/**
 * The page between an app's own "Continue with Google / Apple" button and the provider. UNDERSTANDING.md v2 ("Adding
 * sign-in to an app"): Silicon Accounts never jumps straight to Google or Apple; it first opens its own page saying
 * "Opening Google to sign you in to {app name}…", in the app's configured style and with "Powered by Silicon Accounts"
 * at the bottom (Silicon Accounts linking to accounts.teamofsilicons.com, "Making the pages your own"), and only then
 * moves on to Google or Apple (build spec 06-v2.md §5: about 900 ms, a visible "Continue to Google" fallback, reduced
 * motion = no animation and the same behaviour, the app's copy.opening_title with {provider} and {app}).
 *
 * The journeys press the buttons an app puts on its own page (quill-docs: the SDK snippet; pixel-studio and acme-notes:
 * the iframe), stop the browser's navigation to the provider (a 204 keeps the page that sent it on screen), read and
 * photograph that page, then go on to the provider's URL. They also replay the WebKit race of an earlier round: the
 * app's public config answers 200 but its body is cut short; the embed and the SDK must read it again and draw their
 * buttons, with no error on the console.
 */
import type { Page, Route } from "@playwright/test";
import type { Journey } from "../../context";
import { live, newContext, shot, sleep, startAtApp, waitForOpening } from "../../lib";
import { fakeApp, literally } from "./_helpers";

/**
 * Stops the browser's first navigation to `prefix` with a 204 answer, which cancels a navigation (HTML: no content,
 * the document stays), so the page that sent the browser on is still on screen and alive to read and photograph. The
 * journey then goes on to the stopped URL itself.
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
 * The app's public config (GET /v1/apps/<id>/public), whose first answer is a 200 with its body cut short: what a page
 * reads when WebKit cancels the transfer after the headers came. Later reads go through. Returns the reads so far.
 */
