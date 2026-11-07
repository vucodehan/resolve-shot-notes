"""Tests for level_take.py on a synthetic episode: a take with a sweep for its sound, and a gain.json whose curve rises
from +6 to +12 dB. python -m unittest tools/test_level_take.py (from service/)."""
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import level_take as L  # noqa: E402

SR = 48000


def read(path):
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-f", "f32le", "-"], capture_output=True,
                         check=True).stdout
    info = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=channels,sample_rate", "-of", "json",
                           str(path)], capture_output=True, text=True).stdout
    st = json.loads(info)["streams"][0]
    return np.frombuffer(raw, np.float32).reshape(-1, int(st["channels"])), int(st["sample_rate"])


class LevelTake(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="level-take-"))
        takes = self.dir / "shots" / "takes" / "S01"
        takes.mkdir(parents=True)
        self.take = takes / "v2.mp4"
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=320x180:r=24:d=5", "-f",
                        "lavfi", "-i", "aevalsrc=0.2*sin(2*PI*(200+150*t)*t):s=48000:d=5", "-c:v", "libx264", "-c:a",
                        "aac", "-b:a", "192k", "-shortest", str(self.take)], check=True)
        steps = int(10 / 0.05)
        self.gain = {"release": "test", "fps": 24, "sr": SR,
                     "curve": {"step_s": 0.05, "t0_s": 0.025, "gain_db": list(np.linspace(6, 12, steps))},
                     "lines": [{"sid": "S01", "version": "v1", "part": 1, "file": "outputs/resolve/mixed/S01-v1.line.wav",
                                "timeline_start_s": 1.0, "timeline_end_s": 3.0, "start_frame": 24, "end_frame": 72,
                                "audio_at_s": 1.0, "take_in_s": 0.5, "take_out_s": 2.5, "jcut_lead_s": 0.25,
                                "picture_in_s": 0.75, "median_gain_db": 8.4, "filtered": None, "filter_chain": None}]}

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def write_gain(self):
        p = self.dir / "outputs" / "resolve" / "mixed"
        p.mkdir(parents=True, exist_ok=True)
        (p / "gain.json").write_text(json.dumps(self.gain), encoding="utf-8")

    def expect(self, a_in, length, chain=None):
        x = L.read_take(self.take, a_in, length)
        if chain:
            x = L.ffilter(x, chain)
        y = np.zeros(2 * SR)
        y[:len(x)] = x[:2 * SR]
        t = 1.0 + np.arange(2 * SR) / SR
        return y * L.curve_gain(self.gain["curve"], t)

    def test_no_gain_json_falls_back(self):
        r = L.level(self.dir, "S01", "v2")
        self.assertFalse(r["ok"])
        self.assertIn("gain.json", r["reason"])

    def test_same_in_point_and_lead(self):
        self.write_gain()
        r = L.level(self.dir, "S01", "v2", replaces="v1")
        self.assertTrue(r["ok"], r)
        out, sr = read(r["files"][0])
        self.assertEqual(sr, SR)
        self.assertEqual(out.shape, (2 * SR, 2))
        self.assertTrue(np.allclose(out[:, 0], out[:, 1]))
        # the picture's in-point 0.75 less the 0.25 s J-cut lead: the audio from 0.5 s, at the line's own start
        want = self.expect(0.5, 2.0)
        res = 20 * np.log10(np.sqrt(np.mean((out[:, 0] - want) ** 2)) / np.sqrt(np.mean(want ** 2)))
        self.assertLess(res, -60, "residual %.1f dB" % res)
        self.assertEqual(r["parts"][0]["picture_in_from"], "the replaced line's in-point")
        self.assertAlmostEqual(r["parts"][0]["median_gain_db"], 7.19, delta=0.05)
        # the gain over the line follows the curve over the same timeline span: +6.65 dB at 1.1 s, +7.73 dB at 2.9 s
        raw = L.read_take(self.take, 0.5, 2.0)
        for t, db in ((0.1, 6.65), (1.9, 7.73)):
            i = int(t * SR)
            g = np.sqrt(np.mean(out[i:i + 2400, 0] ** 2)) / np.sqrt(np.mean(raw[i:i + 2400] ** 2))
            self.assertAlmostEqual(20 * np.log10(g), db, delta=0.15)

    def test_cut_json_in_point(self):
        self.write_gain()
        (self.take.with_suffix(".cut.json")).write_text(json.dumps({"in": 1.25, "out": 3.25}), encoding="utf-8")
        r = L.level(self.dir, "S01", "v2")
        self.assertTrue(r["ok"], r)
        out, _ = read(r["files"][0])
        want = self.expect(1.0, 2.0)
        res = 20 * np.log10(np.sqrt(np.mean((out[:, 0] - want) ** 2)) / np.sqrt(np.mean(want ** 2)))
        self.assertLess(res, -60, "residual %.1f dB" % res)
        self.assertEqual(r["parts"][0]["picture_in_from"], "cut.json")
        self.assertAlmostEqual(r["parts"][0]["audio_in_s"], 1.0, places=3)

    def test_filtered_line(self):
        chain = "highpass=f=450,lowpass=f=2900"
        self.gain["lines"][0].update({"filtered": "phone-earpiece", "filter_chain": chain})
        self.write_gain()
        r = L.level(self.dir, "S01", "v2")
        out, _ = read(r["files"][0])
        want = self.expect(0.5, 2.0, chain)
        res = 20 * np.log10(np.sqrt(np.mean((out[:, 0] - want) ** 2)) / np.sqrt(np.mean(want ** 2)))
        self.assertLess(res, -60, "residual %.1f dB" % res)
        self.assertEqual(r["parts"][0]["filter"], chain)

    def test_no_line_for_shot(self):
        self.write_gain()
        r = L.level(self.dir, "S09", "v2")
        self.assertFalse(r["ok"])


if __name__ == "__main__":
    unittest.main()
