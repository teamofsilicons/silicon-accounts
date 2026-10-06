//! Webhook delivery against a real local HTTP receiver (axum on 127.0.0.1).

use std::sync::{Arc, Mutex};

use accounts_core::Settings;
use accounts_core::crypto::verify_webhook_signature;
use accounts_core::events::{self, EmittedEvent};
use accounts_core::test_support::TestContext;
use accounts_worker::webhooks::{self, DeliveryOutcome, WebhookDeliverer};
use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::post;
use serde_json::Value;
use time::OffsetDateTime;
use uuid::Uuid;

#[derive(Debug, Clone)]
struct Received {
    path: String,
    headers: HeaderMap,
    body: Vec<u8>,
}

impl Received {
    fn header(&self, name: &str) -> &str {
        self.headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
    }

    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).expect("JSON body")
    }

    fn signature_valid(&self, secret: &str) -> bool {
        let ts: i64 = self
            .header("x-accounts-timestamp")
            .parse()
            .expect("numeric timestamp");
        verify_webhook_signature(secret, ts, &self.body, self.header("x-accounts-signature"))
    }
}

#[derive(Debug, Default)]
struct ReceiverState {
    received: Vec<Received>,
    fail_next: usize,
    fail_status: u16,
    /// How long each request takes to answer.
    delay: std::time::Duration,
    in_flight: usize,
    max_in_flight: usize,
    answered: usize,
}

#[derive(Debug, Clone, Default)]
struct Receiver {
    inner: Arc<Mutex<ReceiverState>>,
    base: String,
}

impl Receiver {
    fn url(&self, path: &str) -> String {
        format!("{}/{path}", self.base)
    }
    fn port(&self) -> u16 {
        self.base
            .rsplit(':')
            .next()
            .and_then(|p| p.parse().ok())
            .expect("port")
    }
    fn fail_next(&self, n: usize, status: u16) {
        let mut s = self.inner.lock().expect("lock");
        s.fail_next = n;
        s.fail_status = status;
    }
    fn received(&self) -> Vec<Received> {
        self.inner.lock().expect("lock").received.clone()
    }
    fn set_delay(&self, delay: std::time::Duration) {
        self.inner.lock().expect("lock").delay = delay;
    }
    fn max_in_flight(&self) -> usize {
        self.inner.lock().expect("lock").max_in_flight
    }
    fn answered(&self) -> usize {
        self.inner.lock().expect("lock").answered
    }
}

