//! # silicon-accounts-worker (`accounts_worker`)
//!
//! The background work of Silicon Accounts. Nothing here serves HTTP; `accounts-api` starts
//! these loops when ACCOUNTS_WORKER_ENABLED is true, and any number of API nodes may run them
//! at once. Every row is claimed with `FOR UPDATE SKIP LOCKED` for 60 s, and a claim never
//! outlives its work ([`pipeline`]): a loop claims only as many rows as it can send at once and
//! starts each the moment it is claimed, a send is cut at its 10 s HTTP timeout, and anything
//! still running 50 s after its claim is abandoned. So no two nodes ever send the same webhook
//! or message at the same time. A node that stops or crashes mid-send leaves its claims to run
//! out and another node retries them: delivery is at-least-once (webhook receivers dedupe by
//! `event_id`).
//!
//! - [`webhooks`]: delivers `webhook_deliveries` (app and Silicon webhooks). Each attempt POSTs
//!   the stored event body, signed with the target's *current* secret, to the target's *current*
//!   URL; a 2xx within 10 s is delivered, anything else is retried 10 s, 30 s, 1 min, 5 min,
//!   15 min, 30 min, then hourly until 72 h after the event → `failed` (apps can replay it).
//!   With ACCOUNTS_WEBHOOK_ALLOW_PRIVATE=false only https URLs that resolve to public
//!   addresses are contacted (checked at connect time, so DNS rebinding can't slip through).
//! - [`messages`]: sends pending `outbound_messages` (codes, custodian requests, bug reports)
//!   through core's Postmark/Twilio sender; in local delivery mode it only marks them `local`.
//! - [`cleanup`]: deletes expired working state (sign-in flows, codes, tokens, idempotency keys,
//!   finished id reservations, old sign-up sessions, rate-limit windows). History tables are
//!   never touched.
//!
//! Contract with the server crate: [`router`] is merged into the API router (it is empty) and
//! [`spawn_background`] / [`spawn_background_until`] start the loops.

use accounts_core::AppState;
use axum::Router;
use tokio::sync::watch;
use tokio::task::JoinHandle;

pub mod cleanup;
pub mod messages;
pub mod pipeline;
pub mod webhooks;

/// HTTP routes of this crate: none (the worker only runs background loops).
pub fn router() -> Router<AppState> {
    Router::new()
}

/// Starts the webhook, message and cleanup loops. They run until the process exits or their
/// handles are aborted; use [`spawn_background_until`] for a graceful stop.
pub fn spawn_background(state: AppState) -> Vec<JoinHandle<()>> {
    spawn_background_until(state, Shutdown::never())
}

/// Starts the loops. Once `shutdown` triggers they stop claiming work, let the sends in flight
/// finish (at most about one 10 s send timeout) and return.
pub fn spawn_background_until(state: AppState, shutdown: Shutdown) -> Vec<JoinHandle<()>> {
    let mut handles = Vec::with_capacity(3);
    match webhooks::WebhookDeliverer::new(&state) {
        Ok(deliverer) => handles.push(tokio::spawn(webhooks::run(deliverer, shutdown.clone()))),
        Err(e) => {
            // Without its HTTP client the worker can't deliver webhooks; say so loudly instead
            // of silently piling up pending deliveries.
            tracing::error!(error = %e, "webhook delivery is NOT running: the HTTP client could not be built");
            // Progress 0: the webhook loop never started.
            state.telemetry.record_progress(
                "worker",
                "webhook",
                "worker.webhooks_unavailable",
                Some(0.0),
                serde_json::json!({ "error": e.to_string() }),
            );
        }
    }
    handles.push(tokio::spawn(messages::run(state.clone(), shutdown.clone())));
    handles.push(tokio::spawn(cleanup::run(state, shutdown)));
    handles
}

/// A stop signal shared by the background loops.
#[derive(Debug, Clone, Default)]
pub struct Shutdown {
    rx: Option<watch::Receiver<bool>>,
}

impl Shutdown {
    /// A signal that never triggers.
    pub fn never() -> Shutdown {
        Shutdown { rx: None }
    }

    /// Triggers once `true` is sent on the channel, or when the sender is dropped (whoever
    /// owned the loops is gone).
    pub fn new(rx: watch::Receiver<bool>) -> Shutdown {
        Shutdown { rx: Some(rx) }
    }

    /// A signal plus the sender that triggers it.
    pub fn channel() -> (watch::Sender<bool>, Shutdown) {
        let (tx, rx) = watch::channel(false);
        (tx, Shutdown::new(rx))
    }

    /// True once the signal has triggered.
    pub fn is_triggered(&self) -> bool {
        match &self.rx {
            None => false,
            Some(rx) => *rx.borrow() || rx.has_changed().is_err(),
        }
    }

    /// Resolves when the signal triggers (never, for [`Shutdown::never`]).
    pub async fn triggered(&mut self) {
        match &mut self.rx {
            None => std::future::pending::<()>().await,
            Some(rx) => {
                // Err = the sender was dropped, which also means "stop".
                let _ = rx.wait_for(|stop| *stop).await;
            }
        }
    }

    /// Sleeps for `duration`; returns false when the signal triggered first.
    pub async fn sleep(&mut self, duration: std::time::Duration) -> bool {
        tokio::select! {
            _ = tokio::time::sleep(duration) => true,
            _ = self.triggered() => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn shutdown_signal_semantics() {
        let mut never = Shutdown::never();
        assert!(!never.is_triggered());
        assert!(never.sleep(Duration::from_millis(5)).await);

        let (tx, mut s) = Shutdown::channel();
        assert!(!s.is_triggered());
        tx.send(true).expect("send");
        assert!(s.is_triggered());
        assert!(!s.sleep(Duration::from_secs(5)).await);

        let (tx, mut dropped) = Shutdown::channel();
        drop(tx);
        assert!(dropped.is_triggered());
        assert!(!dropped.sleep(Duration::from_secs(5)).await);
    }
}
