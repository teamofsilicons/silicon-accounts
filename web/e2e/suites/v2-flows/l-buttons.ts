/**
 * The embed's and the SDK's Sign in / Sign up buttons (UNDERSTANDING.md "Adding sign-in to an app": an app can drop in
 * our iframe or a snippet that renders the buttons it configured, and "can just have a Sign in and a Sign up button,
 * and we show everything else on our pages accordingly"; build spec 06-v2.md §5: intent on the embed/SDK
 * (`data-intent`, `renderButtons({intent})`, `signIn({intent})`) and Sign in / Sign up buttons instead of method
 * buttons).
 *
 *   embed (pixel-studio's iframe): buttons=intents → "Sign in" and "Sign up" (+ Powered by), intent=signup keeps only
 *        Sign up, method buttons with intent=signup open the sign-up version; a whole sign-up through its Sign up
 *   SDK (quill-docs' page): renderButtons({buttons: "intents"}), data-buttons="intents" with data-intent, mountFrame,
 *        authorizeUrl({intent}); a whole sign-up through its Sign up
 */
import type { Page } from "@playwright/test";
import type { Journey } from "../../context";
import { POWERED_BY_HREF, hostedTitle, newContext, shot, signInWithCode } from "../../lib";
import { backAtApp, button, freshEmail, settle, waitForDetailsPage, waitForFlow } from "./_helpers";

/** Points pixel-studio's iframe at the embed with extra query parameters and waits for its buttons. */
async function embedWith(page: Page, extra: Record<string, string>): Promise<void> {
  await page.evaluate(params => {
    const frame = document.getElementById("signin-iframe") as HTMLIFrameElement;
    const url = new URL(frame.src);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    frame.src = url.href;
  }, extra);
  // The frame has navigated once its address carries every parameter; then wait for its buttons.
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const frame = page.frames().find(candidate => {
      try {
        const url = new URL(candidate.url());
        return url.pathname === "/embed/v1/buttons" && Object.entries(extra).every(([key, value]) => url.searchParams.get(key) === value);
      } catch {
        return false;
      }
    });
    if (frame && (await frame.locator("main[data-ready]").count().catch(() => 0)) > 0) return;
    await page.waitForTimeout(100);
  }
  throw new Error(`the embed never showed its buttons with ${JSON.stringify(extra)}`);
}

/** The embed's links: their words and their /authorize query. */
async function embedLinks(page: Page): Promise<Array<{ text: string; intent: string | null; method: string | null; state: boolean; challenge: boolean; variant: string | null }>> {
  return page.frameLocator("#signin-iframe").locator("a[href^='/authorize']").evaluateAll(links =>
    links.map(link => {
      const url = new URL(link.getAttribute("href") ?? "", location.href);
      return { text: (link.textContent ?? "").trim(), intent: url.searchParams.get("intent"), method: url.searchParams.get("method"), state: url.searchParams.has("state"), challenge: url.searchParams.has("code_challenge"), variant: link.getAttribute("data-variant") };
    }),
  );
}

