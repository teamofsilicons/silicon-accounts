/**
 * How an app starts a sign-in (UNDERSTANDING.md v2 "Adding sign-in to an app"; build spec 06-v2.md §5).
 *
 * - Who types the email or phone number: "An app can never take in a Carbon's email or phone number itself and send
 *   it to us for verification. The Carbon always types it on our pages." A login_hint (or an email/phone parameter) in
 *   the app's link is ignored entirely: not prefilled, not stored, not echoed, nothing sent; the code goes out only when
 *   the Carbon presses Continue on our page, and the app's own page cannot call the code endpoints.
 * - Intents: an app can have "Sign in" and "Sign up" buttons (intent=signin|signup): the hosted pages show the sign-in
 *   or the sign-up version ("Sign in to Briefcase" / "Create your Briefcase account"), the account logic is the same.
 * - Direct method buttons (method=email|phone|google|apple): email/phone open on that empty field with "Other ways to
 *   sign in"; a method the app does not offer is a mistake of the app's link.
 */
import type { Journey } from "../../context";
import { codeFor, completeDetails, hostedTitle, lastSeq, newContext, readFlow, shot, sleep, sql, startAtApp, tag } from "../../lib";
import { Browserish, brief, drive, errorCode, errorDetails, exchangeCode, messagesTo, randomPhone, redirectParams, sendCode, startSignIn } from "./_helpers";

