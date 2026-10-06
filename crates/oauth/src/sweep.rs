//! Background sweep: deletes grant artifacts long past their expiry (authorization codes,
//! short-lived tokens, device authorizations). They are kept for [`GRANT_RETENTION_DAYS`] days
//! after expiring so late presentations still get a precise "already used"/"expired" answer and
//! a reused authorization code can still revoke the tokens issued from it. Token families and
//! refresh tokens are sign-in history and are never swept here.

use std::time::Duration;

use accounts_core::{ApiResult, AppState};
use sqlx::PgPool;
use tokio::time::MissedTickBehavior;

/// Days an expired authorization code, short-lived token or device authorization is kept.
pub const GRANT_RETENTION_DAYS: i32 = 7;

/// How often the sweep runs.
const SWEEP_EVERY: Duration = Duration::from_mins(15);

/// Rows deleted by one [`purge_expired_grants`] run.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct PurgedGrants {
    pub authorization_codes: u64,
    pub short_lived_tokens: u64,
    pub device_authorizations: u64,
}

impl PurgedGrants {
    /// Rows deleted in total.
    #[must_use]
    pub fn total(&self) -> u64 {
        self.authorization_codes + self.short_lived_tokens + self.device_authorizations
    }
}

/// Deletes authorization codes, short-lived tokens and device authorizations that expired more
/// than [`GRANT_RETENTION_DAYS`] days ago.
///
/// # Errors
///
/// A database failure (503 `database_unavailable` when the pool is exhausted, else 500).
pub async fn purge_expired_grants(pool: &PgPool) -> ApiResult<PurgedGrants> {
    let mut conn = pool.acquire().await?;
    let authorization_codes = sqlx::query(
        "delete from authorization_codes where expires_at < now() - make_interval(days => $1)",
    )
    .bind(GRANT_RETENTION_DAYS)
    .execute(&mut *conn)
    .await?
    .rows_affected();
    let short_lived_tokens = sqlx::query(
        "delete from short_lived_tokens where expires_at < now() - make_interval(days => $1)",
    )
    .bind(GRANT_RETENTION_DAYS)
    .execute(&mut *conn)
    .await?
    .rows_affected();
    let device_authorizations = sqlx::query(
        "delete from device_authorizations where expires_at < now() - make_interval(days => $1)",
    )
    .bind(GRANT_RETENTION_DAYS)
    .execute(&mut *conn)
    .await?
    .rows_affected();
    Ok(PurgedGrants {
        authorization_codes,
        short_lived_tokens,
        device_authorizations,
    })
}

/// Runs the sweep every 15 minutes (the first run is right away). Failures are logged and the
/// next run tries again.
pub(crate) async fn run(state: AppState) {
    let mut every = tokio::time::interval(SWEEP_EVERY);
    every.set_missed_tick_behavior(MissedTickBehavior::Delay);
    loop {
        every.tick().await;
        match purge_expired_grants(&state.db).await {
            Ok(purged) if purged.total() > 0 => tracing::info!(
                authorization_codes = purged.authorization_codes,
                short_lived_tokens = purged.short_lived_tokens,
                device_authorizations = purged.device_authorizations,
                "purged expired grants"
            ),
            Ok(_) => {}
            Err(e) => {
                tracing::warn!(error = %e, "could not purge expired grants; retrying at the next sweep");
            }
        }
    }
}
