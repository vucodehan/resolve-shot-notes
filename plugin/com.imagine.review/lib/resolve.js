// Resolve operations for the panel, through Resolve's Workflow Integration promise API.
const fs = require('fs');
const path = require('path');

const PLUGIN_ID = 'com.imagine.review';
const REPAIR_BIN = 'Imagine Repairs';
const CLIP_COLOR = { regenerate: 'Orange', fix: 'Yellow', approve: 'Green' };

let WI = null;
let resolveObj = null;
let initPromise = null;

function nodeModule() {
    if (!WI) WI = require(path.join(__dirname, '..', 'WorkflowIntegration.node'));
    return WI;
}

async function resolve() {
    if (resolveObj) return resolveObj;
    if (!initPromise) {
        initPromise = (async () => {
            const wi = nodeModule();
            const ok = await wi.InitializePromise(PLUGIN_ID);
            if (!ok) throw new Error('Could not connect to DaVinci Resolve (Workflow Integration failed to initialize).');
            try { wi.SetAPITimeout(20); } catch { /* older module */ }
            resolveObj = await wi.GetResolvePromise();
            return resolveObj;
        })().finally(() => { initPromise = null; });
    }
    return initPromise;
}

function cleanup() {
    try { if (WI) WI.CleanUp(); } catch { /* quitting */ }
    resolveObj = null;
}

/** Another route to Resolve with the same promise API (the take test drives these functions through external scripting). */
function useResolve(r) {
    resolveObj = r;
    cache.timelineKey = null;
    cache.items.clear();
}

function tcToFrames(tc, fps) {
    const base = Math.round(fps);
    const m = /^(\d+):(\d+):(\d+)[:;](\d+)$/.exec(String(tc || '').trim());
    if (!m) return null;
    return ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * base + Number(m[4]);
}

function framesToTc(frames, fps) {
    const base = Math.round(fps);
    const pad = (n) => String(n).padStart(2, '0');
    const s = Math.floor(frames / base);
    return pad(Math.floor(s / 3600)) + ':' + pad(Math.floor(s / 60) % 60) + ':' + pad(s % 60) + ':' + pad(frames % base);
}

async function projectAndTimeline() {
    const r = await resolve();
    const pm = await r.GetProjectManager();
    const project = await pm.GetCurrentProject();
    if (!project) return { project: null, timeline: null };
    const timeline = await project.GetCurrentTimeline();
    return { project, timeline };
}

async function clipInfo(item) {
    if (!item) return null;
    let mediaPath = '';
    try {
        const mpi = await item.GetMediaPoolItem();
        if (mpi) mediaPath = (await mpi.GetClipProperty('File Path')) || '';
    } catch { /* generator or title */ }
    let track = 1;
    let trackType = 'video';
    try {
        const tt = await item.GetTrackTypeAndIndex();
        if (Array.isArray(tt) && tt.length > 1) {
            trackType = String(tt[0]);
            track = Number(tt[1]) || 1;
        }
    } catch { /* older Resolve */ }
    return {
        id: await item.GetUniqueId(),
        name: await item.GetName(),
        track,
        trackType,
        start: await item.GetStart(),
        end: await item.GetEnd(),
        leftOffset: await item.GetLeftOffset(),
        mediaPath,
    };
}

// ---------------------------------------------------------------- live context

const cache = { timelineKey: null, fps: 24, startFrame: 0, shotMarkers: {}, shotMarkersAt: 0, items: new Map() };

