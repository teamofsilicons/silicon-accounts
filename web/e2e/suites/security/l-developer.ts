/**
 * The developer site (developers.teamofsilicons.com) is a BFF: its Next server holds a Carbon's developer-platform
 * tokens in one sealed, httpOnly cookie and calls accounts-api with them; the browser never sees a token.
 *
 * - security-developer-bff (HTTP): the sign-in round trip as a browser makes it (state + PKCE sealed in sa_dev_signin,
 *   the code exchanged server side); the cookies' flags; the sealed value holds the tokens and nothing readable
 *   (tampered, re-purposed or foreign-key cookies are no session, and never a 500); the BFF forwards only the developer
 *   audience's routes (no Silicons, emails, sessions, SLTs, OAuth, traversal) and never the browser's own cookies;
 *   every state-changing request needs the developer site's Origin (another site, the account site, no Origin, "null",
 *   127.0.0.1 for localhost, Sec-Fetch-Site other than same-origin: 403 cross_site_request, nothing changes); a Carbon
 *   can't manage another Carbon's app through it; /auth/callback only accepts a state this browser started (no login
 *   CSRF), never reflects a provider's error text, and is single use; return_to never leaves the site; sign-out ends
 *   the developer platform's sign-in only (a copied cookie is dead afterwards, the account site stays signed in).
 * - security-developer-browser: the same in a real browser: after signing in and walking the owner's pages no response,
 *   storage or script-visible cookie holds a token (the sealed cookie is opened with the stack's secret to know exactly
 *   which values to look for), no request carries an Authorization header, and attacker pages on a same-site and a
 *   cross-site origin can't use the session (forged ATA proof, sign-out).
 */
import type { Journey } from "../../context";
import { DEVELOPER_SIGNED_OUT, newContext, shot, signInOnDeveloper, sleep, tag } from "../../lib";
import {
  DEV_SESSION, DEV_SIGNIN, appOwner, brief, call, developerCallback, developerSignIn, errorOf, flowOf, forgetCodesTo, jwtClaims, raw, remember, sealDeveloper, signInWithEmail, sparePort,
  stackDeveloperSecret, startFlow, unsealDeveloper, viaBff, viaSite, advance, Jar, type DeveloperSession,
} from "./_helpers";

const JWT = /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}/;
const REFRESH = /\bsar_[A-Za-z0-9_-]{30,}/;
const OWNED = "acme-notes";
const FOREIGN_APP = "briefcase";

interface ConfigBody {
  config_version?: number;
  signin_config?: { copy?: { title?: string | null } };
}

