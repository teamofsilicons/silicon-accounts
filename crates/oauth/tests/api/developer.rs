//! The developer platform's first-party public client (`client_id=developer`, no secret):
//! authorization code with PKCE S256 (required), refresh and revocation of its own tokens,
//! nothing else.

use accounts_core::test_support::{Req, Resp, TestContext};

use crate::common::*;

const DEVELOPER: &str = "developer";

/// `POST /v1/oauth/token` as the developer platform (no secret).
fn developer_token_req(form: &[(&str, &str)]) -> Req {
    let mut pairs = form.to_vec();
    pairs.push(("client_id", DEVELOPER));
    Req::post("/v1/oauth/token").form(&pairs)
}

async fn redeem(ctx: &TestContext, code: &str, verifier: Option<&str>) -> Resp {
    let redirect = redirect_for(DEVELOPER);
    let mut form = vec![
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", redirect.as_str()),
    ];
    if let Some(v) = verifier {
        form.push(("code_verifier", v));
    }
    ctx.call(router(), developer_token_req(&form)).await
}

/// A finished developer platform sign-in: no membership (it is Silicon Accounts' own app).
async fn developer_code(
    ctx: &TestContext,
    account: &accounts_core::models::Account,
    pkce: Option<(&str, &str)>,
) -> String {
    signed_in_code(
        ctx,
        DEVELOPER,
        account,
        Authorize {
            pkce,
            no_membership: true,
            ..Default::default()
        },
    )
    .await
}

#[tokio::test]
async fn the_developer_platform_signs_in_with_pkce_and_no_secret() {
    assert!(pkce_constants_agree());
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let code = developer_code(&ctx, &carbon, Some((CHALLENGE, "S256"))).await;
    let r = redeem(&ctx, &code, Some(VERIFIER)).await;
    let body = assert_tokens(&r).clone();
    let access = s(&body, "access_token").to_string();
    let claims = ctx
        .state
        .keys
        .jwt
        .verify_access(&access, Some(DEVELOPER))
        .expect("an access token for the developer platform");
    assert_eq!(claims.aud, DEVELOPER);
    assert_eq!(claims.sub, carbon.uuid);
    assert_eq!(body["account"]["uuid"], carbon.uuid.as_str());
    let memberships: i64 = scalar(
        &ctx,
        "select count(*) from memberships where account_uuid = $1",
        &carbon.uuid,
    )
    .await;
    assert_eq!(memberships, 0, "the developer platform has no user base");

    // It refreshes its own tokens without a secret…
    let refresh_token = s(&body, "refresh_token").to_string();
    let r = ctx
        .call(
            router(),
            developer_token_req(&[
                ("grant_type", "refresh_token"),
                ("refresh_token", &refresh_token),
            ]),
        )
        .await;
    let rotated = assert_tokens(&r).clone();
    let next = s(&rotated, "refresh_token").to_string();
    assert_ne!(next, refresh_token);

    // …the accounts CLI's public client can't refresh them (nor the other way round)…
    let r = ctx
        .call(
            router(),
            public_token_req(&[("grant_type", "refresh_token"), ("refresh_token", &next)]),
        )
        .await;
    assert_oauth_error(&r, 400, "invalid_grant", "different app");
    let cli = ctx.first_party_tokens(&carbon).await;
    let r = ctx
        .call(
            router(),
            developer_token_req(&[
                ("grant_type", "refresh_token"),
                ("refresh_token", &cli.refresh_token),
            ]),
        )
        .await;
    assert_oauth_error(&r, 400, "invalid_grant", "different app");

    // …and signs out by revoking them.
    let r = ctx
        .call(
            router(),
            Req::post("/v1/oauth/revoke")
                .form(&[("token", next.as_str()), ("client_id", DEVELOPER)]),
        )
        .await;
    assert_eq!(r.status.as_u16(), 200, "{}", r.json);
    assert_eq!(r.json["revoked"], true);
    let reason: Option<String> = scalar(
        &ctx,
        "select revoke_reason from token_families where account_uuid = $1 and app_id = 'developer'",
        &carbon.uuid,
    )
    .await;
    assert_eq!(reason.as_deref(), Some("user_signed_out"));
    let r = ctx
        .call(
            router(),
            developer_token_req(&[("grant_type", "refresh_token"), ("refresh_token", &next)]),
        )
        .await;
    assert_oauth_error(&r, 400, "invalid_grant", "revoked");
    // A CLI sign-in is untouched, and the developer client can't revoke it.
    let r = ctx
        .call(
            router(),
            Req::post("/v1/oauth/revoke").form(&[
                ("token", cli.refresh_token.as_str()),
                ("client_id", DEVELOPER),
            ]),
        )
        .await;
    assert_eq!(r.json["revoked"], false, "{}", r.json);
    assert_eq!(live_families(&ctx, &carbon.uuid).await, 1);
}

