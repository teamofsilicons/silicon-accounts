/**
 * The page between an app's own "Continue with Google / Apple" button and the provider. UNDERSTANDING.md ("Adding
 * sign-in to an app", as edited on 2026-10-07): Silicon Accounts never jumps straight to Google or Apple; it first
 * opens its own page saying "Opening Google to sign you in to {app name}…", in the app's configured style and with
 * "Powered by Silicon Accounts" at the bottom (Silicon Accounts linking to accounts.teamofsilicons.com, "Making the
 * pages your own"), and only then moves on to Google or Apple.
 *
 * The journeys press the buttons an app puts on its own page (quill-docs: the SDK snippet; pixel-studio: the iframe),
 * stop the browser's navigation to the provider (a 204 keeps the page that sent it on screen), read and photograph that
 * page, then go on to the provider's URL.
 *
 * They also replay the WebKit race of the previous round deterministically: the app's public config answers 200 but
 * its body is cut short (WebKit cancels a frame's reads when the page around it navigates). The embed and the SDK
 * must read it again and draw their buttons, with no error on the console.
 */
import type { Page, Route } from "@playwright/test";
import type { Journey } from "../../context";
import { newContext, shot, sleep } from "../../lib";
import { fakeApp, literally } from "./_helpers";

/**
 * Stops the browser's first navigation to `prefix` with a 204 answer, which cancels a navigation (HTML: no content,
 * the document stays), so the page that sent the browser on is still on screen and alive to read and photograph. (A
 * navigation merely held at the network keeps Playwright from evaluating or photographing the page until it commits.)
 * The journey then goes on to the stopped URL itself.
 */
async function stopFirstNavigation(page: Page, prefix: string): Promise<{ stopped: Promise<{ url: string; at: number }> }> {
  let onStopped!: (value: { url: string; at: number }) => void;
  const stopped = new Promise<{ url: string; at: number }>(resolve => (onStopped = resolve));
  let first = true;
  await page.route(
    url => url.href.startsWith(prefix),
    async (route: Route) => {
      if (!first || !route.request().isNavigationRequest()) {
        await route.fallback();
        return;
      }
      first = false;
      onStopped({ url: route.request().url(), at: Date.now() });
      await route.fulfill({ status: 204, body: "" });
    },
  );
  // Wrapped: an async function returning the promise itself would wait for it (thenables are adopted).
  return { stopped };
}

/** The stopped navigation shows up as a failed request (WebKit: "Aborted: 204 No Content"); it is the journey's own. */
const stoppedNoise = (oidc: string) => new RegExp(`requestfailed GET ${literally(oidc)}/(google|apple)/authorize`);

/**
 * The app's public config (GET /v1/apps/<id>/public), whose first answer is a 200 with its body cut short (a
 * truncated JSON document): what a page reads when WebKit cancels the transfer after the headers came. Later reads go
 * through. Returns the number of reads so far.
 */
async function cutFirstConfigRead(page: Page, site: string, appId: string): Promise<() => number> {
  let reads = 0;
  const url = `${site}/v1/apps/${appId}/public`;
  await page.route(
    candidate => candidate.href.startsWith(url),
    async (route: Route) => {
      reads += 1;
      if (reads === 1) {
        await route.fulfill({
          status: 200,
          headers: { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "no-store" },
          body: `{"app_id":"${appId}","name":"Cut sh`,
        });
        return;
      }
      await route.fallback();
    },
  );
  return () => reads;
}

interface OpeningPage {
  url: string;
  text: string;
  primary: string;
  powered: { found: boolean; text?: string; href?: string; target?: string | null; top?: number; lowest?: number; lowestText?: string; visible?: boolean };
}

