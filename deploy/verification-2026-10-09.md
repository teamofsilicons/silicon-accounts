# Production verification: 2026-10-09

Production runs `a20062ccd2e8a6693bd3d3ebf9f223a04b0ca41a`, Accounts 0.4.0 on
migration 19 (see the last section). Earlier the same day `a2d85c5` was live from
06:33 to 10:38 UTC, `9b46dc9` from 10:38 to 12:41 UTC, `0d0f7b3` from 12:41 to
16:02 UTC and `776fa05` from 16:02 to 21:22 UTC. The first attempt of the day,
`2efa04a`, was rolled back; it is recorded first.

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

## Status page, data we keep and open source wording: live

Source `0d0f7b3dcd5e89f16943907b0ec5ce10d9bc86cb`. Since `9b46dc9` it adds the MIT
`LICENSE`, the developer site's `/status` and `/status.json`, the "What we keep,
and why" docs page, the open source (MIT) wording and visual fixes on both sites,
and updated docs and `llms-full.txt`. `git diff --stat 9b46dc9..HEAD -- crates
migrations` is empty, and the installer and packager are unchanged.

### Preflight

- Clean tree at `0d0f7b3`. The ARM64 rebuild in `target/integration` was a no-op,
  with the same binaries as `9b46dc9`: API `a51584d2...`, migrator `adae161c...`.
- Web typecheck, lint and 30 unit tests passed; developer typecheck, lint and 41
  unit tests passed. Both sites were built for production with the same
  variables as before. Both standalone routing tests passed on those builds,
  which keep `skipProxyUrlNormalize: true` and contain no `modelContext` or
  `webmcp`. The Node and Caddy archives matched their checksums.
- Archive `releases/0d0f7b3dcd5e89f16943907b0ec5ce10d9bc86cb.tar.gz`, 120311783
  bytes, SHA-256 `24787722feef6ac27de1a4a03791790cf7b65d7bec9f1fbf21329531f86eb2b7`.
  56 internal links were preserved, and its `install.py` matches the committed one.

### Install

Read-only precheck SSM `87b7ffdf-f4b5-47f5-a5b8-ae28724fe431` found `9b46dc9`
active on migration 19 with every service up.

Install SSM `077632c9-ecbe-43da-ae02-0dda11c3a6b6` ran from 12:41:43 to 12:42:05
UTC and succeeded. It verified the archive SHA-256 before extracting the
installer. It retained `backups/predeploy-20261009T124158Z.dump` (263027 bytes in
S3 and on the host), SHA-256
`837710e3027fd30ae8c38c364cc1a30220888eb1736ae032e08326da1ab9c612`. Nothing was
pending (19 already applied), and local readiness passed.

Postcheck SSM `c1a85f19-a406-4d14-86c8-890068b399d2` confirmed:

- `current` points at `0d0f7b3`, and `previous-release` at `9b46dc9`.
- Both binary hashes and `build.json` match. Six services and timers are active.
- Migration 19 with none failed; one account, three apps, one membership and the
  RS256 key are unchanged.
- The Caddy direct block, `APPS_API_URL` and the absent loopback flag are as
  before. Zero API ERROR or WARN lines and zero web `EPROTO` lines.
- On the host, the landing and `/status.json` returned 200 with Caddy's headers.

### Public verification

- `https://developers.teamofsilicons.com/status` and `/status.json` return 200.
  The JSON reports `"status": "up"`, "All three services are up.": Silicon
  Accounts 0.4.0 (`/readyz` and `/v1/meta` 200), Silicon Apps 0.1.2 (`/health`
  200) and Silicon Developer 0.1.0 (`/openapi.json` 200). The page shows three
  "Up" badges. In a headless browser at 1440 and 390 px it rendered "Service
  status" without overflow or page errors, and the screenshots were inspected.
- `/docs/accounts/learn/data-we-keep` returns 200 with "What we keep, and why";
  its `.md` matches `docs/learn/data-we-keep.md` byte for byte.
