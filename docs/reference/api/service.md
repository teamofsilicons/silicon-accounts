---
title: Service endpoints
description: Check that we're up and what this deployment supports, send us a bug report, and find the SDK, embed, telemetry and development endpoints.
kind: informative
order: 68
related:
  - reference/api.md
  - reference/limits.md
  - learn/security.md
---

# Service endpoints

Use these to check that the service is running, see how this deployment is set up, or send us a bug report. This page also covers the SDK and embed resources, the telemetry endpoint and the development outbox.

```sh
curl -s "$ACCOUNTS_URL/v1/meta"          # which deployment answered (public origin)
curl -s "$ACCOUNTS_API_URL/healthz"      # ok                  (accounts-api's own address)
curl -s "$ACCOUNTS_API_URL/readyz"       # {"database":"ok"}
```

Send health and readiness probes straight to `accounts-api`. On a local stack that's `ACCOUNTS_API_URL=http://127.0.0.1:8589`; in production, use the API process's internal address.

The public account site forwards `/v1/*` and `/.well-known/*` to that process, but not `/healthz` or `/readyz`. Calling those through `$ACCOUNTS_URL` gets you the site's HTML 404 page.

## `GET /healthz`

Liveness: **200** `ok` (plain text, `no-store`). It checks nothing but the process, and it
answers only on `accounts-api`'s own address.

## `GET /readyz`

Readiness, only on `accounts-api`'s own address: **200** `{"database": "ok"}` when Postgres
answers, otherwise **503**:

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
  "version": "0.3.0",
  "environment": "production",
  "public_url": "https://accounts.teamofsilicons.com",
  "silicon_apps_url": "https://apps.teamofsilicons.com",
  "docs_url": "https://developers.teamofsilicons.com/docs/accounts",
  "developer_url": "https://developers.teamofsilicons.com",
  "providers": { "google": true, "apple": true },
  "delivery": "providers"
}
```

`environment` is `production`, `development` or `test`. `developer_url` is the developer
platform, where apps set up their sign-in (`ACCOUNTS_DEVELOPER_URL`; the account site's
`/developer` pages redirect there). `providers` says whether one-click (managed) Google and Apple
are configured. `delivery` is `providers` (Postmark and Twilio) or `local` (nothing is sent;
development only).

## `POST /v1/reports`

Tell the Silicon Accounts maintainers about a bug, and add the pull request that fixes it if you
have one (we'd be grateful). It's public; a signed-in report names the account (send the Bearer
token or cookie). **Idempotent.** 5 reports per IP per hour. Unknown fields are refused.

```sh
curl -s -X POST "$ACCOUNTS_URL/v1/reports" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: report-2026-10-07-1' \
  -d '{"message":"POST /v1/me/emails says \"A email\" (request id 01a1…)","pr_url":"https://github.com/teamofsilicons/silicon-accounts/pull/42"}'
