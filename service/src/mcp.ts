// MCP server for the Cursor app: the same review notes the Resolve panel writes, so a Cursor chat can
// read them (with the frame stills), work them, and report new takes back to the panel.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { call, health } from "./client.js";
import { VERSION } from "./config.js";
import type { Note } from "./notes.js";

const server = new McpServer({ name: "imagine-review", version: VERSION });

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
const text = (t: string): { content: Content[] } => ({ content: [{ type: "text", text: t }] });
const json = (v: unknown) => text(JSON.stringify(v, null, 1));

async function resolveEpisode(episodeDir?: string, projectName?: string): Promise<string> {
  if (episodeDir) return episodeDir;
  if (projectName) {
    const r = await call<{ episode: { dir: string } | null }>("POST", "/api/context", { projectName });
    if (r.episode) return r.episode.dir;
    throw new Error(`No episode folder found for Resolve project "${projectName}".`);
  }
  throw new Error("Pass episode_dir (the episode folder) or project_name (the Resolve project).");
}

function brief(n: Note): Record<string, unknown> {
  return {
    id: n.id, status: n.status, kind: n.kind, category: n.category, text: n.text, sid: n.sid, version: n.version,
    timecode: n.timecode, sourceFrame: n.sourceFrame, durationFrames: n.durationFrames, stills: n.stills,
    candidate: n.candidate, attempts: n.attempts, comments: n.comments,
  };
}

server.registerTool("review_status", {
  title: "Imagine Review status",
  description: "Whether the Imagine Review service is running, the Cursor sign-in state, and the episodes it knows about.",
  inputSchema: {},
  annotations: { readOnlyHint: true },
}, async () => {
  const h = await health();
  const episodes = await call<unknown[]>("GET", "/api/episodes");
  return json({ service: h ?? "starting", episodes: (episodes as Array<{ release: string; dir: string }>).map((e) => ({ release: e.release, dir: e.dir })) });
});

server.registerTool("review_harvest", {
  title: "Harvest review markers from Resolve",
  description: "Read the review markers on the timeline open in DaVinci Resolve (Red = regenerate, Yellow = fix in edit, Cyan = question, Green = approved; marker name = category, marker note = the note) and file them as notes in the episode folder, each with its shot, take version, frames and a still. Already-harvested markers are skipped.",
  inputSchema: { episode_dir: z.string().optional().describe("Episode folder; found from the open Resolve project when omitted") },
}, async ({ episode_dir }) => {
  const r = await call<{ project: string; episodeDir: string; created: Note[]; updated: Note[]; ignored: number }>("POST", "/api/harvest", { episodeDir: episode_dir });
  return json({ project: r.project, episodeDir: r.episodeDir, created: r.created.map(brief), updated: r.updated.map(brief), ignoredMarkers: r.ignored });
});

server.registerTool("review_list_notes", {
  title: "List review notes",
  description: "List the review notes for an episode, written in the Resolve panel or harvested from markers.",
  inputSchema: {
    episode_dir: z.string().optional(),
    project_name: z.string().optional().describe("Resolve project name, e.g. episode-01-example"),
    status: z.enum(["open", "sent", "working", "candidate", "accepted", "rejected", "closed"]).optional(),
  },
  annotations: { readOnlyHint: true },
}, async ({ episode_dir, project_name, status }) => {
  const dir = await resolveEpisode(episode_dir, project_name);
  const notes = await call<Note[]>("GET", "/api/notes", undefined, { episodeDir: dir });
  return json({ episodeDir: dir, notes: notes.filter((n) => !status || n.status === status).map(brief) });
});

server.registerTool("review_get_note", {
  title: "Get a review note with its stills",
  description: "One note in full, with the frame stills attached as images.",
  inputSchema: { episode_dir: z.string(), note_id: z.string() },
  annotations: { readOnlyHint: true },
}, async ({ episode_dir, note_id }) => {
  const notes = await call<Note[]>("GET", "/api/notes", undefined, { episodeDir: episode_dir });
  const n = notes.find((x) => x.id === note_id);
  if (!n) return { ...text(`No note ${note_id}.`), isError: true };
  const content: Content[] = [{ type: "text", text: JSON.stringify(n, null, 1) }];
  for (const s of n.stills) {
    try {
      const img = await call<{ data: string; mimeType: string }>("GET", "/api/still", undefined, { episodeDir: episode_dir, path: s });
      content.push({ type: "image", data: img.data, mimeType: img.mimeType });
    } catch {
      /* still missing on disk */
    }
  }
  return { content };
});

server.registerTool("review_comment", {
  title: "Reply to a review note",
  description: "Add a reply to a note; the person sees it in the Resolve panel.",
  inputSchema: { episode_dir: z.string(), note_id: z.string(), text: z.string() },
}, async ({ episode_dir, note_id, text: t }) => json(brief(await call<Note>("POST", "/api/notes/comment", { episodeDir: episode_dir, id: note_id, text: t, by: "cursor" }))));

server.registerTool("review_set_status", {
  title: "Set a review note's status",
  description: "Mark a note working (you started it), open, or closed (answered or nothing to change).",
  inputSchema: { episode_dir: z.string(), note_id: z.string(), status: z.enum(["open", "working", "closed"]) },
}, async ({ episode_dir, note_id, status }) => json(brief(await call<Note>("POST", "/api/notes/update", { episodeDir: episode_dir, id: note_id, patch: { status }, by: "cursor" }))));

server.registerTool("review_report_candidate", {
  title: "Report a new take for a note",
  description: "Tell the Resolve panel a new take answers a note. The panel offers to load it as a take on the same timeline clip so the person can compare it and accept. The take must exist at shots/takes/<sid>/<version>.mp4. Do not edit manifest.txt; accepting in Resolve does that.",
  inputSchema: { episode_dir: z.string(), note_id: z.string(), version: z.string().describe("e.g. v11"), summary: z.string() },
}, async ({ episode_dir, note_id, version, summary }) => {
  const notes = await call<Note[]>("GET", "/api/notes", undefined, { episodeDir: episode_dir });
  const n = notes.find((x) => x.id === note_id);
  if (!n) return { ...text(`No note ${note_id}.`), isError: true };
  await call("POST", "/api/notes/comment", { episodeDir: episode_dir, id: note_id, text: `Candidate ${version}: ${summary}`, by: "cursor" });
  const r = await call<Note>("POST", "/api/notes/candidate", { episodeDir: episode_dir, id: note_id, version, summary });
  return json(brief(r));
});

server.registerTool("review_send_to_panel_agent", {
  title: "Send notes to the panel's repair agent",
  description: "Hand open notes to the Cursor agent that runs inside the Resolve panel (instead of working them in this chat).",
  inputSchema: { episode_dir: z.string(), note_ids: z.array(z.string()).optional() },
}, async ({ episode_dir, note_ids }) => json(await call("POST", "/api/agent/send", { episodeDir: episode_dir, noteIds: note_ids })));

await server.connect(new StdioServerTransport());
