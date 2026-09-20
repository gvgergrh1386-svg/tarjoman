"""Shared explicit-list release validation. Never reads local credential files."""
from pathlib import Path,PurePosixPath
import ast,fnmatch,hashlib,json,re,subprocess,sys
ROOT=Path(__file__).resolve().parents[1]
TEXT_EXT={'.js','.cjs','.json','.html','.css','.py','.md','.txt','.cmd','.yml','.yaml'}
PATTERNS={
 'Google API key':re.compile(rb'AIza[0-9A-Za-z_-]{35}'),
 'provider token':re.compile(rb'\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{32,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|xox[baprs]-[A-Za-z0-9-]{24,})'),
 'private key':re.compile(rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'),
 'home path':re.compile(rb'(?:[A-Za-z]:[\\/]+Users[\\/]+[^\s"\'<>]+|/(?:home|Users)/[A-Za-z0-9_.-]+/)'),
 'literal credential':re.compile(rb'''(?i)(?:api[_-]?key|access[_-]?token|password|authorization|bridgeToken)\s*[:=]\s*["']([A-Za-z0-9_./+=-]{24,})["']'''),
}
def digest(data):return hashlib.sha256(data).hexdigest()
def load_lists():
    lists=json.loads((ROOT/'tools/public-files.json').read_text('utf8'))
    for kind in ('source','extension'):
        names=lists[kind]
        if names!=sorted(set(names)):raise ValueError(kind+' list must be unique and sorted')
        for name in names:
            p=PurePosixPath(name)
            if p.is_absolute() or '..' in p.parts or '\\' in name or ':' in name:raise ValueError('unsafe public path')
            if any(x in {'.audit','.git','.rollback','node_modules','__pycache__','jobs','release','.venv'} for x in p.parts) or p.name in {'token.txt','.env'}:raise ValueError('private/generated path in public list: '+name)
            path=ROOT/name
            if path.is_symlink() or not path.is_file():raise ValueError('missing file or symlink: '+name)
    if not set(lists['extension'])<=set(lists['source']):raise ValueError('extension not contained in source list')
    return lists
def scan(name,data):
    if PurePosixPath(name).suffix in TEXT_EXT or name in {'.gitignore','LICENSE'}:
        data.decode('utf8')
        for label,pattern in PATTERNS.items():
            for match in pattern.finditer(data):
                # Named synthetic fixture values are the only accepted credential literals.
                if label=='literal credential' and any(x in match.group(1).lower() for x in [b'test_only',b'synthetic',b'fixture',b'example']):continue
                raise ValueError(label+' pattern in '+name+' (value withheld)')
def validate_manifest(names,read):
    m=json.loads(read('manifest.json'));required=[m['background']['service_worker'],m['action']['default_popup']]+list(m['icons'].values())
    if 'bridge/bridge.py' in names:
        required += ['bridge/messages.json','bridge/manga_target_runner.py']
    for group in m.get('content_scripts',[]):required+=group.get('js',[])+group.get('css',[])
    for n in required:
        if n not in names:raise ValueError('missing runtime dependency '+n)
    for group in m.get('web_accessible_resources',[]):
        for pattern in group['resources']:
            if not any(fnmatch.fnmatchcase(n,pattern) for n in names):raise ValueError('empty resource pattern '+pattern)
    for lang in ('en','fa'):
        data=json.loads(read(f'_locales/{lang}/messages.json'))
        for key in re.findall(r'__MSG_([\w]+)__',json.dumps(m)):
            if not data.get(key,{}).get('message'):raise ValueError('missing native message '+key)
    # Local script/style/image references in application HTML must be included.
    for name in [n for n in names if n.startswith(('popup/','pages/')) and n.endswith('.html')]:
        for relative in re.findall(r'(?:src|href)=["\']([^"\']+)["\']',read(name).decode('utf8')):
            if ':' in relative or relative.startswith('#'):continue
            resolved=(ROOT/name).parent.joinpath(relative).resolve()
            if not resolved.is_relative_to(ROOT) or resolved.relative_to(ROOT).as_posix() not in names:raise ValueError('missing HTML asset '+relative)
    return m
def preflight(lists):
    for name in lists['source']:
        data=(ROOT/name).read_bytes();scan(name,data)
        if name.endswith('.py'):ast.parse(data,filename=name)
        if name.endswith('.json'):json.loads(data)
    for item in json.loads((ROOT/'licenses/sources.json').read_text('utf8')):
        if digest((ROOT/'licenses'/item['file']).read_bytes())!=item['sha256']:raise ValueError('upstream license hash mismatch: '+item['file'])
    subprocess.run([sys.executable,'tools/build_i18n.py','--check'],cwd=ROOT,check=True)
    subprocess.run(['node','tools/check_i18n.cjs'],cwd=ROOT,check=True)
    # Acorn validates JS/CJS and inline regression scripts without executing them.
    subprocess.run(['node','tools/check_syntax.cjs'],cwd=ROOT,check=True)
    m=validate_manifest(lists['extension'],lambda n:(ROOT/n).read_bytes())
    if json.loads((ROOT/'package.json').read_text('utf8'))['version']!=m['version']:raise ValueError('package version mismatch')
    if f'VERSION = "{m["version"]}"' not in (ROOT/'bridge/bridge.py').read_text('utf8'):raise ValueError('companion version mismatch')
    return m['version']
