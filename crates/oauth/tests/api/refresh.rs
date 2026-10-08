//! `grant_type=refresh_token`.

use accounts_core::models::Scope;
use accounts_core::test_support::{Req, TestContext, call};

use crate::common::*;

#[tokio::test]
async fn refresh_rotates_and_keeps_the_absolute_expiry() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let (app, secret) = ctx.app("briefcase").await;
    let first = sign_in(
        &ctx,
        &app.app_id,
        &secret,
        &carbon,
        &[Scope::Profile, Scope::Email],
    )
    .await;
    let r = refresh(&ctx, &app.app_id, &secret, s(&first, "refresh_token")).await;
    let second = assert_tokens(&r).clone();
    assert_ne!(second["refresh_token"], first["refresh_token"]);
    assert_ne!(second["access_token"], first["access_token"]);
    assert_eq!(second["scope"], "profile email");
    assert_eq!(second["membership_id"], first["membership_id"]);
    assert_eq!(
        second["refresh_token_expires_at"], first["refresh_token_expires_at"],
        "900 days from the sign-in, never extended"
    );
    assert!(second.get("id_token").is_none(), "no openid scope");
    let r = refresh(&ctx, &app.app_id, &secret, s(&second, "refresh_token")).await;
    assert_tokens(&r);
}

#[tokio::test]
async fn reusing_a_refresh_token_revokes_the_family_and_tells_the_app() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let (app, secret) = ctx.app("briefcase").await;
    ctx.set_app_webhook(&app.app_id, "http://127.0.0.1:8593/briefcase/webhooks")
        .await;
    let first = sign_in(&ctx, &app.app_id, &secret, &carbon, &[Scope::Profile]).await;
    let second =
        assert_tokens(&refresh(&ctx, &app.app_id, &secret, s(&first, "refresh_token")).await)
            .clone();

    let r = refresh(&ctx, &app.app_id, &secret, s(&first, "refresh_token")).await;
    assert_oauth_error(&r, 400, "invalid_grant", "already used");
    // The whole family is gone: the newest refresh token and access token too.
    let r = refresh(&ctx, &app.app_id, &secret, s(&second, "refresh_token")).await;
    assert_oauth_error(&r, 400, "invalid_grant", "refresh_token_reuse");
    let r = ctx
        .call(
            router(),
            Req::get("/v1/userinfo").bearer(s(&second, "access_token")),
        )
        .await;
    assert_eq!(r.error_code(), Some("token_revoked"));

    let events = app_events(&ctx, &app.app_id, "membership.signed_out").await;
    assert_eq!(events.len(), 1, "{events:?}");
    assert_eq!(events[0]["reason"], "refresh_token_reuse");
    assert_eq!(
        events[0]["membership_id"],
        format!("{}:{}", app.app_id, carbon.uuid)
    );
    let audits: i64 = scalar(
        &ctx,
        "select count(*) from audit_log where account_uuid = $1 and action = 'oauth.refresh_reuse_detected'",
        &carbon.uuid,
    )
    .await;
    assert_eq!(audits, 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_refreshes_of_one_token_rotate_once() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let (app, secret) = ctx.app("briefcase").await;
    let first = sign_in(&ctx, &app.app_id, &secret, &carbon, &[Scope::Profile]).await;
    let token = s(&first, "refresh_token").to_string();
    let mut tasks = Vec::new();
    for _ in 0..4 {
        let router = router().with_state(ctx.state.clone());
        let req = token_req(
            &app.app_id,
            &secret,
            &[("grant_type", "refresh_token"), ("refresh_token", &token)],
        );
        tasks.push(tokio::spawn(async move { call(router, req).await }));
    }
    let mut results = Vec::new();
    for t in tasks {
        results.push(t.await.expect("task"));
    }
    assert_eq!(
        results.iter().filter(|r| r.status == 200).count(),
        1,
        "exactly one rotation: {:?}",
        results.iter().map(|r| r.json.clone()).collect::<Vec<_>>()
    );
    for r in results.iter().filter(|r| r.status != 200) {
        assert_eq!(r.json["error"], "invalid_grant", "{}", r.json);
    }
    // The losers presented a token that had just been used: reuse detection ended the sign-in.
    let reason: Option<String> = scalar(
        &ctx,
        "select revoke_reason from token_families where account_uuid = $1",
        &carbon.uuid,
    )
    .await;
    assert_eq!(reason.as_deref(), Some("refresh_token_reuse"));
}