const hinted: Journey = {
  name: "auth-flows-app-entered-contacts",
  title: "an app never sends a Carbon's email or phone: login_hint (and email/phone parameters) with method=email|phone leave the field empty and send nothing; the code goes out when the Carbon presses Continue; at the API a hinted flow sends nothing, never echoes the hint, and the app's own page cannot call the code endpoints",
  async run(ctx) {
    const { env, results, browser } = ctx;
    const t = tag();

    // 1. briefcase's own "Continue with email", with an email the app put in its link (login_hint and email=).
    const email = `hinted.${t}@example.test`;
    const context = await newContext(browser);
    const page = await context.newPage();
    results.watch(page, "app-entry-email");
    const before = await lastSeq(env);
    const href = await startAtApp(env, page, "briefcase", { method: "email", extra: { login_hint: email, email } });
    const field = page.getByRole("textbox", { name: "Email" });
    await field.waitFor({ timeout: 30_000 });
    await sleep(1_500);
    const filled = await field.inputValue();
    await shot(env, page, "auth-flows-app-entry-email");
    results.check("(the app's link did carry login_hint and email)", href.searchParams.get("login_hint") === email && href.searchParams.get("email") === email, href.search.slice(0, 200));
    results.check(
      "an email the app passed (login_hint, email=) is not filled in: the Carbon types the address on our page (UNDERSTANDING: \"The Carbon always types it on our pages\")",
      filled === "",
      `the Email field holds "${filled}"`,
    );
    const flow = await readFlow(page);
    results.check("…the flow (method_hint email) never mentions it", !!flow && flow.method_hint === "email" && !JSON.stringify(flow).includes(email) && !("login_hint" in flow), JSON.stringify(flow).slice(0, 160));
    const early = await messagesTo(env, email, before);
    const challenges = await sql(env, `select count(*) from otp_challenges where destination = '${email}'`);
    results.check("nothing is sent on arrival: no email reached the address and no code challenge exists", early === 0 && challenges[0]?.[0] === "0", `${early} message(s), ${challenges[0]?.[0]} challenge(s)`);
    await field.fill(email);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    const code = await codeFor(env, email, before).catch(() => null);
    results.check("…the code goes out once the Carbon presses Continue on our page", !!code && (await messagesTo(env, email, before)) === 1, `code ${code ? "received" : "missing"}`);
    await context.close();

    // 2. dm's own "Continue with phone number", with a number in the link.
    const phone = randomPhone();
    const phoneContext = await newContext(browser);
    const phonePage = await phoneContext.newPage();
    results.watch(phonePage, "app-entry-phone");
    const beforePhone = await lastSeq(env);
    await startAtApp(env, phonePage, "dm", { method: "phone", extra: { login_hint: phone, phone } });
    const phoneField = phonePage.getByRole("textbox", { name: "Phone number" });
    await phoneField.waitFor({ timeout: 30_000 });
    await sleep(1_500);
    const phoneFilled = await phoneField.inputValue();
    await shot(env, phonePage, "auth-flows-app-entry-phone");
    results.check("a phone number the app passed (login_hint, phone=) is not filled in: the Carbon types it on our page", phoneFilled.replace(/[^\d]/g, "").replace(/^1$/, "") === "", `the Phone number field holds "${phoneFilled}"`);
    const earlyText = await messagesTo(env, phone, beforePhone);
    const phoneChallenges = await sql(env, `select count(*) from otp_challenges where destination = '${phone}'`);
    results.check("nothing is sent on arrival: no text reached the number and no code challenge exists", earlyText === 0 && phoneChallenges[0]?.[0] === "0", `${earlyText} message(s), ${phoneChallenges[0]?.[0]} challenge(s)`);
    await phoneContext.close();

    // 3. At the API: a flow created with an address sends nothing; the app's page cannot ask for a code.
    const b = new Browserish(env, ctx.ip);
    const apiEmail = `hinted.api.${t}@example.test`;
    const beforeApi = await lastSeq(env);
    const started = await startSignIn(b, "briefcase", { loginHint: apiEmail, method: "email", extra: { email: apiEmail, phone } });
    results.check(
      "POST /v1/flows with login_hint, method=email and email/phone fields → a flow waiting at choose_method with no challenge, the hint nowhere in it",
      started.reply.status === 201 && started.flow?.step === "choose_method" && started.flow.challenge === null && !started.reply.text.includes(apiEmail) && !started.reply.text.includes(phone),
      `${started.reply.status} step=${started.flow?.step} challenge=${JSON.stringify(started.flow?.challenge)}`,
    );
    await sleep(500);
    results.check("…and nothing was sent to the address", (await messagesTo(env, apiEmail, beforeApi)) === 0);
    const appOrigin = new URL(env.apps).origin;
    const crossSite = await b.call("POST", `/v1/flows/${started.flow.id}/email`, { json: { email: apiEmail }, origin: appOrigin });
    results.check(`the app's own page (Origin ${appOrigin}) asking for a code in a flow → 403 origin_not_allowed`, crossSite.status === 403 && errorCode(crossSite) === "origin_not_allowed", brief(crossSite));
    const crossSitePhone = await b.call("POST", `/v1/flows/${started.flow.id}/phone`, { json: { phone }, origin: appOrigin });
    results.check("…the same for a text message", crossSitePhone.status === 403 && errorCode(crossSitePhone) === "origin_not_allowed", brief(crossSitePhone));
    const crossCreate = await b.call("POST", "/v1/flows", { json: { app_id: "briefcase", redirect_uri: started.redirectUri, state: "x" }, origin: appOrigin });
    results.check("…and it cannot even create the flow from its page (403 origin_not_allowed): only our /authorize page does", crossCreate.status === 403 && errorCode(crossCreate) === "origin_not_allowed", brief(crossCreate));
    await sleep(500);
    results.check("…and none of it sent anything", (await messagesTo(env, apiEmail, beforeApi)) === 0 && (await messagesTo(env, phone, beforeApi)) === 0);
  },
};

