import type { Page } from "@playwright/test";
import type { Ctx, Journey } from "../context";
import { codeFor, finishSignup, lastSeq, newContext, shot, sleep, tag } from "../lib";

/** "Powered by Silicon Accounts" is in the viewport and links to account.teamofsilicons.com. */
async function poweredBy(ctx: Ctx, page: Page, label: string): Promise<void> {
  const link = page.getByRole("link", { name: /Silicon Accounts/ }).last();
  const href = (await link.getAttribute("href").catch(() => null)) ?? "";
  const box = await link.boundingBox().catch(() => null);
  const viewport = page.viewportSize() ?? { width: 0, height: 0 };
  const inView = !!box && box.y >= 0 && box.y + box.height <= viewport.height && box.x >= 0 && box.x + box.width <= viewport.width;
  const line = (await link.evaluate(element => element.parentElement?.textContent ?? "").catch(() => "")).replace(/\s+/g, " ");
  ctx.results.check(`${label}: "Powered by Silicon Accounts" is in view and links to account.teamofsilicons.com`, inView && /account\.teamofsilicons\.com/.test(href) && /Powered by/.test(line), `${href} ${JSON.stringify(box)}`);
}

export const journey: Journey = {
  name: "h-branding",
  title: "branded hosted pages (acme-notes split and dark, pixel-studio minimal and sharp) at 1440 and 390 px; the embed iframe and the SDK snippet in the apps' own pages",
  async run(ctx) {
    const { env, results, browser } = ctx;
    for (const [width, height] of [[1440, 900], [390, 844]] as const) {
      // acme-notes: split layout, forced dark theme, gold primary, Fraunces headings.
      {
        const context = await newContext(browser, { width, height });
        const page = await context.newPage();
        results.watch(page, `h-acme-${width}`);
        await page.goto(`${env.apps}/acme-notes/`);
        await page.locator("#signin-hosted").click();
        const proceed = page.getByRole("button", { name: "Continue", exact: true });
        await proceed.waitFor({ timeout: 30_000 });
        await sleep(900);
        await shot(env, page, `h-acme-${width}`);
        const fill = await proceed.evaluate(element => getComputedStyle(element).backgroundColor);
        results.check(`acme-notes ${width}: its gold primary fills Continue`, fill === "rgb(232, 176, 75)", fill);
        const heading = await page.getByRole("heading").first().evaluate(element => getComputedStyle(element).fontFamily);
        results.check(`acme-notes ${width}: headings use its font (Fraunces)`, /Fraunces/.test(heading), heading);
        await poweredBy(ctx, page, `acme-notes ${width}`);
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
        await poweredBy(ctx, page, `pixel-studio ${width}`);
        await context.close();
      }
    }

    // quill-docs: the SDK snippet renders the buttons and signs in end to end (state and PKCE kept in the browser).
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
    const field = page.getByRole("textbox", { name: "Email" });
    await field.waitFor({ timeout: 30_000 });
    const after = await lastSeq(env);
    await field.fill(email);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    const code = await codeFor(env, email, after);
    await page.getByRole("group", { name: /Code from the email/ }).waitFor({ timeout: 15_000 });
    await page.keyboard.type(code, { delay: 30 });
    await finishSignup(env, page, "quill-docs");
    await page.waitForURL(/signed-in|\/quill-docs\/(\?|$)/, { timeout: 30_000 }).catch(() => undefined);
    await page.waitForLoadState("networkidle").catch(() => undefined);
    const signedIn = await page.locator("#signed-in-as").innerText().catch(() => "");
    results.check("quill-docs: the SDK sign-in finished (the app exchanged the code with the browser's PKCE verifier)", /Signed in as/.test(signedIn), signedIn);
    const verified = await page.locator("#id-token-status").getAttribute("data-verified").catch(() => null);
    results.check("quill-docs: the id_token verified against the JWKS (issuer, audience, nonce)", verified === "true", String(verified));
    await context.close();

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