const bff: Journey = {
  name: "security-developer-bff",
  title: "the developer site's BFF over HTTP: the sign-in round trip (state + PKCE sealed, code exchanged server side), its cookies' flags, a sealed value nobody can read or forge, only the developer audience's routes forwarded (no traversal, never the browser's cookies), every write from another Origin / no Origin / Sec-Fetch-Site cross-site refused 403 and changing nothing, another Carbon's app refused, /auth/callback bound to the browser's own state (no login CSRF, no reflected error, single use), return_to never off the site, sign-out ending only the developer platform's sign-in",
  engines: ["chromium"],
  async run(ctx) {
    const { env, results } = ctx;
    const t = viaSite(ctx);
    const developerOrigin = new URL(env.developer).origin;
    const secret = stackDeveloperSecret(env);
    const owner = appOwner(OWNED);
    await forgetCodesTo(env, owner.email);
    const account = await signInWithEmail(t, { email: owner.email });
    remember(ctx, "session cookie", account.jar.get("sa_session"));
    remember(ctx, "code", account.code);

    // 1. The sign-in round trip.
    const signIn = await developerSignIn(t, account.jar, { returnTo: `/apps/${OWNED}` });
    const pending = signIn.devJar.seen.find(cookie => cookie.name === DEV_SIGNIN && cookie.value);
    const authorize = signIn.authorize;
    results.check("GET /auth/sign-in sends the browser to the account site's /authorize as the app developer, to {developer}/auth/callback, with a fresh state and a PKCE S256 challenge (nothing secret in the address)", authorize.origin === new URL(env.site).origin && authorize.pathname === "/authorize" && authorize.searchParams.get("app_id") === "developer" && authorize.searchParams.get("redirect_uri") === developerCallback(env) && (authorize.searchParams.get("state") ?? "").length >= 16 && /^[A-Za-z0-9_-]{43}$/.test(authorize.searchParams.get("code_challenge") ?? "") && authorize.searchParams.get("code_challenge_method") === "S256" && !authorize.searchParams.has("code_verifier"), authorize.href.replace(/state=[^&]+/, "state=…").replace(/code_challenge=[^&]+/, "code_challenge=…"));
    const signinProblems: string[] = [];
    if (!pending) signinProblems.push("no sa_dev_signin");
    else {
      const a = pending.attributes;
      if (!a.has("httponly")) signinProblems.push("not HttpOnly");
      if ((a.get("samesite") ?? "").toLowerCase() !== "lax") signinProblems.push(`SameSite=${a.get("samesite")}`);
      if (a.get("path") !== "/") signinProblems.push(`Path=${a.get("path")}`);
      if (a.has("domain")) signinProblems.push(`Domain=${a.get("domain")}`);
      if (Number(a.get("max-age")) !== 600) signinProblems.push(`Max-Age=${a.get("max-age")}`);
      if (!/^v1\.[A-Za-z0-9_-]{40,}$/.test(pending.value)) signinProblems.push("not a sealed value");
      const opened = unsealDeveloper<Array<{ s: string; v: string; r: string }>>(pending.value, DEV_SIGNIN, secret);
      if (opened && opened.some(entry => entry.v && pending.value.includes(entry.v))) signinProblems.push("the verifier is readable in the cookie");
      if (opened && !opened.some(entry => entry.s === authorize.searchParams.get("state"))) signinProblems.push("its state is not the one sent to /authorize");
    }
    results.check("the pending sign-in cookie sa_dev_signin is HttpOnly, SameSite=Lax, Path=/, host-only, 10 minutes, and sealed (the state and PKCE verifier are not readable in it)", signinProblems.length === 0, signinProblems.join("; ") || pending!.line.replace(/=v1\.[^;]{10}[^;]*/, "=v1.…"));
    const session = signIn.devJar.seen.find(cookie => cookie.name === DEV_SESSION && cookie.value);
    const sealed = signIn.devJar.get(DEV_SESSION) ?? "";
    const opened = unsealDeveloper<DeveloperSession>(sealed, DEV_SESSION, secret);
    remember(ctx, "developer session cookie", sealed);
    remember(ctx, "access token", opened?.at);
    remember(ctx, "refresh token", opened?.rt);
    const sessionProblems: string[] = [];
    if (signIn.callback.status !== 303) sessionProblems.push(`callback ${brief(signIn.callback)}`);
    if (signIn.landed !== `${env.developer}/apps/${OWNED}`) sessionProblems.push(`landed on ${signIn.landed}`);
    if (!session) sessionProblems.push("no sa_dev_session");
    else {
      const a = session.attributes;
      if (!a.has("httponly")) sessionProblems.push("not HttpOnly");
      if ((a.get("samesite") ?? "").toLowerCase() !== "lax") sessionProblems.push(`SameSite=${a.get("samesite")}`);
      if (a.get("path") !== "/") sessionProblems.push(`Path=${a.get("path")}`);
      if (a.has("domain")) sessionProblems.push(`Domain=${a.get("domain")}`);
      if (a.has("secure")) sessionProblems.push("Secure on an http stack (the browser would drop it)");
      const maxAge = Number(a.get("max-age"));
      if (!(maxAge > 86_400 && maxAge <= 400 * 86_400)) sessionProblems.push(`Max-Age=${a.get("max-age")}`);
      if (!/^v1\.[A-Za-z0-9_-]{100,}$/.test(sealed) || JWT.test(sealed) || REFRESH.test(sealed)) sessionProblems.push("its value is not opaque");
    }
    if (!signIn.devJar.seen.some(cookie => cookie.name === DEV_SIGNIN && cookie.attributes.get("max-age") === "0")) sessionProblems.push("the finished pending sign-in is not cleared");
    if (JWT.test(signIn.callback.text) || REFRESH.test(signIn.callback.text) || (opened && [...signIn.callback.headers.values()].some(value => value.includes(opened.at) || value.includes(opened.rt)))) sessionProblems.push("the callback answer carries a token");
    results.check("/auth/callback exchanges the code on the server and answers 303 back to return_to with only an opaque, sealed sa_dev_session (HttpOnly, SameSite=Lax, Path=/, host-only, no Secure on http, at most 400 days) and the pending sign-in cleared; no token in its answer", sessionProblems.length === 0, sessionProblems.join("; ") || `${signIn.callback.status} → ${signIn.landed}; ${session!.line.replace(/=v1\.[^;]{10}[^;]*/, "=v1.…")}`);
    results.check("the sealed session opens only with the server's secret: it holds the developer platform's tokens for the owner (aud=developer, a sar_ refresh token)", !!opened && jwtClaims(opened.at).aud === "developer" && jwtClaims(opened.at).sub === account.uuid && /^sar_/.test(opened.rt) && opened.sub === account.uuid, opened ? `aud ${jwtClaims(opened.at).aud}, sub ${jwtClaims(opened.at).sub} (${account.id})` : `could not be opened with the stack's secret (${secret.slice(0, 20)}…)`);

    // 2. The BFF in use: answers carry the account's data, never its tokens.
    const meReply = await viaBff<{ uuid?: string }>(env, signIn.devJar, "/me", { ip: ctx.ip });
    const appReply = await viaBff(env, signIn.devJar, `/apps/${OWNED}`, { ip: ctx.ip });
    const usersReply = await viaBff(env, signIn.devJar, `/apps/${OWNED}/users?limit=5`, { ip: ctx.ip });
    const leaked = [meReply, appReply, usersReply].filter(reply => JWT.test(reply.text) || REFRESH.test(reply.text) || (opened && (reply.text.includes(opened.at) || reply.text.includes(opened.rt))) || [...reply.headers].some(([name, value]) => name === "authorization" || (opened ? value.includes(opened.at) : false)) || reply.setCookies.some(cookie => cookie.value && !cookie.value.startsWith("v1.")));
    results.check("through the BFF the owner reads their account and their app (me, the app, its users) and no answer carries a token, an Authorization header or a readable cookie", meReply.status === 200 && meReply.body.uuid === account.uuid && appReply.status === 200 && usersReply.status === 200 && leaked.length === 0, `me ${meReply.status}, app ${appReply.status}, users ${usersReply.status}; ${leaked.length} answers with a token`);

    // 3. Only the developer audience's routes are forwarded, and never the browser's own cookies.
    const notForwarded: Array<[string, string, unknown]> = [
      ["GET", "/me/silicons", undefined],
      ["GET", "/me/apps", undefined],
      ["GET", "/me/sessions", undefined],
      ["GET", "/me/emails", undefined],
      ["GET", "/me/proofs", undefined],
      ["GET", "/me/history", undefined],
      ["PATCH", "/me", { display_name: "BFF was here" }],
      ["DELETE", "/me", undefined],
      ["POST", "/me/short-lived-tokens", { app_id: "remind" }],
      ["POST", "/me/silicons", { id: `si:bff-${tag()}`, display_name: "x" }],
      ["POST", "/proofs/ata", { receiving_app: "remind" }],
      ["POST", "/proofs/verify", { proof_token: "x" }],
      ["POST", "/oauth/token", { grant_type: "refresh_token" }],
      ["POST", "/oauth/revoke", { token: "x" }],
      ["GET", "/userinfo", undefined],
      ["POST", "/device/authorize", {}],
      ["GET", `/accounts/by-id/${encodeURIComponent(account.id)}`, undefined],
      ["POST", "/internal/apps/sync", {}],
      ["GET", "/dev/outbox", undefined],
      ["GET", "/flows/x", undefined],
    ];
    const forwarded: string[] = [];
    for (const [method, path, json] of notForwarded) {
      const reply = await viaBff(env, signIn.devJar, path, { method, ...(json !== undefined ? { json } : {}), ip: ctx.ip });
      if (reply.status !== 404 || errorOf(reply).code !== "not_proxied") forwarded.push(`${method} ${path}: ${brief(reply)}`);
    }
    const traversals = [
      `/api/accounts/apps/${OWNED}/../../me/silicons`,
      `/api/accounts/apps/${OWNED}/%2e%2e/%2e%2e/me/silicons`,
      `/api/accounts/apps/${OWNED}%2F..%2F..%2Fme%2Fsilicons`,
      `/api/accounts/apps/${OWNED}/%2E%2E%2Fme`,
      `/api/accounts/apps/${OWNED}/..%5C..%5Cme%5Csilicons`,
      "/api/accounts/apps/%2e%2e/me/silicons",
      "/api/accounts//me/silicons",
      "/api/accounts/apps//me",
      `/api/accounts/apps/${OWNED}/%252e%252e/%252e%252e/me/silicons`,
    ];
    const cookieHeader = signIn.devJar.header() ?? "";
    for (const path of traversals) {
      const reply = await raw(env.developer, path, { headers: { cookie: cookieHeader, "x-forwarded-for": ctx.ip } });
      let body: { error?: { code?: string }; items?: unknown[] } = {};
      try {
        body = JSON.parse(reply.text) as typeof body;
      } catch {
        // Not JSON (a page): judged by its status.
      }
      if (reply.status === 200 && Array.isArray(body.items)) forwarded.push(`${path}: 200 with items (forwarded to an account route)`);
      else if (reply.status < 400 && reply.status !== 308 && reply.status !== 307) forwarded.push(`${path}: ${reply.status}`);
    }
    results.check(`the BFF forwards only the developer audience's routes: ${notForwarded.length} other API paths (Silicons, apps signed into, sessions, emails, proofs, history, account changes, SLTs, ATA/verify outside an app, OAuth, userinfo, device flow, lookups, internal sync, the dev outbox, flows) answer 404 not_proxied, and ${traversals.length} traversal spellings (.., %2e%2e, %2f, %5c, //, double encoding) reach no account route`, forwarded.length === 0, forwarded.join(" | ") || "all refused");
    const accountCookieOnly = await call(`${env.developer}/api/accounts/me`, { headers: { cookie: `sa_session=${account.jar.get("sa_session")}` }, ip: ctx.ip });
    results.check("the BFF never uses the browser's own Silicon Accounts cookie: with only the account site's sa_session (no developer session) /api/accounts/me answers 401 signed_out", accountCookieOnly.status === 401 && errorOf(accountCookieOnly).code === "signed_out", brief(accountCookieOnly));

    // 4. Cookies that aren't the server's own sealed session.
    const flip = (value: string) => `${value.slice(0, -6)}${value.slice(-6, -5) === "A" ? "B" : "A"}${value.slice(-5)}`;
    const forgedCookies: Array<[string, string]> = [
      ["a tampered sealed value (one character changed)", flip(sealed)],
      ["the session sealed for the sa_dev_signin purpose", opened ? sealDeveloper(opened, DEV_SIGNIN, secret) : "v1.x"],
      ["the session sealed with another secret", opened ? sealDeveloper(opened, DEV_SESSION, `another-secret-${tag()}-0123456789abcdef0123456789`) : "v1.x"],
      ["v1. and garbage", `v1.${"A".repeat(120)}`],
      ["the access token in clear", opened?.at ?? "x"],
      ["an empty value", ""],
    ];
    const accepted: string[] = [];
    for (const [label, value] of forgedCookies) {
      const reply = await call(`${env.developer}/api/accounts/me`, { headers: { cookie: `${DEV_SESSION}=${value}` }, ip: ctx.ip });
      if (reply.status !== 401 || errorOf(reply).code !== "signed_out") accepted.push(`${label}: ${brief(reply)}`);
    }
    results.check(`cookies that aren't this server's sealed session are no session (${forgedCookies.length}: tampered, sealed for another purpose, sealed with another secret, garbage, the token in clear, empty): 401 signed_out, never a 500`, accepted.length === 0, accepted.join(" | ") || "all 401 signed_out");
    // A cookie sealed with the server's own secret but holding briefcase's app token instead: the API decides, not the cookie.
    const appTokenSession = opened ? sealDeveloper({ ...opened, at: `${opened.at.slice(0, -4)}AAAA`, rt: `sar_${"Z".repeat(43)}` }, DEV_SESSION, secret) : "";
    const forgedSession = await call(`${env.developer}/api/accounts/apps/${OWNED}`, { headers: { cookie: `${DEV_SESSION}=${appTokenSession}` }, ip: ctx.ip });
    results.check("a session forged with the server's own secret around a broken access token and a made-up refresh token gets nothing (401 signed_out; the API decides, not the cookie) and is cleared", forgedSession.status === 401 && errorOf(forgedSession).code === "signed_out" && forgedSession.setCookies.some(cookie => cookie.name === DEV_SESSION && cookie.attributes.get("max-age") === "0"), `${brief(forgedSession)}; Set-Cookie ${forgedSession.setCookies.map(cookie => `${cookie.name} Max-Age=${cookie.attributes.get("max-age")}`).join(", ") || "none"}`);

    // 5. CSRF: every write needs this site's Origin (and, when sent, Sec-Fetch-Site: same-origin).
    const configOf = async () => (await viaBff<ConfigBody>(env, signIn.devJar, `/apps/${OWNED}`, { ip: ctx.ip })).body;
    const before = await configOf();
    const proofsBefore = ((await viaBff<{ items?: unknown[] }>(env, signIn.devJar, `/apps/${OWNED}/proofs?limit=100`, { ip: ctx.ip })).body.items ?? []).length;
    const attackers: Array<[string, string | null, Record<string, string>]> = [
      ["another site", "https://evil.example", {}],
      ["the account site (a sibling site in production)", new URL(env.site).origin, {}],
      ["the same host on another port", `http://localhost:${sparePort(env, 6)}`, {}],
      ["127.0.0.1 for the site's localhost (a production build allows only its own origin)", `http://127.0.0.1:${new URL(env.developer).port}`, {}],
      ["the site's host over https", `https://localhost:${new URL(env.developer).port}`, {}],
      ['the opaque origin "null"', "null", {}],
      ["no Origin header", null, {}],
      ["the right Origin but Sec-Fetch-Site: cross-site", developerOrigin, { "sec-fetch-site": "cross-site" }],
      ["the right Origin but Sec-Fetch-Site: same-site", developerOrigin, { "sec-fetch-site": "same-site" }],
    ];
    const writes: Array<[string, string, string, unknown]> = [
      ["change the sign-in title", "PATCH", `/apps/${OWNED}/signin-config`, { copy: { title: `CSRF ${tag()}` } }],
      ["add a redirect URI", "PATCH", `/apps/${OWNED}/signin-config`, { redirect_uris: ["https://evil.example/cb"] }],
      ["make an ATA proof", "POST", `/apps/${OWNED}/proofs/ata`, { receiving_app: "remind" }],
      ["set the webhook", "PUT", `/apps/${OWNED}/webhook`, { url: "https://evil.example/hook" }],
      ["remove the webhook", "DELETE", `/apps/${OWNED}/webhook`, undefined],
    ];
    const csrfFailures: string[] = [];
    let csrfTries = 0;
    for (const [label, origin, headers] of attackers) {
      for (const [what, method, path, json] of writes) {
        csrfTries++;
        const reply = await viaBff(env, signIn.devJar.clone(), path, { method, ...(json !== undefined ? { json } : { body: "" }), origin, headers: { ...headers, "idempotency-key": `sec-${tag()}${tag()}` }, ip: ctx.ip });
        if (reply.status !== 403 || errorOf(reply).code !== "cross_site_request" || reply.setCookies.length) csrfFailures.push(`${what} from ${label}: ${brief(reply)}${reply.setCookies.length ? " (sets a cookie)" : ""}`);
      }
      const out = await call(`${env.developer}/auth/sign-out`, { method: "POST", body: "", jar: signIn.devJar.clone(), origin, headers, ip: ctx.ip });
      csrfTries++;
      if (out.status !== 403 || out.setCookies.length) csrfFailures.push(`sign-out from ${label}: ${brief(out)}${out.setCookies.length ? ` (Set-Cookie ${out.setCookies.map(cookie => cookie.name).join(", ")})` : ""}`);
    }
    const after = await configOf();
    const proofsAfter = ((await viaBff<{ items?: unknown[] }>(env, signIn.devJar, `/apps/${OWNED}/proofs?limit=100`, { ip: ctx.ip })).body.items ?? []).length;
    const stillIn = await viaBff(env, signIn.devJar, "/me", { ip: ctx.ip });
    results.check(`every write through the BFF (${writes.length} kinds: sign-in setup ×2, an ATA proof, the webhook ×2, and sign-out) from ${attackers.length} wrong origins (another site, the account site, another port, 127.0.0.1, https, "null", none, Sec-Fetch-Site cross-site / same-site) is refused 403 cross_site_request without a cookie change (${csrfTries} tries)`, csrfFailures.length === 0, csrfFailures.slice(0, 6).join(" | ") || `${csrfTries} × 403`);
    results.check("…and nothing changed: the same sign-in title and config version, no new proof, still signed in to the developer site", after.config_version === before.config_version && after.signin_config?.copy?.title === before.signin_config?.copy?.title && proofsAfter === proofsBefore && stillIn.status === 200, `version ${before.config_version} → ${after.config_version}; title ${before.signin_config?.copy?.title} → ${after.signin_config?.copy?.title}; proofs ${proofsBefore} → ${proofsAfter}; me ${stillIn.status}`);
    const title = `Acme ${tag()}`;
    const ok = await viaBff<ConfigBody>(env, signIn.devJar, `/apps/${OWNED}/signin-config`, { method: "PATCH", json: { copy: { title } }, headers: { "sec-fetch-site": "same-origin", "idempotency-key": `sec-${tag()}${tag()}` }, ip: ctx.ip });
    const restored = await viaBff<ConfigBody>(env, signIn.devJar, `/apps/${OWNED}/signin-config`, { method: "PATCH", json: { copy: { title: before.signin_config?.copy?.title ?? null } }, headers: { "sec-fetch-site": "same-origin", "idempotency-key": `sec-${tag()}${tag()}` }, ip: ctx.ip });
    results.check("control: the same PATCH from the developer site's own origin (Sec-Fetch-Site: same-origin) is applied (and put back)", ok.status === 200 && ok.body.signin_config?.copy?.title === title && restored.status === 200, `${brief(ok)}; restore ${restored.status}`);

    // 6. Another Carbon's app, and an app that doesn't exist.
    const foreign: Array<[string, string, unknown]> = [
      ["GET", `/apps/${FOREIGN_APP}`, undefined],
      ["GET", `/apps/${FOREIGN_APP}/users`, undefined],
      ["PATCH", `/apps/${FOREIGN_APP}/signin-config`, { redirect_uris: ["https://evil.example/cb"] }],
      ["POST", `/apps/${FOREIGN_APP}/proofs/ata`, { receiving_app: "remind" }],
      ["GET", `/apps/${FOREIGN_APP}/webhook/deliveries`, undefined],
      ["POST", `/apps/${FOREIGN_APP}/imports?dry_run=true`, { rows: [] }],
    ];
    const foreignLeaks: string[] = [];
    for (const [method, path, json] of foreign) {
      const reply = await viaBff(env, signIn.devJar, path, { method, ...(json !== undefined ? { json } : {}), headers: { "idempotency-key": `sec-${tag()}${tag()}` }, ip: ctx.ip });
      if (reply.status !== 403 || errorOf(reply).code !== "not_app_owner") foreignLeaks.push(`${method} ${path}: ${brief(reply)}`);
    }
    const unknownApp = await viaBff(env, signIn.devJar, `/apps/no-such-app-${tag()}`, { ip: ctx.ip });
    results.check(`through the BFF the owner of ${OWNED} gets 403 not_app_owner on ${foreign.length} routes of ${FOREIGN_APP} (another Carbon's app: details, users, sign-in setup, ATA proof, deliveries, import), and 404 for an app that doesn't exist`, foreignLeaks.length === 0 && unknownApp.status === 404, `${foreignLeaks.join(" | ") || "all 403"}; unknown app ${brief(unknownApp)}`);

    // 7. /auth/callback: only a state this browser started; never the provider's words; single use.
    const attacker = await signInWithEmail(t, { label: "devattacker" });
    remember(ctx, "session cookie", attacker.jar.get("sa_session"));
    remember(ctx, "code", attacker.code);
    // The attacker starts a developer sign-in in their own browser and stops at the callback: their code and state.
    const attackerDev = new Jar();
    const attackerStart = await call(`${env.developer}/auth/sign-in`, { jar: attackerDev, ip: ctx.ip });
    const attackerParams = Object.fromEntries(new URL(attackerStart.headers.get("location") ?? "", env.developer).searchParams) as Record<string, string>;
    const attackerFlow = flowOf(await startFlow(t, attacker.jar, { ...attackerParams, app_id: "developer", redirect_uri: attackerParams.redirect_uri ?? "" }));
    const attackerDone = attackerFlow ? await advance(t, attacker.jar, attackerFlow) : null;
    const attackerCallback = attackerDone?.redirect_to ?? "";
    remember(ctx, "code", attackerCallback ? new URL(attackerCallback).searchParams.get("code") : null);
    // The victim's browser (signed in to nothing, or with a sign-in of its own pending) is sent to that callback.
    const victimDev = new Jar();
    await call(`${env.developer}/auth/sign-in`, { jar: victimDev, ip: ctx.ip });
    const planted = await call(attackerCallback || `${env.developer}/auth/callback?code=x&state=y`, { jar: victimDev, ip: ctx.ip });
    const plantedTo = planted.headers.get("location") ?? "";
    const victimMe = await call(`${env.developer}/api/accounts/me`, { jar: victimDev, ip: ctx.ip });
    results.check("login CSRF: the attacker's own code and state delivered to another browser's /auth/callback is refused (303 to /sign-in?error=state_mismatch), that browser gets no session, so it is never signed in as the attacker", !!attackerCallback && planted.status === 303 && new URL(plantedTo, env.developer).pathname === "/sign-in" && new URL(plantedTo, env.developer).searchParams.get("error") === "state_mismatch" && !victimDev.get(DEV_SESSION) && victimMe.status === 401, `${planted.status} → ${plantedTo}; victim session ${victimDev.get(DEV_SESSION) ? "SET" : "none"}; /me ${victimMe.status}`);
    const victimState = new URL((await call(`${env.developer}/auth/sign-in`, { jar: victimDev, ip: ctx.ip })).headers.get("location") ?? "", env.developer).searchParams.get("state") ?? "";
    const hostileErrors: Array<[string, string]> = [
      ["a known error with hostile words", `error=access_denied&error_description=${encodeURIComponent("<script>alert(1)</script> Call +1 555 0100 to restore access")}`],
      ["an error code that is markup", `error=${encodeURIComponent("<img src=x onerror=alert(1)>")}`],
      ["a code and an error together", `code=sac_${"x".repeat(43)}&error=server_error`],
    ];
    const reflected: string[] = [];
    for (const [label, query] of hostileErrors) {
      await call(`${env.developer}/auth/sign-in`, { jar: victimDev, ip: ctx.ip });
      const fresh = unsealDeveloper<Array<{ s: string }>>(victimDev.get(DEV_SIGNIN), DEV_SIGNIN, secret)?.slice(-1)[0]?.s ?? victimState;
      const reply = await call(`${env.developer}/auth/callback?state=${encodeURIComponent(fresh)}&${query}`, { jar: victimDev, ip: ctx.ip });
      const location = new URL(reply.headers.get("location") ?? "/", env.developer);
      const page = await call(location.href, { headers: { accept: "text/html" }, ip: ctx.ip });
      const code = location.searchParams.get("error") ?? "";
      if (reply.status !== 303 || location.origin !== developerOrigin || location.pathname !== "/sign-in" || !/^[a-z_]{1,48}$/.test(code) || [...location.searchParams.keys()].some(key => key !== "error") || /<script>alert|onerror=alert|555 0100/.test(page.text) || victimDev.get(DEV_SESSION)) reflected.push(`${label}: ${reply.status} → ${location.href}${/<script>alert|onerror=alert|555 0100/.test(page.text) ? " (the page shows the provider's words)" : ""}`);
    }
    results.check(`/auth/callback never carries a provider's words: ${hostileErrors.length} hostile error answers land on /sign-in?error=<a plain code> (the description dropped, markup turned into sign_in_failed), the page shows fixed words, and no session is made`, reflected.length === 0, reflected.join(" | ") || "all fixed codes");
    const ownStart = await developerSignIn(t, account.jar, { returnTo: "/" });
    const replay = await call(ownStart.flow.redirect_to ?? "", { jar: ownStart.devJar.clone(), ip: ctx.ip });
    const replayTo = new URL(replay.headers.get("location") ?? "/", env.developer);
    results.check("a used callback address (its code and state) replayed in the same browser is refused (state_mismatch) and makes no new session", ownStart.callback.status === 303 && replay.status === 303 && replayTo.pathname === "/sign-in" && replayTo.searchParams.get("error") === "state_mismatch" && !replay.setCookies.some(cookie => cookie.name === DEV_SESSION && cookie.value), `${replay.status} → ${replayTo.pathname}${replayTo.search}`);
    remember(ctx, "developer session cookie", ownStart.devJar.get(DEV_SESSION));

    // 8. return_to never leaves the site (a whole round trip each, continuing as the account site's Carbon).
    const payloads: Array<[string, string | null]> = [
      ["//evil.example/x", "/"],
      ["/\\evil.example/x", "/"],
      ["https://evil.example/x", "/"],
      ["/\t/evil.example/x", "/"],
      ["javascript:alert(document.domain)", "/"],
      [`http://localhost:${new URL(env.developer).port}@evil.example/`, "/"],
      ["/%2F%2Fevil.example/x", null],
      ["/auth/callback?code=x&state=y", "/"],
      ["/api/accounts/me", "/"],
      ["/sign-in?return_to=//evil.example", "/"],
      [`/apps/${OWNED}/ata?tab=1#proofs`, `/apps/${OWNED}/ata?tab=1#proofs`],
    ];
    const strays: string[] = [];
    const landings: string[] = [];
    for (const [payload, want] of payloads) {
      const trip = await developerSignIn(t, account.jar, { returnTo: payload });
      remember(ctx, "developer session cookie", trip.devJar.get(DEV_SESSION));
      const landed = new URL(trip.landed);
      landings.push(`${JSON.stringify(payload)} → ${landed.pathname}${landed.search}${landed.hash}`);
      if (landed.origin !== developerOrigin || (want !== null && `${landed.pathname}${landed.search}${landed.hash}` !== want)) strays.push(`${JSON.stringify(payload)} → ${trip.landed}`);
    }
    results.check(`return_to never leaves the developer site: ${payloads.length} round trips (//, /\\, absolute, tab, javascript:, userinfo, encoded //, the auth and API routes, a nested return_to) land on the site (on / for anything unsafe), and a real path of the site comes back exactly`, strays.length === 0, strays.join(" | ") || landings.slice(0, 4).join(", "));

    // 9. Sign-out: the developer platform's sign-in ends (a copied cookie is dead), the account site's doesn't.
    const copied = signIn.devJar.get(DEV_SESSION) ?? "";
    const out = await call(`${env.developer}/auth/sign-out`, { method: "POST", body: "", jar: signIn.devJar, origin: developerOrigin, headers: { "sec-fetch-site": "same-origin" }, ip: ctx.ip });
    const cleared = out.setCookies.some(cookie => cookie.name === DEV_SESSION && cookie.attributes.get("max-age") === "0");
    const replayed = await call(`${env.developer}/api/accounts/apps/${OWNED}`, { headers: { cookie: `${DEV_SESSION}=${copied}` }, ip: ctx.ip });
    const direct = opened ? await call(`${env.site}/v1/apps/${OWNED}`, { bearer: opened.at, ip: ctx.ip }) : null;
    const refreshed = opened ? await call<{ error?: string }>(`${env.site}/v1/oauth/token`, { form: { grant_type: "refresh_token", refresh_token: opened.rt, client_id: "developer" }, ip: ctx.ip }) : null;
    const accountStill = await call(`${env.site}/v1/session`, { jar: account.jar, ip: ctx.ip });
    results.check("sign-out (POST /auth/sign-out from the site) answers 204 and clears sa_dev_session; the copied old cookie is dead (401), its access token is refused by the API and its refresh token can't be used; the account site's own session is untouched", out.status === 204 && cleared && replayed.status === 401 && direct?.status === 401 && refreshed?.status === 400 && accountStill.status === 200, `sign-out ${brief(out)}${cleared ? " (cleared)" : ""}; old cookie → ${brief(replayed)}; its access token → ${direct ? brief(direct) : "?"}; its refresh token → ${refreshed ? brief(refreshed) : "?"}; account site session ${accountStill.status}`);
  },
};

