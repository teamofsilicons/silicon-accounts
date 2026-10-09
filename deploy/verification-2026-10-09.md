# Production verification: 2026-10-09

Production runs `9b46dc9fdfb609b09a48ed18e5bca15bc3426b66`, Accounts 0.4.0 on
migration 19 (see the last section). It follows `a2d85c5`, which was live from
06:33 to 10:38 UTC. The first attempt of the day, `2efa04a`, was rolled back; it
is recorded first.

## Agent entry points release: deployed, then rolled back

Attempted source `2efa04a7b290abfe2fbe7c76022a04cca2f0855a` (agent capabilities,
Silicon controls, the redesigned account and developer sites) on the Accounts host
under `silicon-production` in `us-east-2`. The release installed and migrated
cleanly, and the API and developer site passed every public check. A signed-out
`GET /` on the account site returned 500 for every visitor, so the code was rolled
back to `0940a941d4101d5cbee6031c25d5bc047ec43f0a`. The database stays at
migration 17; that is compatible with the previous binary (see Rollback).

### Preflight

- Clean tree at `2efa04a`. The full Rust workspace passed 957 tests (3 existing
  ignored) with `CARGO_TARGET_DIR=target/integration`. Web typecheck, zero-warning
  lint and 29 unit tests passed; developer typecheck, lint, 37 unit tests and the
  standalone production-routing test passed.
- ARM64 API and migrator built with `cargo zigbuild --locked --release --target
  aarch64-unknown-linux-gnu.2.34` into `target/integration` (glibc floor 2.34; all
  five new migrations embedded). API SHA-256
  `69fe25d16506dbf1bdc119a108e362951b8f3f0e47f296ad1c9d70761efb1539`, migrator
  `2995cca039f909130cf3c5aee59a77cef286c5e9d137ca7457386506815ec4ac`. The binaries
  were copied to `target/aarch64-unknown-linux-gnu/release`, where `package.py` reads.
- Web built with `ACCOUNTS_API_URL=http://127.0.0.1:8589` and the production
  public and developer URLs; developer built with the production URLs. The Node
  24.21.0 and Caddy 2.11.7 archives matched their recorded upstream checksums.
- Archive `releases/2efa04a7b290abfe2fbe7c76022a04cca2f0855a.tar.gz`, 120037023
  bytes, SHA-256 `950f967898917fc3cdd7c901131de52a9357c5396ec1c65b21ee9e60907968cf`.
  56 internal links were preserved, and its `install.py` matches the committed one.

### Install

Install SSM `a4b44668-18fe-4fbb-bb70-381b71092abc` verified the archive SHA-256
before extracting the installer, then ran it with the documented arguments.
Before the install the host had migration 12, one account, three apps, one
membership and no webhooks. The installer retained
`backups/predeploy-20261009T062319Z.dump` (217648 bytes in S3 and on the host),
SHA-256 `716143927384ce0a9969e5d42f6958e58d8075112f3dc60af100649e3cccd55d`,
before migrating. It then applied 0013 to 0017 and passed local readiness.

Postcheck `1b541d31-56e2-4922-a50f-62ebfc8c5ecc` confirmed the active release and
both binary hashes, six active services and timers, migration 17 (17 applied, none
failed), unchanged counts, zero event subscriptions (no webhooks to carry over),
and the Caddy direct block for `/v1/events/stream` and `/openapi.json`. Other checks:
`APPS_API_URL="https://apps.teamofsilicons.com"` kept, no
`ACCOUNTS_FEDERATION_ALLOW_LOOPBACK` in the API environment, and zero API error
lines. The API made its RS256 identity-token key on first start, kid
`CLkhuxuEYv3Co2aKn5fcywNYA35pluzJ1QzF2vET1gM`, sealed in `signing_keys`.

### Public checks while the release was live (06:24 to 06:27 UTC)

Passed on https://accounts.teamofsilicons.com:

