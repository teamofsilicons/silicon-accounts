---
title: OAuth and OIDC endpoints
description: The endpoints your app signs people in with, from authorize and token exchange to refresh, revocation, introspection and userinfo, with every parameter and response.
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

These are the endpoints your app uses to sign someone in and keep them signed in: start the sign-in, exchange the code for tokens, refresh, check a token and revoke it. They are standard OAuth 2.0 and OpenID Connect, so any OIDC library can read the discovery document and find the endpoints and supported options on its own.

For a walkthrough, start with [Add sign-in to your app](../../start/add-sign-in.md) and [Tokens](../../start/tokens.md). [Tokens and sessions](../../learn/tokens-and-sessions.md) explains how long each token lives and how it behaves.

Here your server exchanges the code that came back to your redirect URI:

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
is for showing, and it can change.

## `GET /authorize`

Our hosted sign-in page, on the account site. Send the browser here and it comes back to your
`redirect_uri`. This is a page, not a JSON endpoint: the page checks your request with
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

`login_hint` is accepted without an error and ignored. We don't prefill it, store it, echo it or
forward it to Google or Apple. An app can never hand us a Carbon's email or phone: the Carbon
always types it on the hosted pages.

What comes back to your `redirect_uri`:

- Success: `?code=sac_…&state=…`. Exchange the code within 2 minutes.
- Refusal: `?error=…&error_description=…&state=…` with `error` = `access_denied` (the Carbon
  cancelled on a details or review page), `login_required`, `consent_required` or
  `interaction_required` (`prompt=none` couldn't finish silently), `invalid_scope`,
  `invalid_request` or `unsupported_response_type`.

An unknown app, a disabled app or an unregistered `redirect_uri` gets an error page, never a
redirect, so nobody can use the page to send codes to someone else's URL.

| Scope | What the app gets in `account` |
|---|---|
| `profile` | always: `uuid`, `membership_id`, `kind`, `id`, `display_name`, `pfp_url`, `updated_at`, `version`; Silicons also `custodian` `{uuid, id}` |
| `email` | `email`, `email_verified` (the primary email; Carbons only) |
| `phone` | `phone`, `phone_verified` (the primary phone; Carbons only) |
| `dob` | `dob` (`YYYY-MM-DD`) |
| `timezone` | `timezone` (IANA, like `Asia/Kolkata`) |
| `openid` | an `id_token` in the token response |

Besides `scope`, your app's sign-in setup decides what is shared:

- `required_fields` are always shared, and must exist on the account before we issue the code. A
  missing email or phone is added on the page, with a code.
- `optional_fields` are checkboxes on the details pages, unticked until the Carbon ticks them.
- Details that `scope` asks for but your app doesn't configure become optional checkboxes on the
  last page.

Silicons never have an email or a phone. Those scopes are simply left out for them and never
block a Silicon. [What apps see](../../learn/what-apps-see.md) explains the rules.

## `GET /.well-known/openid-configuration`

The discovery document your OIDC library reads. Public, with `Access-Control-Allow-Origin: *` and
`Cache-Control: public, max-age=300`.

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
  "service_documentation": "https://developers.teamofsilicons.com/docs/accounts",
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
minutes. Cache it, and fetch it again when a token names a `kid` you don't have.

```json
{
  "keys": [
    { "kty": "OKP", "crv": "Ed25519", "x": "YJpQ5011mgRRBUr1o9VT1FjZaKeccFlUhDxZNxWWSyg", "kid": "dev-1", "use": "sig", "alg": "EdDSA" }
  ]
}
```

## `POST /v1/oauth/token`

One endpoint for every grant. Send the body as `application/x-www-form-urlencoded` (or a JSON
object of strings). Responses are `Cache-Control: no-store`, and errors come as RFC 6749 bodies.

**Client authentication.** Send your app's credentials with HTTP Basic
(`-u app_id:app_secret`) or as `client_id` + `client_secret` in the body, never both
(`invalid_request`). A `client_id` in the body must match the Basic credentials
(`invalid_client`).

Two first-party clients send no secret:

- `client_id=silicon-accounts` is the first-party public client (the `silicon-accounts` CLI). It
  may only use `refresh_token` and the device-code grant (`unauthorized_client` otherwise).
- `client_id=developer` is the developer platform (developers.teamofsilicons.com, whose server
  holds the tokens). It may only use `authorization_code` with PKCE `S256` (a missing challenge
  or `plain` is `invalid_grant`, and the code is burnt), `refresh_token` for its own tokens, and
  `/v1/oauth/revoke`. Other grants are `unauthorized_client`, and introspection is
  `invalid_client`. Its tokens have `aud: "developer"` and act for their Carbon only on
  `GET /v1/me`, `GET /v1/session`, `GET /v1/me/owned-apps` and the author routes under
  `/v1/apps/{app_id}/…`. Anywhere else they get 401 `token_wrong_audience`.

### `grant_type=authorization_code`

| Parameter | |
|---|---|
| `code` | the `sac_…` code from your redirect URI |
| `redirect_uri` | exactly the `redirect_uri` sent to `/authorize` |
| `code_verifier` | the PKCE verifier (43 to 128 characters of `A-Z a-z 0-9 - . _ ~`); required when a challenge was sent, refused when none was |

A code works once and lives 120 seconds. Any refused redemption burns it. If a code that was
already exchanged is presented again, we also revoke the tokens issued from it, and your app gets
`membership.signed_out` with reason `authorization_code_reuse`. A code seen twice means someone
else may have it.

### `grant_type=refresh_token`

| Parameter | |
|---|---|
| `refresh_token` | the newest `sar_…` refresh token you received |
| `scope` | optional; may only repeat or narrow the granted scopes (`invalid_scope` if it adds one) |

Every refresh returns a new refresh token and kills the old one. If a used refresh token is
presented, we revoke the whole sign-in (the token family): every access and refresh token in it
stops working, and your app gets `membership.signed_out` with reason `refresh_token_reuse`. So
always store the new token before you use it. `refresh_token_expires_at` doesn't move: a sign-in
lasts at most 900 days from when it started.

```sh
curl -s -X POST "$ACCOUNTS_URL/v1/oauth/token" -u "$APP_ID:$APP_SECRET" \
  -d grant_type=refresh_token -d refresh_token="$REFRESH_TOKEN"
```

Present the same refresh token again and you get:

```json
{
  "error": "invalid_grant",
  "error_description": "This refresh token was already used once. Presenting a used refresh token revokes the whole sign-in to protect the account, so this sign-in is now revoked; sign in again."
}
```

First-party tokens refresh the same way, with `-d client_id=silicon-accounts` and no secret.

### `grant_type=urn:silicon:params:oauth:grant-type:slt`

This is how a Silicon signs into your app. It asks us for a short-lived token for your app
(`POST /v1/me/short-lived-tokens`, or `silicon-accounts login --app <app_id>`), hands it to you,
and you exchange it here. The alias `grant_type=slt` works too.

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

We refuse an SLT if, after it was issued, the Silicon's STK was rotated or the account removed
your app's access.

### `grant_type=urn:ietf:params:oauth:grant-type:device_code`

The device sign-in (RFC 8628), used by the `silicon-accounts` CLI and by apps' own tools (apps
that turn on `device_flow`). The alias `grant_type=device_code` works too.

