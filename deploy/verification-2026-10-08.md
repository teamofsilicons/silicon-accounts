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
