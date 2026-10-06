//! A Silicon's own webhook: `PUT`/`DELETE /v1/me/webhook`, `POST /v1/me/webhook/test`.

use accounts_core::events;
use accounts_core::models::WebhookTargetKind;
use accounts_core::test_support::{Req, TestContext, test_settings};
use serde_json::json;

use crate::common::*;

#[tokio::test]
async fn a_silicon_sets_tests_and_removes_its_webhook() {
    let ctx = TestContext::new().await;
    let custodian = ctx.carbon().await;
    let (silicon, _) = ctx.silicon(&custodian.uuid).await;
    let t = token(&ctx, &silicon).await;

    // No webhook yet: the test call says so.
    let r = call(&ctx, Req::post("/v1/me/webhook/test").bearer(&t)).await;
    assert_eq!(r.status, 409);
    assert_eq!(r.error_code(), Some("webhook_not_set"));

    let r = call(
        &ctx,
        Req::put("/v1/me/webhook")
            .bearer(&t)
            .json(json!({"url": "http://127.0.0.1:8593/hooks/self"})),
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(r.json["webhook_url"], "http://127.0.0.1:8593/hooks/self");
    let secret = r.json["webhook_secret"]
        .as_str()
        .expect("secret")
        .to_string();
    assert!(secret.starts_with("whsec_"));
    // Stored encrypted; the delivery side reads back exactly this secret.
    let mut conn = ctx.conn().await;
    let stored = events::current_secret(
        &mut conn,
        &ctx.state.keys.keyring,
        WebhookTargetKind::Silicon,
        &silicon.uuid,
    )
    .await
    .expect("secret");
    assert_eq!(stored.as_deref(), Some(secret.as_str()));
    drop(conn);

    // A new PUT rotates the secret.
    let again = call(
        &ctx,
        Req::put("/v1/me/webhook")
            .bearer(&t)
            .json(json!({"url": "http://127.0.0.1:8593/hooks/self2"})),
    )
    .await;
    assert_ne!(again.json["webhook_secret"], secret);

    let r = call(&ctx, Req::post("/v1/me/webhook/test").bearer(&t)).await;
    assert_eq!(r.status, 202, "{}", r.json);
    assert_eq!(r.json["type"], "ping");
    let events = silicon_events(&ctx, &silicon.uuid).await;
    assert_eq!(events.last().map(|(t, _)| t.as_str()), Some("ping"));
    assert_eq!(
        events.last().map(|(_, p)| p["event_id"].clone()),
        Some(r.json["event_id"].clone())
    );
    assert_eq!(
        delivery_urls(&ctx, &silicon.uuid, "ping").await,
        vec!["http://127.0.0.1:8593/hooks/self2".to_string()]
    );

    let r = call(&ctx, Req::delete("/v1/me/webhook").bearer(&t)).await;
    assert_eq!(r.status, 204);
    assert_eq!(account(&ctx, &silicon.uuid).await.webhook_url, None);
    // Removing again is fine.
    assert_eq!(
        call(&ctx, Req::delete("/v1/me/webhook").bearer(&t))
            .await
            .status,
        204
    );
    let actions = audit_actions(&ctx, &silicon.uuid).await;
    assert!(actions.contains(&"silicon.webhook.set".to_string()));
    assert!(actions.contains(&"silicon.webhook.removed".to_string()));
}

#[tokio::test]
async fn only_silicons_and_valid_urls() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let ct = token(&ctx, &carbon).await;
    let r = call(
        &ctx,
        Req::put("/v1/me/webhook")
            .bearer(&ct)
            .json(json!({"url": "https://hooks.example.com/x"})),
    )
    .await;
    assert_eq!(r.status, 403);
    assert_eq!(r.error_code(), Some("silicon_only"));

    let (silicon, _) = ctx.silicon(&carbon.uuid).await;
    let st = token(&ctx, &silicon).await;
    for bad in [
        "not a url",
        "ftp://hooks.example.com/x",
        "https://user:pw@hooks.example.com/x",
        "",
    ] {
        let r = call(
            &ctx,
            Req::put("/v1/me/webhook")
                .bearer(&st)
                .json(json!({"url": bad})),
        )
        .await;
        assert_eq!(r.status, 422, "{bad}: {}", r.json);
        assert!(
            r.json["error"]["details"]["fields"]["url"].is_string(),
            "{bad}"
        );
    }
    let r = call(&ctx, Req::put("/v1/me/webhook").bearer(&st).json(json!({}))).await;
    assert_eq!(r.status, 422);
}