| Parameter | |
|---|---|
| `device_code` | the `sad_…` code from `POST /v1/device/authorize` |
| `client_id` | `silicon-accounts`, or your `app_id` (your secret is optional: HTTP Basic works too) |

Poll every `interval` seconds (5). What you get back:

- `authorization_pending` until the Carbon decides;
- `slow_down` if you poll faster than every 5 seconds (add 5 seconds to your interval);
- `access_denied` if they deny it;
- `expired_token` after 600 seconds;
- the tokens on the first poll after they approve, and `invalid_grant` ("already exchanged") on
  every poll after that.

Your app's tool gets tokens for your app, with the scopes the Carbon approved, and the sign-in
counts like any other: the account becomes an active member and we record the sign-in (method
`device`). A code started by another app is `invalid_grant` for you, and stays usable by its own
app. A code whose Carbon removed your app's access after approving is `invalid_grant`. An app
that hasn't turned on `device_flow` gets `unauthorized_client`.

```sh
curl -s -X POST "$ACCOUNTS_URL/v1/oauth/token" \
  -d grant_type=urn:ietf:params:oauth:grant-type:device_code \
  -d device_code="$DEVICE_CODE" -d client_id=silicon-accounts
```

```json
{
  "error": "authorization_pending",
  "error_description": "The Carbon hasn't approved this device code yet; keep polling every 5 seconds."
}
```

### `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`

