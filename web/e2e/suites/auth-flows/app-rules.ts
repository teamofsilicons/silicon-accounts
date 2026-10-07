/**
 * The app's rules about who may sign in.
 *
 * campus-connect takes only university.test (`allowed_email_domains`; email codes and Google with its hosted domain):
 * other domains, look-alikes and subdomains are refused before any code is sent, Google must be the university's
 * Workspace, "Continue as" needs a verified university email, and the email added on the way must be at the domain.
 * The documented rule (docs/start/sign-in-config.md "Allowed email domains") is that only Carbons with an email at one
 * of the domains get in, whichever the method; the journey also turns phone sign-in on for campus-connect for a moment
 * (a phone code must not let in an account without a university email) and puts it back.
 *
 * legacy-crm takes no new accounts (`allow_signup: false`): an unknown email or phone is refused after its code with
 * nothing created, existing Carbons sign in, and Carbons it imported finish setting up their account with the
 * imported data.
 */
import type { Journey } from "../../context";
import { codeFor, lastSeq, newContext, shot, sleep, sql, startAtApp, tag } from "../../lib";
import {
  Browserish,
  addDetail,
  asApp,
  brief,
  drive,
  errorCode,
  errorDetails,
  exchangeCode,
  nextCode,
  providerLeg,
  randomPhone,
  redirectParams,
  registerIdentity,
  sendCode,
  signUpVia,
  startSignIn,
  providerLog,
  withSigninConfig,
  type FlowView,
} from "./_helpers";

/** Adds a verified phone to a signed-in API browser's account (the account site's Add a phone number). */
async function addPhoneOnSite(b: Browserish, phone: string): Promise<boolean> {
  const mark = await lastSeq(b.env);
  const start = await b.post<{ challenge_id?: string }>("/v1/me/phones", { phone });
  const code = await nextCode(b.env, phone, mark);
  const done = await b.post("/v1/me/phones/verify", { challenge_id: start.body.challenge_id, code });
  return start.status < 300 && done.status === 200;
}

