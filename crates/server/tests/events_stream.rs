//! `GET /v1/events/stream` through the whole router: apps (stream subscriptions), Silicons,
//! custodians and waiting Silicons; resume, filters, limits and every way a stream ends.

use std::time::Duration;

use accounts_core::test_support::{Req, Resp, TestContext, call};
use accounts_server::routes::events::{StreamHub, Timing};
use accounts_server::{Policy, build_router_with_streams};
use axum::Router;
use axum::body::Body;
use axum::http::{HeaderMap, Request, StatusCode};
use http_body_util::BodyExt as _;
use serde_json::{Value, json};
use tower::ServiceExt as _;

const WAIT: Duration = Duration::from_secs(15);

fn fast() -> Timing {
    Timing {
        poll: Duration::from_millis(50),
        heartbeat: Duration::from_millis(300),
        recheck: Duration::from_millis(100),
        max_duration: Duration::from_secs(60),
    }
}

fn router(ctx: &TestContext, hub: &StreamHub) -> Router {
    build_router_with_streams(ctx.state.clone(), Policy::default(), hub.clone())
}

async fn send(ctx: &TestContext, req: Req) -> Resp {
    call(accounts_server::build_router(ctx.state.clone()), req).await
}

/// One SSE frame.
#[derive(Debug, Default, Clone)]
struct Frame {
    id: Option<String>,
    event: Option<String>,
    data: Option<String>,
    comments: Vec<String>,
    retry: Option<u64>,
}

impl Frame {
    fn json(&self) -> Value {
        serde_json::from_str(self.data.as_deref().unwrap_or("null")).expect("data is JSON")
    }
}

struct Stream {
    status: StatusCode,
    headers: HeaderMap,
    body: Body,
    buf: String,
    ended: bool,
}

/// Opens a stream (status and headers; read frames with [`Stream::frame`]).
async fn open(router: Router, req: Req) -> Stream {
    let mut builder = Request::builder().method(req.method).uri(req.uri);
    for (k, v) in &req.headers {
        builder = builder.header(k, v);
    }
    let response = router
        .oneshot(builder.body(Body::empty()).expect("request"))
        .await
        .unwrap_or_else(|e| match e {});
    Stream {
        status: response.status(),
        headers: response.headers().clone(),
        body: response.into_body(),
        buf: String::new(),
        ended: false,
    }
}

impl Stream {
    async fn error(self) -> Value {
        let bytes = self.body.collect().await.expect("body").to_bytes();
        serde_json::from_slice(&bytes).expect("error JSON")
    }

    /// The next frame, `None` once the stream ended.
    async fn frame(&mut self) -> Option<Frame> {
        loop {
            if let Some(at) = self.buf.find("\n\n") {
                let raw: String = self.buf.drain(..at + 2).collect();
                let mut f = Frame::default();
                for line in raw.lines() {
                    if let Some(c) = line.strip_prefix(':') {
                        f.comments.push(c.trim().to_string());
                    } else if let Some((k, v)) = line.split_once(':') {
                        let v = v.strip_prefix(' ').unwrap_or(v).to_string();
                        match k {
                            "id" => f.id = Some(v),
                            "event" => f.event = Some(v),
                            "data" => f.data = Some(v),
                            "retry" => f.retry = v.parse().ok(),
                            _ => {}
                        }
                    }
                }
                return Some(f);
            }
            if self.ended {
                return None;
            }
            let next = tokio::time::timeout(WAIT, self.body.frame())
                .await
                .expect("the stream stayed silent for too long");
            match next {
                Some(Ok(frame)) => {
                    if let Ok(data) = frame.into_data() {
                        self.buf.push_str(std::str::from_utf8(&data).expect("utf8"));
                    }
                }
                Some(Err(e)) => panic!("stream error: {e}"),
                None => self.ended = true,
            }
        }
    }

    /// The next frame that is an event (skips the greeting and heartbeats).
    async fn event(&mut self) -> Frame {
        loop {
            let f = self.frame().await.expect("the stream ended");
            if f.event.is_some() {
                return f;
            }
        }
    }
}

async fn token(ctx: &TestContext, account: &accounts_core::models::Account) -> String {
    ctx.first_party_tokens(account).await.access_token
}

