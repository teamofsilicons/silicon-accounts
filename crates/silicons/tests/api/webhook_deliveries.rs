//! Deliveries of a Silicon's own webhook ("Silicon webhooks … follow these same rules": failed
//! deliveries can be replayed): `GET /v1/me/webhook/deliveries[/{id}]` and
//! `POST /v1/me/webhook/replay` for the Silicon, the same under `/v1/me/silicons/{uuid}/webhook/`
//! for its custodian.

use accounts_core::events;
use accounts_core::test_support::{Req, Resp, TestContext};
use serde_json::{Value, json};

use crate::common::*;

/// Queues an event for the Silicon's webhook, as a change to the Silicon does; returns
/// (event_id, delivery_id).
async fn emit(ctx: &TestContext, silicon_uuid: &str, event_type: &str) -> (String, String) {
    let mut conn = ctx.conn().await;
    let e = events::emit_to_silicon(
        &mut conn,
        silicon_uuid,
        event_type,
        json!({"uuid": silicon_uuid, "changed": ["display_name"]}),
    )
    .await
    .expect("emit")
    .expect("the Silicon has a webhook");
    (e.event_id.to_string(), e.delivery_id.to_string())
}

/// What the worker leaves behind when a delivery gives up after `attempts` attempts (each a 503,
/// 72 hours in): `failed`, with its attempts recorded.
async fn give_up(ctx: &TestContext, delivery_id: &str, attempts: i32) {
    for i in 0..attempts {
        sqlx::query(
            "insert into webhook_attempts (delivery_id, attempted_at, status_code, error, duration_ms) \
             values ($1::uuid, now() - make_interval(mins => $2), 503, 'HTTP 503 from the endpoint', 12)",
        )
        .bind(delivery_id)
        .bind(attempts - i)
        .execute(&ctx.state.db)
        .await
        .expect("attempt");
    }
    sqlx::query(
        "update webhook_deliveries set status = 'failed', attempts = $2, last_status = 503, \
         last_error = 'Still failing 72 hours after the event: HTTP 503', last_attempt_at = now(), \
         locked_until = null where id = $1::uuid",
    )
    .bind(delivery_id)
    .bind(attempts)
    .execute(&ctx.state.db)
    .await
    .expect("give up");
}

/// A delivery row: (status, attempts, manual_replays, url, replayed (requeued_at set), event_id,
/// due now).
async fn row(
    ctx: &TestContext,
    delivery_id: &str,
) -> (String, i32, i32, String, bool, String, bool) {
    sqlx::query_as(
        "select status, attempts, manual_replays, url, requeued_at is not null, event_id::text, \
         next_attempt_at <= now() from webhook_deliveries where id = $1::uuid",
    )
    .bind(delivery_id)
    .fetch_one(&ctx.state.db)
    .await
    .expect("delivery row")
}

fn ids(r: &Resp) -> Vec<String> {
    r.json["items"]
        .as_array()
        .expect("items")
        .iter()
        .map(|i| i["id"].as_str().expect("id").to_string())
        .collect()
}

fn reasons(r: &Resp) -> Vec<(String, String)> {
    r.json["skipped"]
        .as_array()
        .expect("skipped")
        .iter()
        .map(|s| {
            (
                s["delivery_id"].as_str().expect("delivery_id").to_string(),
                s["reason"].as_str().expect("reason").to_string(),
            )
        })
        .collect()
}

fn replay(token: &str, path: &str, key: &str, body: Value) -> Req {
    Req::post(path)
        .bearer(token)
        .header("idempotency-key", key)
        .json(body)
}

