import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createRemoteJWKSet, decodeJwt, decodeProtectedHeader, jwtVerify } from 'jose';
import { parseFormPost } from '../lib/mocks.ts';
import { codeChallengeS256, createPkcePair } from '../lib/pkce.ts';
import { start, type MockOidc } from '../src/mock-oidc.ts';
import { appleClientSecret, basic, generateAppleKey, getManual, postForm } from './helpers.ts';

const GOOGLE = { provider: 'google' as const, client_id: '123456789012-testclient.apps.googleusercontent.com', client_secret: 'GOCSPX-test-secret-value-000000', label: 'test-managed' };
const BYO_GOOGLE = { provider: 'google' as const, client_id: '999999999999-byoclient.apps.googleusercontent.com', client_secret: 'GOCSPX-byo-secret', display_name: 'Acme Notes', label: 'byo:acme-notes' };
const REDIRECT = 'http://127.0.0.1:9/v1/oauth/callback/google';
const APPLE_REDIRECT = 'http://127.0.0.1:9/v1/oauth/callback/apple';

describe('mock-oidc: Google', () => {
  let oidc: MockOidc;
  before(async () => {
    oidc = await start({ port: 0, clients: [GOOGLE, BYO_GOOGLE] });
  });
  after(() => oidc.stop());

  function authorizeUrl(overrides: Record<string, string | null> = {}, challenge = createPkcePair().code_challenge): URL {
    const url = new URL(`${oidc.issuer.google}/authorize`);
    const params: Record<string, string | null> = {
      client_id: GOOGLE.client_id,
      redirect_uri: REDIRECT,
      response_type: 'code',
      scope: 'openid email profile',
      state: 'state-123',
      nonce: 'nonce-abc',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      ...overrides,
    };
    for (const [k, v] of Object.entries(params)) if (v !== null) url.searchParams.set(k, v);
    return url;
  }

  async function authorizeCode(email: string, overrides: Record<string, string | null> = {}): Promise<{ code: string; verifier: string; location: URL }> {
    const pkce = createPkcePair();
    const res = await getManual(authorizeUrl({ _auto: email, ...overrides }, pkce.code_challenge));
    assert.equal(res.status, 302, await res.text());
    const location = new URL(res.headers.get('location') ?? '');
    return { code: location.searchParams.get('code') ?? '', verifier: pkce.code_verifier, location };
  }

  test('authorize with a matching login_hint redirects back with code, state, scope', async () => {
    const res = await getManual(authorizeUrl({ login_hint: 'ada.lovelace@example.test' }));
    assert.equal(res.status, 302);
    const location = new URL(res.headers.get('location') ?? '');
    assert.equal(`${location.origin}${location.pathname}`, REDIRECT);
    assert.equal(location.searchParams.get('state'), 'state-123');
    assert.match(location.searchParams.get('code') ?? '', /^4\/0A/);
    assert.match(location.searchParams.get('scope') ?? '', /openid/);
    assert.equal(location.searchParams.get('authuser'), '0');
  });

  test('token exchange returns an RS256 id_token that verifies against the JWKS', async () => {
    const { code, verifier } = await authorizeCode('ada.lovelace@example.test');
    const res = await postForm(`${oidc.issuer.google}/token`, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      client_id: GOOGLE.client_id,
      client_secret: GOOGLE.client_secret,
      code_verifier: verifier,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.token_type, 'Bearer');
    const idToken = String(res.body.id_token);
    assert.equal(decodeProtectedHeader(idToken).alg, 'RS256');
    const jwks = createRemoteJWKSet(new URL(`${oidc.issuer.google}/jwks`));
    const { payload } = await jwtVerify(idToken, jwks, { issuer: oidc.issuer.google, audience: GOOGLE.client_id });
    assert.equal(payload.email, 'ada.lovelace@example.test');
    assert.equal(payload.email_verified, true);
    assert.equal(payload.nonce, 'nonce-abc');
    assert.equal(payload.name, 'Ada Lovelace');
    assert.equal(payload.azp, GOOGLE.client_id);
    assert.equal(typeof payload.at_hash, 'string');
    assert.match(String(payload.picture), /^https:\/\//);
  });

  test('client_secret_basic works and the request log records the client id and method', async () => {
    await oidc.requests(); // warm
    const { code, verifier } = await authorizeCode('alan.turing@example.test');
    const res = await postForm(
      `${oidc.issuer.google}/token`,
      { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier },
      { Authorization: basic(GOOGLE.client_id, GOOGLE.client_secret) },
    );
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const log = await (await fetch(`${oidc.url}/_requests?provider=google&endpoint=token`)).json();
    const entry = (log as { items: Array<Record<string, unknown>> }).items[0]!;
    assert.equal(entry.client_id, GOOGLE.client_id);
    assert.equal(entry.auth_method, 'client_secret_basic');
    assert.equal(entry.outcome, 'tokens_issued');
    assert.deepEqual(entry.identity, { sub: '104729573829461530003', email: 'alan.turing@example.test' });
  });

  test('a wrong PKCE verifier is invalid_grant, and the code cannot be reused', async () => {
    const { code, verifier } = await authorizeCode('ada.lovelace@example.test');
    const wrong = await postForm(`${oidc.issuer.google}/token`, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      client_id: GOOGLE.client_id,
      client_secret: GOOGLE.client_secret,
      code_verifier: createPkcePair().code_verifier,
    });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.body.error, 'invalid_grant');
    assert.match(String(wrong.body.error_description), /code_verifier/);
    // The failed attempt did not consume the code: the right verifier still works once.
    const form = { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: GOOGLE.client_id, client_secret: GOOGLE.client_secret, code_verifier: verifier };
    assert.equal((await postForm(`${oidc.issuer.google}/token`, form)).status, 200);
    const reuse = await postForm(`${oidc.issuer.google}/token`, form);
    assert.equal(reuse.status, 400);
    assert.equal(reuse.body.error, 'invalid_grant');
    assert.match(String(reuse.body.error_description), /already redeemed/);
  });

  test('wrong secret is 401 invalid_client; redirect_uri mismatch is redirect_uri_mismatch', async () => {
    const { code, verifier } = await authorizeCode('ada.lovelace@example.test');
    const badSecret = await postForm(`${oidc.issuer.google}/token`, { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: GOOGLE.client_id, client_secret: 'nope', code_verifier: verifier });
    assert.equal(badSecret.status, 401);
    assert.equal(badSecret.body.error, 'invalid_client');
    const badRedirect = await postForm(`${oidc.issuer.google}/token`, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: 'http://127.0.0.1:9/other',
      client_id: GOOGLE.client_id,
      client_secret: GOOGLE.client_secret,
      code_verifier: verifier,
    });
    assert.equal(badRedirect.status, 400);
    assert.equal(badRedirect.body.error, 'redirect_uri_mismatch');
  });

  test('authorize refuses unknown clients and incomplete requests with an error page (never redirects)', async () => {
    const unknown = await getManual(authorizeUrl({ client_id: 'nobody.apps.googleusercontent.com' }));
    assert.equal(unknown.status, 401);
    assert.match(await unknown.text(), /data-error="invalid_client"/);
    for (const [missing, pattern] of [
      ['state', /state/],
      ['nonce', /nonce/],
      ['code_challenge', /code_challenge/],
    ] as const) {
      const res = await getManual(authorizeUrl({ [missing]: null }));
      assert.equal(res.status, 400, `missing ${missing}`);
      const html = await res.text();
      assert.match(html, /data-error="invalid_request"/);
      assert.match(html, pattern);
      assert.equal(res.headers.get('location'), null);
    }
    const plain = await getManual(authorizeUrl({ code_challenge_method: 'plain' }));
    assert.equal(plain.status, 400);
    const noOpenid = await getManual(authorizeUrl({ scope: 'email profile' }));
    assert.equal(noOpenid.status, 400);
    assert.match(await noOpenid.text(), /invalid_scope/);
  });

  test('the chooser lists identities as buttons with data-email and shows the client name', async () => {
    const res = await getManual(authorizeUrl({ client_id: BYO_GOOGLE.client_id }));
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /id="chooser"/);
    assert.match(html, /data-email="ada\.lovelace@example\.test"/);
    assert.match(html, /data-client-name="Acme Notes"/);
    assert.match(html, /<input type="hidden" name="state" value="state-123">/);
    assert.match(html, /data-action="cancel"/);
  });

  test('_auto creates unknown identities on the fly; _error=access_denied redirects with error + state', async () => {
    const { location } = await authorizeCode('fresh+abc@example.test');
    assert.ok(location.searchParams.get('code'));
    assert.ok(oidc.identities('google').some((i) => i.email === 'fresh+abc@example.test'));
    const cancelled = await getManual(authorizeUrl({ _error: 'access_denied' }));
    assert.equal(cancelled.status, 302);
    const back = new URL(cancelled.headers.get('location') ?? '');
    assert.equal(back.searchParams.get('error'), 'access_denied');
    assert.equal(back.searchParams.get('state'), 'state-123');
  });

  test('prompt=none without a known identity answers login_required', async () => {
    const res = await getManual(authorizeUrl({ prompt: 'none' }));
    assert.equal(res.status, 302);
    assert.equal(new URL(res.headers.get('location') ?? '').searchParams.get('error'), 'login_required');
  });

  test('POST /_next queues the identity for the next authorize', async () => {
    const queued = await fetch(`${oidc.url}/_next`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'google', email: 'queued+1@example.test', name: 'Queued One' }) });
    assert.equal(queued.status, 201);
    const pkce = createPkcePair();
    const res = await getManual(authorizeUrl({}, pkce.code_challenge));
    assert.equal(res.status, 302);
    const code = new URL(res.headers.get('location') ?? '').searchParams.get('code') ?? '';
    const tokens = await postForm(`${oidc.issuer.google}/token`, { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: GOOGLE.client_id, client_secret: GOOGLE.client_secret, code_verifier: pkce.code_verifier });
    assert.equal(decodeJwt(String(tokens.body.id_token)).name, 'Queued One');
  });

  test('faults: a 503 token error once, then a tampered id_token signed by an unknown key', async () => {
    await fetch(`${oidc.url}/_faults`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'google', endpoint: 'token', status: 503, error: 'temporarily_unavailable' }) });
    await fetch(`${oidc.url}/_faults`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: 'token', id_token: { claims: { nonce: 'wrong-nonce' }, sign_with: 'unknown_key' } }) });
    const first = await authorizeCode('ada.lovelace@example.test');
    const form = (c: { code: string; verifier: string }): Record<string, string> => ({ grant_type: 'authorization_code', code: c.code, redirect_uri: REDIRECT, client_id: GOOGLE.client_id, client_secret: GOOGLE.client_secret, code_verifier: c.verifier });
    const failed = await postForm(`${oidc.issuer.google}/token`, form(first));
    assert.equal(failed.status, 503);
    assert.equal(failed.body.error, 'temporarily_unavailable');
    const second = await authorizeCode('ada.lovelace@example.test');
    const tampered = await postForm(`${oidc.issuer.google}/token`, form(second));
    assert.equal(tampered.status, 200);
    const idToken = String(tampered.body.id_token);
    assert.equal(decodeJwt(idToken).nonce, 'wrong-nonce');
    assert.equal(decodeProtectedHeader(idToken).kid, 'mock-unknown-key');
    const jwks = createRemoteJWKSet(new URL(`${oidc.issuer.google}/jwks`));
    await assert.rejects(jwtVerify(idToken, jwks), /no applicable key|matching key/i);
  });

  test('discovery and JWKS describe the provider', async () => {
    const discovery = (await (await fetch(`${oidc.issuer.google}/.well-known/openid-configuration`)).json()) as Record<string, unknown>;
    assert.equal(discovery.issuer, oidc.issuer.google);
    assert.equal(discovery.token_endpoint, `${oidc.issuer.google}/token`);
    const jwks = (await (await fetch(`${oidc.issuer.google}/jwks`)).json()) as { keys: Array<Record<string, unknown>> };
    assert.equal(jwks.keys[0]?.kty, 'RSA');
    assert.equal(jwks.keys[0]?.alg, 'RS256');
    assert.equal(jwks.keys[0]?.use, 'sig');
  });
});

