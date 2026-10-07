/**
 * Hostile app content. An app styles and words every hosted page itself (UNDERSTANDING.md "Making the pages your own",
 * "Flows"): its sign-in and sign-up titles, the Opening page's title, each flow page's title, subtitle and continue
 * label, its logo. Those pages run on the account site's origin, where the Carbon's session lives, so whatever an app
 * writes there must stay text: markup in any of them is shown as typed, never parsed or run, and an SVG logo with
 * script is only ever an image. Checked on every page a Carbon walks (sign-in, sign-up, Opening, email code, sign-up
 * details, the app's flow page, review) and on the embed, with the CSP's violation reports watched too (an injected
 * handler the CSP had to block still means markup got in).
 */
import type { Page } from "@playwright/test";
import type { Journey } from "../../context";
import { appUrl, completeDetails, hostedTitle, newContext, shot, signInWithCode, sleep, startAtApp, tag } from "../../lib";
import { appCredentials, brief, call, callbackOf, errorOf, randomEmail, remember } from "./_helpers";

const APP = "quill-docs";

interface StoredConfig {
  signin_config?: {
    copy?: Record<string, string | null>;
    flow?: unknown;
    branding?: { logo_url?: string | null; [key: string]: unknown };
  };
}

/** What the page did with the hostile content: anything run, any element it would have made, CSP reports. */
async function damage(page: Page): Promise<{ pwned: unknown; injected: number; violations: string[] }> {
  return page
    .evaluate(() => {
      const scope = window as unknown as { __pwned?: unknown; __violations?: string[] };
      const injected = document.querySelectorAll('img[src="x"], svg[onload], iframe[src^="javascript"], [data-hostile], b.hostile, marquee').length;
      return { pwned: scope.__pwned ?? null, injected, violations: scope.__violations ?? [] };
    })
    .catch(() => ({ pwned: "page unreadable", injected: -1, violations: [] as string[] }));
}

