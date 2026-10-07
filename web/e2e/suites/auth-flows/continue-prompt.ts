/**
 * "Continue as" and the OIDC prompt values. A signed-in browser signs into a second app in one click (consent the
 * first time only), never where the app turned remember_browser off or after "Use another account"; prompt=login asks
 * again (and moves the id_token's auth_time), prompt=consent shows the what's-shared screen again, prompt=select_account
 * shows the chooser, prompt=none never shows a page (silent code, or login_required / consent_required /
 * interaction_required back at the app).
 */
import type { BrowserContext } from "@playwright/test";
import type { Journey } from "../../context";
import { appAccount, newContext, shot, sleep, tag } from "../../lib";
import {
  Browserish,
  brief,
  drive,
  errorCode,
  errorDetails,
  exchangeCode,
  jwtClaims,
  redirectParams,
  sendCode,
  signInAgain,
  signUpVia,
  startSignIn,
} from "./_helpers";

/** Gives a Playwright context the session cookie of an API-made Carbon (the site's origin). */
async function adoptSession(context: BrowserContext, site: string, b: Browserish): Promise<void> {
  const value = b.jar.get("sa_session");
  if (!value) throw new Error("the API browser has no sa_session cookie to hand over");
  await context.addCookies([{ name: "sa_session", value, url: site, httpOnly: true, sameSite: "Lax" }]);
}

const appUrl = (apps: string, app: string, path = "") => new RegExp(`${apps.replace(/[.:/]/g, "\\$&")}/${app}/${path}`);

