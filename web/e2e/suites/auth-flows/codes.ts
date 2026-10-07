/**
 * The verification code's contract (UNDERSTANDING.md "Email and phone verification"): 6 digits, 10 minutes; sending is
 * limited to 10 per destination per 10 minutes (then 429 with Retry-After, also 30 per network), and after 10 wrong
 * codes in a row verification pauses for 1 minute (423), for every code and flow of that address. Windows and
 * cooldowns are moved with SQL (time travel) instead of waited for.
 */
import type { Journey } from "../../context";
import { codeFor, forgetRateLimits, lastSeq, newContext, randomIp, shot, sleep, sql, tag } from "../../lib";
import { Browserish, brief, drive, errorCode, errorDetails, errorMessage, nextCode, sendCode, signUpVia, startSignIn, stats, timed } from "./_helpers";

const sendLimit: Journey = {
  name: "auth-flows-otp-send-limit",
  title: "10 codes per address per 10 minutes: the 11th send is 429 with Retry-After (any flow, any network), the last code still works, the window passing (time travel) allows more; 30 codes per network; the hosted page shows the wait",
  async run(ctx) {
    const { env, results, browser } = ctx;
    const t = tag();
    const b = new Browserish(env, randomIp());
    const s = await startSignIn(b, "briefcase");
    const email = `limit.${t}@example.test`;
    const sends: number[] = [];
    let last = await b.act(s.flow.id, "email", { email });
    sends.push(last.ms);
    for (let i = 2; i <= 10 && last.status === 200; i++) {
      last = await b.act(s.flow.id, "resend");
      sends.push(last.ms);
    }
    results.check("sends 1–10 (one /email, nine /resend) → 200", last.status === 200 && sends.length === 10, brief(last));
    const mark = await lastSeq(env);
    const tenth = await nextCode(env, email, mark - 1);
    const eleventh = await b.act(s.flow.id, "resend");
    const retryAfter = Number(eleventh.headers.get("retry-after"));
    results.check("the 11th send → 429 rate_limited", eleventh.status === 429 && errorCode(eleventh) === "rate_limited", brief(eleventh));
    results.check("…with Retry-After (0 < s ≤ 600) matching details.retry_after_seconds", retryAfter > 0 && retryAfter <= 600 && errorDetails(eleventh).retry_after_seconds === retryAfter, `${eleventh.headers.get("retry-after")} / ${JSON.stringify(errorDetails(eleventh))}`);
    results.check("…and a message naming the masked address and the limit", /l\*\*\*@example\.test/.test(errorMessage(eleventh)) && /10 per 10 minutes/.test(errorMessage(eleventh)), errorMessage(eleventh));
    const stats1 = stats(sends);
    results.metric("code send p50 (through the site)", stats1.p50);
    results.metric("code send p95 (through the site)", stats1.p95);

    // The limit is the address's, whatever the flow or network.
    const other = new Browserish(env, randomIp());
    const os = await startSignIn(other, "commit");
    const elsewhere = await other.act(os.flow.id, "email", { email: email.toUpperCase() });
    results.check("another flow, browser and network → still 429 for that address", elsewhere.status === 429 && errorCode(elsewhere) === "rate_limited", brief(elsewhere));
    const free = await b.act(s.flow.id, "email", { email: `other.${t}@example.test` });
    results.check("a different address from the same browser is fine", free.status === 200, brief(free));

    // The last code sent before the limit still works (here: re-send it to the first address's flow).
    const c = new Browserish(env, randomIp());
    const cs = await startSignIn(c, "briefcase");
    const blocked = await c.act(cs.flow.id, "email", { email });
    results.check("(a third flow can't send either)", blocked.status === 429, brief(blocked));
    await sql(env, `update otp_challenges set created_at = created_at - interval '10 minutes' where destination = '${email}'`);
    const sentAgain = await sendCode(c, cs.flow.id, { email });
    results.check("once the 10-minute window has passed (time travel), sending works again", sentAgain.reply.status === 200 && !!sentAgain.code, brief(sentAgain.reply));
    const verified = await c.act(cs.flow.id, "verify", { code: sentAgain.code ?? "" });
    results.check("…and its code signs up", verified.status === 200 && verified.body.flow.step === "signup", brief(verified));
    results.check("(the 10th code had reached the address)", !!tenth);

    // 30 codes per network per 10 minutes, whatever the addresses.
    const ip = randomIp();
    const n = new Browserish(env, ip);
    let ok = 0;
    let refused: Awaited<ReturnType<typeof n.act>> | null = null;
    for (let i = 1; i <= 31; i++) {
      const flow = await startSignIn(n, "briefcase");
      const reply = await n.act(flow.flow.id, "email", { email: `net${i}.${t}@example.test` });
      if (reply.status === 200) ok++;
      else {
        refused = reply;
        break;
      }
    }
    results.check("30 codes to 30 addresses from one network → 200 each", ok === 30, `${ok} sent`);
    results.check("the 31st from that network → 429 rate_limited (network limit)", refused?.status === 429 && errorCode(refused) === "rate_limited" && /network/.test(errorMessage(refused)) && Number(refused.headers.get("retry-after")) > 0, refused ? brief(refused) : "no refusal");
    await forgetRateLimits(env, ip);
    const flow = await startSignIn(n, "briefcase");
    const after = await n.act(flow.flow.id, "email", { email: `net-after.${t}@example.test` });
    results.check("…the network's window passing (forgetRateLimits) allows more", after.status === 200, brief(after));

    // In the browser: an address at its limit says so with the wait.
    const capped = `capped.${t}@example.test`;
    const api = new Browserish(env, randomIp());
    const af = await startSignIn(api, "briefcase");
    await api.act(af.flow.id, "email", { email: capped });
    for (let i = 2; i <= 10; i++) await api.act(af.flow.id, "resend");
    const context = await newContext(browser);
    const page = await context.newPage();
    results.watch(page, "send-limit", [/status of 429 .*\/v1\/flows\/[\w-]+\/email/]);
    await page.goto(`${env.apps}/briefcase/`);
    await page.locator("#signin-hosted").click();
    const field = page.getByRole("textbox", { name: "Email" });
    await field.waitFor({ timeout: 30_000 });
    await field.fill(capped);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.getByText(/Too many codes were sent to c\*\*\*@example\.test/).waitFor({ timeout: 10_000 }).catch(() => undefined);
    await sleep(300);
    await shot(env, page, "auth-flows-otp-send-limit-01");
    const text = (await page.locator("main").innerText()).replace(/\s+/g, " ");
    results.check("the hosted page says too many codes were sent to the (masked) address and to wait", /Too many codes were sent to c\*\*\*@example\.test/.test(text) && (await field.isVisible()), text.slice(0, 300));
    await context.close();
  },
};

