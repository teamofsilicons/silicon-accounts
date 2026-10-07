/**
 * ux-audit: reduced motion. With `prefers-reduced-motion: reduce` nothing on the site should travel, slide, flip or
 * sweep: no ambient motion on a page left alone, no sliding step morph in the hosted pages, no page transition along
 * the dock, no eclipse when the theme changes, no drawer or palette sliding in, no endless animation (spinners,
 * shimmering skeletons), and nothing left invisible because an entrance animation was skipped. Every frame is sampled
 * (_kit.ts motionStart: running animations and the geometry of every element), and the same actions are measured once
 * without the preference as a control, so a quiet result means the site honoured the preference, not that the probe saw
 * nothing.
 */
import type { BrowserContext, Page } from "@playwright/test";
import type { Ctx, Journey } from "../../context";
import { codeFor, lastSeq, sleep } from "../../lib";
import { auditContext, collectConsole, describeMotion, findingsFor, freshEmail, hostedLink, kit, probeMotion, saveFindings, settle, signedInCarbon, stepReady, type Findings, type MotionSummary } from "./_audit";

type Mode = "reduce" | "no-preference";

/** Motion that counts: animations of position, size, transform or clip-path, and elements travelling over 3+ frames. */
const moves = (m: MotionSummary) => m.motionAnimations.length + m.movingCount + m.viewTransitions;

interface Probe {
  name: string;
  reduce: MotionSummary;
  control: MotionSummary;
}

/** Runs `setup` then `action` under the probe in a page of each mode; records both. */
async function compare(ctx: Ctx, findings: Findings, pages: Record<Mode, Page>, name: string, setup: (page: Page, mode: Mode) => Promise<void>, action: (page: Page, mode: Mode) => Promise<unknown>, windowMs = 1_400): Promise<Probe> {
  const out: Partial<Record<Mode, MotionSummary>> = {};
  for (const mode of ["no-preference", "reduce"] as const) {
    const page = pages[mode];
    await setup(page, mode);
    out[mode] = await probeMotion(page, () => action(page, mode), windowMs);
  }
  const probe = { name, reduce: out.reduce!, control: out["no-preference"]! };
  findings.pages[`motion ${name}`] = probe;
  const { results } = ctx;
  results.check(`reduced motion: ${name}: nothing travels, slides or sweeps`, moves(probe.reduce) === 0, `reduce: ${describeMotion(probe.reduce)} || without the preference: ${describeMotion(probe.control)}`);
  results.metric(`${name}: moving things without the preference`, moves(probe.control), "count");
  results.metric(`${name}: moving things with reduced motion`, moves(probe.reduce), "count");
  return probe;
}

/** A page whose media says `mode` for prefers-reduced-motion. */
async function modePage(context: BrowserContext, mode: Mode): Promise<Page> {
  const page = await context.newPage();
  await page.emulateMedia({ reducedMotion: mode });
  return page;
}

