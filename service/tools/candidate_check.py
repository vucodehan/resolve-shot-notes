"""The running service's candidate path checked on a scratch episode (in the temp folder, never a real episode's notes):
Episode 8's gain.json and S15 takes copied in, a note filed on S15 v6, v7 reported as its candidate through the HTTP
API, and the note read back (its candidate's leveled line and the service's reply). A second scratch episode without
a gain.json checks the fallback reply. python tools/candidate_check.py EPISODE_DIR"""
import json
import os
import shutil
import sys
import tempfile
import urllib.request
from pathlib import Path

cfg = json.loads((Path(os.environ["APPDATA"]) / "ImagineReview" / "config.json").read_text(encoding="utf-8"))
BASE = "http://127.0.0.1:%d" % cfg["port"]


def call(method, path, body=None, query=None):
    url = BASE + path
    if query:
        url += "?" + "&".join("%s=%s" % (k, urllib.parse.quote(v)) for k, v in query.items())
    req = urllib.request.Request(url, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"x-imagine-token": cfg["token"], "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.loads(r.read())


def scratch(src, with_gain):
    d = Path(tempfile.mkdtemp(prefix="imagine-candidate-check-")) / "Episode"
    t = d / "shots" / "takes" / "S15"
    t.mkdir(parents=True)
    for f in ("v6.mp4", "v7.mp4", "v7.cut.json"):
        shutil.copy2(src / "shots" / "takes" / "S15" / f, t / f)
    if with_gain:
        g = d / "outputs" / "resolve" / "mixed"
        g.mkdir(parents=True)
        shutil.copy2(src / "outputs" / "resolve" / "mixed" / "gain.json", g / "gain.json")
    else:
        (d / "outputs").mkdir(parents=True)
    return d


def check(src, with_gain):
    d = scratch(src, with_gain)
    clip = {"id": "scratch-clip", "name": "S15-v6.mp4", "track": 1, "trackType": "video", "start": 87295, "end": 87347,
            "leftOffset": 37, "mediaPath": str(d / "shots" / "takes" / "S15" / "v6.mp4")}
    n = call("POST", "/api/notes", {"episodeDir": str(d), "kind": "regenerate", "category": "words",
                                    "text": "candidate check (scratch)", "clip": clip, "fps": 24, "startFrame": 86400,
                                    "recordAbs": 87300, "durationFrames": 1})["note"]
    call("POST", "/api/notes/candidate", {"episodeDir": str(d), "id": n["id"], "version": "v7", "summary": "check"})
    notes = call("GET", "/api/notes", query={"episodeDir": str(d)})
    m = next(x for x in notes if x["id"] == n["id"])
    c = m.get("candidate") or {}
    out = {"scratch": str(d), "with_gain_json": with_gain, "status": m["status"], "line": c.get("line"),
           "line_exists": bool(c.get("line")) and Path(c["line"]).exists(), "leveling_ok": (c.get("leveling") or {}).get(
               "ok"), "reply": [x["text"] for x in m["comments"] if x["by"] == "service"]}
    shutil.rmtree(d.parent, ignore_errors=True)
    return out


if __name__ == "__main__":
    src = Path(sys.argv[1])
    print(json.dumps([check(src, True), check(src, False)], indent=1))