const domains: Journey = {
  name: "auth-flows-domains",
  title: "campus-connect accepts only university.test: other domains, look-alikes and subdomains are refused before a code is sent, capitals are fine, Google must be the university's Workspace (hd), Continue as needs a university email, an email added on the way must be at the domain; with phone turned on for a moment a phone code must not let other Carbons in",
  async run(ctx) {
    const { env, results, browser } = ctx;
    const t = tag();
    const b = new Browserish(env, ctx.ip);
    const s = await startSignIn(b, "campus-connect");
    for (const [address, why] of [
      [`student.${t}@gmail.test`, "another domain"],
      [`student.${t}@cs.university.test`, "a subdomain"],
      [`student.${t}@university.test.evil.test`, "a look-alike suffix"],
      [`student.${t}@evil-university.test`, "a look-alike prefix"],
    ] as const) {
      const before = await lastSeq(env);
      const reply = await b.act(s.flow.id, "email", { email: address });
      const leaked = await nextCode(env, address, before, 1_500);
      results.check(`${why} (${address.split("@")[1]}) → 403 email_domain_not_allowed, no code sent`, reply.status === 403 && errorCode(reply) === "email_domain_not_allowed" && JSON.stringify(errorDetails(reply).allowed_domains) === JSON.stringify(["university.test"]) && leaked === null, brief(reply));
    }
    const student = `Student.${t}@UNIVERSITY.TEST`;
    const sent = await sendCode(b, s.flow.id, { email: student });
    results.check("the university address in capitals → a code to its lowercase form", sent.reply.status === 200 && !!sent.code, brief(sent.reply));
    const verified = await b.act(s.flow.id, "verify", { code: sent.code ?? "" });
    const done = verified.status === 200 ? await drive(b, verified.body.flow) : null;
    const tokens = done ? await exchangeCode(env, "campus-connect", redirectParams(done).get("code") ?? "", s.redirectUri, s.verifier) : null;
    results.check("…signs up and campus-connect gets the university email", tokens?.status === 200 && tokens.body.account.email === student.toLowerCase(), tokens ? brief(tokens) : brief(verified));

    // Google: the request carries hd; a personal account (no hd claim) is refused, the Workspace one passes.
    const g = new Browserish(env, ctx.ip);
    const gs = await startSignIn(g, "campus-connect");
    const personal = `personal.${t}@university.test`;
    await registerIdentity(env, { provider: "google", email: personal, name: `Personal ${t}` });
    const refusedLeg = await providerLeg(g, gs.flow.id, "google", { email: personal });
    results.check("campus-connect's Google request carries hd=university.test", new URL(refusedLeg.authorizeUrl || "http://x/").searchParams.get("hd") === "university.test", refusedLeg.authorizeUrl.slice(0, 160));
    results.check("a personal Google account (no hd) with a university address → hosted_domain_mismatch on the flow", refusedLeg.flow?.error?.code === "hosted_domain_mismatch" && refusedLeg.flow.step === "choose_method", JSON.stringify(refusedLeg.flow?.error));
    const workspace = `workspace.${t}@university.test`;
    await registerIdentity(env, { provider: "google", email: workspace, name: `Workspace ${t}`, hd: "university.test" });
    const okLeg = await providerLeg(g, gs.flow.id, "google", { email: workspace });
    results.check("the university's Workspace account (hd university.test) → signup", okLeg.flow?.step === "signup" && okLeg.flow.signup?.email === workspace, `${okLeg.flow?.step} ${JSON.stringify(okLeg.flow?.error)}`);
    const [log] = await providerLog(env, { provider: "google", endpoint: "authorize" });
    results.check("the mock saw hd on the authorize request", log?.params.hd === "university.test", JSON.stringify(log?.params));
    const gmailHd = new Browserish(env, ctx.ip);
    const ghs = await startSignIn(gmailHd, "campus-connect");
    const outsider = `outsider.${t}@gmail.test`;
    await registerIdentity(env, { provider: "google", email: outsider, name: `Outsider ${t}`, hd: "university.test" });
    const outsiderLeg = await providerLeg(gmailHd, ghs.flow.id, "google", { email: outsider });
    results.check("a Google account claiming the university's hd but with a gmail.test email → refused (email_domain_not_allowed)", outsiderLeg.flow?.error?.code === "email_domain_not_allowed" && outsiderLeg.flow.step === "choose_method", JSON.stringify(outsiderLeg.flow?.error));

    // A Carbon whose primary email is elsewhere but who also proved a university address may sign in…
    const m = new Browserish(env, ctx.ip);
    const primary = `mixed.${t}@gmail.test`;
    await signUpVia(m, "spacestation", primary);
    const extra = `mixed.${t}@university.test`;
    const mark = await lastSeq(env);
    const add = await m.post<{ challenge_id?: string }>("/v1/me/emails", { email: extra });
    const extraCode = await nextCode(env, extra, mark);
    const added = await m.post("/v1/me/emails/verify", { challenge_id: add.body.challenge_id, code: extraCode });
    results.check("a second, university email is added and verified on the account site", added.status === 200, brief(added));
    const ms = await startSignIn(m, "campus-connect");
    const cont = await m.act(ms.flow.id, "continue");
    results.check("…then Continue as it on campus-connect is allowed (a verified university email): its page", cont.status === 200 && cont.body.flow.step === "details", brief(cont));
    const pageEmail = cont.body.flow?.details?.fields.find(f => f.field === "email")?.value ?? "";
    const mixedDone = cont.status === 200 ? await drive(m, cont.body.flow) : null;
    const mixedTokens = mixedDone ? await exchangeCode(env, "campus-connect", redirectParams(mixedDone).get("code") ?? "", ms.redirectUri, ms.verifier) : null;
    // What the app is given is the documented `email` claim: the account's PRIMARY email (docs/learn/what-apps-see.md,
    // docs/start/oidc.md), and the details page shows exactly that one (masked). The domain rule decides who gets in
    // ("only Carbons with an email at one of your domains"), not which address is shared, so a university member
    // whose primary is elsewhere hands campus-connect that primary. (Reported as a product question, not a failure.)
    const primaryMasked = `${primary[0]}***@gmail.test`;
    results.check(
      "…and is let in: campus-connect is given the account's primary email (the documented email claim), the one its page showed",
      mixedTokens?.status === 200 && mixedTokens.body.account.email === primary && pageEmail === primaryMasked,
      `page shows ${pageEmail}; given ${mixedTokens?.body.account?.email ?? brief(cont)}`,
    );
    // The same Carbon typing its university address: the code proves it, and lets the account in.
    const typed = new Browserish(env, ctx.ip);
    const ts = await startSignIn(typed, "campus-connect");
    const typedSent = await sendCode(typed, ts.flow.id, { email: extra });
    const typedVerified = await typed.act(ts.flow.id, "verify", { code: typedSent.code ?? "" });
    const typedDone = typedVerified.status === 200 ? await drive(typed, typedVerified.body.flow) : null;
    const typedTokens = typedDone ? await exchangeCode(env, "campus-connect", redirectParams(typedDone).get("code") ?? "", ts.redirectUri, ts.verifier) : null;
    results.check(
      "signing in with the university address itself → the same account (no new one), in; the app is given its primary email",
      typedTokens?.status === 200 && typedTokens.body.account.uuid === mixedTokens?.body.account?.uuid && typedTokens.body.account.email === primary,
      `given ${typedTokens?.body.account?.uuid ?? ""} ${typedTokens?.body.account?.email ?? brief(typedVerified)}`,
    );

    // Phone sign-in turned on for campus-connect for a moment (and always put back).
    await withSigninConfig(env, "campus-connect", { methods: { phone: true } }, { methods: { phone: false } }, async () => {
      // An existing Carbon with only a gmail.test email and a phone.
      const p = new Browserish(env, ctx.ip);
      const outsideEmail = `phone.outsider.${t}@gmail.test`;
      await signUpVia(p, "spacestation", outsideEmail);
      const phone = randomPhone();
      results.check("(a Carbon with only gmail.test and a verified phone)", await addPhoneOnSite(p, phone));
      const fresh = new Browserish(env, ctx.ip);
      const fs = await startSignIn(fresh, "campus-connect");
      results.check("(campus-connect now offers phone)", fs.flow.methods.includes("phone"), fs.flow.methods.join(","));
      const phoneSent = await sendCode(fresh, fs.flow.id, { phone });
      const phoneVerified = await fresh.act(fs.flow.id, "verify", { code: phoneSent.code ?? "" });
      let given: string | undefined;
      if (phoneVerified.status === 200 && phoneVerified.body.flow.step !== "choose_method") {
        const bypass = await drive(fresh, phoneVerified.body.flow).catch(() => null);
        const bypassTokens = bypass ? await exchangeCode(env, "campus-connect", redirectParams(bypass).get("code") ?? "", fs.redirectUri, fs.verifier) : null;
        given = bypassTokens?.body.account?.email;
      }
      results.check(
        "a phone code of an account without a university.test email is refused (403 email_domain_not_allowed): the phone must not bypass the domains",
        phoneVerified.status === 403 && errorCode(phoneVerified) === "email_domain_not_allowed",
        `${brief(phoneVerified)}${given !== undefined ? `; the flow went on and campus-connect was given ${given}` : ""}`,
      );
      // A new phone-only Carbon: the required email must be added, and only at the domain.
      const n = new Browserish(env, ctx.ip);
      const ns = await startSignIn(n, "campus-connect");
      const newPhone = randomPhone();
      const ncode = await sendCode(n, ns.flow.id, { phone: newPhone });
      await n.act(ns.flow.id, "verify", { code: ncode.code ?? "" });
      const atPage = await n.act(ns.flow.id, "signup", {});
      if (atPage.body.flow?.step === "details") {
        const gmail = await n.detailsAdd(ns.flow.id, { email: `phone.new.${t}@gmail.test` });
        results.check("a new phone-only Carbon must add the required email on the page, and a gmail.test one → 403 email_domain_not_allowed", gmail.status === 403 && errorCode(gmail) === "email_domain_not_allowed", brief(gmail));
        const uni = await addDetail(n, ns.flow.id, { email: `phone.new.${t}@university.test` });
        const nDone = uni.verified?.status === 200 ? await drive(n, uni.verified.body.flow) : null;
        const nTokens = nDone ? await exchangeCode(env, "campus-connect", redirectParams(nDone).get("code") ?? "", ns.redirectUri, ns.verifier) : null;
        results.check("…a university.test one is added with a code and campus-connect gets it", nTokens?.status === 200 && nTokens.body.account.email === `phone.new.${t}@university.test`, nTokens ? brief(nTokens) : brief(uni.verified ?? uni.sent));
      } else {
        results.check("a new phone-only Carbon must add the required email on the page", false, brief(atPage));
      }
    });
    // With phone and no required email at all: a new phone-only Carbon must not get in without a university email.
    await withSigninConfig(env, "campus-connect", { methods: { phone: true }, required_fields: [] }, { methods: { phone: false }, required_fields: ["email"] }, async () => {
      const q = new Browserish(env, ctx.ip);
      const qs = await startSignIn(q, "campus-connect");
      const qPhone = randomPhone();
      const qcode = await sendCode(q, qs.flow.id, { phone: qPhone });
      const qVerified = await q.act(qs.flow.id, "verify", { code: qcode.code ?? "" });
      let qEnd: FlowView | null = null;
      if (qVerified.status === 200) qEnd = await drive(q, qVerified.body.flow).catch(() => null);
      results.check(
        "campus-connect without a required email: a brand-new phone-only Carbon is not let in without any university.test email",
        qVerified.status === 403 || (qEnd !== null && !redirectParams(qEnd).get("code")),
        qEnd ? `the flow ended at ${qEnd.step} with ${redirectParams(qEnd).get("code") ? "a code" : qEnd.redirect_to}` : brief(qVerified),
      );
    });
    const restored = await asApp<{ signin_config?: { methods?: Record<string, boolean>; required_fields?: string[] } }>(env, "campus-connect", "GET", "/v1/apps/campus-connect");
    results.check("(campus-connect's setup is back: no phone, email required)", restored.body.signin_config?.methods?.phone === false && JSON.stringify(restored.body.signin_config?.required_fields) === '["email"]', JSON.stringify(restored.body.signin_config?.methods));

    // In the browser: the refusal is said under the field, and nothing is sent.
    const context = await newContext(browser);
    const page = await context.newPage();
    // The refused address is the API's 403 (Chromium logs every 4xx a page's fetch gets as a console error).
    results.watch(page, "domains", [/status of 403 .*\/v1\/flows\/[\w-]+\/email/]);
    await startAtApp(env, page, "campus-connect");
    const field = page.getByRole("textbox", { name: "Email" });
    await field.waitFor({ timeout: 30_000 });
    const before = await lastSeq(env);
    await field.fill(`outsider.ui.${t}@gmail.test`);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.getByText(/only accepts email addresses at university\.test/).waitFor({ timeout: 10_000 }).catch(() => undefined);
    await sleep(300);
    await shot(env, page, "auth-flows-domains-01-refused");
    const text = (await page.locator("main").innerText()).replace(/\s+/g, " ");
    results.check("the hosted page says only university.test addresses are accepted, stays on the email field, sends nothing", /only accepts email addresses at university\.test/.test(text) && (await field.isVisible()) && (await nextCode(env, `outsider.ui.${t}@gmail.test`, before, 1_000)) === null, text.slice(0, 300));
    await context.close();
  },
};

