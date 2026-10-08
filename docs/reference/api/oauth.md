---
title: OAuth and OIDC endpoints
description: Reference for /authorize, discovery, the JWKS, the token endpoint and its four grants, revocation, introspection, userinfo and the device authorization — every parameter, response field, claim and error.
kind: informative
order: 61
related:
  - reference/api.md
  - start/add-sign-in.md
  - start/oidc.md
  - start/tokens.md
  - learn/tokens-and-sessions.md
  - learn/what-apps-see.md
  - reference/errors.md
---

# OAuth and OIDC endpoints

These endpoints turn a finished sign-in into tokens, keep the tokens fresh, check them and end
them. They follow OAuth 2.0 and OpenID Connect, so any standard library works against them
(start from the discovery document). For the step-by-step guide see
[Add sign-in to your app](../../start/add-sign-in.md) and [Tokens](../../start/tokens.md); for
why tokens behave this way, [Tokens and sessions](../../learn/tokens-and-sessions.md).

Exchange the code your redirect URI received:

```sh
curl -s -X POST "$ACCOUNTS_URL/v1/oauth/token" -u "$APP_ID:$APP_SECRET" \
  -d grant_type=authorization_code \
  -d code="$CODE" \
  --data-urlencode redirect_uri="http://127.0.0.1:8593/briefcase/callback" \
  -d code_verifier="$CODE_VERIFIER"
```

```json
{
  "access_token": "eyJ0eXAiOiJKV1QiLCJhbGciOiJFZERTQSIsImtpZCI6ImRldi0xIn0.eyJpc3Mi…",
  "token_type": "Bearer",
  "expires_in": 1800,
  "refresh_token": "sar_6L-L2WsKOKHtl0b3Fb56ogKHTklLnY7bRDm0s_2ZSS4",
  "refresh_token_expires_at": "2029-03-25T02:33:02.302Z",
  "scope": "profile email timezone openid",
  "id_token": "eyJ0eXAiOiJKV1QiLCJhbGciOiJFZERTQSIsImtpZCI6ImRldi0xIn0.eyJpc3Mi…",
  "membership_id": "briefcase:8HV",
  "account": {
    "uuid": "8HV",
    "membership_id": "briefcase:8HV",
    "kind": "carbon",
    "id": "c:ada",
    "display_name": "Ada Lovelace",
    "pfp_url": "https://iris.teamofsilicons.com/pfp/carbon?id=8HV",
    "email": "ada@example.test",
    "email_verified": true,
    "timezone": "Asia/Kolkata",
    "updated_at": "2026-10-07T02:32:51.018Z",
    "version": 1
  }
}
```

Store `account.uuid` (or `membership_id`) as the account's key in your app. The `id` (`c:ada`)
is for display and can change.

## `GET /authorize`

The hosted sign-in page on the account site. Send the browser here; it comes back to your
`redirect_uri`. This is a page, not a JSON endpoint: the page validates the request with
`POST /v1/flows` ([Hosted sign-in](sign-in.md)).

