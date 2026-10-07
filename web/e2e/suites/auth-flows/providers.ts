/**
 * Google and Apple through the mock providers: what Silicon Accounts asks them for (client ids, PKCE, nonce, state,
 * response modes, prompt, hd), what it accepts back (verified emails only, its own nonce, the browser that started the
 * sign-in), and how an answer becomes an account (a known identity signs in, a verified email of an account links to
 * it, else a sign-up prefilled with the provider's name; Apple's name only on its first authorization).
 */
import type { Page } from "@playwright/test";
import type { Ctx, Journey } from "../../context";
import { appAccount, finishSignup, json, newContext, shot, sleep, sql, tag } from "../../lib";
import {
  Browserish,
  CLIENT_IDS,
  brief,
  deliverAnswer,
  drive,
  errorCode,
  providerAuthorize,
  providerLog,
  redirectParams,
  registerIdentity,
  signUpVia,
  startSignIn,
  type FlowView,
  type Reply,
} from "./_helpers";

/** On the mock provider's chooser: its "to continue to …" name, then "Use another account" with this email and name. */
async function chooseNew(ctx: Ctx, page: Page, email: string, name: string): Promise<string> {
  await page.waitForURL(new RegExp(ctx.env.oidc.replace(/[.:/]/g, "\\$&")), { timeout: 30_000 });
  const shownName = (await page.locator("#client-name").innerText().catch(() => "")).trim();
  await page.locator('#new-identity input[name="_auto"]').fill(email);
  await page.locator('#new-identity input[name="_name"]').fill(name);
  await page.locator('#new-identity button[data-action="use-another"]').click();
  return shownName;
}

/** On the sign-up step: the prefilled display name and the page text (read before "Create account"). */
async function signupPrefill(page: Page): Promise<{ name: string; text: string }> {
  const field = page.getByRole("textbox", { name: "Display name" });
  await field.waitFor({ timeout: 25_000 });
  await sleep(300);
  return { name: await field.inputValue(), text: (await page.locator("main").innerText()).replace(/\s+/g, " ") };
}

/** Starts the provider leg of a flow at the API and plays the browser at the mock provider and back. */
async function providerLeg(b: Browserish, flowId: string, provider: "google" | "apple", select: { email?: string; name?: string; error?: string }) {
  const go = await b.post<{ authorize_url?: string }>(`/v1/flows/${flowId}/oauth/${provider}`);
  const authorizeUrl = go.body?.authorize_url ?? "";
  const outcome = authorizeUrl ? await providerAuthorize(authorizeUrl, select) : null;
  const delivered = outcome && outcome.kind !== "chooser" && outcome.kind !== "error" ? await deliverAnswer(b, outcome) : null;
  const after: Reply<{ flow: FlowView }> | null = delivered?.flowId ? await b.flow(delivered.flowId) : null;
  return { go, authorizeUrl, outcome, delivered, flow: after?.body?.flow ?? null, after };
}

