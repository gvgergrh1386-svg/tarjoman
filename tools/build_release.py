"""Build deterministic extension/source ZIPs and a clean allowlisted source tree."""
import json,os,shutil,zipfile
from release_common import ROOT,load_lists,preflight,digest
lists=load_lists();version=preflight(lists);release=ROOT/'release';release.mkdir(exist_ok=True)
reports={}
for kind,label in [('extension','Chrome'),('source','Source')]:
    output=release/f'Tarjoman-{version}-{label}.zip';temp=output.with_suffix('.zip.tmp')
    with zipfile.ZipFile(temp,'w',zipfile.ZIP_DEFLATED,compresslevel=9) as z:
        for name in lists[kind]:
            info=zipfile.ZipInfo(name,date_time=(2026,1,1,0,0,0));info.create_system=3;info.external_attr=0o100644<<16;info.compress_type=zipfile.ZIP_DEFLATED
            z.writestr(info,(ROOT/name).read_bytes(),compress_type=zipfile.ZIP_DEFLATED,compresslevel=9)
    os.replace(temp,output);sha=digest(output.read_bytes());output.with_suffix('.zip.sha256').write_text(sha+'  '+output.name+'\n',encoding='ascii')
    reports[kind]={'file':output.name,'sha256':sha,'bytes':output.stat().st_size,'files':len(lists[kind])}
    print(f'{output.name}: {len(lists[kind])} files, SHA256 {sha}')
# Only a build-owned export under this release directory may be replaced.
dest=(release/'source').resolve();marker=release/'source-export.json'
if not dest.is_relative_to(release.resolve()) or dest==release.resolve():raise ValueError('unsafe export path')
if dest.exists():
    if not marker.is_file():raise ValueError('Refusing to replace a source directory without the export marker')
    # Do not overwrite local edits in an export used as a working checkout.
    previous=json.loads(marker.read_text('utf8'))
    existing={p.relative_to(dest).as_posix() for p in dest.rglob('*') if p.is_file()}
    if existing!=set(previous) or any(digest((dest/n).read_bytes())!=sha for n,sha in previous.items()):raise ValueError('Export was modified; choose another location before rebuilding')
    shutil.rmtree(dest)
dest.mkdir()
for name in lists['source']:
    target=dest/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(ROOT/name,target)
marker.write_text(json.dumps({n:digest((ROOT/n).read_bytes()) for n in lists['source']},indent=2),encoding='utf8')
(release/'release-manifest.json').write_text(json.dumps({'version':version,'packages':reports},indent=2)+'\n',encoding='utf8')
