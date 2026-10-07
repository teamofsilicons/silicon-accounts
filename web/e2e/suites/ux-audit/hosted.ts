/**
 * ux-audit: every page of an app's hosted sign-in (UNDERSTANDING.md v2), for several brandings, in light and dark at
 * 1440 and 390 px (an app that forces a theme is looked at in that theme only):
 *
 *   default   briefcase: the site's own look (card). The sign-in and the sign-up version of the methods page (intent),
 *             the pages its own "Continue with email" / "Continue with phone number" buttons open (the empty field), a
 *             login_hint ignored, the code, a wrong code, setting up, its what's-shared page (email required, timezone
 *             optional and unticked), "Continue as" on the next sign-in
 *   acme      acme-notes: split, forced dark, Fraunces, grain; its own sign-up title; the hero copy beside the form
 *             follows the step
 *   pixel     pixel-studio: minimal layout, sharp corners, outline buttons, forced light
 *   ledgerly  ledgerly's two-page flow with a review: the sign-up version, "Step 1 of 2" adding the phone it requires
 *             (Continue pressed first says what is missing), "Step 2 of 2" in its own split layout, the review, Back
 *             (choices kept), the review again
 *   dm        dm's one custom page "Set up DM" ("Start messaging"): the phone it requires added on the page, an optional
 *             email ticked; the next sign-in goes straight back to dm (nothing new to share)
 *   asks      an app that asks for more later: the page says so and marks the new detail
 *   orbit     orbit-games (Apple only, its own Apple, compact, forced dark): methods, Apple, setting up, what is shared
 *   campus    campus-connect (email domains limited to university.test): the refusal of another domain
 *
 * Each page: the generic audit (_audit.ts) plus "Powered by Silicon Accounts": present, never covered or overlapping,
 * linking to accounts.teamofsilicons.com, and in view on pages that fit the screen.
 */
import type { Page } from "@playwright/test";
import type { Ctx, Journey } from "../../context";
import { appAccount, appUrl, chooseMockIdentity, hostedTitle, live, sleep, startAtApp, tag, type SigninMethod } from "../../lib";
import { VARIANTS, auditContext, collectConsole, findingsFor, forcedVariants, freshEmail, hostedLink, pageFetch, saveFindings, sendEmailCode, signedInCarbon, stepReady, ownedApp, type Findings, type Theme, type Variant } from "./_audit";
import { auditStep, freshPhone, typeCode, walkDetails, type DetailsPlan } from "./_hosted";

/** The browser's own log line for the 422 a wrong code gets. */
const WRONG_CODE = /status of 422 .*\/v1\/flows\/[^/ ]+\/(verify|details\/verify)/;

/** The page the app's link opens: waits for its heading and the morph to settle; returns the heading. */
async function openHosted(ctx: Ctx, page: Page, app: string, options: { intent?: "signin" | "signup"; method?: SigninMethod; extra?: Record<string, string | null> } = {}): Promise<string> {
  await startAtApp(ctx.env, page, app, options);
  await page.waitForURL(url => url.pathname.startsWith("/authorize/flow/"), { timeout: 30_000 });
  const title = await hostedTitle(page);
  await stepReady(page);
  return title;
}

interface EmailPlan {
  app: string;
  label: string;
  forced?: Theme;
  wrongCode?: boolean;
  /** The methods page's heading for each intent. */
  titles?: { signin?: RegExp; signup?: RegExp };
  /** The walk itself starts from the app's "Create an account" (intent=signup) instead of its sign-in link. */
  startWithSignup?: boolean;
  /** Expected split-layout hero copy per step (acme-notes). */
  hero?: { methods: RegExp; signup: RegExp; details: RegExp };
  /** The app's own direct buttons to open (the hosted page opens on that method's empty field). */
  direct?: Array<"email" | "phone">;
  /** The details pages. */
  details?: Omit<DetailsPlan, "app" | "prefix" | "variants" | "forced">;
  /** Sign in again: "Continue as", and nothing new to share. */
  again?: boolean;
}

