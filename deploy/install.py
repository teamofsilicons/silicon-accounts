#!/usr/bin/env python3
"""Install a checksummed Accounts release on its dedicated AL2023 host (root via SSM)."""
import argparse, hashlib, json, os, pathlib, pwd, re, shutil, subprocess, tarfile, time, urllib.request, urllib.parse
P=pathlib.Path

def run(*cmd, **kw):
    return subprocess.run(cmd, check=True, **kw)

def write(path, data, mode=0o644):
    path=P(path);path.parent.mkdir(parents=True,exist_ok=True);path.write_text(data);path.chmod(mode)

def env(path, values):
    # systemd EnvironmentFile double-quoted escaping (including literal PEM backslashes).
    def quote(v):
        assert '\n' not in v and '\r' not in v and '\0' not in v
        return '"'+v.replace('\\','\\\\').replace('"','\\"')+'"'
    write(path,''.join(k+'='+quote(str(v))+'\n' for k,v in values.items()),0o600)

def healthy(url):
    for _ in range(45):
        try:
            with urllib.request.urlopen(url,timeout=3) as r:
                if r.status==200:return
        except Exception:pass
        time.sleep(2)
    raise RuntimeError('Readiness failed: '+url)

def prepare_release(archive, release):
    # A configuration-only reapply must never rewrite a running executable.
    # Verify every bundled file/link before reusing the immutable release.
    existing=release.exists() and any(release.iterdir())
    with tarfile.open(archive) as bundle:
        if existing:
            for member in bundle.getmembers():
                destination=release/member.name
                if member.isdir():
                    valid=destination.is_dir() and not destination.is_symlink()
                elif member.issym():
                    valid=destination.is_symlink() and os.readlink(destination)==member.linkname
                elif member.isfile():
                    valid=destination.is_file() and not destination.is_symlink()
                    if valid:
                        with bundle.extractfile(member) as source, destination.open('rb') as target:
                            def digest(stream):
                                h=hashlib.sha256()
                                for block in iter(lambda:stream.read(1024*1024),b''):h.update(block)
                                return h.digest()
                            valid=digest(source)==digest(target)
                else:
                    valid=False
                if not valid:raise ValueError('Existing release differs from verified archive: '+member.name)
        else:
            release.mkdir(parents=True,exist_ok=True)
            bundle.extractall(release,filter='data')

a=argparse.ArgumentParser();a.add_argument('--archive',required=True);a.add_argument('--sha256',required=True);a.add_argument('--revision',required=True);a.add_argument('--secret',required=True);a.add_argument('--bucket',required=True);a.add_argument('--region',default='us-east-2');a=a.parse_args()
assert os.geteuid()==0
os.umask(0o077)
assert hashlib.sha256(P(a.archive).read_bytes()).hexdigest()==a.sha256
run('cloud-init','status','--wait')
release=P('/opt/accounts/releases')/a.revision
prepare_release(a.archive,release)
run('chmod','-R','a+rX',str(release))
run('chmod','755','/opt/accounts','/opt/accounts/releases')
for user in ['accounts','accounts-web','accounts-developer','accounts-caddy']:
    try:pwd.getpwnam(user)
    except KeyError:run('useradd','--system','--home-dir','/var/lib/'+user,'--create-home','--shell','/sbin/nologin',user)
# Secret retrieval output stays private; never place credentials in SSM command text or logs.
s=json.loads(json.loads(subprocess.check_output(['aws','secretsmanager','get-secret-value','--region',a.region,'--secret-id',a.secret]))['SecretString'])
developer_url=urllib.parse.urlsplit(s['DEVELOPER_PUBLIC_URL'])
assert developer_url.scheme=='https' and developer_url.path in ('','/') and not developer_url.query and not developer_url.fragment
assert developer_url.hostname and re.fullmatch(r'[a-z0-9.-]+',developer_url.hostname)
assert s['ACCOUNTS_DEVELOPER_URL'].rstrip('/')==s['DEVELOPER_PUBLIC_URL'].rstrip('/')
run('install','-d','-m','700','/etc/accounts')
api={k:v for k,v in s.items() if k.startswith('ACCOUNTS_')}
env('/etc/accounts/api.env',api)
common={k:s[k] for k in ['ACCOUNTS_API_URL','ACCOUNTS_PUBLIC_URL','ACCOUNTS_DEVELOPER_URL']}
common.update(NODE_ENV='production',NEXT_TELEMETRY_DISABLED='1',HOSTNAME='127.0.0.1')
env('/etc/accounts/web.env',dict(common,PORT='8590'))
env('/etc/accounts/developer.env',dict(common,PORT='8600',DEVELOPER_PUBLIC_URL=s['DEVELOPER_PUBLIC_URL'],DEVELOPER_SESSION_SECRET=s['DEVELOPER_SESSION_SECRET'],APPS_API_URL=s.get('APPS_API_URL','https://apps.teamofsilicons.com')))
if not P('/var/lib/pgsql/data/PG_VERSION').exists():run('postgresql-setup','--initdb')
hba=P('/var/lib/pgsql/data/pg_hba.conf')
hba.write_text('local all all peer\nhost all all 127.0.0.1/32 scram-sha-256\nhost all all ::1/128 scram-sha-256\n');hba.chmod(0o600)
run('systemctl','enable','--now','postgresql');run('systemctl','reload','postgresql')
def sql(query):
    return run('runuser','-u','postgres','--','psql','-v','ON_ERROR_STOP=1','-At',input=query,text=True,capture_output=True).stdout.strip()
