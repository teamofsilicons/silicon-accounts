# Silicon Accounts testkit

Local stand-ins for everything Silicon Accounts talks to, so the whole service can be developed and
tested end to end on one machine, without real Google, Apple, Postmark, Twilio, Iris or Silicon Apps:

| piece | port | what it is |
|---|---|---|
| **mock-oidc** | 8591 | "Sign in with Google" under `/google` and "Sign in with Apple" under `/apple` — authorize pages, token endpoints, JWKS — strict where the real providers are strict |
| **mock-messaging** | 8592 | the Postmark Email API under `/postmark` and the Twilio Messages API under `/twilio`; captures every message and extracts the 6-digit code |
| **fake app server** | 8593 | the server side of the 15 fake apps (`/briefcase/…`, `/dm/…`, …): sign-in pages, OAuth callbacks, webhook receivers, User verification/App verification proof demos |
| **mock-iris** | 8594 | Iris, which draws every account's default profile photo: `/pfp/carbon?id=<uuid>` and `/pfp/silicon?id=<uuid>` answer a small SVG that depends only on the id (`ACCOUNTS_IRIS_BASE_URL`), so no page loads a photo from the internet |
| **fake-apps.json** | — | the 15 fake apps "as Silicon Apps would deliver them": fixed app ids and secrets, owners, logos, sign-in setups |
| **fixtures/imports/** | — | CSV/JSON files for the user import flow, with the expected outcome of every row |
| **lib/** | — | a TypeScript helper library for the e2e suites (sign-in flows over HTTP, OTP codes, webhooks, PKCE, signatures) |
| **journeys/** | — | non-browser walks through the whole product against a running stack, with the helpers and the real `accounts` CLI (`scripts/journeys.sh`) |

Everything is TypeScript run with `tsx` on Node ≥ 24, state is in memory, and nothing needs Docker.

## Quick start

`scripts/dev.sh` at the repo root starts everything (Postgres, migrations, the seeded fake apps, this
testkit, accounts-api pointed at it on `127.0.0.1:8589`, and the account site on
`http://localhost:8590` in front of it — or `scripts/dev-proxy.mjs` with `--web=proxy`). To run the
pieces yourself:

```sh
pnpm -C testkit install
pnpm -C testkit start            # mock-oidc :8591, mock-messaging :8592, fake apps :8593, mock-iris :8594 (Ctrl-C stops all four)
```

In another terminal, point Silicon Accounts at the mocks and seed the fake apps:

```sh
pnpm -s -C testkit accounts-env >> .env      # or: eval "$(pnpm -s -C testkit accounts-env --format shell)"
cargo run -p silicon-accounts-server --bin accounts-seed -- --fake-apps testkit/fake-apps.json
cargo run -p silicon-accounts-server --bin accounts-api        # 127.0.0.1:8589
PORT=8590 ACCOUNTS_API_URL=http://127.0.0.1:8589 pnpm -C web dev   # the site (or: node scripts/dev-proxy.mjs --port 8590 --target http://127.0.0.1:8589)
open http://127.0.0.1:8593/                  # the fake apps; sign in to any of them
```

Run the testkit's own tests: `pnpm -C testkit test` (98 node:test tests, ~1 s) and `pnpm -C testkit typecheck`.

## Commands

| command | does |
|---|---|
| `pnpm -C testkit start` (alias `mocks`) | starts all four servers on their default ports until SIGINT/SIGTERM, then stops them gracefully. Flags: `--host` (`TESTKIT_HOST`), `--oidc-port` (`MOCK_OIDC_PORT`), `--messaging-port` (`MOCK_MESSAGING_PORT`), `--fake-apps-port` (`FAKE_APPS_PORT`), `--iris-port` (`MOCK_IRIS_PORT`), `--accounts-url` (`ACCOUNTS_URL`, default accounts-api at `http://127.0.0.1:8589`; the public site works too), `--ready-file <path>` (writes the URLs as JSON once listening), `--log` (`TESTKIT_LOG=1`, one line per request on stderr), `--quiet`. Port `0` picks a free port. Always prints one line `testkit ready {"oidc":…,"messaging":…,"fake_apps":…,"iris":…}` when listening. |
| `pnpm -s -C testkit accounts-env [--format dotenv\|shell\|json] [--oidc-url URL] [--messaging-url URL] [--iris-url URL] [--api-port N] [--public-url URL] [--no-topology]` | prints the `ACCOUNTS_*` variables that point Silicon Accounts at the mocks (below) and the local topology: `ACCOUNTS_BIND_ADDR=127.0.0.1:8589` (`--api-port`, `ACCOUNTS_API_PORT`), `ACCOUNTS_PUBLIC_URL=http://localhost:8590` (the site; `--public-url`, `ACCOUNTS_PUBLIC_URL`), `ACCOUNTS_TRUST_FORWARDED_FOR=true`; `--no-topology` leaves those three out |
| `pnpm -C testkit test` | all unit/integration tests |
| `pnpm -C testkit journeys [name…]` | the journeys against a running stack (default ports = `scripts/dev.sh`); `scripts/journeys.sh` starts a fresh isolated stack, runs them and tears it down |
| `pnpm -C testkit typecheck` | `tsc --noEmit` (strict) |
| `pnpm -C testkit check:generated` | fails when `fake-apps.json` or the import fixtures are stale |
| `pnpm -C testkit gen:apps` | regenerates `fake-apps.json` from `src/fake-apps/definitions.ts` |
| `pnpm -C testkit gen:fixtures` | regenerates `fixtures/imports/*` (+ `expected.json`, fixture README) from `scripts/build-import-fixtures.ts` |
| `pnpm -C testkit gen:big [--rows N] [--seed N] [--tag T] [--phone-ratio R] [--out path]` | writes `fixtures/imports/big.csv` (100,000 rows by default, ~10 MB, git-ignored) |
| `pnpm -C testkit gen:credentials [--force]` | (re)generates `dev-credentials.json`; after `--force` run `gen:apps` |

## Pointing Silicon Accounts at the mocks

`pnpm -s -C testkit accounts-env` prints exactly these values (from `dev-credentials.json`; ports follow
`MOCK_OIDC_PORT` / `MOCK_MESSAGING_PORT` / `MOCK_IRIS_PORT` or `--oidc-url` / `--messaging-url` / `--iris-url`):

| variable | value |
|---|---|
| `ACCOUNTS_DELIVERY` | `providers` (send through the "real" APIs, i.e. the mocks) |
| `ACCOUNTS_POSTMARK_API_URL` | `http://127.0.0.1:8592/postmark` (Accounts POSTs `{url}/email`) |
| `ACCOUNTS_POSTMARK_SERVER_TOKEN` | `messaging.postmark.server_token` |
| `ACCOUNTS_POSTMARK_FROM` | `accounts@teamofsilicons.com` (the only sender signature the mock accepts) |
| `ACCOUNTS_TWILIO_API_URL` | `http://127.0.0.1:8592/twilio` (Accounts POSTs `{url}/2010-04-01/Accounts/{sid}/Messages.json`) |
| `ACCOUNTS_TWILIO_ACCOUNT_SID` / `_AUTH_TOKEN` | `messaging.twilio.account_sid` / `auth_token` |
| `ACCOUNTS_TWILIO_MESSAGING_SERVICE_SID` / `_FROM` | `messaging.twilio.messaging_service_sid` / `+15005550006` |
| `ACCOUNTS_GOOGLE_CLIENT_ID` / `_CLIENT_SECRET` | `managed.google.client_id` / `client_secret` (the managed, "one click" client) |
| `ACCOUNTS_GOOGLE_AUTH_URL` | `http://127.0.0.1:8591/google/authorize` |
| `ACCOUNTS_GOOGLE_TOKEN_URL` | `http://127.0.0.1:8591/google/token` |
| `ACCOUNTS_GOOGLE_JWKS_URL` | `http://127.0.0.1:8591/google/jwks` |
| `ACCOUNTS_GOOGLE_ISSUERS` | `http://127.0.0.1:8591/google` (the `iss` of every mock Google id_token) |
| `ACCOUNTS_APPLE_SERVICES_ID` / `_TEAM_ID` / `_KEY_ID` | `managed.apple.services_id` (`com.teamofsilicons.accounts.dev`) / `team_id` / `key_id` |
| `ACCOUNTS_APPLE_PRIVATE_KEY` | `managed.apple.private_key_pem` — the p8 key, PKCS#8 PEM **with real newlines** (the dotenv output escapes them as `\n` inside double quotes, which dotenvy expands) |
| `ACCOUNTS_APPLE_AUTH_URL` | `http://127.0.0.1:8591/apple/authorize` |
| `ACCOUNTS_APPLE_TOKEN_URL` | `http://127.0.0.1:8591/apple/token` |
| `ACCOUNTS_APPLE_JWKS_URL` | `http://127.0.0.1:8591/apple/jwks` |
| `ACCOUNTS_APPLE_ISSUER` | `http://127.0.0.1:8591/apple` (both the id_token `iss` and the `aud` Accounts must put in its client_secret JWT) |
| `ACCOUNTS_IRIS_BASE_URL` | `http://127.0.0.1:8594` (mock-iris; production keeps `https://iris.teamofsilicons.com`. The account site needs the same value: its CSP allows a loopback http Iris origin, see `web/proxy.ts`) |
| `ACCOUNTS_WEBHOOK_ALLOW_PRIVATE` | `true` (webhooks go to the fake app server on 127.0.0.1) |

Programmatically: `accountsEnvForMocks({ oidcUrl, messagingUrl })` and
`accountsTopologyEnv({ apiPort, publicUrl })` from `lib/env.ts`, or `startTestkit()` which returns
`accountsEnv` (the mocks) for the ports it actually bound.

## dev-credentials.json

Generated once by `scripts/generate-dev-credentials.ts` and committed. **Development only** — nothing
but the testkit accepts these values; never use them in production. Google clients and Twilio account IDs use explicit mock prefixes so committed fixtures cannot be mistaken for live credentials.

| key | contents |
|---|---|
| `managed.google` | `client_id` (`mock-google-….invalid`), `client_secret` (`mock-google-…`) |
| `managed.apple` | `services_id`, `team_id`, `key_id`, `private_key_pem` (p8, EC P-256), `public_key_pem` |
| `byo['acme-notes'].google` | acme-notes' own Google client (bring your own) — also embedded in `fake-apps.json` |
| `byo['orbit-games'].apple` | orbit-games' own Apple Services ID + p8 key — also embedded in `fake-apps.json` |
| `messaging.postmark` | `server_token`, `from`, `message_stream` |
| `messaging.twilio` | `account_sid`, `auth_token`, `messaging_service_sid`, `from` |
| `mock_oidc_signing_keys` | the mock providers' RS256 id_token keys (stable `kid` across restarts) |

`startTestkit()` / `pnpm start` register the managed clients and both bring-your-own clients in
mock-oidc, and configure mock-messaging with the Postmark/Twilio credentials.

## mock-oidc (port 8591)

Issuers: `http://127.0.0.1:8591/google` and `http://127.0.0.1:8591/apple`
(`{base}/{provider}`; when started elsewhere the issuer follows the base URL).

| endpoint | behaviour |
|---|---|
| `GET /{p}/authorize` | Validates `client_id` (registered for that provider), `redirect_uri` (absolute http(s), no fragment, exact match when the client was registered with `redirect_uris`), `response_type=code`, scopes (Google: `openid email profile`; Apple: `name email`), `state`, `nonce`, and for Google PKCE `S256`. Problems before the redirect is trusted render an HTML error page `<main id="error" data-error="…">` with the reason (never a redirect). Then either picks an identity or shows the chooser. Google answers `302 redirect_uri?code&state&scope&authuser=0[&hd]`; Apple answers with an auto-submitting `<form method=post id="apple-form-post">` (form_post) carrying `code`, `state` and — on that identity's first authorization of that client only — `user={"name":{"firstName","lastName"},"email"}`. Codes look real (Google codes start with `4/`, so the callback must URL-decode). |
| `POST /{p}/token` | `application/x-www-form-urlencoded`. **Google**: client_id + client_secret (form or HTTP Basic, not both), code, redirect_uri (must equal), code_verifier (S256 check). **Apple**: `client_secret` must be an ES256 JWT — header `kid` = registered key id, signature verified with the registered p8 public key, `iss` = team_id, `sub` = client_id (Services ID), `aud` = the mock's Apple issuer, `exp` in the future, lifetime ≤ 6 months; HTTP Basic is refused. Returns `{access_token, id_token, token_type, expires_in}` (+ `refresh_token` for Apple). The id_token is RS256 with `iss`, `aud` = client_id, `sub`, `email`, `email_verified` (Apple: the string `"true"`), `is_private_email` (Apple, string), `name`/`given_name`/`family_name`/`picture` (Google, with the `profile` scope), `hd` (Google Workspace identities), `nonce`, `at_hash`, `iat`, `exp`. Errors are RFC 6749 JSON with a precise `error_description` (`invalid_client` 401 Google / 400 Apple, `invalid_grant`, `redirect_uri_mismatch`, `invalid_request`, `unsupported_grant_type`). |
| `GET /{p}/jwks` | the RS256 public JWK(s) |
| `GET /{p}/.well-known/openid-configuration` | discovery document |
| `GET /google/userinfo`, `POST /{p}/revoke` | for completeness |
| aliases | `/google/o/oauth2/v2/auth`, `/google/oauth2/v3/certs`, `/apple/auth/{authorize,token,keys,revoke}` |

Choosing who signs in (first match wins): a queued `POST /_next` selection → `_auto=<email>` on the
authorize URL (creates the identity if unknown; `_name=` sets its name) → `login_hint` matching an
identity's email or sub → otherwise the chooser page (`<main id="chooser" data-client-name="…">`, one
`<button data-email="…">` per identity, a Cancel button `data-action="cancel"`, and a "Use another
account" form). `prompt=none` with nobody chosen answers `error=login_required`. `_error=<code>` answers
with that error (`access_denied` becomes Apple's `user_cancelled_authorize`). Bring-your-own clients show
their own name and logo on the chooser ("to continue to Acme Notes").

Test controls (JSON): `POST|GET|DELETE /_identities` (`{provider, email, sub?, email_verified?, name?,
given_name?, family_name?, picture?, is_private_email?, hd?}`; re-registering a sub resets its "first
authorization"), `POST|GET|DELETE /_clients` (`{provider, client_id, client_secret}` or `{provider,
client_id, team_id, key_id, public_key_pem | private_key_pem}`, optional `redirect_uris`,
`display_name`, `logo_url`, `label`), `POST|GET|DELETE /_next`, `GET|DELETE /_requests`
(`?provider=&endpoint=&client_id=&outcome=`, newest first — each entry has `client_id`, `client_label`,
`auth_method`, `identity`, `selected_by`, sanitized params, and for Apple the presented client_secret's
`kid/iss/sub/aud`), `POST|GET|DELETE /_faults` (`{endpoint: authorize|token|jwks|userinfo, provider?,
count?, status?, error?, error_description?, delay_ms?, id_token?: {claims?, remove_claims?, expired?,
sign_with?: "unknown_key"|"none"}}` — error answers, delays, or tampered id_tokens to test Accounts'
validation), `POST /_keys/rotate {provider, keep_previous?}`, `POST /_reset`.

Default identities (for manual use; e2e tests should register random ones):

| provider | email | notes |
|---|---|---|
| google | ada.lovelace@example.test | name, picture |
| google | grace.hopper@university.test | `hd=university.test` (campus-connect) |
| google | alan.turing@example.test | |
| google | unverified.person@example.test | `email_verified=false` — Accounts must refuse it |
| apple | katherine.johnson@example.test | |
| apple | q7x2m9k4p1@privaterelay.appleid.com | private relay (`is_private_email="true"`) |
| apple | grace.hopper@university.test | same email as a Google identity (identity linking) |

## mock-messaging (port 8592)

| endpoint | behaviour |
|---|---|
| `POST /postmark/email` (and `/postmark/email/batch`) | `X-Postmark-Server-Token` must equal the configured token, else `401 {"ErrorCode":10}`. Body `From`, `To` (comma list allowed), `Subject`, `TextBody`, `HtmlBody`, `MessageStream` (`outbound`). `From` must be `accounts@teamofsilicons.com` (sender signature) else `422 {"ErrorCode":400}`; missing recipients/body → `422 ErrorCode 300`; bad JSON → `422 ErrorCode 402`. Success: `{"To","SubmittedAt","MessageID","ErrorCode":0,"Message":"OK"}`. |
| `POST /twilio/2010-04-01/Accounts/{sid}/Messages.json` | form body, HTTP Basic `AccountSid:AuthToken` else `401 {"code":20003}`; unknown account SID → 404 `20404`; `To` missing → 21604, not E.164 → 21211; `Body` missing → 21602; neither `MessagingServiceSid` nor `From` → 21603; unknown service → 21701; unknown From → 21606. Success: `201` Twilio Message resource with `sid: "SM…"`. |
| `GET /_messages?to=&channel=email\|sms\|phone&since=&after=&contains=&subject=&limit=` | `{items, count, last_seq}`, **newest first**; each item has `channel`, `provider`, `to`, `recipients`, `from`, `subject`, `text`, `html`, `code` (first 6-digit code), `codes`, `links`, `seq`, `received_at` |
| `GET /_messages/latest?…` | the newest match or 404 |
| `GET /_messages/wait?to=&channel=&after=<seq>&timeout_ms=` | long-poll: the first match (with `seq > after`) as soon as it arrives, `408` with a hint on timeout |
| `DELETE /_messages[?to=]`, `GET|DELETE /_requests` | clear; every provider call incl. rejected and faulted ones (newest first) |
| `POST /_faults` | `{count (or fail_next / n), status=500, channel=email\|sms\|any, delay_ms?, drop?, message?}` — the next N sends fail with that status (Postmark/Twilio-shaped bodies; 429 adds `Retry-After`), wait, or have their connection dropped |
| `POST /_reset` | clear messages, requests and faults |

Faulted sends are not captured as messages. Codes are extracted from the subject, text and (tag-stripped)
HTML: the first run of exactly six digits; `123 456` style only when no plain code exists.

## The fake apps (fake-apps.json)

An object with the same shape as the `POST /v1/internal/apps/sync` body —
`{"_comment","version","fake_app_server":"http://127.0.0.1:8593","apps":[SiliconAppsApp…]}` — generated
from `src/fake-apps/definitions.ts` (`pnpm -C testkit gen:apps`; never edit the JSON by hand). Each app
is a `SiliconAppsApp` (`app_id, name, description, logo_url, logo_dark_url, homepage_url, owner_id,
owner_email, secret, status, created_at, signin_defaults`) plus three testkit extras the seeder may ignore:

- `webhook_url` — `http://127.0.0.1:8593/<app_id>/webhooks` (null for spacestation and quill-docs, to cover apps without a webhook),
- `webhook_secret` — a fixed `whsec_…` the fake app server verifies with from the start (if the seeder configures the webhook with it, deliveries verify out of the box; otherwise tests call `POST /<app>/_connect-webhook`),
- `testkit` — category, purpose, exercised behaviours, the main integration, default sign-in link params, proof roles, accent colour.

`signin_defaults` is a partial SigninConfig. For bring-your-own providers it carries the secrets the way
`PATCH /v1/apps/{app_id}/signin-config` takes them: `google.client_secret` (acme-notes) and
`apple.private_key` (orbit-games). All redirect URIs are `http://127.0.0.1:8593/<app_id>/callback`
(Accounts matches loopback redirect URIs ignoring the port, so the fake app server may run on any port
on 127.0.0.1) and `allowed_origins` is `["http://127.0.0.1:8593"]`. Secrets are
`sa_app_<app_id>_<40 alphanumerics>`. Logos are hand-drawn inline SVG data URIs (light + dark).

| app | owner | sign-in | exercises |
|---|---|---|---|
| `briefcase` | c:saket | Google, Apple (managed), email, phone | required email; default branding (screenshot baseline); webhooks; User verification receiver; Silicon SLT |
| `dm` | c:shubham | phone, email | required phone (added on its details page); one custom-titled flow step ("Set up DM") with optional email + timezone; User verification issuer → briefcase |
| `commit` | c:saket | Google, email | App verification issuer → remind and waveform (one proof per app); continue-as across apps |
| `waveform` | c:shubham | Apple, Google | no codes; profile-only required; App verification receiver |
| `remind` | c:saket | email | required timezone; Silicon SLT; App verification receiver |
| `browser` | c:shubham | email, Google | Silicon-heavy (SLT), custodian webhooks |
| `spacestation` | c:saket | email | optional timezone; `remember_browser: false`; no webhook |
| `interface` | c:shubham | all four | `remember_browser`, links use `prompt=select_account`; optional email/phone/timezone toggles |
| `acme-notes` | c:acme-dev | Google (BYO), email | dark theme, Fraunces headings, radius 28, split layout, grain, logo |
| `pixel-studio` | c:pixel-dev | email, Google, Apple | pink primary, sharp corners, outline buttons, Space Grotesk, minimal layout, dots |
| `ledgerly` | c:ledgerly-dev | email, phone, Google | required phone + dob, optional timezone, sign-up allowed; a two-step flow (`contact` → `about-you`, split layout) with a review page; sign-up copy |
| `campus-connect` | c:campus-it | Google (`hosted_domain`), email | `allowed_email_domains: ["university.test"]` |
| `legacy-crm` | c:crm-dev | email, phone | import target; `allow_signup: false` |
| `orbit-games` | c:orbit-dev | Apple (BYO) | iframe embed via allowed origins; compact density |
| `quill-docs` | c:quill-dev | email, Google | SDK snippet; OIDC (`scope=openid email`, nonce, id_token); optional email; no webhook |

Owner emails: c:saket `saketdev12@example.test`, c:shubham `shubhastro2@example.test`, c:acme-dev
`dev@acme-notes.test`, c:pixel-dev `dev@pixel-studio.test`, c:ledgerly-dev `dev@ledgerly.test`,
c:campus-it `it@university.test`, c:crm-dev `dev@legacy-crm.test`, c:orbit-dev `dev@orbit-games.test`,
c:quill-dev `dev@quill-docs.test`. Every palette passes WCAG AA (≥ 4.5:1) for primary/foreground pairs,
well above the server's 3:1 floor.

## mock-iris (port 8594)

| endpoint | does |
|---|---|
| `GET /pfp/carbon?id=<uuid>` | a Carbon's default photo: a 96×96 SVG of woven straps, colours from a hash of the id (the sign-up page asks for `id=new`) |
| `GET /pfp/silicon?id=<uuid>` | a Silicon's default photo: a chip grid |
| `GET /_requests[?kind=carbon\|silicon]` | what was drawn, newest first: `{count, items:[{seq, at, kind, id, referer}]}` (the last 200) |
| `DELETE /_requests` | forget them |

Answers carry `Access-Control-Allow-Origin: *` and `Cross-Origin-Resource-Policy: cross-origin`, and a day of
caching. `irisSvg(kind, id)` (`src/mock-iris.ts`) gives the same SVG in code.

## fake app server (port 8593)

One server hosts every app by path prefix. It calls Silicon Accounts server-to-server at `ACCOUNTS_URL`
(default accounts-api at `http://127.0.0.1:8589`; the public site, which proxies `/v1/*`, works too) and builds browser links with `ACCOUNTS_PUBLIC_URL`, else `/v1/meta`'s
`public_url`, else `ACCOUNTS_URL`. Its own base is `FAKE_APPS_PUBLIC_URL` or the address it listens on.
Each app keeps a session cookie `fakeapp_sid` scoped to `Path=/<app_id>`, so apps on the one origin
behave like separate sites.

| route | does |
|---|---|
| `GET /<app>/` | the app page: `#signin-hosted` link (hosted pages), the app's own buttons `#signup-hosted` (`intent=signup`) and `#continue-{google\|apple\|email\|phone}` (`method=…`, the methods the app turned on, in its order; each its own sign-in), `<iframe id="signin-iframe" src="…/embed/v1/buttons?…">`, and the SDK snippet (`<div id="silicon-accounts">` + `<script src="…/sdk/v1.js" data-app-id data-redirect-uri data-target data-state data-code-challenge data-code-challenge-method [data-scope data-nonce data-prompt data-intent data-method data-theme]>`). Each integration gets its own state + PKCE (S256) + nonce bound to the session. Query params pass through or tweak the request: `prompt`, `scope`, `intent=signin\|signup`, `method=google\|apple\|email\|phone` (a direct button), `theme`, `nonce=0`, `pkce=S256\|plain\|none`, `redirect_uri=` (e.g. an unregistered one), `only=hosted\|iframe\|sdk`, `tamper=verifier\|redirect_uri\|secret` (makes the code exchange fail on purpose). When signed in it shows `#signed-in-as`. |
| `GET /<app>/callback?code&state` | state must be one this server issued **to this browser session** (`state_session_mismatch` otherwise — login CSRF), single use; exchanges the code at `POST /v1/oauth/token` with client_secret_basic + the PKCE verifier; verifies an id_token (EdDSA via `/.well-known/jwks.json`, issuer from discovery, `aud` = app id, nonce). Renders `Signed in as <id>` with the AccountForApp JSON in `<pre id="account">`, token metadata in `<pre id="token">`, the id_token claims in `<pre id="id-token">` (`#id-token-status[data-verified]`). Errors (`error=access_denied`, token endpoint errors…) render `<main id="fake-app-error" data-error>` with `<pre id="error">{status, code, message, stage, …}`. `?format=json` (or `Accept: application/json`) answers JSON instead. An unknown state with a code gets a small page that looks for the SDK's state in `sessionStorage` (any JSON value with a matching `state` and `code_verifier`/`codeVerifier`/`verifier`) and finishes via `POST /<app>/callback/client`. |
| `GET /<app>/authorize-url` | for HTTP-only tests: creates a pending sign-in for the caller's cookie and returns `{authorize_url, embed_url, state, code_verifier, code_challenge, nonce, redirect_uri}` |
| `GET /<app>/signed-in`, `GET /<app>/me`, `POST /<app>/logout` | the signed-in page / JSON; logout revokes the refresh token at `/v1/oauth/revoke` |
| `POST /<app>/slt-login {slt}` | a Silicon's short-lived token → `grant_type=urn:silicon:params:oauth:grant-type:slt`; returns the account view (`?include_tokens=1` adds tokens) or the Accounts error with its status |
| `POST /<app>/refresh {uuid, reuse_previous?}` | refreshes (rotation); `reuse_previous: true` replays the already-used refresh token to test reuse detection |
| `GET /<app>/userinfo?uuid=` | `GET /v1/userinfo` with the stored access token |
| `POST /<app>/webhooks` | verifies `X-Accounts-Signature: v1=<hex HMAC-SHA256(secret, "{timestamp}.{raw body}")>` against the current secret (and a kept previous one), `X-Accounts-Timestamp` within ±300 s, body JSON, header/body `event_id` + `type` agreement and `app_id`; dedupes by `event_id` (answers 200, counts the duplicate). Refusals are 401/400 with `{error:{code,message}}` and are logged. |
| `POST /<app>/_webhook-secret {secret, keep_previous?}` | registers the secret Accounts returned from `PUT /v1/apps/{app}/webhook`. Deliveries refused earlier for a wrong/unknown secret are re-verified (as of when they arrived) and recovered into the event list (`recovered: true`); the answer says how many (`{recovered: n}`). A later retry of the same event counts as a duplicate. |
| `POST /<app>/_connect-webhook {url?}` | the app registers its own webhook at Accounts (with its credentials) and keeps the new secret |
| `POST /<app>/_webhook-faults {fail_next, status=500, delay_ms?}` | the next N deliveries fail (before verification) |
| `GET /<app>/_events?type=&uuid=&after=&include_rejected=1`, `GET /<app>/_events/wait?…&timeout_ms=`, `DELETE /<app>/_events` | received events (newest first, each with `payload`, `deliveries`, `duplicate_count`, `seq`), long-poll, clear |
| `GET /<app>/_state[?include_tokens=1]`, `DELETE /<app>/_state`, `DELETE /_state` | everything the app holds: accounts (+tokens), callbacks (with errors), webhook stats, files, pings, proof checks |
| `POST /<app>/_replay-last-code` | re-exchanges the last code (expect `invalid_grant`) |
| `POST /hooks/<key>` (+ `/hooks/<key>/_webhook-secret`, `/_webhook-faults`, `/_events`, `/_events/wait`; `GET\|DELETE /hooks`) | **generic webhook sinks** with the same verification, dedupe, faults and recovery — for webhooks that are not an app's, e.g. a Silicon's own webhook: create the Silicon with `webhook_url = <fake apps>/hooks/<key>`, then register the `webhook_secret` from the create response; `silicon.created` (sent before the secret was known) is recovered at that moment. `uuid=` filters match `data.uuid` or the top-level `silicon`. Keys: 1-100 of `[A-Za-z0-9._:-]`. |
| `POST /dm/actions/save-to-briefcase {uuid, filename, scopes?, access_ttl_seconds?}` | **User verification demo**: dm uses the stored access token of `uuid` as `subject_token` for `POST /v1/proofs/user-verification` (receiving_app briefcase), then calls `POST /briefcase/api/files` with `Authorization: Proof <proof_token>`; briefcase verifies with its own credentials at `/v1/proofs/verify`. Returns `200 {ok, file, proof (no tokens), verification, timings: {issue_ms, verify_ms, call_ms, total_ms}}` (502 with `stage` when issuing or verifying failed) |
| `POST /commit/actions/notify {message?, audiences?, access_ttl_seconds?}` | **App verification demo**: an app verification proof is for exactly one app, so commit gets one proof for remind and another for waveform (in parallel), then `POST /remind/api/ping` and `/waveform/api/ping`, each with its own proof and verifying it. Returns `200 {ok, proofs: {remind, waveform}, results: {remind, waveform}, timings: {issue_ms: {…}, verify_ms: {…}, total_ms}}` |
| `POST /<app>/api/files`, `POST /<app>/api/ping` | proof-protected endpoints (any app); invalid proofs → 403 `invalid_proof` with the verification |
| `POST /<app>/api/verify-proof {proof_token}` | verifies any proof with this app's credentials (e.g. "verified by the wrong app → `{valid:false, expires_at:null}`") |
| `POST /<app>/actions/issue-user_verification`, `POST /<app>/actions/issue-app_verification {receiving_app?}` | raw proof issuance with this app's credentials (includes tokens; for refresh/revoke tests); an app verification proof names one `receiving_app` |
| `GET /`, `GET /_apps`, `GET /_config`, `GET /_health` | index of apps, app list, resolved URLs, health |

Testing an iframe from a **disallowed origin**: open `http://localhost:8593/<app>/` — `localhost` and
`127.0.0.1` are different origins, so `frame-ancestors http://127.0.0.1:8593` blocks the embed there.

## Import fixtures

See [`fixtures/imports/README.md`](fixtures/imports/README.md) for every row of `clean.csv`,
`dirty.csv` (BOM, CRLF, and every messy case the spec lists), `dirty.json`, `unknown-columns.csv/.json`,
with the expected outcome, id and messages. The same expectations are machine-readable in
`fixtures/imports/expected.json` (`expectedImportOutcomes(file)`). `big.csv` (100k rows) comes from
`pnpm -C testkit gen:big`.

## The helper library (lib/)

Import from `@silicon-accounts/testkit` (add `"@silicon-accounts/testkit": "link:../testkit"` to the e2e
package and run under `tsx`) or directly from `testkit/lib/index.ts`. Everything is typed.

```ts
import {
  AccountsClient, MockMessagingClient, MockOidcClient, FakeAppsClient,
  signInWithCode, signInWithProvider, signUpCarbon, randomEmail, randomPhone,
  startTestkit, createPkcePair, verifyWebhookSignature, expectedImportOutcomes, measure,
} from '@silicon-accounts/testkit';

const accounts = new AccountsClient();           // $ACCOUNTS_URL or accounts-api at http://127.0.0.1:8589
const messaging = new MockMessagingClient();     // $MOCK_MESSAGING_URL or :8592
const oidc = new MockOidcClient();               // $MOCK_OIDC_URL or :8591
const fakeApps = new FakeAppsClient();           // $FAKE_APPS_URL or :8593

// A new Carbon signs in to briefcase with an email code, then briefcase exchanges the code.
const signIn = await signInWithCode({ accounts, messaging, appId: 'briefcase', email: randomEmail() });
const tokens = await accounts.app('briefcase').exchangeCode(signIn.code!, signIn.redirectUri, signIn.codeVerifier);

// Google through mock-oidc (managed client), Apple works the same way (form_post handled for you).
const g = await oidc.randomIdentity('google');
await signInWithProvider({ accounts, messaging, oidc, provider: 'google', identityEmail: g.email, appId: 'commit' });

// A Carbon signed in to the account site (cookie session with Origin header): /v1/me etc.
const { account, me } = await signUpCarbon({ accounts, messaging });

// Webhooks reaching a fake app.
const event = await fakeApps.waitForEvent('briefcase', { type: 'account.id_changed', uuid: tokens.account.uuid });

// A Silicon's own webhook: point it at a sink, then register the secret it was given.
const key = `scout-${Date.now()}`;
const created = await account.createSilicon({ id: `si:${key}`, display_name: 'Scout', webhook_url: fakeApps.hookUrl(key) });
await fakeApps.setHookSecret(key, created.webhook_secret!);
await fakeApps.waitForHookEvent(key, { type: 'silicon.created' });

// Latency of proof verification (p50/p95/p99).
const stats = await measure(1000, 1, () => accounts.app('briefcase').verifyProof(proofToken));
```

| module | main exports |
|---|---|
| `lib/accounts.ts` | `AccountsClient` (`waitUntilReady`, `meta`, `discovery`, `jwks`, `idAvailable`, `app(appId)`, `browser()`, `withToken(token)`, `siliconLogin`, `siliconSelfCreate`, `siliconRequestStatus`, `cliLoginStart/Verify`, `cliLogin`, `devOutbox`); `AppApi` (token grants, revoke, introspect, userinfo, User verification/App verification issue/refresh/verify/revoke, app details, sign-in config patch + history, users, imports incl. `startImportCsv/Json`, `waitForImport`, `allImportRows`, webhook set/rotate/test/deliveries/replay, lookups); `BrowserSession` (the hosted flow step by step: `createFlow` (with `intent`, `method`; apps never send a `login_hint`), `email`, `phone`, `resend`, `verify`, `signup`, `detailsAdd`, `detailsVerify`, `detailsContinue(id, share)`, `detailsBack`, `review(id, approve)`, `continueAs`, `switchAccount`, `oauthStart`, `deliverProviderCallback`, `session`, `signout`; sends `Origin` and keeps `sa_flow`/`sa_session`/`sa_signup` cookies); `AccountSession` (`/v1/me…`: profile, ids, emails, phones, apps, short-lived tokens, proofs, Silicons, custodian requests, history, owned apps, delete); `driveFlow` (signup → each details page: adds a missing required email/phone with a code, ticks `share` → review), `signInWithCode`, `signInWithProvider`, `signUpCarbon`; `OAuthError` |
| `lib/mocks.ts` | `MockMessagingClient` (`messages`, `latest`, `lastSeq`, `waitFor`, `waitForCode`, `clear`, `requests`, `fault`, `reset`), `MockOidcClient` (`registerIdentity`, `randomIdentity`, `next`, `requests`, `fault`, `rotateKey`, `authorize` — plays the browser at the provider), `FakeAppsClient` (`state`, `events`, `waitForEvent`, `setWebhookSecret`, `connectWebhook`, `webhookFaults`, `hookUrl`, `setHookSecret`, `hookEvents`, `waitForHookEvent`, `hookFaults`, `sltLogin`, `authorizeUrl`, `callback`, `saveToBriefcase`, `notify`, `verifyProof`, `issueUserVerification`, `refresh`, `userinfo`, `files`), `randomEmail`, `randomPhone` (valid `+1 <area> 555 XXXX`, unique per process), `parseFormPost` |
| `lib/pkce.ts` | `createPkcePair`, `codeChallengeS256`, `pkceMatches`, `randomState`, `randomNonce` |
| `lib/signature.ts` | `computeWebhookSignature`, `webhookSignatureHeader`, `verifyWebhookSignature`, `parseSignatureHeader`, `signWebhookDelivery`, `WEBHOOK_HEADERS` |
| `lib/http.ts` | `HttpClient` (cookie jar, Origin, Basic/Bearer, timing), `CookieJar`, `HttpExpectationError` (message includes method, URL, status, error code/message/hint and request id), `expectStatus` |
| `lib/fake-apps.ts` | `fakeApps()`, `fakeApp(id)`, `appCredentials(id)`, `redirectUri(id)` |
| `lib/fixtures.ts` | `importFixturePath/Bytes/Rows`, `expectedImportOutcomes`, `uniquifyEmails`, `bigCsvLines`, `generateBigCsv` |
| `lib/env.ts` | `accountsEnvForMocks`, `accountsTopologyEnv`, `toDotenv`, `toShellExports` |
| `lib/images.ts` | `pngBytes(width, height)`: a tiny well-formed PNG for photo uploads |
| `lib/bench.ts` | `measure(count, concurrency, fn)` → `{count, errors, min/mean/p50/p95/p99/max_ms, throughput_per_s}`, `percentile`, `summarize` (for the proof-verify latency benchmark) |
| `lib/index.ts` | all of the above + `startMockOidc`, `startMockMessaging`, `startFakeAppServer`, `startTestkit`, `loadDevCredentials` |

Each server module also exports `start(options) → {url, port, stop(), …}` (`src/mock-oidc.ts`,
`src/mock-messaging.ts`, `src/fake-app-server.ts`); `startTestkit({oidcPort, messagingPort, fakeAppsPort,
accountsUrl, accountsPublicUrl, host})` starts all three wired to the dev credentials and returns
`{oidc, messaging, fakeApps, credentials, accountsEnv, stop()}`. Defaults are the standard ports; pass
`0` for free ports.

## Journeys (journeys/)

Scripts that walk through the product the way apps, Carbons and Silicons do, without a browser:
the hosted-flow API (`BrowserSession`), the fake app server's own callbacks and proof demos, and
the real `accounts` CLI binary (`ACCOUNTS_CLI`, default `target/debug/accounts`). Each file is one
journey with numbered checks (`ok` / `FAIL`), runnable on its own (`tsx journeys/c-cli-silicons.ts`)
or all together (`pnpm -C testkit journeys`, which exits 1 when any check failed).

| journey | covers |
|---|---|
| `a-hosted-signin` | sign-up through the hosted flow (briefcase, with a photo uploaded on the sign-up page that the new account keeps; the fake app exchanges the code), dm's custom details page (the missing phone added with a code, optional details unticked), ledgerly's two pages + review (sign-up intent, back keeps answers), "continue as" on another app, the details page skipped when everything was granted, "Not you?" at sign-up ends that sign-up |
| `b-providers` | managed Google (interface), bring-your-own Google (acme-notes: mock saw acme's client_id), Apple form_post bring-your-own (orbit-games, cookieless POST → 303 → GET) and managed (waveform), `allowed_email_domains`, `allow_signup: false` |
| `c-cli-silicons` | device flow approved with the browser session, `silicon create` (STK once), `login --silicon`, `login --app remind` + SLT exchange, self-create `--wait` accepted meanwhile, transfer + accept, STK rotation (old STK refused, apps signed out), Silicon webhook events on `/hooks/<key>` |
| `d-proofs` | User verification dm → briefcase and App verification commit → remind and → waveform (one proof per app) through the fake apps (timings), a multi-app App verification request refused (`app_verification_single_app`), non-audience verification `{valid:false, expires_at:null}`, verify latency |
| `e-import` | `accounts app import dirty.csv --wait` compared row by row with `expected.json`, then an imported Carbon finishes setup (`finishing_import`) and the membership turns active (needs a database dirty.csv was never imported into) |
| `f-app-webhooks` | signed app webhooks: id change, scope-limited `account.updated`, primary email change, revoke → `membership.signed_out`, access removal |
| `g-report` | `accounts report` → mock Postmark gets exactly the three recipients |
| `h-protocol` | OIDC id_token, `prompt=none/login`, refused redirect URIs, PKCE, code reuse, refresh rotation + reuse detection, code send limit + verify lockout, CSRF Origin guard, audience confusion, an app's `allowed_origins` in its public config (and, behind the Next.js site, the embed page's `frame-ancestors` and the SDK's CORS), CORS, `docs_url` in `/v1/meta` |
| `i-cli-account`, `j-cli-custodian`, `k-cli-app` | every CLI command family against the real service (account, Silicons and custodian requests — including `silicon update --photo` and `id available --for` — device, config, deletion, app mode with credentials and as the owner) |
| `l-client-contract` | the Rust client's typed values (CLI `--json`) against the raw API: no field dropped or invented |

`scripts/journeys.sh` runs them on a fresh stack in one of three topologies: API only (default:
every call goes straight to accounts-api), `--proxy` (through `scripts/dev-proxy.mjs`, which
forwards `/v1/*` and `/.well-known/*` exactly like the Next.js site's rewrites, so cookies,
`Set-Cookie`, `Location`, `Origin`, `X-Forwarded-For` and Apple's `form_post` all cross a proxy) and
`--next` (through the real site). The journeys read `ACCOUNTS_URL` (where calls go),
`ACCOUNTS_PUBLIC_URL` and `JOURNEYS_FRONT` (`none`, `proxy` or `next`).

They need the per-network code limit (30 per 10 minutes) to apply per journey: run accounts-api
with `ACCOUNTS_TRUST_FORWARDED_FOR=true`, and every `AccountsClient` sends `X-Forwarded-For` from
`TESTKIT_FORWARDED_FOR` (`random` = its own 10.x address; `pnpm -C testkit journeys` sets it).
`new AccountsClient(url, { forwardedFor, headers })` does the same in code.

## Using it from the e2e harness

1. `pnpm -C testkit install --frozen-lockfile`.
2. Start the testkit: `pnpm -C testkit start --ready-file e2e/.artifacts/testkit.json --accounts-url "$ACCOUNTS_URL" &`
   (wait for the `testkit ready` line or the file), or call `startTestkit()` in-process.
3. Export `pnpm -s -C testkit accounts-env --format shell` (or `accountsEnv`) into accounts-api's
   environment, plus the e2e database URL etc.
4. Seed with `accounts-seed --fake-apps testkit/fake-apps.json`.
5. `await new AccountsClient(url).waitUntilReady()`, then run the suites; fresh accounts per test via
   `randomEmail()` / `randomPhone()` / `oidc.randomIdentity()`.
6. `kill -TERM` the testkit (it exits 0 after closing every socket).

Conventions: inspection lists are newest first and carry a monotonic `seq`; testkit errors use the
Accounts error shape `{"error":{"code","message","hint"?}}`; provider endpoints use each provider's
own error format.

Security: the servers bind `127.0.0.1` by default and are test fixtures — their inspection endpoints
hand out OTP codes, tokens (`?include_tokens=1`) and secrets on purpose. Never bind them to a public
interface (`--host`) or point a production Silicon Accounts at them; request logs on stderr carry
only method, path and status (no query strings, bodies or credentials).

## Layout

```
testkit/
  src/            mock-oidc.ts, mock-messaging.ts, fake-app-server.ts, mock-iris.ts, testkit.ts (startTestkit),
                  start.ts (CLI), print-env.ts, credentials.ts, fake-apps/ (definitions, logos, pages,
                  types, load), shared/ (http router/server, page shell, utils)
  lib/            the e2e helper library (index.ts)
  scripts/        generate-dev-credentials.ts, build-fake-apps.ts, build-import-fixtures.ts
  fixtures/imports/  clean.csv, dirty.csv, dirty.json, unknown-columns.csv/.json, expected.json, README.md, generate-big.ts
  test/           node:test suites (+ a small stub of Silicon Accounts used by them)
  fake-apps.json  dev-credentials.json
```
