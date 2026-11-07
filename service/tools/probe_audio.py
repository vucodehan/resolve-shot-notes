"""Measures the repair-audio route on the open timeline (audio clips have no take selector), then restores it.

python probe_audio.py <clip name> <path of another take file>

1. Puts the other take's audio on a new "Repair audio" track at the clip's position, and switches which clip plays
   with SetClipEnabled.
2. Simulates Accept: removes the original dialogue clip and places the new audio on its track at the same frames.
3. Restores: removes the new clip, puts the original media back on its track with its original span, deletes the
   repair track, the imported media and the probe bin. Reports whether everything came back.
"""
import json
import sys

import DaVinciResolveScript as dvr

BIN = "Imagine Review probe"


def info(i):
    return None if i is None else {"name": i.GetName(), "start": i.GetStart(), "end": i.GetEnd(), "left": i.GetLeftOffset(),
                                   "enabled": i.GetClipEnabled()}


def find_audio(tl, name, start):
    for t in range(1, tl.GetTrackCount("audio") + 1):
        for i in tl.GetItemListInTrack("audio", t) or []:
            if i.GetName() == name and i.GetStart() == start:
                return t, i
    return None, None


def main():
    clip_name, take_file = sys.argv[1], sys.argv[2]
    r = dvr.scriptapp("Resolve")
    project = r.GetProjectManager().GetCurrentProject()
    tl = project.GetCurrentTimeline()
    mp = project.GetMediaPool()
    t0 = tl.GetStartFrame()
    video = next(i for i in tl.GetItemListInTrack("video", 1) if i.GetName() == clip_name)
    start, end = video.GetStart(), video.GetEnd()
    a_track, orig = find_audio(tl, clip_name, start)
    orig_mpi = orig.GetMediaPoolItem()
    orig_left = orig.GetLeftOffset()
    out = {"timeline_start": t0, "orig_track": a_track, "orig": info(orig), "tracks_before": tl.GetTrackCount("audio")}

    root = mp.GetRootFolder()
    prev = mp.GetCurrentFolder()
    probe_bin = mp.AddSubFolder(root, BIN)
    mp.SetCurrentFolder(probe_bin)
    mpi = (mp.ImportMedia([take_file]) or [None])[0]
    mp.SetCurrentFolder(prev)
    dur = end - start
    try:
        out["add_track"] = tl.AddTrack("audio", "stereo")
        rt = tl.GetTrackCount("audio")
        out["name_track"] = tl.SetTrackName("audio", rt, "Repair audio")
        placed = mp.AppendToTimeline([{"mediaPoolItem": mpi, "startFrame": 0, "endFrame": dur, "trackIndex": rt,
                                       "recordFrame": start, "mediaType": 2}]) or []
        cand = placed[0] if placed else None
        out["repair_clip"] = info(cand)
        out["disable_orig"] = orig.SetClipEnabled(False)
        out["state_on_new"] = {"orig": info(orig), "cand": info(cand)}
        out["toggle_back"] = [orig.SetClipEnabled(True), cand.SetClipEnabled(False)]
        out["state_on_old"] = {"orig": info(orig), "cand": info(cand)}

        # Accept: the new audio replaces the original on the original track.
        out["accept_delete_orig"] = tl.DeleteClips([orig], False)
        moved = mp.AppendToTimeline([{"mediaPoolItem": mpi, "startFrame": 0, "endFrame": dur, "trackIndex": a_track,
                                      "recordFrame": start, "mediaType": 2}]) or []
        new_on_track = moved[0] if moved else None
        out["accept_placed"] = info(new_on_track)
        out["accept_delete_temp"] = tl.DeleteClips([cand], False)

        # Restore the original exactly.
        out["restore_delete_new"] = tl.DeleteClips([new_on_track], False) if new_on_track else None
        back = mp.AppendToTimeline([{"mediaPoolItem": orig_mpi, "startFrame": orig_left, "endFrame": orig_left + dur,
                                     "trackIndex": a_track, "recordFrame": start, "mediaType": 2}]) or []
        out["restored_clip"] = info(back[0] if back else None)
    finally:
        out["delete_track"] = tl.DeleteTrack("audio", tl.GetTrackCount("audio")) if tl.GetTrackCount("audio") > out["tracks_before"] else None
        if mpi:
            out["media_deleted"] = mp.DeleteClips([mpi])
        out["bin_deleted"] = mp.DeleteFolders([probe_bin])
    _, after = find_audio(tl, clip_name, start)
    out["after"] = info(after)
    out["tracks_after"] = tl.GetTrackCount("audio")
    b, a = out["orig"], out["after"]
    out["restored"] = bool(a) and all(b[k] == a[k] for k in ("name", "start", "end", "left", "enabled")) and out["tracks_after"] == out["tracks_before"]
    print(json.dumps(out, indent=1, default=str))


if __name__ == "__main__":
    main()
