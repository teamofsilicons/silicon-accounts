/**
 * ux-audit: the narrowest phones. The web spec's quality bar is "works at 320/390 px (16 px gutters, no horizontal
 * scroll)", and WCAG 1.4.10 (Reflow) asks for 320 CSS px without scrolling in two directions. The rest of the suite
 * walks 390; this walks 320 × 640 (light): every signed-out and signed-in page, the hosted pages in three layouts (with
 * a flow page adding a phone and the Opening page), the device page, two docs pages, and the developer site's home and
 * every tab of an app. Each page: no sideways scroll, every word and control at least
 * 16 px from the screen's edges (fixed bars and full-bleed backgrounds aside), nothing cut short without a way to read
 * it (listed in the findings), and a screenshot.
 */
import type { Page, Route } from "@playwright/test";
import type { Ctx, Journey } from "../../context";
import { codeFor, lastSeq, signInOnDeveloper, signInWithCode, sleep, startAtApp, tag } from "../../lib";
import { DEVELOPER_EXPECTED, TABS, auditContext, collectConsole, drainProblems, findingsFor, freshEmail, hostedLink, kit, openAccountPage, openDeveloperPage, ownedApp, saveFindings, settle, signedInCarbon, stepReady, tabPath, type Findings } from "./_audit";

const WIDTH = 320;
const HEIGHT = 640;
const GUTTER = 16;

interface Gutters {
  vw: number;
  left: number | null;
  right: number | null;
  offenders: Array<{ el: string; left: number; right: number }>;
}

/**
 * The nearest any word, image, icon or field comes to the screen's edges (outside fixed or sticky bars and sideways
 * scrollers), and what comes closer than 16 px. Words are measured by their text (a link's hover pill may reach into
 * the gutter while its words keep to it), images, icons and fields by their boxes.
 */
const GUTTER_SCRIPT = `(() => {
  const vw = document.documentElement.clientWidth;
  const out = { vw, left: null, right: null, offenders: [] };
  // Fixed or sticky bars, sideways scrollers, and visually hidden text (an sr-only span is clipped to a pixel).
  const exempt = el => {
    for (let p = el; p && p !== document.body; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (s.position === "fixed" || s.position === "sticky") return true;
      if (p !== el && s.overflowX !== "visible" && p.scrollWidth > p.clientWidth + 1) return true;
      const box = p.getBoundingClientRect();
      if (/rect\\(0(px)?,? 0(px)?/.test(s.clip) || /inset\\(50%/.test(s.clipPath) || ((box.width <= 2 || box.height <= 2) && s.overflow !== "visible")) return true;
    }
    return !!el.closest("[aria-hidden=true],.sr-only,[inert]");
  };
  // What shows of a box: cut by the element's own and its ancestors' clipping (an ellipsis cuts its text).
  const shown = (el, r) => {
    let left = r.left, right = r.right;
    for (let p = el; p && p !== document.body; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (s.overflowX !== "visible") { const b = p.getBoundingClientRect(); left = Math.max(left, b.left); right = Math.min(right, b.right); }
      if (s.position === "fixed") break;
    }
    return { left, right, width: right - left, height: r.height, bottom: r.bottom };
  };
  const note = (el, raw) => {
    const r = shown(el, raw);
    if (r.width < 1 || r.height < 1 || r.bottom < -4000) return;
    out.left = out.left === null ? r.left : Math.min(out.left, r.left);
    out.right = out.right === null ? r.right : Math.max(out.right, r.right);
    if ((r.left < ${GUTTER} - 0.5 || r.right > vw - ${GUTTER} + 0.5) && out.offenders.length < 8) out.offenders.push({ el: window.__uxa.describe(el).slice(0, 110), left: Math.round(r.left), right: Math.round(r.right) });
  };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const el = node.parentElement;
    if (!el || !node.textContent.trim() || !window.__uxa.visible(el) || exempt(el)) continue;
    range.selectNodeContents(node);
    for (const r of range.getClientRects()) note(el, r);
  }
  for (const el of document.body.querySelectorAll("img,svg,canvas,video,input:not([type=hidden]),select,textarea")) {
    if (el.tagName.toLowerCase() === "svg" && el.parentElement && el.parentElement.closest("svg")) continue;
    if (!window.__uxa.visible(el) || exempt(el)) continue;
    note(el, el.getBoundingClientRect());
  }
  if (out.left !== null) out.left = Math.round(out.left);
  if (out.right !== null) out.right = Math.round(out.right);
  return out;
})()`;

