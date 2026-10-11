# Production verification, 2026-10-12

## Accounts 81c601c: no telemetry (0.6.0)

PR #10, at the Carbon's request ("remove telemetry from the services and CLIs too, no telemetry"). The service,
worker, CLI and client record and send nothing: the Space Station dependency is gone, `POST /v1/telemetry/events`
answers 404, `X-Accounts-Telemetry` and the `sa_telemetry` cookie are accepted and ignored, and the CLI's telemetry
settings are hidden no-ops. Logs, audit records, rate limiting and security checks are unchanged. No migration.

Preflight (in the telemetry worktree): Rust fmt, check, clippy, tests for every crate against a private Postgres 16,
`deploy/test_install.py`, web typecheck/lint/28 tests, developer typecheck/lint/40 tests. ARM64 binaries built with
`cargo zigbuild --locked --release --target aarch64-unknown-linux-gnu.2.34`; web (with
`ACCOUNTS_API_URL=http://127.0.0.1:8589`) and developer production builds.

Archive `releases/81c601c1de1d9e40fb10d5d91922fa3942849ea5.tar.gz`, 154,389,950 bytes, SHA-256
`ca57566ffebdebc1f0df31cbc3362f1c095574a262a40c204bfd2ec96a60f41d`, S3 version `fCejmCzYenjvye9NVmbrYfZscV6MdXuP`.
SSM `1ae8f66b-da64-4012-b3d6-71d2b9abb7cd`: migrations up to date (20 applied, none pending), configuration valid,
local API, site and developer readiness passed; `current` is `releases/81c601c…`; API, web, developer and Caddy active.

Live: `GET /v1/meta` reports 0.6.0; `POST /v1/telemetry/events` 404; JWKS with `X-Accounts-Telemetry: on` 200;
accounts and developers sites 200. No retired-variable warning at boot.

CLI: nine native archives from package-artifacts run 38177249577, published in Silicon Apps as `silicon-accounts`
0.6.0 (production release `98c359ba-55b5-5f87-b9f7-93d7d5902806`, silicon-apps deploy/verification-2026-10-12.md).
GitHub release `v0.6.0`; crates.io `silicon-accounts-client` and `silicon-accounts-cli` 0.6.0. A managed macOS install
updated itself to 0.6.0.
