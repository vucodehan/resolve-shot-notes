import fs from "node:fs";
import path from "node:path";
import { loadConfig, type NoteKind } from "./config.js";
import { parseClipName, takePath } from "./episodes.js";
import { CATEGORIES, notesFor, type Note } from "./notes.js";
import { stillsForNote } from "./stills.js";

export interface MarkerInfo {
  color: string;
  duration: number;
  note: string;
  name: string;
  customData?: string;
}

export interface ResolveClip {
  id: string;
  name: string;
  track: number;
  /** Absolute record frames, as TimelineItem.GetStart/GetEnd report them. */
  start: number;
  end: number;
  /** Source in-point, TimelineItem.GetLeftOffset. */
  leftOffset: number;
  mediaPath?: string;
  markers?: Record<string, MarkerInfo>;
}

export interface ResolveSnapshot {
  project: string;
  timeline: string;
  fps: number;
  /** Timeline.GetStartFrame (e.g. 86400 for 01:00:00:00 at 24 fps). */
  startFrame: number;
  timelineMarkers: Record<string, MarkerInfo>;
  clips: ResolveClip[];
}

/**
 * How Resolve counts a clip marker's frame: "item" = from the clip's first visible frame on the timeline,
 * "source" = from the first frame of the media file. On Resolve 21.1 a marker added at frame 7 of a clip whose
 * visible part starts at source frame 13 exports to OTIO at source frame 7, so the default is "source".
 */
export type ClipMarkerBase = "item" | "source";

export function clipMarkerBase(): ClipMarkerBase {
  return loadConfig().clipMarkerBase ?? "source";
}