#[tokio::test]
async fn the_developer_platform_must_use_pkce_s256() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;

    let code = developer_code(&ctx, &carbon, None).await;
    let r = redeem(&ctx, &code, None).await;
    assert_oauth_error(&r, 400, "invalid_grant", "public client");
    assert!(s(&r.json, "error_description").contains("sent no code_challenge"));
    // The refused code is used up.
    let r = redeem(&ctx, &code, None).await;
    assert_oauth_error(&r, 400, "invalid_grant", "already used");

    let plain = developer_code(&ctx, &carbon, Some((VERIFIER, "plain"))).await;
    let r = redeem(&ctx, &plain, Some(VERIFIER)).await;
    assert_oauth_error(&r, 400, "invalid_grant", "code_challenge_method=plain");

    let code = developer_code(&ctx, &carbon, Some((CHALLENGE, "S256"))).await;
    let r = redeem(&ctx, &code, None).await;
    assert_oauth_error(&r, 400, "invalid_grant", "code_verifier is required");

    let code = developer_code(&ctx, &carbon, Some((CHALLENGE, "S256"))).await;
    let r = redeem(
        &ctx,
        &code,
        Some("wrong-verifier-wrong-verifier-wrong-verifier-1"),
    )
    .await;
    assert_oauth_error(&r, 400, "invalid_grant", "PKCE verification failed");
    assert_eq!(live_families(&ctx, &carbon.uuid).await, 0);
}

#[tokio::test]
async fn the_developer_client_only_has_its_own_grants() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let (app, secret) = ctx.app("briefcase").await;

    // Another app's code is never redeemed by the developer platform (and is burnt).
    let code = signed_in_code(
        &ctx,
        &app.app_id,
        &carbon,
        Authorize {
            pkce: Some((CHALLENGE, "S256")),
            ..Default::default()
        },
    )
    .await;
    let redirect = redirect_for(&app.app_id);
    let r = ctx
        .call(
            router(),
            developer_token_req(&[
                ("grant_type", "authorization_code"),
                ("code", &code),
                ("redirect_uri", &redirect),
                ("code_verifier", VERIFIER),
            ]),
        )
        .await;
    assert_oauth_error(&r, 400, "invalid_grant", "different app");
    let r = exchange(&ctx, &app.app_id, &secret, &code, Some(VERIFIER)).await;
    assert_oauth_error(&r, 400, "invalid_grant", "already used");

    // No short-lived tokens or device codes.
    let r = ctx
        .call(
            router(),
            developer_token_req(&[("grant_type", "slt"), ("slt", "slt_whatever")]),
        )
        .await;
    assert_oauth_error(&r, 400, "unauthorized_client", "public client");
    assert!(s(&r.json, "error_description").contains("PKCE S256"));
    let r = ctx
        .call(
            router(),
            developer_token_req(&[
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
                ("device_code", "sad_whatever"),
            ]),
        )
        .await;
    assert_oauth_error(
        &r,
        400,
        "unauthorized_client",
        "only for the first-party client 'accounts'",
    );

    // A secret never makes it a confidential client; introspection needs one.
    let r = ctx
        .call(
            router(),
            Req::post("/v1/oauth/token").form(&[
                ("grant_type", "refresh_token"),
                ("refresh_token", "sar_x"),
                ("client_id", DEVELOPER),
                ("client_secret", "sa_app_guess"),
            ]),
        )
        .await;
    assert_eq!(r.status.as_u16(), 401, "{}", r.json);
    assert_eq!(r.json["error"], "invalid_client");
    let r = ctx
        .call(
            router(),
            Req::post("/v1/oauth/introspect").form(&[("token", "sar_x"), ("client_id", DEVELOPER)]),
        )
        .await;
    assert_eq!(r.status.as_u16(), 401, "{}", r.json);
    assert_eq!(r.json["error"], "invalid_client");
    assert!(
        r.json["error_description"]
            .as_str()
            .is_some_and(|d| d.contains("client_id=developer")),
        "{}",
        r.json
    );
}