async function readContext(full) {
    const { project, timeline } = await projectAndTimeline();
    if (!project) return { projectName: null };
    const projectName = await project.GetName();
    if (!timeline) return { projectName, timelineName: null };
    const timelineName = await timeline.GetName();
    const key = projectName + '\u0000' + timelineName;
    if (key !== cache.timelineKey) {
        cache.timelineKey = key;
        cache.fps = parseFloat(await project.GetSetting('timelineFrameRate')) || 24;
        cache.startFrame = await timeline.GetStartFrame();
        cache.shotMarkersAt = 0;
        cache.items.clear();
    }
    if (full || Date.now() - cache.shotMarkersAt > 10000) {
        cache.shotMarkers = (await timeline.GetMarkers()) || {};
        cache.shotMarkersAt = Date.now();
    }
    const timecode = await timeline.GetCurrentTimecode();
    const playhead = tcToFrames(timecode, cache.fps);
    const item = await timeline.GetCurrentVideoItem();
    const clip = item ? await clipInfo(item) : null;
    if (clip && item) cache.items.set(clip.id, item);
    let selected = [];
    let markIn = null;
    let markOut = null;
    if (full) {
        try {
            const sel = (await timeline.GetSelectedClips()) || [];
            for (const it of sel) {
                const info = await clipInfo(it);
                if (!info) continue;
                cache.items.set(info.id, it);
                if (info.trackType === 'video') selected.push(info);
            }
        } catch { /* GetSelectedClips needs 21.0.4 */ }
        try {
            const mio = await timeline.GetMarkInOut();
            const v = mio && (mio.video || mio.audio);
            if (v && v.in !== undefined && v.out !== undefined) {
                const abs = (f) => (f < cache.startFrame ? f + cache.startFrame : f);
                markIn = abs(Number(v.in));
                markOut = abs(Number(v.out));
            }
        } catch { /* no marks */ }
    }
    let shotMarker = null;
    if (clip) {
        for (const [frame, m] of Object.entries(cache.shotMarkers)) {
            const abs = cache.startFrame + Number(frame);
            if (m.color === 'Blue' && abs >= clip.start && abs < clip.end) {
                shotMarker = { name: m.name, note: m.note };
                break;
            }
        }
    }
    return {
        projectName, timelineName, fps: cache.fps, startFrame: cache.startFrame,
        timecode, playhead, clip, shotMarker, selected, markIn, markOut,
    };
}

async function findItem(id, clipName, recordFrame) {
    if (id && cache.items.has(id)) return cache.items.get(id);
    const { timeline } = await projectAndTimeline();
    if (!timeline) return null;
    const startFrame = await timeline.GetStartFrame();
    const tracks = await timeline.GetTrackCount('video');
    let byName = null;
    for (let t = 1; t <= tracks; t++) {
        for (const it of (await timeline.GetItemListInTrack('video', t)) || []) {
            const uid = await it.GetUniqueId();
            cache.items.set(uid, it);
            if (uid === id) return it;
            if (!byName && clipName && (await it.GetName()) === clipName) {
                const s = await it.GetStart();
                const e = await it.GetEnd();
                if (recordFrame === undefined || (startFrame + recordFrame >= s && startFrame + recordFrame < e)) byName = it;
            }
        }
    }
    return byName;
}

// The show's shared builder (_shared/mixed_resolve.py) lays a project out with the dialogue as mixed on its own track,
// one clip per line named after the take that speaks it (S15-v6.line.wav), and each take's raw audio on a disabled
// reference track. A line clip can start before its picture (a J-cut).
const MIXED_TRACK = 'Dialogue (mixed)';
const REFERENCE_TRACK = 'Dialogue raw (reference)';

async function trackIndexByName(timeline, name) {
    const n = await timeline.GetTrackCount('audio');
    for (let i = 1; i <= n; i++) {
        if ((await timeline.GetTrackName('audio', i)) === name) return i;
    }
    return 0;
}

function lineClipPattern(sid, version) {
    const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('^' + esc(sid) + '-' + esc(version) + '\\.line(-\\d+)?\\.wav$', 'i');
}

/** The clip on a track that overlaps [start, end) the most, among those whose name passes the test. */
async function overlapping(timeline, track, start, end, test) {
    let best = null;
    let bestOverlap = 0;
    for (const it of (await timeline.GetItemListInTrack('audio', track)) || []) {
        if (!test(await it.GetName())) continue;
        const s = await it.GetStart();
        const e = await it.GetEnd();
        const ov = Math.min(e, end) - Math.max(s, start);
        if (ov > bestOverlap) [best, bestOverlap] = [it, ov];
    }
    return best;
}