async fn receive(
    State(rx): State<Receiver>,
    Path(path): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> (StatusCode, &'static str) {
    let (status, delay) = {
        let mut s = rx.inner.lock().expect("lock");
        s.received.push(Received {
            path,
            headers,
            body: body.to_vec(),
        });
        s.in_flight += 1;
        s.max_in_flight = s.max_in_flight.max(s.in_flight);
        let status = if s.fail_next > 0 {
            s.fail_next -= 1;
            StatusCode::from_u16(s.fail_status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR)
        } else {
            StatusCode::OK
        };
        (status, s.delay)
    };
    if !delay.is_zero() {
        tokio::time::sleep(delay).await;
    }
    {
        let mut s = rx.inner.lock().expect("lock");
        s.in_flight -= 1;
        s.answered += 1;
    }
    if status == StatusCode::OK {
        (status, "ok")
    } else {
        (status, "receiver is down for maintenance")
    }
}

async fn start_receiver() -> Receiver {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind receiver");
    let addr = listener.local_addr().expect("addr");
    let rx = Receiver {
        inner: Arc::default(),
        base: format!("http://{addr}"),
    };
    let app = Router::new()
        .route("/{*path}", post(receive))
        .with_state(rx.clone());
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    rx
}

async fn ping(ctx: &TestContext, app_id: &str) -> EmittedEvent {
    let mut conn = ctx.conn().await;
    events::ping_app(&mut conn, app_id)
        .await
        .expect("emit")
        .expect("the app has a webhook")
}

#[derive(Debug, sqlx::FromRow)]
struct DeliveryRow {
    status: String,
    attempts: i32,
    url: String,
    last_status: Option<i32>,
    last_error: Option<String>,
    delivered_at: Option<OffsetDateTime>,
    locked_until: Option<OffsetDateTime>,
    next_attempt_at: OffsetDateTime,
}

async fn delivery(ctx: &TestContext, id: Uuid) -> DeliveryRow {
    sqlx::query_as::<_, DeliveryRow>(
        "select status, attempts, url, last_status, last_error, delivered_at, locked_until, next_attempt_at \
         from webhook_deliveries where id = $1",
    )
    .bind(id)
    .fetch_one(&mut *ctx.conn().await)
    .await
    .expect("delivery row")
}

async fn attempts(ctx: &TestContext, id: Uuid) -> Vec<(Option<i32>, Option<String>)> {
    sqlx::query_as(
        "select status_code, error from webhook_attempts where delivery_id = $1 order by id",
    )
    .bind(id)
    .fetch_all(&mut *ctx.conn().await)
    .await
    .expect("attempt rows")
}

async fn make_due(ctx: &TestContext, id: Uuid) {
    sqlx::query("update webhook_deliveries set next_attempt_at = now() where id = $1")
        .bind(id)
        .execute(&mut *ctx.conn().await)
        .await
        .expect("time travel");
}

fn seconds_until(t: OffsetDateTime) -> i64 {
    (t - OffsetDateTime::now_utc()).whole_seconds()
}

#[tokio::test]
async fn delivers_signed_event_with_spec_headers() {
    let ctx = TestContext::new().await;
    let rx = start_receiver().await;
    let (app, _) = ctx.app("hooks").await;
    let secret = ctx
        .set_app_webhook(&app.app_id, &rx.url(&format!("{}/webhooks", app.app_id)))
        .await;
    let ev = ping(&ctx, &app.app_id).await;

    let deliverer = WebhookDeliverer::new(&ctx.state).expect("client");
    let outcomes = deliverer.deliver_due(10).await.expect("cycle");
    assert_eq!(
        outcomes,
        vec![DeliveryOutcome::Delivered {
            delivery_id: ev.delivery_id,
            status: 200
        }]
    );

    let got = rx.received();
    assert_eq!(got.len(), 1);
    let r = &got[0];
    assert_eq!(r.path, format!("{}/webhooks", app.app_id));
    assert_eq!(r.header("content-type"), "application/json");
    assert_eq!(r.header("user-agent"), "SiliconAccounts-Webhooks/1");
    assert_eq!(r.header("x-accounts-event-id"), ev.event_id.to_string());
    assert_eq!(r.header("x-accounts-event-type"), "ping");
    assert_eq!(
        r.header("x-accounts-delivery-id"),
        ev.delivery_id.to_string()
    );
    let ts: i64 = r
        .header("x-accounts-timestamp")
        .parse()
        .expect("unix seconds");
    assert!((OffsetDateTime::now_utc().unix_timestamp() - ts).abs() < 60);
    assert!(r.header("x-accounts-signature").starts_with("v1="));
    assert!(
        r.signature_valid(&secret),
        "signature must verify with the whsec_ secret"
    );
    assert!(!r.signature_valid("whsec_wrong"));

    let body = r.json();
    assert_eq!(body["event_id"], ev.event_id.to_string());
    assert_eq!(body["type"], "ping");
    assert_eq!(body["app_id"], app.app_id.as_str());
    assert_eq!(body["silicon"], Value::Null);
    assert_eq!(body["data"], serde_json::json!({}));
    let stored: Value =
        sqlx::query_scalar("select payload from webhook_events where event_id = $1")
            .bind(ev.event_id)
            .fetch_one(&mut *ctx.conn().await)
            .await
            .expect("payload");
    assert_eq!(body, stored, "the stored payload is sent as-is");

    let d = delivery(&ctx, ev.delivery_id).await;
    assert_eq!(d.status, "delivered");
    assert_eq!(d.attempts, 1);
    assert_eq!(d.last_status, Some(200));
    assert!(d.last_error.is_none());
    assert!(d.delivered_at.is_some());
    assert!(d.locked_until.is_none());
    assert_eq!(
        attempts(&ctx, ev.delivery_id).await,
        vec![(Some(200), None)]
    );

    assert!(
        deliverer.deliver_due(10).await.expect("cycle").is_empty(),
        "a delivered event is never sent again"
    );
    assert_eq!(rx.received().len(), 1);
}

#[tokio::test]
async fn retries_with_the_schedule_until_delivered() {
    let ctx = TestContext::new().await;
    let rx = start_receiver().await;
    let (app, _) = ctx.app("retry").await;
    let secret = ctx.set_app_webhook(&app.app_id, &rx.url("hook")).await;
    rx.fail_next(2, 500);
    let ev = ping(&ctx, &app.app_id).await;
    let deliverer = WebhookDeliverer::new(&ctx.state).expect("client");

    let first = deliverer.deliver_due(10).await.expect("cycle");
    match first.as_slice() {
        [
            DeliveryOutcome::Retrying {
                status,
                error,
                next_attempt_at,
                ..
            },
        ] => {
            assert_eq!(*status, Some(500));
            assert!(
                error.starts_with("HTTP 500 Internal Server Error"),
                "{error}"
            );
            assert!(
                error.contains("receiver is down for maintenance"),
                "{error}"
            );
            let wait = seconds_until(*next_attempt_at);
            assert!(
                (5..=11).contains(&wait),
                "first retry after 10 s, got {wait}"
            );
        }
        other => panic!("expected one retry, got {other:?}"),
    }
    let d = delivery(&ctx, ev.delivery_id).await;
    assert_eq!(
        (d.status.as_str(), d.attempts, d.last_status),
        ("pending", 1, Some(500))
    );
    assert!(
        d.locked_until.is_none(),
        "the lease is released after recording"
    );
    assert!((5..=11).contains(&seconds_until(d.next_attempt_at)));

    assert!(
        deliverer.deliver_due(10).await.expect("cycle").is_empty(),
        "not due again before the retry delay"
    );

    make_due(&ctx, ev.delivery_id).await;
    match deliverer.deliver_due(10).await.expect("cycle").as_slice() {
        [
            DeliveryOutcome::Retrying {
                next_attempt_at, ..
            },
        ] => {
            let wait = seconds_until(*next_attempt_at);
            assert!(
                (25..=31).contains(&wait),
                "second retry after 30 s, got {wait}"
            );
        }
        other => panic!("expected a second retry, got {other:?}"),
    }

    make_due(&ctx, ev.delivery_id).await;
    let third = deliverer.deliver_due(10).await.expect("cycle");
    assert!(matches!(
        third.as_slice(),
        [DeliveryOutcome::Delivered { status: 200, .. }]
    ));
    let d = delivery(&ctx, ev.delivery_id).await;
    assert_eq!(
        (d.status.as_str(), d.attempts, d.last_status),
        ("delivered", 3, Some(200))
    );
    assert!(d.last_error.is_none());
    let tries = attempts(&ctx, ev.delivery_id).await;
    assert_eq!(tries.len(), 3);
    assert_eq!(tries[0].0, Some(500));
    assert_eq!(tries[1].0, Some(500));
    assert_eq!(tries[2], (Some(200), None));

    let got = rx.received();
    assert_eq!(got.len(), 3);
    assert!(got.iter().all(|r| r.signature_valid(&secret)));
    assert!(
        got.iter()
            .all(|r| r.header("x-accounts-event-id") == ev.event_id.to_string())
    );
}

#[tokio::test]
async fn gives_up_72_hours_after_the_event() {
    let ctx = TestContext::new().await;
    let rx = start_receiver().await;
    let (app, _) = ctx.app("giveup").await;
    ctx.set_app_webhook(&app.app_id, &rx.url("hook")).await;
    rx.fail_next(100, 503);
    let deliverer = WebhookDeliverer::new(&ctx.state).expect("client");

    // Created 73 h ago: the window is over, a failure is final.
    let old = ping(&ctx, &app.app_id).await;
    sqlx::query(
        "update webhook_deliveries set created_at = now() - interval '73 hours' where id = $1",
    )
    .bind(old.delivery_id)
    .execute(&mut *ctx.conn().await)
    .await
    .expect("time travel");
    match deliverer.deliver_due(10).await.expect("cycle").as_slice() {
        [DeliveryOutcome::Failed { status, error, .. }] => {
            assert_eq!(*status, Some(503));
            assert!(error.contains("HTTP 503"), "{error}");
        }
        other => panic!("expected failure, got {other:?}"),
    }
    let d = delivery(&ctx, old.delivery_id).await;
    assert_eq!((d.status.as_str(), d.attempts), ("failed", 1));

    // 5 s left in the window but the next retry is 10 s away: final too.
    let edge = ping(&ctx, &app.app_id).await;
    sqlx::query(
        "update webhook_deliveries set created_at = now() - interval '72 hours' + interval '5 seconds' where id = $1",
    )
    .bind(edge.delivery_id)
    .execute(&mut *ctx.conn().await)
    .await
    .expect("time travel");
    assert!(matches!(
        deliverer.deliver_due(10).await.expect("cycle").as_slice(),
        [DeliveryOutcome::Failed { .. }]
    ));

    // 71 h old: still inside the window, so it is retried.
    let young = ping(&ctx, &app.app_id).await;
    sqlx::query(
        "update webhook_deliveries set created_at = now() - interval '71 hours' where id = $1",
    )
    .bind(young.delivery_id)
    .execute(&mut *ctx.conn().await)
    .await
    .expect("time travel");
    assert!(matches!(
        deliverer.deliver_due(10).await.expect("cycle").as_slice(),
        [DeliveryOutcome::Retrying { .. }]
    ));
}

#[tokio::test]
async fn replayed_delivery_gets_a_fresh_window() {
    let ctx = TestContext::new().await;
    let rx = start_receiver().await;
    let (app, _) = ctx.app("replay").await;
    ctx.set_app_webhook(&app.app_id, &rx.url("hook")).await;
    rx.fail_next(100, 500);
    let deliverer = WebhookDeliverer::new(&ctx.state).expect("client");
    let ev = ping(&ctx, &app.app_id).await;
    // What a replay leaves behind: an old event, pending again, attempts reset.
    sqlx::query(
        "update webhook_deliveries set created_at = now() - interval '100 hours', status = 'pending', \
         attempts = 0, manual_replays = 1, next_attempt_at = now() where id = $1",
    )
    .bind(ev.delivery_id)
    .execute(&mut *ctx.conn().await)
    .await
    .expect("replay");
    assert!(
        matches!(
            deliverer.deliver_due(10).await.expect("cycle").as_slice(),
            [DeliveryOutcome::Retrying { .. }]
        ),
        "a replay is retried although the event is older than 72 h"
    );
    // After 77 more failures the schedule has spent its 72 h: the 78th failure is final.
    sqlx::query(
        "update webhook_deliveries set attempts = 77, next_attempt_at = now() where id = $1",
    )
    .bind(ev.delivery_id)
    .execute(&mut *ctx.conn().await)
    .await
    .expect("time travel");
    assert!(matches!(
        deliverer.deliver_due(10).await.expect("cycle").as_slice(),
        [DeliveryOutcome::Failed { .. }]
    ));
    assert_eq!(delivery(&ctx, ev.delivery_id).await.status, "failed");
}

#[tokio::test]
async fn signs_with_the_current_secret_and_posts_to_the_current_url() {
    let ctx = TestContext::new().await;
    let rx = start_receiver().await;
    let (app, _) = ctx.app("rotate").await;
    let old_secret = ctx.set_app_webhook(&app.app_id, &rx.url("old")).await;
    let ev = ping(&ctx, &app.app_id).await;
    let new_secret = ctx.set_app_webhook(&app.app_id, &rx.url("new")).await;

    let deliverer = WebhookDeliverer::new(&ctx.state).expect("client");
    assert!(matches!(
        deliverer.deliver_due(10).await.expect("cycle").as_slice(),
        [DeliveryOutcome::Delivered { .. }]
    ));
    let got = rx.received();
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].path, "new");
    assert!(got[0].signature_valid(&new_secret));
    assert!(!got[0].signature_valid(&old_secret));
    assert_eq!(delivery(&ctx, ev.delivery_id).await.url, rx.url("new"));
}

