/**
 * Sign-up: everything prefilled (display name and id from the email, timezone from the IP headers, else the browser,
 * else UTC; date of birth exactly 18 years ago in that timezone; the Iris photo), the id checked live with free ids
 * offered, every field validated with a reason, and the 48-hour sign-up session: it resumes in a new flow of the same
 * browser, only where the app would accept it, and ends after 48 hours (time travel) or "Not you?".
 */
import type { Journey } from "../../context";
import { codeFor, lastSeq, newContext, shot, sleep, sql, tag } from "../../lib";
import { Browserish, brief, eighteenYearsAgo, errorCode, errorDetails, sendCode, signUpVia, startSignIn, type FlowView, type Reply } from "./_helpers";

const titleCase = (word: string) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();

/** A browser at the signup step of `appId` for a new address (verify sent with `headers`). */
async function atSignup(b: Browserish, appId: string, email: string, options: { timezone?: string; headers?: Record<string, string> } = {}): Promise<{ flow: FlowView; reply: Reply<{ flow: FlowView }> }> {
  const s = await startSignIn(b, appId, { timezone: options.timezone });
  const sent = await sendCode(b, s.flow.id, { email });
  const reply = await b.call<{ flow: FlowView }>("POST", `/v1/flows/${s.flow.id}/verify`, { json: { code: sent.code ?? "" }, headers: options.headers });
  return { flow: reply.body?.flow, reply };
}

