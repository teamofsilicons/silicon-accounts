#!/usr/bin/env python3
"""Package tested ARM64 binaries and production Next standalone builds."""
from pathlib import Path
import hashlib,json,shutil,subprocess,tarfile
p=Path('.dev/production');bundle=p/'bundle';bundle.mkdir(exist_ok=True);(bundle/'bin').mkdir(exist_ok=True)
for binary in ['accounts-api','accounts-migrate']:
    shutil.copy2(Path('target/aarch64-unknown-linux-gnu/release')/binary,bundle/'bin'/binary)
for app in ['web','developer']:
    dest=bundle/app
    if dest.exists():shutil.rmtree(dest)
    shutil.copytree(Path(app)/'.next/standalone',dest,symlinks=True)
    shutil.copytree(Path(app)/'.next/static',dest/'.next/static',dirs_exist_ok=True)
    if (Path(app)/'public').exists():shutil.copytree(Path(app)/'public',dest/'public',dirs_exist_ok=True)
with tarfile.open(p/'node-v24.21.0-linux-arm64.tar.xz') as t:t.extractall(p,filter='data')
shutil.copytree(p/'node-v24.21.0-linux-arm64',bundle/'node',dirs_exist_ok=True)
with tarfile.open(p/'caddy_2.11.7_linux_arm64.tar.gz') as t:t.extract('caddy',bundle/'bin',filter='data')
shutil.copy2('deploy/install.py',bundle/'install.py')
rev=subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()
(bundle/'build.json').write_text(json.dumps({'revision':rev,'architecture':'aarch64','node':'v24.21.0','caddy':'v2.11.7'}))
archive=p/(rev+'.tar.gz')
with tarfile.open(archive,'w:gz',dereference=False) as t:
    for path in bundle.iterdir():t.add(path,arcname=path.name)
sha=hashlib.sha256(archive.read_bytes()).hexdigest()
(p/'release.json').write_text(json.dumps({'revision':rev,'sha256':sha,'archive':str(archive)}))
print('Bundle ready:',archive.stat().st_size,'bytes; sha256:',sha)
