#!/usr/bin/env python3
"""Apply a verified account-site (web) overlay while keeping the rest of production byte for byte.

Run only from an archive whose checksum has already been verified. manifest.json pins the prior release, the
schema version (unchanged) and every file of the new web build. Based on passkeys-cutover.py: only web/ is replaced
(the previous builds' static files are kept for open tabs); the API, migrations, Developer, Node, Caddy, /etc/accounts
and the accounts-* units are kept and hash-checked. The new server answers on a loopback port before the switch, and
only accounts-web restarts. The database is not touched, so no backup is taken. Rollback: point `current` at
`previous-release` and restart accounts-web.
"""
import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import time
import urllib.request


def run(*args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def sha(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def files(root):
    return {str(p.relative_to(root)): ('link:' + os.readlink(p) if p.is_symlink() else sha(p))
            for p in sorted(root.rglob('*')) if p.is_symlink() or p.is_file()}


def schema():
    return run('runuser', '-u', 'postgres', '--', 'psql', '-d', 'silicon_accounts', '-v', 'ON_ERROR_STOP=1', '-At',
               input='select max(version) from _sqlx_migrations where success', text=True,
               capture_output=True).stdout.strip()


def switch(path):
    link = root / 'current.web-next'
    link.unlink(missing_ok=True)
    link.symlink_to(path)
    os.replace(link, root / 'current')


def healthy(url):
    for _ in range(45):
        try:
            with urllib.request.urlopen(url, timeout=3) as response:
                if response.status == 200:
                    return
        except Exception:
            pass
        time.sleep(1)
    raise RuntimeError('Readiness failed: ' + url)


HEALTH = ('http://127.0.0.1:8589/readyz', 'http://127.0.0.1:8590/v1/meta', 'http://127.0.0.1:8590/',
          'http://127.0.0.1:8600/auth/session')
PREFLIGHT_PORT = 18590

assert os.geteuid() == 0
stage = Path(__file__).resolve().parent
manifest = json.loads((stage / 'manifest.json').read_text())
assert files(stage / 'overlay') == manifest['files'], 'Overlay differs from manifest'
root = Path('/opt/accounts')
baseline = (root / 'current').resolve()
assert baseline.name == manifest['baseline'], 'Production changed; rebase the release'
assert schema() == manifest['schema'], 'Schema changed; rebase the release'
config_paths = list(Path('/etc/accounts').glob('*')) + list(Path('/etc/systemd/system').glob('accounts-*.service'))
config_hashes = {str(p): sha(p) for p in config_paths if p.is_file()}
release = root / 'releases' / manifest['release']
assert not release.exists(), 'Never overwrite an immutable release'
run('cp', '-a', '--', str(baseline), str(release))
shutil.rmtree(release / 'web')
shutil.copytree(stage / 'overlay/web', release / 'web', symlinks=True)
# Open tabs still ask for the previous builds' chunks: keep the ones the new build doesn't have.
old, new = baseline / 'web/.next/static', release / 'web/.next/static'
kept = 0
for path in old.rglob('*'):
    target = new / path.relative_to(old)
    if path.is_file() and not target.exists():
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, target)
        kept += 1
run('chmod', '-R', 'a+rX', str(release))
for name, expected in manifest['files'].items():
    p = release / name
    actual = 'link:' + os.readlink(p) if p.is_symlink() else sha(p)
    assert actual == expected, 'Release copy changed: ' + name
# Everything outside web/ is the baseline's, byte for byte (build.json is rewritten below).
outside = lambda tree: {k: v for k, v in tree.items() if not k.startswith('web/') and k != 'build.json'}
assert outside(files(release)) == outside(files(baseline)), 'Release differs from the baseline outside web/'

# Loopback preflight: the new server, as accounts-web with its environment, on a spare port. Its own unit name (an
# earlier run's failed transient unit may still be loaded), and the port must be free so the answer is the new build's.
stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
unit = 'accounts-web-preflight-' + stamp
with socket.socket() as probe:
    assert probe.connect_ex(('127.0.0.1', PREFLIGHT_PORT)) != 0, 'Preflight port is in use'
run('systemd-run', '--unit', unit, '--collect', '--quiet', '--property=User=accounts-web',
    '--property=EnvironmentFile=/etc/accounts/web.env', '--property=WorkingDirectory=' + str(release),
    '/usr/bin/env', 'PORT=' + str(PREFLIGHT_PORT), 'HOSTNAME=127.0.0.1',
    str(release / 'node/bin/node'), str(release / 'web/server.js'))
try:
    for path in ('/v1/meta', '/'):
        healthy('http://127.0.0.1:%d%s' % (PREFLIGHT_PORT, path))
finally:
    subprocess.run(['systemctl', 'stop', unit], check=False)
print('Loopback preflight passed on', PREFLIGHT_PORT, flush=True)

try:
    build = json.loads((baseline / 'build.json').read_text())
    build.update(revision=manifest['revision'], baseline_release=baseline.name, web_revision=manifest['revision'])
    build[manifest['build_key']] = {'source': manifest['revision'], 'baseline_release': baseline.name,
                                    'web_build_id': manifest['web_build_id'], 'prior_static_files_kept': kept}
    (release / 'build.json').write_text(json.dumps(build, indent=2) + '\n')
    (release / 'build.json').chmod(0o644)
    started = time.monotonic()
    switch(release)
    run('systemctl', 'restart', 'accounts-web')
    for url in HEALTH:
        healthy(url)
    cutover_seconds = round(time.monotonic() - started, 1)
    assert all(sha(Path(path)) == digest for path, digest in config_hashes.items()), 'Runtime configuration changed'
    assert schema() == manifest['schema']
except Exception:
    switch(baseline)
    run('systemctl', 'restart', 'accounts-web')
    for url in HEALTH:
        healthy(url)
    raise
# previous-release is a symlink to the release a rollback restores.
link = root / 'previous-release.next'
link.unlink(missing_ok=True)
link.symlink_to(baseline)
os.replace(link, root / 'previous-release')
receipt = {key: manifest[key] for key in ('release', 'revision', 'baseline', 'web_build_id')}
receipt.update(schema_version=int(manifest['schema']), prior_static_files_kept=kept, unchanged_outside_web=True,
               unchanged_configuration=True, loopback_preflight=PREFLIGHT_PORT, restarted_units=['accounts-web'],
               cutover_seconds=cutover_seconds, health='passed',
               verified_at=datetime.datetime.now(datetime.timezone.utc).isoformat())
(Path('/var/lib/accounts') / ('web-release-' + stamp + '.json')).write_text(json.dumps(receipt, indent=2) + '\n')
print(json.dumps(receipt, indent=2), flush=True)
