//! The Organizations bridge's Ting relays.

use accounts_core::repo::organizations;
use accounts_core::test_support::{Req, TestContext, test_settings};
use axum::Router;
use axum::http::StatusCode;
use axum::routing::post;
use serde_json::json;

use crate::common::*;

#[tokio::test]
async fn linked_account_notifications_go_to_the_configured_ting() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("listener");
    let mut settings = test_settings();
    settings.ting_url = format!("http://{}", listener.local_addr().expect("addr"));
    let ting = Router::new().route("/v1/tings", post(|| async { StatusCode::CREATED }));
    let server = tokio::spawn(async move { axum::serve(listener, ting).await });
    let ctx = TestContext::with_settings(settings).await;
    let secret = "org-test-service-secret";
    sqlx::query("insert into apps(app_id,name,secret_hash,status,source) values('silicon-organizations','Organizations',$1,'active','fake')")
        .bind(ctx.state.keys.pepper.hash(secret))
        .execute(&ctx.state.db)
        .await
        .expect("organizations app");
    ctx.exec(
        "insert into organization_projections(org_id,name) values('testorg','Test organization')",
    )
    .await;
    let personal = ctx.carbon().await;
    let work = ctx.carbon().await;
    sqlx::query("update accounts set org_id='testorg',handle='c:member.testorg' where uuid=$1")
        .bind(&work.uuid)
        .execute(&ctx.state.db)
        .await
        .expect("work account");
    organizations::link(&mut *ctx.conn().await, &personal.uuid, &work.uuid)
        .await
        .expect("link");
    let r = call(
        &ctx,
        Req::post(&format!(
            "/v1/internal/organizations/testorg/accounts/{}/notify-linked",
            work.uuid
        ))
        .basic(organizations::APP_ID, secret)
        .json(json!({
            "proof_token": "proof",
            "notification": {"type": "silicon-organizations.test", "key": "k1"},
        })),
    )
    .await;
    assert_status(&r, 200);
    assert_eq!(r.json["delivered"], 1);
    server.abort();
}