/** What the browser shows while the provider's request is held: its URL, words, painted primary and footer. */
async function readOpeningPage(page: Page): Promise<OpeningPage> {
  const url = page.url();
  const probe = await page
    .evaluate(() => {
      const text = (document.body?.innerText ?? "").replace(/\s+/g, " ").trim();
      const scope = document.querySelector(".sa-brand");
      const primary = scope ? getComputedStyle(scope).getPropertyValue("--primary").trim() : "";
      const powered = document.querySelector("[data-powered-by]");
      if (!powered) return { text, primary, powered: { found: false } };
      const box = powered.getBoundingClientRect();
      const style = getComputedStyle(powered);
      const link = powered.querySelector("a");
      // The lowest visible text on the page outside the footer: "at the bottom" means nothing else reads below it.
      let lowest = 0;
      let lowestText = "";
      for (const element of Array.from(document.body.querySelectorAll("*"))) {
        if (powered.contains(element)) continue;
        if (!Array.from(element.childNodes).some(node => node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim())) continue;
        const s = getComputedStyle(element);
        if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) continue;
        const r = element.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
        if (r.bottom > lowest) {
          lowest = r.bottom;
          lowestText = (element.textContent ?? "").trim().slice(0, 60);
        }
      }
      return {
        text,
        primary,
        powered: {
          found: true,
          text: (powered.textContent ?? "").replace(/\s+/g, " ").trim(),
          href: link?.getAttribute("href") ?? "",
          target: link?.getAttribute("target") ?? null,
          top: box.top,
          lowest,
          lowestText,
          visible: box.width > 0 && box.height > 0 && style.visibility !== "hidden" && style.display !== "none",
        },
      };
    })
    .catch(error => ({ text: `(could not read the page: ${String(error)})`, primary: "", powered: { found: false } }));
  return { url, ...probe };
}

/** The ellipsis may be "…" or "...". */
const openingWords = (provider: "Google" | "Apple", app: string) => new RegExp(`Opening ${provider} to sign you in to ${literally(app)}(…|\\.\\.\\.)?`);

function checkOpening(ctx: Parameters<Journey["run"]>[0], provider: "Google" | "Apple", appName: string, primary: string, seen: OpeningPage): void {
  const { env, results } = ctx;
  results.check(`pressing Continue with ${provider} on the app's page first opens a page of ours (the browser is on ${env.site} when it asks ${provider})`, seen.url.startsWith(env.site), seen.url);
  results.check(
    `…that page says "Opening ${provider} to sign you in to ${appName}…" (UNDERSTANDING: "we first open our page saying Opening ${provider} to sign you in to {app name}…")`,
    openingWords(provider, appName).test(seen.text),
    `the page reads: ${seen.text.slice(0, 300)}`,
  );
  results.check(`…in the app's configured style (its branding primary ${primary} painted on the page)`, seen.primary.toLowerCase() === primary.toLowerCase(), `--primary = "${seen.primary}"`);
  const powered = seen.powered;
  results.check(
    `…with "Powered by Silicon Accounts" at the bottom (visible, nothing reads below it)`,
    powered.found && !!powered.visible && /Powered by Silicon Accounts/.test(powered.text ?? "") && (powered.top ?? 0) >= (powered.lowest ?? 0) - 1,
    JSON.stringify(powered),
  );
  results.check(
    `…whose "Silicon Accounts" links to https://accounts.teamofsilicons.com (UNDERSTANDING, "Making the pages your own")`,
    /^https:\/\/accounts\.teamofsilicons\.com\/?$/.test(powered.href ?? ""),
    `href="${powered.href ?? ""}"`,
  );
}