const prefill: Journey = {
  name: "auth-flows-signup-prefill",
  title: "sign-up prefill (name and id from the email, timezone from IP headers → browser → UTC, dob 18 years ago, Iris photo), ids taken/reserved/invalid with suggestions, every field validated, a custom sign-up kept exactly",
  async run(ctx) {
    const { env, results } = ctx;
    const t = tag();

    // Timezone: the IP header wins, then the browser's, then UTC; dob is 18 years ago in that timezone.
    const paris = await atSignup(new Browserish(env, ctx.ip), "briefcase", `tz.paris.${t}@example.test`, { timezone: "America/Sao_Paulo", headers: { "x-vercel-ip-timezone": "Europe/Paris" } });
    results.check("an IP timezone header (x-vercel-ip-timezone: Europe/Paris) through the site → Europe/Paris", paris.flow?.signup?.timezone === "Europe/Paris", `${paris.flow?.signup?.timezone} ${brief(paris.reply).slice(0, 80)}`);
    results.check("…and the dob is exactly 18 years before today in Paris", paris.flow?.signup?.dob === eighteenYearsAgo("Europe/Paris"), `${paris.flow?.signup?.dob} vs ${eighteenYearsAgo("Europe/Paris")}`);
    const cloudfront = await atSignup(new Browserish(env, ctx.ip), "briefcase", `tz.cf.${t}@example.test`, { timezone: "UTC", headers: { "cloudfront-viewer-time-zone": "asia/tokyo" } });
    results.check("cloudfront-viewer-time-zone (any case) → its canonical name Asia/Tokyo", cloudfront.flow?.signup?.timezone === "Asia/Tokyo", String(cloudfront.flow?.signup?.timezone));
    const browserTz = await atSignup(new Browserish(env, ctx.ip), "briefcase", `tz.browser.${t}@example.test`, { timezone: "America/Sao_Paulo", headers: { "x-vercel-ip-timezone": "Mars/Base" } });
    results.check("an invalid IP timezone falls back to the browser's (America/Sao_Paulo)", browserTz.flow?.signup?.timezone === "America/Sao_Paulo" && browserTz.flow.signup.dob === eighteenYearsAgo("America/Sao_Paulo"), `${browserTz.flow?.signup?.timezone} ${browserTz.flow?.signup?.dob}`);
    const utc = await atSignup(new Browserish(env, ctx.ip), "briefcase", `tz.none.${t}@example.test`, { timezone: "Not/AZone" });
    results.check("no usable timezone at all → UTC", utc.flow?.signup?.timezone === "UTC", String(utc.flow?.signup?.timezone));
    results.check("the photo prefill is our Iris default", utc.flow?.signup?.pfp_url === `${env.iris}/pfp/carbon?id=new`, String(utc.flow?.signup?.pfp_url));
    results.check("the sign-up session ends 48 hours after the code", Math.abs(Date.parse(utc.flow?.signup?.expires_at ?? "") - Date.now() - 48 * 3_600_000) < 60_000, String(utc.flow?.signup?.expires_at));

    // Names and ids from the email.
    const plus = await atSignup(new Browserish(env, ctx.ip), "briefcase", `Mary_Ann.Smith-Jones+news.${t}@Example.test`);
    results.check("display name from the local part, split on . _ - + and title-cased", plus.flow?.signup?.display_name === `Mary Ann Smith Jones News ${titleCase(t)}`, String(plus.flow?.signup?.display_name));
    results.check("id from the local part: lowercase, other characters collapsed to -, cut to 30", plus.flow?.signup?.id === `c:${`mary_ann-smith-jones-news-${t}`.slice(0, 30).replace(/[-_]+$/, "")}`, String(plus.flow?.signup?.id));
    const long = await atSignup(new Browserish(env, ctx.ip), "briefcase", `${"x".repeat(26)}${t}@example.test`);
    results.check("a long local part is cut to 30 characters", long.flow?.signup?.id === `c:${"x".repeat(26)}${t}`.slice(0, 32), String(long.flow?.signup?.id));

    // A taken id: the next sign-up from the same local part gets -2; the availability API agrees and suggests.
    const owner = new Browserish(env, ctx.ip);
    await signUpVia(owner, "briefcase", `taken.${t}@example.test`);
    const taken = `c:taken-${t}`;
    const second = await atSignup(new Browserish(env, ctx.ip), "briefcase", `taken.${t}@elsewhere.test`);
    results.check("the same local part again → the id is numbered (taken-…-2)", second.flow?.signup?.id === `${taken}-2`, String(second.flow?.signup?.id));
    const available = (id: string) => new Browserish(env, ctx.ip).get<{ available: boolean; reason: string | null; message: string; suggestions: string[] }>(`/v1/ids/available?id=${encodeURIComponent(id)}`);
    const takenReply = await available(taken.toUpperCase());
    results.check("ids/available: a taken id in capitals → available false, reason taken (ids are case-insensitive)", takenReply.status === 200 && takenReply.body.available === false && takenReply.body.reason === "taken", JSON.stringify(takenReply.body));
    results.check("…with up to 3 free suggestions near it", Array.isArray(takenReply.body.suggestions) && takenReply.body.suggestions.length >= 1 && takenReply.body.suggestions.length <= 3 && takenReply.body.suggestions.every(id => id.startsWith(`c:taken-${t}`)), JSON.stringify(takenReply.body.suggestions));
    const reserved = await available("c:admin");
    results.check("c:admin → reason reserved_word", reserved.body.available === false && reserved.body.reason === "reserved_word", JSON.stringify(reserved.body));
    for (const [id, why] of [["c:ab", "too short"], [`c:${"a".repeat(31)}`, "too long"], ["c:no spaces", "a space"], ["c:é-accent", "a non-ASCII letter"], [`x:taken-${t}`, "an unknown prefix"]] as const) {
      const reply = await available(id);
      results.check(`${JSON.stringify(id)} (${why}) → available false, reason invalid, with a message`, reply.status === 200 && reply.body.available === false && reply.body.reason === "invalid" && reply.body.message.length > 10, JSON.stringify(reply.body).slice(0, 200));
    }
    const silicon = await available(`si:taken-${t}`);
    results.check("si:taken-… is free although c:taken-… is taken (separate namespaces)", silicon.body.available === true, JSON.stringify(silicon.body));
    const free = await available(`c:free-${t}`);
    results.check("a free id → available true, no suggestions", free.body.available === true && free.body.suggestions.length === 0, JSON.stringify(free.body));

    // Validation at submit: every field, all at once, with reasons.
    const v = new Browserish(env, ctx.ip);
    const at = await atSignup(v, "briefcase", `validate.${t}@example.test`);
    const id = at.flow.id;
    const takenSubmit = await v.act(id, "signup", { id: taken });
    results.check("submitting a taken id → 409 id_taken with suggestions", takenSubmit.status === 409 && errorCode(takenSubmit) === "id_taken" && Array.isArray(errorDetails(takenSubmit).suggestions) && (errorDetails(takenSubmit).suggestions as unknown[]).length > 0, brief(takenSubmit));
    const reservedSubmit = await v.act(id, "signup", { id: "c:support" });
    results.check("a reserved word as id → 422 with details.fields.id", reservedSubmit.status === 422 && typeof (errorDetails(reservedSubmit).fields as Record<string, string> | undefined)?.id === "string", brief(reservedSubmit));
    const future = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    const many = await v.act(id, "signup", { display_name: "  ", id: "c:a!", timezone: "Mars/Base", dob: future, pfp_url: "http://insecure.example/me.png" });
    const fields = (errorDetails(many).fields ?? {}) as Record<string, string>;
    results.check("five bad fields at once → 422 naming display_name, id, timezone, dob and pfp_url", many.status === 422 && ["display_name", "id", "timezone", "dob", "pfp_url"].every(field => typeof fields[field] === "string"), JSON.stringify(fields).slice(0, 500));
    for (const [body, field, why] of [
      [{ display_name: "x".repeat(101) }, "display_name", "101 characters"],
      [{ display_name: "Bell\u0007" }, "display_name", "a control character"],
      [{ dob: "1899-12-31" }, "dob", "before 1900"],
      [{ dob: "07/10/2008" }, "dob", "not YYYY-MM-DD"],
      [{ pfp_url: "javascript:alert(1)" }, "pfp_url", "a javascript: URL"],
    ] as const) {
      const reply = await v.act(id, "signup", body);
      results.check(`${field} with ${why} → 422 on that field`, reply.status === 422 && typeof ((errorDetails(reply).fields ?? {}) as Record<string, string>)[field] === "string", brief(reply));
    }
    const still = await v.flow(id);
    results.check("refused submissions leave the flow at signup with the session live", still.body.flow?.step === "signup" && !!still.body.flow.signup, brief(still));
    const custom = await v.act(id, "signup", { display_name: "  Custom Carbon  ", id: `C:Custom-${t.toUpperCase()}`, timezone: "america/new_york", dob: "1990-05-17", pfp_url: null });
    results.check("a custom sign-up is accepted (trimmed name, id lowercased, timezone canonical)", custom.status === 200 && ["consent", "complete"].includes(custom.body.flow.step), brief(custom));
    const me = await v.get<Record<string, unknown>>("/v1/me");
    results.check("the account is exactly what was submitted", me.body.display_name === "Custom Carbon" && me.body.id === `c:custom-${t}` && me.body.timezone === "America/New_York" && me.body.dob === "1990-05-17", JSON.stringify(me.body).slice(0, 300));
    results.check("pfp_url null → our Iris default for the new uuid", me.body.pfp_url === `${env.iris}/pfp/carbon?id=${String(me.body.uuid)}`, String(me.body.pfp_url));
    const used = await v.act(id, "signup", {});
    results.check("submitting the sign-up again → 409 (the flow moved on)", used.status === 409, brief(used));
  },
};

