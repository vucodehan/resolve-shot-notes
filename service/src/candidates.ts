import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { loadConfig } from "./config.js";
import { takePath } from "./episodes.js";
import { emit } from "./events.js";
import { log } from "./log.js";
import { writeDigest } from "./markers.js";
import { notesFor, type Leveling, type Note } from "./notes.js";

const run = promisify(execFile);
const LEVEL_TAKE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "tools", "level_take.py");

export function normalizeVersion(v: string): string {
  const s = String(v).trim().toLowerCase();
  return /^\d+$/.test(s) ? `v${s}` : s;
}

/**
 * The candidate's line at the episode's mix level (tools/level_take.py): shots/takes/<sid>/<version>.line.wav, from the
 * episode's outputs/resolve/mixed/gain.json. Without a gain.json the result says so and the panel uses the raw audio.
 */
export async function levelTake(episodeDir: string, sid: string, version: string, replaces?: string): Promise<Leveling> {
  const cfg = loadConfig();
  const env = { ...process.env };
  if (path.isAbsolute(cfg.ffmpegPath)) env.PATH = `${path.dirname(cfg.ffmpegPath)}${path.delimiter}${env.PATH ?? ""}`;
  const args = [LEVEL_TAKE, episodeDir, sid, version, ...(replaces ? ["--replaces", replaces] : [])];
  try {
    const { stdout } = await run(cfg.pythonPath, args, { env, windowsHide: true, timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
    const last = stdout.trim().split(/\r?\n/).pop() ?? "{}";
    return JSON.parse(last) as Leveling;
  } catch (e) {
    log.warn("level_take failed", { episodeDir, sid, version, error: String(e) });
    return { ok: false, reason: `level_take.py failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

function levelingReply(version: string, lv: Leveling): string {
  if (!lv.ok) return `${version} is not leveled to the mix: ${lv.reason}. The panel will use the take's own audio, at its own level.`;
  const parts = (lv.parts ?? []).map((p) => `${path.basename(p.file)} for ${p.replaces_clip} (median ${p.median_gain_db >= 0 ? "+" : ""}${p.median_gain_db} dB, the replaced line had ${p.replaced_line_median_gain_db ?? "?"} dB)`);
  return `Leveled ${version}'s line to the episode's mix: ${parts.join("; ")}.`;
}

/** Marks a note's candidate and levels its line; the leveling result is the note's reply. */
export async function markCandidate(episodeDir: string, noteId: string, version: string, summary: string, by: string): Promise<Note> {
  const store = notesFor(episodeDir);
  const n = store.get(noteId);
  if (!n || !n.sid) throw new Error(`Note ${noteId} is not bound to a shot.`);
  const p = takePath(episodeDir, n.sid, version);
  const lv = await levelTake(episodeDir, n.sid, version, n.version);
  const lines = lv.ok ? lv.files ?? [] : [];
  store.update(noteId, {
    status: "candidate",
    candidate: { version, path: p, at: new Date().toISOString(), summary, line: lines[0], lines, leveling: lv },
  }, by);
  const updated = store.comment(noteId, "service", levelingReply(version, lv));
  writeDigest(episodeDir);
  emit({ type: "note.updated", episodeDir, note: updated });
  emit({ type: "take.candidate", episodeDir, note: updated });
  return updated;
}

/** A new take answers a note: the panel offers it as a take on the same timeline clip. */
export async function reportCandidate(episodeDir: string, noteId: string, version: string, summary: string, by: string): Promise<Note> {
  const store = notesFor(episodeDir);
  const n = store.get(noteId);
  if (!n) throw new Error(`No note ${noteId}.`);
  if (!n.sid) throw new Error(`Note ${noteId} is not bound to a shot.`);
  const v = normalizeVersion(version);
  const p = takePath(episodeDir, n.sid, v);
  if (!fs.existsSync(p)) throw new Error(`No take at ${p}.`);
  return markCandidate(episodeDir, noteId, v, summary, by);
}
