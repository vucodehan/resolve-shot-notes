// Self-test of every Resolve operation the panel uses, on the open timeline, run inside Resolve.
// Notes go to a scratch episode folder; every marker, clip color, take, track and bin it adds is removed again.
const rv = require('./resolve');
const svc = require('./service');

function check(cond, msg) {
    if (!cond) throw new Error(msg);
}

async function timelineItem(clip) {
    const r = await rv.resolve();
    const project = await (await r.GetProjectManager()).GetCurrentProject();
    const timeline = await project.GetCurrentTimeline();
    for (const it of (await timeline.GetItemListInTrack('video', clip.track)) || []) {
        if ((await it.GetUniqueId()) === clip.id) return { project, timeline, item: it };
    }
    return { project, timeline, item: null };
}

async function run({ scratchDir, clipName, candidatePath }) {
    const out = { steps: [] };
    const step = (name, data) => out.steps.push({ name, ...data });

    const ctx = await rv.readContext(true);
    step('context', { project: ctx.projectName, timeline: ctx.timelineName, fps: ctx.fps, playhead: ctx.timecode, clip: ctx.clip && ctx.clip.name, shot: ctx.shotMarker && ctx.shotMarker.name, selected: ctx.selected.length, markIn: ctx.markIn, markOut: ctx.markOut });
    check(ctx.projectName && ctx.timelineName, 'no project or timeline open');

    const snap = await rv.snapshot();
    const clip = snap.clips.find((c) => c.name === clipName) || (ctx.clip && snap.clips.find((c) => c.id === ctx.clip.id));
    check(clip, 'clip ' + clipName + ' is not on the timeline');
    step('snapshot', { clips: snap.clips.length, timelineMarkers: Object.keys(snap.timelineMarkers).length, clip: clip.name, start: clip.start, end: clip.end, leftOffset: clip.leftOffset });

    const recordAbs = Math.floor((clip.start + clip.end) / 2);
    const r = await svc.call('POST', '/api/notes', {
        episodeDir: scratchDir, kind: 'regenerate', category: 'facing', text: 'self-test note', clip, fps: snap.fps, startFrame: snap.startFrame, recordAbs, durationFrames: 6,
    });
    const placedAt = await rv.placeMarker(r.marker, clip.id, clip.name, r.note.recordFrame);
    await rv.setClipColor(clip.id, clip.name, r.note.recordFrame, 'regenerate');
    const snap2 = await rv.snapshot();
    const m = snap2.clips.find((c) => c.id === clip.id).markers[String(placedAt)];
    step('marker', { note: r.note.id, sourceFrame: r.note.sourceFrame, markerFrame: placedAt, color: m && m.color, customData: m && m.customData, stills: r.note.stills.length });
    check(m && m.customData === r.note.id, 'the note marker was not found on the clip');

    const imp = await svc.call('POST', '/api/import', { episodeDir: scratchDir, snapshot: snap2, source: 'harvest' });
    step('reimport', { created: imp.created.length, updated: imp.updated.length });
    check(imp.created.length === 0, 'the tagged marker was imported a second time');

    step('recolor', { ok: await rv.recolorMarker(r.note, 'Green') });
    const { timeline, item } = await timelineItem(clip);
    step('cleanup-marker', { marker: await item.DeleteMarkerByCustomData(r.note.id), color: await item.ClearClipColor() });

    if (candidatePath) {
        const note = { ...r.note, candidate: { version: 'v0', path: candidatePath } };
        const before = { name: clip.name, start: clip.start, end: clip.end, left: clip.leftOffset, audioTracks: await timeline.GetTrackCount('audio') };
        const load = await rv.loadTake(note);
        step('take-load', load);
        step('take-original', await rv.selectTake(note, 'original'));
        step('take-candidate', await rv.selectTake(note, 'candidate'));
        await rv.finalizeTake(note, 'original');
        const snap3 = await rv.snapshot();
        const c3 = snap3.clips.find((c) => c.id === clip.id) || snap3.clips.find((c) => c.start === clip.start && c.track === clip.track);
        const after = { name: c3.name, start: c3.start, end: c3.end, left: c3.leftOffset, audioTracks: await timeline.GetTrackCount('audio') };
        step('take-restore', { before, after });
        check(JSON.stringify(before) === JSON.stringify(after), 'the clip was not restored after the take test');
        const project = (await timelineItem(clip)).project;
        const mp = await project.GetMediaPool();
        const root = await mp.GetRootFolder();
        for (const f of (await root.GetSubFolderList()) || []) {
            if ((await f.GetName()) === 'Imagine Repairs') {
                const clips = (await f.GetClipList()) || [];
                const left = [];
                for (const c of clips) if ((await c.GetClipProperty('File Path')) === candidatePath) left.push(c);
                if (left.length) await mp.DeleteClips(left);
                if (!((await f.GetClipList()) || []).length) await mp.DeleteFolders([f]);
            }
        }
    }
    out.ok = true;
    return out;
}

module.exports = { run };
