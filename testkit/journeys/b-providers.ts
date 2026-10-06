// Google managed (interface), Google bring-your-own (acme-notes: the mock saw acme's client_id),
// Apple form_post bring-your-own (orbit-games, as a real browser: cookieless POST → 303 → GET)
// and managed (waveform), campus-connect's email domain restriction, legacy-crm's
// allow_signup=false refusal.
import {
  accounts,
  check,
  codeStep,
  done,
  driveFlow,
  HttpClient,
  loadDevCredentials,
  messaging,
  newBrowser,
  oidc,
  randomEmail,
  section,
  signUpCarbon,
  startAppSignIn,
  type BrowserSession,
} from './_common.ts';

const creds = loadDevCredentials();

async function providerSignIn(appId: string, provider: 'google' | 'apple', identityEmail: string, browser: BrowserSession, realBrowserApple = false) {
  const s = await startAppSignIn(appId, browser);
  const authorizeUrl = await browser.oauthStart(s.flow.id, provider);
  const outcome = await oidc.authorize(authorizeUrl, { email: identityEmail });
  let flowId: string;
  if (outcome.kind === 'redirect') {
    flowId = await browser.deliverProviderCallback({ method: 'GET', url: outcome.location });
  } else if (outcome.kind === 'form_post' && realBrowserApple) {
    // A browser's cross-site form_post carries no SameSite=Lax cookie: Silicon Accounts parks
    // the answer and sends the browser (303) to a same-site GET that does carry it.
    const bare = new HttpClient({ baseUrl: accounts.url, headers: accounts.headers });
    const res = await bare.post(await accounts.toServerUrl(outcome.action), { form: outcome.fields, headers: { Accept: 'text/html' }, origin: new URL(authorizeUrl).origin });
    check(res.status === 303 && /\/v1\/oauth\/callback\/apple\?ticket=/.test(res.location ?? ''), `cookieless form_post → 303 ${res.location}`, { status: res.status, body: res.text.slice(0, 300) });
    flowId = await browser.deliverProviderCallback({ method: 'GET', url: new URL(res.location!, accounts.url).toString() });
  } else if (outcome.kind === 'form_post') {
    flowId = await browser.deliverProviderCallback({ method: 'POST', url: outcome.action, fields: outcome.fields, origin: new URL(authorizeUrl).origin });
  } else {
    throw new Error(`mock-oidc answered ${outcome.kind}: ${JSON.stringify(outcome).slice(0, 400)}`);
  }
  let flow = await browser.flow(flowId);
  if (flow.step !== 'failed' && flow.step !== 'choose_method') flow = await driveFlow(browser, flow, { messaging });
  return { ...s, authorizeUrl, flow };
}

section('the account site connects Google and Apple to a signed-in Carbon');
{
  const c = await signUpCarbon({ accounts, messaging });
  const g = await oidc.randomIdentity('google');
  const linked = await c.browser.connectProvider('google', oidc, g.email);
  check(new URL(linked.location).pathname === '/sign-in-methods' && new URL(linked.location).search === '?linked=google&email_added=true', `Google connected → ${linked.location}`);
  const me: any = await c.account.me();
  check(me.identities?.some((i: any) => i.provider === 'google' && i.email === g.email.toLowerCase()), 'the account lists its Google identity', me.identities);
  check(me.emails?.some((e: any) => e.email === g.email.toLowerCase() && e.verified_via === 'google' && !e.is_primary), 'the Google email was added (verified by Google, no code)', me.emails);
  const a = await oidc.randomIdentity('apple');
  const apple = await c.browser.connectProvider('apple', oidc, a.email, '/settings');
  check(/\/settings\?linked=apple&email_added=true$/.test(apple.location), `Apple connected (form_post) → ${apple.location}`);
  // The same Google account can't be connected to a second Carbon.
  const d = await signUpCarbon({ accounts, messaging });
  const refused = await d.browser.connectProvider('google', oidc, g.email);
  check(new URL(refused.location).searchParams.get('link_error') === 'identity_in_use', `a second Carbon is refused: ${refused.location}`);
  const flow = await d.browser.flow(refused.flow_id);
  check(flow.step === 'complete' && flow.error?.code === 'identity_in_use' && !!flow.error?.message, 'the flow carries the reason', flow.error);
}

