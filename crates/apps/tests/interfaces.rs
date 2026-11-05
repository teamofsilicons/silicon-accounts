mod common;
use accounts_core::{
    Settings,
    secrecy::SecretString,
    test_support::{Req, TestContext},
};
use common::call;
use serde_json::{Value, json};
const TOKEN: &str = "internal-token-for-tests-0123456789abcdef";
const APPS_TOKEN: &str = "apps-internal-token-for-tests-0123456789";

#[tokio::test]
async fn interface_and_apps_internal_credentials_are_separate() {
    let mut settings = Settings::for_tests();
    settings.internal_token = Some(SecretString::from(APPS_TOKEN));
    settings.interfaces_internal_token = Some(SecretString::from(TOKEN));
    let ctx = TestContext::with_settings(settings).await;
    let actor = ctx.carbon().await;
    let url = format!("/v1/internal/interfaces/eligibility/{}", actor.uuid);
    assert_eq!(call(&ctx, Req::get(&url).bearer(TOKEN)).await.status, 200);
    assert_eq!(
        call(&ctx, Req::get(&url).bearer(APPS_TOKEN)).await.status,
        401
    );
    assert_eq!(
        call(&ctx, Req::get("/v1/internal/apps").bearer(APPS_TOKEN))
            .await
            .status,
        200
    );
    assert_eq!(
        call(&ctx, Req::get("/v1/internal/apps").bearer(TOKEN))
            .await
            .status,
        401
    );
}

fn request(body: Value, key: &str) -> Req {
    Req::post("/v1/internal/interfaces/sync")
        .bearer(TOKEN)
        .header("idempotency-key", key)
        .json(body)
}

#[tokio::test]
async fn broker_sync_rejects_old_or_conflicting_cell_generation() {
    let mut settings = Settings::for_tests();
    settings.interfaces_internal_token = Some(SecretString::from(TOKEN));
    let ctx = TestContext::with_settings(settings).await;
    let actor = ctx.carbon().await;
    let (app, _) = ctx.app_owned("interface-target", Some(&actor.uuid)).await;
    let one = "https://one.cells.example/interface-auth/callback";
    let two = "https://two.cells.example/interface-auth/callback";
    let mut body = json!({"interface_id":"potato","actor_uuid":actor.uuid,"revision":1,"name":"Potato","logo_url":null,"kind":"unverified","app_ids":[app.app_id],"redirect_uris":[one,two],"allowed_origins":["https://app.example"],"cell_broker":{"cell_id":"one","callback_url":one,"generation":1},"branding":{},"app_descriptions":{},"active":true});
    assert_eq!(
        call(&ctx, request(body.clone(), "broker-one")).await.status,
        200
    );
    body["revision"] = json!(2);
    body["cell_broker"] = json!({"cell_id":"two","callback_url":two,"generation":2});
    assert_eq!(
        call(&ctx, request(body.clone(), "broker-two")).await.status,
        200
    );
    body["revision"] = json!(3);
    body["cell_broker"] = json!({"cell_id":"one","callback_url":one,"generation":1});
    assert_eq!(
        call(&ctx, request(body.clone(), "broker-stale"))
            .await
            .status,
        409
    );
    body["cell_broker"] = json!({"cell_id":"one","callback_url":one,"generation":2});
    assert_eq!(
        call(&ctx, request(body.clone(), "broker-conflict"))
            .await
            .status,
        409
    );
    body["cell_broker"] = Value::Null;
    assert_eq!(
        call(&ctx, request(body.clone(), "broker-clear"))
            .await
            .status,
        409
    );
    sqlx::query("update apps set status='disabled' where app_id=$1")
        .bind(body["app_ids"][0].as_str().unwrap())
        .execute(&ctx.db.pool)
        .await
        .unwrap();
    body["actor_uuid"] = json!("deleted-creator");
    body["cell_broker_cleanup"] = json!(true);
    body["cell_broker"] = json!({"cell_id":"two","callback_url":two,"generation":3,"active":false});
    body["redirect_uris"] = json!([one]);
    body["name"] = json!("unauthorized change");
    assert_eq!(
        call(&ctx, request(body.clone(), "cleanup-tampered"))
            .await
            .status,
        403
    );
    body["name"] = json!("Potato");
    let result = call(&ctx, request(body.clone(), "cleanup-exact")).await;
    assert_eq!(result.status, 200, "{}", result.json);
    assert_eq!(
        call(&ctx, request(body.clone(), "cleanup-exact"))
            .await
            .json,
        result.json
    );
    sqlx::query("update apps set status='active' where app_id=$1")
        .bind(body["app_ids"][0].as_str().unwrap())
        .execute(&ctx.db.pool)
        .await
        .unwrap();
    body["actor_uuid"] = json!(actor.uuid);
    body["cell_broker_cleanup"] = json!(false);
    body["revision"] = json!(4);
    body["cell_broker"] = json!({"cell_id":"one","callback_url":one,"generation":4,"active":true});
    assert_eq!(
        call(&ctx, request(body.clone(), "broker-reselect"))
            .await
            .status,
        200
    );
    body["revision"] = json!(5);
    body["cell_broker"] = json!({"cell_id":"two","callback_url":two,"generation":3,"active":false});
    assert_eq!(call(&ctx, request(body, "old-tombstone")).await.status, 409);
}

