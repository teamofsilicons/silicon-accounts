//! The outbound email/SMS loop: providers mode with a scripted sender, and local mode.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use accounts_core::Settings;
use accounts_core::config::DeliveryMode;
use accounts_core::delivery::{self, NewMessage, OutboundMessage, SendError, Sender};
use accounts_core::models::MessageChannel;
use accounts_core::test_support::TestContext;
use accounts_worker::messages::{self, SendSummary};
use async_trait::async_trait;
use time::OffsetDateTime;
use uuid::Uuid;

/// Answers with the scripted results in order, then succeeds.
#[derive(Default)]
struct ScriptedSender {
    script: Mutex<VecDeque<Result<String, SendError>>>,
    sent: Mutex<Vec<String>>,
}

impl ScriptedSender {
    fn with(script: Vec<Result<String, SendError>>) -> Arc<ScriptedSender> {
        Arc::new(ScriptedSender {
            script: Mutex::new(script.into()),
            sent: Mutex::default(),
        })
    }
    fn sent(&self) -> Vec<String> {
        self.sent.lock().expect("lock").clone()
    }
}

#[async_trait]
impl Sender for ScriptedSender {
    async fn send(&self, msg: &OutboundMessage) -> Result<String, SendError> {
        self.sent.lock().expect("lock").push(msg.to_address.clone());
        self.script
            .lock()
            .expect("lock")
            .pop_front()
            .unwrap_or_else(|| Ok(format!("provider-{}", msg.id)))
    }
    fn name(&self) -> &'static str {
        "scripted"
    }
}

async fn providers_ctx() -> TestContext {
    let mut settings = Settings::for_tests();
    settings.delivery = DeliveryMode::Providers;
    TestContext::with_settings(settings).await
}

async fn enqueue(ctx: &TestContext, to: &str, purpose: &str) -> Uuid {
    let mut conn = ctx.conn().await;
    delivery::enqueue(
        &mut conn,
        &ctx.state.settings,
        &NewMessage {
            channel: MessageChannel::Email,
            to: to.into(),
            subject: Some("Hello".into()),
            text_body: "Hello from Silicon Accounts".into(),
            html_body: None,
            purpose: purpose.into(),
        },
    )
    .await
    .expect("enqueue")
}

#[derive(Debug, sqlx::FromRow)]
struct Row {
    status: String,
    attempts: i32,
    last_error: Option<String>,
    provider_message_id: Option<String>,
    next_attempt_at: OffsetDateTime,
}

async fn row(ctx: &TestContext, id: Uuid) -> Row {
    sqlx::query_as::<_, Row>(
        "select status, attempts, last_error, provider_message_id, next_attempt_at from outbound_messages where id = $1",
    )
    .bind(id)
    .fetch_one(&mut *ctx.conn().await)
    .await
    .expect("message row")
}

async fn make_due(ctx: &TestContext, id: Uuid) {
    sqlx::query("update outbound_messages set next_attempt_at = now() where id = $1")
        .bind(id)
        .execute(&mut *ctx.conn().await)
        .await
        .expect("time travel");
}

#[tokio::test]
async fn sends_pending_messages_and_retries_transient_failures() {
    let ctx = providers_ctx().await;
    let sender = ScriptedSender::with(vec![Err(SendError::retryable(
        "Postmark answered 503 (ErrorCode -1): try later",
    ))]);
    let state = ctx.state.clone().with_sender(sender.clone());
    let id = enqueue(&ctx, "carbon@example.test", "custodian_request").await;
    assert_eq!(row(&ctx, id).await.status, "pending");

    let first = messages::send_due(&state).await.expect("cycle");
    assert_eq!(
        first,
        SendSummary {
            claimed: 1,
            retrying: 1,
            ..SendSummary::default()
        }
    );
    let r = row(&ctx, id).await;
    assert_eq!((r.status.as_str(), r.attempts), ("pending", 1));
    assert!(r.last_error.unwrap_or_default().contains("503"));
    let wait = (r.next_attempt_at - OffsetDateTime::now_utc()).whole_seconds();
    assert!((5..=11).contains(&wait), "retried after 10 s, got {wait}");

    assert_eq!(
        messages::send_due(&state).await.expect("cycle").claimed,
        0,
        "not due yet"
    );
    make_due(&ctx, id).await;
    let second = messages::send_due(&state).await.expect("cycle");
    assert_eq!(second.sent, 1);
    let r = row(&ctx, id).await;
    assert_eq!((r.status.as_str(), r.attempts), ("sent", 2));
    assert_eq!(r.provider_message_id, Some(format!("provider-{id}")));
    assert_eq!(sender.sent(), vec!["carbon@example.test"; 2]);
}

