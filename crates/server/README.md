# silicon-accounts-server (`accounts_server`)

The Silicon Accounts service: composes every feature crate into one HTTP router, adds the
middleware stack, and ships the three binaries.

**Topology.** The account site (Next.js, `web/`) serves the public origin
(`ACCOUNTS_PUBLIC_URL`, `https://accounts.teamofsilicons.com`; `http://localhost:8590` locally):
its pages, the embed page and `sdk/v1.js`, and it proxies `/v1/*` and `/.well-known/*` to
`accounts-api` (its `rewrites`, target `ACCOUNTS_API_URL`; `127.0.0.1:8589` locally). Browsers,
apps and the CLI only ever use the public origin, so cookies, the CSRF `Origin` guard, provider
callbacks (Apple's `form_post` too) and redirects all stay on one origin; `Set-Cookie` and
absolute `Location` headers pass through the proxy unchanged. Behind it, run `accounts-api` with
`ACCOUNTS_TRUST_FORWARDED_FOR=true`: the client address is the right-most `X-Forwarded-For`
entry. Next.js forwards that header as it arrives and adds none, so in production the load
balancer in front of the site must append the client address (an ALB does); without one every
request counts as the site's own address. Server-to-server callers may call either origin.

The developer platform (Next.js, `developer/`; `ACCOUNTS_DEVELOPER_URL`,
`https://developers.teamofsilicons.com`; `http://localhost:8600` locally) is a separate site in
front of the same API: its Next server signs Carbons in through the account site's hosted
pages as the first-party public client `developer` (PKCE S256, no secret; it may only return to
`{ACCOUNTS_DEVELOPER_URL}/auth/callback`) and calls `accounts-api` server to server with their
tokens. Those tokens (`aud = developer`) only read the signed-in Carbon (`GET /v1/me`,
`GET /v1/session`) and manage the apps they own (`GET /v1/me/owned-apps`, `/v1/apps/{app_id}/…`);
every other route answers 401 `token_wrong_audience`. At start-up `accounts-api` writes this
deployment's callback into the `developer` app's stored sign-in setup
(`first_party::sync_developer_app`; the rule itself is applied in code).

| binary | what it does |
|---|---|
| `accounts-api` | the HTTP API (listens on `ACCOUNTS_BIND_ADDR`, default `127.0.0.1:8589`) and, with `ACCOUNTS_WORKER_ENABLED=true`, the background work |
| `accounts-migrate` | applies the embedded migrations, printing every pending and applied version; `--check` only lists them (exit 3 when some are pending) |
| `accounts-seed` | `--fake-apps testkit/fake-apps.json [--force]`: loads the fake apps through `accounts_apps::seed_fake_apps` (the same upsert as `POST /v1/internal/apps/sync`) |

## Run it locally

One command brings up the whole stack (Postgres, migrations, the fake apps, the testkit's mock
Google/Apple and Postmark/Twilio, the fake app server, accounts-api wired to them on
`127.0.0.1:8589`, the Next.js site on `http://localhost:8590` in front of it, and the developer
platform from `developer/` on `http://localhost:8600` when it has its Next.js app):

```bash
scripts/dev.sh               # foreground, Ctrl-C stops everything; --detach + scripts/stop.sh otherwise
scripts/dev.sh --prod        # the site as a production build (pnpm -C web build, then start)
scripts/dev.sh --web=proxy   # scripts/dev-proxy.mjs instead of the site: /v1/* + /.well-known/* only
scripts/dev.sh --api-only    # no site: accounts-api's own origin is the public URL
scripts/journeys.sh          # the non-browser journeys against a fresh stack, API only
scripts/journeys.sh --proxy  # the same through scripts/dev-proxy.mjs (the site's rewrites, mimicked)
scripts/journeys.sh --next   # the same through the real Next.js site
```

`scripts/dev.sh --help` lists every flag (`--web=auto|next|proxy|external|none`,
`--developer=auto|on|off`, `--prod`, `--no-build`, `--release`, `--reseed`, `--reset-db`) and the
port/database overrides (the developer platform runs on `DEVELOPER_PORT`: 8600 next to the
default site, else the site's port + 5). Without a
Next.js app in `web/` (no `"next"` dependency in `web/package.json`) it warns and serves the API
only. By hand:

```bash
scripts/dev-db.sh                                   # Postgres on 127.0.0.1:5444
cargo run -p silicon-accounts-server --bin accounts-migrate
cargo run -p silicon-accounts-server --bin accounts-seed -- --fake-apps testkit/fake-apps.json
ACCOUNTS_EXPOSE_DEV_OUTBOX=true ACCOUNTS_TRUST_FORWARDED_FOR=true \
  cargo run -p silicon-accounts-server --bin accounts-api   # 127.0.0.1:8589
PORT=8590 ACCOUNTS_API_URL=http://127.0.0.1:8589 pnpm -C web dev   # the site: http://localhost:8590
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
| `GET /v1/meta` | name, version, environment, public URL, Silicon Apps URL, docs URL (`docs_url`, ACCOUNTS_DOCS_URL, default `https://developers.teamofsilicons.com/docs/accounts`), developer platform (`developer_url`, ACCOUNTS_DEVELOPER_URL, default `https://developers.teamofsilicons.com`, `http://localhost:8600` outside production), managed providers, delivery mode |
| `POST /v1/reports` | bug report (optional session; 5/hour per IP; message 1..10000 chars; `pr_url` https; `Idempotency-Key`) mailed to every `ACCOUNTS_REPORT_RECIPIENTS` address → `201 {"report_id","status":"queued","recipients":3}` |
| `POST /v1/telemetry/events` | ≤ 50 events named `^[a-z0-9_.]{1,64}$` (the CLI sends `cli.command` / `cli.step`), forwarded to Space Station unless the caller opted out (`X-Accounts-Telemetry: off` or the cookie `sa_telemetry=off`) → `202 {"accepted","forwarded"}` |
| `GET /v1/dev/outbox?to=&purpose=&limit=` | recorded messages with the parsed OTP `code`; only with `ACCOUNTS_EXPOSE_DEV_OUTBOX=true` outside production (production answers like an unknown route) |
| `GET /embed/v1/buttons?app_id=…` | legacy static hosting only (`ACCOUNTS_WEB_DIST`): the iframe page with `frame-ancestors 'self' <app allowed_origins>` (`'none'` for unknown/disabled apps or no origins). The Next.js site serves its own embed page and builds `frame-ancestors` from `GET /v1/apps/{app_id}/public` `allowed_origins` |
| `GET /sdk/v1.js` | legacy static hosting only: the SDK, CORS `*`, `Cache-Control: public, max-age=300` (the Next.js site serves its own) |
| anything else | unknown API paths (`/v1`, `/.well-known`, `/embed`, `/sdk`, `/healthz`, `/readyz`) → `404 route_not_found` JSON; other GET/HEAD → a static single-page site (`index.html`, `no-store`) when `ACCOUNTS_WEB_DIST` is set, else 404 |

## Middleware (outermost first)

1. **Request id** (core): `X-Request-Id` taken when sane, generated otherwise, on every response.
2. **Linger**: reads and throws away whatever request body the layers below answered without
   reading to its end (the 413 for a declared `Content-Length` over the limit, a 401 or 429 on an
   upload, a streamed body past the limit), so a client or proxy that is still uploading reads the
   answer instead of a reset connection. Without it, a 2 MB + 1 byte photo or a 51 MB import sent
   through the account site's `/v1` rewrite got a bare `500` from the site (its proxy hit EPIPE
   mid-upload), and direct clients got `ECONNRESET`. Without `Expect: 100-continue` the rest of
   the body is read first and the answer follows (the connection stays usable when the whole
   body came). With `Expect: 100-continue` and a body nobody asked for, the answer goes out at
   once (no `100 Continue`, so a waiting client never sends the body) and ends once the client
   stopped sending (2 s without a first byte; a proxy that streams anyway is read to the end).
   Bounded: at most 64 MB read, whatever the declared length (the site's rewrite forwards at
   most 52 MB of any body under the original `Content-Length`, and must still get the 413), the
   route's time budget, 5 s without data; past those, and after a time-budget 503, the answer
   carries `Connection: close`. HTTP/1 only (HTTP/2 resets an unread stream on its own).
3. **Observe**: one log line per request inside a span carrying the request id; a Space Station
   `http.request` event (source `api`, step `"{METHOD} {route template}"`, progress 1.0; route
   template, method, status, duration — never raw paths or query strings). Health probes and
   static files are skipped. A request that opted out (`X-Accounts-Telemetry: off`, or the
   account site's cookie `sa_telemetry=off`) runs inside core's
   `telemetry::with_request_opt_out`: neither this event nor any event its handler records is
   sent.
4. **Policy**: `X-Content-Type-Options: nosniff`, `Referrer-Policy`, HSTS when cookies are secure;
   HTML gets the site CSP (`frame-ancestors 'none'`) + `X-Frame-Options: DENY`; JSON gets
   `default-src 'none'` and, under `/v1`, `Cache-Control: no-store` unless the handler set one.
   CORS `*` only for `/v1/apps/{app_id}/public`, `/sdk/*`, `/.well-known/*` (preflights answered
   here); every other response leaves without CORS headers. Plain-text 4xx/5xx (axum's 405,
   framework rejections) are rewritten into `{"error":{"code","message","hint"}}`.
5. **Limits**: body limits by route — 64 KB default, 2 MB for the photo uploads
   (`POST /v1/me/photo`, `/v1/me/silicons/{uuid}/photo`, `/v1/flows/{id}/signup/photo`), 50 MB
   (+64 KB envelope) `POST /v1/apps/{app_id}/imports`, 5 MB `POST /v1/internal/apps/sync`,
   512 KB `PATCH /v1/apps/{app_id}/signin-config` (two inline logos of up to 128 KB) —
   enforced on `Content-Length` and on the body stream (`413 payload_too_large`); time budgets
   30 s / 60 s (photo, sync) / 5 min (imports) → `503 request_timeout`.
6. **Panic recovery**: a panicking handler becomes `500 internal` with `details.request_id`.

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
Nothing a request records is sent when that request opted out (header or cookie, see
Middleware); background work keeps reporting.

## Tests

```bash
CARGO_TARGET_DIR=target/server cargo test -p silicon-accounts-server   # needs scripts/dev-db.sh
```

Driven in-process through `build_router` (tower `oneshot`) against a throwaway database:
endpoints, security headers, CORS, the SPA/static/embed/SDK serving, every body-limit class
(64 KB, 2 MB photos — all three routes, 512 KB sign-in config, 5 MB sync, 50 MB imports —
declared and streamed), every time budget, RFC 6749 errors on the OAuth endpoints, panics,
background start/stop, the telemetry opt-out covering handler events, and a custodian's Silicon
photo plus the history entries that name the Silicon.

`tests/early_answers.rs` serves the router on a real socket and talks raw HTTP/1.1 to it, the way
a proxy does: a declared body over the limit (2 MB + 1 byte, 4 MB and 8 MB photos, a 51 MB
import), `Expect: 100-continue` from a client that waits (the 413 comes without `100 Continue`)
and from a proxy that streams the body anyway, a 401 on an upload, and a chunked photo past
2 MB. Each upload must go out in full and its answer must be read; without the linger layer
every one of them fails with ECONNRESET or EPIPE.
