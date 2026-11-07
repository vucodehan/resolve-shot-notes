import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { SqliteLocalAgentStore } from "@cursor/sdk/sqlite";
import {
  Agent,
  Cursor,
  CursorAgentError,
  FileCredentialStore,
  type ModelSelection,
  type Run,
  type SDKAgent,
  type SDKCustomTool,
  type SDKImage,
  type SDKModel,
} from "@cursor/sdk";
import { markCandidate, reportCandidate } from "./candidates.js";
import { APP_DIR, loadConfig, updateConfig } from "./config.js";
import { episodeFromDir, maxVersion, takePath } from "./episodes.js";
import { emit } from "./events.js";
import { log } from "./log.js";
import { writeDigest } from "./markers.js";
import { notesFor, reviewDir, type Note } from "./notes.js";

// ---------------------------------------------------------------- credentials and models

export async function apiKey(): Promise<string | undefined> {
  if (process.env.CURSOR_API_KEY?.trim()) return process.env.CURSOR_API_KEY.trim();
  const stored = await new FileCredentialStore().load();
  if (!stored) return undefined;
  if (stored.apiKeyExpiresAtMs && stored.apiKeyExpiresAtMs < Date.now()) return undefined;
  return stored.apiKey;
}

export async function authStatus(): Promise<{ status: "logged-in" | "logged-out"; email?: string; expiresAt?: string; source?: string }> {
  if (process.env.CURSOR_API_KEY?.trim()) return { status: "logged-in", source: "CURSOR_API_KEY" };
  const s = await Cursor.auth.status();
  if (s.status === "logged-in") {
    return {
      status: "logged-in",
      email: s.email,
      expiresAt: s.apiKeyExpiresAtMs ? new Date(s.apiKeyExpiresAtMs).toISOString() : undefined,
      source: "login",
    };
  }
  return { status: "logged-out" };
}

let loginInFlight: Promise<void> | null = null;

/** Browser sign-in that mints a named, 90-day user API key (kept in ~/.cursor/sdk/auth.json). */
export function startLogin(): Promise<string> {
  return new Promise((resolveUrl, rejectUrl) => {
    if (loginInFlight) {
      rejectUrl(new Error("a sign-in is already waiting for the browser"));
      return;
    }
    let sentUrl = false;
    loginInFlight = Cursor.auth
      .login({
        apiKeyName: "Imagine Review (DaVinci Resolve)",
        onLoginUrl: (url) => {
          sentUrl = true;
          resolveUrl(url);
        },
      })
      .then((r) => {
        emit({ type: "auth.changed", status: "logged-in", email: r.email });
        log.info("signed in", { email: r.email });
      })
      .catch((e) => {
        emit({ type: "auth.changed", status: "logged-out", error: String(e) });
        if (!sentUrl) rejectUrl(e);
      })
      .finally(() => {
        loginInFlight = null;
        modelCache = null;
      });
  });
}

export async function logout(): Promise<void> {
  await Cursor.auth.logout();
  modelCache = null;
  emit({ type: "auth.changed", status: "logged-out" });
}

let modelCache: { at: number; models: SDKModel[] } | null = null;

export async function listModels(): Promise<SDKModel[]> {
  if (modelCache && Date.now() - modelCache.at < 10 * 60_000) return modelCache.models;
  const key = await apiKey();
  if (!key) return [];
  const models = await Cursor.models.list({ apiKey: key });
  modelCache = { at: Date.now(), models };
  return models;
}

function versionScore(id: string): number {
  const nums = id.match(/\d+(?:[.-]\d+)?/g)?.map((n) => Number(n.replace("-", "."))) ?? [];
  return nums.length ? Math.max(...nums) : 0;
}

/** The configured model, else the newest Opus, else Composer, else the first the account offers. */
export async function pickModel(): Promise<ModelSelection> {
  const cfg = loadConfig();
  if (cfg.model) return { id: cfg.model };
  const models = await listModels();
  const ids = models.map((m) => m.id);
  const opus = ids.filter((id) => /opus/i.test(id) && !/fast/i.test(id)).sort((a, b) => versionScore(b) - versionScore(a));
  if (opus.length) return { id: opus[0] };
  const composer = ids.find((id) => /^composer/i.test(id));
  if (composer) return { id: composer };
  return { id: ids[0] ?? "auto" };
}

