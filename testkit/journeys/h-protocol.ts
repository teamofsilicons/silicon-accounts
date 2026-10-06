// Protocol and security details apps and the sign-in pages rely on: the OIDC id_token
// (quill-docs), prompt=none/login, refused redirect URIs, PKCE, code reuse, refresh rotation and
// reuse detection, OTP send limit and verify lockout, the CSRF Origin guard, audience confusion,
// the embed page's frame-ancestors, SDK/discovery CORS.
import { accounts, check, codeFrom, codeStep, done, driveFlow, fakeAppsUrl, HttpClient, messaging, newBrowser, randomEmail, section, signUpCarbon, startAppSignIn } from './_common.ts';

section('quill-docs: scope openid → an id_token the fake app verifies (EdDSA, iss, aud, nonce)');
{
  const browser = await newBrowser();
  const s = await startAppSignIn('quill-docs', browser, { scope: 'openid email' });
  let flow = await codeStep(browser, s.flow, { email: randomEmail('oidc') });
  flow = await driveFlow(browser, flow, { messaging, optionalScopes: ['email'] });
  const cb: any = await s.fake.callback('quill-docs', flow.redirect_to!);
  check(cb.id_token?.verified === true && typeof cb.id_token?.claims?.auth_time === 'number', `id_token verified (claims: ${Object.keys(cb.id_token?.claims ?? {}).join(', ')})`, cb.id_token);
}

section('prompt=none / prompt=login');
{
  const s = await startAppSignIn('briefcase', await newBrowser(), { prompt: 'none' });
  check(s.flow.step === 'failed' && /error=login_required/.test(s.flow.redirect_to ?? ''), 'prompt=none, nobody signed in → step failed, redirect error=login_required', s.flow);
  const c = await signUpCarbon({ accounts, messaging });
  const p = await startAppSignIn('briefcase', c.browser, { prompt: 'login' });
  check(p.flow.step === 'choose_method' && !p.flow.signed_in_as, 'prompt=login → no "continue as"', p.flow);
  const n = await startAppSignIn('commit', c.browser, { prompt: 'none' });
  check(n.flow.step === 'failed' && /error=consent_required/.test(n.flow.redirect_to ?? ''), 'prompt=none before any consent → consent_required', n.flow);
}

section('refused /authorize requests never redirect');
{
  const browser = await newBrowser();
  const r1: any = await browser.createFlowRaw({ app_id: 'briefcase', redirect_uri: 'https://evil.example/cb', state: 's' });
  check(r1.status === 400 && r1.body?.error?.code === 'redirect_uri_not_registered' && !r1.body?.error?.details?.redirect_to, 'unregistered redirect_uri → 400 without redirect_to', r1.body);
  const r2: any = await browser.createFlowRaw({ app_id: 'no-such-app', redirect_uri: 'https://x.example/cb' });
  check(r2.status === 400 && r2.body?.error?.code === 'unknown_app', 'unknown app → 400 unknown_app', r2.body);
}

section('PKCE, code reuse, refresh rotation + reuse detection');
{
  const browser = await newBrowser();
  const app = accounts.app('briefcase');
  const s = await startAppSignIn('briefcase', browser);
  let flow = await codeStep(browser, s.flow, { email: randomEmail('pkce') });
  flow = await driveFlow(browser, flow, { messaging });
  const code = codeFrom(flow);
  const bad: any = await app.tokenRaw({ grant_type: 'authorization_code', code, redirect_uri: s.az.redirect_uri, code_verifier: 'x'.repeat(43) });
  check(bad.status === 400 && bad.body?.error === 'invalid_grant', 'wrong code_verifier → invalid_grant', bad.body);
  const burned: any = await app.tokenRaw({ grant_type: 'authorization_code', code, redirect_uri: s.az.redirect_uri, code_verifier: s.az.code_verifier ?? '' });
  check(burned.status === 400, 'the code is burned after a failed PKCE check', burned.body);
  const s2 = await startAppSignIn('briefcase', browser);
  flow = await browser.continueAs(s2.flow.id);
  const t1 = await app.exchangeCode(codeFrom(flow), s2.az.redirect_uri, s2.az.code_verifier);
  const t2 = await app.refresh(t1.refresh_token);
  check(t2.refresh_token !== t1.refresh_token, 'refresh rotates the refresh token');
  const reuse: any = await app.tokenRaw({ grant_type: 'refresh_token', refresh_token: t1.refresh_token });
  check(reuse.status === 400 && reuse.body?.error === 'invalid_grant', 'a used refresh token → invalid_grant', reuse.body);
  const family: any = await app.tokenRaw({ grant_type: 'refresh_token', refresh_token: t2.refresh_token });
  check(family.status === 400, 'reuse revoked the whole sign-in', family.body);
  check((await app.introspect(t2.access_token)).active === false, 'introspection says inactive');
}

