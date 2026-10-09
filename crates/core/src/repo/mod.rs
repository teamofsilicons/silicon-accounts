//! Repositories: every SQL statement shared by the feature crates.
//!
//! Functions take `&mut PgConnection` — pass `&mut tx` for a transaction or `&mut conn` for a
//! pooled connection — and return [`crate::ApiResult`] with precise errors. Multi-statement
//! functions open a nested transaction (a savepoint when the caller already has one), so they
//! are atomic either way.
//!
//! A few functions take `&PgPool` because they must persist a failure even when the request
//! fails: [`otp::verify`], [`tokens::refresh`], [`tokens::consume_code`],
//! [`tokens::consume_slt`], [`tokens::poll_device`], [`accounts::begin_stk_attempt`],
//! [`accounts::stk_attempt_failed`] and the [`idempotency`] helpers.

pub mod accounts;
pub mod apps;
pub mod audit;
pub mod contacts;
pub mod idempotency;
pub mod identities;
pub mod memberships;
pub mod otp;
pub mod photos;
pub mod rate_limit;
pub mod sessions;
pub mod subscriptions;
pub mod tokens;

/// True when a database error is a unique violation (optionally on a given constraint/index).
pub fn is_unique_violation(e: &sqlx::Error, constraint: Option<&str>) -> bool {
    match e {
        sqlx::Error::Database(db) => {
            db.code().as_deref() == Some("23505")
                && match constraint {
                    Some(c) => db.constraint() == Some(c),
                    None => true,
                }
        }
        _ => false,
    }
}

/// True when a database error is a foreign-key violation.
pub fn is_foreign_key_violation(e: &sqlx::Error) -> bool {
    matches!(e, sqlx::Error::Database(db) if db.code().as_deref() == Some("23503"))
}
