/**
 * The app's rules about who may sign in. campus-connect takes only university.test (email codes, Google with its
 * hosted domain, continue-as): other domains, look-alikes and subdomains are refused before any code is sent.
 * legacy-crm takes no new accounts: an unknown email is refused after its code (nothing is created), existing Carbons
 * sign in, and Carbons it imported finish setting up their account with the imported data.
 */
import type { Journey } from "../../context";
import { codeFor, json, lastSeq, newContext, shot, sleep, sql, tag } from "../../lib";
import {
  Browserish,
  brief,
  drive,
  errorCode,
  errorDetails,
  exchangeCode,
  fakeApp,
  nextCode,
  providerAuthorize,
  deliverAnswer,
  providerLog,
  redirectParams,
  registerIdentity,
  sendCode,
  signUpVia,
  startSignIn,
} from "./_helpers";

const domains: Journey = {
  name: "auth-flows-domains",
  title: "campus-connect accepts only university.test: other domains, look-alikes and subdomains are refused before a code is sent, capitals are fine, Google must be the university's Workspace (hd), and what the app is given stays inside its domain",
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
    const go = await g.post<{ authorize_url?: string }>(`/v1/flows/${gs.flow.id}/oauth/google`);
    results.check("campus-connect's Google request carries hd=university.test", new URL(go.body?.authorize_url ?? "http://x/").searchParams.get("hd") === "university.test", go.body?.authorize_url?.slice(0, 120));
    const personal = `personal.${t}@university.test`;
    await registerIdentity(env, { provider: "google", email: personal, name: `Personal ${t}` });
    const outcome = await providerAuthorize(go.body?.authorize_url ?? "", { email: personal });
    const landed = await deliverAnswer(g, outcome);
    const refused = await g.flow(landed.flowId ?? gs.flow.id);
    results.check("a personal Google account (no hd) with a university address → hosted_domain_mismatch on the flow", refused.body.flow?.error?.code === "hosted_domain_mismatch" && refused.body.flow.step === "choose_method", JSON.stringify(refused.body.flow?.error));
    const workspace = `workspace.${t}@university.test`;
    await registerIdentity(env, { provider: "google", email: workspace, name: `Workspace ${t}`, hd: "university.test" });
    const go2 = await g.post<{ authorize_url?: string }>(`/v1/flows/${gs.flow.id}/oauth/google`);
    const ok = await deliverAnswer(g, await providerAuthorize(go2.body?.authorize_url ?? "", { email: workspace }));
    const signup = await g.flow(ok.flowId ?? gs.flow.id);
    results.check("the university's Workspace account (hd university.test) → signup", signup.body.flow?.step === "signup" && signup.body.flow.signup?.email === workspace, `${signup.body.flow?.step} ${JSON.stringify(signup.body.flow?.error)}`);
    const [log] = await providerLog(env, { provider: "google", endpoint: "authorize" });
    results.check("the mock saw hd on the authorize request", log?.params.hd === "university.test", JSON.stringify(log?.params));

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
    results.check("…then continue as it on campus-connect is allowed (a verified university email)", cont.status === 200 && cont.body.flow.step === "consent", brief(cont));
    const mixedDone = cont.status === 200 ? await drive(m, cont.body.flow) : null;
    const mixedTokens = mixedDone ? await exchangeCode(env, "campus-connect", redirectParams(mixedDone).get("code") ?? "", ms.redirectUri, ms.verifier) : null;
    results.check("…and campus-connect is given an email inside its allowed domain (not the gmail.test primary)", mixedTokens?.status === 200 && (mixedTokens.body.account.email ?? "").endsWith("@university.test"), `given ${mixedTokens?.body.account?.email ?? brief(cont)}`);
    // The same Carbon typing its university address: the code proves it, the app is still given the primary.
    const typed = new Browserish(env, ctx.ip);
    const ts = await startSignIn(typed, "campus-connect");
    const typedSent = await sendCode(typed, ts.flow.id, { email: extra });
    const typedVerified = await typed.act(ts.flow.id, "verify", { code: typedSent.code ?? "" });
    const typedDone = typedVerified.status === 200 ? await drive(typed, typedVerified.body.flow) : null;
    const typedTokens = typedDone ? await exchangeCode(env, "campus-connect", redirectParams(typedDone).get("code") ?? "", ts.redirectUri, ts.verifier) : null;
    results.check("signing in with the university address itself → campus-connect is given that address", typedTokens?.status === 200 && typedTokens.body.account.email === extra, `given ${typedTokens?.body.account?.email ?? brief(typedVerified)}`);

    // In the browser: the refusal is said under the field, and nothing is sent.
    const context = await newContext(browser);
    const page = await context.newPage();
    // The refused address is the API's 403 (Chromium logs every 4xx a page's fetch gets as a console error).
    results.watch(page, "domains", [/status of 403 .*\/v1\/flows\/[\w-]+\/email/]);
    await page.goto(`${env.apps}/campus-connect/`);
    await page.locator("#signin-hosted").click();
    const field = page.getByRole("textbox", { name: "Email" });
    await field.waitFor({ timeout: 30_000 });
    await field.fill(`outsider.${t}@gmail.test`);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.getByText(/only accepts email addresses at university\.test/).waitFor({ timeout: 10_000 }).catch(() => undefined);
    await sleep(300);
    await shot(env, page, "auth-flows-domains-01-refused");
    const text = (await page.locator("main").innerText()).replace(/\s+/g, " ");
    results.check("the hosted page says only university.test addresses are accepted, and stays on the email field", /only accepts email addresses at university\.test/.test(text) && (await field.isVisible()), text.slice(0, 300));
    await context.close();
  },
};

