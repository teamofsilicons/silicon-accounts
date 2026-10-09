// mock-silicon-apps: the stand-in Silicon Apps API every local stack's developer site publishes through.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { DEFAULT_REFUSAL, start, type MockSiliconApps } from '../src/mock-silicon-apps.ts';

/** An unsigned JWT-shaped token with these claims (the stand-in only reads them). */
const token = (claims: Record<string, unknown>) => `eyJhbGciOiJFZERTQSJ9.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;
const bearer = { authorization: `Bearer ${token({ aud: 'developer', sub: 'uuid-1' })}` };

describe('mock-silicon-apps', () => {
  let apps: MockSiliconApps;
  before(async () => {
    apps = await start({ port: 0 });
  });
  after(async () => {
    await apps.stop();
  });

  test('lists no apps and no invitations for a signed-in account, and knows no app', async () => {
    const mine = await fetch(`${apps.url}/v1/apps?mine=true&limit=100`, { headers: bearer });
    assert.equal(mine.status, 200);
    assert.deepEqual(await mine.json(), { items: [], limit: 100, next_offset: null, offset: 0, sort: 'relevance', total: 0 });
    assert.deepEqual(await (await fetch(`${apps.url}/v1/invites`, { headers: bearer })).json(), { items: [] });
    const one = await fetch(`${apps.url}/v1/apps/briefcase`, { headers: bearer });
    assert.equal(one.status, 404);
    assert.equal(((await one.json()) as { error: { code: string } }).error.code, 'not_found');
    const created = await fetch(`${apps.url}/v1/apps`, { method: 'POST', headers: { ...bearer, 'content-type': 'application/json' }, body: '{"app_id":"x"}' });
    assert.equal(created.status, 503);
    assert.match(((await created.json()) as { error: { hint: string } }).error.hint, /--apps=on/);
    assert.equal((await fetch(`${apps.url}/v1/apps/availability/my-app`, { headers: bearer })).status, 503);
  });

  test('needs a bearer token like the real authoring routes', async () => {
    const anonymous = await fetch(`${apps.url}/v1/apps?mine=true`);
    assert.equal(anonymous.status, 401);
    assert.equal(((await anonymous.json()) as { error: { code: string } }).error.code, 'authentication_required');
  });

  test('refuses every token when told to, as an Apps API that trusts another Silicon Accounts, and answers again after', async () => {
    const refused = await fetch(`${apps.url}/_refuse`, { method: 'PUT' });
    assert.equal(refused.status, 200);
    assert.equal(((await (await fetch(`${apps.url}/_health`)).json()) as { refusing: boolean }).refusing, true);
    const answer = await fetch(`${apps.url}/v1/apps?mine=true`, { headers: bearer });
    assert.equal(answer.status, 401);
    assert.deepEqual(((await answer.json()) as { error: { code: string; message: string } }).error.code, DEFAULT_REFUSAL.code);
    await fetch(`${apps.url}/_refuse`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'accounts_error', message: 'Silicon Accounts: down' }) });
    const custom = (await (await fetch(`${apps.url}/v1/invites`, { headers: bearer })).json()) as { error: { code: string; message: string } };
    assert.deepEqual([custom.error.code, custom.error.message], ['accounts_error', 'Silicon Accounts: down']);
    assert.equal((await fetch(`${apps.url}/_refuse`, { method: 'DELETE' })).status, 204);
    assert.equal((await fetch(`${apps.url}/v1/apps?mine=true`, { headers: bearer })).status, 200);
  });

  test('records what it was asked, with the token\'s audience', async () => {
    apps.reset();
    await fetch(`${apps.url}/v1/apps?mine=true&limit=5`, { headers: bearer });
    const log = (await (await fetch(`${apps.url}/_requests`)).json()) as { count: number; items: Array<{ method: string; path: string; aud: unknown; sub: unknown }> };
    assert.equal(log.count, 1);
    assert.deepEqual([log.items[0]?.method, log.items[0]?.path, log.items[0]?.aud, log.items[0]?.sub], ['GET', '/v1/apps?mine=true&limit=5', 'developer', 'uuid-1']);
    assert.equal((await fetch(`${apps.url}/_requests`, { method: 'DELETE' })).status, 204);
    assert.equal(apps.requests().length, 0);
  });
});
