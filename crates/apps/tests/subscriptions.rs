//! Event subscriptions: create, list, update, pause, delete, test, and which events each one
//! records and delivers.

mod common;

use accounts_core::events;
use accounts_core::models::{Account, AccountField, Scope};
use accounts_core::test_support::{Req, TestContext};
use common::{OwnedApp, call, owned_app};
use serde_json::{Value, json};

const HOOK: &str = "http://127.0.0.1:8593/subs/webhooks";

fn base(a: &OwnedApp) -> String {
    format!("/v1/apps/{}/subscriptions", a.app_id)
}

/// (type, subscription delivery or "legacy", has a delivery row) of every event recorded for an
/// app, oldest first.
async fn recorded(ctx: &TestContext, app_id: &str) -> Vec<(String, String, bool)> {
    sqlx::query_as(
        "select e.type, coalesce(s.delivery, case when e.subscription_id is null then 'legacy' else 'deleted' end), \
                exists(select 1 from webhook_deliveries d where d.event_id = e.event_id) \
         from webhook_events e left join app_event_subscriptions s on s.id = e.subscription_id \
         where e.target_kind = 'app' and e.target_id = $1 order by e.tx_id, e.event_id",
    )
    .bind(app_id)
    .fetch_all(&ctx.state.db)
    .await
    .expect("events")
}

/// The `changed` lists of the account.updated events recorded for an app's subscription kind.
async fn changed(ctx: &TestContext, app_id: &str, delivery: &str) -> Vec<Value> {
    sqlx::query_scalar(
        "select e.payload->'data'->'changed' from webhook_events e \
         join app_event_subscriptions s on s.id = e.subscription_id \
         where e.target_id = $1 and s.delivery = $2 and e.type = 'account.updated' \
         order by e.tx_id, e.event_id",
    )
    .bind(app_id)
    .bind(delivery)
    .fetch_all(&ctx.state.db)
    .await
    .expect("changed")
}

/// A profile change of `account` as the account crate records it.
async fn profile_changed(ctx: &TestContext, account: &Account, fields: &[AccountField]) {
    let mut tx = ctx.state.db.begin().await.expect("tx");
    let account = accounts_core::repo::accounts::bump_version(&mut tx, &account.uuid)
        .await
        .expect("bump");
    events::notify_profile_updated(&mut tx, &account, fields)
        .await
        .expect("emit");
    tx.commit().await.expect("commit");
}

async fn id_changed(ctx: &TestContext, account: &Account) {
    let mut tx = ctx.state.db.begin().await.expect("tx");
    events::notify_id_changed(&mut tx, account, "c:old", "c:new")
        .await
        .expect("emit");
    tx.commit().await.expect("commit");
}

