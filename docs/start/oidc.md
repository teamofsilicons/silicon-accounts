---
title: Use any OpenID Connect library
description: Point a stock OpenID Connect library at the discovery document, use your app id and secret as client credentials, and get a verified EdDSA id_token; what is supported, what isn't, and what to use instead.
kind: instructive
order: 14
related:
  - start/hosted-pages.md
  - start/tokens.md
  - learn/tokens-and-sessions.md
  - learn/what-apps-see.md
---

# Use any OpenID Connect library

You'll give your OpenID Connect library the issuer `https://accounts.teamofsilicons.com`, your
app id as `client_id` and your app secret as `client_secret`, and let it run the
authorization code flow with PKCE and a nonce. Silicon Accounts is an OIDC provider: the
library discovers every endpoint, validates the `id_token` (signed with EdDSA, Ed25519) and
fetches userinfo. This example uses [openid-client](https://github.com/panva/openid-client)
v6 for Node:

```sh
npm init -y && npm pkg set type=module && npm install openid-client
```

```ts
// oidc-app.ts: sign in through OpenID Connect with a stock library (openid-client v6).
// npm install openid-client; "type": "module" in package.json; Node 24+:
// ACCOUNTS_APP_ID=briefcase ACCOUNTS_APP_SECRET=sa_app_… node oidc-app.ts, then open http://localhost:3000/login
import { createServer } from "node:http";
import * as oidc from "openid-client";

const ISSUER = new URL(process.env.ACCOUNTS_URL ?? "https://accounts.teamofsilicons.com");
const APP_ID = process.env.ACCOUNTS_APP_ID ?? "briefcase"; // your client_id
const APP_SECRET = process.env.ACCOUNTS_APP_SECRET ?? ""; // your client_secret
const PORT = Number(process.env.PORT ?? 3000);
const REDIRECT_URI = `http://localhost:${PORT}/callback`; // one of the app's redirect_uris

// Reads /.well-known/openid-configuration once. id_tokens are signed with EdDSA (Ed25519).
const config = await oidc.discovery(
  ISSUER,
  APP_ID,
  APP_SECRET,
  undefined,
  ISSUER.protocol === "http:" ? { execute: [oidc.allowInsecureRequests] } : undefined, // a local http stack only
);

const pending = new Map<string, { verifier: string; nonce: string }>(); // state → PKCE verifier + nonce

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  if (url.pathname === "/login") {
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const verifier = oidc.randomPKCECodeVerifier();
    pending.set(state, { verifier, nonce });
    const authorize = oidc.buildAuthorizationUrl(config, {
      redirect_uri: REDIRECT_URI,
      scope: "openid email",
      state,
      nonce,
      code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
      code_challenge_method: "S256",
    });
    res.writeHead(302, { Location: authorize.href, "Set-Cookie": `signin_state=${state}; HttpOnly; SameSite=Lax; Path=/; Max-Age=3600` });
    return res.end();
  }
  if (url.pathname === "/callback") {
    const state = url.searchParams.get("state") ?? "";
    const cookieState = /(?:^|;\s*)signin_state=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
    const started = pending.get(state);
    pending.delete(state);
    if (!started || cookieState !== state) return res.writeHead(400).end("Unknown sign-in: start again at /login");
    try {
      // Checks state, exchanges the code with PKCE, validates the id_token (EdDSA, iss, aud, exp, nonce).
      const tokens = await oidc.authorizationCodeGrant(config, url, {
        pkceCodeVerifier: started.verifier,
        expectedState: state,
        expectedNonce: started.nonce,
        idTokenExpected: true,
      });
      const claims = tokens.claims()!; // claims.sub is the account uuid: key your user on it
      const userinfo = await oidc.fetchUserInfo(config, tokens.access_token, claims.sub);
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ claims, userinfo }, null, 2));
    } catch (error) {
      return res.writeHead(400).end(String(error)); // error=access_denied and every refusal land here
    }
  }
  res.writeHead(404).end();
}).listen(PORT, () => console.log(`Open http://localhost:${PORT}/login`));
```

After a sign-in, the callback shows the validated claims and the userinfo:

```json
{
  "claims": {
    "iss": "https://accounts.teamofsilicons.com",
    "sub": "aQm",
    "aud": "briefcase",
    "exp": 1791343503,
    "iat": 1791341703,
    "auth_time": 1791341703,
    "nonce": "BrXP_yF6jiGsOrcQmOMyAjZVLpSITuhaZwekxsvD8WM",
    "name": "Oidc3 Docs",
    "picture": "https://iris.teamofsilicons.com/pfp/carbon?id=aQm",
    "preferred_username": "c:oidc3-docs",
    "email": "oidc3-docs@example.test",
    "email_verified": true
  },
  "userinfo": {
    "display_name": "Oidc3 Docs",
    "email": "oidc3-docs@example.test",
    "email_verified": true,
    "id": "c:oidc3-docs",
    "kind": "carbon",
    "membership_id": "briefcase:aQm",
    "name": "Oidc3 Docs",
    "pfp_url": "https://iris.teamofsilicons.com/pfp/carbon?id=aQm",
    "picture": "https://iris.teamofsilicons.com/pfp/carbon?id=aQm",
    "sub": "aQm",
    "updated_at": "2026-10-07T02:55:03.809Z",
    "uuid": "aQm",
    "version": 1
  }
}
```

A declined what's-shared screen reaches the `catch` as openid-client's
`AuthorizationResponseError` (`error=access_denied`).
`oidc.refreshTokenGrant(config, refresh_token)` rotates the refresh token and, with `openid`
granted, returns a new `id_token` (without a nonce). The library's defaults work as shown; a
library that assumes RS256 needs `id_token_signed_response_alg: "EdDSA"` in its client
metadata.

## The settings every library needs

| Setting | Value |
|---|---|
| Issuer (discovery) | `https://accounts.teamofsilicons.com`, exactly, with no trailing slash. Discovery is at `/.well-known/openid-configuration`, keys at `/.well-known/jwks.json` (both cacheable 5 minutes). |
| `client_id` | Your app id, e.g. `briefcase`. |
| `client_secret` | Your app secret. Auth method `client_secret_basic` or `client_secret_post`. |
| Redirect URI | One of your app's `redirect_uris`, character for character. |
| Response type | `code` (the only one). Response mode `query`. |
| PKCE | `S256` (or `plain`). Use it: once you send a challenge, the verifier is required. |
| Scopes | `openid` plus any of `email`, `phone`, `dob`, `timezone`; `profile` is always granted. |
| id_token algorithm | `EdDSA` (Ed25519), the only one. |

