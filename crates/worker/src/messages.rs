//! Outbound email and SMS.
//!
//! Requests store messages in `outbound_messages` (core `delivery::enqueue`) and try to send
//! them right after their transaction commits. This loop sends whatever is still `pending` and
//! due. It claims messages with core's `delivery::claim_due` (`FOR UPDATE SKIP LOCKED`; a claim
//! bumps `attempts` and holds the message for `delivery::CLAIM_SECONDS`, 60 s) and sends each
//! through core's `delivery::deliver_claimed`, which records `sent`, schedules the retry or marks
//! `failed` — only while the claim still holds: a result that comes back after another node
//! claimed the message again is not recorded (`claim_lost`).
//!
//! A claim never outlives its send: the loop runs on the [claim pipeline](crate::pipeline),
//! which claims only as many messages as it has free send slots ([`CONCURRENCY`]) and starts
//! each one the moment it is claimed. A send takes at most the provider client's 10 s timeout,
//! far inside the 60 s claim, so no other node can claim a message while it is being sent. A
//! send still running [`CLAIM_BUDGET`] (50 s) after its claim (only a stalled database gets
//! there) is abandoned, and the message is retried once its claim ends.
//!
//! Retries follow core's policy — the same backoff as webhooks (10 s, 30 s, 1 min, 5 min,
//! 15 min, 30 min, then hourly), at most `delivery::MAX_ATTEMPTS` (8) attempts, and verification
//! codes stop retrying once the code would have expired — so the request path and the worker
//! never disagree about a message.
//!
//! With ACCOUNTS_DELIVERY=local nothing is ever sent: a `pending` message (for example one
//! left from a run with providers) is marked `local`, where the dev outbox shows it.

use std::time::Duration;

use accounts_core::config::DeliveryMode;
use accounts_core::delivery::{self, DeliveryOutcome, MAX_ATTEMPTS, OutboundMessage};
use accounts_core::{ApiResult, AppState};
use serde_json::json;
use tokio::time::Instant;

use crate::Shutdown;
use crate::pipeline::{self, CLAIM_BUDGET, Pipeline};

/// Messages sent at once; the loop never holds more claims than this.
pub const CONCURRENCY: usize = 8;
/// Wait before looking again when fewer messages were due than send slots were free.
pub const IDLE_POLL: Duration = Duration::from_secs(1);
/// Wait after a claim failed (database unavailable).
pub const ERROR_BACKOFF: Duration = Duration::from_secs(5);
/// Wait between sweeps in local delivery mode.
pub const LOCAL_POLL: Duration = Duration::from_secs(10);

/// What one [`send_due`] round did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SendSummary {
    /// Messages claimed (providers mode).
    pub claimed: usize,
    pub sent: usize,
    pub retrying: usize,
    pub failed: usize,
    /// Sends abandoned at the claim budget; retried when their claim ends.
    pub abandoned: usize,
    /// Sends whose result could not be recorded (database error); retried when their claim ends.
    pub errors: usize,
    /// Sends that finished after their claim ran out and another node claimed the message again;
    /// their result was not recorded (the other node's counts).
    pub claim_lost: usize,
    /// Pending messages marked `local` (local mode).
    pub marked_local: u64,
}

/// What happened to one claimed message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SendResult {
    /// Core's outcome: sent, retrying or failed.
    Done(DeliveryOutcome),
    /// Not finished within the claim budget; abandoned so it can't outlive its claim, and
    /// retried once the claim ends.
    Abandoned,
    /// The result could not be recorded; retried once the claim ends.
    Error(String),
}

impl SendResult {
    /// Short label for logs and telemetry event names (`message.<label>`).
    pub fn label(&self) -> &'static str {
        match self {
            SendResult::Done(DeliveryOutcome::Sent { .. }) => "sent",
            SendResult::Done(DeliveryOutcome::Retrying { .. }) => "retrying",
            SendResult::Done(DeliveryOutcome::Failed { .. }) => "failed",
            SendResult::Done(DeliveryOutcome::Skipped) => "skipped",
            SendResult::Done(DeliveryOutcome::ClaimLost) => "claim_lost",
            SendResult::Abandoned => "abandoned",
            SendResult::Error(_) => "error",
        }
    }
}

/// Telemetry progress of a message after an attempt: 1.0 once it is settled (sent, failed for
/// good, nothing to do), otherwise the share of its [`MAX_ATTEMPTS`] attempts used so far
/// (`attempts` counts the current one), capped below 1.0.
pub fn progress(result: &SendResult, attempts: i32) -> f64 {
    match result {
        SendResult::Done(
            DeliveryOutcome::Sent { .. }
            | DeliveryOutcome::Failed { .. }
            | DeliveryOutcome::Skipped,
        ) => 1.0,
        _ => (f64::from(attempts.max(0)) / f64::from(MAX_ATTEMPTS)).min(0.99),
    }
}

/// Marks every pending message `local`: ACCOUNTS_DELIVERY=local never sends.
async fn mark_local(state: &AppState) -> ApiResult<u64> {
    let marked = sqlx::query(
        "update outbound_messages set status = 'local', last_error = null where status = 'pending'",
    )
    .execute(&state.db)
    .await?
    .rows_affected();
    if marked > 0 {
        tracing::info!(
            count = marked,
            "marked pending messages 'local': ACCOUNTS_DELIVERY=local never sends email or SMS"
        );
    }
    Ok(marked)
}