/**
 * The dialogue under a picture clip. In the mixed layout: the noted take's line clip on the mixed dialogue track (by
 * shot and version in its name, the one overlapping the picture), with its raw audio on the reference track. In an
 * older project: the audio clip with exactly the picture's name and start.
 */
async function findAudioPartner(note, start, end) {
    const { timeline } = await projectAndTimeline();
    if (!timeline) return null;
    const mixed = await trackIndexByName(timeline, MIXED_TRACK);
    if (mixed && note.sid && note.version) {
        const item = await overlapping(timeline, mixed, start, end, (n) => lineClipPattern(note.sid, note.version).test(n));
        if (item) {
            const ref = await trackIndexByName(timeline, REFERENCE_TRACK);
            const refItem = ref ? await overlapping(timeline, ref, start, end, (n) => n === note.clipName) : null;
            return { layout: 'mixed', item, track: mixed, refItem, refTrack: ref };
        }
    }
    const tracks = await timeline.GetTrackCount('audio');
    for (let t = 1; t <= tracks; t++) {
        for (const it of (await timeline.GetItemListInTrack('audio', t)) || []) {
            if ((await it.GetName()) === note.clipName && (await it.GetStart()) === start) return { layout: 'raw', item: it, track: t };
        }
    }
    return null;
}

/** The candidate's leveled line (level_take.py beside the take), when the service made one. */
function leveledLine(note) {
    const c = note.candidate || {};
    const p = c.line || String(c.path || '').replace(/\.mp4$/i, '.line.wav');
    return p && fs.existsSync(p) ? p : null;
}

async function importAudio(mp, filePath, clipName) {
    const bin = await repairBin(mp);
    for (const c of (await bin.GetClipList()) || []) {
        if ((await c.GetClipProperty('File Path')) === filePath) return c;
    }
    const before = await mp.GetCurrentFolder();
    await mp.SetCurrentFolder(bin);
    const items = (await mp.ImportMedia([filePath])) || [];
    if (before) await mp.SetCurrentFolder(before);
    if (!items.length) throw new Error('Resolve could not import ' + filePath);
    if (clipName) {
        try { await items[0].SetName(clipName); } catch { /* SetName needs 20.2 */ }
    }
    return items[0];
}

async function clipFrames(mpi) {
    const f = Number(await mpi.GetClipProperty('Frames'));
    return Number.isFinite(f) && f > 0 ? f : null;
}

// ---------------------------------------------------------------- markers

async function placeMarker(marker, clipId, clipName, recordFrame) {
    const { timeline } = await projectAndTimeline();
    const target = marker.scope === 'clip' ? await findItem(clipId, clipName, recordFrame) : timeline;
    if (!target) throw new Error('The clip for this note is no longer on the timeline.');
    for (let i = 0; i < 6; i++) {
        const ok = await target.AddMarker(marker.frame + i, marker.color, marker.name, marker.note, marker.duration, marker.customData);
        if (ok) return marker.frame + i;
    }
    throw new Error('Resolve refused the marker (another marker may sit on that frame).');
}

async function recolorMarker(note, color) {
    const { timeline } = await projectAndTimeline();
    const target = note.markerScope === 'clip' ? await findItem(note.timelineItemId, note.clipName, note.recordFrame) : timeline;
    if (!target) return false;
    const found = await target.GetMarkerByCustomData(note.id);
    if (!found || typeof found !== 'object') return false;
    const entries = Object.entries(found);
    let frame;
    let info;
    if (entries.length && typeof entries[0][1] === 'object') [frame, info] = [Number(entries[0][0]), entries[0][1]];
    else return false;
    await target.DeleteMarkerByCustomData(note.id);
    return target.AddMarker(frame, color, info.name || '', info.note || '', info.duration || 1, note.id);
}