/** A new Carbon through an app's hosted pages with an email code, auditing every page on the way. */
async function emailWalk(ctx: Ctx, plan: EmailPlan): Promise<void> {
  const { env, results, browser } = ctx;
  const findings = findingsFor(ctx);
  const variants = plan.forced ? forcedVariants(plan.forced) : VARIANTS;
  const context = await auditContext(browser);
  const page = await context.newPage();
  // A wrong code is answered 422 on purpose; the browser logs that response as a console error of its own.
  const expected = plan.wrongCode ? [WRONG_CODE] : [];
  results.watch(page, plan.label, expected);
  collectConsole(page, expected);
  const prefix = `hosted-${plan.label}`;

  // The sign-up version of the methods page (the app's "Create an account"), unless the walk starts there.
  if (plan.titles?.signup && !plan.startWithSignup) {
    const title = await openHosted(ctx, page, plan.app, { intent: "signup" });
    results.check(`${prefix}-methods-signup: the app's "Create an account" opens the sign-up version ("${plan.titles.signup.source}")`, plan.titles.signup.test(title), title);
    await auditStep(ctx, page, findings, `${prefix}-methods-signup`, variants, { forced: plan.forced });
  }

  // The app's own direct buttons: email and phone open on their field, empty (an app never hands us either).
  for (const method of plan.direct ?? []) {
    await openHosted(ctx, page, plan.app, { method });
    const field = page.getByRole("textbox", { name: method === "email" ? "Email" : "Phone number" });
    const shown = await field.waitFor({ timeout: 15_000 }).then(() => true, () => false);
    const value = shown ? await field.inputValue() : "(no field)";
    const other = await page.getByRole("button", { name: /^Other ways to sign (in|up)$/ }).count();
    results.check(`${prefix}-direct-${method}: the app's "Continue with ${method === "email" ? "email" : "phone number"}" opens straight on the ${method} field, empty, with a way to the other methods`, shown && value === "" && other > 0, `field ${shown ? `"${value}"` : "missing"}; "Other ways" buttons: ${other}`);
    await auditStep(ctx, page, findings, `${prefix}-direct-${method}`, [variants[0]!, variants[variants.length - 1]!], { forced: plan.forced, hero: plan.hero?.methods });
  }

  // The methods page the walk starts from.
  const title = await openHosted(ctx, page, plan.app, plan.startWithSignup ? { intent: "signup" } : {});
  const wanted = plan.startWithSignup ? plan.titles?.signup : plan.titles?.signin;
  if (wanted) results.check(`${prefix}-methods: the heading is "${wanted.source}"`, wanted.test(title), title);
  await auditStep(ctx, page, findings, `${prefix}-methods${plan.startWithSignup ? "-signup" : ""}`, variants, { forced: plan.forced, hero: plan.hero?.methods });

  const email = freshEmail(`uxa.${plan.label}`);
  const code = await sendEmailCode(env, page, email);
  await stepReady(page);
  await auditStep(ctx, page, findings, `${prefix}-code`, variants, { forced: plan.forced, hero: plan.hero?.methods });
  if (plan.wrongCode) {
    await typeCode(page, code === "000000" ? "111111" : "000000");
    const error = page.locator("main [role=alert]").first();
    await error.waitFor({ timeout: 10_000 }).catch(() => undefined);
    await stepReady(page);
    const text = (await error.innerText().catch(() => "")).replace(/\s+/g, " ");
    results.check(`${prefix}: a wrong code says what happened and what to do`, /code/i.test(text) && text.length > 15, text);
    await auditStep(ctx, page, findings, `${prefix}-code-wrong`, variants, { forced: plan.forced, expectedConsole: [WRONG_CODE] });
  }
  await typeCode(page, code);

  const create = page.getByRole("button", { name: "Create account" });
  await create.waitFor({ timeout: 30_000 });
  await stepReady(page);
  await auditStep(ctx, page, findings, `${prefix}-signup`, variants, { forced: plan.forced, fullPage: true, hero: plan.hero?.signup });
  await create.click();

  const walk = await walkDetails(ctx, page, findings, { app: plan.app, prefix, variants, forced: plan.forced, hero: plan.hero?.details, ...plan.details });
  findings.pages[`${prefix} details walk`] = walk;
  await page.waitForURL(appUrl(env, plan.app), { timeout: 30_000 });
  const account = await appAccount(page);
  results.check(`${prefix}: the app received the new account`, typeof account?.uuid === "string", JSON.stringify(account).slice(0, 160));

  if (plan.again) {
    await page.goto(await hostedLink(env, page, plan.app));
    const continueAs = page.getByRole("button", { name: /^Continue as/ });
    await continueAs.waitFor({ timeout: 30_000 });
    await stepReady(page);
    // A returning Carbon: the app's own sign-in copy ("Welcome back to Acme Notes") is right here.
    await auditStep(ctx, page, findings, `${prefix}-continue-as`, variants, { forced: plan.forced, hero: plan.hero?.methods });
    await continueAs.click();
    await page.waitForURL(appUrl(env, plan.app), { timeout: 30_000 });
    results.check(`${prefix}: "Continue as" goes straight back to the app (nothing new to share, no page in between)`, true);
  }
  results.check(`${prefix}: findings saved`, true, saveFindings(ctx, findings));
  await context.close();
}

