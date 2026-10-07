/**
 * ux-audit: the Opening page (UNDERSTANDING.md "Adding sign-in to an app"; build spec 06-v2 §5). When a Carbon presses
 * "Continue with Google" or "Continue with Apple" on the app's own site (its direct buttons, its iframe or the SDK), we
 * first open our page saying "Opening Google to sign you in to {app name}…" (or the app's copy.opening_title), in the
 * app's style with "Powered by Silicon Accounts" at the bottom, then move on to the provider by ourselves (about
 * 900 ms), with a visible "Continue to Google" as the fallback. Reduced motion: no animation, same behaviour.
 *
 * For each app and button, at 1440 and 390 px in its theme(s): how long until the page moves on (and how long its words
 * are fully on screen before it does), then, holding the page's request that starts the provider (POST
 * /v1/flows/{id}/oauth/{provider}) so the page stays, the generic audit and its words, style, fallback and Powered by;
 * then the provider opens. Back from the provider the page waits, paused, for a press (audited too).
 */
import type { BrowserContext, Page, Route } from "@playwright/test";
import type { Ctx, Journey } from "../../context";
import { json, sleep } from "../../lib";
import { auditContext, collectConsole, drainProblems, findingsFor, forcedVariants, saveFindings, settle, stepReady, VARIANTS, type Findings, type Theme, type Variant } from "./_audit";
import { auditStep } from "./_hosted";

interface OpeningCase {
  app: string;
  provider: "google" | "apple";
  /** Where the button is: the app's own direct button on its page, its iframe buttons, or the SDK's. */
  via: "direct" | "iframe" | "sdk";
  forced?: Theme;
  /** The heading while it opens (the app's copy.opening_title when it set one). */
  title: RegExp;
  /** The app's "Create an account" flavour: the paused page says "Sign up for …". */
  signup?: boolean;
}

const CASES: OpeningCase[] = [
  { app: "briefcase", provider: "google", via: "direct", title: /^Opening Google to sign you in to Briefcase…$/ },
  { app: "briefcase", provider: "apple", via: "direct", title: /^Opening Apple to sign you in to Briefcase…$/ },
  { app: "acme-notes", provider: "google", via: "direct", forced: "dark", title: /^Taking you to Google for Acme Notes…$/ },
  { app: "pixel-studio", provider: "google", via: "direct", forced: "light", title: /^Opening Google to sign you in to Pixel Studio…$/ },
  { app: "pixel-studio", provider: "apple", via: "direct", forced: "light", title: /^Opening Apple to sign you in to Pixel Studio…$/ },
  { app: "orbit-games", provider: "apple", via: "direct", forced: "dark", title: /^Opening Apple to sign you in to Orbit Games…$/ },
  { app: "ledgerly", provider: "google", via: "direct", forced: "light", title: /^Opening Google to sign you in to Ledgerly…$/ },
  { app: "briefcase", provider: "google", via: "iframe", title: /^Opening Google to sign you in to Briefcase…$/ },
  { app: "quill-docs", provider: "google", via: "sdk", title: /^Opening Google to sign you in to Quill Docs…$/ },
];

const START = /^\/v1\/flows\/[^/]+\/oauth\/(google|apple)$/;
const providerName = (provider: "google" | "apple") => (provider === "google" ? "Google" : "Apple");

/** What the page reported: [ms since the Opening page's heading appeared, its opacity], and when (this clock) it first did. */
interface OpeningSamples {
  list: Array<[number, number]>;
  firstAt: number;
}

/** Records, in Node, when the Opening page's heading appears and how opaque it is on every frame. */
async function watchOpening(context: BrowserContext): Promise<OpeningSamples> {
  const samples: OpeningSamples = { list: [], firstAt: 0 };
  await context.exposeBinding("__uxaOpening", (_source, at: number, opacity: number) => {
    if (!samples.list.length) samples.firstAt = Date.now() - at;
    samples.list.push([at, opacity]);
  });
  await context.addInitScript(`(() => {
    let attached = null;
    const tick = () => {
      const heading = document.querySelector('[data-opening]:not([data-step-leaving] *) h1');
      if (heading) {
        if (attached === null) attached = performance.now();
        let opacity = 1;
        for (let node = heading; node && node.nodeType === 1; node = node.parentElement) opacity *= parseFloat(getComputedStyle(node).opacity || "1");
        if (window.__uxaOpening) window.__uxaOpening(Math.round(performance.now() - attached), Math.round(opacity * 100) / 100);
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  })()`);
  return samples;
}

/** Presses the app's own button for the provider. */
async function press(ctx: Ctx, page: Page, entry: OpeningCase, theme: Theme): Promise<void> {
  await page.goto(`${ctx.env.apps}/${entry.app}/?theme=${theme}`);
  const name = `Continue with ${providerName(entry.provider)}`;
  if (entry.via === "direct") await page.locator(`#continue-${entry.provider}`).click({ timeout: 30_000 });
  else if (entry.via === "iframe") await page.frameLocator("#signin-iframe").getByRole("link", { name }).click({ timeout: 30_000 });
  else await page.locator("#silicon-accounts").getByRole("button", { name }).click({ timeout: 30_000 });
}