async function setClipColor(clipId, clipName, recordFrame, kind) {
    const color = CLIP_COLOR[kind];
    if (!color) return false;
    const item = await findItem(clipId, clipName, recordFrame);
    return item ? item.SetClipColor(color) : false;
}

async function jumpTo(timecode) {
    const { timeline } = await projectAndTimeline();
    return timeline ? timeline.SetCurrentTimecode(timecode) : false;
}

/** Every clip and marker on the timeline, in the shape the service imports. */
async function snapshot() {
    const { project, timeline } = await projectAndTimeline();
    if (!timeline) throw new Error('No timeline is open.');
    const clips = [];
    const tracks = await timeline.GetTrackCount('video');
    for (let t = 1; t <= tracks; t++) {
        for (const it of (await timeline.GetItemListInTrack('video', t)) || []) {
            const info = await clipInfo(it);
            info.track = t;
            info.markers = (await it.GetMarkers()) || {};
            cache.items.set(info.id, it);
            clips.push(info);
        }
    }
    return {
        project: await project.GetName(),
        timeline: await timeline.GetName(),
        fps: parseFloat(await project.GetSetting('timelineFrameRate')) || 24,
        startFrame: await timeline.GetStartFrame(),
        timelineMarkers: (await timeline.GetMarkers()) || {},
        clips,
    };
}

async function tagMarkers(tags) {
    const { timeline } = await projectAndTimeline();
    let done = 0;
    for (const t of tags) {
        const target = t.scope === 'timeline' ? timeline : await findItem(t.clipId);
        if (target && (await target.UpdateMarkerCustomData(t.frame, t.noteId))) done++;
    }
    return done;
}

// ---------------------------------------------------------------- takes

async function repairBin(mp) {
    const root = await mp.GetRootFolder();
    for (const f of (await root.GetSubFolderList()) || []) {
        if ((await f.GetName()) === REPAIR_BIN) return f;
    }
    return mp.AddSubFolder(root, REPAIR_BIN);
}

/** Imports a candidate take into the repair bin, named like the pipeline's clips (S07-v10.mp4) so later notes bind to it. */
async function importCandidate(filePath, clipName) {
    const { project } = await projectAndTimeline();
    const mp = await project.GetMediaPool();
    const bin = await repairBin(mp);
    for (const c of (await bin.GetClipList()) || []) {
        if ((await c.GetClipProperty('File Path')) === filePath) return { mp, mpi: c };
    }
    const before = await mp.GetCurrentFolder();
    await mp.SetCurrentFolder(bin);
    const items = (await mp.ImportMedia([filePath])) || [];
    if (before) await mp.SetCurrentFolder(before);
    if (!items.length) throw new Error('Resolve could not import ' + filePath);
    if (clipName) {
        try { await items[0].SetName(clipName); } catch { /* SetName needs 20.2 */ }
    }
    return { mp, mpi: items[0] };
}

function cutSpan(candidatePath, fps) {
    const p = candidatePath.replace(/\.mp4$/i, '.cut.json');
    try {
        const c = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (typeof c.in === 'number' && typeof c.out === 'number' && c.out > c.in) {
            return { start: Math.round(c.in * fps), end: Math.round(c.out * fps), from: 'cut.json' };
        }
    } catch { /* no cut file */ }
    return null;
}

// Audio clips have no take selector in Resolve 21.1 (AddTake returns false on them), so a candidate's dialogue goes on a
// "Repair audio" track at the same frames, and the two dialogue clips are switched with SetClipEnabled. In the mixed
// layout the candidate's dialogue is its leveled line (level_take.py), at the replaced line clip's own frames.
const REPAIR_TRACK = 'Repair audio';
const loaded = new Map(); // note id -> the take's state (picture item, the dialogue clips switched, where they go on Accept)

async function repairTrack(timeline) {
    const n = await timeline.GetTrackCount('audio');
    for (let i = n; i >= 1; i--) {
        if ((await timeline.GetTrackName('audio', i)) === REPAIR_TRACK) return i;
    }
    if (!(await timeline.AddTrack('audio', 'stereo'))) throw new Error('Resolve would not add the repair audio track.');
    const idx = await timeline.GetTrackCount('audio');
    await timeline.SetTrackName('audio', idx, REPAIR_TRACK);
    return idx;
}