const browserWalk: Journey = {
  name: "security-developer-browser",
  title: "the developer site in a real browser: signed in through the BFF and walking an owner's pages, no response, storage, script-visible cookie or request ever carries the developer platform's tokens (checked against the sealed cookie's real values) or any token-shaped value; a same-site and a cross-site attacker page can neither make an ATA proof nor sign the developer out",
  async run(ctx) {
    const { env, results, browser } = ctx;
    const t = viaSite(ctx);
    const secret = stackDeveloperSecret(env);
    const owner = appOwner(OWNED);
    await forgetCodesTo(env, owner.email);
    const account = await signInWithEmail(t, { email: owner.email });
    remember(ctx, "session cookie", account.jar.get("sa_session"));
    remember(ctx, "code", account.code);

    const context = await newContext(browser);
    const host = new URL(env.site).hostname;
    await context.addCookies([{ name: "sa_session", value: account.jar.get("sa_session") ?? "", domain: host, path: "/", httpOnly: true, sameSite: "Lax", secure: false, expires: Math.floor(Date.now() / 1000) + 3600 }]);
    // The stack seeds the fake apps' owners with photos on the production Iris (scripts/dev.sh seeds without
    // ACCOUNTS_IRIS_BASE_URL): nothing a page loads may leave the machine, so those photos come from the mock Iris here.
    const productionIris: string[] = [];
    await context.route(url => url.hostname === "iris.teamofsilicons.com", async route => {
      const url = new URL(route.request().url());
      productionIris.push(url.href);
      try {
        await route.fulfill({ response: await route.fetch({ url: `${env.iris}${url.pathname}${url.search}` }) });
      } catch {
        await route.abort().catch(() => undefined);
      }
    });
    const page = await context.newPage();
    // The encoded-// return_to payload is a path of the site itself, which has no such page: its 404 is expected.
    results.watch(page, "developer-browser", [DEVELOPER_SIGNED_OUT, /status of 404 \(Not Found\) @ https?:\/\/[^/ ]+\/%2F%2Fevil\.example\/x/]);
    const bodies: Array<{ url: string; text: string }> = [];
    const authorizations: string[] = [];
    page.on("request", request => {
      const headers = request.headers();
      if (headers.authorization) authorizations.push(`${request.method()} ${request.url()}`);
    });
    page.on("response", response => {
      const type = response.headers()["content-type"] ?? "";
      if (!/json|text|javascript|x-component/.test(type) || response.status() >= 300) return;
      void response.text().then(text => bodies.push({ url: response.url(), text }), () => undefined);
    });
    await signInOnDeveloper(env, page, null, { returnTo: `/apps/${OWNED}` });
    for (const path of ["/", `/apps/${OWNED}`, `/apps/${OWNED}/users`, `/apps/${OWNED}/sign-in`, `/apps/${OWNED}/webhooks`, `/apps/${OWNED}/ata`, `/apps/${OWNED}/embed`]) {
      await page.goto(`${env.developer}${path}`);
      await page.waitForLoadState("networkidle").catch(() => undefined);
      await sleep(150);
    }
    await shot(env, page, "security-developer-browser-01-ata");
    const cookies = await context.cookies(env.developer);
    const sealedCookie = cookies.find(cookie => cookie.name === DEV_SESSION);
    const opened = unsealDeveloper<DeveloperSession>(sealedCookie?.value, DEV_SESSION, secret);
    remember(ctx, "developer session cookie", sealedCookie?.value);
    remember(ctx, "access token", opened?.at);
    remember(ctx, "refresh token", opened?.rt);
    results.check("signed in through the BFF, the browser holds the developer session only as an httpOnly, SameSite=Lax cookie, sealed (it opens with the server's secret to aud=developer tokens)", !!sealedCookie && sealedCookie.httpOnly && sealedCookie.sameSite === "Lax" && !!opened && jwtClaims(opened.at).aud === "developer", sealedCookie ? `httpOnly ${sealedCookie.httpOnly}, sameSite ${sealedCookie.sameSite}, opens: ${opened ? "yes" : "NO"}` : "no sa_dev_session");
    const storage = await page.evaluate(() => {
      const all: string[] = [document.cookie];
      for (const store of [localStorage, sessionStorage]) for (let i = 0; i < store.length; i++) all.push(`${store.key(i)}=${store.getItem(store.key(i) ?? "")}`);
      return all.join("\n");
    });
    const exact = opened ? [opened.at, opened.rt, opened.at.split(".")[2] ?? "~"] : [];
    await sleep(500);
    const inBodies = bodies.filter(body => JWT.test(body.text) || REFRESH.test(body.text) || exact.some(value => value && body.text.includes(value)));
    const inStorage = JWT.test(storage) || REFRESH.test(storage) || exact.some(value => value && storage.includes(value)) || storage.includes(DEV_SESSION);
    results.check(`no token reaches the browser: none of ${bodies.length} responses (pages, scripts, RSC payloads, the BFF's JSON) holds the session's access or refresh token or anything token-shaped, nor do document.cookie, localStorage or sessionStorage, and no request carries an Authorization header`, !!opened && inBodies.length === 0 && !inStorage && authorizations.length === 0, `${inBodies.map(body => body.url).slice(0, 3).join(", ") || "no response"}; storage ${inStorage ? "HOLDS a token" : "clean"} (${storage.length} chars); Authorization on ${authorizations.slice(0, 3).join(", ") || "no request"}`);

    // Signed in, the developer site's /sign-in sends the browser straight on to return_to: only a path of the site may
    // come through (the client-side twin of the BFF's own return_to rule).
    const evilHits: string[] = [];
    await context.route(url => url.hostname === "evil.example" || url.hostname.endsWith(".evil.example"), route => {
      evilHits.push(route.request().url());
      return route.fulfill({ contentType: "text/html", body: "<title>evil</title>evil" });
    });
    const dialogs: string[] = [];
    page.on("dialog", dialog => {
      dialogs.push(dialog.message());
      void dialog.dismiss();
    });
    const returnPayloads = ["//evil.example/x", "/\\evil.example/x", "https://evil.example/x", "/\t/evil.example/x", "javascript:window.__pwned=1", `http://localhost:${new URL(env.developer).port}@evil.example/`, "/%2F%2Fevil.example/x", "https:evil.example"];
    const escaped: string[] = [];
    for (const payload of returnPayloads) {
      await page.goto(`${env.developer}/sign-in?return_to=${encodeURIComponent(payload)}`);
      await page.waitForURL(url => url.pathname !== "/sign-in", { timeout: 15_000 }).catch(() => undefined);
      await page.waitForLoadState("networkidle").catch(() => undefined);
      await sleep(300);
      if (new URL(page.url()).origin !== new URL(env.developer).origin) escaped.push(`${JSON.stringify(payload)} → ${page.url()}`);
    }
    const pwned = await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned ?? null).catch(() => null);
    results.check(`a signed-in browser opening the developer site's /sign-in?return_to=<foreign> stays on the developer site for ${returnPayloads.length} payloads (//, /\\, absolute, tab, javascript:, userinfo, encoded //, https:host) and runs nothing`, escaped.length === 0 && evilHits.length === 0 && pwned === null && dialogs.length === 0, escaped.join(" | ") || `last at ${page.url()}; evil hits ${evilHits.length}`);

    // Attacker pages: a same-site one (another port of localhost: the cookie goes along) and a cross-site one.
    const sameSite = `http://localhost:${sparePort(env, 6)}`;
    const crossSite = `http://127.0.0.1:${sparePort(env, 6)}`;
    const attackerPage = `<!doctype html><title>attacker</title>
<form id="signout" method="POST" action="${env.developer}/auth/sign-out"></form>
<form id="ata" method="POST" action="${env.developer}/api/accounts/apps/${OWNED}/proofs/ata" enctype="text/plain"><input name='{"receiving_app":"remind","x":"' value='"}'></form>
<script>
window.shoot = async () => {
  const out = {};
  try { const r = await fetch(${JSON.stringify(`${env.developer}/api/accounts/apps/${OWNED}/proofs/ata`)}, { method: "POST", mode: "no-cors", credentials: "include", headers: { "content-type": "text/plain" }, body: '{"receiving_app":"remind"}' }); out.fetch = "sent " + r.type; } catch (e) { out.fetch = "error " + e; }
  try { const r = await fetch(${JSON.stringify(`${env.developer}/api/accounts/me`)}, { credentials: "include" }); out.read = "read " + r.status + " " + (await r.text()).slice(0, 60); } catch (e) { out.read = "blocked"; }
  return out;
};
</script>`;
    await context.route(`${sameSite}/**`, route => route.fulfill({ contentType: "text/html", body: attackerPage }));
    await context.route(`${crossSite}/**`, route => route.fulfill({ contentType: "text/html", body: attackerPage }));
    const attackerTab = await context.newPage();
    const answers: Array<{ url: string; method: string; status: number }> = [];
    attackerTab.on("response", response => {
      if (response.url().startsWith(env.developer)) answers.push({ url: response.url().slice(env.developer.length), method: response.request().method(), status: response.status() });
    });
    const proofs = async () => ((await page.evaluate(async url => (await (await fetch(url)).json()) as { items?: unknown[] }, `${env.developer}/api/accounts/apps/${OWNED}/proofs?limit=100`).catch(() => ({ items: undefined }))).items ?? []).length;
    const proofsBefore = await proofs();
    const outcomes: string[] = [];
    const failures: string[] = [];
    for (const [kind, origin] of [
      ["same-site", sameSite],
      ["cross-site", crossSite],
    ] as const) {
      answers.length = 0;
      await attackerTab.goto(`${origin}/fetch.html`);
      const shot1 = await attackerTab.evaluate(() => (window as unknown as { shoot: () => Promise<Record<string, string>> }).shoot());
      await sleep(400);
      const fetchAnswer = answers.find(answer => answer.method === "POST" && answer.url.includes("/proofs/ata"));
      // Each promise gets its handlers at once: a navigation that fails before it is awaited must not crash the walk.
      const ataForm = attackerTab.waitForResponse(response => response.url().includes("/proofs/ata") && response.request().method() === "POST", { timeout: 15_000 }).then(response => response.status(), () => 0);
      await attackerTab.goto(`${origin}/form.html`);
      await attackerTab.evaluate(() => (document.getElementById("ata") as HTMLFormElement).submit());
      const formStatus = await ataForm;
      await attackerTab.waitForURL(url => url.href.startsWith(env.developer), { timeout: 10_000 }).catch(() => undefined);
      await attackerTab.waitForLoadState("load").catch(() => undefined);
      const signout = attackerTab.waitForResponse(response => response.url() === `${env.developer}/auth/sign-out`, { timeout: 15_000 }).then(response => response.status(), () => 0);
      await attackerTab.goto(`${origin}/signout.html`);
      await attackerTab.evaluate(() => (document.getElementById("signout") as HTMLFormElement).submit());
      const signoutStatus = await signout;
      await attackerTab.waitForURL(url => url.href.startsWith(env.developer), { timeout: 10_000 }).catch(() => undefined);
      await attackerTab.waitForLoadState("load").catch(() => undefined);
      await sleep(400);
      const held = (await context.cookies(env.developer)).some(cookie => cookie.name === DEV_SESSION && cookie.value === sealedCookie?.value);
      const live = (await call(`${env.developer}/api/accounts/me`, { headers: { cookie: `${DEV_SESSION}=${sealedCookie?.value ?? ""}` }, ip: ctx.ip })).status === 200;
      outcomes.push(`${kind}: fetch ${fetchAnswer?.status ?? "not seen"} (${shot1.fetch}), read ${shot1.read?.slice(0, 20)}, form ATA ${formStatus}, form sign-out ${signoutStatus}, session ${held && live ? "kept" : "LOST"}`);
      if (![403, 401].includes(fetchAnswer?.status ?? 0) || !/blocked/.test(shot1.read ?? "") || ![403, 401].includes(formStatus) || ![403].includes(signoutStatus) || !held || !live) failures.push(outcomes[outcomes.length - 1]!);
    }
    const proofsAfter = await proofs();
    await shot(env, attackerTab, "security-developer-browser-02-attacker");
    results.check("(note) photos the stack's seeded owners have on the production Iris, served from the mock Iris instead", true, `${productionIris.length} requests${productionIris[0] ? ` (e.g. ${productionIris[0]})` : ""}`);
    results.check("attacker pages on a same-site origin (the cookie goes along: 403 by Origin) and a cross-site one (SameSite=Lax keeps it home) can't make an ATA proof (fetch or text/plain form), can't read the BFF, and can't sign the developer out (403); the developer stays signed in and no proof was made", failures.length === 0 && proofsAfter === proofsBefore, `${outcomes.join(" | ")}; proofs ${proofsBefore} → ${proofsAfter}`);
    await context.close();
  },
};

export const journeys: Journey[] = [bff, browserWalk];
