/**
 * "Continue as" and the OIDC prompt values. A signed-in browser signs into a second app in one click (its details page
 * the first time only), never where the app turned remember_browser off or after "Use another account"; prompt=login
 * asks again (and moves the id_token's auth_time), prompt=consent shows the details page again, prompt=select_account
 * shows the chooser, prompt=none never shows a page (silent code, or login_required / consent_required /
 * interaction_required back at the app).
 */
import type { Journey } from "../../context";
import { appAccount, completeDetails, newContext, shot, sleep, startAtApp, tag } from "../../lib";
import {
  Browserish,
  adoptSession,
  appPage,
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

const continueAs: Journey = {
  name: "auth-flows-continue-as",
  title: "a signed-in browser: Continue as on a second app (its details page once), then one click straight back with timings; never on spacestation (remember_browser off) or after Use another account; continuing into an app whose domain rule the account fails is refused; at the API: continue without a session, switch",
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

    await startAtApp(env, page, "commit");
    const continueButton = page.getByRole("button", { name: /^Continue as/ });
    await continueButton.waitFor({ timeout: 30_000 });
    await sleep(300);
    await shot(env, page, "auth-flows-continue-as-01");
    const card = (await page.locator("main").innerText()).replace(/\s+/g, " ");
    results.check("commit offers \"Continue as One\" (first name) with the c:id, and Use another account", (await continueButton.innerText()).trim() === "Continue as One" && card.includes(me?.id ?? "?") && (await page.getByRole("button", { name: "Use another account" }).count()) === 1, card.slice(0, 200));
    let started = Date.now();
    await continueButton.click();
    const walk = await completeDetails(env, page, "commit");
    results.check("the first time on commit, its details page is shown (commit requires the email)", walk.pages.length === 1 && walk.pages[0]?.rows.some(r => r.field === "email" && r.mode === "required") === true, JSON.stringify(walk.pages.map(p => p.rows)));
    results.metric("continue as on a new app, with its details page", Date.now() - started);
    const first = await appAccount(page);
    results.check("commit got the same account (uuid) with its email", first?.uuid === me?.uuid && first?.email === email, JSON.stringify(first).slice(0, 200));

    await page.goto(`${env.apps}/commit/`);
    started = Date.now();
    await page.locator("#signin-hosted").click();
    await continueButton.click({ timeout: 30_000 });
    await page.waitForURL(appPage(env, "commit", "callback"), { timeout: 30_000 });
    const oneClick = Date.now() - started;
    results.metric("one-click continue as (app link → back at the app)", oneClick);
    results.check("the second time: one click straight back, no page", (await appAccount(page))?.uuid === me?.uuid, `${oneClick} ms`);

    // spacestation turned remember_browser off: no Continue as, the methods instead.
    await startAtApp(env, page, "spacestation");
    await page.getByRole("textbox", { name: "Email" }).waitFor({ timeout: 30_000 });
    await sleep(300);
    results.check("spacestation (remember_browser off) shows the methods, not Continue as", (await continueButton.count()) === 0);

    // "Use another account" forgets the browser's account for that flow (also after a reload).
    await startAtApp(env, page, "briefcase");
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
  title: "prompt=login (no continue-as, a fresh code, auth_time moves), consent (the page again, with what was granted before), select_account (the chooser), none (silent code or login_required / consent_required / interaction_required), invalid prompt values",
  async run(ctx) {
    const { env, results, browser } = ctx;
    const t = tag();
    const b = new Browserish(env, ctx.ip);
    const email = `prompt.${t}@example.test`;

    // A Carbon on quill-docs with openid (so the id_token carries auth_time), sharing its optional email.
    const signed = await signUpVia(b, "quill-docs", email, { scope: "openid email", share: ["email"] });
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
    results.check("prompt=login: the code signs the same account in, straight to complete (nothing new to share)", verified.body.flow?.step === "complete" && loginTokens?.body.account?.uuid === firstTokens.body.account?.uuid, brief(verified));
    results.check("prompt=login moves auth_time to the new authentication", authTime3 > authTime1, `${authTime3} vs ${authTime1}`);

    // prompt=consent: the page again although everything was granted, showing what was granted before.
    const consent = await startSignIn(b, "quill-docs", { scope: "openid email", prompt: "consent" });
    const consentStep = await b.act(consent.flow.id, "continue");
    const shared = consentStep.body.flow?.details?.fields.find(f => f.field === "email");
    results.check("prompt=consent: continue as lands on the details page", consentStep.status === 200 && consentStep.body.flow.step === "details", brief(consentStep));
    results.check("…its optional email previously granted and ticked (shared before)", shared?.previously_granted === true && shared.shared === true && shared.mode === "optional", JSON.stringify(shared));
    const consentDone = await drive(b, consentStep.body.flow);
    results.check("…continuing as it is completes with a code", consentDone.step === "complete" && !!redirectParams(consentDone).get("code"), consentDone.redirect_to ?? "");

    // prompt=select_account: the chooser with the browser's account.
    const select = await startSignIn(b, "interface", { prompt: "select_account" });
    results.check("prompt=select_account: choose_method with the browser's account offered", select.flow.step === "choose_method" && select.flow.signed_in_as?.uuid === firstTokens.body.account?.uuid && select.flow.prompt === "select_account", `${select.flow.step} ${select.flow.prompt}`);

    // prompt=none.
    const anonymous = new Browserish(env, ctx.ip);
    const none1 = await startSignIn(anonymous, "briefcase", { prompt: "none" });
    const r1 = redirectParams(none1.flow);
    results.check("prompt=none, nobody signed in → step failed, redirect error=login_required with the state", none1.reply.status === 201 && none1.flow.step === "failed" && r1.get("error") === "login_required" && r1.get("state") === none1.state && !!r1.get("error_description") && !r1.get("code"), none1.flow.redirect_to ?? "");
    const none2 = await startSignIn(b, "commit", { prompt: "none" });
    results.check("prompt=none, signed in but commit never shown its page → consent_required", none2.flow.step === "failed" && redirectParams(none2.flow).get("error") === "consent_required", none2.flow.redirect_to ?? "");
    const none3 = await startSignIn(b, "dm", { prompt: "none" });
    results.check("prompt=none, dm requires a phone the account lacks → interaction_required", none3.flow.step === "failed" && redirectParams(none3.flow).get("error") === "interaction_required", none3.flow.redirect_to ?? "");
    const none4 = await startSignIn(b, "campus-connect", { prompt: "none" });
    results.check("prompt=none, campus-connect's domain rule fails → interaction_required", none4.flow.step === "failed" && redirectParams(none4.flow).get("error") === "interaction_required", none4.flow.redirect_to ?? "");
    const none5 = await startSignIn(b, "quill-docs", { prompt: "none", scope: "openid email" });
    const silentCode = redirectParams(none5.flow).get("code");
    results.check("prompt=none, signed in and everything granted → complete at once with a code", none5.flow.step === "complete" && !!silentCode && redirectParams(none5.flow).get("state") === none5.state, none5.flow.redirect_to ?? "");
    const silentTokens = await exchangeCode(env, "quill-docs", silentCode ?? "", none5.redirectUri, none5.verifier);
    results.check("…and the silent code exchanges for the same account (its nonce in the id_token)", silentTokens.status === 200 && silentTokens.body.account.uuid === firstTokens.body.account.uuid && jwtClaims(silentTokens.body.id_token).nonce === none5.nonce, brief(silentTokens));
    const none6 = await startSignIn(b, "quill-docs", { prompt: "none", scope: "openid email phone" });
    results.check("prompt=none, the app asks in scope for a detail never granted (phone) → consent_required", none6.flow.step === "failed" && redirectParams(none6.flow).get("error") === "consent_required", none6.flow.redirect_to ?? "");
    const read = await b.flow(none1.flow.id);
    results.check("a failed flow is not readable by another browser, and GET on the finished flow repeats redirect_to", read.status === 403 && (await anonymous.flow(none1.flow.id)).body.flow?.redirect_to === none1.flow.redirect_to, brief(read));
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
    results.watch(page, "prompt-none", [/status of 400 .*\/callback/]);
    await startAtApp(env, page, "briefcase", { extra: { prompt: "none" } });
    await page.waitForURL(appPage(env, "briefcase", "callback"), { timeout: 30_000 });
    results.check("browser, prompt=none and nobody signed in → straight back to briefcase with login_required", (await page.locator("#error-code").innerText().catch(() => "")) === "login_required", page.url());
    await adoptSession(context, env.site, b);
    await startAtApp(env, page, "quill-docs", { extra: { prompt: "none", scope: "openid email" } });
    await page.waitForURL(appPage(env, "quill-docs", "callback"), { timeout: 30_000 });
    const silent = await appAccount(page);
    results.check("browser, prompt=none and everything granted → signed in at quill-docs without a page", silent?.uuid === firstTokens.body.account.uuid, JSON.stringify(silent).slice(0, 160));
    results.check("…its id_token verified by the app (signature, issuer, audience, nonce)", (await page.locator("#id-token-status").getAttribute("data-verified").catch(() => null)) === "true");
    await startAtApp(env, page, "interface", { extra: { prompt: "select_account" } });
    await page.getByRole("button", { name: /^Continue as/ }).waitFor({ timeout: 30_000 });
    results.check("browser, prompt=select_account → the chooser (Continue as, Use another account)", (await page.getByRole("button", { name: "Use another account" }).count()) === 1);
    await shot(env, page, "auth-flows-prompt-01-select-account");
    await page.getByRole("button", { name: /^Continue as/ }).click();
    const walk = await completeDetails(env, page, "interface");
    results.check("…continuing as it shows interface's page the first time, then back at interface", walk.pages.length === 1 && (await appAccount(page))?.uuid === firstTokens.body.account.uuid, JSON.stringify(walk.pages.map(p => p.id)));
    await context.close();
  },
};

export const journeys: Journey[] = [continueAs, prompts];