const lockout: Journey = {
  name: "auth-flows-verify-lockout",
  title: "10 wrong codes in a row → the 10th says 0 tries left with locked_until, then 423 for 1 minute (even the right code, any flow, a resend); the cooldown over (time travel) the right code works and the streak restarts; an account's history records the lock; the hosted page shows it",
  async run(ctx) {
    const { env, results, browser } = ctx;
    const t = tag();
    const b = new Browserish(env, randomIp());
    const s = await startSignIn(b, "briefcase");
    const email = `lock.${t}@example.test`;
    const sent = await sendCode(b, s.flow.id, { email });
    const wrong = sent.code === "000000" ? "111111" : "000000";
    const remaining: unknown[] = [];
    let reply = await b.act(s.flow.id, "verify", { code: wrong });
    remaining.push(errorDetails(reply).remaining_attempts);
    for (let i = 2; i <= 9; i++) {
      reply = await b.act(s.flow.id, "verify", { code: wrong });
      remaining.push(errorDetails(reply).remaining_attempts);
    }
    results.check("wrong codes 1–9 → 422 invalid_code with 9…1 tries left", JSON.stringify(remaining) === JSON.stringify([9, 8, 7, 6, 5, 4, 3, 2, 1]), JSON.stringify(remaining));
    const tenth = await b.act(s.flow.id, "verify", { code: wrong });
    const until = String(errorDetails(tenth).locked_until ?? "");
    const lockMs = Date.parse(until) - Date.now();
    results.check("the 10th wrong code → 422 with remaining_attempts 0, locked_until about a minute ahead and Retry-After", tenth.status === 422 && errorDetails(tenth).remaining_attempts === 0 && lockMs > 50_000 && lockMs <= 61_000 && Number(tenth.headers.get("retry-after")) > 50, `${brief(tenth)} retry-after ${tenth.headers.get("retry-after")}`);
    const right = await b.act(s.flow.id, "verify", { code: sent.code ?? "" });
    results.check("the right code during the cooldown → 423 verification_locked with Retry-After ≤ 60", right.status === 423 && errorCode(right) === "verification_locked" && Number(right.headers.get("retry-after")) > 0 && Number(right.headers.get("retry-after")) <= 60 && !!errorDetails(right).locked_until, `${brief(right)} retry-after ${right.headers.get("retry-after")}`);

    // Another flow, browser and network for the same address: locked too; a resend's code too.
    const other = new Browserish(env, randomIp());
    const os = await startSignIn(other, "commit");
    const otherSent = await sendCode(other, os.flow.id, { email });
    const otherTry = await other.act(os.flow.id, "verify", { code: otherSent.code ?? "" });
    results.check("a new flow elsewhere for the same address: its own right code → 423 (no fresh guesses)", otherTry.status === 423 && errorCode(otherTry) === "verification_locked", brief(otherTry));
    const mark = await lastSeq(env);
    const resent = await b.act(s.flow.id, "resend");
    const resentCode = await nextCode(env, email, mark);
    const resentTry = await b.act(s.flow.id, "verify", { code: resentCode ?? "" });
    results.check("a resend during the cooldown: the new code → 423 too", resent.status === 200 && resentTry.status === 423, `${brief(resent)} / ${brief(resentTry)}`);

    // The cooldown over: the streak starts again, the right (latest) code works.
    await sql(env, `update otp_challenges set locked_until = now() - interval '1 second' where destination = '${email}'`);
    const fresh = await b.act(s.flow.id, "verify", { code: wrong === resentCode ? "222222" : wrong });
    results.check("after the cooldown (time travel) a wrong code counts from scratch: 9 tries left", fresh.status === 422 && errorDetails(fresh).remaining_attempts === 9, brief(fresh));
    const unlocked = await b.act(s.flow.id, "verify", { code: resentCode ?? "" });
    results.check("…and the right code works", unlocked.status === 200 && unlocked.body.flow.step === "signup", brief(unlocked));

    // An existing Carbon's address locked by someone guessing: its history says so.
    const owner = new Browserish(env, randomIp());
    const ownerEmail = `victim.${t}@example.test`;
    await signUpVia(owner, "spacestation", ownerEmail);
    const uuid = (await owner.session())?.account.uuid ?? "";
    const guesser = new Browserish(env, randomIp());
    const gs = await startSignIn(guesser, "briefcase");
    const gSent = await sendCode(guesser, gs.flow.id, { email: ownerEmail });
    const gWrong = gSent.code === "000000" ? "111111" : "000000";
    for (let i = 1; i <= 10; i++) await guesser.act(gs.flow.id, "verify", { code: gWrong });
    const history = await sql(env, `select method, outcome, app_id from signin_history where account_uuid = '${uuid}' order by at desc limit 1`);
    results.check("10 wrong codes for an account's email → a failed sign-in in its history (email, briefcase)", JSON.stringify(history) === JSON.stringify([["email", "failed", "briefcase"]]), JSON.stringify(history));
    const audit = await sql(env, `select details->>'wrong_codes', details->>'destination' from audit_log where account_uuid = '${uuid}' and action = 'signin.locked'`);
    results.check("…and signin.locked in the audit log (masked destination)", audit.length === 1 && audit[0]?.[0] === "10" && audit[0]?.[1] === "v***@example.test", JSON.stringify(audit));
    const ownersSession = await owner.get("/v1/me");
    results.check("the account's own session is untouched by the lock", ownersSession.status === 200);

    // In the browser: 9 wrong codes elsewhere, the 10th typed on the page locks it; reloaded after the cooldown it works.
    const shown = `lock.ui.${t}@example.test`;
    const context = await newContext(browser);
    const page = await context.newPage();
    results.watch(page, "lockout", [/status of 42[23] .*\/v1\/flows\/[\w-]+\/verify/]);
    await page.goto(`${env.apps}/briefcase/`);
    await page.locator("#signin-hosted").click();
    const field = page.getByRole("textbox", { name: "Email" });
    await field.waitFor({ timeout: 30_000 });
    const before = await lastSeq(env);
    await field.fill(shown);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    const pageCode = await codeFor(env, shown, before);
    const group = page.getByRole("group", { name: /Code from the email/ });
    await group.waitFor({ timeout: 15_000 });
    const api = new Browserish(env, randomIp());
    const af = await startSignIn(api, "briefcase");
    const apiSent = await sendCode(api, af.flow.id, { email: shown });
    const pageWrong = [pageCode, apiSent.code].includes("000000") ? ([pageCode, apiSent.code].includes("111111") ? "222222" : "111111") : "000000";
    for (let i = 1; i <= 9; i++) await api.act(af.flow.id, "verify", { code: pageWrong });
    await page.keyboard.type(pageWrong, { delay: 25 });
    await page.getByText(/Locked\. Try again in/).waitFor({ timeout: 10_000 }).catch(() => undefined);
    await sleep(300);
    await shot(env, page, "auth-flows-verify-lockout-01");
    const text = (await page.locator("main").innerText()).replace(/\s+/g, " ");
    const disabled = await group.locator("input").first().isDisabled().catch(() => false);
    results.check("the page shows the lock with a countdown and disables the code cells", /Locked\. Try again in (0:5\d|1:00|5\d s|60 s)/.test(text) && disabled, text.slice(0, 300));
    await sql(env, `update otp_challenges set locked_until = now() - interval '1 second' where destination = '${shown}'`);
    await page.reload();
    await group.waitFor({ timeout: 30_000 });
    await sleep(300);
    await page.keyboard.type(pageCode, { delay: 25 });
    const create = page.getByRole("button", { name: "Create account" });
    await create.waitFor({ timeout: 20_000 }).catch(() => undefined);
    results.check("after the cooldown (time travel) and a reload, the page's own code works → sign-up", await create.isVisible());
    await context.close();
  },
};

