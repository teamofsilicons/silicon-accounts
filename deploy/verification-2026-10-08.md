# Production verification — 2026-10-08

Deployed source `d153e5924b21a060586012f1906c74938319df6f` under
`silicon-production` in `us-east-2`. `us-east-1` rejected EC2 creation at its
32-vCPU quota. The failed stack and empty retained bucket were removed, and its
unused runtime secret was scheduled for recovery-window deletion. No existing
service was stopped or moved.

## Verified

- CloudFormation CREATE_COMPLETE, ARM64 native API and Next standalone servers.
- Both public DNS A records point to `3.138.98.112`; the other 104 records remained
  unchanged. Both sites have valid publicly trusted HTTPS.
- All six migrations applied. API readiness reports `database: ok`.
- Public `/readyz`, `/v1/meta`, `/docs`, `/sdk/v1.js`, OIDC discovery and JWKS return
  200. Production dev outbox returns 404. Discovery issuer is the Accounts origin.
- Browser Accounts sign-in renders Google, Apple, email and phone choices.
  Developer sign-in starts PKCE and renders its Accounts-hosted login page.
- API, web, developer, Caddy, PostgreSQL and the hourly backup timer are active.
  Database and application ports bind to loopback. Security group admits only
  ports 80 and 443; administration uses SSM.
- An hourly-style backup was uploaded to the private S3 bucket. A dump was restored
  into a temporary database; all six migration records were verified before that
  verification database was removed.
- Before deployment: 868 Rust, 98 testkit and 10 developer tests passed (3 Rust
  tests ignored). Both frontend checks/builds passed. Linux release build passed.
- The first packaging attempt flattened pnpm links and failed to start the sites.
  The corrected bundle preserves 56 internal links. Both packaged standalone
  servers passed local HTTP checks and subsequently passed host readiness.

## Still pending

The existing Google and Apple credentials are loaded and metadata reports both
providers enabled. This does not prove usable social login. The Accounts callback
URLs still need approval and saving in the provider consoles, then real login
verification. Google OAuth remains in Testing mode. No claim of completed Google
or Apple sign-in, email delivery, or SMS delivery is made by this deployment check.

This is a single-host deployment with hourly backups, not high availability.
Operational references and rollback guidance are in `README.md`.

## Silicon Apps integration upgrade

Source `875a30af17a49a8e694e830e7e3ab7107566f0f9` was deployed on the same
instance on 2026-10-08. The additive seventh migration adds app authors while
preserving Accounts users, registry IDs, ownership, and sign-in settings. This
release includes the official Apps catalog sync, private mail delivery, coauthor
webhook management, and scoped verified-email integration. All 874 Rust tests
passed (3 ignored); the ARM64 native release built successfully.

The predeployment dump `backups/predeploy-20261008T124704Z.dump` was uploaded
before migration. Its SHA-256 is
`2c6cbaba7b55b61afdf68dccbd68958e7452d88c587b8b81f677c4a96e3a483b`.
Restoring it to a separate temporary database verified migration 6, zero accounts,
and two built-in apps; that temporary database was then removed. Production now
has migration 7 and the same zero accounts and two apps. The authenticated Apps
registry listing succeeds and is empty, as expected before a genuine production
owner signs up. No local fixture identities were copied and no mail was sent.

Public readiness and all service readiness checks pass. The existing Postmark
provider is configured, but actual mail delivery remains untested. The old
Developer origin is retained until the coordinated DNS cutover. Apps registration
and credential provisioning require a real production owner; they are not
represented as complete by this upgrade. Caddy's Developer hostname now derives
from the matching runtime Developer URLs so that cutover can preserve this
management site at a dedicated hostname.

## Apps registration and Developer hostname cutover

After the user completed a real production signup and chose `c:saket`, the
existing active Carbon's immutable UUID was resolved to `zQo`. The `apps` entry
was registered with that owner and accepted author. Its generated app secret
was verified against the app-authenticated API, then merged with the service
token into the dedicated Apps runtime secret, preserving runner and telemetry
configuration. No account was fabricated or contact verified by the deployment.
Registry export now contains only `apps`; Accounts' two ownerless first-party
entries remain unchanged and are intentionally excluded from export.