export function setModel(id: string): void {
  updateConfig({ model: id });
}

// ---------------------------------------------------------------- chat log

export interface ChatEntry {
  ts: string;
  role: "user" | "assistant" | "tool" | "system";
  text: string;
  runId?: string;
  images?: string[];
}

function chatPath(episodeDir: string): string {
  return path.join(reviewDir(episodeDir), "chat.jsonl");
}

function appendChat(episodeDir: string, entry: ChatEntry): void {
  fs.mkdirSync(reviewDir(episodeDir), { recursive: true });
  fs.appendFileSync(chatPath(episodeDir), JSON.stringify(entry) + "\n", "utf8");
}

export function chatHistory(episodeDir: string, limit = 200): ChatEntry[] {
  const p = chatPath(episodeDir);
  if (!fs.existsSync(p)) return [];
  const lines = fs.readFileSync(p, "utf8").split(/\r?\n/).filter(Boolean);
  return lines.slice(-limit).map((l) => JSON.parse(l) as ChatEntry);
}

// ---------------------------------------------------------------- the episode's agent

interface AgentRecord {
  agentId: string;
  model: string;
  createdAt: string;
}

function recordPath(episodeDir: string): string {
  return path.join(reviewDir(episodeDir), "agent.json");
}

function readRecord(episodeDir: string): AgentRecord | null {
  try {
    return JSON.parse(fs.readFileSync(recordPath(episodeDir), "utf8")) as AgentRecord;
  } catch {
    return null;
  }
}

// The SDK's default store lives under ~/.cursor/projects/<workspace slug>/sdk-agent-store/<sha256>/agents/agent-<sha256>/,
// which passes Windows' 260-character limit for long episode paths and SQLite then cannot open it. Each workspace
// gets its store under %APPDATA%\ImagineReview\agents\<12 hex> instead.
const agentStores = new Map<string, Promise<SqliteLocalAgentStore>>();

function agentStore(workspace: string): Promise<SqliteLocalAgentStore> {
  const k = path.resolve(workspace).toLowerCase();
  let s = agentStores.get(k);
  if (!s) {
    const id = createHash("sha256").update(k).digest("hex").slice(0, 12);
    s = SqliteLocalAgentStore.open({ workspaceRef: path.resolve(workspace), stateRoot: path.join(APP_DIR, "agents", id) });
    agentStores.set(k, s);
  }
  return s;
}

// Named panel_* so they cannot collide with the imagine-review MCP server's review_* tools, which the agent also loads.
function customTools(episodeDir: string): Record<string, SDKCustomTool> {
  const store = () => notesFor(episodeDir);
  const changed = (n: Note) => {
    writeDigest(episodeDir);
    emit({ type: "note.updated", episodeDir, note: n });
  };
  return {
    panel_list_notes: {
      description: "List the person's review notes for this episode (from DaVinci Resolve), with shot, version, frames, still paths and status. No arguments needed: it is bound to this episode.",
      inputSchema: { type: "object", properties: { status: { type: "string", description: "Optional status filter: open, sent, working, candidate, accepted, rejected, closed" } } },
      annotations: { readOnlyHint: true },
      execute: (args) => {
        const st = typeof args.status === "string" ? args.status : undefined;
        return JSON.stringify(store().list().filter((n) => !st || n.status === st), null, 1);
      },
    },
    panel_report_candidate: {
      description: "Report a new take that answers a note. The panel loads it into Resolve as a take on the same timeline clip for the person to compare and accept. Call once the take exists under shots/takes/<sid>/<version>.mp4 and has passed its gates.",
      inputSchema: {
        type: "object",
        properties: {
          note_id: { type: "string" },
          version: { type: "string", description: "e.g. v11" },
          summary: { type: "string", description: "What changed and which rule or gate let the original fault through." },
        },
        required: ["note_id", "version", "summary"],
      },
      execute: async (args) => {
        try {
          const n = await reportCandidate(episodeDir, String(args.note_id), String(args.version), String(args.summary ?? ""), "agent");
          return `Reported ${n.sid} ${n.candidate?.version} for ${n.id}. The person will compare it in Resolve.`;
        } catch (e) {
          return { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true };
        }
      },
    },
    panel_add_comment: {
      description: "Add a reply to a note (an answer to a question, or why a note cannot be fixed yet). The person sees it in the panel.",
      inputSchema: { type: "object", properties: { note_id: { type: "string" }, text: { type: "string" } }, required: ["note_id", "text"] },
      execute: (args) => {
        const n = store().comment(String(args.note_id), "agent", String(args.text));
        changed(n);
        return "Comment added.";
      },
    },
    panel_set_status: {
      description: "Set a note's status to working (you started it) or closed (nothing to regenerate, e.g. a question you answered).",
      inputSchema: { type: "object", properties: { note_id: { type: "string" }, status: { type: "string", enum: ["working", "closed"] } }, required: ["note_id", "status"] },
      execute: (args) => {
        const n = store().update(String(args.note_id), { status: args.status as Note["status"] }, "agent");
        changed(n);
        return `Note ${n.id} is ${n.status}.`;
      },
    },
  };
}

