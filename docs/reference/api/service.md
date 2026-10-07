---
title: Service endpoints
description: Reference for health and readiness probes, deployment metadata, bug reports, telemetry, the development outbox, the embed and SDK files, and what unknown paths answer.
kind: informative
order: 68
related:
  - reference/api.md
  - reference/limits.md
  - learn/security.md
---

# Service endpoints

These endpoints describe and watch the service itself, and take bug reports and telemetry.

```sh
curl -s "$ACCOUNTS_URL/v1/meta"          # which deployment answered (public origin)
curl -s "$ACCOUNTS_API_URL/healthz"      # ok                  (accounts-api's own address)
curl -s "$ACCOUNTS_API_URL/readyz"       # {"database":"ok"}
```

`ACCOUNTS_API_URL` is `accounts-api`'s own address, not the public origin: locally
`http://127.0.0.1:8589`; in production, the address of the `accounts-api` process behind the
account site. The account site at the public origin forwards only `/v1/*` and `/.well-known/*`
to `accounts-api`, so `$ACCOUNTS_URL/healthz` and `$ACCOUNTS_URL/readyz` get the site's HTML 404
page, not a probe.

## `GET /healthz`

Liveness: **200** `ok` (plain text, `no-store`). Checks nothing but the process. On `accounts-api`'s
own address only.

## `GET /readyz`

Readiness, on `accounts-api`'s own address only: **200** `{"database": "ok"}` when Postgres
answers, else **503**:

```json
{
  "database": "unavailable",
  "error": {
    "code": "database_unavailable",
    "message": "Silicon Accounts can't reach its database, so it is not ready to serve requests.",
    "hint": "Check that Postgres is running and ACCOUNTS_DATABASE_URL points at it."
  }
}
```

## `GET /v1/meta`

What this deployment is. Public.

```json
{
  "name": "Silicon Accounts",
  "version": "0.1.0",
  "environment": "production",
  "public_url": "https://accounts.teamofsilicons.com",
  "silicon_apps_url": "https://apps.teamofsilicons.com",
  "docs_url": "https://accounts.teamofsilicons.com/docs",
  "developer_url": "https://developer.teamofsilicons.com",
  "providers": { "google": true, "apple": true },
  "delivery": "providers"
}
```

`environment` is `production`, `development` or `test`; `developer_url` is the developer
platform, where apps' sign-in is set up (`ACCOUNTS_DEVELOPER_URL`; the account site's
`/developer` pages redirect there); `providers` says whether one-click
(managed) Google and Apple are configured; `delivery` is `providers` (Postmark and Twilio) or
`local` (nothing is sent; development only).

## `POST /v1/reports`

Report a bug to the Silicon Accounts maintainers, optionally with the pull request that fixes
it. Public; signed-in reports name the account (send the Bearer token or cookie). **Idempotent.**
5 reports per IP per hour. Unknown fields are refused.

```sh
curl -s -X POST "$ACCOUNTS_URL/v1/reports" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: report-2026-10-07-1' \
  -d '{"message":"POST /v1/me/emails says \"A email\" (request id 01a1…)","pr_url":"https://github.com/teamofsilicons/silicon-accounts/pull/42"}'
```

**201**:

```json
{ "report_id": "01a11439-e90a-7133-aca9-e337db93d14f", "status": "queued", "recipients": 3 }
```

`message` is 1 to 10,000 characters; `pr_url` must be https. Each report is emailed to every
maintainer address. Errors: 422 `validation_failed`, 429 `rate_limited`. The CLI's
`accounts report "…" --pr <link>` calls this endpoint.

## `POST /v1/telemetry/events`

Client telemetry, forwarded to Space Station. Public; 120 requests per IP per minute.

```json
{
  "events": [
    { "source": "cli", "step": "login.code", "name": "cli.step", "progress": 0.5, "data": { "ok": true } }
  ]
}
```

At most 50 events; `name` matches `^[a-z0-9_.]{1,64}$`; `source` is 1–64 characters of
`a-z 0-9 _ . -`; `step` is 1–200 printable characters; `progress` is 0 to 1; `data` is an object
of at most 8 KB. **202** `{"accepted": 1, "forwarded": false}` (`forwarded` is true when Space
Station took them). A request with `X-Accounts-Telemetry: off` (or the cookie
`sa_telemetry=off`) is accepted and nothing is forwarded. Errors: 422 `validation_failed`, 429
`rate_limited`.

## `GET /v1/dev/outbox`

**Development only**: the emails and text messages the service recorded, newest first, with the
6-digit code parsed out, so local tests can sign in without an inbox. Query: `to`, `purpose`,
`limit` (1–200, default 50). It works only when `ACCOUNTS_EXPOSE_DEV_OUTBOX=true` outside
production: in production it answers exactly like an unknown route (404 `route_not_found`);
elsewhere with the outbox off, 404 `dev_outbox_disabled`.

```sh
curl -s "http://localhost:8590/v1/dev/outbox?to=ada@example.test&limit=1" | jq -r '.items[0].code'
```

Items: `id`, `channel` (`email` | `sms`), `to`, `subject`, `text_body`, `purpose`
(`otp_signin`, `otp_cli_login`, `otp_add_email`, `otp_add_phone`, `otp_requirement`,
`custodian_request`, `custodian_invite`, `custodian_transfer`, `report`), `status`, `attempts`,
`last_error`, `sent_at`, `created_at`, `code` (the 6-digit code of an `otp_*` message, else
null). `to` matches the exact address (case-insensitive; phones in E.164, URL-encoded as
`%2B…`).

## `GET /embed/v1/buttons` and `GET /sdk/v1.js`

The sign-in iframe and the SDK script for apps. In production the account site serves both: the
iframe with `frame-ancestors 'self' <the app's allowed_origins>` (none configured, unknown app:
`'none'`), the SDK with `Access-Control-Allow-Origin: *` and `Cache-Control: public,
max-age=300`. See [the iframe](../../start/iframe.md) and [the SDK](../../start/sdk.md). The API
serves them itself only in the legacy static-hosting setup (`ACCOUNTS_WEB_DIST`); otherwise it
answers 404 `route_not_found` with a hint.

## Unknown paths

On the public origin, any other path under `/v1` or `/.well-known` (the paths the account site
forwards), and on `accounts-api`'s own address any unknown path at all:

```json
{
  "error": {
    "code": "route_not_found",
    "message": "There is no endpoint GET /v1/nope in Silicon Accounts.",
    "hint": "Check the method and the path: the API lives under /v1 (plus /.well-known, /healthz and /readyz). GET /v1/meta describes this server; the API reference is at https://accounts.teamofsilicons.com/docs."
  }
}
```

Every other unknown path on the public origin (`/embed/v1/nope`, `/sdk/v2.js`, `/healthz`) is
the account site's HTML 404 page, because the site, not `accounts-api`, answers it.

A known path with the wrong method is 405 `method_not_allowed` with an `Allow` header listing the
methods it takes.
