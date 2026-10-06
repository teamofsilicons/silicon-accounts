# silicon-accounts-server (`accounts_server`)

The Silicon Accounts service: composes every feature crate into one HTTP router, adds the
middleware stack, serves the account site, and ships the three binaries.

| binary | what it does |
|---|---|
| `accounts-api` | the HTTP service (API + account site + embed + SDK) and, with `ACCOUNTS_WORKER_ENABLED=true`, the background work |
| `accounts-migrate` | applies the embedded migrations, printing every pending and applied version; `--check` only lists them (exit 3 when some are pending) |
| `accounts-seed` | `--fake-apps testkit/fake-apps.json [--force]`: loads the fake apps through `accounts_apps::seed_fake_apps` (the same upsert as `POST /v1/internal/apps/sync`) |

## Run it locally

One command brings up the whole stack (Postgres, migrations, the fake apps, the testkit's mock
Google/Apple and Postmark/Twilio, the fake app server, and accounts-api wired to them):

```bash
scripts/dev.sh             # foreground, Ctrl-C stops everything; --detach + scripts/stop.sh otherwise
scripts/journeys.sh        # the non-browser journeys against a fresh stack on ports 9690-9693
```

`scripts/dev.sh --help` lists the flags (`--no-build`, `--release`, `--reseed`, `--reset-db`) and
the port/database overrides; it serves the account site from `web/dist` when it has been built
(`pnpm -C web build`). By hand:

```bash
scripts/dev-db.sh                                   # Postgres on 127.0.0.1:5444
cargo run -p silicon-accounts-server --bin accounts-migrate
cargo run -p silicon-accounts-server --bin accounts-seed -- --fake-apps testkit/fake-apps.json
pnpm -C web build                                   # optional: the account site
ACCOUNTS_WEB_DIST=web/dist ACCOUNTS_EXPOSE_DEV_OUTBOX=true \
  cargo run -p silicon-accounts-server --bin accounts-api   # http://localhost:8590
```

Configuration is the `ACCOUNTS_*` environment (see `/.env.example`); development works with no
variables at all. `accounts-api` refuses to start (exit 2) on invalid configuration or when
`ACCOUNTS_WEB_DIST` has no `index.html`, and (exit 1) when the database is unreachable or has
pending migrations. On Ctrl-C / SIGTERM, at the same moment, it stops accepting connections and
lets in-flight requests finish (30 s at most), and the worker stops claiming work and finishes the
webhooks and emails it is sending (normally within one 10 s send timeout; anything still running
after 20 s is cut off and, still claimed, retried by a node once its 60 s claim ends). The whole
stop takes at most 30 s.

## Endpoints owned here

| route | |
|---|---|
| `GET /healthz` | `200 ok` (liveness; no dependencies checked) |
| `GET /readyz` | `200 {"database":"ok"}`, or `503` with an error object |
| `GET /v1/meta` | name, version, environment, public URL, Silicon Apps URL, managed providers, delivery mode |
| `POST /v1/reports` | bug report (optional session; 5/hour per IP; message 1..10000 chars; `pr_url` https; `Idempotency-Key`) mailed to every `ACCOUNTS_REPORT_RECIPIENTS` address → `201 {"report_id","status":"queued","recipients":3}` |
| `POST /v1/telemetry/events` | ≤ 50 events named `^[a-z0-9_.]{1,64}$` (the CLI sends `cli.command` / `cli.step`), forwarded to Space Station unless `X-Accounts-Telemetry: off` → `202 {"accepted","forwarded"}` |
| `GET /v1/dev/outbox?to=&purpose=&limit=` | recorded messages with the parsed OTP `code`; only with `ACCOUNTS_EXPOSE_DEV_OUTBOX=true` outside production (production answers like an unknown route) |
| `GET /embed/v1/buttons?app_id=…` | the iframe page with `frame-ancestors 'self' <app allowed_origins>` (`'none'` for unknown/disabled apps or no origins) |
| `GET /sdk/v1.js` | the SDK, CORS `*`, `Cache-Control: public, max-age=300` |
| anything else | unknown API paths (`/v1`, `/.well-known`, `/embed`, `/sdk`, `/healthz`, `/readyz`) → `404 route_not_found` JSON; other GET/HEAD → the account site (`index.html`, `no-store`) when `ACCOUNTS_WEB_DIST` is set |

## Middleware (outermost first)

1. **Request id** (core): `X-Request-Id` taken when sane, generated otherwise, on every response.
2. **Observe**: one log line per request inside a span carrying the request id; a Space Station
   `http.request` event (source `api`, step `"{METHOD} {route template}"`, progress 1.0; route
   template, method, status, duration — never raw paths or query strings). Health probes,
   static files and requests with `X-Accounts-Telemetry: off` are skipped.
3. **Policy**: `X-Content-Type-Options: nosniff`, `Referrer-Policy`, HSTS when cookies are secure;
   HTML gets the site CSP (`frame-ancestors 'none'`) + `X-Frame-Options: DENY`; JSON gets
   `default-src 'none'` and, under `/v1`, `Cache-Control: no-store` unless the handler set one.
   CORS `*` only for `/v1/apps/{app_id}/public`, `/sdk/*`, `/.well-known/*` (preflights answered
   here); every other response leaves without CORS headers. Plain-text 4xx/5xx (axum's 405,
   framework rejections) are rewritten into `{"error":{"code","message","hint"}}`.
4. **Limits**: body limits by route — 64 KB default, 2 MB `POST /v1/me/photo`, 50 MB
   (+64 KB envelope) `POST /v1/apps/{app_id}/imports`, 5 MB `POST /v1/internal/apps/sync`,
   512 KB `PATCH /v1/apps/{app_id}/signin-config` (two inline logos of up to 128 KB) —
   enforced on `Content-Length` and on the body stream (`413 payload_too_large`); time budgets
   30 s / 60 s (photo, sync) / 5 min (imports) → `503 request_timeout`.
5. **Panic recovery**: a panicking handler becomes `500 internal` with `details.request_id`.

Errors these layers make (413, 503 time budget, 500 panic, rewritten 405 / plain-text errors)
use the API error object everywhere except `/v1/oauth/token`, `/v1/oauth/revoke` and
`/v1/oauth/introspect`, which answer RFC 6749 bodies like their handlers do
(`{"error":"invalid_request"|"temporarily_unavailable"|"server_error","error_description":"…"}`,
same status, `Cache-Control: no-store`, the request id in the description of 5xx).

Static files: `/assets/*` (content-hashed) are `public, max-age=31536000, immutable`; a missing
asset is a 404, never the HTML; other build files are `no-cache`; dotfiles are never served;
text is gzip-compressed when accepted (API JSON is not compressed).

## Telemetry

Every Space Station event carries source, step and progress: `http.request` (1.0),
`report.submitted` (1.0), `api.started` / `api.stopped` (1.0), plus the worker's events (see
its README) and client events forwarded by `POST /v1/telemetry/events` (their own progress).

## Tests

```bash
CARGO_TARGET_DIR=target/server cargo test -p silicon-accounts-server   # needs scripts/dev-db.sh
```

Driven in-process through `build_router` (tower `oneshot`) against a throwaway database:
endpoints, security headers, CORS, the SPA/static/embed/SDK serving, every body-limit class
(64 KB, 2 MB photo, 512 KB sign-in config, 5 MB sync, 50 MB imports — declared and streamed),
every time budget, RFC 6749 errors on the OAuth endpoints, panics, and background start/stop.
