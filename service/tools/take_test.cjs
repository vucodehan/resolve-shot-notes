// The panel's take functions (plugin/com.imagine.review/lib/resolve.js) run against the open Resolve project through
// external scripting (resolve_rpc.py), without the panel: load a candidate take on a noted clip, flip between the two,
// then accept or reject it, with the timeline's clips recorded before and after.
//
// node tools/take_test.cjs SCENARIO.json
//   SCENARIO: { "python": "...", "note": { ...a note with its candidate... }, "steps": ["load", "original", "candidate",
//               "accept" | "reject"], "out": "result.json" }
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const rv = require(path.join(__dirname, '..', '..', 'plugin', 'com.imagine.review', 'lib', 'resolve.js'));

class Bridge {
    constructor(python) {
        this.next = 1;
        this.pending = new Map();
        this.proc = spawn(python, ['-u', path.join(__dirname, 'resolve_rpc.py')], { stdio: ['pipe', 'pipe', 'inherit'] });
        this.ready = new Promise((res, rej) => { this.pending.set(0, { res, rej }); });
        readline.createInterface({ input: this.proc.stdout }).on('line', (line) => {
            const m = JSON.parse(line);
            const p = this.pending.get(m.id);
            if (!p) return;
            this.pending.delete(m.id);
            if (m.e) p.rej(new Error(m.e)); else p.res(m.r);
        });
    }
    call(h, m, a) {
        const id = this.next++;
        return new Promise((res, rej) => {
            this.pending.set(id, { res, rej });
            this.proc.stdin.write(JSON.stringify({ id, h, m, a }) + '\n');
        });
    }
    close() { this.proc.stdin.end(); }
}

function wrap(bridge, h) {
    const enc = (v) => {
        if (v && typeof v === 'object' && v.__h !== undefined) return { __h: v.__h };
        if (Array.isArray(v)) return v.map(enc);
        if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)]));
        return v;
    };
    const dec = (v) => {
        if (Array.isArray(v)) return v.map(dec);
        if (v && typeof v === 'object') {
            const keys = Object.keys(v);
            if (keys.length === 1 && keys[0] === '__h') return wrap(bridge, v.__h);
            return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, dec(x)]));
        }
        return v;
    };
    return new Proxy({}, {
        get(_, prop) {
            if (prop === 'then') return undefined;
            if (prop === '__h') return h;
            return (...args) => bridge.call(h, String(prop), args.map(enc)).then(dec);
        },
    });
}

/** Every clip on every track, with its frames and enabled state, and each audio track's name and state. */
async function timelineState() {
    const r = await rv.resolve();
    const project = await (await r.GetProjectManager()).GetCurrentProject();
    const tl = await project.GetCurrentTimeline();
    const out = { project: await project.GetName(), video: [], audio: [] };
    for (const kind of ['video', 'audio']) {
        const n = await tl.GetTrackCount(kind);
        for (let t = 1; t <= n; t++) {
            const clips = [];
            for (const it of (await tl.GetItemListInTrack(kind, t)) || []) {
                clips.push({ name: await it.GetName(), start: await it.GetStart(), end: await it.GetEnd(), left: await it.GetLeftOffset(), enabled: await it.GetClipEnabled() });
            }
            out[kind].push({ track: t, name: await tl.GetTrackName(kind, t), enabled: await tl.GetIsTrackEnabled(kind, t), clips });
        }
    }
    return out;
}

async function main() {
    const sc = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
    const bridge = new Bridge(sc.python || 'python');
    const res = { steps: [] };
    try {
        await bridge.ready;
        rv.useResolve(wrap(bridge, 0));
        res.before = await timelineState();
        for (const s of sc.steps) {
            if (s === 'load') res.steps.push({ load: await rv.loadTake(sc.note) });
            else if (s === 'original' || s === 'candidate') res.steps.push({ [s]: await rv.selectTake(sc.note, s) });
            else if (s === 'accept') res.steps.push({ accept: await rv.finalizeTake(sc.note, 'candidate') });
            else if (s === 'reject') res.steps.push({ reject: await rv.finalizeTake(sc.note, 'original') });
            if (s === 'load') res.loaded = await timelineState();
        }
        res.after = await timelineState();
        res.saved = await rv.saveProject();
        res.ok = true;
    } catch (e) {
        res.ok = false;
        res.error = e && e.stack ? e.stack : String(e);
    } finally {
        bridge.close();
    }
    fs.writeFileSync(sc.out, JSON.stringify(res, null, 1));
    console.log(JSON.stringify({ ok: res.ok, error: res.error, steps: res.steps }, null, 1));
    process.exit(res.ok ? 0 : 1);
}

main();
