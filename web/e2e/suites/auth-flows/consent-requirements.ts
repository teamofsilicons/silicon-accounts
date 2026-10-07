/**
 * What's shared with the app. Consent: required details locked on, optional ones toggled (the toggle decides what the
 * app gets, and a later consent replaces the grant), asked again when the app asks for more, Cancel sends
 * access_denied and grants nothing. Requirements: a detail the app requires and the account lacks is added with a code
 * before consent (dm: phone; ledgerly: phone + dob, where dob always exists), refusing addresses of other accounts.
 */
import type { BrowserContext } from "@playwright/test";
import type { Journey } from "../../context";
import { appAccount, codeFor, lastSeq, newContext, shot, sleep, sql, tag } from "../../lib";
import {
  Browserish,
  brief,
  drive,
  errorCode,
  errorDetails,
  exchangeCode,
  nextCode,
  randomPhone,
  redirectParams,
  sendCode,
  signUpVia,
  startSignIn,
} from "./_helpers";

async function adoptSession(context: BrowserContext, site: string, b: Browserish): Promise<void> {
  await context.addCookies([{ name: "sa_session", value: b.jar.get("sa_session") ?? "", url: site, httpOnly: true, sameSite: "Lax" }]);
}

const appUrl = (apps: string, app: string, path = "") => new RegExp(`${apps.replace(/[.:/]/g, "\\$&")}/${app}/${path}`);

const tokenScope = async (page: import("@playwright/test").Page) => ((JSON.parse((await page.locator("#token").innerText().catch(() => "{}")) || "{}") as { scope?: string }).scope ?? "").split(" ").sort().join(" ");