#[tokio::test]
async fn removed_webhook_fails_without_sending() {
    let ctx = TestContext::new().await;
    let rx = start_receiver().await;
    let (app, _) = ctx.app("removed").await;
    ctx.set_app_webhook(&app.app_id, &rx.url("hook")).await;
    let ev = ping(&ctx, &app.app_id).await;
    sqlx::query(
        "update app_signin_configs set webhook_url = null, webhook_secret_enc = null where app_id = $1",
    )
    .bind(&app.app_id)
    .execute(&mut *ctx.conn().await)
    .await
    .expect("remove webhook");

    let deliverer = WebhookDeliverer::new(&ctx.state).expect("client");
    match deliverer.deliver_due(10).await.expect("cycle").as_slice() {
        [
            DeliveryOutcome::Failed {
                status: None,
                error,
                ..
            },
        ] => {
            assert!(error.contains("no webhook endpoint"), "{error}");
            assert!(error.contains("replay"), "{error}");
        }
        other => panic!("expected a final failure, got {other:?}"),
    }
    assert!(rx.received().is_empty());
    let tries = attempts(&ctx, ev.delivery_id).await;
    assert_eq!(tries.len(), 1);
    assert!(tries[0].0.is_none() && tries[0].1.is_some());
}

#[tokio::test]
async fn disabled_app_is_held_and_retried() {
    let ctx = TestContext::new().await;
    let rx = start_receiver().await;
    let (app, _) = ctx.app("disabled").await;
    ctx.set_app_webhook(&app.app_id, &rx.url("hook")).await;
    let ev = ping(&ctx, &app.app_id).await;
    sqlx::query("update apps set status = 'disabled' where app_id = $1")
        .bind(&app.app_id)
        .execute(&mut *ctx.conn().await)
        .await
        .expect("disable");
    let deliverer = WebhookDeliverer::new(&ctx.state).expect("client");
    match deliverer.deliver_due(10).await.expect("cycle").as_slice() {
        [DeliveryOutcome::Retrying { error, .. }] => {
            assert!(error.contains("is disabled"), "{error}")
        }
        other => panic!("expected a held retry, got {other:?}"),
    }
    assert!(rx.received().is_empty());

    sqlx::query("update apps set status = 'active' where app_id = $1")
        .bind(&app.app_id)
        .execute(&mut *ctx.conn().await)
        .await
        .expect("enable");
    make_due(&ctx, ev.delivery_id).await;
    assert!(matches!(
        deliverer.deliver_due(10).await.expect("cycle").as_slice(),
        [DeliveryOutcome::Delivered { .. }]
    ));
}