section('codes: the 11th send → 429; the 10th wrong code locks (423 after)');
{
  const browser = await newBrowser();
  const s = await startAppSignIn('briefcase', browser);
  const email = randomEmail('limits');
  let last: any = await browser.http.post(`/v1/flows/${s.flow.id}/email`, { json: { email } });
  for (let i = 2; i <= 11 && last.status === 200; i++) last = await browser.http.post(`/v1/flows/${s.flow.id}/resend`);
  check(last.status === 429 && last.body?.error?.code === 'rate_limited' && !!last.headers.get('retry-after'), `11th send → 429 rate_limited, Retry-After ${last.headers.get('retry-after')}`, last.body);
  const b2 = await newBrowser();
  const s2 = await startAppSignIn('briefcase', b2);
  await b2.email(s2.flow.id, randomEmail('lock'));
  let r: any = null;
  for (let i = 1; i <= 10; i++) r = await b2.verifyRaw(s2.flow.id, '000000');
  check(r.status === 422 && r.body?.error?.details?.remaining_attempts === 0 && !!r.body?.error?.details?.locked_until, '10th wrong code → 422 invalid_code, remaining_attempts 0, locked_until', r.body);
  r = await b2.verifyRaw(s2.flow.id, '000000');
  check(r.status === 423 && r.body?.error?.code === 'verification_locked', '11th → 423 verification_locked', r.body);
}

section('CSRF: cookie-authenticated mutations need the site\'s Origin');
{
  const c = await signUpCarbon({ accounts, messaging });
  const evil: any = await c.browser.http.request('PATCH', '/v1/me', { json: { display_name: 'X' }, origin: 'https://evil.example' });
  check(evil.status === 403 && evil.body?.error?.code === 'origin_not_allowed', 'foreign Origin → 403 origin_not_allowed', evil.body);
  const none: any = await c.browser.http.request('PATCH', '/v1/me', { json: { display_name: 'X' }, origin: null });
  check(none.status === 403 && none.body?.error?.code === 'origin_not_allowed', 'no Origin → 403 origin_not_allowed', none.body);
  check((await c.browser.http.request('PATCH', '/v1/me', { json: { display_name: 'Fine' } })).status === 200, 'the site\'s own Origin → 200');
}

section('an app\'s access token is not an account-site token');
{
  const browser = await newBrowser();
  const s = await startAppSignIn('briefcase', browser);
  let flow = await codeStep(browser, s.flow, { email: randomEmail('aud') });
  flow = await driveFlow(browser, flow, { messaging });
  const t = await accounts.app('briefcase').exchangeCode(codeFrom(flow), s.az.redirect_uri, s.az.code_verifier);
  const r: any = await new HttpClient({ baseUrl: accounts.url, headers: { Authorization: `Bearer ${t.access_token}` } }).get('/v1/me');
  check(r.status === 401 && r.body?.error?.code === 'token_wrong_audience', `app token on /v1/me → ${r.status} ${r.body?.error?.code}`, r.body);
}

section('embed frame-ancestors, SDK + discovery CORS');
{
  const e = await fetch(`${accounts.url}/embed/v1/buttons?app_id=orbit-games`);
  const csp = e.headers.get('content-security-policy') ?? '';
  const allowed = new URL(fakeAppsUrl).origin;
  check(e.status === 200 && (/frame-ancestors[^;]*/.exec(csp)?.[0] ?? '') === `frame-ancestors 'self' ${allowed}`, `orbit-games embed: ${/frame-ancestors[^;]*/.exec(csp)?.[0]} (allowed origin ${allowed})`, csp);
  check(/frame-ancestors 'none'/.test((await fetch(`${accounts.url}/embed/v1/buttons?app_id=no-such-app`)).headers.get('content-security-policy') ?? ''), "unknown app → frame-ancestors 'none'");
  const sdk = await fetch(`${accounts.url}/sdk/v1.js`);
  check(sdk.headers.get('access-control-allow-origin') === '*', `sdk/v1.js → ${sdk.status}, CORS *`);
  const disc = await accounts.discovery();
  check(disc.issuer === (await accounts.publicUrl()) && String(disc.authorization_endpoint).endsWith('/authorize'), `discovery issuer ${disc.issuer}`);
  check((await accounts.jwks()).keys[0]?.alg === 'EdDSA', 'JWKS: one Ed25519 key');
  const pub = await fetch(`${accounts.url}/v1/apps/briefcase/public`, { headers: { Origin: 'https://anywhere.example' } });
  check(pub.headers.get('access-control-allow-origin') === '*', 'GET /v1/apps/{id}/public is CORS *');
  const me = await fetch(`${accounts.url}/v1/me`, { headers: { Origin: 'https://anywhere.example' } });
  check(!me.headers.get('access-control-allow-origin'), '/v1/me sends no CORS headers');
}

done();
