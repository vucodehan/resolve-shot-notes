#!/usr/bin/env node
import fs from "node:fs";
import { call, ensureService, health } from "./client.js";
import { CONFIG_PATH, loadConfig, PID_PATH } from "./config.js";
import type { Note } from "./notes.js";

const USAGE = `imagine-review <command>

  start                 start the background service (if it is not running)
  stop                  stop it
  status                service, sign-in and config
  login                 sign in to Cursor in the browser (mints a 90-day API key)
  logout                forget the stored sign-in
  harvest [episodeDir]  file the open Resolve timeline's review markers as notes
  notes <episodeDir>    list an episode's notes
  probe-markers         measure how Resolve counts clip marker frames (adds and removes one marker)
  selftest [episodeDir clipName]
                        ask the open panel to test every Resolve operation it uses (adds nothing permanent)
`;

async function main(): Promise<void> {
  const [cmd, arg] = process.argv.slice(2);
  switch (cmd) {
    case "start":
      await ensureService();
      console.log(JSON.stringify(await health(), null, 1));
      break;
    case "stop": {
      if (!fs.existsSync(PID_PATH)) {
        console.log("not running");
        break;
      }
      const pid = Number(fs.readFileSync(PID_PATH, "utf8"));
      try {
        process.kill(pid);
        console.log(`stopped ${pid}`);
      } catch {
        console.log(`process ${pid} was not running`);
      }
      fs.rmSync(PID_PATH, { force: true });
      break;
    }
    case "status":
      console.log(JSON.stringify({ config: CONFIG_PATH, service: await health(), projectsRoots: loadConfig().projectsRoots }, null, 1));
      break;
    case "login": {
      await ensureService();
      const r = await call<{ url: string }>("POST", "/api/auth/login");
      console.log(`Finish signing in in the browser: ${r.url}`);
      const until = Date.now() + 5 * 60_000;
      while (Date.now() < until) {
        await new Promise((res) => setTimeout(res, 2000));
        const a = await call<{ status: string; email?: string }>("GET", "/api/auth");
        if (a.status === "logged-in") {
          console.log(`Signed in${a.email ? ` as ${a.email}` : ""}.`);
          return;
        }
      }
      throw new Error("sign-in timed out");
    }
    case "logout":
      console.log(JSON.stringify(await call("POST", "/api/auth/logout")));
      break;
    case "harvest": {
      const r = await call<{ project: string; episodeDir: string; created: Note[]; updated: Note[]; ignored: number }>("POST", "/api/harvest", { episodeDir: arg });
      console.log(`${r.project}\n${r.episodeDir}\ncreated ${r.created.length}, updated ${r.updated.length}, other markers ignored ${r.ignored}`);
      for (const n of r.created) console.log(`  ${n.id} ${n.sid ?? "?"} ${n.version ?? ""} ${n.kind} ${n.category}: ${n.text}`);
      break;
    }
    case "notes": {
      if (!arg) throw new Error("notes <episodeDir>");
      for (const n of await call<Note[]>("GET", "/api/notes", undefined, { episodeDir: arg })) {
        console.log(`${n.id} [${n.status}] ${n.sid ?? "?"} ${n.version ?? ""} ${n.kind}/${n.category} ${n.timecode ?? ""}: ${n.text}`);
      }
      break;
    }
    case "probe-markers":
      console.log(JSON.stringify(await call("POST", "/api/probe/clip-marker"), null, 1));
      break;
    case "selftest":
      console.log(JSON.stringify(await call("POST", "/api/selftest/run", { episodeDir: arg, clipName: process.argv[4] }), null, 1));
      break;
    default:
      console.log(USAGE);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