#[tokio::test]
async fn webhook_subscriptions_pick_updates_and_filter_deliveries() {
    let ctx = TestContext::new().await;
    let a = owned_app(&ctx, "subs").await;
    let member = ctx.carbon().await;
    ctx.membership(&a.app_id, &member.uuid, &[Scope::Profile, Scope::Timezone])
        .await;

    let r = call(&ctx, Req::get(&base(&a)).basic(&a.app_id, &a.secret)).await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(r.json, json!({"items": [], "next_cursor": null}));

    // A webhook subscription with the default updates; the secret is shown once.
    let r = call(
        &ctx,
        Req::post(&base(&a))
            .basic(&a.app_id, &a.secret)
            .header("idempotency-key", "sub-create-1")
            .json(json!({"delivery": "webhook", "url": HOOK})),
    )
    .await;
    assert_eq!(r.status, 201, "{}", r.json);
    let sub = r.json.clone();
    let id = sub["id"].as_str().expect("id").to_string();
    assert_eq!(sub["delivery"], "webhook");
    assert_eq!(sub["status"], "active");
    assert_eq!(sub["url"], HOOK);
    assert_eq!(sub["secret_set"], true);
    assert_eq!(sub["stream_url"], Value::Null);
    assert_eq!(
        sub["updates"],
        json!([
            "id_change",
            "display_name_change",
            "pfp_change",
            "access_removed",
            "account_deleted"
        ])
    );
    assert_eq!(
        sub["event_types"],
        json!([
            "account.id_changed",
            "account.updated",
            "account.deleted",
            "membership.signed_out",
            "membership.access_removed",
            "ping"
        ])
    );
    let secret = sub["secret"].as_str().expect("secret");
    assert!(secret.starts_with("whsec_"));
    assert_eq!(r.headers["cache-control"], "no-store");

    // A retry with the same key replays the same answer (same secret), nothing runs twice.
    let again = call(
        &ctx,
        Req::post(&base(&a))
            .basic(&a.app_id, &a.secret)
            .header("idempotency-key", "sub-create-1")
            .json(json!({"delivery": "webhook", "url": HOOK})),
    )
    .await;
    assert_eq!(again.status, 201);
    assert_eq!(again.json["secret"], sub["secret"]);
    assert_eq!(again.headers["idempotent-replayed"], "true");

    // It is the app's webhook: the webhook resource shows it, and there is only one.
    let w = call(
        &ctx,
        Req::get(&format!("/v1/apps/{}/webhook", a.app_id)).basic(&a.app_id, &a.secret),
    )
    .await;
    assert_eq!(w.json["url"], HOOK);
    assert_eq!(w.json["subscription_id"], id.as_str());
    assert_eq!(w.json["status"], "active");
    assert_eq!(w.json["events"], sub["updates"]);
    let dup = call(
        &ctx,
        Req::post(&base(&a))
            .basic(&a.app_id, &a.secret)
            .json(json!({"delivery": "webhook", "url": HOOK})),
    )
    .await;
    assert_eq!(dup.status, 409);
    assert_eq!(dup.error_code(), Some("subscription_exists"));
    assert_eq!(dup.json["error"]["details"]["subscription_id"], id.as_str());

    // Defaults: a display name change is delivered, a timezone change is not.
    profile_changed(&ctx, &member, &[AccountField::Timezone]).await;
    profile_changed(
        &ctx,
        &member,
        &[AccountField::DisplayName, AccountField::Timezone],
    )
    .await;
    assert_eq!(
        recorded(&ctx, &a.app_id).await,
        vec![("account.updated".to_string(), "webhook".to_string(), true)]
    );
    assert_eq!(
        changed(&ctx, &a.app_id, "webhook").await,
        vec![json!(["display_name"])]
    );

    // Pick only the timezone: now the timezone is delivered and the display name is not.
    let r = call(
        &ctx,
        Req::patch(&format!("{}/{id}", base(&a)))
            .basic(&a.app_id, &a.secret)
            .json(json!({"updates": ["timezone_change"]})),
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(r.json["updates"], json!(["timezone_change"]));
    assert_eq!(r.json["event_types"], json!(["account.updated", "ping"]));
    profile_changed(&ctx, &member, &[AccountField::DisplayName]).await;
    profile_changed(
        &ctx,
        &member,
        &[AccountField::DisplayName, AccountField::Timezone],
    )
    .await;
    id_changed(&ctx, &member).await;
    assert_eq!(
        changed(&ctx, &a.app_id, "webhook").await,
        vec![json!(["display_name"]), json!(["timezone"])]
    );
    assert_eq!(recorded(&ctx, &a.app_id).await.len(), 2, "no id change");

    // Paused: nothing is recorded. Active again: it is.
    let r = call(
        &ctx,
        Req::patch(&format!("{}/{id}", base(&a)))
            .basic(&a.app_id, &a.secret)
            .json(json!({"status": "paused", "updates": null})),
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(r.json["status"], "paused");
    assert_eq!(r.json["updates"], Value::Null, "null = every update");
    id_changed(&ctx, &member).await;
    assert_eq!(recorded(&ctx, &a.app_id).await.len(), 2, "paused");
    // The webhook test still pings a paused webhook (the app asked for it).
    let t = call(
        &ctx,
        Req::post(&format!("{}/{id}/test", base(&a))).basic(&a.app_id, &a.secret),
    )
    .await;
    assert_eq!(t.status, 202, "{}", t.json);
    assert!(t.json["delivery_id"].is_string());
    let r = call(
        &ctx,
        Req::patch(&format!("{}/{id}", base(&a)))
            .basic(&a.app_id, &a.secret)
            .json(json!({"status": "active"})),
    )
    .await;
    assert_eq!(r.json["status"], "active");
    id_changed(&ctx, &member).await;
    let types: Vec<String> = recorded(&ctx, &a.app_id)
        .await
        .into_iter()
        .map(|(t, _, _)| t)
        .collect();
    assert_eq!(
        types,
        vec![
            "account.updated",
            "account.updated",
            "ping",
            "account.id_changed"
        ]
    );

    // A new URL keeps the signing secret.
    let r = call(
        &ctx,
        Req::patch(&format!("{}/{id}", base(&a)))
            .basic(&a.app_id, &a.secret)
            .json(json!({"url": "http://127.0.0.1:8593/subs/v2"})),
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(r.json["url"], "http://127.0.0.1:8593/subs/v2");
    let stored: Option<Vec<u8>> =
        sqlx::query_scalar("select webhook_secret_enc from app_signin_configs where app_id = $1")
            .bind(&a.app_id)
            .fetch_one(&ctx.state.db)
            .await
            .expect("secret");
    assert_eq!(
        ctx.state
            .keys
            .keyring
            .decrypt_string(&stored.expect("set"))
            .expect("decrypt"),
        secret
    );

    // Deleting the webhook subscription removes the webhook.
    let r = call(
        &ctx,
        Req::delete(&format!("{}/{id}", base(&a))).basic(&a.app_id, &a.secret),
    )
    .await;
    assert_eq!(r.status, 204);
    let w = call(
        &ctx,
        Req::get(&format!("/v1/apps/{}/webhook", a.app_id)).basic(&a.app_id, &a.secret),
    )
    .await;
    assert_eq!(w.json["url"], Value::Null);
    assert_eq!(w.json["subscription_id"], Value::Null);
    let r = call(
        &ctx,
        Req::get(&format!("{}/{id}", base(&a))).basic(&a.app_id, &a.secret),
    )
    .await;
    assert_eq!(r.status, 404);
    assert_eq!(r.error_code(), Some("subscription_not_found"));
}

#[tokio::test]
async fn webhooks_set_up_before_subscriptions_keep_every_event() {
    let ctx = TestContext::new().await;
    let a = owned_app(&ctx, "legacy").await;
    let member = ctx.carbon().await;
    ctx.membership(&a.app_id, &member.uuid, &[Scope::Profile, Scope::Timezone])
        .await;
    // Written straight to the columns, like the Silicon Apps sync or an older accounts-api.
    ctx.set_app_webhook(&a.app_id, HOOK).await;
    let r = call(&ctx, Req::get(&base(&a)).basic(&a.app_id, &a.secret)).await;
    let items = r.json["items"].as_array().expect("items");
    assert_eq!(items.len(), 1, "{}", r.json);
    assert_eq!(items[0]["delivery"], "webhook");
    assert_eq!(items[0]["updates"], Value::Null);
    assert_eq!(items[0]["event_types"], json!(events::APP_EVENT_TYPES));
    profile_changed(&ctx, &member, &[AccountField::Timezone]).await;
    assert_eq!(
        changed(&ctx, &a.app_id, "webhook").await,
        vec![json!(["timezone"])]
    );

    // PUT /webhook with events (what Silicon Apps sends) sets the same subscription's updates.
    let r = call(
        &ctx,
        Req::put(&format!("/v1/apps/{}/webhook", a.app_id))
            .basic(&a.app_id, &a.secret)
            .json(json!({"url": HOOK, "events": ["id_change"], "preserve_secret": true})),
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.json);
    let r = call(&ctx, Req::get(&base(&a)).basic(&a.app_id, &a.secret)).await;
    assert_eq!(r.json["items"][0]["updates"], json!(["id_change"]));
    assert_eq!(
        r.json["items"][0]["id"], items[0]["id"],
        "the same subscription"
    );

    // DELETE /webhook removes the subscription.
    let r = call(
        &ctx,
        Req::delete(&format!("/v1/apps/{}/webhook", a.app_id)).basic(&a.app_id, &a.secret),
    )
    .await;
    assert_eq!(r.status, 204);
    let r = call(&ctx, Req::get(&base(&a)).basic(&a.app_id, &a.secret)).await;
    assert_eq!(r.json["items"], json!([]));
}

#[tokio::test]
async fn stream_subscriptions_record_without_deliveries() {
    let ctx = TestContext::new().await;
    let a = owned_app(&ctx, "stream").await;
    let member = ctx.carbon().await;
    ctx.membership(&a.app_id, &member.uuid, &[Scope::Profile])
        .await;
    ctx.set_app_webhook(&a.app_id, HOOK).await;

    // The owner creates it, with every update.
    let r = call(
        &ctx,
        Req::post(&base(&a))
            .session(&ctx.state.settings, &a.cookie)
            .header("origin", &ctx.state.settings.public_origin)
            .json(json!({"delivery": "stream", "updates": null})),
    )
    .await;
    assert_eq!(r.status, 201, "{}", r.json);
    let id = r.json["id"].as_str().expect("id").to_string();
    assert_eq!(r.json["delivery"], "stream");
    assert_eq!(r.json["url"], Value::Null);
    assert!(r.json.get("secret").is_none());
    assert_eq!(
        r.json["stream_url"],
        format!("{}/v1/events/stream", ctx.state.settings.public_url)
    );
    let dup = call(
        &ctx,
        Req::post(&base(&a))
            .basic(&a.app_id, &a.secret)
            .json(json!({"delivery": "stream"})),
    )
    .await;
    assert_eq!(dup.error_code(), Some("subscription_exists"));

    // Each subscription gets its own row; only the webhook's is delivered.
    id_changed(&ctx, &member).await;
    assert_eq!(
        recorded(&ctx, &a.app_id).await,
        vec![
            (
                "account.id_changed".to_string(),
                "webhook".to_string(),
                true
            ),
            (
                "account.id_changed".to_string(),
                "stream".to_string(),
                false
            ),
        ]
    );
    let event_ids: Vec<String> =
        sqlx::query_scalar("select event_id::text from webhook_events where target_id = $1")
            .bind(&a.app_id)
            .fetch_all(&ctx.state.db)
            .await
            .expect("ids");
    assert_ne!(event_ids[0], event_ids[1], "event ids are per receiver");

    // A test ping on the stream has no delivery.
    let t = call(
        &ctx,
        Req::post(&format!("{}/{id}/test", base(&a))).basic(&a.app_id, &a.secret),
    )
    .await;
    assert_eq!(t.status, 202, "{}", t.json);
    assert_eq!(t.json["subscription_id"], id.as_str());
    assert_eq!(t.json["delivery_id"], Value::Null);
    assert!(t.json["event_id"].is_string());

    // Membership notices follow access_removed.
    let r = call(
        &ctx,
        Req::patch(&format!("{}/{id}", base(&a)))
            .basic(&a.app_id, &a.secret)
            .json(json!({"updates": ["account_deleted"]})),
    )
    .await;
    assert_eq!(r.status, 200);
    let mut tx = ctx.state.db.begin().await.expect("tx");
    events::membership_access_removed(&mut tx, &a.app_id, &member.uuid)
        .await
        .expect("emit");
    tx.commit().await.expect("commit");
    let streamed: Vec<String> = recorded(&ctx, &a.app_id)
        .await
        .into_iter()
        .filter(|(_, d, _)| d == "stream")
        .map(|(t, _, _)| t)
        .collect();
    assert_eq!(streamed, vec!["account.id_changed", "ping"]);

    let r = call(
        &ctx,
        Req::delete(&format!("{}/{id}", base(&a))).basic(&a.app_id, &a.secret),
    )
    .await;
    assert_eq!(r.status, 204);
    let r = call(&ctx, Req::get(&base(&a)).basic(&a.app_id, &a.secret)).await;
    assert_eq!(
        r.json["items"].as_array().map(Vec::len),
        Some(1),
        "the webhook stays"
    );
}

#[tokio::test]
async fn subscription_input_is_checked() {
    let ctx = TestContext::new().await;
    let a = owned_app(&ctx, "subcheck").await;
    let (other, other_secret) = ctx.app("other").await;
    let post = |body: Value| Req::post(&base(&a)).basic(&a.app_id, &a.secret).json(body);
    let r = call(&ctx, post(json!({"delivery": "webhook"}))).await;
    assert_eq!(r.status, 422);
    assert!(r.json["error"]["details"]["fields"]["url"].is_string());
    let r = call(&ctx, post(json!({"delivery": "stream", "url": HOOK}))).await;
    assert_eq!(r.status, 422);
    assert!(r.json["error"]["details"]["fields"]["url"].is_string());
    let r = call(&ctx, post(json!({"delivery": "email"}))).await;
    assert_eq!(r.status, 422, "{}", r.json);
    let r = call(
        &ctx,
        post(json!({"delivery": "stream", "updates": ["id_change", "favourite_colour"]})),
    )
    .await;
    assert_eq!(r.status, 422);
    assert_eq!(r.error_code(), Some("invalid_updates"));
    assert_eq!(
        r.json["error"]["details"]["allowed"]
            .as_array()
            .map(Vec::len),
        Some(9)
    );
    let r = call(&ctx, post(json!({"delivery": "stream", "events": []}))).await;
    assert_eq!(r.status, 422, "unknown fields are refused");
    let r = call(
        &ctx,
        post(json!({"delivery": "webhook", "url": "ftp://x.example/hook"})),
    )
    .await;
    assert_eq!(r.status, 422);

    let r = call(
        &ctx,
        post(json!({"delivery": "stream", "status": "paused"})),
    )
    .await;
    assert_eq!(r.status, 201);
    assert_eq!(r.json["status"], "paused");
    assert_eq!(
        r.json["updates"].as_array().map(Vec::len),
        Some(5),
        "defaults"
    );
    let id = r.json["id"].as_str().expect("id").to_string();
    let r = call(
        &ctx,
        Req::patch(&format!("{}/{id}", base(&a)))
            .basic(&a.app_id, &a.secret)
            .json(json!({})),
    )
    .await;
    assert_eq!(r.status, 422);
    let r = call(
        &ctx,
        Req::patch(&format!("{}/{id}", base(&a)))
            .basic(&a.app_id, &a.secret)
            .json(json!({"url": HOOK})),
    )
    .await;
    assert_eq!(r.status, 422, "a stream has no URL");
    for path in [
        format!("{}/nope", base(&a)),
        format!("{}/{}", base(&a), uuid::Uuid::now_v7()),
    ] {
        let r = call(&ctx, Req::get(&path).basic(&a.app_id, &a.secret)).await;
        assert_eq!(r.status, 404, "{path}");
        assert_eq!(r.error_code(), Some("subscription_not_found"));
    }
    // Another app's credentials can't see or touch them.
    let r = call(
        &ctx,
        Req::get(&base(&a)).basic(&other.app_id, &other_secret),
    )
    .await;
    assert_eq!(r.status, 403);
    assert_eq!(r.error_code(), Some("app_mismatch"));
    let r = call(&ctx, Req::get(&base(&a))).await;
    assert_eq!(r.status, 401);
}
