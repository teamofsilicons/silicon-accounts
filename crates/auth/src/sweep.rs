//! Cleanup of this crate's tables: sign-in flows a day after they expired, sign-up sessions
//! a week after they expired or were used (kept a little longer for support questions), and
//! the photos uploaded on sign-up pages that never became an account's photo (as soon as their
//! sign-up expired or was used).

use std::time::Duration;

use accounts_core::AppState;
use sqlx::PgPool;
use tokio::task::JoinHandle;

/// How often the sweep runs.
pub const SWEEP_INTERVAL: Duration = Duration::from_secs(15 * 60);

/// Rows one sweep deleted.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SweepReport {
    pub flows: u64,
    pub signup_sessions: u64,
    /// Sign-up photos whose sign-up expired or finished without them.
    pub signup_photos: u64,
}

/// Deletes long-expired flows and sign-up sessions, and the uploads of sign-ups that ended.
pub async fn run_once(pool: &PgPool) -> Result<SweepReport, sqlx::Error> {
    let signup_photos = accounts_core::repo::photos::sweep_signup_photos(pool).await?;
    let flows = sqlx::query("delete from signin_flows where expires_at < now() - interval '1 day'")
        .execute(pool)
        .await?
        .rows_affected();
    let signup_sessions = sqlx::query(
        "delete from signup_sessions where expires_at < now() - interval '7 days' \
         or consumed_at < now() - interval '7 days'",
    )
    .execute(pool)
    .await?
    .rows_affected();
    Ok(SweepReport {
        flows,
        signup_sessions,
        signup_photos,
    })
}

/// Starts the sweep loop.
pub fn spawn(state: AppState) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(SWEEP_INTERVAL);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tick.tick().await;
            match run_once(&state.db).await {
                Ok(report) if report == SweepReport::default() => {}
                Ok(report) => {
                    tracing::debug!(
                        flows = report.flows,
                        signup_sessions = report.signup_sessions,
                        signup_photos = report.signup_photos,
                        "swept expired sign-in flows, sign-up sessions and sign-up photos"
                    );
                }
                Err(e) => tracing::warn!(error = %e, "sign-in sweep failed; will retry"),
            }
        }
    })
}
