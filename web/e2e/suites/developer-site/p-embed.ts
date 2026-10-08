/**
 * The Embed tab (UNDERSTANDING "Adding sign-in to an app"): Briefcase's owner copies what adds sign-in to the app, and
 * every snippet is used for real. The hosted link with the app's own state and PKCE signs a fresh Carbon in, and the
 * server snippets exchange the code, refresh and read userinfo with the app's secret; the direct buttons open the
 * Opening page (Google) or the empty email field (email); the iframe shows the app's buttons only on an allowed
 * origin, and a click takes the whole window to the hosted pages; the SDK snippet renders "Sign in" and "Sign up" and
 * its "Sign up" opens the sign-up version of the pages. The options (buttons, intent, method, scopes, PKCE) change
 * the snippets; there is never a login hint or an email or phone in them; the live preview runs the real SDK; OIDC
 * discovery is linked and shown.
 */
import { createHash, randomBytes } from "node:crypto";
import type { Locator } from "@playwright/test";
import type { Journey } from "../../context";
import { api, completeDetails, hostedTitle, newContext, POWERED_BY_HREF, shot, signInWithCode, sleep, tag, waitForOpening } from "../../lib";
import { appBasic, appDetail, freshEmail, ownerSignIn, selectOption } from "./_helpers";

const APP = "briefcase";

const b64url = (buffer: Buffer) => buffer.toString("base64url");

/** The text of a code block by its file name (Arc's CodeBlock: a region "<file name> source code" around a <pre>). */
async function codeOf(scope: Locator, filename: string): Promise<string> {
  const pre = scope.getByRole("region", { name: `${filename} source code`, exact: true }).locator("pre").first();
  await pre.waitFor({ timeout: 10_000 });
  return (await pre.innerText()).replace(/\u00a0/g, " ");
}

