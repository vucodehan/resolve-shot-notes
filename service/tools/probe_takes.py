"""Measures Resolve's take-selector API on the open timeline, then restores the timeline exactly.

python probe_takes.py <clip name on V1> <path of another take file>

Adds the file as a take on the clip (picture) and on its dialogue audio clip (same name, same start), switches between
the takes, then selects the original, deletes the added take, finalizes, and removes the imported media and its bin.
Prints what each call returned and whether the clip came back unchanged.
"""
import json
import sys

import DaVinciResolveScript as dvr

BIN = "Imagine Review probe"


def state(item):
    return {"name": item.GetName(), "start": item.GetStart(), "end": item.GetEnd(), "left": item.GetLeftOffset(),
            "takes": item.GetTakesCount(), "selected": item.GetSelectedTakeIndex()}


def main():
    clip_name, take_file = sys.argv[1], sys.argv[2]
    r = dvr.scriptapp("Resolve")
    project = r.GetProjectManager().GetCurrentProject()
    tl = project.GetCurrentTimeline()
    mp = project.GetMediaPool()
    video = next(i for i in tl.GetItemListInTrack("video", 1) if i.GetName() == clip_name)
    audio = None
    for t in range(1, tl.GetTrackCount("audio") + 1):
        for i in tl.GetItemListInTrack("audio", t) or []:
            if i.GetName() == clip_name and i.GetStart() == video.GetStart():
                audio = i
    out = {"before": {"video": state(video), "audio": state(audio) if audio else None}}

    root = mp.GetRootFolder()
    prev = mp.GetCurrentFolder()
    probe_bin = mp.AddSubFolder(root, BIN)
    mp.SetCurrentFolder(probe_bin)
    imported = mp.ImportMedia([take_file]) or []
    mp.SetCurrentFolder(prev)
    mpi = imported[0] if imported else None
    out["imported"] = bool(mpi)
    try:
        left = video.GetLeftOffset()
        dur = video.GetEnd() - video.GetStart()
        out["video_addtake_range"] = video.AddTake(mpi, left, left + dur)
        out["video_after_add"] = state(video)
        out["video_select_new"] = video.SelectTakeByIndex(video.GetTakesCount())
        out["video_on_new"] = state(video)
        if audio:
            out["audio_addtake_range"] = audio.AddTake(mpi, left, left + dur)
            out["audio_after_add"] = state(audio)
            if audio.GetTakesCount():
                out["audio_select_new"] = audio.SelectTakeByIndex(audio.GetTakesCount())
                out["audio_on_new"] = state(audio)
    finally:
        for name, item in (("video", video), ("audio", audio)):
            if item is None or not item.GetTakesCount():
                continue
            item.SelectTakeByIndex(1)
            while item.GetTakesCount() > 1:
                if not item.DeleteTakeByIndex(item.GetTakesCount()):
                    break
            out[name + "_finalize"] = item.FinalizeTake()
        if mpi:
            out["media_deleted"] = mp.DeleteClips([mpi])
        out["bin_deleted"] = mp.DeleteFolders([probe_bin])
    out["after"] = {"video": state(video), "audio": state(audio) if audio else None}
    b, a = out["before"]["video"], out["after"]["video"]
    out["video_restored"] = all(b[k] == a[k] for k in ("name", "start", "end", "left"))
    if audio:
        b, a = out["before"]["audio"], out["after"]["audio"]
        out["audio_restored"] = all(b[k] == a[k] for k in ("name", "start", "end", "left"))
    print(json.dumps(out, indent=1, default=str))


if __name__ == "__main__":
    main()