#[tokio::test]
async fn permanent_failures_stop_immediately() {
    let ctx = providers_ctx().await;
    let sender = ScriptedSender::with(vec![Err(SendError::permanent(
        "Postmark answered 422 (ErrorCode 300): Invalid 'To' address",
    ))]);
    let state = ctx.state.clone().with_sender(sender);
    let id = enqueue(&ctx, "bad@example.test", "report").await;
    assert_eq!(messages::send_due(&state).await.expect("cycle").failed, 1);
    let r = row(&ctx, id).await;
    assert_eq!(r.status, "failed");
    assert!(
        r.last_error
            .unwrap_or_default()
            .contains("Invalid 'To' address")
    );
}

#[tokio::test]
async fn gives_up_after_eight_attempts() {
    let ctx = providers_ctx().await;
    let script = (0..20)
        .map(|_| Err(SendError::retryable("Twilio request failed: timed out")))
        .collect();
    let state = ctx.state.clone().with_sender(ScriptedSender::with(script));
    let id = enqueue(&ctx, "carbon@example.test", "custodian_invite").await;
    for attempt in 1..=8 {
        make_due(&ctx, id).await;
        messages::send_due(&state).await.expect("cycle");
        let r = row(&ctx, id).await;
        assert_eq!(r.attempts, attempt);
        let expected = if attempt < 8 { "pending" } else { "failed" };
        assert_eq!(r.status, expected, "after attempt {attempt}");
    }
    make_due(&ctx, id).await;
    assert_eq!(
        messages::send_due(&state).await.expect("cycle").claimed,
        0,
        "a failed message is never claimed again"
    );
}

#[tokio::test]
async fn local_mode_marks_leftover_pending_messages_local() {
    let ctx = TestContext::new().await;
    assert_eq!(ctx.state.settings.delivery, DeliveryMode::Local);
    // A message left pending by an earlier run with ACCOUNTS_DELIVERY=providers.
    let id = Uuid::now_v7();
    sqlx::query(
        "insert into outbound_messages (id, channel, to_address, text_body, purpose, status) \
         values ($1, 'email', 'carbon@example.test', 'hi', 'report', 'pending')",
    )
    .bind(id)
    .execute(&mut *ctx.conn().await)
    .await
    .expect("insert");
    // And one enqueued now (local mode stores it as local right away).
    let local = enqueue(&ctx, "carbon@example.test", "report").await;
    assert_eq!(row(&ctx, local).await.status, "local");

    let summary = messages::send_due(&ctx.state).await.expect("cycle");
    assert_eq!(summary.marked_local, 1);
    assert_eq!(summary.sent, 0);
    assert_eq!(row(&ctx, id).await.status, "local");
}

/// A working provider that takes `delay` per send and keeps count.
struct SlowSender {
    delay: std::time::Duration,
    state: Mutex<SlowState>,
}

#[derive(Default)]
struct SlowState {
    /// Sends started per message id, with the time each started.
    started: std::collections::HashMap<Uuid, Vec<OffsetDateTime>>,
    completed: usize,
    in_flight: usize,
    max_in_flight: usize,
}

impl SlowSender {
    fn new(delay: std::time::Duration) -> Arc<SlowSender> {
        Arc::new(SlowSender {
            delay,
            state: Mutex::default(),
        })
    }
    fn completed(&self) -> usize {
        self.state.lock().expect("lock").completed
    }
    fn started_total(&self) -> usize {
        self.state
            .lock()
            .expect("lock")
            .started
            .values()
            .map(Vec::len)
            .sum()
    }
}

