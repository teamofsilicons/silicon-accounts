/**
 * OpenID Connect as a generic client library sees it: discovery and JWKS, then openid-client (v6) drives quill-docs'
 * sign-in end to end (authorization URL, the code grant with PKCE, state and nonce checks, the EdDSA id_token verified
 * against the JWKS, userinfo with the subject check, refresh, introspection, revocation), and refuses what it must.
 *
 * openid-client is this suite's own dependency (web/package.json is not the suite's to change):
 *   npm install --prefix web/e2e/suites/auth-flows
 * It is loaded by a computed specifier so `pnpm -C web typecheck` never needs it.
 */
import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import type { Journey } from "../../context";
import { json, tag } from "../../lib";
import { Browserish, brief, drive, exchangeCode, fakeApp, jwtClaims, jwtHeader, redirectUriOf, sendCode, signUpVia } from "./_helpers";

interface OidcConfig {
  serverMetadata(): Record<string, unknown>;
}

interface OidcTokens {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  token_type: string;
  expires_in?: number;
  scope?: string;
  claims(): Record<string, unknown> | undefined;
}

/** The parts of openid-client this journey uses. */
interface OpenidClient {
  discovery(server: URL, clientId: string, metadata?: Record<string, unknown> | string, auth?: unknown, options?: { execute?: Array<(config: OidcConfig) => void> }): Promise<OidcConfig>;
  allowInsecureRequests(config: OidcConfig): void;
  ClientSecretBasic(secret: string): unknown;
  ClientSecretPost(secret: string): unknown;
  buildAuthorizationUrl(config: OidcConfig, parameters: Record<string, string>): URL;
  authorizationCodeGrant(config: OidcConfig, currentUrl: URL, checks?: Record<string, unknown>): Promise<OidcTokens>;
  refreshTokenGrant(config: OidcConfig, refreshToken: string): Promise<OidcTokens>;
  fetchUserInfo(config: OidcConfig, accessToken: string, expectedSubject: string): Promise<Record<string, unknown>>;
  tokenIntrospection(config: OidcConfig, token: string): Promise<Record<string, unknown>>;
  tokenRevocation(config: OidcConfig, token: string): Promise<void>;
  randomPKCECodeVerifier(): string;
  calculatePKCECodeChallenge(verifier: string): Promise<string>;
  randomState(): string;
  randomNonce(): string;
}

async function loadOpenidClient(): Promise<OpenidClient | null> {
  const specifier = "openid-client";
  try {
    return (await import(specifier)) as OpenidClient;
  } catch {
    return null;
  }
}

/** An error and its causes in one line (openid-client wraps oauth4webapi's precise message as the cause). */
function describeError(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current instanceof Error && depth < 4; depth++) {
    const extra = current as Error & { code?: unknown; error?: unknown };
    parts.push(`${extra.name}: ${extra.message}${extra.code ? ` [${String(extra.code)}]` : ""}${extra.error ? ` (${String(extra.error)})` : ""}`);
    current = extra.cause;
  }
  return parts.length ? parts.join(" ← ") : String(error);
}

