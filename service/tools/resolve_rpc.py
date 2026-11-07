"""Resolve's scripting objects served over stdin/stdout, one JSON request per line, so the panel's own functions
(plugin/com.imagine.review/lib/resolve.js) can be driven through external scripting by take_test.cjs.

request  {"id": 1, "h": 0, "m": "GetProjectManager", "a": []}     h 0 is the Resolve object
answer   {"id": 1, "r": {"__h": 3}}  or  {"id": 1, "e": "message"}
Scripting objects travel as {"__h": n}; everything else as JSON.
"""
import json
import os
import sys

os.environ.setdefault("RESOLVE_SCRIPT_API", r"C:\ProgramData\Blackmagic Design\DaVinci Resolve\Support\Developer\Scripting")
os.environ.setdefault("RESOLVE_SCRIPT_LIB", r"C:\Program Files\Blackmagic Design\DaVinci Resolve\fusionscript.dll")
sys.path.append(os.path.join(os.environ["RESOLVE_SCRIPT_API"], "Modules"))
import DaVinciResolveScript as dvr  # noqa: E402

PLAIN = (str, int, float, bool, type(None))
objs = {}


def enc(v):
    if isinstance(v, PLAIN):
        return v
    if isinstance(v, (list, tuple)):
        return [enc(x) for x in v]
    if isinstance(v, dict):
        return {str(k): enc(x) for k, x in v.items()}
    k = len(objs) + 1
    objs[k] = v
    return {"__h": k}


def dec(v):
    if isinstance(v, list):
        return [dec(x) for x in v]
    if isinstance(v, dict):
        if set(v) == {"__h"}:
            return objs[v["__h"]]
        return {k: dec(x) for k, x in v.items()}
    return v


def main():
    r = dvr.scriptapp("Resolve")
    if r is None:
        print(json.dumps({"id": 0, "e": "DaVinci Resolve is not reachable by scripting"}), flush=True)
        return
    objs[0] = r
    print(json.dumps({"id": 0, "r": "ready"}), flush=True)
    for line in sys.stdin:
        if not line.strip():
            continue
        q = json.loads(line)
        try:
            fn = getattr(objs[q["h"]], q["m"])
            out = {"id": q["id"], "r": enc(fn(*dec(q.get("a") or [])))}
        except Exception as e:  # the caller sees it as a rejected promise
            out = {"id": q["id"], "e": "%s.%s: %s: %s" % (type(objs.get(q["h"])).__name__, q["m"], type(e).__name__, e)}
        print(json.dumps(out), flush=True)


if __name__ == "__main__":
    main()