export function timecode(frameAbs: number, fps: number): string {
  const base = Math.round(fps);
  const ff = frameAbs % base;
  const totalSec = Math.floor(frameAbs / base);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(totalSec / 3600))}:${pad(Math.floor(totalSec / 60) % 60)}:${pad(totalSec % 60)}:${pad(ff)}`;
}

/** Where a note on a clip lives, in every frame space the panel and the agent need. */
export function locate(clip: ResolveClip, recordAbs: number, startFrame: number, fps: number) {
  const offsetInItem = recordAbs - clip.start;
  return {
    recordFrame: recordAbs - startFrame,
    sourceFrame: clip.leftOffset + offsetInItem,
    clipMarkerFrame: clipMarkerBase() === "item" ? offsetInItem : clip.leftOffset + offsetInItem,
    timecode: timecode(recordAbs, fps),
  };
}

export function clipAt(clips: ResolveClip[], recordAbs: number): ResolveClip | undefined {
  return clips
    .filter((c) => recordAbs >= c.start && recordAbs < c.end)
    .sort((a, b) => b.track - a.track)[0];
}

function categoryFrom(name: string): { category: string; rest: string } {
  const word = name.trim().split(/[\s,:;/-]+/)[0]?.toLowerCase() ?? "";
  if ((CATEGORIES as readonly string[]).includes(word)) {
    return { category: word, rest: name.trim().slice(word.length).replace(/^[\s,:;/-]+/, "") };
  }
  return { category: "other", rest: name.trim() };
}

function noteText(m: MarkerInfo, rest: string): string {
  const parts = [rest, m.note?.trim()].filter((s) => s && !/^Marker \d+$/i.test(s));
  return parts.join(" — ") || "(no text on the marker)";
}

export interface ImportResult {
  created: Note[];
  updated: Note[];
  /** Markers that need their customData set to the note id, so the next harvest skips them. */
  tags: Array<{ scope: "timeline" | "clip"; clipId?: string; frame: number; noteId: string }>;
  ignored: number;
}

export async function importMarkers(episodeDir: string, snap: ResolveSnapshot, source: Note["source"]): Promise<ImportResult> {
  const cfg = loadConfig();
  const store = notesFor(episodeDir);
  const existing = store.list();
  const result: ImportResult = { created: [], updated: [], tags: [], ignored: 0 };

  type Found = { scope: "timeline" | "clip"; frame: number; m: MarkerInfo; clip?: ResolveClip; recordAbs: number };
  const found: Found[] = [];
  for (const [k, m] of Object.entries(snap.timelineMarkers ?? {})) {
    if (!cfg.reviewColors[m.color]) {
      result.ignored++;
      continue;
    }
    const recordAbs = snap.startFrame + Number(k);
    found.push({ scope: "timeline", frame: Number(k), m, clip: clipAt(snap.clips, recordAbs), recordAbs });
  }
  const base = clipMarkerBase();
  for (const clip of snap.clips) {
    for (const [k, m] of Object.entries(clip.markers ?? {})) {
      if (!cfg.reviewColors[m.color]) {
        result.ignored++;
        continue;
      }
      const f = Number(k);
      const recordAbs = base === "item" ? clip.start + f : clip.start + (f - clip.leftOffset);
      found.push({ scope: "clip", frame: f, m, clip, recordAbs });
    }
  }

  for (const f of found) {
    const kind = cfg.reviewColors[f.m.color] as NoteKind;
    const { category, rest } = categoryFrom(f.m.name ?? "");
    const text = noteText(f.m, rest);
    const tagged = /^N-\d+$/.test(f.m.customData ?? "") ? store.get(f.m.customData!) : undefined;
    if (tagged) {
      if (tagged.text !== text || tagged.kind !== kind || tagged.category !== category) {
        result.updated.push(store.update(tagged.id, { text, kind, category, markerColor: f.m.color }, "marker"));
      }
      continue;
    }
    const parsed = f.clip ? parseClipName(f.clip.name) : null;
    const loc = f.clip ? locate(f.clip, f.recordAbs, snap.startFrame, snap.fps) : null;
    const dupe = existing.find((n) => n.clipName === f.clip?.name && n.sourceFrame === loc?.sourceFrame && n.text === text);
    if (dupe) {
      result.tags.push({ scope: f.scope, clipId: f.clip?.id, frame: f.frame, noteId: dupe.id });
      continue;
    }
    let media = f.clip?.mediaPath;
    if (parsed) {
      const take = takePath(episodeDir, parsed.sid, parsed.version);
      if (fs.existsSync(take)) media = take;
    }
    const note = store.create({
      kind,
      category,
      text,
      source,
      sid: parsed?.sid,
      version: parsed?.version,
      clipName: f.clip?.name,
      timelineItemId: f.clip?.id,
      recordFrame: loc?.recordFrame ?? f.recordAbs - snap.startFrame,
      sourceFrame: loc?.sourceFrame,
      durationFrames: Math.max(1, Number(f.m.duration) || 1),
      timecode: loc?.timecode ?? timecode(f.recordAbs, snap.fps),
      mediaPath: media,
      fps: snap.fps,
      stills: [],
      markerColor: f.m.color,
      markerScope: f.scope,
    });
    if (media && loc) {
      const stills = await stillsForNote(episodeDir, note.id, media, loc.sourceFrame, note.durationFrames, snap.fps);
      if (stills.length) store.update(note.id, { stills }, "service");
    }
    result.created.push(store.get(note.id)!);
    result.tags.push({ scope: f.scope, clipId: f.clip?.id, frame: f.frame, noteId: note.id });
  }
  writeDigest(episodeDir);
  return result;
}

/** review/notes.md: the same notes as a readable list, rewritten on every change. */
export function writeDigest(episodeDir: string): void {
  const notes = notesFor(episodeDir).list();
  const lines = [`# Review notes`, ``, `Episode: ${episodeDir}`, `Updated: ${new Date().toISOString()}`, ``];
  for (const n of notes) {
    lines.push(`## ${n.id} · ${n.sid ?? "?"} ${n.version ?? ""} · ${n.kind} · ${n.category} · ${n.status}`);
    lines.push(``);
    lines.push(`- Note: ${n.text}`);
    if (n.timecode) lines.push(`- Timeline: ${n.timecode} (frame ${n.recordFrame}), ${n.durationFrames} frame(s)`);
    if (n.sourceFrame !== undefined) lines.push(`- Source frame: ${n.sourceFrame} of ${n.mediaPath ? path.relative(episodeDir, n.mediaPath) : "?"}`);
    for (const s of n.stills) lines.push(`- Still: ${s.replace(/\\/g, "/")}`);
    if (n.candidate) lines.push(`- Candidate: ${n.candidate.version}${n.candidate.summary ? ` — ${n.candidate.summary}` : ""}`);
    for (const a of n.attempts) lines.push(`- ${a.version} ${a.verdict}${a.reason ? `: ${a.reason}` : ""}`);
    for (const c of n.comments) lines.push(`- ${c.by}: ${c.text}`);
    lines.push(``);
  }
  fs.mkdirSync(path.join(episodeDir, "review"), { recursive: true });
  fs.writeFileSync(path.join(episodeDir, "review", "notes.md"), lines.join("\n"), "utf8");
}