- Open source (MIT) wording:
  - The account site's footer says "Silicon Accounts is open source (MIT)", and
    its landing mentions it 10 times.
  - The developer site's footer says "Silicon Apps and Silicon Accounts are open
    source (MIT)", and its home mentions it 12 times.
  - Both link the GitHub repositories, which are public and answer 200.
- `/llms-full.txt` on the developer site is byte-identical to
  `developer/llms/llms-full.md`: 763874 bytes, 8273 lines, starting with
  `# Silicon Developer docs (full)`.
- The developer sitemap lists `https://developers.teamofsilicons.com/status`.
- No `modelContext` or `webmcp` appears in the raw HTML of the account landing,
  `/sign-in`, the developer home, `/docs`, `/docs/apps`,
  `/docs/accounts/start/webhooks`, the data-we-keep page or `/status`.
- Signed-out `GET https://accounts.teamofsilicons.com/` returned 200 with the
  landing text and `<main`, three times out of three. With a stale
  `__Host-sa_session` and with a stale `sa_session` it served the same landing
  and cleared the cookie.
- `/sign-in` rendered Continue with Google, Continue with Apple, Email/Phone, the
  email field and Continue at 1440 and 390 px. The developer sign-in returns 303
  to the Accounts `/authorize` with `app_id=developer`, the exact callback, S256
  and a 43-character challenge, and the hosted page renders. Nothing was
  submitted.
- API:
  - `/readyz` `{"database":"ok"}`; `/v1/meta` version 0.4.0.
  - `/v1/capabilities` and `?require=event_stream` return 200.
  - Discovery has the Accounts issuer, EdDSA and RS256, and six grants; JWKS
    lists both keys.
  - `/openapi.json` returns 200 with 135 paths; `/.well-known/agent.json`
    reports 0.4.0 with six skills.
  - The event stream answers the API's JSON 401 under `curl --max-time 5 -N`.
  - Both `/mcp` `initialize` calls return 2025-06-18.
- The account site's agent files return 200, `/docs` returns 308 to the
  developer docs, and the developer docs pages, search (61 matches), agent card
  (seven skills), `/openapi.json`, `/auth/session` and `/sign-in` return 200.
  An unknown page returns 404.

### Log watch

From 12:45 to 12:48 UTC the landing, `/sign-in`, `/readyz`, the developer home,
`/docs` and `/status` were probed in seven rounds. Every request returned 200,
and `/status.json` said `up` each time. Log scan SSM
`48fd6d1a-4548-4f4f-8dc1-bfe86535e0c0` found no restarts, zero API ERROR or WARN
lines, zero Caddy error lines and no other system warnings. The web and developer
logs held only the usual restart line from the previous process at 12:42:00.

## Four Linux upload targets in the docs and llms-full.txt: live

Source `776fa058d757595772214706227a29b10a86a85a`. Since `0d0f7b3` it changes only
five Apps docs pages and `developer/llms/llms-full.md` (and the deploy records):
every place that said third-party uploads validate on `linux-x86_64` only now
names the four Linux targets Silicon Apps opened today (`linux-x86_64`,
`linux-i686`, `linux-aarch64`, `linux-armv7hf`) and still says Windows and macOS
have no validation worker. Before editing, `GET https://apps.teamofsilicons.com/v1/targets`
reported `runner_available: true` for those four and `false` for the five Windows
and macOS targets, and `/v1/capabilities` reported the four `live` and the rest
`not_configured`. `git diff --stat 0d0f7b3..776fa05 -- crates migrations` is
empty, and the installer and packager are unchanged. The Silicon Apps store copy
states no upload target limit, so the Apps host was not redeployed.

### Preflight

- Clean tree at `776fa05`. The ARM64 rebuild in `target/integration` was a no-op,
  with the same binaries as `0d0f7b3`: API `a51584d2...`, migrator `adae161c...`.
- Web typecheck, lint and 30 unit tests passed; developer typecheck, lint and 41
  unit tests passed, and `pnpm build:docs --check` found 56 pages with no
  problems. No U+2014 or U+2013 is in `docs`, `docs-apps` or `developer/llms`.
  Both sites were built for production with the same variables as before. Both
  standalone routing tests passed on those builds, which keep
  `skipProxyUrlNormalize: true` and contain no `modelContext` or `webmcp`. The
  Node and Caddy archives matched their checksums.
