#!/usr/bin/env python3
"""Apply a verified Ting overlay while preserving the composite production runtime.

Run only from an archive whose checksum has already been verified. manifest.json
pins the prior release, every replacement file, and the schema transition.
"""
import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
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


def sql(query):
    return run('runuser', '-u', 'postgres', '--', 'psql', '-d', 'silicon_accounts',
               '-v', 'ON_ERROR_STOP=1', '-At', input=query, text=True,
               capture_output=True).stdout.strip()


def switch(path):
    link = root / 'current.ting-next'
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


assert os.geteuid() == 0
stage = Path(__file__).resolve().parent
manifest = json.loads((stage / 'manifest.json').read_text())
assert files(stage / 'overlay') == manifest['files'], 'Overlay differs from manifest'
root = Path('/opt/accounts')
baseline = (root / 'current').resolve()
assert baseline.name == manifest['baseline'], 'Production changed; rebase the release'
assert sha(baseline / 'bin/accounts-api') == manifest['baseline_api_sha256']
assert sql('select max(version) from _sqlx_migrations where success') == '37'
# Automatic rollback is safe for this deployment only because no Silicon callback
# is configured or waiting. Otherwise an operator must plan legacy delivery recovery.
assert sql("select count(*) from accounts where kind='silicon' and webhook_url is not null") == '0'
assert sql("select count(*) from webhook_deliveries where target_kind='silicon' and status='pending'") == '0'
config_paths = list(Path('/etc/accounts').glob('*')) + list(Path('/etc/systemd/system').glob('accounts-*.service'))
config_hashes = {str(p): sha(p) for p in config_paths if p.is_file()}
release = root / 'releases' / manifest['release']
assert not release.exists(), 'Never overwrite an immutable release'
run('cp', '-a', '--', str(baseline), str(release))
for app in ('web', 'developer'):
    shutil.rmtree(release / app)
    shutil.copytree(stage / 'overlay' / app, release / app, symlinks=True)
for binary in ('accounts-api', 'accounts-migrate', 'accounts-migrate-uuids'):
    shutil.copy2(stage / 'overlay/bin' / binary, release / 'bin' / binary)
    (release / 'bin' / binary).chmod(0o755)
run('chmod', '-R', 'a+rX', str(release))
for name, expected in manifest['files'].items():
    p = release / name
    actual = 'link:' + os.readlink(p) if p.is_symlink() else sha(p)
    assert actual == expected, 'Release copy changed: ' + name
assert sha(release / 'node/bin/node') == sha(baseline / 'node/bin/node')
assert sha(release / 'bin/caddy') == sha(baseline / 'bin/caddy')
assert (root / 'current').resolve() == baseline
stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
backup = Path('/var/lib/accounts/backups') / ('predeploy-ting-' + stamp + '.dump')
run('systemctl', 'stop', 'accounts-api')
try:
    with backup.open('xb') as stream:
        run('runuser', '-u', 'postgres', '--', 'pg_dump', '-Fc', 'silicon_accounts', stdout=stream)
    backup.chmod(0o600)
    run('pg_restore', '--list', str(backup), stdout=subprocess.DEVNULL)
    backup_key = 'backups/' + backup.name
    run('aws', 's3', 'cp', str(backup), 's3://' + manifest['bucket'] + '/' + backup_key,
        '--only-show-errors')
    print('Backup verified and uploaded:', backup_key, flush=True)
    # systemd reads the existing private environment; credentials never enter command arguments.
    run('systemd-run', '--wait', '--collect', '--quiet', '--pipe',
        '--property=EnvironmentFile=/etc/accounts/api.env', '--property=User=accounts',
        str(release / 'bin/accounts-migrate'))
    assert sql('select max(version) from _sqlx_migrations where success') == '38'
    build = json.loads((baseline / 'build.json').read_text())
    build.update(revision=manifest['revision'], baseline_release=baseline.name,
                 accounts_revision=manifest['revision'], migration_revision=manifest['revision'],
                 migration_version=38, ting_release=manifest['release'])
    for binary in ('accounts-api', 'accounts-migrate', 'accounts-migrate-uuids'):
        build.setdefault('binaries', {})[binary] = sha(release / 'bin' / binary)
    build['web_revision'] = build['developer_revision'] = manifest['revision']
    (release / 'build.json').write_text(json.dumps(build, indent=2) + '\n')
    (release / 'build.json').chmod(0o644)
    switch(release)
    run('systemctl', 'restart', 'accounts-api', 'accounts-web', 'accounts-developer')
    for url in ('http://127.0.0.1:8589/readyz', 'http://127.0.0.1:8590/', 'http://127.0.0.1:8600/docs'):
        healthy(url)
    assert all(sha(Path(path)) == digest for path, digest in config_hashes.items()), 'Runtime configuration changed'
except Exception:
    # Migration 38 is additive. The empty legacy Silicon callback queue checked
    # above permits a code rollback; preserve the new outbox and backup for recovery.
    switch(baseline)
    run('systemctl', 'restart', 'accounts-api', 'accounts-web', 'accounts-developer')
    healthy('http://127.0.0.1:8589/readyz')
    raise
(root / 'previous-release').write_text(str(baseline) + '\n')
(root / 'previous-release').chmod(0o600)
receipt = {key: manifest[key] for key in ('release', 'revision', 'baseline', 'bucket')}
receipt.update(backup_key=backup_key, backup_sha256=sha(backup), migration_version=38,
               unchanged_configuration=True, health='passed',
               verified_at=datetime.datetime.now(datetime.timezone.utc).isoformat())
(Path('/var/lib/accounts') / ('ting-release-' + stamp + '.json')).write_text(json.dumps(receipt, indent=2) + '\n')
print(json.dumps(receipt, indent=2), flush=True)