interface Session {
  agent: SDKAgent;
  run: Run | null;
  queue: Promise<void>;
}

const sessions = new Map<string, Session>();

function key(episodeDir: string): string {
  return path.resolve(episodeDir).toLowerCase();
}

async function session(episodeDir: string): Promise<Session> {
  const k = key(episodeDir);
  const existing = sessions.get(k);
  if (existing) return existing;
  const ep = episodeFromDir(episodeDir);
  const apiKeyValue = await apiKey();
  if (!apiKeyValue) throw new Error("Not signed in to Cursor. Use 'Sign in with Cursor' in the panel.");
  const model = await pickModel();
  const options = {
    apiKey: apiKeyValue,
    model,
    name: `Imagine Review: ${ep.release}`,
    local: {
      cwd: ep.seriesDir,
      dirs: [ep.dir],
      store: await agentStore(ep.seriesDir),
      settingSources: ["user" as const, "project" as const],
      customTools: customTools(episodeDir),
    },
  };
  const rec = readRecord(episodeDir);
  let agent: SDKAgent | null = null;
  if (rec?.agentId) {
    try {
      agent = await Agent.resume(rec.agentId, options);
      log.info("agent resumed", { episodeDir, agentId: rec.agentId });
    } catch (e) {
      log.warn("agent resume failed, creating a new one", { episodeDir, error: String(e) });
    }
  }
  if (!agent) {
    agent = await Agent.create(options);
    fs.mkdirSync(reviewDir(episodeDir), { recursive: true });
    fs.writeFileSync(recordPath(episodeDir), JSON.stringify({ agentId: agent.agentId, model: model.id, createdAt: new Date().toISOString() }, null, 1));
    log.info("agent created", { episodeDir, agentId: agent.agentId, model: model.id });
  }
  const s: Session = { agent, run: null, queue: Promise.resolve() };
  sessions.set(k, s);
  return s;
}

export function isBusy(episodeDir: string): boolean {
  return !!sessions.get(key(episodeDir))?.run;
}

export async function cancel(episodeDir: string): Promise<boolean> {
  const s = sessions.get(key(episodeDir));
  if (s?.run && s.run.supports("cancel")) {
    await s.run.cancel();
    return true;
  }
  return false;
}

function imageFor(file: string): SDKImage | null {
  try {
    return { data: fs.readFileSync(file).toString("base64"), mimeType: "image/jpeg" };
  } catch {
    return null;
  }
}

export interface SendRequest {
  episodeDir: string;
  text: string;
  images?: string[];
  noteIds?: string[];
  /** What the person saw in the panel's chat box, if different from the prompt sent. */
  display?: string;
}

/** Queue a message to the episode's agent; streams events and returns when the run is queued. */
export async function send(req: SendRequest): Promise<{ queued: true }> {
  const s = await session(req.episodeDir);
  s.queue = s.queue.then(() => runOne(s, req)).catch((e) => log.error("agent run failed", e));
  return { queued: true };
}

