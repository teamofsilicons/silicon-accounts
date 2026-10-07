/**
 * ux-audit: what a Carbon sees when the hosted sign-in cannot go on, provoked for real (the limits) or by moving time
 * in this stack's database (web/e2e/README.md "Time travel"), in light and dark at 1440 and 390 px:
 *
 *   too many codes   10 codes to one address within 10 minutes, then an 11th asked for: the refusal and its countdown
 *   code expired     the code's 10 minutes over before it is typed
 *   one try left     8 wrong codes in a row already, then one more: how many tries are left
 *   locked           the 10th wrong code in a row: entry paused for a minute, a live countdown, the cells disabled
 *   sign-up expired  the 48-hour sign-up session over before "Create account"
 *   flow expired     the sign-in's 60 minutes over, then the page opened again
 *   unknown flow     a link to a sign-in that does not exist
 *
 * Each state must say what happened and what to do next in the Carbon's words (UNDERSTANDING.md: never just say
 * something went wrong), offer the way forward, keep API words and internal ids out, and pass the generic audit
 * (_audit.ts: theme, sideways scroll, axe, squircles, console, vocabulary, screenshots).
 */
import type { Page } from "@playwright/test";
import type { Ctx, Journey } from "../../context";
import { codeFor, lastSeq, signInWithCode, sleep, sql } from "../../lib";
import { freshPhone } from "./_hosted";
import { VARIANTS, auditContext, auditVariants, collectConsole, findingsFor, freshEmail, hostedLink, pageFetch, saveFindings, stepReady, waitUntil, type Findings } from "./_audit";

