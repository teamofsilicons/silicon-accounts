//! Webhook events: fan-out only to member apps with a webhook, scope-aware `account.updated`,
//! Silicon webhooks, and the stored payload shape.

use accounts_core::events::{self, types};
use accounts_core::models::{AccountField, MembershipStatus, Scope};
use accounts_core::repo::memberships;
use accounts_core::test_support::TestContext;
use accounts_core::views::AccountSummary;
use serde_json::Value;

async fn events_for(ctx: &TestContext, app_id: &str) -> Vec<(String, Value)> {
    sqlx::query_as("select type, payload from webhook_events where target_id = $1 order by occurred_at, event_id")
        .bind(app_id)
        .fetch_all(&ctx.state.db)
        .await
        .expect("events")
}

#[tokio::test]
async fn id_changes_reach_member_apps_with_webhooks_only() {
    let ctx = TestContext::new().await;
    let c = ctx.carbon().await;
    let (member, _) = ctx.app("member").await;
    let (no_hook, _) = ctx.app("nohook").await;
    let (removed, _) = ctx.app("removed").await;
    let (stranger, _) = ctx.app("stranger").await;
    let (imported, _) = ctx.app("imported").await;
    ctx.set_app_webhook(&member.app_id, "http://127.0.0.1:8593/member/webhooks")
        .await;
    ctx.set_app_webhook(&removed.app_id, "http://127.0.0.1:8593/removed/webhooks")
        .await;
    ctx.set_app_webhook(&stranger.app_id, "http://127.0.0.1:8593/stranger/webhooks")
        .await;
    ctx.set_app_webhook(&imported.app_id, "http://127.0.0.1:8593/imported/webhooks")
        .await;
    ctx.membership(&member.app_id, &c.uuid, &[Scope::Profile])
        .await;
    ctx.membership(&no_hook.app_id, &c.uuid, &[Scope::Profile])
        .await;
    ctx.membership(&removed.app_id, &c.uuid, &[Scope::Profile])
        .await;
    let mut conn = ctx.conn().await;
    memberships::upsert_imported(
        &mut conn,
        &imported.app_id,
        &c.uuid,
        Some("ext-1"),
        None,
        false,
    )
    .await
    .expect("import");
    let removed_m = memberships::remove_access(&mut conn, &removed.app_id, &c.uuid, &c.uuid)
        .await
        .expect("remove");
    assert_eq!(removed_m.membership.status, MembershipStatus::AccessRemoved);

    let emitted = events::notify_id_changed(&mut conn, &c, "c:old-id", "c:new-id")
        .await
        .expect("emit");
    let mut targets: Vec<String> = emitted.iter().map(|e| e.target_id.clone()).collect();
    targets.sort();
    let mut expected = vec![member.app_id.clone(), imported.app_id.clone()];
    expected.sort();
    assert_eq!(targets, expected, "only live members with a webhook");

    let evs = events_for(&ctx, &member.app_id).await;
    assert_eq!(evs.len(), 1);
    let (ty, payload) = &evs[0];
    assert_eq!(ty, types::ACCOUNT_ID_CHANGED);
    assert_eq!(payload["type"], types::ACCOUNT_ID_CHANGED);
    assert_eq!(payload["app_id"], member.app_id);
    assert_eq!(payload["silicon"], Value::Null);
    assert_eq!(
        payload["data"]["membership_id"],
        format!("{}:{}", member.app_id, c.uuid)
    );
    assert_eq!(payload["data"]["old_id"], "c:old-id");
    assert_eq!(payload["data"]["new_id"], "c:new-id");
    assert_eq!(payload["data"]["kind"], "carbon");
    assert!(payload["event_id"].as_str().is_some_and(|s| s.len() == 36));
    assert!(
        payload["occurred_at"]
            .as_str()
            .is_some_and(|s| s.ends_with('Z') && s.len() == 24)
    );

    let deliveries: Vec<(String, String, i32)> =
        sqlx::query_as("select status, url, attempts from webhook_deliveries where target_id = $1")
            .bind(&member.app_id)
            .fetch_all(&ctx.state.db)
            .await
            .expect("deliveries");
    assert_eq!(
        deliveries,
        vec![(
            "pending".to_string(),
            "http://127.0.0.1:8593/member/webhooks".to_string(),
            0
        )]
    );
    assert!(events_for(&ctx, &stranger.app_id).await.is_empty());
    assert!(events_for(&ctx, &removed.app_id).await.is_empty());
}