#[tokio::test]
async fn delivers_to_a_silicons_own_webhook() {
    let ctx = TestContext::new().await;
    let rx = start_receiver().await;
    let carbon = ctx.carbon().await;
    let (silicon, _) = ctx.silicon(&carbon.uuid).await;
    let (secret, enc) = events::new_webhook_secret(&ctx.state.keys.keyring).expect("secret");
    sqlx::query("update accounts set webhook_url = $2, webhook_secret_enc = $3 where uuid = $1")
        .bind(&silicon.uuid)
        .bind(rx.url("silicon"))
        .bind(enc)
        .execute(&mut *ctx.conn().await)
        .await
        .expect("set Silicon webhook");
    let ev = {
        let mut conn = ctx.conn().await;
        events::ping_silicon(&mut conn, &silicon.uuid)
            .await
            .expect("emit")
            .expect("has webhook")
    };
    let deliverer = WebhookDeliverer::new(&ctx.state).expect("client");
    assert!(matches!(
        deliverer.deliver_due(10).await.expect("cycle").as_slice(),
        [DeliveryOutcome::Delivered { .. }]
    ));
    let got = rx.received();
    assert_eq!(got.len(), 1);
    assert!(got[0].signature_valid(&secret));
    let body = got[0].json();
    assert_eq!(body["silicon"], silicon.uuid.as_str());
    assert_eq!(body["app_id"], Value::Null);
    assert_eq!(body["event_id"], ev.event_id.to_string());
}

