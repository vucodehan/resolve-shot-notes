// Sign in to Cursor for Imagine Review: opens the browser, mints a named 90-day user API key,
// and stores it where the Cursor SDK looks for it (~/.cursor/sdk/auth.json).
//   node tools/sign-in.mjs            sign in (skips if already signed in)
//   node tools/sign-in.mjs --force    sign in again
//   node tools/sign-in.mjs --status   print the current state
import { spawn } from "node:child_process";
import { Cursor } from "@cursor/sdk";

function openBrowser(url) {
  if (process.platform === "win32") {
    spawn("rundll32", ["url.dll,FileProtocolHandler", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  } else {
    spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
  }
}

const force = process.argv.includes("--force");
const before = await Cursor.auth.status();
if (process.argv.includes("--status")) {
  console.log(JSON.stringify(before));
  process.exit(0);
}
if (before.status === "logged-in" && !force) {
  console.log(`Already signed in${before.email ? ` as ${before.email}` : ""}.`);
} else {
  const r = await Cursor.auth.login({
    apiKeyName: "Imagine Review (DaVinci Resolve)",
    openBrowser: false,
    onLoginUrl: (url) => {
      console.log(`LOGIN_URL ${url}`);
      openBrowser(url);
    },
  });
  console.log(`LOGGED_IN ${r.email ?? ""} key expires ${new Date(r.apiKeyExpiresAtMs).toISOString()}`);
}
const me = await Cursor.me();
console.log(`ME ${me.apiKeyName} ${me.userEmail ?? ""}`);
const models = await Cursor.models.list();
console.log(`MODELS ${models.map((m) => m.id).join(", ")}`);