const google: Journey = {
  name: "auth-flows-google",
  title: "managed Google on interface in the browser (what the provider is asked for, the provider's name on the sign-up page), the same identity again in a fresh browser signs straight in",
  async run(ctx) {
    const { env, results, browser } = ctx;
    const t = tag();
    const email = `grace.hopper.${t}@gmail.test`;
    const name = `Grace Hopper ${t}`;
    const context = await newContext(browser);
    const page = await context.newPage();
    results.watch(page, "google");
    await page.goto(`${env.apps}/interface/`);
    await page.locator("#signin-hosted").click();
    await page.getByRole("button", { name: "Continue with Google" }).click({ timeout: 30_000 });
    const chooserName = await chooseNew(ctx, page, email, name);
    results.check("managed Google's consent page names Silicon Accounts (not the app)", chooserName === "Silicon Accounts", chooserName);
    const [authorize] = await providerLog(env, { provider: "google", endpoint: "authorize" });
    const p = authorize?.params ?? {};
    results.check("Google was asked with the managed client id", authorize?.client_id === CLIENT_IDS.managedGoogle, String(authorize?.client_id));
    results.check("…for a code with PKCE S256, a state and a nonce", p.response_type === "code" && p.code_challenge_method === "S256" && p.state_present === true && p.nonce_present === true, JSON.stringify(p));
    results.check("…scope \"openid email profile\", prompt select_account (interface's setup)", p.scope === "openid email profile" && p.prompt === "select_account", JSON.stringify(p));
    results.check("…returning to the site's own callback", p.redirect_uri === `${env.site}/v1/oauth/callback/google`, String(p.redirect_uri));
    const prefill = await signupPrefill(page);
    results.check("the sign-up page is prefilled with the Google name and shows its email", prefill.name === name && prefill.text.includes(email), `${prefill.name} | ${prefill.text.slice(0, 160)}`);
    await finishSignup(env, page, "interface", "auth-flows-google-01");
    const [token] = await providerLog(env, { provider: "google", endpoint: "token" });
    results.check("the code was exchanged with the managed client too", token?.client_id === CLIENT_IDS.managedGoogle && token.outcome !== "error", JSON.stringify(token).slice(0, 300));
    const account = await appAccount(page);
    const uuid = String(account?.uuid ?? "");
    results.check("interface got the account", uuid.length >= 3 && account?.display_name === name, JSON.stringify(account).slice(0, 200));
    const linked = await sql(env, `select provider, client_id, email from identities where account_uuid = '${uuid}'`);
    results.check("the Google identity is linked with the client that proved it", JSON.stringify(linked) === JSON.stringify([["google", CLIENT_IDS.managedGoogle, email]]), JSON.stringify(linked));
    const verified = await sql(env, `select is_primary, verified_at is not null, verified_via from account_emails where account_uuid = '${uuid}'`);
    results.check("its Google email is the primary, verified via google (no code needed)", JSON.stringify(verified) === JSON.stringify([["t", "t", "google"]]), JSON.stringify(verified));
    await context.close();

    // A fresh browser: the same Google identity signs straight in (no sign-up; interface already has its consent).
    const fresh = await newContext(browser);
    const again = await fresh.newPage();
    results.watch(again, "google-again");
    await again.goto(`${env.apps}/interface/`);
    await again.locator("#signin-hosted").click();
    await again.getByRole("button", { name: "Continue with Google" }).click({ timeout: 30_000 });
    await again.waitForURL(new RegExp(env.oidc.replace(/[.:/]/g, "\\$&")), { timeout: 30_000 });
    await again.locator(`button.identity[data-email="${email}"]`).click();
    await again.waitForURL(new RegExp(`${env.apps.replace(/[.:/]/g, "\\$&")}/interface/callback`), { timeout: 30_000 });
    const second = await appAccount(again);
    results.check("the known Google identity signs the same account in, straight back to the app", second?.uuid === uuid, JSON.stringify(second).slice(0, 200));
    const history = await sql(env, `select method, outcome from signin_history where account_uuid = '${uuid}' order by at, id`);
    results.check("history: google/new_account then google/success", JSON.stringify(history) === JSON.stringify([["google", "new_account"], ["google", "success"]]), JSON.stringify(history));
    await fresh.close();

    // method=google: the hosted page opens Google at once, without a click.
    const hinted = await newContext(browser);
    const hp = await hinted.newPage();
    results.watch(hp, "google-method");
    await hp.goto(`${env.apps}/interface/?method=google`);
    const hintedAt = Date.now();
    await hp.locator("#signin-hosted").click();
    await hp.waitForURL(new RegExp(env.oidc.replace(/[.:/]/g, "\\$&")), { timeout: 30_000 }).catch(() => undefined);
    results.check("method=google: the hosted page goes straight to Google's page (no click on the methods)", hp.url().startsWith(env.oidc), hp.url());
    results.metric("method=google: app link → Google's page", Date.now() - hintedAt);
    await hinted.close();
    const api = new Browserish(env, ctx.ip);
    const wrongMethod = await startSignIn(api, "dm", { method: "google" });
    results.check("method=google on dm (no Google) → 400 method_not_enabled with dm's methods, and the redirect back to dm", wrongMethod.reply.status === 400 && (wrongMethod.reply.body as { error?: { code?: string; details?: { methods?: string[]; redirect_to?: string } } }).error?.code === "method_not_enabled" && JSON.stringify((wrongMethod.reply.body as { error?: { details?: { methods?: string[] } } }).error?.details?.methods) === JSON.stringify(["phone", "email"]), JSON.stringify(wrongMethod.reply.body).slice(0, 300));
  },
};