#[tokio::test]
async fn refresh_tokens_expire_900_days_after_the_sign_in() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let (app, secret) = ctx.app("briefcase").await;
    let first = sign_in(&ctx, &app.app_id, &secret, &carbon, &[Scope::Profile]).await;
    ctx.exec("update token_families set expires_at = now() - interval '1 second'")
        .await;
    let r = refresh(&ctx, &app.app_id, &secret, s(&first, "refresh_token")).await;
    assert_oauth_error(&r, 400, "invalid_grant", "expired");
    assert!(s(&r.json, "error_description").contains("900 days"));
}

#[tokio::test]
async fn the_account_must_still_be_active() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let (app, secret) = ctx.app("briefcase").await;
    let first = sign_in(&ctx, &app.app_id, &secret, &carbon, &[Scope::Profile]).await;
    ctx.exec(&format!(
        "update accounts set status = 'deleted', handle = null, deleted_at = now() where uuid = '{}'",
        carbon.uuid
    ))
    .await;
    let r = refresh(&ctx, &app.app_id, &secret, s(&first, "refresh_token")).await;
    assert_oauth_error(&r, 400, "invalid_grant", "deleted");
}

#[tokio::test]
async fn the_membership_must_still_be_active() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let (app, secret) = ctx.app("briefcase").await;
    let first = sign_in(&ctx, &app.app_id, &secret, &carbon, &[Scope::Profile]).await;
    // Access removed without the families being revoked (defence in depth).
    ctx.exec(
        "update memberships set status = 'access_removed', access_removed_at = now(), updated_at = now()",
    )
    .await;
    let r = refresh(&ctx, &app.app_id, &secret, s(&first, "refresh_token")).await;
    assert_oauth_error(&r, 400, "invalid_grant", "removed the access");
    let reason: Option<String> = scalar(
        &ctx,
        "select revoke_reason from token_families where account_uuid = $1",
        &carbon.uuid,
    )
    .await;
    assert_eq!(
        reason.as_deref(),
        Some("access_removed"),
        "the sign-in ended"
    );

    // No membership at all.
    let other = ctx.carbon().await;
    let tokens = sign_in(&ctx, &app.app_id, &secret, &other, &[Scope::Profile]).await;
    ctx.exec(&format!(
        "delete from memberships where account_uuid = '{}'",
        other.uuid
    ))
    .await;
    let r = refresh(&ctx, &app.app_id, &secret, s(&tokens, "refresh_token")).await;
    assert_oauth_error(&r, 400, "invalid_grant", "no active membership");
}

#[tokio::test]
async fn an_app_can_only_refresh_its_own_tokens() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let (app, secret) = ctx.app("briefcase").await;
    let (other, other_secret) = ctx.app("dm").await;
    let first = sign_in(&ctx, &app.app_id, &secret, &carbon, &[Scope::Profile]).await;
    let r = refresh(
        &ctx,
        &other.app_id,
        &other_secret,
        s(&first, "refresh_token"),
    )
    .await;
    assert_oauth_error(&r, 400, "invalid_grant", "different app");
    // Nothing happened to it.
    assert_tokens(&refresh(&ctx, &app.app_id, &secret, s(&first, "refresh_token")).await);
}