#[tokio::test]
async fn unlink_before_initial_link_installs_a_tombstone_against_delayed_link() {
    let mut settings = Settings::for_tests();
    settings.interfaces_internal_token = Some(SecretString::from(TOKEN));
    let ctx = TestContext::with_settings(settings).await;
    let actor = ctx.carbon().await;
    let (app, _) = ctx.app_owned("interface-target", Some(&actor.uuid)).await;
    let callback = "https://one.cells.example/interface-auth/callback";
    let mut body = json!({"interface_id":"potato","actor_uuid":actor.uuid,"revision":1,"name":"Potato","logo_url":null,"kind":"unverified","app_ids":[app.app_id],"redirect_uris":[],"allowed_origins":[],"branding":{},"app_descriptions":{},"active":true});
    assert_eq!(
        call(&ctx, request(body.clone(), "initial")).await.status,
        200
    );
    body["actor_uuid"] = json!("inactive-creator");
    body["revision"] = json!(2);
    body["cell_broker_cleanup"] = json!(true);
    body["cell_broker"] =
        json!({"cell_id":"one","callback_url":callback,"generation":2,"active":false});
    assert_eq!(
        call(&ctx, request(body.clone(), "cleanup")).await.status,
        200
    );
    body["actor_uuid"] = json!(actor.uuid);
    body["revision"] = json!(3);
    body["cell_broker_cleanup"] = json!(false);
    body["cell_broker"] =
        json!({"cell_id":"one","callback_url":callback,"generation":1,"active":true});
    assert_eq!(call(&ctx, request(body, "delayed-link")).await.status, 409);
}

#[tokio::test]
async fn registry_bridge_enforces_tiers_revisions_and_atomic_secret_replay() {
    let mut settings = Settings::for_tests();
    settings.interfaces_internal_token = Some(SecretString::from(TOKEN));
    let ctx = TestContext::with_settings(settings).await;
    let actor = ctx.carbon().await;
    let coauthor = ctx.carbon().await;
    let (app, _) = ctx.app_owned("interface-target", Some(&actor.uuid)).await;
    let mut body = json!({"interface_id":"potato","actor_uuid":actor.uuid,"revision":1,"name":"Potato", "logo_url":null, "kind":"unverified", "app_ids":[app.app_id], "redirect_uris":["https://potato.example/callback"], "allowed_origins":["https://potato.example"],"branding":{},"app_descriptions":{},"active":true});
    let created = call(&ctx, request(body.clone(), "op-1")).await;
    assert_eq!(created.status, 200, "{}", created.json);
    let secret = created.json["interface_secret"].as_str().unwrap();
    assert!(secret.starts_with("sif_secret_"));
    let replay = call(&ctx, request(body.clone(), "op-1")).await;
    assert_eq!(replay.json, created.json);
    sqlx::query("update interface_sync_operations set created_at=now()-interval '2 days' where interface_id='potato' and key='op-1'").execute(&ctx.state.db).await.unwrap();
    assert_eq!(
        call(&ctx, request(body.clone(), "op-1")).await.json,
        created.json
    );
    let ack = || {
        Req::post("/v1/internal/interfaces/sync/ack")
            .bearer(TOKEN)
            .json(json!({"interface_id":"potato","key":"op-1"}))
    };
    assert_eq!(call(&ctx, ack()).await.status, 200);
    assert_eq!(call(&ctx, ack()).await.status, 200);
    assert!(
        call(&ctx, request(body.clone(), "op-1"))
            .await
            .json
            .get("interface_secret")
            .is_none()
    );
    let different_key = call(&ctx, request(body.clone(), "op-2")).await;
    assert_eq!(different_key.status, 409);
    body["revision"] = json!(2);
    body["kind"] = json!("trusted");
    assert_eq!(call(&ctx, request(body.clone(), "op-3")).await.status, 403);
    sqlx::query("insert into interface_creator_eligibility(account_uuid,verified,trusted) values($1,true,true)").bind(&actor.uuid).execute(&ctx.state.db).await.unwrap();
    assert_eq!(call(&ctx, request(body.clone(), "op-3")).await.status, 200);
    body["revision"] = json!(3);
    body["actor_uuid"] = json!(coauthor.uuid);
    body["name"] = json!("Potato edited");
    let update = call(&ctx, request(body.clone(), "op-4")).await;
    assert_eq!(update.status, 200, "{}", update.json);
    assert!(update.json.get("interface_secret").is_none());
    let eligibility = call(
        &ctx,
        Req::get(&format!(
            "/v1/internal/interfaces/eligibility/{}",
            coauthor.uuid
        ))
        .bearer(TOKEN),
    )
    .await;
    assert_eq!(eligibility.json, json!({"verified":false,"trusted":false}));
    body["revision"] = json!(4);
    body["redirect_uris"] = json!(["https://evil.example/callback#fragment"]);
    assert_eq!(call(&ctx, request(body, "op-5")).await.status, 400);
}