#[tokio::test]
async fn account_updated_respects_each_apps_scopes() {
    let ctx = TestContext::new().await;
    let c = ctx.carbon().await;
    let (with_email, _) = ctx.app("withemail").await;
    let (profile_only, _) = ctx.app("profileonly").await;
    ctx.set_app_webhook(&with_email.app_id, "http://127.0.0.1:8593/a/webhooks")
        .await;
    ctx.set_app_webhook(&profile_only.app_id, "http://127.0.0.1:8593/b/webhooks")
        .await;
    ctx.membership(&with_email.app_id, &c.uuid, &[Scope::Profile, Scope::Email])
        .await;
    ctx.membership(&profile_only.app_id, &c.uuid, &[Scope::Profile])
        .await;
    let mut conn = ctx.conn().await;

    // An email change is only visible to the app with the email scope.
    let emitted = events::account_updated(&mut conn, &c, &[AccountField::Email])
        .await
        .expect("emit");
    assert_eq!(emitted.len(), 1);
    assert_eq!(emitted[0].target_id, with_email.app_id);
    let (_, payload) = events_for(&ctx, &with_email.app_id)
        .await
        .pop()
        .expect("event");
    assert_eq!(payload["data"]["changed"], serde_json::json!(["email"]));
    assert!(payload["data"]["account"]["email"].as_str().is_some());

    // A display-name change reaches both; the profile-only app sees no email in the account.
    let emitted = events::account_updated(
        &mut conn,
        &c,
        &[AccountField::DisplayName, AccountField::Dob],
    )
    .await
    .expect("emit");
    assert_eq!(emitted.len(), 2);
    let (_, payload) = events_for(&ctx, &profile_only.app_id)
        .await
        .pop()
        .expect("event");
    assert_eq!(
        payload["data"]["changed"],
        serde_json::json!(["display_name"])
    );
    assert!(payload["data"]["account"].get("email").is_none());
    assert!(payload["data"]["account"].get("dob").is_none());
}

#[tokio::test]
async fn silicon_webhooks_and_custodian_changes() {
    let ctx = TestContext::new().await;
    let old = ctx.carbon().await;
    let new = ctx.carbon().await;
    let (s, _) = ctx.silicon(&old.uuid).await;
    let (app, _) = ctx.app("remind").await;
    ctx.set_app_webhook(&app.app_id, "http://127.0.0.1:8593/remind/webhooks")
        .await;
    ctx.membership(&app.app_id, &s.uuid, &[Scope::Profile, Scope::Timezone])
        .await;
    let mut conn = ctx.conn().await;

    // No Silicon webhook yet: nothing for the Silicon itself.
    assert!(
        events::ping_silicon(&mut conn, &s.uuid)
            .await
            .expect("ping")
            .is_none()
    );
    let (_secret, enc) = events::new_webhook_secret(&ctx.state.keys.keyring).expect("secret");
    let s = accounts_core::repo::accounts::set_silicon_webhook(
        &mut conn,
        &s.uuid,
        Some("http://127.0.0.1:8593/s/webhooks"),
        Some(&enc),
    )
    .await
    .expect("webhook");
    let emitted = events::notify_custodian_changed(
        &mut conn,
        &s,
        &AccountSummary::from_account(&old),
        &AccountSummary::from_account(&new),
    )
    .await
    .expect("emit");
    let kinds: Vec<&str> = emitted.iter().map(|e| e.event_type.as_str()).collect();
    assert!(
        kinds.contains(&types::SILICON_CUSTODIAN_CHANGED)
            && kinds.contains(&types::SILICON_OWN_CUSTODIAN_CHANGED),
        "{kinds:?}"
    );
    let own: Vec<(String, Value)> = sqlx::query_as(
        "select type, payload from webhook_events where target_kind = 'silicon' and target_id = $1",
    )
    .bind(&s.uuid)
    .fetch_all(&ctx.state.db)
    .await
    .expect("events");
    assert_eq!(own.len(), 1);
    assert_eq!(own[0].1["silicon"], s.uuid);
    assert_eq!(own[0].1["app_id"], Value::Null);
    assert_eq!(own[0].1["data"]["to"]["uuid"], new.uuid);

    // The Silicon's secret decrypts for signing; the app gets the custodian in account.updated.
    let secret = events::current_secret(
        &mut conn,
        &ctx.state.keys.keyring,
        accounts_core::models::WebhookTargetKind::Silicon,
        &s.uuid,
    )
    .await
    .expect("secret")
    .expect("set");
    assert!(secret.starts_with("whsec_"));
    let emitted = events::notify_profile_updated(&mut conn, &s, &[AccountField::Timezone])
        .await
        .expect("emit");
    assert_eq!(emitted.len(), 2, "app + the Silicon itself");
    let (_, payload) = events_for(&ctx, &app.app_id).await.pop().expect("event");
    assert_eq!(payload["data"]["account"]["custodian"]["uuid"], old.uuid);
    assert_eq!(payload["data"]["account"]["timezone"], "UTC");
}
