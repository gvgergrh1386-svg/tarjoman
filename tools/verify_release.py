"""Verify exact public file sets, bytes, privacy patterns, dependencies and hashes."""
import argparse,json,zipfile
from pathlib import Path
from release_common import ROOT,load_lists,scan,validate_manifest,digest
parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--extract',type=Path);args=parser.parse_args()
lists=load_lists();version=json.loads((ROOT/'manifest.json').read_text('utf8'))['version'];reports={}
for kind,label in [('extension','Chrome'),('source','Source')]:
    p=ROOT/'release'/f'Tarjoman-{version}-{label}.zip';sha=digest(p.read_bytes())
    assert p.with_suffix('.zip.sha256').read_text().split()[0]==sha,'checksum mismatch'
    with zipfile.ZipFile(p) as z:
        assert z.testzip() is None,'archive integrity failure'
        assert sorted(z.namelist())==lists[kind],'archive file set mismatch or duplicate'
        entries={}
        for name in z.namelist():
            data=z.read(name);scan(name,data);assert data==(ROOT/name).read_bytes(),'source byte mismatch: '+name;entries[name]=digest(data)
        assert validate_manifest(z.namelist(),z.read)['version']==version
        if kind=='extension' and args.extract:
            dest=args.extract.resolve();parent=(ROOT/'.audit'/version).resolve()
            assert dest.is_relative_to(parent) and dest!=parent,'use a dedicated audit child for extraction'
            assert not dest.exists() or not any(dest.iterdir()),'extraction destination must be empty'
            dest.mkdir(parents=True,exist_ok=True);z.extractall(dest)
    reports[kind]={'file':p.name,'sha256':sha,'files':len(entries),'bytes':p.stat().st_size,'entries':entries}
out=ROOT/'.audit'/version;out.mkdir(parents=True,exist_ok=True);(out/'package-validation.json').write_text(json.dumps(reports,indent=2),encoding='utf8')
print(json.dumps({k:{n:v for n,v in r.items() if n!='entries'} for k,r in reports.items()},indent=2))