export const journey: Journey = {
  name: "security-app-content",
  title: "hostile app content stays text: markup in an app's sign-in / sign-up / Opening titles and subtitles, its flow page's title, subtitle and continue label, and script in its SVG logo is never parsed or run on any hosted page (sign-in, sign-up, Opening, code, sign-up details, flow page, review) or the embed, and causes no CSP report",
  async run(ctx) {
    const { env, results, browser } = ctx;
    const marker = (n: number) => `window.__pwned=${n}`;
    const hostile = {
      title: `<img src=x onerror=${marker(1)}>`,
      subtitle: `<script>${marker(2)}</script><b class="hostile">bold</b>`,
      opening_title: `<svg onload=${marker(3)}> {provider} {app}`,
      signup_title: `"><img src=x onerror=${marker(4)}>`,
      signup_subtitle: `<iframe src="javascript:${marker(5)}"></iframe>`,
    };
    const flowStep = { id: "hostile", fields: ["email"], title: `<marquee data-hostile onstart=${marker(6)}>t</marquee>`, subtitle: `</div><img src=x onerror=${marker(7)}>`, continue_label: "<b>go</b>", layout: null };
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" onload="window.top.__pwned=8"><script>window.top.__pwned=9</script><rect width="40" height="40" fill="#e33"/></svg>`;
    const logo = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
    const before = (await call<StoredConfig>(`${env.site}/v1/apps/${APP}`, { basic: appCredentials(APP), ip: ctx.ip })).body.signin_config ?? {};
    const patch = (body: unknown) => call(`${env.site}/v1/apps/${APP}/signin-config`, { method: "PATCH", json: body, basic: appCredentials(APP), ip: ctx.ip, headers: { "idempotency-key": `sec-${tag()}${tag()}` } });
    const set = await patch({ copy: hostile, flow: { steps: [flowStep], review: true }, branding: { logo_url: logo } });
    results.check("an app may store markup-looking words as its pages' copy and flow text, and an SVG logo (plain text and data:image are allowed)", set.status === 200, brief(set));
    const context = await newContext(browser);
    await context.addInitScript(() => {
      const seen: string[] = [];
      (window as unknown as { __violations: string[] }).__violations = seen;
      document.addEventListener("securitypolicyviolation", event => seen.push(`${event.violatedDirective} ${event.blockedURI}`));
    });
    const dialogs: string[] = [];
    const callback = callbackOf(env, APP);
    const authorize = (extra = "") => `${env.site}/authorize?app_id=${APP}&redirect_uri=${encodeURIComponent(callback)}&state=hc-${tag()}${extra}`;
    const seen: Array<{ page: string; pwned: unknown; injected: number; violations: string[]; shows: boolean }> = [];
    const look = async (page: Page, label: string, literal: string | null) => {
      await page.waitForLoadState("networkidle").catch(() => undefined);
      await sleep(600);
      const text = await page.locator("body").innerText().catch(() => "");
      const result = await damage(page);
      seen.push({ page: label, ...result, shows: literal === null || text.includes(literal) });
    };
    try {
      const page = await context.newPage();
      page.on("dialog", dialog => {
        dialogs.push(dialog.message());
        void dialog.dismiss();
      });
      results.watch(page, "app-content", [/Refused to (execute|load)/, /Content Security Policy/]);
      // Sign in and sign up versions of the method page, and the Opening page.
      await page.goto(authorize());
      await hostedTitle(page);
      await look(page, "sign-in page", hostile.title);
      await shot(env, page, "security-app-content-01-signin");
      await page.goto(authorize("&intent=signup"));
      await hostedTitle(page);
      await look(page, "sign-up page", hostile.signup_title);
      await page.goto(authorize("&method=google"));
      const opening = page.locator('[data-opening="google"]:not([data-step-leaving] *)');
      await opening.waitFor({ timeout: 30_000 }).catch(() => undefined);
      const openingText = await opening.innerText().catch(() => "");
      const openingDamage = await damage(page);
      seen.push({ page: "Opening page", ...openingDamage, shows: openingText.includes("<svg onload") });
      await page.waitForURL(url => url.href.startsWith(env.oidc), { timeout: 15_000 }).catch(() => undefined);
      // A new Carbon walks the whole sign-in from the app's own link (its state and PKCE): code, sign-up details, the
      // app's flow page, the review, back at the app.
      await startAtApp(env, page, APP);
      const email = randomEmail("appcontent");
      const code = await signInWithCode(env, page, { email });
      remember(ctx, "code", code);
      const create = page.getByRole("button", { name: /^(Create account|Finish setup)$/ });
      await create.waitFor({ timeout: 30_000 });
      await look(page, "sign-up details page", null);
      await create.click();
      const walk = await completeDetails(env, page, APP, { stopAtReview: true, shotName: "security-app-content-02" });
      const flowPage = walk.pages[0];
      seen.push({ page: "the app's flow page", pwned: null, injected: 0, violations: [], shows: !!flowPage && flowPage.title.includes("<marquee") && flowPage.continueLabel === "<b>go</b>" });
      await look(page, "review page", null);
      await page.getByRole("button", { name: "Share and continue", exact: true }).click();
      await page.waitForURL(appUrl(env, APP), { timeout: 30_000 }).catch(() => undefined);
      await look(page, "back at the app", null);
      // The embed on the app's own page.
      const embedPage = await context.newPage();
      await embedPage.goto(`${env.site}/embed/v1/buttons?app_id=${APP}&redirect_uri=${encodeURIComponent(callback)}&state=e-${tag()}`);
      await look(embedPage, "embed", null);
      const ran = seen.filter(entry => entry.pwned !== null || entry.injected !== 0 || entry.violations.length);
      const notText = seen.filter(entry => !entry.shows);
      results.check(`no hosted page ran or parsed the app's hostile content (${seen.length} pages: sign-in, sign-up, Opening, sign-up details, the flow page, review, the embed): nothing executed, no element made from it, no CSP report, no dialog`, ran.length === 0 && dialogs.length === 0, ran.map(entry => `${entry.page}: pwned=${String(entry.pwned)} injected=${entry.injected} violations=${entry.violations.join(",")}`).join(" | ") || `${dialogs.length} dialogs`);
      results.check("…and the app's words are shown as typed (the titles with their angle brackets; the continue button reads \"<b>go</b>\")", notText.length === 0, notText.map(entry => entry.page).join(", ") || `flow page title "${flowPage?.title.slice(0, 60)}", continue "${flowPage?.continueLabel}"`);
      const logoImage = await page.evaluate(() => [...document.querySelectorAll("img")].filter(image => image.src.startsWith("data:image/svg+xml")).length).catch(() => 0);
      results.check("(note) an SVG logo is only ever drawn as an image (no inline SVG made from it)", true, `${logoImage} data:image/svg+xml <img> on the last page`);
      await shot(env, page, "security-app-content-03-done");
    } finally {
      const restoreCopy: Record<string, string | null> = {};
      for (const key of Object.keys(hostile)) restoreCopy[key] = before.copy?.[key] ?? null;
      const restored = await patch({ copy: restoreCopy, flow: before.flow ?? null, branding: { logo_url: before.branding?.logo_url ?? null } });
      if (restored.status !== 200) results.check(`${APP}'s sign-in setup is put back`, false, `${brief(restored)} ${JSON.stringify(errorOf(restored).details ?? {}).slice(0, 200)}`);
      await context.close();
    }
  },
};
