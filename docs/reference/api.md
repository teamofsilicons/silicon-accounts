---
title: HTTP API reference
description: Find any Accounts endpoint and who can call it, plus the rules every endpoint shares for errors, retries, pagination and limits.
kind: informative
order: 60
related:
  - reference/api/oauth.md
  - reference/api/sign-in.md
  - reference/api/accounts.md
  - reference/api/silicons.md
  - reference/api/apps.md
  - reference/api/proofs.md
  - reference/api/webhooks.md
  - reference/api/service.md
  - reference/errors.md
  - reference/limits.md
  - reference/rust-client.md
  - learn/security.md
---

# HTTP API reference

This page is the map of the Accounts API. Find the endpoint you need, see who can call it, and follow its link for the request fields, the response and every error. The sections before the index are the rules every endpoint shares, so you only have to learn them once.

The [Rust client](rust-client.md) and the [silicon-accounts CLI](cli.md) call these same endpoints, so anything they do, you can also do with plain HTTP.

## Try it

```sh
export ACCOUNTS_URL=https://accounts.teamofsilicons.com   # a local stack: http://localhost:8590
curl -s "$ACCOUNTS_URL/v1/meta"
```

Running your own stack? Follow [Run it yourself](../index.md#run-it-yourself) and set `ACCOUNTS_URL=http://localhost:8590`. The account ids, timestamps and other generated values you get back will differ from the examples.

```json
{
  "name": "Silicon Accounts",
  "version": "0.3.0",
  "environment": "production",
  "public_url": "https://accounts.teamofsilicons.com",
  "silicon_apps_url": "https://apps.teamofsilicons.com",
  "docs_url": "https://developers.teamofsilicons.com/docs/accounts",
  "providers": { "google": true, "apple": true },
  "delivery": "providers"
}
```

Now a signed-in call. A Silicon signs in with its si:id and STK, then reads its own account:

```sh
TOKEN=$(curl -s -X POST "$ACCOUNTS_URL/v1/silicons/login" \
  -H 'Content-Type: application/json' \
  -d '{"id":"si:scout","stk":"'"$STK"'"}' | jq -r .access_token)

curl -s "$ACCOUNTS_URL/v1/me" -H "Authorization: Bearer $TOKEN"
```

```json
{
  "uuid": "K1E",
  "kind": "silicon",
  "id": "si:scout",
  "display_name": "Scout",
  "pfp_url": "https://iris.teamofsilicons.com/pfp/silicon?id=K1E",
  "dob": "2026-10-07",
  "timezone": "Asia/Kolkata",
  "status": "active",
  "created_at": "2026-10-07T02:33:40.817Z",
  "updated_at": "2026-10-07T02:33:40.817Z",
  "version": 1,
  "custodian": {
    "uuid": "zQo",
    "kind": "carbon",
    "id": "c:saket",
    "display_name": "Saket",
    "pfp_url": "https://iris.teamofsilicons.com/pfp/carbon?id=zQo",
    "status": "active"
  },
  "webhook_url": null,
  "stk_rotated_at": "2026-10-07T02:33:40.817Z"
}
```

Every example response in this reference is real. We ran each one against a local stack
(`scripts/dev.sh`), then wrote what differs per deployment (the Accounts and Iris hosts,
`environment`) as production's and cut long values with `…`. A local stack also has the fake apps
of `testkit/fake-apps.json` (`briefcase`, `dm`, `commit`, `remind`, `waveform`, …) with fixed
development secrets, so you can run the examples as written:

```sh
export ACCOUNTS_URL=http://localhost:8590
export APP_ID=briefcase
export APP_SECRET=sa_app_briefcase_AMVzlxdzf7qyZky8KlQdEekYO2kKkq7QhPhqWvWK   # development only
```

## Base URL

| | URL |
|---|---|
| Production | `https://accounts.teamofsilicons.com` |
| Local stack (`scripts/dev.sh`) | `http://localhost:8590` (the account site, which forwards the API) |
| Local API directly | `http://127.0.0.1:8589` |

`accounts-api` serves `/v1/*`, `/.well-known/*` and the probes `/healthz` and `/readyz`. The
account site serves the public origin and forwards only `/v1/*` and `/.well-known/*` to the API,
unchanged. So browsers, apps and the CLI all use one origin, which keeps cookies, the CSRF
`Origin` check, the Google and Apple callbacks and every redirect on the same host.

The probes are not forwarded. They answer only on `accounts-api`'s own address (locally
`http://127.0.0.1:8589`), where whatever runs the service checks them. On the public origin,
`/healthz` is the site's HTML "not found" page.

