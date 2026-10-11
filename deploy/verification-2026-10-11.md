# Production verification, 2026-10-11

## Accounts 38fab27: the Apps tag filter leaves the docs

Why: Silicon Apps' API dropped its `tags` search filter (silicon-apps 0861354). `developer/llms/llms-full.md`
(edited at the Carbon's request) and `docs-apps/reference/api.md` now say `q` also matches tags and that a request
with `tags` answers 400 pointing to `q` (PR #6).

Before: the host ran `ui-22af27d` (API binary `f74e9b51…`, migration 0020). `git diff 22af27d 38fab27` is the two docs
files and `.github/workflows/managed-install.yml`; no Rust, migration, installer or packager change.

Preflight: web typecheck, lint, 28 tests; developer typecheck, lint, 39 tests; both production builds (web with
`ACCOUNTS_API_URL=http://127.0.0.1:8589`, the only build-time value). ARM64 binaries built with `cargo zigbuild --locked
--release --target aarch64-unknown-linux-gnu.2.34` from the same Rust source as the live release. The full Rust
workspace was not re-run (no Rust change since the last verified release).

Archive `releases/38fab272ec329d1e9949b03c371e4e667d68384a.tar.gz` in the backups bucket, 155194460 bytes, SHA-256
`7bca79ce3e46c3876e280e0ba0bd08f6ea2e2be75358cf0eaf1308842b0a1398`, S3 version `0h9OmXoJXbd7QvkuRVncyFNgT_.kP5dE`; its
`install.py` matches the committed one.

Install SSM `1ff6509a-095b-498f-bf60-ab4dca524f54` verified the archive SHA-256 before extracting the installer;
`accounts-migrate` found nothing pending (20 applied, latest 0020); local API, site and developer readiness passed;
`current` is `releases/38fab27…`; accounts-api, accounts-web, accounts-developer and accounts-caddy active.

Public checks: `developers.teamofsilicons.com/llms-full.txt` no longer lists `tags=` and carries the new line; the
Apps API reference page says the same; developer `/`, `/docs`, `/llms.txt`, `/status` 200; accounts `/`, `/readyz`,
`/v1/meta` (version 0.5.0), `/llms.txt` 200.

## Accounts 45fa28c: llms.md tag line

PR #7: `developer/llms/llms.md` now says tags help people find an app when they search (edited at the Carbon's
request). Docs only; same binaries and web build as 38fab27, developer site rebuilt (typecheck, lint, 39 tests).
Archive `releases/45fa28c38a1d5c379cac484c53329559ff22da6e.tar.gz`, SHA-256
`410f9f63e6e8fac887536e5e52c6d19a390c4b624655fdc288b0c495fd8878c4`, S3 version `P1128mkxYgRPTZshix81MxITOYmZgwv7`.
Install SSM `a21c1ab8-67cc-4e3f-9385-7727163e3638`: nothing to migrate, readiness passed, four services active.
Live: `developers.teamofsilicons.com/llms.txt` carries the new line and not the old one.