const continueAs: Journey = {
  name: "auth-flows-continue-as",
  title: "a signed-in browser: Continue as on a second app (consent once), then one click straight back; never on spacestation (remember_browser off) or after Use another account; continue-as into an app whose domain rule the account fails is refused",
  async run(ctx) {
    const { env, results, browser } = ctx;
    const t = tag();
    const b = new Browserish(env, ctx.ip);
    const email = `one.click.${t}@example.test`;
    await signUpVia(b, "briefcase", email);
    const me = (await b.session())?.account;
    const context = await newContext(browser);
    await adoptSession(context, env.site, b);
    const page = await context.newPage();
    results.watch(page, "continue-as");

    await page.goto(`${env.apps}/commit/`);
    await page.locator("#signin-hosted").click();
    const continueButton = page.getByRole("button", { name: /^Continue as/ });
    await continueButton.waitFor({ timeout: 30_000 });
    await sleep(300);
    await shot(env, page, "auth-flows-continue-as-01");
    const card = (await page.locator("main").innerText()).replace(/\s+/g, " ");
    results.check("commit offers Continue as One (first name) with the c:id, and Use another account", (await continueButton.innerText()).trim() === "Continue as One" && card.includes(me?.id ?? "?") && (await page.getByRole("button", { name: "Use another account" }).count()) === 1, card.slice(0, 200));
    let started = Date.now();
    await continueButton.click();
    const share = page.getByRole("button", { name: "Share and continue" });
    await share.waitFor({ timeout: 20_000 });
    results.check("the first time on commit, consent is asked (commit requires the email)", await share.isVisible());
    await share.click();
    await page.waitForURL(appUrl(env.apps, "commit", "callback"), { timeout: 30_000 });
    results.metric("continue as on a new app, with consent", Date.now() - started);
    const first = await appAccount(page);
    results.check("commit got the same account (uuid) with its email", first?.uuid === me?.uuid && first?.email === email, JSON.stringify(first).slice(0, 200));

    await page.goto(`${env.apps}/commit/`);
    started = Date.now();
    await page.locator("#signin-hosted").click();
    await continueButton.click({ timeout: 30_000 });
    await page.waitForURL(appUrl(env.apps, "commit", "callback"), { timeout: 30_000 });
    const oneClick = Date.now() - started;
    results.metric("one-click continue as (app link → back at the app)", oneClick);
    results.check("the second time: one click straight back, no consent", (await appAccount(page))?.uuid === me?.uuid, `${oneClick} ms`);

    // spacestation turned remember_browser off: no Continue as, the methods instead.
    await page.goto(`${env.apps}/spacestation/`);
    await page.locator("#signin-hosted").click();
    await page.getByRole("textbox", { name: "Email" }).waitFor({ timeout: 30_000 });
    await sleep(300);
    results.check("spacestation (remember_browser off) shows the methods, not Continue as", (await continueButton.count()) === 0);

    // "Use another account" forgets the browser's account for that flow (also after a reload).
    await page.goto(`${env.apps}/briefcase/`);
    await page.locator("#signin-hosted").click();
    await page.getByRole("button", { name: "Use another account" }).click({ timeout: 30_000 });
    await page.getByRole("textbox", { name: "Email" }).waitFor({ timeout: 15_000 });
    await page.reload();
    await page.getByRole("textbox", { name: "Email" }).waitFor({ timeout: 30_000 });
    await sleep(400);
    results.check("after Use another account (and a reload) the flow no longer offers Continue as", (await continueButton.count()) === 0);
    await context.close();

    // The same at the API, plus the refusals.
    const space = await startSignIn(b, "spacestation");
    results.check("API: spacestation's flow offers no account (signed_in_as null)", space.flow.signed_in_as === null, JSON.stringify(space.flow.signed_in_as));
    const forced = await b.act(space.flow.id, "continue");
    results.check("API: continue on spacestation → 403 continue_not_allowed", forced.status === 403 && errorCode(forced) === "continue_not_allowed", brief(forced));
    const campus = await startSignIn(b, "campus-connect");
    results.check("API: campus-connect still offers the account…", campus.flow.signed_in_as?.uuid === me?.uuid);
    const refused = await b.act(campus.flow.id, "continue");
    results.check("…but continuing as it (no university.test email) → 403 email_domain_not_allowed", refused.status === 403 && errorCode(refused) === "email_domain_not_allowed" && JSON.stringify(errorDetails(refused).allowed_domains) === JSON.stringify(["university.test"]), brief(refused));
    const anonymous = new Browserish(env, ctx.ip);
    const nobody = await startSignIn(anonymous, "commit");
    const noSession = await anonymous.act(nobody.flow.id, "continue");
    results.check("API: continue without a browser session → 401 session_required", noSession.status === 401 && errorCode(noSession) === "session_required", brief(noSession));
    const switched = await startSignIn(b, "commit");
    const afterSwitch = await b.act(switched.flow.id, "switch");
    results.check("API: after switch the flow is back at choose_method offering no account (signed_in_as null)", afterSwitch.status === 200 && afterSwitch.body.flow.step === "choose_method" && afterSwitch.body.flow.signed_in_as === null && (await b.flow(switched.flow.id)).body.flow?.signed_in_as === null, brief(afterSwitch));
  },
};

