import fs from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import * as agent from "./agent.js";
import { APP_DIR, loadConfig, VERSION, type NoteKind } from "./config.js";
import {
  bindEpisode, episodeFromDir, findEpisode, listEpisodes, maxVersion, parseClipName, setManifestVersion, shotInfo, takePath,
} from "./episodes.js";
import { reportCandidate } from "./candidates.js";
import { addClient, clientCount, emit } from "./events.js";
import { harvestOpenProject, probeClipMarker } from "./harvest.js";
import { log } from "./log.js";
import { importMarkers, locate, writeDigest, type ResolveClip, type ResolveSnapshot } from "./markers.js";
import { CATEGORIES, notesFor, type Note } from "./notes.js";
import { stillsForNote } from "./stills.js";

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

type Handler = (req: IncomingMessage, url: URL, body: Record<string, unknown>) => Promise<unknown> | unknown;

const routes = new Map<string, Handler>();
const route = (method: string, p: string, h: Handler) => routes.set(`${method} ${p}`, h);

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (req.method === "GET" || req.method === "HEAD") return {};
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 16 * 1024 * 1024) throw new HttpError(413, "body too large");
    chunks.push(c as Buffer);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "body is not JSON");
  }
}

function send(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

function str(v: unknown, name: string): string {
  if (typeof v !== "string" || !v.trim()) throw new HttpError(400, `${name} is required`);
  return v;
}

function episodeDirOf(v: unknown): string {
  const dir = path.resolve(str(v, "episodeDir"));
  if (!fs.existsSync(path.join(dir, "shots")) && !fs.existsSync(path.join(dir, "outputs"))) {
    throw new HttpError(400, `${dir} is not an episode folder (no shots/ or outputs/)`);
  }
  return dir;
}

const KIND_COLOR: Record<NoteKind, string> = { regenerate: "Red", fix: "Yellow", question: "Cyan", approve: "Green", note: "Yellow" };

function changed(episodeDir: string, note: Note): Note {
  writeDigest(episodeDir);
  emit({ type: "note.updated", episodeDir, note });
  return note;
}

// ---------------------------------------------------------------- status, auth, models

route("GET", "/api/health", async () => ({
  ok: true, version: VERSION, pid: process.pid, auth: await agent.authStatus(), model: loadConfig().model || null, panels: clientCount(),
}));

route("GET", "/api/auth", () => agent.authStatus());
route("POST", "/api/auth/login", async () => ({ url: await agent.startLogin() }));
route("POST", "/api/auth/logout", async () => {
  await agent.logout();
  return { ok: true };
});

route("GET", "/api/models", async () => {
  const models = await agent.listModels();
  return { models: models.map((m) => ({ id: m.id, displayName: m.displayName })), selected: (await agent.pickModel()).id };
});
route("POST", "/api/models", (_r, _u, b) => {
  agent.setModel(str(b.id, "id"));
  return { ok: true, selected: b.id };
});

// ---------------------------------------------------------------- episodes

route("GET", "/api/episodes", () => listEpisodes());

route("POST", "/api/context", (_r, _u, b) => {
  const ep = findEpisode(str(b.projectName, "projectName"));
  if (!ep) return { episode: null };
  const notes = notesFor(ep.dir).list();
  return { episode: ep, counts: countBy(notes) };
});

route("POST", "/api/bind", (_r, _u, b) => {
  const dir = episodeDirOf(b.episodeDir);
  return { episode: bindEpisode(str(b.projectName, "projectName"), dir) };
});

route("GET", "/api/shot", (_r, u) => {
  const dir = episodeDirOf(u.searchParams.get("episodeDir"));
  return shotInfo(dir, str(u.searchParams.get("sid"), "sid"));
});

function countBy(notes: Note[]): Record<string, number> {
  const c: Record<string, number> = {};
  for (const n of notes) c[n.status] = (c[n.status] ?? 0) + 1;
  return c;
}

// ---------------------------------------------------------------- notes

route("GET", "/api/notes", (_r, u) => notesFor(episodeDirOf(u.searchParams.get("episodeDir"))).list());

route("GET", "/api/categories", () => CATEGORIES);

/** A note written in the panel: the service files it, pulls the stills, and returns the marker the panel should place. */
route("POST", "/api/notes", async (_r, _u, b) => {
  const dir = episodeDirOf(b.episodeDir);
  const kind = (str(b.kind, "kind") as NoteKind);
  if (!KIND_COLOR[kind]) throw new HttpError(400, `unknown kind ${kind}`);
  const clip = b.clip as ResolveClip | undefined;
  const fps = Number(b.fps) || 24;
  const startFrame = Number(b.startFrame) || 0;
  const recordAbs = Number(b.recordAbs);
  const durationFrames = Math.max(1, Math.round(Number(b.durationFrames) || 1));
  const store = notesFor(dir);
  const parsed = clip ? parseClipName(clip.name) : null;
  const loc = clip && Number.isFinite(recordAbs) ? locate(clip, recordAbs, startFrame, fps) : null;
  let media = clip?.mediaPath;
  if (parsed && fs.existsSync(takePath(dir, parsed.sid, parsed.version))) media = takePath(dir, parsed.sid, parsed.version);
  const category = typeof b.category === "string" && b.category ? b.category : "other";
  const note = store.create({
    kind,
    category,
    text: str(b.text, "text"),
    source: "panel",
    sid: parsed?.sid,
    version: parsed?.version,
    clipName: clip?.name,
    timelineItemId: clip?.id,
    recordFrame: loc?.recordFrame,
    sourceFrame: loc?.sourceFrame,
    durationFrames,
    timecode: loc?.timecode,
    mediaPath: media,
    fps,
    stills: [],
    markerColor: KIND_COLOR[kind],
    markerScope: clip ? "clip" : "timeline",
  });
  if (media && loc) {
    const stills = await stillsForNote(dir, note.id, media, loc.sourceFrame, durationFrames, fps);
    if (stills.length) store.update(note.id, { stills }, "service");
  }
  const final = changed(dir, store.get(note.id)!);
  return {
    note: final,
    marker: {
      scope: clip ? "clip" : "timeline",
      frame: clip ? loc!.clipMarkerFrame : (Number.isFinite(recordAbs) ? recordAbs - startFrame : 0),
      color: KIND_COLOR[kind],
      name: `${category}`,
      note: `${final.id}: ${final.text}`,
      duration: durationFrames,
      customData: final.id,
    },
  };
});

route("POST", "/api/notes/update", (_r, _u, b) => {
  const dir = episodeDirOf(b.episodeDir);
  const patch = (b.patch ?? {}) as Partial<Note>;
  const allowed: (keyof Note)[] = ["text", "kind", "category", "status"];
  const clean = Object.fromEntries(Object.entries(patch).filter(([k]) => allowed.includes(k as keyof Note))) as Partial<Note>;
  return changed(dir, notesFor(dir).update(str(b.id, "id"), clean, str(b.by ?? "panel", "by")));
});

route("POST", "/api/notes/comment", (_r, _u, b) => {
  const dir = episodeDirOf(b.episodeDir);
  return changed(dir, notesFor(dir).comment(str(b.id, "id"), typeof b.by === "string" ? b.by : "person", str(b.text, "text")));
});

route("POST", "/api/notes/candidate", async (_r, _u, b) => {
  const dir = episodeDirOf(b.episodeDir);
  try {
    return await reportCandidate(dir, str(b.id, "id"), str(b.version, "version"), typeof b.summary === "string" ? b.summary : "", typeof b.by === "string" ? b.by : "cursor");
  } catch (e) {
    throw new HttpError(409, e instanceof Error ? e.message : String(e));
  }
});

/** The person accepted the candidate take in Resolve: the manifest names it. */
route("POST", "/api/notes/accept", (_r, _u, b) => {
  const dir = episodeDirOf(b.episodeDir);
  const store = notesFor(dir);
  const n = store.get(str(b.id, "id"));
  if (!n) throw new HttpError(404, "no such note");
  if (!n.candidate || !n.sid) throw new HttpError(409, "the note has no candidate take");
  setManifestVersion(dir, n.sid, n.candidate.version, "accepted_in_review");
  const attempts = [...n.attempts, { version: n.candidate.version, verdict: "accepted" as const, at: new Date().toISOString() }];
  return changed(dir, store.update(n.id, { status: "accepted", attempts, version: n.candidate.version }, "person"));
});

route("POST", "/api/notes/reject", (_r, _u, b) => {
  const dir = episodeDirOf(b.episodeDir);
  const store = notesFor(dir);
  const n = store.get(str(b.id, "id"));
  if (!n) throw new HttpError(404, "no such note");
  if (!n.candidate) throw new HttpError(409, "the note has no candidate take");
  const reason = typeof b.reason === "string" ? b.reason : "";
  const attempts = [...n.attempts, { version: n.candidate.version, verdict: "rejected" as const, at: new Date().toISOString(), reason }];
  return changed(dir, store.update(n.id, { status: "open", attempts, candidate: undefined }, "person"));
});

/** Markers read by the panel (or any client) from Resolve: review-colored ones become notes. */
route("POST", "/api/import", async (_r, _u, b) => {
  const dir = episodeDirOf(b.episodeDir);
  const res = await importMarkers(dir, b.snapshot as ResolveSnapshot, (b.source as Note["source"]) ?? "harvest");
  for (const n of [...res.created, ...res.updated]) emit({ type: "note.updated", episodeDir: dir, note: n });
  return res;
});

/** Harvest without the panel, through Resolve's external scripting. */
route("POST", "/api/harvest", async (_r, _u, b) => harvestOpenProject(typeof b.episodeDir === "string" ? episodeDirOf(b.episodeDir) : undefined));

route("POST", "/api/probe/clip-marker", () => probeClipMarker());

// ---------------------------------------------------------------- panel self-test

/** Inputs for the panel's self-test: a scratch episode folder, and another version of the clip's shot to load as a take. */
function selftestParams(episodeDir?: string, clipName?: string): { scratchDir: string; clipName?: string; candidatePath?: string } {
  const scratchDir = path.join(APP_DIR, "selftest", "Episode");
  fs.mkdirSync(path.join(scratchDir, "shots"), { recursive: true });
  let candidatePath: string | undefined;
  const parsed = clipName ? parseClipName(clipName) : null;
  if (episodeDir && parsed) {
    const other = shotInfo(episodeDir, parsed.sid).versions.filter((v) => v.version !== parsed.version).pop();
    candidatePath = other?.mp4;
    const take = takePath(episodeDir, parsed.sid, parsed.version);
    const local = path.join(scratchDir, "shots", "takes", parsed.sid, `${parsed.version}.mp4`);
    if (fs.existsSync(take) && !fs.existsSync(local)) {
      fs.mkdirSync(path.dirname(local), { recursive: true });
      fs.copyFileSync(take, local);
    }
  }
  return { scratchDir, clipName, candidatePath };
}

route("GET", "/api/selftest/params", (_r, u) =>
  selftestParams(u.searchParams.get("episodeDir") ?? undefined, u.searchParams.get("clipName") ?? undefined));

const selftestWaiters = new Map<string, (r: unknown) => void>();

/** Asks the open panel to run its self-test inside Resolve and waits for the result. */
route("POST", "/api/selftest/run", async (_r, _u, b) => {
  const runId = `st-${Date.now()}`;
  const params = selftestParams(typeof b.episodeDir === "string" ? b.episodeDir : undefined, typeof b.clipName === "string" ? b.clipName : undefined);
  const result = new Promise((res) => {
    selftestWaiters.set(runId, res);
    setTimeout(() => {
      if (selftestWaiters.delete(runId)) res({ ok: false, error: "no panel answered within 120 s (is Imagine Review open in Resolve?)" });
    }, 120_000);
  });
  emit({ type: "panel.selftest", runId, params });
  return result;
});

route("POST", "/api/selftest/result", (_r, _u, b) => {
  const res = selftestWaiters.get(String(b.runId));
  if (res) {
    selftestWaiters.delete(String(b.runId));
    res(b);
  }
  return { ok: true };
});

// ---------------------------------------------------------------- agent

route("POST", "/api/agent/send", async (_r, _u, b) => {
  const dir = episodeDirOf(b.episodeDir);
  const store = notesFor(dir);
  const wanted = Array.isArray(b.noteIds) && b.noteIds.length
    ? (b.noteIds as string[]).map((id) => store.get(id)).filter((n): n is Note => !!n)
    : store.list().filter((n) => n.status === "open" && n.kind !== "approve");
  if (!wanted.length) throw new HttpError(409, "no open notes to send");
  for (const n of wanted) {
    store.update(n.id, { status: "sent", baselineVersion: n.sid ? maxVersion(dir, n.sid) : undefined }, "service");
  }
  const fresh = wanted.map((n) => store.get(n.id)!);
  for (const n of fresh) emit({ type: "note.updated", episodeDir: dir, note: n });
  writeDigest(dir);
  const { text, images } = agent.repairPrompt(dir, fresh);
  await agent.send({
    episodeDir: dir, text, images, noteIds: fresh.map((n) => n.id),
    display: `Repair ${fresh.length} note${fresh.length > 1 ? "s" : ""}: ${fresh.map((n) => `${n.id} (${n.sid ?? "?"} ${n.kind})`).join(", ")}`,
  });
  return { sent: fresh.map((n) => n.id) };
});

route("POST", "/api/agent/chat", async (_r, _u, b) => {
  const dir = episodeDirOf(b.episodeDir);
  const text = str(b.text, "text");
  const context = (b.context ?? undefined) as Parameters<typeof agent.chatPrompt>[1];
  const images = Array.isArray(b.images) ? (b.images as string[]).filter((p) => typeof p === "string" && fs.existsSync(p)) : [];
  await agent.send({ episodeDir: dir, text: agent.chatPrompt(text, context), images, display: text });
  return { queued: true };
});

route("POST", "/api/agent/cancel", async (_r, _u, b) => ({ cancelled: await agent.cancel(episodeDirOf(b.episodeDir)) }));

route("GET", "/api/agent/history", (_r, u) => {
  const dir = episodeDirOf(u.searchParams.get("episodeDir"));
  return { busy: agent.isBusy(dir), entries: agent.chatHistory(dir) };
});

// ---------------------------------------------------------------- files

route("GET", "/api/still", (_r, u) => {
  const dir = episodeDirOf(u.searchParams.get("episodeDir"));
  const rel = str(u.searchParams.get("path"), "path");
  const full = path.resolve(dir, rel);
  if (!full.startsWith(path.join(dir, "review") + path.sep) || !fs.existsSync(full)) throw new HttpError(404, "no such still");
  return { mimeType: "image/jpeg", data: fs.readFileSync(full).toString("base64") };
});

route("GET", "/api/episode", (_r, u) => episodeFromDir(episodeDirOf(u.searchParams.get("episodeDir"))));

/** A still of the frame under the playhead, for a chat message (no note is filed). Returns absolute paths. */
route("POST", "/api/still/grab", async (_r, _u, b) => {
  const dir = episodeDirOf(b.episodeDir);
  const clip = b.clip as ResolveClip | undefined;
  if (!clip) throw new HttpError(400, "clip is required");
  const fps = Number(b.fps) || 24;
  const loc = locate(clip, Number(b.recordAbs), Number(b.startFrame) || 0, fps);
  const parsed = parseClipName(clip.name);
  let media = clip.mediaPath;
  if (parsed && fs.existsSync(takePath(dir, parsed.sid, parsed.version))) media = takePath(dir, parsed.sid, parsed.version);
  if (!media) throw new HttpError(404, "no media file for this clip");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const rel = await stillsForNote(dir, `chat-${stamp}`, media, loc.sourceFrame, 1, fps);
  return { stills: rel.map((r) => path.join(dir, r)), sid: parsed?.sid, version: parsed?.version, sourceFrame: loc.sourceFrame };
});

// ---------------------------------------------------------------- server

export function startServer(): http.Server {
  const cfg = loadConfig();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${cfg.port}`);
    try {
      const token = req.headers["x-imagine-token"] ?? url.searchParams.get("token");
      if (token !== cfg.token) throw new HttpError(401, "bad or missing token");
      if (req.method === "GET" && url.pathname === "/api/events") {
        addClient(res);
        return;
      }
      const h = routes.get(`${req.method} ${url.pathname}`);
      if (!h) throw new HttpError(404, `no route ${req.method} ${url.pathname}`);
      const body = await readBody(req);
      send(res, 200, (await h(req, url, body)) ?? { ok: true });
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status >= 500) log.error(`${req.method} ${url.pathname} failed`, e);
      send(res, status, { error: e instanceof Error ? e.message : String(e) });
    }
  });
  server.listen(cfg.port, "127.0.0.1");
  return server;
}
