#!/usr/bin/env python3
"""Verify real public, latest-version installations in a fresh CI home."""
import json
import os
import pathlib
import platform
import subprocess
import urllib.request

results = []


def run(app, *args):
    command = pathlib.Path(os.environ['SILICON_HOME']) / '.apps/bin' / (app + ('.cmd' if os.name == 'nt' else ''))
    completed = subprocess.run([str(command), *args], text=True, capture_output=True, timeout=60)
    results.append({'command': [app, *args], 'exit_code': completed.returncode, 'stdout': completed.stdout, 'stderr': completed.stderr})
    assert completed.returncode == 0, results[-1]
    return completed.stdout


versions = {}
for app in ['silicon-apps', 'silicon-accounts']:
    request = urllib.request.Request(f'https://api.github.com/repos/teamofsilicons/{app}/releases/latest', headers={'User-Agent': 'Silicon-managed-install-verification'})
    with urllib.request.urlopen(request) as response:
        versions[app] = json.load(response)['tag_name'].removeprefix('v')
    assert run(app, '--version').strip() == f'{app} {versions[app]}'
    assert run(app, '--help').strip()
    assert json.loads(run(app, 'accounts', '--json'))['app_id'] == app
    assert json.loads(run(app, 'login', 'status', '--json'))['authenticated'] is False

installed = json.loads(run('silicon-apps', 'installed', '--json'))['items']
assert {item['app_id'] for item in installed} == set(versions)
for item in installed:
    assert item['version'] == versions[item['app_id']]
    assert item['channel'] == 'production'
    assert item['server'] == 'https://apps.teamofsilicons.com'
    assert 'allow_install_script' not in item
accounts = next(item for item in installed if item['app_id'] == 'silicon-accounts')
assert not accounts['package_id'].startswith('bootstrap:')
assert not accounts['release_id'].startswith('bootstrap:')
report = {'platform': platform.platform(), 'versions': versions, 'installed': installed, 'command_results': results}
pathlib.Path('managed-install-verification.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'platform': report['platform'], 'versions': versions, 'verified_commands': len(results)}))