const prompts: Journey = {
  name: "auth-flows-prompt",
  title: "prompt=login (no continue-as, a fresh code, auth_time moves), consent (asked again), select_account (the chooser), none (silent code or login_required / consent_required / interaction_required), invalid prompt values",
  async run(ctx) {
    const { env, results, browser } = ctx;
    const t = tag();
    const b = new Browserish(env, ctx.ip);
    const email = `prompt.${t}@example.test`;

    // A Carbon on quill-docs with openid (so the id_token carries auth_time).
    const signed = await signUpVia(b, "quill-docs", email, { scope: "openid email", optionalScopes: ["email"] });
    const firstTokens = await exchangeCode(env, "quill-docs", signed.code, signed.started.redirectUri, signed.started.verifier);
    const authTime1 = Number(jwtClaims(firstTokens.body.id_token).auth_time);
    results.check("quill-docs (openid) got an id_token with auth_time", firstTokens.status === 200 && authTime1 > 0, brief(firstTokens));
    await sleep(1_200);

    // Continue as: the session's earlier authentication stands.
    const quiet = await signInAgain(b, "quill-docs", { scope: "openid email" });
    const quietTokens = await exchangeCode(env, "quill-docs", quiet.code ?? "", quiet.started.redirectUri, quiet.started.verifier);
    results.check("continue as keeps auth_time (no new authentication)", Number(jwtClaims(quietTokens.body.id_token).auth_time) === authTime1, `${jwtClaims(quietTokens.body.id_token).auth_time} vs ${authTime1}`);

    // prompt=login: no browser account offered, continue refused, a code signs the same account in, auth_time moves.
    const login = await startSignIn(b, "quill-docs", { scope: "openid email", prompt: "login" });
    results.check("prompt=login: the flow offers no browser account", login.flow.step === "choose_method" && login.flow.signed_in_as === null && login.flow.prompt === "login", `${login.flow.step} ${JSON.stringify(login.flow.signed_in_as)}`);
    const sneak = await b.act(login.flow.id, "continue");
    results.check("prompt=login: continue → 403 reauthentication_required", sneak.status === 403 && errorCode(sneak) === "reauthentication_required", brief(sneak));
    const sent = await sendCode(b, login.flow.id, { email });
    const verified = await b.act(login.flow.id, "verify", { code: sent.code ?? "" });
    const loginDone = verified.status === 200 ? await drive(b, verified.body.flow) : null;
    const loginTokens = loginDone ? await exchangeCode(env, "quill-docs", redirectParams(loginDone).get("code") ?? "", login.redirectUri, login.verifier) : null;
    const authTime3 = Number(jwtClaims(loginTokens?.body.id_token).auth_time);
    results.check("prompt=login: the code signs the same account in (no consent: nothing new asked)", loginDone?.step === "complete" && loginTokens?.body.account?.uuid === firstTokens.body.account?.uuid, brief(verified));
    results.check("prompt=login moves auth_time to the new authentication", authTime3 > authTime1, `${authTime3} vs ${authTime1}`);

    // prompt=consent: the screen again although everything was granted, with what was granted before.
    const consent = await startSignIn(b, "quill-docs", { scope: "openid email", prompt: "consent" });
    const consentStep = await b.act(consent.flow.id, "continue");
    results.check("prompt=consent: continue as lands on the consent step", consentStep.status === 200 && consentStep.body.flow.step === "consent", brief(consentStep));
    const cv = consentStep.body.flow?.consent;
    results.check("…showing what was granted before (profile, email) and email pre-checked", (cv?.previously_granted ?? []).includes("email") && (cv?.previously_granted ?? []).includes("profile") && cv?.optional.find(row => row.scope === "email")?.granted === true, JSON.stringify(cv));

    // prompt=select_account: the chooser with the browser's account.
    const select = await startSignIn(b, "interface", { prompt: "select_account" });
    results.check("prompt=select_account: choose_method with the browser's account offered", select.flow.step === "choose_method" && select.flow.signed_in_as?.uuid === firstTokens.body.account?.uuid && select.flow.prompt === "select_account", `${select.flow.step} ${select.flow.prompt}`);

    // prompt=none.
    const anonymous = new Browserish(env, ctx.ip);
    const none1 = await startSignIn(anonymous, "briefcase", { prompt: "none" });
    const r1 = redirectParams(none1.flow);
    results.check("prompt=none, nobody signed in → step failed, redirect error=login_required with the state", none1.reply.status === 201 && none1.flow.step === "failed" && r1.get("error") === "login_required" && r1.get("state") === none1.state && !!r1.get("error_description") && !r1.get("code"), none1.flow.redirect_to ?? "");
    const none2 = await startSignIn(b, "commit", { prompt: "none" });
    results.check("prompt=none, signed in but commit never consented → consent_required", none2.flow.step === "failed" && redirectParams(none2.flow).get("error") === "consent_required", none2.flow.redirect_to ?? "");
    const none3 = await startSignIn(b, "dm", { prompt: "none" });
    results.check("prompt=none, dm requires a phone the account lacks → interaction_required", none3.flow.step === "failed" && redirectParams(none3.flow).get("error") === "interaction_required", none3.flow.redirect_to ?? "");
    const none4 = await startSignIn(b, "campus-connect", { prompt: "none" });
    results.check("prompt=none, campus-connect's domain rule fails → interaction_required", none4.flow.step === "failed" && redirectParams(none4.flow).get("error") === "interaction_required", none4.flow.redirect_to ?? "");
    const none5 = await startSignIn(b, "quill-docs", { prompt: "none", scope: "openid email" });
    const silentCode = redirectParams(none5.flow).get("code");
    results.check("prompt=none, signed in and consented → complete at once with a code", none5.flow.step === "complete" && !!silentCode && redirectParams(none5.flow).get("state") === none5.state, none5.flow.redirect_to ?? "");
    const silentTokens = await exchangeCode(env, "quill-docs", silentCode ?? "", none5.redirectUri, none5.verifier);
    results.check("…and the silent code exchanges for the same account", silentTokens.status === 200 && silentTokens.body.account.uuid === firstTokens.body.account.uuid && jwtClaims(silentTokens.body.id_token).nonce === none5.nonce, brief(silentTokens));
    const read = await b.flow(none1.flow.id);
    results.check("a failed flow is not readable by another browser, and GET on the finished flow repeats redirect_to (idempotent)", read.status === 403 && (await anonymous.flow(none1.flow.id)).body.flow?.redirect_to === none1.flow.redirect_to, brief(read));
    const after = await anonymous.act(none1.flow.id, "email", { email: `late.${t}@example.test` });
    results.check("actions on a failed flow → 409 flow_failed", after.status === 409 && errorCode(after) === "flow_failed", brief(after));

    // Invalid prompt values never redirect anywhere unregistered, but say so to the app.
    const both = await startSignIn(anonymous, "briefcase", { prompt: "none login" });
    const redirect = String(errorDetails(both.reply).redirect_to ?? "");
    results.check("prompt=\"none login\" → 400 invalid_request, with the error redirect to the app's registered URI", both.reply.status === 400 && errorCode(both.reply) === "invalid_request" && redirect.startsWith(both.redirectUri) && new URL(redirect).searchParams.get("error") === "invalid_request" && new URL(redirect).searchParams.get("state") === both.state, brief(both.reply));
    const unknown = await startSignIn(anonymous, "briefcase", { prompt: "sometimes" });
    results.check("prompt=sometimes → 400 invalid_request naming the value", unknown.reply.status === 400 && errorCode(unknown.reply) === "invalid_request" && brief(unknown.reply).includes("sometimes"), brief(unknown.reply));

    // In the browser: prompt=none ends at the app without showing a page.
    const context = await newContext(browser);
    const page = await context.newPage();
    results.watch(page, "prompt-none", [/400 .*\/callback/]);
    await page.goto(`${env.apps}/briefcase/?prompt=none`);
    await page.locator("#signin-hosted").click();
    await page.waitForURL(appUrl(env.apps, "briefcase", "callback"), { timeout: 30_000 });
    results.check("browser, prompt=none and nobody signed in → straight back to briefcase with login_required", (await page.locator("#error-code").innerText().catch(() => "")) === "login_required", page.url());
    await adoptSession(context, env.site, b);
    await page.goto(`${env.apps}/quill-docs/?prompt=none&scope=${encodeURIComponent("openid email")}`);
    await page.locator("#signin-hosted").click();
    await page.waitForURL(appUrl(env.apps, "quill-docs", "callback"), { timeout: 30_000 });
    const silent = await appAccount(page);
    results.check("browser, prompt=none and consented → signed in at quill-docs without a page", silent?.uuid === firstTokens.body.account.uuid, JSON.stringify(silent).slice(0, 160));
    results.check("…its id_token verified by the app (signature, issuer, audience, nonce)", (await page.locator("#id-token-status").getAttribute("data-verified").catch(() => null)) === "true");
    await page.goto(`${env.apps}/interface/?prompt=select_account`);
    await page.locator("#signin-hosted").click();
    await page.getByRole("button", { name: /^Continue as/ }).waitFor({ timeout: 30_000 });
    results.check("browser, prompt=select_account → the chooser (Continue as, Use another account)", (await page.getByRole("button", { name: "Use another account" }).count()) === 1);
    await shot(env, page, "auth-flows-prompt-01-select-account");
    await context.close();
  },
};

export const journeys: Journey[] = [continueAs, prompts];
