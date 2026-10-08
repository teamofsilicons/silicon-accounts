//! `POST /v1/device/authorize` and `grant_type=urn:ietf:params:oauth:grant-type:device_code`.

use accounts_core::repo::tokens;
use accounts_core::test_support::{Req, Resp, TestContext};
use serde_json::{Value, json};

use crate::common::*;

const DEVICE_GRANT: &str = "urn:ietf:params:oauth:grant-type:device_code";

async fn authorize(ctx: &TestContext, body: Value) -> Resp {
    ctx.call(router(), Req::post("/v1/device/authorize").json(body))
        .await
}

async fn poll(ctx: &TestContext, device_code: &str) -> Resp {
    ctx.call(
        router(),
        public_token_req(&[("grant_type", DEVICE_GRANT), ("device_code", device_code)]),
    )
    .await
}

async fn decide(ctx: &TestContext, user_code: &str, account_uuid: &str, approve: bool) {
    let mut conn = ctx.conn().await;
    tokens::decide_device(&mut conn, user_code, account_uuid, approve)
        .await
        .expect("decide device");
}

/// Lets the next poll through the 5-second interval.
async fn wait_interval(ctx: &TestContext) {
    ctx.exec("update device_authorizations set last_polled_at = now() - interval '10 seconds'")
        .await;
}

fn assert_user_code(code: &str) {
    assert_eq!(code.len(), 9, "{code}");
    assert_eq!(&code[4..5], "-", "{code}");
    for c in code.chars().filter(|c| *c != '-') {
        assert!(
            "ABCDEFGHJKMNPQRSTUVWXYZ23456789".contains(c),
            "{c} is ambiguous or not allowed in {code}"
        );
    }
}

#[tokio::test]
async fn a_device_sign_in_from_start_to_tokens() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let r = authorize(
        &ctx,
        json!({"client_label": "silicon-accounts CLI on test-mac"}),
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(header(&r, "cache-control"), "no-store");
    let device_code = s(&r.json, "device_code").to_string();
    let user_code = s(&r.json, "user_code").to_string();
    assert!(device_code.starts_with("sad_"));
    assert_user_code(&user_code);
    let site = ctx.state.settings.url("/device");
    assert_eq!(r.json["verification_uri"], site.as_str());
    assert_eq!(
        r.json["verification_uri_complete"],
        format!("{site}?code={user_code}")
    );
    assert_eq!(r.json["expires_in"], 600);
    assert_eq!(r.json["interval"], 5);
    assert!(
        r.json["expires_at"]
            .as_str()
            .is_some_and(|t| t.ends_with('Z'))
    );

    // Waiting for the Carbon, then polling too fast.
    let r = poll(&ctx, &device_code).await;
    assert_oauth_error(&r, 400, "authorization_pending", "hasn't approved");
    let r = poll(&ctx, &device_code).await;
    assert_oauth_error(&r, 400, "slow_down", "5 seconds");

    decide(&ctx, &user_code, &carbon.uuid, true).await;
    wait_interval(&ctx).await;
    let r = poll(&ctx, &device_code).await;
    let body = assert_tokens(&r).clone();
    assert_eq!(
        body["membership_id"],
        format!("silicon-accounts:{}", carbon.uuid)
    );
    assert_eq!(body["account"]["uuid"], carbon.uuid.as_str());
    let jwks = ctx
        .call(router(), Req::get("/.well-known/jwks.json"))
        .await
        .json;
    let claims = verify_with_jwks(
        &jwks,
        ctx.state.settings.issuer(),
        "silicon-accounts",
        s(&body, "access_token"),
    );
    assert_eq!(claims["sub"], carbon.uuid.as_str());
    let family: String = scalar(
        &ctx,
        "select origin || '|' || label from token_families where account_uuid = $1",
        &carbon.uuid,
    )
    .await;
    assert_eq!(family, "device|silicon-accounts CLI on test-mac");
    let history: String = scalar(
        &ctx,
        "select method || ':' || outcome || ':' || app_id from signin_history where account_uuid = $1",
        &carbon.uuid,
    )
    .await;
    assert_eq!(history, "device:success:silicon-accounts");

    // A device code gives tokens once.
    wait_interval(&ctx).await;
    let r = poll(&ctx, &device_code).await;
    assert_oauth_error(&r, 400, "invalid_grant", "already exchanged");

    // The CLI keeps itself signed in with the public client.
    let r = ctx
        .call(
            router(),
            public_token_req(&[
                ("grant_type", "refresh_token"),
                ("refresh_token", s(&body, "refresh_token")),
            ]),
        )
        .await;
    assert_tokens(&r);
}

