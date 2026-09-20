"""Static release audit; reports paths and counts, never credential values."""
import ast
import hashlib
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import subprocess
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
BASELINE = ROOT / '.audit/baseline'
FOLDERS = ['background', 'content', 'shared', 'popup', 'pages', 'fonts', 'icons']
paths = sorted(p for folder in FOLDERS for p in (ROOT / folder).rglob('*') if p.is_file())
errors, references, changes = [], [], {'new': [], 'changed': [], 'unchanged': [], 'removed': []}


def reference(source, value):
    parsed = urlsplit(value)
    if parsed.scheme or parsed.netloc or not parsed.path:
        return
    path = ((ROOT if value.startswith('/') else source.parent) / unquote(parsed.path).lstrip('/')).resolve()
    references.append({'source': source.relative_to(ROOT).as_posix(), 'target': value, 'exists': path.is_file()})
    if not path.is_relative_to(ROOT) or not path.is_file():
        errors.append('Missing or escaping reference: ' + str(source.relative_to(ROOT)) + ': ' + value)


class LocalRefs(HTMLParser):
    def __init__(self, source):
        super().__init__()
        self.source = source

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        if tag in {'script', 'img', 'iframe', 'audio', 'video', 'source'} and attributes.get('src'):
            reference(self.source, attributes['src'])
        if tag == 'link' and attributes.get('href'):
            reference(self.source, attributes['href'])


syntax_count = 0
suspects = []
credential = re.compile(r'AIza[0-9A-Za-z_-]{35}|\bsk-(?:proj-)?[A-Za-z0-9_-]{40,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----')
for path in paths + [ROOT / 'manifest.json', ROOT / 'bridge/bridge.py']:
    relative = path.relative_to(ROOT).as_posix()
    data = path.read_bytes()
    before = BASELINE / relative
    changes['new' if not before.is_file() else 'unchanged' if before.read_bytes() == data else 'changed'].append(relative)
    if path.suffix in {'.js', '.html', '.css', '.json', '.py'}:
        source = data.decode('utf-8-sig')
        if credential.search(source):
            suspects.append(relative)
        if path.suffix == '.js':
            result = subprocess.run(['node', '--check', str(path)], capture_output=True, text=True)
            syntax_count += 1
            if result.returncode:
                errors.append('JS syntax: ' + relative)
        elif path.suffix == '.py':
            ast.parse(source, filename=relative)
        elif path.suffix == '.html':
            LocalRefs(path).feed(source)

manifest = json.loads((ROOT / 'manifest.json').read_text(encoding='utf-8'))
for name in [manifest['background']['service_worker'], manifest['action']['default_popup'], *manifest['icons'].values()]:
    reference(ROOT / 'manifest.json', name)
for group in manifest['content_scripts']:
    for name in group.get('js', []) + group.get('css', []):
        reference(ROOT / 'manifest.json', name)
for group in manifest['web_accessible_resources']:
    for pattern in group['resources']:
        if not list(ROOT.glob(pattern)):
            errors.append('Missing web accessible resource: ' + pattern)
worker = ROOT / manifest['background']['service_worker']
for call in re.finditer(r'\bimportScripts\(([\s\S]*?)\);', worker.read_text(encoding='utf-8')):
    body = re.sub(r'//[^\n]*|/\*[\s\S]*?\*/', '', call.group(1))
    for name in re.findall(r"['\"]([^'\"]+\.js)['\"]", body):
        reference(worker, name)
for folder in FOLDERS:
    for old in (BASELINE / folder).rglob('*'):
        if old.is_file() and not (ROOT / old.relative_to(BASELINE)).is_file():
            changes['removed'].append(old.relative_to(BASELINE).as_posix())

report = {'version': manifest['version'], 'javascriptSyntaxFiles': syntax_count,
          'localReferenceCount': len(references), 'errors': errors, 'credentialPatternFiles': suspects,
          'changes': changes, 'references': references,
          'runtimeSha256': {p.relative_to(ROOT).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}}
out = ROOT / '.audit/3.7.5/final-static.json'
out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({k: report[k] for k in ['version', 'javascriptSyntaxFiles', 'localReferenceCount', 'errors', 'credentialPatternFiles']}, ensure_ascii=False))
print('Changes: ' + json.dumps({k: len(v) for k, v in changes.items()}))
raise SystemExit(1 if errors or suspects else 0)
