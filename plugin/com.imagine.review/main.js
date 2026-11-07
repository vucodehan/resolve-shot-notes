// Imagine Review: DaVinci Resolve Workflow Integration panel (Electron main process).
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const rv = require('./lib/resolve');
const svc = require('./lib/service');
const selftest = require('./lib/selftest');

let win = null;
let context = { projectName: null };
let episode = null;
let polling = false;
let pollCount = 0;
let stopEvents = null;

function toRenderer(channel, payload) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function errorText(e) {
    return e && e.message ? e.message : String(e);
}

/** Wraps an IPC handler so failures reach the renderer as { error } instead of rejecting. */
function handle(channel, fn) {
    ipcMain.handle(channel, async (_ev, ...args) => {
        try {
            return { ok: true, data: await fn(...args) };
        } catch (e) {
            return { ok: false, error: errorText(e) };
        }
    });
}

async function refreshEpisode(projectName) {
    if (!projectName) {
        episode = null;
    } else {
        const r = await svc.call('POST', '/api/context', { projectName });
        episode = r.episode;
    }
    toRenderer('episode', episode);
}

async function poll() {
    if (polling) return;
    polling = true;
    try {
        const full = pollCount % 2 === 0;
        pollCount++;
        const next = await rv.readContext(full);
        if (!full) {
            next.selected = context.selected || [];
            next.markIn = context.markIn;
            next.markOut = context.markOut;
        }
        const projectChanged = next.projectName !== context.projectName;
        const changed = JSON.stringify(next) !== JSON.stringify(context);
        context = next;
        if (projectChanged) await refreshEpisode(next.projectName).catch((e) => toRenderer('toast', { level: 'error', text: errorText(e) }));
        if (changed) toRenderer('context', context);
    } catch (e) {
        toRenderer('context', { error: errorText(e) });
    } finally {
        polling = false;
    }
}

function requireEpisode() {
    if (!episode) throw new Error('This Resolve project is not linked to an episode folder yet. Use "Link episode folder".');
    return episode.dir;
}

/** Where a note goes on a clip: the In/Out range when it lies on this clip, else the playhead, else the clip's middle. */
function noteSpan(clip, useRange) {
    const inClip = (f) => f !== null && f !== undefined && f >= clip.start && f < clip.end;
    if (useRange && inClip(context.markIn) && context.markOut !== null && context.markOut >= context.markIn) {
        return { recordAbs: context.markIn, durationFrames: Math.min(context.markOut, clip.end - 1) - context.markIn + 1 };
    }
    if (inClip(context.playhead)) return { recordAbs: context.playhead, durationFrames: 1 };
    return { recordAbs: Math.floor((clip.start + clip.end) / 2), durationFrames: 1 };
}