#[tokio::test]
async fn production_rules_refuse_private_webhook_targets() {
    let mut settings = test_settings();
    settings.webhook_allow_private = false;
    let ctx = TestContext::with_settings(settings).await;
    let carbon = ctx.carbon().await;
    let (silicon, _) = ctx.silicon(&carbon.uuid).await;
    let st = token(&ctx, &silicon).await;
    for bad in [
        "http://hooks.example.com/x",
        "https://127.0.0.1/x",
        "https://10.0.0.8/x",
        "https://localhost/x",
    ] {
        let r = call(
            &ctx,
            Req::put("/v1/me/webhook")
                .bearer(&st)
                .json(json!({"url": bad})),
        )
        .await;
        assert_eq!(r.status, 422, "{bad}: {}", r.json);
    }
    let r = call(
        &ctx,
        Req::put("/v1/me/webhook")
            .bearer(&st)
            .json(json!({"url": "https://hooks.example.com/silicon"})),
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.json);
}

/// Ping deliveries of a Silicon: (status, last_error), oldest first.
async fn ping_deliveries(ctx: &TestContext, uuid: &str) -> Vec<(String, Option<String>)> {
    sqlx::query_as(
        "select d.status, d.last_error from webhook_deliveries d join webhook_events e on e.event_id = d.event_id \
         where d.target_kind = 'silicon' and d.target_id = $1 and e.type = 'ping' order by d.created_at, d.id",
    )
    .bind(uuid)
    .fetch_all(&ctx.state.db)
    .await
    .expect("deliveries")
}

#[tokio::test]
async fn test_pings_are_limited_and_only_the_latest_is_retried() {
    let ctx = TestContext::new().await;
    let custodian = ctx.carbon().await;
    let (silicon, _) = ctx.silicon(&custodian.uuid).await;
    let t = token(&ctx, &silicon).await;
    let test = || Req::post("/v1/me/webhook/test").bearer(&t);

    // Without a webhook nothing is queued and nothing is counted.
    for _ in 0..3 {
        assert_eq!(
            call(&ctx, test()).await.error_code(),
            Some("webhook_not_set")
        );
    }
    let r = call(
        &ctx,
        Req::put("/v1/me/webhook")
            .bearer(&t)
            .json(json!({"url": "http://127.0.0.1:9/elsewhere"})),
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.json);
    // Another event for the Silicon that is waiting too: never touched by test pings.
    let mut conn = ctx.conn().await;
    events::emit_to_silicon(&mut conn, &silicon.uuid, "silicon.updated", json!({}))
        .await
        .expect("event");
    drop(conn);

    let limit = accounts_silicons::WEBHOOK_TESTS_PER_SILICON.max;
    assert_eq!(limit, 10);
    for i in 0..limit {
        let r = call(&ctx, test()).await;
        assert_eq!(r.status, 202, "ping {i}: {}", r.json);
        assert_eq!(r.json["superseded_pings"], if i == 0 { 0 } else { 1 });
        assert_eq!(r.json["url"], "http://127.0.0.1:9/elsewhere");
        // At most one test ping is ever waiting to be retried: the latest.
        let pending: Vec<_> = ping_deliveries(&ctx, &silicon.uuid)
            .await
            .into_iter()
            .filter(|(s, _)| s == "pending")
            .collect();
        assert_eq!(pending.len(), 1, "after ping {i}");
    }
    let all = ping_deliveries(&ctx, &silicon.uuid).await;
    assert_eq!(all.len(), 10);
    for (status, error) in &all[..9] {
        assert_eq!(status, "failed");
        assert!(
            error
                .as_deref()
                .is_some_and(|e| e.starts_with("Superseded by a newer test ping"))
        );
    }
    assert_eq!(all[9], ("pending".to_string(), None));
    assert_eq!(
        delivery_urls(&ctx, &silicon.uuid, "silicon.updated")
            .await
            .len(),
        1
    );
    let other: String = sqlx::query_scalar(
        "select d.status from webhook_deliveries d join webhook_events e on e.event_id = d.event_id \
         where d.target_id = $1 and e.type = 'silicon.updated'",
    )
    .bind(&silicon.uuid)
    .fetch_one(&ctx.state.db)
    .await
    .expect("other");
    assert_eq!(other, "pending");

    // The 11th within the hour is refused, precisely.
    let r = call(&ctx, test()).await;
    assert_eq!(r.status, 429, "{}", r.json);
    assert_eq!(r.error_code(), Some("rate_limited"));
    assert!(r.headers.get("retry-after").is_some());
    assert!(
        r.json["error"]["message"]
            .as_str()
            .expect("message")
            .contains("webhook test pings for this Silicon: the limit is 10 per hour")
    );
    assert!(r.json["error"]["hint"].is_string());
    assert_eq!(ping_deliveries(&ctx, &silicon.uuid).await.len(), 10);

    // A ping a worker is sending right now (leased) is left to finish.
    ctx.exec(&format!(
        "update webhook_deliveries set locked_until = now() + interval '1 minute' \
         where target_id = '{}' and status = 'pending'; delete from rate_limits;",
        silicon.uuid
    ))
    .await;
    let r = call(&ctx, test()).await;
    assert_eq!(r.status, 202, "{}", r.json);
    assert_eq!(r.json["superseded_pings"], 0);
}