#[tokio::test]
async fn an_app_streams_its_subscription_and_resumes() {
    let ctx = TestContext::new().await;
    let hub = StreamHub::with_timing(fast());
    let (app, secret) = ctx.app("streamer").await;
    let carbon = ctx.carbon().await;
    ctx.membership(
        &app.app_id,
        &carbon.uuid,
        &[accounts_core::models::Scope::Profile],
    )
    .await;
    let carbon_token = token(&ctx, &carbon).await;
    let stream_req = || Req::get("/v1/events/stream").basic(&app.app_id, &secret);

    // No stream subscription yet.
    let s = open(router(&ctx, &hub), stream_req()).await;
    assert_eq!(s.status, 409);
    let e = s.error().await;
    assert_eq!(e["error"]["code"], "stream_subscription_required");
    assert!(
        e["error"]["hint"]
            .as_str()
            .is_some_and(|h| h.contains("subscriptions"))
    );

    let r = send(
        &ctx,
        Req::post(&format!("/v1/apps/{}/subscriptions", app.app_id))
            .basic(&app.app_id, &secret)
            .json(json!({"delivery": "stream", "updates": ["id_change", "display_name_change"]})),
    )
    .await;
    assert_eq!(r.status, 201, "{}", r.json);
    let sub_id = r.json["id"].as_str().expect("id").to_string();

    let mut s = open(router(&ctx, &hub), stream_req()).await;
    assert_eq!(s.status, 200);
    assert_eq!(s.headers["content-type"], "text/event-stream");
    assert_eq!(s.headers["cache-control"], "no-store");
    assert_eq!(s.headers["accounts-version"], "2026-10-01");
    let hello = s.frame().await.expect("greeting");
    assert_eq!(hello.retry, Some(5000));
    assert_eq!(hello.comments, vec!["connected"]);
    assert_eq!(hub.open_streams(), 1);

    // A display name change arrives with the webhook body.
    let r = send(
        &ctx,
        Req::patch("/v1/me")
            .bearer(&carbon_token)
            .json(json!({"display_name": "Ada Streamed"})),
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.json);
    let first = s.event().await;
    assert_eq!(first.event.as_deref(), Some("account.updated"));
    let body = first.json();
    assert_eq!(body["type"], "account.updated");
    assert_eq!(body["app_id"], app.app_id.as_str());
    assert_eq!(body["event_id"].as_str(), first.id.as_deref());
    assert_eq!(body["data"]["changed"], json!(["display_name"]));
    assert_eq!(body["data"]["account"]["display_name"], "Ada Streamed");

    // A timezone change is not picked, an id change is: the next event is the id change.
    let r = send(
        &ctx,
        Req::patch("/v1/me")
            .bearer(&carbon_token)
            .json(json!({"timezone": "Europe/London"})),
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.json);
    let new_id = format!("c:streamed-{}", accounts_core::test_support::rand_suffix());
    let r = send(
        &ctx,
        Req::post("/v1/me/id")
            .bearer(&carbon_token)
            .json(json!({"id": new_id})),
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.json);
    let second = s.event().await;
    assert_eq!(second.event.as_deref(), Some("account.id_changed"));
    assert_eq!(second.json()["data"]["new_id"], new_id.as_str());

    // A test ping on the subscription.
    let r = send(
        &ctx,
        Req::post(&format!(
            "/v1/apps/{}/subscriptions/{sub_id}/test",
            app.app_id
        ))
        .basic(&app.app_id, &secret),
    )
    .await;
    assert_eq!(r.status, 202, "{}", r.json);
    let ping = s.event().await;
    assert_eq!(ping.event.as_deref(), Some("ping"));
    assert_eq!(ping.id.as_deref(), r.json["event_id"].as_str());

    // Resume after the first event: the rest arrives again, in order.
    let mut resumed = open(
        router(&ctx, &hub),
        stream_req().header("last-event-id", first.id.as_deref().expect("id")),
    )
    .await;
    assert_eq!(resumed.status, 200);
    assert_eq!(resumed.event().await.id, second.id);
    assert_eq!(resumed.event().await.id, ping.id);
    // ?after= does the same, and types= filters.
    let mut filtered = open(
        router(&ctx, &hub),
        Req::get(&format!(
            "/v1/events/stream?after={}&types=ping",
            first.id.as_deref().expect("id")
        ))
        .basic(&app.app_id, &secret),
    )
    .await;
    assert_eq!(filtered.status, 200);
    assert_eq!(filtered.event().await.id, ping.id);
    assert_eq!(hub.open_streams(), 3);

    // Cursors must belong to this feed; types must be app event types.
    for (query, code) in [
        (
            "?after=0199aaaa-0000-7000-8000-000000000000",
            "unknown_event_id",
        ),
        ("?after=nope", "unknown_event_id"),
        ("?types=silicon.updated", "invalid_query"),
    ] {
        let s = open(
            router(&ctx, &hub),
            Req::get(&format!("/v1/events/stream{query}")).basic(&app.app_id, &secret),
        )
        .await;
        assert_eq!(s.status, 400, "{query}");
        assert_eq!(s.error().await["error"]["code"], code, "{query}");
    }

    // Deleting the subscription ends its streams.
    let r = send(
        &ctx,
        Req::delete(&format!("/v1/apps/{}/subscriptions/{sub_id}", app.app_id))
            .basic(&app.app_id, &secret),
    )
    .await;
    assert_eq!(r.status, 204);
    let closed = s.event().await;
    assert_eq!(closed.event.as_deref(), Some("stream.closed"));
    assert_eq!(closed.json()["reason"], "subscription_deleted");
    assert!(closed.id.is_none(), "control frames carry no id");
    assert!(s.frame().await.is_none(), "the stream ended");
    drop(s);
    drop(resumed);
    drop(filtered);
    assert_eq!(hub.open_streams(), 0, "permits are freed");
}

