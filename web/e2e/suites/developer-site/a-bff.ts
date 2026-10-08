/**
 * developers.teamofsilicons.com is a BFF (06-v2 §2): its Next server signs a Carbon in through the account site's hosted
 * pages as the first-party public client `developer` (PKCE S256), keeps the tokens in a sealed httpOnly cookie, and
 * proxies /api/accounts/* to accounts-api. This journey signs an app's owner in from a deep link and checks that no
 * token ever reaches the browser, what the developer audience's token may do at accounts-api (and what it may not),
 * what the BFF forwards, and its same-origin guard.
 */
import type { Response } from "@playwright/test";
import type { Journey } from "../../context";
import { DEVELOPER_SIGNED_OUT, developerApi, fakeApp, newContext, shot, signInWithCode, sleep, tag } from "../../lib";
import { SESSION_COOKIE, SIGNIN_COOKIE, appDetail, bearer, developerSecret, errorCode, errorMessage, freshCodeWindow, jwtClaims, readDevSession, unseal } from "./_helpers";

interface Seen {
  url: string;
  status: number;
  body: string;
  headers: string;
}

export const journey: Journey = {
  name: "developer-site-bff-signin",
  title: "an app's owner signs in to the developer site from a deep link through its BFF (PKCE S256 on the account site's hosted pages, the code exchanged on the server); the session cookie is sealed and httpOnly and no token reaches the browser; the developer token works only for the account read and the owner routes; the BFF forwards only its allowlist and refuses cross-site writes",
  async run(ctx) {
    const { env, results, browser } = ctx;
    const appId = "quill-docs";
    const ownerEmail = fakeApp(appId).owner_email;
    await freshCodeWindow(env, ownerEmail);
    const context = await newContext(browser);
    const page = await context.newPage();
    results.watch(page, "bff", [DEVELOPER_SIGNED_OUT]);

    // Everything the browser receives from the developer site and the account site's API, to look for tokens in.
    const seen: Seen[] = [];
    const reads: Array<Promise<void>> = [];
    const UNREAD = "\u0000unread";
    const unread: string[] = [];
    const browserTokenCalls: string[] = [];
    let callback: { url: string; status: number } | null = null;
    page.on("request", request => {
      if (/\/v1\/oauth\/(token|revoke)/.test(request.url())) browserTokenCalls.push(`${request.method()} ${request.url()}`);
    });
    page.on("response", (response: Response) => {
      const url = response.url();
      if (url.startsWith(`${env.developer}/auth/callback`)) callback = { url, status: response.status() };
      const ours = url.startsWith(env.developer) || url.startsWith(`${env.site}/v1/`) || url.startsWith(`${env.site}/authorize`);
      if (!ours || /\/_next\/static\//.test(url)) return;
      reads.push((async () => {
        const headers = JSON.stringify(await response.allHeaders().catch(() => ({})));
        // A body that never ends (a streamed page the browser left, a prefetch it dropped) must not hold the journey up:
        // after 5 s its headers alone are looked at.
        const body = response.status() >= 300 && response.status() < 400 ? "" : await Promise.race([response.text().catch(() => ""), sleep(5_000).then(() => UNREAD)]);
        if (body === UNREAD) unread.push(url);
        seen.push({ url, status: response.status(), body: body === UNREAD ? "" : body, headers });
      })());
    });

    // A signed-out visitor to a deep link is sent to the sign-in card, which comes back there.
    const deep = `/apps/${appId}/users`;
    await page.goto(`${env.developer}${deep}`);
    await page.waitForURL(url => url.href.startsWith(`${env.developer}/sign-in`), { timeout: 30_000 });
    const signInPage = new URL(page.url());
    results.check("a signed-out visitor to a deep link lands on the sign-in card with return_to", signInPage.searchParams.get("return_to") === deep, page.url());
    const cta = page.getByRole("link", { name: /Continue with Silicon Accounts/ });
    await cta.waitFor({ timeout: 20_000 });
    results.check("…\"Build with Silicon Accounts\" and its one button, Continue with Silicon Accounts", (await page.getByRole("heading", { level: 1 }).innerText()).trim() === "Build with Silicon Accounts" && (await cta.getAttribute("href")) === `/auth/sign-in?return_to=${encodeURIComponent(deep)}`, String(await cta.getAttribute("href")));
    await shot(env, page, "ds-a-01-sign-in-card");

    const started = Date.now();
    await cta.click();
    await page.waitForURL(url => url.href.startsWith(`${env.site}/authorize`), { timeout: 30_000 });
    const authorize = new URL(page.url());
    const challenge = authorize.searchParams.get("code_challenge") ?? "";
    results.check("it goes to the account site's /authorize as the app `developer`, back to its own /auth/callback", authorize.searchParams.get("app_id") === "developer" && authorize.searchParams.get("redirect_uri") === `${env.developer}/auth/callback`, authorize.search.slice(0, 240));
    results.check("…with a state and a PKCE S256 challenge (43 base64url characters), and no email or phone", !!authorize.searchParams.get("state") && /^[A-Za-z0-9_-]{43}$/.test(challenge) && authorize.searchParams.get("code_challenge_method") === "S256" && !authorize.searchParams.has("login_hint"), `state ${authorize.searchParams.get("state")?.length} chars, challenge ${challenge.length} chars`);
    const pending = (await context.cookies(env.developer)).find(cookie => cookie.name === SIGNIN_COOKIE);
    const pendingList = unseal<Array<{ s: string; v: string; r: string }>>(pending?.value, SIGNIN_COOKIE, developerSecret(env)) ?? [];
    results.check("…remembering the state, the PKCE verifier and where to come back in a sealed httpOnly cookie", !!pending?.httpOnly && pending.sameSite === "Lax" && pendingList.some(entry => entry.s === authorize.searchParams.get("state") && entry.r === deep && entry.v.length >= 43), `${pending?.name} httpOnly=${pending?.httpOnly} sameSite=${pending?.sameSite} entries=${pendingList.length}`);
    await signInWithCode(env, page, { email: ownerEmail });
    await page.waitForURL(url => url.href === `${env.developer}${deep}`, { timeout: 30_000 });
    results.metric("signing in through the BFF (button to deep link, email code included)", Date.now() - started);
    await page.getByRole("tabpanel", { name: "Users" }).waitFor({ timeout: 30_000 });
    await sleep(800);
    await shot(env, page, "ds-a-02-deep-link");
    results.check("signed in, the browser is back on the deep link (the Users tab of the app)", page.url() === `${env.developer}${deep}`, page.url());
    const back = callback as { url: string; status: number } | null;
    const callbackUrl = back ? new URL(back.url) : null;
    results.check("…by /auth/callback with the code and the same state (303 to the deep link)", !!callbackUrl?.searchParams.get("code") && callbackUrl.searchParams.get("state") === authorize.searchParams.get("state") && back?.status === 303, `${back?.status} ${callbackUrl?.pathname}?code=${callbackUrl?.searchParams.get("code")?.slice(0, 8)}…`);
    results.check("…and the browser itself never called the token endpoint: the code was exchanged on the developer site's server", browserTokenCalls.length === 0, browserTokenCalls.join(" ") || "no token calls from the browser");
    results.check("…the pending sign-in cookie is gone once used", !(await context.cookies(env.developer)).some(cookie => cookie.name === SIGNIN_COOKIE && cookie.value));

    // The session: a sealed, httpOnly cookie; the tokens inside never reach the page.
    const { cookie, session } = await readDevSession(context, env);
    results.check("the session cookie is httpOnly, SameSite=Lax, for the whole site, and not Secure over http", !!cookie && cookie.httpOnly && cookie.sameSite === "Lax" && cookie.path === "/" && !cookie.secure, JSON.stringify({ name: cookie?.name, httpOnly: cookie?.httpOnly, sameSite: cookie?.sameSite, path: cookie?.path, secure: cookie?.secure }));
    results.check("…its value is sealed (v1.…): no JWT and no refresh token in it", !!cookie && /^v1\.[A-Za-z0-9_-]+$/.test(cookie.value) && !cookie.value.includes("eyJ") && !cookie.value.includes("sar_"), `${cookie?.value.slice(0, 16)}… (${cookie?.value.length} chars)`);
    results.check("…and opened with the server's key it holds the Carbon's tokens", !!session && session.rt.startsWith("sar_") && session.at.split(".").length === 3, session ? `rt ${session.rt.slice(0, 8)}…, at ${session.at.slice(0, 12)}…` : "could not open the cookie with the stack's secret");
    if (!session) throw new Error("the developer site's session cookie could not be opened with the stack's DEVELOPER_SESSION_SECRET");
    const claims = jwtClaims(session.at);
    const detail = await appDetail(ctx, appId);
    results.check("the access token is issued to the developer platform (aud=developer) for the app's owner", claims.aud === "developer" && claims.sub === detail.owner?.uuid && session.sub === detail.owner?.uuid, JSON.stringify({ aud: claims.aud, sub: claims.sub, owner: detail.owner?.uuid }));
    const lifetime = (session.ae - Date.now()) / 60_000;
    results.check("…lives 30 minutes, and the refresh token 900 days", lifetime > 25 && lifetime <= 30.5 && Math.abs((session.re - Date.now()) / 86_400_000 - 900) < 2, `${lifetime.toFixed(1)} min, ${((session.re - Date.now()) / 86_400_000).toFixed(1)} days`);
    const scriptCookies = await page.evaluate(() => document.cookie);
    results.check("page scripts can't read the session cookie (document.cookie)", !scriptCookies.includes(SESSION_COOKIE) && !scriptCookies.includes(SIGNIN_COOKIE), scriptCookies || "(empty)");
    // (No named functions inside evaluate: tsx would wrap them in a helper the page does not have.)
    const storage = await page.evaluate(() => [localStorage, sessionStorage].map(store => Array.from({ length: store.length }, (_, index) => `${store.key(index)}=${store.getItem(store.key(index) ?? "") ?? ""}`).join("\n")).join("\n"));
    results.check("localStorage and sessionStorage hold no token", !storage.includes(session.at) && !storage.includes(session.rt) && !/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./.test(storage) && !storage.includes("sar_"), `${storage.length} characters stored`);
    const me = await developerApi<{ uuid?: string; id?: string; kind?: string }>(env, page, "/me");
    results.check("GET /api/accounts/me answers as the Carbon (through the BFF)", me.status === 200 && me.body.id === fakeApp(appId).owner_id && me.body.kind === "carbon", `${me.status} ${me.body.id}`);
    await Promise.all(reads);
    const leaks = seen.filter(entry => [session.at, session.rt].some(token => entry.body.includes(token) || entry.headers.includes(token)) || /"(access_token|refresh_token)"\s*:/.test(entry.body));
    results.check(`none of the ${seen.length} answers the browser got (pages, the BFF, the hosted pages' API) carries a token`, leaks.length === 0 && seen.length > 5, leaks.map(entry => `${entry.status} ${entry.url}`).join(", ") || `${seen.length} answers looked at${unread.length ? ` (${unread.length} bodies still streaming after 5 s, their headers looked at: ${unread.map(url => new URL(url).pathname).join(" ")})` : ""}`);

    // The developer audience's token, straight at accounts-api: the account read and the owner routes only.
    const allowed = [
      ["GET", "/v1/me"],
      ["GET", "/v1/me/owned-apps"],
      ["GET", `/v1/apps/${appId}`],
      ["GET", `/v1/apps/${appId}/users`],
      ["GET", `/v1/apps/${appId}/signin-config/history`],
      ["GET", `/v1/apps/${appId}/proofs`],
      ["GET", `/v1/apps/${appId}/imports`],
      ["GET", `/v1/apps/${appId}/webhook/deliveries`],
    ] as const;
    const allowedSeen: string[] = [];
    for (const [method, path] of allowed) {
      const answer = await bearer(ctx, session.at, path, { method });
      allowedSeen.push(`${method} ${path} ${answer.status}`);
    }
    results.check("the developer token reads the account and every owner route of its own app", allowedSeen.every(line => / 200$/.test(line)), allowedSeen.join("; "));
    const session2 = await bearer(ctx, session.at, "/v1/session");
    results.check("…GET /v1/session is on its list (not refused for its audience)", errorCode(session2.body) !== "token_wrong_audience", `${session2.status} ${errorCode(session2.body) ?? ""}`);
    const refused = [
      ["GET", "/v1/me/emails", undefined],
      ["GET", "/v1/me/phones", undefined],
      ["GET", "/v1/me/sessions", undefined],
      ["GET", "/v1/me/apps", undefined],
      ["GET", "/v1/me/history", undefined],
      ["GET", "/v1/me/silicons", undefined],
      ["GET", "/v1/me/proofs", undefined],
      ["GET", "/v1/me/identities", undefined],
      ["PATCH", "/v1/me", { display_name: "Taken over" }],
      ["POST", "/v1/me/id", { id: `c:taken-${tag()}` }],
      ["POST", "/v1/me/emails", { email: `takeover-${tag()}@example.test` }],
      ["POST", "/v1/me/short-lived-tokens", { app_id: appId }],
      ["POST", "/v1/me/silicons", { display_name: "Not mine" }],
      ["DELETE", "/v1/me", { confirm: "c:quill-dev" }],
    ] as const;
    const wrong: string[] = [];
    let sample = "";
    for (const [method, path, body] of refused) {
      const answer = await bearer(ctx, session.at, path, { method, ...(body ? { json: body } : {}) });
      const code = errorCode(answer.body);
      if (answer.status !== 401 || code !== "token_wrong_audience") wrong.push(`${method} ${path} → ${answer.status} ${code}`);
      if (!sample) sample = `${errorMessage(answer.body)} | hint: ${(answer.body as { error?: { hint?: string } }).error?.hint ?? ""}`;
    }
    results.check(`…and is refused with 401 token_wrong_audience on the ${refused.length} account routes it may not touch (reads and writes)`, wrong.length === 0, wrong.join("; ") || `all ${refused.length} refused`);
    results.check("…in words that say what the token is for and what to use instead", /developer platform/.test(sample) && /accounts login/.test(sample), sample.slice(0, 300));
    const stillMe = await appDetail(ctx, appId);
    results.check("…and nothing of the account changed (the owner is still c:quill-dev, with the same name)", stillMe.owner?.id === "c:quill-dev" && stillMe.owner?.display_name === detail.owner?.display_name, `${stillMe.owner?.id} ${stillMe.owner?.display_name}`);
    const other = await bearer(ctx, session.at, "/v1/apps/briefcase");
    results.check("another Carbon's app answers 403 not_app_owner to the same token", other.status === 403 && errorCode(other.body) === "not_app_owner", `${other.status} ${errorCode(other.body)}`);

    // The BFF forwards only what the developer site uses.
    const notProxied: string[] = [];
    for (const [method, path] of [["GET", "/me/emails"], ["GET", "/me/sessions"], ["GET", "/me/apps"], ["POST", "/oauth/token"], ["POST", "/me/short-lived-tokens"], ["GET", "/proofs/verify"], ["GET", `/apps/${appId}%2F..%2F..%2Fme%2Femails`]] as const) {
      const answer = await developerApi(env, page, path, { method, ...(method === "POST" ? { json: {} } : {}) });
      if (answer.status !== 404 || errorCode(answer.body) !== "not_proxied") notProxied.push(`${method} ${path} → ${answer.status} ${errorCode(answer.body)}`);
    }
    results.check("the BFF answers 404 not_proxied for everything outside its allowlist (account routes, the token endpoint, an encoded way out of /apps)", notProxied.length === 0, notProxied.join("; ") || "all refused");
    const publicMeta = await fetch(`${env.developer}/api/accounts/meta`);
    const publicApp = await fetch(`${env.developer}/api/accounts/apps/${appId}/public`);
    const signedOut = await fetch(`${env.developer}/api/accounts/me`);
    const signedOutBody = (await signedOut.json().catch(() => null)) as unknown;
    results.check("public reads pass without a session (meta, an app's public setup); account reads answer 401 signed_out", publicMeta.status === 200 && publicApp.status === 200 && signedOut.status === 401 && errorCode(signedOutBody) === "signed_out", `${publicMeta.status} ${publicApp.status} ${signedOut.status} ${errorCode(signedOutBody)}`);

    // The same-origin guard: a write needs this site's own Origin (and, when sent, Sec-Fetch-Site: same-origin).
    const version = (await appDetail(ctx, appId)).config_version;
    const write = (headers: Record<string, string>) => page.request.fetch(`${env.developer}/api/accounts/apps/${appId}/signin-config`, { method: "PATCH", headers: { "content-type": "application/json", ...headers }, data: JSON.stringify({ copy: { subtitle: `Cross-site ${tag()}` } }) });
    const foreign = await write({ origin: "https://evil.example" });
    const none = await write({});
    const crossSite = await write({ origin: env.developer, "sec-fetch-site": "cross-site" });
    const codes = await Promise.all([foreign, none, crossSite].map(async answer => `${answer.status()} ${errorCode(await answer.json().catch(() => null))}`));
    results.check("a write from another origin, with no Origin, or marked cross-site answers 403 cross_site_request", codes.every(code => code === "403 cross_site_request"), codes.join(" | "));
    const signOutForeign = await page.request.fetch(`${env.developer}/auth/sign-out`, { method: "POST", headers: { origin: "https://evil.example" } });
    results.check("…signing out from another origin too (403), and the session stays", signOutForeign.status() === 403 && (await developerApi(env, page, "/me")).status === 200, String(signOutForeign.status()));
    const same = await developerApi<{ config_version?: number }>(env, page, `/apps/${appId}/signin-config`, { method: "PATCH", json: {} });
    results.check("…while the site's own (empty) write goes through, and nothing was stored by the refused ones", same.status === 200 && same.body.config_version === version && (await appDetail(ctx, appId)).config_version === version, `${same.status} version ${same.body.config_version} (was ${version})`);

    await context.close();
  },
};