async function reflow(ctx: Ctx, page: Page, findings: Findings, name: string): Promise<void> {
  const { env, results } = ctx;
  await page.setViewportSize({ width: WIDTH, height: HEIGHT });
  await page.emulateMedia({ colorScheme: "light" });
  await page.evaluate("window.scrollTo({ left: 0, top: 0, behavior: 'instant' })").catch(() => undefined);
  await settle(page, 400);
  await page.screenshot({ path: `${env.shots}/uxa-reflow-${name}-320.png`, fullPage: true }).catch(() => undefined);
  const overflow = await kit<{ scrollWidth: number; clientWidth: number; scrolledX: number; offenders: Array<{ el: string; left: number; right: number }> }>(page, "overflow()");
  results.check(`reflow ${name} 320: no horizontal scroll (WCAG 1.4.10)`, overflow.scrolledX === 0 && overflow.scrollWidth <= overflow.clientWidth, `scrollWidth ${overflow.scrollWidth} vs ${overflow.clientWidth}${overflow.offenders.length ? `; sticking out: ${overflow.offenders.slice(0, 5).map(item => `${item.el} [${item.left}..${item.right}]`).join("; ")}` : ""}`);
  const gutters = (await page.evaluate(GUTTER_SCRIPT)) as Gutters;
  results.check(`reflow ${name} 320: every word and control keeps the 16 px side gutter`, gutters.offenders.length === 0, gutters.offenders.length ? gutters.offenders.map(item => `${item.el} [${item.left}..${item.right}]`).join("; ") : `content spans ${gutters.left}..${gutters.right} of ${gutters.vw}`);
  const truncated = await kit<Array<{ el: string; kind: string; text: string; titled: boolean }>>(page, "truncation()");
  const problems = drainProblems(page);
  results.check(`reflow ${name} 320: no console errors`, problems.console.length === 0, problems.console.slice(0, 3).join(" | "));
  findings.pages[`reflow ${name}`] = { shot: `shots/uxa-reflow-${name}-320.png`, overflow, gutters, truncated: truncated.filter(item => !item.titled).slice(0, 12) };
}

