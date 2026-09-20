#!/usr/bin/env python3
"""Print EVERY GXT-* line one harness page emits, in order.

dev/run_harness.py is the pass/fail gate and deliberately prints only failures.
When a check fails you usually need the diagnostic line next to it — the
measured ratio, the theme it happened on — and that is what this shows.

Run:  python dev/dump_harness.py mock-yt.html
      python dev/dump_harness.py "mock-yt-nodeps.html?drop=ui"
"""
from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import run_harness as H  # noqa: E402


def main() -> int:
    # The suites print Persian, and this pipe defaults to the ANSI codepage on
    # Windows — without this the tool dies on its own output.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, OSError):
            pass
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    page = sys.argv[1]
    with H.serve() as (port, ws, stop):
        url = f"http://127.0.0.1:{port}/dev/{page}{'&' if '?' in page else '?'}h=1"
        lines, summary = H.collect(ws, url, budget=120.0, emulate=H.EMULATE.get(page))
        for line in lines:
            print(line)
        print("--- summary:", summary or "(none)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
