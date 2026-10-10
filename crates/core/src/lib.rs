//! # Silicon Accounts core (`accounts_core`)
//!
//! The shared foundation of every server crate (auth, account, silicons, apps, proofs, worker,
//! server). Feature crates only use what this crate exposes, so all shared domain rules live
//! here: configuration, database access and migrations, the API error shape, account ids and
//! uuids, cryptography, JWTs, domain models, API views, input normalization, repositories,
//! webhook events, outbound email/SMS, telemetry and the HTTP extractors.
//!
//! Start with `crates/core/README.md`: it maps every module and shows the exact functions to
//! call for each job.
//!
//! Conventions every module follows:
//! - Repository functions take `&mut PgConnection`; pass `&mut tx` (a transaction) or
//!   `&mut conn` (a pooled connection). The few that must persist a failure even when the
//!   request fails (OTP verification, refresh-token reuse, code consumption, the STK attempt
//!   gate, idempotency) take `&PgPool` and manage their own transaction.
//! - Errors are [`ApiError`] (non-OAuth endpoints) or [`OAuthError`] (`/v1/oauth/*`). Every
//!   message says exactly what was wrong and why; every hint says what to do next.
//! - Expiries and locks stored in the database (codes, SLTs, device codes, token families, OTP
//!   challenges and their cooldowns, sign-up sessions, reservations, rate limits) are stamped and
//!   compared with Postgres `now()`, so tests can time-travel by editing rows and the API nodes'
//!   clocks don't matter for them. A JWT's own `exp`/`nbf` are checked with the node's clock
//!   (30 s leeway on `nbf`), as JWTs are; timestamps written into payloads (`occurred_at`) and
//!   telemetry also use the node's clock.

pub mod access;
pub mod config;
pub mod crypto;
pub mod db;
pub mod delivery;
pub mod error;
pub mod events;
pub mod federation;
pub mod http;
pub mod identity_tokens;
pub mod ids;
pub mod image;
pub mod jwt;
pub mod models;
pub mod normalize;
pub mod pfp;
pub mod photo_upload;
pub mod repo;
pub mod silicon_keys;
pub mod state;
pub mod telemetry;
pub mod timefmt;
pub mod uuid_migration;
pub mod views;

#[cfg(feature = "test-support")]
pub mod test_support;

pub use config::{Environment, Settings};
pub use error::{ApiError, ApiResult, FieldErrors, OAuthError};
/// Re-exported because [`Settings`] holds `secrecy::SecretString` fields
/// (`use accounts_core::secrecy::ExposeSecret;` to read them).
pub use secrecy;
pub use state::{AppState, Keys};

/// The `app_id` of the first-party app: the account site and the silicon-accounts CLI.
pub const FIRST_PARTY_APP_ID: &str = "silicon-accounts";

/// Resolve the former first-party client ID at upgrade boundaries only.
/// Keep ordinary app identities exact and reserve both spellings.
pub fn canonical_first_party_app_id(app_id: &str) -> &str {
    if app_id == "accounts" {
        FIRST_PARTY_APP_ID
    } else {
        app_id
    }
}

/// The `app_id` of the developer platform (developers.teamofsilicons.com): a first-party public
/// client (no secret, PKCE required) whose tokens (`aud = developer`) may only read the
/// signed-in Carbon's identity and manage the apps they own (see `http::auth`).
pub const DEVELOPER_APP_ID: &str = "developer";

/// Canonical app identity for the Silicon Apps catalog and CLI.
pub const SILICON_APPS_APP_ID: &str = "silicon-apps";

/// True for Silicon Accounts' own apps (`silicon-accounts`, `developer`): no consent screen, no
/// membership, and their sign-ins are never reported to app webhooks.
pub fn is_first_party_app_id(app_id: &str) -> bool {
    app_id == FIRST_PARTY_APP_ID || app_id == DEVELOPER_APP_ID
}

/// Product name used in copy, emails and the `Powered by` line.
pub const PRODUCT_NAME: &str = "Silicon Accounts";

/// The public site of Silicon Accounts (the `Powered by Silicon Accounts` link target).
pub const PRODUCT_SITE: &str = "https://accounts.teamofsilicons.com";

/// Version of the running service (from Cargo).
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
