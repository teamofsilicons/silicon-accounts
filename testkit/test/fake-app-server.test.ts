import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { FakeAppsClient } from '../lib/mocks.ts';
import { codeChallengeS256 } from '../lib/pkce.ts';
import { signWebhookDelivery, webhookSignatureHeader } from '../lib/signature.ts';
import { start, type FakeAppServer } from '../src/fake-app-server.ts';
import { loadFakeApps } from '../src/fake-apps/load.ts';
import { attr, basic, cookieFrom, preJson } from './helpers.ts';
import { startStubAccounts, type StubAccount, type StubAccounts } from './stub-accounts.ts';

const apps = loadFakeApps();
const app = (id: string) => apps.find((a) => a.app_id === id)!;

describe('fake-app-server', () => {
  let stub: StubAccounts;
  let server: FakeAppServer;
  let client: FakeAppsClient;
  let ada: StubAccount;

  before(async () => {
    stub = await startStubAccounts({ apps });
    server = await start({ port: 0, accountsUrl: stub.url, apps });
    client = new FakeAppsClient(server.url);
    ada = stub.createAccount({ id: 'c:ada', display_name: 'Ada', email: 'ada@example.test', timezone: 'Europe/London' });
  });
  after(async () => {
    await server.stop();
    await stub.stop();
  });
  beforeEach(() => server.reset());

  async function openPage(appId: string, query = '', cookie?: string): Promise<{ html: string; cookie: string }> {
    const res = await fetch(`${server.url}/${appId}/${query}`, cookie ? { headers: { Cookie: cookie } } : {});
    assert.equal(res.status, 200);
    return { html: await res.text(), cookie: cookieFrom(res) || (cookie ?? '') };
  }

  test('the app page offers the hosted link, the iframe and the SDK snippet, each with its own state + PKCE', async () => {
    const { html, cookie } = await openPage('briefcase');
    assert.match(cookie, /^fakeapp_sid=/);
    const hosted = new URL(attr(html, /<a id="signin-hosted"[^>]*>/, 'href') ?? '');
    assert.equal(`${hosted.origin}${hosted.pathname}`, `${stub.url}/authorize`);
    assert.equal(hosted.searchParams.get('app_id'), 'briefcase');
    assert.equal(hosted.searchParams.get('redirect_uri'), `${server.url}/briefcase/callback`);
    assert.equal(hosted.searchParams.get('code_challenge_method'), 'S256');
    assert.match(hosted.searchParams.get('code_challenge') ?? '', /^[A-Za-z0-9_-]{43}$/);
    assert.ok(hosted.searchParams.get('state'));
    assert.ok(hosted.searchParams.get('nonce'));
    const iframe = new URL(attr(html, /<iframe id="signin-iframe"[^>]*>/, 'src') ?? '');
    assert.equal(iframe.pathname, '/embed/v1/buttons');
    assert.notEqual(iframe.searchParams.get('state'), hosted.searchParams.get('state'));
    assert.equal(attr(html, /<script src="[^"]*\/sdk\/v1\.js"[^>]*>/, 'data-app-id'), 'briefcase');
    assert.equal(attr(html, /<script src="[^"]*\/sdk\/v1\.js"[^>]*>/, 'data-target'), '#silicon-accounts');
    assert.ok(attr(html, /<script src="[^"]*\/sdk\/v1\.js"[^>]*>/, 'data-state'));
    // interface's sign-in links carry prompt=select_account by default.
    const iface = await openPage('interface', '?only=hosted');
    assert.equal(new URL(attr(iface.html, /<a id="signin-hosted"[^>]*>/, 'href') ?? '').searchParams.get('prompt'), 'select_account');
    assert.doesNotMatch(iface.html, /signin-iframe/);
  });

  test('callback: checks state, exchanges the code with client_secret_basic + PKCE and shows the account', async () => {
    const { html, cookie } = await openPage('briefcase');
    const hosted = new URL(attr(html, /<a id="signin-hosted"[^>]*>/, 'href') ?? '');
    const code = stub.issueCode({
      app_id: 'briefcase',
      redirect_uri: hosted.searchParams.get('redirect_uri') ?? '',
      code_challenge: hosted.searchParams.get('code_challenge'),
      code_challenge_method: 'S256',
      scopes: ['profile', 'email'],
      account: ada,
    });
    const res = await fetch(`${server.url}/briefcase/callback?code=${encodeURIComponent(code)}&state=${hosted.searchParams.get('state')}`, { headers: { Cookie: cookie } });
    const page = await res.text();
    assert.equal(res.status, 200, page);
    assert.match(page, /Signed in as <strong>c:ada<\/strong>/);
    const account = preJson(page, 'account') as Record<string, unknown>;
    assert.equal(account.uuid, ada.uuid);
    assert.equal(account.membership_id, `briefcase:${ada.uuid}`);
    assert.equal(account.email, 'ada@example.test');
    const exchange = stub.tokenRequests.at(-1)!;
    assert.equal(exchange.grant_type, 'authorization_code');
    assert.equal(exchange.client_id, 'briefcase');
    assert.equal(codeChallengeS256(exchange.form.code_verifier ?? ''), hosted.searchParams.get('code_challenge'));
    // The same browser now sees the signed-in panel on the app page; the state was single-use.
    assert.match((await openPage('briefcase', '', cookie)).html, /<p id="signed-in-as">Signed in as <strong>c:ada<\/strong>/);
    assert.doesNotMatch((await openPage('briefcase')).html, /id="signed-in-as"/);
    const again = await fetch(`${server.url}/briefcase/callback?state=${hosted.searchParams.get('state')}`, { headers: { Cookie: cookie } });
    assert.equal(again.status, 400);
    assert.match(await again.text(), /unknown_state/);
    const state = await client.state('briefcase');
    assert.equal(state.accounts.length, 1);
    assert.equal((state.accounts[0] as Record<string, unknown>).via, 'hosted');
  });

  test('callback refuses a state issued to another browser (login CSRF) and reports Accounts errors', async () => {
    const { html } = await openPage('briefcase');
    const state = new URL(attr(html, /<a id="signin-hosted"[^>]*>/, 'href') ?? '').searchParams.get('state') ?? '';
    const other = await openPage('briefcase');
    const mismatch = await fetch(`${server.url}/briefcase/callback?code=x&state=${state}`, { headers: { Cookie: other.cookie } });
    assert.equal(mismatch.status, 400);
    assert.match(await mismatch.text(), /state_session_mismatch/);

    const fresh = await openPage('briefcase', '?only=hosted');
    const freshState = new URL(attr(fresh.html, /<a id="signin-hosted"[^>]*>/, 'href') ?? '').searchParams.get('state');
    const denied = await fetch(`${server.url}/briefcase/callback?error=access_denied&state=${freshState}`, { headers: { Cookie: fresh.cookie } });
    assert.equal(denied.status, 400);
    const deniedPage = await denied.text();
    assert.equal((preJson(deniedPage, 'error') as Record<string, unknown>).code, 'access_denied');

    const badCode = await openPage('briefcase', '?only=hosted');
    const badState = new URL(attr(badCode.html, /<a id="signin-hosted"[^>]*>/, 'href') ?? '').searchParams.get('state');
    const failed = await fetch(`${server.url}/briefcase/callback?code=sac_unknown&state=${badState}`, { headers: { Cookie: badCode.cookie } });
    assert.equal(failed.status, 400);
    const error = preJson(await failed.text(), 'error') as Record<string, unknown>;
    assert.equal(error.code, 'invalid_grant');
    assert.equal(error.stage, 'token_exchange');
  });

  test('tamper=verifier makes the exchange fail like a PKCE mismatch would', async () => {
    const { html, cookie } = await openPage('briefcase', '?only=hosted&tamper=verifier');
    const hosted = new URL(attr(html, /<a id="signin-hosted"[^>]*>/, 'href') ?? '');
    const code = stub.issueCode({ app_id: 'briefcase', redirect_uri: hosted.searchParams.get('redirect_uri') ?? '', code_challenge: hosted.searchParams.get('code_challenge'), code_challenge_method: 'S256', account: ada });
    const res = await fetch(`${server.url}/briefcase/callback?code=${code}&state=${hosted.searchParams.get('state')}`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 400);
    assert.match(String((preJson(await res.text(), 'error') as Record<string, unknown>).message), /code_verifier/);
  });

  test('OIDC (quill-docs): the id_token is verified against the Accounts JWKS, including the nonce', async () => {
    const started = await fetch(`${server.url}/quill-docs/authorize-url`);
    const params = (await started.json()) as { authorize_url: string; state: string; nonce: string; code_verifier: string };
    const cookie = cookieFrom(started);
    const authorize = new URL(params.authorize_url);
    assert.equal(authorize.searchParams.get('scope'), 'openid email');
    const code = stub.issueCode({ app_id: 'quill-docs', redirect_uri: authorize.searchParams.get('redirect_uri') ?? '', code_challenge: authorize.searchParams.get('code_challenge'), code_challenge_method: 'S256', nonce: params.nonce, scopes: ['profile', 'openid', 'email'], account: ada });
    const res = await fetch(`${server.url}/quill-docs/callback?code=${code}&state=${params.state}&format=json`, { headers: { Cookie: cookie } });
    const body = (await res.json()) as Record<string, unknown> & { id_token: { verified: boolean; claims: Record<string, unknown>; error: string | null } };
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.id_token.verified, true, String(body.id_token.error));
    assert.equal(body.id_token.claims.nonce, params.nonce);

    const second = await fetch(`${server.url}/quill-docs/authorize-url`);
    const p2 = (await second.json()) as { authorize_url: string; state: string };
    const a2 = new URL(p2.authorize_url);
    const wrongNonce = stub.issueCode({ app_id: 'quill-docs', redirect_uri: a2.searchParams.get('redirect_uri') ?? '', code_challenge: a2.searchParams.get('code_challenge'), code_challenge_method: 'S256', nonce: 'not-the-nonce', scopes: ['profile', 'openid'], account: ada });
    const res2 = await fetch(`${server.url}/quill-docs/callback?code=${wrongNonce}&state=${p2.state}&format=json`, { headers: { Cookie: cookieFrom(second) } });
    const body2 = (await res2.json()) as { id_token: { verified: boolean; error: string } };
    assert.equal(body2.id_token.verified, false);
    assert.match(body2.id_token.error, /nonce mismatch/);
  });

  test('an unknown state with a code gets the client-side (SDK) completion page', async () => {
    const res = await fetch(`${server.url}/quill-docs/callback?code=x&state=sdk-generated`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /id="fake-app-callback-client"/);
    assert.match(html, /sessionStorage/);
    const finish = await fetch(`${server.url}/quill-docs/callback/client`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieFrom(res) }, body: JSON.stringify({ code: 'x', state: 'sdk-generated', found: false }) });
    assert.equal(finish.status, 400);
    assert.equal(((await finish.json()) as { error: { code: string } }).error.code, 'unknown_state');
  });

  test('SLT login (Silicons) exchanges the short-lived token; a used SLT is refused', async () => {
    const scout = stub.createAccount({ id: 'si:scout', kind: 'silicon', display_name: 'Scout' });
    const slt = stub.issueSlt('remind', scout);
    const ok = await client.sltLogin('remind', slt);
    assert.equal(ok.ok, true);
    assert.equal(ok.kind, 'silicon');
    assert.equal(ok.membership_id, `remind:${scout.uuid}`);
    assert.equal(stub.tokenRequests.at(-1)?.grant_type, 'urn:silicon:params:oauth:grant-type:slt');
    const reused = await client.sltLogin('remind', slt);
    assert.equal(reused.ok, false);
    assert.equal(reused.status, 400);
  });

  describe('webhooks', () => {
    const briefcase = app('briefcase');
    const event = (id: string, type = 'account.id_changed', appId = 'briefcase') => ({
      event_id: id,
      type,
      occurred_at: new Date().toISOString(),
      app_id: appId,
      silicon: null,
      data: { uuid: 'a8K', membership_id: `${appId}:a8K`, kind: 'carbon', old_id: 'c:old', new_id: 'c:new' },
    });
    async function deliver(delivery: { headers: Record<string, string>; body: string }, appId = 'briefcase'): Promise<number> {
      return (await fetch(`${server.url}/${appId}/webhooks`, { method: 'POST', headers: delivery.headers, body: delivery.body })).status;
    }

    test('signed deliveries are accepted with the fixed secret from fake-apps.json and recorded', async () => {
      assert.equal(await deliver(signWebhookDelivery(briefcase.webhook_secret ?? '', event('0192f0aa-0000-7000-8000-000000000001'))), 200);
      const events = await client.events('briefcase', { type: 'account.id_changed' });
      assert.equal(events.items.length, 1);
      assert.equal(events.items[0]?.payload.data.new_id, 'c:new');
    });

    test('duplicates are acknowledged once and counted; bad signatures and stale timestamps are 401', async () => {
      const delivery = signWebhookDelivery(briefcase.webhook_secret ?? '', event('0192f0aa-0000-7000-8000-000000000002'));
      assert.equal(await deliver(delivery), 200);
      assert.equal(await deliver(delivery), 200);
      const forged = signWebhookDelivery('whsec_wrong', event('0192f0aa-0000-7000-8000-000000000003'));
      assert.equal(await deliver(forged), 401);
      const stale = signWebhookDelivery(briefcase.webhook_secret ?? '', event('0192f0aa-0000-7000-8000-000000000004'), { timestamp: Math.floor(Date.now() / 1000) - 3600 });
      assert.equal(await deliver(stale), 401);
      const tamperedBody = signWebhookDelivery(briefcase.webhook_secret ?? '', event('0192f0aa-0000-7000-8000-000000000005'));
      assert.equal(await deliver({ headers: tamperedBody.headers, body: tamperedBody.body.replace('c:new', 'c:evil') }), 401);
      const list = await client.events('briefcase', { includeRejected: true });
      assert.equal(list.items.length, 1);
      assert.equal(list.items[0]?.duplicate_count, 1);
      assert.equal(list.duplicates, 1);
      assert.deepEqual(
        (list.rejected ?? []).map((r) => r.reason),
        ['signature_mismatch', 'timestamp_out_of_tolerance', 'signature_mismatch'],
      );
    });

    test('header/body mismatches and events for another app are refused', async () => {
      const delivery = signWebhookDelivery(briefcase.webhook_secret ?? '', event('0192f0aa-0000-7000-8000-000000000006'));
      assert.equal(await deliver({ headers: { ...delivery.headers, 'X-Accounts-Event-Id': 'other' }, body: delivery.body }), 400);
      assert.equal(await deliver(signWebhookDelivery(briefcase.webhook_secret ?? '', event('0192f0aa-0000-7000-8000-000000000007', 'account.updated', 'dm'))), 400);
    });

    test('fault injection fails the next N deliveries, then the retry is accepted', async () => {
      await client.webhookFaults('briefcase', { fail_next: 2, status: 503 });
      const delivery = signWebhookDelivery(briefcase.webhook_secret ?? '', event('0192f0aa-0000-7000-8000-000000000008'));
      assert.deepEqual([await deliver(delivery), await deliver(delivery), await deliver(delivery)], [503, 503, 200]);
      const state = await client.state('briefcase');
      assert.equal((state.webhook as Record<string, unknown>).deliveries, 3);
    });

    test('a test-registered secret replaces the fixed one; _connect-webhook fetches a fresh one from Accounts', async () => {
      await client.setWebhookSecret('dm', 'whsec_registered_by_test');
      assert.equal(await deliver(signWebhookDelivery('whsec_registered_by_test', event('0192f0aa-0000-7000-8000-000000000009', 'ping', 'dm')), 'dm'), 200);
      assert.equal(await deliver(signWebhookDelivery(app('dm').webhook_secret ?? '', event('0192f0aa-0000-7000-8000-000000000010', 'ping', 'dm')), 'dm'), 401);
      await client.connectWebhook('dm');
      const fresh = stub.webhookSecrets.get('dm') ?? '';
      assert.match(fresh, /^whsec_/);
      assert.equal(await deliver(signWebhookDelivery(fresh, event('0192f0aa-0000-7000-8000-000000000011', 'ping', 'dm')), 'dm'), 200);
    });

    test('deliveries refused for an unknown secret are recovered once the secret is registered', async () => {
      const early = signWebhookDelivery('whsec_issued_later', event('0192f0aa-0000-7000-8000-000000000013', 'membership.signed_out'));
      assert.equal(await deliver(early), 401);
      assert.equal((await client.events('briefcase')).items.length, 0);
      assert.deepEqual(await client.setWebhookSecret('briefcase', 'whsec_issued_later'), { recovered: 1 });
      const [recovered] = (await client.events('briefcase')).items;
      assert.equal(recovered?.recovered, true);
      assert.equal(await deliver(early), 200, 'the retry is acknowledged as a duplicate');
      assert.equal((await client.events('briefcase')).items[0]?.duplicate_count, 1);
    });

    test('generic sinks (/hooks/<key>) receive a Silicon webhook that is created before its secret is known', async () => {
      const key = 'si-scout-1';
      const url = client.hookUrl(key);
      const created = {
        event_id: '0192f0aa-0000-7000-8000-000000000020',
        type: 'silicon.created',
        occurred_at: new Date().toISOString(),
        app_id: null,
        silicon: 'xY9',
        data: { uuid: 'xY9', id: 'si:scout', status: 'pending_custodian' },
      };
      const delivery = signWebhookDelivery('whsec_silicon_secret', created);
      assert.equal((await fetch(url, { method: 'POST', headers: delivery.headers, body: delivery.body })).status, 401);
      const waiting = client.waitForHookEvent(key, { type: 'silicon.created', uuid: 'xY9', timeoutMs: 5_000 });
      assert.deepEqual(await client.setHookSecret(key, 'whsec_silicon_secret'), { recovered: 1 });
      assert.equal((await waiting).payload.silicon, 'xY9');
      await client.hookFaults(key, { fail_next: 1, status: 500 });
      const accepted = signWebhookDelivery('whsec_silicon_secret', { ...created, event_id: '0192f0aa-0000-7000-8000-000000000021', type: 'silicon.custodian.accepted' });
      assert.equal((await fetch(url, { method: 'POST', headers: accepted.headers, body: accepted.body })).status, 500);
      assert.equal((await fetch(url, { method: 'POST', headers: accepted.headers, body: accepted.body })).status, 200);
      const events = await client.hookEvents(key, { includeRejected: true });
      assert.deepEqual(
        events.items.map((e) => e.type),
        ['silicon.custodian.accepted', 'silicon.created'],
      );
      assert.equal(events.rejected?.length, 2);
      const invalid = await fetch(`${server.url}/hooks/${'x'.repeat(101)}`, { method: 'POST', body: '{}' });
      assert.equal(invalid.status, 422);
    });

    test('waitForEvent long-polls until the delivery arrives', async () => {
      const waiting = client.waitForEvent('commit', { type: 'membership.signed_out', timeoutMs: 5_000 });
      const body = JSON.stringify(event('0192f0aa-0000-7000-8000-000000000012', 'membership.signed_out', 'commit'));
      const ts = String(Math.floor(Date.now() / 1000));
      setTimeout(
        () =>
          void fetch(`${server.url}/commit/webhooks`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Accounts-Event-Id': '0192f0aa-0000-7000-8000-000000000012',
              'X-Accounts-Event-Type': 'membership.signed_out',
              'X-Accounts-Timestamp': ts,
              'X-Accounts-Signature': webhookSignatureHeader(app('commit').webhook_secret ?? '', ts, body),
            },
            body,
          }),
        100,
      );
      const received = await waiting;
      assert.equal(received.event_id, '0192f0aa-0000-7000-8000-000000000012');
    });
  });

  describe('proof demos', () => {
    test('OBO: dm saves a file into Briefcase on behalf of a signed-in account, with timings', async () => {
      const grace = stub.createAccount({ id: 'c:grace', display_name: 'Grace', email: 'grace@example.test' });
      assert.equal((await client.sltLogin('dm', stub.issueSlt('dm', grace))).ok, true);
      const { status, body } = await client.saveToBriefcase({ uuid: grace.uuid, filename: 'notes.txt' });
      assert.equal(status, 200, JSON.stringify(body));
      const file = body.file as Record<string, unknown>;
      assert.equal(file.filename, 'notes.txt');
      assert.equal(file.uploaded_by_app, 'dm');
      assert.equal((file.owner as Record<string, unknown>).uuid, grace.uuid);
      const timings = body.timings as Record<string, number>;
      for (const key of ['issue_ms', 'verify_ms', 'total_ms']) assert.equal(typeof timings[key], 'number', key);
      assert.equal(JSON.stringify(body).includes('sap_'), false, 'proof tokens are not echoed');
      assert.equal((await client.files('briefcase', grace.uuid)).length, 1);
      assert.deepEqual(stub.verifyRequests.at(-1), { app_id: 'briefcase', valid: true });
    });

    test('OBO: a proof for Briefcase is invalid when another app verifies it', async () => {
      const linus = stub.createAccount({ id: 'c:linus', display_name: 'Linus' });
      await client.sltLogin('dm', stub.issueSlt('dm', linus));
      const issued = await client.issueObo('dm', { uuid: linus.uuid });
      assert.equal(issued.status, 201);
      const token = String((issued.body as Record<string, unknown>).proof_token);
      assert.deepEqual((await client.verifyProof('commit', token)).verification, { valid: false, expires_at: null });
      assert.equal((await client.verifyProof('briefcase', token)).verification.valid, true);
    });

    test('OBO without a stored sign-in is a precise 404', async () => {
      const { status, body } = await client.saveToBriefcase({ uuid: 'nobody' });
      assert.equal(status, 404);
      assert.match(String((body.error as Record<string, unknown>).hint), /slt-login/);
    });

    test('ATA: commit gets one proof for remind + waveform and both verify it', async () => {
      const { status, body } = await client.notify({ message: 'standup in 5' });
      assert.equal(status, 200, JSON.stringify(body));
      const results = body.results as Record<string, Record<string, unknown>>;
      assert.equal(results.remind?.ok, true);
      assert.equal(results.waveform?.ok, true);
      const timings = body.timings as { issue_ms: number; verify_ms: Record<string, number>; total_ms: number };
      assert.equal(typeof timings.verify_ms.remind, 'number');
      assert.equal(typeof timings.verify_ms.waveform, 'number');
      const remindState = await client.state('remind');
      assert.equal((remindState.pings as unknown[]).length, 1);
    });
  });

  test('refresh rotates; replaying the previous refresh token is refused (reuse detection)', async () => {
    const dorothy = stub.createAccount({ id: 'c:dorothy', display_name: 'Dorothy' });
    await client.sltLogin('browser', stub.issueSlt('browser', dorothy));
    const first = await client.refresh('browser', dorothy.uuid);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const reuse = await client.refresh('browser', dorothy.uuid, true);
    assert.equal(reuse.status, 400);
    assert.match(JSON.stringify(reuse.body), /reuse/);
  });

  test('logout revokes the refresh token at Accounts', async () => {
    const { html, cookie } = await openPage('commit', '?only=hosted');
    const hosted = new URL(attr(html, /<a id="signin-hosted"[^>]*>/, 'href') ?? '');
    const code = stub.issueCode({ app_id: 'commit', redirect_uri: hosted.searchParams.get('redirect_uri') ?? '', code_challenge: hosted.searchParams.get('code_challenge'), code_challenge_method: 'S256', account: ada });
    await fetch(`${server.url}/commit/callback?code=${code}&state=${hosted.searchParams.get('state')}`, { headers: { Cookie: cookie } });
    const before = stub.revoked.length;
    const res = await fetch(`${server.url}/commit/logout`, { method: 'POST', headers: { Cookie: cookie, Accept: 'application/json' } });
    assert.equal(res.status, 200);
    assert.equal(stub.revoked.length, before + 1);
    assert.match(stub.revoked.at(-1) ?? '', /^sar_/);
  });

  test('unknown apps are a precise 404 listing the known ones; the index lists every app', async () => {
    const res = await fetch(`${server.url}/nope/`);
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: { code: string; hint: string } };
    assert.equal(body.error.code, 'unknown_app');
    assert.match(body.error.hint, /briefcase/);
    const index = await (await fetch(`${server.url}/`, { headers: { Accept: 'application/json' } })).json();
    assert.equal((index as { apps: unknown[] }).apps.length, 15);
    const html = await (await fetch(`${server.url}/`)).text();
    assert.equal((html.match(/data-app-id=/g) ?? []).length, 15);
  });

  test('client_secret_basic carries the fixed app secret', () => {
    const header = basic('briefcase', app('briefcase').secret);
    assert.match(header, /^Basic /);
  });
});
