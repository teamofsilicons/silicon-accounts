/**
 * ux-audit: every step of an app's hosted sign-in, for several brandings, in light and dark at 1440 and 390 px
 * (an app that forces a theme is looked at in that theme only):
 *
 *   default   briefcase: the site's own look (card), every method; methods, code, a wrong code, setting up, what is
 *             shared, and "Continue as" on the next sign-in
 *   acme      acme-notes: split layout, forced dark, Fraunces, grain; the hero copy beside the form follows the step
 *   pixel     pixel-studio: minimal layout, sharp corners, outline buttons, dots, forced light
 *   ledgerly  ledgerly: card, rounded corners, gradient, forced light; requires a phone (the requirements step)
 *   orbit     orbit-games: Apple only (its own Apple), compact, gradient, forced dark
 *   campus    campus-connect: email domains limited to university.test (the refusal state)
 *
 * Each step: the generic audit (_audit.ts) plus "Powered by Silicon Accounts": present, never covered or overlapping,
 * linking to account.teamofsilicons.com, and in view on steps that fit the screen.
 */
import type { Page } from "@playwright/test";
import type { Ctx, Journey } from "../../context";
import { appAccount, codeFor, lastSeq, sleep } from "../../lib";
import { VARIANTS, auditContext, auditPage, collectConsole, findingsFor, forcedVariants, freshEmail, hostedLink, poweredBy, saveFindings, sendEmailCode, stepReady, type Findings, type Theme, type Variant } from "./_audit";

interface StepOptions {
  forced?: Theme;
  fullPage?: boolean;
  /** The split layout's hero copy expected beside the form at 1440 (acme-notes). */
  hero?: RegExp;
}

/** The generic audit of a hosted step in each variant, plus "Powered by" and (split layout) the hero copy. */
async function auditStep(ctx: Ctx, page: Page, findings: Findings, name: string, variants: Variant[], options: StepOptions = {}): Promise<void> {
  const { results } = ctx;
  for (const variant of variants) {
    await auditPage(ctx, page, findings, { name, variant, forcedTheme: options.forced, siteTheme: !options.forced, fullPage: options.fullPage });
    const paint = await page.locator("[data-paint]").first().getAttribute("data-paint").catch(() => null);
    results.check(`${name} ${variant.key}: the step paints ${options.forced ? `the app's forced ${options.forced}` : `the visitor's ${variant.theme}`} theme`, paint === (options.forced ?? variant.theme), `data-paint=${paint}`);
    let powered = await poweredBy(page);
    const fits = (powered.scrollHeight ?? 0) <= (powered.viewport ?? 0) + 2;
    if (powered.found && !powered.inView && !fits) {
      await page.locator("[data-powered-by]").first().scrollIntoViewIfNeeded().catch(() => undefined);
      await sleep(250);
      powered = await poweredBy(page);
      await page.evaluate("window.scrollTo({ left: 0, top: 0, behavior: 'instant' })");
    }
    results.check(
      `${name} ${variant.key}: "Powered by Silicon Accounts" is there, uncovered, overlapping nothing${fits ? ", in view" : " (reachable by scrolling)"}, linking to account.teamofsilicons.com`,
      powered.found && !!powered.visible && !!powered.inView && !powered.covered && !powered.overlaps?.length && /^https:\/\/account\.teamofsilicons\.com\/?$/.test(powered.href ?? "") && /Powered by/.test(powered.text ?? ""),
      JSON.stringify(powered),
    );
    if (options.hero && variant.width >= 1000) {
      const hero = (await page.locator(".sa-brand-aside .sa-brand-title").first().innerText().catch(() => "")).trim();
      results.check(`${name} ${variant.key}: the copy beside the form says "${options.hero.source}"`, options.hero.test(hero), hero || "(no hero title)");
    }
  }
}

/** The browser's own log line for the 422 a wrong code gets. */
const WRONG_CODE = /status of 422 .*\/v1\/flows\/[^/ ]+\/(verify|requirements\/verify)/;

/** The code step: the first cell, type. */
async function typeCode(page: Page, code: string): Promise<void> {
  await page.getByRole("textbox", { name: /digit 1 of 6/ }).first().click();
  await page.keyboard.type(code, { delay: 30 });
}

/** On the mock provider's chooser: "Use another account" with this email and name. */
async function chooseNewIdentity(ctx: Ctx, page: Page, email: string, name: string): Promise<void> {
  await page.waitForURL(new RegExp(ctx.env.oidc.replace(/[.:/]/g, "\\$&")), { timeout: 30_000 });
  await page.locator('#new-identity input[name="_auto"]').fill(email);
  await page.locator('#new-identity input[name="_name"]').fill(name);
  await page.locator('#new-identity button[data-action="use-another"]').click();
}

interface EmailPlan {
  app: string;
  label: string;
  forced?: Theme;
  wrongCode?: boolean;
  /** Expected split-layout hero copy per step (acme-notes). */
  hero?: { methods: RegExp; signup: RegExp; consent: RegExp };
  /** The app requires a phone the new Carbon lacks: the requirements step comes after setting up. */
  phone?: boolean;
  /** Sign in again: "Continue as". */
  again?: boolean;
}

