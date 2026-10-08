/**
 * Token confusion. Three audiences act for a Carbon: `accounts` (the account site's own tokens: the CLI, Silicons,
 * the device flow) works everywhere an account acts; `developer` (developers.teamofsilicons.com's tokens) only reads
 * the account (GET /v1/me, /v1/session, /v1/me/owned-apps) and manages the apps the Carbon owns (/v1/apps/{app_id}/…),
 * and is refused with 401 `token_wrong_audience` everywhere else (it can never mint an SLT, approve a device code, touch
 * Silicons, emails or sessions); an app's own token (aud = the app) never opens an account endpoint or an owner route.
 * No other credential (refresh token, id_token, SLT, proof token, session cookie, app secret) passes for a Bearer access
 * token; forged JWTs (alg none, HS256 with the public key, another Ed25519 key, edited claims) are refused.
 * Introspection only ever reports the calling app's own tokens, revocation by another app revokes nothing, and codes,
 * SLTs, refresh tokens and proofs only work for the app they were issued to. The public client `developer` (no secret)
 * only redeems its own codes, with PKCE S256, and refreshes its own tokens.
 */
import { createHmac, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import type { Journey } from "../../context";
import { sql, tag } from "../../lib";
import {
  appCredentials, appOwner, appTokens, base64url, brief, call, continueInto, createSilicon, deviceTokens, developerCallback, developerTokens, errorOf, flowOf, forgetCodesTo, jwtClaims, pkcePair,
  publicToken, remember, siliconLogin, signInWithEmail, startFlow, token, viaSite, advance, type Reply,
} from "./_helpers";

const b64json = (value: unknown) => base64url(Buffer.from(JSON.stringify(value)));

/** The same JSON object, key order aside. */
const canonical = (value: unknown): string => (value && typeof value === "object" && !Array.isArray(value) ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}` : JSON.stringify(value));
const exactly = (reply: Reply, expected: Record<string, unknown>) => reply.status === 200 && canonical(reply.body) === canonical(expected);

export const journey: Journey = {
  name: "security-tokens",
  title: "token confusion: briefcase's access token gets 401 on /v1/me and every account endpoint and owner route; the developer platform's token (aud=developer) reads /v1/me, /v1/session, /v1/me/owned-apps and manages only owned apps, and gets 401 token_wrong_audience everywhere else (no SLT, device approval, Silicons, emails, sessions); an accounts token works on owner routes; refresh/id/SLT/proof tokens, cookies and secrets are no Bearer token; forged JWTs are refused; introspection by another app says exactly {active:false}; the public client developer only redeems its own codes with PKCE S256 and refreshes its own tokens; another app can't revoke, refresh or redeem briefcase's tokens, codes, SLTs or proofs",
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
    const claims = jwtClaims(bc.access_token);
    results.check("the app's access token is a JWT issued to briefcase for this Carbon", claims.aud === "briefcase" && claims.sub === carbon.uuid, JSON.stringify({ aud: claims.aud, sub: claims.sub, kind: claims.kind }));

    // 1. An app's access token on the account endpoints and on the owner routes of apps.
    const accountEndpoints: Array<[string, string, unknown]> = [
      ["GET", "/v1/me", undefined],
      ["GET", "/v1/session", undefined],
      ["PATCH", "/v1/me", { display_name: "Taken over" }],
      ["POST", "/v1/me/short-lived-tokens", { app_id: "remind" }],
      ["GET", "/v1/me/apps", undefined],
      ["GET", "/v1/me/sessions", undefined],
      ["GET", "/v1/me/owned-apps", undefined],
      ["GET", "/v1/me/proofs", undefined],
      ["POST", "/v1/me/silicons", { id: `si:tok-${tag()}`, display_name: "x" }],
      ["GET", "/v1/apps/briefcase", undefined],
      ["POST", "/v1/apps/briefcase/proofs/ata", { receiving_app: "remind" }],
      ["DELETE", "/v1/me", { confirm: carbon.id }],
    ];
    const opened: string[] = [];
    for (const [method, path, json] of accountEndpoints) {
      const reply = await call(`${env.site}${path}`, { method, ...(json !== undefined ? { json } : {}), bearer: bc.access_token, ip: ctx.ip });
      if (reply.status !== 401 || !/token_wrong_audience|invalid_token/.test(errorOf(reply).code ?? "")) opened.push(`${method} ${path}: ${brief(reply)}`);
      if (reply.text.includes(bc.access_token.slice(-40))) opened.push(`${method} ${path} echoes the token`);
    }
    const wrongAud = await call(`${env.site}/v1/me`, { bearer: bc.access_token, ip: ctx.ip });
    results.check(`briefcase's access token is refused on ${accountEndpoints.length} account endpoints and owner routes (401 token_wrong_audience), and the answer never echoes the token`, opened.length === 0, opened.join(" | ") || `${errorOf(wrongAud).code}: ${errorOf(wrongAud).message}`);
    const me = await call<{ display_name?: string; status?: string }>(`${env.site}/v1/me`, { jar: carbon.jar, ip: ctx.ip });
    results.check("…and the Carbon's account is untouched (not renamed, not deleted)", me.status === 200 && me.body.display_name !== "Taken over" && me.body.status === "active", `${me.status} ${me.body.display_name} ${me.body.status}`);

    // 2. Every other kind of credential as a Bearer token.
    const slt = await call<{ slt?: string }>(`${env.site}/v1/me/short-lived-tokens`, { json: { app_id: "remind" }, jar: carbon.jar, origin: env.site, ip: ctx.ip });
    remember(ctx, "slt", slt.body.slt);
    const ata = await call<{ proof_token?: string; proof_refresh_token?: string; proof_id?: string }>(`${env.site}/v1/proofs/ata`, { json: { receiving_app: "remind" }, basic: appCredentials("commit"), ip: ctx.ip, headers: { "idempotency-key": `sec-${tag()}` } });
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

    // An app can't widen what it gets with `scope`: details it asks for there and doesn't request are optional
    // (unticked) on the last details page, so a Carbon who just continues shares none of them.
    const wide = await appTokens(t, "briefcase", { scope: "openid email dob timezone", label: "widescope" });
    remember(ctx, "access token", wide.tokens.access_token);
    remember(ctx, "refresh token", wide.tokens.refresh_token);
    remember(ctx, "code", wide.carbon.code, wide.carbon.authCode);
    const wideInfo = await call<Record<string, unknown>>(`${env.site}/v1/userinfo`, { bearer: wide.tokens.access_token, ip: ctx.ip });
    const wideScopes = wide.tokens.scope.split(" ");
    const ticked = await appTokens(t, "briefcase", { scope: "openid email dob", label: "tickedscope", share: ["dob"] });
    remember(ctx, "access token", ticked.tokens.access_token);
    remember(ctx, "refresh token", ticked.tokens.refresh_token);
    results.check("an app asking with scope for details it doesn't request (dob, timezone) gets none of them from a Carbon who just continues (token scope and userinfo without them); only a ticked one is shared", !wideScopes.includes("dob") && !wideScopes.includes("timezone") && wideInfo.status === 200 && wideInfo.body.birthdate === undefined && wideInfo.body.zoneinfo === undefined && ticked.tokens.scope.split(" ").includes("dob"), `continued: scope "${wide.tokens.scope}", userinfo ${Object.keys(wideInfo.body ?? {}).join(",")}; ticked dob: scope "${ticked.tokens.scope}"`);

    // 3. Forged JWTs.
    const jwks = await call<{ keys: Array<{ kid: string; x: string }> }>(`${env.site}/.well-known/jwks.json`);
    const kid = jwks.body.keys[0]?.kid ?? "dev-1";
    const now = Math.floor(Date.now() / 1000);
    const forgedClaims = { iss: env.site, sub: carbon.uuid, aud: "accounts", exp: now + 900, iat: now, nbf: now, jti: randomUUID(), kind: "carbon", id: carbon.id, mid: `accounts:${carbon.uuid}`, fid: randomUUID(), scope: "profile" };
    const none = `${b64json({ alg: "none", typ: "JWT", kid })}.${b64json(forgedClaims)}.`;
    const noneDeveloper = `${b64json({ alg: "none", typ: "JWT", kid })}.${b64json({ ...forgedClaims, aud: "developer", mid: `developer:${carbon.uuid}` })}.`;
    const hsHeader = `${b64json({ alg: "HS256", typ: "JWT", kid })}.${b64json(forgedClaims)}`;
    const hs = `${hsHeader}.${base64url(createHmac("sha256", Buffer.from(jwks.body.keys[0]?.x ?? "", "base64")).update(hsHeader).digest())}`;
    const hsText = `${hsHeader}.${base64url(createHmac("sha256", jwks.body.keys[0]?.x ?? "").update(hsHeader).digest())}`;
    const { privateKey } = generateKeyPairSync("ed25519");
    const edHeader = `${b64json({ alg: "EdDSA", typ: "JWT", kid })}.${b64json(forgedClaims)}`;
    const foreignKey = `${edHeader}.${base64url(sign(null, Buffer.from(edHeader), privateKey))}`;
    const [h, , s] = bc.access_token.split(".");
    const audSwapped = `${h}.${b64json({ ...claims, aud: "accounts" })}.${s}`;
    const audDeveloper = `${h}.${b64json({ ...claims, aud: "developer" })}.${s}`;
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
      ['alg "none" claiming the developer audience', noneDeveloper],
      ["HS256 keyed with the public key's bytes (algorithm confusion)", hs],
      ["HS256 keyed with the public key's text", hsText],
      ["EdDSA signed by another key under the service's kid", foreignKey],
      ["briefcase's token with aud edited to accounts", audSwapped],
      ["briefcase's token with aud edited to developer", audDeveloper],
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
      const owned = await call(`${env.site}/v1/me/owned-apps`, { bearer: jwt, ip: ctx.ip });
      if (owned.status !== 401) forgedOk.push(`${label} on /v1/me/owned-apps: ${brief(owned)}`);
      const introspected = await call(`${env.site}/v1/oauth/introspect`, { form: { token: jwt }, basic: appCredentials("briefcase"), ip: ctx.ip });
      if (!exactly(introspected, { active: false })) forgedOk.push(`${label}: introspection ${introspected.status} ${introspected.text.slice(0, 80)}`);
    }
    results.check(`forged JWTs are refused on /v1/me and /v1/me/owned-apps and introspect as exactly {active:false} (${forged.length}: alg none (also as aud developer), HS256 key confusion ×2, a foreign Ed25519 key, edited aud (accounts, developer), edited sub, the attacker's key in jwk / jku / x5u, a path as kid)`, forgedOk.length === 0, forgedOk.join(" | ") || "all 401 and inactive");

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
    // The developer platform's tokens of this Carbon (it owns no app).
    const dev = await developerTokens(t, carbon.jar);
    remember(ctx, "access token", dev.access_token);
    remember(ctx, "refresh token", dev.refresh_token);
    const devClaims = jwtClaims(dev.access_token);
    results.check("the developer platform's tokens (the app `developer`, PKCE S256, no secret) are a JWT with aud=developer for the Carbon, and a refresh token", devClaims.aud === "developer" && devClaims.sub === carbon.uuid && /^sar_/.test(dev.refresh_token), JSON.stringify({ aud: devClaims.aud, sub: devClaims.sub, scope: dev.scope }));
    const crossIntrospection: Array<[string, string, string]> = [
      ["dm", "briefcase's access token", bc.access_token],
      ["dm", "briefcase's refresh token", bc.refresh_token],
      ["commit", "briefcase's id_token", bc.id_token ?? ""],
      ["briefcase", "a first-party (accounts) access token", firstParty.body.access_token],
      ["briefcase", "a first-party refresh token", firstParty.body.refresh_token],
      ["briefcase", "the developer platform's access token", dev.access_token],
      ["briefcase", "the developer platform's refresh token", dev.refresh_token],
      ["remind", "a proof token for remind", ata.body.proof_token ?? ""],
      ["briefcase", "an unknown token", `sar_${base64url(Buffer.from(randomUUID()))}`],
    ];
    const leaks: string[] = [];
    for (const [app, label, value] of crossIntrospection) {
      const reply = await introspect(app, value);
      if (!exactly(reply, { active: false })) leaks.push(`${app} on ${label}: ${reply.status} ${reply.text.slice(0, 120)}`);
    }
    results.check(`another app's tokens introspect as exactly {"active":false} (${crossIntrospection.length} cases: access, refresh, id_token, first-party and developer-platform access/refresh, proof, unknown)`, leaks.length === 0, leaks.join(" | ") || "all exactly {active:false}");
    const publicClient = await call<{ error?: string }>(`${env.site}/v1/oauth/introspect`, { form: { token: bc.access_token, client_id: "accounts" }, ip: ctx.ip });
    const developerClient = await call<{ error?: string }>(`${env.site}/v1/oauth/introspect`, { form: { token: dev.access_token, client_id: "developer" }, ip: ctx.ip });
    const wrongSecret = `sa_app_briefcase_${"W".repeat(40)}`;
    const badSecret = await introspect("briefcase", bc.access_token, ["briefcase", wrongSecret]);
    results.check("introspection needs real app credentials: the public client ids accounts and developer alone, and a wrong secret, get 401 invalid_client (and the wrong secret is not echoed)", publicClient.status === 401 && publicClient.body.error === "invalid_client" && developerClient.status === 401 && developerClient.body.error === "invalid_client" && badSecret.status === 401 && !badSecret.text.includes(wrongSecret), `${publicClient.status} ${publicClient.body.error} / developer ${developerClient.status} ${developerClient.body.error} / ${badSecret.status} ${badSecret.text.slice(0, 100)}`);

    // OBO: an app turns only access tokens it received itself into proofs (aud = the issuing app).
    const obo = (app: string, subject: string) => call<{ proof_token?: string; proof_refresh_token?: string }>(`${env.site}/v1/proofs/obo`, { json: { subject_token: subject, receiving_app: "remind" }, basic: appCredentials(app), ip: ctx.ip, headers: { "idempotency-key": `sec-${tag()}${tag()}` } });
    const oboCases: Array<[string, string, string]> = [
      ["dm presenting briefcase's access token", "dm", bc.access_token],
      ["briefcase presenting the developer platform's token", "briefcase", dev.access_token],
      ["briefcase presenting a first-party (accounts) token", "briefcase", firstParty.body.access_token],
      ["briefcase presenting its own id_token", "briefcase", bc.id_token ?? ""],
      ["briefcase presenting its own refresh token", "briefcase", bc.refresh_token],
    ];
    const oboIssued: string[] = [];
    for (const [label, app, subject] of oboCases) {
      const reply = await obo(app, subject);
      remember(ctx, "proof token", reply.body?.proof_token, reply.body?.proof_refresh_token);
      if (reply.status === 201 || reply.status < 400 || !/subject_token/.test(errorOf(reply).code ?? "")) oboIssued.push(`${label}: ${brief(reply)}`);
    }
    const ownObo = await obo("briefcase", bc.access_token);
    remember(ctx, "proof token", ownObo.body?.proof_token, ownObo.body?.proof_refresh_token);
    results.check(`an OBO proof needs the issuing app's own access token for the Carbon: ${oboCases.length} others are refused (another app's, the developer platform's, a first-party token, an id_token, a refresh token), briefcase's own works`, oboIssued.length === 0 && ownObo.status === 201, `${oboIssued.join(" | ") || "all refused"}; own ${brief(ownObo)}`);

    // 5. The developer platform's audience: reads of the account and the owner routes, nothing else.
    const asDeveloper = (method: string, path: string, json?: unknown, accessToken = dev.access_token) => call(`${env.site}${path}`, { method, ...(json !== undefined ? { json } : method === "GET" || method === "HEAD" ? {} : { body: "" }), bearer: accessToken, ip: ctx.ip, headers: { "idempotency-key": `sec-${tag()}${tag()}` } });
    const allowed: Array<[string, string, number]> = [
      ["GET", "/v1/me", 200],
      ["GET", "/v1/session", 200],
      ["GET", "/v1/me/owned-apps", 200],
    ];
    const allowedFailures: string[] = [];
    for (const [method, path, status] of allowed) {
      const reply = await asDeveloper(method, path);
      if (reply.status !== status) allowedFailures.push(`${method} ${path}: ${brief(reply)}`);
    }
    const devMe = await asDeveloper("GET", "/v1/me");
    results.check("a developer-platform token reads its own Carbon: GET /v1/me, GET /v1/session and GET /v1/me/owned-apps answer 200 (as that Carbon)", allowedFailures.length === 0 && (devMe.body as { uuid?: string }).uuid === carbon.uuid, allowedFailures.join(" | ") || `me = ${(devMe.body as { id?: string }).id}`);
    const device = await call<{ user_code?: string; device_code?: string }>(`${env.site}/v1/device/authorize`, { json: { client_label: "escalation probe" }, ip: ctx.ip });
    remember(ctx, "device code", device.body.device_code);
    const refusedRoutes: Array<[string, string, unknown]> = [
      ["PATCH", "/v1/me", { display_name: "Developer was here" }],
      ["DELETE", "/v1/me", { confirm: carbon.id }],
      ["POST", "/v1/me/id", { id: `c:dev-${tag()}` }],
      ["GET", "/v1/me/silicons", undefined],
      ["POST", "/v1/me/silicons", { id: `si:dev-${tag()}`, display_name: "x" }],
      ["POST", `/v1/me/silicons/${bot.uuid}/stk`, {}],
      ["GET", "/v1/me/apps", undefined],
      ["DELETE", "/v1/me/apps/briefcase", undefined],
      ["GET", "/v1/me/sessions", undefined],
      ["GET", "/v1/me/emails", undefined],
      ["POST", "/v1/me/emails", { email: `sec.dev.${tag()}@example.test` }],
      ["GET", "/v1/me/phones", undefined],
      ["GET", "/v1/me/identities", undefined],
      ["POST", "/v1/me/identities/google", {}],
      ["GET", "/v1/me/proofs", undefined],
      ["GET", "/v1/me/history", undefined],
      ["GET", "/v1/me/custodian-requests", undefined],
      ["POST", "/v1/me/short-lived-tokens", { app_id: "remind" }],
      ["POST", `/v1/device/${device.body.user_code ?? "ABCD-EFGH"}/approve`, undefined],
      ["POST", "/v1/session/signout", undefined],
      ["HEAD", "/v1/me/silicons", undefined],
      ["PUT", "/v1/me/webhook", { url: "https://hooks.example.com/x" }],
      ["GET", `/v1/accounts/by-id/${encodeURIComponent(carbon.id)}`, undefined],
    ];
    const escaped: string[] = [];
    for (const [method, path, json] of refusedRoutes) {
      const reply = await asDeveloper(method, path, json);
      const code = method === "HEAD" ? "" : (errorOf(reply).code ?? "");
      if (reply.status !== 401 || (method !== "HEAD" && code !== "token_wrong_audience")) escaped.push(`${method} ${path}: ${brief(reply)}`);
    }
    const sample = await asDeveloper("GET", "/v1/me/silicons");
    results.check(`a developer-platform token is refused with 401 token_wrong_audience on ${refusedRoutes.length} other routes (the account's details, id, deletion, Silicons and their STKs, apps signed into, sessions, emails, phones, identities, proofs, history, custodian requests, short-lived tokens, device approval, sign-out, its webhook, account lookups)`, escaped.length === 0, escaped.join(" | ") || `${errorOf(sample).message} | hint: ${errorOf(sample).hint ?? ""}`.slice(0, 400));
    const poll = await publicToken(t, "accounts", { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: device.body.device_code ?? "" });
    const meAfter = await call<{ display_name?: string; status?: string }>(`${env.site}/v1/me`, { jar: carbon.jar, ip: ctx.ip });
    results.check("…so a stolen developer-platform token can't be turned into an accounts token (the device code it tried to approve still polls authorization_pending) and changed nothing on the account", poll.status === 400 && poll.body.error === "authorization_pending" && meAfter.body.display_name !== "Developer was here" && meAfter.body.status === "active", `poll ${poll.status} ${poll.body.error}; account ${meAfter.body.status}, name ${meAfter.body.display_name}`);
    const notOwned: Array<[string, string, unknown]> = [
      ["GET", "/v1/apps/briefcase", undefined],
      ["GET", "/v1/apps/briefcase/users", undefined],
      ["GET", "/v1/apps/briefcase/signin-config/history", undefined],
      ["PATCH", "/v1/apps/briefcase/signin-config", { redirect_uris: ["https://evil.example/cb"] }],
      ["POST", "/v1/apps/briefcase/proofs/ata", { receiving_app: "remind" }],
      ["GET", "/v1/apps/briefcase/proofs", undefined],
      ["PUT", "/v1/apps/briefcase/webhook", { url: "https://hooks.example.com/x" }],
      ["GET", "/v1/apps/briefcase/webhook/deliveries", undefined],
      ["GET", "/v1/apps/briefcase/imports", undefined],
    ];
    const ownerLeaks: string[] = [];
    for (const [method, path, json] of notOwned) {
      const reply = await asDeveloper(method, path, json);
      if (reply.status !== 403 || errorOf(reply).code !== "not_app_owner") ownerLeaks.push(`${method} ${path}: ${brief(reply)}`);
    }
    results.check(`a Carbon who owns no app gets 403 not_app_owner on ${notOwned.length} owner routes of briefcase with the developer platform's token (details, users, setup history, setup change, ATA proofs, proof list, webhook, deliveries, imports)`, ownerLeaks.length === 0, ownerLeaks.join(" | ") || "all 403");

    // The owner of briefcase (c:saket, seeded): their developer-platform token manages briefcase, not dm (c:shubham's).
    const owner = appOwner("briefcase");
    await forgetCodesTo(env, owner.email);
    const saket = await signInWithEmail(t, { email: owner.email });
    remember(ctx, "session cookie", saket.jar.get("sa_session"));
    remember(ctx, "code", saket.code);
    const saketDev = await developerTokens(t, saket.jar);
    remember(ctx, "access token", saketDev.access_token);
    remember(ctx, "refresh token", saketDev.refresh_token);
    const ownedList = await asDeveloper("GET", "/v1/me/owned-apps", undefined, saketDev.access_token);
    const ownedIds = ((ownedList.body as { items?: Array<{ app_id: string }> }).items ?? []).map(item => item.app_id);
    const details = await asDeveloper("GET", "/v1/apps/briefcase", undefined, saketDev.access_token);
    const users = await asDeveloper("GET", "/v1/apps/briefcase/users?limit=5", undefined, saketDev.access_token);
    const ownerAta = await call<{ proof_id?: string; proof_token?: string; receiving_app?: string }>(`${env.site}/v1/apps/briefcase/proofs/ata`, { json: { receiving_app: "remind" }, bearer: saketDev.access_token, ip: ctx.ip, headers: { "idempotency-key": `sec-${tag()}${tag()}` } });
    remember(ctx, "proof token", ownerAta.body.proof_token);
    // Someone else's developer-platform token can't revoke the owner's proof; the owner's own can.
    const strangerRevoke = await call(`${env.site}/v1/apps/briefcase/proofs/${ownerAta.body.proof_id ?? "x"}`, { method: "DELETE", bearer: dev.access_token, ip: ctx.ip });
    const stillValid = await call<{ valid?: boolean }>(`${env.site}/v1/proofs/verify`, { json: { proof_token: ownerAta.body.proof_token ?? "" }, basic: appCredentials("remind"), ip: ctx.ip });
    const ownerRevoke = ownerAta.body.proof_id ? await call(`${env.site}/v1/apps/briefcase/proofs/${ownerAta.body.proof_id}`, { method: "DELETE", bearer: saketDev.access_token, ip: ctx.ip }) : null;
    const afterRevoke = await call<{ valid?: boolean }>(`${env.site}/v1/proofs/verify`, { json: { proof_token: ownerAta.body.proof_token ?? "" }, basic: appCredentials("remind"), ip: ctx.ip });
    results.check("an ATA proof made by briefcase's owner can't be revoked with another Carbon's developer-platform token (403 not_app_owner, it still verifies), and the owner's revokes it (remind is then told valid:false)", strangerRevoke.status === 403 && errorOf(strangerRevoke).code === "not_app_owner" && stillValid.body.valid === true && !!ownerRevoke && ownerRevoke.status < 300 && afterRevoke.body.valid === false, `stranger ${brief(strangerRevoke)}; still valid ${stillValid.body.valid}; owner ${ownerRevoke ? brief(ownerRevoke) : "-"}; after ${afterRevoke.body.valid}`);
    const dmDetails = await asDeveloper("GET", "/v1/apps/dm", undefined, saketDev.access_token);
    const dmAta = await asDeveloper("POST", "/v1/apps/dm/proofs/ata", { receiving_app: "remind" }, saketDev.access_token);
    const dmPatch = await asDeveloper("PATCH", "/v1/apps/dm/signin-config", { redirect_uris: ["https://evil.example/cb"] }, saketDev.access_token);
    results.check("the owner's developer-platform token lists and manages briefcase (owned apps, details, users, an ATA proof for remind) and gets 403 not_app_owner on dm, another Carbon's app (details, ATA proof, sign-in setup)", ownedIds.includes("briefcase") && !ownedIds.includes("dm") && details.status === 200 && users.status === 200 && ownerAta.status === 201 && [dmDetails, dmAta, dmPatch].every(reply => reply.status === 403 && errorOf(reply).code === "not_app_owner"), `owned ${ownedIds.join(",")}; details ${details.status}; users ${users.status}; ata ${brief(ownerAta)}; dm: ${[dmDetails, dmAta, dmPatch].map(brief).join(" / ")}`);
    // An accounts token (the CLI's, from the device flow) works on the same owner routes; briefcase's own token doesn't.
    const saketCli = await deviceTokens(t, saket.jar, "security suite (owner)");
    remember(ctx, "access token", saketCli.access_token);
    remember(ctx, "refresh token", saketCli.refresh_token);
    const cliDetails = await call(`${env.site}/v1/apps/briefcase`, { bearer: saketCli.access_token, ip: ctx.ip });
    const cliSilicons = await call(`${env.site}/v1/me/silicons`, { bearer: saketCli.access_token, ip: ctx.ip });
    const cliDm = await call(`${env.site}/v1/apps/dm`, { bearer: saketCli.access_token, ip: ctx.ip });
    results.check("an accounts token (aud=accounts, from the device flow) works on the owner's routes (briefcase's details) and on account routes (/v1/me/silicons), and is still refused on another Carbon's app (403)", jwtClaims(saketCli.access_token).aud === "accounts" && cliDetails.status === 200 && cliSilicons.status === 200 && cliDm.status === 403, `aud ${jwtClaims(saketCli.access_token).aud}; briefcase ${cliDetails.status}; silicons ${cliSilicons.status}; dm ${brief(cliDm)}`);
    const developerUserinfo = await call<Record<string, unknown>>(`${env.site}/v1/userinfo`, { bearer: dev.access_token, ip: ctx.ip });
    results.check("(note) /v1/userinfo with a developer-platform token", true, `${developerUserinfo.status} keys ${Object.keys(developerUserinfo.body ?? {}).join(",")}`);

    // 6. The public client `developer` at the token endpoint: only its own codes (PKCE S256) and its own refresh tokens.
    const second = await continueInto(t, carbon.jar, "briefcase", { scope: "openid email" });
    remember(ctx, "code", second.code);
    const briefcaseCodeAsDeveloper = await publicToken(t, "developer", { grant_type: "authorization_code", code: second.code, redirect_uri: second.redirect, code_verifier: second.verifier });
    const sltAsDeveloper = await publicToken(t, "developer", { grant_type: "urn:silicon:params:oauth:grant-type:slt", slt: slt.body.slt ?? "" });
    const deviceAsDeveloper = await publicToken(t, "developer", { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: device.body.device_code ?? "" });
    const refreshAsDeveloper = await publicToken(t, "developer", { grant_type: "refresh_token", refresh_token: bc.refresh_token });
    const secretAsDeveloper = await call<{ error?: string }>(`${env.site}/v1/oauth/token`, { form: { grant_type: "refresh_token", refresh_token: dev.refresh_token, client_id: "developer", client_secret: "made-up-secret-for-a-public-client" }, ip: ctx.ip });
    const publicRefusals = [
      ["briefcase's code (with its verifier and redirect URI)", briefcaseCodeAsDeveloper, "invalid_grant"],
      ["an SLT minted for remind", sltAsDeveloper, null],
      ["a device code", deviceAsDeveloper, null],
      ["briefcase's refresh token", refreshAsDeveloper, "invalid_grant"],
    ] as const;
    const publicLeaks = publicRefusals.filter(([, reply, wanted]) => reply.status < 400 || !!reply.body.access_token || (wanted && reply.body.error !== wanted)).map(([label, reply]) => `${label}: ${brief(reply)}`);
    results.check(`the public client developer (no secret) gets no tokens from anything but its own sign-ins: ${publicRefusals.length} refusals (briefcase's code, an SLT, a device code, briefcase's refresh token)`, publicLeaks.length === 0, publicLeaks.join(" | ") || publicRefusals.map(([label, reply]) => `${label}: ${reply.status} ${reply.body.error}`).join("; "));
    results.check("(note) client_id=developer with a client_secret it doesn't have", true, brief(secretAsDeveloper));
    const briefcaseRefresh = await token(t, { grant_type: "refresh_token", refresh_token: bc.refresh_token }, appCredentials("briefcase"));
    remember(ctx, "refresh token", briefcaseRefresh.body.refresh_token);
    remember(ctx, "access token", briefcaseRefresh.body.access_token);
    results.check("…and briefcase itself still refreshes (the public client's attempt didn't burn or revoke briefcase's sign-in)", briefcaseRefresh.status === 200 && !!briefcaseRefresh.body.access_token, brief(briefcaseRefresh));
    const devRevokesBriefcase = await call<{ revoked?: boolean }>(`${env.site}/v1/oauth/revoke`, { form: { token: briefcaseRefresh.body.refresh_token ?? "", client_id: "developer" }, ip: ctx.ip });
    const stillLive = await introspect("briefcase", briefcaseRefresh.body.access_token ?? "");
    results.check("client_id=developer revoking briefcase's refresh token revokes nothing (revoked:false) and briefcase's access token stays active", devRevokesBriefcase.status === 200 && devRevokesBriefcase.body.revoked === false && (stillLive.body as { active?: boolean }).active === true, `${devRevokesBriefcase.status} ${devRevokesBriefcase.text.slice(0, 80)}; active ${(stillLive.body as { active?: boolean }).active}`);
    // The developer app's codes: only for client_id=developer, only with PKCE S256 and the right verifier.
    const devCode = async (pkce: "S256" | "plain" | "none") => {
      const jar = carbon.jar.clone();
      const { verifier, challenge } = pkcePair();
      const start = pkce === "none" ? {} : pkce === "plain" ? { code_challenge: verifier, code_challenge_method: "plain" } : { code_challenge: challenge, code_challenge_method: "S256" };
      const created = flowOf(await startFlow(t, jar, { app_id: "developer", redirect_uri: developerCallback(env), state: `d-${tag()}`, ...start }));
      const done = created ? await advance(t, jar, created) : null;
      const code = done?.redirect_to ? (new URL(done.redirect_to).searchParams.get("code") ?? "") : "";
      remember(ctx, "code", code);
      return { code, verifier };
    };
    const noPkce = await devCode("none");
    const noPkceExchange = await publicToken(t, "developer", { grant_type: "authorization_code", code: noPkce.code, redirect_uri: developerCallback(env) });
    const plain = await devCode("plain");
    const plainExchange = await publicToken(t, "developer", { grant_type: "authorization_code", code: plain.code, redirect_uri: developerCallback(env), code_verifier: plain.verifier });
    const wrongVerifier = await devCode("S256");
    const wrongExchange = await publicToken(t, "developer", { grant_type: "authorization_code", code: wrongVerifier.code, redirect_uri: developerCallback(env), code_verifier: pkcePair().verifier });
    const byAccounts = await devCode("S256");
    const accountsExchange = await publicToken(t, "accounts", { grant_type: "authorization_code", code: byAccounts.code, redirect_uri: developerCallback(env), code_verifier: byAccounts.verifier });
    const byBriefcase = await devCode("S256");
    const briefcaseExchange = await token(t, { grant_type: "authorization_code", code: byBriefcase.code, redirect_uri: developerCallback(env), code_verifier: byBriefcase.verifier }, appCredentials("briefcase"));
    const devExchanges = [
      ["without PKCE", noPkceExchange],
      ["with PKCE plain", plainExchange],
      ["with a wrong verifier", wrongExchange],
      ["by the public client accounts", accountsExchange],
      ["by briefcase with its secret", briefcaseExchange],
    ] as const;
    const devLeaks = devExchanges.filter(([, reply]) => reply.status === 200 || !!reply.body.access_token || ![400, 401].includes(reply.status)).map(([label, reply]) => `${label}: ${brief(reply)}`);
    results.check(`the developer app's codes are redeemed only by client_id=developer with PKCE S256 and the right verifier: ${devExchanges.length} other redemptions are refused (no PKCE, plain, a wrong verifier, the accounts client, briefcase)`, noPkce.code.startsWith("sac_") && devLeaks.length === 0, devLeaks.join(" | ") || devExchanges.map(([label, reply]) => `${label}: ${reply.status} ${reply.body.error}`).join("; "));
    // Rotation and reuse of the developer platform's refresh token.
    const rotated = await publicToken(t, "developer", { grant_type: "refresh_token", refresh_token: dev.refresh_token });
    remember(ctx, "refresh token", rotated.body.refresh_token);
    remember(ctx, "access token", rotated.body.access_token);
    const reused = await publicToken(t, "developer", { grant_type: "refresh_token", refresh_token: dev.refresh_token });
    const afterReuse = await call(`${env.site}/v1/me`, { bearer: rotated.body.access_token ?? "", ip: ctx.ip });
    results.check("the developer platform's refresh token rotates (client_id=developer, no secret), and presenting the used one again ends that sign-in at once: the newest access token is refused (401)", rotated.status === 200 && jwtClaims(rotated.body.access_token).aud === "developer" && reused.status === 400 && reused.body.error === "invalid_grant" && afterReuse.status === 401, `rotate ${rotated.status}; reuse ${brief(reused)}; newest access token → ${brief(afterReuse)}`);

    // 7. Another app can't revoke, refresh or redeem briefcase's credentials.
    const current = briefcaseRefresh.body;
    const revokeRefresh = await call<{ revoked?: boolean }>(`${env.site}/v1/oauth/revoke`, { form: { token: current.refresh_token }, basic: appCredentials("dm"), ip: ctx.ip });
    const revokeAccess = await call<{ revoked?: boolean }>(`${env.site}/v1/oauth/revoke`, { form: { token: current.access_token }, basic: appCredentials("dm"), ip: ctx.ip });
    const stillActive = await introspect("briefcase", current.access_token);
    results.check("dm revoking briefcase's refresh and access tokens revokes nothing (200 revoked:false) and briefcase's token stays active", revokeRefresh.status === 200 && revokeRefresh.body.revoked === false && revokeAccess.status === 200 && revokeAccess.body.revoked === false && (stillActive.body as { active?: boolean }).active === true, `${revokeRefresh.status} ${JSON.stringify(revokeRefresh.body).slice(0, 80)} / ${revokeAccess.status} / still active: ${(stillActive.body as { active?: boolean }).active}`);
    const dmRefresh = await token(t, { grant_type: "refresh_token", refresh_token: current.refresh_token }, appCredentials("dm"));
    results.check("dm can't refresh with briefcase's refresh token (400 invalid_grant)", dmRefresh.status === 400 && dmRefresh.body.error === "invalid_grant" && !dmRefresh.text.includes(current.refresh_token), `${dmRefresh.status} ${dmRefresh.body.error}: ${dmRefresh.body.error_description ?? ""}`.slice(0, 200));
    const ownRefresh = await token(t, { grant_type: "refresh_token", refresh_token: current.refresh_token }, appCredentials("briefcase"));
    remember(ctx, "refresh token", ownRefresh.body.refresh_token);
    remember(ctx, "access token", ownRefresh.body.access_token);
    results.check("…and briefcase itself still can (dm's attempts didn't burn or revoke its sign-in)", ownRefresh.status === 200 && !!ownRefresh.body.access_token, brief(ownRefresh));

    const third = await continueInto(t, carbon.jar, "briefcase", { scope: "openid email" });
    remember(ctx, "code", third.code);
    const stolenCode = await token(t, { grant_type: "authorization_code", code: third.code, redirect_uri: third.redirect, code_verifier: third.verifier }, appCredentials("dm"));
    results.check("dm can't redeem an authorization code issued to briefcase, even with briefcase's redirect URI and verifier (400 invalid_grant, code not echoed)", stolenCode.status === 400 && stolenCode.body.error === "invalid_grant" && !stolenCode.text.includes(third.code), `${stolenCode.status} ${stolenCode.body.error}: ${stolenCode.body.error_description ?? ""}`.slice(0, 200));
    const rightful = await token(t, { grant_type: "authorization_code", code: third.code, redirect_uri: third.redirect, code_verifier: third.verifier }, appCredentials("briefcase"));
    results.metric("briefcase's code still redeemable after dm's attempt (1 yes, 0 no)", rightful.status === 200 ? 1 : 0, "count");
    results.check(`(note) after dm's failed attempt briefcase's own exchange of the code answered ${rightful.status}`, true, rightful.status === 200 ? "the code stays bound to briefcase and usable once" : `burned: ${rightful.body.error} ${rightful.body.error_description ?? ""}`);

    const stolenSlt = await token(t, { grant_type: "urn:silicon:params:oauth:grant-type:slt", slt: slt.body.slt ?? "" }, appCredentials("briefcase"));
    results.check("briefcase can't redeem a short-lived token minted for remind (400 invalid_grant, SLT not echoed)", stolenSlt.status === 400 && stolenSlt.body.error === "invalid_grant" && !stolenSlt.text.includes(slt.body.slt ?? "~"), `${stolenSlt.status} ${stolenSlt.body.error}: ${stolenSlt.body.error_description ?? ""}`.slice(0, 200));

    const verify = (app: string) => call(`${env.site}/v1/proofs/verify`, { json: { proof_token: ata.body.proof_token }, basic: appCredentials(app), ip: ctx.ip });
    const byBriefcase2 = await verify("briefcase");
    const byWaveform = await verify("waveform");
    const byIssuer = await verify("commit");
    const byRemind = await verify("remind");
    results.check("an ATA proof from commit for remind verifies as exactly {valid:false, expires_at:null} for briefcase, for waveform and for its own issuer, and valid for remind alone", exactly(byBriefcase2, { valid: false, expires_at: null }) && exactly(byWaveform, { valid: false, expires_at: null }) && exactly(byIssuer, { valid: false, expires_at: null }) && (byRemind.body as { valid?: boolean }).valid === true, `briefcase ${byBriefcase2.text.slice(0, 60)} / waveform ${byWaveform.text.slice(0, 60)} / commit ${byIssuer.text.slice(0, 60)} / remind valid=${(byRemind.body as { valid?: boolean }).valid}`);
    const twoApps = await call(`${env.site}/v1/proofs/ata`, { json: { audiences: ["remind", "waveform"] }, basic: appCredentials("commit"), ip: ctx.ip, headers: { "idempotency-key": `sec-${tag()}` } });
    results.check("an ATA proof for two apps at once is refused (422 ata_single_app): a proof can never be verified by a second app", twoApps.status === 422 && errorOf(twoApps).code === "ata_single_app", brief(twoApps));

    // 8. A sign-in past its 900 days (time travel on the family) ends everything issued under it at once.
    const fresh = ownRefresh.body;
    const beforeExpiry = await introspect("briefcase", fresh.access_token);
    await sql(env, `update token_families set expires_at = now() - interval '1 second' where account_uuid = '${carbon.uuid}' and app_id = 'briefcase'`);
    const expiredIntrospect = await introspect("briefcase", fresh.access_token);
    const expiredRefresh = await token(t, { grant_type: "refresh_token", refresh_token: fresh.refresh_token }, appCredentials("briefcase"));
    const expiredUserinfo = await call(`${env.site}/v1/userinfo`, { bearer: fresh.access_token, ip: ctx.ip });
    results.check("once the sign-in (token family) is past its 900 days (time travel), its unexpired access token introspects inactive, is refused at /v1/userinfo, and its refresh token is refused", (beforeExpiry.body as { active?: boolean }).active === true && exactly(expiredIntrospect, { active: false }) && expiredUserinfo.status === 401 && expiredRefresh.status === 400 && expiredRefresh.body.error === "invalid_grant", `before ${(beforeExpiry.body as { active?: boolean }).active}; introspect ${expiredIntrospect.text}; userinfo ${expiredUserinfo.status}; refresh ${expiredRefresh.status} ${expiredRefresh.body.error}`);

    // 9. Sign-out kills the first-party access token at once (its sign-in is checked on every request), and the same
    //    for the developer platform's sign-out (its access token dies with the revoked refresh token).
    const out = await call(`${env.site}/v1/oauth/revoke`, { form: { token: firstParty.body.refresh_token, client_id: "accounts" }, ip: ctx.ip });
    const after = await call(`${env.site}/v1/me`, { bearer: firstParty.body.access_token, ip: ctx.ip });
    results.check("after the Silicon signs out (revoking its first-party refresh token) its still-unexpired access token is refused at once (401 token_revoked)", out.status === 200 && after.status === 401 && errorOf(after).code === "token_revoked", `${out.status} ${out.text.slice(0, 60)} / ${brief(after)}`);
    const devOut = await call<{ revoked?: boolean }>(`${env.site}/v1/oauth/revoke`, { form: { token: saketDev.refresh_token, client_id: "developer" }, ip: ctx.ip });
    const devAfter = await call(`${env.site}/v1/apps/briefcase`, { bearer: saketDev.access_token, ip: ctx.ip });
    results.check("after the developer platform signs out (client_id=developer revokes its own refresh token) its still-unexpired access token is refused at once on owner routes (401 token_revoked)", devOut.status === 200 && devOut.body.revoked === true && devAfter.status === 401 && errorOf(devAfter).code === "token_revoked", `${devOut.status} ${devOut.text.slice(0, 60)} / ${brief(devAfter)}`);
  },
};
