import type { Page } from "@playwright/test";
import type { Ctx, Journey } from "../context";
import { POWERED_BY_HREF, appAccount, completeDetails, finishSignup, hostedTitle, live, newContext, poweredBy, shot, signInWithCode, sleep, startAtApp, tag } from "../lib";

/**
 * "Powered by Silicon Accounts" links to https://accounts.teamofsilicons.com and is in view, or (`foot`: a page taller
 * than the window) shows at the page's foot once scrolled there.
 */
async function poweredByCheck(ctx: Ctx, page: Page, label: string, foot = false): Promise<void> {
  const seen = await poweredBy(page);
  ctx.results.check(`${label}: "Powered by Silicon Accounts" is ${foot ? "at the foot of the page" : "in view"} and links to accounts.teamofsilicons.com`, (foot ? seen.atEnd : seen.inView) && seen.href === POWERED_BY_HREF && /Powered by/.test(seen.text), `${seen.href} ${seen.text} inView=${seen.inView} atEnd=${seen.atEnd}`);
}

const style = (page: Page, selector: string, property: string) => live(page, selector).first().evaluate((element, name) => getComputedStyle(element).getPropertyValue(name), property);

export const journey: Journey = {
  name: "h-branding",
  title: "every page in the app's own style: acme-notes (split, dark, gold, Fraunces) on its sign-in, sign-up, set-up and details pages, pixel-studio (minimal, sharp) through its iframe, at 1440 and 390 px; Sign in and Sign up buttons; the SDK snippet signs in; the embed's framing rules",
  async run(ctx) {
    const { env, results, browser } = ctx;
    for (const [width, height] of [[1440, 900], [390, 844]] as const) {
      // acme-notes: split layout, forced dark theme, gold primary, Fraunces headings; its own sign-in and sign-up titles.
      {
        const context = await newContext(browser, { width, height });
        const page = await context.newPage();
        results.watch(page, `h-acme-${width}`);
        await startAtApp(env, page, "acme-notes");
        const proceed = page.getByRole("button", { name: "Continue", exact: true });
        await proceed.waitFor({ timeout: 30_000 });
        await sleep(900);
        await shot(env, page, `h-acme-${width}`);
        const fill = await proceed.evaluate(element => getComputedStyle(element).backgroundColor);
        results.check(`acme-notes ${width}: its gold primary fills Continue`, fill === "rgb(232, 176, 75)", fill);
        const heading = await style(page, "h1", "font-family");
        results.check(`acme-notes ${width}: headings use its font (Fraunces)`, /Fraunces/.test(heading), heading);
        results.check(`acme-notes ${width}: its own sign-in title`, (await hostedTitle(page)) === "Welcome back to Acme Notes", await hostedTitle(page));
        await poweredByCheck(ctx, page, `acme-notes ${width}`);
        await startAtApp(env, page, "acme-notes", { intent: "signup" });
        await page.getByRole("button", { name: "Continue", exact: true }).waitFor({ timeout: 30_000 });
        await sleep(700);
        await shot(env, page, `h-acme-signup-${width}`);
        results.check(`acme-notes ${width}: its sign-up button opens its sign-up title`, (await hostedTitle(page)) === "Start your Acme notebook", await hostedTitle(page));
        await poweredByCheck(ctx, page, `acme-notes sign-up ${width}`);
        await context.close();
      }
      // pixel-studio: its main integration is the iframe; the hosted page is minimal, sharp, pink outline buttons.
      {
        const context = await newContext(browser, { width, height });
        const page = await context.newPage();
        results.watch(page, `h-pixel-${width}`);
        await page.goto(`${env.apps}/pixel-studio/`);
        const frame = page.frameLocator("#signin-iframe");
        const first = frame.getByRole("link", { name: /Continue with/ }).or(frame.getByRole("button", { name: /Continue with/ })).first();
        await first.waitFor({ timeout: 30_000 });
        await sleep(800);
        await shot(env, page, `h-pixel-app-${width}`);
        const labels = await frame.getByRole("link", { name: /Continue with/ }).or(frame.getByRole("button", { name: /Continue with/ })).allInnerTexts();
        const frameHeight = await page.locator("#signin-iframe").evaluate(element => element.getBoundingClientRect().height);
        results.check(`pixel-studio ${width}: the iframe shows its buttons and sizes itself to them`, labels.length >= 2 && frameHeight > 50 && frameHeight < 400, `${labels.join(" | ")}; ${frameHeight} px`);
        await first.click();
        await page.waitForURL(url => url.href.startsWith(`${env.site}/authorize`), { timeout: 30_000 });
        await page.getByRole("button").first().waitFor({ timeout: 30_000 });
        await sleep(900);
        await shot(env, page, `h-pixel-hosted-${width}`);
        const radius = await page.getByRole("button").first().evaluate(element => getComputedStyle(element).borderRadius);
        results.check(`pixel-studio ${width}: sharp corners`, /^0px/.test(radius), radius);
        await poweredByCheck(ctx, page, `pixel-studio ${width}`);
        await context.close();
      }
    }

    // acme-notes' later pages keep its style too: the code, setting up the account, the details page.
    {
      const context = await newContext(browser);
      const page = await context.newPage();
      results.watch(page, "h-acme-pages");
      const email = `ida.acme.${tag()}@example.test`;
      await startAtApp(env, page, "acme-notes");
      await signInWithCode(env, page, { email });
      const create = page.getByRole("button", { name: "Create account" });
      await create.waitFor({ timeout: 25_000 });
      await sleep(600);
      await shot(env, page, "h-acme-setup");
      results.check("acme-notes: setting up the account uses its heading font and its gold", /Fraunces/.test(await style(page, "h1", "font-family")) && (await create.evaluate(element => getComputedStyle(element).backgroundColor)) === "rgb(232, 176, 75)");
      await poweredByCheck(ctx, page, "acme-notes set-up page", true);
      await create.click();
      const share = page.getByRole("button", { name: "Share and continue", exact: true });
      await share.waitFor({ timeout: 30_000 });
      await sleep(600);
      await shot(env, page, "h-acme-details");
      results.check("acme-notes: the details page uses its heading font and its gold", /Fraunces/.test(await style(page, "h1", "font-family")) && (await share.evaluate(element => getComputedStyle(element).backgroundColor)) === "rgb(232, 176, 75)");
      await poweredByCheck(ctx, page, "acme-notes details page");
      await completeDetails(env, page, "acme-notes");
      results.check("acme-notes received the new account", typeof (await appAccount(page))?.uuid === "string");
      await context.close();
    }

    // quill-docs: the SDK snippet renders the buttons and signs in end to end (state and PKCE kept in the browser).
    {
      const context = await newContext(browser);
      const page = await context.newPage();
      results.watch(page, "h-quill");
      await page.goto(`${env.apps}/quill-docs/`);
      await page.waitForFunction(() => {
        const host = document.querySelector("#silicon-accounts");
        const root = host?.shadowRoot ?? host;
        return !!root && root.querySelectorAll("button, a").length > 0;
      }, undefined, { timeout: 30_000 });
      await shot(env, page, "h-quill-sdk");
      const labels = await page.locator("#silicon-accounts").evaluate(host => [...(host.shadowRoot ?? host).querySelectorAll("button, a")].map(element => element.textContent?.trim() ?? ""));
      results.check("quill-docs: the SDK rendered its configured buttons", labels.some(label => /email/i.test(label)), labels.join(" | "));
      await page.locator("#silicon-accounts").evaluate(host => {
        const root = host.shadowRoot ?? host;
        const target = [...root.querySelectorAll("button, a")].find(element => /email/i.test(element.textContent ?? ""));
        (target as HTMLElement | undefined)?.click();
      });
      await page.waitForURL(url => url.href.startsWith(`${env.site}/authorize`), { timeout: 30_000 });
      const email = `quill.${tag()}@example.test`;
      await signInWithCode(env, page, { email });
      await finishSignup(env, page, "quill-docs");
      await page.waitForURL(/signed-in|\/quill-docs\/(\?|$)/, { timeout: 30_000 }).catch(() => undefined);
      await page.waitForLoadState("networkidle").catch(() => undefined);
      const signedIn = await page.locator("#signed-in-as").innerText().catch(() => "");
      results.check("quill-docs: the SDK sign-in finished (the app exchanged the code with the browser's PKCE verifier)", /Signed in as/.test(signedIn), signedIn);
      const verified = await page.locator("#id-token-status").getAttribute("data-verified").catch(() => null);
      results.check("quill-docs: the id_token verified against the JWKS (issuer, audience, nonce)", verified === "true", String(verified));
      await context.close();
    }

    // "Sign in" and "Sign up" buttons instead of method buttons (the embed's buttons=intents): Sign up opens the sign-up page.
    {
      const context = await newContext(browser);
      const page = await context.newPage();
      results.watch(page, "h-intents");
      await page.goto(`${env.apps}/pixel-studio/`);
      const src = (await page.locator("#signin-iframe").getAttribute("src", { timeout: 30_000 })) ?? "";
      const embed = new URL(src, env.site);
      embed.searchParams.set("buttons", "intents");
      embed.searchParams.delete("method");
      await page.goto(embed.href);
      const signIn = page.locator('a[data-intent="signin"]');
      const signUp = page.locator('a[data-intent="signup"]');
      await signUp.waitFor({ timeout: 30_000 });
      await shot(env, page, "h-embed-intents");
      results.check("the embed's buttons=intents shows \"Sign in\" and \"Sign up\"", (await signIn.innerText()).includes("Sign in") && (await signUp.innerText()).includes("Sign up"), `${await signIn.innerText()} | ${await signUp.innerText()}`);
      const href = new URL((await signUp.getAttribute("href")) ?? "", env.site);
      results.check("…\"Sign up\" asks for intent=signup and passes no email or phone", href.searchParams.get("intent") === "signup" && !href.searchParams.has("login_hint"), href.search.slice(0, 200));
      await signUp.click();
      await page.waitForURL(url => url.href.startsWith(`${env.site}/authorize`), { timeout: 30_000 });
      results.check("…and opens the sign-up version of pixel-studio's page", /^Create your Pixel Studio account$/i.test(await hostedTitle(page)), await hostedTitle(page));
      await context.close();
    }

    // The embed and the SDK as the site serves them.
    const embed = await fetch(`${env.site}/embed/v1/buttons?app_id=pixel-studio`);
    const apps = new URL(env.apps).origin;
    results.check("the embed lets the app's own origin frame it", (embed.headers.get("content-security-policy") ?? "").includes(`frame-ancestors 'self' ${apps}`), embed.headers.get("content-security-policy") ?? "");
    const unknown = await fetch(`${env.site}/embed/v1/buttons?app_id=no-such-app`);
    results.check("the embed of an unknown app may not be framed anywhere", (unknown.headers.get("content-security-policy") ?? "").includes("frame-ancestors 'none'") && unknown.headers.get("x-frame-options") === "DENY");
    const sdk = await fetch(`${env.site}/sdk/v1.js`);
    results.check("/sdk/v1.js is served to any origin", sdk.status === 200 && sdk.headers.get("access-control-allow-origin") === "*", String(sdk.status));
  },
};