async function dropRepairTrackIfEmpty(timeline) {
    const n = await timeline.GetTrackCount('audio');
    for (let i = n; i >= 1; i--) {
        if ((await timeline.GetTrackName('audio', i)) === REPAIR_TRACK && !((await timeline.GetItemListInTrack('audio', i)) || []).length) {
            await timeline.DeleteTrack('audio', i);
        }
    }
}

/**
 * Adds the candidate as a new take on the noted clip and plays it. Its dialogue goes on the repair track: in the mixed
 * layout the candidate's leveled line at the replaced line clip's record frame (or, when the episode has no gain record
 * yet, its raw audio under the picture), in an older project its raw audio under the picture; the original is switched
 * off.
 */
async function loadTake(note) {
    if (!note.candidate) throw new Error('This note has no candidate take yet.');
    if (loaded.has(note.id)) {
        const st = loaded.get(note.id);
        return { takes: 2, selected: 2, span: st.span, audio: !!st.candAudio, layout: st.layout, leveled: st.leveled };
    }
    const { timeline } = await projectAndTimeline();
    const item = await findItem(note.timelineItemId, note.clipName, note.recordFrame);
    if (!item) throw new Error('The clip for this note is no longer on the timeline.');
    const fps = note.fps || 24;
    const name = note.sid ? note.sid + '-' + note.candidate.version + '.mp4' : null;
    const { mp, mpi } = await importCandidate(note.candidate.path, name);
    const start = await item.GetStart();
    const end = await item.GetEnd();
    const duration = end - start;
    const left = await item.GetLeftOffset();
    const cut = cutSpan(note.candidate.path, fps);
    const span = cut ? { start: cut.start, end: cut.start + duration, from: 'cut.json' } : { start: left, end: left + duration, from: 'same in-point' };
    // AddTake answers false unless the Edit or Cut page is open (Resolve 21.1)
    const r = await resolve();
    const page = await r.GetCurrentPage();
    if (page !== 'edit' && page !== 'cut') await r.OpenPage('edit');
    let ok = await item.AddTake(mpi, span.start, span.end);
    if (!ok) ok = await item.AddTake(mpi);
    if (!ok) throw new Error('Resolve refused to add the take.');
    const count = await item.GetTakesCount();
    await item.SelectTakeByIndex(count);

    const partner = await findAudioPartner(note, start, end);
    const st = { item, mpi, span, start, layout: partner ? partner.layout : null, leveled: false, origAudio: null, origTrack: 1, candAudio: null };
    if (partner) {
        st.origAudio = partner.item;
        st.origTrack = partner.track;
        const rt = await repairTrack(timeline);
        const line = partner.layout === 'mixed' ? leveledLine(note) : null;
        let info;
        if (line) {
            // the leveled line replaces the line clip frame for frame, its J-cut lead included
            const lineName = note.sid + '-' + note.candidate.version + '.line.wav';
            st.lineMpi = await importAudio(mp, line, lineName);
            st.lineStart = await partner.item.GetStart();
            st.lineFrames = (await partner.item.GetEnd()) - st.lineStart;
            const have = await clipFrames(st.lineMpi);
            info = { mediaPoolItem: st.lineMpi, startFrame: 0, endFrame: have ? Math.min(have, st.lineFrames) : st.lineFrames, trackIndex: rt, recordFrame: st.lineStart, mediaType: 2 };
            st.leveled = true;
            if (partner.refItem) {
                st.refItem = partner.refItem;
                st.refTrack = partner.refTrack;
                st.refStart = await partner.refItem.GetStart();
                st.refFrames = (await partner.refItem.GetEnd()) - st.refStart;
            }
        } else {
            info = { mediaPoolItem: mpi, startFrame: span.start, endFrame: span.end, trackIndex: rt, recordFrame: start, mediaType: 2 };
        }
        const placed = (await mp.AppendToTimeline([info])) || [];
        st.candAudio = placed[0] || null;
        if (st.candAudio) await st.origAudio.SetClipEnabled(false);
    }
    loaded.set(note.id, st);
    return { takes: count, selected: count, span, audio: partner ? !!st.candAudio : null, layout: st.layout, leveled: st.leveled };
}

