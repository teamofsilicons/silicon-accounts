// mock-iris: the default profile photos every local stack shows instead of the real Iris.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { irisSvg, start, type MockIris } from '../src/mock-iris.ts';

describe('mock-iris', () => {
  let iris: MockIris;
  before(async () => {
    iris = await start({ port: 0 });
  });
  after(async () => {
    await iris.stop();
  });

  test('draws the same SVG for the same account, and different ones for Carbons, Silicons and other ids', async () => {
    const carbon = await fetch(`${iris.url}/pfp/carbon?id=a8K`);
    assert.equal(carbon.status, 200);
    assert.match(carbon.headers.get('content-type') ?? '', /^image\/svg\+xml/);
    assert.equal(carbon.headers.get('access-control-allow-origin'), '*');
    assert.equal(carbon.headers.get('cross-origin-resource-policy'), 'cross-origin');
    const svg = await carbon.text();
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    assert.equal(svg, irisSvg('carbon', 'a8K'));
    assert.equal(await (await fetch(`${iris.url}/pfp/carbon?id=a8K`)).text(), svg, 'deterministic');
    const silicon = await (await fetch(`${iris.url}/pfp/silicon?id=a8K`)).text();
    assert.notEqual(silicon, svg);
    assert.notEqual(await (await fetch(`${iris.url}/pfp/carbon?id=Zz9`)).text(), svg);
    // The sign-up page's preview asks for id=new.
    assert.equal((await fetch(`${iris.url}/pfp/carbon?id=new`)).status, 200);
  });

  test('records what it drew, and answers unknown paths with a 404', async () => {
    iris.reset();
    await fetch(`${iris.url}/pfp/silicon?id=Q1x`, { headers: { referer: 'http://localhost:9600/silicons' } });
    const log = (await (await fetch(`${iris.url}/_requests?kind=silicon`)).json()) as { count: number; items: Array<{ kind: string; id: string; referer: string | null }> };
    assert.equal(log.count, 1);
    assert.deepEqual([log.items[0]?.kind, log.items[0]?.id, log.items[0]?.referer], ['silicon', 'Q1x', 'http://localhost:9600/silicons']);
    assert.equal((await fetch(`${iris.url}/pfp/robot?id=x`)).status, 404);
    assert.equal(((await (await fetch(`${iris.url}/_health`)).json()) as { ok: boolean }).ok, true);
  });
});
