//! The auth routes merge with the oauth crate's (which owns `POST /v1/device/authorize` and
//! `/v1/oauth/{token,revoke,introspect}`) without conflicts, and requests reach the right side.

mod common;

use accounts_core::AppState;
use accounts_core::test_support::{Req, TestContext};
use axum::Router;
use axum::routing::post;

fn oauth_like() -> Router<AppState> {
    Router::new()
        .route("/v1/device/authorize", post(|| async { "authorize" }))
        .route("/v1/oauth/token", post(|| async { "token" }))
        .route("/v1/oauth/revoke", post(|| async { "revoke" }))
        .route("/v1/oauth/introspect", post(|| async { "introspect" }))
}

#[tokio::test]
async fn routes_merge_with_the_oauth_crate() {
    let ctx = TestContext::new().await;
    let app = || accounts_auth::router().merge(oauth_like());
    let r = ctx.call(app(), Req::post("/v1/device/authorize")).await;
    assert_eq!(r.status, 200);
    assert_eq!(r.body, b"authorize");
    let r = ctx.call(app(), Req::post("/v1/oauth/token")).await;
    assert_eq!(r.body, b"token");
    // The device approval page is ours (needs a signed-in Carbon).
    let r = ctx.call(app(), Req::get("/v1/device/WDJB-MJHT")).await;
    assert_eq!(r.status, 401);
    // So is the provider callback under /v1/oauth.
    let r = ctx
        .call(
            app(),
            Req::get("/v1/oauth/callback/google?state=x").header("accept", "application/json"),
        )
        .await;
    assert_eq!(r.status, 400);
    assert_eq!(r.error_code(), Some("invalid_state"));
}
