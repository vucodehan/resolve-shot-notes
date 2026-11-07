// Talks to the Imagine Review background service (HTTP on 127.0.0.1), starting it when it is not running.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

function configPath() {
    if (process.platform === 'win32') {
        return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'ImagineReview', 'config.json');
    }
    if (process.platform === 'darwin') {
        return path.join(os.homedir(), 'Library', 'Application Support', 'ImagineReview', 'config.json');
    }
    return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'ImagineReview', 'config.json');
}

function readConfig() {
    const p = configPath();
    if (!fs.existsSync(p)) {
        throw new Error('Imagine Review is not installed for this user (no ' + p + '). Run scripts\\install.ps1.');
    }
    return JSON.parse(fs.readFileSync(p, 'utf8'));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function health(cfg) {
    try {
        const r = await fetch('http://127.0.0.1:' + cfg.port + '/api/health', {
            headers: { 'x-imagine-token': cfg.token },
            signal: AbortSignal.timeout(2000),
        });
        return r.ok ? await r.json() : null;
    } catch {
        return null;
    }
}

// Start-Process on Windows so the service does not inherit this process's handles.
function launch(cfg) {
    if (process.platform === 'win32') {
        const q = (s) => s.replace(/'/g, "''");
        const cmd = "Start-Process -FilePath '" + q(cfg.nodePath) + "' -ArgumentList '\"" + q(cfg.serviceEntry) + "\"' -WindowStyle Hidden";
        spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', cmd], { stdio: 'ignore', windowsHide: true });
        return;
    }
    spawn(cfg.nodePath, [cfg.serviceEntry], { detached: true, stdio: 'ignore' }).unref();
}

let launching = null;

async function ensureRunning() {
    const cfg = readConfig();
    const h = await health(cfg);
    if (h) return h;
    if (!launching) {
        launching = Promise.resolve().then(() => launch(cfg));
        setTimeout(() => { launching = null; }, 20000);
    }
    for (let i = 0; i < 40; i++) {
        await sleep(400);
        const again = await health(cfg);
        if (again) return again;
    }
    throw new Error('The Imagine Review service did not start. See %APPDATA%\\ImagineReview\\logs\\service.log.');
}

async function call(method, route, body, query) {
    const cfg = readConfig();
    const url = new URL('http://127.0.0.1:' + cfg.port + route);
    for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);
    const doFetch = () => fetch(url, {
        method,
        headers: { 'x-imagine-token': cfg.token, 'Content-Type': 'application/json' },
        body: method === 'POST' ? JSON.stringify(body || {}) : undefined,
        signal: AbortSignal.timeout(180000),
    });
    let r;
    try {
        r = await doFetch();
    } catch {
        await ensureRunning();
        r = await doFetch();
    }
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
    return data;
}

/** Server-sent events from the service, forwarded to onEvent; reconnects until stop() is called. */
function subscribe(onEvent, onState) {
    let stopped = false;
    let controller = null;
    (async () => {
        while (!stopped) {
            try {
                await ensureRunning();
                const cfg = readConfig();
                controller = new AbortController();
                const r = await fetch('http://127.0.0.1:' + cfg.port + '/api/events', {
                    headers: { 'x-imagine-token': cfg.token },
                    signal: controller.signal,
                });
                if (!r.ok || !r.body) throw new Error('events HTTP ' + r.status);
                onState(true);
                const reader = r.body.getReader();
                const decoder = new TextDecoder();
                let buf = '';
                for (;;) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    buf += decoder.decode(value, { stream: true });
                    let i;
                    while ((i = buf.indexOf('\n\n')) >= 0) {
                        const chunk = buf.slice(0, i);
                        buf = buf.slice(i + 2);
                        const data = chunk.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
                        if (!data) continue;
                        try {
                            onEvent(JSON.parse(data));
                        } catch {
                            /* keepalive or malformed */
                        }
                    }
                }
            } catch {
                /* service restarting; retry */
            }
            onState(false);
            if (!stopped) await sleep(2000);
        }
    })();
    return () => {
        stopped = true;
        if (controller) controller.abort();
    };
}

module.exports = { readConfig, ensureRunning, call, subscribe, health };