const prefillBrowser: Journey = {
  name: "auth-flows-signup-ids",
  title: "the sign-up page checks the id live: a taken id shows free ones to pick, a malformed one says why, the picked id is the account's",
  async run(ctx) {
    const { env, results, browser } = ctx;
    const t = tag();
    await signUpVia(new Browserish(env, ctx.ip), "briefcase", `pick.${t}@example.test`);
    const context = await newContext(browser);
    const page = await context.newPage();
    results.watch(page, "ids");
    await page.goto(`${env.apps}/spacestation/`);
    await page.locator("#signin-hosted").click();
    const field = page.getByRole("textbox", { name: "Email" });
    await field.waitFor({ timeout: 30_000 });
    const after = await lastSeq(env);
    const address = `pick.${t}@second.test`;
    await field.fill(address);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    const code = await codeFor(env, address, after);
    await page.getByRole("group", { name: /Code from the email/ }).waitFor({ timeout: 15_000 });
    await page.keyboard.type(code, { delay: 25 });
    const idField = page.getByRole("textbox", { name: "Your id" });
    await idField.waitFor({ timeout: 20_000 });
    await sleep(400);
    results.check("the prefilled id skips the taken one", (await idField.inputValue()) === `pick-${t}-2`, await idField.inputValue());
    await idField.fill(`pick-${t}`);
    const suggestions = page.getByRole("group", { name: "Free ids" });
    await suggestions.waitFor({ timeout: 10_000 }).catch(() => undefined);
    const offered = (await suggestions.innerText().catch(() => "")).replace(/\s+/g, " ");
    const note = (await page.locator("main").innerText()).replace(/\s+/g, " ");
    results.check("a taken id is flagged and free ids are offered", /taken|not available|already/i.test(note) && /c:pick-/.test(offered), `${offered} | ${note.slice(note.indexOf("Your id"), note.indexOf("Your id") + 160)}`);
    await shot(env, page, "auth-flows-signup-ids-01-taken");
    await idField.fill("a!");
    await sleep(500);
    const invalid = (await page.locator("main").innerText()).replace(/\s+/g, " ");
    results.check("a malformed id says which character is wrong, before asking the server", invalid.includes('"!" can\'t be in an id'), invalid.slice(invalid.indexOf("Your id"), invalid.indexOf("Your id") + 160));
    await idField.fill(`pick-${t}`);
    await suggestions.waitFor({ timeout: 10_000 });
    const first = suggestions.getByRole("button").first();
    const picked = ((await first.innerText()) || "").trim().replace(/^c:/, "");
    await first.click();
    await sleep(600);
    results.check("picking a free id fills the field and it is available", (await idField.inputValue()) === picked && /is available/.test(await page.locator("main").innerText()), `${picked} → ${await idField.inputValue()}`);
    await page.getByRole("button", { name: "Create account" }).click();
    const share = page.getByRole("button", { name: "Share and continue" });
    await share.waitFor({ timeout: 20_000 });
    await share.click();
    await page.waitForURL(new RegExp(`${env.apps.replace(/[.:/]/g, "\\$&")}/spacestation/callback`), { timeout: 30_000 });
    const rows = await sql(env, `select a.handle from accounts a join account_emails e on e.account_uuid = a.uuid where e.email = '${address}'`);
    results.check("the account has the picked id", rows[0]?.[0] === `c:${picked}`, JSON.stringify(rows));
    await context.close();
  },
};

