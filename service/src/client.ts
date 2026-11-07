import { spawn } from "node:child_process";
import { loadConfig } from "./config.js";

export async function health(): Promise<Record<string, unknown> | null> {
  const cfg = loadConfig();
  try {
    const r = await fetch(`http://127.0.0.1:${cfg.port}/api/health`, { headers: { "x-imagine-token": cfg.token }, signal: AbortSignal.timeout(2000) });
    return r.ok ? ((await r.json()) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * On Windows a child started from Node inherits every inheritable handle, including the caller's stdout pipe, so a
 * service spawned from the MCP server or an installer would keep that pipe open. Start-Process starts it without them.
 */
export function launchService(nodePath: string, entry: string): void {
  if (process.platform === "win32") {
    const q = (s: string) => s.replace(/'/g, "''");
    const cmd = `Start-Process -FilePath '${q(nodePath)}' -ArgumentList '"${q(entry)}"' -WindowStyle Hidden`;
    spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", cmd], { stdio: "ignore", windowsHide: true });
    return;
  }
  spawn(nodePath, [entry], { detached: true, stdio: "ignore" }).unref();
}

/** Starts the background service if it is not answering, and waits for it. */
export async function ensureService(timeoutMs = 15_000): Promise<void> {
  if (await health()) return;
  const cfg = loadConfig();
  launchService(cfg.nodePath, cfg.serviceEntry);
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 400));
    if (await health()) return;
  }
  throw new Error(`The Imagine Review service did not start (node ${cfg.nodePath} ${cfg.serviceEntry}). See %APPDATA%\\ImagineReview\\logs\\service.log.`);
}

export async function call<T = unknown>(method: "GET" | "POST", path: string, body?: unknown, query?: Record<string, string>): Promise<T> {
  await ensureService();
  const cfg = loadConfig();
  const url = new URL(`http://127.0.0.1:${cfg.port}${path}`);
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
  const r = await fetch(url, {
    method,
    headers: { "x-imagine-token": cfg.token, "Content-Type": "application/json" },
    body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
    signal: AbortSignal.timeout(180_000),
  });
  const data = (await r.json()) as T & { error?: string };
  if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
  return data;
}
