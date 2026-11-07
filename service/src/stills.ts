import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { loadConfig } from "./config.js";
import { log } from "./log.js";

const run = promisify(execFile);

export async function probeFps(media: string): Promise<number | null> {
  const cfg = loadConfig();
  try {
    const { stdout } = await run(cfg.ffprobePath, [
      "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=r_frame_rate", "-of", "csv=p=0", media,
    ], { windowsHide: true, timeout: 15_000 });
    const [n, d] = stdout.trim().split("/").map(Number);
    return n && d ? n / d : null;
  } catch {
    return null;
  }
}

/** Exact frame from the take file (ungraded, the frame the generator made). Output-side seek so the frame is exact. */
export async function extractFrame(media: string, frame: number, fps: number, out: string): Promise<boolean> {
  const cfg = loadConfig();
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const t = Math.max(0, frame) / fps;
  try {
    await run(cfg.ffmpegPath, [
      "-hide_banner", "-loglevel", "error", "-y", "-i", media, "-ss", t.toFixed(4),
      "-frames:v", "1", "-vf", "scale='min(1280,iw)':-2", "-q:v", "3", out,
    ], { windowsHide: true, timeout: 30_000 });
    return fs.existsSync(out);
  } catch (e) {
    log.warn("still extraction failed", { media, frame, error: String(e) });
    return false;
  }
}

/**
 * Stills for a note: one frame for a point note; first, middle and last for a range.
 * Returns paths relative to the episode folder.
 */
export async function stillsForNote(
  episodeDir: string, noteId: string, media: string, sourceFrame: number, durationFrames: number, fps: number,
): Promise<string[]> {
  if (!fs.existsSync(media)) return [];
  const frames = durationFrames > 2
    ? [sourceFrame, sourceFrame + Math.floor((durationFrames - 1) / 2), sourceFrame + durationFrames - 1]
    : [sourceFrame];
  const out: string[] = [];
  for (const [i, f] of frames.entries()) {
    const rel = path.join("review", "stills", `${noteId}-${"abc"[i]}-f${f}.jpg`);
    if (await extractFrame(media, f, fps, path.join(episodeDir, rel))) out.push(rel);
  }
  return out;
}