export const journeys: Journey[] = [
  {
    name: "ux-audit-reflow-320",
    title: "320 × 640 (the spec's narrowest phone, WCAG 1.4.10): signed-out pages, hosted pages in card/split/minimal (methods, code, setting up, what's shared, a flow page adding a phone, the Opening page), every account page, the device page, the developer site's home and ten tabs, docs — no sideways scroll, 16 px gutters",
    timeoutMs: 1_200_000,
    async run(ctx) {
      const { env, results, browser } = ctx;
      const findings = findingsFor(ctx);

      // Signed out: the landing page, the site's sign-in, three hosted layouts, setting up and what is shared.
      {
        const context = await auditContext(browser, { width: WIDTH, height: HEIGHT });
        const page = await context.newPage();
        results.watch(page, "reflow-signed-out");
        collectConsole(page);
        await page.goto(`${env.site}/`);
        await reflow(ctx, page, findings, "landing");
        await page.goto(`${env.site}/sign-in`);
        await page.getByRole("textbox", { name: "Email" }).waitFor({ timeout: 30_000 });
        await stepReady(page);
        await reflow(ctx, page, findings, "signin-email");
        for (const app of ["acme-notes", "pixel-studio", "ledgerly"]) {
          await page.goto(await hostedLink(env, page, app));
          await page.locator("main").first().waitFor({ timeout: 30_000 });
          await stepReady(page);
          await reflow(ctx, page, findings, `hosted-${app}-methods`);
        }
        await page.goto(await hostedLink(env, page, "briefcase"));
        const email = freshEmail("uxa.reflow");
        const field = page.getByRole("textbox", { name: "Email" });
        await field.waitFor({ timeout: 30_000 });
        const after = await lastSeq(env);
        await field.fill(email);
        await page.getByRole("button", { name: "Continue", exact: true }).click();
        const code = await codeFor(env, email, after);
        await page.getByRole("group", { name: /Code from the email/ }).waitFor({ timeout: 20_000 });
        await stepReady(page);
        await reflow(ctx, page, findings, "hosted-briefcase-code");
        await page.getByRole("textbox", { name: /digit 1 of 6/ }).first().click();
        await page.keyboard.type(code, { delay: 25 });
        await page.getByRole("button", { name: "Create account" }).waitFor({ timeout: 30_000 });
        await stepReady(page);
        await reflow(ctx, page, findings, "hosted-briefcase-signup");
        await page.getByRole("button", { name: "Create account" }).click();
        await page.getByRole("button", { name: "Share and continue" }).waitFor({ timeout: 30_000 });
        await stepReady(page);
        await reflow(ctx, page, findings, "hosted-briefcase-details");
        await context.close();
      }

      // ledgerly's first flow page with the phone being added (the country picker and the number side by side), and
      // the Opening page (held while it opens Google, so it can be measured).
      {
        const context = await auditContext(browser, { width: WIDTH, height: HEIGHT });
        const page = await context.newPage();
        results.watch(page, "reflow-flow");
        collectConsole(page);
        await startAtApp(env, page, "ledgerly", { intent: "signup" });
        await signInWithCode(env, page, { email: freshEmail("uxa.reflow.flow") });
        await page.getByRole("button", { name: "Create account" }).click({ timeout: 30_000 });
        await page.getByText("Step 1 of 2", { exact: true }).first().waitFor({ timeout: 30_000 });
        await stepReady(page);
        await reflow(ctx, page, findings, "hosted-ledgerly-step1-adding-phone");
        const held: Route[] = [];
        const site = new URL(env.site).origin;
        const isStart = (url: URL) => url.origin === site && /^\/v1\/flows\/[^/]+\/oauth\/(google|apple)$/.test(url.pathname);
        await context.route(isStart, route => (route.request().method() === "POST" ? void held.push(route) : void route.continue()));
        await startAtApp(env, page, "acme-notes", { method: "google" });
        for (let i = 0; i < 100 && !held.length; i++) await sleep(100);
        await stepReady(page);
        await reflow(ctx, page, findings, "hosted-acme-opening-google");
        for (const route of held.splice(0)) await route.continue().catch(() => undefined);
        await page.waitForURL(url => url.href.startsWith(env.oidc), { timeout: 15_000 }).catch(() => undefined);
        await context.unroute(isStart).catch(() => undefined);
        await context.close();
      }

      // Signed in: every account page, the device page, two docs pages; then the developer site (an app of their own).
      const carbon = await signedInCarbon(ctx, "uxa.reflow.in", { width: WIDTH, height: HEIGHT });
      const { page } = carbon;
      results.watch(page, "reflow-signed-in", DEVELOPER_EXPECTED);
      collectConsole(page, DEVELOPER_EXPECTED);
      for (const [path, name] of [["/", "identity"], ["/sign-in-methods", "sign-in-methods"], ["/apps", "apps"], ["/silicons", "silicons"], ["/proofs", "proofs"], ["/activity", "activity"], ["/settings", "settings"]] as const) {
        await openAccountPage(ctx, page, path, /./);
        await reflow(ctx, page, findings, `account-${name}`);
      }
      await page.goto(`${env.site}/device`);
      await page.getByRole("textbox", { name: "Code from your terminal" }).waitFor({ timeout: 30_000 });
      await stepReady(page);
      await reflow(ctx, page, findings, "device");
      for (const [path, name] of [["/docs/start/add-sign-in", "docs-add-sign-in"], ["/docs/reference/errors", "docs-errors"]] as const) {
        await page.goto(`${env.site}${path}`);
        await page.locator("main h1").first().waitFor({ timeout: 30_000 });
        await reflow(ctx, page, findings, name);
      }
      const appId = `uxa-r-${tag()}`;
      await ownedApp(ctx, carbon.uuid, appId, `Reflow Notes ${appId.slice(-6)}`);
      // The developer site: "Continue as" the Carbon already signed in on the account site.
      await signInOnDeveloper(env, page, null);
      await openDeveloperPage(ctx, page, "/");
      await reflow(ctx, page, findings, "developer-home");
      for (const tab of TABS) {
        await openDeveloperPage(ctx, page, tabPath(appId, tab));
        await reflow(ctx, page, findings, `developer-${tab}`);
      }
      results.check("reflow: findings saved", true, saveFindings(ctx, findings));
      await carbon.context.close();
    },
  },
];