const FLOW_PATH = /\/authorize\/flow\/([^/?#]+)/;
/** The refusals this journey provokes on purpose; the browser logs each 4xx answer as a console error of its own. */
const PROVOKED = [/status of 4\d\d .*\/v1\/flows\b/];
/** "1" with a plural noun ("1 more tries", "1 errors"): a count that does not agree with its word. */
const ONE_PLURAL = /\b1 (?:more |wrong |new )?(?:tries|attempts|codes|errors|rows|seconds|minutes|hours|days)\b/gi;
/** Words written for API clients or developers, which never belong in what a Carbon reads. */
const API_WORDS = /\b(POST|GET|PATCH)\s+\/|\/v1\/|FlowView|flow_id|signup_session|otp_challenge|_[a-z]+_[a-z]+\b|\bnull\b|undefined|\[object/;

/** Opens briefcase's hosted sign-in in `page`; returns the flow id once the email field is on screen. */
async function openFlow(ctx: Ctx, page: Page): Promise<string> {
  await page.goto(await hostedLink(ctx.env, page, "briefcase"));
  await page.getByRole("textbox", { name: "Email" }).waitFor({ timeout: 30_000 });
  await stepReady(page);
  return FLOW_PATH.exec(page.url())?.[1] ?? "";
}

/** Opens an app's hosted sign-in in `page` (its methods page on screen). */
async function openApp(ctx: Ctx, page: Page, app: string): Promise<void> {
  await page.goto(await hostedLink(ctx.env, page, app));
  await page.waitForURL(url => url.pathname.startsWith("/authorize/flow/"), { timeout: 30_000 });
  await page.locator("main h1").first().waitFor({ timeout: 30_000 });
  await stepReady(page);
}

/** A phone number that is already another Carbon's: a new Carbon signs up with it on the account site. */
async function takenPhone(ctx: Ctx): Promise<string> {
  const context = await auditContext(ctx.browser);
  const page = await context.newPage();
  ctx.results.watch(page, "errors-taken-phone");
  const phone = freshPhone();
  await page.goto(`${ctx.env.site}/sign-in`);
  await signInWithCode(ctx.env, page, { phone });
  await page.getByRole("button", { name: "Create account" }).click({ timeout: 30_000 });
  await page.waitForURL(`${ctx.env.site}/`, { timeout: 30_000 });
  await context.close();
  return phone;
}

/** Asks for a code for `email` on the email step and waits for the code step; returns the code. */
async function toCodeStep(ctx: Ctx, page: Page, email: string): Promise<string> {
  const after = await lastSeq(ctx.env);
  await page.getByRole("textbox", { name: "Email" }).fill(email);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  const code = await codeFor(ctx.env, email, after);
  await page.getByRole("group", { name: /Code from the email/ }).waitFor({ timeout: 20_000 });
  await stepReady(page);
  return code;
}

async function typeCode(page: Page, code: string): Promise<void> {
  await page.getByRole("textbox", { name: /digit 1 of 6/ }).first().click();
  await page.keyboard.type(code, { delay: 30 });
}

/** What the step says right now (its main column), in one line. */
const mainText = async (page: Page) => ((await page.locator("main").first().innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();

/** Every alert, status and field message in main, in one line (what changed on the step). */
async function messages(page: Page): Promise<string> {
  return (await page.evaluate(`(() => {
    const main = document.querySelector("main");
    if (!main) return "";
    const seen = new Set();
    const out = [];
    main.querySelectorAll("[role=alert],[role=status],[aria-live],[data-problem],[aria-invalid=true]").forEach(node => {
      const ids = (node.getAttribute("aria-describedby") || "").split(/\\s+/).filter(Boolean);
      const texts = [node.innerText || ""].concat(ids.map(id => (document.getElementById(id) || {}).innerText || ""));
      for (const text of texts) { const t = text.replace(/\\s+/g, " ").trim(); if (t && !seen.has(t)) { seen.add(t); out.push(t); } }
    });
    return out.join(" | ");
  })()`)) as string;
}

/**
 * Everything main says to the Carbon (screen-reader text included, aria-hidden copies left out), except the problem
 * page's small "Details for the app's developers" list, which keeps the exact code for developers on purpose.
 */
async function carbonText(page: Page): Promise<string> {
  return (await page.evaluate(`(() => {
    const main = document.querySelector("main");
    if (!main) return "";
    const skip = Array.from(main.querySelectorAll('dl[aria-label^="Details for"]'));
    const parts = [];
    const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!parent || skip.some(list => list.contains(node)) || parent.closest("[aria-hidden=true],[inert],script,style")) continue;
      parts.push(node.textContent || "");
    }
    return parts.join(" ").replace(/\\s+/g, " ").trim();
  })()`)) as string;
}

/** Checks the words of an error state and audits it in every variant (or `variants`). */
async function judge(ctx: Ctx, page: Page, findings: Findings, name: string, said: string, expect: { what: RegExp; next: RegExp; nextLabel: string }, variants = VARIANTS): Promise<void> {
  const { results } = ctx;
  const carbon = await carbonText(page);
  findings.pages[`${name} words`] = { messages: said, page: carbon };
  results.check(`${name}: says what happened (${expect.what.source})`, expect.what.test(said), said.slice(0, 400));
  results.check(`${name}: says what to do next (${expect.nextLabel})`, expect.next.test(said), said.slice(0, 400));
  results.check(`${name}: no API words, internal ids or exact instants in what the Carbon reads`, !API_WORDS.test(carbon) && !/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(carbon), carbon.slice(0, 500));
  const disagree = carbon.match(ONE_PLURAL) ?? [];
  results.check(`${name}: numbers agree with their words (never "1 more tries")`, disagree.length === 0, disagree.length ? `${disagree.join(", ")} in: ${carbon.slice(0, 300)}` : "");
  await auditVariants(ctx, page, findings, name, variants, { expectedConsole: PROVOKED });
}

export const journeys: Journey[] = [
  {
    name: "ux-audit-hosted-errors",
    title: "the hosted sign-in when it cannot go on (too many codes, an expired code, one try left, locked, an expired sign-up, an expired or unknown sign-in): words, a way forward, and the audit at light/dark × 1440/390",
    timeoutMs: 900_000,
    async run(ctx) {
      const { env, results, browser } = ctx;
      const findings = findingsFor(ctx);
      const context = await auditContext(browser);
      const page = await context.newPage();
      results.watch(page, "hosted-errors", PROVOKED);
      collectConsole(page, PROVOKED);

      // 1. Too many codes to one address: 10 within 10 minutes (sent from another sign-in: the limit is per address,
      // whichever sign-in asks), then the 11th from this page.
      const busy = freshEmail("uxa.errors.sends");
      {
        const helperContext = await auditContext(browser);
        const helper = await helperContext.newPage();
        results.watch(helper, "hosted-errors-sender");
        let flowId = await openFlow(ctx, helper);
        const answers: string[] = [];
        let sent = 0;
        for (let i = 0; i < 14 && sent < 10; i++) {
          const answer = await pageFetch<{ error?: { code?: string } }>(helper, `/v1/flows/${flowId}/email`, { method: "POST", body: { email: busy } });
          answers.push(`${answer.status}${answer.body?.error?.code ? ` ${answer.body.error.code}` : ""}`);
          if (answer.status < 300) sent++;
          // A sign-in that will not send again (it moved on) is swapped for a new one; the address's count stays.
          else flowId = await openFlow(ctx, helper);
        }
        results.check("too-many-codes: 10 codes went to one address within 10 minutes (the per-address limit)", sent === 10, answers.join(", "));
        await helperContext.close();
      }
      await openFlow(ctx, page);
      await page.getByRole("textbox", { name: "Email" }).fill(busy);
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      const waiting = page.getByRole("button", { name: /^Try again in \d+:\d\d$/ });
      const refused = await waiting.waitFor({ timeout: 15_000 }).then(() => true, () => false);
      results.check("too-many-codes: the 11th is refused and the button counts down to when it may go (\"Try again in m:ss\")", refused, (await mainText(page)).slice(0, 300));
      const countdown = (await waiting.innerText().catch(() => "")).trim();
      const minutes = Number(/(\d+):\d\d/.exec(countdown)?.[1] ?? "-1");
      results.check("too-many-codes: the countdown is the rest of the 10-minute window (9 to 10 minutes)", minutes >= 8 && minutes <= 10, countdown || "(no countdown)");
      await stepReady(page);
      await judge(ctx, page, findings, "errors-too-many-codes", `${await messages(page)} | ${countdown}`, { what: /too many codes|10 per 10 minutes|limit/i, next: /try again in \d+:\d\d|wait/i, nextLabel: "when to try again" });

      // 2. A code whose 10 minutes are over before it is typed.
      const expiredEmail = freshEmail("uxa.errors.expired");
      await openFlow(ctx, page);
      const expiredCode = await toCodeStep(ctx, page, expiredEmail);
      await sql(env, `update otp_challenges set expires_at = now() - interval '1 second' where destination = '${expiredEmail}' and consumed_at is null`);
      await typeCode(page, expiredCode);
      await waitUntil(page, `/expired/i.test((document.querySelector("main") || {}).innerText || "")`, 15_000);
      await stepReady(page);
      const resend = page.getByRole("button", { name: /^Resend code|^Send a new code/ }).first();
      const resendText = (await resend.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
      results.check("code-expired: a button to get a new code is right there", (await resend.count()) > 0, resendText || "(none)");
      await judge(ctx, page, findings, "errors-code-expired", await messages(page), { what: /expired/i, next: /new code|resend|send/i, nextLabel: "get a new code" });

      // 3 and 4. Wrong codes: 8 in a row already (moved in the database), then the 9th (one try left) and the 10th (locked).
      const lockEmail = freshEmail("uxa.errors.locked");
      await openFlow(ctx, page);
      const rightCode = await toCodeStep(ctx, page, lockEmail);
      await sql(env, `update otp_challenges set failed_streak = 8, total_failures = 8 where destination = '${lockEmail}' and consumed_at is null`);
      const wrong = rightCode === "000000" ? "111111" : "000000";
      await typeCode(page, wrong);
      await waitUntil(page, `/(1|one) (try|attempt)|left|wrong|incorrect|does not match/i.test((document.querySelector("main [role=alert]") || {}).innerText || "")`, 15_000);
      await stepReady(page);
      await judge(ctx, page, findings, "errors-one-try-left", await messages(page), { what: /wrong|incorrect|does not match|not the code/i, next: /\b(1|one) (more )?(try|tries|attempts?)\b|last (try|attempt)/i, nextLabel: "how many tries are left" });
      await typeCode(page, wrong);
      const lockedShown = await waitUntil(page, `/Try again in \\d+:\\d\\d/.test((document.querySelector("main") || {}).innerText || "")`, 15_000);
      const cells = page.getByRole("textbox", { name: /digit \d of 6/ });
      const disabled = await cells.evaluateAll(nodes => nodes.filter(node => (node as HTMLInputElement).disabled).length);
      results.check("locked: the 10th wrong code pauses entry with a live countdown (\"Try again in m:ss\")", lockedShown, (await messages(page)).slice(0, 300));
      results.check("locked: the code cells are disabled while it counts down", disabled === 6, `${disabled} of 6 disabled`);
      // The countdown ticks every second: it should change in place, not be made anew (with its entrance animation,
      // and announced again as a new status) on every tick; and a ticking time does not belong in a live region
      // (WAI-ARIA: a timer's role is "timer", which is not announced on each change).
      const ticking = (await page.evaluate(`new Promise(done => {
        const main = document.querySelector("main");
        let made = 0;
        const observer = new MutationObserver(list => { for (const m of list) for (const node of m.addedNodes) if (node.nodeType === 1 && /Try again in \\d+:\\d\\d/.test(node.textContent || "") && (node.matches("[role=status],[role=alert],[aria-live]") || node.querySelector("[role=status],[role=alert],[aria-live]"))) made++; });
        observer.observe(main, { childList: true, subtree: true, characterData: true });
        setTimeout(() => {
          observer.disconnect();
          const holders = Array.from(main.querySelectorAll("*")).filter(el => el.children.length === 0 && /Try again in \\d+:\\d\\d/.test(el.textContent || ""));
          const live = holders.map(el => el.closest("[role=status],[role=alert],[aria-live]:not([aria-live=off])")).filter(Boolean).map(el => el.tagName.toLowerCase() + "[" + (el.getAttribute("role") || "aria-live=" + el.getAttribute("aria-live")) + "]");
          done({ made, live });
        }, 2600);
      })`)) as { made: number; live: string[] };
      findings.pages["errors-locked countdown"] = ticking;
      results.check("locked: the countdown changes in place (no new status note, re-animated, every second)", ticking.made === 0, `${ticking.made} new status notes in 2.6 s`);
      results.check("locked: the ticking countdown is not in a live region (it would be announced every second)", ticking.live.length === 0, ticking.live.join(", ") || "not in a live region");
      // The lock lasts a minute: two variants (light 1440, dark 390) fit in it.
      await judge(ctx, page, findings, "errors-locked", await messages(page), { what: /too many|wrong codes|paused|locked/i, next: /try again in \d+:\d\d|wait/i, nextLabel: "when entry opens again" }, [VARIANTS[0]!, VARIANTS[3]!]);

      // 5. A sign-up session past its 48 hours, then "Create account".
      const lateEmail = freshEmail("uxa.errors.late");
      await openFlow(ctx, page);
      const lateCode = await toCodeStep(ctx, page, lateEmail);
      await typeCode(page, lateCode);
      const create = page.getByRole("button", { name: "Create account" });
      await create.waitFor({ timeout: 30_000 });
      await stepReady(page);
      await sql(env, `update signup_sessions set expires_at = now() - interval '1 second' where verified_email = '${lateEmail}'`);
      await create.click();
      await waitUntil(page, `/expired/i.test((document.querySelector("main") || {}).innerText || "")`, 15_000);
      await stepReady(page);
      const lateWords = await messages(page);
      const lateActions = await page.locator("main").first().getByRole("button").allInnerTexts().catch(() => [] as string[]);
      findings.pages["errors-signup-expired actions"] = lateActions;
      await judge(ctx, page, findings, "errors-signup-expired", `${lateWords} | buttons: ${lateActions.join(", ")}`, { what: /sign-up expired|expired/i, next: /again|start|verify|sign in/i, nextLabel: "how to start again" });

      // 6. A sign-in past its 60 minutes, opened again.
      const staleFlow = await openFlow(ctx, page);
      await sql(env, `update signin_flows set expires_at = now() - interval '1 second' where id = '${staleFlow.replace(/'/g, "")}'`);
      await page.reload();
      await waitUntil(page, `!!document.querySelector("main [data-problem], main [role=alert]")`, 20_000);
      await stepReady(page);
      const staleWords = `${await mainText(page)}`;
      const staleLinks = await page.locator("main").first().locator("a[href], button").allInnerTexts().catch(() => [] as string[]);
      await judge(ctx, page, findings, "errors-flow-expired", `${staleWords} | actions: ${staleLinks.join(", ")}`, { what: /expired|no longer|ended|timed out/i, next: /back to|start again|sign in again|try again|go to/i, nextLabel: "a way back to the app or to start again" });

      // 7. A sign-in that does not exist.
      await page.goto(`${env.site}/authorize/flow/uxaNoSuchFlow0000000000`);
      await waitUntil(page, `!!document.querySelector("main [data-problem], main [role=alert]")`, 20_000);
      await sleep(300);
      await stepReady(page);
      const unknownWords = await mainText(page);
      await judge(ctx, page, findings, "errors-unknown-flow", unknownWords, { what: /not found|no sign-in|does not exist|doesn't exist|expired|ended|cannot|can't/i, next: /back to|start again|go to|sign in|try again/i, nextLabel: "where to go instead" });

      // 8 and 9 (v2). On dm's own page, the phone it requires: a phone already on another account, then a code whose
      // 10 minutes are over before it is typed (details/add and details/verify).
      {
        const dmEmail = freshEmail("uxa.errors.dm");
        await openApp(ctx, page, "dm");
        await page.getByRole("button", { name: "Email", exact: true }).click().catch(() => undefined);
        await toCodeStep(ctx, page, dmEmail).then(code => typeCode(page, code));
        await page.getByRole("button", { name: "Create account" }).click({ timeout: 30_000 });
        const adder = page.locator('[data-adding="phone"]:not([data-step-leaving] *)').first();
        await adder.waitFor({ timeout: 30_000 });
        await stepReady(page);
        // A phone that is already another Carbon's.
        const taken = await takenPhone(ctx);
        await adder.getByRole("textbox", { name: "Phone number" }).click();
        await page.keyboard.type(taken, { delay: 20 });
        await adder.getByRole("button", { name: "Send code" }).click();
        await waitUntil(page, `/another account|already|in use|belongs/i.test((document.querySelector("main") || {}).innerText || "")`, 15_000);
        await stepReady(page);
        await judge(ctx, page, findings, "errors-details-phone-in-use", await messages(page), { what: /another account|already|in use|belongs/i, next: /another (number|phone)|use a different|sign in|switch/i, nextLabel: "what to do instead" }, [VARIANTS[0]!, VARIANTS[3]!]);
        // A new number, its code expired before it is typed.
        const fresh = freshPhone();
        const field = adder.getByRole("textbox", { name: "Phone number" });
        await field.click();
        await page.keyboard.press("ControlOrMeta+a");
        await page.keyboard.press("Backspace");
        const after = await lastSeq(env);
        await page.keyboard.type(fresh, { delay: 20 });
        await adder.getByRole("button", { name: "Send code" }).click();
        const sms = await codeFor(env, fresh, after);
        await page.getByRole("group", { name: /^Code from the text message/ }).first().waitFor({ timeout: 20_000 });
        await stepReady(page);
        await sql(env, `update otp_challenges set expires_at = now() - interval '1 second' where destination = '${fresh}' and consumed_at is null`);
        await page.getByRole("group", { name: /^Code from the text message/ }).first().getByRole("textbox").first().click();
        await page.keyboard.type(sms, { delay: 30 });
        await waitUntil(page, `/expired/i.test((document.querySelector("main") || {}).innerText || "")`, 15_000);
        await stepReady(page);
        await judge(ctx, page, findings, "errors-details-code-expired", await messages(page), { what: /expired/i, next: /new code|resend|send/i, nextLabel: "get a new code" }, [VARIANTS[0]!, VARIANTS[3]!]);
      }

      results.check("hosted-errors: findings saved", true, saveFindings(ctx, findings));
      await context.close();
    },
  },
];
