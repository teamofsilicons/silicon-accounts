//! App webhook management, deliveries and replay.

mod common;

use accounts_core::Settings;
use accounts_core::events;
use accounts_core::models::{AccountField, Scope};
use accounts_core::repo::memberships;
use accounts_core::test_support::{Req, TestContext};
use common::{call, owned_app};
use serde_json::{Value, json};
use uuid::Uuid;

async fn stored_secret(ctx: &TestContext, app_id: &str) -> Option<String> {
    let enc: Option<Vec<u8>> =
        sqlx::query_scalar("select webhook_secret_enc from app_signin_configs where app_id = $1")
            .bind(app_id)
            .fetch_one(&ctx.state.db)
            .await
            .expect("row");
    enc.map(|e| ctx.state.keys.keyring.decrypt_string(&e).expect("decrypt"))
}

#[tokio::test]
async fn set_rotate_test_and_remove_the_webhook() {
    let ctx = TestContext::new().await;
    let a = owned_app(&ctx, "wh").await;
    let base = format!("/v1/apps/{}/webhook", a.app_id);

    let r = call(
        &ctx,
        Req::post(&format!("{base}/test")).basic(&a.app_id, &a.secret),
    )
    .await;
    assert_eq!(r.status, 409);
    assert_eq!(r.error_code(), Some("webhook_not_set"));
    let r = call(
        &ctx,
        Req::post(&format!("{base}/rotate-secret")).basic(&a.app_id, &a.secret),
    )
    .await;
    assert_eq!(r.error_code(), Some("webhook_not_set"));

    let r = call(
        &ctx,
        Req::put(&base)
            .basic(&a.app_id, &a.secret)
            .json(json!({"url": "ftp://hooks.example.com/x"})),
    )
    .await;
    assert_eq!(r.status, 422);
    assert!(r.json["error"]["details"]["fields"]["url"].is_string());
    let r = call(
        &ctx,
        Req::put(&base)
            .basic(&a.app_id, &a.secret)
            .json(json!({"uri": "x"})),
    )
    .await;
    assert_eq!(r.status, 422, "unknown fields are refused: {}", r.json);

    let url = "http://127.0.0.1:8593/wh/webhooks";
    let r = call(
        &ctx,
        Req::put(&base)
            .basic(&a.app_id, &a.secret)
            .json(json!({"url": url})),
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(r.json["url"], url);
    let first = r.json["secret"].as_str().expect("secret").to_string();
    assert!(first.starts_with("whsec_"));
    assert_eq!(r.headers["cache-control"], "no-store");
    assert_eq!(
        stored_secret(&ctx, &a.app_id).await.as_deref(),
        Some(first.as_str())
    );
    let details = call(
        &ctx,
        Req::get(&format!("/v1/apps/{}", a.app_id)).basic(&a.app_id, &a.secret),
    )
    .await;
    assert_eq!(
        details.json["webhook"],
        json!({"url": url, "secret_set": true})
    );
    assert!(!details.json.to_string().contains(&first));

    // Setting it again issues a new secret; rotating too.
    let r = call(
        &ctx,
        Req::put(&base)
            .session(&ctx.state.settings, &a.cookie)
            .json(json!({"url": url})),
    )
    .await;
    assert_eq!(r.status, 200);
    let second = r.json["secret"].as_str().expect("secret").to_string();
    assert_ne!(first, second);

    // A retried rotation (same Idempotency-Key) returns the same secret instead of rotating twice.
    let rotate = || {
        Req::post(&format!("{base}/rotate-secret"))
            .basic(&a.app_id, &a.secret)
            .header("idempotency-key", "rot-1")
    };
    let r1 = call(&ctx, rotate()).await;
    let r2 = call(&ctx, rotate()).await;
    assert_eq!(r2.headers["idempotent-replayed"], "true");
    assert_eq!(r1.json["secret"], r2.json["secret"]);
    assert_eq!(r2.headers["cache-control"], "no-store");
    assert_eq!(
        stored_secret(&ctx, &a.app_id).await.as_deref(),
        r1.json["secret"].as_str()
    );
    let r = call(
        &ctx,
        Req::post(&format!("{base}/rotate-secret")).basic(&a.app_id, &a.secret),
    )
    .await;
    assert_eq!(r.status, 200);
    let third = r.json["secret"].as_str().expect("secret").to_string();
    assert_ne!(second, third);
    assert_eq!(
        stored_secret(&ctx, &a.app_id).await.as_deref(),
        Some(third.as_str())
    );

    // Test ping → a pending delivery of type ping.
    let r = call(
        &ctx,
        Req::post(&format!("{base}/test")).basic(&a.app_id, &a.secret),
    )
    .await;
    assert_eq!(r.status, 202, "{}", r.json);
    let event_id = r.json["event_id"].as_str().expect("event").to_string();
    let r = call(
        &ctx,
        Req::get(&format!("{base}/deliveries")).basic(&a.app_id, &a.secret),
    )
    .await;
    assert_eq!(r.json["items"][0]["event_id"], event_id.as_str());
    assert_eq!(r.json["items"][0]["type"], "ping");
    assert_eq!(r.json["items"][0]["status"], "pending");
    assert!(r.json["items"][0]["next_attempt_at"].is_string());

    // Removing it fails what can no longer be delivered (replayable later).
    let r = call(&ctx, Req::delete(&base).basic(&a.app_id, &a.secret)).await;
    assert_eq!(r.status, 204);
    let r = call(
        &ctx,
        Req::get(&format!("{base}/deliveries?status=failed")).basic(&a.app_id, &a.secret),
    )
    .await;
    assert_eq!(r.json["items"][0]["event_id"], event_id.as_str());
    assert!(
        r.json["items"][0]["last_error"]
            .as_str()
            .is_some_and(|e| e.contains("removed its webhook"))
    );
    assert_eq!(r.json["items"][0]["next_attempt_at"], Value::Null);
    let details = call(
        &ctx,
        Req::get(&format!("/v1/apps/{}", a.app_id)).basic(&a.app_id, &a.secret),
    )
    .await;
    assert_eq!(
        details.json["webhook"],
        json!({"url": null, "secret_set": false})
    );
    assert_eq!(
        call(&ctx, Req::delete(&base).basic(&a.app_id, &a.secret))
            .await
            .status,
        204,
        "idempotent"
    );
    let r = call(
        &ctx,
        Req::post(&format!("{base}/replay"))
            .basic(&a.app_id, &a.secret)
            .json(json!({"status": "failed"})),
    )
    .await;
    assert_eq!(r.status, 409, "replays need a current URL");
    assert_eq!(r.error_code(), Some("webhook_not_set"));
}

#[tokio::test]
async fn production_refuses_private_webhook_urls() {
    let mut settings = Settings::for_tests();
    settings.webhook_allow_private = false;
    let ctx = TestContext::with_settings(settings).await;
    let a = owned_app(&ctx, "whp").await;
    for url in [
        "http://hooks.example.com/x",
        "https://127.0.0.1/x",
        "https://10.0.0.8/x",
        "https://localhost/x",
    ] {
        let r = call(
            &ctx,
            Req::put(&format!("/v1/apps/{}/webhook", a.app_id))
                .basic(&a.app_id, &a.secret)
                .json(json!({"url": url})),
        )
        .await;
        assert_eq!(r.status, 422, "{url}: {}", r.json);
    }
    let r = call(
        &ctx,
        Req::put(&format!("/v1/apps/{}/webhook", a.app_id))
            .basic(&a.app_id, &a.secret)
            .json(json!({"url": "https://hooks.example.com/x"})),
    )
    .await;
    assert_eq!(r.status, 200);
}

/// Marks a delivery as finished the way the worker would, with attempts.
async fn finish(ctx: &TestContext, delivery_id: Uuid, status: &str, attempts: i32) {
    sqlx::query(
        "update webhook_deliveries set status = $2, attempts = $3, last_status = 500, last_error = 'HTTP 500 from the app', \
         last_attempt_at = now(), delivered_at = case when $2 = 'delivered' then now() end where id = $1",
    )
    .bind(delivery_id)
    .bind(status)
    .bind(attempts)
    .execute(&ctx.state.db)
    .await
    .expect("finish");
    for i in 0..attempts {
        sqlx::query("insert into webhook_attempts (delivery_id, status_code, error, duration_ms) values ($1, 500, 'HTTP 500', $2)")
            .bind(delivery_id)
            .bind(10 + i)
            .execute(&ctx.state.db)
            .await
            .expect("attempt");
    }
}

#[tokio::test]
async fn deliveries_detail_and_replay_respect_membership() {
    let ctx = TestContext::new().await;
    let a = owned_app(&ctx, "rep").await;
    let other = owned_app(&ctx, "rep-o").await;
    ctx.set_app_webhook(&a.app_id, "http://127.0.0.1:8593/rep/webhooks")
        .await;
    ctx.set_app_webhook(&other.app_id, "http://127.0.0.1:8593/rep-o/webhooks")
        .await;
    let member = ctx.carbon().await;
    let leaver = ctx.carbon().await;
    ctx.membership(&a.app_id, &member.uuid, &[Scope::Profile])
        .await;
    ctx.membership(&a.app_id, &leaver.uuid, &[Scope::Profile])
        .await;
    ctx.membership(&other.app_id, &member.uuid, &[Scope::Profile])
        .await;

    let mut conn = ctx.conn().await;
    let member_update = events::account_updated(&mut conn, &member, &[AccountField::DisplayName])
        .await
        .expect("emit");
    let mine = member_update
        .iter()
        .find(|e| e.target_id == a.app_id)
        .expect("event for a")
        .clone();
    let theirs = member_update
        .iter()
        .find(|e| e.target_id == other.app_id)
        .expect("event for other")
        .clone();
    let leaver_update = events::account_updated(&mut conn, &leaver, &[AccountField::DisplayName])
        .await
        .expect("emit")
        .remove(0);
    memberships::remove_access(&mut conn, &a.app_id, &leaver.uuid, &leaver.uuid)
        .await
        .expect("remove");
    let removed_notice = events::membership_access_removed(&mut conn, &a.app_id, &leaver.uuid)
        .await
        .expect("emit")
        .expect("webhook set");
    let ping = events::ping_app(&mut conn, &a.app_id)
        .await
        .expect("ping")
        .expect("set");
    drop(conn);
    finish(&ctx, mine.delivery_id, "failed", 7).await;
    finish(&ctx, theirs.delivery_id, "failed", 7).await;
    finish(&ctx, leaver_update.delivery_id, "failed", 7).await;
    finish(&ctx, removed_notice.delivery_id, "failed", 7).await;
    // ping stays pending.

    let base = format!("/v1/apps/{}/webhook", a.app_id);
    let r = call(
        &ctx,
        Req::get(&format!("{base}/deliveries?status=failed")).basic(&a.app_id, &a.secret),
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.json);
    let failed = r.json["items"].as_array().expect("items");
    assert_eq!(failed.len(), 3, "only this app's deliveries");
    assert!(
        failed
            .iter()
            .all(|d| d["attempts"] == 7 && d["last_status"] == 500 && d["manual_replays"] == 0)
    );
    let r = call(
        &ctx,
        Req::get(&format!("{base}/deliveries?limit=2")).basic(&a.app_id, &a.secret),
    )
    .await;
    assert_eq!(r.json["items"].as_array().map(Vec::len), Some(2));
    let cursor = r.json["next_cursor"].as_str().expect("cursor").to_string();
    let r2 = call(
        &ctx,
        Req::get(&format!("{base}/deliveries?limit=2&cursor={cursor}")).basic(&a.app_id, &a.secret),
    )
    .await;
    assert_eq!(r2.json["items"].as_array().map(Vec::len), Some(2));
    assert_eq!(r2.json["next_cursor"], Value::Null);
    let r = call(
        &ctx,
        Req::get(&format!("{base}/deliveries?status=lost")).basic(&a.app_id, &a.secret),
    )
    .await;
    assert_eq!(r.error_code(), Some("invalid_query"));

    // Detail: attempts + the exact payload.
    let r = call(
        &ctx,
        Req::get(&format!("{base}/deliveries/{}", mine.delivery_id)).basic(&a.app_id, &a.secret),
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(r.json["type"], "account.updated");
    assert_eq!(r.json["attempts"].as_array().map(Vec::len), Some(7));
    assert_eq!(r.json["attempts"][0]["status_code"], 500);
    assert_eq!(r.json["payload"]["event_id"], mine.event_id.to_string());
    assert_eq!(r.json["payload"]["app_id"], a.app_id.as_str());
    assert_eq!(r.json["payload"]["data"]["uuid"], member.uuid.as_str());
    assert_eq!(r.json["payload_redacted"], false);

    // The leaver removed the app's access: its delivery shows who it was about, not its data.
    let r = call(
        &ctx,
        Req::get(&format!("{base}/deliveries/{}", leaver_update.delivery_id))
            .basic(&a.app_id, &a.secret),
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(r.json["payload_redacted"], true);
    assert_eq!(
        r.json["payload"]["data"],
        json!({"uuid": leaver.uuid, "membership_id": format!("{}:{}", a.app_id, leaver.uuid)})
    );
    assert_eq!(
        r.json["payload"]["event_id"],
        leaver_update.event_id.to_string()
    );
    assert!(
        r.json["payload_redacted_reason"]
            .as_str()
            .is_some_and(|m| m.contains("removed this app's access")),
        "{}",
        r.json
    );
    // The notice that access ended carries no account data and is shown as is.
    let r = call(
        &ctx,
        Req::get(&format!("{base}/deliveries/{}", removed_notice.delivery_id))
            .basic(&a.app_id, &a.secret),
    )
    .await;
    assert_eq!(r.json["payload_redacted"], false);
    for bad in [
        theirs.delivery_id.to_string(),
        Uuid::now_v7().to_string(),
        "nope".to_string(),
    ] {
        let r = call(
            &ctx,
            Req::get(&format!("{base}/deliveries/{bad}")).basic(&a.app_id, &a.secret),
        )
        .await;
        assert_eq!(r.status, 404, "{bad}");
        assert_eq!(r.error_code(), Some("delivery_not_found"));
    }

    // Replay by id: the member's event goes again (to the current URL); the leaver's data does
    // not, but the access-removed notice does; pending and unknown ones are reported.
    let new_url = "http://127.0.0.1:8594/rep/hooks";
    sqlx::query("update app_signin_configs set webhook_url = $2 where app_id = $1")
        .bind(&a.app_id)
        .bind(new_url)
        .execute(&ctx.state.db)
        .await
        .expect("url");
    let unknown = Uuid::now_v7();
    let r = call(
        &ctx,
        Req::post(&format!("{base}/replay")).basic(&a.app_id, &a.secret).json(json!({"delivery_ids": [
            mine.delivery_id, leaver_update.delivery_id, removed_notice.delivery_id, ping.delivery_id, unknown, theirs.delivery_id
        ]})),
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(
        r.json["replayed"],
        json!([mine.delivery_id, removed_notice.delivery_id])
    );
    let reasons: Vec<(String, String)> = r.json["skipped"]
        .as_array()
        .expect("skipped")
        .iter()
        .map(|s| {
            (
                s["delivery_id"].as_str().unwrap_or_default().to_string(),
                s["reason"].as_str().unwrap_or_default().to_string(),
            )
        })
        .collect();
    assert_eq!(
        reasons,
        vec![
            (
                leaver_update.delivery_id.to_string(),
                "membership_inactive".to_string()
            ),
            (ping.delivery_id.to_string(), "already_pending".to_string()),
            (unknown.to_string(), "not_found".to_string()),
            (theirs.delivery_id.to_string(), "not_found".to_string()),
        ]
    );
    let row: (String, i32, i32, String, Uuid) = sqlx::query_as(
        "select status, attempts, manual_replays, url, event_id from webhook_deliveries where id = $1",
    )
    .bind(mine.delivery_id)
    .fetch_one(&ctx.state.db)
    .await
    .expect("row");
    assert_eq!(
        row,
        (
            "pending".to_string(),
            0,
            1,
            new_url.to_string(),
            mine.event_id
        )
    );

    // Replay by status: what is still failed (the leaver's data stays skipped).
    let r = call(
        &ctx,
        Req::post(&format!("{base}/replay"))
            .basic(&a.app_id, &a.secret)
            .header("idempotency-key", "replay-1")
            .json(json!({"status": "failed", "since": "2020-01-01T00:00:00Z"})),
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(r.json["replayed"], json!([]));
    assert_eq!(
        r.json["skipped"],
        json!([]),
        "replay by status only picks replayable deliveries"
    );
    assert_eq!(r.json["remaining"], 0);
    assert_eq!(r.json["not_replayable"], 1, "the leaver's data: {}", r.json);
    let again = call(
        &ctx,
        Req::post(&format!("{base}/replay"))
            .basic(&a.app_id, &a.secret)
            .header("idempotency-key", "replay-1")
            .json(json!({"status": "failed", "since": "2020-01-01T00:00:00Z"})),
    )
    .await;
    assert_eq!(again.headers["idempotent-replayed"], "true");

    let r = call(
        &ctx,
        Req::post(&format!("{base}/replay"))
            .basic(&a.app_id, &a.secret)
            .json(json!({"status": "delivered"})),
    )
    .await;
    assert_eq!(r.status, 422);
    let many: Vec<String> = (0..101).map(|_| Uuid::now_v7().to_string()).collect();
    let r = call(
        &ctx,
        Req::post(&format!("{base}/replay"))
            .basic(&a.app_id, &a.secret)
            .json(json!({"delivery_ids": many})),
    )
    .await;
    assert_eq!(r.status, 422);
    assert!(
        r.json["error"]["details"]["fields"]["delivery_ids"]
            .as_str()
            .is_some_and(|m| m.contains("at most 100"))
    );
}

/// Replay by status picks only deliveries it may send, so 100+ withheld ones (an account that
/// removed access) never block a newer delivery of a live member, and `remaining` reaches 0.
#[tokio::test]
async fn bulk_replay_reaches_live_members_past_withheld_deliveries() {
    let ctx = TestContext::new().await;
    let a = owned_app(&ctx, "bulk").await;
    ctx.set_app_webhook(&a.app_id, "http://127.0.0.1:8593/bulk/webhooks")
        .await;
    let leaver = ctx.carbon().await;
    let member = ctx.carbon().await;
    ctx.membership(&a.app_id, &leaver.uuid, &[Scope::Profile])
        .await;
    ctx.membership(&a.app_id, &member.uuid, &[Scope::Profile])
        .await;
    let mut conn = ctx.conn().await;
    for _ in 0..120 {
        let e = events::account_updated(&mut conn, &leaver, &[AccountField::DisplayName])
            .await
            .expect("emit")
            .remove(0);
        finish(&ctx, e.delivery_id, "failed", 1).await;
    }
    memberships::remove_access(&mut conn, &a.app_id, &leaver.uuid, &leaver.uuid)
        .await
        .expect("remove");
    let mut live = Vec::new();
    for _ in 0..3 {
        let e = events::account_updated(&mut conn, &member, &[AccountField::DisplayName])
            .await
            .expect("emit")
            .remove(0);
        finish(&ctx, e.delivery_id, "failed", 1).await;
        live.push(e.delivery_id);
    }
    drop(conn);

    let replay = || {
        Req::post(&format!("/v1/apps/{}/webhook/replay", a.app_id))
            .basic(&a.app_id, &a.secret)
            .json(json!({"status": "failed"}))
    };
    let r = call(&ctx, replay()).await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(r.json["replayed"], json!(live), "{}", r.json);
    assert_eq!(r.json["remaining"], 0);
    assert_eq!(r.json["not_replayable"], 120);
    for id in &live {
        let status: String =
            sqlx::query_scalar("select status from webhook_deliveries where id = $1")
                .bind(id)
                .fetch_one(&ctx.state.db)
                .await
                .expect("status");
        assert_eq!(status, "pending");
    }
    // Nothing left to send: a client looping until remaining == 0 stops.
    let r = call(&ctx, replay()).await;
    assert_eq!(
        (
            &r.json["replayed"],
            &r.json["remaining"],
            &r.json["not_replayable"]
        ),
        (&json!([]), &json!(0), &json!(120))
    );
}

/// `remaining` counts what is still replayable beyond the 100 of one request.
#[tokio::test]
async fn bulk_replay_pages_through_more_than_a_hundred() {
    let ctx = TestContext::new().await;
    let a = owned_app(&ctx, "page").await;
    ctx.set_app_webhook(&a.app_id, "http://127.0.0.1:8593/page/webhooks")
        .await;
    let member = ctx.carbon().await;
    ctx.membership(&a.app_id, &member.uuid, &[Scope::Profile])
        .await;
    let mut conn = ctx.conn().await;
    for _ in 0..130 {
        let e = events::account_updated(&mut conn, &member, &[AccountField::DisplayName])
            .await
            .expect("emit")
            .remove(0);
        finish(&ctx, e.delivery_id, "failed", 1).await;
    }
    drop(conn);
    let replay = || {
        Req::post(&format!("/v1/apps/{}/webhook/replay", a.app_id))
            .basic(&a.app_id, &a.secret)
            .json(json!({"status": "failed"}))
    };
    let r = call(&ctx, replay()).await;
    assert_eq!(r.json["replayed"].as_array().map(Vec::len), Some(100));
    assert_eq!(r.json["remaining"], 30);
    let r = call(&ctx, replay()).await;
    assert_eq!(r.json["replayed"].as_array().map(Vec::len), Some(30));
    assert_eq!(r.json["remaining"], 0);
}

/// A deleted account's data is never replayed or shown, while the `account.deleted` notice is.
#[tokio::test]
async fn deleted_accounts_get_no_data_replayed_or_shown() {
    let ctx = TestContext::new().await;
    let a = owned_app(&ctx, "gone").await;
    ctx.set_app_webhook(&a.app_id, "http://127.0.0.1:8593/gone/webhooks")
        .await;
    let gone = ctx.carbon().await;
    ctx.membership(
        &a.app_id,
        &gone.uuid,
        &[Scope::Profile, Scope::Email, Scope::Dob, Scope::Timezone],
    )
    .await;
    let mut conn = ctx.conn().await;
    let update = events::account_updated(&mut conn, &gone, &[AccountField::Email])
        .await
        .expect("emit")
        .remove(0);
    // Core's deletion tells every member app itself (`account.deleted`).
    accounts_core::repo::accounts::delete_account(
        &mut conn,
        &ctx.state.settings,
        &gone.uuid,
        &gone.uuid,
        true,
    )
    .await
    .expect("delete");
    let deleted_delivery: uuid::Uuid = sqlx::query_scalar(
        "select d.id from webhook_deliveries d join webhook_events e on e.event_id = d.event_id \
          where e.type = 'account.deleted' and e.target_id = $1 and e.account_uuid = $2",
    )
    .bind(&a.app_id)
    .bind(&gone.uuid)
    .fetch_one(&mut *conn)
    .await
    .expect("account.deleted was emitted by the deletion");
    drop(conn);
    finish(&ctx, update.delivery_id, "failed", 7).await;
    finish(&ctx, deleted_delivery, "failed", 7).await;

    let r = call(
        &ctx,
        Req::post(&format!("/v1/apps/{}/webhook/replay", a.app_id))
            .basic(&a.app_id, &a.secret)
            .json(json!({"delivery_ids": [update.delivery_id, deleted_delivery]})),
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(r.json["replayed"], json!([deleted_delivery]));
    assert_eq!(r.json["skipped"][0]["reason"], "account_deleted");
    assert!(
        r.json["skipped"][0]["message"]
            .as_str()
            .is_some_and(|m| m.contains("deleted")),
        "{}",
        r.json
    );
    assert_eq!(r.json["not_replayable"], 1);

    let r = call(
        &ctx,
        Req::get(&format!(
            "/v1/apps/{}/webhook/deliveries/{}",
            a.app_id, update.delivery_id
        ))
        .basic(&a.app_id, &a.secret),
    )
    .await;
    assert_eq!(r.json["payload_redacted"], true);
    assert!(
        r.json["payload"]["data"].get("account").is_none(),
        "{}",
        r.json
    );
    assert!(!r.json.to_string().contains("@example.test"), "{}", r.json);

    let r = call(
        &ctx,
        Req::post(&format!("/v1/apps/{}/webhook/replay", a.app_id))
            .basic(&a.app_id, &a.secret)
            .json(json!({"status": "failed"})),
    )
    .await;
    assert_eq!(r.json["replayed"], json!([]), "{}", r.json);
    assert_eq!(r.json["not_replayable"], 1);
}