#[async_trait]
impl Sender for SlowSender {
    async fn send(&self, msg: &OutboundMessage) -> Result<String, SendError> {
        {
            let mut s = self.state.lock().expect("lock");
            s.started
                .entry(msg.id)
                .or_default()
                .push(OffsetDateTime::now_utc());
            s.in_flight += 1;
            s.max_in_flight = s.max_in_flight.max(s.in_flight);
        }
        tokio::time::sleep(self.delay).await;
        let mut s = self.state.lock().expect("lock");
        s.in_flight -= 1;
        s.completed += 1;
        Ok(format!("provider-{}", msg.id))
    }
    fn name(&self) -> &'static str {
        "slow"
    }
}

/// Messages claimed and not finished: pending with their claim (`next_attempt_at`, 60 s
/// ahead) still running. Retries would be due within 10 s, so they never count.
async fn claimed_unfinished(ctx: &TestContext) -> i64 {
    sqlx::query_scalar(
        "select count(*) from outbound_messages where status = 'pending' and next_attempt_at > now() + interval '30 seconds'",
    )
    .fetch_one(&mut *ctx.conn().await)
    .await
    .expect("count claims")
}

async fn sent_count(ctx: &TestContext) -> i64 {
    sqlx::query_scalar("select count(*) from outbound_messages where status = 'sent'")
        .fetch_one(&mut *ctx.conn().await)
        .await
        .expect("count sent")
}