interface OpeningRead {
  title: string;
  font: string;
  background: string;
  fallback: boolean;
  otherWays: boolean;
  paint: string | null;
  text: string;
}

const READ = `(() => {
  const root = document.querySelector('[data-opening]:not([data-step-leaving] *)');
  if (!root) return null;
  const heading = root.querySelector("h1");
  const brand = root.closest(".sa-brand") || document.querySelector(".sa-brand");
  const buttons = Array.from(root.querySelectorAll("button"));
  const shows = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
  return {
    title: heading ? heading.textContent.replace(/\\s+/g, " ").trim() : "",
    font: heading ? getComputedStyle(heading).fontFamily : "",
    background: brand ? getComputedStyle(brand).getPropertyValue("--background").trim().toUpperCase() : "",
    fallback: buttons.some(b => /^Continue to (Google|Apple)$/.test(b.textContent.trim()) && shows(b)),
    otherWays: buttons.some(b => /^Other ways to sign (in|up)$/.test(b.textContent.trim()) && shows(b)),
    paint: (document.querySelector("[data-paint]") || { getAttribute: () => null }).getAttribute("data-paint"),
    text: ((document.querySelector("main") || {}).innerText || "").replace(/\\s+/g, " ").trim().slice(0, 400),
  };
})()`;