async function cutFirstConfigRead(page: Page, site: string, appId: string): Promise<() => number> {
  let reads = 0;
  const url = `${site}/v1/apps/${appId}/public`;
  await page.route(
    candidate => candidate.href.startsWith(url),
    async (route: Route) => {
      reads += 1;
      if (reads === 1) {
        await route.fulfill({ status: 200, headers: { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "no-store" }, body: `{"app_id":"${appId}","name":"Cut sh` });
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
  title: string;
  primary: string;
  fallback: boolean;
  powered: { found: boolean; text?: string; href?: string; top?: number; lowest?: number; lowestText?: string; visible?: boolean };
}

/** What the browser shows on the Opening page: its URL, heading, words, painted primary, fallback and footer. */
async function readOpeningPage(page: Page): Promise<OpeningPage> {
  const url = page.url();
  const probe = await page
    .evaluate(() => {
      const text = (document.body?.innerText ?? "").replace(/\s+/g, " ").trim();
      const opening = [...document.querySelectorAll("[data-opening]")].find(element => !element.closest("[data-step-leaving]"));
      const title = (opening?.querySelector("h1")?.textContent ?? "").replace(/\s+/g, " ").trim();
      const fallback = [...(opening?.querySelectorAll("button") ?? [])].some(button => /^Continue to (Google|Apple)$/.test((button.textContent ?? "").replace(/\s+/g, " ").trim()) && button.getClientRects().length > 0);
      const scope = document.querySelector(".sa-brand");
      const primary = scope ? getComputedStyle(scope).getPropertyValue("--primary").trim() : "";
      const powered = document.querySelector("[data-powered-by]");
      if (!powered) return { text, title, fallback, primary, powered: { found: false } };
      const box = powered.getBoundingClientRect();
      const style = getComputedStyle(powered);
      const link = [...powered.querySelectorAll("a")].find(a => (a.textContent ?? "").trim() === "Silicon Accounts") ?? powered.querySelector("a");
      // The lowest visible text on the page outside the footer: "at the bottom" means nothing else reads below it.
      let lowest = 0;
      let lowestText = "";
      for (const element of Array.from(document.body.querySelectorAll("*"))) {
        if (powered.contains(element)) continue;
        if (!Array.from(element.childNodes).some(node => node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim())) continue;
        const s = getComputedStyle(element);
        if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) continue;
        if (element.closest(".sr-only")) continue;
        const r = element.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
        if (r.bottom > lowest) {
          lowest = r.bottom;
          lowestText = (element.textContent ?? "").trim().slice(0, 60);
        }
      }
      return {
        text,
        title,
        fallback,
        primary,
        powered: {
          found: true,
          text: (powered.textContent ?? "").replace(/\s+/g, " ").trim(),
          href: link?.getAttribute("href") ?? "",
          top: box.top,
          lowest,
          lowestText,
          visible: box.width > 0 && box.height > 0 && style.visibility !== "hidden" && style.display !== "none",
        },
      };
    })
    .catch(error => ({ text: `(could not read the page: ${String(error)})`, title: "", fallback: false, primary: "", powered: { found: false } }));
  return { url, ...probe };
}

function checkOpening(ctx: Parameters<Journey["run"]>[0], provider: "Google" | "Apple", expectedTitle: string, primary: string, seen: OpeningPage): void {
  const { env, results } = ctx;
  results.check(`pressing Continue with ${provider} on the app's page first opens a page of ours (the browser is on ${env.site} when it asks ${provider})`, seen.url.startsWith(env.site), seen.url);
  results.check(`…that page says "${expectedTitle}"`, seen.title === expectedTitle, `the page's heading: "${seen.title}" | ${seen.text.slice(0, 200)}`);
  results.check(`…in the app's configured style (its branding primary ${primary} painted on the page)`, seen.primary.toLowerCase() === primary.toLowerCase(), `--primary = "${seen.primary}"`);
  results.check(`…with a visible "Continue to ${provider}" fallback`, seen.fallback);
  const powered = seen.powered;
  results.check(`…with "Powered by Silicon Accounts" at the bottom (visible, nothing reads below it)`, powered.found && !!powered.visible && /Powered by Silicon Accounts/.test(powered.text ?? "") && (powered.top ?? 0) >= (powered.lowest ?? 0) - 1, JSON.stringify(powered));
  results.check(`…whose "Silicon Accounts" links to https://accounts.teamofsilicons.com (UNDERSTANDING, "Making the pages your own")`, /^https:\/\/accounts\.teamofsilicons\.com\/?$/.test(powered.href ?? ""), `href="${powered.href ?? ""}"`);
}

/** The primary colour the page paints for an app: its dark palette's for a dark-theme app, else (light browsers) the light one. */
function primaryOf(appId: string): string {
  const branding = fakeApp(appId).signin_defaults.branding as { theme?: string; light?: { primary?: string }; dark?: { primary?: string } } | undefined;
  return ((branding?.theme === "dark" ? branding.dark?.primary : branding?.light?.primary) ?? "").toLowerCase();
}

const google: Journey = {
  name: "auth-flows-opening-google",
  title: "quill-docs' SDK button Continue with Google: a cut-off config read is read again (buttons drawn, no error), then our \"Opening Google to sign you in to Quill Docs…\" page in quill-docs' style with its fallback and Powered by at the bottom, and only then Google; back on the page it waits paused; reduced motion moves on the same",
  async run(ctx) {
    const { env, results, browser } = ctx;
    const app = fakeApp("quill-docs");
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
    const opening = live(page, '[data-opening="google"]').first();
    const shownAt = await opening.waitFor({ timeout: 30_000 }).then(() => Date.now(), () => null);
    const held = await Promise.race([toGoogle.stopped, sleep(30_000).then(() => null)]);
    results.check("the browser goes on to Google by itself (its authorize request was made)", held !== null, held?.url ?? "no request to Google within 30 s");
    if (held && shownAt) {
      results.metric("Opening page shown → Google asked", held.at - shownAt);
      results.check("…about 900 ms after the Opening page showed (between 0.5 and 5 s)", held.at - shownAt >= 500 && held.at - shownAt <= 5_000, `${held.at - shownAt} ms`);
    }
    if (held) results.metric("Continue with Google pressed → Google asked", held.at - pressedAt);
    await sleep(300);
    const seen = await readOpeningPage(page);
    await shot(env, page, "auth-flows-opening-google");
    checkOpening(ctx, "Google", `Opening Google to sign you in to ${app.name}…`, primaryOf("quill-docs"), seen);

    // Back on the page (a reload after it moved on): it waits for a press instead of sending the Carbon on again.
    // (The first stop lets every later navigation through; this one, registered last, answers first.)
    const again = await stopFirstNavigation(page, `${env.oidc}/google/authorize`);
    await page.reload();
    await live(page, '[data-opening="google"][data-paused]').first().waitFor({ timeout: 30_000 }).catch(() => undefined);
    const moved = await Promise.race([again.stopped.then(() => true), sleep(2_500).then(() => false)]);
    const paused = await readOpeningPage(page);
    await shot(env, page, "auth-flows-opening-google-paused");
    results.check("reloaded after it moved on, the page waits paused (\"Sign in to Quill Docs with Google\", Continue to Google) and does not move by itself", !moved && paused.title === `Sign in to ${app.name} with Google` && paused.fallback, `${paused.title} | moved=${moved}`);
    await live(page, '[data-opening="google"] button').filter({ hasText: "Continue to Google" }).first().click();
    const pressed = await Promise.race([again.stopped.then(() => true), sleep(15_000).then(() => false)]);
    results.check("…and \"Continue to Google\" goes on to Google", pressed);
    const atGoogle = held ? await page.goto(held.url).then(() => page.url().startsWith(`${env.oidc}/google/authorize`), () => false) : false;
    results.check("…and only then Google's page", atGoogle, page.url());
    await context.close();

    // Reduced motion: the same behaviour (it moves on by itself), without the animation.
    const calm = await newContext(browser);
    const calmPage = await calm.newPage();
    await calmPage.emulateMedia({ reducedMotion: "reduce" });
    results.watch(calmPage, "opening-reduced-motion");
    await startAtApp(env, calmPage, "quill-docs", { method: "google" });
    const reduced = await waitForOpening(env, calmPage, "google", { shotName: "auth-flows-opening-google-reduced-motion" });
    results.check("with reduced motion the Opening page still shows its title and moves on to Google by itself", reduced.title === `Opening Google to sign you in to ${app.name}…` && reduced.movedAfterMs !== null && reduced.movedAfterMs < 10_000, `${reduced.title} | ${reduced.movedAfterMs} ms`);
    if (reduced.movedAfterMs !== null) results.metric("Opening page (reduced motion) → Google", reduced.movedAfterMs);
    await calm.close();

    // "Other ways to sign in" on the Opening page: the app's methods, and no move to Google.
    const other = await newContext(browser);
    const otherPage = await other.newPage();
    results.watch(otherPage, "opening-other-ways");
    await startAtApp(env, otherPage, "quill-docs", { method: "google" });
    await live(otherPage, '[data-opening="google"]').first().waitFor({ timeout: 30_000 });
    await otherPage.getByRole("button", { name: "Other ways to sign in" }).click({ timeout: 5_000 }).catch(() => undefined);
    const field = otherPage.getByRole("textbox", { name: "Email" });
    const methods = await field.waitFor({ timeout: 10_000 }).then(() => true, () => false);
    await sleep(1_500);
    results.check("\"Other ways to sign in\" on the Opening page shows quill-docs' methods (the email field) and stays there", methods && otherPage.url().startsWith(env.site) && (await field.isVisible()), otherPage.url());
    await other.close();
  },
};

const apple: Journey = {
  name: "auth-flows-opening-apple",
  title: "pixel-studio's iframe button Continue with Apple: a cut-off config read is read again (buttons drawn, no error), then our \"Opening Apple to sign you in to Pixel Studio…\" page in pixel-studio's style with Powered by at the bottom, and only then Apple; acme-notes' iframe: its own opening title in its own words",
  async run(ctx) {
    const { env, results, browser } = ctx;
    const app = fakeApp("pixel-studio");
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
    results.check("the browser goes on to Apple by itself (its authorize request was made)", held !== null, held?.url ?? "no request to Apple within 30 s");
    if (held) results.metric("Continue with Apple pressed → Apple asked", held.at - pressedAt);
    await sleep(300);
    const seen = await readOpeningPage(page);
    await shot(env, page, "auth-flows-opening-apple");
    checkOpening(ctx, "Apple", `Opening Apple to sign you in to ${app.name}…`, primaryOf("pixel-studio"), seen);
    const atApple = held ? await page.goto(held.url).then(() => page.url().startsWith(`${env.oidc}/apple/authorize`), () => false) : false;
    results.check("…and only then Apple's page", atApple, page.url());
    await context.close();

    // acme-notes' own words (copy.opening_title "Taking you to {provider} for {app}…"), from its iframe.
    const acme = await newContext(browser);
    const acmePage = await acme.newPage();
    results.watch(acmePage, "opening-acme", [stoppedNoise(env.oidc)]);
    const toAcmeGoogle = await stopFirstNavigation(acmePage, `${env.oidc}/google/authorize`);
    await acmePage.goto(`${env.apps}/acme-notes/?only=iframe`);
    await acmePage.frameLocator("#signin-iframe").getByRole("link", { name: "Continue with Google" }).click({ timeout: 15_000 });
    const acmeHeld = await Promise.race([toAcmeGoogle.stopped, sleep(30_000).then(() => null)]);
    await sleep(300);
    const acmeSeen = await readOpeningPage(acmePage);
    await shot(env, acmePage, "auth-flows-opening-acme");
    results.check("acme-notes' Opening page uses its own copy: \"Taking you to Google for Acme Notes…\", then Google", acmeSeen.title === "Taking you to Google for Acme Notes…" && acmeHeld !== null, `${acmeSeen.title} | ${acmeHeld?.url.slice(0, 80) ?? "no Google request"}`);
    results.check("…in acme-notes' style, with Powered by Silicon Accounts linking to accounts.teamofsilicons.com", acmeSeen.primary.toLowerCase() === primaryOf("acme-notes") && /^https:\/\/accounts\.teamofsilicons\.com\/?$/.test(acmeSeen.powered.href ?? ""), `${acmeSeen.primary} ${acmeSeen.powered.href}`);
    await acme.close();
  },
};

export const journeys: Journey[] = [google, apple];
