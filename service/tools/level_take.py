"""A new take's line at the episode's mix level, for the Imagine Review panel to put on the mixed dialogue track.

python level_take.py EPISODE_DIR SID VERSION [--replaces VERSION] [--out DIR] [--in SECONDS] [--name STEM]
  --in    the picture in-point to use instead of the cut.json's (a take put back by hand)
  --name  the output's stem instead of VERSION (S15-v6 writes S15-v6.line.wav)

Reads EPISODE_DIR/outputs/resolve/mixed/gain.json (written by the show's shared Resolve builder) and writes, next to the
take, shots/takes/SID/VERSION.line.wav (and .line-2.wav, ... for a line cut in parts) with VERSION.line.json:
  - the take's audio over the span the panel will use: its picture in-point from VERSION.cut.json, else the replaced
    line's own picture in-point, less the replaced line's J-cut lead, placed where the replaced line's audio starts;
  - for as long as the line (the cut.json's out-point, else the replaced line's length), within the replaced clip's span;
  - read as the cuts read it (mono, 16-bit, 48 kHz), through the line's filter when the line was filtered (a split
    call's phone), times the episode's gain over that same timeline span from gain.json's curve;
  - mono to stereo, 48 kHz, the replaced line clip's exact length.
Prints one JSON object: {"ok": true, "files": [...], ...} or {"ok": false, "reason": ...} (no gain.json, no line).
"""
import json
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path

import numpy as np

SR = 48000


def read_take(path, start, dur):
    """The cuts' read_audio: input seek to start (3 decimals), mono, 16-bit; a start before 0 is padded with silence."""
    n = int(round(dur * SR))
    if n <= 0:
        return np.zeros(0)
    pad = 0
    if start < 0:
        pad = int(round(-start * SR))
        dur, start = dur + start, 0.0
    with tempfile.TemporaryDirectory() as d:
        raw = Path(d) / "a.raw"
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", "%.3f" % start, "-t", "%.3f" % max(dur, 0.001), "-i",
                        str(path), "-ac", "1", "-ar", str(SR), "-f", "s16le", str(raw)], check=True)
        x = np.frombuffer(raw.read_bytes(), dtype=np.int16).astype(np.float64) / 32768.0
    x = np.concatenate([np.zeros(pad), x])
    return np.pad(x, (0, max(0, n - len(x))))[:n]


def ffilter(x, chain):
    with tempfile.TemporaryDirectory() as d:
        a, b = Path(d) / "in.raw", Path(d) / "out.raw"
        (x * 32767).clip(-32768, 32767).astype(np.int16).tofile(a)
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "s16le", "-ar", str(SR), "-ac", "1", "-i", str(a), "-af",
                        chain, "-f", "s16le", "-ar", str(SR), "-ac", "1", str(b)], check=True)
        y = np.frombuffer(b.read_bytes(), dtype=np.int16).astype(np.float64) / 32768.0
    return np.pad(y, (0, max(0, len(x) - len(y))))[:len(x)]


def write_wav(path, x):
    st = np.stack([x, x], 1).astype(np.float32)
    with tempfile.TemporaryDirectory() as d:
        raw = Path(d) / "x.raw"
        st.tofile(raw)
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "f32le", "-ar", str(SR), "-ac", "2", "-i", str(raw), "-c:a",
                        "pcm_s24le", str(path)], check=True)


def curve_gain(curve, t):
    """The gain (linear) at timeline times t from gain.json's curve: dB values at step_s spacing from t0_s."""
    g = np.asarray(curve["gain_db"], np.float64)
    centers = curve["t0_s"] + curve["step_s"] * np.arange(len(g))
    return 10 ** (np.interp(t, centers, g) / 20.0)