#[tokio::test]
async fn a_denied_device_sign_in() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let r = authorize(&ctx, json!({})).await;
    let device_code = s(&r.json, "device_code").to_string();
    decide(&ctx, s(&r.json, "user_code"), &carbon.uuid, false).await;
    let r = poll(&ctx, &device_code).await;
    assert_oauth_error(&r, 400, "access_denied", "denied");
}

#[tokio::test]
async fn an_expired_device_code() {
    let ctx = TestContext::new().await;
    let r = authorize(&ctx, json!({})).await;
    let device_code = s(&r.json, "device_code").to_string();
    let ttl: f64 = scalar(
        &ctx,
        "select extract(epoch from expires_at - created_at)::float8 from device_authorizations where user_code = $1",
        s(&r.json, "user_code"),
    )
    .await;
    assert!((ttl - 600.0).abs() < 1.0, "{ttl}");
    ctx.exec("update device_authorizations set expires_at = now() - interval '1 second'")
        .await;
    let r = poll(&ctx, &device_code).await;
    assert_oauth_error(&r, 400, "expired_token", "expired");
}

#[tokio::test]
async fn an_unlabelled_device_sign_in_gets_the_default_label() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    // Empty body, and a form body: both fine.
    let r = ctx.call(router(), Req::post("/v1/device/authorize")).await;
    assert_eq!(r.status, 200, "{}", r.json);
    let r2 = ctx
        .call(
            router(),
            Req::post("/v1/device/authorize")
                .form(&[("client_id", "silicon-accounts"), ("scope", "profile")]),
        )
        .await;
    assert_eq!(r2.status, 200, "{}", r2.json);
    decide(&ctx, s(&r.json, "user_code"), &carbon.uuid, true).await;
    let r = poll(&ctx, s(&r.json, "device_code")).await;
    assert_tokens(&r);
    let label: String = scalar(
        &ctx,
        "select label from token_families where account_uuid = $1",
        &carbon.uuid,
    )
    .await;
    assert_eq!(label, "silicon-accounts CLI");
}

#[tokio::test]
async fn only_the_first_party_client_polls_device_codes() {
    let ctx = TestContext::new().await;
    let (app, secret) = ctx.app("briefcase").await;
    let r = authorize(&ctx, json!({})).await;
    let r = ctx
        .call(
            router(),
            token_req(
                &app.app_id,
                &secret,
                &[
                    ("grant_type", DEVICE_GRANT),
                    ("device_code", s(&r.json, "device_code")),
                ],
            ),
        )
        .await;
    assert_oauth_error(
        &r,
        400,
        "unauthorized_client",
        "only for the first-party client",
    );
}