const oidc: Journey = {
  name: "auth-flows-oidc",
  title: "OIDC discovery + JWKS, and openid-client driving quill-docs end to end: authorization URL, code grant with PKCE/state/nonce, the EdDSA id_token verified against the JWKS, userinfo, refresh, introspection, revocation; wrong state or nonce refused by the library",
  async run(ctx) {
    const { env, results } = ctx;
    const t = tag();

    // Discovery and JWKS as served through the site (cross-origin readable, cacheable).
    const disc = await json<Record<string, unknown>>(`${env.site}/.well-known/openid-configuration`, { headers: { origin: "https://some-app.example" } });
    const d = disc.body;
    const at = (path: string) => `${env.site}${path}`;
    results.check("discovery: issuer is the public origin, every endpoint absolute on it", disc.status === 200 && d.issuer === env.site && d.authorization_endpoint === at("/authorize") && d.token_endpoint === at("/v1/oauth/token") && d.userinfo_endpoint === at("/v1/userinfo") && d.jwks_uri === at("/.well-known/jwks.json") && d.revocation_endpoint === at("/v1/oauth/revoke") && d.introspection_endpoint === at("/v1/oauth/introspect"), JSON.stringify(d).slice(0, 400));
    const list = (key: string) => (Array.isArray(d[key]) ? (d[key] as string[]) : []);
    results.check("discovery: code flow only, S256 PKCE, EdDSA id_tokens, Basic and post client auth", JSON.stringify(list("response_types_supported")) === '["code"]' && list("code_challenge_methods_supported").includes("S256") && JSON.stringify(list("id_token_signing_alg_values_supported")) === '["EdDSA"]' && list("token_endpoint_auth_methods_supported").includes("client_secret_basic") && list("token_endpoint_auth_methods_supported").includes("client_secret_post"), JSON.stringify({ r: d.response_types_supported, c: d.code_challenge_methods_supported, a: d.id_token_signing_alg_values_supported }));
    results.check("discovery: grants authorization_code, refresh_token, device_code and the SLT grant; scopes and claims listed", ["authorization_code", "refresh_token", "urn:ietf:params:oauth:grant-type:device_code", "urn:silicon:params:oauth:grant-type:slt"].every(g => list("grant_types_supported").includes(g)) && ["openid", "profile", "email", "phone"].every(s => list("scopes_supported").includes(s)) && ["sub", "nonce", "auth_time", "email", "email_verified"].every(c => list("claims_supported").includes(c)), JSON.stringify({ g: d.grant_types_supported, s: d.scopes_supported }));
    results.check("discovery is CORS * and cacheable for 5 minutes", disc.headers.get("access-control-allow-origin") === "*" && /max-age=300/.test(disc.headers.get("cache-control") ?? ""), `${disc.headers.get("access-control-allow-origin")} ${disc.headers.get("cache-control")}`);
    const jwks = await json<{ keys: Array<Record<string, string>> }>(`${env.site}/.well-known/jwks.json`, { headers: { origin: "https://some-app.example" } });
    const key = jwks.body.keys?.[0];
    results.check("JWKS: an Ed25519 signing key (OKP, EdDSA, use sig) with a kid, CORS *", jwks.status === 200 && jwks.body.keys.length >= 1 && key?.kty === "OKP" && key.crv === "Ed25519" && key.alg === "EdDSA" && key.use === "sig" && !!key.kid && !("d" in key) && jwks.headers.get("access-control-allow-origin") === "*", JSON.stringify(jwks.body));

    // Claims follow the granted scopes: ledgerly (phone + dob required, timezone optional) asking for openid.
    const l = new Browserish(env, ctx.ip);
    const ledger = await signUpVia(l, "ledgerly", `oidc.ledger.${t}@example.test`, { scope: "openid", share: ["timezone"], timezone: "Asia/Kolkata", signup: { dob: "1991-07-04" } });
    const ledgerTokens = await exchangeCode(env, "ledgerly", ledger.code, ledger.started.redirectUri, ledger.started.verifier);
    const idToken = ledgerTokens.body.id_token ?? "";
    const lc = jwtClaims(idToken);
    results.check("ledgerly's id_token carries the granted details: phone_number (+verified), birthdate, zoneinfo — and no email (not granted)", typeof lc.phone_number === "string" && lc.phone_number_verified === true && lc.birthdate === "1991-07-04" && lc.zoneinfo === "Asia/Kolkata" && !("email" in lc) && lc.nonce === ledger.started.nonce && lc.aud === "ledgerly", JSON.stringify(lc));
    const [head, payload, signature] = idToken.split(".");
    const signatureOk = !!key && !!signature && cryptoVerify(null, Buffer.from(`${head}.${payload}`), createPublicKey({ key: { ...key }, format: "jwk" }), Buffer.from(signature, "base64url"));
    results.check("…its Ed25519 signature verifies against the JWKS key (node:crypto, independently of any library)", signatureOk, String(jwtHeader(idToken).kid));
    const noOpenid = await signUpVia(new Browserish(env, ctx.ip), "briefcase", `oidc.none.${t}@example.test`);
    const noIdToken = await exchangeCode(env, "briefcase", noOpenid.code, noOpenid.started.redirectUri, noOpenid.started.verifier);
    results.check("without openid in scope there is no id_token", noIdToken.status === 200 && noIdToken.body.id_token === undefined && !noIdToken.body.scope.split(" ").includes("openid"), brief(noIdToken));

    const client = await loadOpenidClient();
    results.check("openid-client is installed for this suite (npm install --prefix web/e2e/suites/auth-flows)", client !== null);
    if (!client) return;
    const secret = fakeApp("quill-docs").secret;
    const redirectUri = redirectUriOf(env, "quill-docs");
    let config: OidcConfig;
    try {
      config = await client.discovery(new URL(env.site), "quill-docs", { client_secret: secret }, client.ClientSecretBasic(secret), { execute: [client.allowInsecureRequests] });
      results.check("openid-client: discovery accepted (issuer matches the URL it was fetched from)", config.serverMetadata().issuer === env.site, String(config.serverMetadata().issuer));
    } catch (error) {
      results.check("openid-client: discovery accepted (issuer matches the URL it was fetched from)", false, describeError(error));
      return;
    }

    // The library builds the authorization URL; the hosted flow is played by a browser stand-in.
    const verifier = client.randomPKCECodeVerifier();
    const state = client.randomState();
    const nonce = client.randomNonce();
    const authorizeUrl = client.buildAuthorizationUrl(config, { redirect_uri: redirectUri, scope: "openid email", code_challenge: await client.calculatePKCECodeChallenge(verifier), code_challenge_method: "S256", state, nonce });
    results.check("openid-client's authorization URL is the site's /authorize with client_id, PKCE, state and nonce", authorizeUrl.origin + authorizeUrl.pathname === at("/authorize") && authorizeUrl.searchParams.get("client_id") === "quill-docs" && authorizeUrl.searchParams.get("response_type") === "code", authorizeUrl.toString().slice(0, 200));
    const b = new Browserish(env, ctx.ip);
    const email = `oidc.client.${t}@example.test`;
    const created = await b.createFlow({ ...Object.fromEntries(authorizeUrl.searchParams), timezone: "Europe/Lisbon" });
    results.check("the hosted flow accepts the library's authorization request (client_id, response_type=code)", created.status === 201, brief(created));
    if (created.status !== 201) return;
    const sent = await sendCode(b, created.body.flow.id, { email });
    const verified = await b.act(created.body.flow.id, "verify", { code: sent.code ?? "" });
    const done = await drive(b, verified.body.flow, { share: ["email"] });
    const callback = new URL(done.redirect_to ?? `${redirectUri}?error=no_redirect`);

    // A wrong state is refused by the library before it spends the code.
    try {
      await client.authorizationCodeGrant(config, callback, { pkceCodeVerifier: verifier, expectedState: `${state}x`, expectedNonce: nonce });
      results.check("openid-client refuses a callback whose state doesn't match", false, "it accepted the wrong state");
    } catch (error) {
      results.check("openid-client refuses a callback whose state doesn't match", /state/i.test(describeError(error)), describeError(error));
    }

    let tokens: OidcTokens | null = null;
    try {
      tokens = await client.authorizationCodeGrant(config, callback, { pkceCodeVerifier: verifier, expectedState: state, expectedNonce: nonce, idTokenExpected: true });
    } catch (error) {
      results.check("openid-client: the code grant succeeds and the id_token verifies", false, describeError(error));
      return;
    }
    const claims = tokens.claims() ?? {};
    const header = jwtHeader(tokens.id_token);
    results.check("openid-client: the code grant succeeds and the EdDSA id_token verifies (signature against the JWKS, iss, aud, exp, nonce)", tokens.token_type.toLowerCase() === "bearer" && header.alg === "EdDSA" && header.kid === key?.kid && claims.iss === env.site && claims.aud === "quill-docs" && claims.nonce === nonce, JSON.stringify({ header, claims }).slice(0, 400));
    results.check("id_token claims: sub (the uuid), email + email_verified, name, picture, preferred_username, auth_time, zoneinfo absent (not granted)", typeof claims.sub === "string" && claims.email === email && claims.email_verified === true && typeof claims.name === "string" && typeof claims.picture === "string" && String(claims.preferred_username).startsWith("c:oidc-client-") && typeof claims.auth_time === "number" && !("zoneinfo" in claims), JSON.stringify(claims));
    const sub = String(claims.sub);

    try {
      const info = await client.fetchUserInfo(config, tokens.access_token, sub);
      results.check("openid-client: userinfo with the subject check", info.sub === sub && info.email === email, JSON.stringify(info).slice(0, 200));
    } catch (error) {
      results.check("openid-client: userinfo with the subject check", false, describeError(error));
    }
    try {
      const introspected = await client.tokenIntrospection(config, tokens.access_token);
      results.check("openid-client: introspection says active for quill-docs", introspected.active === true && introspected.sub === sub && introspected.client_id === "quill-docs", JSON.stringify(introspected));
    } catch (error) {
      results.check("openid-client: introspection says active for quill-docs", false, describeError(error));
    }
    let refreshed: OidcTokens | null = null;
    try {
      refreshed = await client.refreshTokenGrant(config, tokens.refresh_token ?? "");
      const again = refreshed.claims() ?? {};
      results.check("openid-client: refresh rotates and the new id_token verifies for the same subject", refreshed.refresh_token !== tokens.refresh_token && again.sub === sub && again.iss === env.site, JSON.stringify(again).slice(0, 200));
    } catch (error) {
      results.check("openid-client: refresh rotates and the new id_token verifies for the same subject", false, describeError(error));
    }
    if (refreshed?.refresh_token) {
      try {
        await client.tokenRevocation(config, refreshed.refresh_token);
        await client.refreshTokenGrant(config, refreshed.refresh_token).then(
          () => results.check("openid-client: after revocation the refresh token is refused", false, "the refresh still worked"),
          error => results.check("openid-client: after revocation the refresh token is refused (invalid_grant)", /invalid_grant/.test(describeError(error)), describeError(error)),
        );
      } catch (error) {
        results.check("openid-client: revocation", false, describeError(error));
      }
    }

    // The library spends the code before it sees a wrong nonce, and refuses that id_token.
    const second = new Browserish(env, ctx.ip);
    const verifier2 = client.randomPKCECodeVerifier();
    const state2 = client.randomState();
    const url2 = client.buildAuthorizationUrl(config, { redirect_uri: redirectUri, scope: "openid email", code_challenge: await client.calculatePKCECodeChallenge(verifier2), code_challenge_method: "S256", state: state2, nonce: "the-real-nonce" });
    const f2 = await second.createFlow({ ...Object.fromEntries(url2.searchParams), timezone: "UTC" });
    const s2 = await sendCode(second, f2.body.flow.id, { email: `oidc.nonce.${t}@example.test` });
    const v2 = await second.act(f2.body.flow.id, "verify", { code: s2.code ?? "" });
    const d2 = await drive(second, v2.body.flow, { share: ["email"] });
    try {
      await client.authorizationCodeGrant(config, new URL(d2.redirect_to ?? redirectUri), { pkceCodeVerifier: verifier2, expectedState: state2, expectedNonce: "another-nonce" });
      results.check("openid-client refuses an id_token whose nonce isn't the one it sent", false, "accepted");
    } catch (error) {
      results.check("openid-client refuses an id_token whose nonce isn't the one it sent", /nonce/i.test(describeError(error)), describeError(error));
    }

    // client_secret_post works the same.
    try {
      const postConfig = await client.discovery(new URL(env.site), "quill-docs", { client_secret: secret }, client.ClientSecretPost(secret), { execute: [client.allowInsecureRequests] });
      const third = new Browserish(env, ctx.ip);
      const verifier3 = client.randomPKCECodeVerifier();
      const state3 = client.randomState();
      const nonce3 = client.randomNonce();
      const url3 = client.buildAuthorizationUrl(postConfig, { redirect_uri: redirectUri, scope: "openid", code_challenge: await client.calculatePKCECodeChallenge(verifier3), code_challenge_method: "S256", state: state3, nonce: nonce3 });
      const f3 = await third.createFlow({ ...Object.fromEntries(url3.searchParams), timezone: "UTC" });
      const s3 = await sendCode(third, f3.body.flow.id, { email: `oidc.post.${t}@example.test` });
      const v3 = await third.act(f3.body.flow.id, "verify", { code: s3.code ?? "" });
      const d3 = await drive(third, v3.body.flow);
      const t3 = await client.authorizationCodeGrant(postConfig, new URL(d3.redirect_to ?? redirectUri), { pkceCodeVerifier: verifier3, expectedState: state3, expectedNonce: nonce3 });
      const c3 = t3.claims() ?? {};
      results.check("client_secret_post: scope openid alone → an id_token without email claims", c3.nonce === nonce3 && !("email" in c3) && (t3.scope ?? "").split(" ").includes("openid"), JSON.stringify(c3).slice(0, 300));
    } catch (error) {
      results.check("client_secret_post: scope openid alone → an id_token without email claims", false, describeError(error));
    }
  },
};

export const journeys: Journey[] = [oidc];