#[tokio::test]
async fn a_silicon_lists_inspects_and_replays_its_failed_deliveries() {
    let ctx = TestContext::new().await;
    let custodian = ctx.carbon().await;
    let (silicon, _) = ctx.silicon(&custodian.uuid).await;
    let st = token(&ctx, &silicon).await;
    let set = |url: &str| {
        Req::put("/v1/me/webhook")
            .bearer(&st)
            .json(json!({"url": url}))
    };
    assert_eq!(call(&ctx, set("http://127.0.0.1:9/old")).await.status, 200);

    let empty = call(&ctx, Req::get("/v1/me/webhook/deliveries").bearer(&st)).await;
    assert_eq!(empty.status, 200, "{}", empty.json);
    assert_eq!(empty.json, json!({"items": [], "next_cursor": null}));

    // Two events and a test ping fail for good; a fourth event is still being retried.
    let (e1, d1) = emit(&ctx, &silicon.uuid, "silicon.updated").await;
    let (_, d2) = emit(&ctx, &silicon.uuid, "silicon.id_changed").await;
    let ping = call(&ctx, Req::post("/v1/me/webhook/test").bearer(&st)).await;
    assert_eq!(ping.status, 202, "{}", ping.json);
    let dp = ping.json["delivery_id"].as_str().expect("ping").to_string();
    let (_, d4) = emit(&ctx, &silicon.uuid, "silicon.updated").await;
    give_up(&ctx, &d1, 3).await;
    give_up(&ctx, &d2, 1).await;
    give_up(&ctx, &dp, 2).await;

    // ---- listing: newest first, filtered, paginated ----
    let list = |q: &str| Req::get(&format!("/v1/me/webhook/deliveries{q}")).bearer(&st);
    let all = call(&ctx, list("")).await;
    assert_eq!(
        ids(&all),
        vec![d4.clone(), dp.clone(), d2.clone(), d1.clone()]
    );
    let failed = call(&ctx, list("?status=failed")).await;
    assert_eq!(ids(&failed), vec![dp.clone(), d2.clone(), d1.clone()]);
    let first = &failed.json["items"][2];
    assert_eq!(first["event_id"], e1.as_str());
    assert_eq!(first["type"], "silicon.updated");
    assert_eq!(first["account_uuid"], silicon.uuid.as_str());
    assert_eq!(first["url"], "http://127.0.0.1:9/old");
    assert_eq!(first["status"], "failed");
    assert_eq!(first["attempts"], 3);
    assert_eq!(first["last_status"], 503);
    assert!(first["last_error"].as_str().expect("error").contains("503"));
    assert!(
        first["next_attempt_at"].is_null(),
        "only pending ones have a next attempt"
    );
    assert!(first["last_attempt_at"].is_string() && first["created_at"].is_string());
    assert_eq!(first["manual_replays"], 0);
    assert!(all.json["items"][0]["next_attempt_at"].is_string());
    let page1 = call(&ctx, list("?limit=2")).await;
    assert_eq!(ids(&page1), vec![d4.clone(), dp.clone()]);
    let cursor = page1.json["next_cursor"].as_str().expect("cursor");
    let page2 = call(&ctx, list(&format!("?limit=2&cursor={cursor}"))).await;
    assert_eq!(ids(&page2), vec![d2.clone(), d1.clone()]);
    assert!(page2.json["next_cursor"].is_null());
    let bad = call(&ctx, list("?status=lost")).await;
    assert_eq!(bad.status, 400, "{}", bad.json);
    assert_eq!(bad.error_code(), Some("invalid_query"));
    assert_eq!(
        call(&ctx, list("?cursor=nonsense")).await.error_code(),
        Some("invalid_cursor")
    );

    // ---- one delivery: its attempts and the exact payload ----
    let one = call(
        &ctx,
        Req::get(&format!("/v1/me/webhook/deliveries/{d1}")).bearer(&st),
    )
    .await;
    assert_eq!(one.status, 200, "{}", one.json);
    assert_eq!(one.json["attempt_count"], 3);
    let attempts = one.json["attempts"].as_array().expect("attempts");
    assert_eq!(attempts.len(), 3);
    assert!(
        attempts
            .iter()
            .all(|a| a["status_code"] == 503 && a["duration_ms"] == 12)
    );
    assert_eq!(one.json["payload"]["event_id"], e1.as_str());
    assert_eq!(one.json["payload"]["type"], "silicon.updated");
    assert_eq!(one.json["payload"]["silicon"], silicon.uuid.as_str());
    assert_eq!(one.json["payload"]["app_id"], Value::Null);
    assert_eq!(one.json["payload_redacted"], false);
    for missing in [uuid::Uuid::now_v7().to_string(), "nope".to_string()] {
        let r = call(
            &ctx,
            Req::get(&format!("/v1/me/webhook/deliveries/{missing}")).bearer(&st),
        )
        .await;
        assert_eq!(r.status, 404, "{}", r.json);
        assert_eq!(r.error_code(), Some("delivery_not_found"));
        assert!(
            r.json["error"]["hint"]
                .as_str()
                .expect("hint")
                .contains("GET /v1/me/webhook/deliveries")
        );
    }

    // ---- replay by id: to the current URL, the same event ----
    assert_eq!(call(&ctx, set("http://127.0.0.1:9/new")).await.status, 200);
    let payload_before: Value =
        sqlx::query_scalar("select payload from webhook_events where event_id = $1::uuid")
            .bind(&e1)
            .fetch_one(&ctx.state.db)
            .await
            .expect("payload");
    let stranger = uuid::Uuid::now_v7().to_string();
    let body = json!({"delivery_ids": [d1, dp, d4, stranger]});
    let r = call(
        &ctx,
        replay(&st, "/v1/me/webhook/replay", "replay-1", body.clone()),
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(r.json["replayed"], json!([d1]));
    assert_eq!(
        reasons(&r),
        vec![
            (dp.clone(), "test_ping".to_string()),
            (d4.clone(), "already_pending".to_string()),
            (stranger.clone(), "not_found".to_string()),
        ]
    );
    assert!(
        r.json["skipped"][0]["message"]
            .as_str()
            .expect("message")
            .contains("POST /v1/me/webhook/test")
    );
    assert_eq!(r.json["remaining"], 0);
    assert_eq!(r.json["not_replayable"], 1);
    assert_eq!(r.json["url"], "http://127.0.0.1:9/new");
    assert_eq!(
        row(&ctx, &d1).await,
        (
            "pending".to_string(),
            0,
            1,
            "http://127.0.0.1:9/new".to_string(),
            true,
            e1.clone(),
            true
        ),
        "re-queued now with a fresh retry window, same event"
    );
    let payload_after: Value =
        sqlx::query_scalar("select payload from webhook_events where event_id = $1::uuid")
            .bind(&e1)
            .fetch_one(&ctx.state.db)
            .await
            .expect("payload");
    assert_eq!(
        payload_after, payload_before,
        "the signed body is unchanged"
    );
    assert_eq!(row(&ctx, &dp).await.0, "failed", "the ping stays failed");

    // The same Idempotency-Key gets the same answer and replays nothing twice.
    let again = call(&ctx, replay(&st, "/v1/me/webhook/replay", "replay-1", body)).await;
    assert_eq!(again.status, 200);
    assert_eq!(again.json, r.json);
    assert_eq!(
        again
            .headers
            .get("idempotent-replayed")
            .map(|v| v.to_str().unwrap_or("")),
        Some("true")
    );
    assert_eq!(row(&ctx, &d1).await.2, 1);

    // ---- replay by status: the failed events left, never the ping ----
    let r = call(
        &ctx,
        replay(
            &st,
            "/v1/me/webhook/replay",
            "replay-2",
            json!({"status": "failed"}),
        ),
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(r.json["replayed"], json!([d2]));
    assert_eq!(r.json["skipped"], json!([]));
    assert_eq!(r.json["remaining"], 0);
    assert_eq!(r.json["not_replayable"], 1);
    let r = call(
        &ctx,
        replay(
            &st,
            "/v1/me/webhook/replay",
            "replay-3",
            json!({"status": "failed"}),
        ),
    )
    .await;
    assert_eq!(r.json["replayed"], json!([]));
    assert_eq!(r.json["not_replayable"], 1);

    // A delivered delivery can be sent again by naming it.
    ctx.exec(&format!(
        "update webhook_deliveries set status = 'delivered', delivered_at = now(), attempts = 1 where id = '{d4}'"
    ))
    .await;
    let r = call(
        &ctx,
        replay(
            &st,
            "/v1/me/webhook/replay",
            "replay-4",
            json!({"delivery_ids": [d4]}),
        ),
    )
    .await;
    assert_eq!(r.json["replayed"], json!([d4]));
    let shown = call(
        &ctx,
        Req::get(&format!("/v1/me/webhook/deliveries/{d4}")).bearer(&st),
    )
    .await;
    assert_eq!(shown.json["status"], "pending");
    assert_eq!(shown.json["delivered_at"], Value::Null);
    assert_eq!(shown.json["manual_replays"], 1);

    // Precise refusals.
    for bad in [
        json!({}),
        json!({"delivery_ids": []}),
        json!({"status": "delivered"}),
        json!({"status": "failed", "delivery_ids": [d1]}),
        json!({"status": "failed", "since": "yesterday"}),
    ] {
        let r = call(
            &ctx,
            Req::post("/v1/me/webhook/replay")
                .bearer(&st)
                .json(bad.clone()),
        )
        .await;
        assert_eq!(r.status, 422, "{bad}: {}", r.json);
        assert_eq!(r.error_code(), Some("validation_failed"));
    }

    let actions = audit_actions(&ctx, &silicon.uuid).await;
    assert_eq!(
        actions
            .iter()
            .filter(|a| *a == "silicon.webhook.replayed")
            .count(),
        4,
        "every replay is in the Silicon's history (the idempotent repeat is not a new one): {actions:?}"
    );
}

#[tokio::test]
async fn replay_by_status_can_start_at_a_time() {
    let ctx = TestContext::new().await;
    let custodian = ctx.carbon().await;
    let (silicon, _) = ctx.silicon(&custodian.uuid).await;
    let st = token(&ctx, &silicon).await;
    let r = call(
        &ctx,
        Req::put("/v1/me/webhook")
            .bearer(&st)
            .json(json!({"url": "http://127.0.0.1:9/hook"})),
    )
    .await;
    assert_eq!(r.status, 200);
    let (_, old) = emit(&ctx, &silicon.uuid, "silicon.updated").await;
    let (_, recent) = emit(&ctx, &silicon.uuid, "silicon.updated").await;
    give_up(&ctx, &old, 1).await;
    give_up(&ctx, &recent, 1).await;
    ctx.exec(&format!(
        "update webhook_deliveries set created_at = now() - interval '3 days' where id = '{old}'"
    ))
    .await;
    let since = accounts_core::timefmt::format_rfc3339_ms(
        time::OffsetDateTime::now_utc() - time::Duration::days(1),
    );
    let r = call(
        &ctx,
        replay(
            &st,
            "/v1/me/webhook/replay",
            "since-1",
            json!({"status": "failed", "since": since}),
        ),
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(r.json["replayed"], json!([recent]));
    assert_eq!(r.json["remaining"], 0, "nothing failed is left since then");
    let r = call(
        &ctx,
        replay(
            &st,
            "/v1/me/webhook/replay",
            "since-2",
            json!({"status": "failed"}),
        ),
    )
    .await;
    assert_eq!(r.json["replayed"], json!([old]));
}

#[tokio::test]
async fn the_custodian_lists_and_replays_its_silicons_deliveries() {
    let ctx = TestContext::new().await;
    let custodian = ctx.carbon().await;
    let ct = token(&ctx, &custodian).await;
    let stranger = ctx.carbon().await;
    let xt = token(&ctx, &stranger).await;
    let (silicon, _) = ctx.silicon(&custodian.uuid).await;
    let si = silicon.handle.clone().expect("id");
    let base = format!("/v1/me/silicons/{}/webhook", silicon.uuid);
    let set = call(
        &ctx,
        Req::put(&base)
            .bearer(&ct)
            .json(json!({"url": "http://127.0.0.1:9/by-custodian"})),
    )
    .await;
    assert_eq!(set.status, 200, "{}", set.json);
    let (event, d1) = emit(&ctx, &silicon.uuid, "silicon.stk_rotated").await;
    give_up(&ctx, &d1, 2).await;

    // Other Carbons' Silicons are not revealed.
    for req in [
        Req::get(&format!("{base}/deliveries")).bearer(&xt),
        Req::get(&format!("{base}/deliveries/{d1}")).bearer(&xt),
        replay(
            &xt,
            &format!("{base}/replay"),
            "x-1",
            json!({"delivery_ids": [d1]}),
        ),
    ] {
        let r = call(&ctx, req).await;
        assert_eq!(r.status, 404, "{}", r.json);
        assert_eq!(r.error_code(), Some("silicon_not_found"));
    }
    assert_eq!(row(&ctx, &d1).await.0, "failed");

    // The custodian, by uuid or by si:id.
    for key in [silicon.uuid.as_str(), si.as_str()] {
        let r = call(
            &ctx,
            Req::get(&format!(
                "/v1/me/silicons/{key}/webhook/deliveries?status=failed"
            ))
            .bearer(&ct),
        )
        .await;
        assert_eq!(r.status, 200, "{}", r.json);
        assert_eq!(ids(&r), vec![d1.clone()]);
    }
    let one = call(
        &ctx,
        Req::get(&format!("{base}/deliveries/{d1}")).bearer(&ct),
    )
    .await;
    assert_eq!(one.status, 200, "{}", one.json);
    assert_eq!(one.json["event_id"], event.as_str());
    assert_eq!(one.json["attempts"].as_array().map(Vec::len), Some(2));
    let missing = call(
        &ctx,
        Req::get(&format!("{base}/deliveries/{}", uuid::Uuid::now_v7())).bearer(&ct),
    )
    .await;
    assert_eq!(missing.error_code(), Some("delivery_not_found"));
    assert!(
        missing.json["error"]["hint"]
            .as_str()
            .expect("hint")
            .contains(&format!("{base}/deliveries"))
    );

    let r = call(
        &ctx,
        replay(
            &ct,
            &format!("{base}/replay"),
            "c-1",
            json!({"delivery_ids": [d1]}),
        ),
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(r.json["replayed"], json!([d1]));
    assert_eq!(r.json["url"], "http://127.0.0.1:9/by-custodian");
    let (status, attempts, replays, url, requeued, event_id, _) = row(&ctx, &d1).await;
    assert_eq!(
        (
            status.as_str(),
            attempts,
            replays,
            url.as_str(),
            requeued,
            event_id.as_str()
        ),
        (
            "pending",
            0,
            1,
            "http://127.0.0.1:9/by-custodian",
            true,
            event.as_str()
        )
    );
    // In the history of the Silicon and of the custodian who asked, not the stranger's.
    assert!(
        audit_actions(&ctx, &silicon.uuid)
            .await
            .contains(&"silicon.webhook.replayed".to_string())
    );
    assert!(
        audit_actions(&ctx, &custodian.uuid)
            .await
            .contains(&"silicon.webhook.replayed".to_string())
    );
    assert!(
        !audit_actions(&ctx, &stranger.uuid)
            .await
            .contains(&"silicon.webhook.replayed".to_string())
    );

    // Each side has its own routes.
    let st = token(&ctx, &silicon).await;
    let r = call(&ctx, Req::get(&format!("{base}/deliveries")).bearer(&st)).await;
    assert_eq!(r.status, 403);
    assert_eq!(r.error_code(), Some("carbon_only"));
    let r = call(&ctx, Req::get("/v1/me/webhook/deliveries").bearer(&ct)).await;
    assert_eq!(r.status, 403);
    assert_eq!(r.error_code(), Some("silicon_only"));

    // Nowhere to send a replay without a webhook.
    assert_eq!(call(&ctx, Req::delete(&base).bearer(&ct)).await.status, 204);
    let r = call(
        &ctx,
        replay(
            &ct,
            &format!("{base}/replay"),
            "c-2",
            json!({"status": "failed"}),
        ),
    )
    .await;
    assert_eq!(r.status, 409, "{}", r.json);
    assert_eq!(r.error_code(), Some("webhook_not_set"));
    assert!(
        r.json["error"]["hint"]
            .as_str()
            .expect("hint")
            .contains(&format!("PUT {base}"))
    );
    // The deliveries are still listed.
    let r = call(&ctx, Req::get(&format!("{base}/deliveries")).bearer(&ct)).await;
    assert_eq!(ids(&r), vec![d1]);
}

#[tokio::test]
async fn a_silicon_never_reaches_another_silicons_deliveries() {
    let ctx = TestContext::new().await;
    let custodian = ctx.carbon().await;
    let (a, _) = ctx.silicon(&custodian.uuid).await;
    let (b, _) = ctx.silicon(&custodian.uuid).await;
    let at = token(&ctx, &a).await;
    let bt = token(&ctx, &b).await;
    for t in [&at, &bt] {
        let r = call(
            &ctx,
            Req::put("/v1/me/webhook")
                .bearer(t)
                .json(json!({"url": "http://127.0.0.1:9/shared"})),
        )
        .await;
        assert_eq!(r.status, 200);
    }
    let (_, theirs) = emit(&ctx, &b.uuid, "silicon.updated").await;
    give_up(&ctx, &theirs, 1).await;

    let r = call(&ctx, Req::get("/v1/me/webhook/deliveries").bearer(&at)).await;
    assert_eq!(ids(&r), Vec::<String>::new());
    let r = call(
        &ctx,
        Req::get(&format!("/v1/me/webhook/deliveries/{theirs}")).bearer(&at),
    )
    .await;
    assert_eq!(r.error_code(), Some("delivery_not_found"));
    let r = call(
        &ctx,
        replay(
            &at,
            "/v1/me/webhook/replay",
            "a-1",
            json!({"delivery_ids": [theirs]}),
        ),
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(r.json["replayed"], json!([]));
    assert_eq!(reasons(&r), vec![(theirs.clone(), "not_found".to_string())]);
    let r = call(
        &ctx,
        replay(
            &at,
            "/v1/me/webhook/replay",
            "a-2",
            json!({"status": "failed"}),
        ),
    )
    .await;
    assert_eq!(r.json["replayed"], json!([]));
    assert_eq!(row(&ctx, &theirs).await.0, "failed", "untouched");

    // Without a webhook of its own a Silicon gets told so.
    assert_eq!(
        call(&ctx, Req::delete("/v1/me/webhook").bearer(&bt))
            .await
            .status,
        204
    );
    let r = call(
        &ctx,
        replay(
            &bt,
            "/v1/me/webhook/replay",
            "b-1",
            json!({"delivery_ids": [theirs]}),
        ),
    )
    .await;
    assert_eq!(r.status, 409, "{}", r.json);
    assert_eq!(r.error_code(), Some("webhook_not_set"));
    assert_eq!(row(&ctx, &theirs).await.0, "failed");
}