#[tokio::test]
async fn ssrf_guard_refuses_private_targets_when_private_is_not_allowed() {
    let mut settings = Settings::for_tests();
    settings.webhook_allow_private = false;
    let ctx = TestContext::with_settings(settings).await;
    let rx = start_receiver().await;
    let (app, _) = ctx.app("ssrf").await;
    // The test helper stores URLs without validation, like a URL saved before the policy changed.
    ctx.set_app_webhook(&app.app_id, &rx.url("hook")).await;
    let ev = ping(&ctx, &app.app_id).await;
    let deliverer = WebhookDeliverer::new(&ctx.state).expect("client");

    let set_url = |url: String| {
        let ctx = &ctx;
        let app_id = app.app_id.clone();
        async move {
            sqlx::query("update app_signin_configs set webhook_url = $2 where app_id = $1")
                .bind(app_id)
                .bind(url)
                .execute(&mut *ctx.conn().await)
                .await
                .expect("set url");
        }
    };
    let expect_refusal =
        |outcomes: Vec<DeliveryOutcome>, needle: &'static str| match outcomes.as_slice() {
            [
                DeliveryOutcome::Retrying {
                    status: None,
                    error,
                    ..
                },
            ] => {
                assert!(error.contains("SSRF guard"), "{error}");
                assert!(error.contains(needle), "expected '{needle}' in: {error}");
            }
            other => panic!("expected a refusal, got {other:?}"),
        };

    // http is refused outright.
    expect_refusal(
        deliverer.deliver_due(10).await.expect("cycle"),
        "must use https",
    );

    // A literal loopback address is refused before connecting.
    set_url(format!("https://127.0.0.1:{}/hook", rx.port())).await;
    make_due(&ctx, ev.delivery_id).await;
    expect_refusal(
        deliverer.deliver_due(10).await.expect("cycle"),
        "private or reserved IP",
    );

    // Local host names are refused by name.
    set_url(format!("https://localhost:{}/hook", rx.port())).await;
    make_due(&ctx, ev.delivery_id).await;
    expect_refusal(
        deliverer.deliver_due(10).await.expect("cycle"),
        "local host",
    );

    // IPv6 forms that carry a private IPv4 address are literal private targets too.
    for host in ["[64:ff9b::7f00:1]", "[::127.0.0.1]", "[2002:7f00:1::]"] {
        set_url(format!("https://{host}:{}/hook", rx.port())).await;
        make_due(&ctx, ev.delivery_id).await;
        expect_refusal(
            deliverer.deliver_due(10).await.expect("cycle"),
            "private or reserved IP",
        );
    }

    // A name that slips past the name check is still refused once it resolves to loopback
    // (`localhost.` with the trailing dot is a different spelling of localhost), and the stored
    // error never says what it resolved to: app owners read it.
    if tokio::net::lookup_host(("localhost.", 0)).await.is_ok() {
        set_url(format!("https://localhost.:{}/hook", rx.port())).await;
        make_due(&ctx, ev.delivery_id).await;
        expect_refusal(
            deliverer.deliver_due(10).await.expect("cycle"),
            "'localhost.' has no public address",
        );
        let stored = delivery(&ctx, ev.delivery_id)
            .await
            .last_error
            .unwrap_or_default();
        assert!(
            !stored.contains("127.0.0.1") && !stored.contains("::1"),
            "{stored}"
        );
    }

    // A name that doesn't resolve reads exactly like one that resolves privately, so the
    // stored error can't be used to probe which internal names exist.
    set_url(format!("https://no-such-host.invalid:{}/hook", rx.port())).await;
    make_due(&ctx, ev.delivery_id).await;
    expect_refusal(
        deliverer.deliver_due(10).await.expect("cycle"),
        "'no-such-host.invalid' has no public address",
    );
    let stored = delivery(&ctx, ev.delivery_id)
        .await
        .last_error
        .unwrap_or_default();
    assert!(!stored.contains("could not be resolved"), "{stored}");

    assert!(
        rx.received().is_empty(),
        "nothing may reach a private address"
    );
    let d = delivery(&ctx, ev.delivery_id).await;
    assert_eq!(d.status, "pending");
    assert!(d.last_error.unwrap_or_default().contains("SSRF guard"));
}