export const journeys: Journey[] = [
  {
    name: "ux-audit-reduced-motion",
    title: "prefers-reduced-motion: no ambient motion, no step morph, no page transition, no theme eclipse, no sliding drawer or palette, no endless animation, nothing left invisible — each measured against a control without the preference",
    timeoutMs: 900_000,
    async run(ctx) {
      const { env, results } = ctx;
      const findings = findingsFor(ctx);

      // Signed-out pages: the landing page left alone, the hosted step morph.
      const anonymous = await auditContext(ctx.browser);
      const pages: Record<Mode, Page> = { "no-preference": await modePage(anonymous, "no-preference"), reduce: await modePage(anonymous, "reduce") };
      for (const [mode, page] of Object.entries(pages)) {
        results.watch(page, `motion-${mode}`);
        collectConsole(page);
      }
      results.check("reduced motion: the page sees prefers-reduced-motion: reduce", (await pages.reduce.evaluate("matchMedia('(prefers-reduced-motion: reduce)').matches")) === true);

      await compare(ctx, findings, pages, "the landing page left alone for 2.5 s", async page => {
        await page.goto(`${env.site}/`);
        await settle(page, 800);
      }, async () => undefined, 2_500);
      await pages.reduce.screenshot({ path: `${env.shots}/uxa-motion-landing-reduce.png` });

      const emails: Record<Mode, string> = { "no-preference": freshEmail("uxa.motion.a"), reduce: freshEmail("uxa.motion.b") };
      const codes: Partial<Record<Mode, string>> = {};
      await compare(ctx, findings, pages, "the hosted card moving from email to code", async (page, mode) => {
        await page.goto(await hostedLink(env, page, "briefcase"));
        await page.getByRole("textbox", { name: "Email" }).fill(emails[mode], { timeout: 30_000 });
        await stepReady(page);
      }, async (page, mode) => {
        const after = await lastSeq(env);
        await page.getByRole("button", { name: "Continue", exact: true }).click();
        codes[mode] = await codeFor(env, emails[mode], after);
      }, 1_600);
      // The first five digits before the probe (each keystroke moves the code field's ring one cell, which is input,
      // not animation); the sixth submits the code, and the card morphs to setting up under the probe.
      await compare(ctx, findings, pages, "the hosted card moving from the code to setting up", async (page, mode) => {
        await page.getByRole("group", { name: /Code from the email/ }).waitFor({ timeout: 20_000 });
        await stepReady(page);
        await page.getByRole("textbox", { name: /digit 1 of 6/ }).first().click();
        await page.keyboard.type((codes[mode] ?? "").slice(0, 5), { delay: 40 });
        await settle(page, 300);
      }, async (page, mode) => {
        await page.keyboard.type((codes[mode] ?? "").slice(5), { delay: 10 });
        await page.getByRole("button", { name: "Create account" }).waitFor({ timeout: 30_000 });
      }, 1_800);
      const hiddenSignup = await kit<Array<{ el: string; opacity: number }>>(pages.reduce, "hiddenContent()");
      results.check("reduced motion: setting up shows everything (no entrance left at opacity 0)", hiddenSignup.length === 0, JSON.stringify(hiddenSignup));
      await pages.reduce.screenshot({ path: `${env.shots}/uxa-motion-signup-reduce.png`, fullPage: true });
      await anonymous.close();

      // Signed in: page transitions along the dock, the theme eclipse, the drawer, the palette, every page at rest.
      const a = await signedInCarbon(ctx, "uxa.motion.c");
      const b = await signedInCarbon(ctx, "uxa.motion.d");
      const signed: Record<Mode, Page> = { "no-preference": a.page, reduce: b.page };
      for (const [mode, page] of Object.entries(signed)) {
        await page.emulateMedia({ reducedMotion: mode as Mode });
        results.watch(page, `motion-signed-${mode}`);
        collectConsole(page);
      }
      await compare(ctx, findings, signed, "a page change along the dock (Identity → Apps)", async page => {
        await page.goto(`${env.site}/`);
        await page.locator("main").first().waitFor({ timeout: 30_000 });
        await settle(page, 800);
      }, async page => {
        await page.locator("nav[aria-label='Account sections']").getByRole("link", { name: "Apps" }).click();
        await page.waitForURL(`${env.site}/apps`, { timeout: 15_000 });
      }, 1_200);
      let eclipse: Record<Mode, boolean> = { "no-preference": false, reduce: false };
      await compare(ctx, findings, signed, "changing the theme from the dock", async page => {
        await settle(page, 600);
        await page.evaluate("(() => { window.__uxaEclipse = false; new MutationObserver(() => { if (document.documentElement.getAttribute('data-transition') === 'eclipse') window.__uxaEclipse = true; }).observe(document.documentElement, { attributes: true }); })()");
      }, async (page, mode) => {
        await page.locator("nav[aria-label='Account sections']").getByRole("button", { name: /^Switch to (dark|light) mode$/ }).first().click();
        await sleep(900);
        eclipse = { ...eclipse, [mode]: (await page.evaluate("window.__uxaEclipse === true")) === true };
      }, 1_400);
      results.check("reduced motion: the theme changes without the eclipse (no data-transition=eclipse)", !eclipse.reduce, `reduce: ${eclipse.reduce}, without the preference: ${eclipse["no-preference"]}`);
      await compare(ctx, findings, signed, "opening the Create a Silicon drawer", async page => {
        await page.goto(`${env.site}/silicons`);
        await page.getByRole("button", { name: "Create a Silicon" }).first().waitFor({ timeout: 30_000 });
        await settle(page, 800);
      }, async page => {
        await page.getByRole("button", { name: "Create a Silicon" }).first().click();
        await page.getByRole("dialog", { name: "Create a Silicon" }).waitFor({ timeout: 10_000 });
      }, 1_200);
      await compare(ctx, findings, signed, "opening the command palette (⌘K)", async page => {
        await page.keyboard.press("Escape");
        await sleep(500);
        await settle(page, 400);
      }, async page => {
        await page.keyboard.press("ControlOrMeta+k");
        await page.getByRole("dialog").last().waitFor({ timeout: 10_000 }).catch(() => undefined);
      }, 1_000);
      await signed.reduce.keyboard.press("Escape");

      // Every account page at rest under reduced motion: no endless animation, nothing left invisible.
      for (const path of ["/", "/sign-in-methods", "/apps", "/silicons", "/proofs", "/activity", "/settings", "/developer"]) {
        const page = signed.reduce;
        await page.goto(`${env.site}${path}`);
        await page.locator("main").first().waitFor({ timeout: 30_000 });
        await settle(page, 600);
        const rest = await probeMotion(page, async () => undefined, 1_200);
        const hidden = await kit<Array<{ el: string; opacity: number }>>(page, "hiddenContent()");
        results.check(`reduced motion: ${path} at rest: no endless or travelling animation, nothing left invisible`, rest.infinite.length === 0 && moves(rest) === 0 && hidden.length === 0, `${describeMotion(rest)}${hidden.length ? `; invisible: ${JSON.stringify(hidden)}` : ""}`);
      }
      await signed.reduce.goto(`${env.site}/`);
      await settle(signed.reduce, 600);
      await signed.reduce.screenshot({ path: `${env.shots}/uxa-motion-home-reduce.png` });
      results.check("reduced motion: findings saved", true, saveFindings(ctx, findings));
      await a.context.close();
      await b.context.close();
    },
  },
];