The Developer portal moved to
`https://developer.accounts.teamofsilicons.com`. Both authoritative nameservers
and a public resolver confirmed its A record before changing the matching
Accounts/Developer runtime origins. The new site has valid public TLS;
`/auth/session` returns 200 and sign-in returns a PKCE S256 authorization URL with
exact callback `https://developer.accounts.teamofsilicons.com/auth/callback`.
The hosted authorization page returns 200, and `/v1/meta` reports the new origin.
These HTTP checks do not represent a completed new-portal authenticated session.

An initial configuration reapply encountered Linux's `ETXTBSY` protection while
attempting to extract over the running executable, before any service/runtime
file change. Installer revision `6e39cbc0106bc836fec85e84d5f353c31f1f87dd` fixes
that retry path: it verifies every existing bundled file and link and reuses the
immutable release. Its focused preservation/tamper test passes. The checksummed
fixed installer completed the reapply with no pending migrations; the API source
remains `875a30a`, migration 7. The new preconfiguration backup is
`backups/predeploy-20261008T134728Z.dump`, SHA-256
`7dd8d3ac1ecdd6e8d19e7709ac2bf3d6ec5e0863fa0a4ef4b19be25f21bfc894`.
Post-cutover checks confirm one genuine account, three apps, Apps owner `zQo`
and the correct stored Developer callback. The earlier isolated restore test
remains the recovery evidence; this newer backup was uploaded but not restored.

The parent deployment session subsequently confirmed a real Google sign-in and
completed production account setup for `c:saket`, followed by a legitimate
Apps CLI login. Google login is therefore verified; this does not establish
Apple login, SMS, or real-recipient mail delivery. Those independent checks
remain unverified. The old `developer.teamofsilicons.com` DNS record was then
moved to the Apps host by the coordinating deployment session.

## Common developer portal correction and final deployment

The user's subsequent correction keeps the existing Accounts Next developer
frontend and adds Apps authoring there, on
`https://developers.teamofsilicons.com`. The temporary nested hostname above is
historical and now redirects to this common portal. Accounts configuration,
users, imports, proofs and other existing tabs remain alongside publishing,
packages, releases, authors and history. The store has a separate host.

Final deployed source is `6e828d99d449369754bcc63ff32b5d2bbd19b79a`, archive
SHA-256 `4e2ffa0367b4693063ace2a2739f1aa86499e20055d02056741560da0d9b057b`.
The rebuilt ARM64 API SHA-256 is
`77c4bee655eff6c9e37ae90664b2771bd7ae0dfd880a884bb500160f82520f35`.
SSM `aba69391-30bc-4ef7-8a0f-af32bda450f8` applied it; postcheck
`75b6abc3-4f94-4c50-8ba2-c6f36042125c` verified the exact active release and binary,
all four services and the backup timer, migration 7, one genuine account, three
apps and one membership. Apps owner UUID, authors and app secret remain unchanged.
No fixture identity, fake grant or production email was created for these checks.

The pre-cutover backup `backups/predeploy-20261008T142732Z.dump`, SHA-256
`e891291f36b1804cadc6f963b2907fb7a1dd2f637c1b79518490f7ff2efeaa5c`, was restored
into an isolated PostgreSQL database and verified against those counts, schema
version and owner, then dropped (SSM `19755b15-7de8-4e7c-8919-e6ee3d95dced`).
The final documentation reapply also retained a newer backup at
`backups/predeploy-20261008T143304Z.dump`; that redundant newer copy was not restored.

Public TLS, the anonymous session endpoint, Accounts metadata, the exact plural
developer callback and PKCE S256 were verified. The former nested host redirects
to the same path on the plural host. The public common-portal Docs JavaScript,
including CLI 0.1.4 links, matches the local build byte-for-byte (SHA-256
`bc2de8280965451f7f058bf418a06fe06985cd39a55ebc1e4796eb0ea78905fc`). Checks used
the verified destination IP with the correct hostname/SNI while a local resolver
retained a negative DNS cache. After the user reloaded local Unbound, DNS resolved
correctly and the live Chrome accessibility view verified a genuine signed-in
session on `developers.teamofsilicons.com`: the "Your apps" dashboard, account
menu "Saket Gupta", the Silicon Apps entry (`apps`, one user), and "New app" were
visible, with no Explore navigation. This verifies the authenticated common-portal
dashboard on its canonical host. App-specific tabs have not yet been checked in
that production browser session; their local browser tests are separate evidence.