const expiry: Journey = {
  name: "auth-flows-signup-expiry",
  title: "the 48-hour sign-up session: it resumes in a new flow of the same browser only where the app would accept it, survives the 60-minute flow, ends at 48 hours (time travel) and on \"Not you?\"; the hosted page says so",
  async run(ctx) {
    const { env, results, browser } = ctx;
    const t = tag();
    const b = new Browserish(env, ctx.ip);
    const email = `resume.${t}@example.test`;
    const first = await atSignup(b, "briefcase", email);
    results.check("a verified new email → signup", first.flow?.step === "signup");

    // A new flow in the same browser resumes the sign-up (no new code), where the app would take it.
    const resumed = await startSignIn(b, "commit");
    results.check("a new flow (commit) in the same browser resumes at signup with the proven email", resumed.flow.step === "signup" && resumed.flow.signup?.email === email, `${resumed.flow.step} ${resumed.flow.signup?.email}`);
    const crm = await startSignIn(b, "legacy-crm");
    results.check("…not in legacy-crm (it takes no new accounts)", crm.flow.step === "choose_method", crm.flow.step);
    const campus = await startSignIn(b, "campus-connect");
    results.check("…not in campus-connect (the email's domain is not allowed)", campus.flow.step === "choose_method", campus.flow.step);
    const wave = await startSignIn(b, "waveform");
    results.check("…not in waveform (no email method)", wave.flow.step === "choose_method", wave.flow.step);
    const stranger = new Browserish(env, ctx.ip);
    const elsewhere = await startSignIn(stranger, "briefcase");
    results.check("…and never in another browser", elsewhere.flow.step === "choose_method", elsewhere.flow.step);

    // The 60-minute flow ends; the sign-up session (48 h) does not.
    await sql(env, `update signin_flows set expires_at = now() - interval '1 second' where id = '${first.flow.id}'`);
    const expiredFlow = await b.flow(first.flow.id);
    results.check("a flow past its 60 minutes → 410 flow_expired", expiredFlow.status === 410 && errorCode(expiredFlow) === "flow_expired", brief(expiredFlow));
    const expiredAct = await b.act(first.flow.id, "signup", {});
    results.check("…its actions too (410 flow_expired)", expiredAct.status === 410 && errorCode(expiredAct) === "flow_expired", brief(expiredAct));
    const afterFlow = await startSignIn(b, "briefcase");
    results.check("…but a new flow still resumes the sign-up", afterFlow.flow.step === "signup" && afterFlow.flow.signup?.email === email, afterFlow.flow.step);

    // Close to the end it still works; at 48 hours it ends.
    await sql(env, `update signup_sessions set expires_at = now() + interval '1 minute' where verified_email = '${email}'`);
    const nearEnd = await startSignIn(b, "briefcase");
    results.check("with a minute of its 48 hours left it still resumes", nearEnd.flow.step === "signup", nearEnd.flow.step);
    await sql(env, `update signup_sessions set expires_at = now() - interval '1 second' where verified_email = '${email}'`);
    const read = await b.flow(nearEnd.flow.id);
    results.check("past 48 hours, reading a flow at signup → back to choose_method with signup_expired", read.status === 200 && read.body.flow.step === "choose_method" && read.body.flow.error?.code === "signup_expired", brief(read));
    const submit = await b.act(afterFlow.flow.id, "signup", {});
    results.check("submitting an expired sign-up → 410 signup_expired (the flow goes back to choose_method)", submit.status === 410 && errorCode(submit) === "signup_expired", brief(submit));
    const back = await b.flow(afterFlow.flow.id);
    results.check("…and that flow now says why at choose_method", back.body.flow?.step === "choose_method" && back.body.flow.error?.code === "signup_expired", JSON.stringify(back.body.flow?.error));
    const none = await startSignIn(b, "briefcase");
    results.check("a new flow no longer resumes it", none.flow.step === "choose_method", none.flow.step);
    const noAccount = await sql(env, `select count(*) from account_emails where email = '${email}'`);
    results.check("no account was made from the expired sign-up", noAccount[0]?.[0] === "0", JSON.stringify(noAccount));
    const again = await sendCode(b, none.flow.id, { email });
    const fresh = await b.act(none.flow.id, "verify", { code: again.code ?? "" });
    results.check("verifying the email again opens a fresh 48-hour sign-up", fresh.status === 200 && fresh.body.flow.step === "signup" && Date.parse(fresh.body.flow.signup?.expires_at ?? "") > Date.now() + 47 * 3_600_000, brief(fresh));

    // "Not you?" ends the sign-up for good in this browser.
    const switched = await b.act(none.flow.id, "switch");
    results.check("\"Not you?\" (switch) → choose_method and the sa_signup cookie is cleared", switched.status === 200 && switched.body.flow.step === "choose_method" && !b.jar.get("sa_signup"), brief(switched));
    const ended = await sql(env, `select count(*) from signup_sessions where verified_email = '${email}' and expires_at > now() and consumed_at is null`);
    results.check("…and the session itself ended (no live sign-up left for the email)", ended[0]?.[0] === "0", JSON.stringify(ended));

    // In the browser: the page says the sign-up expired.
    const context = await newContext(browser);
    const page = await context.newPage();
    results.watch(page, "expiry");
    const shown = `shown.${t}@example.test`;
    await page.goto(`${env.apps}/briefcase/`);
    await page.locator("#signin-hosted").click();
    const field = page.getByRole("textbox", { name: "Email" });
    await field.waitFor({ timeout: 30_000 });
    const after = await lastSeq(env);
    await field.fill(shown);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    const code = await codeFor(env, shown, after);
    await page.getByRole("group", { name: /Code from the email/ }).waitFor({ timeout: 15_000 });
    await page.keyboard.type(code, { delay: 25 });
    await page.getByRole("button", { name: "Create account" }).waitFor({ timeout: 20_000 });
    await sql(env, `update signup_sessions set expires_at = now() - interval '1 second' where verified_email = '${shown}'`);
    await page.reload();
    const alert = page.getByText("Your sign-up expired");
    await alert.waitFor({ timeout: 20_000 }).catch(() => undefined);
    await sleep(300);
    await shot(env, page, "auth-flows-signup-expiry-01");
    results.check("reloading after 48 hours shows \"Your sign-up expired\" with the email field again", (await alert.isVisible()) && (await field.isVisible()), (await page.locator("main").innerText()).replace(/\s+/g, " ").slice(0, 200));
    await page.getByRole("button", { name: "Create account" }).waitFor({ state: "detached", timeout: 2_000 }).catch(() => undefined);
    results.check("…and the sign-up form is gone", (await page.getByRole("button", { name: "Create account" }).count()) === 0);
    await context.close();
  },
};

export const journeys: Journey[] = [prefill, prefillBrowser, expiry];