const closedSignup: Journey = {
  name: "auth-flows-allow-signup",
  title: "legacy-crm takes no new accounts: an unknown email or phone is refused after its code with nothing created, an existing Carbon signs in (its page), an imported Carbon finishes setting up with the imported data (\"imported by Legacy CRM\") and becomes active; the hosted page says so",
  async run(ctx) {
    const { env, results, browser } = ctx;
    const t = tag();
    const b = new Browserish(env, ctx.ip);
    const s = await startSignIn(b, "legacy-crm");
    const stranger = `stranger.${t}@example.test`;
    const sent = await sendCode(b, s.flow.id, { email: stranger });
    const refused = await b.act(s.flow.id, "verify", { code: sent.code ?? "" });
    results.check("an unknown email → 403 signup_not_allowed after the code", refused.status === 403 && errorCode(refused) === "signup_not_allowed", brief(refused));
    const after = await b.flow(s.flow.id);
    results.check("…the flow is back at choose_method carrying the reason, no sign-up cookie", after.body.flow?.step === "choose_method" && after.body.flow.error?.code === "signup_not_allowed" && !b.jar.get("sa_signup"), JSON.stringify(after.body.flow?.error));
    const nothing = await sql(env, `select (select count(*) from account_emails where email = '${stranger}'), (select count(*) from signup_sessions where verified_email = '${stranger}')`);
    results.check("…and nothing was created (no account, no sign-up session)", JSON.stringify(nothing) === JSON.stringify([["0", "0"]]), JSON.stringify(nothing));
    const phone = randomPhone();
    const sentPhone = await sendCode(b, s.flow.id, { phone });
    const refusedPhone = await b.act(s.flow.id, "verify", { code: sentPhone.code ?? "" });
    results.check("an unknown phone → 403 signup_not_allowed too", refusedPhone.status === 403 && errorCode(refusedPhone) === "signup_not_allowed", brief(refusedPhone));
    const intentSignup = await startSignIn(new Browserish(env, ctx.ip), "legacy-crm", { intent: "signup" });
    results.check("(intent=signup does not change it: the flow starts, the account logic is the same)", intentSignup.reply.status === 201 && intentSignup.flow.intent === "signup", brief(intentSignup.reply));

    // An existing Carbon (made on another app) signs in.
    const existing = `existing.${t}@example.test`;
    await signUpVia(new Browserish(env, ctx.ip), "spacestation", existing);
    const e = new Browserish(env, ctx.ip);
    const es = await startSignIn(e, "legacy-crm");
    const esent = await sendCode(e, es.flow.id, { email: existing });
    const everified = await e.act(es.flow.id, "verify", { code: esent.code ?? "" });
    results.check("an existing Carbon's email → straight to legacy-crm's page (no sign-up)", everified.status === 200 && everified.body.flow.step === "details", brief(everified));
    const edone = everified.status === 200 ? await drive(e, everified.body.flow) : null;
    results.check("…and in with a code", !!redirectParams(edone).get("code"), edone?.redirect_to ?? "");

    // An imported Carbon finishes setting up the account the app made for them.
    const imported = `imported.${t}@example.test`;
    const job = await asApp<{ job?: { id: string } }>(env, "legacy-crm", "POST", "/v1/apps/legacy-crm/imports", { rows: [{ external_id: `crm-${t}`, email: imported, display_name: `Imported Person ${t}`, username: `imported-${t}`, dob: "1980-02-29", timezone: "Europe/London" }], options: {} }, { "idempotency-key": `auth-flows-${t}` });
    let status = "";
    for (let i = 0; i < 75 && job.body.job && status !== "completed" && status !== "failed"; i++) {
      await sleep(200);
      status = (await asApp<{ job?: { status: string } }>(env, "legacy-crm", "GET", `/v1/apps/legacy-crm/imports/${job.body.job.id}`)).body.job?.status ?? "";
    }
    results.check("legacy-crm imports a Carbon (job completed)", job.status === 202 && status === "completed", `${job.status} ${status}`);
    const i = new Browserish(env, ctx.ip);
    const is = await startSignIn(i, "legacy-crm");
    const isent = await sendCode(i, is.flow.id, { email: imported });
    const iverified = await i.act(is.flow.id, "verify", { code: isent.code ?? "" });
    const pre = iverified.body.flow?.signup;
    results.check("the imported Carbon's code → signup marked finishing_import, prefilled from the import, imported by Legacy CRM", iverified.status === 200 && iverified.body.flow.step === "signup" && pre?.finishing_import === true && pre.display_name === `Imported Person ${t}` && pre.id === `c:imported-${t}` && pre.timezone === "Europe/London" && pre.dob === "1980-02-29" && pre.imported_by?.app_id === "legacy-crm" && pre.imported_by.name === "Legacy CRM", JSON.stringify(pre));
    const finished = iverified.status === 200 ? await drive(i, iverified.body.flow) : null;
    const tokens = finished ? await exchangeCode(env, "legacy-crm", redirectParams(finished).get("code") ?? "", is.redirectUri, is.verifier) : null;
    const uuid = tokens?.body.account?.uuid ?? "";
    results.check("…finishing it signs in to legacy-crm with the imported account", tokens?.status === 200 && tokens.body.account.email === imported, tokens ? brief(tokens) : "no flow");
    const state = await sql(env, `select a.status, m.status, m.external_id from accounts a join memberships m on m.account_uuid = a.uuid and m.app_id = 'legacy-crm' where a.uuid = '${uuid}'`);
    results.check("…the account is active and its legacy-crm membership active (external_id kept)", JSON.stringify(state) === JSON.stringify([["active", "active", `crm-${t}`]]), JSON.stringify(state));

    // In the browser: the refusal for a new address, and an imported Carbon's "Finish setup".
    const context = await newContext(browser);
    const page = await context.newPage();
    results.watch(page, "closed", [/status of 403 .*\/v1\/flows\/[\w-]+\/verify/]);
    await startAtApp(env, page, "legacy-crm");
    const field = page.getByRole("textbox", { name: "Email" });
    await field.waitFor({ timeout: 30_000 });
    const newcomer = `newcomer.${t}@example.test`;
    const mark = await lastSeq(env);
    await field.fill(newcomer);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    const code = await codeFor(env, newcomer, mark);
    await page.getByRole("group", { name: /Code from the email/ }).waitFor({ timeout: 15_000 });
    await page.keyboard.type(code, { delay: 25 });
    await page.getByText(/does(n't| not) (take|accept) new accounts/).first().waitFor({ timeout: 15_000 }).catch(() => undefined);
    await sleep(300);
    await shot(env, page, "auth-flows-allow-signup-01");
    const text = (await page.locator("main").innerText()).replace(/\s+/g, " ");
    results.check("the hosted page says legacy-crm takes no new accounts (no sign-up form)", /does(n't| not) (take|accept) new accounts/.test(text) && (await page.getByRole("button", { name: "Create account" }).count()) === 0, text.slice(0, 300));
    await context.close();

    const imported2 = `imported.ui.${t}@example.test`;
    await asApp(env, "legacy-crm", "POST", "/v1/apps/legacy-crm/imports", { rows: [{ external_id: `crm-ui-${t}`, email: imported2, display_name: `Imported Browser ${t}` }], options: {} }, { "idempotency-key": `auth-flows-ui-${t}` });
    let made = false;
    for (let k = 0; k < 75 && !made; k++) {
      await sleep(200);
      made = (await sql(env, `select count(*) from account_emails where email = '${imported2}'`))[0]?.[0] === "1";
    }
    const finish = await newContext(browser);
    const fp = await finish.newPage();
    results.watch(fp, "closed-finish");
    await startAtApp(env, fp, "legacy-crm");
    const f2 = fp.getByRole("textbox", { name: "Email" });
    await f2.waitFor({ timeout: 30_000 });
    const mark2 = await lastSeq(env);
    await f2.fill(imported2);
    await fp.getByRole("button", { name: "Continue", exact: true }).click();
    const code2 = await codeFor(env, imported2, mark2);
    await fp.getByRole("group", { name: /Code from the email/ }).waitFor({ timeout: 15_000 });
    await fp.keyboard.type(code2, { delay: 25 });
    const finishButton = fp.getByRole("button", { name: "Finish setup" });
    const finishing = await finishButton.waitFor({ timeout: 20_000 }).then(() => true, () => false);
    await sleep(300);
    await shot(env, fp, "auth-flows-allow-signup-02-finish");
    const finishText = (await fp.locator("main").innerText()).replace(/\s+/g, " ");
    results.check("an imported Carbon on legacy-crm sees \"Finish setup\" with the imported name, naming Legacy CRM", finishing && finishText.includes("Legacy CRM") && (await fp.getByRole("textbox", { name: "Display name" }).inputValue()) === `Imported Browser ${t}`, finishText.slice(0, 300));
    await finish.close();
  },
};

export const journeys: Journey[] = [domains, closedSignup];
