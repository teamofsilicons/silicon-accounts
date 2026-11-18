//! The Organizations bridge's Ting relays and system mail.

use accounts_core::config::Settings;
use accounts_core::repo::organizations;
use accounts_core::test_support::{Req, TestContext, test_settings};
use axum::Router;
use axum::http::StatusCode;
use axum::routing::post;
use serde_json::json;
use tokio::task::JoinHandle;

use crate::common::*;

const SECRET: &str = "org-test-service-secret";

/// A context with the Organizations app and the `testorg` organization registered.
async fn org_context(settings: Settings) -> TestContext {
    let ctx = TestContext::with_settings(settings).await;
    sqlx::query("insert into apps(app_id,name,secret_hash,status,source) values('silicon-organizations','Organizations',$1,'active','fake')")
        .bind(ctx.state.keys.pepper.hash(SECRET))
        .execute(&ctx.state.db)
        .await
        .expect("organizations app");
    ctx.exec(
        "insert into organization_projections(org_id,name) values('testorg','Test organization')",
    )
    .await;
    ctx
}

/// `org_context` whose configured Ting is a local listener that accepts every send.
async fn with_local_ting() -> (TestContext, JoinHandle<std::io::Result<()>>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("listener");
    let mut settings = test_settings();
    settings.ting_url = format!("http://{}", listener.local_addr().expect("addr"));
    let ting = Router::new().route("/v1/tings", post(|| async { StatusCode::CREATED }));
    let server = tokio::spawn(async move { axum::serve(listener, ting).await });
    (org_context(settings).await, server)
}

#[tokio::test]
async fn linked_account_notifications_go_to_the_configured_ting() {
    let (ctx, server) = with_local_ting().await;
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
        .basic(organizations::APP_ID, SECRET)
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

#[tokio::test]
async fn invitation_notifications_go_to_the_configured_ting() {
    let (ctx, server) = with_local_ting().await;
    let invited = ctx.carbon().await;
    sqlx::query("insert into organization_invitations(invite_id,org_id,ticket_hash,account_uuid,handle,return_to,expires_at) values('inv1','testorg','ticket'::bytea,$1,'c:invited.testorg','https://organizations.example.test/',now()+interval '1 day')")
        .bind(&invited.uuid)
        .execute(&ctx.state.db)
        .await
        .expect("invitation");
    let r = call(
        &ctx,
        Req::post("/v1/internal/organizations/testorg/invitations/inv1/notify")
            .basic(organizations::APP_ID, SECRET)
            .json(json!({
                "proof_token": "proof",
                "notification": {"type": "silicon-organizations.inviteSent", "key": "k1"},
            })),
    )
    .await;
    assert_status(&r, 200);
    assert_eq!(r.json["delivered"], 1);
    server.abort();
}

#[tokio::test]
async fn system_mail_goes_only_to_the_configured_report_recipients() {
    let mut settings = test_settings();
    settings.report_recipients = vec!["ops@example.com".into()];
    let ctx = org_context(settings).await;
    let send = |to: &str| {
        Req::post("/v1/internal/organizations/system/mail")
            .basic(organizations::APP_ID, SECRET)
            .json(json!({
                "kind": "bug_report",
                "to_email": to,
                "subject": "Bug",
                "text_body": "Something broke.",
            }))
    };
    let r = call(&ctx, send("ops@example.com")).await;
    assert_status(&r, 202);
    let r = call(&ctx, send("saketdev12@gmail.com")).await;
    assert_error(&r, 403, "report_recipient_forbidden");
}
