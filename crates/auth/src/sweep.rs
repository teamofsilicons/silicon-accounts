//! Cleanup of this crate's tables: sign-in flows a day after they expired, sign-up sessions
//! a week after they expired or were used (kept a little longer for support questions).

use std::time::Duration;

use accounts_core::AppState;
use sqlx::PgPool;
use tokio::task::JoinHandle;

/// How often the sweep runs.
pub const SWEEP_INTERVAL: Duration = Duration::from_secs(15 * 60);

/// Deletes long-expired flows and sign-up sessions; returns (flows, sign-up sessions).
pub async fn run_once(pool: &PgPool) -> Result<(u64, u64), sqlx::Error> {
    let flows = sqlx::query("delete from signin_flows where expires_at < now() - interval '1 day'")
        .execute(pool)
        .await?
        .rows_affected();
    let signups = sqlx::query(
        "delete from signup_sessions where expires_at < now() - interval '7 days' \
         or consumed_at < now() - interval '7 days'",
    )
    .execute(pool)
    .await?
    .rows_affected();
    Ok((flows, signups))
}

/// Starts the sweep loop.
pub fn spawn(state: AppState) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(SWEEP_INTERVAL);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tick.tick().await;
            match run_once(&state.db).await {
                Ok((0, 0)) => {}
                Ok((flows, signups)) => {
                    tracing::debug!(
                        flows,
                        signups,
                        "swept expired sign-in flows and sign-up sessions"
                    );
                }
                Err(e) => tracing::warn!(error = %e, "sign-in sweep failed; will retry"),
            }
        }
    })
}
