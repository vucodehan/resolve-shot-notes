import type { ServerResponse } from "node:http";

export interface BusEvent {
  type: string;
  episodeDir?: string;
  [key: string]: unknown;
}

const clients = new Set<ServerResponse>();
let seq = 0;

export function addClient(res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(`event: hello\ndata: {}\n\n`);
  clients.add(res);
  res.on("close", () => clients.delete(res));
}

/** Event-stream subscribers; only open panels subscribe. */
export function clientCount(): number {
  return clients.size;
}

export function emit(ev: BusEvent): void {
  const payload = `id: ${++seq}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`;
  for (const c of clients) {
    try {
      c.write(payload);
    } catch {
      clients.delete(c);
    }
  }
}

setInterval(() => {
  for (const c of clients) {
    try {
      c.write(`: keepalive\n\n`);
    } catch {
      clients.delete(c);
    }
  }
}, 15_000).unref();