#[tokio::test]
async fn silicons_and_their_custodians_stream_silicon_events() {
    let ctx = TestContext::new().await;
    let hub = StreamHub::with_timing(fast());
    let carbon = ctx.carbon().await;
    let (silicon, _stk) = ctx.silicon(&carbon.uuid).await;
    let silicon_token = token(&ctx, &silicon).await;
    let carbon_token = token(&ctx, &carbon).await;

    let mut own = open(
        router(&ctx, &hub),
        Req::get("/v1/events/stream").bearer(&silicon_token),
    )
    .await;
    assert_eq!(own.status, 200);
    let mut custodian = open(
        router(&ctx, &hub),
        Req::get("/v1/events/stream?types=silicon.updated").bearer(&carbon_token),
    )
    .await;
    assert_eq!(custodian.status, 200);
    // The account site's session works too.
    let cookie = ctx.browser_session(&carbon).await;
    let mut by_cookie = open(
        router(&ctx, &hub),
        Req::get("/v1/events/stream").session(&ctx.state.settings, &cookie),
    )
    .await;
    assert_eq!(by_cookie.status, 200);

    // The custodian renames the Silicon, which has no webhook: the event is still recorded.
    let r = send(
        &ctx,
        Req::patch(&format!("/v1/me/silicons/{}", silicon.uuid))
            .bearer(&carbon_token)
            .json(json!({"display_name": "Scout Live"})),
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.json);
    for s in [&mut own, &mut custodian, &mut by_cookie] {
        let ev = s.event().await;
        assert_eq!(ev.event.as_deref(), Some("silicon.updated"));
        let body = ev.json();
        assert_eq!(body["silicon"], silicon.uuid.as_str());
        assert_eq!(body["app_id"], Value::Null);
        assert_eq!(body["data"]["changed"], json!(["display_name"]));
    }
    let deliveries: i64 =
        sqlx::query_scalar("select count(*) from webhook_deliveries where target_id = $1")
            .bind(&silicon.uuid)
            .fetch_one(&ctx.state.db)
            .await
            .expect("count");
    assert_eq!(deliveries, 0, "no webhook, no delivery");

    // Rotating the STK ends the Silicon's sign-ins: its stream closes.
    let r = send(
        &ctx,
        Req::post(&format!("/v1/me/silicons/{}/stk", silicon.uuid)).bearer(&carbon_token),
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.json);
    let rotated = own.event().await;
    assert_eq!(rotated.event.as_deref(), Some("silicon.stk_rotated"));
    let closed = own.event().await;
    assert_eq!(closed.event.as_deref(), Some("stream.closed"));
    assert_eq!(closed.json()["reason"], "access_removed");

    // Nobody without credentials, and an app's token is not an account's.
    let s = open(router(&ctx, &hub), Req::get("/v1/events/stream")).await;
    assert_eq!(s.status, 401);
    assert_eq!(s.error().await["error"]["code"], "unauthenticated");
}