const consent: Journey = {
  name: "auth-flows-consent",
  title: "briefcase's what's-shared screen: email required and locked, timezone optional and off; toggling it on shares it, prompt=consent toggling it off takes it back, Cancel sends access_denied; at the API: requested scopes pre-check, asking for more shows the screen again, bad optional scopes are refused",
  async run(ctx) {
    const { env, results, browser } = ctx;
    const t = tag();
    const b = new Browserish(env, ctx.ip);
    const email = `consent.${t}@example.test`;
    await signUpVia(b, "spacestation", email, { timezone: "Europe/Berlin" });
    const context = await newContext(browser);
    await adoptSession(context, env.site, b);
    const page = await context.newPage();
    // Cancel ends at briefcase's error page, which answers 400 (the fake app's way of saying access_denied).
    results.watch(page, "consent", [/status of 400 .*\/briefcase\/callback\?error=access_denied/]);

    await page.goto(`${env.apps}/briefcase/`);
    await page.locator("#signin-hosted").click();
    await page.getByRole("button", { name: /^Continue as/ }).click({ timeout: 30_000 });
    const list = page.getByRole("list", { name: "Details shared with Briefcase" });
    await list.waitFor({ timeout: 20_000 });
    await sleep(300);
    await shot(env, page, "auth-flows-consent-01");
    const required = await list.locator("li[data-required]").evaluateAll(rows => rows.map(row => row.getAttribute("data-scope")));
    const optional = await list.locator("li[data-optional]").evaluateAll(rows => rows.map(row => row.getAttribute("data-scope")));
    results.check("required rows: profile and email (locked); optional: timezone", JSON.stringify(required) === JSON.stringify(["profile", "email"]) && JSON.stringify(optional) === JSON.stringify(["timezone"]), `${required.join(",")} | ${optional.join(",")}`);
    const tz = page.getByRole("switch", { name: /Timezone/ });
    results.check("the timezone switch starts off", (await tz.getAttribute("aria-checked")) === "false");
    results.check("the timezone row shows the account's timezone", /Berlin/.test(await list.innerText()), (await list.innerText()).replace(/\s+/g, " "));
    await tz.click();
    results.check("…and turns on when toggled", (await tz.getAttribute("aria-checked")) === "true");
    await page.getByRole("button", { name: "Share and continue" }).click();
    await page.waitForURL(appUrl(env.apps, "briefcase", "callback"), { timeout: 30_000 });
    const shared = await appAccount(page);
    results.check("briefcase got the timezone it was allowed (Europe/Berlin) and the email", shared?.timezone === "Europe/Berlin" && shared?.email === email, JSON.stringify(shared).slice(0, 300));
    results.check("…and the scope says so (email profile timezone)", (await tokenScope(page)) === "email profile timezone", await tokenScope(page));

    // prompt=consent: the switch starts on (granted before); turning it off replaces the grant.
    await page.goto(`${env.apps}/briefcase/?prompt=consent`);
    await page.locator("#signin-hosted").click();
    await page.getByRole("button", { name: /^Continue as/ }).click({ timeout: 30_000 });
    await tz.waitFor({ timeout: 20_000 });
    results.check("prompt=consent shows the screen again with timezone on (granted before)", (await tz.getAttribute("aria-checked")) === "true");
    await tz.click();
    await page.getByRole("button", { name: "Share and continue" }).click();
    await page.waitForURL(appUrl(env.apps, "briefcase", "callback"), { timeout: 30_000 });
    const narrowed = await appAccount(page);
    results.check("switching timezone off takes it back: briefcase no longer gets it", narrowed !== null && !("timezone" in narrowed) && (await tokenScope(page)) === "email profile", `${await tokenScope(page)} ${JSON.stringify(narrowed).slice(0, 200)}`);
    const grant = await sql(env, `select array_to_string(granted_scopes, ' ') from memberships where app_id = 'briefcase' and account_uuid = '${String(narrowed?.uuid)}'`);
    results.check("the membership's grant was replaced (email profile)", grant[0]?.[0]?.split(" ").sort().join(" ") === "email profile", JSON.stringify(grant));

    // Cancel: back to the app with access_denied (and the state), nothing new granted.
    await page.goto(`${env.apps}/briefcase/?prompt=consent`);
    await page.locator("#signin-hosted").click();
    await page.getByRole("button", { name: /^Continue as/ }).click({ timeout: 30_000 });
    await page.getByRole("button", { name: "Cancel" }).click({ timeout: 20_000 });
    await page.waitForURL(appUrl(env.apps, "briefcase", "callback"), { timeout: 30_000 });
    results.check("Cancel → briefcase gets error=access_denied", (await page.locator("#error-code").innerText().catch(() => "")) === "access_denied", page.url());
    await context.close();

    // At the API.
    const c = new Browserish(env, ctx.ip);
    const fresh = await startSignIn(c, "briefcase", { scope: "email timezone" });
    const sent = await sendCode(c, fresh.flow.id, { email: `api.consent.${t}@example.test` });
    let flow = (await c.act(fresh.flow.id, "verify", { code: sent.code ?? "" })).body.flow;
    flow = (await c.act(flow.id, "signup", {})).body.flow;
    results.check("a new account lands on consent", flow.step === "consent", flow.step);
    results.check("timezone asked for in scope → its optional row starts granted", flow.consent?.optional.find(row => row.scope === "timezone")?.granted === true, JSON.stringify(flow.consent?.optional));
    const badScope = await c.act(flow.id, "consent", { approve: true, optional_scopes: ["phone"] });
    results.check("optional_scopes with phone (not optional for briefcase) → 422 naming optional_scopes[0]", badScope.status === 422 && typeof ((errorDetails(badScope).fields ?? {}) as Record<string, string>)["optional_scopes[0]"] === "string", brief(badScope));
    const junk = await c.act(flow.id, "consent", { approve: true, optional_scopes: ["timezone", "superuser"] });
    results.check("an unknown scope (superuser) → 422 naming optional_scopes[1]", junk.status === 422 && typeof ((errorDetails(junk).fields ?? {}) as Record<string, string>)["optional_scopes[1]"] === "string", brief(junk));
    const declined = await c.act(flow.id, "consent", { approve: false });
    const d = redirectParams(declined.body.flow);
    results.check("decline → complete with error=access_denied and the state, no code", declined.status === 200 && declined.body.flow.step === "complete" && d.get("error") === "access_denied" && d.get("state") === fresh.state && !d.get("code"), declined.body.flow?.redirect_to ?? "");
    const uuid = (await c.session())?.account.uuid ?? "";
    const membership = await sql(env, `select count(*) from memberships where app_id = 'briefcase' and account_uuid = '${uuid}'`);
    results.check("…and no membership was made for briefcase", membership[0]?.[0] === "0", JSON.stringify(membership));
    const history = await sql(env, `select method, outcome from signin_history where account_uuid = '${uuid}' and app_id = 'briefcase'`);
    results.check("…the decline is in the sign-in history as failed", JSON.stringify(history) === JSON.stringify([["session", "failed"]]) || JSON.stringify(history) === JSON.stringify([["email", "failed"]]), JSON.stringify(history));
    const replay = await c.act(flow.id, "consent", { approve: true });
    results.check("consent again on the finished flow → 409 flow_completed", replay.status === 409 && errorCode(replay) === "flow_completed", brief(replay));

    // Granted email only; the app later asks for timezone too → the screen again (no prompt needed).
    const first = await startSignIn(c, "briefcase");
    const firstDone = await drive(c, first.flow, { optionalScopes: [] });
    results.check("approving with no optional scopes completes", firstDone.step === "complete" && !!redirectParams(firstDone).get("code"));
    const more = await startSignIn(c, "briefcase", { scope: "timezone" });
    const moreStep = await c.act(more.flow.id, "continue");
    results.check("asking for timezone later → consent again, with email granted before and timezone new", moreStep.body.flow?.step === "consent" && (moreStep.body.flow.consent?.previously_granted ?? []).includes("email") && !(moreStep.body.flow.consent?.previously_granted ?? []).includes("timezone"), JSON.stringify(moreStep.body.flow?.consent));
    const moreDone = await drive(c, moreStep.body.flow, { optionalScopes: ["timezone"] });
    const tokens = await exchangeCode(env, "briefcase", redirectParams(moreDone).get("code") ?? "", more.redirectUri, more.verifier);
    results.check("approved → the token's scope and account include the timezone", tokens.status === 200 && tokens.body.scope.split(" ").includes("timezone") && typeof tokens.body.account.timezone === "string", brief(tokens));
    const same = await startSignIn(c, "briefcase", { scope: "timezone" });
    const sameStep = await c.act(same.flow.id, "continue");
    results.check("asking for the same again → no consent screen (complete)", sameStep.body.flow?.step === "complete", sameStep.body.flow?.step);
  },
};

