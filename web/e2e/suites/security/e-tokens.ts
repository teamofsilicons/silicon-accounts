/**
 * Token confusion. An app's access token (aud = the app) never opens the account endpoints (/v1/me and friends need
 * aud = accounts); no other credential (refresh token, id_token, SLT, proof token, session cookie, app secret) passes
 * for a Bearer access token; forged JWTs (alg none, HS256 with the public key, another Ed25519 key, edited claims)
 * are refused. Introspection only ever reports the calling app's own tokens (anything else is exactly
 * {"active":false}), revocation by another app revokes nothing, and codes, SLTs, refresh tokens and proofs only work
 * for the app they were issued to.
 */
import { createHmac, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import type { Journey } from "../../context";
import { sql, tag } from "../../lib";
import { appCredentials, appTokens, base64url, brief, call, continueInto, createSilicon, errorOf, remember, siliconLogin, token, viaSite, type Reply } from "./_helpers";

const b64json = (value: unknown) => base64url(Buffer.from(JSON.stringify(value)));

function decodePart(jwt: string, index: number): Record<string, unknown> {
  return JSON.parse(Buffer.from((jwt.split(".")[index] ?? "").replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")) as Record<string, unknown>;
}

/** The same JSON object, key order aside. */
const canonical = (value: unknown): string => (value && typeof value === "object" && !Array.isArray(value) ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}` : JSON.stringify(value));
const exactly = (reply: Reply, expected: Record<string, unknown>) => reply.status === 200 && canonical(reply.body) === canonical(expected);

export const journey: Journey = {
  name: "security-tokens",
  title: "token confusion: briefcase's access token gets 401 on /v1/me, /v1/session and every account endpoint; refresh/id/SLT/proof tokens, cookies and secrets are no Bearer token; forged JWTs (alg none, HS256 key confusion, foreign key, edited claims, the attacker's key in jwk/jku/x5u, a path as kid) are refused; introspection by another app says exactly {active:false}; another app can't revoke, refresh or redeem briefcase's tokens, codes, SLTs or proofs",
  engines: ["chromium"],
  async run(ctx) {
    const { env, results } = ctx;
    const t = viaSite(ctx);
    const { tokens: bc, carbon } = await appTokens(t, "briefcase", { scope: "openid email", label: "tokens" });
    remember(ctx, "access token", bc.access_token);
    remember(ctx, "refresh token", bc.refresh_token);
    remember(ctx, "id token", bc.id_token);
    remember(ctx, "code", carbon.code, carbon.authCode);
    remember(ctx, "session cookie", carbon.jar.get("sa_session"));
    const claims = decodePart(bc.access_token, 1);
    results.check("the app's access token is a JWT issued to briefcase for this Carbon", claims.aud === "briefcase" && claims.sub === carbon.uuid, JSON.stringify({ aud: claims.aud, sub: claims.sub, kind: claims.kind }));

    // 1. An app's access token on the account endpoints.
    const accountEndpoints: Array<[string, string, unknown]> = [
      ["GET", "/v1/me", undefined],
      ["GET", "/v1/session", undefined],
      ["PATCH", "/v1/me", { display_name: "Taken over" }],
      ["POST", "/v1/me/short-lived-tokens", { app_id: "remind" }],
      ["GET", "/v1/me/apps", undefined],
      ["GET", "/v1/me/sessions", undefined],
      ["POST", "/v1/me/silicons", { id: `si:tok-${tag()}`, display_name: "x" }],
      ["DELETE", "/v1/me", { confirm: carbon.id }],
    ];
    const opened: string[] = [];
    for (const [method, path, json] of accountEndpoints) {
      const reply = await call(`${env.site}${path}`, { method, ...(json !== undefined ? { json } : {}), bearer: bc.access_token, ip: ctx.ip });
      if (reply.status !== 401 || !/token_wrong_audience|invalid_token/.test(errorOf(reply).code ?? "")) opened.push(`${method} ${path}: ${brief(reply)}`);
      if (reply.text.includes(bc.access_token.slice(-40))) opened.push(`${method} ${path} echoes the token`);
    }
    const wrongAud = await call(`${env.site}/v1/me`, { bearer: bc.access_token, ip: ctx.ip });
    results.check(`briefcase's access token is refused on ${accountEndpoints.length} account endpoints (401 token_wrong_audience), and the answer never echoes the token`, opened.length === 0, opened.join(" | ") || `${errorOf(wrongAud).code}: ${errorOf(wrongAud).message}`);
    const me = await call<{ display_name?: string; status?: string }>(`${env.site}/v1/me`, { jar: carbon.jar, ip: ctx.ip });
    results.check("…and the Carbon's account is untouched (not renamed, not deleted)", me.status === 200 && me.body.display_name !== "Taken over" && me.body.status === "active", `${me.status} ${me.body.display_name} ${me.body.status}`);

    // 2. Every other kind of credential as a Bearer token.
    const slt = await call<{ slt?: string }>(`${env.site}/v1/me/short-lived-tokens`, { json: { app_id: "remind" }, jar: carbon.jar, origin: env.site, ip: ctx.ip });
    remember(ctx, "slt", slt.body.slt);
    const ata = await call<{ proof_token?: string; proof_refresh_token?: string }>(`${env.site}/v1/proofs/ata`, { json: { audiences: ["remind", "waveform"] }, basic: appCredentials("commit"), ip: ctx.ip, headers: { "idempotency-key": `sec-${tag()}` } });
    remember(ctx, "proof token", ata.body.proof_token, ata.body.proof_refresh_token);
    const others: Array<[string, string]> = [
      ["briefcase's refresh token", bc.refresh_token],
      ["briefcase's id_token (a JWT signed by the same key)", bc.id_token ?? ""],
      ["a short-lived token for remind", slt.body.slt ?? ""],
      ["an ATA proof token", ata.body.proof_token ?? ""],
      ["a proof refresh token", ata.body.proof_refresh_token ?? ""],
      ["the browser's session cookie value", carbon.jar.get("sa_session") ?? ""],
      ["an app secret", appCredentials("briefcase")[1]],
      ["an empty token", ""],
    ];
    const passed: string[] = [];
    for (const [label, value] of others) {
      if (!value && label !== "an empty token") {
        passed.push(`${label}: could not be obtained`);
        continue;
      }
      const reply = await call(`${env.site}/v1/me`, { bearer: value, ip: ctx.ip });
      if (reply.status !== 401) passed.push(`${label}: ${brief(reply)}`);
      if (value.length > 20 && reply.text.includes(value)) passed.push(`${label}: echoed`);
    }
    results.check(`no other credential works as a Bearer access token on /v1/me (${others.length}: refresh, id_token, SLT, proof, proof refresh, session cookie, app secret, empty) and none is echoed`, passed.length === 0, passed.join(" | ") || "all 401");
    const userinfoId = await call(`${env.site}/v1/userinfo`, { bearer: bc.id_token ?? "x", ip: ctx.ip });
    const userinfoOk = await call<{ email?: string; phone_number?: string; birthdate?: string }>(`${env.site}/v1/userinfo`, { bearer: bc.access_token, ip: ctx.ip });
    results.check("an id_token is not an access token at /v1/userinfo either (401); briefcase's access token gets only what it was granted", userinfoId.status === 401 && userinfoOk.status === 200 && userinfoOk.body.email === carbon.email && userinfoOk.body.birthdate === undefined && userinfoOk.body.phone_number === undefined, `${brief(userinfoId)} / userinfo ${userinfoOk.status} keys ${Object.keys(userinfoOk.body as object).join(",")}`);

    // 3. Forged JWTs.
    const jwks = await call<{ keys: Array<{ kid: string; x: string }> }>(`${env.site}/.well-known/jwks.json`);
    const kid = jwks.body.keys[0]?.kid ?? "dev-1";
    const now = Math.floor(Date.now() / 1000);
    const forgedClaims = { iss: env.site, sub: carbon.uuid, aud: "accounts", exp: now + 900, iat: now, nbf: now, jti: randomUUID(), kind: "carbon", id: carbon.id, mid: `accounts:${carbon.uuid}`, fid: randomUUID(), scope: "profile" };
    const none = `${b64json({ alg: "none", typ: "JWT", kid })}.${b64json(forgedClaims)}.`;
    const hsHeader = `${b64json({ alg: "HS256", typ: "JWT", kid })}.${b64json(forgedClaims)}`;
    const hs = `${hsHeader}.${base64url(createHmac("sha256", Buffer.from(jwks.body.keys[0]?.x ?? "", "base64")).update(hsHeader).digest())}`;
    const hsText = `${hsHeader}.${base64url(createHmac("sha256", jwks.body.keys[0]?.x ?? "").update(hsHeader).digest())}`;
    const { privateKey } = generateKeyPairSync("ed25519");
    const edHeader = `${b64json({ alg: "EdDSA", typ: "JWT", kid })}.${b64json(forgedClaims)}`;
    const foreignKey = `${edHeader}.${base64url(sign(null, Buffer.from(edHeader), privateKey))}`;
    const [h, , s] = bc.access_token.split(".");
    const audSwapped = `${h}.${b64json({ ...claims, aud: "accounts" })}.${s}`;
    const subSwapped = `${h}.${b64json({ ...claims, sub: "AAA" })}.${s}`;
    // Tokens that bring their own key: the header names the attacker's key (embedded jwk, a jku URL) or a kid that
    // looks like a path; a verifier that trusts the header would accept them.
    const attackerPublic = generateKeyPairSync("ed25519");
    const selfSigned = (header: Record<string, unknown>) => {
      const signingInput = `${b64json({ alg: "EdDSA", typ: "JWT", ...header })}.${b64json(forgedClaims)}`;
      return `${signingInput}.${base64url(sign(null, Buffer.from(signingInput), attackerPublic.privateKey))}`;
    };
    const embeddedJwk = selfSigned({ kid, jwk: attackerPublic.publicKey.export({ format: "jwk" }) });
    const jku = selfSigned({ kid: "attacker-1", jku: "https://evil.example/.well-known/jwks.json" });
    const kidPath = selfSigned({ kid: "../../../../../../dev/null" });
    const x5u = selfSigned({ kid, x5u: "https://evil.example/cert.pem" });
    const forged: Array<[string, string]> = [
      ['alg "none"', none],
      ["HS256 keyed with the public key's bytes (algorithm confusion)", hs],
      ["HS256 keyed with the public key's text", hsText],
      ["EdDSA signed by another key under the service's kid", foreignKey],
      ["briefcase's token with aud edited to accounts", audSwapped],
      ["briefcase's token with sub edited", subSwapped],
      ["signed by the attacker's key, embedded in the header (jwk)", embeddedJwk],
      ["signed by the attacker's key, published at a jku URL", jku],
      ["signed by the attacker's key, x5u URL under the service's kid", x5u],
      ["a kid that is a path (../../dev/null)", kidPath],
    ];
    const forgedOk: string[] = [];
    for (const [label, jwt] of forged) {
      const reply = await call(`${env.site}/v1/me`, { bearer: jwt, ip: ctx.ip });
      if (reply.status !== 401) forgedOk.push(`${label}: ${brief(reply)}`);
      const introspected = await call(`${env.site}/v1/oauth/introspect`, { form: { token: jwt }, basic: appCredentials("briefcase"), ip: ctx.ip });
      if (!exactly(introspected, { active: false })) forgedOk.push(`${label}: introspection ${introspected.status} ${introspected.text.slice(0, 80)}`);
    }
    results.check(`forged JWTs are refused on /v1/me and introspect as exactly {active:false} (${forged.length}: alg none, HS256 key confusion ×2, a foreign Ed25519 key, edited aud, edited sub, the attacker's key in jwk / jku / x5u, a path as kid)`, forgedOk.length === 0, forgedOk.join(" | ") || "all 401 and inactive");

    // 4. Introspection: only the calling app's own tokens are ever active.
    const introspect = (app: string, value: string, credentials: [string, string] = appCredentials(app)) => call(`${env.site}/v1/oauth/introspect`, { form: { token: value }, basic: credentials, ip: ctx.ip });
    const ownAccess = await introspect("briefcase", bc.access_token);
    const ownBody = ownAccess.body as { active?: boolean; aud?: string; sub?: string };
    results.check("control: briefcase introspects its own access token → active, aud briefcase, sub the Carbon", ownAccess.status === 200 && ownBody.active === true && ownBody.aud === "briefcase" && ownBody.sub === carbon.uuid, JSON.stringify(ownAccess.body).slice(0, 160));
    const bot = await createSilicon(t, carbon.jar, "tokens");
    remember(ctx, "stk", bot.stk);
    const firstParty = await siliconLogin(t, bot.id, bot.stk);
    remember(ctx, "access token", firstParty.body.access_token);
    remember(ctx, "refresh token", firstParty.body.refresh_token);
    const crossIntrospection: Array<[string, string, string]> = [
      ["dm", "briefcase's access token", bc.access_token],
      ["dm", "briefcase's refresh token", bc.refresh_token],
      ["commit", "briefcase's id_token", bc.id_token ?? ""],
      ["briefcase", "a first-party (accounts) access token", firstParty.body.access_token],
      ["briefcase", "a first-party refresh token", firstParty.body.refresh_token],
      ["remind", "a proof token for remind", ata.body.proof_token ?? ""],
      ["briefcase", "an unknown token", `sar_${base64url(Buffer.from(randomUUID()))}`],
    ];
    const leaks: string[] = [];
    for (const [app, label, value] of crossIntrospection) {
      const reply = await introspect(app, value);
      if (!exactly(reply, { active: false })) leaks.push(`${app} on ${label}: ${reply.status} ${reply.text.slice(0, 120)}`);
    }
    results.check(`another app's tokens introspect as exactly {"active":false} (${crossIntrospection.length} cases: access, refresh, id_token, first-party access/refresh, proof, unknown)`, leaks.length === 0, leaks.join(" | ") || "all exactly {active:false}");
    const publicClient = await call<{ error?: string }>(`${env.site}/v1/oauth/introspect`, { form: { token: bc.access_token, client_id: "accounts" }, ip: ctx.ip });
    const wrongSecret = `sa_app_briefcase_${"W".repeat(40)}`;
    const badSecret = await introspect("briefcase", bc.access_token, ["briefcase", wrongSecret]);
    results.check("introspection needs real app credentials: the public client id alone and a wrong secret get 401 invalid_client (and the wrong secret is not echoed)", publicClient.status === 401 && publicClient.body.error === "invalid_client" && badSecret.status === 401 && !badSecret.text.includes(wrongSecret), `${publicClient.status} ${publicClient.body.error} / ${badSecret.status} ${badSecret.text.slice(0, 100)}`);

    // 5. Another app can't revoke, refresh or redeem briefcase's credentials.
    const revokeRefresh = await call<{ revoked?: boolean }>(`${env.site}/v1/oauth/revoke`, { form: { token: bc.refresh_token }, basic: appCredentials("dm"), ip: ctx.ip });
    const revokeAccess = await call<{ revoked?: boolean }>(`${env.site}/v1/oauth/revoke`, { form: { token: bc.access_token }, basic: appCredentials("dm"), ip: ctx.ip });
    const stillActive = await introspect("briefcase", bc.access_token);
    results.check("dm revoking briefcase's refresh and access tokens revokes nothing (200 revoked:false) and briefcase's token stays active", revokeRefresh.status === 200 && revokeRefresh.body.revoked === false && revokeAccess.status === 200 && revokeAccess.body.revoked === false && (stillActive.body as { active?: boolean }).active === true, `${revokeRefresh.status} ${JSON.stringify(revokeRefresh.body).slice(0, 80)} / ${revokeAccess.status} / still active: ${(stillActive.body as { active?: boolean }).active}`);
    const dmRefresh = await token(t, { grant_type: "refresh_token", refresh_token: bc.refresh_token }, appCredentials("dm"));
    results.check("dm can't refresh with briefcase's refresh token (400 invalid_grant)", dmRefresh.status === 400 && dmRefresh.body.error === "invalid_grant" && !dmRefresh.text.includes(bc.refresh_token), `${dmRefresh.status} ${dmRefresh.body.error}: ${dmRefresh.body.error_description ?? ""}`.slice(0, 200));
    const ownRefresh = await token(t, { grant_type: "refresh_token", refresh_token: bc.refresh_token }, appCredentials("briefcase"));
    remember(ctx, "refresh token", ownRefresh.body.refresh_token);
    remember(ctx, "access token", ownRefresh.body.access_token);
    results.check("…and briefcase itself still can (dm's attempts didn't burn or revoke its sign-in)", ownRefresh.status === 200 && !!ownRefresh.body.access_token, brief(ownRefresh));

    const second = await continueInto(t, carbon.jar, "briefcase", "openid email");
    remember(ctx, "code", second.code);
    const stolenCode = await token(t, { grant_type: "authorization_code", code: second.code, redirect_uri: second.redirect, code_verifier: second.verifier }, appCredentials("dm"));
    results.check("dm can't redeem an authorization code issued to briefcase, even with briefcase's redirect URI and verifier (400 invalid_grant, code not echoed)", stolenCode.status === 400 && stolenCode.body.error === "invalid_grant" && !stolenCode.text.includes(second.code), `${stolenCode.status} ${stolenCode.body.error}: ${stolenCode.body.error_description ?? ""}`.slice(0, 200));
    const rightful = await token(t, { grant_type: "authorization_code", code: second.code, redirect_uri: second.redirect, code_verifier: second.verifier }, appCredentials("briefcase"));
    results.metric("briefcase's code still redeemable after dm's attempt (1 yes, 0 no)", rightful.status === 200 ? 1 : 0, "count");
    results.check(`(note) after dm's failed attempt briefcase's own exchange of the code answered ${rightful.status}`, true, rightful.status === 200 ? "the code stays bound to briefcase and usable once" : `burned: ${rightful.body.error} ${rightful.body.error_description ?? ""}`);

    const stolenSlt = await token(t, { grant_type: "urn:silicon:params:oauth:grant-type:slt", slt: slt.body.slt ?? "" }, appCredentials("briefcase"));
    results.check("briefcase can't redeem a short-lived token minted for remind (400 invalid_grant, SLT not echoed)", stolenSlt.status === 400 && stolenSlt.body.error === "invalid_grant" && !stolenSlt.text.includes(slt.body.slt ?? "~"), `${stolenSlt.status} ${stolenSlt.body.error}: ${stolenSlt.body.error_description ?? ""}`.slice(0, 200));

    const verify = (app: string) => call(`${env.site}/v1/proofs/verify`, { json: { proof_token: ata.body.proof_token }, basic: appCredentials(app), ip: ctx.ip });
    const byBriefcase = await verify("briefcase");
    const byIssuer = await verify("commit");
    const byRemind = await verify("remind");
    results.check("an ATA proof for remind + waveform verifies as exactly {valid:false, expires_at:null} for briefcase and for its own issuer, and valid for remind", exactly(byBriefcase, { valid: false, expires_at: null }) && exactly(byIssuer, { valid: false, expires_at: null }) && (byRemind.body as { valid?: boolean }).valid === true, `briefcase ${byBriefcase.text.slice(0, 60)} / commit ${byIssuer.text.slice(0, 60)} / remind valid=${(byRemind.body as { valid?: boolean }).valid}`);

    // 6. A sign-in past its 900 days (time travel on the family) ends everything issued under it at once.
    const fresh = ownRefresh.body;
    const beforeExpiry = await introspect("briefcase", fresh.access_token);
    await sql(env, `update token_families set expires_at = now() - interval '1 second' where account_uuid = '${carbon.uuid}' and app_id = 'briefcase'`);
    const expiredIntrospect = await introspect("briefcase", fresh.access_token);
    const expiredRefresh = await token(t, { grant_type: "refresh_token", refresh_token: fresh.refresh_token }, appCredentials("briefcase"));
    const expiredUserinfo = await call(`${env.site}/v1/userinfo`, { bearer: fresh.access_token, ip: ctx.ip });
    results.check("once the sign-in (token family) is past its 900 days (time travel), its unexpired access token introspects inactive, is refused at /v1/userinfo, and its refresh token is refused", (beforeExpiry.body as { active?: boolean }).active === true && exactly(expiredIntrospect, { active: false }) && expiredUserinfo.status === 401 && expiredRefresh.status === 400 && expiredRefresh.body.error === "invalid_grant", `before ${(beforeExpiry.body as { active?: boolean }).active}; introspect ${expiredIntrospect.text}; userinfo ${expiredUserinfo.status}; refresh ${expiredRefresh.status} ${expiredRefresh.body.error}`);

    // 7. Sign-out kills the first-party access token at once (its sign-in is checked on every request).
    const out = await call(`${env.site}/v1/oauth/revoke`, { form: { token: firstParty.body.refresh_token, client_id: "accounts" }, ip: ctx.ip });
    const after = await call(`${env.site}/v1/me`, { bearer: firstParty.body.access_token, ip: ctx.ip });
    results.check("after the Silicon signs out (revoking its first-party refresh token) its still-unexpired access token is refused at once (401 token_revoked)", out.status === 200 && after.status === 401 && errorOf(after).code === "token_revoked", `${out.status} ${out.text.slice(0, 60)} / ${brief(after)}`);
  },
};