- Archive `releases/776fa058d757595772214706227a29b10a86a85a.tar.gz`, 120311796
  bytes, SHA-256 `d070306b6b80568c0bacdd0e457eba196fe934a0120dd8bebf7fe892ea7f715c`,
  S3 version `7ioLic6lJYmh6GvYpm8uy9FAFjy22je1`. 56 internal links were preserved,
  its `install.py` matches the committed one, and its developer server chunks
  carry the new wording and none of the old.

### Install

Read-only precheck SSM `5dcf1a6f-4046-4f8a-8a15-c88172e4972e` found `0d0f7b3`
active on migration 19 with every service up, and the hourly backup due at
16:00:45 UTC. SSM `1eedf56f-5074-46ba-b978-d729842ac8d3` waited for it: the
backup ran at 16:01:07 and succeeded before the install began.

Install SSM `2bae2fee-9907-4547-8c90-5c7ec612d845` ran from 16:01:48 to 16:02:10
UTC and succeeded. It verified the archive SHA-256 before extracting the
installer. It retained `backups/predeploy-20261009T160203Z.dump` (260887 bytes in
S3 and on the host, S3 version `W31T4D1dTZn6I9U_WR8IXgUdB4BoEWa.`), SHA-256
`15e6e15bc0f91a798b1c960c83e71bc1ef318bfe8438a3efe541df48cb352559`. Nothing was
pending (19 already applied), and local readiness passed.

Postcheck SSM `2b382bcc-92ac-48ac-8044-6017a1712993` confirmed:

- `current` points at `776fa05`, and `previous-release` at `0d0f7b3`.
- Both binary hashes and `build.json` match. Six services and timers are active;
  the API restarted at 16:02:04, web and developer at 16:02:05, Caddy at 16:02:08.
- Migration 19 with none failed; one account, three apps, one membership and the
  RS256 key are unchanged.
- The Caddy direct block, `APPS_API_URL` and the absent loopback flag are as
  before. Zero API ERROR or WARN lines and zero web `EPROTO` lines.
- On the host, the landing and `/status.json` returned 200 with Caddy's headers.

### Public verification

- `https://developers.teamofsilicons.com/llms-full.txt` is byte-identical to
  `developer/llms/llms-full.md`: 764887 bytes, 8273 lines, starting with
  `# Silicon Developer docs (full)`. It names the four Linux targets in 16 places
  and no longer says `` `linux-x86_64` only `` anywhere. Before the install it
  served the previous 763874-byte file.
- The five changed pages' `.md` (`/docs/apps/index.md`, `/docs/apps/start/publish.md`,
  `/docs/apps/start/install.md`, `/docs/apps/reference/manifest.md`,
  `/docs/apps/reference/api.md`) match their sources in `docs-apps` byte for
  byte. Their HTML pages return 200 with one `<main>`, name `linux-armv7hf` and
  no longer say "only live worker" or "Today only" (`/docs/apps/index` answers
  308 to `/docs/apps`, which carries the new text).
- In a headless browser at 1440 and 390 px, `/status`, `/docs/apps` and
  `/docs/apps/reference/manifest` rendered without overflow, page errors or
  `navigator.modelContext`, and the screenshots were inspected.
- `/status` and `/status.json` return 200; the JSON reports `"status": "up"`,
  "All three services are up.": Silicon Accounts 0.4.0, Silicon Apps 0.1.2 and
  Silicon Developer 0.1.0, and the page shows three "Up" badges. The developer
  sitemap still lists `/status`.
- Signed-out `GET https://accounts.teamofsilicons.com/` returned 200 with the
  landing and `<main`, three times out of three. With a stale
  `__Host-sa_session` and with a stale `sa_session` it served the same landing
  and cleared the cookie.
- `/sign-in` rendered Continue with Google, Continue with Apple, Email/Phone, the
  email field and Continue at 1440 and 390 px. The developer sign-in returns 303
  to the Accounts `/authorize` with `app_id=developer`, the exact callback, S256
  and a 43-character challenge, and the hosted page renders. Nothing was
  submitted.
