#!/usr/bin/env python3
"""Apply the verified Twilio Verify SMS overlay (API-only) while preserving the production runtime.

Run only from an archive whose checksum has already been verified. manifest.json pins the
prior release, the replacement accounts-api binary, and the unchanged schema version (45).
Refreshes /etc/accounts/api.env from Secrets Manager so ACCOUNTS_TWILIO_VERIFY_SERVICE_SID is active;
Node, Caddy, web, Developer, systemd units and every other runtime file are kept byte for byte.
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

SCHEMA_EXPECTED = '45'
RETIRED = ('ACCOUNTS_TELEMETRY_ENABLED', 'ACCOUNTS_TELEMETRY_TABLE_KEY')


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


def quote_env(v):
    s = str(v)
    assert '\n' not in s and '\r' not in s and '\0' not in s
    return '"' + s.replace('\\', '\\\\').replace('"', '\\"') + '"'


def write_env_atomic(path, values):
    tmp = path.with_suffix('.env.next')
    tmp.unlink(missing_ok=True)
    fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as f:
        for k, v in values.items():
            f.write(k + '=' + quote_env(v) + '\n')
    os.replace(tmp, path)


def switch(path):
    link = root / 'current.twilio-verify-next'
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
os.umask(0o077)
stage = Path(__file__).resolve().parent
manifest = json.loads((stage / 'manifest.json').read_text())
assert files(stage / 'overlay') == manifest['files'], 'Overlay differs from manifest'
root = Path('/opt/accounts')
baseline = (root / 'current').resolve()
assert baseline.name == manifest['baseline'], 'Production changed; rebase the release'
assert sha(baseline / 'bin/accounts-api') == manifest['baseline_api_sha256']
assert schema() == SCHEMA_EXPECTED

# Hash every config/unit EXCEPT api.env (which we refresh from Secrets Manager) so we verify nothing else changes.
immutable_paths = [
    p for p in list(Path('/etc/accounts').glob('*')) + list(Path('/etc/systemd/system').glob('accounts-*.service'))
    if p.is_file() and p.name != 'api.env'
]
immutable_hashes = {str(p): sha(p) for p in immutable_paths}

release = root / 'releases' / manifest['release']
assert not release.exists(), 'Never overwrite an immutable release'
run('cp', '-a', '--', str(baseline), str(release))
shutil.copy2(stage / 'overlay/bin/accounts-api', release / 'bin/accounts-api')
(release / 'bin/accounts-api').chmod(0o755)
run('chmod', '-R', 'a+rX', str(release))
assert sha(release / 'bin/accounts-api') == manifest['files']['bin/accounts-api']
assert sha(release / 'node/bin/node') == sha(baseline / 'node/bin/node')
assert sha(release / 'bin/caddy') == sha(baseline / 'bin/caddy')
assert (root / 'current').resolve() == baseline

stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
backup = Path('/var/lib/accounts/backups') / ('predeploy-twilio-verify-' + stamp + '.dump')
with backup.open('xb') as stream:
    run('runuser', '-u', 'postgres', '--', 'pg_dump', '-Fc', 'silicon_accounts', stdout=stream)
backup.chmod(0o600)
run('pg_restore', '--list', str(backup), stdout=subprocess.DEVNULL)
backup_key = 'backups/' + backup.name
run('aws', 's3', 'cp', str(backup), 's3://' + manifest['bucket'] + '/' + backup_key, '--only-show-errors')
print('Backup verified and uploaded:', backup_key, flush=True)

# Fetch updated runtime secret directly on host; never print secret values.
secret_raw = subprocess.check_output(
    ['aws', 'secretsmanager', 'get-secret-value', '--region', manifest['region'], '--secret-id', manifest['secret']],
    text=True,
)
secret = json.loads(json.loads(secret_raw)['SecretString'])
api_env = {k: v for k, v in secret.items() if k.startswith('ACCOUNTS_') and k not in RETIRED}
assert 'ACCOUNTS_TWILIO_VERIFY_SERVICE_SID' in api_env, 'Secret is missing ACCOUNTS_TWILIO_VERIFY_SERVICE_SID'
assert 'ACCOUNTS_TWILIO_MESSAGING_SERVICE_SID' not in api_env, 'Secret still has ACCOUNTS_TWILIO_MESSAGING_SERVICE_SID'

api_env_path = Path('/etc/accounts/api.env')
prior_api_env = api_env_path.read_bytes()

try:
    build = json.loads((baseline / 'build.json').read_text())
    build.update(
        revision=manifest['revision'],
        baseline_release=baseline.name,
        accounts_revision=manifest['revision'],
        twilio_verify_release=manifest['release'],
    )
    build.setdefault('binaries', {})['accounts-api'] = sha(release / 'bin/accounts-api')
    (release / 'build.json').write_text(json.dumps(build, indent=2) + '\n')
    (release / 'build.json').chmod(0o644)
    write_env_atomic(api_env_path, api_env)
    switch(release)
    run('systemctl', 'restart', 'accounts-api')
    for url in HEALTH:
        healthy(url)
    assert all(sha(Path(path)) == digest for path, digest in immutable_hashes.items()), 'Unexpected configuration change'
except Exception:
    fd = os.open(str(api_env_path.with_suffix('.env.rollback')), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'wb') as f:
        f.write(prior_api_env)
    os.replace(api_env_path.with_suffix('.env.rollback'), api_env_path)
    switch(baseline)
    run('systemctl', 'restart', 'accounts-api')
    for url in HEALTH:
        healthy(url)
    raise

link = root / 'previous-release.next'
link.unlink(missing_ok=True)
link.symlink_to(baseline)
os.replace(link, root / 'previous-release')

receipt = {key: manifest[key] for key in ('release', 'revision', 'baseline', 'bucket')}
receipt.update(
    api_sha256=sha(release / 'bin/accounts-api'),
    backup_key=backup_key,
    backup_sha256=sha(backup),
    migration_version=int(SCHEMA_EXPECTED),
    twilio_env_keys=sorted(k for k in api_env if 'TWILIO' in k),
    health='passed',
    verified_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),
)
(Path('/var/lib/accounts') / ('twilio-verify-release-' + stamp + '.json')).write_text(json.dumps(receipt, indent=2) + '\n')
print(json.dumps(receipt, indent=2), flush=True)