async fn wait_for_sent(ctx: &TestContext, total: i64, mut sample: impl FnMut(i64)) {
    for _ in 0..500 {
        sample(claimed_unfinished(ctx).await);
        if sent_count(ctx).await == total {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    panic!(
        "only {} of {total} messages were sent",
        sent_count(ctx).await
    );
}

/// The regression for claims running out while messages wait in a local queue (a second node
/// then sent them again): the loop holds a claim only while it is sending that message, and
/// starts each send the moment the message is claimed.
#[tokio::test]
async fn the_loop_holds_a_claim_only_while_it_sends() {
    let ctx = providers_ctx().await;
    let sender = SlowSender::new(std::time::Duration::from_millis(250));
    let state = ctx.state.clone().with_sender(sender.clone());
    let total = 3 * messages::CONCURRENCY + 5;
    let mut ids = Vec::new();
    for i in 0..total {
        ids.push(
            enqueue(
                &ctx,
                &format!("carbon{i}@example.test"),
                "custodian_request",
            )
            .await,
        );
    }
    let (stop, shutdown) = accounts_worker::Shutdown::channel();
    let handle = tokio::spawn(messages::run(state, shutdown));
    let mut max_claimed = 0;
    wait_for_sent(&ctx, total as i64, |n| max_claimed = max_claimed.max(n)).await;
    stop.send(true).expect("stop");
    tokio::time::timeout(std::time::Duration::from_secs(10), handle)
        .await
        .expect("the loop stops")
        .expect("no panic");

    assert!(
        max_claimed <= messages::CONCURRENCY as i64,
        "{max_claimed} messages claimed with {} send slots",
        messages::CONCURRENCY
    );
    let first_starts: std::collections::HashMap<Uuid, OffsetDateTime> = {
        let s = sender.state.lock().expect("lock");
        assert!(s.max_in_flight <= messages::CONCURRENCY);
        assert!(s.max_in_flight > 1, "messages are sent in parallel");
        ids.iter()
            .map(|id| {
                let starts = s.started.get(id).expect("every message was sent");
                assert_eq!(
                    starts.len(),
                    1,
                    "message {id} was sent {} times",
                    starts.len()
                );
                (*id, starts[0])
            })
            .collect()
    };
    // Each send started right after its claim (claim time = next_attempt_at - 60 s).
    for id in &ids {
        let r = row(&ctx, *id).await;
        assert_eq!((r.status.as_str(), r.attempts), ("sent", 1));
        let claimed_at = r.next_attempt_at - time::Duration::seconds(60);
        let wait = first_starts[id] - claimed_at;
        assert!(
            wait < time::Duration::seconds(1),
            "message {id} waited {wait} between its claim and its send"
        );
    }
}

#[tokio::test]
async fn two_nodes_never_send_a_message_twice() {
    let ctx = providers_ctx().await;
    let sender = SlowSender::new(std::time::Duration::from_millis(100));
    let total = 4 * messages::CONCURRENCY;
    for i in 0..total {
        enqueue(&ctx, &format!("node{i}@example.test"), "report").await;
    }
    let (stop, shutdown) = accounts_worker::Shutdown::channel();
    let a = tokio::spawn(messages::run(
        ctx.state.clone().with_sender(sender.clone()),
        shutdown.clone(),
    ));
    let b = tokio::spawn(messages::run(
        ctx.state.clone().with_sender(sender.clone()),
        shutdown,
    ));
    wait_for_sent(&ctx, total as i64, |_| {}).await;
    stop.send(true).expect("stop");
    for h in [a, b] {
        tokio::time::timeout(std::time::Duration::from_secs(10), h)
            .await
            .expect("the loop stops")
            .expect("no panic");
    }
    assert_eq!(
        sender.started_total(),
        total,
        "every message was sent exactly once"
    );
}

#[tokio::test]
async fn a_send_past_the_claim_budget_is_abandoned_and_left_to_its_claim() {
    let ctx = providers_ctx().await;
    let sender = SlowSender::new(std::time::Duration::from_secs(3));
    let state = ctx.state.clone().with_sender(sender.clone());
    let id = enqueue(&ctx, "stalled@example.test", "custodian_request").await;

    let started = std::time::Instant::now();
    let summary = messages::send_due_within(&state, std::time::Duration::from_millis(300))
        .await
        .expect("round");
    assert!(started.elapsed() < std::time::Duration::from_secs(2));
    assert_eq!(
        summary,
        SendSummary {
            claimed: 1,
            abandoned: 1,
            ..SendSummary::default()
        }
    );
    assert_eq!(sender.completed(), 0, "the send itself was cut off");
    let r = row(&ctx, id).await;
    assert_eq!((r.status.as_str(), r.attempts), ("pending", 1));
    let claim_left = (r.next_attempt_at - OffsetDateTime::now_utc()).whole_seconds();
    assert!(
        claim_left > 50,
        "the claim still holds ({claim_left} s left)"
    );
    assert_eq!(
        messages::send_due(&state).await.expect("round").claimed,
        0,
        "no one takes it while the claim holds"
    );
}

#[tokio::test]
async fn a_graceful_stop_claims_nothing_new_and_finishes_the_sends_in_flight() {
    let ctx = providers_ctx().await;
    let sender = SlowSender::new(std::time::Duration::from_millis(800));
    let state = ctx.state.clone().with_sender(sender.clone());
    for i in 0..3 {
        enqueue(&ctx, &format!("stop{i}@example.test"), "report").await;
    }
    let (stop, shutdown) = accounts_worker::Shutdown::channel();
    let handle = tokio::spawn(messages::run(state, shutdown));
    for _ in 0..100 {
        if sender.started_total() == 3 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    assert_eq!(sender.started_total(), 3, "all three sends are in flight");
    stop.send(true).expect("stop");
    let late = enqueue(&ctx, "late@example.test", "report").await;
    tokio::time::timeout(std::time::Duration::from_secs(5), handle)
        .await
        .expect("the loop stops within one send")
        .expect("no panic");
    assert_eq!(sender.completed(), 3, "nothing in flight was cut off");
    assert_eq!(sent_count(&ctx).await, 3);
    let r = row(&ctx, late).await;
    assert_eq!(
        (r.status.as_str(), r.attempts),
        ("pending", 0),
        "not claimed after the stop"
    );
    assert_eq!(claimed_unfinished(&ctx).await, 0);
}
