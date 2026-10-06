//! The custodian-request expiry sweep: every minute, pending requests past their 14 days become
//! `expired`; an initial one also releases its Silicon and sends `silicon.custodian.expired`
//! (see [`crate::lifecycle::expire`]). It also releases self-created Silicons left waiting on a
//! request that was cancelled because the Carbon they named deleted their account
//! ([`crate::lifecycle::release_orphan`]). Safe on many nodes at once: rows are claimed with
//! `for update skip locked`, and each request is handled in its own savepoint so one bad row
//! never blocks the rest.

use std::time::Duration;

use accounts_core::error::ApiResult;
use accounts_core::state::AppState;
use sqlx::Connection;
use tokio::task::JoinHandle;
use tokio::time::MissedTickBehavior;

use crate::{lifecycle, requests};

/// How often the sweep runs.
pub const SWEEP_INTERVAL: Duration = Duration::from_secs(60);

/// Requests handled per transaction.
const BATCH: i64 = 100;

/// What one sweep did.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SweepReport {
    /// Requests expired.
    pub expired: usize,
    /// Self-created Silicons released because their named custodian deleted their account.
    pub released_orphans: usize,
    /// Requests that failed (retried by the next sweep).
    pub failed: usize,
}

/// Expires every overdue pending custodian request now, then releases orphaned self-created
/// Silicons (see the module docs).
pub async fn expire_overdue(state: &AppState) -> ApiResult<SweepReport> {
    let mut report = SweepReport::default();
    loop {
        let mut tx = state.db.begin().await?;
        let due = requests::lock_overdue(&mut tx, BATCH).await?;
        let mut expired_now = 0;
        for request in &due {
            let mut savepoint = Connection::begin(&mut *tx).await?;
            match lifecycle::expire(&mut savepoint, request).await {
                Ok(()) => {
                    savepoint.commit().await?;
                    expired_now += 1;
                }
                Err(e) => {
                    let _ = savepoint.rollback().await;
                    report.failed += 1;
                    tracing::error!(request = %request.id, error = %e, "could not expire a custodian request; the next sweep retries it");
                }
            }
        }
        tx.commit().await?;
        report.expired += expired_now;
        // A short batch means nothing is left; a batch that only failed would loop forever.
        if (due.len() as i64) < BATCH || expired_now == 0 {
            break;
        }
    }
    let mut tx = state.db.begin().await?;
    for request in requests::lock_orphaned(&mut tx, BATCH).await? {
        let mut savepoint = Connection::begin(&mut *tx).await?;
        match lifecycle::release_orphan(&mut savepoint, &request).await {
            Ok(released) => {
                savepoint.commit().await?;
                report.released_orphans += usize::from(released);
            }
            Err(e) => {
                let _ = savepoint.rollback().await;
                report.failed += 1;
                tracing::error!(request = %request.id, error = %e, "could not release an orphaned Silicon; the next sweep retries it");
            }
        }
    }
    tx.commit().await?;
    Ok(report)
}

/// Starts the sweep loop (first run immediately, then every [`SWEEP_INTERVAL`]).
pub fn spawn(state: AppState) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(SWEEP_INTERVAL);
        ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);
        loop {
            ticker.tick().await;
            match expire_overdue(&state).await {
                Ok(r) if r == SweepReport::default() => {}
                Ok(r) => tracing::info!(
                    expired = r.expired,
                    released_orphans = r.released_orphans,
                    failed = r.failed,
                    "custodian request sweep"
                ),
                Err(e) => tracing::error!(
                    error = %e,
                    "custodian request sweep failed; it runs again in a minute"
                ),
            }
        }
    })
}