#[tokio::test]
async fn the_public_client_refreshes_first_party_tokens_only() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let first_party = ctx.first_party_tokens(&carbon).await;
    let r = ctx
        .call(
            router(),
            public_token_req(&[
                ("grant_type", "refresh_token"),
                ("refresh_token", &first_party.refresh_token),
            ]),
        )
        .await;
    let rotated = assert_tokens(&r).clone();
    assert_eq!(
        rotated["membership_id"],
        format!("silicon-accounts:{}", carbon.uuid)
    );
    let jwks = ctx
        .call(router(), Req::get("/.well-known/jwks.json"))
        .await
        .json;
    let claims = verify_with_jwks(
        &jwks,
        ctx.state.settings.issuer(),
        "silicon-accounts",
        s(&rotated, "access_token"),
    );
    assert_eq!(claims["sub"], carbon.uuid.as_str());

    // An app's refresh token can't be rotated without that app's secret.
    let (app, secret) = ctx.app("briefcase").await;
    let app_tokens = sign_in(&ctx, &app.app_id, &secret, &carbon, &[Scope::Profile]).await;
    let r = ctx
        .call(
            router(),
            public_token_req(&[
                ("grant_type", "refresh_token"),
                ("refresh_token", s(&app_tokens, "refresh_token")),
            ]),
        )
        .await;
    assert_oauth_error(&r, 400, "invalid_grant", "different app");
    // And an app can't rotate first-party tokens.
    let r = refresh(&ctx, &app.app_id, &secret, s(&rotated, "refresh_token")).await;
    assert_oauth_error(&r, 400, "invalid_grant", "different app");
}

#[tokio::test]
async fn a_refresh_may_narrow_but_never_widen_the_scope() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let (app, secret) = ctx.app("briefcase").await;
    let first = sign_in(
        &ctx,
        &app.app_id,
        &secret,
        &carbon,
        &[Scope::Profile, Scope::Email],
    )
    .await;
    let r = ctx
        .call(
            router(),
            token_req(
                &app.app_id,
                &secret,
                &[
                    ("grant_type", "refresh_token"),
                    ("refresh_token", s(&first, "refresh_token")),
                    ("scope", "profile phone"),
                ],
            ),
        )
        .await;
    assert_oauth_error(&r, 400, "invalid_scope", "can't add scopes: 'phone'");
    let r = ctx
        .call(
            router(),
            token_req(
                &app.app_id,
                &secret,
                &[
                    ("grant_type", "refresh_token"),
                    ("refresh_token", s(&first, "refresh_token")),
                    ("scope", "files.read"),
                ],
            ),
        )
        .await;
    assert_oauth_error(&r, 400, "invalid_scope", "'files.read'");
    // Refused requests didn't use the token up.
    let r = ctx
        .call(
            router(),
            token_req(
                &app.app_id,
                &secret,
                &[
                    ("grant_type", "refresh_token"),
                    ("refresh_token", s(&first, "refresh_token")),
                    ("scope", "profile offline_access"),
                ],
            ),
        )
        .await;
    assert_eq!(assert_tokens(&r)["scope"], "profile email");
}

#[tokio::test]
async fn missing_or_wrong_kinds_of_refresh_tokens() {
    let ctx = TestContext::new().await;
    let (app, secret) = ctx.app("briefcase").await;
    let r = ctx
        .call(
            router(),
            token_req(&app.app_id, &secret, &[("grant_type", "refresh_token")]),
        )
        .await;
    assert_oauth_error(&r, 400, "invalid_request", "refresh_token is required");
    let r = refresh(&ctx, &app.app_id, &secret, "sac_abc").await;
    assert_oauth_error(&r, 400, "invalid_grant", "an authorization code");
    let r = refresh(&ctx, &app.app_id, &secret, "sar_unknown").await;
    assert_oauth_error(&r, 400, "invalid_grant", "not known");
}

#[tokio::test]
async fn previous_cli_client_id_refreshes_to_the_canonical_identity() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let token = ctx
        .tokens_for(&carbon, "silicon-accounts", &[Scope::Profile])
        .await;
    let r = ctx
        .call(
            router(),
            Req::post("/v1/oauth/token").form(&[
                ("grant_type", "refresh_token"),
                ("client_id", "accounts"),
                ("refresh_token", &token.refresh_token),
            ]),
        )
        .await;
    let result = assert_tokens(&r);
    assert_eq!(
        result["membership_id"],
        format!("silicon-accounts:{}", carbon.uuid)
    );
    let claims = ctx
        .state
        .keys
        .jwt
        .verify_access(s(result, "access_token"), Some("silicon-accounts"))
        .unwrap();
    assert_eq!(claims.aud, "silicon-accounts");
    let revoked = ctx
        .call(
            router(),
            Req::post("/v1/oauth/revoke").form(&[
                ("client_id", "accounts"),
                ("token", s(result, "refresh_token")),
            ]),
        )
        .await;
    assert_eq!(revoked.json["revoked"], true);
}