#[tokio::test]
async fn connection_errors_are_described() {
    let ctx = TestContext::new().await;
    let (app, _) = ctx.app("down").await;
    // Bind then drop a listener so the port is (almost certainly) closed.
    let port = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        l.local_addr().expect("addr").port()
    };
    ctx.set_app_webhook(&app.app_id, &format!("http://127.0.0.1:{port}/hook"))
        .await;
    ping(&ctx, &app.app_id).await;
    let deliverer = WebhookDeliverer::new(&ctx.state).expect("client");
    match deliverer.deliver_due(10).await.expect("cycle").as_slice() {
        [
            DeliveryOutcome::Retrying {
                status: None,
                error,
                ..
            },
        ] => {
            assert!(error.starts_with("Could not connect"), "{error}");
        }
        other => panic!("expected a retry, got {other:?}"),
    }
}

#[tokio::test]
async fn parallel_workers_never_send_a_delivery_twice() {
    let ctx = TestContext::new().await;
    let rx = start_receiver().await;
    let (app, _) = ctx.app("parallel").await;
    ctx.set_app_webhook(&app.app_id, &rx.url("hook")).await;
    for _ in 0..20 {
        ping(&ctx, &app.app_id).await;
    }
    let a = WebhookDeliverer::new(&ctx.state).expect("client");
    let b = WebhookDeliverer::new(&ctx.state).expect("client");
    let (ra, rb) = tokio::join!(a.deliver_due(32), b.deliver_due(32));
    let total = ra.expect("a").len() + rb.expect("b").len();
    assert_eq!(total, 20);
    let got = rx.received();
    assert_eq!(got.len(), 20);
    let mut ids: Vec<String> = got
        .iter()
        .map(|r| r.header("x-accounts-delivery-id").to_string())
        .collect();
    ids.sort();
    ids.dedup();
    assert_eq!(ids.len(), 20, "every delivery was sent exactly once");
}

#[tokio::test]
async fn an_expired_lease_hands_the_delivery_to_another_worker() {
    let ctx = TestContext::new().await;
    let rx = start_receiver().await;
    let (app, _) = ctx.app("lease").await;
    ctx.set_app_webhook(&app.app_id, &rx.url("hook")).await;
    let ev = ping(&ctx, &app.app_id).await;

    let first = webhooks::claim_due(&ctx.state.db, 10, 60)
        .await
        .expect("claim");
    assert_eq!(first.len(), 1);
    assert!(
        webhooks::claim_due(&ctx.state.db, 10, 60)
            .await
            .expect("claim")
            .is_empty(),
        "a leased delivery can't be claimed again"
    );
    // The first worker stalls past its lease; a second worker takes over.
    sqlx::query(
        "update webhook_deliveries set locked_until = now() - interval '1 second' where id = $1",
    )
    .bind(ev.delivery_id)
    .execute(&mut *ctx.conn().await)
    .await
    .expect("expire lease");
    let second = webhooks::claim_due(&ctx.state.db, 10, 60)
        .await
        .expect("claim");
    assert_eq!(second.len(), 1);

    let deliverer = WebhookDeliverer::new(&ctx.state).expect("client");
    assert_eq!(
        deliverer
            .deliver_claimed(&first[0])
            .await
            .expect("late worker"),
        DeliveryOutcome::LeaseLost {
            delivery_id: ev.delivery_id
        }
    );
    assert!(matches!(
        deliverer
            .deliver_claimed(&second[0])
            .await
            .expect("current worker"),
        DeliveryOutcome::Delivered { .. }
    ));
    let d = delivery(&ctx, ev.delivery_id).await;
    assert_eq!((d.status.as_str(), d.attempts), ("delivered", 1));
    assert_eq!(
        attempts(&ctx, ev.delivery_id).await.len(),
        2,
        "both HTTP attempts are on record"
    );
}