const closedSignup: Journey = {
  name: "auth-flows-allow-signup",
  title: "legacy-crm takes no new accounts: an unknown email or phone is refused after its code with nothing created, an existing Carbon signs in, an imported Carbon finishes setting up with the imported data and becomes active",
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
    const phone = `+1206555${String(Math.floor(1000 + Math.random() * 8999))}`;
    const sentPhone = await sendCode(b, s.flow.id, { phone });
    const refusedPhone = await b.act(s.flow.id, "verify", { code: sentPhone.code ?? "" });
    results.check("an unknown phone → 403 signup_not_allowed too", refusedPhone.status === 403 && errorCode(refusedPhone) === "signup_not_allowed", brief(refusedPhone));

    // An existing Carbon (made on another app) signs in.
    const existing = `existing.${t}@example.test`;
    await signUpVia(new Browserish(env, ctx.ip), "spacestation", existing);
    const e = new Browserish(env, ctx.ip);
    const es = await startSignIn(e, "legacy-crm");
    const esent = await sendCode(e, es.flow.id, { email: existing });
    const everified = await e.act(es.flow.id, "verify", { code: esent.code ?? "" });
    results.check("an existing Carbon's email → straight to consent (no sign-up)", everified.status === 200 && everified.body.flow.step === "consent", brief(everified));

    // An imported Carbon finishes setting up the account the app made for them.
    const imported = `imported.${t}@example.test`;
    const crm = fakeApp("legacy-crm");
    const job = await json<{ job?: { id: string } }>(`${env.site}/v1/apps/legacy-crm/imports`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Basic ${Buffer.from(`legacy-crm:${crm.secret}`).toString("base64")}`, "idempotency-key": `auth-flows-${t}` },
      body: JSON.stringify({ rows: [{ external_id: `crm-${t}`, email: imported, display_name: `Imported Person ${t}`, username: `imported-${t}`, dob: "1980-02-29", timezone: "Europe/London" }], options: {} }),
    });
    let status = "";
    for (let i = 0; i < 50 && job.body.job && status !== "completed" && status !== "failed"; i++) {
      await sleep(200);
      status = (await json<{ job?: { status: string } } & { status?: string }>(`${env.site}/v1/apps/legacy-crm/imports/${job.body.job.id}`, { headers: { authorization: `Basic ${Buffer.from(`legacy-crm:${crm.secret}`).toString("base64")}` } })).body.job?.status ?? "";
    }
    results.check("legacy-crm imports a Carbon (job completed)", job.status === 202 && status === "completed", `${job.status} ${status}`);
    const i = new Browserish(env, ctx.ip);
    const is = await startSignIn(i, "legacy-crm");
    const isent = await sendCode(i, is.flow.id, { email: imported });
    const iverified = await i.act(is.flow.id, "verify", { code: isent.code ?? "" });
    const pre = iverified.body.flow?.signup;
    results.check("the imported Carbon's code → signup marked finishing_import, prefilled from the import", iverified.status === 200 && iverified.body.flow.step === "signup" && pre?.finishing_import === true && pre.display_name === `Imported Person ${t}` && pre.id === `c:imported-${t}` && pre.timezone === "Europe/London" && pre.dob === "1980-02-29", JSON.stringify(pre));
    const finished = iverified.status === 200 ? await drive(i, iverified.body.flow) : null;
    const tokens = finished ? await exchangeCode(env, "legacy-crm", redirectParams(finished).get("code") ?? "", is.redirectUri, is.verifier) : null;
    const uuid = tokens?.body.account?.uuid ?? "";
    results.check("…finishing it signs in to legacy-crm with the same (imported) uuid", tokens?.status === 200 && tokens.body.account.email === imported, tokens ? brief(tokens) : "no flow");
    const state = await sql(env, `select a.status, m.status, m.external_id from accounts a join memberships m on m.account_uuid = a.uuid and m.app_id = 'legacy-crm' where a.uuid = '${uuid}'`);
    results.check("…the account is active and its legacy-crm membership active (external_id kept)", JSON.stringify(state) === JSON.stringify([["active", "active", `crm-${t}`]]), JSON.stringify(state));

    // In the browser: the refusal for a new address.
    const context = await newContext(browser);
    const page = await context.newPage();
    results.watch(page, "closed", [/status of 403 .*\/v1\/flows\/[\w-]+\/verify/]);
    await page.goto(`${env.apps}/legacy-crm/`);
    await page.locator("#signin-hosted").click();
    const field = page.getByRole("textbox", { name: "Email" });
    await field.waitFor({ timeout: 30_000 });
    const newcomer = `newcomer.${t}@example.test`;
    const mark = await lastSeq(env);
    await field.fill(newcomer);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    const code = await codeFor(env, newcomer, mark);
    await page.getByRole("group", { name: /Code from the email/ }).waitFor({ timeout: 15_000 });
    await page.keyboard.type(code, { delay: 25 });
    await page.getByText("This app does not take new accounts").waitFor({ timeout: 15_000 }).catch(() => undefined);
    await sleep(300);
    await shot(env, page, "auth-flows-allow-signup-01");
    const text = (await page.locator("main").innerText()).replace(/\s+/g, " ");
    results.check("the hosted page says legacy-crm takes no new accounts (no sign-up form)", /does not take new accounts|doesn't accept new accounts/.test(text) && (await page.getByRole("button", { name: "Create account" }).count()) === 0, text.slice(0, 300));
    await context.close();
  },
};

export const journeys: Journey[] = [domains, closedSignup];