describe('mock-oidc: Apple', () => {
  const key = generateAppleKey();
  const otherKey = generateAppleKey();
  const APPLE = { provider: 'apple' as const, client_id: 'test.example.signin', team_id: 'TEAM123456', key_id: 'KEY1234567', public_key_pem: key.publicKeyPem, label: 'test-apple' };
  let oidc: MockOidc;
  before(async () => {
    oidc = await start({ port: 0, clients: [APPLE], includeDefaultIdentities: false, identities: [{ provider: 'apple', email: 'relay123@privaterelay.appleid.com', name: 'Relay Person', sub: '000111.aaaa.0001' }] });
  });
  after(() => oidc.stop());

  function authorizeUrl(overrides: Record<string, string | null> = {}): URL {
    const url = new URL(`${oidc.issuer.apple}/authorize`);
    const params: Record<string, string | null> = {
      client_id: APPLE.client_id,
      redirect_uri: APPLE_REDIRECT,
      response_type: 'code',
      response_mode: 'form_post',
      scope: 'name email',
      state: 'apple-state',
      nonce: 'apple-nonce',
      ...overrides,
    };
    for (const [k, v] of Object.entries(params)) if (v !== null) url.searchParams.set(k, v);
    return url;
  }

  const secret = (overrides: Partial<Parameters<typeof appleClientSecret>[0]> = {}): Promise<string> =>
    appleClientSecret({ privateKey: key.privateKey, teamId: APPLE.team_id, keyId: APPLE.key_id, servicesId: APPLE.client_id, audience: oidc.issuer.apple, ...overrides });

  async function formPost(email: string, overrides: Record<string, string | null> = {}): Promise<Record<string, string>> {
    const res = await getManual(authorizeUrl({ _auto: email, ...overrides }));
    assert.equal(res.status, 200);
    const form = parseFormPost(await res.text());
    assert.ok(form, 'form_post page');
    assert.equal(form.action, APPLE_REDIRECT);
    return form.fields;
  }

  test('scope name/email requires response_mode=form_post', async () => {
    const res = await getManual(authorizeUrl({ response_mode: 'query' }));
    assert.equal(res.status, 400);
    assert.match(await res.text(), /form_post/);
  });

  test('form_post carries code + state, and user JSON only on the first authorization', async () => {
    const first = await formPost('ada+apple@example.test');
    assert.ok(first.code);
    assert.equal(first.state, 'apple-state');
    const user = JSON.parse(first.user ?? '{}') as { name: { firstName: string; lastName: string }; email: string };
    assert.equal(user.email, 'ada+apple@example.test');
    assert.deepEqual(user.name, { firstName: 'Ada', lastName: 'Apple' });
    const second = await formPost('ada+apple@example.test');
    assert.equal(second.user, undefined);
  });

  test('token exchange verifies the ES256 client_secret and returns email_verified as the string "true"', async () => {
    const fields = await formPost('relay123@privaterelay.appleid.com');
    const res = await postForm(`${oidc.issuer.apple}/token`, { grant_type: 'authorization_code', code: fields.code ?? '', redirect_uri: APPLE_REDIRECT, client_id: APPLE.client_id, client_secret: await secret() });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.refresh_token);
    const jwks = createRemoteJWKSet(new URL(`${oidc.issuer.apple}/jwks`));
    const { payload } = await jwtVerify(String(res.body.id_token), jwks, { issuer: oidc.issuer.apple, audience: APPLE.client_id });
    assert.equal(payload.email_verified, 'true');
    assert.equal(payload.is_private_email, 'true');
    assert.equal(payload.nonce, 'apple-nonce');
    assert.equal(payload.sub, '000111.aaaa.0001');
    const log = oidc.requests({ provider: 'apple', endpoint: 'token' })[0];
    assert.equal(log?.client_id, APPLE.client_id);
    assert.deepEqual(log?.client_secret_jwt, { kid: APPLE.key_id, iss: APPLE.team_id, sub: APPLE.client_id, aud: oidc.issuer.apple });
  });

  test('bad client secrets are invalid_client with a precise description', async () => {
    const now = Math.floor(Date.now() / 1000);
    const cases: Array<[string, Promise<string> | string, RegExp]> = [
      ['signed by another key', appleClientSecret({ privateKey: otherKey.privateKey, teamId: APPLE.team_id, keyId: APPLE.key_id, servicesId: APPLE.client_id, audience: oidc.issuer.apple }), /signature/],
      ['wrong audience', secret({ audience: 'https://appleid.apple.com' }), /"aud"/],
      ['wrong issuer (team)', secret({ teamId: 'OTHERTEAM1' }), /"iss"/],
      ['wrong subject', secret({ servicesId: 'someone.else' }), /"sub"/],
      ['wrong kid', secret({ keyId: 'OTHERKEY01' }), /kid/],
      ['expired', secret({ iat: now - 7200, exp: now - 3600 }), /expired/],
      ['too long-lived', secret({ iat: now, exp: now + 16_000_000 }), /lifetime/],
      ['not a JWT', 'definitely-not-a-jwt', /not a JWT/],
    ];
    for (const [name, clientSecret, pattern] of cases) {
      const fields = await formPost('relay123@privaterelay.appleid.com');
      const res = await postForm(`${oidc.issuer.apple}/token`, { grant_type: 'authorization_code', code: fields.code ?? '', redirect_uri: APPLE_REDIRECT, client_id: APPLE.client_id, client_secret: await clientSecret });
      assert.equal(res.status, 400, name);
      assert.equal(res.body.error, 'invalid_client', name);
      assert.match(String(res.body.error_description), pattern, name);
    }
  });

  test('HTTP Basic is refused (Apple only takes client_secret_post)', async () => {
    const fields = await formPost('relay123@privaterelay.appleid.com');
    const res = await postForm(`${oidc.issuer.apple}/token`, { grant_type: 'authorization_code', code: fields.code ?? '', redirect_uri: APPLE_REDIRECT, client_id: APPLE.client_id }, { Authorization: basic(APPLE.client_id, 'x') });
    assert.equal(res.status, 400);
    assert.match(String(res.body.error_description), /client_secret_post/);
  });

  test('cancel answers user_cancelled_authorize through form_post', async () => {
    const res = await getManual(authorizeUrl({ _error: 'access_denied' }));
    const form = parseFormPost(await res.text());
    assert.equal(form?.fields.error, 'user_cancelled_authorize');
    assert.equal(form?.fields.state, 'apple-state');
  });

  test('a registered client may be given its p8 private key instead of the public key', async () => {
    oidc.registerClient({ provider: 'apple', client_id: 'test.private.only', team_id: 'TEAM999999', key_id: 'KEYPRIV001', private_key_pem: key.privateKeyPem });
    const res = await getManual(authorizeUrl({ client_id: 'test.private.only', _auto: 'p8@example.test' }));
    const form = parseFormPost(await res.text());
    const token = await postForm(`${oidc.issuer.apple}/token`, {
      grant_type: 'authorization_code',
      code: form?.fields.code ?? '',
      redirect_uri: APPLE_REDIRECT,
      client_id: 'test.private.only',
      client_secret: await appleClientSecret({ privateKey: key.privateKey, teamId: 'TEAM999999', keyId: 'KEYPRIV001', servicesId: 'test.private.only', audience: oidc.issuer.apple }),
    });
    assert.equal(token.status, 200, JSON.stringify(token.body));
  });

  test('PKCE challenge sent to Apple is honoured when present', async () => {
    const pkce = createPkcePair();
    const fields = await formPost('pkce+apple@example.test', { code_challenge: pkce.code_challenge, code_challenge_method: 'S256' });
    const wrong = await postForm(`${oidc.issuer.apple}/token`, { grant_type: 'authorization_code', code: fields.code ?? '', redirect_uri: APPLE_REDIRECT, client_id: APPLE.client_id, client_secret: await secret(), code_verifier: 'x'.repeat(43) });
    assert.equal(wrong.body.error, 'invalid_grant');
    assert.equal(codeChallengeS256(pkce.code_verifier), pkce.code_challenge);
  });
});