export const journeys: Journey[] = [
  {
    name: "ux-audit-hosted-default",
    title: "briefcase's hosted pages in the site's own look: sign-in and sign-up methods, its direct email and phone buttons, code, wrong code, setting up, what's shared (optional unticked), Continue as — light/dark × 1440/390",
    timeoutMs: 900_000,
    async run(ctx) {
      // A login_hint is never prefilled (UNDERSTANDING.md: the Carbon always types it on our pages).
      {
        const context = await auditContext(ctx.browser);
        const page = await context.newPage();
        ctx.results.watch(page, "default-login-hint");
        await openHosted(ctx, page, "briefcase", { extra: { login_hint: `uxa.hint.${tag()}@example.test` } });
        const field = page.getByRole("textbox", { name: "Email" });
        await field.waitFor({ timeout: 15_000 });
        const value = await field.inputValue();
        ctx.results.check("hosted-default: a login_hint in the app's link is ignored (the email field stays empty)", value === "" && !page.url().includes("login_hint"), `field "${value}"; ${page.url()}`);
        await context.close();
      }
      await emailWalk(ctx, {
        app: "briefcase",
        label: "default",
        wrongCode: true,
        titles: { signin: /^Sign in to Briefcase$/, signup: /^Create your Briefcase account$/ },
        direct: ["email", "phone"],
        details: { expect: [{ title: /^Share your details with Briefcase$/, continueLabel: "Share and continue" }] },
        again: true,
      });
    },
  },
  {
    name: "ux-audit-hosted-acme",
    title: "acme-notes' split, dark, Fraunces pages at 1440/390: its own sign-in and sign-up titles, code, wrong code, setting up, what's shared, Continue as, and the hero copy beside the form following the step",
    timeoutMs: 900_000,
    run: ctx =>
      emailWalk(ctx, {
        app: "acme-notes",
        label: "acme",
        forced: "dark",
        wrongCode: true,
        titles: { signin: /^Welcome back to Acme Notes$/, signup: /^Start your Acme notebook$/ },
        hero: { methods: /^Welcome back to Acme Notes$/, signup: /^Welcome to Acme Notes$/, details: /^Welcome to Acme Notes$/ },
        direct: ["email"],
        again: true,
      }),
  },
  {
    name: "ux-audit-hosted-pixel",
    title: "pixel-studio's minimal, sharp, outline pages (forced light) at 1440/390: methods, code, wrong code, setting up, what's shared",
    timeoutMs: 900_000,
    run: ctx => emailWalk(ctx, { app: "pixel-studio", label: "pixel", forced: "light", wrongCode: true, titles: { signin: /^PIXEL STUDIO$/ } }),
  },
  {
    name: "ux-audit-hosted-ledgerly",
    title: "ledgerly's two-page flow with a review (forced light): the sign-up version, Step 1 of 2 adding the required phone (Continue first says what is missing), Step 2 of 2 in its split layout, the review, Back keeps choices",
    timeoutMs: 900_000,
    run: ctx =>
      emailWalk(ctx, {
        app: "ledgerly",
        label: "ledgerly",
        forced: "light",
        startWithSignup: true,
        titles: { signup: /^Create your Ledgerly account$/ },
        direct: ["phone"],
        details: {
          add: { phone: freshPhone() },
          tick: ["timezone"],
          tryContinueFirst: true,
          reviewBack: true,
          expect: [
            { title: /^How can we reach you\?$/, continueLabel: "Continue" },
            { title: /^About you$/, continueLabel: "Review", layout: "split" },
          ],
        },
      }),
  },
  {
    name: "ux-audit-hosted-dm",
    title: "dm's one custom page \"Set up DM\" (Start messaging): the phone it requires added on the page (the button first says what is missing), the optional email ticked; the next sign-in goes straight back — light/dark × 1440/390",
    timeoutMs: 900_000,
    run: ctx =>
      emailWalk(ctx, {
        app: "dm",
        label: "dm",
        titles: { signin: /^Sign in to DM$/ },
        details: {
          add: { phone: freshPhone() },
          tick: ["email"],
          tryContinueFirst: true,
          stateVariants: [VARIANTS[0]!, VARIANTS[3]!],
          expect: [{ title: /^Set up DM$/, continueLabel: "Start messaging" }],
        },
        again: true,
      }),
  },
  {
    name: "ux-audit-hosted-asks-more",
    title: "an app that asks for more later: the returning Carbon's page says the app would like a little more and marks the new detail — light/dark × 1440/390",
    timeoutMs: 600_000,
    async run(ctx) {
      const { env, results } = ctx;
      const findings = findingsFor(ctx);
      const carbon = await signedInCarbon(ctx, "uxa.asks");
      const { page } = carbon;
      // The app's callback is briefcase's (its setup is a copy): briefcase's fake app then refuses a code that is not its own.
      const expected = [/status of 4\d\d .*127\.0\.0\.1:\d+\/briefcase\/callback/];
      results.watch(page, "asks-more", expected);
      collectConsole(page, expected);
      const appId = `uxa-asks-${tag()}`;
      await ownedApp(ctx, carbon.uuid, appId, `Asks More ${appId.slice(-6)}`);
      const authorize = `${env.site}/authorize?app_id=${appId}&redirect_uri=${encodeURIComponent(`${env.apps}/briefcase/callback`)}&response_type=code&state=uxa${tag()}&scope=openid`;
      // First sign-in: the email it requires, the timezone left unticked.
      await page.goto(authorize);
      await page.getByRole("button", { name: /^Continue as/ }).click({ timeout: 30_000 });
      await page.getByRole("button", { name: "Share and continue", exact: true }).click({ timeout: 30_000 });
      await page.waitForURL(url => url.href.startsWith(`${env.apps}/briefcase/callback`), { timeout: 30_000 });
      // The app now also requires a date of birth.
      const patched = await (async () => {
        await page.goto(`${env.site}/`);
        await page.locator("main").first().waitFor({ timeout: 30_000 });
        return pageFetch(page, `/v1/apps/${appId}/signin-config`, { method: "PATCH", body: { required_fields: ["email", "dob"] } });
      })();
      results.check("asks-more: the app now requires a date of birth too", patched.status === 200, `${patched.status} ${JSON.stringify(patched.body).slice(0, 200)}`);
      await page.goto(authorize);
      await page.getByRole("button", { name: /^Continue as/ }).click({ timeout: 30_000 });
      const list = live(page, 'ul[aria-label^="Details shared with"]');
      await list.first().waitFor({ timeout: 30_000 });
      await stepReady(page);
      const title = await hostedTitle(page);
      results.check("asks-more: the page says the app would like a little more", /would like a little more/.test(title), title);
      const fresh = await live(page, 'ul[aria-label^="Details shared with"] > li').evaluateAll(items => items.map(item => ({ field: item.getAttribute("data-field"), text: (item as HTMLElement).innerText.replace(/\s+/g, " ").trim() })));
      results.check("asks-more: the detail the app newly asks for (date of birth) is marked New", fresh.some(row => row.field === "dob" && /\bNew\b/.test(row.text)), JSON.stringify(fresh));
      // The timezone was asked for the first time too (the Carbon left it unticked then): it is not new to the Carbon.
      results.check("asks-more: details the app asked for before (email shared, timezone left unticked) are not marked New", fresh.every(row => row.field === "dob" || !/\bNew\b/.test(row.text)), JSON.stringify(fresh));
      await auditStep(ctx, page, findings, "hosted-asks-more", VARIANTS, { fullPage: true });
      results.check("asks-more: findings saved", true, saveFindings(ctx, findings));
      await carbon.context.close();
    },
  },
  {
    name: "ux-audit-hosted-orbit",
    title: "orbit-games (Apple only, its own Apple, compact, forced dark): the methods page, Apple's mock, setting up and what's shared",
    timeoutMs: 600_000,
    async run(ctx) {
      const { env, results, browser } = ctx;
      const findings = findingsFor(ctx);
      const variants = forcedVariants("dark");
      const context = await auditContext(browser);
      const page = await context.newPage();
      results.watch(page, "orbit");
      collectConsole(page);
      await page.goto(await hostedLink(env, page, "orbit-games"));
      const apple = page.getByRole("button", { name: "Continue with Apple" });
      await apple.waitFor({ timeout: 30_000 });
      await stepReady(page);
      await auditStep(ctx, page, findings, "hosted-orbit-methods", variants, { forced: "dark" });
      const fields = await page.getByRole("textbox").count();
      results.check("hosted-orbit: Apple is the only way in (no email or phone field)", fields === 0, `${fields} text fields`);
      await apple.click();
      const t = `${Date.now().toString(36)}`;
      await chooseMockIdentity(env, page, `uxa.orbit.${t}@icloud.test`, `Orbit Audit ${t}`);
      const create = page.getByRole("button", { name: "Create account" });
      await create.waitFor({ timeout: 30_000 });
      await stepReady(page);
      await auditStep(ctx, page, findings, "hosted-orbit-signup", variants, { forced: "dark", fullPage: true });
      await create.click();
      await walkDetails(ctx, page, findings, { app: "orbit-games", prefix: "hosted-orbit", variants, forced: "dark" });
      const account = await appAccount(page);
      results.check("hosted-orbit: the app received the new account", typeof account?.uuid === "string", JSON.stringify(account).slice(0, 160));
      results.check("hosted-orbit: findings saved", true, saveFindings(ctx, findings));
      await context.close();
    },
  },
  {
    name: "ux-audit-hosted-campus",
    title: "campus-connect (email domains limited to university.test): the methods page and the refusal of another domain, in words, at 1440/390 light/dark",
    async run(ctx) {
      const { env, results, browser } = ctx;
      const findings = findingsFor(ctx);
      const context = await auditContext(browser);
      const page = await context.newPage();
      // The refusal is a 403 on purpose; the browser logs that response as a console error of its own.
      const refused = [/status of 403 .*\/v1\/flows\/[^/ ]+\/email/];
      results.watch(page, "campus", refused);
      collectConsole(page, refused);
      await page.goto(await hostedLink(env, page, "campus-connect"));
      const field = page.getByRole("textbox", { name: "Email" });
      await field.waitFor({ timeout: 30_000 });
      await stepReady(page);
      await auditStep(ctx, page, findings, "hosted-campus-methods", VARIANTS);
      await field.fill(freshEmail("uxa.campus"));
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      const refusal = page.locator("main [role=alert]").first();
      await refusal.waitFor({ timeout: 15_000 }).catch(() => undefined);
      await stepReady(page);
      const text = (await refusal.innerText().catch(() => "")).replace(/\s+/g, " ");
      results.check("hosted-campus: another domain is refused in words that name the allowed one", /university\.test/.test(text), text || "(no message)");
      await auditStep(ctx, page, findings, "hosted-campus-domain-refused", VARIANTS, { expectedConsole: refused });
      results.check("hosted-campus: findings saved", true, saveFindings(ctx, findings));
      await sleep(100);
      await context.close();
    },
  },
];

export type { Findings, Variant };