## The discovery document

```json
{
  "authorization_endpoint": "https://accounts.teamofsilicons.com/authorize",
  "claims_parameter_supported": false,
  "claims_supported": ["iss", "sub", "aud", "exp", "iat", "auth_time", "nonce", "name", "picture", "preferred_username", "email", "email_verified", "phone_number", "phone_number_verified", "zoneinfo", "birthdate"],
  "code_challenge_methods_supported": ["S256", "plain"],
  "device_authorization_endpoint": "https://accounts.teamofsilicons.com/v1/device/authorize",
  "grant_types_supported": ["authorization_code", "refresh_token", "urn:ietf:params:oauth:grant-type:device_code", "urn:silicon:params:oauth:grant-type:slt"],
  "id_token_signing_alg_values_supported": ["EdDSA"],
  "introspection_endpoint": "https://accounts.teamofsilicons.com/v1/oauth/introspect",
  "introspection_endpoint_auth_methods_supported": ["client_secret_basic", "client_secret_post"],
  "issuer": "https://accounts.teamofsilicons.com",
  "jwks_uri": "https://accounts.teamofsilicons.com/.well-known/jwks.json",
  "prompt_values_supported": ["none", "login", "consent", "select_account"],
  "request_parameter_supported": false,
  "request_uri_parameter_supported": false,
  "response_modes_supported": ["query"],
  "response_types_supported": ["code"],
  "revocation_endpoint": "https://accounts.teamofsilicons.com/v1/oauth/revoke",
  "revocation_endpoint_auth_methods_supported": ["client_secret_basic", "client_secret_post"],
  "scopes_supported": ["profile", "email", "phone", "dob", "timezone", "openid", "offline_access"],
  "service_documentation": "https://developers.teamofsilicons.com/docs/accounts",
  "subject_types_supported": ["public"],
  "token_endpoint": "https://accounts.teamofsilicons.com/v1/oauth/token",
  "token_endpoint_auth_methods_supported": ["client_secret_basic", "client_secret_post"],
  "userinfo_endpoint": "https://accounts.teamofsilicons.com/v1/userinfo"
}
```

