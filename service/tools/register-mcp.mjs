// Adds (or with --remove, removes) the imagine-review MCP server in ~/.cursor/mcp.json, keeping a backup.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const remove = process.argv.includes("--remove");
const nodeArg = process.argv.indexOf("--node");
const nodePath = nodeArg > 0 ? process.argv[nodeArg + 1] : process.execPath;
const file = path.join(os.homedir(), ".cursor", "mcp.json");
const entry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "mcp.js");

let data = { mcpServers: {} };
if (fs.existsSync(file)) {
  const raw = fs.readFileSync(file, "utf8");
  data = raw.trim() ? JSON.parse(raw) : { mcpServers: {} };
  fs.writeFileSync(`${file}.bak-imagine-review`, raw, "utf8");
}
data.mcpServers ??= {};
if (remove) {
  delete data.mcpServers["imagine-review"];
} else {
  data.mcpServers["imagine-review"] = { command: nodePath, args: [entry] };
}
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf8");
console.log(`${remove ? "removed from" : "registered in"} ${file}${remove ? "" : `: ${nodePath} ${entry}`}`);
