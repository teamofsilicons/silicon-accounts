//! Authentication and delivery boundaries after the real offline UUID cutover.
use accounts_core::{
    repo::accounts,
    test_support::{Req, TestContext, call},
    uuid_migration,
};

#[tokio::test]
async fn old_bearer_refresh_and_browser_session_fail_but_new_subject_signs_in() {
    let ctx = TestContext::new().await;
    sqlx::query("insert into accounts(uuid,number,kind,handle,status,display_name,pfp_url,dob,timezone) values('Ab1',nextval('account_number_seq'),'carbon','c:legacy','active','Legacy','https://example.test/avatar',date '2000-01-01','UTC')").execute(&ctx.state.db).await.expect("UUID migration fixture");
    let account = accounts::get(&mut *ctx.conn().await, "Ab1")
        .await
        .expect("UUID migration fixture")
        .expect("UUID migration fixture");
    let token = ctx.first_party_tokens(&account).await;
    let cookie = ctx.browser_session(&account).await;
    let router = accounts_server::build_router(ctx.state.clone());
    assert_eq!(
        call(
            router.clone(),
            Req::get("/v1/me").bearer(&token.access_token)
        )
        .await
        .status,
        200
    );
    let plan = uuid_migration::prepare(&ctx.state.db)
        .await
        .expect("UUID migration fixture");
    uuid_migration::apply(&ctx.state.db, &plan, true)
        .await
        .expect("UUID migration fixture");
    let denied = call(
        router.clone(),
        Req::get("/v1/me").bearer(&token.access_token),
    )
    .await;
    assert_eq!(denied.status, 401, "{}", denied.json);
    let denied_cookie = call(
        router.clone(),
        Req::get("/v1/me").session(&ctx.state.settings, &cookie),
    )
    .await;
    assert_eq!(denied_cookie.status, 401, "{}", denied_cookie.json);
    let denied_refresh = call(
        router.clone(),
        Req::post("/v1/oauth/token").form(&[
            ("grant_type", "refresh_token"),
            ("client_id", "silicon-accounts"),
            ("refresh_token", &token.refresh_token),
        ]),
    )
    .await;
    assert_eq!(
        denied_refresh.json["error"], "invalid_grant",
        "{}",
        denied_refresh.json
    );
    let migrated = accounts::get(&mut *ctx.conn().await, &plan[0].new_uuid)
        .await
        .expect("UUID migration fixture")
        .expect("UUID migration fixture");
    let fresh = ctx.first_party_tokens(&migrated).await;
    let accepted = call(router, Req::get("/v1/me").bearer(&fresh.access_token)).await;
    assert_eq!(accepted.status, 200, "{}", accepted.json);
    assert_eq!(accepted.json["uuid"], plan[0].new_uuid);
}

#[tokio::test]
async fn migrated_history_cannot_be_replayed_or_claimed_for_delivery() {
    use accounts_core::{
        events,
        models::{AccountField, Scope},
    };
    use serde_json::json;
    use uuid::Uuid;
    let ctx = TestContext::new().await;
    sqlx::query("insert into accounts(uuid,number,kind,handle,status,display_name,pfp_url,dob,timezone,custodian_uuid) values('Ab1',nextval('account_number_seq'),'carbon','c:legacy','active','Legacy','https://example.test/a',date '2000-01-01','UTC',null),('Si2',nextval('account_number_seq'),'silicon','si:legacy','active','Legacy Silicon','https://example.test/b',date '2000-01-01','UTC','Ab1')").execute(&ctx.state.db).await.expect("legacy accounts");
    let (app, secret) = ctx.app("rekey").await;
    ctx.set_app_webhook(&app.app_id, "http://127.0.0.1:9999/receive")
        .await;
    ctx.membership(&app.app_id, "Si2", &[Scope::Profile]).await;
    let mut conn = ctx.conn().await;
    let (_, encrypted) = events::new_webhook_secret(&ctx.state.keys.keyring).expect("secret");
    let silicon = accounts::set_silicon_webhook(
        &mut conn,
        "Si2",
        Some("http://127.0.0.1:9999/silicon"),
        Some(&encrypted),
    )
    .await
    .expect("webhook");
    events::notify_profile_updated(&mut conn, &silicon, &[AccountField::DisplayName])
        .await
        .expect("old events");
    let deliveries: Vec<(Uuid, String)> =
        sqlx::query_as("select id,target_kind from webhook_deliveries")
            .fetch_all(&mut *conn)
            .await
            .expect("old deliveries");
    drop(conn);
    let plan = uuid_migration::prepare(&ctx.state.db).await.expect("plan");
    uuid_migration::apply(&ctx.state.db, &plan, true)
        .await
        .expect("cutover");
    let new_uuid = &plan
        .iter()
        .find(|r| r.old_uuid == "Si2")
        .expect("silicon map")
        .new_uuid;
    let silicon = accounts::get(&mut *ctx.conn().await, new_uuid)
        .await
        .expect("account")
        .expect("silicon");
    let token = ctx.first_party_tokens(&silicon).await;
    let router = accounts_server::build_router(ctx.state.clone());
    for (id, kind) in &deliveries {
        let request = if kind == "app" {
            Req::post(&format!("/v1/apps/{}/webhook/replay", app.app_id))
                .basic(&app.app_id, &secret)
        } else {
            Req::post("/v1/me/webhook/replay").bearer(&token.access_token)
        };
        let response = call(router.clone(), request.json(json!({"delivery_ids":[id]}))).await;
        assert_eq!(response.status, 200, "{}", response.json);
        assert_eq!(response.json["replayed"], json!([]));
        assert_eq!(
            response.json["skipped"][0]["reason"],
            "account_uuid_migrated"
        );
    }
    // Even if an operator accidentally requeues one, the worker cannot send it.
    sqlx::query("update webhook_deliveries set status='pending' where id=any($1)")
        .bind(deliveries.iter().map(|d| d.0).collect::<Vec<_>>())
        .execute(&ctx.state.db)
        .await
        .expect("simulate accidental replay");
    let claimed = accounts_worker::webhooks::claim_due(&ctx.state.db, 100, 60)
        .await
        .expect("claim");
    assert!(!claimed.is_empty(), "fresh reconciled state still delivers");
    assert!(
        claimed
            .iter()
            .all(|row| !deliveries.iter().any(|old| old.0 == row.id))
    );
}
