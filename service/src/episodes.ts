import fs from "node:fs";
import path from "node:path";
import { loadConfig, updateConfig } from "./config.js";
import { log } from "./log.js";

export interface EpisodeRef {
  dir: string;
  /** Release name: the Resolve project name and the master's file stem. */
  release: string;
  /** Folder that holds the episode (the series folder); the repair agent's workspace. */
  seriesDir: string;
}

export interface TakeVersion {
  version: string;
  number: number;
  mp4: string;
  prompt?: string;
  auto?: string;
  review?: string;
  result?: string;
}

export interface ShotInfo {
  sid: string;
  manifestVersion?: string;
  manifestStatus?: string;
  versions: TakeVersion[];
}

const SKIP_DIRS = new Set([
  "node_modules", "_tools", "assets", "shots", "discard", "research", "resolve", ".git", "venv",
  "harvest", "review", "cine", "_locks", "RETIRED PIPELINES",
]);

let index = new Map<string, EpisodeRef>();
let indexedAt = 0;

/**
 * Resolve appends " (2)", " (3)" when a project name is taken, and the show's shared builder names its projects
 * "<release> (mixed)" (the dialogue as mixed at the master's levels); the episode is the same.
 */
export function releaseFromProject(projectName: string): string {
  let s = projectName.trim();
  for (let prev = ""; s !== prev;) {
    prev = s;
    s = s.replace(/\s\(\d+\)$/, "").replace(/\s\(mixed\)$/i, "").trim();
  }
  return s;
}

function walk(dir: string, depth: number, found: Map<string, EpisodeRef>): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const full = path.join(dir, e.name);
    if (e.name === "outputs") {
      let files: string[] = [];
      try {
        files = fs.readdirSync(full);
      } catch {
        continue;
      }
      for (const f of files) {
        if (!/\.(drp|mp4)$/i.test(f) || /-sheet\.|\.check\./i.test(f)) continue;
        const release = f.replace(/\.(drp|mp4)$/i, "");
        if (!found.has(release) || f.toLowerCase().endsWith(".drp")) {
          found.set(release, { dir, release, seriesDir: path.dirname(dir) });
        }
      }
      continue;
    }
    if (SKIP_DIRS.has(e.name) || depth <= 0) continue;
    walk(full, depth - 1, found);
  }
}

export function rebuildIndex(): Map<string, EpisodeRef> {
  const cfg = loadConfig();
  const found = new Map<string, EpisodeRef>();
  for (const root of cfg.projectsRoots) walk(root, 4, found);
  index = found;
  indexedAt = Date.now();
  log.info("episode index rebuilt", { episodes: found.size });
  return found;
}

export function findEpisode(projectName: string): EpisodeRef | null {
  const cfg = loadConfig();
  const release = releaseFromProject(projectName);
  const bound = cfg.episodeBindings[release];
  if (bound && fs.existsSync(bound)) return { dir: bound, release, seriesDir: path.dirname(bound) };
  let hit = index.get(release);
  if (!hit && Date.now() - indexedAt > 10_000) hit = rebuildIndex().get(release);
  return hit ?? null;
}

export function bindEpisode(projectName: string, dir: string): EpisodeRef {
  const release = releaseFromProject(projectName);
  const cfg = loadConfig();
  updateConfig({ episodeBindings: { ...cfg.episodeBindings, [release]: dir } });
  return { dir, release, seriesDir: path.dirname(dir) };
}

export function episodeFromDir(dir: string): EpisodeRef {
  const outputs = path.join(dir, "outputs");
  let release = path.basename(dir);
  try {
    const drp = fs.readdirSync(outputs).find((f) => f.toLowerCase().endsWith(".drp"));
    if (drp) release = drp.replace(/\.drp$/i, "");
  } catch {
    /* no outputs folder yet */
  }
  return { dir, release, seriesDir: path.dirname(dir) };
}

export function listEpisodes(): EpisodeRef[] {
  if (Date.now() - indexedAt > 60_000) rebuildIndex();
  return [...index.values()];
}