Local validation includes 25 common-portal browser cases, 13 frontend unit tests,
typechecking, zero-warning lint and production builds; 71 Accounts account API
tests, two composed developer-platform tests, and focused coauthor, invitation,
webhook and audience-boundary regressions pass. Apps accepts developer tokens
only on its explicit authoring routes after signature, issuer, expiry and live
Accounts checks; UUID author/admin rules remain in force. Verified email
invitation matching uses the existing first-party self-profile contract, while
Apps-scoped email consent remains unchanged. The Apps registry retains only its
store OAuth callback, with its credentials and other sign-in settings preserved.

## Verification terminology and managed-app history

Source `d5f40ef37e229ddb471784738be7f0664674420e` is deployed with migration 8.
Bundle SHA-256 is `529489b2b9c032f1a5f0482279429467478a0b204251b58777318684c7ec9b0b`;
API SHA-256 is `be842f6d70b6017c757850abe180748fbe214b78a6cefcd96f853b10c51d476f`.
Installer SSM `b9f741b0-6f54-4139-a55e-0ff381bc01ee` and verification SSM
`f6b09cd8-69fb-41f8-b390-842f6791f616` confirmed the exact release, both new
indexes, six active services/timers and database readiness. The genuine account,
three apps and one membership remain; production had and still has zero proof
families/events. No test credentials or fixture records were created.

The common developer portal now has `/app-verification`, listing retained records
for apps the signed-in account currently manages. Filters, cursor pagination,
issuance/refresh/revocation history and one-time token display are tested. App
credentials, Apps-scoped tokens and unrelated users cannot read central history.
Losing author access removes history access; cached rows also disappear when a
refetch reports an authorization denial. ATA/OBO wire values remain compatible,
with App verification/User verification labels across both frontends and docs.

The full Rust workspace suite passed (three existing ignored tests); proofs
all-target Clippy, formatting, both frontend typechecks/lint/builds, 38 portal
browser tests and 13 portal unit tests passed. Forty-two docs pages passed link
checks. Account screenshots cover 36 theme/viewport/state combinations and the
central page was reviewed at desktop/mobile widths in both themes. ARM64 API and
migrator builds passed. CLI labels/aliases are committed source; no new Accounts
CLI/client package release was published as part of this portal deployment.

Public HTTPS pages, API readiness and authentication denials pass. Published
developer and account verification JavaScript matches the tested build exactly.
A genuine signed-in Chrome session for Saket Gupta also verified the central
page, issuing-app/status filters and empty state against zero production proofs.
The retained predeployment dump is `backups/predeploy-20261008T153213Z.dump`,
SHA-256 `7dda2006b0b9d211aea0237c6a16023b32ef28673a0e86a4bc6c1542eee90174`.
This latest backup was uploaded but not separately restored; earlier isolated
restore evidence remains above.

## Manual account verification request and real demo delivery

Source `9b6a701479d7c4912ff1c8be9210861fa2d721b6` is deployed with migration 9.
Bundle SHA-256 is `94c00500345d0cf9f9420f3e8668ce481c65c810a72d4edf36af6f3f1ee92c97`;
API SHA-256 is `bd85e07ded69d47802f3bada4c4de1a4f88c379c16c349168f9bac0abf34de67`.
Installer SSM `44bea589-01e5-4568-941b-4597279110bb` and postcheck
`deb3afa4-fbf2-468f-980b-86214a8c43af` confirmed the exact source/binary, migration,
six active services/timers and readiness. Before the demo, production retained one
account, three apps, one membership and zero proof families; the new request and
notification tables were empty. The predeployment backup is
`backups/predeploy-20261008T154514Z.dump`, SHA-256
`7ef15d66accd51d2c1fadd57bf56e7a0797383f97fe49757994d2eaefdfd3bda`.
It was uploaded; the earlier restore tests remain the separate recovery evidence.