#[tokio::test]
async fn a_waiting_silicon_streams_until_its_custodian_decides() {
    let ctx = TestContext::new().await;
    let hub = StreamHub::with_timing(fast());
    let carbon = ctx.carbon().await;
    let handle = carbon.handle.clone().expect("c:id");
    let r = send(
        &ctx,
        Req::post("/v1/silicons").json(json!({
            "id": format!("si:waiting-{}", accounts_core::test_support::rand_suffix()),
            "display_name": "Waiting",
            "custodian": handle,
        })),
    )
    .await;
    assert_eq!(r.status, 201, "{}", r.json);
    let request_token = r.json["request_token"].as_str().expect("token").to_string();
    let request_id = r.json["request"]["id"]
        .as_str()
        .expect("request id")
        .to_string();

    let mut s = open(
        router(&ctx, &hub),
        Req::get("/v1/events/stream").bearer(&request_token),
    )
    .await;
    assert_eq!(s.status, 200);
    let carbon_token = token(&ctx, &carbon).await;
    let r = send(
        &ctx,
        Req::post(&format!("/v1/me/custodian-requests/{request_id}/accept")).bearer(&carbon_token),
    )
    .await;
    assert_eq!(r.status, 204, "{}", r.json);
    let accepted = s.event().await;
    assert_eq!(
        accepted.event.as_deref(),
        Some("silicon.custodian.accepted")
    );
    assert_eq!(accepted.json()["data"]["request_id"], request_id.as_str());
    let closed = s.event().await;
    assert_eq!(closed.json()["reason"], "request_decided");

    // Reconnecting after the decision closes at once; the decision can still be read again.
    let mut again = open(
        router(&ctx, &hub),
        Req::get("/v1/events/stream")
            .bearer(&request_token)
            .header("last-event-id", accepted.id.as_deref().expect("id")),
    )
    .await;
    assert_eq!(again.status, 200);
    assert_eq!(again.event().await.json()["reason"], "request_decided");

    let s = open(
        router(&ctx, &hub),
        Req::get("/v1/events/stream").bearer("sarq_not_a_real_token"),
    )
    .await;
    assert_eq!(s.status, 401);
    assert_eq!(s.error().await["error"]["code"], "invalid_request_token");
}

#[tokio::test]
async fn streams_are_limited_and_end_cleanly() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let carbon_token = token(&ctx, &carbon).await;

    // Five per caller; the sixth is told when to come back.
    let hub = StreamHub::with_timing(fast());
    let mut open_streams = Vec::new();
    for _ in 0..5 {
        let s = open(
            router(&ctx, &hub),
            Req::get("/v1/events/stream").bearer(&carbon_token),
        )
        .await;
        assert_eq!(s.status, 200);
        open_streams.push(s);
    }
    let s = open(
        router(&ctx, &hub),
        Req::get("/v1/events/stream").bearer(&carbon_token),
    )
    .await;
    assert_eq!(s.status, 429);
    assert!(s.headers.get("retry-after").is_some());
    let e = s.error().await;
    assert_eq!(e["error"]["code"], "too_many_streams");
    assert!(e["error"]["details"]["retry_after_seconds"].is_u64());

    // Shutting down ends every stream with server_restarting and refuses new ones.
    hub.close_all();
    for s in &mut open_streams {
        let closed = s.event().await;
        assert_eq!(closed.json()["reason"], "server_restarting");
        assert!(s.frame().await.is_none());
    }
    let s = open(
        router(&ctx, &hub),
        Req::get("/v1/events/stream").bearer(&carbon_token),
    )
    .await;
    assert_eq!(s.status, 503);
    assert!(s.headers.get("retry-after").is_some());

    // Streams last at most max_duration and send heartbeats while quiet.
    let short = StreamHub::with_timing(Timing {
        max_duration: Duration::from_millis(900),
        ..fast()
    });
    let mut s = open(
        router(&ctx, &short),
        Req::get("/v1/events/stream").bearer(&carbon_token),
    )
    .await;
    let mut heartbeats = 0;
    let closed = loop {
        let f = s.frame().await.expect("frame");
        if f.comments.iter().any(|c| c == "heartbeat") {
            heartbeats += 1;
        }
        if f.event.is_some() {
            break f;
        }
    };
    assert!(heartbeats >= 1, "a quiet stream sends heartbeats");
    assert_eq!(closed.json()["reason"], "max_duration");

    // A bearer stream ends when its token expires.
    let expiring = StreamHub::with_timing(fast());
    let mut conn = ctx.conn().await;
    let short_token = {
        let mut settings = (*ctx.state.settings).clone();
        settings.access_token_ttl_seconds = 1;
        let tokens = accounts_core::repo::tokens::issue_tokens(
            &mut conn,
            &ctx.state.keys,
            &settings,
            accounts_core::repo::tokens::IssueRequest {
                account: &carbon,
                app_id: accounts_core::FIRST_PARTY_APP_ID,
                origin: accounts_core::models::TokenOrigin::CliCode,
                scopes: &[accounts_core::models::Scope::Profile],
                browser_session_id: None,
                label: Some("short"),
                ip: None,
                user_agent: None,
                nonce: None,
                auth_time: None,
            },
        )
        .await
        .expect("tokens");
        tokens.access_token
    };
    drop(conn);
    let mut s = open(
        router(&ctx, &expiring),
        Req::get("/v1/events/stream").bearer(&short_token),
    )
    .await;
    assert_eq!(s.status, 200);
    assert_eq!(s.event().await.json()["reason"], "token_expired");
}
