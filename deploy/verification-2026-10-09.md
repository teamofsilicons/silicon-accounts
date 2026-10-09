# Production verification: 2026-10-09

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
