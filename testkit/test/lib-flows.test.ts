// End-to-end tests of the e2e helper library: real mock-oidc + mock-messaging (started by
// startTestkit with the dev credentials), the real fake app server, and the stub standing in
// for Silicon Accounts.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { AccountsClient, signInWithCode, signInWithProvider, signUpCarbon } from '../lib/accounts.ts';
import { appCredentials, fakeApp, redirectUri } from '../lib/fake-apps.ts';
import { CookieJar, HttpExpectationError } from '../lib/http.ts';
import { FakeAppsClient, MockMessagingClient, MockOidcClient, randomEmail, randomPhone } from '../lib/mocks.ts';
import { start as startFakeApps, type FakeAppServer } from '../src/fake-app-server.ts';
import { loadFakeApps } from '../src/fake-apps/load.ts';
import { startTestkit, type RunningTestkit } from '../src/testkit.ts';
import { startStubAccounts, type StubAccounts } from './stub-accounts.ts';

describe('lib: sign-in helpers against mocks + stub Accounts', () => {
  let kit: RunningTestkit;
  let stub: StubAccounts;
  let fakeApps: FakeAppServer;
  let accounts: AccountsClient;
  let messaging: MockMessagingClient;
  let oidc: MockOidcClient;

  before(async () => {
    kit = await startTestkit({ oidcPort: 0, messagingPort: 0, irisPort: 0, fakeApps: false });
    const creds = kit.credentials;
    stub = await startStubAccounts({
      apps: loadFakeApps(),
      messaging: {
        url: kit.messaging?.url ?? '',
        postmarkToken: creds.messaging.postmark.server_token,
        twilio: { accountSid: creds.messaging.twilio.account_sid, authToken: creds.messaging.twilio.auth_token, messagingServiceSid: creds.messaging.twilio.messaging_service_sid },
      },
      oidc: {
        url: kit.oidc?.url ?? '',
        google: creds.managed.google,
        apple: { services_id: creds.managed.apple.services_id, team_id: creds.managed.apple.team_id, key_id: creds.managed.apple.key_id, private_key_pem: creds.managed.apple.private_key_pem },
      },
    });
    fakeApps = await startFakeApps({ port: 0, accountsUrl: stub.url });
    accounts = new AccountsClient(stub.url);
    messaging = new MockMessagingClient(kit.messaging?.url);
    oidc = new MockOidcClient(kit.oidc?.url);
  });

  after(async () => {
    await fakeApps.stop();
    await stub.stop();
    await kit.stop();
  });

  test('startTestkit exposes the env that points Accounts at the mocks', () => {
    assert.equal(kit.accountsEnv.ACCOUNTS_DELIVERY, 'providers');
    assert.equal(kit.accountsEnv.ACCOUNTS_POSTMARK_API_URL, `${kit.messaging?.url}/postmark`);
    assert.equal(kit.accountsEnv.ACCOUNTS_GOOGLE_ISSUERS, kit.oidc?.issuer.google);
    assert.equal(kit.accountsEnv.ACCOUNTS_APPLE_ISSUER, kit.oidc?.issuer.apple);
    assert.match(kit.accountsEnv.ACCOUNTS_APPLE_PRIVATE_KEY ?? '', /^-----BEGIN PRIVATE KEY-----\n/);
    assert.equal(kit.accountsEnv.ACCOUNTS_IRIS_BASE_URL, kit.iris?.url);
  });

  test('signInWithCode (email): new Carbon signs up, continues the details page, and the app exchanges the code', async () => {
    const email = randomEmail('ada');
    const result = await signInWithCode({ accounts, messaging, appId: 'briefcase', email });
    assert.equal(result.flow.step, 'complete');
    assert.ok(result.code);
    assert.equal(result.redirectUri, redirectUri('briefcase'));
    const tokens = await accounts.app('briefcase').exchangeCode(result.code, result.redirectUri, result.codeVerifier);
    assert.equal(tokens.account.membership_id, `briefcase:${tokens.account.uuid}`);
    assert.equal(tokens.token_type, 'Bearer');
    // The verification email really went through the mock Postmark API.
    const sent = await messaging.latest({ to: email, channel: 'email' });
    assert.equal(sent?.provider, 'postmark');
    assert.equal(sent?.from, 'Silicon Accounts <accounts@teamofsilicons.com>');
  });

  test('signInWithCode (phone) goes through the mock Twilio API', async () => {
    const phone = randomPhone();
    const result = await signInWithCode({ accounts, messaging, appId: 'dm', phone });
    assert.ok(result.code);
    assert.equal((await messaging.latest({ to: phone, channel: 'sms' }))?.provider, 'twilio');
  });

  test('a code reused by the app is refused with an OAuth error', async () => {
    const result = await signInWithCode({ accounts, messaging, appId: 'commit', email: randomEmail() });
    const app = accounts.app('commit');
    await app.exchangeCode(result.code ?? '', result.redirectUri, result.codeVerifier);
    await assert.rejects(app.exchangeCode(result.code ?? '', result.redirectUri, result.codeVerifier), (error: Error & { error?: string }) => error.error === 'invalid_grant');
  });

  test('signInWithProvider (Google, managed client): mock-oidc picks the identity, Accounts gets a verified id_token', async () => {
    const identity = await oidc.randomIdentity('google', { name: 'Grace Googler' });
    const result = await signInWithProvider({ accounts, messaging, oidc, provider: 'google', identityEmail: identity.email, appId: 'briefcase' });
    assert.ok(result.code);
    const tokenCall = (await oidc.requests({ provider: 'google', endpoint: 'token' }))[0];
    assert.equal(tokenCall?.client_id, kit.credentials.managed.google.client_id);
    assert.equal(tokenCall?.identity?.email, identity.email);
    const tokens = await accounts.app('briefcase').exchangeCode(result.code ?? '', result.redirectUri, result.codeVerifier);
    assert.equal(tokens.account.display_name, 'Grace Googler');
  });

  test('signInWithProvider (Apple): form_post + ES256 client_secret signed with the managed p8 key; name from the first-login user JSON', async () => {
    const identity = await oidc.randomIdentity('apple', { name: 'Kate Apple', given_name: 'Kate', family_name: 'Apple' });
    const result = await signInWithProvider({ accounts, messaging, oidc, provider: 'apple', identityEmail: identity.email, appId: 'waveform' });
    const tokens = await accounts.app('waveform').exchangeCode(result.code ?? '', result.redirectUri, result.codeVerifier);
    assert.equal(tokens.account.display_name, 'Kate Apple');
    const tokenCall = (await oidc.requests({ provider: 'apple', endpoint: 'token' }))[0];
    assert.equal(tokenCall?.outcome, 'tokens_issued');
    assert.equal(tokenCall?.client_secret_jwt?.kid, kit.credentials.managed.apple.key_id);
  });

  test('signUpCarbon signs a Carbon in to the account site; the session reads /v1/me', async () => {
    const { me, email, browser } = await signUpCarbon({ accounts, messaging });
    assert.equal(me.email, email);
    assert.ok(browser.jar.get(stub.url, 'sa_session'));
  });

  test('the browser helper sends Origin: a wrong Origin is refused by the CSRF guard', async () => {
    const browser = await accounts.browser(new CookieJar());
    const flow = await browser.createFlow({ app_id: 'briefcase', redirect_uri: redirectUri('briefcase') });
    browser.http.origin = 'http://evil.test';
    await assert.rejects(browser.email(flow.id, randomEmail()), (error: unknown) => error instanceof HttpExpectationError && error.response.status === 403);
  });

  test('full app sign-in through the fake app server: authorize-url → hosted flow → callback (JSON)', async () => {
    const jar = new CookieJar();
    const fake = new FakeAppsClient(fakeApps.url, jar);
    const started = await fake.authorizeUrl('briefcase');
    const authorize = new URL(started.authorize_url);
    // Drive the hosted flow with the exact parameters the fake app generated.
    const browser = await accounts.browser();
    const email = randomEmail('full');
    let flow = await browser.createFlow({
      app_id: 'briefcase',
      redirect_uri: authorize.searchParams.get('redirect_uri') ?? '',
      state: started.state,
      code_challenge: authorize.searchParams.get('code_challenge') ?? '',
      code_challenge_method: 'S256',
      nonce: started.nonce ?? '',
    });
    const after = await messaging.lastSeq();
    flow = await browser.email(flow.id, email);
    flow = await browser.verify(flow.id, await messaging.waitForCode({ to: email, after }));
    flow = await browser.signup(flow.id, { display_name: 'Full Flow', id: flow.signup?.id ?? 'c:full-flow', timezone: 'UTC', dob: '2000-01-01' });
    flow = await browser.detailsContinue(flow.id);
    const result = await fake.callback('briefcase', flow.redirect_to ?? '');
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.id, flow.signup?.id);
    const state = await fake.state('briefcase');
    assert.equal(state.accounts.length, 1);
  });

  test('fake app data helpers expose the fixed credentials', () => {
    assert.equal(appCredentials('briefcase').secret, fakeApp('briefcase').secret);
    assert.match(fakeApp('acme-notes').signin_defaults.google?.client_id ?? '', /^mock-google-.*\.invalid$/);
  });
});
