"""Inventory runtime surfaces and validate source without reading user secrets.

python dev/audit_inventory.py
Outputs machine-readable evidence under .audit/3.7.0/.
"""
import ast
import hashlib
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / '.audit' / '3.7.0'
OUT.mkdir(parents=True, exist_ok=True)
FOLDERS = ['background', 'content', 'shared', 'popup', 'pages', 'bridge', 'tools', 'dev']
runtime = [p for folder in FOLDERS[:5] for p in (ROOT / folder).rglob('*') if p.suffix in {'.js', '.html', '.css'}]


class Controls(HTMLParser):
    def __init__(self):
        super().__init__()
        self.controls = []
        self.current = None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag in {'button', 'input', 'select', 'textarea', 'a'}:
            self.current = {'tag': tag, 'id': a.get('id'), 'name': a.get('name'), 'type': a.get('type'),
                'attributes': a, 'text': '', 'status': 'تأییدنشده',
                'verification': 'Inventory identifies reachability; see feature matrix for runtime evidence. Individual control is not certified by static discovery.'}
            self.controls.append(self.current)
            if tag == 'input':
                self.current = None

    def handle_data(self, data):
        if self.current:
            self.current['text'] += data

    def handle_endtag(self, tag):
        if self.current and self.current['tag'] == tag:
            self.current['text'] = ' '.join(self.current['text'].split())
            self.current = None


controls = []
for p in runtime:
    if p.suffix == '.html':
        parser = Controls()
        parser.feed(p.read_text(encoding='utf-8'))
        controls.extend({'file': p.relative_to(ROOT).as_posix(), **control} for control in parser.controls)
inventory = {'html_controls': controls, 'modules': []}
for p in runtime:
    if p.suffix != '.js':
        continue
    text = p.read_text(encoding='utf-8')
    inventory['modules'].append({'file': p.relative_to(ROOT).as_posix(), 'lines': text.count('\n') + 1,
        'functions': re.findall(r'\b(?:async\s+)?function\s+(\w+)\s*\(', text),
        'message_types': sorted(set(re.findall(r'\btype:\s*[\'\"]([A-Z][A-Z_]+)[\'\"]', text))),
        'dynamic_ids': sorted(set(re.findall(r'\bid\s*=\s*[\'\"]([^\'\"`]+)[\'\"]', text)))})
manifest = json.loads((ROOT / 'manifest.json').read_text(encoding='utf-8'))
inventory['manifest'] = manifest
script = "const vm=require('node:vm'),fs=require('node:fs');const c=vm.createContext({});vm.runInContext(fs.readFileSync('shared/settings.js','utf8'),c);console.log(JSON.stringify({defaults:c.GXT.DEFAULTS,fonts:c.GXT.BUNDLED_FONTS,tts:c.GXT.TTS_ENGINES,registers:c.GXT.REGISTERS,models:c.GXT.CURATED_MODELS}));"
settings = subprocess.run(['node', '-e', script], cwd=ROOT, capture_output=True, text=True, encoding='utf-8')
if settings.returncode:
    raise RuntimeError('Settings inventory could not evaluate')
inventory['configuration'] = json.loads(settings.stdout)
(OUT / 'feature-inventory.json').write_text(json.dumps(inventory, ensure_ascii=False, indent=2), encoding='utf-8')

validation = {'js': [], 'python': [], 'missing_references': [], 'changed_files': [], 'added_files': []}
for p in runtime:
    if p.suffix == '.js':
        result = subprocess.run(['node', '--check', str(p)], capture_output=True, text=True, encoding='utf-8')
        validation['js'].append({'file': p.relative_to(ROOT).as_posix(), 'ok': result.returncode == 0})
for folder in FOLDERS:
    for p in (ROOT / folder).rglob('*.py'):
        try:
            ast.parse(p.read_text(encoding='utf-8-sig'), filename=str(p))
            ok = True
        except SyntaxError:
            ok = False
        validation['python'].append({'file': p.relative_to(ROOT).as_posix(), 'ok': ok})
for p in runtime:
    if p.suffix == '.html':
        for ref in re.findall(r'(?:src|href)=[\'\"]([^\'\"]+)[\'\"]', p.read_text(encoding='utf-8')):
            if re.match(r'^[a-z]+:|^#', ref):
                continue
            if not (p.parent / ref.split('?')[0].split('#')[0]).exists():
                validation['missing_references'].append({'file': p.relative_to(ROOT).as_posix(), 'ref': ref})
baseline = {entry['path'].replace('\\', '/'): entry for entry in json.loads((OUT / 'baseline-files.json').read_text(encoding='utf-8-sig'))}
tracked = runtime + [p for folder in ['bridge', 'dev', 'tools'] for p in (ROOT / folder).rglob('*') if p.suffix in {'.py','.cjs','.html','.json'}] + [ROOT / 'manifest.json', ROOT / 'README.md', ROOT / 'INSTALL-3.7.0.fa.md', ROOT / 'AUDIT-3.7.0.fa.md', ROOT / 'FEATURES-3.7.0.fa.md']
for p in sorted(set(tracked)):
    rel = p.relative_to(ROOT).as_posix()
    if rel not in baseline:
        validation['added_files'].append(rel)
    elif hashlib.sha256(p.read_bytes()).hexdigest().lower() != baseline[rel]['sha256'].lower():
        validation['changed_files'].append(rel)
validation['ok'] = all(x['ok'] for x in validation['js'] + validation['python']) and not validation['missing_references']
(OUT / 'source-validation.json').write_text(json.dumps(validation, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({'html_controls': len(controls), 'settings': len(inventory['configuration']['defaults']),
    'js_files': len(validation['js']), 'python_files': len(validation['python']),
    'missing_references': validation['missing_references'], 'ok': validation['ok']}, ensure_ascii=False))
raise SystemExit(0 if validation['ok'] else 1)