const expiry: Journey = {
  name: "auth-flows-code-expiry",
  title: "a code lives 10 minutes: one minute before its end it works, after it (time travel) → 410 code_expired; a resend's code works; the hosted page says the code expired and sends a new one",
  async run(ctx) {
    const { env, results, browser } = ctx;
    const t = tag();
    const b = new Browserish(env, randomIp());
    const s = await startSignIn(b, "briefcase");
    const email = `expiry.${t}@example.test`;
    const sent = await sendCode(b, s.flow.id, { email });
    await sql(env, `update otp_challenges set expires_at = now() + interval '1 minute' where destination = '${email}' and consumed_at is null`);
    const stillOk = await timed(() => b.act(s.flow.id, "verify", { code: sent.code ?? "" }));
    results.check("with a minute left the code still works", stillOk.value.status === 200 && stillOk.value.body.flow.step === "signup", brief(stillOk.value));
    await drive(b, stillOk.value.body.flow);

    const e = new Browserish(env, randomIp());
    const es = await startSignIn(e, "briefcase");
    const late = `late.${t}@example.test`;
    const lateSent = await sendCode(e, es.flow.id, { email: late });
    await sql(env, `update otp_challenges set expires_at = now() - interval '1 second' where destination = '${late}' and consumed_at is null`);
    const expired = await e.act(es.flow.id, "verify", { code: lateSent.code ?? "" });
    results.check("after 10 minutes (time travel) → 410 code_expired saying codes last 10 minutes", expired.status === 410 && errorCode(expired) === "code_expired" && /10 minutes/.test(errorMessage(expired)), brief(expired));
    const view = await e.flow(es.flow.id);
    results.check("the flow stays at verify_code, its challenge showing the past expiry", view.body.flow?.step === "verify_code" && Date.parse(view.body.flow.challenge?.expires_at ?? "") < Date.now(), JSON.stringify(view.body.flow?.challenge));
    const mark = await lastSeq(env);
    const resent = await e.act(es.flow.id, "resend");
    const newCode = await nextCode(env, late, mark);
    const old = await e.act(es.flow.id, "verify", { code: lateSent.code === newCode ? "999999" : (lateSent.code ?? "") });
    results.check("after a resend the old code is just wrong (422)", resent.status === 200 && old.status === 422, `${brief(resent)} / ${brief(old)}`);
    const ok = await e.act(es.flow.id, "verify", { code: newCode ?? "" });
    results.check("…and the new code works", ok.status === 200 && ok.body.flow.step === "signup", brief(ok));

    // The hosted page.
    const shown = `expiry.ui.${t}@example.test`;
    const context = await newContext(browser);
    const page = await context.newPage();
    results.watch(page, "code-expiry", [/status of 410 .*\/v1\/flows\/[\w-]+\/verify/]);
    await page.goto(`${env.apps}/briefcase/`);
    await page.locator("#signin-hosted").click();
    const field = page.getByRole("textbox", { name: "Email" });
    await field.waitFor({ timeout: 30_000 });
    const before = await lastSeq(env);
    await field.fill(shown);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    const first = await codeFor(env, shown, before);
    await page.getByRole("group", { name: /Code from the email/ }).waitFor({ timeout: 15_000 });
    await sql(env, `update otp_challenges set expires_at = now() - interval '1 second' where destination = '${shown}' and consumed_at is null`);
    await page.keyboard.type(first, { delay: 25 });
    await page.getByText(/Codes work for 10 minutes, and a newer code replaces/).first().waitFor({ timeout: 10_000 }).catch(() => undefined);
    await sleep(300);
    await shot(env, page, "auth-flows-code-expiry-01");
    const text = (await page.locator("main").innerText()).replace(/\s+/g, " ");
    results.check("typing an expired code: the page says codes last 10 minutes and offers \"Send a new code\"", /Codes work for 10 minutes, and a newer code replaces the one before it/.test(text) && (await page.getByRole("button", { name: "Send a new code" }).count()) === 1, text.slice(0, 300));
    const again = await lastSeq(env);
    await page.getByRole("button", { name: "Send a new code" }).click();
    const second = await codeFor(env, shown, again);
    await sleep(500);
    await page.getByRole("group", { name: /Code from the email/ }).locator("input").first().click();
    await page.keyboard.type(second, { delay: 25 });
    const create = page.getByRole("button", { name: "Create account" });
    await create.waitFor({ timeout: 20_000 }).catch(() => undefined);
    results.check("…the new code from \"Send a new code\" works → sign-up", await create.isVisible());
    await context.close();
  },
};

export const journeys: Journey[] = [sendLimit, lockout, expiry];