async function openingCase(ctx: Ctx, findings: Findings, entry: OpeningCase, variant: Variant, options: { reduce?: boolean; paused?: boolean } = {}): Promise<void> {
  const { env, results, browser } = ctx;
  const label = `opening ${entry.app} ${entry.provider} (${entry.via}) ${variant.key}${options.reduce ? " reduced-motion" : ""}`;
  const shotName = `opening-${entry.app}-${entry.provider}-${entry.via}${options.reduce ? "-reduce" : ""}`;
  const context = await auditContext(browser, { width: variant.width, height: variant.height, dark: variant.theme === "dark" });
  const samples = await watchOpening(context);
  const page = await context.newPage();
  if (options.reduce) await page.emulateMedia({ reducedMotion: "reduce" });
  results.watch(page, label);
  collectConsole(page);
  const site = new URL(env.site).origin;
  const held: Route[] = [];
  let askedAt = 0;
  const isStart = (url: URL) => url.origin === site && START.test(url.pathname);
  await context.route(isStart, route => {
    if (route.request().method() !== "POST") return void route.continue();
    if (!askedAt) askedAt = Date.now();
    held.push(route);
  });
  await press(ctx, page, entry, variant.theme);
  for (let i = 0; i < 150 && held.length === 0; i++) await sleep(100);
  const shown = samples.list.length > 0;
  const visibleAt = samples.list.find(([, opacity]) => opacity >= 0.95)?.[0] ?? null;
  // From the heading's first frame to the page's request that starts the provider.
  const movedAfter = shown && askedAt ? askedAt - samples.firstAt : null;
  results.check(`${label}: the app's button opens our page first and it starts ${providerName(entry.provider)} by itself`, held.length > 0 && shown && page.url().startsWith(env.site), `${held.length ? "asked to start the provider" : "never asked"}; frames sampled ${samples.list.length}`);
  if (movedAfter !== null) {
    results.metric(`${label}: moved on after (ms since the page showed)`, movedAfter);
    if (visibleAt !== null) results.metric(`${label}: words fully on screen for (ms)`, movedAfter - visibleAt);
    results.check(`${label}: it moves on after about 900 ms (700–2500 ms), its words fully on screen for at least 500 ms before`, movedAfter >= 700 && movedAfter <= 2500 && visibleAt !== null && movedAfter - visibleAt >= 500, `showed, then moved on after ${movedAfter} ms; fully visible from ${visibleAt} ms`);
  }
  await stepReady(page);
  const read = (await page.evaluate(READ)) as OpeningRead | null;
  findings.pages[`${label} read`] = read;
  results.check(`${label}: says "${entry.title.source}"`, !!read && entry.title.test(read.title), read?.title ?? "(no Opening page)");
  // "Other ways to sign in" leads to the app's other methods; an app with this provider alone (orbit-games) has none.
  const methods = (await json<{ methods?: string[] }>(`${env.site}/v1/apps/${entry.app}/public`)).body.methods ?? [];
  const others = methods.length > 1;
  results.check(`${label}: a visible "Continue to ${providerName(entry.provider)}" fallback${others ? ' and "Other ways to sign in"' : " (the app has no other method, so no \"Other ways\")"}`, !!read?.fallback && read.otherWays === others, JSON.stringify(read ? { fallback: read.fallback, otherWays: read.otherWays, methods } : null));
  const theme = entry.forced ?? variant.theme;
  results.check(`${label}: in the app's look (${entry.forced ? `its forced ${entry.forced} theme` : `the visitor's ${variant.theme}`})`, read?.paint === theme, `data-paint=${read?.paint}; font ${read?.font}; background ${read?.background}`);
  if (options.reduce) {
    // Reduced motion: nothing pulses or fills while it waits (the dots and the bar hold still).
    const moving = (await page.evaluate(`(() => {
      const root = document.querySelector('[data-opening]');
      if (!root || !document.getAnimations) return [];
      return document.getAnimations().filter(a => a.playState === "running" && a.effect && a.effect.target && root.contains(a.effect.target)).map(a => (a.animationName || a.transitionProperty || "animation") + " on " + a.effect.target.tagName.toLowerCase());
    })()`)) as string[];
    // A fade is not motion (it may stay); nothing may travel, pulse or fill.
    const before = samples.list.filter(([at]) => at < 400).map(([, opacity]) => opacity);
    results.check(`${label}: nothing moves on the page while it waits (no pulse, no filling bar)`, moving.length === 0, `${moving.join(", ") || "no running animation"}; heading opacity in the first 400 ms: ${[...new Set(before)].join(", ")}`);
  }
  // Held: the page as a Carbon sees it while we open the provider.
  await auditStep(ctx, page, findings, `${shotName}`, [variant], { forced: entry.forced });
  // Then the provider opens.
  for (const route of held.splice(0)) await route.continue().catch(() => undefined);
  const opened = await page.waitForURL(url => url.href.startsWith(env.oidc), { timeout: 20_000, waitUntil: "commit" }).then(() => true, () => false);
  results.check(`${label}: then ${providerName(entry.provider)} opens`, opened, page.url().slice(0, 120));
  await context.unroute(isStart).catch(() => undefined);
  if (options.paused && opened) {
    // Back from the provider (its back button): the page waits for a press instead of moving on again.
    await page.goBack({ waitUntil: "commit" }).catch(() => undefined);
    await page.waitForURL(url => url.href.startsWith(`${env.site}/authorize/flow/`), { timeout: 20_000 }).catch(() => undefined);
    const pausedPage = page.locator('[data-opening][data-paused]:not([data-step-leaving] *)');
    const paused = await pausedPage.waitFor({ timeout: 15_000 }).then(() => true, () => false);
    await sleep(2_000);
    const stayed = page.url().startsWith(env.site);
    const again = (await page.evaluate(READ).catch(() => null)) as OpeningRead | null;
    const pausedTitle = new RegExp(`^${entry.signup ? "Sign up for" : "Sign in to"} .+ with ${providerName(entry.provider)}$`);
    results.check(`${label}: back from ${providerName(entry.provider)}, the page waits for a press (paused, "${pausedTitle.source}", the fallback is the main button)`, paused && stayed && !!again && pausedTitle.test(again.title) && again.fallback, `${paused ? "paused" : "not paused"}; ${stayed ? "stayed" : `moved to ${page.url()}`}; "${again?.title}"`);
    await settle(page, 400);
    await auditStep(ctx, page, findings, `${shotName}-paused`, [variant], { forced: entry.forced });
  }
  const problems = drainProblems(page);
  results.check(`${label}: no console errors`, problems.console.length === 0, problems.console.slice(0, 4).join(" | "));
  await context.close();
}

export const journeys: Journey[] = [
  {
    name: "ux-audit-opening",
    title: "the Opening page from the apps' own Google/Apple buttons (direct, iframe, SDK) for briefcase, acme-notes (its own title), pixel-studio, orbit-games and ledgerly at 1440 and 390: words, the app's look, Powered by, the fallback, ~900 ms, the paused page back from the provider",
    timeoutMs: 1_500_000,
    async run(ctx) {
      const findings = findingsFor(ctx);
      const app = await json<{ copy?: { opening_title?: string | null } }>(`${ctx.env.site}/v1/apps/acme-notes/public`);
      findings.notes.push(`acme-notes copy.opening_title: ${JSON.stringify(app.body.copy?.opening_title ?? null)}`);
      for (const entry of CASES) {
        const variants = entry.forced ? forcedVariants(entry.forced) : [VARIANTS[0]!, VARIANTS[3]!];
        for (const [index, variant] of variants.entries()) await openingCase(ctx, findings, entry, variant, { paused: index === 0 && entry.via === "direct" });
      }
      ctx.results.check("opening: findings saved", true, saveFindings(ctx, findings));
    },
  },
  {
    name: "ux-audit-opening-reduced-motion",
    title: "the Opening page with prefers-reduced-motion: no pulse, no filling bar, no fade, and it still moves on to the provider by itself",
    async run(ctx) {
      const findings = findingsFor(ctx);
      await openingCase(ctx, findings, CASES[0]!, VARIANTS[0]!, { reduce: true });
      await openingCase(ctx, findings, CASES[2]!, forcedVariants("dark")[1]!, { reduce: true });
      ctx.results.check("opening reduced motion: findings saved", true, saveFindings(ctx, findings));
    },
  },
];