#[tokio::test]
async fn tier_request_is_durable_and_does_not_grant_eligibility() {
    let mut settings = Settings::for_tests();
    settings.interfaces_internal_token = Some(SecretString::from(TOKEN));
    let ctx = TestContext::with_settings(settings).await;
    let actor = ctx.carbon().await;
    let (app, _) = ctx.app_owned("tier-target", Some(&actor.uuid)).await;
    let body = json!({"interface_id":"potato","actor_uuid":actor.uuid,"revision":1,"name":"Potato", "logo_url":null, "kind":"unverified", "app_ids":[app.app_id], "redirect_uris":[], "allowed_origins":[],"branding":{},"app_descriptions":{},"active":true});
    assert_eq!(call(&ctx, request(body, "create")).await.status, 200);
    let submit = || {
        Req::post("/v1/internal/interfaces/potato/requests")
            .bearer(TOKEN)
            .header("idempotency-key", "ask-1")
            .json(json!({"actor_uuid":actor.uuid,"kind":"trusted","reason":"A reason"}))
    };
    let first = call(&ctx, submit()).await;
    assert_eq!(first.status, 200, "{}", first.json);
    assert_eq!(first.json["created"], true);
    assert_eq!(call(&ctx, submit()).await.json, first.json);
    let count: i64 =
        sqlx::query_scalar("select count(*) from interface_tier_request_notifications")
            .fetch_one(&ctx.state.db)
            .await
            .unwrap();
    assert_eq!(count, 2);
    let eligibility = call(
        &ctx,
        Req::get(&format!(
            "/v1/internal/interfaces/eligibility/{}",
            actor.uuid
        ))
        .bearer(TOKEN),
    )
    .await;
    assert_eq!(eligibility.json, json!({"verified":false,"trusted":false}));
}

#[tokio::test]
async fn cell_localhost_subdomains_are_allowed_but_lookalikes_are_not() {
    let mut settings = Settings::for_tests();
    settings.interfaces_internal_token = Some(SecretString::from(TOKEN));
    let ctx = TestContext::with_settings(settings).await;
    let account = ctx.carbon().await;
    let (app, _) = ctx.app_owned("local-target", Some(&account.uuid)).await;
    let mut body = json!({"interface_id":"celltest","actor_uuid":account.uuid,"revision":1,"name":"Cell", "logo_url":null, "kind":"unverified", "app_ids":[app.app_id], "redirect_uris":["http://cell-id.cells.localhost:8674/interface-auth/callback"], "allowed_origins":["http://cell-id.cells.localhost:8674"],"branding":{},"app_descriptions":{},"active":true});
    let valid = call(&ctx, request(body.clone(), "local-1")).await;
    assert_eq!(valid.status, 200, "{}", valid.json);
    body["revision"] = json!(2);
    body["redirect_uris"] = json!(["http://localhost.evil.test/callback"]);
    assert_eq!(call(&ctx, request(body, "local-2")).await.status, 400);
}

#[tokio::test]
async fn interface_custom_pages_validate_and_provider_secrets_are_refused() {
    let mut settings = Settings::for_tests();
    settings.interfaces_internal_token = Some(SecretString::from(TOKEN));
    let ctx = TestContext::with_settings(settings).await;
    let actor = ctx.carbon().await;
    let (app, _) = ctx.app_owned("custom-target", Some(&actor.uuid)).await;
    let mut body = json!({"interface_id":"custom-interface","actor_uuid":actor.uuid,"revision":1,"name":"Custom", "logo_url":null,"kind":"unverified","app_ids":[app.app_id],"redirect_uris":[],"allowed_origins":[],"branding":{},"app_descriptions":{},"active":true,
        "signin_config":{"required_fields":["email"],"optional_fields":["timezone"],"flow":{"steps":[{"id":"contact","fields":["email"],"title":"Contact"},{"id":"zone","fields":["timezone"],"title":"Zone"}],"review":true},"allow_signup":false,"remember_browser":false,"allowed_email_domains":["example.test"]}});
    let created = call(&ctx, request(body.clone(), "custom-1")).await;
    assert_eq!(created.status, 200, "{}", created.json);
    body["revision"] = json!(2);
    body["signin_config"]["google"] = json!({"client_secret":"fixture-secret"});
    assert_eq!(call(&ctx, request(body, "custom-2")).await.status, 400);
}
