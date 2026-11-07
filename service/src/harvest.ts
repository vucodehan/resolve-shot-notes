import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { loadConfig } from "./config.js";
import { findEpisode } from "./episodes.js";
import { emit } from "./events.js";
import { importMarkers, type ResolveSnapshot } from "./markers.js";

const run = promisify(execFile);
const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "tools", "resolve_harvest.py");

async function python(args: string[]): Promise<unknown> {
  const cfg = loadConfig();
  const env = {
    ...process.env,
    RESOLVE_SCRIPT_API: cfg.resolveScriptApi,
    RESOLVE_SCRIPT_LIB: cfg.resolveScriptLib,
    PYTHONPATH: cfg.resolveModules,
  };
  const { stdout } = await run(cfg.pythonPath, [SCRIPT, ...args], { env, windowsHide: true, timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
  const out = JSON.parse(stdout) as { error?: string };
  if (out && typeof out === "object" && out.error) throw new Error(out.error);
  return out;
}

export async function resolveSnapshot(): Promise<ResolveSnapshot> {
  return (await python(["snapshot"])) as ResolveSnapshot;
}

export async function probeClipMarker(): Promise<unknown> {
  return python(["probe-clip-marker"]);
}

/** Harvest the open Resolve timeline's review markers into the episode's notes (external scripting, no panel needed). */
export async function harvestOpenProject(episodeDirOverride?: string) {
  const snap = await resolveSnapshot();
  const ep = episodeDirOverride ? { dir: episodeDirOverride } : findEpisode(snap.project);
  if (!ep) throw new Error(`No episode folder found for the Resolve project "${snap.project}". Bind it from the panel or pass episodeDir.`);
  const result = await importMarkers(ep.dir, snap, "harvest");
  if (result.tags.length) {
    const tmp = path.join(os.tmpdir(), `imagine-review-tags-${process.pid}-${Date.now()}.json`);
    fs.writeFileSync(tmp, JSON.stringify(result.tags), "utf8");
    try {
      await python(["tag", tmp]);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }
  for (const n of [...result.created, ...result.updated]) emit({ type: "note.updated", episodeDir: ep.dir, note: n });
  return { project: snap.project, timeline: snap.timeline, episodeDir: ep.dir, created: result.created, updated: result.updated, ignored: result.ignored };
}