export const journey: Journey = {
  name: "developer-site-embed",
  title: "the Embed tab, every snippet used for real: the hosted link with PKCE signs a fresh Carbon in and the server snippets exchange, refresh and read userinfo; direct buttons (Opening page, empty email field); the iframe on an allowed origin (and refused elsewhere) sends the whole window to the hosted pages; the SDK's Sign up opens the sign-up pages; options change the snippets; no login hint anywhere; the live preview and OIDC discovery",
  async run(ctx) {
    const { env, results, browser } = ctx;
    const t = tag();
    const config = (await appDetail(ctx, APP)).signin_config;
    const redirectUri = config.redirect_uris[0] ?? "";
    const { context, page } = await ownerSignIn(ctx, APP, { label: "embed", returnTo: `/apps/${APP}/embed` });
    try {
      const panel = page.getByRole("tabpanel", { name: "Embed" });
      await panel.getByRole("tab", { name: "Hosted link" }).waitFor({ timeout: 30_000 });
      await sleep(400);

      // The hosted link as shown, with the app's registered redirect URI and PKCE.
      const link = await codeOf(panel, "Sign-in link");
      const linkHref = (/href="([^"]+)"/.exec(link)?.[1] ?? "").replace(/&amp;/g, "&");
      const linkUrl = new URL(linkHref, env.site);
      results.check("the hosted link points at this stack's /authorize with app_id, the registered redirect URI, a state and PKCE S256", linkUrl.origin === env.site && linkUrl.pathname === "/authorize" && linkUrl.searchParams.get("app_id") === APP && linkUrl.searchParams.get("redirect_uri") === redirectUri && linkUrl.searchParams.get("state") === "STATE" && linkUrl.searchParams.get("code_challenge_method") === "S256" && /Sign in with Silicon Accounts/.test(link), linkHref);
      const tabText = (await panel.innerText()).replace(/\s+/g, " ");
      results.check("no snippet has a login hint, an email or a phone: the Carbon always types it on our pages (and the tab says so)", !/login_hint|data-login-hint/.test(tabText) && /Your app never takes a Carbon's email or phone itself/.test(tabText), "");

      // Options change the snippets.
      await selectOption(panel, page, "Opens", "The sign-up page (intent=signup)");
      await selectOption(panel, page, "Sign-in method", "Google");
      await panel.getByRole("button", { name: "openid (an id_token)" }).click().catch(() => undefined);
      await sleep(300);
      const signupLink = await codeOf(panel, "Sign-in link");
      const signupUrl = new URL((/href="([^"]+)"/.exec(signupLink)?.[1] ?? "").replace(/&amp;/g, "&"), env.site);
      results.check("Opens · sign-up, method Google and the openid scope go into the link (intent=signup, method=google, scope=openid), labelled Sign up", signupUrl.searchParams.get("intent") === "signup" && signupUrl.searchParams.get("method") === "google" && signupUrl.searchParams.get("scope") === "openid" && /Sign up with Silicon Accounts/.test(signupLink), signupUrl.search);
      await panel.getByRole("switch").first().click();
      await sleep(200);
      const noPkce = await codeOf(panel, "Sign-in link");
      results.check("turning PKCE off drops the challenge from the link", !/code_challenge/.test(noPkce), noPkce.slice(0, 200));
      await panel.getByRole("switch").first().click();
      await selectOption(panel, page, "Buttons", "Sign in and Sign up");
      await sleep(200);
      results.check("Buttons · Sign in and Sign up hides the method choice", (await panel.getByRole("combobox", { name: "Sign-in method" }).count()) === 0);
      await panel.getByRole("tab", { name: "Iframe" }).click();
      const iframeCode = await codeOf(panel, "Iframe");
      await panel.getByRole("tab", { name: "SDK" }).click();
      const sdkCode = await codeOf(panel, "SDK");
      results.check("…and the iframe and SDK snippets follow (buttons=intents, data-buttons=\"intents\", data-intent=\"signup\")", /buttons=intents/.test(iframeCode) && /data-buttons="intents"/.test(sdkCode) && /data-intent="signup"/.test(sdkCode) && /data-pkce="S256"/.test(sdkCode) && !/data-method/.test(sdkCode), `${iframeCode.slice(0, 160)} | ${sdkCode.slice(0, 200)}`);
      await shot(env, page, "ds-p-01-embed", true);

      // Direct buttons for the app's own site.
      const direct = await codeOf(panel, "Direct buttons as links");
      const hrefs = [...direct.matchAll(/<a href="([^"]+)">([^<]+)<\/a>/g)].map(match => ({ url: new URL(match[1]!.replace(/&amp;/g, "&"), env.site), label: match[2]! }));
      const labels = hrefs.map(item => item.label);
      const methods = config.method_order.filter(method => config.methods[method as keyof typeof config.methods]);
      results.check("a direct link per method the app turned on, in its order, plus Sign in and Sign up", labels.join("|") === [...methods.map(method => ({ google: "Continue with Google", apple: "Continue with Apple", email: "Continue with email", phone: "Continue with phone number" })[method as "google"]), "Sign in", "Sign up"].join("|") && hrefs.slice(0, methods.length).every((item, index) => item.url.searchParams.get("method") === methods[index]) && hrefs[hrefs.length - 1]?.url.searchParams.get("intent") === "signup", labels.join(" | "));

      // The server snippets name this stack's endpoints and the app.
      await panel.getByRole("tab", { name: "Silicons" }).click();
      const siliconCode = await codeOf(panel, "Short-lived token");
      results.check("the Silicons snippet: silicon-accounts login --app briefcase and the slt grant", /accounts login --app briefcase -q/.test(siliconCode) && /grant_type=urn:silicon:params:oauth:grant-type:slt/.test(siliconCode), siliconCode.slice(0, 160));

      // OIDC discovery.
      const discoveryUrl = await panel.getByText(`${env.site}/.well-known/openid-configuration`).count();
      const discovery = await api<{ issuer?: string; jwks_uri?: string }>(ctx, "/.well-known/openid-configuration");
      await panel.getByRole("tree", { name: "OpenID Connect discovery document" }).or(panel.getByLabel("OpenID Connect discovery document")).first().waitFor({ timeout: 10_000 }).catch(() => undefined);
      results.check("OpenID Connect: the discovery URL, its issuer and jwks_uri, and the document itself", discoveryUrl >= 1 && discovery.status === 200 && (await panel.getByText(discovery.body.jwks_uri ?? "?").count()) >= 1, `${discovery.status} ${discovery.body.issuer} ${discovery.body.jwks_uri}`);

      // The live preview runs the real SDK with the saved setup.
      const host = panel.locator("[data-preview-host]");
      await host.getByRole("button").first().waitFor({ timeout: 15_000 }).catch(() => undefined);
      const previewButtons = (await host.getByRole("button").allInnerTexts()).map(text => text.trim()).filter(Boolean);
      results.check("the live preview shows the SDK's own Sign in / Sign up buttons for this setup", previewButtons.includes("Sign up") || previewButtons.includes("Sign in"), previewButtons.join(" | "));
      const urlBefore = page.url();
      await host.getByRole("button").first().click().catch(() => undefined);
      await sleep(500);
      results.check("…and a click in the preview stays on the developer site", page.url() === urlBefore, page.url());

      // 1. The hosted link, used by an app's own server: state and PKCE of its own, then the code exchange.
      const verifier = b64url(randomBytes(32));
      const challenge = b64url(createHash("sha256").update(verifier).digest());
      const state = `ds-${t}`;
      const real = new URL(linkUrl.href);
      real.searchParams.set("state", state);
      real.searchParams.set("code_challenge", challenge);
      const visitor = await newContext(browser);
      const visitorPage = await visitor.newPage();
      results.watch(visitorPage, "embed-hosted");
      let callback: URL | null = null;
      await visitor.route(url => url.href.startsWith(redirectUri), async route => {
        callback = new URL(route.request().url());
        await route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>callback</title><p>captured</p>" });
      });
      await visitorPage.goto(real.href);
      const email = freshEmail("embed");
      await signInWithCode(env, visitorPage, { email });
      await visitorPage.getByRole("button", { name: "Create account" }).click({ timeout: 25_000 });
      await completeDetails(env, visitorPage, APP, {}).catch(() => undefined);
      await until(() => callback !== null, 15_000);
      const got = callback as URL | null;
      results.check("the hosted link (with the app's own state and PKCE) signs a fresh Carbon in and comes back to the redirect URI with ?code= and the same state", got?.searchParams.get("state") === state && /^sac_/.test(got?.searchParams.get("code") ?? ""), got?.href ?? "never came back");
      const token = await api<{ access_token?: string; refresh_token?: string; membership_id?: string; account?: { uuid?: string; email?: string } }>(ctx, "/v1/oauth/token", { method: "POST", direct: true, headers: { authorization: appBasic(APP), "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code: got?.searchParams.get("code") ?? "", redirect_uri: redirectUri, code_verifier: verifier }).toString() });
      results.check("\"Exchange the code\" works as written (app id and secret, code, redirect_uri, code_verifier): tokens, membership briefcase:<uuid>, the account with its email", token.status === 200 && !!token.body.access_token && /^sar_/.test(token.body.refresh_token ?? "") && token.body.membership_id === `${APP}:${token.body.account?.uuid}` && token.body.account?.email === email, `${token.status} ${JSON.stringify(token.body).slice(0, 200)}`);
      const refreshed = await api<{ access_token?: string; refresh_token?: string }>(ctx, "/v1/oauth/token", { method: "POST", direct: true, headers: { authorization: appBasic(APP), "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: token.body.refresh_token ?? "" }).toString() });
      const userinfo = await api<{ uuid?: string; sub?: string; email?: string }>(ctx, "/v1/userinfo", { direct: true, headers: { authorization: `Bearer ${refreshed.body.access_token ?? ""}` } });
      results.check("…and so do refresh (a rotated refresh token) and userinfo", refreshed.status === 200 && refreshed.body.refresh_token !== token.body.refresh_token && userinfo.status === 200 && (userinfo.body.uuid ?? userinfo.body.sub) === token.body.account?.uuid, `${refreshed.status} ${userinfo.status} ${JSON.stringify(userinfo.body).slice(0, 120)}`);
      await visitor.unroute(url => url.href.startsWith(redirectUri));

      // 2. Direct buttons: Google opens the Opening page; email opens straight on its empty field.
      const google = hrefs.find(item => item.url.searchParams.get("method") === "google");
      const emailLink = hrefs.find(item => item.url.searchParams.get("method") === "email");
      const fresh = await newContext(browser);
      const freshPage = await fresh.newPage();
      results.watch(freshPage, "embed-direct");
      if (google) {
        google.url.searchParams.set("state", `g-${t}`);
        google.url.searchParams.set("code_challenge", challenge);
        await freshPage.goto(google.url.href);
        const opening = await waitForOpening(env, freshPage, "google", { stay: true });
        results.check("the direct Continue with Google link opens the Opening page in Briefcase's name, Powered by at the bottom", opening.title === "Opening Google to sign you in to Briefcase…" && opening.poweredBy.href === POWERED_BY_HREF, `${opening.title} ${opening.poweredBy.href}`);
      }
      if (emailLink) {
        emailLink.url.searchParams.set("state", `e-${t}`);
        emailLink.url.searchParams.set("code_challenge", challenge);
        await freshPage.goto(emailLink.url.href);
        const field = freshPage.getByRole("textbox", { name: "Email" });
        await field.waitFor({ timeout: 20_000 });
        results.check("the direct Continue with email link opens straight on the email field, empty, and no Google or Apple button", (await field.inputValue()) === "" && (await freshPage.getByRole("button", { name: "Continue with Google" }).count()) === 0, await hostedTitle(freshPage));
      }

      // 3. The iframe on a page of the app's allowed origin, and on one that is not.
      const allowed = new URL(config.allowed_origins[0] ?? env.apps).origin;
      const iframeHtml = iframeCode.replace(/STATE/g, `i-${t}`).replace(/CHALLENGE/g, challenge);
      const pageWith = (body: string) => `<!doctype html><html><head><meta charset="utf-8"><title>Briefcase</title></head><body><h1>Briefcase</h1>${body}</body></html>`;
      await fresh.route(`${allowed}/__ds-embed-${t}.html`, route => route.fulfill({ status: 200, contentType: "text/html", body: pageWith(iframeHtml) }));
      await freshPage.goto(`${allowed}/__ds-embed-${t}.html`);
      const frame = freshPage.frameLocator('iframe[title="Sign in to Briefcase"]');
      // The snippet as last set: Sign in and Sign up buttons opening the sign-up version, so just "Sign up".
      // Each button is a link with target=_top (embed-buttons.tsx).
      const signUpInFrame = frame.getByRole("link", { name: "Sign up", exact: true });
      await signUpInFrame.waitFor({ timeout: 20_000 }).catch(() => undefined);
      const framed = await signUpInFrame.isVisible().catch(() => false);
      const frameButtons = (await frame.getByRole("group").first().getByRole("link").allInnerTexts().catch(() => [])).map(text => text.trim());
      await shot(env, freshPage, "ds-p-02-iframe");
      results.check(`the iframe snippet shows Briefcase's button (just Sign up, as set) with Powered by on its allowed origin (${allowed})`, framed && frameButtons.join("|") === "Sign up" && (await frame.getByRole("link", { name: "Silicon Accounts", exact: true }).count()) === 1, frameButtons.join(" | "));
      if (framed) {
        await signUpInFrame.click();
        await freshPage.waitForURL(url => url.href.startsWith(`${env.site}/authorize`), { timeout: 20_000 }).catch(() => undefined);
        const title = await hostedTitle(freshPage).catch(() => "");
        results.check("…and a click there takes the whole window to the hosted sign-up page", freshPage.url().startsWith(`${env.site}/authorize`) && title === "Create your Briefcase account", `${title} — ${freshPage.url().slice(0, 120)}`);
      }
      const elsewhere = `http://localhost:${new URL(env.apps).port}`;
      const blocked = await newContext(browser);
      const blockedPage = await blocked.newPage();
      results.watch(blockedPage, "embed-elsewhere", [/frame-ancestors|Refused to frame|Refused to display|ERR_BLOCKED_BY_RESPONSE/]);
      await blocked.route(`${elsewhere}/__ds-embed-${t}.html`, route => route.fulfill({ status: 200, contentType: "text/html", body: pageWith(iframeHtml) }));
      await blockedPage.goto(`${elsewhere}/__ds-embed-${t}.html`);
      await sleep(2500);
      const elsewhereShows = await blockedPage.frameLocator('iframe[title="Sign in to Briefcase"]').getByRole("link", { name: "Sign up", exact: true }).isVisible().catch(() => false);
      results.check(`…but not on an origin that is not allowed (${elsewhere}): the browser refuses to frame it`, !elsewhereShows);
      await blocked.close();

      // 4. The SDK snippet on the app's page: "Sign in" and "Sign up"; "Sign up" opens the sign-up pages.
      const sdkPage = await fresh.newPage();
      results.watch(sdkPage, "embed-sdk");
      await fresh.route(`${allowed}/__ds-sdk-${t}.html`, route => route.fulfill({ status: 200, contentType: "text/html", body: pageWith(sdkCode) }));
      await sdkPage.goto(`${allowed}/__ds-sdk-${t}.html`);
      const signUp = sdkPage.getByRole("button", { name: "Sign up", exact: true });
      await signUp.waitFor({ timeout: 20_000 }).catch(() => undefined);
      const sdkButtons = (await sdkPage.locator("#silicon-accounts").getByRole("button").allInnerTexts().catch(() => [])).map(text => text.trim());
      results.check("the SDK snippet (data-buttons=\"intents\", data-intent=\"signup\") renders just its Sign up button", sdkButtons.includes("Sign up") && !sdkButtons.some(text => /Continue with/.test(text)), sdkButtons.join(" | "));
      if (await signUp.isVisible().catch(() => false)) {
        await signUp.click();
        await sdkPage.waitForURL(url => url.href.startsWith(`${env.site}/authorize`), { timeout: 20_000 }).catch(() => undefined);
        const title = await hostedTitle(sdkPage).catch(() => "");
        const authorizeUrl = sdkPage.url();
        results.check("…and Sign up opens the sign-up version of Briefcase's pages, with the SDK's own state and PKCE", /^Create your Briefcase account$/.test(title) && /\/authorize/.test(authorizeUrl), `${title} — ${authorizeUrl.slice(0, 160)}`);
        const sent = new URL(authorizeUrl.startsWith(`${env.site}/authorize/flow/`) ? sdkPage.url() : authorizeUrl);
        results.check("…the SDK made the state and PKCE itself (no login hint)", !sent.searchParams.has("login_hint"), sent.search.slice(0, 200));
      }
      await fresh.close();
      await visitor.close();
    } finally {
      await context.close();
    }
  },
};

async function until(probe: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (probe()) return true;
    await sleep(200);
  }
  return probe();
}
