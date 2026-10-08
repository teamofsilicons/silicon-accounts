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
import { appCredentials, brief, call, callbackOf, developerCallback, errorOf, raw, remember, signInWithEmail, viaSite, Jar } from "./_helpers";

/** Requests to the attacker's host (by host: the site's own URLs carry "evil.example" in their query strings). */
const EVIL = (url: URL) => url.hostname === "evil.example" || url.hostname.endsWith(".evil.example");

export const journey: Journey = {
  name: "security-redirects",
  title: "open redirects: /authorize refuses unregistered, look-alike, scheme-changed, path-changed and query-added redirect URIs (and never error-redirects to them), the first-party app only its own origin, the developer site's app only its exact callback; the site's own redirects stay on the site for //, /\\ and encoded paths; forged Host / X-Forwarded-Host / Forwarded headers change no published URL; in the browser /authorize, /sign-in?return_to and Connect Google never leave the site, and hostile parameters are never executed",
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

    // The account site's own sign-in (app `silicon-accounts`): only the site's origin.
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
      const reply = await call(`${env.site}/v1/flows`, { json: { app_id: "silicon-accounts", redirect_uri: uri, state: "s" }, jar: new Jar(), origin: env.site, ip: ctx.ip });
      if (reply.status !== 400 || errorOf(reply).code !== "redirect_uri_not_registered") fpAccepted.push(`${label}: ${brief(reply)}`);
    }
    const own = await call(`${env.site}/v1/flows`, { json: { app_id: "silicon-accounts", redirect_uri: `${env.site}/sign-in`, state: "s" }, jar: new Jar(), origin: env.site, ip: ctx.ip });
    results.check(`the account site's own sign-in redirects only to its origin: ${firstParty.length} others refused (look-alike host, userinfo, other site/port, fragment, //, javascript:), its /sign-in accepted`, fpAccepted.length === 0 && own.status === 201, fpAccepted.join(" | ") || `own ${own.status}`);

    // The developer site's app (`developer`, a public client): only {ACCOUNTS_DEVELOPER_URL}/auth/callback, exactly. Its
    // code is the developer platform's whole sign-in, so a look-alike redirect would hand it to someone else.
    const devCb = developerCallback(env);
    const dev = new URL(env.developer);
    const devVariants: Array<[string, string]> = [
      ["a trailing slash", `${devCb}/`],
      ["a query added", `${devCb}?next=https://evil.example/`],
      ["another path", `${env.developer}/auth/callbackx`],
      ["the path's case", `${env.developer}/auth/CALLBACK`],
      ["a dot segment", `${env.developer}/auth/x/../callback`],
      ["an encoded slash", `${env.developer}/auth%2Fcallback`],
      ["127.0.0.1 for localhost", devCb.replace("localhost", "127.0.0.1")],
      ["https instead of http", devCb.replace("http:", "https:")],
      ["another port", `http://${dev.hostname}:${Number(dev.port) + 1}/auth/callback`],
      ["the account site's origin", `${env.site}/auth/callback`],
      ["a look-alike host", `${env.developer}.evil.example/auth/callback`],
      ["userinfo", `http://${dev.host}@evil.example/auth/callback`],
      ["another site", "https://evil.example/auth/callback"],
      ["a fragment", `${devCb}#frag`],
      ["the production developer site", "https://developers.teamofsilicons.com/auth/callback"],
      ["a fake app's callback", callbackOf(env, "briefcase")],
    ];
    const devAccepted: string[] = [];
    for (const [label, uri] of devVariants) {
      const jar = new Jar();
      const reply = await call(`${env.site}/v1/flows`, { json: { app_id: "developer", redirect_uri: uri, state: "s", code_challenge: "x".repeat(43), code_challenge_method: "S256" }, jar, origin: env.site, ip: ctx.ip });
      if (reply.status !== 400 || errorOf(reply).code !== "redirect_uri_not_registered" || errorOf(reply).details?.redirect_to !== undefined || jar.get("sa_flow")) devAccepted.push(`${label} (${uri}): ${brief(reply)}`);
    }
    const devOwn = await call(`${env.site}/v1/flows`, { json: { app_id: "developer", redirect_uri: devCb, state: "s", code_challenge: "x".repeat(43), code_challenge_method: "S256" }, jar: new Jar(), origin: env.site, ip: ctx.ip });
    results.check(`the developer site's app redirects only to ${devCb}: ${devVariants.length} others refused before any flow exists (trailing slash, query, other paths, dot segment, encoded slash, 127.0.0.1, https, another port, the account site, look-alike, userinfo, another site, fragment, the production address, an app's callback), its own accepted`, devAccepted.length === 0 && devOwn.status === 201, devAccepted.join(" | ") || `own ${devOwn.status}`);
    const devApp = await call(`${env.site}/v1/apps/developer/public`);
    const devPatch = await call(`${env.site}/v1/apps/developer/signin-config`, { method: "PATCH", json: { redirect_uris: ["https://evil.example/cb"] }, basic: ["developer", "anything"], ip: ctx.ip });
    results.check("nobody can give the developer app another redirect URI: it has no secret to change its setup with (401)", devPatch.status === 401, `public ${devApp.status}; PATCH ${brief(devPatch)}`);

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

    // The site's own redirects (trailing slashes, /identity, /docs/index): a path that starts with //, /\ or their
    // encodings must never become a Location that leaves the site (sent byte for byte: fetch would normalize them).
    const tricky = ["//evil.example/", "///evil.example/a/", "//evil.example/%2e%2e", "/\\evil.example/", "/%5Cevil.example/", "/%2F%2Fevil.example/", "/.//evil.example/", "//evil.example/sign-in/", "/identity//evil.example", "/%09/evil.example", "/sign-in/?next=//evil.example/", "/\\/evil.example/"];
    const offSite: string[] = [];
    const seen: string[] = [];
    for (const path of tricky) {
      const reply = await raw(env.site, path);
      const location = String(reply.headers.location ?? "");
      if (reply.status === -1) offSite.push(`${path}: ${reply.text}`);
      if (!location) continue;
      seen.push(`${path} → ${reply.status} ${location}`);
      let leaves = /^\s*[/\\]{2}/.test(location) || /^\s*\/\\/.test(location);
      try {
        leaves ||= new URL(location, env.site).origin !== env.site;
      } catch {
        leaves = true;
      }
      if (leaves) offSite.push(`${path} → ${reply.status} ${location}`);
    }
    results.check(`the site's own redirects never point off the site: ${tricky.length} paths starting with //, ///, /\\, /\\/, encoded // and \\, /./, or a tab are answered with a path on the site (or not redirected)`, offSite.length === 0, offSite.join(" | ") || `${seen.length} redirects, e.g. ${seen.slice(0, 3).join(", ")}`);

    // A forged Host, X-Forwarded-Host or Forwarded header never reaches a Location or a URL the service publishes: the
    // discovery document, the device flow's verification URLs and the site's redirects come out exactly as without it.
    const forgedHosts: Array<[string, string, Record<string, string>]> = [
      ["Host: evil.example at the site", env.site, { host: "evil.example" }],
      ["X-Forwarded-Host: evil.example (+ X-Forwarded-Proto: https) at the site", env.site, { "x-forwarded-host": "evil.example", "x-forwarded-proto": "https" }],
      ["Forwarded: host=evil.example at the site", env.site, { forwarded: "host=evil.example;proto=https" }],
      ["Host: evil.example straight at accounts-api", env.api, { host: "evil.example" }],
      ["X-Forwarded-Host: evil.example straight at accounts-api", env.api, { "x-forwarded-host": "evil.example" }],
    ];
    const published = async (base: string, headers: Record<string, string>) => {
      const discovery = await raw(base, "/.well-known/openid-configuration", { headers });
      const device = await raw(base, "/v1/device/authorize", { method: "POST", headers: { ...headers, "content-type": "application/json", "x-forwarded-for": ctx.ip }, body: JSON.stringify({ client_label: "host header probe" }) });
      let deviceBody: { device_code?: string; verification_uri?: string; verification_uri_complete?: string; user_code?: string } = {};
      try {
        deviceBody = JSON.parse(device.text) as typeof deviceBody;
      } catch {
        // Not JSON: compared as missing.
      }
      remember(ctx, "device code", deviceBody.device_code);
      const redirects: string[] = [];
      if (base === env.site) for (const path of ["/identity", "/docs/index", "/sign-in/"]) redirects.push(`${path} ${(await raw(base, path, { headers })).headers.location ?? ""}`);
      return { discovery: `${discovery.status} ${discovery.text}`, device: `${device.status} ${deviceBody.verification_uri ?? ""} ${(deviceBody.verification_uri_complete ?? "").replace(deviceBody.user_code ?? "\u0000", "<code>")}`, redirects: redirects.join(", ") };
    };
    const poisoned: string[] = [];
    for (const [label, base, headers] of forgedHosts) {
      const control = await published(base, {});
      const forged = await published(base, headers);
      for (const part of ["discovery", "device", "redirects"] as const) {
        if (forged[part] !== control[part] || /evil\.example/.test(forged[part])) poisoned.push(`${label}: ${part} differs (${forged[part].slice(0, 120)} vs ${control[part].slice(0, 120)})`);
      }
      if (!control.discovery.startsWith("200") || !control.device.startsWith("200")) poisoned.push(`${label}: control ${control.discovery.slice(0, 40)} / ${control.device.slice(0, 60)}`);
    }
    results.check(`a forged Host, X-Forwarded-Host or Forwarded header (${forgedHosts.length} cases, site and accounts-api) changes nothing the service publishes: the discovery document, the device flow's verification URLs and the site's redirects are byte-identical to those without it`, poisoned.length === 0, poisoned.join(" | ") || "identical in every case");

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
    // After the network is idle, a short wait catches anything a page would still do by itself; a direct Google
    // button's Opening page moves on after about 900 ms, so that case waits past it.
    const settle = async (p: Page, ms = 600) => {
      await p.waitForLoadState("networkidle").catch(() => undefined);
      await sleep(ms);
    };

    const providerHits = async () => ((await call<{ items?: unknown[] }>(`${env.oidc}/_requests?endpoint=authorize`)).body.items ?? []).length;
    const providerBefore = await providerHits();
    for (const [label, query] of [
      ["an unregistered redirect_uri", `app_id=briefcase&redirect_uri=${encodeURIComponent("https://evil.example/cb")}&state=x`],
      ["an unregistered redirect_uri with prompt=none", `app_id=briefcase&redirect_uri=${encodeURIComponent("https://evil.example/cb")}&state=x&prompt=none`],
      ["a javascript: redirect_uri", `app_id=briefcase&redirect_uri=${encodeURIComponent("javascript:window.__pwned=1")}&state=x`],
      ["an unregistered redirect_uri behind the app's Continue with Google button (intent=signup)", `app_id=briefcase&redirect_uri=${encodeURIComponent("https://evil.example/cb")}&state=x&method=google&intent=signup`],
      ["the developer app with a foreign redirect_uri", `app_id=developer&redirect_uri=${encodeURIComponent("https://evil.example/auth/callback")}&state=x&code_challenge=${"x".repeat(43)}&code_challenge_method=S256`],
    ] as const) {
      await page.goto(`${env.site}/authorize?${query}`);
      await settle(page, query.includes("method=google") ? 1_500 : 600);
      const text = (await page.locator("body").innerText()).replace(/\s+/g, " ");
      const stayed = new URL(page.url()).origin === env.site && new URL(page.url()).pathname.startsWith("/authorize");
      results.check(`/authorize with ${label} stays on the site and says the redirect isn't registered`, stayed && hits.length === 0 && /not registered|isn.t registered|redirect/i.test(text), `at ${page.url().slice(0, 90)}; evil hits ${hits.length}; "${text.slice(0, 140)}"`);
    }
    const providerAfter = await providerHits();
    results.check("…and none of them ever opened Google or Apple (no authorize request reached the mock providers; the Opening page never showed for a link that can't start)", providerAfter === providerBefore, `${providerAfter - providerBefore} authorize requests`);
    await shot(env, page, "security-redirects-01-unregistered");

    // Signed in: /sign-in?return_to=… goes straight to return_to, so only a path on this site may come through.
    await context.addCookies([{ name: "sa_session", value: carbon.jar.get("sa_session") ?? "", domain: site.hostname, path: "/", httpOnly: true, sameSite: "Lax", secure: false, expires: Math.floor(Date.now() / 1000) + 3600 }]);
    const payloads = ["https://evil.example/x", "//evil.example/x", "/\\evil.example/x", "/\t/evil.example/x", "\\\\evil.example/x", "javascript:window.__pwned=1", "data:text/html,<script>window.__pwned=1</script>", `http://${site.host}@evil.example/`, `${env.site}.evil.example/`, "https:evil.example", "/%2F%2Fevil.example/x"];
    const escaped: string[] = [];
    for (const payload of payloads) {
      await page.goto(`${env.site}/sign-in?return_to=${encodeURIComponent(payload)}`);
      await page.waitForURL(url => url.origin !== env.site || url.pathname !== "/sign-in", { timeout: 20_000 }).catch(() => undefined);
      await settle(page, 300);
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
      `/v1/oauth/callback/${encodeURIComponent(`<img src=x onerror=${marker}>`)}?state=${encodeURIComponent(`"><img src=x onerror=${marker}>`)}`,
      `/v1/oauth/callback/google?state=${encodeURIComponent(`<svg onload=${marker}>`)}&error=${encodeURIComponent(`<img src=x onerror=${marker}>`)}&error_description=${encodeURIComponent(`<script>${marker}</script>`)}`,
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
      await settle(probe, 500);
      const state = await probe.evaluate(() => ({ pwned: (window as unknown as { __pwned?: number }).__pwned ?? null, injected: document.querySelectorAll('img[src="x"], svg[onload]').length }));
      if (state.pwned !== null || state.injected) executed.push(`${path.slice(0, 60)}: pwned=${state.pwned} injected elements=${state.injected}`);
    }
    await shot(env, probe, "security-redirects-02-hostile");
    results.check(`hostile values in ${hostile.length} pages' query strings and paths (app_id, redirect_uri, state, login_hint, error, error_description, device code, embed theme, the provider callback's provider name, state and error) never become markup or script`, executed.length === 0 && dialogs.length === 0 && violations.length === 0, executed.join(" | ") || `no element injected, no dialog, ${violations.length} CSP refusals${violations[0] ? ` (${violations[0]})` : ""}`);
    await xss.close();
    await context.close();
  },
};