password=urllib.parse.urlparse(s['ACCOUNTS_DATABASE_URL']).password
if sql("SELECT 1 FROM pg_roles WHERE rolname='accounts'")!='1':sql("CREATE ROLE accounts LOGIN PASSWORD '"+password+"'")
if sql("SELECT 1 FROM pg_database WHERE datname='silicon_accounts'")!='1':run('runuser','-u','postgres','--','createdb','-O','accounts','silicon_accounts')
# A pre-migration copy is retained outside the release directory.
backup=P('/var/lib/accounts/backups');backup.mkdir(parents=True,exist_ok=True);backup.chmod(0o700)
stamp=time.strftime('%Y%m%dT%H%M%SZ',time.gmtime())
with (backup/(stamp+'.dump')).open('wb') as f:run('runuser','-u','postgres','--','pg_dump','-Fc','silicon_accounts',stdout=f)
run('aws','s3','cp',str(backup/(stamp+'.dump')),'s3://'+a.bucket+'/backups/predeploy-'+stamp+'.dump','--only-show-errors')
run(str(release/'bin/accounts-migrate'),env=dict(os.environ,**api))
previous=P('/opt/accounts/current')
if previous.is_symlink():write('/opt/accounts/previous-release',str(previous.resolve())+'\n',0o600)
P('/opt/accounts/current.next').unlink(missing_ok=True);P('/opt/accounts/current.next').symlink_to(release);os.replace('/opt/accounts/current.next',previous)
for name,user,command in [('api','accounts','/opt/accounts/current/bin/accounts-api'),('web','accounts-web','/opt/accounts/current/node/bin/node /opt/accounts/current/web/server.js'),('developer','accounts-developer','/opt/accounts/current/node/bin/node /opt/accounts/current/developer/server.js')]:
    write('/etc/systemd/system/accounts-'+name+'.service',f'''[Unit]
Description=Silicon Accounts {name}
After=network-online.target postgresql.service
Wants=network-online.target
[Service]
User={user}
Group={user}
WorkingDirectory=/opt/accounts/current
EnvironmentFile=/etc/accounts/{name}.env
ExecStart={command}
Restart=on-failure
RestartSec=3
TimeoutStopSec=45
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
UMask=0077
[Install]
WantedBy=multi-user.target
''')
write('/etc/accounts/Caddyfile','''{
    email lords@teamofsilicons.com
}
accounts.teamofsilicons.com {
    @readiness path /readyz /healthz
    handle @readiness {
        reverse_proxy 127.0.0.1:8589
    }
    handle {
        reverse_proxy 127.0.0.1:8590 {
            header_up X-Forwarded-For {remote_host}
        }
    }
}
__DEVELOPER_HOST__ {
    reverse_proxy 127.0.0.1:8600
}
'''.replace('__DEVELOPER_HOST__',developer_url.hostname) + ('''
developer.accounts.teamofsilicons.com {
    redir https://developers.teamofsilicons.com{uri} permanent
}
''' if developer_url.hostname == 'developers.teamofsilicons.com' else ''))
# Give Caddy access only to its non-secret configuration, not the API's env files.
run('install','-d','-m','755','/etc/accounts-caddy')
shutil.copyfile('/etc/accounts/Caddyfile','/etc/accounts-caddy/Caddyfile');P('/etc/accounts-caddy/Caddyfile').chmod(0o644)
write('/etc/systemd/system/accounts-caddy.service','''[Unit]
Description=Silicon Accounts HTTPS
After=network-online.target
Wants=network-online.target
[Service]
User=accounts-caddy
Group=accounts-caddy
Environment=HOME=/var/lib/accounts-caddy
ExecStart=/opt/accounts/current/bin/caddy run --config /etc/accounts-caddy/Caddyfile --adapter caddyfile
ExecReload=/opt/accounts/current/bin/caddy reload --config /etc/accounts-caddy/Caddyfile --adapter caddyfile
Restart=on-failure
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/var/lib/accounts-caddy
[Install]
WantedBy=multi-user.target
''')
write('/usr/local/sbin/accounts-backup',f'''#!/bin/bash
set -euo pipefail
umask 077
stamp=$(date -u +%Y%m%dT%H%M%SZ)
file=/var/lib/accounts/backups/$stamp.dump
runuser -u postgres -- pg_dump -Fc silicon_accounts > "$file"
aws s3 cp "$file" s3://{a.bucket}/backups/$stamp.dump --only-show-errors
find /var/lib/accounts/backups -name '*.dump' -mtime +3 -delete
''',0o700)
write('/etc/systemd/system/accounts-backup.service','[Unit]\nDescription=Accounts PostgreSQL backup\n[Service]\nType=oneshot\nExecStart=/usr/local/sbin/accounts-backup\n')
write('/etc/systemd/system/accounts-backup.timer','[Unit]\nDescription=Hourly Accounts backup\n[Timer]\nOnCalendar=hourly\nPersistent=true\nRandomizedDelaySec=300\n[Install]\nWantedBy=timers.target\n')
run('systemctl','daemon-reload')
for name in ['api','web','developer']:
    run('systemctl','enable','accounts-'+name);run('systemctl','restart','accounts-'+name)
healthy('http://127.0.0.1:8589/readyz');healthy('http://127.0.0.1:8590/v1/meta');healthy('http://127.0.0.1:8600/auth/session')
run(str(release/'bin/caddy'),'validate','--config','/etc/accounts-caddy/Caddyfile','--adapter','caddyfile')
run('systemctl','enable','--now','accounts-caddy','accounts-backup.timer')
run('systemctl','restart','accounts-caddy')
print('Accounts installed; local API, site and developer readiness passed.')