async function selectTake(note, which) {
    const st = loaded.get(note.id);
    if (!st) throw new Error('Load the take first.');
    const count = await st.item.GetTakesCount();
    const idx = which === 'original' ? 1 : count;
    await st.item.SelectTakeByIndex(idx);
    if (st.origAudio && st.candAudio) {
        await st.origAudio.SetClipEnabled(which === 'original');
        await st.candAudio.SetClipEnabled(which !== 'original');
    }
    return { selected: idx, of: count };
}

/**
 * Accept: the candidate becomes the clip. In the mixed layout its leveled line takes the line clip's place on the mixed
 * dialogue track and its raw audio the reference clip's place on the (disabled) reference track; otherwise its audio
 * goes on the original dialogue track. Reject: the clip and its dialogue are restored as they were.
 */
async function finalizeTake(note, which) {
    const st = loaded.get(note.id);
    if (!st) throw new Error('Load the take first.');
    const { project, timeline } = await projectAndTimeline();
    const mp = await project.GetMediaPool();
    const count = await st.item.GetTakesCount();
    if (which === 'candidate') {
        await st.item.SelectTakeByIndex(count);
        await st.item.FinalizeTake();
        if (st.origAudio && st.candAudio && st.leveled) {
            await timeline.DeleteClips([st.origAudio], false);
            await timeline.DeleteClips([st.candAudio], false);
            const have = await clipFrames(st.lineMpi);
            await mp.AppendToTimeline([{ mediaPoolItem: st.lineMpi, startFrame: 0, endFrame: have ? Math.min(have, st.lineFrames) : st.lineFrames, trackIndex: st.origTrack, recordFrame: st.lineStart, mediaType: 2 }]);
            if (st.refItem) {
                // the raw audio keeps the reference clip's offset from its picture (a J-cut's lead)
                const from = Math.max(0, st.span.start + (st.refStart - st.start));
                await timeline.DeleteClips([st.refItem], false);
                await mp.AppendToTimeline([{ mediaPoolItem: st.mpi, startFrame: from, endFrame: from + st.refFrames, trackIndex: st.refTrack, recordFrame: st.refStart, mediaType: 2 }]);
            }
        } else if (st.origAudio && st.candAudio) {
            await timeline.DeleteClips([st.origAudio], false);
            await mp.AppendToTimeline([{ mediaPoolItem: st.mpi, startFrame: st.span.start, endFrame: st.span.end, trackIndex: st.origTrack, recordFrame: st.start, mediaType: 2 }]);
            await timeline.DeleteClips([st.candAudio], false);
        }
    } else {
        await st.item.SelectTakeByIndex(1);
        while ((await st.item.GetTakesCount()) > 1) {
            if (!(await st.item.DeleteTakeByIndex(await st.item.GetTakesCount()))) break;
        }
        await st.item.FinalizeTake();
        if (st.candAudio) await timeline.DeleteClips([st.candAudio], false);
        if (st.origAudio) await st.origAudio.SetClipEnabled(true);
    }
    await dropRepairTrackIfEmpty(timeline);
    loaded.delete(note.id);
    cache.items.clear();
    return true;
}

function isLoaded(noteId) {
    return loaded.has(noteId);
}

async function saveProject() {
    const r = await resolve();
    const pm = await r.GetProjectManager();
    return pm.SaveProject();
}

module.exports = {
    resolve, cleanup, useResolve, readContext, placeMarker, recolorMarker, setClipColor, jumpTo, snapshot, tagMarkers,
    loadTake, selectTake, finalizeTake, isLoaded, saveProject, framesToTc, findAudioPartner,
};
