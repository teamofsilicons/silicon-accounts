/**
 * The token endpoint and its neighbours, as an app uses them. PKCE (S256 and plain) is enforced and never
 * downgradable; codes work once, for their own app and redirect_uri, for 120 seconds, and a reused code revokes what
 * it issued; refresh tokens rotate, a reused one revokes the whole sign-in; userinfo, introspection and revocation say
 * exactly what they should and nothing about other apps' tokens. Latencies are recorded as metrics.
 */
import type { Journey } from "../../context";
import { newContext, sql, tag } from "../../lib";
import {
  Browserish,
  appEvents,
  appForm,
  brief,
  exchangeCode,
  fakeApp,
  introspect,
  jwtClaims,
  jwtHeader,
  refresh,
  revoke,
  signUpVia,
  signInAgain,
  stats,
  userinfo,
  type Tokens,
} from "./_helpers";

const pkce: Journey = {
  name: "auth-flows-pkce",
  title: "PKCE: a wrong, missing or unasked-for code_verifier is invalid_grant and burns the code; plain works when asked for; malformed challenges are refused at /authorize; the fake app's tampered verifier fails in the browser",
  async run(ctx) {
    const { env, results, browser } = ctx;
    const t = tag();
    const b = new Browserish(env, ctx.ip);
    const first = await signUpVia(b, "briefcase", `pkce.${t}@example.test`);
    const wrong = await exchangeCode(env, "briefcase", first.code, first.started.redirectUri, "w".repeat(43));
    results.check("S256 with the wrong verifier → 400 invalid_grant \"PKCE verification failed\"", wrong.status === 400 && wrong.body.error === "invalid_grant" && /PKCE verification failed/.test(wrong.body.error_description ?? ""), brief(wrong));
    const right = await exchangeCode(env, "briefcase", first.code, first.started.redirectUri, first.started.verifier);
    results.check("…the code is burned: the right verifier afterwards → invalid_grant (already used)", right.status === 400 && right.body.error === "invalid_grant" && /already used/.test(right.body.error_description ?? ""), brief(right));

    const missing = await signInAgain(b, "briefcase");
    const noVerifier = await exchangeCode(env, "briefcase", missing.code ?? "", missing.started.redirectUri, null);
    results.check("a challenged code without code_verifier → invalid_grant \"code_verifier is required\"", noVerifier.status === 400 && /code_verifier is required/.test(noVerifier.body.error_description ?? ""), brief(noVerifier));
    const late = await exchangeCode(env, "briefcase", missing.code ?? "", missing.started.redirectUri, missing.started.verifier);
    results.check("…and burned too", late.status === 400 && late.body.error === "invalid_grant", brief(late));

    const none = await signInAgain(b, "briefcase", { pkce: "none" });
    const downgrade = await exchangeCode(env, "briefcase", none.code ?? "", none.started.redirectUri, "d".repeat(43));
    results.check("a verifier for a code that had no challenge → invalid_grant (no PKCE downgrade)", downgrade.status === 400 && /downgrade/.test(downgrade.body.error_description ?? ""), brief(downgrade));
    const plainNone = await signInAgain(b, "briefcase", { pkce: "none" });
    const okNone = await exchangeCode(env, "briefcase", plainNone.code ?? "", plainNone.started.redirectUri, null);
    results.check("no challenge and no verifier (a confidential client) → 200", okNone.status === 200, brief(okNone));

    const plain = await signInAgain(b, "briefcase", { pkce: "plain" });
    const plainBad = await exchangeCode(env, "briefcase", plain.code ?? "", plain.started.redirectUri, `${plain.started.verifier ?? ""}x`);
    results.check("plain with a different verifier → invalid_grant", plainBad.status === 400 && plainBad.body.error === "invalid_grant", brief(plainBad));
    const plain2 = await signInAgain(b, "briefcase", { pkce: "plain" });
    const plainOk = await exchangeCode(env, "briefcase", plain2.code ?? "", plain2.started.redirectUri, plain2.started.verifier);
    results.check("plain with the verifier equal to the challenge → 200", plainOk.status === 200, brief(plainOk));
    const shortVerifier = await signInAgain(b, "briefcase");
    const tooShort = await exchangeCode(env, "briefcase", shortVerifier.code ?? "", shortVerifier.started.redirectUri, "abc");
    results.check("a 3-character verifier → invalid_grant that also says the verifier is malformed", tooShort.status === 400 && /also/.test(tooShort.body.error_description ?? ""), brief(tooShort));

    // Malformed challenges never make a flow.
    const c = new Browserish(env, ctx.ip);
    const flowWith = (extra: Record<string, string>) => c.createFlow({ app_id: "briefcase", redirect_uri: first.started.redirectUri, state: "s", ...extra });
    for (const [extra, why] of [
      [{ code_challenge: "a".repeat(42), code_challenge_method: "S256" }, "a 42-character challenge"],
      [{ code_challenge: `${"a".repeat(42)}!`, code_challenge_method: "S256" }, "a challenge with '!'"],
      [{ code_challenge: "a".repeat(43), code_challenge_method: "S512" }, "method S512"],
      [{ code_challenge_method: "S256" }, "a method without a challenge"],
    ] as const) {
      const reply = await flowWith(extra);
      results.check(`${why} → 400 invalid_request (with the error redirect to the app)`, reply.status === 400 && (reply.body as { error?: { code?: string } }).error?.code === "invalid_request", brief(reply));
    }

    // In the browser: the fake app sends a wrong verifier.
    const context = await newContext(browser);
    const page = await context.newPage();
    results.watch(page, "pkce", [/status of 400 .*\/briefcase\/callback/]);
    const session = b.jar.get("sa_session") ?? "";
    await context.addCookies([{ name: "sa_session", value: session, url: env.site, httpOnly: true, sameSite: "Lax" }]);
    await page.goto(`${env.apps}/briefcase/?tamper=verifier`);
    await page.locator("#signin-hosted").click();
    await page.getByRole("button", { name: /^Continue as/ }).click({ timeout: 30_000 });
    await page.waitForURL(new RegExp(`${env.apps.replace(/[.:/]/g, "\\$&")}/briefcase/callback`), { timeout: 30_000 });
    const code = await page.locator("#error-code").innerText().catch(() => "");
    const message = await page.locator("#error-message").innerText().catch(() => "");
    results.check("the fake app with a tampered verifier gets invalid_grant (PKCE) and no account", code === "invalid_grant" && /PKCE/.test(message) && (await page.locator("#account").count()) === 0, `${code}: ${message}`);
    await context.close();
  },
};