def level(episode, sid, version, replaces=None, out_dir=None, in_s=None, name=None):
    ep = Path(episode)
    gp = ep / "outputs" / "resolve" / "mixed" / "gain.json"
    if not gp.exists():
        return {"ok": False, "reason": "no gain.json in this episode yet (%s): its Resolve project was not built by the "
                "show's shared builder (_shared/mixed_resolve.py)" % gp}
    gain = json.loads(gp.read_text(encoding="utf-8"))
    fps = gain.get("fps", 24)
    lines = [ln for ln in gain["lines"] if ln["sid"] == sid]
    if replaces:
        same = [ln for ln in lines if ln["version"] == replaces]
        lines = same or lines
    if not lines:
        return {"ok": False, "reason": "gain.json has no line for %s" % sid}
    vers = sorted({ln["version"] for ln in lines})
    if len(vers) > 1:
        lines = [ln for ln in lines if ln["version"] == vers[-1]]
    take = ep / "shots" / "takes" / sid / ("%s.mp4" % version)
    if not take.exists():
        return {"ok": False, "reason": "no take at %s" % take}
    cut = take.with_suffix(".cut.json")
    cutj = {"in": float(in_s)} if in_s is not None else None
    if cutj is None and cut.exists():
        try:
            cutj = json.loads(cut.read_text(encoding="utf-8"))
        except ValueError:
            cutj = None
    out_dir = Path(out_dir) if out_dir else take.parent
    out_dir.mkdir(parents=True, exist_ok=True)
    first = min(lines, key=lambda ln: ln["part"])
    files, parts = [], []
    for ln in sorted(lines, key=lambda x: x["part"]):
        lead = float(ln.get("jcut_lead_s") or 0.0)
        # the picture in-point: the cut.json's in for the first part; a later part keeps its offset from the first
        if cutj and isinstance(cutj.get("in"), (int, float)):
            p_in = float(cutj["in"]) + (ln["picture_in_s"] - first["picture_in_s"])
            src_of_in = "--in" if in_s is not None else "cut.json"
        else:
            p_in = float(ln["picture_in_s"])
            src_of_in = "the replaced line's in-point"
        a_in = p_in - lead
        length = ln["take_out_s"] - ln["take_in_s"]
        if cutj and isinstance(cutj.get("out"), (int, float)) and ln is first and len(lines) == 1:
            length = max(0.0, float(cutj["out"]) - a_in)
        s0, s1 = ln["start_frame"] / fps, ln["end_frame"] / fps
        n = int(round((s1 - s0) * SR))
        o = max(0, int(round((ln["audio_at_s"] - s0) * SR)))
        m = max(0, min(n - o, int(round(length * SR))))
        x = read_take(take, a_in, m / SR) if m else np.zeros(0)
        if ln.get("filtered") and ln.get("filter_chain"):
            x = ffilter(x, ln["filter_chain"])
        y = np.zeros(n)
        y[o:o + len(x)] = x
        t = s0 + np.arange(n) / SR
        g = curve_gain(gain["curve"], t)
        y = y * g
        stem = name or version
        fname = "%s.line.wav" % stem if ln["part"] == 1 else "%s.line-%d.wav" % (stem, ln["part"])
        path = out_dir / fname
        write_wav(path, y)
        span_g = 20 * np.log10(g[o:o + max(1, m)])
        files.append(str(path))
        parts.append({"part": ln["part"], "file": str(path), "replaces_clip": Path(ln["file"]).name,
                      "timeline_start_s": round(s0, 4), "frames": ln["end_frame"] - ln["start_frame"],
                      "audio_at_s": ln["audio_at_s"], "picture_in_s": round(p_in, 4), "picture_in_from": src_of_in,
                      "jcut_lead_s": lead, "audio_in_s": round(a_in, 4), "audio_s": round(m / SR, 4),
                      "median_gain_db": round(float(np.median(span_g)), 2),
                      "replaced_line_median_gain_db": ln.get("median_gain_db"),
                      "filter": ln.get("filter_chain") if ln.get("filtered") else None})
    rec = {"ok": True, "episode": str(ep), "release": gain.get("release"), "sid": sid, "version": version,
           "replaces": first["version"], "files": files, "parts": parts,
           "made": datetime.now().isoformat(timespec="seconds"), "by": "Davinci Integration/service/tools/level_take.py",
           "gain_json": str(gp)}
    (out_dir / ("%s.line.json" % (name or version))).write_text(json.dumps(rec, indent=1), encoding="utf-8")
    return rec


if __name__ == "__main__":
    a = sys.argv[1:]
    opts = {}
    for key in ("--replaces", "--out", "--in", "--name"):
        if key in a:
            i = a.index(key)
            opts[key[2:]] = a[i + 1]
            del a[i:i + 2]
    try:
        res = level(a[0], a[1], a[2], opts.get("replaces"), opts.get("out"),
                    float(opts["in"]) if "in" in opts else None, opts.get("name"))
    except Exception as e:  # the service reports it in the note's reply
        res = {"ok": False, "reason": "%s: %s" % (type(e).__name__, e)}
    print(json.dumps(res))
