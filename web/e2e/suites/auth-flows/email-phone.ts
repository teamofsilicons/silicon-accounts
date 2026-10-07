/**
 * Email and phone sign-in through the hosted pages: a new Carbon with an email code (sign-up, consent, the app's code
 * exchange), the same Carbon back with the address typed in another case, a phone sign-up on dm (phone first, the
 * required phone already proven so no requirements step), and the API's answers to malformed input, other browsers
 * and other origins.
 */
import type { Journey } from "../../context";
import { appAccount, codeFor, lastSeq, newContext, shot, sleep, sql, tag } from "../../lib";
import { Browserish, brief, drive, errorCode, errorDetails, sendCode, startSignIn, timed } from "./_helpers";

const titleCase = (word: string) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();

const email: Journey = {
  name: "auth-flows-email",
  title: "email code on briefcase's hosted page: sign-up prefill, consent, the app's account; back again with the address in capitals, no sign-up and no consent",
  async run({ env, results, browser }) {
    const context = await newContext(browser);
    const page = await context.newPage();
    results.watch(page, "email");
    const t = tag();
    const address = `ada.lovelace.${t}@example.test`;

    const started = Date.now();
    await page.goto(`${env.apps}/briefcase/`);
    await page.locator("#signin-hosted").click();
    const field = page.getByRole("textbox", { name: "Email" });
    await field.waitFor({ timeout: 30_000 });
    results.check("the hosted link lands on /authorize/flow/{id}", /\/authorize\/flow\/[A-Za-z0-9_-]+$/.test(new URL(page.url()).pathname), page.url());
    let after = await lastSeq(env);
    await field.fill(`  Ada.Lovelace.${t.toUpperCase()}@Example.TEST `);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    const sentAt = Date.now();
    const code = await codeFor(env, address, after);
    results.metric("email code: Continue → code in the mock inbox", Date.now() - sentAt);
    results.check("the code went to the normalized (trimmed, lowercased) address", /^\d{6}$/.test(code), address);
    const codeGroup = page.getByRole("group", { name: /Code from the email/ });
    await codeGroup.waitFor({ timeout: 15_000 });
    const shown = (await page.locator("main").innerText()).replace(/\s+/g, " ");
    results.check("the code step shows the masked address, never the whole one", shown.includes("a***@example.test") && !shown.includes(address), shown.slice(0, 200));
    await page.keyboard.type(code, { delay: 25 });

    const idField = page.getByRole("textbox", { name: "Your id" });
    await idField.waitFor({ timeout: 20_000 });
    await sleep(500);
    await shot(env, page, "auth-flows-email-01-signup");
    const id = await idField.inputValue();
    const name = await page.getByRole("textbox", { name: "Display name" }).inputValue();
    results.check("sign-up: the id comes from the email's local part", id === `ada-lovelace-${t}`, id);
    results.check("sign-up: the display name comes from the email's local part, title-cased", name === `Ada Lovelace ${titleCase(t)}`, name);
    await page.getByRole("button", { name: "Create account" }).click();

    const share = page.getByRole("button", { name: "Share and continue" });
    await share.waitFor({ timeout: 20_000 });
    const shareList = page.getByRole("list", { name: "Details shared with Briefcase" });
    await shareList.waitFor({ timeout: 10_000 });
    const consentText = (await shareList.innerText()).replace(/\s+/g, " ");
    results.check("consent lists the required email (masked) and the optional timezone", consentText.includes("a***@example.test") && !consentText.includes(address) && /Timezone/.test(consentText), consentText.slice(0, 300));
    const tz = page.getByRole("switch", { name: /Timezone/ });
    results.check("the optional timezone starts off (the app did not ask for it in scope)", (await tz.getAttribute("aria-checked")) === "false" || (await tz.getAttribute("data-state")) === "unchecked");
    await shot(env, page, "auth-flows-email-02-consent");
    await share.click();
    await page.waitForURL(new RegExp(`${env.apps.replace(/[.:/]/g, "\\$&")}/briefcase/callback`), { timeout: 30_000 });
    results.metric("email sign-up: app link → back at the app", Date.now() - started);
    const account = await appAccount(page);
    const uuid = String(account?.uuid ?? "");
    results.check("briefcase got the account with the verified, normalized email", account?.email === address && account?.email_verified === true, JSON.stringify(account).slice(0, 300));
    results.check("briefcase got no timezone (declined by default)", account !== null && !("timezone" in account), JSON.stringify(account).slice(0, 300));
    results.check("the membership id is briefcase:<uuid>", (await page.locator("#membership-id").innerText().catch(() => "")) === `briefcase:${uuid}`);
    const token = JSON.parse((await page.locator("#token").innerText().catch(() => "{}")) || "{}") as { scope?: string };
    results.check("granted scope: profile and email", (token.scope ?? "").split(" ").sort().join(" ") === "email profile", String(token.scope));

    // Sign out of briefcase (it revokes its refresh token), then back in as the same address in capitals.
    let mark = Date.now();
    const lap = (name: string) => {
      results.metric(`second sign-in: ${name}`, Date.now() - mark);
      mark = Date.now();
    };
    await page.locator("#sign-out").click();
    await page.waitForURL(`${env.apps}/briefcase/`, { timeout: 15_000 });
    lap("briefcase sign-out");
    await page.locator("#signin-hosted").click();
    await page.getByRole("button", { name: "Use another account" }).click({ timeout: 30_000 });
    await field.waitFor({ timeout: 15_000 });
    lap("hosted page → Use another account");
    after = await lastSeq(env);
    await field.fill(address.toUpperCase());
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    const again = await codeFor(env, address, after);
    lap("code sent and received");
    await page.getByRole("group", { name: /Code from the email/ }).waitFor({ timeout: 15_000 });
    await page.keyboard.type(again, { delay: 25 });
    await page.waitForURL(new RegExp(`${env.apps.replace(/[.:/]/g, "\\$&")}/briefcase/callback`), { timeout: 30_000 });
    lap("code typed → back at briefcase");
    const second = await appAccount(page);
    results.check("the same address in capitals is the same account (no sign-up, no consent)", second?.uuid === uuid, JSON.stringify(second).slice(0, 200));
    const history = await sql(env, `select method, outcome from signin_history where account_uuid = '${uuid}' and app_id = 'briefcase' order by at, id`);
    results.check("sign-in history: email/new_account, then email/success", JSON.stringify(history) === JSON.stringify([["email", "new_account"], ["email", "success"]]), JSON.stringify(history));
    const revoked = await sql(env, `select count(*) filter (where revoked_at is not null), count(*) from token_families where account_uuid = '${uuid}' and app_id = 'briefcase'`);
    results.check("briefcase's sign-out revoked its first sign-in (one of two token families revoked)", revoked[0]?.[0] === "1" && revoked[0]?.[1] === "2", JSON.stringify(revoked));
    await context.close();
  },
};