const google: Journey = {
  name: "auth-flows-opening-google",
  title: "quill-docs' SDK button Continue with Google: a cut-off config read is read again (buttons drawn, no error), then our \"Opening Google to sign you in to Quill Docs…\" page in quill-docs' style with Powered by Silicon Accounts at the bottom, and only then Google",
  async run(ctx) {
    const { env, results, browser } = ctx;
    const app = fakeApp("quill-docs");
    const primary = ((app.signin_defaults.branding as { light?: { primary?: string } } | undefined)?.light?.primary ?? "").toLowerCase();
    const context = await newContext(browser);
    const page = await context.newPage();
    results.watch(page, "opening-google", [stoppedNoise(env.oidc)]);
    const reads = await cutFirstConfigRead(page, env.site, "quill-docs");
    const toGoogle = await stopFirstNavigation(page, `${env.oidc}/google/authorize`);

    await page.goto(`${env.apps}/quill-docs/?only=sdk`);
    const button = page.locator("#silicon-accounts").getByRole("button", { name: "Continue with Google" });
    const drawn = await button.waitFor({ timeout: 15_000 }).then(() => true, () => false);
    results.check("the SDK reads quill-docs' config again after a 200 whose body was cut short, and draws its buttons", drawn && reads() >= 2, `drawn=${drawn}, reads=${reads()}`);
    const sdkAlerts = (await page.locator("#silicon-accounts").getByRole("alert").allInnerTexts()).filter(text => text.trim());
    results.check("…without showing an error", sdkAlerts.length === 0, sdkAlerts.length ? sdkAlerts.join(" | ").slice(0, 300) : "no alert");

    const pressedAt = Date.now();
    await button.click();
    const held = await Promise.race([toGoogle.stopped, sleep(30_000).then(() => null)]);
    results.check("the browser goes on to Google (its authorize request was made)", held !== null, held?.url ?? "no request to Google within 30 s");
    if (held) results.metric("Continue with Google pressed → Google asked", held.at - pressedAt);
    await sleep(300);
    const seen = await readOpeningPage(page);
    await shot(env, page, "auth-flows-opening-google");
    checkOpening(ctx, "Google", app.name, primary, seen);
    const atGoogle = held ? await page.goto(held.url).then(() => page.url().startsWith(`${env.oidc}/google/authorize`), () => false) : false;
    results.check("…and only then Google's page", atGoogle, page.url());
    await context.close();
  },
};

const apple: Journey = {
  name: "auth-flows-opening-apple",
  title: "pixel-studio's iframe button Continue with Apple: a cut-off config read is read again (buttons drawn, no error), then our \"Opening Apple to sign you in to Pixel Studio…\" page in pixel-studio's style with Powered by Silicon Accounts at the bottom, and only then Apple",
  async run(ctx) {
    const { env, results, browser } = ctx;
    const app = fakeApp("pixel-studio");
    const primary = ((app.signin_defaults.branding as { light?: { primary?: string } } | undefined)?.light?.primary ?? "").toLowerCase();
    const context = await newContext(browser);
    const page = await context.newPage();
    results.watch(page, "opening-apple", [stoppedNoise(env.oidc)]);
    const reads = await cutFirstConfigRead(page, env.site, "pixel-studio");
    const toApple = await stopFirstNavigation(page, `${env.oidc}/apple/authorize`);

    await page.goto(`${env.apps}/pixel-studio/?only=iframe`);
    const frame = page.frameLocator("#signin-iframe");
    const link = frame.getByRole("link", { name: "Continue with Apple" });
    const drawn = await link.waitFor({ timeout: 15_000 }).then(() => true, () => false);
    results.check("the embed reads pixel-studio's config again after a 200 whose body was cut short, and draws its buttons", drawn && reads() >= 2, `drawn=${drawn}, reads=${reads()}`);
    // Next's route announcer is an empty role=alert in every page; an error is an alert with words in it.
    const embedAlerts = (await frame.locator('[role="alert"]:not(#__next-route-announcer__)').allInnerTexts()).filter(text => text.trim());
    results.check("…without showing an error", embedAlerts.length === 0, embedAlerts.length ? embedAlerts.join(" | ").slice(0, 300) : "no alert");

    const pressedAt = Date.now();
    await link.click();
    const held = await Promise.race([toApple.stopped, sleep(30_000).then(() => null)]);
    results.check("the browser goes on to Apple (its authorize request was made)", held !== null, held?.url ?? "no request to Apple within 30 s");
    if (held) results.metric("Continue with Apple pressed → Apple asked", held.at - pressedAt);
    await sleep(300);
    const seen = await readOpeningPage(page);
    await shot(env, page, "auth-flows-opening-apple");
    checkOpening(ctx, "Apple", app.name, primary, seen);
    const atApple = held ? await page.goto(held.url).then(() => page.url().startsWith(`${env.oidc}/apple/authorize`), () => false) : false;
    results.check("…and only then Apple's page", atApple, page.url());
    await context.close();
  },
};

export const journeys: Journey[] = [google, apple];