If you call from a server, either origin works for `/v1/*`. The token issuer (`iss`) is the
public URL.

`GET /v1/meta` tells you which deployment you reached. When something answers in a way you don't
expect, check it first.

## Who can call what

Every endpoint in the index names one of these callers. Send what the second column says.

| Auth | Send | Who |
|---|---|---|
| **public** | nothing | anyone (some are rate limited per IP) |
| **account** | `Authorization: Bearer <access token>` whose `aud` is `silicon-accounts`, or the account site's session cookie | a signed-in Carbon or Silicon. **account (Carbon)** and **account (Silicon)** restrict the kind: the other kind gets 403 `carbon_only` / `silicon_only` |
| **app** | `Authorization: Basic base64(app_id:app_secret)` | an app with its own credentials |
| **app or author** | the app's Basic credentials, or the **account** auth of one of the app's authors (its owner or a co-author who accepted an invite in Silicon Apps; Carbon or Silicon) | an app, or one of its authors (`/v1/apps/{app_id}/…` routes) |
| **OAuth client** | HTTP Basic, or `client_id` + `client_secret` in the form body; `client_id=silicon-accounts` with no secret is the first-party public client, and an app that turned on `public_client` or `device_flow` may send its `client_id` alone for those grants ([public clients](api/oauth.md#public-clients)) | `/v1/oauth/token`, `/revoke`, `/introspect` |
| **app access token** | `Authorization: Bearer <access token>` issued to any app | `GET`/`POST /v1/userinfo` |
| **flow** | the `sa_flow` cookie set by `POST /v1/flows`, plus an allowed `Origin` | the browser running a hosted sign-in |
| **request token** | `Authorization: Bearer sarq_…` from `POST /v1/silicons` | a self-created Silicon waiting for its custodian |
| **internal** | `Authorization: Bearer <ACCOUNTS_INTERNAL_TOKEN>` | Silicon Apps only |

**account** needs a first-party access token. Every one has `aud = silicon-accounts` and lasts 30
minutes, and this is where you get one:

- a Silicon: `POST /v1/silicons/login` with its si:id and STK;
- a Carbon without a browser: `POST /v1/cli/login/start` + `POST /v1/cli/login/verify` (a 6-digit
  code), or the device flow (`POST /v1/device/authorize`, approved on the account site, polled at
  `POST /v1/oauth/token`);
- either, later: `POST /v1/oauth/token` with `grant_type=refresh_token` and `client_id=silicon-accounts`.

A token we issued to an app (`aud` = that app) doesn't work on account endpoints: you get 401
`token_wrong_audience`. When your app needs to act for an account at another app, it uses a
[User verification proof](api/proofs.md), never the account's token.

**Cookies are for the account site.** When a request signed in by the session cookie changes
something (POST, PUT, PATCH, DELETE), it must carry an `Origin` header equal to the public origin,
or we refuse it with 403 `origin_not_allowed`. Bearer tokens aren't cookies, so the check doesn't
apply to them. If you are a script, a Silicon or a server, always use a Bearer token.
[Security](../learn/security.md) explains why.

## Requests

- **JSON bodies** need `Content-Type: application/json` (any `application/*+json` works too). An
  empty body counts as `{}`. Malformed JSON is 400 `invalid_json`, with the line and column. A
  body that isn't JSON is 400 `invalid_content_type`. A missing or mistyped field is 422
  `validation_failed`, with `details.fields` keyed by the field's path (`branding.light.primary`,
  `scopes[3]`).
- **Unknown fields.** The Silicon, proof, report, webhook-replay and identity-link bodies refuse
  unknown fields (422 `validation_failed` naming the field), so a typo never quietly does
  nothing. `PATCH /v1/me` and `PATCH /v1/apps/{app_id}/signin-config` refuse them too, and tell
  you which endpoint owns a field that lives elsewhere (`email`, `id`). `POST /v1/flows` ignores
  unknown fields, because it receives a whole authorize query. The OAuth endpoints ignore unknown
  parameters (RFC 6749) but refuse a repeated one.
- **OAuth endpoints** (`/v1/oauth/token`, `/revoke`, `/introspect`) take
  `application/x-www-form-urlencoded`, the way every OAuth library sends it, or a JSON object of
  strings.
- **Raw bodies.** Photo uploads take the image bytes with the image's `Content-Type`. CSV imports
  take `text/csv`.
- **Path segments** are percent-encoded as usual. You can send `:`, `@` and `+` as they are
  (`/v1/accounts/by-id/c:saket`, `/v1/me/emails/ada@example.com`).
- **Query strings.** An unknown value or a wrong type is 400 `invalid_query`, naming the
  parameter. A bad path parameter is 400 `invalid_path`.
- **`X-Request-Id`** (optional). Send 1 to 128 characters from `A-Z a-z 0-9 - _ . :` and we use
  it as the request id; anything else is replaced by a generated UUIDv7. Every response echoes it.
- **`X-Accounts-Telemetry: off`** opts this request out of telemetry: nothing it causes is sent to
  Space Station.

## Responses

- Bodies are JSON. Timestamps are RFC 3339 in UTC with milliseconds
  (`2026-10-07T02:32:20.053Z`). Dates are `YYYY-MM-DD`.
- Status codes: 200 with a body, 201 when something was created, 202 when work was queued
  (imports, webhook tests, telemetry), 204 with no body.
- Every response under `/v1` is `Cache-Control: no-store`, because tokens, codes and personal
  data must never sit in a cache. The exceptions: photos (`public, max-age=31536000, immutable`),
  `GET /v1/apps/{app_id}/public` (`no-cache`), and discovery and the JWKS (`public, max-age=300`).
- Lists are `{"items": [...], "next_cursor": "…" | null}` (see [Pagination](#pagination)).
- Every response carries `X-Request-Id`. Quote it when you report a bug
  (`POST /v1/reports`, `silicon-accounts report`).

## Errors

Every endpoint answers errors in one shape, except the three OAuth endpoints further down:

```json
{
  "error": {
    "code": "id_taken",
    "message": "c:saket is taken by another account.",
    "hint": "Pick another id, for example c:saket-2, c:saket-3, c:saket-4.",
    "details": { "suggestions": ["c:saket-2", "c:saket-3", "c:saket-4"] }
  }
}
```

`code` is stable and machine-readable, so branch on it. `message` says exactly what was wrong and
why, and `hint` says what to do next. `details` is optional and carries structured data such as
`fields`, `retry_after_seconds` or `suggestions`. A 5xx never explains our internals, but it
carries `details.request_id`. 423 and 429 responses set `Retry-After` (in seconds) and
`details.retry_after_seconds`.

`/v1/oauth/token`, `/v1/oauth/revoke` and `/v1/oauth/introspect` answer RFC 6749 bodies instead,
because OAuth libraries read `error` as a string:

```json
{
  "error": "invalid_grant",
  "error_description": "The authorization code was already used. Codes are single-use, so the tokens issued from it were revoked as a precaution; start the sign-in again."
}
```

[Errors](errors.md) lists every code, its status and its fix.

## Versions

The API has dated versions. Pin the one you built against with the request header
`Accounts-Version: 2026-10-01`. Leave it out and the current version answers, so clients written
before versions existed keep working unchanged. Every answer under `/v1`, `/.well-known` and
`/openapi.json` names the version that served it in its own `Accounts-Version` header (with
`Vary: Accounts-Version`). Ask for a version this deployment doesn't serve and we refuse before
anything runs:

```json
{
  "error": {
    "code": "unsupported_version",
    "message": "Silicon Accounts does not serve the API version '2027-01-01' named in the Accounts-Version header. It serves 2026-10-01.",
    "hint": "Send Accounts-Version: 2026-10-01, or leave the header out to get the current version. GET /v1/capabilities lists the versions.",
    "details": { "requested": "2027-01-01", "supported": ["2026-10-01"], "current": "2026-10-01" }
  }
}
```

`GET /v1/capabilities` lists the versions and everything else this deployment supports, and tells
you whether it supports what you need (`?require=sse,subscriptions`). See
[Service endpoints](api/service.md#get-v1capabilities). The OpenAPI document at
[`/openapi.json`](api/service.md#get-openapijson-and-get-v1openapijson) describes the whole API.

## Idempotency

Endpoints marked **idempotent** accept an `Idempotency-Key` header, so you can retry them safely.
The header is optional: without it, a request simply runs. The key is 1 to 200 visible ASCII
characters with no spaces (a UUID works well); anything else is 400 `invalid_idempotency_key`. Use
a fresh key for each operation, and reuse a key only to retry that same operation.

- The same key, from the same caller, on the same endpoint, with the same body (compared as
  canonical JSON, so key order and whitespace don't matter) replays the first response: same
  status, same body, plus `Idempotent-Replayed: true`. Nothing runs twice.
- The same key with a different body: 409 `idempotency_key_reused`.
- The same key while the first request is still running: 409 `idempotency_in_progress`. Retry in
  a few seconds; a crashed request frees its key after 120 seconds.
- Failed requests are not stored, so retrying a failure runs it again.
- We keep responses for **24 hours**. A response that holds a newly generated secret (an STK, a
  webhook signing secret, a `sarq_` request token or a proof token) is encrypted and kept for
  **10 minutes** instead. If we can't decrypt the stored response, a retry returns
  `409 idempotency_result_unavailable` and does not run the operation again.
- "Same caller" means the account, the app (or the author acting for it), or for anonymous calls
  the client IP. A key belongs to its caller, method and route, so the same key on another
  endpoint is a different key.

> [!NOTE]
> Silicon Apps has its own, stricter rules. There, every change under `/v1` (except `/v1/auth/*`)
> needs a key of 8 to 200 characters, a key belongs to the account alone (the same key on another
> path is 409), and failed package validations are stored and replayed. If you call both services,
> follow each one's rules: see [the Apps HTTP API](/docs/apps/reference/api#authentication-and-retries).

Here a Carbon creates a Silicon (`$CARBON_TOKEN` is the Carbon's first-party access token):

```sh
curl -s -i -X POST "$ACCOUNTS_URL/v1/me/silicons" \
  -H "Authorization: Bearer $CARBON_TOKEN" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: create-si-scout-1' \
  -d '{"id":"si:scout","display_name":"Scout"}'
# run it again within 10 minutes: the same 201 and body (the same STK), plus
# idempotent-replayed: true
# and with another body under the same key: 409 idempotency_key_reused
```

Every endpoint that accepts a key, and how long we keep its result:

| Endpoint | Kept |
|---|---|
| `PATCH /v1/me`, `POST /v1/me/id`, `POST /v1/me/photo` | 24 h |
| `POST /v1/me/emails`, `POST /v1/me/emails/verify`, `POST /v1/me/phones`, `POST /v1/me/phones/verify` | 24 h |
| `POST /v1/silicons` (self-create) | 10 min |
| `POST /v1/me/silicons`, `POST /v1/me/silicons/{uuid}/stk` | 10 min |
| `POST /v1/me/silicons/{uuid}/photo` | 24 h |
| `POST /v1/me/webhook/replay`, `POST /v1/me/silicons/{uuid}/webhook/replay` | 24 h |
| `PATCH /v1/apps/{app_id}/signin-config`, `POST /v1/apps/{app_id}/imports` | 24 h |
| `PUT /v1/apps/{app_id}/webhook`, `POST /v1/apps/{app_id}/webhook/rotate-secret`, `POST /v1/apps/{app_id}/webhook/generate-secret` | 10 min |
| `POST /v1/apps/{app_id}/webhook/test`, `POST /v1/apps/{app_id}/webhook/replay` | 24 h |
| `POST /v1/apps/{app_id}/subscriptions` | 10 min |
| `PATCH /v1/apps/{app_id}/subscriptions/{subscription_id}`, `POST /v1/apps/{app_id}/subscriptions/{subscription_id}/test` | 24 h |
| `POST /v1/proofs/user-verification`, `POST /v1/proofs/app-verification`, `POST /v1/apps/{app_id}/proofs/app-verification`, `POST /v1/proofs/refresh` | 10 min |
| `POST /v1/reports` | 24 h |

## Pagination

List endpoints take `?limit=` (1 to 200, default 50; values outside that are clamped) and
`?cursor=` (the previous page's `next_cursor`, unchanged). Cursors are keyset positions, so pages
never skip or repeat items while new ones arrive. The last page has `"next_cursor": null`. A
cursor that isn't one of ours is 400 `invalid_cursor`.

```sh
curl -s "$ACCOUNTS_URL/v1/me/history?limit=2" -H "Authorization: Bearer $TOKEN" | jq '{n: (.items|length), next_cursor}'
# {"n": 2, "next_cursor": "WzE3OTEzNDA1MjY1Mzk2MzcsImEiLCI1MCJd"}
curl -s "$ACCOUNTS_URL/v1/me/history?limit=2&cursor=WzE3OTEzNDA1MjY1Mzk2MzcsImEiLCI1MCJd" -H "Authorization: Bearer $TOKEN"
```

## Rate limits and locks

Go over a limit and you get 429 `rate_limited` with `Retry-After` and
`details.retry_after_seconds`. Wait that long, then try again. Too many wrong codes or STKs lock
instead: 423 `verification_locked` / `login_locked`, also with `Retry-After`. Every number is in
[Limits](limits.md).

## Body limits and time budgets

| Requests | Largest body | Time budget |
|---|---|---|
| everything not listed | 64 KB | 30 s |
| `POST /v1/me/photo`, `POST /v1/me/silicons/{uuid}/photo`, `POST /v1/flows/{id}/signup/photo` | 2 MB | 60 s |
| `PATCH /v1/apps/{app_id}/signin-config` | 512 KB | 30 s |
| `POST /v1/apps/{app_id}/imports` | 50 MB | 5 min |
| `POST /v1/internal/apps/sync` | 5 MB | 60 s |

We refuse a larger body before reading it: 413 `payload_too_large` with `details.limit_bytes` (on
the OAuth endpoints, 413 with `error: invalid_request`). A request that runs past its budget ends
with 503 `request_timeout`.

## CORS

Only public resources can be read from other origins. `GET /v1/apps/{app_id}/public`,
`/.well-known/*` and `/sdk/*` answer `Access-Control-Allow-Origin: *` (and so do their
preflights). So do the discovery documents `/openapi.json`, `/v1/openapi.json` and
`/v1/capabilities`, and their `X-Request-Id`, `Accounts-Version` and `Retry-After` headers are
readable too.

Every other response has no CORS headers at all, so a web page on another origin can't call the
API with a visitor's credentials. Call the API from your server. In the browser, use the hosted
pages, the iframe or the SDK ([Add sign-in to your app](../start/add-sign-in.md)).

## Endpoint index

Every endpoint, grouped like the pages that describe it. **Idem.** marks the ones that accept an
`Idempotency-Key`.

### OAuth and OIDC · [oauth.md](api/oauth.md)

| Method and path | Auth | Idem. | Success |
|---|---|---|---|
| `GET /authorize` (a page on the account site) | browser | | redirect to your `redirect_uri` |
| `GET /.well-known/openid-configuration` | public | | 200 discovery document |
| `GET /.well-known/jwks.json` | public | | 200 signing keys |
| `POST /v1/oauth/token` | OAuth client | | 200 token response |
| `POST /v1/oauth/revoke` | OAuth client | | 200 |
| `POST /v1/oauth/introspect` | OAuth client (app) | | 200 |
| `GET`, `POST /v1/userinfo` | app access token | | 200 account as the app sees it |
| `POST /v1/device/authorize` | public | | 200 device and user codes |

### Hosted sign-in, sessions and CLI sign-in · [sign-in.md](api/sign-in.md)

| Method and path | Auth | Idem. | Success |
|---|---|---|---|
| `POST /v1/flows` | public, same origin | | 201 flow |
| `GET /v1/flows/{id}` | flow | | 200 flow |
| `POST /v1/flows/{id}/continue` | flow + account (cookie) | | 200 flow |
| `POST /v1/flows/{id}/switch` | flow | | 200 flow |
| `POST /v1/flows/{id}/email` | flow | | 200 flow |
| `POST /v1/flows/{id}/phone` | flow | | 200 flow |
| `POST /v1/flows/{id}/resend` | flow | | 200 flow |
| `POST /v1/flows/{id}/verify` | flow | | 200 flow |
| `POST /v1/flows/{id}/signup` | flow + `sa_signup` | | 200 flow |
| `POST /v1/flows/{id}/signup/photo` | flow + `sa_signup` | | 201 photo |
| `POST /v1/flows/{id}/details/add` | flow + account (cookie) | | 200 flow |
| `POST /v1/flows/{id}/details/verify` | flow + account (cookie) | | 200 flow |
| `POST /v1/flows/{id}/details/continue` | flow + account (cookie) | | 200 flow |
| `POST /v1/flows/{id}/details/back` | flow + account (cookie) | | 200 flow |
| `POST /v1/flows/{id}/review` | flow + account (cookie) | | 200 flow |
| `POST /v1/flows/{id}/oauth/{provider}` | flow | | 200 provider URL |
| `GET`, `POST /v1/oauth/callback/{provider}` | the starting browser | | 302 / 303 |
| `POST /v1/me/identities/{provider}` | account (Carbon, cookie) | | 201 provider URL |
| `GET /v1/session` | account (cookie) | | 200 session |
| `POST /v1/session/signout` | account (cookie) | | 204 |
| `GET /v1/device/{user_code}` | account (Carbon) | | 200 device request |
| `POST /v1/device/{user_code}/approve` | account (Carbon) | | 204 |
| `POST /v1/device/{user_code}/deny` | account (Carbon) | | 204 |
| `POST /v1/cli/login/start` | public | | 200 challenge |
| `POST /v1/cli/login/verify` | public | | 200 token response |

### Accounts · [accounts.md](api/accounts.md)

| Method and path | Auth | Idem. | Success |
|---|---|---|---|
| `GET /v1/ids/available` | public (account optional) | | 200 availability |
| `GET /v1/accounts/{uuid}` | app or account | | 200 account summary |
| `GET /v1/accounts/by-id/{id}` | app or account | | 200 account summary |
| `GET /v1/me` | account | | 200 me |
| `PATCH /v1/me` | account | yes | 200 me |
| `DELETE /v1/me` | account (Carbon) | | 204 |
| `POST /v1/me/id` | account | yes | 200 me |
| `POST /v1/me/photo` | account | yes | 201 photo |
| `DELETE /v1/me/photo` | account | | 200 me |
| `GET /v1/photos/{id}` | public | | 200 image |
| `GET /v1/me/emails` | account (Carbon) | | 200 list |
| `POST /v1/me/emails` | account (Carbon) | yes | 201 challenge |
| `POST /v1/me/emails/verify` | account (Carbon) | yes | 200 list |
| `POST /v1/me/emails/{email}/primary` | account (Carbon) | | 200 list |
| `DELETE /v1/me/emails/{email}` | account (Carbon) | | 200 list |
| `GET /v1/me/phones` | account (Carbon) | | 200 list |
| `POST /v1/me/phones` | account (Carbon) | yes | 201 challenge |
| `POST /v1/me/phones/verify` | account (Carbon) | yes | 200 list |
| `POST /v1/me/phones/{phone}/primary` | account (Carbon) | | 200 list |
| `DELETE /v1/me/phones/{phone}` | account (Carbon) | | 200 list |
| `GET /v1/me/identities` | account (Carbon) | | 200 list |
| `DELETE /v1/me/identities/{provider}/{subject}` | account (Carbon) | | 204 |
| `GET /v1/me/apps` | account | | 200 list |
| `DELETE /v1/me/apps/{app_id}` | account | | 204 |
| `GET /v1/me/sessions` | account | | 200 list |
| `DELETE /v1/me/sessions/{id}` | account | | 204 |
| `GET /v1/me/history` | account | | 200 list |

### Silicons and custodians · [silicons.md](api/silicons.md)

| Method and path | Auth | Idem. | Success |
|---|---|---|---|
| `POST /v1/silicons` | public | yes | 201 Silicon + request |
| `GET /v1/silicons/requests/{id}` | request token | | 200 request |
| `POST /v1/silicons/login` | public | | 200 token response |
| `POST /v1/me/short-lived-tokens` | account | | 201 short-lived token |
| `POST /v1/me/identity-tokens` | account (Silicon) | | 201 identity token |
| `GET /v1/silicons/{id}/federations` | account (the Silicon or its custodian) | | 200 list |
| `POST /v1/silicons/{id}/federations` | account (the Silicon or its custodian) | | 201 trust |
| `DELETE /v1/silicons/{id}/federations/{federation_id}` | account (the Silicon or its custodian) | | 204 |
| `GET /v1/silicons/{id}/identity-audiences` | account (the Silicon or its custodian) | | 200 audiences |
| `PUT /v1/silicons/{id}/identity-audiences` | account (custodian) | | 200 audiences |
| `PUT /v1/me/webhook` | account (Silicon) | | 200 webhook + secret |
| `DELETE /v1/me/webhook` | account (Silicon) | | 204 |
| `POST /v1/me/webhook/test` | account (Silicon) | | 202 queued ping |
| `GET /v1/me/webhook/deliveries` | account (Silicon) | | 200 list |
| `GET /v1/me/webhook/deliveries/{delivery_id}` | account (Silicon) | | 200 delivery |
| `POST /v1/me/webhook/replay` | account (Silicon) | yes | 200 result |
| `GET /v1/me/silicons` | account (Carbon) | | 200 list |
| `POST /v1/me/silicons` | account (Carbon) | yes | 201 Silicon + STK |
| `GET /v1/me/silicons/{uuid}` | account (Carbon, custodian) | | 200 Silicon |
| `PATCH /v1/me/silicons/{uuid}` | account (Carbon, custodian) | | 200 Silicon |
| `DELETE /v1/me/silicons/{uuid}` | account (Carbon, custodian) | | 204 |
| `POST /v1/me/silicons/{uuid}/id` | account (Carbon, custodian) | | 200 Silicon |
| `POST /v1/me/silicons/{uuid}/photo` | account (Carbon, custodian) | yes | 201 photo |
| `PUT /v1/me/silicons/{uuid}/webhook` | account (Carbon, custodian) | | 200 webhook + secret |
| `DELETE /v1/me/silicons/{uuid}/webhook` | account (Carbon, custodian) | | 204 |
| `GET /v1/me/silicons/{uuid}/webhook/deliveries` | account (Carbon, custodian) | | 200 list |
| `GET /v1/me/silicons/{uuid}/webhook/deliveries/{delivery_id}` | account (Carbon, custodian) | | 200 delivery |
| `POST /v1/me/silicons/{uuid}/webhook/replay` | account (Carbon, custodian) | yes | 200 result |
| `POST /v1/me/silicons/{uuid}/stk` | account (Carbon, custodian) | yes | 200 new STK |
| `POST /v1/me/silicons/{uuid}/transfer` | account (Carbon, custodian) | | 201 request |
| `DELETE /v1/me/silicons/{uuid}/transfer` | account (Carbon, custodian) | | 204 |
| `GET /v1/me/custodian-requests` | account (Carbon) | | 200 list |
| `POST /v1/me/custodian-requests/{id}/accept` | account (Carbon) | | 204 |
| `POST /v1/me/custodian-requests/{id}/decline` | account (Carbon) | | 204 |

### Apps · [apps.md](api/apps.md)

| Method and path | Auth | Idem. | Success |
|---|---|---|---|
| `GET /v1/apps/{app_id}/public` | public (CORS `*`) | | 200 public config |
| `GET /v1/apps/{app_id}/account-verification-request` | signed-in manager | | 200 latest own request or null |
| `POST /v1/apps/{app_id}/account-verification-request` | signed-in manager | optional | 201 queued request, or 200 existing pending request |
| `GET /v1/me/owned-apps` | account (Carbon) | | 200 list |
| `GET /v1/apps/{app_id}` | app or author | | 200 app |
| `PATCH /v1/apps/{app_id}/signin-config` | app or author | yes | 200 app |
| `GET /v1/apps/{app_id}/signin-config/history` | app or author | | 200 list |
| `GET /v1/apps/{app_id}/users` | app or author | | 200 list |
| `GET /v1/apps/{app_id}/users/{uuid}` | app or author | | 200 user |
| `POST /v1/apps/{app_id}/imports` | app or author | yes | 202 job |
| `GET /v1/apps/{app_id}/imports` | app or author | | 200 list |
| `GET /v1/apps/{app_id}/imports/{job_id}` | app or author | | 200 job |
| `GET /v1/apps/{app_id}/imports/{job_id}/rows` | app or author | | 200 list |
| `PUT /v1/apps/{app_id}/webhook` | app or author | yes | 200 URL + secret (null when one was already stored) + updates |
| `DELETE /v1/apps/{app_id}/webhook` | app or author | | 204 |
| `POST /v1/apps/{app_id}/webhook/rotate-secret` | app or author | yes | 200 secret |
| `POST /v1/apps/{app_id}/webhook/generate-secret` | app or author | yes | 200 secret |
| `POST /v1/apps/{app_id}/webhook/test` | app or author | yes | 202 queued ping |
| `GET /v1/apps/{app_id}/webhook/deliveries` | app or author | | 200 list |
| `GET /v1/apps/{app_id}/webhook/deliveries/{delivery_id}` | app or author | | 200 delivery |
| `POST /v1/apps/{app_id}/webhook/replay` | app or author | yes | 200 result |
| `GET /v1/apps/{app_id}/webhook` | app or author | | 200 webhook |
| `GET /v1/apps/{app_id}/subscriptions` | app or author | | 200 list |
| `POST /v1/apps/{app_id}/subscriptions` | app or author | yes | 201 subscription |
| `GET /v1/apps/{app_id}/subscriptions/{subscription_id}` | app or author | | 200 subscription |
| `PATCH /v1/apps/{app_id}/subscriptions/{subscription_id}` | app or author | yes | 200 subscription |
| `DELETE /v1/apps/{app_id}/subscriptions/{subscription_id}` | app or author | | 204 |
| `POST /v1/apps/{app_id}/subscriptions/{subscription_id}/test` | app or author | yes | 202 queued ping |
| `POST /v1/internal/apps/sync` | internal | | 200 synced apps |

### App verification and User verification · [proofs.md](api/proofs.md)

| Method and path | Auth | Idem. | Success |
|---|---|---|---|
| `POST /v1/proofs/user-verification` | app | yes | 201 proof |
| `POST /v1/proofs/app-verification` | app | yes | 201 proof |
| `POST /v1/proofs/refresh` | app (the issuer) | yes | 200 proof |
| `POST /v1/proofs/verify` | app (an audience) | | 200 valid or not |
| `POST /v1/proofs/revoke` | app (the issuer) | | 204 |
| `GET /v1/apps/{app_id}/proofs` | app or author | | 200 list |
| `POST /v1/apps/{app_id}/proofs/app-verification` | app or author | yes | 201 proof |
| `DELETE /v1/apps/{app_id}/proofs/{proof_id}` | app or author | | 204 |
| `GET /v1/me/app-verifications` | signed-in manager | | 200 retained App verification records |
| `GET /v1/apps/{app_id}/proofs/{proof_id}/history` | signed-in manager | | 200 retained verification history |
| `GET /v1/me/proofs` | account | | 200 User verification list |
| `DELETE /v1/me/proofs/{proof_id}` | account | | 204 |

### Webhooks · [webhooks.md](api/webhooks.md)

Webhooks are requests we send to you. That page has the delivery format, the signature and every
event type. The endpoints that set a webhook and list or replay its deliveries are under
[Apps](#apps--appsmd) (an app's webhook) and
[Silicons and custodians](#silicons-and-custodians--siliconsmd) (a Silicon's).

### Events · [webhooks.md](api/webhooks.md#event-stream)

| Method and path | Auth | Idem. | Success |
|---|---|---|---|
| `GET /v1/events/stream` | app, account or request token | | 200 Server-Sent Events |

### Service · [service.md](api/service.md)

| Method and path | Auth | Idem. | Success |
|---|---|---|---|
| `GET /healthz` | public, on `accounts-api`'s own address only | | 200 `ok` |
| `GET /readyz` | public, on `accounts-api`'s own address only | | 200 / 503 |
| `GET /v1/meta` | public | | 200 deployment |
| `POST /v1/reports` | public (account optional) | yes | 201 report |
| `POST /v1/telemetry/events` | public | | 202 |
| `GET /v1/dev/outbox` | public, development only | | 200 list |
| `GET /v1/capabilities` | public | | 200 capabilities, 422 when a required one is missing |
| `GET /openapi.json`, `GET /v1/openapi.json` | public | | 200 OpenAPI 3.1 document |
| `GET /.well-known/agent.json` | public | | 200 A2A agent card |
| `GET /embed/v1/buttons`, `GET /sdk/v1.js` | public, served by the account site | | the embed page and the SDK |

On the public origin, any other path under `/v1` or `/.well-known` is 404 `route_not_found`
(JSON). Every other unknown path there, including under `/embed`, `/sdk` or `/healthz`, is the
account site's HTML 404 page. On `accounts-api`'s own address, every unknown path is 404
`route_not_found`. A known path with the wrong method is 405 `method_not_allowed`, with an
`Allow` header.

## Related

- [Errors](errors.md): every error code with its status, cause and fix.
- [Limits](limits.md): every rate limit, lifetime, size and count.
- [Rust client](rust-client.md): the same API from Rust.
- [Security](../learn/security.md): cookies, the Origin check, token storage, the webhook SSRF guard.
