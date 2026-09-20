#!/usr/bin/env python3
"""Run the general-video browser regressions without changing old baselines."""
import json
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import run_harness as harness

if __name__ == '__main__':
    with harness.serve() as (port, ws, _proc):
        page = sys.argv[1] if len(sys.argv)>1 else 'mock-web-video.html'
        lines, summary = harness.collect(ws, f'http://127.0.0.1:{port}/dev/{page}', budget=90)
        result = harness.evaluate_results(lines, summary)
        print(json.dumps({'lines': lines, **result}, ensure_ascii=False, indent=2))
        sys.exit(1 if result['problems'] else 0)