| Parameter | Required | Meaning |
|---|---|---|
| `app_id` | yes | your app id (`client_id` is accepted as an alias; if both are sent they must agree) |
| `redirect_uri` | yes | must equal one of the app's `redirect_uris` exactly, after trimming. `http://localhost` and `http://127.0.0.1` URIs match on any port when registered with that host |
| `state` | recommended | returned unchanged, byte for byte; check it on return to stop CSRF |
| `code_challenge` | recommended | PKCE challenge (RFC 7636) |
| `code_challenge_method` | no | `S256` (default when a challenge is sent) or `plain` |
| `scope` | no | space-separated: `profile` (always granted), `email`, `phone`, `dob`, `timezone`, `openid` (adds an `id_token`), `offline_access` (accepted and ignored: refresh tokens are always issued) |
| `nonce` | with `openid` | echoed in the `id_token` unchanged |
| `prompt` | no | `login` (ignore the browser's session), `consent` (always show what is shared), `select_account` (show the chooser), `none` (never show a page: complete silently or fail) |
| `intent` | no | `signin` (default) or `signup`: which version of the pages opens ("Sign in to Briefcase" or "Create your Briefcase account"). The account logic is the same: a first visit is a sign-up either way |
| `method` | no | the app's own direct button: `google` or `apple` first show the Opening page ("Opening Google to sign you in to {app}…") and move on to the provider by themselves; `email` or `phone` open on that empty field. Must be enabled for the app |
| `response_type` | no | only `code` is supported |

`login_hint` is accepted without an error and ignored: it is not prefilled, not stored, not
echoed and not forwarded to Google or Apple. An app can never hand Silicon Accounts a Carbon's
email or phone; the Carbon always types it on the hosted pages.

Back on your `redirect_uri`:

- success: `?code=sac_…&state=…` — exchange the code within 2 minutes;
- refusal: `?error=…&error_description=…&state=…` with `error` = `access_denied` (the Carbon
  cancelled on a details or review page), `login_required`, `consent_required` or `interaction_required`
  (`prompt=none` couldn't finish silently), `invalid_scope`, `invalid_request` or
  `unsupported_response_type`.

An unknown app, a disabled app or an unregistered `redirect_uri` is shown as an error page and is
never redirected to, so the page can't be used to send codes to someone else's URL.

| Scope | What the app gets in `account` |
|---|---|
| `profile` | always: `uuid`, `membership_id`, `kind`, `id`, `display_name`, `pfp_url`, `updated_at`, `version`; Silicons also `custodian` `{uuid, id}` |
| `email` | `email`, `email_verified` (the primary email; Carbons only) |
| `phone` | `phone`, `phone_verified` (the primary phone; Carbons only) |
| `dob` | `dob` (`YYYY-MM-DD`) |
| `timezone` | `timezone` (IANA, like `Asia/Kolkata`) |
| `openid` | an `id_token` in the token response |

Besides `scope`, the app's sign-in setup decides what is shared: its `required_fields` are always
shared (and must exist on the account before the code is issued: a missing email or phone is
added on the page, with a code), its `optional_fields` are checkboxes on the details pages,
unticked until the Carbon ticks them. Details `scope` asks for that the app doesn't configure are
optional checkboxes on the last page. Silicons never have an email or a phone: those scopes are
simply left out for them and never block a Silicon.
[What apps see](../../learn/what-apps-see.md) explains the rules.

## `GET /.well-known/openid-configuration`

Public, `Access-Control-Allow-Origin: *`, `Cache-Control: public, max-age=300`.

```sh
curl -s "$ACCOUNTS_URL/.well-known/openid-configuration"
```

```json
{
  "issuer": "https://accounts.teamofsilicons.com",
  "authorization_endpoint": "https://accounts.teamofsilicons.com/authorize",
  "token_endpoint": "https://accounts.teamofsilicons.com/v1/oauth/token",
  "userinfo_endpoint": "https://accounts.teamofsilicons.com/v1/userinfo",
  "jwks_uri": "https://accounts.teamofsilicons.com/.well-known/jwks.json",
  "revocation_endpoint": "https://accounts.teamofsilicons.com/v1/oauth/revoke",
  "introspection_endpoint": "https://accounts.teamofsilicons.com/v1/oauth/introspect",
  "device_authorization_endpoint": "https://accounts.teamofsilicons.com/v1/device/authorize",
  "service_documentation": "https://accounts.teamofsilicons.com/docs",
  "response_types_supported": ["code"],
  "response_modes_supported": ["query"],
  "grant_types_supported": [
    "authorization_code",
    "refresh_token",
    "urn:ietf:params:oauth:grant-type:device_code",
    "urn:silicon:params:oauth:grant-type:slt"
  ],
  "subject_types_supported": ["public"],
  "id_token_signing_alg_values_supported": ["EdDSA"],
  "scopes_supported": ["profile", "email", "phone", "dob", "timezone", "openid", "offline_access"],
  "claims_supported": [
    "iss", "sub", "aud", "exp", "iat", "auth_time", "nonce", "name", "picture",
    "preferred_username", "email", "email_verified", "phone_number",
    "phone_number_verified", "zoneinfo", "birthdate"
  ],
  "token_endpoint_auth_methods_supported": ["client_secret_basic", "client_secret_post"],
  "revocation_endpoint_auth_methods_supported": ["client_secret_basic", "client_secret_post"],
  "introspection_endpoint_auth_methods_supported": ["client_secret_basic", "client_secret_post"],
  "code_challenge_methods_supported": ["S256", "plain"],
  "prompt_values_supported": ["none", "login", "consent", "select_account"],
  "claims_parameter_supported": false,
  "request_parameter_supported": false,
  "request_uri_parameter_supported": false
}
```

## `GET /.well-known/jwks.json`

The public keys that sign access tokens and `id_token`s. Public, CORS `*`, cacheable for 5
minutes. Cache it and fetch it again when a token names a `kid` you don't have.

```json
{
  "keys": [
    { "kty": "OKP", "crv": "Ed25519", "x": "YJpQ5011mgRRBUr1o9VT1FjZaKeccFlUhDxZNxWWSyg", "kid": "dev-1", "use": "sig", "alg": "EdDSA" }
  ]
}
```

## `POST /v1/oauth/token`

Every grant. The body is `application/x-www-form-urlencoded` (or a JSON object of strings).
Responses are `Cache-Control: no-store`; errors are RFC 6749 bodies.

**Client authentication.** Send the app's credentials with HTTP Basic
(`-u app_id:app_secret`) or as `client_id` + `client_secret` in the body, never both
(`invalid_request`). A `client_id` in the body must match the Basic credentials
(`invalid_client`). `client_id=accounts` with no secret is the first-party public client (the
`accounts` CLI): it may only use `refresh_token` and the device-code grant
(`unauthorized_client` otherwise). `client_id=developer` with no secret is the developer
platform (developers.teamofsilicons.com, whose server holds the tokens): it may only use
`authorization_code` with PKCE `S256` (a missing challenge or `plain` is `invalid_grant`, and the
code is burnt), `refresh_token` for its own tokens, and `/v1/oauth/revoke`; other grants are
`unauthorized_client` and introspection is `invalid_client`. Its tokens have `aud: "developer"`
and act for their Carbon only on `GET /v1/me`, `GET /v1/session`, `GET /v1/me/owned-apps` and
the owner routes under `/v1/apps/{app_id}/…`; anywhere else they get 401
`token_wrong_audience`.

### `grant_type=authorization_code`

| Parameter | |
|---|---|
| `code` | the `sac_…` code from your redirect URI |
| `redirect_uri` | exactly the `redirect_uri` sent to `/authorize` |
| `code_verifier` | the PKCE verifier (43–128 characters of `A-Z a-z 0-9 - . _ ~`); required when a challenge was sent, refused when none was |

Codes are single-use and live 120 seconds. Any refused redemption burns the code. Presenting a
code that was already exchanged also revokes the tokens issued from it, and the app gets
`membership.signed_out` with reason `authorization_code_reuse`: a code seen twice means
someone else may have it.

### `grant_type=refresh_token`

| Parameter | |
|---|---|
| `refresh_token` | the newest `sar_…` refresh token you received |
| `scope` | optional; may only repeat or narrow the granted scopes (`invalid_scope` if it adds one) |

Every refresh returns a new refresh token and kills the old one. Presenting a used refresh token
revokes the whole sign-in (the token family): every access and refresh token of it stops working
and the app gets `membership.signed_out` with reason `refresh_token_reuse`. Always store the new
token before using it. `refresh_token_expires_at` doesn't move: a sign-in lasts at most 900 days
from when it started.

```sh
curl -s -X POST "$ACCOUNTS_URL/v1/oauth/token" -u "$APP_ID:$APP_SECRET" \
  -d grant_type=refresh_token -d refresh_token="$REFRESH_TOKEN"
```

Presenting the same refresh token again:

```json
{
  "error": "invalid_grant",
  "error_description": "This refresh token was already used once. Presenting a used refresh token revokes the whole sign-in to protect the account, so this sign-in is now revoked; sign in again."
}
```

First-party tokens refresh the same way with `-d client_id=accounts` and no secret.

### `grant_type=urn:silicon:params:oauth:grant-type:slt`

How a Silicon signs into your app: it gets a short-lived token for your app
(`POST /v1/me/short-lived-tokens`, or `accounts login --app <app_id>`) and hands it to you. The
alias `grant_type=slt` works too.

| Parameter | |
|---|---|
| `slt` | the `slt_…` token (single use, 120 seconds, only for the app it was issued for) |

```sh
curl -s -X POST "$ACCOUNTS_URL/v1/oauth/token" -u "$APP_ID:$APP_SECRET" \
  -d grant_type=urn:silicon:params:oauth:grant-type:slt -d slt="$SLT"
```

```json
{
  "access_token": "eyJ…",
  "token_type": "Bearer",
  "expires_in": 1800,
  "refresh_token": "sar_…",
  "refresh_token_expires_at": "2029-03-25T02:33:57.696Z",
  "scope": "profile timezone",
  "membership_id": "briefcase:K1E",
  "account": {
    "uuid": "K1E",
    "membership_id": "briefcase:K1E",
    "kind": "silicon",
    "id": "si:scout",
    "display_name": "Scout",
    "pfp_url": "https://iris.teamofsilicons.com/pfp/silicon?id=K1E",
    "timezone": "Asia/Kolkata",
    "custodian": { "uuid": "zQo", "id": "c:saket" },
    "updated_at": "2026-10-07T02:33:40.817Z",
    "version": 1
  }
}
```

An SLT is refused when the Silicon's STK was rotated, or the account removed your app's access,
after the SLT was issued.

### `grant_type=urn:ietf:params:oauth:grant-type:device_code`

The `accounts` CLI's device sign-in (RFC 8628); only the first-party client may use it. The alias
`grant_type=device_code` works too.

| Parameter | |
|---|---|
| `device_code` | the `sad_…` code from `POST /v1/device/authorize` |
| `client_id` | `accounts` |

Poll every `interval` seconds (5). Until the Carbon decides you get `authorization_pending`;
polling faster than every 5 seconds gets `slow_down` (add 5 seconds to your interval); a denial
is `access_denied`; after 600 seconds `expired_token`. Once approved, the first poll returns the
tokens and later ones get `invalid_grant` ("already exchanged").

```sh
curl -s -X POST "$ACCOUNTS_URL/v1/oauth/token" \
  -d grant_type=urn:ietf:params:oauth:grant-type:device_code \
  -d device_code="$DEVICE_CODE" -d client_id=accounts
```

```json
{
  "error": "authorization_pending",
  "error_description": "The Carbon hasn't approved this device code yet; keep polling every 5 seconds."
}
```

### The token response

| Field | |
|---|---|
| `access_token` | an EdDSA (Ed25519) JWT, valid `expires_in` seconds (1800) |
| `token_type` | `Bearer` |
| `expires_in` | 1800 |
| `refresh_token` | `sar_…`, rotates on every refresh |
| `refresh_token_expires_at` | when the sign-in ends at the latest (900 days after it started) |
| `scope` | the granted scopes, space-separated |
| `id_token` | only when `openid` was granted |
| `membership_id` | `{app_id}:{uuid}` |
| `account` | the account as your app may see it (the fields of the scopes above) |

Access token claims (first-party tokens have `aud: "accounts"`):

```json
{
  "iss": "https://accounts.teamofsilicons.com",
  "sub": "8HV",
  "aud": "briefcase",
  "exp": 1791342182,
  "iat": 1791340382,
  "nbf": 1791340382,
  "jti": "01a11435-086d-7380-97bc-50f5ff0c33b3",
  "kind": "carbon",
  "id": "c:ada",
  "mid": "briefcase:8HV",
  "fid": "01a11435-0864-723d-86b3-c15a7345c088",
  "scope": "profile email timezone openid"
}
```

`sub` is the account uuid, `id` the c:id or si:id when the token was issued, `mid` the membership
id, `fid` the token family (the sign-in). Verify the signature with the JWKS, `exp`/`nbf`, and
`aud` equal to your app id. A local check can't see revocation; call
[introspection](#post-v1oauthintrospect) when you must know about a sign-out at once.

`id_token` claims (header `{"alg":"EdDSA","kid":"…"}`):

```json
{
  "iss": "https://accounts.teamofsilicons.com",
  "sub": "8HV",
  "aud": "briefcase",
  "exp": 1791342182,
  "iat": 1791340382,
  "auth_time": 1791340371,
  "nonce": "n-456",
  "name": "Ada Lovelace",
  "picture": "https://iris.teamofsilicons.com/pfp/carbon?id=8HV",
  "preferred_username": "c:ada",
  "email": "ada@example.test",
  "email_verified": true,
  "zoneinfo": "Asia/Kolkata"
}
```

`auth_time` is when the Carbon last proved who they are (a code, Google, Apple or a finished
sign-up), not when the token was made. `phone_number`, `phone_number_verified` and `birthdate`
appear with the `phone` and `dob` scopes. A refresh returns a fresh `id_token` too.

### Token endpoint errors

| Status | `error` | When |
|---|---|---|
| 400 | `invalid_request` | a parameter is missing, repeated or malformed; the client authenticated twice |
| 401 | `invalid_client` | unknown app, wrong secret, disabled app, no credentials (with `WWW-Authenticate: Basic`) |
| 400 | `invalid_grant` | the code, refresh token, SLT or device code is unknown, expired, already used, revoked, issued to another app, or its account was deleted or removed the app's access; a `redirect_uri` or PKCE mismatch |
| 400 | `unauthorized_client` | the public client asked for a grant only confidential clients may use, or an app asked for the device-code grant |
| 400 | `unsupported_grant_type` | any other `grant_type` (the description says what to use instead: App verification proofs for `client_credentials`, User verification proofs for token exchange) |
| 400 | `invalid_scope` | a refresh asked for a scope that wasn't granted, or an unknown scope |
| 400 | `authorization_pending`, `slow_down`, `access_denied`, `expired_token` | device-code polling (above) |
| 413 | `invalid_request` | the body is over 64 KB |
| 500 | `server_error` | a fault on our side (the description carries the request id) |
| 503 | `temporarily_unavailable` | the request ran past its 30-second budget |

`error_description` always says exactly which of the reasons applied. [Errors](../errors.md#oauth-errors)
lists them all.

## `POST /v1/oauth/revoke`

Ends the sign-in behind a refresh token or an access token (RFC 7009): the whole token family is
revoked. Same client authentication as the token endpoint; the first-party public client may
revoke first-party tokens only. An access token is accepted even after it expired.
`token_type_hint` is accepted and ignored (the token's own form says what it is).

```sh
curl -s -X POST "$ACCOUNTS_URL/v1/oauth/revoke" -u "$APP_ID:$APP_SECRET" -d token="$REFRESH_TOKEN"
```

```json
{ "revoked": true }
```

Once the client is authenticated the answer is always 200. A token that isn't one of the
caller's (unknown, malformed, another app's) is answered the same way, so the endpoint can't be
used to probe tokens:

```json
{
  "revoked": false,
  "message": "Nothing was revoked: this is not a refresh or access token issued to 'dm' (it is unknown, malformed, or belongs to another app). RFC 7009 answers 200 either way."
}
```

Revoking an app's sign-in sends that app `membership.signed_out` with reason `app_revoked`.

## `POST /v1/oauth/introspect`

Is this token of yours live right now (RFC 7662)? Needs the app's own credentials (the public
client gets 401 `invalid_client`). Only the calling app's tokens are ever reported active.

```sh
curl -s -X POST "$ACCOUNTS_URL/v1/oauth/introspect" -u "$APP_ID:$APP_SECRET" -d token="$ACCESS_TOKEN"
```

```json
{
  "active": true,
  "iss": "https://accounts.teamofsilicons.com",
  "sub": "8HV",
  "aud": "briefcase",
  "client_id": "briefcase",
  "exp": 1791342204,
  "iat": 1791340404,
  "nbf": 1791340404,
  "jti": "01a11435-60b5-7167-abb0-ff4c0b338368",
  "kind": "carbon",
  "id": "c:ada",
  "username": "c:ada",
  "membership_id": "briefcase:8HV",
  "scope": "profile email timezone openid",
  "token_type": "access_token"
}
```

A refresh token reports `token_type: "refresh_token"` and its sign-in's end as `exp`. Anything
else — expired, revoked, another app's, unknown — is exactly `{"active": false}`.

## `GET` / `POST /v1/userinfo`

The account behind an access token, as the token's app may see it, plus the OIDC claim names.
Send `Authorization: Bearer <access token>`; with POST you may instead send a form field
`access_token` (never both). Any audience works, first-party tokens included.

```sh
curl -s "$ACCOUNTS_URL/v1/userinfo" -H "Authorization: Bearer $ACCESS_TOKEN"
```

```json
{
  "uuid": "8HV",
  "membership_id": "briefcase:8HV",
  "kind": "carbon",
  "id": "c:ada",
  "display_name": "Ada Lovelace",
  "pfp_url": "https://iris.teamofsilicons.com/pfp/carbon?id=8HV",
  "email": "ada@example.test",
  "email_verified": true,
  "timezone": "Asia/Kolkata",
  "updated_at": "2026-10-07T02:32:51.018Z",
  "version": 1,
  "sub": "8HV",
  "name": "Ada Lovelace",
  "picture": "https://iris.teamofsilicons.com/pfp/carbon?id=8HV",
  "zoneinfo": "Asia/Kolkata"
}
```

With the `phone` and `dob` scopes it adds `phone_number`, `phone_number_verified` and
`birthdate`. A Silicon's answer carries `custodian`.

Errors use the API error shape plus `WWW-Authenticate: Bearer realm="Silicon Accounts",
error="invalid_token", …` so OIDC libraries understand them; all are 401: `unauthenticated` (no
token), `invalid_authorization`, `invalid_token` (malformed or expired — strictly at its `exp`),
`token_revoked` (signed out, STK rotated, account deleted…), `account_deleted`,
`access_removed` (the account removed your app's access), `membership_inactive`, `app_disabled`.

```json
{
  "error": {
    "code": "token_revoked",
    "message": "The sign-in behind this access token was revoked at 2026-10-07T02:38:05.252Z (app_revoked).",
    "hint": "Sign in again."
  }
}
```

## `POST /v1/device/authorize`

Starts a device sign-in for the `accounts` CLI (RFC 8628). Public. The body (JSON or form) is
optional: `client_label` (shown on the approval page and in the sessions list; cut at 100
characters), `client_id` (if sent, must be `accounts`: 400 `unauthorized_client` otherwise),
`scope` (checked for typos only: 400 `invalid_scope`). At most 60 per IP per 10 minutes. Errors
use the API error shape.

```sh
curl -s -X POST "$ACCOUNTS_URL/v1/device/authorize" \
  -H 'Content-Type: application/json' -d '{"client_label":"accounts CLI on build box"}'
```

```json
{
  "device_code": "sad_bXmMc5C9tF_K7UZl8cLE5Ff2R1Q0_hbtXv87TIkbngU",
  "user_code": "MVHB-KQAW",
  "verification_uri": "https://accounts.teamofsilicons.com/device",
  "verification_uri_complete": "https://accounts.teamofsilicons.com/device?code=MVHB-KQAW",
  "expires_in": 600,
  "interval": 5,
  "expires_at": "2026-10-07T02:46:05.176Z"
}
```

Show `user_code` and `verification_uri` to the Carbon, who approves on the account site
(`/v1/device/{user_code}/approve`, see [Hosted sign-in](sign-in.md#device-approval)); poll the
token endpoint with the device-code grant. User codes use `A-Z` without `I`, `L` and `O`, plus
`2-9`; typed codes are matched without spaces, dashes or case.
