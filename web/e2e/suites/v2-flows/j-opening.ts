/**
 * The Opening page (UNDERSTANDING.md "Adding sign-in to an app": "When a Carbon presses Continue with Google or Continue
 * with Apple on the app's own website, we don't jump straight to Google or Apple. We first open our page saying
 * Opening Google to sign you in to {app name}…, in the app's configured style and with Powered by Silicon Accounts at
 * the bottom, and only then move on to Google or Apple"; build spec 06-v2.md §5: ≈ 900 ms, a visible "Continue to
 * Google" fallback, reduced motion = no animation with the same behaviour, `copy.opening_title`).
 *
 *   briefcase  Google, the default look: the page, its fallback, Powered by, the move on, the whole sign-in after it;
 *              back from Google the page waits (paused) with its button; Cancel at Google lands on the methods page
 *              with the reason, never the Opening page again
 *   waveform   Apple: "Opening Apple to sign you in to Waveform…", the whole sign-in through Apple
 *   acme-notes its own opening_title ("Taking you to {provider} for {app}…"), its dark palette, Fraunces headings and
 *              split layout, its own Google client
 *   reduced motion: no pulse, no filling bar, the same move on
 */
import type { Page } from "@playwright/test";
import type { Journey } from "../../context";
import { POWERED_BY_HREF, chooseMockIdentity, hostedTitle, json, live, newContext, shot, startAtApp, waitForOpening, type Env } from "../../lib";
import { backAtApp, button, flowApi, flowIdOf, freshEmail, reducedMotionContext, settle, waitForDetailsPage } from "./_helpers";

interface OidcRequest {
  provider: string;
  endpoint: string;
  client_id: string | null;
  params: Record<string, unknown>;
}

/** The newest authorize request the mock provider got (its log is newest first). */
async function lastAuthorize(env: Env, provider: "google" | "apple"): Promise<OidcRequest | null> {
  const { body } = await json<{ items?: OidcRequest[] }>(`${env.oidc}/_requests?provider=${provider}&endpoint=authorize`);
  return body.items?.[0] ?? null;
}

/** The Opening page's motion: the filling bar's transform and the three dots' opacity, read twice 200 ms apart. */
async function motion(page: Page): Promise<{ bar: string[]; dots: string[][] }> {
  const read = () =>
    page.evaluate(() => {
      const root = [...document.querySelectorAll("[data-opening]")].find(element => !element.closest("[data-step-leaving]"));
      const bar = root?.querySelector('[class*="openingBar"] > span');
      const dots = [...(root?.querySelectorAll('[class*="openingDots"] > span') ?? [])];
      return { bar: bar ? getComputedStyle(bar).transform : "missing", dots: dots.map(dot => getComputedStyle(dot).opacity) };
    });
  const first = await read();
  await page.waitForTimeout(200);
  const second = await read();
  return { bar: [first.bar, second.bar], dots: [first.dots, second.dots] };
}