#[tokio::test]
async fn background_loop_delivers_and_stops_on_shutdown() {
    let ctx = TestContext::new().await;
    let rx = start_receiver().await;
    let (app, _) = ctx.app("loop").await;
    ctx.set_app_webhook(&app.app_id, &rx.url("hook")).await;
    let ev = ping(&ctx, &app.app_id).await;

    let (stop, shutdown) = accounts_worker::Shutdown::channel();
    let handles = accounts_worker::spawn_background_until(ctx.state.clone(), shutdown);
    assert_eq!(handles.len(), 3);
    let mut delivered = false;
    for _ in 0..50 {
        if delivery(&ctx, ev.delivery_id).await.status == "delivered" {
            delivered = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    assert!(delivered, "the loop delivers within a few seconds");
    stop.send(true).expect("signal");
    for h in handles {
        tokio::time::timeout(std::time::Duration::from_secs(15), h)
            .await
            .expect("loops stop promptly")
            .expect("no panic");
    }
}

async fn leased_now(ctx: &TestContext) -> i64 {
    sqlx::query_scalar("select count(*) from webhook_deliveries where locked_until > now()")
        .fetch_one(&mut *ctx.conn().await)
        .await
        .expect("count leases")
}

async fn delivered_count(ctx: &TestContext) -> i64 {
    sqlx::query_scalar("select count(*) from webhook_deliveries where status = 'delivered'")
        .fetch_one(&mut *ctx.conn().await)
        .await
        .expect("count delivered")
}

/// The regression for leases running down in a local queue: the loop holds a lease only while
/// it is attempting that delivery, so no lease can expire while its delivery waits its turn.
#[tokio::test]
async fn the_loop_holds_a_lease_only_while_it_attempts_the_delivery() {
    let ctx = TestContext::new().await;
    let rx = start_receiver().await;
    rx.set_delay(std::time::Duration::from_millis(300));
    let (app, _) = ctx.app("busy").await;
    ctx.set_app_webhook(&app.app_id, &rx.url("hook")).await;
    let total = 2 * webhooks::CONCURRENCY + 8;
    for _ in 0..total {
        ping(&ctx, &app.app_id).await;
    }
    let (stop, shutdown) = accounts_worker::Shutdown::channel();
    let deliverer = WebhookDeliverer::new(&ctx.state).expect("client");
    let handle = tokio::spawn(webhooks::run(deliverer, shutdown));
    let mut max_leased = 0;
    for _ in 0..400 {
        max_leased = max_leased.max(leased_now(&ctx).await);
        if delivered_count(&ctx).await == total as i64 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    stop.send(true).expect("stop");
    tokio::time::timeout(std::time::Duration::from_secs(10), handle)
        .await
        .expect("the loop stops")
        .expect("no panic");
    assert_eq!(delivered_count(&ctx).await, total as i64);
    assert!(
        max_leased <= webhooks::CONCURRENCY as i64,
        "{max_leased} leases held with {} attempt slots",
        webhooks::CONCURRENCY
    );
    assert!(max_leased > 1, "deliveries run in parallel");
    assert!(rx.max_in_flight() <= webhooks::CONCURRENCY);
    let mut ids: Vec<String> = rx
        .received()
        .iter()
        .map(|r| r.header("x-accounts-delivery-id").to_string())
        .collect();
    assert_eq!(ids.len(), total, "each delivery was sent once");
    ids.sort();
    ids.dedup();
    assert_eq!(ids.len(), total);
}

#[tokio::test]
async fn an_attempt_past_the_claim_budget_is_abandoned_and_left_to_its_lease() {
    let ctx = TestContext::new().await;
    let rx = start_receiver().await;
    rx.set_delay(std::time::Duration::from_secs(3));
    let (app, _) = ctx.app("stall").await;
    ctx.set_app_webhook(&app.app_id, &rx.url("hook")).await;
    let ev = ping(&ctx, &app.app_id).await;
    let deliverer = WebhookDeliverer::new(&ctx.state).expect("client");

    let started = std::time::Instant::now();
    let outcomes = deliverer
        .deliver_due_within(10, std::time::Duration::from_millis(300))
        .await
        .expect("cycle");
    assert_eq!(
        outcomes,
        vec![DeliveryOutcome::Abandoned {
            delivery_id: ev.delivery_id
        }]
    );
    assert!(
        started.elapsed() < std::time::Duration::from_secs(2),
        "the budget cut the attempt short"
    );
    let d = delivery(&ctx, ev.delivery_id).await;
    assert_eq!((d.status.as_str(), d.attempts), ("pending", 0));
    assert!(
        d.locked_until
            .is_some_and(|until| seconds_until(until) > 30),
        "the lease stays until it runs out"
    );
    assert!(
        attempts(&ctx, ev.delivery_id).await.is_empty(),
        "nothing recorded"
    );
    assert!(
        webhooks::claim_due(&ctx.state.db, 10, 60)
            .await
            .expect("claim")
            .is_empty(),
        "no other worker can take it while the lease holds"
    );
}

#[tokio::test]
async fn a_graceful_stop_claims_nothing_new_and_finishes_the_attempts_in_flight() {
    let ctx = TestContext::new().await;
    let rx = start_receiver().await;
    rx.set_delay(std::time::Duration::from_millis(800));
    let (app, _) = ctx.app("stop").await;
    ctx.set_app_webhook(&app.app_id, &rx.url("hook")).await;
    for _ in 0..5 {
        ping(&ctx, &app.app_id).await;
    }
    let (stop, shutdown) = accounts_worker::Shutdown::channel();
    let deliverer = WebhookDeliverer::new(&ctx.state).expect("client");
    let handle = tokio::spawn(webhooks::run(deliverer, shutdown));
    for _ in 0..100 {
        if rx.received().len() == 5 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    assert_eq!(rx.received().len(), 5, "all five attempts are in flight");
    stop.send(true).expect("stop");
    // Due work that shows up after the stop is left for the next start (or another node).
    let late = ping(&ctx, &app.app_id).await;
    tokio::time::timeout(std::time::Duration::from_secs(5), handle)
        .await
        .expect("the loop stops within one attempt")
        .expect("no panic");
    assert_eq!(rx.answered(), 5);
    assert_eq!(
        delivered_count(&ctx).await,
        5,
        "nothing in flight was cut off"
    );
    let d = delivery(&ctx, late.delivery_id).await;
    assert_eq!((d.status.as_str(), d.attempts), ("pending", 0));
    assert!(d.locked_until.is_none(), "not claimed after the stop");
    assert_eq!(leased_now(&ctx).await, 0);
}

#[tokio::test]
async fn a_replay_gets_seventy_two_hours_from_the_replay_itself() {
    let ctx = TestContext::new().await;
    let rx = start_receiver().await;
    let (app, _) = ctx.app("requeue").await;
    ctx.set_app_webhook(&app.app_id, &rx.url("hook")).await;
    rx.fail_next(100, 500);
    let deliverer = WebhookDeliverer::new(&ctx.state).expect("client");
    let ev = ping(&ctx, &app.app_id).await;
    // Replayed 71 hours ago (the apps crate stamps requeued_at), and the next retry (10 s
    // later) still falls inside its window, although the event itself is 300 hours old.
    sqlx::query(
        "update webhook_deliveries set created_at = now() - interval '300 hours', status = 'pending', \
         attempts = 0, manual_replays = 1, requeued_at = now() - interval '71 hours', \
         next_attempt_at = now() where id = $1",
    )
    .bind(ev.delivery_id)
    .execute(&mut *ctx.conn().await)
    .await
    .expect("replay");
    assert!(
        matches!(
            deliverer.deliver_due(10).await.expect("cycle").as_slice(),
            [DeliveryOutcome::Retrying { .. }]
        ),
        "71 hours after the replay it is still retried"
    );
    // 73 hours after the replay the next failure is final, whatever the attempt count.
    sqlx::query(
        "update webhook_deliveries set attempts = 1, requeued_at = now() - interval '73 hours', \
         next_attempt_at = now() where id = $1",
    )
    .bind(ev.delivery_id)
    .execute(&mut *ctx.conn().await)
    .await
    .expect("time travel");
    assert!(matches!(
        deliverer.deliver_due(10).await.expect("cycle").as_slice(),
        [DeliveryOutcome::Failed { .. }]
    ));
}
