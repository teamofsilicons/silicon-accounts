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