The Sign-in tab now offers a reason-only request for manual account verification
to use the developer's own domain. It explains an up-to-48-hour response estimate
and shows pending review. This release does not implement domain provisioning,
an approval API or an account-verification grant. Only first-party signed-in
current app managers can submit or view their own account-wide request. The
pending uniqueness rule and transaction save one request and two fixed-recipient
outbox rows together; duplicate or concurrent submissions do not enqueue again.
Existing provider delivery remains at-least-once.

The full Rust workspace passed 884 tests (three existing ignored); five new
request API integrations, strict Apps Clippy and formatting passed. The developer
portal passed 46 browser tests, 15 unit tests, typecheck, lint and production build.
The docs check passed all 42 pages and the account web production build passed.
Both themes were visually checked at desktop and mobile widths. Public HTTPS,
API/BFF authentication denials and byte-identical deployed component assets pass.

The user explicitly authorized a demo notification. The existing genuine Chrome
session for Saket Gupta submitted it through the production Sign-in form for
Silicon Apps; the reason starts `DEMO REQUEST` and explicitly asks for no approval
or domain changes. The visible receipt showed Request submitted, Pending review,
the stored reason and a response estimate of October 10 at 21:16 Asia/Kolkata.
The request ID is `01a11c31-8eb1-7368-8c13-375632f0af5d` and remains pending.

Read-only SSM `d980721d-909d-40a2-b54d-adb8fb4ea405` verified the request's exact
two linked outbox records: both sent once, without errors. Postmark returned
non-sandboxed per-recipient Delivered events at `2026-10-08T15:46:13Z` for
`lords@teamofsilicons.com` and `saket@teamofsilicons.com`. This establishes
destination mail-server acceptance, not inbox placement or reading. The verifier
did not send mail or log message bodies/credentials. Its initial download used an
unpermitted object prefix and received 403 before verification; moving that same
checksummed helper under the existing releases prefix succeeded without changing
IAM permissions or resubmitting the request.

## Shared documentation rollout

The common documentation is live at https://developers.teamofsilicons.com/docs.
All 42 Accounts pages are preserved under `/docs/accounts`; nine Apps pages live
under `/docs/apps`, with one shared landing, search and navigation. Markdown,
`/llms.txt` and `/llms-full.txt` include both products. The account site links to
the shared docs; legacy Accounts pages retain their paths under the Accounts
namespace through 308 redirects. The store links and legacy docs route point to
the Apps namespace. No new CLI or crate release was needed for this move.

Final Accounts source `ace71ff0a39ac7b861d8025000c25d3de4cbfdf0`, bundle SHA-256 `79d8c3d4526d8ae99feef009cdbb14ca87134c3a936e0fdc016a4952b52cea2c`,
API SHA-256 `d4019457215edcb6fd1565a75851f677cc6b2be82a6f5c8dc401a63569f7f28d`, migration 9. Install SSM `325d61b3-4e54-4c00-8794-e2dde32311f8` and verification
`bb16fe14-4621-4ca0-8265-2ad3ca1415ad` confirm the exact release, six active services/timers, readiness and
continued anonymous denials on protected verification APIs. The existing demo
request and two notification records remain; no request or email was sent by this
rollout. Backup `backups/predeploy-20261008T162902Z.dump`, SHA-256 `540c6f4ae333ecbb29004300b669ca4d60e388f2a3b7c67aebe78ecd6dd54f8a`, was uploaded;
previous restore evidence remains separate.

Apps source `0f41edef91d6de61a3770d2f791a4e352a35f2ae` supplies the store links and
Caddy redirects. Bundle SHA-256 is
`857a45c0284559835bc63475659b1e0c2b111a831e7dd6cd62e6e6348f0fe454`.
Its API binary and worker are unchanged. Install `679b906f-4b26-4de3-9079-e66c87e2d7d1` and verification
`5bcebb0e-9a5e-48b0-a599-0f504540874a` confirm the release, services, catalog and database integrity.

