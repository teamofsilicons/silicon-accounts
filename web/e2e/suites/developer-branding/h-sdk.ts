/**
 * The SDK snippet of quill-docs (its owner copies it from the Embed tab, where the live preview runs the real SDK):
 * pasted into a page whose own CSS tries to hide or restyle every button and link, it renders the app's buttons in an
 * open Shadow DOM (nothing in the light DOM, nothing of the page's CSS inside), in the app's colours, with "Powered
 * by"; a click creates the state and PKCE and the sign-in completes at the app's callback. On the SDK's own
 * handleCallback: the code comes back with its verifier and nonce, the app exchanges it and the id_token carries that
 * nonce, and a callback works once. Misconfigured snippets say what is wrong inside the box, still with "Powered by".
 */
import type { Page } from "@playwright/test";
import type { Journey } from "../../context";
import { codeFor, json, lastSeq, newContext, shot, sleep, tag } from "../../lib";
import { appBasic, checkPoweredBy, freshEmail, hostPage, htmlPage, ownerSignIn, sameColour } from "./_helpers";

const APP = "quill-docs";

/** Page CSS that would hide or restyle the buttons if it could reach them. */
const HOSTILE_CSS = `<style>
  button, a, p, span, svg { display: none !important; visibility: hidden !important; }
  * { color: rgb(255, 0, 0) !important; font-family: "Comic Sans MS", cursive !important; letter-spacing: 6px !important; }
  body { background: #FFFFFF; }
</style>`;

interface ShadowFacts {
  open: boolean;
  methods: string[];
  lightDomButtons: number;
  visible: boolean[];
  primary: { background: string; color: string; font: string } | null;
}

function shadowFacts(page: Page): Promise<ShadowFacts> {
  return page.evaluate(() => {
    const host = document.querySelector("#silicon-accounts");
    const root = host?.shadowRoot ?? null;
    const buttons = root ? [...root.querySelectorAll<HTMLElement>("button[data-method]")] : [];
    const primary = buttons.find(button => button.classList.contains("p")) ?? null;
    return {
      open: !!root,
      methods: buttons.map(button => button.getAttribute("data-method") ?? ""),
      lightDomButtons: host ? host.querySelectorAll("button, a").length : -1,
      visible: buttons.map(button => {
        const style = getComputedStyle(button);
        const box = button.getBoundingClientRect();
        return style.display !== "none" && style.visibility === "visible" && box.width > 0 && box.height > 0;
      }),
      primary: primary ? { background: getComputedStyle(primary).backgroundColor, color: getComputedStyle(primary).color, font: getComputedStyle(primary).fontFamily } : null,
    };
  });
}