const requirements: Journey = {
  name: "auth-flows-requirements",
  title: "ledgerly requires phone + dob: the requirements step asks only for the phone (dob exists), consent then shows both and the app gets them; dm's phone at the API: other accounts' numbers refused, wrong codes counted, a number added elsewhere moves the flow on",
  async run(ctx) {
    const { env, results, browser } = ctx;
    const t = tag();
    const b = new Browserish(env, ctx.ip);
    const email = `needs.${t}@example.test`;
    await signUpVia(b, "spacestation", email, { signup: { dob: "1994-03-14" } });
    const context = await newContext(browser);
    await adoptSession(context, env.site, b);
    const page = await context.newPage();
    results.watch(page, "requirements");
    await page.goto(`${env.apps}/ledgerly/`);
    await page.locator("#signin-hosted").click();
    await page.getByRole("button", { name: /^Continue as/ }).click({ timeout: 30_000 });
    const phoneField = page.getByRole("textbox", { name: "Phone number" });
    await phoneField.waitFor({ timeout: 20_000 });
    await sleep(300);
    await shot(env, page, "auth-flows-requirements-01");
    const flowId = new URL(page.url()).pathname.split("/").pop() ?? "";
    const view = (await (await page.request.get(`${env.site}/v1/flows/${flowId}`)).json()) as { flow?: { step?: string; requirements?: { missing?: string[] } } };
    const heading = page.getByRole("heading", { name: "Add your phone number" });
    results.check("ledgerly's requirements step asks for the phone only (the dob is always there)", view.flow?.step === "requirements" && JSON.stringify(view.flow.requirements?.missing) === '["phone"]' && (await heading.isVisible()), JSON.stringify(view.flow?.requirements));
    const number = randomPhone();
    const after = await lastSeq(env);
    await phoneField.click();
    await page.keyboard.type(number, { delay: 25 });
    await page.getByRole("button", { name: "Send code" }).click();
    const code = await codeFor(env, number, after);
    await page.getByRole("group", { name: /Code/ }).first().waitFor({ timeout: 15_000 });
    await page.keyboard.type(code, { delay: 25 });
    const list = page.getByRole("list", { name: "Details shared with Ledgerly" });
    await list.waitFor({ timeout: 20_000 });
    const required = await list.locator("li[data-required]").evaluateAll(rows => rows.map(row => row.getAttribute("data-scope")));
    results.check("consent then shows profile, phone and dob as required", JSON.stringify(required) === JSON.stringify(["profile", "phone", "dob"]), required.join(","));
    await page.getByRole("button", { name: "Share and continue" }).click();
    await page.waitForURL(appUrl(env.apps, "ledgerly", "callback"), { timeout: 30_000 });
    const got = await appAccount(page);
    results.check("ledgerly got the verified phone and the dob", got?.phone === number && got?.phone_verified === true && got?.dob === "1994-03-14", JSON.stringify(got).slice(0, 300));
    const primary = await sql(env, `select is_primary, verified_via from account_phones where phone = '${number}'`);
    results.check("the phone became the account's primary (it had none), verified by code", JSON.stringify(primary) === JSON.stringify([["t", "code"]]), JSON.stringify(primary));
    await context.close();

    // dm at the API.
    const c = new Browserish(env, ctx.ip);
    await signUpVia(c, "spacestation", `dm.needs.${t}@example.test`);
    const s = await startSignIn(c, "dm");
    const atReq = await c.act(s.flow.id, "continue");
    results.check("dm: continue as → requirements, missing [phone]", atReq.body.flow?.step === "requirements" && JSON.stringify(atReq.body.flow.requirements?.missing) === JSON.stringify(["phone"]), brief(atReq));
    const notNeeded = await c.act(s.flow.id, "requirements/email", { email: `extra.${t}@example.test` });
    results.check("adding an email dm does not require → 409 requirement_not_needed", notNeeded.status === 409 && errorCode(notNeeded) === "requirement_not_needed", brief(notNeeded));
    const noCode = await c.act(s.flow.id, "requirements/verify", { code: "123456" });
    results.check("verifying before any code was sent → 409 no_code_sent", noCode.status === 409 && errorCode(noCode) === "no_code_sent", brief(noCode));
    const consentEarly = await c.act(s.flow.id, "consent", { approve: true });
    results.check("consent while the phone is missing → 409 invalid_step (still at requirements)", consentEarly.status === 409 && errorCode(consentEarly) === "invalid_step", brief(consentEarly));
    const taken = await c.act(s.flow.id, "requirements/phone", { phone: number });
    results.check("another account's phone → 409 phone_in_use, no code sent", taken.status === 409 && errorCode(taken) === "phone_in_use", brief(taken));
    const mine = randomPhone();
    let mark = await lastSeq(env);
    const sent = await c.act(s.flow.id, "requirements/phone", { phone: mine });
    const first = await nextCode(env, mine, mark);
    results.check("a free number → a code by SMS, the challenge on the requirements view", sent.status === 200 && !!first && sent.body.flow.requirements?.challenge?.channel === "phone", brief(sent));
    const wrong = await c.act(s.flow.id, "requirements/verify", { code: first === "000000" ? "111111" : "000000" });
    results.check("a wrong requirement code → 422 invalid_code with 9 tries left", wrong.status === 422 && errorCode(wrong) === "invalid_code" && errorDetails(wrong).remaining_attempts === 9, brief(wrong));
    mark = await lastSeq(env);
    const resent = await c.act(s.flow.id, "resend");
    const second = await nextCode(env, mine, mark);
    results.check("resend at requirements → a new code", resent.status === 200 && !!second, brief(resent));
    const old = await c.act(s.flow.id, "requirements/verify", { code: first ?? "" });
    results.check("the replaced code no longer works (422 invalid_code: only the newest code counts), 8 tries left", old.status === 422 && errorCode(old) === "invalid_code" && errorDetails(old).remaining_attempts === 8, brief(old));
    const stranger = new Browserish(env, ctx.ip);
    const signedOut = await stranger.act(s.flow.id, "requirements/verify", { code: second ?? "" });
    results.check("another browser can't verify it (403 flow_not_bound)", signedOut.status === 403 && errorCode(signedOut) === "flow_not_bound", brief(signedOut));

    // The number is added on the account site meanwhile: reading the flow moves it on to consent.
    const elsewhere = randomPhone();
    mark = await lastSeq(env);
    const added = await c.post<{ challenge_id?: string }>("/v1/me/phones", { phone: elsewhere });
    const siteCode = await nextCode(env, elsewhere, mark);
    const verifiedSite = await c.post("/v1/me/phones/verify", { challenge_id: added.body.challenge_id, code: siteCode });
    results.check("the phone is added and verified on the account site meanwhile", added.status < 300 && verifiedSite.status === 200, `${brief(added)} / ${brief(verifiedSite)}`);
    const moved = await c.flow(s.flow.id);
    results.check("reading the flow then moves it on to consent (nothing missing any more)", moved.body.flow?.step === "consent" && (moved.body.flow.consent?.required ?? []).some(row => row.scope === "phone"), brief(moved));
    const done = await drive(c, moved.body.flow);
    const tokens = await exchangeCode(env, "dm", redirectParams(done).get("code") ?? "", s.redirectUri, s.verifier);
    results.check("dm gets the number added on the account site", tokens.status === 200 && tokens.body.account.phone === elsewhere, brief(tokens));

    // Signed out in between: the requirements step can't continue for that account.
    const d = new Browserish(env, ctx.ip);
    await signUpVia(d, "spacestation", `dm.signout.${t}@example.test`);
    const ds = await startSignIn(d, "dm");
    await d.act(ds.flow.id, "continue");
    await d.post("/v1/session/signout");
    const gone = await d.act(ds.flow.id, "requirements/phone", { phone: randomPhone() });
    results.check("signed out meanwhile → 401 session_required at the requirements step", gone.status === 401 && errorCode(gone) === "session_required", brief(gone));
  },
};

export const journeys: Journey[] = [consent, requirements];