/** A new Carbon through an app's hosted pages with an email code, auditing every step on the way. */
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

  await page.goto(await hostedLink(env, page, plan.app));
  await page.getByRole("textbox", { name: "Email" }).waitFor({ timeout: 30_000 });
  await stepReady(page);
  await auditStep(ctx, page, findings, `${prefix}-methods`, variants, { forced: plan.forced, hero: plan.hero?.methods });

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
    await auditStep(ctx, page, findings, `${prefix}-code-wrong`, variants, { forced: plan.forced });
  }
  await typeCode(page, code);

  const create = page.getByRole("button", { name: "Create account" });
  await create.waitFor({ timeout: 30_000 });
  await stepReady(page);
  await auditStep(ctx, page, findings, `${prefix}-signup`, variants, { forced: plan.forced, fullPage: true, hero: plan.hero?.signup });
  await create.click();

  if (plan.phone) {
    const phoneField = page.getByRole("textbox", { name: "Phone number" });
    await phoneField.waitFor({ timeout: 30_000 });
    await stepReady(page);
    await auditStep(ctx, page, findings, `${prefix}-requirements`, variants, { forced: plan.forced, fullPage: true });
    const phone = `+1202555${String(Math.floor(1000 + Math.random() * 8999))}`;
    const after = await lastSeq(env);
    await phoneField.click();
    await page.keyboard.type(phone, { delay: 30 });
    await page.getByRole("button", { name: "Send code" }).click();
    const sms = await codeFor(env, phone, after);
    await page.getByRole("group", { name: /Code/ }).first().waitFor({ timeout: 20_000 });
    await stepReady(page);
    await auditStep(ctx, page, findings, `${prefix}-requirements-code`, variants, { forced: plan.forced });
    await typeCode(page, sms);
  }

  const share = page.getByRole("button", { name: "Share and continue" });
  const appUrl = new RegExp(`${env.apps.replace(/[.:/]/g, "\\$&")}/${plan.app}/`);
  const where = await Promise.race([share.waitFor({ timeout: 30_000 }).then(() => "consent" as const), page.waitForURL(appUrl, { timeout: 30_000 }).then(() => "app" as const)]);
  if (where === "consent") {
    await stepReady(page);
    await auditStep(ctx, page, findings, `${prefix}-consent`, variants, { forced: plan.forced, fullPage: true, hero: plan.hero?.consent });
    await share.click();
    await page.waitForURL(appUrl, { timeout: 30_000 });
  } else results.check(`${prefix}: the app asks for nothing to share (no consent step)`, true);
  await page.waitForLoadState("networkidle").catch(() => undefined);
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
    await page.waitForURL(appUrl, { timeout: 30_000 });
    results.check(`${prefix}: "Continue as" goes straight back to the app`, true);
  }
  results.check(`${prefix}: findings saved`, true, saveFindings(ctx, findings));
  await context.close();
}

export const journeys: Journey[] = [
  {
    name: "ux-audit-hosted-default",
    title: "briefcase's hosted pages in the site's own look: methods, code, a wrong code, setting up, what is shared, Continue as — light/dark × 1440/390",
    run: ctx => emailWalk(ctx, { app: "briefcase", label: "default", wrongCode: true, again: true }),
  },
  {
    name: "ux-audit-hosted-acme",
    title: "acme-notes' split, dark, Fraunces pages at 1440/390, and the hero copy beside the form following the step (the app's title on sign-in, a welcome for a new Carbon)",
    run: ctx =>
      emailWalk(ctx, {
        app: "acme-notes",
        label: "acme",
        forced: "dark",
        wrongCode: true,
        hero: { methods: /^Welcome back to Acme Notes$/, signup: /^Welcome to Acme Notes$/, consent: /^Welcome to Acme Notes$/ },
        again: true,
      }),
  },
  {
    name: "ux-audit-hosted-pixel",
    title: "pixel-studio's minimal, sharp, outline pages (forced light) at 1440/390: every step",
    run: ctx => emailWalk(ctx, { app: "pixel-studio", label: "pixel", forced: "light", wrongCode: true }),
  },
  {
    name: "ux-audit-hosted-ledgerly",
    title: "ledgerly's rounded card (forced light): setting up, then the phone it requires and its code, then what is shared",
    run: ctx => emailWalk(ctx, { app: "ledgerly", label: "ledgerly", forced: "light", phone: true }),
  },
  {
    name: "ux-audit-hosted-orbit",
    title: "orbit-games (Apple only, its own Apple, compact, forced dark): the methods step, Apple's mock, setting up and what is shared",
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
      await chooseNewIdentity(ctx, page, `uxa.orbit.${t}@icloud.test`, `Orbit Audit ${t}`);
      const create = page.getByRole("button", { name: "Create account" });
      await create.waitFor({ timeout: 30_000 });
      await stepReady(page);
      await auditStep(ctx, page, findings, "hosted-orbit-signup", variants, { forced: "dark", fullPage: true });
      await create.click();
      const share = page.getByRole("button", { name: "Share and continue" });
      const appUrl = new RegExp(`${env.apps.replace(/[.:/]/g, "\\$&")}/orbit-games/`);
      const where = await Promise.race([share.waitFor({ timeout: 30_000 }).then(() => "consent" as const), page.waitForURL(appUrl, { timeout: 30_000 }).then(() => "app" as const)]);
      if (where === "consent") {
        await stepReady(page);
        await auditStep(ctx, page, findings, "hosted-orbit-consent", variants, { forced: "dark", fullPage: true });
        await share.click();
        await page.waitForURL(appUrl, { timeout: 30_000 });
      }
      const account = await appAccount(page);
      results.check("hosted-orbit: the app received the new account", typeof account?.uuid === "string", JSON.stringify(account).slice(0, 160));
      results.check("hosted-orbit: findings saved", true, saveFindings(ctx, findings));
      await context.close();
    },
  },
  {
    name: "ux-audit-hosted-campus",
    title: "campus-connect (email domains limited to university.test): the methods step and the refusal of another domain, in words, at 1440/390 light/dark",
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
      await auditStep(ctx, page, findings, "hosted-campus-domain-refused", VARIANTS);
      results.check("hosted-campus: findings saved", true, saveFindings(ctx, findings));
      await context.close();
    },
  },
];
