"""Run 3.7.0 content regressions against current or preserved production sources.

python dev/run_content_audit.py [--source PATH] [--output PATH]
Uses real headless Chrome and controlled worker responses, with a temporary profile.
"""
import argparse
import json
import shutil
import sys
import tempfile
from pathlib import Path

import run_harness as harness

ROOT = Path(__file__).resolve().parents[1]
for stream in (sys.stdout, sys.stderr):
    if hasattr(stream, 'reconfigure'):
        stream.reconfigure(encoding='utf-8', errors='replace')
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--source', type=Path, default=ROOT)
parser.add_argument('--output', type=Path)
parser.add_argument('pages', nargs='*', default=['mock-media-lifecycle.html'])
args = parser.parse_args()
results = {}
with tempfile.TemporaryDirectory(prefix='gxt-content-audit-') as directory:
    target = Path(directory)
    for name in ['content', 'shared', 'fonts', 'icons', 'pages', 'popup']:
        shutil.copytree(args.source / name, target / name)
    (target / 'dev').mkdir()
    shutil.copy2(ROOT / 'dev/chrome-shim.js', target / 'dev/chrome-shim.js')
    for page in args.pages:
        shutil.copy2(ROOT / 'dev' / page, target / 'dev' / page)
    harness.ROOT = target
    with harness.serve() as (port, ws, proc):
        for page in args.pages:
            lines, summary = harness.collect(ws, f'http://127.0.0.1:{port}/dev/{page}', 90)
            validation = harness.evaluate_results(lines, summary)
            baseline = json.loads(harness.BASELINE.read_text(encoding='utf-8'))
            expected = baseline.get(page, {'mock-media-lifecycle.html': 15, 'mock-yt-settings-lifecycle.html': 8}.get(page))
            if expected is None:
                validation['problems'].append('No expected check count registered for ' + page)
            elif validation['checks'] < expected:
                validation['problems'].append(f'Expected at least {expected} checks; observed {validation["checks"]}')
            results[page] = {'summary': summary, 'lines': lines, 'validation': validation}
            print('\n'.join(lines), flush=True)
if args.output:
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding='utf-8')
ok = all(not r['validation']['problems'] for r in results.values())
raise SystemExit(0 if ok else 1)