const emailApi: Journey = {
  name: "auth-flows-email-api",
  title: "the email step's answers: malformed addresses, the masked challenge and its timings, another browser or origin, a method the app lacks, a code after the step moved on",
  async run(ctx) {
    const { env, results } = ctx;
    const b = new Browserish(env, ctx.ip);
    const s = await startSignIn(b, "briefcase");
    results.check("POST /v1/flows → 201 with the sa_flow binding cookie", s.reply.status === 201 && !!b.jar.get("sa_flow"), brief(s.reply));
    const setCookie = s.reply.headers.get("set-cookie") ?? "";
    results.check("sa_flow is HttpOnly, SameSite=Lax, Path=/", /HttpOnly/i.test(setCookie) && /SameSite=Lax/i.test(setCookie) && /Path=\//.test(setCookie), setCookie.replace(/saf_[A-Za-z0-9_-]+/, "saf_…"));
    results.check("a new flow starts at choose_method with briefcase's methods in its order", s.flow.step === "choose_method" && s.flow.methods.join(",") === "google,apple,email,phone", `${s.flow.step} ${s.flow.methods.join(",")}`);
    const lifetime = Date.parse(s.flow.expires_at) - Date.now();
    results.check("a flow lives 60 minutes", lifetime > 59 * 60_000 && lifetime <= 60 * 60_000 + 5_000, `${Math.round(lifetime / 1000)} s`);

    for (const [bad, why] of [
      ["ada@", "nothing after @"],
      ["ada.example.test", "no @"],
      ["a..b@example.test", "double dot"],
      ["ada@example", "no dot in the domain"],
      ["ada lovelace@example.test", "a space"],
    ] as const) {
      const reply = await b.act(s.flow.id, "email", { email: bad });
      results.check(`"${bad}" (${why}) → 422 invalid_email with the reason`, reply.status === 422 && errorCode(reply) === "invalid_email", brief(reply));
    }

    const address = `grace.api.${tag()}@example.test`;
    const sent = await sendCode(b, s.flow.id, { email: `  ${address.toUpperCase()}  ` });
    const flow = sent.reply.body.flow;
    results.check("a padded, capitalised address is accepted → verify_code", sent.reply.status === 200 && flow.step === "verify_code", brief(sent.reply));
    results.check("the challenge is masked (g***@example.test) and on the email channel", flow.challenge?.destination === "g***@example.test" && flow.challenge.channel === "email", JSON.stringify(flow.challenge));
    const ttl = Date.parse(flow.challenge?.expires_at ?? "") - Date.now();
    results.check("the code lives 10 minutes", ttl > 9 * 60_000 && ttl <= 10 * 60_000 + 5_000, `${Math.round(ttl / 1000)} s`);
    const resendIn = Date.parse(flow.challenge?.resend_available_at ?? "") - Date.now();
    results.check("resend is offered after 30 seconds", resendIn > 25_000 && resendIn <= 31_000, `${Math.round(resendIn / 1000)} s`);
    results.check("the code reached the lowercased address", !!sent.code && sent.to.trim().toLowerCase() === address, String(sent.code));

    // Another browser (no sa_flow cookie, or another flow's) can't read or drive this flow.
    const stranger = new Browserish(env, ctx.ip);
    const read = await stranger.flow(s.flow.id);
    results.check("another browser reading the flow → 403 flow_not_bound", read.status === 403 && errorCode(read) === "flow_not_bound", brief(read));
    await startSignIn(stranger, "briefcase");
    const guess = await stranger.act(s.flow.id, "verify", { code: sent.code ?? "000000" });
    results.check("another browser with its own sa_flow can't verify this flow's code → 403 flow_not_bound", guess.status === 403 && errorCode(guess) === "flow_not_bound", brief(guess));
    const foreign = await b.post(`/v1/flows/${s.flow.id}/verify`, { code: sent.code }, { origin: "https://evil.example" });
    results.check("the right browser from a foreign Origin → 403 origin_not_allowed", foreign.status === 403 && errorCode(foreign) === "origin_not_allowed", brief(foreign));
    const noOrigin = await b.post(`/v1/flows/${s.flow.id}/verify`, { code: sent.code }, { origin: null });
    results.check("…and without an Origin → 403 origin_not_allowed", noOrigin.status === 403 && errorCode(noOrigin) === "origin_not_allowed", brief(noOrigin));
    const stillWaiting = await b.flow(s.flow.id);
    results.check("refused attempts left the flow at verify_code", stillWaiting.body.flow?.step === "verify_code", brief(stillWaiting));

    const short = await b.act(s.flow.id, "verify", { code: "12345" });
    results.check("a 5-digit code → 422 invalid_code without counting (no remaining_attempts)", short.status === 422 && errorCode(short) === "invalid_code" && errorDetails(short).remaining_attempts === undefined, brief(short));
    const { value: ok, ms } = await timed(() => b.act(s.flow.id, "verify", { code: sent.code ?? "" }));
    results.metric("verify (right code, new address) through the site", ms);
    results.check("the right code → signup (a new address)", ok.status === 200 && ok.body.flow.step === "signup" && !!b.jar.get("sa_signup"), brief(ok));
    const signupCookie = ok.headers.get("set-cookie") ?? "";
    results.check("sa_signup is HttpOnly, SameSite=Lax, 48 h", /HttpOnly/i.test(signupCookie) && /SameSite=Lax/i.test(signupCookie) && /Max-Age=172800/.test(signupCookie), signupCookie.replace(/sau_[A-Za-z0-9_-]+/, "sau_…"));
    const twice = await b.act(s.flow.id, "verify", { code: sent.code ?? "" });
    results.check("the same code again after the step moved on → 409 invalid_step", twice.status === 409 && errorCode(twice) === "invalid_step", brief(twice));
    const resend = await b.act(s.flow.id, "resend");
    results.check("resend at signup → 409 invalid_step", resend.status === 409 && errorCode(resend) === "invalid_step", brief(resend));

    // login_hint is echoed for the page to prefill (cut to 320 characters) and passed on to Google.
    const hinted = await startSignIn(new Browserish(env, ctx.ip), "briefcase", { loginHint: `  hint.${tag()}@example.test  ` });
    results.check("login_hint comes back on the flow view, trimmed", /^hint\.[a-z0-9]+@example\.test$/.test(hinted.flow.login_hint ?? ""), String(hinted.flow.login_hint));
    const longHint = await startSignIn(new Browserish(env, ctx.ip), "briefcase", { loginHint: "x".repeat(400) });
    results.check("a 400-character login_hint is cut to 320", longHint.flow.login_hint?.length === 320, String(longHint.flow.login_hint?.length));
    const hb = new Browserish(env, ctx.ip);
    const hs = await startSignIn(hb, "briefcase", { loginHint: "grace@gmail.test" });
    const hgo = await hb.post<{ authorize_url?: string }>(`/v1/flows/${hs.flow.id}/oauth/google`);
    results.check("…and Google's authorize request carries it", new URL(hgo.body?.authorize_url ?? "http://x/").searchParams.get("login_hint") === "grace@gmail.test", hgo.body?.authorize_url?.slice(0, 160));

    // A method the app does not offer.
    const c = new Browserish(env, ctx.ip);
    const commit = await startSignIn(c, "commit");
    const phone = await c.act(commit.flow.id, "phone", { phone: "+12025550100" });
    results.check("phone on commit (email + Google only) → 403 method_not_enabled listing its methods", phone.status === 403 && errorCode(phone) === "method_not_enabled" && JSON.stringify(errorDetails(phone).methods) === JSON.stringify(["google", "email"]), brief(phone));
    const early = await c.act(commit.flow.id, "resend");
    results.check("resend before any code → 409 invalid_step", early.status === 409 && errorCode(early) === "invalid_step", brief(early));
    const unknown = await c.flow("AAAAAAAAAAAAAAAAAAAAAA");
    results.check("an unknown flow id → 404 flow_not_found", unknown.status === 404 && errorCode(unknown) === "flow_not_found", brief(unknown));
  },
};

const phone: Journey = {
  name: "auth-flows-phone",
  title: "dm's hosted page offers the phone first: an SMS code, the sign-up named \"Carbon 1234\", consent with the masked phone, dm gets the verified number; local numbers and bad numbers at the API",
  async run(ctx) {
    const { env, results, browser } = ctx;
    const context = await newContext(browser);
    const page = await context.newPage();
    results.watch(page, "phone");
    const digits = String(Math.floor(1000 + Math.random() * 8999));
    const number = `+1415555${digits}`;

    await page.goto(`${env.apps}/dm/`);
    await page.locator("#signin-hosted").click();
    const field = page.getByRole("textbox", { name: "Phone number" });
    await field.waitFor({ timeout: 30_000 });
    results.check("dm's page opens on the phone field (phone comes first in its order)", await field.isVisible());
    const after = await lastSeq(env);
    await field.click();
    await page.keyboard.type(number, { delay: 25 });
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    const code = await codeFor(env, number, after);
    results.check("the SMS reached the E.164 number", /^\d{6}$/.test(code), number);
    await page.getByRole("group", { name: /Code from the text message|Code/ }).first().waitFor({ timeout: 15_000 });
    const masked = (await page.locator("main").innerText()).replace(/\s+/g, " ");
    results.check("the code step shows the masked number", masked.includes(digits) && !masked.includes(number.slice(2, 8)), masked.slice(0, 200));
    await page.keyboard.type(code, { delay: 25 });
    const idField = page.getByRole("textbox", { name: "Your id" });
    await idField.waitFor({ timeout: 20_000 });
    await sleep(400);
    const name = await page.getByRole("textbox", { name: "Display name" }).inputValue();
    const id = await idField.inputValue();
    results.check("sign-up by phone: display name \"Carbon <last 4 digits>\"", name === `Carbon ${digits}`, name);
    results.check("sign-up by phone: id from the display name (carbon-<digits>, numbered if taken)", id === `carbon-${digits}` || id.startsWith(`carbon-${digits}-`), id);
    await shot(env, page, "auth-flows-phone-01-signup");
    await page.getByRole("button", { name: "Create account" }).click();
    const share = page.getByRole("button", { name: "Share and continue" });
    await share.waitFor({ timeout: 20_000 });
    const shareList = page.getByRole("list", { name: "Details shared with DM" });
    await shareList.waitFor({ timeout: 10_000 });
    const consent = (await shareList.innerText()).replace(/\s+/g, " ");
    results.check("dm's consent shows the required phone, masked (no requirements step: the sign-up proved it)", /Phone/.test(consent) && consent.includes(`+14*****${digits}`) && !consent.includes(number), consent.slice(0, 300));
    await share.click();
    await page.waitForURL(new RegExp(`${env.apps.replace(/[.:/]/g, "\\$&")}/dm/callback`), { timeout: 30_000 });
    const account = await appAccount(page);
    results.check("dm got the verified phone", account?.phone === number && account?.phone_verified === true, JSON.stringify(account).slice(0, 300));
    results.check("dm got no email (the Carbon has none)", account !== null && !("email" in account), JSON.stringify(account).slice(0, 300));
    await context.close();

    // At the API: local numbers with a country, and numbers that are not numbers.
    const b = new Browserish(env, ctx.ip);
    const s = await startSignIn(b, "dm");
    const local = `(202) 555-${String(Math.floor(1000 + Math.random() * 8999))}`;
    const e164 = `+1202555${local.slice(-4)}`;
    const localAfter = await lastSeq(env);
    const sent = await b.act(s.flow.id, "phone", { phone: local, country: "us" });
    const localCode = sent.status === 200 ? await codeFor(env, e164, localAfter).catch(() => null) : null;
    results.check("a local number with country \"us\" is normalized to E.164 and texted there", sent.status === 200 && sent.body.flow.challenge?.channel === "phone" && !!localCode, `${brief(sent)} ${e164}`);
    results.check("the phone challenge keeps only the first 3 and last 4 characters (+12*****NNNN)", sent.body.flow?.challenge?.destination === `+12*****${e164.slice(-4)}`, String(sent.body.flow?.challenge?.destination));
    // The same number again in a fresh browser: the existing account signs in, dm's consent is not asked again.
    const firstVerify = sent.status === 200 ? await b.act(s.flow.id, "verify", { code: localCode ?? "" }) : null;
    const created = firstVerify?.status === 200 ? await drive(b, firstVerify.body.flow) : null;
    const again = new Browserish(env, ctx.ip);
    const as = await startSignIn(again, "dm");
    const agSent = await sendCode(again, as.flow.id, { phone: e164 });
    const agVerified = await again.act(as.flow.id, "verify", { code: agSent.code ?? "" });
    results.check("the same number in a fresh browser signs the existing account straight in (complete, no sign-up, no consent)", created?.step === "complete" && agVerified.status === 200 && agVerified.body.flow.step === "complete" && agVerified.body.flow.signed_in_as?.uuid === (await b.session())?.account.uuid, brief(agVerified));
    // A phone-only Carbon on an app that requires an email: the requirements step asks for one.
    const needsEmail = await startSignIn(again, "briefcase");
    const toRequirements = await again.act(needsEmail.flow.id, "continue");
    results.check("that phone-only Carbon continuing to briefcase (email required) → requirements [email]", toRequirements.status === 200 && toRequirements.body.flow.step === "requirements" && JSON.stringify(toRequirements.body.flow.requirements?.missing) === '["email"]', brief(toRequirements));

    const b2 = new Browserish(env, ctx.ip);
    const s2 = await startSignIn(b2, "dm");
    for (const [input, country, code, why] of [
      ["2025550123", undefined, "invalid_phone", "a local number without a country"],
      ["+1 202 555", undefined, "invalid_phone", "too short to be a number"],
      ["+44 20 7946 09x8", undefined, "invalid_phone", "a letter in it"],
      ["2025550123", "XX", "invalid_country", "a country that does not exist"],
    ] as const) {
      const reply = await b2.act(s2.flow.id, "phone", { phone: input, ...(country ? { country } : {}) });
      results.check(`${why} → 422 ${code} with a precise message`, reply.status === 422 && errorCode(reply) === code, brief(reply));
    }
  },
};

export const journeys: Journey[] = [email, emailApi, phone];