const googleByo: Journey = {
  name: "auth-flows-google-byo",
  title: "acme-notes brings its own Google client: its consent page shows Acme Notes, the authorize and token calls carry acme's client id (never the managed one), and the identity is linked to acme's client",
  async run(ctx) {
    const { env, results, browser } = ctx;
    const t = tag();
    const email = `kat.johnson.${t}@gmail.test`;
    const name = `Katherine Johnson ${t}`;
    const context = await newContext(browser);
    const page = await context.newPage();
    results.watch(page, "acme");
    await page.goto(`${env.apps}/acme-notes/`);
    await page.locator("#signin-hosted").click();
    const button = page.getByRole("button", { name: "Continue with Google" });
    await button.waitFor({ timeout: 30_000 });
    await sleep(300);
    await shot(env, page, "auth-flows-google-byo-01-methods");
    await button.click();
    const chooserName = await chooseNew(ctx, page, email, name);
    results.check("acme's own Google client shows Acme Notes on the provider's page", chooserName === "Acme Notes", chooserName);
    const authorizes = await providerLog(env, { provider: "google", endpoint: "authorize" });
    results.check("the mock saw acme's client id on authorize", authorizes[0]?.client_id === CLIENT_IDS.acmeGoogle, String(authorizes[0]?.client_id));
    await finishSignup(env, page, "acme-notes", "auth-flows-google-byo-02");
    const tokens = await providerLog(env, { provider: "google", endpoint: "token" });
    results.check("the mock saw acme's client id on the token exchange (secret accepted)", tokens[0]?.client_id === CLIENT_IDS.acmeGoogle && tokens[0].outcome !== "error", JSON.stringify(tokens[0]).slice(0, 300));
    const account = await appAccount(page);
    const uuid = String(account?.uuid ?? "");
    results.check("acme-notes got the account with the Google email", account?.email === email, JSON.stringify(account).slice(0, 200));
    const linked = await sql(env, `select client_id from identities where account_uuid = '${uuid}' and provider = 'google'`);
    results.check("the identity is linked with acme's client id", linked[0]?.[0] === CLIENT_IDS.acmeGoogle, JSON.stringify(linked));
    const managedSeen = (await providerLog(env, { provider: "google", client_id: CLIENT_IDS.managedGoogle })).filter(entry => entry.identity?.email === email);
    results.check("the managed client never saw this identity", managedSeen.length === 0, `${managedSeen.length} managed requests`);
    await context.close();

    // At the API: the authorize URL itself.
    const b = new Browserish(env, ctx.ip);
    const s = await startSignIn(b, "acme-notes");
    const go = await b.post<{ authorize_url?: string }>(`/v1/flows/${s.flow.id}/oauth/google`);
    const url = new URL(go.body?.authorize_url ?? "http://invalid.invalid/");
    results.check("acme's authorize URL: its client id, S256, nonce, state bound to the flow", url.searchParams.get("client_id") === CLIENT_IDS.acmeGoogle && url.searchParams.get("code_challenge_method") === "S256" && !!url.searchParams.get("nonce") && (url.searchParams.get("state") ?? "").startsWith(`${s.flow.id}.`), url.toString().slice(0, 200));
    const apple = await b.post(`/v1/flows/${s.flow.id}/oauth/apple`);
    results.check("Apple on acme-notes (not enabled) → 403 method_not_enabled", apple.status === 403 && errorCode(apple) === "method_not_enabled", brief(apple));
    const bogus = await b.post(`/v1/flows/${s.flow.id}/oauth/facebook`);
    results.check("an unknown provider → 404 unknown_provider", bogus.status === 404 && errorCode(bogus) === "unknown_provider", brief(bogus));
  },
};

