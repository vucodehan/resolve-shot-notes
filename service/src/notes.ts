import fs from "node:fs";
import path from "node:path";
import type { NoteKind } from "./config.js";

export type NoteStatus = "open" | "sent" | "working" | "candidate" | "accepted" | "rejected" | "closed";

export const CATEGORIES = [
  "identity", "facing", "hands", "geometry", "room", "words", "pause", "continuity",
  "lipsync", "sound", "pacing", "grade", "other",
] as const;

export interface NoteComment {
  at: string;
  by: string;
  text: string;
}

export interface NoteAttempt {
  version: string;
  verdict: "accepted" | "rejected";
  at: string;
  reason?: string;
}

/** tools/level_take.py's answer: the candidate's line at the episode's mix level, or why it could not be made. */
export interface Leveling {
  ok: boolean;
  reason?: string;
  files?: string[];
  parts?: Array<{ part: number; file: string; replaces_clip: string; frames: number; median_gain_db: number; replaced_line_median_gain_db?: number; picture_in_s: number; audio_in_s: number; jcut_lead_s: number }>;
}

export interface Note {
  id: string;
  createdAt: string;
  updatedAt: string;
  kind: NoteKind;
  category: string;
  text: string;
  status: NoteStatus;
  source: "panel" | "harvest" | "ide";
  sid?: string;
  version?: string;
  clipName?: string;
  timelineItemId?: string;
  /** Frame relative to the timeline's first frame. */
  recordFrame?: number;
  /** Frame inside the clip's media file. */
  sourceFrame?: number;
  durationFrames: number;
  timecode?: string;
  mediaPath?: string;
  fps: number;
  stills: string[];
  markerColor?: string;
  markerScope?: "timeline" | "clip";
  /** Highest take version on disk when the note went to the agent; a candidate is anything above it. */
  baselineVersion?: number;
  /** line: the leveled line (shots/takes/<sid>/<version>.line.wav) the panel puts on the mixed dialogue track. */
  candidate?: { version: string; path: string; at: string; summary?: string; line?: string; lines?: string[]; leveling?: Leveling };
  attempts: NoteAttempt[];
  comments: NoteComment[];
}

type NoteEvent =
  | { ts: string; type: "create"; note: Note }
  | { ts: string; type: "update"; id: string; patch: Partial<Note>; by: string }
  | { ts: string; type: "comment"; id: string; comment: NoteComment };

export function reviewDir(episodeDir: string): string {
  return path.join(episodeDir, "review");
}

export function stillsDir(episodeDir: string): string {
  return path.join(reviewDir(episodeDir), "stills");
}

function logPath(episodeDir: string): string {
  return path.join(reviewDir(episodeDir), "notes.jsonl");
}

/** One episode's notes. The log is append-only; the current state is replayed from it. */
export class NoteStore {
  private notes = new Map<string, Note>();
  private loadedSize = -1;

  constructor(readonly episodeDir: string) {}

  private load(): void {
    const p = logPath(this.episodeDir);
    const size = fs.existsSync(p) ? fs.statSync(p).size : 0;
    if (size === this.loadedSize) return;
    this.notes.clear();
    if (size > 0) {
      for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
        if (!line.trim()) continue;
        let ev: NoteEvent;
        try {
          ev = JSON.parse(line) as NoteEvent;
        } catch {
          continue;
        }
        this.apply(ev);
      }
    }
    this.loadedSize = size;
  }

  private apply(ev: NoteEvent): void {
    if (ev.type === "create") {
      this.notes.set(ev.note.id, structuredClone(ev.note));
    } else if (ev.type === "update") {
      const n = this.notes.get(ev.id);
      if (n) Object.assign(n, ev.patch, { updatedAt: ev.ts });
    } else if (ev.type === "comment") {
      const n = this.notes.get(ev.id);
      if (n) {
        n.comments.push(ev.comment);
        n.updatedAt = ev.ts;
      }
    }
  }

  private append(ev: NoteEvent): void {
    fs.mkdirSync(reviewDir(this.episodeDir), { recursive: true });
    const p = logPath(this.episodeDir);
    fs.appendFileSync(p, JSON.stringify(ev) + "\n", "utf8");
    this.apply(ev);
    this.loadedSize = fs.statSync(p).size;
  }

  list(): Note[] {
    this.load();
    return [...this.notes.values()].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  }

  get(id: string): Note | undefined {
    this.load();
    return this.notes.get(id);
  }

  nextId(): string {
    this.load();
    let max = 0;
    for (const id of this.notes.keys()) {
      const m = /^N-(\d+)$/.exec(id);
      if (m) max = Math.max(max, Number(m[1]));
    }
    return `N-${String(max + 1).padStart(4, "0")}`;
  }

  create(fields: Omit<Note, "id" | "createdAt" | "updatedAt" | "attempts" | "comments" | "status"> & Partial<Pick<Note, "status">>): Note {
    const ts = new Date().toISOString();
    const note: Note = {
      ...fields,
      id: this.nextId(),
      createdAt: ts,
      updatedAt: ts,
      status: fields.status ?? "open",
      attempts: [],
      comments: [],
    };
    this.append({ ts, type: "create", note });
    return note;
  }

  update(id: string, patch: Partial<Note>, by: string): Note {
    const n = this.get(id);
    if (!n) throw new Error(`no note ${id}`);
    const clean = { ...patch };
    delete (clean as Partial<Note>).id;
    this.append({ ts: new Date().toISOString(), type: "update", id, patch: clean, by });
    return this.get(id)!;
  }

  comment(id: string, by: string, text: string): Note {
    if (!this.get(id)) throw new Error(`no note ${id}`);
    const at = new Date().toISOString();
    this.append({ ts: at, type: "comment", id, comment: { at, by, text } });
    return this.get(id)!;
  }
}

const stores = new Map<string, NoteStore>();

export function notesFor(episodeDir: string): NoteStore {
  const key = path.resolve(episodeDir).toLowerCase();
  let s = stores.get(key);
  if (!s) {
    s = new NoteStore(path.resolve(episodeDir));
    stores.set(key, s);
  }
  return s;
}
