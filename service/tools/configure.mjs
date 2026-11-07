// Writes %APPDATA%\ImagineReview\config.json for this machine. Run by scripts/install.ps1; safe to re-run.
//   node tools/configure.mjs --projects "<root>" [--projects "<root2>"] [--pipeline "<doc.md>"] [--python "<python.exe>"]
//                            [--node "<node.exe>"] [--ffmpeg "<ffmpeg.exe>"] [--ffprobe "<ffprobe.exe>"] [--model <id>]
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, updateConfig, CONFIG_PATH } from "../dist/config.js";

const args = process.argv.slice(2);
const all = (flag) => args.flatMap((a, i) => (a === flag && args[i + 1] ? [args[i + 1]] : []));
const one = (flag) => all(flag)[0];

const here = path.dirname(fileURLToPath(import.meta.url));
const cfg = loadConfig();
const patch = {
  serviceEntry: path.resolve(here, "..", "dist", "index.js"),
  nodePath: one("--node") ?? process.execPath,
};
const roots = all("--projects");
if (roots.length) patch.projectsRoots = roots.map((r) => path.resolve(r));
if (one("--pipeline")) patch.pipelineDoc = path.resolve(one("--pipeline"));
if (one("--python")) patch.pythonPath = one("--python");
if (one("--ffmpeg")) patch.ffmpegPath = one("--ffmpeg");
if (one("--ffprobe")) patch.ffprobePath = one("--ffprobe");
if (one("--model") !== undefined) patch.model = one("--model");
const next = updateConfig({ ...cfg, ...patch });
console.log(JSON.stringify({ config: CONFIG_PATH, port: next.port, projectsRoots: next.projectsRoots, pipelineDoc: next.pipelineDoc, serviceEntry: next.serviceEntry, nodePath: next.nodePath, pythonPath: next.pythonPath, ffmpegPath: next.ffmpegPath }, null, 1));
