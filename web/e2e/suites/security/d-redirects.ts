/**
 * Open redirects and reflected input. The hosted flow only ever sends a browser back to a redirect URI the app
 * registered (byte for byte for https; loopback http on any port, per RFC 8252) and refuses everything else before it
 * creates a flow, so no error redirect can be aimed at another site either. The first-party app accepts only the
 * site's own origin. In the browser: /authorize with a foreign redirect_uri shows an error and goes nowhere,
 * /sign-in?return_to=… never leaves the site (signed in, or after a whole sign-in round trip), the account site's
 * "Connect Google" refuses a foreign return_to, and hostile query parameters are shown as text, never run.
 */
import type { Page, Route } from "@playwright/test";
import type { Journey } from "../../context";
import { codeFor, lastSeq, newContext, shot, sleep, tag } from "../../lib";
import { appCredentials, brief, call, callbackOf, errorOf, remember, signInWithEmail, viaSite, Jar } from "./_helpers";

/** Requests to the attacker's host (by host: the site's own URLs carry "evil.example" in their query strings). */
const EVIL = (url: URL) => url.hostname === "evil.example" || url.hostname.endsWith(".evil.example");

export const journey: Journey = {
  name: "security-redirects",
  title: "open redirects: /authorize refuses unregistered, look-alike, scheme-changed, path-changed and query-added redirect URIs (and never error-redirects to them), the first-party app only its own origin; in the browser /authorize, /sign-in?return_to and Connect Google never leave the site, and hostile parameters are never executed",
  async run(ctx) {
    const { env, results, browser } = ctx;
    const t = viaSite(ctx);
    const cb = callbackOf(env, "briefcase");
    const apps = new URL(env.apps);
    const site = new URL(env.site);

    // 1. POST /v1/flows: redirect URIs that are not briefcase's.
    const create = (jar: Jar, body: Record<string, unknown>) => call(`${env.site}/v1/flows`, { json: { app_id: "briefcase", state: `s-${tag()}`, ...body }, jar, origin: env.site, ip: ctx.ip });
    const foreign: Array<[string, string]> = [
      ["another site", "https://evil.example/briefcase/callback"],
      ["protocol-relative", `//evil.example${apps.pathname}briefcase/callback`],
      ["a look-alike host", `http://127.0.0.1.evil.example:${apps.port}/briefcase/callback`],
      ["userinfo trick", `http://${apps.host}@evil.example/briefcase/callback`],
      ["backslash authority", `http://evil.example\\@${apps.host}/briefcase/callback`],
      ["another loopback host name", `http://localhost:${apps.port}/briefcase/callback`],
      ["IPv6 loopback instead", `http://[::1]:${apps.port}/briefcase/callback`],
      ["https instead of http", cb.replace("http:", "https:")],
      ["a query added", `${cb}?next=https://evil.example/`],
      ["a path added", `${cb}/../../evil`],
      ["a suffix on the path", `${cb}.evil.example`],
      ["another path's case", cb.replace("callback", "CALLBACK")],
      ["javascript:", `javascript:alert(document.domain)//${cb}`],
      ["data:", "data:text/html,<script>alert(1)</script>"],
      ["another app's callback", callbackOf(env, "dm")],
    ];
    const accepted: string[] = [];
    for (const [label, uri] of foreign) {
      const jar = new Jar();
      const reply = await create(jar, { redirect_uri: uri });
      const error = errorOf(reply);
      if (reply.status !== 400 || error.code !== "redirect_uri_not_registered" || error.details?.redirect_to !== undefined || jar.get("sa_flow")) accepted.push(`${label} (${uri}): ${brief(reply)}${error.details?.redirect_to ? ` redirect_to=${String(error.details.redirect_to)}` : ""}`);
    }
    results.check(`POST /v1/flows refuses ${foreign.length} redirect URIs briefcase never registered (400 redirect_uri_not_registered, no flow, no error redirect)`, accepted.length === 0, accepted.join(" | ") || foreign.map(([label]) => label).join(", "));

    const bad: Array<[string, Record<string, unknown>]> = [
      ["an invalid scope", { scope: "openid wallet.drain" }],
      ["prompt=none while signed out", { prompt: "none" }],
      ["an unsupported response_type", { response_type: "token" }],
      ["a bad PKCE method", { code_challenge: "x".repeat(43), code_challenge_method: "plain-text" }],
    ];
    const aimed: string[] = [];
    for (const [label, extra] of bad) {
      const reply = await create(new Jar(), { redirect_uri: "https://evil.example/cb", ...extra });
      const error = errorOf(reply);
      if (reply.status !== 400 || error.code !== "redirect_uri_not_registered" || JSON.stringify(reply.body).includes("evil.example/cb?")) aimed.push(`${label}: ${brief(reply)}`);
    }
    results.check("a second error together with a foreign redirect URI (bad scope, prompt=none signed out, response_type=token, bad PKCE) is still answered 400 redirect_uri_not_registered: no error redirect is ever built for an unregistered URI", aimed.length === 0, aimed.join(" | ") || `${bad.length} combinations`);
    const scoped = await create(new Jar(), { redirect_uri: cb, scope: "openid wallet.drain" });
    const redirectTo = String(errorOf(scoped).details?.redirect_to ?? "");
    results.check("control: with briefcase's own redirect URI the same bad scope comes back as an RFC 6749 error redirect to that URI only", scoped.status === 400 && errorOf(scoped).code === "invalid_scope" && redirectTo.startsWith(`${cb}?`) && /error=invalid_scope/.test(redirectTo), redirectTo.slice(0, 160));

    // An https redirect URI matches byte for byte only (briefcase's are loopback http): a URI registered on an app this
    // suite owns for the length of the check (spacestation), then restored.
    const registered = "https://space.example/auth/callback";
    const detail = await call<{ signin_config?: { redirect_uris?: string[] }; config_version?: number }>(`${env.site}/v1/apps/spacestation`, { basic: appCredentials("spacestation"), ip: ctx.ip });
    const original = detail.body.signin_config?.redirect_uris ?? [];
    const patched = await call(`${env.site}/v1/apps/spacestation/signin-config`, { method: "PATCH", json: { redirect_uris: [...original, registered] }, basic: appCredentials("spacestation"), ip: ctx.ip, headers: { "idempotency-key": `sec-${tag()}` } });
    try {
      const variants = [
        `${registered}/`,
        `${registered}?x=1`,
        `${registered}#frag`,
        registered.replace("space.example", "SPACE.example"),
        registered.replace("https:", "http:"),
        registered.replace("space.example", "space.example.evil.example"),
        registered.replace("space.example", "evil.example#space.example"),
        registered.replace("https://", "https://space.example@"),
        registered.replace("space.example", "space.example:8443"),
      ];
      const exactFailures: string[] = [];
      for (const uri of variants) {
        const reply = await call(`${env.site}/v1/flows`, { json: { app_id: "spacestation", redirect_uri: uri, state: "s" }, jar: new Jar(), origin: env.site, ip: ctx.ip });
        if (reply.status !== 400 || errorOf(reply).code !== "redirect_uri_not_registered") exactFailures.push(`${uri}: ${brief(reply)}`);
      }
      const exact = await call(`${env.site}/v1/flows`, { json: { app_id: "spacestation", redirect_uri: registered, state: "s" }, jar: new Jar(), origin: env.site, ip: ctx.ip });
      results.check(`an https redirect URI matches only byte for byte: ${variants.length} variants (trailing slash, query, fragment, case, http, look-alike host, userinfo, port) are refused, the registered one works`, patched.status === 200 && exactFailures.length === 0 && exact.status === 201, `${patched.status === 200 ? "" : `patch ${brief(patched)}; `}${exactFailures.join(" | ") || "all refused"}; exact ${exact.status}`);
    } finally {
      await call(`${env.site}/v1/apps/spacestation/signin-config`, { method: "PATCH", json: { redirect_uris: original }, basic: appCredentials("spacestation"), ip: ctx.ip, headers: { "idempotency-key": `sec-${tag()}` } });
    }

    // The account site's own sign-in (app `accounts`): only the site's origin.
    const firstParty: Array<[string, string]> = [
      ["a look-alike host", `${env.site}.evil.example/`],
      ["userinfo", `http://${site.host}@evil.example/`],
      ["another site", "https://evil.example/sign-in"],
      ["another port", `http://localhost:${Number(site.port) + 1}/`],
      ["a fragment", `${env.site}/sign-in#x`],
      ["protocol-relative", "//evil.example/sign-in"],
      ["javascript:", "javascript:alert(1)"],
    ];
    const fpAccepted: string[] = [];
    for (const [label, uri] of firstParty) {
      const reply = await call(`${env.site}/v1/flows`, { json: { app_id: "accounts", redirect_uri: uri, state: "s" }, jar: new Jar(), origin: env.site, ip: ctx.ip });
      if (reply.status !== 400 || errorOf(reply).code !== "redirect_uri_not_registered") fpAccepted.push(`${label}: ${brief(reply)}`);
    }
    const own = await call(`${env.site}/v1/flows`, { json: { app_id: "accounts", redirect_uri: `${env.site}/sign-in`, state: "s" }, jar: new Jar(), origin: env.site, ip: ctx.ip });
    results.check(`the account site's own sign-in redirects only to its origin: ${firstParty.length} others refused (look-alike host, userinfo, other site/port, fragment, //, javascript:), its /sign-in accepted`, fpAccepted.length === 0 && own.status === 201, fpAccepted.join(" | ") || `own ${own.status}`);

    // Connect Google's return_to (POST /v1/me/identities/google, a signed-in Carbon's browser).
    const carbon = await signInWithEmail(t, { label: "redirects" });
    remember(ctx, "session cookie", carbon.jar.get("sa_session"));
    remember(ctx, "code", carbon.code);
    const returns = ["https://evil.example/", "//evil.example/x", "/\\evil.example/x", "javascript:alert(1)", `${env.site}.evil.example/`, `http://${site.host}@evil.example/`, "/sign-in-methods#x", "/\t/evil.example"];
    const returnAccepted: string[] = [];
    for (const value of returns) {
      const reply = await call(`${env.site}/v1/me/identities/google`, { json: { return_to: value }, jar: carbon.jar, origin: env.site, ip: ctx.ip });
      const fields = (errorOf(reply).details?.fields ?? {}) as Record<string, unknown>;
      if (reply.status !== 422 || !fields.return_to) returnAccepted.push(`${JSON.stringify(value)}: ${brief(reply)}`);
    }
    const ownReturn = await call<{ authorize_url?: string }>(`${env.site}/v1/me/identities/google`, { json: { return_to: "/sign-in-methods" }, jar: carbon.jar, origin: env.site, ip: ctx.ip });
    results.check(`Connect Google refuses ${returns.length} foreign return_to values (422 with details.fields.return_to) and accepts a path on the site`, returnAccepted.length === 0 && ownReturn.status === 201 && (ownReturn.body.authorize_url ?? "").startsWith(env.oidc), returnAccepted.join(" | ") || `own: ${ownReturn.status} → ${(ownReturn.body.authorize_url ?? "").slice(0, 60)}`);

    // 2. In the browser. Anything aimed at evil.example is answered here and counted.
    const context = await newContext(browser);
    const hits: string[] = [];
    await context.route(EVIL, (route: Route) => {
      hits.push(route.request().url());
      return route.fulfill({ contentType: "text/html", body: "<title>evil</title>evil" });
    });
    const dialogs: string[] = [];
    const page = await context.newPage();
    page.on("dialog", dialog => {
      dialogs.push(dialog.message());
      void dialog.dismiss();
    });
    results.watch(page, "redirects", [/400 \(Bad Request\)/, /Failed to load resource/]);
    const settle = async (p: Page, ms = 2500) => {
      await p.waitForLoadState("networkidle").catch(() => undefined);
      await sleep(ms);
    };

    for (const [label, query] of [
      ["an unregistered redirect_uri", `app_id=briefcase&redirect_uri=${encodeURIComponent("https://evil.example/cb")}&state=x`],
      ["an unregistered redirect_uri with prompt=none", `app_id=briefcase&redirect_uri=${encodeURIComponent("https://evil.example/cb")}&state=x&prompt=none`],
      ["a javascript: redirect_uri", `app_id=briefcase&redirect_uri=${encodeURIComponent("javascript:window.__pwned=1")}&state=x`],
    ] as const) {
      await page.goto(`${env.site}/authorize?${query}`);
      await settle(page);
      const text = (await page.locator("body").innerText()).replace(/\s+/g, " ");
      const stayed = new URL(page.url()).origin === env.site && new URL(page.url()).pathname.startsWith("/authorize");
      results.check(`/authorize with ${label} stays on the site and says the redirect isn't registered`, stayed && hits.length === 0 && /not registered|isn.t registered|redirect/i.test(text), `at ${page.url().slice(0, 90)}; evil hits ${hits.length}; "${text.slice(0, 140)}"`);
    }
    await shot(env, page, "security-redirects-01-unregistered");

    // Signed in: /sign-in?return_to=… goes straight to return_to, so only a path on this site may come through.
    await context.addCookies([{ name: "sa_session", value: carbon.jar.get("sa_session") ?? "", domain: site.hostname, path: "/", httpOnly: true, sameSite: "Lax", secure: false, expires: Math.floor(Date.now() / 1000) + 3600 }]);
    const payloads = ["https://evil.example/x", "//evil.example/x", "/\\evil.example/x", "/\t/evil.example/x", "\\\\evil.example/x", "javascript:window.__pwned=1", "data:text/html,<script>window.__pwned=1</script>", `http://${site.host}@evil.example/`, `${env.site}.evil.example/`, "https:evil.example", "/%2F%2Fevil.example/x"];
    const escaped: string[] = [];
    for (const payload of payloads) {
      await page.goto(`${env.site}/sign-in?return_to=${encodeURIComponent(payload)}`);
      await page.waitForURL(url => url.origin !== env.site || url.pathname !== "/sign-in", { timeout: 20_000 }).catch(() => undefined);
      await settle(page, 600);
      const at = new URL(page.url());
      if (at.origin !== env.site || hits.length) escaped.push(`${JSON.stringify(payload)} → ${page.url()}`);
    }
    const pwned = await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned ?? null);
    results.check(`a signed-in browser opening /sign-in?return_to=<foreign> stays on the site for ${payloads.length} payloads (absolute, //, /\\, tab, \\\\, javascript:, data:, userinfo, look-alike, https:host, encoded //)`, escaped.length === 0 && hits.length === 0 && pwned === null && dialogs.length === 0, escaped.join(" | ") || `last at ${page.url()}; evil hits ${hits.length}`);
    await page.goto(`${env.site}/sign-in?return_to=${encodeURIComponent("/silicons")}`);
    await page.waitForURL(url => url.pathname === "/silicons", { timeout: 20_000 }).catch(() => undefined);
    results.check("control: return_to=/silicons (a path on the site) is honoured", new URL(page.url()).pathname === "/silicons", page.url());

    // A whole sign-in round trip from a signed-out browser that started at /sign-in?return_to=//evil.example/x.
    const fresh = await newContext(browser);
    await fresh.route(EVIL, (route: Route) => {
      hits.push(route.request().url());
      return route.fulfill({ contentType: "text/html", body: "evil" });
    });
    const round = await fresh.newPage();
    results.watch(round, "redirects-round-trip");
    const email = `sec.redirects.round.${tag()}@example.test`;
    await round.goto(`${env.site}/sign-in?return_to=${encodeURIComponent("//evil.example/x")}`);
    const field = round.getByRole("textbox", { name: "Email" });
    await field.waitFor({ timeout: 30_000 });
    const after = await lastSeq(env);
    await field.fill(email);
    await round.getByRole("button", { name: "Continue", exact: true }).click();
    const code = await codeFor(env, email, after);
    remember(ctx, "code", code);
    await round.getByRole("group", { name: /Code from the email/ }).waitFor({ timeout: 15_000 });
    await round.keyboard.type(code, { delay: 25 });
    await round.getByRole("button", { name: "Create account" }).click({ timeout: 30_000 });
    await round.waitForURL(url => url.origin !== env.site || (!url.pathname.startsWith("/sign-in") && !url.pathname.startsWith("/authorize")), { timeout: 30_000 }).catch(() => undefined);
    await settle(round, 800);
    results.check("after a whole first-party sign-in that started with return_to=//evil.example/x the browser lands on the site's home, not the foreign host", round.url() === `${env.site}/` && hits.length === 0, `at ${round.url()}; evil hits ${hits.join(", ") || 0}`);
    await fresh.close();

    // 3. Hostile parameters are shown as text, never run.
    const marker = "window.__pwned=1";
    const hostile = [
      `/authorize?app_id=${encodeURIComponent(`<img src=x onerror=${marker}>`)}&redirect_uri=${encodeURIComponent(cb)}&state=x`,
      `/authorize?app_id=briefcase&redirect_uri=${encodeURIComponent(`${cb}"><img src=x onerror=${marker}>`)}&state=x`,
      `/authorize?app_id=briefcase&redirect_uri=${encodeURIComponent(cb)}&state=${encodeURIComponent(`"><img src=x onerror=${marker}>`)}&login_hint=${encodeURIComponent(`"><svg onload=${marker}>@example.test`)}`,
      `/sign-in?state=${encodeURIComponent("x")}&error=${encodeURIComponent(`<img src=x onerror=${marker}>`)}&error_description=${encodeURIComponent(`<script>${marker}</script>`)}`,
      `/device?code=${encodeURIComponent(`<img src=x onerror=${marker}>`)}`,
      `/embed/v1/buttons?app_id=briefcase&redirect_uri=${encodeURIComponent(cb)}&state=${encodeURIComponent(`</script><script>${marker}</script>`)}&theme=${encodeURIComponent(`"><img src=x onerror=${marker}>`)}`,
    ];
    const executed: string[] = [];
    const xss = await newContext(browser);
    const probe = await xss.newPage();
    probe.on("dialog", dialog => {
      dialogs.push(dialog.message());
      void dialog.dismiss();
    });
    const violations: string[] = [];
    probe.on("console", message => {
      if (/Content Security Policy|Refused to (execute|load|apply)/i.test(message.text())) violations.push(message.text().slice(0, 140));
    });
    for (const path of hostile) {
      await probe.goto(`${env.site}${path}`);
      await settle(probe, 1500);
      const state = await probe.evaluate(() => ({ pwned: (window as unknown as { __pwned?: number }).__pwned ?? null, injected: document.querySelectorAll('img[src="x"], svg[onload]').length }));
      if (state.pwned !== null || state.injected) executed.push(`${path.slice(0, 60)}: pwned=${state.pwned} injected elements=${state.injected}`);
    }
    await shot(env, probe, "security-redirects-02-hostile");
    results.check(`hostile values in ${hostile.length} pages' query strings (app_id, redirect_uri, state, login_hint, error, error_description, device code, embed theme) never become markup or script`, executed.length === 0 && dialogs.length === 0 && violations.length === 0, executed.join(" | ") || `no element injected, no dialog, ${violations.length} CSP refusals${violations[0] ? ` (${violations[0]})` : ""}`);
    await xss.close();
    await context.close();
  },
};
