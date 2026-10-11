"""Exercise immutable release preparation without AWS/systemd side effects."""
import ast
import contextlib
import hashlib
import io
import os
from pathlib import Path
import tarfile
import tempfile
import unittest

# install.py remains an executable operator script. Load just its pure helper.
source = ast.parse(Path(__file__).with_name('install.py').read_text())
wanted = [node for node in source.body
          if (isinstance(node, ast.FunctionDef) and node.name in ('prepare_release', 'api_environment'))
          or (isinstance(node, ast.Assign) and any(getattr(t, 'id', None) == 'RETIRED' for t in node.targets))]
namespace = {'hashlib': hashlib, 'os': os, 'tarfile': tarfile}
exec(compile(ast.Module(body=wanted, type_ignores=[]), 'install.py', 'exec'), namespace)
prepare_release = namespace['prepare_release']
api_environment = namespace['api_environment']


class ReleaseTests(unittest.TestCase):
    def test_reapply_preserves_existing_executable_and_links_and_rejects_tampering(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / 'release.tar.gz'
            release = root / 'release'
            with tarfile.open(archive, 'w:gz') as bundle:
                member = tarfile.TarInfo('bin/server')
                member.size = 7
                bundle.addfile(member, io.BytesIO(b'payload'))
                member = tarfile.TarInfo('bin/alias')
                member.type = tarfile.SYMTYPE
                member.linkname = 'server'
                bundle.addfile(member)
            prepare_release(archive, release)
            executable = release / 'bin/server'
            inode = executable.stat().st_ino
            prepare_release(archive, release)
            self.assertEqual(executable.stat().st_ino, inode)
            self.assertEqual(executable.read_bytes(), b'payload')
            self.assertEqual(os.readlink(release / 'bin/alias'), 'server')
            executable.write_bytes(b'changed')
            with self.assertRaisesRegex(ValueError, 'differs'):
                prepare_release(archive, release)
            self.assertEqual(executable.read_bytes(), b'changed')


class EnvironmentTests(unittest.TestCase):
    def test_retired_telemetry_keys_never_reach_the_api_environment(self):
        secret = {
            'ACCOUNTS_PUBLIC_URL': 'https://accounts.example',
            'ACCOUNTS_TELEMETRY_ENABLED': 'true',
            'ACCOUNTS_TELEMETRY_TABLE_KEY': 'old-key',
            'DEVELOPER_SESSION_SECRET': 'developer-only',
        }
        with contextlib.redirect_stdout(io.StringIO()) as printed:
            api = api_environment(secret)
        self.assertEqual(api, {'ACCOUNTS_PUBLIC_URL': 'https://accounts.example'})
        self.assertIn('ACCOUNTS_TELEMETRY_TABLE_KEY', printed.getvalue())
        self.assertNotIn('old-key', printed.getvalue())


if __name__ == '__main__':
    unittest.main()