export const journey: Journey = {
  name: "v2-flows-buttons",
  title: "the embed's and the SDK's Sign in / Sign up buttons: buttons=intents, intent=signup, data-buttons/data-intent, renderButtons, mountFrame, authorizeUrl; each opens our sign-in or sign-up page, Powered by kept; a whole sign-up through each Sign up button",
  async run(ctx) {
    const { env, results, browser } = ctx;

    // The embed, in pixel-studio's iframe.
    {
      const context = await newContext(browser);
      const page = await context.newPage();
      results.watch(page, "buttons-embed");
      await page.goto(`${env.apps}/pixel-studio/?only=iframe`);
      await page.frameLocator("#signin-iframe").locator("main[data-ready]").waitFor({ timeout: 20_000 });
      await embedWith(page, { buttons: "intents" });
      const frame = page.frameLocator("#signin-iframe");
      let links = await embedLinks(page);
      results.check("embed buttons=intents: \"Sign in\" (primary) and \"Sign up\", in a group named after the app", JSON.stringify(links.map(link => `${link.text}:${link.variant}`)) === JSON.stringify(["Sign in:primary", "Sign up:secondary"]) && (await frame.getByRole("group", { name: "Pixel Studio", exact: true }).count()) === 1, JSON.stringify(links));
      results.check("…Sign in opens the sign-in page (no intent, no method), Sign up the sign-up page (intent=signup), both with the app's state and PKCE", links[0]?.intent === null && links[0].method === null && links[1]?.intent === "signup" && links[1].method === null && links.every(link => link.state && link.challenge), JSON.stringify(links));
      const powered = frame.locator("[data-powered-by] a");
      results.check("…and keeps \"Powered by Silicon Accounts\"", (await powered.getAttribute("href")) === POWERED_BY_HREF && /Powered by Silicon Accounts/.test((await frame.locator("[data-powered-by]").innerText()).replace(/\s+/g, " ")), String(await powered.getAttribute("href")));
      await shot(env, page, "v2f-l-01-embed-intents");
      await embedWith(page, { buttons: "intents", intent: "signup" });
      links = await embedLinks(page);
      results.check("embed buttons=intents&intent=signup: only \"Sign up\"", JSON.stringify(links.map(link => link.text)) === JSON.stringify(["Sign up"]), JSON.stringify(links));
      await embedWith(page, { buttons: "methods", intent: "signup" });
      links = await embedLinks(page);
      results.check("embed method buttons with intent=signup: each opens the sign-up version (intent=signup, its method), in a group \"Sign up for Pixel Studio\"", links.length === 3 && links.every(link => link.intent === "signup" && !!link.method) && (await frame.getByRole("group", { name: "Sign up for Pixel Studio", exact: true }).count()) === 1, JSON.stringify(links));
      await frame.getByRole("link", { name: "Continue with email" }).click();
      await page.waitForURL(url => url.pathname.startsWith("/authorize"), { timeout: 30_000 });
      const viaMethod = await waitForFlow(page, f => f.step === "choose_method", "pixel-studio's sign-up page");
      results.check("…Continue with email there: our sign-up page, on the email field", viaMethod.intent === "signup" && viaMethod.method_hint === "email" && (await hostedTitle(page)) === "Create your Pixel Studio account", `${viaMethod.intent} ${viaMethod.method_hint} ${await hostedTitle(page)}`);

      // A whole sign-up through the embed's Sign up button.
      await page.goto(`${env.apps}/pixel-studio/?only=iframe`);
      await page.frameLocator("#signin-iframe").locator("main[data-ready]").waitFor({ timeout: 20_000 });
      await embedWith(page, { buttons: "intents" });
      await frame.getByRole("link", { name: "Sign up", exact: true }).click();
      await page.waitForURL(url => url.pathname.startsWith("/authorize"), { timeout: 30_000 });
      const flow = await waitForFlow(page, f => f.step === "choose_method", "pixel-studio's sign-up page");
      results.check("the embed's Sign up takes the whole window to \"Create your Pixel Studio account\" with every method", flow.intent === "signup" && flow.method_hint === null && (await hostedTitle(page)) === "Create your Pixel Studio account" && (await page.getByRole("button", { name: "Continue with Google", exact: true }).count()) === 1, `${flow.intent} ${flow.method_hint} ${await hostedTitle(page)}`);
      const email = freshEmail("embed-signup");
      await signInWithCode(env, page, { email });
      await page.getByRole("button", { name: "Create account" }).click({ timeout: 25_000 });
      await waitForDetailsPage(page);
      await button(page, "Share and continue").click();
      const outcome = await backAtApp(env, page, "pixel-studio");
      results.check("…and the sign-up ends signed in at pixel-studio (its own state, exchanged by its server)", outcome.account?.email === email, JSON.stringify(outcome.account).slice(0, 200));
      await context.close();
    }

    // The SDK, on quill-docs' page.
    {
      const context = await newContext(browser);
      const page = await context.newPage();
      results.watch(page, "buttons-sdk");
      await page.goto(`${env.apps}/quill-docs/?only=sdk`);
      await page.locator("#silicon-accounts").getByRole("button").first().waitFor({ timeout: 20_000 });
      const sdk = await page.evaluate(() => {
        const api = (window as unknown as { SiliconAccounts: { authorizeUrl: (options: Record<string, unknown>) => string } }).SiliconAccounts;
        let bogus = "";
        try {
          api.authorizeUrl({ intent: "bogus" });
        } catch (error) {
          bogus = String(error instanceof Error ? error.message : error);
        }
        return { signup: api.authorizeUrl({ intent: "signup" }), signin: api.authorizeUrl({ intent: "signin" }), bogus };
      });
      results.check("SDK authorizeUrl({intent: signup}) asks intent=signup; ({intent: signin}) leaves it out (the default)", new URL(sdk.signup).searchParams.get("intent") === "signup" && !new URL(sdk.signin).searchParams.has("intent"), `${sdk.signup.slice(-80)} | ${sdk.signin.slice(-80)}`);
      results.check("…and an unknown intent is refused with a precise error", /intent must be signin or signup/.test(sdk.bogus), sdk.bogus);

      // renderButtons({buttons: "intents"}) and mountFrame({buttons: "intents"}).
      await page.evaluate(() => {
        for (const id of ["v2f-intents", "v2f-signin-only", "v2f-frame"]) {
          const holder = document.createElement("div");
          holder.id = id;
          document.body.append(holder);
        }
        const api = (window as unknown as { SiliconAccounts: { renderButtons: (target: string, options: Record<string, unknown>) => Promise<unknown>; mountFrame: (target: string, options: Record<string, unknown>) => Promise<unknown> } }).SiliconAccounts;
        void api.renderButtons("#v2f-intents", { buttons: "intents" });
        void api.renderButtons("#v2f-signin-only", { buttons: "intents", intent: "signin" });
        void api.mountFrame("#v2f-frame", { buttons: "intents" });
      });
      const intents = page.locator("#v2f-intents");
      await intents.getByRole("button", { name: "Sign up", exact: true }).waitFor({ timeout: 20_000 });
      const labels = (await intents.getByRole("button").allInnerTexts()).map(text => text.trim());
      results.check("SDK renderButtons({buttons: \"intents\"}): \"Sign in\" and \"Sign up\"", JSON.stringify(labels) === JSON.stringify(["Sign in", "Sign up"]), JSON.stringify(labels));
      const sdkPowered = intents.locator("[data-powered-by] a");
      results.check("…with \"Powered by Silicon Accounts\" linking to accounts.teamofsilicons.com", (await sdkPowered.getAttribute("href")) === POWERED_BY_HREF, String(await sdkPowered.getAttribute("href")));
      const signinOnly = (await page.locator("#v2f-signin-only").getByRole("button").allInnerTexts()).map(text => text.trim());
      results.check("…renderButtons({buttons: \"intents\", intent: \"signin\"}) keeps only \"Sign in\"", JSON.stringify(signinOnly) === JSON.stringify(["Sign in"]), JSON.stringify(signinOnly));
      const mounted = page.locator("#v2f-frame iframe");
      await mounted.waitFor({ timeout: 20_000 });
      const mountedSrc = new URL((await mounted.getAttribute("src")) ?? "", env.site);
      await page.frameLocator("#v2f-frame iframe").getByRole("link", { name: "Sign up", exact: true }).waitFor({ timeout: 20_000 });
      results.check("SDK mountFrame({buttons: \"intents\"}): the embed with buttons=intents, drawing Sign in and Sign up", mountedSrc.pathname === "/embed/v1/buttons" && mountedSrc.searchParams.get("buttons") === "intents" && (await page.frameLocator("#v2f-frame iframe").getByRole("link", { name: "Sign in", exact: true }).count()) === 1, mountedSrc.href.slice(0, 200));

      // A script tag with data-buttons="intents" and data-intent="signup".
      await page.evaluate(site => {
        const holder = document.createElement("div");
        holder.id = "v2f-tag";
        document.body.append(holder);
        const original = document.querySelector('script[src$="/sdk/v1.js"]');
        const script = document.createElement("script");
        for (const attribute of [...(original?.attributes ?? [])]) if (attribute.name.startsWith("data-")) script.setAttribute(attribute.name, attribute.value);
        script.setAttribute("data-target", "#v2f-tag");
        script.setAttribute("data-buttons", "intents");
        script.setAttribute("data-intent", "signup");
        script.src = `${site}/sdk/v1.js?v2f=intents`;
        document.body.append(script);
      }, env.site);
      await page.locator("#v2f-tag").getByRole("button").first().waitFor({ timeout: 20_000 });
      const tagLabels = (await page.locator("#v2f-tag").getByRole("button").allInnerTexts()).map(text => text.trim());
      results.check("a script tag with data-buttons=\"intents\" data-intent=\"signup\" renders only \"Sign up\"", JSON.stringify(tagLabels) === JSON.stringify(["Sign up"]), JSON.stringify(tagLabels));
      await settle(page);
      await shot(env, page, "v2f-l-02-sdk-intents", true);

      // A whole sign-up through renderButtons' Sign up.
      const navigated = page.waitForRequest(request => request.isNavigationRequest() && request.url().startsWith(`${env.site}/authorize`), { timeout: 30_000 });
      await intents.getByRole("button", { name: "Sign up", exact: true }).click();
      const url = new URL((await navigated).url());
      results.check("the SDK's Sign up goes to /authorize with intent=signup, no method, the app's state", url.searchParams.get("intent") === "signup" && !url.searchParams.has("method") && url.searchParams.has("state"), url.search.slice(0, 200));
      const flow = await waitForFlow(page, f => f.step === "choose_method", "quill-docs' sign-up page");
      results.check("…our sign-up page: \"Create your Quill Docs account\" with every method", flow.intent === "signup" && (await hostedTitle(page)) === "Create your Quill Docs account" && (await page.getByRole("button", { name: "Continue with Google", exact: true }).count()) === 1, `${flow.intent} ${await hostedTitle(page)}`);
      const email = freshEmail("sdk-signup");
      await signInWithCode(env, page, { email });
      await page.getByRole("button", { name: "Create account" }).click({ timeout: 25_000 });
      await waitForDetailsPage(page);
      await button(page, "Share and continue").click();
      const outcome = await backAtApp(env, page, "quill-docs");
      results.check("…and the sign-up ends signed in at quill-docs", !!outcome.account?.uuid, JSON.stringify(outcome.account).slice(0, 200));
      await context.close();
    }
  },
};