async function runOne(s: Session, req: SendRequest): Promise<void> {
  const { episodeDir } = req;
  const images = (req.images ?? []).map(imageFor).filter((x): x is SDKImage => !!x).slice(0, 12);
  appendChat(episodeDir, { ts: new Date().toISOString(), role: "user", text: req.display ?? req.text, images: req.images });
  const store = notesFor(episodeDir);
  for (const id of req.noteIds ?? []) {
    const n = store.get(id);
    if (n) emit({ type: "note.updated", episodeDir, note: store.update(id, { status: "working" }, "service") });
  }
  emit({ type: "agent.status", episodeDir, status: "starting" });
  let run: Run;
  try {
    run = await s.agent.send({ text: req.text, images });
  } catch (e) {
    const msg = e instanceof CursorAgentError ? `${e.message}${e.isRetryable ? " (retryable)" : ""}` : String(e);
    appendChat(episodeDir, { ts: new Date().toISOString(), role: "system", text: `The agent did not start: ${msg}` });
    emit({ type: "agent.done", episodeDir, status: "error", error: msg });
    sessions.delete(key(episodeDir));
    return;
  }
  s.run = run;
  log.info("agent run started", { episodeDir, runId: run.id, agentId: s.agent.agentId });
  emit({ type: "agent.status", episodeDir, status: "running", runId: run.id });
  let text = "";
  const loggedCalls = new Set<string>();
  try {
    for await (const m of run.stream()) {
      if (m.type === "assistant") {
        for (const b of m.message.content) {
          if (b.type === "text" && b.text) {
            text += b.text;
            emit({ type: "agent.text", episodeDir, runId: run.id, text: b.text });
          }
        }
      } else if (m.type === "tool_call") {
        emit({ type: "agent.tool", episodeDir, runId: run.id, name: m.name, status: m.status, callId: m.call_id, args: summarizeArgs(m.args) });
        if ((m.status === "completed" || m.status === "error") && !loggedCalls.has(m.call_id)) {
          loggedCalls.add(m.call_id);
          appendChat(episodeDir, { ts: new Date().toISOString(), role: "tool", text: `${m.name} ${m.status}${summarizeArgs(m.args) ? ": " + summarizeArgs(m.args) : ""}`, runId: run.id });
        }
      } else if (m.type === "thinking") {
        emit({ type: "agent.thinking", episodeDir, runId: run.id });
      } else if (m.type === "status") {
        emit({ type: "agent.status", episodeDir, runId: run.id, status: m.status.toLowerCase(), message: m.message });
      }
    }
  } catch (e) {
    log.warn("agent stream ended with an error", { error: String(e) });
  }
  const result = await run.wait();
  s.run = null;
  if (text.trim()) appendChat(episodeDir, { ts: new Date().toISOString(), role: "assistant", text, runId: run.id });
  if (result.status === "error") {
    appendChat(episodeDir, { ts: new Date().toISOString(), role: "system", text: `The run failed: ${result.error?.message ?? "unknown error"}`, runId: run.id });
  }
  await settleNotes(episodeDir, req.noteIds ?? []);
  emit({ type: "agent.done", episodeDir, runId: run.id, status: result.status, error: result.error?.message, durationMs: result.durationMs });
  log.info("agent run finished", { episodeDir, runId: run.id, status: result.status, durationMs: result.durationMs });
}

function summarizeArgs(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  const pick = a.command ?? a.path ?? a.file_path ?? a.pattern ?? a.query ?? a.note_id ?? a.toolName ?? a.name;
  const s = typeof pick === "string" ? pick : "";
  return s.length > 140 ? s.slice(0, 137) + "..." : s;
}

/** After a run: a note whose shot gained a newer take becomes a candidate even if the agent did not report it. */
async function settleNotes(episodeDir: string, ids: string[]): Promise<void> {
  const store = notesFor(episodeDir);
  for (const id of ids) {
    const n = store.get(id);
    if (!n || n.status !== "working") continue;
    if (n.kind === "regenerate" && n.sid && n.baselineVersion !== undefined) {
      const top = maxVersion(episodeDir, n.sid);
      if (top > n.baselineVersion) {
        await markCandidate(episodeDir, id, `v${top}`, "found on disk after the run", "service");
        continue;
      }
    }
    emit({ type: "note.updated", episodeDir, note: store.update(id, { status: "open" }, "service") });
  }
  writeDigest(episodeDir);
}

