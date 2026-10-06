// The CLI entry (`pnpm -C testkit start`): starts all three servers, prints a ready line,
// and stops cleanly on SIGTERM/SIGINT.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const testkitRoot = fileURLToPath(new URL('..', import.meta.url));

async function startCli(): Promise<{ child: ReturnType<typeof spawn>; urls: Record<string, string> }> {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/start.ts', '--oidc-port', '0', '--messaging-port', '0', '--fake-apps-port', '0', '--accounts-url', 'http://127.0.0.1:9', '--quiet'], {
    cwd: testkitRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  const urls = await new Promise<Record<string, string>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ready line within 15 s: ${out}`)), 15_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      const match = /testkit ready (\{.*\})/.exec(out);
      if (match?.[1]) {
        clearTimeout(timer);
        resolve(JSON.parse(match[1]) as Record<string, string>);
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.on('exit', (code) => reject(new Error(`exited early with ${code}: ${out}`)));
  });
  return { child, urls };
}

describe('pnpm start', () => {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    test(`starts the three servers and stops cleanly on ${signal}`, async () => {
      const { child, urls } = await startCli();
      for (const key of ['oidc', 'messaging', 'fake_apps']) {
        const res = await fetch(`${urls[key]}/_health`);
        assert.equal(res.status, 200, key);
        assert.equal(((await res.json()) as { ok: boolean }).ok, true);
      }
      child.kill(signal);
      const [code] = (await once(child, 'exit')) as [number | null];
      assert.equal(code, 0);
      await assert.rejects(fetch(`${urls.oidc}/_health`));
    });
  }

  test('a port that is already taken is a precise error', async () => {
    const { child, urls } = await startCli();
    try {
      const port = new URL(urls.oidc ?? '').port;
      const second = spawn(process.execPath, ['--import', 'tsx', 'src/start.ts', '--oidc-port', port, '--messaging-port', '0', '--fake-apps-port', '0', '--quiet'], { cwd: testkitRoot, stdio: ['ignore', 'pipe', 'pipe'] });
      let err = '';
      second.stderr?.on('data', (chunk: Buffer) => {
        err += chunk.toString();
      });
      const [code] = (await once(second, 'exit')) as [number | null];
      assert.equal(code, 1);
      assert.match(err, /already in use/);
    } finally {
      child.kill('SIGTERM');
      await once(child, 'exit');
    }
  });
});
