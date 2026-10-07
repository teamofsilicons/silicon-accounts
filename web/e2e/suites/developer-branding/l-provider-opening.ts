/**
 * "Continue with Google" or "Continue with Apple" pressed on an app's own website, held to UNDERSTANDING.md ("Adding
 * sign-in to an app", edited 2026-10-07): "we don't jump straight to Google or Apple. We first open our page saying
 * `Opening Google to sign you in to {app name}…`, in the app's configured style and with `Powered by Silicon
 * Accounts` at the bottom, and only then move on to Google or Apple."
 *
 * The press comes from each way an app can add sign-in: its own direct button (a link to /authorize with
 * method=google|apple, as the fake app's page builds it), its iframe embed (browser) and its SDK snippet
 * (quill-docs); and from apps of every look: the Silicon Accounts look (briefcase), acme-notes (split, forced dark),
 * pixel-studio (minimal, light, outline), orbit-games (dark, soft, its own Apple keys), at 1440 px and on a phone.
 *
 * The page our site shows on the way is read twice: while it asks the API for the provider's address (that call is
 * held, so the page stays on screen to be read and photographed), and at the moment the browser leaves it for the
 * provider (its own `beforeunload`, through a binding: Playwright cannot read a page whose navigation has begun; only
 * Chromium delivers that snapshot). Then the journey lets it go on and sees the provider's page.
 */
import type { Journey } from "../../context";
import { json, newContext, shot, sleep } from "../../lib";
import { checkPoweredBy, holdRequests, readHostedLook, recordLeaving } from "./_helpers";

interface Case {
  app: string;
  provider: "google" | "apple";
  /** Where the press happens: the app's own button, its iframe embed, or its SDK snippet. */
  entry: "button" | "iframe" | "sdk";
  width: number;
  height: number;
}

const CASES: Case[] = [
  { app: "briefcase", provider: "google", entry: "button", width: 1440, height: 900 },
  { app: "acme-notes", provider: "google", entry: "button", width: 1440, height: 900 },
  { app: "acme-notes", provider: "google", entry: "button", width: 390, height: 844 },
  { app: "pixel-studio", provider: "apple", entry: "button", width: 1440, height: 900 },
  { app: "orbit-games", provider: "apple", entry: "button", width: 1440, height: 900 },
  { app: "orbit-games", provider: "apple", entry: "button", width: 390, height: 844 },
  { app: "browser", provider: "google", entry: "iframe", width: 1440, height: 900 },
  { app: "quill-docs", provider: "google", entry: "sdk", width: 1440, height: 900 },
];

interface PublicApp {
  name: string;
  branding: { theme: string; layout: string; button_style: string };
}