/** "S07-v9.mp4" -> { sid: "S07", version: "v9" }; the pipeline's .drp builders name every clip this way. */
export function parseClipName(name: string): { sid: string; version: string } | null {
  const m = /^([A-Za-z0-9_]+?)-(v\d+)\.(mp4|mov|mxf|mkv)$/i.exec(name.trim());
  return m ? { sid: m[1], version: m[2].toLowerCase() } : null;
}

export function readManifest(dir: string): Map<string, { version: string; status: string }> {
  const out = new Map<string, { version: string; status: string }>();
  const p = path.join(dir, "shots", "manifest.txt");
  if (!fs.existsSync(p)) return out;
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = /^(\S+)\s+(v\d+)(?:\s+(\S+))?/.exec(line.trim());
    if (m) out.set(m[1], { version: m[2], status: m[3] ?? "" });
  }
  return out;
}

export function takesDir(dir: string, sid: string): string {
  return path.join(dir, "shots", "takes", sid);
}

export function takePath(dir: string, sid: string, version: string): string {
  return path.join(takesDir(dir, sid), `${version}.mp4`);
}

function reviewResult(file: string): string | undefined {
  try {
    const text = fs.readFileSync(file, "utf8");
    const m = /result:\s*([a-z_]+)/gi;
    let last: string | undefined;
    for (let r = m.exec(text); r; r = m.exec(text)) last = r[1];
    return last;
  } catch {
    return undefined;
  }
}

export function listVersions(dir: string, sid: string): TakeVersion[] {
  const td = takesDir(dir, sid);
  let files: string[] = [];
  try {
    files = fs.readdirSync(td);
  } catch {
    return [];
  }
  const set = new Set(files);
  const out: TakeVersion[] = [];
  for (const f of files) {
    const m = /^v(\d+)\.mp4$/i.exec(f);
    if (!m) continue;
    const version = `v${m[1]}`;
    const tv: TakeVersion = { version, number: Number(m[1]), mp4: path.join(td, f) };
    if (set.has(`${version}.prompt.txt`)) tv.prompt = path.join(td, `${version}.prompt.txt`);
    if (set.has(`${version}.auto.json`)) tv.auto = path.join(td, `${version}.auto.json`);
    if (set.has(`${version}.review.md`)) {
      tv.review = path.join(td, `${version}.review.md`);
      tv.result = reviewResult(tv.review);
    }
    out.push(tv);
  }
  return out.sort((a, b) => a.number - b.number);
}

export function maxVersion(dir: string, sid: string): number {
  const v = listVersions(dir, sid);
  return v.length ? v[v.length - 1].number : 0;
}

export function shotInfo(dir: string, sid: string): ShotInfo {
  const man = readManifest(dir).get(sid);
  return { sid, manifestVersion: man?.version, manifestStatus: man?.status, versions: listVersions(dir, sid) };
}

/** The person accepted a take in Resolve: the manifest names it, and the replaced line is kept in manifest.history. */
export function setManifestVersion(dir: string, sid: string, version: string, status: string): void {
  const p = path.join(dir, "shots", "manifest.txt");
  const lines = fs.existsSync(p) ? fs.readFileSync(p, "utf8").split(/\r?\n/) : [];
  let replaced: string | null = null;
  const next = lines.map((line) => {
    const m = /^(\S+)\s+v\d+/.exec(line.trim());
    if (m && m[1] === sid) {
      replaced = line;
      return `${sid} ${version} ${status}`;
    }
    return line;
  });
  if (replaced === null) next.splice(next.length && next[next.length - 1] === "" ? next.length - 1 : next.length, 0, `${sid} ${version} ${status}`);
  fs.writeFileSync(p, next.join("\n"), "utf8");
  fs.appendFileSync(path.join(dir, "shots", "manifest.history"),
    `${new Date().toISOString()}\t${sid}\t${replaced ?? "(none)"}\t->\t${sid} ${version} ${status}\n`, "utf8");
}