- API:
  - `/readyz` `{"database":"ok"}`; `/v1/meta` version 0.4.0.
  - `/v1/capabilities` and `?require=event_stream` return 200.
  - Discovery has the Accounts issuer, EdDSA and RS256, and six grants; JWKS
    lists both keys.
  - `/openapi.json` returns 200 with 135 paths; `/.well-known/agent.json`
    reports 0.4.0 with six skills.
  - The event stream answers the API's JSON 401 under `curl --max-time 5 -N`.
  - Both `/mcp` `initialize` calls return 2025-06-18.
- The account site's agent files return 200, `/docs` returns 308 to the
  developer docs, and the developer home, docs pages, search (61 matches), agent
  card (seven skills), `/openapi.json`, `/auth/session` and `/sign-in` return
  200. An unknown page returns 404. No `modelContext` or `webmcp` appears in the
  raw HTML of any page checked.

### Log watch

From 16:06 to 16:12 UTC the landing, `/sign-in`, `/readyz`, the developer home,
`/docs`, `/status` and `/llms-full.txt` were probed in seven rounds. Every
request returned 200, and `/status.json` said `up` each time. Log scan SSM
`afe8812f-5626-4bce-8c38-acb499b60a4d` at 16:12:29 UTC found no restarts, zero
API ERROR or WARN lines, zero Caddy error lines and no other system warnings. The
web and developer logs held only the usual restart line from the previous
process at 16:02:05.

## MCP servers removed: live

Source `a20062ccd2e8a6693bd3d3ebf9f223a04b0ca41a`. At the Carbon's request it
deletes `/mcp` from the developer and account sites. The Accounts API no longer
lists `mcp` in `/v1/capabilities` or links `/mcp` from its agent card, and the
docs and `llms-full.txt` are updated to match. Since `776fa05` the API changes
only in `crates/server` (discovery and its OpenAPI document). There are no
migrations, and the installer and packager are unchanged.

### Preflight

- Clean tree at `a20062c`. `cargo test -p silicon-accounts-server` passed 96
  tests (none failed or ignored) with `CARGO_TARGET_DIR=target/integration`.
  Web typecheck, lint and 26 unit tests passed; developer typecheck, lint and 39
  unit tests passed.
- Both sites were built for production with the same variables as before. Both
  standalone routing tests passed on those builds. Neither build has an `mcp`
  route, and both keep `skipProxyUrlNormalize: true`.
- The new ARM64 API SHA-256 is
  `b6134588be10ff54f6da3623c728f696377fb308911638683a7e7959e93ca08f`; the
  migrator is unchanged at `adae161c...`. The Node and Caddy archives matched
  their checksums.
- Archive `releases/a20062ccd2e8a6693bd3d3ebf9f223a04b0ca41a.tar.gz`, 120266993
  bytes, SHA-256 `ca9263f680b50f3ed22faa5e9b0a614fa96b42571757673fb2ddf552a5e4cb24`.
  56 internal links were preserved, and its `install.py` matches the committed one.
- With no schema change, the previous release `776fa05` remained a direct
  rollback target.

### Install

Read-only precheck SSM `53ff9c2b-eb1f-419d-b508-82206f6efae0` found `776fa05`
(API `a51584d2...`) active on migration 19. Just before the install, `POST /mcp`
on both hosts still answered JSON-RPC (200, `application/json`).

Install SSM `753f144b-acb8-4f93-bfde-bbc28ee7bbd4` ran from 21:22:29 to 21:22:53
UTC and succeeded. It verified the archive SHA-256 before extracting the
installer. It retained `backups/predeploy-20261009T212246Z.dump` (261514 bytes in
S3 and on the host), SHA-256
`2486ef64363d2702387148ac848ec95f23fc5b8c9f0306c15d6c998e8cbdcd44`. Nothing was
pending (19 already applied), and local readiness passed.

Postcheck SSM `911a3683-92f9-4f91-b9e7-e81afc814207` confirmed:

- `current` points at `a20062c`, and `previous-release` at `776fa05`.
- The new API hash, the migrator hash and `build.json` match. Six services and
  timers are active.