const intents: Journey = {
  name: "auth-flows-intents",
  title: "intent=signup shows the sign-up version (\"Create your Briefcase account\", app copy or the default) and intent=signin the sign-in one; a first time is a sign-up either way and an existing Carbon simply signs in; a bad intent or a method the app lacks is a mistake of the app's link (400, back to the app); method=email|phone open on that field",
  async run(ctx) {
    const { env, results, browser } = ctx;
    const t = tag();
    const context = await newContext(browser);
    const page = await context.newPage();
    // The link mistakes answer 400 (the page shows why and offers "Back to the app").
    results.watch(page, "intents", [/status of 400 .*\/v1\/flows\b/]);

    // The app's "Create an account" button: the sign-up version of the methods page.
    const href = await startAtApp(env, page, "briefcase", { intent: "signup" });
    await page.getByRole("textbox", { name: "Email" }).waitFor({ timeout: 30_000 });
    await sleep(400);
    await shot(env, page, "auth-flows-intents-01-signup");
    const signupTitle = await hostedTitle(page);
    results.check("briefcase's \"Create an account\" link carries intent=signup", href.searchParams.get("intent") === "signup", href.search.slice(0, 160));
    results.check("intent=signup: \"Create your Briefcase account\" (briefcase's copy.signup_title)", signupTitle === "Create your Briefcase account", signupTitle);
    results.check("…and the flow says intent signup", (await readFlow(page))?.intent === "signup", JSON.stringify((await readFlow(page))?.intent));
    // An existing Carbon pressing "Sign up" just signs in (the account logic does not change).
    const existing = `intent.existing.${t}@example.test`;
    const owner = new Browserish(env, ctx.ip);
    const os = await startSignIn(owner, "briefcase");
    const osent = await sendCode(owner, os.flow.id, { email: existing });
    await drive(owner, (await owner.act(os.flow.id, "verify", { code: osent.code ?? "" })).body.flow);
    const after = await lastSeq(env);
    await page.getByRole("textbox", { name: "Email" }).fill(existing);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    const code = await codeFor(env, existing, after);
    await page.getByRole("group", { name: /Code from the email/ }).waitFor({ timeout: 15_000 });
    await page.keyboard.type(code, { delay: 25 });
    const walk = await completeDetails(env, page, "briefcase");
    results.check("an existing Carbon on the sign-up version simply signs in: no sign-up form, no page (already shared), back at briefcase", walk.pages.length === 0 && /\/briefcase\/callback/.test(page.url()), page.url());

    // The sign-in version, and an app without its own sign-up copy (the default words).
    await startAtApp(env, page, "briefcase", { intent: "signup", extra: { intent: "signin" } });
    await page.getByRole("button", { name: "Use another account" }).waitFor({ timeout: 30_000 }).catch(() => undefined);
    results.check("intent=signin: \"Sign in to Briefcase\"", (await hostedTitle(page)) === "Sign in to Briefcase", await hostedTitle(page));
    const fresh = await newContext(browser);
    const p2 = await fresh.newPage();
    results.watch(p2, "intents-default");
    await startAtApp(env, p2, "commit", { intent: "signup" });
    await p2.getByRole("textbox", { name: "Email" }).waitFor({ timeout: 30_000 });
    const commitTitle = await hostedTitle(p2);
    results.check("intent=signup on an app with no sign-up copy (commit): the default \"Create your Commit account\"", commitTitle === "Create your Commit account", commitTitle);
    // A first time on the sign-in version is a sign-up all the same.
    await startAtApp(env, p2, "commit");
    const newcomer = `intent.new.${t}@example.test`;
    const mark = await lastSeq(env);
    await p2.getByRole("textbox", { name: "Email" }).fill(newcomer);
    await p2.getByRole("button", { name: "Continue", exact: true }).click();
    const newCode = await codeFor(env, newcomer, mark);
    await p2.getByRole("group", { name: /Code from the email/ }).waitFor({ timeout: 15_000 });
    await p2.keyboard.type(newCode, { delay: 25 });
    const create = p2.getByRole("button", { name: "Create account" });
    results.check("a first time on the sign-in version is a sign-up all the same (Create account)", await create.waitFor({ timeout: 20_000 }).then(() => true, () => false));
    await fresh.close();

    // Mistakes in the app's link: back to the app with the RFC 6749 error, never a redirect by itself.
    await startAtApp(env, page, "briefcase", { extra: { intent: "register" } });
    const problem = page.locator("[data-problem]");
    await problem.waitFor({ timeout: 30_000 });
    const back = page.getByRole("link", { name: "Back to the app" });
    const backHref = (await back.getAttribute("href").catch(() => null)) ?? "";
    results.check("intent=register → the link's mistake page with \"Back to the app\" (error=invalid_request), staying on /authorize", new URL(page.url()).pathname === "/authorize" && new URL(backHref || "http://x/").searchParams.get("error") === "invalid_request", `${page.url()} | ${backHref}`);
    await startAtApp(env, page, "dm", { extra: { method: "google" } });
    await problem.waitFor({ timeout: 30_000 });
    const dmBack = (await page.getByRole("link", { name: "Back to the app" }).getAttribute("href").catch(() => null)) ?? "";
    results.check("method=google on dm (no Google) → the mistake page, back to dm with error=invalid_request", new URL(dmBack || "http://x/").searchParams.get("error") === "invalid_request" && dmBack.startsWith(`${env.apps}/dm/callback`), dmBack);
    await context.close();

    // At the API.
    const api = new Browserish(env, ctx.ip);
    const bad = await startSignIn(api, "briefcase", { intent: "register" });
    const badRedirect = new URL(String(errorDetails(bad.reply).redirect_to ?? "http://x/"));
    results.check("API: intent=register → 400 invalid_request naming it, with the redirect back to the app", bad.reply.status === 400 && errorCode(bad.reply) === "invalid_request" && brief(bad.reply).includes("register") && badRedirect.searchParams.get("error") === "invalid_request" && badRedirect.searchParams.get("state") === bad.state, brief(bad.reply));
    const wrongMethod = await startSignIn(api, "dm", { method: "google" });
    results.check("API: method=google on dm → 400 method_not_enabled with dm's methods and the redirect back", wrongMethod.reply.status === 400 && errorCode(wrongMethod.reply) === "method_not_enabled" && JSON.stringify(errorDetails(wrongMethod.reply).methods) === JSON.stringify(["phone", "email"]) && String(errorDetails(wrongMethod.reply).redirect_to ?? "").startsWith(wrongMethod.redirectUri), brief(wrongMethod.reply));
    const unknownMethod = await startSignIn(api, "briefcase", { method: "facebook" });
    results.check("API: method=facebook → 400 method_not_enabled", unknownMethod.reply.status === 400 && errorCode(unknownMethod.reply) === "method_not_enabled", brief(unknownMethod.reply));
    const hinted = await startSignIn(api, "briefcase", { method: "phone", intent: "signup" });
    results.check("API: method=phone with intent=signup → the flow keeps both (method_hint phone, intent signup)", hinted.reply.status === 201 && hinted.flow.method_hint === "phone" && hinted.flow.intent === "signup", brief(hinted.reply));
    // A sign-up through intent=signup completes like any other.
    const done = await signupThrough(api, `intent.api.${t}@example.test`);
    results.check("API: a sign-up started with intent=signup ends with a code briefcase can exchange", done.ok, done.detail);
  },
};

/** A new Carbon through briefcase with intent=signup, then the token exchange. */
async function signupThrough(b: Browserish, email: string): Promise<{ ok: boolean; detail: string }> {
  const s = await startSignIn(b, "briefcase", { intent: "signup" });
  const sent = await sendCode(b, s.flow.id, { email });
  const verified = await b.act(s.flow.id, "verify", { code: sent.code ?? "" });
  if (verified.body.flow?.step !== "signup") return { ok: false, detail: `after verify: ${brief(verified)}` };
  const done = await drive(b, verified.body.flow);
  const tokens = await exchangeCode(b.env, "briefcase", redirectParams(done).get("code") ?? "", s.redirectUri, s.verifier);
  return { ok: tokens.status === 200 && tokens.body.account.email === email, detail: brief(tokens) };
}

export const journeys: Journey[] = [hinted, intents];