const googleApi: Journey = {
  name: "auth-flows-google-api",
  title: "Google at the API: an email already on an account links to it (sign-in, not a new account), unverified emails, cancel, provider errors and forged id_tokens are refused on the flow, the answer only works once and only in the browser that started it",
  async run(ctx) {
    const { env, results } = ctx;
    const t = tag();

    // An account made with an email code; Google later proves the same email → the same account, identity linked.
    const owner = new Browserish(env, ctx.ip);
    const ownerEmail = `linked.${t}@example.test`;
    const made = await signUpVia(owner, "briefcase", ownerEmail);
    const uuid = (await owner.session())?.account.uuid ?? "";
    const g = new Browserish(env, ctx.ip);
    const s = await startSignIn(g, "interface");
    await registerIdentity(env, { provider: "google", email: ownerEmail, name: `Someone Else ${t}`, picture: `https://pictures.example.test/${t}.png` });
    const leg = await providerLeg(g, s.flow.id, "google", { email: ownerEmail });
    results.check("Google with the verified email of an account → that account signs in (consent for interface), no sign-up", leg.flow?.step === "consent" && leg.flow.signed_in_as?.uuid === uuid && made.code.length > 0, `${leg.flow?.step} ${leg.flow?.signed_in_as?.uuid} vs ${uuid}`);
    results.check("…the browser got a session for it", (await g.session())?.account.uuid === uuid);
    const identities = await sql(env, `select provider from identities where account_uuid = '${uuid}'`);
    results.check("…and the Google identity is now linked to it", JSON.stringify(identities) === JSON.stringify([["google"]]), JSON.stringify(identities));
    const audit = await sql(env, `select details->>'linked_by' from audit_log where account_uuid = '${uuid}' and action = 'identity.linked'`);
    results.check("…audited as linked_by verified_email", audit[0]?.[0] === "verified_email", JSON.stringify(audit));

    // A new Google identity: sign-up prefilled with its name, its picture offered beside the Iris default.
    const n = new Browserish(env, ctx.ip);
    const ns = await startSignIn(n, "briefcase");
    const fresh = `new.google.${t}@gmail.test`;
    await registerIdentity(env, { provider: "google", email: fresh, name: `Mary Jackson ${t}`, picture: `https://pictures.example.test/mary-${t}.png` });
    const nl = await providerLeg(n, ns.flow.id, "google", { email: fresh });
    const prefill = nl.flow?.signup;
    results.check("a new Google identity → signup prefilled with its name and email", nl.flow?.step === "signup" && prefill?.display_name === `Mary Jackson ${t}` && prefill.email === fresh && prefill.provider === "google", JSON.stringify(prefill));
    results.check("…the Iris default is the photo, the Google picture only offered", prefill?.pfp_url === `${env.iris}/pfp/carbon?id=new` && prefill.provider_pfp_url === `https://pictures.example.test/mary-${t}.png`, JSON.stringify({ pfp: prefill?.pfp_url, provider: prefill?.provider_pfp_url }));
    results.check("…and the sa_signup cookie is set when the browser reads the flow (not at the provider's callback)", !!n.jar.get("sa_signup") && !(nl.delivered?.hops.some(hop => /sa_signup=/.test(hop.headers.get("set-cookie") ?? "")) ?? false));
    const replay = nl.outcome?.kind === "redirect" ? await n.call("GET", nl.outcome.location, { headers: { accept: "text/html" } }) : null;
    results.check("the same Google answer again → 400 invalid_state (an answer works once)", replay?.status === 400 && /data-error="invalid_state"/.test(replay.text), `${replay?.status}`);

    // Unverified email, a cancel, a provider error, a forged id_token: each lands on the flow as its error.
    const cases: Array<{ label: string; setup: () => Promise<unknown>; select: { email?: string; error?: string }; code: string }> = [
      { label: "a Google email the provider has not verified", setup: () => registerIdentity(env, { provider: "google", email: `unverified.${t}@gmail.test`, email_verified: false }), select: { email: `unverified.${t}@gmail.test` }, code: "email_not_verified" },
      { label: "Cancel on Google's page", setup: async () => undefined, select: { error: "access_denied" }, code: "provider_cancelled" },
      { label: "Google's token endpoint failing (500)", setup: () => json(`${env.oidc}/_faults`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: "token", provider: "google", status: 500, error: "server_error", count: 1 }) }), select: { email: `tokenfail.${t}@gmail.test` }, code: "provider_error" },
      { label: "an id_token with another nonce", setup: () => json(`${env.oidc}/_faults`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: "token", provider: "google", id_token: { claims: { nonce: "not-the-flows-nonce" } }, count: 1 }) }), select: { email: `nonce.${t}@gmail.test` }, code: "provider_token_invalid" },
      { label: "an id_token signed with a key outside Google's JWKS", setup: () => json(`${env.oidc}/_faults`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: "token", provider: "google", id_token: { sign_with: "unknown_key" }, count: 1 }) }), select: { email: `forged.${t}@gmail.test` }, code: "provider_token_invalid" },
      { label: "an expired id_token", setup: () => json(`${env.oidc}/_faults`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: "token", provider: "google", id_token: { expired: true }, count: 1 }) }), select: { email: `expired.${t}@gmail.test` }, code: "provider_token_invalid" },
      { label: "an id_token for another audience", setup: () => json(`${env.oidc}/_faults`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: "token", provider: "google", id_token: { claims: { aud: "someone-else" } }, count: 1 }) }), select: { email: `aud.${t}@gmail.test` }, code: "provider_token_invalid" },
    ];
    for (const entry of cases) {
      const cb = new Browserish(env, ctx.ip);
      const cs = await startSignIn(cb, "briefcase");
      await entry.setup();
      const out = await providerLeg(cb, cs.flow.id, "google", entry.select);
      results.check(`${entry.label} → back on the flow at choose_method with ${entry.code}, nobody signed in`, out.flow?.step === "choose_method" && out.flow.error?.code === entry.code && !cb.jar.get("sa_session"), `${out.flow?.step} ${out.flow?.error?.code}: ${out.flow?.error?.message ?? brief(out.after ?? out.go)}`);
    }
    await json(`${env.oidc}/_faults`, { method: "DELETE" });

    // The answer delivered by another browser (a forwarded Google link) is discarded and the flow says why.
    const victim = new Browserish(env, ctx.ip);
    const vs = await startSignIn(victim, "briefcase");
    const go = await victim.post<{ authorize_url?: string }>(`/v1/flows/${vs.flow.id}/oauth/google`);
    const outcome = await providerAuthorize(go.body?.authorize_url ?? "", { email: `elsewhere.${t}@gmail.test` });
    const attacker = new Browserish(env, ctx.ip);
    const elsewhere = outcome.kind === "redirect" ? await attacker.call("GET", outcome.location, { headers: { accept: "text/html" } }) : null;
    results.check("the Google answer opened in another browser → 403 page (flow_not_bound), no session there", elsewhere?.status === 403 && /data-error="flow_not_bound"/.test(elsewhere.text) && !attacker.jar.get("sa_session"), `${elsewhere?.status}`);
    const after = await victim.flow(vs.flow.id);
    results.check("…the starting browser's flow says the answer arrived elsewhere", after.body.flow?.error?.code === "provider_answer_elsewhere" && after.body.flow.step === "choose_method", JSON.stringify(after.body.flow?.error));
    const late = outcome.kind === "redirect" ? await victim.call("GET", outcome.location, { headers: { accept: "text/html" } }) : null;
    results.check("…and the discarded answer can't be replayed in the right browser (400 invalid_state)", late?.status === 400 && /invalid_state/.test(late.text), `${late?.status}`);
    const nostate = await victim.call("GET", `${env.site}/v1/oauth/callback/google?code=x`, { headers: { accept: "application/json" } });
    results.check("a callback without state → 400 invalid_state (JSON when asked)", nostate.status === 400 && errorCode(nostate) === "invalid_state", brief(nostate));
  },
};