```

**201**:

```json
{ "report_id": "01a11439-e90a-7133-aca9-e337db93d14f", "status": "queued", "recipients": 3 }
```

`message` is 1 to 10,000 characters, and `pr_url` must be https. Every report is emailed to each
maintainer address. Errors: 422 `validation_failed`, 429 `rate_limited`. The CLI's
`silicon-accounts report "…" --pr <link>` calls this endpoint.

## `POST /v1/telemetry/events`

Client telemetry, which we forward to Space Station. Public; 120 requests per IP per minute.

```json
{
  "events": [
    { "source": "cli", "step": "login.code.sent", "name": "cli.step", "progress": 0.4,
      "data": { "channel": "email", "command": "login", "cli_version": "0.4.0", "os": "macos", "arch": "aarch64" } }
  ]
}
```

At most 50 events. `name` matches `^[a-z0-9_.]{1,64}$`; `source` is 1 to 64 characters of
`a-z 0-9 _ . -`; `step` is 1 to 200 printable characters; `progress` is 0 to 1; `data` is an
object of at most 8 KB. Answers **202** `{"accepted": 1, "forwarded": true}` (`forwarded` is
false when nothing is forwarded for this request). A request with `X-Accounts-Telemetry: off` (or
the cookie `sa_telemetry=off`) is accepted and nothing is forwarded. Errors: 422
`validation_failed`, 429 `rate_limited`.

We forward only what the `silicon-accounts` CLI reports, word for word, so no identifier or free
text gets through whatever its shape:

- only the CLI's events: `source` `cli`, `name` `cli.command` or `cli.step` (others are accepted
  and dropped);
- `step` as one of the CLI's step names or command paths, anything else as `other`; `progress`
  rounded to the hundredth;
- in `data`, only `cli_version` (a release version such as `0.4.0` or `0.5.0-rc.1`), `outcome`,
  `exit_code`, `duration_ms` (a day at most), `json`, `account_kind`, `kind`, `method`,
  `channel`, `browser_opened`, `dry_run`, `format`, `ttl_seconds` (a day at most), `wait`,
  `webhook`, `signed_in`, each only as the CLI sends it (a flag, a count, an exit code from
  -1000 to 1000, or one of a fixed set of words) or as `null`; `command`, `os`, `arch` and
  `error_code` as one of the words the CLI uses, else `other`; and `app` or `app_id` (an app
  id) only on the `login.slt.issued` step. Everything else is dropped, the `source` the CLI
  reports for a `--federated` sign-in included.

The validation and the 202 answer don't change with this filter: an event is accepted when it is
well formed, whatever is forwarded of it.

## `GET /v1/dev/outbox`

**Development only.** The emails and text messages the service recorded, newest first, with the
6-digit code parsed out, so local tests can sign in without an inbox. Query: `to`, `purpose`,
`limit` (1 to 200, default 50). It works only when `ACCOUNTS_EXPOSE_DEV_OUTBOX=true` outside
production. In production it answers exactly like an unknown route (404 `route_not_found`);
elsewhere, with the outbox off, it answers 404 `dev_outbox_disabled`.

```sh
curl -s "http://localhost:8590/v1/dev/outbox?to=ada@example.test&limit=1" | jq -r '.items[0].code'
```

Items: `id`, `channel` (`email` | `sms`), `to`, `subject`, `text_body`, `purpose`
(`otp_signin`, `otp_cli_login`, `otp_add_email`, `otp_add_phone`, `otp_requirement`,
`custodian_request`, `custodian_invite`, `custodian_transfer`, `report`), `status`, `attempts`,
`last_error`, `sent_at`, `created_at`, `code` (the 6-digit code of an `otp_*` message, else
null). `to` matches the exact address (case-insensitive; phones in E.164, URL-encoded as
`%2B…`).

## `GET /v1/capabilities`

What this deployment supports, so a Silicon or an app can check before relying on something.
Public, CORS `*`, cacheable for 5 minutes. Each capability has `supported`, a `description`, its
`endpoints` and its `docs`. The answer also lists the API versions, the ways to authenticate, the
main limits, and links to the OpenAPI document, the agent card, the MCP server and `llms.txt`.

```sh
curl -s "$ACCOUNTS_URL/v1/capabilities?require=sse,subscriptions"
```

```json
{
  "service": "Silicon Accounts",
  "version": "0.3.0",
  "api_version": "2026-10-01",
  "api_versions": ["2026-10-01"],
  "version_header": "Accounts-Version",
  "public_url": "https://accounts.teamofsilicons.com",
  "capabilities": {
    "sse": {
      "supported": true,
      "description": "Event streaming with Server-Sent Events: the same events and bodies as webhooks, live, with heartbeats.",
      "endpoints": ["GET /v1/events/stream"],
      "docs": "https://developers.teamofsilicons.com/docs/accounts/learn/webhooks#streaming-events"
    },
    "…": "…"
  },
  "auth_methods": [{ "name": "bearer_access_token", "description": "…", "header": "Authorization" }, "…"],
  "limits": { "page_size_max": 200, "streams_per_caller": 5, "stream_heartbeat_seconds": 15, "stream_max_seconds": 3600, "webhook_retry_hours": 72, "…": "…" },
  "links": {
    "openapi": "https://accounts.teamofsilicons.com/openapi.json",
    "agent_card": "https://accounts.teamofsilicons.com/.well-known/agent.json",
    "mcp": "https://accounts.teamofsilicons.com/mcp",
    "llms_txt": "https://accounts.teamofsilicons.com/llms.txt",
    "docs": "https://developers.teamofsilicons.com/docs/accounts",
    "…": "…"
  },
  "require": { "requested": ["sse", "subscriptions"], "satisfied": true, "supported": ["sse", "subscriptions"], "missing": [] }
}
```

The 27 capabilities are `rest_json`, `openapi`, `structured_errors`, `rate_limit_headers`,
`idempotency_keys`, `pagination`, `version_negotiation`, `capability_negotiation`,
`bearer_tokens`, `client_credentials`, `oauth2`, `openid_connect`, `device_flow`,
`short_lived_tokens`, `workload_identity_federation`, `identity_tokens`, `proofs`, `webhooks`,
`webhook_signatures`, `webhook_replay`, `sse`, `stream_resume`, `subscriptions`, `imports`,
`agent_card`, `mcp` and `llms_txt`. `require` takes 1 to 50 of them (each at most 64 characters),
separated by commas. Case doesn't matter, and `-`, `.` and spaces count as `_`.

`client_credentials` means your app authenticates its API calls with HTTP Basic
`app_id:app_secret`, as its description says. It isn't the OAuth 2.0 `client_credentials` grant:
we issue no app-only access tokens, so `POST /v1/oauth/token` refuses that grant with
`unsupported_grant_type`, and an app proves itself to another app with an
[App verification proof](../../start/app-verification.md) instead.

Some common names work as aliases:

| You may send | It means |
|---|---|
| `event_stream`, `event_streaming`, `events_stream`, `server_sent_events`, `streaming` | `sse` |
| `idempotency` | `idempotency_keys` |
| `webhook` | `webhooks` |
| `subscription` | `subscriptions` |
| `oauth` | `oauth2` |
| `oidc` | `openid_connect` |
| `errors` | `structured_errors` |
| `rate_limits` | `rate_limit_headers` |
| `versioning` | `version_negotiation` |
| `token_exchange`, `trusted_publishing`, `oidc_federation`, `federation` | `workload_identity_federation` |
| `cloud_federation`, `id_tokens_for_clouds` | `identity_tokens` |
| `a2a` | `agent_card` |

Anything else is unknown. `graphql`, for example, is neither a name nor an alias. If one name is
unknown or unsupported, the answer is 422:

```json
{
  "error": {
    "code": "capabilities_missing",
    "message": "Silicon Accounts does not support this capability: graphql.",
    "hint": "Check the names against details.available (GET /v1/capabilities lists each with its docs), or go without the missing ones.",
    "details": { "missing": ["graphql"], "supported": ["sse"], "available": ["rest_json", "openapi", "…"] }
  }
}
```

An empty `require`, more than 50 names or a name over 64 characters is 400 `invalid_query`.

Silicon Apps answers `require` differently, so don't share one parser between the two services.
Its names are its own (`streaming`, `target:linux-x86_64`, …) and must match exactly, an empty
`require` is ignored, and its 422 `capabilities_missing` lists `details.missing` as objects with a
reason each. See [the Apps HTTP API](/docs/apps/reference/api#discovery-versions-and-limits).

## `GET /openapi.json` and `GET /v1/openapi.json`

The OpenAPI 3.1 document of every endpoint: methods, paths, authentication
(`bearerAuth`, `appBasic`, `requestToken` and the others), parameters, bodies, responses and the
error shape. Public, CORS `*`, cacheable for 5 minutes. A test keeps it in step with the routes
the service really has.

```sh
curl -s "$ACCOUNTS_URL/openapi.json" | jq '.paths | keys | length'
```

## `GET /.well-known/agent.json`

The [A2A](https://a2a-protocol.org) agent card: what the service is, its skills (create a Silicon
account, sign a Silicon into an app, verify a proof, manage app sign-in, subscribe to account
events), how to authenticate, and links to the OpenAPI document, `llms.txt`, the docs and the MCP
server. Public, CORS `*`, cacheable for 5 minutes. We speak REST and MCP, not A2A tasks:
`capabilities.streaming` and `pushNotifications` describe the event stream and webhooks.

```json
{
  "protocolVersion": "0.3.0",
  "name": "Silicon Accounts",
  "description": "Accounts for Carbons and Silicons. …",
  "url": "https://accounts.teamofsilicons.com",
  "provider": { "organization": "Team of Silicons", "url": "https://teamofsilicons.com" },
  "version": "0.3.0",
  "documentationUrl": "https://developers.teamofsilicons.com/docs/accounts",
  "capabilities": { "streaming": true, "pushNotifications": true, "stateTransitionHistory": false },
  "skills": [{ "id": "create-silicon-account", "name": "Create a Silicon account", "…": "…" }, "…"],
  "links": { "openapi": "https://accounts.teamofsilicons.com/openapi.json", "mcp": "https://accounts.teamofsilicons.com/mcp", "…": "…" }
}
```

## `GET /embed/v1/buttons` and `GET /sdk/v1.js`

The sign-in iframe and the SDK script for apps. In production the account site serves both:

- the iframe with `frame-ancestors 'self' <the app's allowed_origins>` (`'none'` when none are
  configured or the app is unknown);
- the SDK with `Access-Control-Allow-Origin: *` and `Cache-Control: public, max-age=300`.

See [the iframe](../../start/iframe.md) and [the SDK](../../start/sdk.md). The API serves them
itself only in the legacy static-hosting setup (`ACCOUNTS_WEB_DIST`); otherwise it answers 404
`route_not_found` with a hint.

## Unknown paths

On the public origin, any other path under `/v1` or `/.well-known` (the paths the account site
forwards), and any unknown path at all on `accounts-api`'s own address, gets:

```json
{
  "error": {
    "code": "route_not_found",
    "message": "There is no endpoint GET /v1/nope in Silicon Accounts.",
    "hint": "Check the method and the path: the API lives under /v1 (plus /.well-known, /healthz and /readyz). GET /v1/meta describes this server; the API reference is at https://developers.teamofsilicons.com/docs/accounts."
  }
}
```

Every other unknown path on the public origin (`/embed/v1/nope`, `/sdk/v2.js`, `/healthz`) gets
the account site's HTML 404 page, because the site answers it, not `accounts-api`.

A known path with the wrong method is 405 `method_not_allowed`, with an `Allow` header listing
the methods it takes.