/// One round of the loop: claims up to [`CONCURRENCY`] due messages and sends them all at once
/// (in local mode: marks pending messages `local`). [`run`] does this continuously.
pub async fn send_due(state: &AppState) -> ApiResult<SendSummary> {
    send_due_within(state, CLAIM_BUDGET).await
}

/// [`send_due`] with another claim budget (tests use a short one).
pub async fn send_due_within(state: &AppState, budget: Duration) -> ApiResult<SendSummary> {
    if state.settings.delivery == DeliveryMode::Local {
        return Ok(SendSummary {
            marked_local: mark_local(state).await?,
            ..SendSummary::default()
        });
    }
    let claimed_at = Instant::now();
    let claimed = delivery::claim_due(&state.db, CONCURRENCY as i64).await?;
    let mut summary = SendSummary {
        claimed: claimed.len(),
        ..SendSummary::default()
    };
    let results = futures::future::join_all(
        claimed
            .into_iter()
            .map(|msg| send_claimed(state, msg, claimed_at + budget)),
    )
    .await;
    for result in results {
        match result {
            SendResult::Done(DeliveryOutcome::Sent { .. }) => summary.sent += 1,
            SendResult::Done(DeliveryOutcome::Retrying { .. }) => summary.retrying += 1,
            SendResult::Done(DeliveryOutcome::Failed { .. }) => summary.failed += 1,
            SendResult::Done(DeliveryOutcome::Skipped) => {}
            SendResult::Done(DeliveryOutcome::ClaimLost) => summary.claim_lost += 1,
            SendResult::Abandoned => summary.abandoned += 1,
            SendResult::Error(_) => summary.errors += 1,
        }
    }
    Ok(summary)
}

/// Sends one claimed message through core, bounded by `deadline`; logs and records telemetry.
pub async fn send_claimed(state: &AppState, msg: OutboundMessage, deadline: Instant) -> SendResult {
    let sent = tokio::time::timeout_at(
        deadline,
        delivery::deliver_claimed(&state.db, state.sender.as_ref(), &state.settings, &msg),
    )
    .await;
    let result = match sent {
        Ok(Ok(outcome)) => SendResult::Done(outcome),
        Ok(Err(e)) => {
            // The claim pushed next_attempt_at 60 s ahead, so the message is retried then.
            tracing::error!(message_id = %msg.id, error = %e, "could not record a message send; it is retried when its 60 s claim ends");
            SendResult::Error(e.to_string())
        }
        Err(_) => {
            tracing::error!(
                message_id = %msg.id,
                purpose = %msg.purpose,
                budget_seconds = CLAIM_BUDGET.as_secs(),
                "a message send did not finish in time; abandoned so it can't outlive its 60 s claim, and retried when the claim ends"
            );
            SendResult::Abandoned
        }
    };
    state.telemetry.record_progress(
        "worker",
        "message_send",
        &format!("message.{}", result.label()),
        Some(progress(&result, msg.attempts)),
        json!({
            "channel": msg.channel,
            "purpose": msg.purpose,
            "attempt": msg.attempts,
            "max_attempts": MAX_ATTEMPTS,
            "sender": state.sender.name(),
        }),
    );
    result
}

/// The message loop: sends until `shutdown` triggers, then lets the sends in flight finish.
pub async fn run(state: AppState, mut shutdown: Shutdown) {
    tracing::info!(
        delivery = state.settings.delivery.as_str(),
        sender = state.sender.name(),
        concurrency = CONCURRENCY,
        "outbound message sender started"
    );
    if state.settings.delivery == DeliveryMode::Local {
        // Local mode only tidies up leftovers; no need to look every second.
        loop {
            if let Err(e) = mark_local(&state).await {
                tracing::error!(error = %e, "could not mark pending messages 'local'; trying again in 10 seconds");
            }
            if !shutdown.sleep(LOCAL_POLL).await {
                break;
            }
        }
    } else {
        let db = state.db.clone();
        let worker_state = state.clone();
        Pipeline {
            name: "messages",
            concurrency: CONCURRENCY,
            idle_poll: IDLE_POLL,
            error_backoff: ERROR_BACKOFF,
        }
        .run(
            shutdown,
            move |free| {
                let db = db.clone();
                async move { delivery::claim_due(&db, free as i64).await }
            },
            move |msg, claimed_at| {
                let state = worker_state.clone();
                async move {
                    send_claimed(&state, msg, pipeline::deadline(claimed_at)).await;
                }
            },
        )
        .await;
    }
    tracing::info!("outbound message sender stopped");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn progress_is_settled_or_a_share_of_the_attempts() {
        let sent = SendResult::Done(DeliveryOutcome::Sent {
            provider_message_id: "x".into(),
        });
        assert_eq!(progress(&sent, 3), 1.0);
        let failed = SendResult::Done(DeliveryOutcome::Failed {
            error: "bad address".into(),
        });
        assert_eq!(progress(&failed, 1), 1.0);
        let retrying = SendResult::Done(DeliveryOutcome::Retrying {
            next_attempt_at: time::OffsetDateTime::now_utc(),
            error: "503".into(),
        });
        assert_eq!(progress(&retrying, 2), 0.25);
        assert_eq!(progress(&SendResult::Abandoned, 1), 0.125);
        assert_eq!(progress(&SendResult::Error("db".into()), 8), 0.99);
        assert_eq!(retrying.label(), "retrying");
        assert_eq!(SendResult::Abandoned.label(), "abandoned");
    }
}