const apple: Journey = {
  name: "auth-flows-apple",
  title: "managed Apple on waveform in the browser: form_post back through the site, the first-time name on the sign-up page, Apple's ES256 client secret; at the API the form_post is parked for a same-site GET, the name comes only once, orbit-games uses its own key",
  async run(ctx) {
    const { env, results, browser } = ctx;
    const t = tag();
    const email = `alan.turing.${t}@icloud.test`;
    const name = `Alan Turing ${t}`;
    const context = await newContext(browser);
    const page = await context.newPage();
    results.watch(page, "apple");
    await page.goto(`${env.apps}/waveform/`);
    await page.locator("#signin-hosted").click();
    await page.getByRole("button", { name: "Continue with Apple" }).click({ timeout: 30_000 });
    const chooserName = await chooseNew(ctx, page, email, name);
    results.check("managed Apple names Silicon Accounts", chooserName === "Silicon Accounts", chooserName);
    const prefill = await signupPrefill(page);
    results.check("the sign-up page carries Apple's first-time name (from the form_post's user field) and its email", prefill.name === name && prefill.text.includes(email), `${prefill.name} | ${prefill.text.slice(0, 160)}`);
    await finishSignup(env, page, "waveform", "auth-flows-apple-01");
    const [authorize] = await providerLog(env, { provider: "apple", endpoint: "authorize" });
    const p = authorize?.params ?? {};
    results.check("Apple was asked for code + form_post with scope \"name email\", state and nonce", p.response_type === "code" && p.response_mode === "form_post" && p.scope === "name email" && p.state_present === true && p.nonce_present === true, JSON.stringify(p));
    const [token] = await providerLog(env, { provider: "apple", endpoint: "token" });
    const jwt = token?.client_secret_jwt;
    results.check("the token call's client secret is an ES256 JWT of the managed key (iss = its team_id, sub = services id, aud = Apple)", token?.client_id === CLIENT_IDS.managedApple && jwt?.iss === "MEHY5F7GV2" && jwt.sub === CLIENT_IDS.managedApple && jwt.kid === "141EA2Q4Z8" && jwt.aud === `${env.oidc}/apple`, JSON.stringify(jwt));
    const account = await appAccount(page);
    results.check("waveform got the account named from Apple's first answer", account?.display_name === name, JSON.stringify(account).slice(0, 200));
    await context.close();

    // At the API: the cross-site form_post is parked and continues with a same-site GET; the ticket works once.
    const b = new Browserish(env, ctx.ip);
    const s = await startSignIn(b, "waveform");
    await registerIdentity(env, { provider: "apple", email: `ada.apple.${t}@icloud.test`, given_name: "Ada", family_name: `Byron ${t}` });
    const go = await b.post<{ authorize_url?: string }>(`/v1/flows/${s.flow.id}/oauth/apple`);
    const first = await providerAuthorize(go.body?.authorize_url ?? "", { email: `ada.apple.${t}@icloud.test` });
    results.check("Apple answers with a form_post carrying code, state and the first-time user JSON", first.kind === "form_post" && !!first.fields.code && !!first.fields.state && /"firstName":"Ada"/.test(first.fields.user ?? ""), first.kind === "form_post" ? Object.keys(first.fields).join(",") : first.kind);
    if (first.kind === "form_post") {
      const posted = await b.call("POST", first.action, { form: first.fields, origin: env.oidc, cookies: false, headers: { accept: "text/html" } });
      results.check("the cookie-less cross-site POST → 303 to a same-site GET with a one-time ticket", posted.status === 303 && /\/v1\/oauth\/callback\/apple\?ticket=/.test(posted.location ?? ""), `${posted.status} ${posted.location}`);
      const again = await b.call("POST", first.action, { form: first.fields, origin: env.oidc, cookies: false, headers: { accept: "application/json" } });
      results.check("the same form_post again → 400 invalid_state (already received)", again.status === 400 && errorCode(again) === "invalid_state", brief(again));
      const stranger = new Browserish(env, ctx.ip);
      const stolen = posted.location ? await stranger.call("GET", posted.location, { headers: { accept: "application/json" } }) : null;
      results.check("the ticket opened by another browser → 403 flow_not_bound (and the answer is discarded)", stolen?.status === 403 && errorCode(stolen) === "flow_not_bound", stolen ? brief(stolen) : "no ticket");
      const own = posted.location ? await b.call("GET", posted.location, { headers: { accept: "application/json" } }) : null;
      results.check("…after which the starting browser's ticket is refused too (400 invalid_state)", own?.status === 400 && errorCode(own) === "invalid_state", own ? brief(own) : "no ticket");
    }

    // The name comes once: a second authorization of the same identity carries no user field.
    const c = new Browserish(env, ctx.ip);
    const cs = await startSignIn(c, "waveform");
    const leg = await providerLeg(c, cs.flow.id, "apple", { email: `ada.apple.${t}@icloud.test` });
    const fields = leg.outcome?.kind === "form_post" ? leg.outcome.fields : {};
    results.check("Apple's second authorization of the identity sends no user field", leg.outcome?.kind === "form_post" && fields.user === undefined, Object.keys(fields).join(","));
    results.check("…so the sign-up falls back to a name from the email (Ada Apple <tag>)", leg.flow?.step === "signup" && leg.flow.signup?.display_name === `Ada Apple ${t.charAt(0).toUpperCase()}${t.slice(1)}`, JSON.stringify(leg.flow?.signup?.display_name));
    if (leg.flow?.step === "signup") {
      const done = await drive(c, leg.flow);
      results.check("…and it completes with Apple's verified (\"true\" string) email", done.step === "complete" && !!redirectParams(done).get("code"), done.redirect_to ?? "");
      const verified = await sql(env, `select verified_via from account_emails where email = 'ada.apple.${t}@icloud.test'`);
      results.check("…the email is verified via apple", verified[0]?.[0] === "apple", JSON.stringify(verified));
    }

    // orbit-games brings its own Apple key.
    const o = new Browserish(env, ctx.ip);
    const os = await startSignIn(o, "orbit-games");
    const orbit = await providerLeg(o, os.flow.id, "apple", { email: `mae.orbit.${t}@icloud.test`, name: `Mae Jemison ${t}` });
    const [orbitToken] = await providerLog(env, { provider: "apple", endpoint: "token" });
    results.check("orbit-games: Apple saw its services id and a client secret signed by its own key (team_id 8AZ0EGEDA7, kid D2GZHDQCGA)", orbitToken?.client_id === CLIENT_IDS.orbitApple && orbitToken.client_secret_jwt?.iss === "8AZ0EGEDA7" && orbitToken.client_secret_jwt.kid === "D2GZHDQCGA", JSON.stringify(orbitToken?.client_secret_jwt));
    results.check("…and the flow reached sign-up with Apple's first-time name", orbit.flow?.step === "signup" && orbit.flow.signup?.display_name === `Mae Jemison ${t}`, JSON.stringify(orbit.flow?.signup?.display_name));
  },
};

export const journeys: Journey[] = [google, googleByo, googleApi, apple];
