import fs from "node:fs";
import path from "node:path";
import { LOG_DIR } from "./config.js";

let stream: fs.WriteStream | null = null;

function out(): fs.WriteStream {
  if (!stream) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    stream = fs.createWriteStream(path.join(LOG_DIR, "service.log"), { flags: "a" });
  }
  return stream;
}

function write(level: string, msg: string, extra?: unknown): void {
  const line = `${new Date().toISOString()} ${level} ${msg}${extra === undefined ? "" : " " + safeJson(extra)}`;
  out().write(line + "\n");
  if (process.stderr.isTTY) process.stderr.write(line + "\n");
}

function safeJson(v: unknown): string {
  if (v instanceof Error) return JSON.stringify({ name: v.name, message: v.message, stack: v.stack });
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export const log = {
  info: (msg: string, extra?: unknown) => write("INFO", msg, extra),
  warn: (msg: string, extra?: unknown) => write("WARN", msg, extra),
  error: (msg: string, extra?: unknown) => write("ERROR", msg, extra),
};
