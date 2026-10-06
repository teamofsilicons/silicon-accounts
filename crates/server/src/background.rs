//! Background tasks of every crate, started by `accounts-api` when ACCOUNTS_WORKER_ENABLED.
//!
//! The worker's loops (webhooks, outbound messages, cleanup) stop gracefully: once asked, they
//! stop claiming work and let the sends in flight finish. A loop only ever holds claims on what
//! it is sending right now, and a send is cut at its 10 s HTTP timeout, so that takes about one
//! send timeout. [`BackgroundTasks::shutdown`] waits `grace` for it (accounts-api: 20 s) and
//! then aborts whatever still runs (only a stalled database keeps a send that long). An aborted
//! send stays claimed, so another node, or this one after a restart, retries it once its 60 s
//! claim ends: delivery is at-least-once, and webhook receivers dedupe by `event_id`.
//!
//! The other crates' tasks (sweeps such as custodian-request expiry, import jobs) are aborted at
//! once; their work is transactional and resumes on the next start.

use std::time::Duration;

use accounts_core::AppState;
use tokio::sync::watch;
use tokio::task::{AbortHandle, JoinHandle};

/// Running background tasks. Keep it for the life of the service and call
/// [`BackgroundTasks::shutdown`] when stopping: dropping it stops the worker loops (they read a
/// dropped stop signal as "stop"), while the other crates' tasks keep running detached.
#[must_use = "dropping BackgroundTasks stops the worker loops; keep it and call shutdown() when the service stops"]
pub struct BackgroundTasks {
    graceful: Vec<JoinHandle<()>>,
    others: Vec<JoinHandle<()>>,
    stop: watch::Sender<bool>,
}

impl std::fmt::Debug for BackgroundTasks {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BackgroundTasks")
            .field("graceful", &self.graceful.len())
            .field("others", &self.others.len())
            .finish()
    }
}

/// Starts the background tasks of every crate.
pub fn spawn_background(state: &AppState) -> BackgroundTasks {
    let (stop, rx) = watch::channel(false);
    let graceful =
        accounts_worker::spawn_background_until(state.clone(), accounts_worker::Shutdown::new(rx));
    let mut others = Vec::new();
    others.extend(accounts_auth::spawn_background(state.clone()));
    others.extend(accounts_oauth::spawn_background(state.clone()));
    others.extend(accounts_account::spawn_background(state.clone()));
    others.extend(accounts_silicons::spawn_background(state.clone()));
    others.extend(accounts_apps::spawn_background(state.clone()));
    others.extend(accounts_proofs::spawn_background(state.clone()));
    BackgroundTasks {
        graceful,
        others,
        stop,
    }
}

impl BackgroundTasks {
    /// No tasks (ACCOUNTS_WORKER_ENABLED=false).
    pub fn none() -> BackgroundTasks {
        BackgroundTasks {
            graceful: Vec::new(),
            others: Vec::new(),
            stop: watch::channel(false).0,
        }
    }

    /// Number of running tasks.
    pub fn len(&self) -> usize {
        self.graceful.len() + self.others.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Asks the worker loops to stop (they finish the sends in flight), waits up to `grace` for
    /// them, and aborts everything else at once (and any loop still running after `grace`).
    pub async fn shutdown(self, grace: Duration) {
        let _ = self.stop.send(true);
        for task in &self.others {
            task.abort();
        }
        let aborts: Vec<AbortHandle> = self.graceful.iter().map(|h| h.abort_handle()).collect();
        let pending = self.graceful.len();
        if tokio::time::timeout(grace, futures::future::join_all(self.graceful))
            .await
            .is_err()
        {
            tracing::warn!(
                tasks = pending,
                grace_seconds = grace.as_secs(),
                "background tasks did not stop in time; aborting them (sends cut off stay claimed and are retried when their 60 s claim ends)"
            );
            for a in aborts {
                a.abort();
            }
        }
    }
}
