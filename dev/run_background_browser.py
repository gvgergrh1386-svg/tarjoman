"""Native Chrome IndexedDB checks against current sources or an untouched backup."""
from pathlib import Path
import json
import shutil
import sys
import tempfile

import run_harness as harness


def main():
    current = Path(__file__).resolve().parent.parent
    source = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else current
    with tempfile.TemporaryDirectory(prefix="gxt-background-regression-") as temp:
        fixture = Path(temp)
        (fixture / "background").mkdir()
        (fixture / "dev").mkdir()
        shutil.copy2(source / "background/audio-cache.js", fixture / "background/audio-cache.js")
        shutil.copy2(current / "dev/background-browser.html", fixture / "dev/background-browser.html")
        harness.ROOT = fixture
        with harness.serve() as (port, ws, _):
            lines, summary = harness.collect(ws, f"http://127.0.0.1:{port}/dev/background-browser.html", budget=45)
    print(json.dumps({"source": str(source), "lines": lines, "summary": summary}, ensure_ascii=False, indent=2))
    passes = sum(line.startswith("GXT-BACKGROUND PASS ") for line in lines)
    failures = [line for line in lines if " FAIL " in line]
    return 0 if summary == "GXT-BACKGROUND SUMMARY 5/5" and passes == 5 and not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
