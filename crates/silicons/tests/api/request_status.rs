//! `GET /v1/silicons/requests/{id}` (Bearer sarq_…): the Silicon waits for its custodian.

use std::time::Duration;

use accounts_core::test_support::{Req, TestContext, call as raw_call};
use serde_json::{Value, json};

use crate::common::*;

fn status_req(id: &str, token: &str) -> Req {
    Req::get(&format!("/v1/silicons/requests/{id}")).bearer(token)
}

#[tokio::test]
async fn pending_then_accepted() {
    let ctx = TestContext::new().await;
    let saket = ctx.carbon().await;
    let created = self_created(&ctx, saket.handle.as_deref().expect("id"), json!({})).await;
    let id = created["request"]["id"].as_str().expect("id");
    let token_ = created["request_token"].as_str().expect("token");

    let r = call(&ctx, status_req(id, token_)).await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(r.json["id"], id);
    assert_eq!(r.json["kind"], "initial");
    assert_eq!(r.json["status"], "pending");
    assert_eq!(r.json["decided_at"], Value::Null);
    assert_eq!(r.json["custodian"], saket.handle.clone().expect("id"));
    assert_eq!(r.json["silicon"]["uuid"], created["silicon"]["uuid"]);
    assert_eq!(r.json["silicon"]["id"], created["silicon"]["id"]);
    assert_eq!(r.json["silicon"]["status"], "pending_custodian");
    assert_eq!(r.json["expires_at"], created["request"]["expires_at"]);

    let t = token(&ctx, &saket).await;
    assert_eq!(accept(&ctx, &t, id).await.status, 204);
    let r = call(&ctx, status_req(id, token_)).await;
    assert_eq!(r.json["status"], "accepted");
    assert!(r.json["decided_at"].is_string());
    assert_eq!(r.json["silicon"]["status"], "active");
}

#[tokio::test]
async fn declined_requests_show_the_released_silicon() {
    let ctx = TestContext::new().await;
    let saket = ctx.carbon().await;
    let created = self_created(&ctx, saket.handle.as_deref().expect("id"), json!({})).await;
    let id = created["request"]["id"].as_str().expect("id");
    let t = token(&ctx, &saket).await;
    assert_eq!(decline(&ctx, &t, id).await.status, 204);
    let r = call(
        &ctx,
        status_req(id, created["request_token"].as_str().expect("token")),
    )
    .await;
    assert_eq!(r.status, 200);
    assert_eq!(r.json["status"], "declined");
    assert_eq!(r.json["silicon"]["id"], Value::Null);
    assert_eq!(r.json["silicon"]["status"], "deleted");
}

#[tokio::test]
async fn an_overdue_request_is_expired_when_read() {
    let ctx = TestContext::new().await;
    let saket = ctx.carbon().await;
    let created = self_created(
        &ctx,
        saket.handle.as_deref().expect("id"),
        json!({"webhook_url": "http://127.0.0.1:8593/hooks/overdue"}),
    )
    .await;
    let id = created["request"]["id"].as_str().expect("id");
    let uuid = created["silicon"]["uuid"].as_str().expect("uuid");
    make_overdue(&ctx, id).await;
    let r = call(
        &ctx,
        status_req(id, created["request_token"].as_str().expect("token")),
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(r.json["status"], "expired");
    assert_eq!(r.json["silicon"]["status"], "deleted");
    // The expiry really happened (not just displayed): request row, release, webhook.
    let (status, ..) = request_row(&ctx, id).await;
    assert_eq!(status, "expired");
    assert_eq!(
        silicon_event_types(&ctx, uuid).await,
        vec!["silicon.created", "silicon.custodian.expired"]
    );
}

#[tokio::test]
async fn the_request_token_is_required_and_checked() {
    let ctx = TestContext::new().await;
    let saket = ctx.carbon().await;
    let created = self_created(&ctx, saket.handle.as_deref().expect("id"), json!({})).await;
    let id = created["request"]["id"].as_str().expect("id");
    let other = self_created(&ctx, saket.handle.as_deref().expect("id"), json!({})).await;

    let r = call(&ctx, Req::get(&format!("/v1/silicons/requests/{id}"))).await;
    assert_eq!(r.status, 401);
    assert_eq!(r.error_code(), Some("request_token_required"));

    let jwt = token(&ctx, &saket).await;
    let r = call(&ctx, status_req(id, &jwt)).await;
    assert_eq!(r.status, 401);
    assert_eq!(r.error_code(), Some("invalid_request_token"));
    assert!(
        r.json["error"]["message"]
            .as_str()
            .expect("m")
            .contains("JWT")
    );

    // Another request's token: indistinguishable from an unknown request.
    let r = call(
        &ctx,
        status_req(id, other["request_token"].as_str().expect("token")),
    )
    .await;
    assert_eq!(r.status, 404);
    assert_eq!(r.error_code(), Some("custodian_request_not_found"));
    let r = call(
        &ctx,
        status_req(
            "0190e8d1-0000-7000-8000-000000000000",
            created["request_token"].as_str().expect("token"),
        ),
    )
    .await;
    assert_eq!(r.status, 404);
    let r = call(
        &ctx,
        status_req(
            "not-a-uuid",
            created["request_token"].as_str().expect("token"),
        ),
    )
    .await;
    assert_eq!(r.status, 404);
}

/// What `silicon-accounts silicon create --wait` does: poll until the custodian decides.
#[tokio::test]
async fn waiting_silicon_sees_the_acceptance() {
    let ctx = TestContext::new().await;
    let saket = ctx.carbon().await;
    let created = self_created(&ctx, saket.handle.as_deref().expect("id"), json!({})).await;
    let id = created["request"]["id"].as_str().expect("id").to_string();
    let request_token = created["request_token"]
        .as_str()
        .expect("token")
        .to_string();

    let state = ctx.state.clone();
    let poll_id = id.clone();
    let waiter = tokio::spawn(async move {
        let mut polls = 0;
        loop {
            polls += 1;
            let r = raw_call(
                router().with_state(state.clone()),
                status_req(&poll_id, &request_token),
            )
            .await;
            assert_eq!(r.status, 200, "{}", r.json);
            if r.json["status"] != "pending" {
                return (r.json, polls);
            }
            assert!(polls < 200, "the decision never arrived");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    });
    tokio::time::sleep(Duration::from_millis(120)).await;
    let t = token(&ctx, &saket).await;
    assert_eq!(accept(&ctx, &t, &id).await.status, 204);
    let (final_status, polls) = waiter.await.expect("waiter");
    assert_eq!(final_status["status"], "accepted");
    assert_eq!(final_status["silicon"]["status"], "active");
    assert!(polls > 1, "it waited while the request was pending");
}