Validation passed: 884 Rust tests (three existing ignored), frontend typechecks,
lint and builds, 18 developer unit tests, four account-site redirect tests,
52 developer browser tests and 18 store browser tests. The initial live crawl
found that Next normalized the standalone listener's 127.0.0.1 origin to localhost,
causing an internal missing-page rewrite to attempt TLS to the HTTP listener.
The final release enables the supported `skipProxyUrlNormalize` flag and preserves
raw origins for rewrites/relative legacy redirects. A new standalone regression
passes 22 route/header combinations with production Host/forwarded-HTTPS headers,
including valid pages, unknown-page 404s, Markdown, aliases, CSP and HSTS.

The final live crawl checked all 52 pages, 663 search records,
5166 rendered internal links, raw Markdown/LLM exports,
canonical metadata, legacy redirects and metadata/discovery documentation URLs.
Production IAB verification showed the shared landing and search results from both
products. Local visual checks covered light/dark at 320/1440 px and mobile theme
switching; the store's public browser/CSP/assets/installer/API checks also passed.

## Documentation source buttons removed

Removed Edit on GitHub and View as Markdown from the shared article header and
sidebar, including the empty landing-page metadata row and unused styles. Updated
the landing copy to stop referring to the removed button; raw Markdown remains
available. Developer typecheck, lint, 18 unit tests and production build passed.

Source `7213a42e6e63499fa23748f9296b74876522b3ac`, bundle SHA-256 `e80d9713076d81dc5f6cf13ad62aa5e9ffc56dab1352d656df5086ccc63cb761`.
The API and account-site build are unchanged. Install SSM `1102475d-4ac3-445c-a2db-10e8a62768c5` and
verification `01c3d529-55ff-40cd-ad25-91dc8b484c43` confirmed the release, services and readiness. The live
browser checked the landing, an Apps guide and an Accounts guide at 1440 and
390 pixels: both controls absent, titles visible, no horizontal overflow or browser
errors, and Markdown still served successfully. Screenshots were inspected.
Backup `backups/predeploy-20261008T163809Z.dump`, SHA-256 `820b71427cc20d1812c7dd7b619bc635f019353f173a63c91c3cbc91a8fdce77`.

## Documentation readability pass

Revised all 52 public pages using the plain language of the sibling Silicon
understanding documents, with precise inputs, limits and outcomes retained.
Updated shared landing copy, navigation summaries, exports and authoring guidance.
Removed em dashes from public documentation and corrected outdated deployment
and publication notes. Requirements documents were not changed.

Source `d99cce8364d01dacbf511dc1cd470e02ba1ea6ff`, bundle SHA-256 `69cf43eb966b6b15339dd00555bdc64d091b6ca02beace85a05a5097b67643f3`.
Both frontends were rebuilt. The API binary and migration 9 remain unchanged.
Install SSM `2cf60c5e-e623-431c-95dd-2623d2054824` and verification `387fb013-6eaa-4025-b320-9bb1b0af4bd0` confirmed the release,
services, readiness and protected-route authentication. Backup
`backups/predeploy-20261008T170144Z.dump`, SHA-256 `558888940edcb18365ac5800c7a805b02b8f76ed61d8a7154f935c6ad14aac99`.

Developer typecheck, lint, 18 unit tests, production build and 6 documentation
browser tests passed. Accounts web typecheck, lint, 4 redirect tests and production
build passed. The structural audit retained all 758 existing heading anchors and
703 fenced code blocks, allowing punctuation-only changes to 8 sample error
messages. Documentation link checks and git diff checks passed.

The live crawl checked all 52 pages, 663 search records,
5167 internal links, legacy redirects, metadata,
unknown-page 404s and machine-readable exports. All 52 raw Markdown exports
matched the committed source byte for byte. Search and LLM exports contain no em
dashes. Live browser checks covered the landing, publishing and sign-in guides
in light and dark themes at 1440 and 390 pixels, with no horizontal overflow,
page errors or removed source buttons. Screenshots were inspected.
