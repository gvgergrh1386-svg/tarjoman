"""Run current browser regressions against an immutable runtime or unpacked ZIP.

Test fixtures stay outside the release. Only runtime files come from --source.
"""
import argparse
from pathlib import Path
import shutil
import sys
import tempfile
import run_harness as h

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--source', type=Path, required=True)
parser.add_argument('suites', nargs='*')
args = parser.parse_args()
source = args.source.resolve()
current = Path(__file__).resolve().parents[1]
assert (source / 'manifest.json').is_file(), 'source must be an extension runtime'
with tempfile.TemporaryDirectory(prefix='gxt-runtime-regression-') as staging:
    root = Path(staging).resolve()
    # The fixed directory list never traverses user/audit/job data.
    for folder in ['background', 'content', 'shared', 'popup', 'pages', 'fonts', 'icons']:
        shutil.copytree(source / folder, root / folder)
    shutil.copy2(source / 'manifest.json', root / 'manifest.json')
    shutil.copytree(current / 'dev', root / 'dev', ignore=shutil.ignore_patterns('__pycache__'))
    h.ROOT = root
    h.HERE = root / 'dev'
    sys.argv = ['run_against', *args.suites]
    raise SystemExit(h.main())