section('interface: managed Google');
{
  const g = await oidc.randomIdentity('google');
  const browser = await newBrowser();
  const r = await providerSignIn('interface', 'google', g.email, browser);
  check(r.flow.step === 'complete', `completes (got ${r.flow.step})`, r.flow);
  const cb: any = await r.fake.callback('interface', r.flow.redirect_to!);
  check(cb.ok === true && cb.account?.display_name === g.name, `interface got the account named "${g.name}" from Google`, cb);
  const reqs = await oidc.requests({ provider: 'google', endpoint: 'authorize' });
  check(reqs[0]?.client_id === creds.managed.google.client_id, 'mock Google saw the managed client_id');
  const me: any = await browser.account().me();
  check(me.identities?.[0]?.provider === 'google', 'the account lists its Google identity', me.identities);
}

section('acme-notes: bring-your-own Google');
{
  const g = await oidc.randomIdentity('google');
  const browser = await newBrowser();
  const r = await providerSignIn('acme-notes', 'google', g.email, browser);
  check(r.flow.step === 'complete', `completes (got ${r.flow.step})`, r.flow);
  const cb: any = await r.fake.callback('acme-notes', r.flow.redirect_to!);
  check(cb.ok === true, 'acme-notes exchanged the code', cb);
  const acme = creds.byo['acme-notes'].google.client_id;
  check((await oidc.requests({ provider: 'google', endpoint: 'authorize' }))[0]?.client_id === acme, "mock Google authorize saw acme's client_id");
  check((await oidc.requests({ provider: 'google', endpoint: 'token' }))[0]?.client_id === acme, "mock Google token saw acme's client_id");
}

section('orbit-games: bring-your-own Apple (form_post as a real browser)');
{
  const a = await oidc.randomIdentity('apple', { name: 'Orbit Player' });
  const browser = await newBrowser();
  const r = await providerSignIn('orbit-games', 'apple', a.email, browser, true);
  check(r.flow.step === 'complete', `completes (got ${r.flow.step})`, r.flow);
  const cb: any = await r.fake.callback('orbit-games', r.flow.redirect_to!);
  check(cb.ok === true, 'orbit-games exchanged the code', cb);
  check((await oidc.requests({ provider: 'apple', endpoint: 'token' }))[0]?.client_id === creds.byo['orbit-games'].apple.services_id, "mock Apple token saw orbit's services id");
}

section('waveform: managed Apple');
{
  const a = await oidc.randomIdentity('apple');
  const browser = await newBrowser();
  const r = await providerSignIn('waveform', 'apple', a.email, browser);
  check(r.flow.step === 'complete', `completes (got ${r.flow.step})`, r.flow);
  const cb: any = await r.fake.callback('waveform', r.flow.redirect_to!);
  check(cb.ok === true, 'waveform exchanged the code', cb);
  check((await oidc.requests({ provider: 'apple', endpoint: 'token' }))[0]?.client_id === creds.managed.apple.services_id, 'mock Apple token saw the managed services id');
}

section('campus-connect: allowed_email_domains [university.test]');
{
  const browser = await newBrowser();
  const s = await startAppSignIn('campus-connect', browser);
  const after = await messaging.lastSeq();
  const res: any = await browser.http.post(`/v1/flows/${s.flow.id}/email`, { json: { email: randomEmail('outsider') } });
  check(res.status === 403 && res.body?.error?.code === 'email_domain_not_allowed', 'an email outside university.test → 403 email_domain_not_allowed', res.body);
  check((await messaging.lastSeq()) === after, 'no code was sent to the outsider');
  let flow = await codeStep(browser, s.flow, { email: randomEmail('student', 'university.test') });
  flow = await driveFlow(browser, flow, { messaging });
  check(flow.step === 'complete', `a university.test email signs up (got ${flow.step})`, flow);
  const g = await oidc.randomIdentity('google');
  const r = await providerSignIn('campus-connect', 'google', g.email, await newBrowser());
  check(r.flow.step !== 'complete' && !!r.flow.error, `a Google identity outside the domain is refused (${r.flow.step}: ${r.flow.error?.code})`, r.flow);
}

section('legacy-crm: allow_signup=false');
{
  const browser = await newBrowser();
  const s = await startAppSignIn('legacy-crm', browser);
  const email = randomEmail('stranger');
  const after = await messaging.lastSeq();
  await browser.email(s.flow.id, email);
  const code = await messaging.waitForCode({ to: email, after });
  const v: any = await browser.verifyRaw(s.flow.id, code);
  check(v.status === 403 && v.body?.error?.code === 'signup_not_allowed', 'a new email → 403 signup_not_allowed', v.body);
}

done();
