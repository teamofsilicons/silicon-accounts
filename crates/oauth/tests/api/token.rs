//! POST /v1/oauth/token: what holds for every grant.

use accounts_core::models::Scope;
use accounts_core::test_support::{Req, TestContext};
use serde_json::json;

use crate::common::*;

#[tokio::test]
async fn grant_type_is_required_and_must_be_supported() {
    let ctx = TestContext::new().await;
    let (app, secret) = ctx.app("briefcase").await;
    let r = ctx
        .call(
            router(),
            Req::post("/v1/oauth/token").basic(&app.app_id, &secret),
        )
        .await;
    assert_oauth_error(&r, 400, "invalid_request", "grant_type is required");
    for (grant, mentions) in [
        ("password", "/authorize"),
        ("client_credentials", "/v1/proofs/ata"),
        (
            "urn:ietf:params:oauth:grant-type:token-exchange",
            "/v1/proofs/obo",
        ),
        ("implicit", "PKCE"),
        ("magic", "'magic' is not supported"),
    ] {
        let r = ctx
            .call(
                router(),
                token_req(&app.app_id, &secret, &[("grant_type", grant)]),
            )
            .await;
        assert_oauth_error(&r, 400, "unsupported_grant_type", mentions);
    }
}

#[tokio::test]
async fn malformed_bodies_get_precise_errors() {
    let ctx = TestContext::new().await;
    let (app, secret) = ctx.app("briefcase").await;
    let mut repeated = Req::post("/v1/oauth/token")
        .basic(&app.app_id, &secret)
        .header("content-type", "application/x-www-form-urlencoded");
    repeated.body = b"grant_type=refresh_token&refresh_token=sar_a&refresh_token=sar_b".to_vec();
    let r = ctx.call(router(), repeated).await;
    assert_oauth_error(&r, 400, "invalid_request", "duplicate field");
    let r = ctx
        .call(
            router(),
            Req::post("/v1/oauth/token")
                .basic(&app.app_id, &secret)
                .json(json!({"grant_type": 5})),
        )
        .await;
    assert_oauth_error(&r, 400, "invalid_request", "grant_type");
    let mut broken = Req::post("/v1/oauth/token")
        .basic(&app.app_id, &secret)
        .header("content-type", "application/json");
    broken.body = b"{\"grant_type\":".to_vec();
    let r = ctx.call(router(), broken).await;
    assert_oauth_error(&r, 400, "invalid_request", "could not be read");
    // Bodies over the limit are refused before parsing.
    let mut huge = Req::post("/v1/oauth/token")
        .basic(&app.app_id, &secret)
        .header("content-type", "application/x-www-form-urlencoded");
    huge.body = vec![b'a'; 3 * 1024 * 1024];
    let r = ctx.call(router(), huge).await;
    assert_oauth_error(&r, 413, "invalid_request", "too large");
}

#[tokio::test]
async fn unknown_parameters_are_ignored() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let (app, secret) = ctx.app("briefcase").await;
    let tokens = sign_in(&ctx, &app.app_id, &secret, &carbon, &[Scope::Profile]).await;
    let r = ctx
        .call(
            router(),
            token_req(
                &app.app_id,
                &secret,
                &[
                    ("grant_type", "refresh_token"),
                    ("refresh_token", s(&tokens, "refresh_token")),
                    ("resource", "https://briefcase.example"),
                    ("audience", "ignored"),
                ],
            ),
        )
        .await;
    assert_tokens(&r);
}

#[tokio::test]
async fn a_disabled_app_cannot_use_the_token_endpoint() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let (app, secret) = ctx.app("briefcase").await;
    let tokens = sign_in(&ctx, &app.app_id, &secret, &carbon, &[Scope::Profile]).await;
    ctx.exec(&format!(
        "update apps set status = 'disabled' where app_id = '{}'",
        app.app_id
    ))
    .await;
    ctx.state.app_cache.invalidate(&app.app_id);
    let r = refresh(&ctx, &app.app_id, &secret, s(&tokens, "refresh_token")).await;
    assert_oauth_error(&r, 401, "invalid_client", "disabled");
}

#[tokio::test]
async fn every_answer_echoes_no_secrets_into_errors() {
    let ctx = TestContext::new().await;
    let (app, secret) = ctx.app("briefcase").await;
    let r = ctx
        .call(
            router(),
            token_req(
                &app.app_id,
                &secret,
                &[
                    ("grant_type", "refresh_token"),
                    ("refresh_token", "sar_secret-value-123"),
                ],
            ),
        )
        .await;
    assert_oauth_error(&r, 400, "invalid_grant", "not known");
    assert!(!r.json.to_string().contains("secret-value-123"));
    assert!(!r.json.to_string().contains(&secret));
}
