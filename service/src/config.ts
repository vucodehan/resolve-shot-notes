import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const APP_NAME = "ImagineReview";
export const VERSION = "0.1.0";

function appDataRoot(): string {
  if (process.platform === "win32") {
    return process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support");
  }
  return process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
}

export const APP_DIR = path.join(appDataRoot(), APP_NAME);
export const CONFIG_PATH = path.join(APP_DIR, "config.json");
export const LOG_DIR = path.join(APP_DIR, "logs");
export const PID_PATH = path.join(APP_DIR, "service.pid");

export interface Config {
  /** Loopback port the service listens on. */
  port: number;
  /** Shared secret every client sends in the x-imagine-token header. */
  token: string;
  /** Node 22.13+ used to launch the service from the panel or the MCP server. */
  nodePath: string;
  /** Absolute path of dist/index.js. */
  serviceEntry: string;
  /** Folders searched for episode folders (each episode has outputs/<release>.drp). */
  projectsRoots: string[];
  /** The pipeline procedure the repair agent follows. */
  pipelineDoc: string;
  /** Python that can import DaVinciResolveScript (used for harvesting without the panel). */
  pythonPath: string;
  resolveScriptApi: string;
  resolveScriptLib: string;
  resolveModules: string;
  ffmpegPath: string;
  ffprobePath: string;
  /** Cursor model id for the repair agent; empty picks one automatically. */
  model: string;
  /** Marker colors that count as review notes. Blue is the pipeline's own shot marker. */
  reviewColors: Record<string, NoteKind>;
  /** How Resolve counts a clip marker's frame: from the clip's first visible frame, or from the media's first frame. */
  clipMarkerBase: "item" | "source";
  /** Resolve project name (without the " (n)" suffix) -> episode folder, set by the panel. */
  episodeBindings: Record<string, string>;
}

export type NoteKind = "regenerate" | "fix" | "question" | "approve" | "note";

export const DEFAULT_REVIEW_COLORS: Record<string, NoteKind> = {
  Red: "regenerate",
  Yellow: "fix",
  Cyan: "question",
  Green: "approve",
};

function defaults(): Config {
  const serviceEntry = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.js");
  return {
    port: 47615,
    token: crypto.randomBytes(24).toString("hex"),
    nodePath: process.execPath,
    serviceEntry,
    projectsRoots: [],
    pipelineDoc: "",
    pythonPath: "python",
    resolveScriptApi: "C:\\ProgramData\\Blackmagic Design\\DaVinci Resolve\\Support\\Developer\\Scripting",
    resolveScriptLib: "C:\\Program Files\\Blackmagic Design\\DaVinci Resolve\\fusionscript.dll",
    resolveModules: "C:\\ProgramData\\Blackmagic Design\\DaVinci Resolve\\Support\\Developer\\Scripting\\Modules",
    ffmpegPath: "ffmpeg",
    ffprobePath: "ffprobe",
    model: "",
    reviewColors: { ...DEFAULT_REVIEW_COLORS },
    clipMarkerBase: "source",
    episodeBindings: {},
  };
}

let cached: Config | null = null;

export function loadConfig(): Config {
  if (cached) return cached;
  fs.mkdirSync(APP_DIR, { recursive: true });
  let stored: Partial<Config> = {};
  if (fs.existsSync(CONFIG_PATH)) {
    stored = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) as Partial<Config>;
  }
  const merged: Config = { ...defaults(), ...stored };
  if (!merged.reviewColors || Object.keys(merged.reviewColors).length === 0) {
    merged.reviewColors = { ...DEFAULT_REVIEW_COLORS };
  }
  merged.episodeBindings ??= {};
  if (!stored.token) saveConfig(merged);
  cached = merged;
  return merged;
}

export function saveConfig(cfg: Config): void {
  fs.mkdirSync(APP_DIR, { recursive: true });
  const tmp = CONFIG_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), "utf8");
  fs.renameSync(tmp, CONFIG_PATH);
  cached = cfg;
}

export function updateConfig(patch: Partial<Config>): Config {
  const cfg = { ...loadConfig(), ...patch };
  saveConfig(cfg);
  return cfg;
}