/** scaleX of a computed transform ("none" = 1). */
const scaleX = (transform: string) => (transform === "none" ? 1 : Number(/^matrix\(([^,]+),/.exec(transform)?.[1] ?? Number.NaN));

export const journey: Journey = {
  name: "v2-flows-opening",
  title: "the Opening Google/Apple page from an app's own button: its words, the app's style, Powered by, the fallback button, moving on by itself (≈900 ms), reduced motion, paused when back from Google, Cancel at Google → the methods page; whole sign-ins through Google and Apple after it",
  timeoutMs: 600_000,
  async run(ctx) {
    const { env, results, browser } = ctx;

    // briefcase, Google, the default look.
    {
      const context = await newContext(browser);
      const page = await context.newPage();
      results.watch(page, "opening-google");
      const href = await startAtApp(env, page, "briefcase", { method: "google" });
      await live(page, '[data-opening="google"]').first().waitFor({ timeout: 30_000 });
      const shownAt = Date.now();
      const id = flowIdOf(page);
      const animated = await motion(page);
      const seen = await waitForOpening(env, page, "google", { shotName: "v2f-j-01-briefcase-opening" });
      const movedAfter = seen.movedAfterMs === null ? null : Date.now() - shownAt;
      const flow = id ? (await flowApi(env, page, id, "", undefined, ctx.ip)).body.flow ?? null : null;
      results.check("briefcase's Continue with Google (method=google) shows our page first: \"Opening Google to sign you in to Briefcase…\"", href.searchParams.get("method") === "google" && seen.title === "Opening Google to sign you in to Briefcase…", `${href.searchParams.get("method")} | ${seen.title}`);
      results.check("…in briefcase's look (it kept the defaults: the Silicon look, background #F7F8FA)", seen.background === "#F7F8FA", seen.background);
      results.check("…with the \"Continue to Google\" fallback button visible", seen.fallback);
      results.check("…and \"Powered by Silicon Accounts\" in view, linking to accounts.teamofsilicons.com", seen.poweredBy.inView && seen.poweredBy.href === POWERED_BY_HREF && /Powered by Silicon Accounts/.test(seen.poweredBy.text), JSON.stringify(seen.poweredBy));
      results.check("…while it waits, the bar fills and the dots pulse (motion allowed)", scaleX(animated.bar[0]!) < 0.98 && JSON.stringify(animated.dots[0]) !== JSON.stringify(animated.dots[1]), JSON.stringify(animated));
      results.check("…then moves on to Google by itself, about 900 ms after it shows", movedAfter !== null && movedAfter >= 800 && movedAfter <= 5_000, `${movedAfter} ms`);
      if (movedAfter !== null) results.metric("Opening page shown → Google (briefcase)", movedAfter);
      const asked = await lastAuthorize(env, "google");
      results.check("…which is asked by Silicon Accounts' own Google client, with no login_hint", !!asked?.client_id && asked.params.login_hint === null && flow?.method_hint === "google", JSON.stringify(asked).slice(0, 300));

      // Back from Google: the page waits for a press (it never sends the Carbon straight back).
      await page.goBack();
      await live(page, '[data-opening="google"]').first().waitFor({ timeout: 30_000 });
      await page.waitForTimeout(2_500);
      const pausedTitle = await hostedTitle(page);
      const paused = await live(page, '[data-opening="google"]').first().getAttribute("data-paused").catch(() => null);
      results.check("back from Google with the back button: the page stays (paused) — \"Sign in to Briefcase with Google\"", page.url().startsWith(`${env.site}/authorize/flow/`) && paused !== null && pausedTitle === "Sign in to Briefcase with Google", `${page.url().slice(0, 80)} paused=${paused} "${pausedTitle}"`);
      results.check("…with \"Continue to Google\" and \"Other ways to sign in\"", (await page.getByRole("button", { name: "Continue to Google" }).count()) === 1 && (await page.getByRole("button", { name: "Other ways to sign in" }).count()) === 1);
      await settle(page);
      await shot(env, page, "v2f-j-02-paused");
      // The fallback button works: it takes the Carbon to Google (asked by briefcase's sign-in, no login_hint).
      const pressedAt = Date.now();
      await page.getByRole("button", { name: "Continue to Google" }).click();
      const reached = await page.waitForURL(url => url.href.startsWith(env.oidc), { timeout: 15_000 }).then(() => true, () => false);
      const viaFallback = await lastAuthorize(env, "google");
      results.check("pressing the fallback \"Continue to Google\" goes to Google at once", reached && Date.now() - pressedAt < 10_000 && !!viaFallback?.client_id && viaFallback.params.login_hint === null, `${reached ? `at Google after ${Date.now() - pressedAt} ms` : `still at ${page.url().slice(0, 100)}`} ${JSON.stringify(viaFallback?.params ?? null).slice(0, 160)}`);
      await page.goBack();
      await live(page, '[data-opening="google"][data-paused]').first().waitFor({ timeout: 30_000 });
      await page.getByRole("button", { name: "Other ways to sign in" }).click();
      await page.getByRole("button", { name: "Continue with Apple", exact: true }).waitFor({ timeout: 10_000 });
      results.check("…Other ways to sign in shows briefcase's methods", (await page.getByRole("button", { name: "Continue with Google", exact: true }).count()) === 1 && (await page.getByRole("textbox", { name: "Email" }).count()) === 1);

      // Cancel at Google: back on our methods page with the reason, not the Opening page again.
      await page.getByRole("button", { name: "Continue with Google", exact: true }).click();
      await page.waitForURL(url => url.href.startsWith(env.oidc), { timeout: 30_000 });
      await page.locator('button[data-action="cancel"]').click();
      await page.waitForURL(url => url.href.startsWith(`${env.site}/authorize/flow/`), { timeout: 30_000 });
      await live(page, "main h1").first().waitFor({ timeout: 30_000 });
      await page.waitForTimeout(2_000);
      const alert = (await live(page, 'main [role="alert"]').allInnerTexts().catch(() => [] as string[])).join(" | ").replace(/\s+/g, " ");
      results.check("Cancel on Google's page: back on briefcase's methods page saying so, not the Opening page (no loop)", (await live(page, "[data-opening]").count()) === 0 && page.url().startsWith(`${env.site}/authorize/flow/`) && /cancel/i.test(alert), `${page.url().slice(0, 80)} alert: ${alert}`);

      // The whole sign-in after the Opening page.
      const email = freshEmail("opening-google");
      await startAtApp(env, page, "briefcase", { method: "google" });
      await waitForOpening(env, page, "google");
      await chooseMockIdentity(env, page, email, "Opal Google");
      await page.getByRole("button", { name: "Create account" }).click({ timeout: 30_000 });
      await waitForDetailsPage(page);
      await button(page, "Share and continue").click();
      const outcome = await backAtApp(env, page, "briefcase");
      results.check("a whole sign-up through the Opening page and Google: briefcase gets the Google email", outcome.account?.email === email, JSON.stringify(outcome.account).slice(0, 200));
      await context.close();
    }

    // waveform, Apple.
    {
      const context = await newContext(browser);
      const page = await context.newPage();
      results.watch(page, "opening-apple");
      await startAtApp(env, page, "waveform", { method: "apple" });
      const seen = await waitForOpening(env, page, "apple", { shotName: "v2f-j-03-waveform-apple" });
      results.check("waveform's Continue with Apple: \"Opening Apple to sign you in to Waveform…\", the fallback \"Continue to Apple\", Powered by", seen.title === "Opening Apple to sign you in to Waveform…" && seen.fallback && seen.poweredBy.href === POWERED_BY_HREF && seen.poweredBy.inView, JSON.stringify(seen));
      results.check("…moving on to Apple by itself", seen.movedAfterMs !== null && seen.movedAfterMs <= 5_000, `${seen.movedAfterMs} ms`);
      if (seen.movedAfterMs !== null) results.metric("Opening page shown → Apple (waveform)", seen.movedAfterMs);
      const email = freshEmail("opening-apple");
      await chooseMockIdentity(env, page, email, "Ari Apple");
      await page.getByRole("button", { name: "Create account" }).click({ timeout: 30_000 });
      await waitForDetailsPage(page);
      await button(page, "Share and continue").click();
      const outcome = await backAtApp(env, page, "waveform");
      results.check("…and a whole sign-up through Apple: waveform gets the account (optional email left unticked)", !!outcome.account?.uuid && outcome.account.email === undefined, JSON.stringify(outcome.account).slice(0, 200));
      await context.close();
    }

    // acme-notes: its own opening title, palette, fonts and layout, its own Google client.
    {
      const context = await newContext(browser);
      const page = await context.newPage();
      results.watch(page, "opening-acme");
      await startAtApp(env, page, "acme-notes", { method: "google" });
      await live(page, '[data-opening="google"]').first().waitFor({ timeout: 30_000 });
      const layout = await page.locator("[data-paint][data-layout]").first().getAttribute("data-layout");
      const seen = await waitForOpening(env, page, "google", { shotName: "v2f-j-04-acme-opening" });
      results.check("acme-notes' own opening_title: \"Taking you to Google for Acme Notes…\"", seen.title === "Taking you to Google for Acme Notes…", seen.title);
      results.check("…in acme-notes' style: its dark background #16130F, Fraunces headings, its split layout", seen.background === "#16130F" && /Fraunces/.test(seen.headingFont) && layout === "split", `${seen.background} | ${seen.headingFont} | ${layout}`);
      results.check("…keeping Powered by Silicon Accounts", seen.poweredBy.href === POWERED_BY_HREF && (seen.poweredBy.inView || seen.poweredBy.atEnd), JSON.stringify(seen.poweredBy));
      const asked = await lastAuthorize(env, "google");
      results.check("…then Google with acme-notes' own client (bring your own)", asked?.client_id === "mock-google-byo.invalid", String(asked?.client_id));
      await context.close();
    }

    // Reduced motion: no pulse and no filling bar, the same move on.
    {
      const context = await reducedMotionContext(browser, env);
      const page = await context.newPage();
      results.watch(page, "opening-reduced");
      await startAtApp(env, page, "briefcase", { method: "google" });
      await live(page, '[data-opening="google"]').first().waitFor({ timeout: 30_000 });
      const shownAt = Date.now();
      const still = await motion(page);
      const seen = await waitForOpening(env, page, "google", { shotName: "v2f-j-05-reduced-motion" });
      const movedAfter = seen.movedAfterMs === null ? null : Date.now() - shownAt;
      results.check("reduced motion: the bar is full from the start and the dots stand still", still.bar.every(transform => Math.abs(scaleX(transform) - 1) < 0.001) && JSON.stringify(still.dots[0]) === JSON.stringify(still.dots[1]) && (still.dots[0] ?? []).every(opacity => opacity === "0.55"), JSON.stringify(still));
      results.check("…the same words and the same move on to Google (about 900 ms)", seen.title === "Opening Google to sign you in to Briefcase…" && movedAfter !== null && movedAfter >= 800 && movedAfter <= 5_000, `${seen.title} ${movedAfter} ms`);
      if (movedAfter !== null) results.metric("Opening page shown → Google (reduced motion)", movedAfter);
      await context.close();
    }
  },
};