The device grant belongs to the `accounts` CLI and the `urn:silicon:params:oauth:grant-type:slt`
grant is how [Silicons sign in to your app](add-sign-in.md#silicons-sign-in-without-the-pages);
neither is part of a browser sign-in.

## The id_token

The `id_token` comes with the token response whenever the sign-in included `openid`, and
again with every refresh of that sign-in.

| Claim | Value |
|---|---|
| `iss` | `https://accounts.teamofsilicons.com` |
| `sub` | The account's `uuid`: permanent, the same in every token and webhook. Key your user on it. |
| `aud` | Your app id. |
| `exp`, `iat` | Same lifetime as the access token: 30 minutes. |
| `auth_time` | When the Carbon last proved who they are in this browser (a code, Google, Apple). "Continue as …" and `prompt=none` keep the earlier time, so `auth_time` can be well before `iat`. |
| `nonce` | Your `nonce`, byte for byte (absent after a refresh). |
| `name`, `picture`, `preferred_username` | Display name, profile photo URL, and the current `c:`/`si:` id (it can change; never key on it). Always present. |
| `email`, `email_verified` | The primary email, with scope `email` (Carbons only). |
| `phone_number`, `phone_number_verified` | The primary phone in E.164, with scope `phone` (Carbons only). |
| `birthdate` | `YYYY-MM-DD`, with scope `dob`. |
| `zoneinfo` | An IANA time zone, with scope `timezone`. |

A Silicon signed in with a short-lived token gets no `id_token` (there is no browser sign-in to
describe); its token response carries the same account view as everyone else's.

## Userinfo

`GET /v1/userinfo` with `Authorization: Bearer <access token>` (or `POST` with the token as a
form field `access_token`) returns the standard claims (`sub`, `name`, `picture`, `email`,
`email_verified`, `phone_number`, `phone_number_verified`, `zoneinfo`, `birthdate`) next to
Silicon Accounts' own view of the account (`uuid`, `membership_id`, `kind`, `id`,
`display_name`, `pfp_url`, `version`, `updated_at`, and `custodian` for a Silicon), limited
to what the account granted your app. Libraries ignore the fields they don't know. Errors and
details are in [tokens](tokens.md#read-the-account-userinfo).

## What isn't supported, and what to use instead

| You may expect | Here | Use instead |
|---|---|---|
| Implicit or hybrid flows (`response_type=token`, `id_token`) | `unsupported_response_type` | The code flow with PKCE. |
| `response_mode=form_post` or `fragment` | Only `query` | The code arrives as `?code=`. |
| `max_age` | Ignored | `prompt=login`, then check `auth_time`. |
| `request`, `request_uri`, `claims` parameters | Ignored | Plain query parameters; scopes decide the claims. |
| RS256 or other algorithms | EdDSA only | A library with Ed25519 support (`jose`, `openid-client`, the Rust package). |
| RP-initiated logout (`end_session_endpoint`) | None | Revoke your sign-in with `POST /v1/oauth/revoke`. The Carbon stays signed in to Silicon Accounts itself, so the next sign-in offers "Continue as …"; send `prompt=login` when you need a fresh sign-in. |
| Front- or back-channel logout | None | [Webhooks](webhooks.md): `membership.signed_out`, `membership.access_removed`, `account.deleted`. |
| Dynamic client registration | None | Apps are created in Silicon Apps; their sign-in setup is changed with `PATCH /v1/apps/{app_id}/signin-config`. |
| Public clients (no secret) | Every app is confidential | Exchange the code on a server you control; native and single-page apps send the code there. |
| `offline_access` to get a refresh token | Accepted, ignored | Every sign-in returns a refresh token. |

To check access tokens your API receives without a library, see
[Check an access token](tokens.md#check-an-access-token).
