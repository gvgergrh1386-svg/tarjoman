"""Run the complete regression suite, retaining every suite's output."""
from pathlib import Path
import json,os,subprocess,sys
ROOT=Path(__file__).resolve().parents[1]
version=json.loads((ROOT/'manifest.json').read_text('utf8'))['version']
out=ROOT/'.audit'/version/'tests';out.mkdir(parents=True,exist_ok=True)
commands=[['node',str(p.relative_to(ROOT))] for p in sorted((ROOT/'dev').glob('*regressions.cjs'))]
commands += [['node','dev/test_subtitles.cjs'],['node','dev/test_workshop.cjs']]
commands += [[sys.executable,p] for p in ['dev/test_runner.py','bridge/test_audit.py','bridge/selftest_bridge.py','bridge/test_manga_targets.py']]
if '--browser' in sys.argv:commands=[[sys.executable,'dev/run_harness.py']]
results=[]
for command in commands:
    result=subprocess.run(command,cwd=ROOT,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,encoding='utf8',errors='replace',env={**os.environ,'PYTHONIOENCODING':'utf-8'})
    name=Path(command[-1]).stem; (out/(name+'.log')).write_text(result.stdout,encoding='utf8')
    results.append({'suite':command[-1],'exit':result.returncode,'log':name+'.log'})
    print(('PASS ' if result.returncode==0 else 'FAIL ')+command[-1],flush=True)
(out/('browser.json' if '--browser' in sys.argv else 'suites.json')).write_text(json.dumps(results,indent=2),encoding='utf8')
sys.exit(any(x['exit'] for x in results))