// ---------------------------------------------------------------- prompts

export function repairPrompt(episodeDir: string, notes: Note[]): { text: string; images: string[] } {
  const cfg = loadConfig();
  const ep = episodeFromDir(episodeDir);
  const images: string[] = [];
  const rel = (p?: string) => (p ? path.relative(episodeDir, p).replace(/\\/g, "/") : "?");
  const out: string[] = [
    `# Review notes from DaVinci Resolve: ${ep.release}`,
    ``,
    `Episode folder: ${episodeDir}`,
    cfg.pipelineDoc ? `Pipeline procedure: ${cfg.pipelineDoc} (Part 1.4 files, Part 7.3 review rows, Part 7.4 retries).` : ``,
    ``,
    `The person reviewed the cut in DaVinci Resolve and left the notes below. Each note is bound to a shot, the take version on the timeline, and the exact frames. The attached images are those frames, in the order listed.`,
    ``,
  ];
  for (const n of notes) {
    out.push(`## ${n.id} · ${n.sid ?? "(no shot)"} ${n.version ?? ""} · ${n.kind} · ${n.category}`);
    out.push(`Note: "${n.text}"`);
    if (n.sourceFrame !== undefined) {
      out.push(`Frames: source ${n.sourceFrame}${n.durationFrames > 1 ? `-${n.sourceFrame + n.durationFrames - 1}` : ""} of ${rel(n.mediaPath)} (timeline ${n.timecode}, ${n.durationFrames} frame${n.durationFrames > 1 ? "s" : ""}, ${n.fps} fps)`);
    }
    if (n.sid && n.version) {
      const base = `shots/takes/${n.sid}/${n.version}`;
      out.push(`Take files: ${base}.mp4, ${base}.prompt.txt, ${base}.auto.json`);
    }
    for (const s of n.stills) {
      out.push(`Still: review/${s.replace(/\\/g, "/").replace(/^review\//, "")}`);
      images.push(path.join(episodeDir, s));
    }
    for (const a of n.attempts) out.push(`Earlier attempt ${a.version}: ${a.verdict}${a.reason ? ` (${a.reason})` : ""}`);
    for (const c of n.comments) out.push(`${c.by}: ${c.text}`);
    out.push(``);
  }
  out.push(
    `## How to answer these notes`,
    `- Work only on the noted shots. For a "regenerate" note, make the next version of that shot with the episode's own programs and gates, following the retries table (7.4) for the note's category. Takes are never overwritten; the next attempt is the next version.`,
    `- Beside each new take write v<n>.cut.json: {"in": seconds, "out": seconds}, the span the edit should use, found by the same word-timing rule the episode's cut uses. The panel uses it to drop the take in at the right length.`,
    `- When a new take passes its gates, call panel_report_candidate(note_id, version, summary). In the summary, name the rule or gate that let the original fault through.`,
    `- "fix" notes are edit-side (trim, timing, sound, an earlier version). Say what to change with panel_add_comment; regenerate only if the note asks for it.`,
    `- "question" notes: answer with panel_add_comment, then panel_set_status(closed).`,
    `- Use the panel_* tools for these notes (they are bound to this episode), not the imagine-review MCP server's review_* tools.`,
    `- Do not edit shots/manifest.txt. The person accepts each new take in Resolve, and the panel updates the manifest.`,
    `- Do not open, create, switch, save or export DaVinci Resolve projects, do not use the davinci-resolve MCP tools, and do not run the episode's *_resolve.py: the person is reviewing in Resolve right now and the panel owns Resolve.`,
    `- If a note cannot be answered, call panel_add_comment with the reason instead of guessing.`,
  );
  return { text: out.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n"), images };
}

export function chatPrompt(text: string, context?: { sid?: string; version?: string; timecode?: string; clipName?: string; line?: string }): string {
  if (!context?.sid) return text;
  return [
    `[Context from the Resolve panel: the playhead is on ${context.sid} ${context.version ?? ""}${context.timecode ? ` at ${context.timecode}` : ""}${context.line ? `, line: ${context.line}` : ""}. Do not touch DaVinci Resolve or its projects; the person is reviewing there.]`,
    ``,
    text,
  ].join("\n");
}