function registerIpc() {
    handle('state', async () => ({ context, episode, health: await svc.health(svc.readConfig()) }));

    handle('note:create', async ({ kind, category, text, useSelection, useRange }) => {
        const dir = requireEpisode();
        const targets = useSelection && context.selected && context.selected.length ? context.selected : (context.clip ? [context.clip] : []);
        const created = [];
        if (!targets.length) {
            const r = await svc.call('POST', '/api/notes', {
                episodeDir: dir, kind, category, text, fps: context.fps, startFrame: context.startFrame, recordAbs: context.playhead, durationFrames: 1,
            });
            await rv.placeMarker(r.marker, null, null, r.note.recordFrame);
            created.push(r.note);
        }
        for (const clip of targets) {
            const span = noteSpan(clip, useRange);
            const r = await svc.call('POST', '/api/notes', {
                episodeDir: dir, kind, category, text, clip, fps: context.fps, startFrame: context.startFrame, ...span,
            });
            try {
                await rv.placeMarker(r.marker, clip.id, clip.name, r.note.recordFrame);
                await rv.setClipColor(clip.id, clip.name, r.note.recordFrame, kind);
            } catch (e) {
                toRenderer('toast', { level: 'warn', text: r.note.id + ' saved, but the marker was not placed: ' + errorText(e) });
            }
            created.push(r.note);
        }
        return created;
    });

    handle('notes:list', async () => (episode ? svc.call('GET', '/api/notes', undefined, { episodeDir: episode.dir }) : []));

    handle('notes:import', async () => {
        const dir = requireEpisode();
        const snap = await rv.snapshot();
        const r = await svc.call('POST', '/api/import', { episodeDir: dir, snapshot: snap, source: 'harvest' });
        const tagged = r.tags.length ? await rv.tagMarkers(r.tags) : 0;
        return { created: r.created.length, updated: r.updated.length, tagged };
    });

    handle('note:jump', async (note) => {
        if (!note.timecode) throw new Error('This note has no timecode.');
        return rv.jumpTo(note.timecode);
    });

    handle('note:update', async (id, patch) => svc.call('POST', '/api/notes/update', { episodeDir: requireEpisode(), id, patch, by: 'person' }));
    handle('note:comment', async (id, text) => svc.call('POST', '/api/notes/comment', { episodeDir: requireEpisode(), id, text, by: 'person' }));

    handle('take:load', async (note) => rv.loadTake(note));
    handle('take:select', async (note, which) => rv.selectTake(note, which));
    handle('take:accept', async (note) => {
        await rv.finalizeTake(note, 'candidate');
        const updated = await svc.call('POST', '/api/notes/accept', { episodeDir: requireEpisode(), id: note.id });
        await rv.recolorMarker(note, 'Green').catch(() => false);
        await rv.setClipColor(note.timelineItemId, note.clipName, note.recordFrame, 'approve').catch(() => false);
        await rv.saveProject().catch(() => false);
        return updated;
    });
    handle('take:reject', async (note, reason) => {
        if (rv.isLoaded(note.id)) await rv.finalizeTake(note, 'original');
        return svc.call('POST', '/api/notes/reject', { episodeDir: requireEpisode(), id: note.id, reason });
    });

    handle('agent:send', async (noteIds) => svc.call('POST', '/api/agent/send', { episodeDir: requireEpisode(), noteIds }));
    handle('agent:chat', async (text, attachShot) => {
        const dir = requireEpisode();
        const c = context.clip;
        const m = c && /^([A-Za-z0-9_]+?)-(v\d+)\./.exec(c.name);
        const ctx = m ? { sid: m[1], version: m[2], timecode: context.timecode, clipName: c.name, line: context.shotMarker && context.shotMarker.note } : undefined;
        let images = [];
        if (attachShot && c) {
            const r = await svc.call('POST', '/api/still/grab', {
                episodeDir: dir, clip: c, fps: context.fps, startFrame: context.startFrame, recordAbs: context.playhead,
            });
            images = r.stills;
        }
        return svc.call('POST', '/api/agent/chat', { episodeDir: dir, text, context: ctx, images });
    });
    handle('agent:cancel', async () => svc.call('POST', '/api/agent/cancel', { episodeDir: requireEpisode() }));
    handle('agent:history', async () => (episode ? svc.call('GET', '/api/agent/history', undefined, { episodeDir: episode.dir }) : { busy: false, entries: [] }));

    handle('auth:status', async () => svc.call('GET', '/api/auth'));
    handle('auth:login', async () => {
        const r = await svc.call('POST', '/api/auth/login');
        await shell.openExternal(r.url);
        return r;
    });
    handle('auth:logout', async () => svc.call('POST', '/api/auth/logout'));
    handle('models:list', async () => svc.call('GET', '/api/models'));
    handle('models:set', async (id) => svc.call('POST', '/api/models', { id }));

    handle('episode:link', async () => {
        if (!context.projectName) throw new Error('Open a project in Resolve first.');
        const pick = await dialog.showOpenDialog(win, { title: 'Episode folder for ' + context.projectName, properties: ['openDirectory'] });
        if (pick.canceled || !pick.filePaths.length) return episode;
        const r = await svc.call('POST', '/api/bind', { projectName: context.projectName, episodeDir: pick.filePaths[0] });
        episode = r.episode;
        toRenderer('episode', episode);
        return episode;
    });
    handle('episode:open', async (rel) => shell.openPath(rel ? path.join(requireEpisode(), rel) : requireEpisode()));

    handle('selftest', async () => {
        const clipName = context.clip ? context.clip.name : undefined;
        const params = await svc.call('GET', '/api/selftest/params', undefined, episode && clipName ? { episodeDir: episode.dir, clipName } : {});
        return selftest.run(params);
    });

    handle('window:pin', async (on) => {
        if (win) win.setAlwaysOnTop(!!on, 'floating');
        return !!on;
    });
}

function createWindow() {
    win = new BrowserWindow({
        width: 460,
        height: 900,
        minWidth: 380,
        minHeight: 560,
        title: 'Imagine Review',
        backgroundColor: '#1b1b1e',
        useContentSize: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
        },
    });
    win.setMenu(null);
    win.loadFile('index.html');
    win.on('closed', () => { win = null; });
    win.on('close', () => app.quit());
}

app.whenReady().then(async () => {
    registerIpc();
    createWindow();
    try {
        await svc.ensureRunning();
    } catch (e) {
        toRenderer('toast', { level: 'error', text: errorText(e) });
    }
    stopEvents = svc.subscribe((ev) => {
        if (ev.type === 'panel.selftest') {
            selftest.run(ev.params)
                .then((r) => svc.call('POST', '/api/selftest/result', { runId: ev.runId, ...r }))
                .catch((e) => svc.call('POST', '/api/selftest/result', { runId: ev.runId, ok: false, error: errorText(e) }).catch(() => null));
            return;
        }
        toRenderer('event', ev);
    }, (up) => toRenderer('service', up));
    setInterval(poll, 500);
    poll();
});

app.on('window-all-closed', () => {
    if (stopEvents) stopEvents();
    rv.cleanup();
    app.quit();
});

app.on('before-quit', () => {
    if (stopEvents) stopEvents();
    rv.cleanup();
});