const codeReuse: Journey = {
  name: "auth-flows-code-reuse",
  title: "an authorization code works once (a replay revokes the tokens it issued and tells the app), only for its own app, only for 120 seconds (time travel); bad credentials leave it unused; two redemptions at once: one wins and is then revoked",
  async run(ctx) {
    const { env, results } = ctx;
    const t = tag();
    const b = new Browserish(env, ctx.ip);
    const s = await signUpVia(b, "briefcase", `reuse.${t}@example.test`);
    const ttl = await sql(env, `select extract(epoch from expires_at - created_at)::int from authorization_codes where flow_id = '${s.flow.id}'`);
    results.check("an authorization code lives 120 seconds", ttl[0]?.[0] === "120", JSON.stringify(ttl));
    const badSecret = await exchangeCode(env, "briefcase", s.code, s.started.redirectUri, s.started.verifier, { secret: `${fakeApp("briefcase").secret}x` });
    results.check("a wrong client secret → 401 invalid_client", badSecret.status === 401 && badSecret.body.error === "invalid_client", brief(badSecret));
    const first = await exchangeCode(env, "briefcase", s.code, s.started.redirectUri, s.started.verifier, { post: true });
    results.check("…which leaves the code unused: it exchanges (client_secret_post) → 200", first.status === 200 && first.body.token_type === "Bearer" && first.body.refresh_token.startsWith("sar_"), brief(first));
    const uuid = first.body.account?.uuid ?? "";
    const replay = await exchangeCode(env, "briefcase", s.code, s.started.redirectUri, s.started.verifier);
    results.check("the same code again → 400 invalid_grant saying its tokens were revoked", replay.status === 400 && replay.body.error === "invalid_grant" && /revoked/.test(replay.body.error_description ?? ""), brief(replay));
    const afterRefresh = await refresh(env, "briefcase", first.body.refresh_token);
    results.check("…the first exchange's refresh token is dead (authorization_code_reuse)", afterRefresh.status === 400 && /authorization_code_reuse/.test(afterRefresh.body.error_description ?? ""), brief(afterRefresh));
    const active = await introspect(env, "briefcase", first.body.access_token);
    results.check("…its access token introspects inactive", active.status === 200 && active.body.active === false, JSON.stringify(active.body));
    const info = await userinfo(env, first.body.access_token);
    results.check("…and userinfo refuses it (401)", info.status === 401, brief(info));
    const events = await appEvents(env, "briefcase", uuid);
    results.check("briefcase is told membership.signed_out (reason authorization_code_reuse)", events.some(e => e.type === "membership.signed_out" && e.data.reason === "authorization_code_reuse"), JSON.stringify(events));
    const audit = await sql(env, `select actor_id from audit_log where account_uuid = '${uuid}' and action = 'oauth.code_reuse_detected'`);
    results.check("…and the audit log keeps oauth.code_reuse_detected", audit.length === 1 && audit[0]?.[0] === "briefcase", JSON.stringify(audit));

    // Another app's code.
    const other = await signInAgain(b, "briefcase");
    const stolen = await exchangeCode(env, "commit", other.code ?? "", other.started.redirectUri, other.started.verifier);
    results.check("briefcase's code presented by commit → invalid_grant (issued to a different app)", stolen.status === 400 && /different app/.test(stolen.body.error_description ?? ""), brief(stolen));
    const owner = await exchangeCode(env, "briefcase", other.code ?? "", other.started.redirectUri, other.started.verifier);
    results.check("…which burned it for briefcase too", owner.status === 400 && owner.body.error === "invalid_grant", brief(owner));

    // 120 seconds.
    const old = await signInAgain(b, "briefcase");
    await sql(env, `update authorization_codes set expires_at = now() - interval '1 second' where flow_id = '${old.flow.id}'`);
    const expired = await exchangeCode(env, "briefcase", old.code ?? "", old.started.redirectUri, old.started.verifier);
    results.check("a code past its 120 seconds (time travel) → invalid_grant (expired)", expired.status === 400 && /expired/.test(expired.body.error_description ?? ""), brief(expired));

    // Garbage and grant types.
    const unknown = await exchangeCode(env, "briefcase", `sac_${"A".repeat(43)}`, s.started.redirectUri, null);
    results.check("an unknown sac_ code → invalid_grant (not known)", unknown.status === 400 && /not known/.test(unknown.body.error_description ?? ""), brief(unknown));
    const refreshAsCode = await exchangeCode(env, "briefcase", "sar_abc", s.started.redirectUri, null);
    results.check("a refresh token as code → invalid_grant naming what it is", refreshAsCode.status === 400 && /refresh token/.test(refreshAsCode.body.error_description ?? ""), brief(refreshAsCode));
    const noGrant = await appForm<Record<string, string>>(env, "briefcase", "/v1/oauth/token", { code: s.code });
    results.check("no grant_type → 400 invalid_request", noGrant.status === 400 && noGrant.body.error === "invalid_request", brief(noGrant));
    for (const [grant, hint] of [["password", "/authorize"], ["client_credentials", "ATA"], ["implicit", "PKCE"]] as const) {
      const reply = await appForm<Record<string, string>>(env, "briefcase", "/v1/oauth/token", { grant_type: grant });
      results.check(`grant_type=${grant} → unsupported_grant_type explaining the alternative (${hint})`, reply.status === 400 && reply.body.error === "unsupported_grant_type" && (reply.body.error_description ?? "").includes(hint), brief(reply));
    }
    const publicClient = await (async () => {
      const response = await fetch(`${env.site}/v1/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", client_id: "accounts", code: s.code, redirect_uri: s.started.redirectUri }).toString() });
      return { status: response.status, body: (await response.json()) as { error?: string } };
    })();
    results.check("the first-party public client can't redeem codes → unauthorized_client", publicClient.status === 400 && publicClient.body.error === "unauthorized_client", JSON.stringify(publicClient));

    // Two redemptions at the same moment: exactly one wins, and the loser's reuse revokes the winner's tokens.
    const race = await signInAgain(b, "briefcase");
    const both = await Promise.all([0, 1].map(() => exchangeCode(env, "briefcase", race.code ?? "", race.started.redirectUri, race.started.verifier)));
    const winners = both.filter(reply => reply.status === 200);
    results.check("two concurrent redemptions: exactly one 200, one invalid_grant", winners.length === 1 && both.filter(reply => reply.status === 400).length === 1, both.map(reply => reply.status).join(","));
    const winnerRefresh = winners[0] ? await refresh(env, "briefcase", winners[0].body.refresh_token) : null;
    results.check("…and the winner's tokens were revoked by the loser's replay", winnerRefresh?.status === 400, winnerRefresh ? brief(winnerRefresh) : "no winner");
  },
};

const refreshRotation: Journey = {
  name: "auth-flows-refresh",
  title: "refresh tokens rotate (same 900-day end, new access token), a used one revokes the whole sign-in and tells the app; another app's refresh is refused; scope can narrow, never widen; past 900 days (time travel) or after the access was removed it's over; concurrent refreshes trip reuse detection",
  async run(ctx) {
    const { env, results } = ctx;
    const t = tag();
    const b = new Browserish(env, ctx.ip);
    const s = await signUpVia(b, "briefcase", `rotate.${t}@example.test`, { optionalScopes: ["timezone"] });
    const t0 = await exchangeCode(env, "briefcase", s.code, s.started.redirectUri, s.started.verifier);
    const uuid = t0.body.account.uuid;
    const created = await sql(env, `select extract(epoch from expires_at - created_at)::bigint from token_families where account_uuid = '${uuid}' and app_id = 'briefcase'`);
    results.check("a sign-in (token family) lasts 900 days", created[0]?.[0] === String(900 * 86_400), JSON.stringify(created));
    const access = jwtClaims(t0.body.access_token);
    results.check("access token: EdDSA JWT, 30 minutes, sub = uuid, aud = briefcase, mid, kind, id, fid, scope", jwtHeader(t0.body.access_token).alg === "EdDSA" && Number(access.exp) - Number(access.iat) === 1800 && t0.body.expires_in === 1800 && access.sub === uuid && access.aud === "briefcase" && access.mid === `briefcase:${uuid}` && access.kind === "carbon" && typeof access.fid === "string" && access.scope === t0.body.scope, JSON.stringify(access));
    const durations: number[] = [];
    const r1 = await refresh(env, "briefcase", t0.body.refresh_token);
    durations.push(r1.ms);
    results.check("refresh → 200 with a new refresh token and a new access token", r1.status === 200 && r1.body.refresh_token !== t0.body.refresh_token && r1.body.access_token !== t0.body.access_token, brief(r1));
    results.check("…the same 900-day end (absolute, not extended), scope and account", r1.body.refresh_token_expires_at === t0.body.refresh_token_expires_at && r1.body.scope === t0.body.scope && r1.body.account.uuid === uuid && r1.body.account.timezone !== undefined, `${r1.body.refresh_token_expires_at} vs ${t0.body.refresh_token_expires_at}`);
    let current: Tokens = r1.body;
    for (let i = 0; i < 8; i++) {
      const next = await refresh(env, "briefcase", current.refresh_token);
      durations.push(next.ms);
      if (next.status !== 200) break;
      current = next.body;
    }
    const st = stats(durations);
    results.metric("refresh p50 (through the site)", st.p50);
    results.metric("refresh p95 (through the site)", st.p95);
    const narrow = await refresh(env, "briefcase", current.refresh_token, { scope: "profile" });
    results.check("refresh asking a narrower scope (profile) → 200", narrow.status === 200, brief(narrow));
    current = narrow.status === 200 ? narrow.body : current;
    const wide = await refresh(env, "briefcase", current.refresh_token, { scope: "profile email phone" });
    results.check("refresh asking for more (phone) → 400 invalid_scope naming it", wide.status === 400 && wide.body.error === "invalid_scope" && /phone/.test(wide.body.error_description ?? ""), brief(wide));
    const otherApp = await refresh(env, "commit", current.refresh_token);
    results.check("briefcase's refresh token at commit → invalid_grant (a different app)", otherApp.status === 400 && /different app/.test(otherApp.body.error_description ?? ""), brief(otherApp));
    const stillMine = await refresh(env, "briefcase", current.refresh_token);
    results.check("…and it still works for briefcase (nothing was revoked by that)", stillMine.status === 200, brief(stillMine));
    current = stillMine.status === 200 ? stillMine.body : current;

    // Reuse detection.
    const reused = await refresh(env, "briefcase", t0.body.refresh_token);
    results.check("presenting the very first (used) refresh token → invalid_grant (used once; the sign-in is revoked)", reused.status === 400 && /already used once/.test(reused.body.error_description ?? ""), brief(reused));
    const latest = await refresh(env, "briefcase", current.refresh_token);
    results.check("…the newest refresh token is dead too (refresh_token_reuse)", latest.status === 400 && /refresh_token_reuse/.test(latest.body.error_description ?? ""), brief(latest));
    const introspected = await introspect(env, "briefcase", current.access_token);
    results.check("…the newest access token introspects inactive", introspected.body.active === false, JSON.stringify(introspected.body));
    const events = await appEvents(env, "briefcase", uuid);
    results.check("briefcase is told membership.signed_out (refresh_token_reuse)", events.some(e => e.type === "membership.signed_out" && e.data.reason === "refresh_token_reuse"), JSON.stringify(events));
    const audit = await sql(env, `select count(*) from audit_log where account_uuid = '${uuid}' and action = 'oauth.refresh_reuse_detected'`);
    results.check("…and the audit log keeps oauth.refresh_reuse_detected", audit[0]?.[0] === "1", JSON.stringify(audit));

    // 900 days, and removed access.
    const again = await signInAgain(b, "briefcase");
    const t1 = await exchangeCode(env, "briefcase", again.code ?? "", again.started.redirectUri, again.started.verifier);
    const fid = String(jwtClaims(t1.body.access_token).fid ?? "");
    await sql(env, `update token_families set expires_at = now() - interval '1 second' where id = '${fid}'`);
    const old = await refresh(env, "briefcase", t1.body.refresh_token);
    results.check("past its 900 days (time travel) → invalid_grant (expired)", old.status === 400 && /expired/.test(old.body.error_description ?? ""), brief(old));
    const third = await signInAgain(b, "briefcase");
    const t2 = await exchangeCode(env, "briefcase", third.code ?? "", third.started.redirectUri, third.started.verifier);
    const removed = await b.call("DELETE", "/v1/me/apps/briefcase");
    const afterRemoval = await refresh(env, "briefcase", t2.body.refresh_token);
    results.check("after the Carbon removes briefcase's access → refresh is invalid_grant", removed.status === 204 && afterRemoval.status === 400 && afterRemoval.body.error === "invalid_grant", `${removed.status} ${brief(afterRemoval)}`);

    // Two refreshes with the same token at once: one rotates, the other is a reuse → the sign-in ends.
    const fourth = await signInAgain(b, "briefcase");
    const t3 = await exchangeCode(env, "briefcase", fourth.code ?? "", fourth.started.redirectUri, fourth.started.verifier);
    const race = await Promise.all([0, 1].map(() => refresh(env, "briefcase", t3.body.refresh_token)));
    const won = race.find(reply => reply.status === 200);
    const followUp = won ? await refresh(env, "briefcase", won.body.refresh_token) : null;
    results.check("two concurrent refreshes of one token: one 200, one invalid_grant, and reuse detection ends the sign-in", race.filter(reply => reply.status === 200).length === 1 && followUp?.status === 400, `${race.map(reply => reply.status).join(",")} → ${followUp?.status}`);
  },
};

const endpoints: Journey = {
  name: "auth-flows-token-endpoints",
  title: "userinfo (scoped claims + OIDC aliases, Bearer errors), introspection (active fields, nothing about other apps' or dead tokens), revocation (RFC 7009: 200 always, ends the sign-in, tells the app, never another app's token); an app's token is no account-site token; latencies",
  async run(ctx) {
    const { env, results } = ctx;
    const t = tag();
    const b = new Browserish(env, ctx.ip);
    const email = `endpoints.${t}@example.test`;
    const s = await signUpVia(b, "briefcase", email, { optionalScopes: ["timezone"], timezone: "Asia/Tokyo" });
    const tokens = await exchangeCode(env, "briefcase", s.code, s.started.redirectUri, s.started.verifier);
    results.check("token responses are never cached (Cache-Control: no-store)", /no-store/.test(tokens.headers.get("cache-control") ?? ""), String(tokens.headers.get("cache-control")));
    const uuid = tokens.body.account.uuid;

    const info = await userinfo(env, tokens.body.access_token);
    const u = info.body;
    results.check("userinfo → the account as briefcase may see it (uuid, membership, email, timezone)", info.status === 200 && u.uuid === uuid && u.membership_id === `briefcase:${uuid}` && u.email === email && u.timezone === "Asia/Tokyo", JSON.stringify(u).slice(0, 300));
    results.check("…with the OIDC aliases sub, name, picture, email_verified, zoneinfo", u.sub === uuid && u.name === u.display_name && u.picture === u.pfp_url && u.email_verified === true && u.zoneinfo === "Asia/Tokyo", JSON.stringify(u).slice(0, 300));
    results.check("…and nothing outside its scopes (no phone, dob, birthdate, phone_number)", !("phone" in u) && !("dob" in u) && !("birthdate" in u) && !("phone_number" in u), Object.keys(u).join(","));
    const viaForm = await fetch(`${env.site}/v1/userinfo`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ access_token: tokens.body.access_token }).toString() });
    results.check("POST /v1/userinfo with a form access_token → 200", viaForm.status === 200, String(viaForm.status));
    const twice = await fetch(`${env.site}/v1/userinfo`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Bearer ${tokens.body.access_token}` }, body: new URLSearchParams({ access_token: tokens.body.access_token }).toString() });
    results.check("…the token in both the header and the form → 400", twice.status === 400, String(twice.status));
    const anonymous = await fetch(`${env.site}/v1/userinfo`);
    results.check("no token → 401 with WWW-Authenticate: Bearer", anonymous.status === 401 && /^Bearer/.test(anonymous.headers.get("www-authenticate") ?? ""), `${anonymous.status} ${anonymous.headers.get("www-authenticate")}`);
    const garbage = await userinfo(env, "eyJhbGciOiJFZERTQSJ9.e30.c2ln");
    results.check("a forged token → 401 with WWW-Authenticate error=\"invalid_token\"", garbage.status === 401 && /invalid_token/.test(garbage.headers.get("www-authenticate") ?? ""), `${garbage.status} ${garbage.headers.get("www-authenticate")}`);
    const asAccount = await b.call("GET", "/v1/me", { bearer: tokens.body.access_token, cookies: false });
    results.check("briefcase's access token on /v1/me (the account site's API) → 401 token_wrong_audience", asAccount.status === 401 && (asAccount.body as { error?: { code?: string } }).error?.code === "token_wrong_audience", brief(asAccount));

    // Introspection.
    const active = await introspect(env, "briefcase", tokens.body.access_token);
    const a = active.body;
    results.check("introspect (access token) → active with sub, aud, client_id, scope, kind, id, membership_id, exp/iat, token_type", a.active === true && a.sub === uuid && a.aud === "briefcase" && a.client_id === "briefcase" && a.scope === tokens.body.scope && a.kind === "carbon" && typeof a.id === "string" && a.membership_id === `briefcase:${uuid}` && a.token_type === "access_token" && Number(a.exp) > Number(a.iat), JSON.stringify(a));
    const refreshActive = await introspect(env, "briefcase", tokens.body.refresh_token);
    results.check("introspect (refresh token) → active, token_type refresh_token, exp = the 900-day end", refreshActive.body.active === true && refreshActive.body.token_type === "refresh_token" && Number(refreshActive.body.exp) === Math.floor(Date.parse(tokens.body.refresh_token_expires_at) / 1000), JSON.stringify(refreshActive.body));
    const foreign = await introspect(env, "commit", tokens.body.access_token);
    results.check("commit introspecting briefcase's token → exactly {\"active\":false}", foreign.status === 200 && JSON.stringify(foreign.body) === '{"active":false}', JSON.stringify(foreign.body));
    const junk = await introspect(env, "briefcase", "not-a-token");
    results.check("a junk token → exactly {\"active\":false}", JSON.stringify(junk.body) === '{"active":false}', JSON.stringify(junk.body));
    const noToken = await appForm<Record<string, string>>(env, "briefcase", "/v1/oauth/introspect", {});
    results.check("no token parameter → 400 invalid_request", noToken.status === 400 && noToken.body.error === "invalid_request", brief(noToken));
    const badClient = await introspect(env, "briefcase", tokens.body.access_token, { secret: "sa_app_wrong" });
    results.check("a wrong app secret → 401 invalid_client", badClient.status === 401 && badClient.body.error === "invalid_client", brief(badClient));
    const publicIntrospect = await fetch(`${env.site}/v1/oauth/introspect`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: tokens.body.access_token, client_id: "accounts" }).toString() });
    results.check("the first-party public client can't introspect → 401 invalid_client", publicIntrospect.status === 401, String(publicIntrospect.status));

    // Latency of the reads apps make most.
    const intro: number[] = [];
    const reads: number[] = [];
    for (let i = 0; i < 20; i++) {
      intro.push((await introspect(env, "briefcase", tokens.body.access_token)).ms);
      reads.push((await userinfo(env, tokens.body.access_token)).ms);
    }
    results.metric("introspect p50 (through the site)", stats(intro).p50);
    results.metric("introspect p95 (through the site)", stats(intro).p95);
    results.metric("userinfo p50 (through the site)", stats(reads).p50);
    results.metric("userinfo p95 (through the site)", stats(reads).p95);
    const direct: number[] = [];
    for (let i = 0; i < 20; i++) direct.push((await introspect(env, "briefcase", tokens.body.access_token, { direct: true })).ms);
    results.metric("introspect p50 (accounts-api direct)", stats(direct).p50);

    // Revocation.
    const second = await signInAgain(b, "briefcase");
    const keep = await exchangeCode(env, "briefcase", second.code ?? "", second.started.redirectUri, second.started.verifier);
    const commitSide = await signInAgain(b, "commit");
    const commitTokens = await exchangeCode(env, "commit", commitSide.code ?? "", commitSide.started.redirectUri, commitSide.started.verifier);
    const notMine = await revoke(env, "briefcase", commitTokens.body.refresh_token);
    results.check("briefcase revoking commit's refresh token → 200 {revoked:false}, and it still works", notMine.status === 200 && notMine.body.revoked === false && (await refresh(env, "commit", commitTokens.body.refresh_token)).status === 200, JSON.stringify(notMine.body));
    const done = await revoke(env, "briefcase", tokens.body.refresh_token);
    results.check("revoking its own refresh token → 200 {revoked:true}", done.status === 200 && done.body.revoked === true, JSON.stringify(done.body));
    const dead = await refresh(env, "briefcase", tokens.body.refresh_token);
    results.check("…the refresh token is dead (app_revoked)", dead.status === 400 && /app_revoked/.test(dead.body.error_description ?? ""), brief(dead));
    results.check("…so is its access token (introspect false, userinfo 401)", (await introspect(env, "briefcase", tokens.body.access_token)).body.active === false && (await userinfo(env, tokens.body.access_token)).status === 401);
    results.check("…the other briefcase sign-in of the same Carbon is untouched", (await introspect(env, "briefcase", keep.body.access_token)).body.active === true);
    const events = await appEvents(env, "briefcase", uuid);
    results.check("briefcase is told membership.signed_out (app_revoked)", events.some(e => e.type === "membership.signed_out" && e.data.reason === "app_revoked"), JSON.stringify(events));
    const repeat = await revoke(env, "briefcase", tokens.body.refresh_token);
    results.check("revoking again → 200 (idempotent), no second event", repeat.status === 200 && (await appEvents(env, "briefcase", uuid)).filter(e => e.data.reason === "app_revoked").length === 1, JSON.stringify(repeat.body));
    const byAccess = await revoke(env, "briefcase", keep.body.access_token);
    results.check("revoking with an access token ends its sign-in too", byAccess.body.revoked === true && (await refresh(env, "briefcase", keep.body.refresh_token)).status === 400, JSON.stringify(byAccess.body));
    const proof = await revoke(env, "briefcase", `sap_${"x".repeat(43)}`);
    results.check("a proof token → 200 {revoked:false} saying where proofs are revoked", proof.body.revoked === false && /proof/i.test(proof.body.message ?? ""), JSON.stringify(proof.body));
    const unknownToken = await revoke(env, "briefcase", "sar_unknown");
    results.check("an unknown token → 200 {revoked:false}", unknownToken.status === 200 && unknownToken.body.revoked === false, JSON.stringify(unknownToken.body));
    const missing = await appForm<Record<string, string>>(env, "briefcase", "/v1/oauth/revoke", {});
    results.check("no token → 400 invalid_request; a wrong secret → 401 invalid_client", missing.status === 400 && (await revoke(env, "briefcase", "x", { secret: "nope" })).status === 401, brief(missing));
  },
};

export const journeys: Journey[] = [pkce, codeReuse, refreshRotation, endpoints];