- Migration 19 with none failed; one account, three apps, one membership and the
  RS256 key are unchanged.
- The Caddy direct block, `APPS_API_URL` and the absent loopback flag are as
  before. Zero API ERROR or WARN lines and zero web `EPROTO` lines.
- On the host, the landing and `/status.json` returned 200.

### Public verification

- `POST` (an MCP `initialize`) and `GET` to `https://accounts.teamofsilicons.com/mcp`
  and `https://developers.teamofsilicons.com/mcp` all return 404 with each site's
  HTML "Not found" page, and none of them contains `jsonrpc`.
- `/v1/capabilities` reports 0.4.0 with 26 capabilities and no `mcp` key or
  mention; `?require=event_stream` still returns 200 and also has no mention.
- Neither `/.well-known/agent.json` mentions `mcp`: the Accounts card has six
  skills at 0.4.0, and the developer card has three. Neither `robots.txt` has an
  `/mcp` line.
- No `mcp` appears, in any case, in the account landing, the developer home,
  `/sign-in`, `/docs`, `/status`, either `llms.txt`, either sitemap or the
  developer `/openapi.json`. The account landing, `/sign-in`, `/docs` and the
  developer home also contain no `modelContext` or `webmcp`.
- `/llms-full.txt` on the developer site is byte-identical to
  `developer/llms/llms-full.md`: 764668 bytes, 8273 lines, starting with
  `# Silicon Developer docs (full)`. Its remaining MCP mentions describe the
  outside protocol, other providers and the MCP Registry; it links no
  teamofsilicons `/mcp` address.
- `/status` and `/status.json` return 200 with "All three services are up."
  (Accounts 0.4.0, Apps 0.1.2, Developer 0.1.0). The sitemap still lists
  `/status`.
- Signed-out `GET https://accounts.teamofsilicons.com/` returned 200 with the
  landing text and `<main`, three times out of three. With a stale
  `__Host-sa_session` and with a stale `sa_session` it served the same landing
  and cleared the cookie.
- A headless browser at 1440 and 390 px showed, with no page errors or overflow:
  - the landing;
  - `/sign-in` with Continue with Google, Continue with Apple, Email/Phone, the
    email field and Continue;
  - the developer home;
  - the hosted "Sign in to Silicon Developer" page;
  - `/status` and the data-we-keep page.

  Screenshots were inspected. Nothing was submitted.
- The developer sign-in returns 303 to the Accounts `/authorize` with
  `app_id=developer`, the exact callback, S256 and a 43-character challenge.
- API:
  - `/readyz` `{"database":"ok"}`; `/v1/meta` version 0.4.0.
  - Discovery has the Accounts issuer, EdDSA and RS256, and six grants; JWKS
    lists both keys.
  - `/openapi.json` returns 200 with 135 paths and no `mcp` mention.
  - The event stream answers the API's JSON 401 under `curl --max-time 5 -N`.
- The account site's agent files return 200, and `/docs` returns 308 to the
  developer docs. The developer docs pages, search (61 matches),
  `/openapi.json`, `/auth/session` and `/sign-in` return 200; the data-we-keep
  `.md` matches its source, and an unknown page returns 404.

### Log watch

From 21:25 to 21:29 UTC the landing, `/sign-in`, `/readyz`, the developer home,
`/docs`, `/status` and both `/mcp` addresses were probed in seven rounds. The
pages returned 200, both `/mcp` addresses 404, and `/status.json` said `up`
every time. Log scan SSM `ebef6bb4-8e1b-4c78-8275-b2c6f78dfc0a` found no
restarts, zero API ERROR or WARN lines, zero Caddy error lines and no system
warnings.

At 21:26:30 the developer site logged one Next.js error: "The Server Reference ID
did not match the expected format. Received "x"." That is a request carrying a
bogus `Next-Action: x` header, which Next refuses; it did not come from these
checks. SSM `cc0428c8-6907-4770-8b3b-606a770830b5` showed the same line 191 times
in the developer log and 8 times in the web log since 2026-10-08, from outside
probes. It predates this release, and the service did not restart.
