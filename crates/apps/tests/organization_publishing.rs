mod common;
use accounts_core::{
    Settings,
    models::Scope,
    secrecy::SecretString,
    test_support::{Req, TestContext},
};
use axum::{Json, Router, routing::get};
use serde_json::{Value, json};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
const INTERNAL: &str = "platform-test-internal-0123456789abcdef";
#[tokio::test]
async fn organization_projection_keeps_ownership_and_revokes_departed_manager() {
    let member = Arc::new(Mutex::new(String::new()));
    let active = Arc::new(AtomicBool::new(true));
    let captured = member.clone();
    let allowed = active.clone();
    let router=Router::new().route("/v1/integrations/developer/publishing",get(move||{let uuid=captured.lock().unwrap().clone();let live=allowed.load(Ordering::SeqCst);async move{Json(json!({"account_uuid":uuid,"organizations":if live{vec![json!({"org_id":"example","name":"Example","admin":false,"teams":[],"permissions":{"apps":["manage"]}})]}else{vec![]}}))}}));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let mut settings = Settings::for_tests();
    settings.organizations_url = base;
    settings.internal_token = Some(SecretString::from(INTERNAL));
    let ctx = TestContext::with_settings(settings).await;
    let owner = ctx.carbon().await;
    *member.lock().unwrap() = owner.uuid.clone();
    let token = ctx
        .tokens_for(&owner, "developer", &[Scope::Profile])
        .await
        .access_token;
    let app = json!({"app_id":"org-publishing-test","name":"Organization app","organization_id":"example","organization_access":{"grants":[]},"secret":"sa_app_notes-x_0123456789abcdefghijklmnopqrstuv","status":"active","author_uuids":[],"owner_uuid":null});
    let sync = |app: Value| {
        Req::post("/v1/internal/apps/sync")
            .bearer(INTERNAL)
            .json(json!({"apps":[app]}))
    };
    let result = common::call(&ctx, sync(app.clone())).await;
    assert_eq!(result.status, 200, "{}", result.json);
    let projection:(Option<String>,String)=sqlx::query_as("SELECT a.owner_uuid,p.organization_id FROM apps a JOIN app_organization_publishers p USING(app_id) WHERE app_id='org-publishing-test'").fetch_one(&ctx.state.db).await.unwrap();
    assert_eq!(projection, (None, "example".into()));
    let path = "/v1/apps/org-publishing-test";
    assert_eq!(
        common::call(&ctx, Req::get(path).bearer(&token))
            .await
            .status,
        200
    );
    assert_eq!(
        common::call(
            &ctx,
            Req::get(&format!("{path}/account-verification-request")).bearer(&token)
        )
        .await
        .status,
        200
    );
    let mut personal = app.clone();
    personal.as_object_mut().unwrap().remove("organization_id");
    personal["owner_uuid"] = json!(owner.uuid);
    assert_eq!(common::call(&ctx, sync(personal)).await.status, 422);
    let mut different = app.clone();
    different["organization_id"] = json!("other-org");
    assert_eq!(common::call(&ctx, sync(different)).await.status, 422);
    // Stale legacy author rows cannot restore authority after departure.
    sqlx::query("INSERT INTO app_authors(app_id,account_uuid) VALUES('org-publishing-test',$1)")
        .bind(&owner.uuid)
        .execute(&ctx.state.db)
        .await
        .unwrap();
    active.store(false, Ordering::SeqCst);
    assert_eq!(
        common::call(&ctx, Req::get(path).bearer(&token))
            .await
            .status,
        403
    );
    assert_eq!(
        common::call(
            &ctx,
            Req::get(&format!("{path}/account-verification-request")).bearer(&token)
        )
        .await
        .status,
        403
    );
    let owned = common::call(&ctx, Req::get("/v1/me/owned-apps").bearer(&token)).await;
    assert_eq!(owned.status, 200);
    assert!(
        !owned.json["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v["app_id"] == "org-publishing-test")
    );
    let mut disabled = app.clone();
    disabled["status"] = json!("disabled");
    disabled["deleted_at"] = json!("2026-10-01T00:00:00Z");
    assert_eq!(common::call(&ctx, sync(disabled)).await.status, 200);
    let state: String =
        sqlx::query_scalar("SELECT status::text FROM apps WHERE app_id='org-publishing-test'")
            .fetch_one(&ctx.state.db)
            .await
            .unwrap();
    assert_eq!(state, "disabled");
    let deleted: Option<time::OffsetDateTime> = sqlx::query_scalar(
        "SELECT deleted_at FROM app_registry_lifecycle WHERE app_id='org-publishing-test'",
    )
    .fetch_one(&ctx.state.db)
    .await
    .unwrap();
    assert!(deleted.is_some());
    let exported = common::call(&ctx, Req::get("/v1/internal/apps").bearer(INTERNAL)).await;
    assert_eq!(exported.status, 200);
    let registry = exported.json["apps"].as_array().unwrap();
    for internal in [
        "silicon-accounts",
        "developer",
        "silicon-account-management",
        "silicon-apps-catalog",
    ] {
        assert!(registry.iter().all(|app| app["app_id"] != internal));
    }
    let record = registry
        .iter()
        .find(|v| v["app_id"] == "org-publishing-test")
        .unwrap();
    assert!(
        record["deleted_at"]
            .as_str()
            .unwrap()
            .starts_with("2026-10-01T00:00:00")
    );
    active.store(true, Ordering::SeqCst);
    let owned = common::call(&ctx, Req::get("/v1/me/owned-apps").bearer(&token)).await;
    assert!(
        !owned.json["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v["app_id"] == "org-publishing-test")
    );
    assert_eq!(common::call(&ctx, sync(app)).await.status, 200);
    let deleted: Option<time::OffsetDateTime> = sqlx::query_scalar(
        "SELECT deleted_at FROM app_registry_lifecycle WHERE app_id='org-publishing-test'",
    )
    .fetch_one(&ctx.state.db)
    .await
    .unwrap();
    assert!(deleted.is_none());
    let owned = common::call(&ctx, Req::get("/v1/me/owned-apps").bearer(&token)).await;
    assert!(
        owned.json["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v["app_id"] == "org-publishing-test")
    );
    server.abort();
}
