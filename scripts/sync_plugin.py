"""The repo's panel files copied into Resolve's installed plugin folder (as scripts/install.ps1 copies them), each one
that differs backed up first as <name>.before-<stamp>. WorkflowIntegration.node is the installer's and is left alone.
python scripts/sync_plugin.py"""
import hashlib
import shutil
from datetime import datetime
from pathlib import Path

SRC = Path(__file__).resolve().parent.parent / "plugin" / "com.imagine.review"
DST = Path(r"C:\ProgramData\Blackmagic Design\DaVinci Resolve\Support\Workflow Integration Plugins\com.imagine.review")
stamp = datetime.now().strftime("%Y%m%d-%H%M")


def sha(p):
    return hashlib.sha1(p.read_bytes()).hexdigest()


for f in sorted(SRC.rglob("*")):
    if not f.is_file():
        continue
    d = DST / f.relative_to(SRC)
    if d.exists() and sha(d) == sha(f):
        print("same    ", f.relative_to(SRC))
        continue
    if d.exists():
        shutil.copy2(d, d.with_name(d.name + ".before-" + stamp))
    d.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(f, d)
    print("copied  ", f.relative_to(SRC))