#[tokio::test]
async fn device_authorization_requests_are_validated() {
    let ctx = TestContext::new().await;
    let (app, secret) = ctx.app("briefcase").await;
    let r = authorize(&ctx, json!({"client_id": app.app_id})).await;
    assert_eq!(r.status, 400);
    assert_eq!(r.error_code(), Some("unauthorized_client"));
    assert!(
        r.json["error"]["hint"]
            .as_str()
            .is_some_and(|h| h.contains("/authorize"))
    );
    let r = ctx
        .call(
            router(),
            Req::post("/v1/device/authorize")
                .basic(&app.app_id, &secret)
                .json(json!({})),
        )
        .await;
    assert_eq!(r.error_code(), Some("unauthorized_client"));
    let r = authorize(&ctx, json!({"scope": "profile files.read"})).await;
    assert_eq!(r.status, 400);
    assert_eq!(r.error_code(), Some("invalid_scope"));
    let r = ctx
        .call(
            router(),
            Req::post("/v1/device/authorize")
                .header("content-type", "application/json")
                .header("x-test", "1"),
        )
        .await;
    assert_eq!(
        r.status, 200,
        "an empty JSON body is no parameters: {}",
        r.json
    );
    let mut broken = Req::post("/v1/device/authorize").header("content-type", "application/json");
    broken.body = b"{\"client_label\": ".to_vec();
    let r = ctx.call(router(), broken).await;
    assert_eq!(r.status, 400);
    assert_eq!(r.error_code(), Some("invalid_request"));
    // Labels are cleaned before anyone sees them.
    let carbon = ctx.carbon().await;
    let r = authorize(&ctx, json!({"client_label": "  my\u{0007}\n laptop  "})).await;
    decide(&ctx, s(&r.json, "user_code"), &carbon.uuid, true).await;
    assert_tokens(&poll(&ctx, s(&r.json, "device_code")).await);
    let label: String = scalar(
        &ctx,
        "select label from token_families where account_uuid = $1",
        &carbon.uuid,
    )
    .await;
    assert_eq!(label, "my laptop");
}

#[tokio::test]
async fn device_authorization_is_rate_limited_per_ip() {
    let ctx = TestContext::new().await;
    // Requests in tests have no socket address, so they share the "unknown" bucket.
    ctx.exec(
        "insert into rate_limits (bucket, window_started_at, count) values ('device_authorize:ip:unknown', now(), 60)",
    )
    .await;
    let r = authorize(&ctx, json!({})).await;
    assert_eq!(r.status, 429, "{}", r.json);
    assert_eq!(r.error_code(), Some("rate_limited"));
    assert!(
        header(&r, "retry-after")
            .parse::<u64>()
            .is_ok_and(|s| s > 0)
    );
    assert!(s(&r.json["error"], "message").contains("60 per 10 minutes"));
}

#[tokio::test]
async fn missing_unknown_and_wrong_kinds_of_device_codes() {
    let ctx = TestContext::new().await;
    let r = ctx
        .call(router(), public_token_req(&[("grant_type", DEVICE_GRANT)]))
        .await;
    assert_oauth_error(&r, 400, "invalid_request", "device_code is required");
    let r = poll(&ctx, "sad_unknown").await;
    assert_oauth_error(&r, 400, "invalid_grant", "not known");
    let r = poll(&ctx, "sar_not-a-device-code").await;
    assert_oauth_error(&r, 400, "invalid_grant", "a refresh token");
    // The bare alias of the grant type works too.
    let r = ctx
        .call(
            router(),
            public_token_req(&[
                ("grant_type", "device_code"),
                ("device_code", "sad_unknown"),
            ]),
        )
        .await;
    assert_oauth_error(&r, 400, "invalid_grant", "not known");
}

#[tokio::test]
async fn the_device_routes_merge_with_the_approval_routes() {
    // The auth crate serves /v1/device/{user_code}(/approve|/deny) next to this crate's
    // POST /v1/device/authorize; the server merges both routers.
    let ctx = TestContext::new().await;
    let merged = router().merge(
        axum::Router::new()
            .route(
                "/v1/device/{user_code}",
                axum::routing::get(|| async { "approval page" }),
            )
            .route(
                "/v1/device/{user_code}/approve",
                axum::routing::post(|| async { "approved" }),
            ),
    );
    let r = ctx
        .call(
            merged.clone(),
            Req::post("/v1/device/authorize").json(json!({})),
        )
        .await;
    assert_eq!(r.status, 200, "{}", r.json);
    let r = ctx
        .call(merged.clone(), Req::get("/v1/device/WDJB-MJHT"))
        .await;
    assert_eq!(r.body, b"approval page");
    let r = ctx
        .call(merged.clone(), Req::post("/v1/device/WDJB-MJHT/approve"))
        .await;
    assert_eq!(r.body, b"approved");
    let r = ctx.call(merged, Req::get("/v1/device/authorize")).await;
    assert_eq!(r.status, 405, "authorize is POST only");
}
