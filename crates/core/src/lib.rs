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
//!   request fails (OTP verification, refresh-token reuse, code consumption, idempotency) take
//!   `&PgPool` and manage their own transaction.
//! - Errors are [`ApiError`] (non-OAuth endpoints) or [`OAuthError`] (`/v1/oauth/*`). Every
//!   message says exactly what was wrong and why; every hint says what to do next.
//! - Time comes from Postgres `now()` wherever a TTL is enforced, so tests can time-travel by
//!   editing rows and app/database clock skew never matters.

pub mod config;
pub mod crypto;
pub mod db;
pub mod delivery;
pub mod error;
pub mod events;
pub mod http;
pub mod ids;
pub mod jwt;
pub mod models;
pub mod normalize;
pub mod pfp;
pub mod repo;
pub mod state;
pub mod telemetry;
pub mod timefmt;
pub mod views;

#[cfg(feature = "test-support")]
pub mod test_support;

pub use config::{Environment, Settings};
pub use error::{ApiError, ApiResult, FieldErrors, OAuthError};
/// Re-exported because [`Settings`] holds `secrecy::SecretString` fields
/// (`use accounts_core::secrecy::ExposeSecret;` to read them).
pub use secrecy;
pub use state::{AppState, Keys};

/// The `app_id` of the first-party app: the account site and the accounts CLI.
pub const FIRST_PARTY_APP_ID: &str = "accounts";

/// Product name used in copy, emails and the `Powered by` line.
pub const PRODUCT_NAME: &str = "Silicon Accounts";

/// The public site of Silicon Accounts (the `Powered by Silicon Accounts` link target).
pub const PRODUCT_SITE: &str = "https://account.teamofsilicons.com";

/// Version of the running service (from Cargo).
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
