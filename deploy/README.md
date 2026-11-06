# Silicon Accounts production

AWS profile `silicon-production`, account `234951665042`, region `us-east-2`.
`stack.json` provisions a dedicated ARM64 EC2 host, encrypted retained disk,
fixed public IP, SSM administration (no SSH ingress), private release/backup
bucket, and an instance role scoped to the Accounts secret and bucket.

Accounts API, account site, developer portal, and Caddy run as separate systemd
users. PostgreSQL and application ports bind to loopback; only HTTP/HTTPS are
public. Caddy overwrites incoming X-Forwarded-For with the actual peer address.
Production secrets reside in Secrets Manager and root-only environment files.
The Accounts site uses `accounts.teamofsilicons.com`. The management portal host is
derived from the matching `ACCOUNTS_DEVELOPER_URL` and `DEVELOPER_PUBLIC_URL` secret
fields, both set to `https://developers.teamofsilicons.com`. This common Next portal
preserves Accounts settings and adds Apps publishing in the same app workspace.
Its server-side Apps proxy uses `APPS_API_URL=https://apps.teamofsilicons.com` and
the sealed first-party developer session. The former nested developer hostname
redirects to the canonical portal; Silicon Apps hosts the store separately.
Provision destination DNS before changing origins; the runtime validates the
first-party callback at exactly `/auth/callback` on that origin. An OAuth flow
started on a former hostname must restart; host-only cookies are never copied.
Preserve all unrelated DNS records.

## Release

1. Run workspace tests and both frontend checks. Build API and migration binaries
   using `cargo zigbuild --locked --release --target aarch64-unknown-linux-gnu.2.34
   -p silicon-accounts-server --bin accounts-api --bin accounts-migrate --bin accounts-migrate-uuids`.
2. Build `web` with `ACCOUNTS_API_URL=http://127.0.0.1:8589` and the production
   public/developer URLs. Build `developer`. Download Node 24.21.0 ARM64 and Caddy
   2.11.7 ARM64 from official releases, verify upstream checksums, and place archives
   under ignored `.dev/production/`.
3. Commit source and run `python3 deploy/package.py`. Upload the archive under
   `releases/` in the stack bucket. Record SHA-256 and source revision.
4. Via SSM fetch the archive, verify SHA-256 before extracting `install.py`,
   then invoke it with `--archive`, `--sha256`, `--revision`, `--secret`, `--bucket`, `--region`.
   The installer retains a database dump before migration, migrates, switches the
   release symlink, starts services, and checks local readiness. Secrets must never
   appear in SSM commands or output.
   Silicon Accounts records no telemetry: the installer leaves the retired
   `ACCOUNTS_TELEMETRY_ENABLED` and `ACCOUNTS_TELEMETRY_TABLE_KEY` out of
   `/etc/accounts/api.env` (printing their names) if the secret still holds them;
   remove them from the secret.
5. Verify public HTTPS, `/readyz`, `/v1/meta`, discovery, developer authentication
   redirect and real provider flows. Provider console callbacks must include
   `https://accounts.teamofsilicons.com/v1/oauth/callback/google` and `/apple`.
   A redirect reaching a provider is not proof of a completed sign-in.

## Backups and recovery

`accounts-backup.timer` sends hourly PostgreSQL custom dumps to the private bucket;
local copies expire after three days, S3 dumps after fourteen days. Bucket versioning
is enabled. Instance disk and backup bucket are retained on stack deletion;
termination protection is enabled. The initial single-host deployment has
host-level downtime risk and an hourly database recovery point.

For a code-only rollback, inspect `/opt/accounts/previous-release`, verify schema
compatibility, restore `/opt/accounts/current` to that release and restart the API,
web, developer and Caddy services. Never roll back code blindly after a migration.
For database recovery, stop writers, restore a selected dump to a new database,
validate it, then deliberately change the configured database URL. Retain the old
database until verification completes.

The standard account UUID cutover is a separate offline operation. Follow
[the coordinated UUID runbook](../docs/operations/account-uuid-migration.md); the
installer applies only additive schema migrations and never backfills identities
automatically.

## Local Accounts frontend against production

`http://localhost:9100` is the explicit development origin for the Accounts frontend.
Keep it in `ACCOUNTS_EXTRA_ALLOWED_ORIGINS` in Secrets Manager and `/etc/accounts/api.env`.
Start the frontend with `scripts/dev-live.sh`; its API rewrites target the public HTTPS
Accounts origin. This is a same-origin local proxy, not credentialed CORS.

First-party Google/Apple flows returning to an explicitly allowed `http://localhost`
origin park their provider answer on the production API, redirect an opaque single-use
ticket to the local callback proxy, and require the original flow cookie there before
exchanging the provider code. The registered provider callback stays on production.
Other apps do not get this handoff. Do not add wildcard origins or disable cookie security.

## Automatic Silicon Accounts registration — 2026-11-06

Migration 0037 registers all non-deleted identities with `silicon-accounts` and installs an
account INSERT trigger for future registrations. Production now has 10/10 active Carbons
and 11/11 active Silicons registered. The deleted Silicon remains a tombstone without a new
membership. The migration creates no sessions or sign-in timestamps and grants no other app
access. Existing memberships are preserved.

The rollout changed only the embedded `accounts-migrate` binary in a verified copy of the
current composite release. API, web, Developer, Node, and Caddy files were unchanged; no
service restart was needed. Source is based on the deployed interface broker revision, not
the older `main` snapshot. Future full releases must include migrations 0029–0037 and retain
the current composite frontend builds. The historical component revisions in production.json
are not an authoritative description of this composite release.

Receipt: [verification-automatic-registration-2026-11-06.json](verification-automatic-registration-2026-11-06.json).
The predeployment PostgreSQL backup was verified and uploaded. Production checks covered
complete membership coverage, idempotent rerun, migration readiness, and Carbon/Silicon
creation in a rolled-back transaction. Local verification: 348 integration tests passed.

## Contacts basic directory access — 2026-11-06

The API now supports an explicit `ACCOUNTS_PROFILE_DIRECTORY_APP_IDS` operator grant, empty
by default. Production enables only `silicon-contacts`, persisted in the Accounts runtime
secret and service environment. This grants name/photo lookup for active identities with an
active Accounts registration; it grants no private contact fields or first-party sessions.

API source `afaf544a0a667e8ae7d556aa3e6c2cac8fd60a93` was built from the deployed registration/
interface broker source. Deployment preserved all other files in the current composite
release, including migration 0037, Accounts web, and Developer. Both API services passed
readiness. The integrated Contacts add-contact preview was verified in a production browser
as `si:saket-agents`, without saving a contact.

Receipt: [verification-contacts-directory-2026-11-06.json](verification-contacts-directory-2026-11-06.json).
