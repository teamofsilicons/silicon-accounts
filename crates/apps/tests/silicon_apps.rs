mod common;

use accounts_core::models::{AccountField, Scope};
use accounts_core::secrecy::SecretString;
use accounts_core::test_support::{Req, TestContext};
use accounts_core::{Settings, events};
use common::call;
use serde_json::json;

const TOKEN: &str = "apps-service-test-token-at-least-32-characters";

#[tokio::test]
async fn silicon_authors_join_leave_and_existing_users_survive_sync() {
    let mut settings = Settings::for_tests();
    settings.internal_token = Some(SecretString::from(TOKEN));
    let ctx = TestContext::with_settings(settings).await;
    let carbon = ctx.carbon().await;
    let (silicon, _) = ctx.silicon(&carbon.uuid).await;
    let outsider = ctx.carbon().await;
    let sync = |authors: Vec<String>, owner: String| {
        Req::post("/v1/internal/apps/sync").bearer(TOKEN).json(json!({"apps":[{
        "app_id":"joint-app","name":"Joint app","secret":"sa_app_joint-app-long-random-test-secret",
        "owner_uuid":owner,"author_uuids":authors
    }]}))
    };
    let response = call(
        &ctx,
        sync(
            vec![silicon.uuid.clone(), carbon.uuid.clone()],
            silicon.uuid.clone(),
        ),
    )
    .await;
    assert_eq!(response.status, 200, "{}", response.json);
    ctx.membership("joint-app", &outsider.uuid, &[Scope::Profile])
        .await;
    let carbon_cookie = ctx.browser_session(&carbon).await;
    let silicon_cookie = ctx.browser_session(&silicon).await;
    for cookie in [&carbon_cookie, &silicon_cookie] {
        let response = call(
            &ctx,
            Req::get("/v1/apps/joint-app").session(&ctx.state.settings, cookie),
        )
        .await;
        assert_eq!(response.status, 200, "{}", response.json);
    }
    let response = call(&ctx, sync(vec![silicon.uuid.clone()], silicon.uuid.clone())).await;
    assert_eq!(response.status, 200, "{}", response.json);
    let response = call(
        &ctx,
        Req::get("/v1/apps/joint-app").session(&ctx.state.settings, &carbon_cookie),
    )
    .await;
    assert_eq!(response.status, 403);
    let count: i64 =
        sqlx::query_scalar("select count(*) from memberships where app_id='joint-app'")
            .fetch_one(&ctx.state.db)
            .await
            .unwrap();
    assert_eq!(count, 1);
    let exported = call(&ctx, Req::get("/v1/internal/apps").bearer(TOKEN)).await;
    assert_eq!(exported.status, 200);
    assert_eq!(
        exported.json["apps"][0]["authors"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert!(!exported.json.to_string().contains("sa_app_"));
    assert_eq!(call(&ctx, Req::get("/v1/internal/apps")).await.status, 401);
}

#[tokio::test]
async fn selected_webhook_updates_are_stored_and_filter_deliveries() {
    let ctx = TestContext::new().await;
    let author = common::owned_app(&ctx, "selected").await;
    let member = ctx.carbon().await;
    ctx.membership(
        &author.app_id,
        &member.uuid,
        &[Scope::Profile, Scope::Timezone],
    )
    .await;
    let path = format!("/v1/apps/{}/webhook", author.app_id);
    let configured = call(
        &ctx,
        Req::put(&path)
            .basic(&author.app_id, &author.secret)
            .json(json!({
                "url":"http://127.0.0.1:8593/hook","events":["id_change","display_name_change"]
            })),
    )
    .await;
    assert_eq!(configured.status, 200, "{}", configured.json);
    let read = call(&ctx, Req::get(&path).basic(&author.app_id, &author.secret)).await;
    assert_eq!(
        read.json["events"],
        json!(["id_change", "display_name_change"])
    );
    assert!(read.json.get("secret").is_none());
    let mut conn = ctx.conn().await;
    assert!(
        events::account_updated(&mut conn, &member, &[AccountField::Timezone])
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        events::account_updated(
            &mut conn,
            &member,
            &[AccountField::DisplayName, AccountField::Timezone]
        )
        .await
        .unwrap()
        .len(),
        1
    );
    assert!(
        events::account_deleted(&mut conn, &member.uuid)
            .await
            .unwrap()
            .is_empty()
    );
    assert!(
        events::membership_signed_out(&mut conn, &author.app_id, &member.uuid, "user")
            .await
            .unwrap()
            .is_none()
    );
    let invalid = call(
        &ctx,
        Req::put(&path)
            .basic(&author.app_id, &author.secret)
            .json(json!({"url":"http://127.0.0.1:8593/hook","events":["made_up"]})),
    )
    .await;
    assert_eq!(invalid.status, 422);
}

#[tokio::test]
async fn apps_mail_resolves_contacts_privately_and_deduplicates() {
    let mut settings = Settings::for_tests();
    settings.internal_token = Some(SecretString::from(TOKEN));
    settings.silicon_apps_url = "https://apps.example.test".into();
    settings.developer_url = "https://developers.example.test".into();
    let ctx = TestContext::with_settings(settings).await;
    let app = common::owned_app(&ctx, "mail").await;
    let body = json!({"kind":"mail.invite","body":{"id":"invitation-one","app_id":app.app_id,"to":app.owner.handle,"account_uuid":app.owner.uuid}});
    for _ in 0..2 {
        let response = call(
            &ctx,
            Req::post("/v1/internal/apps/mail")
                .bearer(TOKEN)
                .header("Idempotency-Key", "invite-mail-one")
                .json(body.clone()),
        )
        .await;
        assert_eq!(response.status, 202, "{}", response.json);
        assert_eq!(response.json["recipients"], 1);
        assert!(!response.json.to_string().contains('@'));
    }
    let count: i64 =
        sqlx::query_scalar("select count(*) from outbound_messages where purpose='apps_invite'")
            .fetch_one(&ctx.state.db)
            .await
            .unwrap();
    assert_eq!(count, 1);
    let body: String =
        sqlx::query_scalar("select text_body from outbound_messages where purpose='apps_invite'")
            .fetch_one(&ctx.state.db)
            .await
            .unwrap();
    assert!(body.contains("https://developers.example.test/invitations"));
    assert!(!body.contains("https://apps.example.test"));
    let response=call(&ctx,Req::post("/v1/internal/apps/mail").bearer(TOKEN).header("Idempotency-Key","report-mail-one").json(json!({"kind":"mail.report","body":{"message":"Local test report","pr":"https://github.com/teamofsilicons/silicon-apps/pull/1"}}))).await;
    assert_eq!(response.status, 202, "{}", response.json);
    assert_eq!(response.json["recipients"], 3);
}

#[tokio::test]
async fn webhook_secret_can_be_prepared_before_endpoint_and_preserved() {
    let ctx = TestContext::new().await;
    let app = common::owned_app(&ctx, "prepare").await;
    let path = format!("/v1/apps/{}/webhook", app.app_id);
    let generated = call(
        &ctx,
        Req::post(&format!("{path}/generate-secret"))
            .basic(&app.app_id, &app.secret)
            .header("Idempotency-Key", "prepare-secret-once"),
    )
    .await;
    assert_eq!(generated.status, 200, "{}", generated.json);
    let first = generated.json["secret"].as_str().unwrap();
    assert!(first.starts_with("whsec_"));
    let unset = call(&ctx, Req::get(&path).basic(&app.app_id, &app.secret)).await;
    assert!(unset.json["url"].is_null());
    assert_eq!(unset.json["secret_set"], true);
    for url in [
        "http://127.0.0.1:8593/first",
        "http://127.0.0.1:8593/second",
    ] {
        let saved = call(
            &ctx,
            Req::put(&path)
                .basic(&app.app_id, &app.secret)
                .json(json!({"url":url,"events":["id_change"],"preserve_secret":true})),
        )
        .await;
        assert_eq!(saved.status, 200, "{}", saved.json);
        assert!(saved.json["secret"].is_null());
    }
    let encrypted: Vec<u8> =
        sqlx::query_scalar("select webhook_secret_enc from app_signin_configs where app_id=$1")
            .bind(&app.app_id)
            .fetch_one(&ctx.state.db)
            .await
            .unwrap();
    assert_eq!(
        ctx.state.keys.keyring.decrypt_string(&encrypted).unwrap(),
        first
    );
}

#[tokio::test]
async fn apps_audience_is_limited_to_author_routes_and_active_memberships() {
    let ctx = TestContext::new().await;
    let app = common::owned_app(&ctx, "audience").await;
    // Register the exact catalog application.
    sqlx::query("insert into apps(app_id,name,source,status,secret_hash) values('apps','Silicon Apps','silicon_apps','active','test'::bytea) on conflict do nothing").execute(&ctx.state.db).await.unwrap();
    ctx.membership("apps", &app.owner.uuid, &[Scope::Profile])
        .await;
    let token = ctx
        .tokens_for(&app.owner, "apps", &[Scope::Profile])
        .await
        .access_token;
    let path = format!("/v1/apps/{}", app.app_id);
    assert_eq!(call(&ctx, Req::get(&path).bearer(&token)).await.status, 200);
    let denied = call(&ctx, Req::get("/v1/me/owned-apps").bearer(&token)).await;
    assert_eq!(denied.status, 401);
    assert_eq!(denied.error_code(), Some("token_wrong_audience"));
    let stranger = ctx.carbon().await;
    ctx.membership("apps", &stranger.uuid, &[Scope::Profile])
        .await;
    let stranger_token = ctx
        .tokens_for(&stranger, "apps", &[Scope::Profile])
        .await
        .access_token;
    assert_eq!(
        call(&ctx, Req::get(&path).bearer(&stranger_token))
            .await
            .status,
        403
    );
    sqlx::query(
        "update memberships set status='access_removed' where app_id='apps' and account_uuid=$1",
    )
    .bind(&app.owner.uuid)
    .execute(&ctx.state.db)
    .await
    .unwrap();
    let removed = call(&ctx, Req::get(&path).bearer(&token)).await;
    assert_eq!(removed.status, 401);
    assert_eq!(removed.error_code(), Some("access_removed"));
}
