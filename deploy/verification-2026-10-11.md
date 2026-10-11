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

## Accounts 37d5688: Writings look, light only, no telemetry (account and developer sites)

PR #8, at the Carbon's request. Account site: the look of Silicon Writings and the Silicon Apps store (cream paper,
ink, blue serif titles, Geist Pixel wordmark, fonts preloaded with `font-display: block`), light only, the new Silicon
Accounts mark everywhere (icons, favicon, og.png, hosted first-party sign-in, Powered by, SDK), the dock trimmed to
this site's six sections (Developers and Docs moved to the top row, the phone sheet's foot and the palette), a calm
one-column landing page without FAQ, and no telemetry (`X-Accounts-Telemetry: off` on every call, `sa_telemetry=off`
always set, no setting). Developer site: the same look, light only; the home page's hero is Sign in plus Read the docs
(was five buttons), no FAQ; console pages in one pill; no telemetry (the `/api` proxy and sign-in routes send both
opt-out headers, `POST /telemetry` refused, `/settings` redirects to `/apps`). No Rust, migration, installer or packager
change since 45fa28c; same binaries.

Preflight: web typecheck, lint, 28 tests, build, screenshots at 1440 and 390; developer typecheck, lint, 40 tests, e2e
61 passed, build. Archive `releases/37d5688f08d1e22168cce6c4f1239e9edda321f3.tar.gz`, 154934364 bytes, SHA-256
`46932a17f6f54a10c083ff1f1f0ac4275de66cd99de2e7fcf0c92b61dff3ed03`, S3 version `kacUD1lnKMPxiEyHhfdKm6BsSKyUooOR`; its
`install.py` matches the committed one. Before: `current` was `releases/45fa28c…`.

Install SSM `3f4824e6-bdb3-48f3-bfa9-cb2bf92878ba`: nothing to migrate (20 applied, latest 0020), readiness passed,
`current` is `releases/37d5688…`, four services active.

Live: accounts `/`, `/readyz`, `/settings`, `/icon.svg`, `/og.png` 200, the new landing copy present, `icon.svg`
byte-identical to the repository; developer `/`, `/docs`, `/status`, `/llms.txt` 200, the hero has one primary and one
secondary action, no theme switch or FAQPage, `og.png` byte-identical; `/settings` redirects to `/apps`. A headless
browser loaded both home pages with BDO Grotesk, Hedvig Letters Serif and Geist Pixel Square, `data-theme="light"`,
and no console errors.