A Silicon signing in with a key (RFC 7523). `assertion` is a JWT signed with one of its
[registered keys](silicons.md#silicon-keys), and `client_id` is `silicon-accounts`. The answer is
the same first-party token response as `POST /v1/silicons/login`. Any other client gets
`unauthorized_client`, and a bad assertion is `invalid_grant` with the reason.

```sh
curl -s -X POST "$ACCOUNTS_URL/v1/oauth/token" \
  -d grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer \
  -d assertion="$ASSERTION" -d client_id=silicon-accounts
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

The access token's claims (first-party tokens have `aud: "silicon-accounts"`):

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

`sub` is the account uuid, `id` the c:id or si:id at the time the token was issued, `mid` the
membership id and `fid` the token family (the sign-in). To check a token yourself, verify the
signature against the JWKS, check `exp` and `nbf`, and check that `aud` equals your app id. A
local check can't see a revocation, so call [introspection](#post-v1oauthintrospect) when you
need to know about a sign-out at once.

The `id_token`'s claims (header `{"alg":"EdDSA","kid":"…"}`):

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

Ends the sign-in behind a refresh token or an access token (RFC 7009): we revoke the whole token
family. Authenticate the same way as at the token endpoint; the first-party public client can
revoke first-party tokens only. An access token is accepted even after it expired.
`token_type_hint` is accepted and ignored, because the token's own form says what it is.

```sh
curl -s -X POST "$ACCOUNTS_URL/v1/oauth/revoke" -u "$APP_ID:$APP_SECRET" -d token="$REFRESH_TOKEN"
```

```json
{ "revoked": true }
```

Once your client is authenticated, the answer is always 200. A token that isn't yours (unknown,
malformed or another app's) gets a 200 too, so nobody can use the endpoint to probe tokens:

```json
{
  "revoked": false,
  "message": "Nothing was revoked: this is not a refresh or access token issued to 'dm' (it is unknown, malformed, or belongs to another app). RFC 7009 answers 200 either way."
}
```

Revoking an app's sign-in sends that app `membership.signed_out` with reason `app_revoked`.

## `POST /v1/oauth/introspect`

Is this token of yours live right now (RFC 7662)? This needs your app's own credentials; the
public client gets 401 `invalid_client`. We only ever report the calling app's own tokens as
active.

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

An active refresh token reports `token_type: "refresh_token"`, with the session's end as `exp`. A
token that is expired, revoked, unknown or another app's returns exactly `{"active": false}`.

## `GET` / `POST /v1/userinfo`

The account behind an access token, as the token's app may see it, plus the OIDC claim names.
Send `Authorization: Bearer <access token>`. With POST you can send a form field `access_token`
instead, never both. Any audience works, first-party tokens included.

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

Errors use the API error shape, plus
`WWW-Authenticate: Bearer realm="Silicon Accounts", error="invalid_token", …` so OIDC libraries
understand them. All of them are 401: `unauthenticated` (no token), `invalid_authorization`,
`invalid_token` (malformed, or expired at its exact `exp` time), `token_revoked` (signed out, STK
rotated, account deleted…), `account_deleted`, `access_removed` (the account removed your app's
access), `membership_inactive`, `app_disabled`.

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

Starts a device sign-in (RFC 8628) for the `silicon-accounts` CLI, or for your app's own tool.
Public. The body (JSON or form) is optional:

- `client_label`: shown on the approval page and in the sessions list, cut at 100 characters;
- `client_id`: `silicon-accounts` when left out;
- `scope`.

At most 60 per IP per 10 minutes. Errors use the API error shape.

```sh
curl -s -X POST "$ACCOUNTS_URL/v1/device/authorize" \
  -H 'Content-Type: application/json' -d '{"client_label":"silicon-accounts CLI on build box"}'
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

Show the Carbon `user_code` and `verification_uri`. They approve on the account site
(`/v1/device/{user_code}/approve`, see [Hosted sign-in](sign-in.md#device-approval)) while you
poll the token endpoint with the device-code grant. User codes use `A-Z` without `I`, `L` and
`O`, plus `2-9`, and we match typed codes ignoring spaces, dashes and case.

### For an app's tool

Send `client_id=<your app_id>` (or HTTP Basic with your secret, which we then check) to start a
device sign-in for your app. It works once your app has turned on `device_flow` in its sign-in
setup; until then you get 400 `unauthorized_client`.

`scope` (space-separated) asks for details your app requests (`email`, `phone`, `dob`,
`timezone`). Your required details and `profile` are always included, and a detail your app
doesn't ask for is 400 `invalid_scope`. At most 600 per app per 10 minutes. Other errors: 400
`invalid_client` (no such app), 401 `invalid_app_credentials` (a wrong secret), 403
`app_disabled`. For the steps, see [Sign people into your CLI](../../start/add-sign-in.md#sign-people-into-your-cli).

## Public clients

Your app's command-line and desktop tools can't keep a secret, because a secret shipped inside a
tool isn't secret. Turn on `public_client` (or `device_flow`) in your sign-in setup, and the token
endpoint accepts your app's `client_id` alone (`token_endpoint_auth_method` `none`) for:

| Grant | With |
|---|---|
| `authorization_code` | `public_client`; the sign-in must have used PKCE with `code_challenge_method=S256`, and the exchange sends the `code_verifier` (a code without PKCE is `invalid_grant`) |
| `urn:ietf:params:oauth:grant-type:device_code` | `device_flow` |
| `refresh_token` | either; only the app's own sign-ins |

`POST /v1/oauth/revoke` accepts it too, for the app's own tokens. Short-lived tokens and
introspection always need the secret (`unauthorized_client`, `invalid_client`). Loopback redirect
URIs (`http://127.0.0.1/…`, `http://[::1]/…`, `http://localhost/…`) match on any port, as RFC 8252
asks.