export const journey: Journey = {
  name: "developer-branding-sdk",
  title: "SDK snippet from the Embed tab: open Shadow DOM buttons in the app's order and colours that hostile page CSS cannot reach, Powered by, SDK-made state + PKCE, a sign-in completed at the app; handleCallback (verifier, nonce, once only); clear errors for bad snippets",
  timeoutMs: 6 * 60_000,
  async run(ctx) {
    const { env, results } = ctx;
    const t = tag();
    const publicConfig = (await json<{ methods: string[]; branding: { light: { primary: string; primary_foreground: string }; dark: { primary: string; primary_foreground: string }; font_family: string } }>(`${env.site}/v1/apps/${APP}/public`)).body;

    // The owner's Embed tab: the SDK snippet, and a live preview made by the real SDK.
    const owner = await ownerSignIn(ctx, APP, "dvb-h-owner");
    const { page } = owner;
    await page.goto(`${env.site}/developer/${APP}/embed`);
    await page.getByRole("tab", { name: "SDK" }).click();
    const block = page.getByRole("region", { name: "SDK source code" }).locator("pre");
    await block.waitFor({ timeout: 20_000 });
    const snippet = (await block.textContent()) ?? "";
    const redirect = `${env.apps}/${APP}/callback`;
    results.check("the Embed tab's SDK snippet loads this site's /sdk/v1.js with the app id, its redirect URI, the target and PKCE", snippet.includes(`src="${env.site}/sdk/v1.js"`) && snippet.includes(`data-app-id="${APP}"`) && snippet.includes(`data-redirect-uri="${redirect}"`) && snippet.includes('data-target="#silicon-accounts"') && snippet.includes('data-pkce="S256"'), snippet.replace(/\s+/g, " ").slice(0, 260));
    const preview = await page.waitForFunction(() => {
      const host = document.querySelector("[data-preview-host] > div");
      return host?.shadowRoot?.querySelectorAll("button[data-method]").length ?? 0;
    }, undefined, { timeout: 20_000 }).then(handle => handle.jsonValue()).catch(() => 0);
    results.check("the Embed tab's live preview is the real SDK rendering the app's buttons in a shadow root", preview === publicConfig.methods.length, `${preview} buttons for ${publicConfig.methods.join(",")}`);
    await owner.context.close();

    // The snippet on a page whose CSS hides every button and link and paints everything red in Comic Sans.
    const context = await newContext(ctx.browser);
    const hostUrl = `${new URL(env.apps).origin}/__dvb/sdk-${t}.html`;
    await hostPage(context, hostUrl, htmlPage("An app with loud CSS", `<h1>Sign in to continue</h1>${snippet}<script>document.addEventListener("silicon-accounts:ready", () => { window.__dvbReady = performance.now(); });</script>`, HOSTILE_CSS));
    const visitor = await context.newPage();
    results.watch(visitor, "dvb-h-sdk");
    const loadStarted = Date.now();
    await visitor.goto(hostUrl);
    await visitor.waitForFunction(() => (document.querySelector("#silicon-accounts")?.shadowRoot?.querySelectorAll("button[data-method]").length ?? 0) > 0, undefined, { timeout: 20_000 }).catch(() => undefined);
    results.metric("SDK snippet: page load → buttons rendered", Date.now() - loadStarted);
    await sleep(500);
    const facts = await shadowFacts(visitor);
    results.check("the buttons live in an open shadow root, none in the page's own DOM", facts.open && facts.methods.length > 0 && facts.lightDomButtons === 0, JSON.stringify({ open: facts.open, light: facts.lightDomButtons }));
    results.check("they are the app's methods, in its order", JSON.stringify(facts.methods) === JSON.stringify(publicConfig.methods), `${facts.methods.join(",")} vs ${publicConfig.methods.join(",")}`);
    results.check("the page's CSS cannot hide them (every button displayed, visible, with a box)", facts.visible.length > 0 && facts.visible.every(Boolean), JSON.stringify(facts.visible));
    results.check("the page's CSS cannot restyle them: the main button keeps the app's primary and text colours, not red Comic Sans", !!facts.primary && sameColour(facts.primary.background, publicConfig.branding.light.primary) && sameColour(facts.primary.color, publicConfig.branding.light.primary_foreground) && !/Comic Sans/.test(facts.primary.font), JSON.stringify(facts.primary));
    results.check("the SDK announced itself (silicon-accounts:ready)", (await visitor.evaluate(() => typeof (window as unknown as { __dvbReady?: number }).__dvbReady === "number")) && (await visitor.evaluate(() => typeof (window as unknown as { SiliconAccounts?: unknown }).SiliconAccounts === "object")));
    await checkPoweredBy(ctx, visitor, "the SDK buttons", { shadowHost: "#silicon-accounts" });
    await shot(env, visitor, "dvb-h-01-sdk-hostile-css");

    // renderButtons from JavaScript with theme "dark": the app's dark palette, in a shadow root of its own.
    const dark = await visitor.evaluate(async ({ appId, redirectUri }) => {
      const box = document.createElement("div");
      box.id = "dvb-dark";
      document.body.append(box);
      const sdk = (window as unknown as { SiliconAccounts: { renderButtons: (target: Element, options: Record<string, unknown>) => Promise<unknown> } }).SiliconAccounts;
      await sdk.renderButtons(box, { appId, redirectUri, theme: "dark" });
      const primary = box.shadowRoot?.querySelector<HTMLElement>("button.p");
      return { theme: box.shadowRoot?.querySelector<HTMLElement>(".sa")?.dataset.theme ?? null, background: primary ? getComputedStyle(primary).backgroundColor : null, color: primary ? getComputedStyle(primary).color : null };
    }, { appId: APP, redirectUri: redirect });
    results.check("renderButtons with theme \"dark\" paints the app's dark palette", dark.theme === "dark" && sameColour(dark.background, publicConfig.branding.dark.primary) && sameColour(dark.color, publicConfig.branding.dark.primary_foreground), JSON.stringify(dark));

    // A click: the SDK makes the state and PKCE pair, keeps them for the callback, and the sign-in completes.
    await visitor.locator("#silicon-accounts button[data-method='email']").click();
    await visitor.waitForURL(url => url.href.startsWith(`${env.site}/authorize`), { timeout: 20_000 });
    const authorize = new URL(visitor.url());
    const params = authorize.searchParams;
    results.check("the click goes to /authorize with the SDK's own state and S256 challenge, the redirect URI and method=email", params.get("app_id") === APP && params.get("redirect_uri") === redirect && (params.get("state") ?? "").length >= 32 && /^[A-Za-z0-9_-]{43}$/.test(params.get("code_challenge") ?? "") && params.get("code_challenge_method") === "S256" && params.get("method") === "email", authorize.search.slice(0, 260));
    const email = freshEmail("sdk");
    const field = visitor.getByRole("textbox", { name: "Email" });
    await field.waitFor({ timeout: 30_000 });
    const after = await lastSeq(env);
    await field.fill(email);
    await visitor.getByRole("button", { name: "Continue", exact: true }).click();
    const code = await codeFor(env, email, after);
    await visitor.getByRole("group", { name: /Code from the email/ }).waitFor({ timeout: 15_000 });
    await visitor.keyboard.type(code, { delay: 25 });
    await visitor.getByRole("button", { name: "Create account", exact: true }).click({ timeout: 30_000 });
    const share = visitor.getByRole("button", { name: "Share and continue", exact: true });
    const callback = visitor.waitForURL(url => url.href.startsWith(redirect), { timeout: 30_000 }).then(() => "callback" as const);
    if ((await Promise.race([callback, share.waitFor({ timeout: 30_000 }).then(() => "consent" as const)])) === "consent") await share.click();
    await visitor.locator("#signed-in-as").waitFor({ timeout: 30_000 }).catch(() => undefined);
    const signedIn = (await visitor.locator("#signed-in-as").innerText().catch(() => "")).replace(/\s+/g, " ");
    results.check("back at quill-docs, the app finished the sign-in with the verifier the SDK kept in this tab", /Signed in as c:/.test(signedIn), `${visitor.url().slice(0, 100)} ${signedIn.slice(0, 100)}`);
    await shot(env, visitor, "dvb-h-02-signed-in");

    // handleCallback on the app's callback page: the code with its verifier and nonce, once only.
    const handlerPage = htmlPage("Callback", `<pre id="out">waiting</pre><script src="${env.site}/sdk/v1.js"></script><script>
      const out = {};
      try { out.first = SiliconAccounts.handleCallback(); } catch (error) { out.firstError = error.code || String(error); }
      try { SiliconAccounts.handleCallback(); out.second = "accepted again"; } catch (error) { out.second = error.code || String(error); }
      document.getElementById("out").textContent = JSON.stringify(out);
    </script>`);
    await context.route(url => url.href.startsWith(`${redirect}?`), route => route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: handlerPage }));
    const starter = `${new URL(env.apps).origin}/__dvb/sdk-api-${t}.html`;
    await hostPage(context, starter, htmlPage("Start", `<button id="go">Sign in</button><script src="${env.site}/sdk/v1.js"></script><script>
      document.getElementById("go").addEventListener("click", () => SiliconAccounts.signIn({ appId: "${APP}", redirectUri: "${redirect}", pkce: "S256", scope: "openid", method: "email" }));
    </script>`));
    await visitor.goto(starter);
    await visitor.locator("#go").click();
    await visitor.waitForURL(url => url.href.startsWith(`${env.site}/authorize`), { timeout: 20_000 });
    const second = new URL(visitor.url()).searchParams;
    const continueAs = visitor.getByRole("button", { name: /^Continue as/ });
    await continueAs.click({ timeout: 30_000 });
    const share2 = visitor.getByRole("button", { name: "Share and continue", exact: true });
    const back = visitor.waitForURL(url => url.href.startsWith(redirect), { timeout: 30_000 }).then(() => "callback" as const);
    if ((await Promise.race([back, share2.waitFor({ timeout: 30_000 }).then(() => "consent" as const)])) === "consent") await share2.click();
    await visitor.waitForURL(url => url.href.startsWith(redirect), { timeout: 30_000 });
    await visitor.waitForFunction(() => document.getElementById("out")?.textContent !== "waiting", undefined, { timeout: 15_000 }).catch(() => undefined);
    const handled = JSON.parse((await visitor.locator("#out").textContent()) ?? "{}") as { first?: { code: string; state: string; codeVerifier: string | null; nonce: string | null; redirectUri: string | null; appId: string | null }; firstError?: string; second?: string };
    const first = handled.first;
    results.check("handleCallback returns the code, the state the SDK made, its PKCE verifier and the OpenID nonce it sent", !!first && first.state === second.get("state") && !!first.codeVerifier && first.nonce === second.get("nonce") && first.redirectUri === redirect && first.appId === APP, JSON.stringify(handled).slice(0, 300));
    results.check("a callback works once: the second handleCallback says unknown_state", handled.second === "unknown_state", String(handled.second));
    if (first) {
      const exchange = await json<{ access_token?: string; id_token?: string; error?: string }>(`${env.site}/v1/oauth/token`, {
        method: "POST",
        headers: { authorization: appBasic(APP), "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", code: first.code, redirect_uri: redirect, code_verifier: first.codeVerifier ?? "" }).toString(),
      });
      const claims = exchange.body.id_token ? (JSON.parse(Buffer.from(exchange.body.id_token.split(".")[1] ?? "", "base64url").toString()) as { nonce?: string; aud?: string }) : null;
      results.check("the app exchanges that code with that verifier, and the id_token carries the SDK's nonce", exchange.status === 200 && !!exchange.body.access_token && claims?.nonce === first.nonce && claims?.aud === APP, `${exchange.status} ${JSON.stringify(claims)}`);
    }

    // Snippets that cannot work say why inside the box (still with Powered by), and in the console for developers.
    for (const [label, attrs, words] of [
      ["unknown app", `data-app-id="no-such-app-${t}" data-redirect-uri="${redirect}"`, /no-such-app|not found|unknown/i],
      ["method not offered", `data-app-id="${APP}" data-redirect-uri="${redirect}" data-method="phone"`, /does not offer sign-in with "phone"/],
      ["no redirect URI", `data-app-id="${APP}"`, /data-redirect-uri is missing/],
    ] as const) {
      const broken = await context.newPage();
      results.watch(broken, `dvb-h-broken-${label}`, [/Silicon Accounts:/, /status of 404/]);
      const url = `${new URL(env.apps).origin}/__dvb/sdk-broken-${label.replace(/\s+/g, "-")}-${t}.html`;
      await hostPage(context, url, htmlPage("Broken", `<div id="box"></div><script src="${env.site}/sdk/v1.js" ${attrs} data-target="#box" async></script>`));
      await broken.goto(url);
      const message = await broken.waitForFunction(() => document.querySelector("#box")?.shadowRoot?.querySelector("[role='alert']")?.textContent ?? "", undefined, { timeout: 15_000 }).then(handle => handle.jsonValue()).catch(() => "");
      results.check(`a snippet with ${label} shows "not set up correctly" and the reason inside the box`, /not set up correctly/.test(String(message)) && words.test(String(message)), String(message).slice(0, 200));
      await checkPoweredBy(ctx, broken, `the SDK box with ${label}`, { shadowHost: "#box" });
      await broken.close();
    }
    await context.close();
  },
};
