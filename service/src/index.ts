import fs from "node:fs";
import { loadConfig, PID_PATH, VERSION } from "./config.js";
import { rebuildIndex } from "./episodes.js";
import { startServer } from "./http.js";
import { log } from "./log.js";

async function alreadyRunning(port: number, token: string): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { "x-imagine-token": token }, signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  if (await alreadyRunning(cfg.port, cfg.token)) {
    log.info("service already running; exiting", { port: cfg.port });
    return;
  }
  const server = startServer();
  server.on("listening", () => {
    fs.writeFileSync(PID_PATH, String(process.pid), "utf8");
    log.info("imagine-review service listening", { version: VERSION, port: cfg.port, pid: process.pid });
    setTimeout(() => rebuildIndex(), 100);
  });
  server.on("error", (e) => {
    log.error("server error", e);
    process.exit(1);
  });
  const stop = () => {
    log.info("service stopping");
    try {
      if (fs.readFileSync(PID_PATH, "utf8").trim() === String(process.pid)) fs.rmSync(PID_PATH, { force: true });
    } catch {
      /* already gone */
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  process.on("unhandledRejection", (e) => log.error("unhandled rejection", e));
  process.on("uncaughtException", (e) => log.error("uncaught exception", e));
}

void main();