- `/readyz` 200 `{"database":"ok"}`; `/v1/meta` 200, version 0.3.0 (meta carries
  no revision; the host's `build.json` named `2efa04a`).
- `/.well-known/openid-configuration`: issuer is the Accounts origin, signing
  algorithms EdDSA and RS256, and the grants are authorization_code,
  refresh_token, device_code, slt, jwt-bearer and token-exchange.
  `/.well-known/jwks.json` lists the Ed25519 key `accounts-production-1` and the
  RSA key with the kid above.
- `/openapi.json` 200 JSON, OpenAPI 3.1.0, 135 paths including
  `/v1/events/stream`. `/v1/capabilities` 200 JSON. `/.well-known/agent.json` 200
  with six skills.
- `curl --max-time 5 -N` on `/v1/events/stream` returned the API's JSON 401
  (`unauthenticated`, and `invalid_token` for a malformed bearer), not HTML.
  Its `Vary: Accounts-Version`, without Next's `Accept-Encoding`, shows Caddy sent
  it straight to the API. No credentials were used, so a live stream and its
  flushing were not exercised.
- `/llms.txt`, `/llms-full.txt`, `/robots.txt`, `/sitemap.xml` (4 URLs),
  `/.well-known/security.txt`, `/manifest.webmanifest` and `/sdk/v1.js` returned
  200; `/docs` returned 308 to the developer docs. `POST /mcp` `initialize`
  returned protocol 2025-06-18 from `silicon-accounts`. `/sign-in` returned 200;
  its choices were not inspected before the rollback.

Passed on https://developers.teamofsilicons.com:

- `/` 200 with the new hero "Build apps for Carbons and Silicons"; `/docs`,
  `/docs/accounts`, `/docs/apps` 200; an unknown page is a real 404.
- `/llms-full.txt` starts with `# Silicon Developer docs (full)`; `/llms.txt`,
  `/robots.txt`, `/sitemap.xml` (64 URLs), `/.well-known/security.txt`,
  `/.well-known/agent.json` (seven skills) and `/openapi.json` returned 200.
- `/api/docs/search?q=webhooks` returned 10 results led by "Receive webhooks".
  `POST /mcp` `initialize` returned protocol 2025-06-18 from `silicon-developer`.
- `/auth/session` 200; `/auth/sign-in` 303 to the Accounts `/authorize` with
  `app_id=developer`, the exact `/auth/callback` redirect URI and S256 PKCE.

### Failure

A signed-out `GET https://accounts.teamofsilicons.com/` returned 500 with the body
`Internal Server Error`, three times out of three. The response carried
`x-middleware-rewrite: https://localhost:8590/landing`. Diagnostic SSM
`8fc3a0ee-37ef-438d-8fe0-c1c5b01a7ac9` reproduced it on the host with Caddy's
`Host` and `X-Forwarded-Proto: https` headers. The web service logged
`Failed to proxy https://localhost:8590/landing Error: write EPROTO ... wrong version number`.

`web/proxy.ts` rewrites a signed-out `/` to `/landing` using
`new URL(..., request.url)`. Without `skipProxyUrlNormalize`, Next normalizes the
standalone listener's `127.0.0.1` to `localhost` and keeps the forwarded https
scheme. The rewrite then looks external and is proxied over TLS to the plain HTTP
listener. The developer site already avoids this: `developer/next.config.ts` sets
`skipProxyUrlNormalize: true`, and its standalone routing test covers it.
`web/next.config.ts` has no such setting, and the web site has no
production-routing test, so the local checks could not catch the bug. Signed-in
`/`, `/sign-in` and the API rewrites do not take this path.

### Rollback

Schema compatibility was checked before switching. The previous API refuses only
embedded migrations that have not been applied, so the extra applied 0013 to 0017
do not stop it. The new migrations are additive: new tables, nullable or
defaulted columns, and a widened `token_families` origin check. The
subscription trigger was written for an older API running during a rollback.
Nothing had used the new flows: zero new token families, device authorizations,
event subscriptions or accounts since the install.

Rollback SSM `9d6c809d-59a8-468f-9445-08103e6ec070` followed the README.
It read `/opt/accounts/previous-release` and checked the previous API hash
`bb82d925d90c23570ed74e48a176fd30dfa6fbc5b633286ad3fd4a7d74190f7b`. It then
atomically pointed `/opt/accounts/current` back at
`/opt/accounts/releases/0940a941d4101d5cbee6031c25d5bc047ec43f0a`, restarted the
API, web and developer services, waited for local readiness, validated the
Caddyfile and restarted Caddy. The signed-out landing returned 200 again.
`/opt/accounts/previous-release` was left unchanged and also names `0940a94`.

Verification SSM `94cc19f3-e30d-480b-84ce-4210461548af` confirmed the active
release, the API hash, six active services and timers, migration 17 with no
failures, one account, three apps, one membership and `{"database":"ok"}`. No API
error or web EPROTO line has appeared since the rollback. Publicly, both sites'
pages, `/readyz`, `/v1/meta`, discovery (EdDSA only), JWKS, `/sdk/v1.js` and the
developer sign-in PKCE redirect pass. The new API routes answer clean JSON 404s
from the previous API. The installed Caddyfile keeps its direct block for
`/v1/events/stream` and `/openapi.json`, which is harmless with the previous API.

The release directory for `2efa04a` and its staged archive remain on the host.
The RS256 key row remains in `signing_keys`; the previous API ignores it, and the
next release loads it instead of making a new one.

### To release again

Set `skipProxyUrlNormalize: true` in `web/next.config.ts`, as the developer site
does. Add a web standalone routing test that requests a signed-out `/` with
Caddy's `Host` and `X-Forwarded-Proto: https` headers. Then rebuild, repackage and
reinstall: no migration remains pending, so the installer takes a backup and
applies nothing. After the install, check the signed-out landing text before
anything else.

## Agent entry points release with the landing fix: live

Source `a2d85c5a770f7c19cccf6a7c3e23b0fbe5efce31` adds `skipProxyUrlNormalize: true`
to `web/next.config.ts` and a web standalone routing test. Since `2efa04a` nothing
else changed: not the API, migrations, developer site or installer.

### Preflight

- Clean tree at `a2d85c5`. The Rust crates are unchanged since the 957-test run
  above. The ARM64 rebuild in `target/integration` was a no-op, with identical
  hashes: API `69fe25d16506dbf1bdc119a108e362951b8f3f0e47f296ad1c9d70761efb1539`
  and migrator `2995cca039f909130cf3c5aee59a77cef286c5e9d137ca7457386506815ec4ac`.
- Web typecheck, lint and 29 unit tests passed, and both sites were rebuilt for
  production with the same variables as before. Both standalone routing tests
  passed on those production builds: `web` (signed-out `/`, the agent files and
  `/sign-in`, with and without Caddy's forwarding headers) and `developer`. Both
  builds carry `"skipProxyUrlNormalize": true`. The Node and Caddy archives
  matched their checksums again.
- Archive `releases/a2d85c5a770f7c19cccf6a7c3e23b0fbe5efce31.tar.gz`, 120035393
  bytes, SHA-256 `406fa76b29de35b96559038cd86b5d024d0e0587cca0195cead523fc133ac2f1`.
  56 internal links were preserved, and its `install.py` matches the committed one.

### Install

Install SSM `f691b9ad-5181-4da5-a030-f42645c2d96b` ran from 06:33:39 to 06:33:57
UTC and succeeded. It verified the archive SHA-256 before extracting the
installer. It retained `backups/predeploy-20261009T063352Z.dump` (259128 bytes in
S3 and on the host), SHA-256
`36af18f4a4ec71cb48318d79f8f429a4b80a82c1588bac951fc3967ab3098ac2`. The migrator
reported nothing pending: 17 already applied. Local readiness passed.

Postcheck `732f9405-08d3-4f72-b79e-b89988b34cb8` confirmed that `current` points at
the `a2d85c5` release and that `previous-release` names `0940a94`. It also
confirmed both binary hashes, `build.json`, six active services and timers,
migration 17 with no failures, and one account, three apps and one membership.
The API loaded the existing RS256 key (`identity-token signing key ready`, same
kid; no new key was made). The other checks:

- the Caddy direct block is present, `APPS_API_URL` is kept, and the
  federation loopback flag is absent;
- zero API error lines and zero web `EPROTO` lines;
- the landing returned 200 on the host with Caddy's headers.

### Public verification

- Signed-out `GET https://accounts.teamofsilicons.com/` returned 200 (196891
  bytes) five times out of five without a cookie. Every response had
  `x-middleware-rewrite: /landing`, and the raw HTML contains "One account for
  every Carbon and Silicon", "An identity of your own, in one command", "Create
  your Silicon account", the FAQPage JSON-LD and `<main`. Three stale cookie sets
  (`__Host-sa_session`, `sa_session`, both together) were each sent twice. Every
  request returned the same 200 landing and cleared each stale cookie with
  `Max-Age=0`. `/landing` returns 308 to `/`.
- A headless browser rendered the pages at 1440 and 390 px with no page errors
  and no horizontal overflow. The landing heading is "One account for every
  Carbon and Silicon". `/sign-in` shows "Sign in to Silicon Accounts" with
  Continue with Google, Continue with Apple, and an Email/Phone choice with the
  email field and Continue. Screenshots were inspected. The developer home's
  heading is "Build apps for Carbons and Silicons". Its sign-in opens the hosted
  "Sign in to Silicon Developer" page with the same four choices. Nothing was
  submitted.
- API: `/readyz` `{"database":"ok"}`; `/v1/meta` version 0.3.0, production, with
  the developer and Apps URLs and both providers. Discovery has the Accounts
  issuer, EdDSA and RS256, and the six grants (authorization_code,
  refresh_token, device_code, slt, jwt-bearer, token-exchange) plus the device
  endpoint. JWKS lists `accounts-production-1` and the RS256 kid.
  `/openapi.json` is OpenAPI 3.1.0, 0.3.0, with 135 paths including
  `/v1/events/stream`. `/v1/capabilities` reports API version 2026-10-01, and
  `/.well-known/agent.json` lists six skills.
- `curl --max-time 5 -N` on `/v1/events/stream` returned the API's JSON 401
  `unauthenticated` with `Vary: Accounts-Version`, straight from the API, not
  HTML. No credentials were used, so a live stream was not exercised.
- Account site: `/llms.txt` and `/llms-full.txt` (`# Silicon Accounts`),
  `/robots.txt`, `/sitemap.xml` (4 URLs), `/.well-known/security.txt`,
  `/manifest.webmanifest` and `/sdk/v1.js` returned 200; `/docs` returned 308 to
  the developer docs. `POST /mcp` `initialize` returned 2025-06-18 from
  `silicon-accounts`.
- Developer site:
  - `/`, `/docs`, `/docs/accounts` and `/docs/apps` returned 200.
  - `/docs/accounts/start/webhooks` returned 200 with "Receive webhooks", and its
    `.md` returned 200; an unknown page is a real 404.
  - `/llms-full.txt` starts with `# Silicon Developer docs (full)`.
  - `/api/docs/search?q=webhooks` returned 58 matches, led by "Receive webhooks".
  - `/llms.txt`, `/robots.txt`, `/sitemap.xml` (64 URLs),
    `/.well-known/security.txt`, `/.well-known/agent.json` (seven skills),
    `/openapi.json`, `/auth/session` and `/sign-in` returned 200.
  - `POST /mcp` `initialize` returned 2025-06-18 from `silicon-developer`.
  - `/auth/sign-in` returned 303 to the Accounts `/authorize` with
    `app_id=developer`, the exact `/auth/callback` redirect URI, S256 and a
    43-character challenge.

### Log watch

From 06:53 to 06:58 UTC the landing, `/sign-in`, `/readyz`, the developer home
and `/docs` were requested in seven rounds about 35 seconds apart; every request returned 200.
Log scan SSM `e6c7e63c-52be-4718-90cb-f278ea6def76` covered the 25 minutes after
the switch. It found no restarts, zero API ERROR or WARN lines and zero Caddy
error lines. The web and developer logs held only clean startup lines. Each had
one "Failed with result 'exit-code'": that is the previous process exiting 143
on SIGTERM at 06:33:54, the usual restart pattern. SSM
`374a4794-8939-4f0c-a625-4b559d38e271` showed those lines.

## Accounts 0.4.0: live

Source `9b46dc9fdfb609b09a48ed18e5bca15bc3426b66`, workspace version 0.4.0.
Since `a2d85c5` it adds migrations 0018 (short-lived token bounds) and 0019
(app-bound `silicon.custodian_changed` payloads cut to `{uuid, id}` by a trigger
and a one-time rewrite), plus API fixes. It removes WebMCP from both sites and
updates the docs and `llms-full.txt`. The installer and packager are unchanged.

### Preflight

- Clean tree at `9b46dc9`. With `CARGO_TARGET_DIR=target/integration` the full
  workspace passed 975 tests (3 existing ignored, none failed). Web typecheck,
  lint and 30 unit tests passed; developer typecheck, lint and 37 unit tests
  passed.
- Both sites were built for production with the same variables as before. Both
  standalone routing tests passed on those builds, and both builds keep
  `skipProxyUrlNormalize: true`. Neither build contains `modelContext` or
  `webmcp`.
- ARM64 API SHA-256 `a51584d2063199251b2e7b7839717b09d896e96e4fc4d9a68ad245044dfac833`,
  migrator `adae161c31e5e75f67f96f1ec32f2014bc5c5c05da0c8d1c4fa72fc87b84c1f1`
  (glibc 2.34 target, 0018 and 0019 embedded). The Node and Caddy archives
  matched their checksums.
- Archive `releases/9b46dc9fdfb609b09a48ed18e5bca15bc3426b66.tar.gz`, 120206159
  bytes, SHA-256 `1572b0ab005a5a8bedb2caa692d2305dee96c3502afe850b403f020a96c921a9`.
  56 internal links were preserved, and its `install.py` matches the committed one.
- Rollback readiness: the `a2d85c5` API refuses only embedded migrations that have
  not been applied, so 0018 and 0019 would not stop it. 0018 adds two nullable
  columns whose check holds when both are null, which is how the previous API
  inserts. 0019 adds a function and a trigger that only cut payloads. No rollback
  was needed.

### Install

Read-only precheck SSM `75681c4b-02e0-4425-8bb8-7cca2431d37f` found `a2d85c5`
active on migration 17, with one account, three apps, one membership, one
short-lived token and no app-bound `silicon.custodian_changed` rows.

Install SSM `cb188c53-797a-4b9d-865d-953f539b7ee9` ran from 10:38:31 to 10:38:53
UTC and succeeded. It verified the archive SHA-256 before extracting the
installer. It retained `backups/predeploy-20261009T103846Z.dump` (259708 bytes in
S3 and on the host), SHA-256
`c1f1d653eff9b54b6450137abf4504ccf4e160b84dfd3624c60d181ca28929d8`, before
applying 0018 and 0019 (2 applied, 17 already applied). Local readiness passed.

Postcheck SSM `c9c33cb8-ae6b-42e1-b7af-3a3cd4d8274d` confirmed the host state:

- `current` points at the `9b46dc9` release, and `previous-release` at `a2d85c5`.
- Both binary hashes and `build.json` match. Six services and timers are active.
- Migration 19: 19 applied, none failed; 0018 and 0019 at 10:38:46.
- Unchanged counts, the custodian trigger present, and zero capped short-lived
  tokens (expected).
- The same RS256 key was loaded.
- The Caddy direct block and `APPS_API_URL` are kept, and the federation loopback
  flag is absent.
- Zero API ERROR or WARN lines and zero web `EPROTO` lines.
- The landing returned 200 on the host with Caddy's headers.

### Public verification

- `/v1/meta` reports version 0.4.0, production. `/readyz` returns
  `{"database":"ok"}`.
- `GET /v1/capabilities?require=event_stream` returns 200 (an unknown
  requirement returns 422); `/v1/capabilities` reports 0.4.0 and 27 capabilities.
- Discovery still has the Accounts issuer, EdDSA and RS256, and the same six
  grants; JWKS lists both keys. `/openapi.json` returns 200 with 135 paths,
  including `/v1/events/stream`. `/.well-known/agent.json` reports 0.4.0 and six
  skills.
- `curl --max-time 5 -N` on `/v1/events/stream` returned the API's JSON 401
  `unauthenticated`, not HTML; no live stream was exercised. Both `/mcp`
  `initialize` calls return 2025-06-18.
- Signed-out `GET https://accounts.teamofsilicons.com/` returned 200 (188383
  bytes) with the landing text and `<main`, three times without a cookie. With a
  stale `__Host-sa_session` and with a stale `sa_session` it served the same
  landing and cleared the cookie.
- The account site's agent files (`/llms.txt`, `/llms-full.txt`, `/robots.txt`,
  `/sitemap.xml`, `/.well-known/security.txt`, `/manifest.webmanifest`) and
  `/sdk/v1.js` return 200; `/docs` returns 308 to the developer docs.
- No `modelContext` or `webmcp` appears in the raw HTML of the account landing,
  `/sign-in`, the developer home, `/docs`, `/docs/apps` or
  `/docs/accounts/start/webhooks`.
- A headless browser at 1440 and 390 px showed the landing heading, `/sign-in`
  with Continue with Google, Continue with Apple, Email/Phone, the email field and
  Continue, and the developer home. The developer sign-in reached the hosted
  "Sign in to Silicon Developer" page. There were no page errors or horizontal
  overflow, and the screenshots were inspected. Nothing was submitted.
- Developer site:
  - `/`, `/docs`, `/docs/accounts`, `/docs/apps` and
    `/docs/accounts/start/webhooks` return 200. That page's `.md` matches
    `docs/start/webhooks.md` byte for byte; an unknown page returns 404.
  - `/llms-full.txt` starts with `# Silicon Developer docs (full)`, is 754362
    bytes, and is byte-identical to `developer/llms/llms-full.md`.
  - `/api/docs/search?q=webhooks` returns 60 matches led by "Receive webhooks".
  - `/.well-known/agent.json` has seven skills; `/openapi.json`, `/auth/session`
    and `/sign-in` return 200.
  - `/auth/sign-in` returns 303 to the Accounts `/authorize` with
    `app_id=developer`, the exact `/auth/callback` redirect URI, S256 and a
    43-character challenge.

### Log watch

From 10:41 to 10:48 UTC the landing, `/sign-in`, `/readyz`,
`/v1/capabilities?require=event_stream`, the developer home and `/docs` were
probed in twelve rounds. From about 10:43:45 to 10:45:32 this workstation's probes
timed out, and then its local resolver failed to resolve the developer host.
Public resolvers (1.1.1.1, 8.8.8.8) returned `3.138.98.112` throughout, and the
developer site answered 200 through that address. The host's journal shows no
warning, restart or error in that window, so the gap was on the workstation's
side. All other rounds were 200 everywhere.

Log scan SSM `77f294a6-1aa2-4651-92e4-f5367e03841e` covered the ten minutes after
the switch. It found no restarts, zero API ERROR or WARN lines, zero Caddy error
lines, and only startup lines in the web and developer logs. Each had one
"Failed with result 'exit-code'", the previous process exiting on SIGTERM at the
restart, as in every earlier release.

The OpenAPI document's `info.version` still reads 0.3.0 (`crates/server/openapi.json`)
while the service reports 0.4.0. That is cosmetic, and is noted for the next
source change.
