#!/usr/bin/env python3
"""Apply the verified passkeys overlay (PR 27) while preserving the composite production runtime.

Run only from an archive whose checksum has already been verified. manifest.json pins the
prior release, every replacement file and the schema transition (44 -> 45). Based on
ting-cutover.py: API, migrations, web and Developer are replaced; Node, Caddy and every
runtime configuration file are kept byte for byte.
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

SCHEMA_FROM, SCHEMA_TO = '44', '45'


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


def schema():
    return sql('select max(version) from _sqlx_migrations where success')


def switch(path):
    link = root / 'current.passkeys-next'
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


HEALTH = ('http://127.0.0.1:8589/readyz', 'http://127.0.0.1:8590/v1/meta', 'http://127.0.0.1:8600/auth/session')

assert os.geteuid() == 0
stage = Path(__file__).resolve().parent
manifest = json.loads((stage / 'manifest.json').read_text())
assert files(stage / 'overlay') == manifest['files'], 'Overlay differs from manifest'
root = Path('/opt/accounts')
baseline = (root / 'current').resolve()
assert baseline.name == manifest['baseline'], 'Production changed; rebase the release'
assert sha(baseline / 'bin/accounts-api') == manifest['baseline_api_sha256']
assert schema() == SCHEMA_FROM
config_paths = list(Path('/etc/accounts').glob('*')) + list(Path('/etc/systemd/system').glob('accounts-*.service'))
config_hashes = {str(p): sha(p) for p in config_paths if p.is_file()}
release = root / 'releases' / manifest['release']
assert not release.exists(), 'Never overwrite an immutable release'
run('cp', '-a', '--', str(baseline), str(release))
kept = {}
for app in ('web', 'developer'):
    shutil.rmtree(release / app)
    shutil.copytree(stage / 'overlay' / app, release / app, symlinks=True)
    # Open tabs still ask for the previous build's chunks: keep the ones the new build doesn't have.
    old, new = baseline / app / '.next/static', release / app / '.next/static'
    kept[app] = 0
    for path in old.rglob('*'):
        target = new / path.relative_to(old)
        if path.is_file() and not target.exists():
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, target)
            kept[app] += 1
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
backup = Path('/var/lib/accounts/backups') / ('predeploy-passkeys-' + stamp + '.dump')
# The live API keeps serving through the backup and migration: 0045 only adds two tables it never reads.
with backup.open('xb') as stream:
    run('runuser', '-u', 'postgres', '--', 'pg_dump', '-Fc', 'silicon_accounts', stdout=stream)
backup.chmod(0o600)
run('pg_restore', '--list', str(backup), stdout=subprocess.DEVNULL)
backup_key = 'backups/' + backup.name
run('aws', 's3', 'cp', str(backup), 's3://' + manifest['bucket'] + '/' + backup_key, '--only-show-errors')
print('Backup verified and uploaded:', backup_key, flush=True)
try:
    # systemd reads the existing private environment; credentials never enter command arguments.
    run('systemd-run', '--wait', '--collect', '--quiet', '--pipe',
        '--property=EnvironmentFile=/etc/accounts/api.env', '--property=User=accounts',
        str(release / 'bin/accounts-migrate'))
    assert schema() == SCHEMA_TO
    build = json.loads((baseline / 'build.json').read_text())
    build.update(revision=manifest['revision'], baseline_release=baseline.name,
                 accounts_revision=manifest['revision'], migration_revision=manifest['revision'],
                 migration_version=int(SCHEMA_TO), passkeys_release=manifest['release'])
    for binary in ('accounts-api', 'accounts-migrate', 'accounts-migrate-uuids'):
        build.setdefault('binaries', {})[binary] = sha(release / 'bin' / binary)
    build['web_revision'] = build['developer_revision'] = manifest['revision']
    (release / 'build.json').write_text(json.dumps(build, indent=2) + '\n')
    (release / 'build.json').chmod(0o644)
    switch(release)
    run('systemctl', 'restart', 'accounts-api', 'accounts-web', 'accounts-developer')
    for url in HEALTH:
        healthy(url)
    assert all(sha(Path(path)) == digest for path, digest in config_hashes.items()), 'Runtime configuration changed'
except Exception:
    # Migration 45 is additive (two new tables), so the previous code runs on it unchanged.
    switch(baseline)
    run('systemctl', 'restart', 'accounts-api', 'accounts-web', 'accounts-developer')
    for url in HEALTH:
        healthy(url)
    raise
# previous-release is a symlink to the release a rollback restores (the overlays since 2026-11 keep it that way).
link = root / 'previous-release.next'
link.unlink(missing_ok=True)
link.symlink_to(baseline)
os.replace(link, root / 'previous-release')
receipt = {key: manifest[key] for key in ('release', 'revision', 'baseline', 'bucket')}
receipt.update(backup_key=backup_key, backup_sha256=sha(backup), migration_version=int(SCHEMA_TO),
               prior_static_files_kept=kept, unchanged_configuration=True, health='passed',
               verified_at=datetime.datetime.now(datetime.timezone.utc).isoformat())
(Path('/var/lib/accounts') / ('passkeys-release-' + stamp + '.json')).write_text(json.dumps(receipt, indent=2) + '\n')
print(json.dumps(receipt, indent=2), flush=True)
