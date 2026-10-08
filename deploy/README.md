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
fields, allowing it to move to `developer.accounts.teamofsilicons.com` while Silicon
Apps takes over `developer.teamofsilicons.com`. Provision the destination DNS before
changing these fields; the runtime validates the first-party callback at that origin.
Preserve all unrelated DNS records.

## Release

1. Run workspace tests and both frontend checks. Build API and migration binaries
   using `cargo zigbuild --locked --release --target aarch64-unknown-linux-gnu.2.34
   -p silicon-accounts-server --bin accounts-api --bin accounts-migrate`.
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
