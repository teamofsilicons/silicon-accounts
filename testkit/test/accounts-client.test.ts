// AccountsClient options: X-Forwarded-For per client (so each e2e scenario gets its own
// per-network limits when accounts-api trusts the header) and extra headers on every request.

import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { AccountsClient, randomPrivateIp } from '../lib/accounts.ts';

describe('AccountsClient headers', () => {
  let server: Server;
  let url = '';
  const seen: IncomingHttpHeaders[] = [];

  before(async () => {
    server = createServer((req, res) => {
      seen.push(req.headers);
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/v1/meta') {
        res.end(JSON.stringify({ name: 'Silicon Accounts', version: '0', environment: 'test', public_url: url, silicon_apps_url: url, providers: { google: false, apple: false }, delivery: 'local' }));
      } else {
        res.end('{}');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test('randomPrivateIp gives addresses in 10.0.0.0/8', () => {
    for (let i = 0; i < 50; i++) {
      const ip = randomPrivateIp();
      const parts = ip.split('.').map(Number);
      assert.equal(parts.length, 4, ip);
      assert.equal(parts[0], 10, ip);
      assert.ok(parts.every((p) => Number.isInteger(p) && p >= 0 && p <= 255), ip);
      assert.ok((parts[3] ?? 0) >= 1, ip);
    }
  });

  test("forwardedFor 'random' sends one stable address on every request of the client, its browsers and sessions", async () => {
    seen.length = 0;
    const client = new AccountsClient(url, { forwardedFor: 'random', headers: { 'X-Test': 'yes' } });
    await client.meta();
    const browser = await client.browser();
    await browser.request('POST', '/v1/flows', { json: {} });
    await client.withToken('t').request('GET', '/v1/me');
    await client.app('briefcase').request('GET', '/v1/apps/briefcase');
    const forwarded = seen.map((h) => h['x-forwarded-for']);
    assert.equal(forwarded.length, 4);
    assert.match(String(forwarded[0]), /^10\.\d+\.\d+\.\d+$/);
    assert.ok(forwarded.every((f) => f === forwarded[0]), JSON.stringify(forwarded));
    assert.ok(seen.every((h) => h['x-test'] === 'yes'));
    assert.equal(seen[2]?.authorization, 'Bearer t');
    assert.match(String(seen[3]?.authorization), /^Basic /);
    // Another client gets its own address (two random /8 picks colliding is ~1e-7).
    seen.length = 0;
    await new AccountsClient(url, { forwardedFor: 'random' }).meta();
    assert.notEqual(seen[0]?.['x-forwarded-for'], forwarded[0]);
  });

  test('a fixed forwardedFor, TESTKIT_FORWARDED_FOR, and null', async () => {
    seen.length = 0;
    await new AccountsClient(url, { forwardedFor: '203.0.113.7' }).meta();
    assert.equal(seen[0]?.['x-forwarded-for'], '203.0.113.7');
    const previous = process.env.TESTKIT_FORWARDED_FOR;
    process.env.TESTKIT_FORWARDED_FOR = '198.51.100.9';
    try {
      seen.length = 0;
      await new AccountsClient(url).meta();
      assert.equal(seen[0]?.['x-forwarded-for'], '198.51.100.9');
      seen.length = 0;
      await new AccountsClient(url, { forwardedFor: null }).meta();
      assert.equal(seen[0]?.['x-forwarded-for'], undefined);
    } finally {
      if (previous === undefined) delete process.env.TESTKIT_FORWARDED_FOR;
      else process.env.TESTKIT_FORWARDED_FOR = previous;
    }
  });
});