const PROVIDER = { google: "Google", apple: "Apple" } as const;
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const journey: Journey = {
  name: "developer-branding-provider-opening",
  title: "Continue with Google/Apple from an app's own button, iframe and SDK: our page first says \"Opening <provider> to sign you in to <app>…\", in the app's style with Powered by, then moves on to the provider (default, acme-notes, pixel-studio, orbit-games; 1440 and 390 px)",
  timeoutMs: 6 * 60_000,
  async run(ctx) {
    const { env, results, browser } = ctx;
    const oidc = new URL(env.oidc).origin;
    const site = new URL(env.site).origin;
    const opening: string[] = [];
    const notOpening: string[] = [];
    const movedOn: string[] = [];
    const stuck: string[] = [];

    for (const item of CASES) {
      const provider = PROVIDER[item.provider];
      const label = `dvb-l-${item.app}-${item.entry}-${item.width}`;
      const app = (await json<PublicApp>(`${env.site}/v1/apps/${item.app}/public`)).body;
      const theme = app.branding.theme === "auto" ? "light" : app.branding.theme;
      const said = new RegExp(`Opening ${provider} to sign you in to ${escape(app.name)}`);
      const context = await newContext(browser, { width: item.width, height: item.height });
      const leaving = await recordLeaving(context, env.site);
      // The page's own call for the provider's address (POST /v1/flows/{id}/oauth/{provider}).
      const held = await holdRequests(context, url => url.origin === site && /^\/v1\/flows\/[^/]+\/oauth\//.test(url.pathname));
      const page = await context.newPage();
      results.watch(page, label);
      try {
        // The press, on the app's own site.
        if (item.entry === "button") {
          await page.goto(`${env.apps}/${item.app}/?only=hosted&method=${item.provider}`);
          await page.locator("#signin-hosted").click();
        } else if (item.entry === "iframe") {
          await page.goto(`${env.apps}/${item.app}/?only=iframe`);
          await page.frameLocator("#signin-iframe").locator(`a[data-method='${item.provider}']`).click({ timeout: 30_000 });
        } else {
          await page.goto(`${env.apps}/${item.app}/?only=sdk`);
          await page.locator(`#silicon-accounts button[data-method='${item.provider}']`).click({ timeout: 30_000 });
        }
        const pressed = Date.now();
        const asking = await Promise.race([held.reached, sleep(20_000).then(() => null)]);
        const askedAfter = Date.now() - pressed;

        // While it asks for the provider's address, the page is on screen: what does it say and look like?
        let shown = "";
        let shownHeading = "";
        let busyButton = false;
        if (asking) {
          await page.locator("main[data-fonts='ready']").first().waitFor({ timeout: 10_000 }).catch(() => undefined);
          await sleep(700);
          shown = ((await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "")) ?? "").replace(/\s+/g, " ").trim();
          shownHeading = ((await page.locator("main h1").first().textContent({ timeout: 2_000 }).catch(() => "")) ?? "").replace(/\s+/g, " ").trim();
          busyButton = (await page.locator(`main [data-provider='${item.provider}'][aria-busy='true']`).count()) > 0;
          const look = await readHostedLook(page).catch(() => null);
          results.check(`${label}: on the way to ${provider} the page is ours, in ${item.app}'s style (${theme}, ${app.branding.layout}, ${app.branding.button_style} buttons)`, page.url().startsWith(env.site) && look?.attrs["data-theme"] === theme && look.attrs["data-layout"] === app.branding.layout && look.attrs["data-button-style"] === app.branding.button_style, `${page.url().slice(0, 80)}; ${JSON.stringify(look?.attrs ?? null)}`);
          await checkPoweredBy(ctx, page, `${label}: on the way to ${provider}`, { outsideBranding: true });
          await shot(env, page, `${label}-opening-${item.provider}`);
        } else {
          results.check(`${label}: on the way to ${provider} the page is ours, in ${item.app}'s style`, false, `the page never asked for ${provider}'s address within 20 s (${page.url().slice(0, 100)})`);
        }

        // Then on to the provider; what the page showed as the browser left it.
        const released = Date.now();
        held.release();
        const arrived = await page.waitForURL(url => url.origin === oidc, { timeout: 30_000 }).then(() => page.locator("#new-identity").waitFor({ timeout: 15_000 })).then(() => true).catch(() => false);
        (arrived ? movedOn : stuck).push(`${item.app} (${item.entry}, ${item.width} px)${arrived ? "" : `: ${page.url().slice(0, 80)}`}`);
        // What a Carbon waits: press → the page asks for the provider's address, then the answer → the provider's page
        // (the journey's own hold in between, while it reads the page, left out).
        if (arrived && asking) results.metric(`${item.app} ${item.entry} ${item.width}px: press → ${provider}'s page (without the journey's hold)`, askedAfter + (Date.now() - released));
        // (WebKit does not deliver the leaving snapshot; the page read while it asked for the address stands alone there.)
        const last = [...leaving].reverse().find(snapshot => snapshot.url.startsWith(env.site));
        const saidIt = said.test(shown) || said.test(last?.text ?? "");
        (saidIt ? opening : notOpening).push(`${item.app} via its ${item.entry} at ${item.width} px: ${saidIt ? "says it" : `shows the heading "${shownHeading || last?.heading || "(none)"}"${busyButton ? ` with its Continue with ${provider} button busy` : ""}, and no "Opening ${provider}…" line${last ? " (also as it left)" : ""}`}`);
      } finally {
        held.release();
        await context.close();
      }
    }

    results.check("pressing Continue with Google or Apple on an app's own site first shows our page saying \"Opening <Google|Apple> to sign you in to <app name>…\" (UNDERSTANDING.md, \"Adding sign-in to an app\")", notOpening.length === 0 && opening.length === CASES.length, [...notOpening, ...opening].join(" | "));
    results.check("then the browser moves on to Google or Apple (the mock provider's page), from every app and every way in", stuck.length === 0 && movedOn.length === CASES.length, stuck.join(" | ") || movedOn.join(", "));
  },
};
