"""Read the open DaVinci Resolve timeline's markers and clips as JSON, or tag markers with note ids.

python resolve_harvest.py snapshot
python resolve_harvest.py tag <tags.json>     tags.json: [{"scope": "timeline"|"clip", "clipId": "...", "frame": 12, "noteId": "N-0001"}]
python resolve_harvest.py probe-clip-marker   measures how clip marker frames are counted (adds one marker, reads it, removes it)

Uses Resolve's external scripting (DaVinci Resolve Studio). Prints one JSON object on stdout.
"""
import json
import sys

import DaVinciResolveScript as dvr


def connect():
    resolve = dvr.scriptapp("Resolve")
    if resolve is None:
        raise SystemExit(json.dumps({"error": "Resolve is not reachable by external scripting (is DaVinci Resolve Studio running?)"}))
    project = resolve.GetProjectManager().GetCurrentProject()
    if project is None:
        raise SystemExit(json.dumps({"error": "no project is open in Resolve"}))
    timeline = project.GetCurrentTimeline()
    if timeline is None:
        raise SystemExit(json.dumps({"error": "the open project has no current timeline"}))
    return resolve, project, timeline


def media_path(item):
    try:
        mpi = item.GetMediaPoolItem()
        return mpi.GetClipProperty("File Path") if mpi else ""
    except Exception:
        return ""


def snapshot():
    _, project, timeline = connect()
    fps = float(project.GetSetting("timelineFrameRate") or 24)
    clips = []
    for track in range(1, (timeline.GetTrackCount("video") or 0) + 1):
        for item in timeline.GetItemListInTrack("video", track) or []:
            clips.append({
                "id": item.GetUniqueId(),
                "name": item.GetName(),
                "track": track,
                "start": item.GetStart(),
                "end": item.GetEnd(),
                "leftOffset": item.GetLeftOffset(),
                "mediaPath": media_path(item),
                "markers": item.GetMarkers() or {},
            })
    return {
        "project": project.GetName(),
        "timeline": timeline.GetName(),
        "fps": fps,
        "startFrame": timeline.GetStartFrame(),
        "timelineMarkers": timeline.GetMarkers() or {},
        "clips": clips,
    }


def tag(path):
    _, _, timeline = connect()
    tags = json.load(open(path, encoding="utf-8"))
    items = {}
    for track in range(1, (timeline.GetTrackCount("video") or 0) + 1):
        for item in timeline.GetItemListInTrack("video", track) or []:
            items[item.GetUniqueId()] = item
    done = 0
    for t in tags:
        target = timeline if t["scope"] == "timeline" else items.get(t.get("clipId"))
        if target is not None and target.UpdateMarkerCustomData(int(t["frame"]), t["noteId"]):
            done += 1
    return {"tagged": done, "of": len(tags)}


def probe_clip_marker():
    """Adds a marker at frame 0 of the first clip whose source in-point is not 0, reads every marker back, then deletes it.
    Resolve keeps the frame it was given, so the answer comes from where the marker shows on the clip: reported by
    GetMarkers relative to the clip's visible start ("item") when frame 0 is accepted on a clip with a left offset."""
    _, _, timeline = connect()
    for item in timeline.GetItemListInTrack("video", 1) or []:
        left = item.GetLeftOffset()
        if left > 0:
            ok_zero = item.AddMarker(0, "Cream", "probe", "imagine-review probe", 1, "imagine-review-probe")
            ok_left = item.AddMarker(int(left), "Cream", "probe", "imagine-review probe", 1, "imagine-review-probe")
            seen = item.GetMarkers() or {}
            item.DeleteMarkersByColor("Cream")
            return {"clip": item.GetName(), "leftOffset": left, "duration": item.GetDuration(),
                    "accepted_frame_0": bool(ok_zero), "accepted_frame_left": bool(ok_left),
                    "frames_seen": sorted(int(k) for k in seen.keys())}
    return {"error": "no clip with a left offset on V1"}


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "snapshot"
    if cmd == "snapshot":
        out = snapshot()
    elif cmd == "tag":
        out = tag(sys.argv[2])
    elif cmd == "probe-clip-marker":
        out = probe_clip_marker()
    else:
        out = {"error": "unknown command %s" % cmd}
    sys.stdout.write(json.dumps(out))


if __name__ == "__main__":
    main()
