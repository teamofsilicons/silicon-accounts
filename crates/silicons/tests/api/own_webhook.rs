//! Accounts callback endpoints are retired without creating delivery work.
use crate::common::*;
use accounts_core::test_support::{Req, TestContext};
use serde_json::json;
#[tokio::test]
async fn own_and_custodian_callback_routes_direct_clients_to_ting() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let (silicon, _) = ctx.silicon(&carbon.uuid).await;
    let auth = token(&ctx, &silicon).await;
    for base in [
        "/v1/me/webhook".to_string(),
        format!("/v1/me/silicons/{}/webhook", silicon.uuid),
    ] {
        for request in [
            Req::put(&base).json(json!({"url":"http://127.0.0.1:9999/retired"})),
            Req::delete(&base),
            Req::get(&format!("{base}/deliveries")),
            Req::get(&format!("{base}/deliveries/old-id")),
            Req::post(&format!("{base}/replay")).json(json!({"all":true})),
        ] {
            let response = call(&ctx, request.bearer(&auth)).await;
            assert_eq!(response.status, 410, "{}", response.json);
            assert_eq!(response.error_code(), Some("silicon_notifications_moved"));
        }
    }
    let response = call(&ctx, Req::post("/v1/me/webhook/test").bearer(&auth)).await;
    assert_eq!(response.status, 410);
    let n: i64 =
        sqlx::query_scalar("select count(*) from webhook_deliveries where target_kind='silicon'")
            .fetch_one(&ctx.state.db)
            .await
            .unwrap();
    assert_eq!(n, 0);
}
