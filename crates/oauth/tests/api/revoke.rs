//! POST /v1/oauth/revoke (RFC 7009).

use accounts_core::jwt::AccessTokenInput;
use accounts_core::models::{AccountKind, Scope};
use accounts_core::test_support::{Req, Resp, TestContext};
use serde_json::json;
use uuid::Uuid;

use crate::common::*;

async fn revoke(ctx: &TestContext, app_id: &str, secret: &str, token: &str) -> Resp {
    ctx.call(
        router(),
        Req::post("/v1/oauth/revoke")
            .basic(app_id, secret)
            .form(&[("token", token)]),
    )
    .await
}

async fn revoke_public(ctx: &TestContext, token: &str, hint: &str) -> Resp {
    ctx.call(
        router(),
        Req::post("/v1/oauth/revoke").form(&[
            ("token", token),
            ("token_type_hint", hint),
            ("client_id", "silicon-accounts"),
        ]),
    )
    .await
}

#[track_caller]
fn assert_revoked(r: &Resp, revoked: bool) {
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(header(r, "cache-control"), "no-store");
    assert_eq!(r.json["revoked"], revoked, "{}", r.json);
    if !revoked {
        assert!(
            s(&r.json, "message").contains("Nothing was revoked"),
            "{}",
            r.json
        );
    }
}

#[tokio::test]
async fn revoking_a_refresh_token_ends_the_sign_in_and_tells_the_app() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let (app, secret) = ctx.app("briefcase").await;
    ctx.set_app_webhook(&app.app_id, "http://127.0.0.1:8593/briefcase/webhooks")
        .await;
    let tokens = sign_in(&ctx, &app.app_id, &secret, &carbon, &[Scope::Profile]).await;
    let r = revoke(&ctx, &app.app_id, &secret, s(&tokens, "refresh_token")).await;
    assert_revoked(&r, true);

    let r = refresh(&ctx, &app.app_id, &secret, s(&tokens, "refresh_token")).await;
    assert_oauth_error(&r, 400, "invalid_grant", "app_revoked");
    let r = ctx
        .call(
            router(),
            Req::get("/v1/userinfo").bearer(s(&tokens, "access_token")),
        )
        .await;
    assert_eq!(r.error_code(), Some("token_revoked"));

    let events = app_events(&ctx, &app.app_id, "membership.signed_out").await;
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["reason"], "app_revoked");
    assert_eq!(events[0]["uuid"], carbon.uuid.as_str());
    let action: String = scalar(
        &ctx,
        "select action || ':' || actor_kind || ':' || actor_id from audit_log where account_uuid = $1 and action = 'oauth.token_revoked'",
        &carbon.uuid,
    )
    .await;
    assert_eq!(action, format!("oauth.token_revoked:app:{}", app.app_id));

    // Revoking again is fine and notifies nobody twice.
    assert_revoked(
        &revoke(&ctx, &app.app_id, &secret, s(&tokens, "refresh_token")).await,
        true,
    );
    assert_eq!(
        app_events(&ctx, &app.app_id, "membership.signed_out")
            .await
            .len(),
        1
    );
}

#[tokio::test]
async fn an_access_token_revokes_its_sign_in_even_after_it_expired() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let (app, secret) = ctx.app("briefcase").await;

    let live = sign_in(&ctx, &app.app_id, &secret, &carbon, &[Scope::Profile]).await;
    assert_revoked(
        &revoke(&ctx, &app.app_id, &secret, s(&live, "access_token")).await,
        true,
    );
    let r = refresh(&ctx, &app.app_id, &secret, s(&live, "refresh_token")).await;
    assert_oauth_error(&r, 400, "invalid_grant", "revoked");

    let later = sign_in(&ctx, &app.app_id, &secret, &carbon, &[Scope::Profile]).await;
    let family: Uuid = {
        let mut conn = ctx.conn().await;
        sqlx::query_scalar(
            "select id from token_families where account_uuid = $1 and revoked_at is null",
        )
        .bind(&carbon.uuid)
        .fetch_one(&mut *conn)
        .await
        .expect("live family")
    };
    let (expired, _) = ctx
        .state
        .keys
        .jwt
        .sign_access(&AccessTokenInput {
            account_uuid: &carbon.uuid,
            app_id: &app.app_id,
            kind: AccountKind::Carbon,
            id: carbon.handle.as_deref().expect("handle"),
            family_id: family,
            scope: "profile",
            ttl_seconds: -600,
        })
        .expect("sign");
    assert_revoked(&revoke(&ctx, &app.app_id, &secret, &expired).await, true);
    let r = refresh(&ctx, &app.app_id, &secret, s(&later, "refresh_token")).await;
    assert_oauth_error(&r, 400, "invalid_grant", "revoked");
}

#[tokio::test]
async fn unknown_and_other_apps_tokens_answer_200_and_revoke_nothing() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let (app, secret) = ctx.app("briefcase").await;
    let (other, other_secret) = ctx.app("dm").await;
    let tokens = sign_in(&ctx, &app.app_id, &secret, &carbon, &[Scope::Profile]).await;

    let foreign_refresh = revoke(
        &ctx,
        &other.app_id,
        &other_secret,
        s(&tokens, "refresh_token"),
    )
    .await;
    assert_revoked(&foreign_refresh, false);
    let foreign_access = revoke(
        &ctx,
        &other.app_id,
        &other_secret,
        s(&tokens, "access_token"),
    )
    .await;
    assert_revoked(&foreign_access, false);
    let unknown = revoke(&ctx, &other.app_id, &other_secret, "sar_never-issued").await;
    assert_revoked(&unknown, false);
    // Another app's token and an unknown one can't be told apart.
    assert_eq!(foreign_refresh.json, unknown.json);
    assert_revoked(
        &revoke(&ctx, &other.app_id, &other_secret, "hello").await,
        false,
    );
    assert_revoked(
        &revoke(
            &ctx,
            &other.app_id,
            &other_secret,
            "eyJhbGciOiJub25lIn0.e30.",
        )
        .await,
        false,
    );
    // The sign-in is untouched.
    assert_tokens(&refresh(&ctx, &app.app_id, &secret, s(&tokens, "refresh_token")).await);
}

#[tokio::test]
async fn the_public_client_signs_the_cli_out_and_touches_nothing_else() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let first_party = ctx.first_party_tokens(&carbon).await;
    let (app, secret) = ctx.app("briefcase").await;
    ctx.set_app_webhook(&app.app_id, "http://127.0.0.1:8593/briefcase/webhooks")
        .await;
    let app_tokens = sign_in(&ctx, &app.app_id, &secret, &carbon, &[Scope::Profile]).await;

    // An app's token can't be revoked without that app's secret.
    assert_revoked(
        &revoke_public(&ctx, s(&app_tokens, "refresh_token"), "refresh_token").await,
        false,
    );
    assert_tokens(&refresh(&ctx, &app.app_id, &secret, s(&app_tokens, "refresh_token")).await);

    assert_revoked(
        &revoke_public(&ctx, &first_party.refresh_token, "refresh_token").await,
        true,
    );
    let r = ctx
        .call(
            router(),
            public_token_req(&[
                ("grant_type", "refresh_token"),
                ("refresh_token", &first_party.refresh_token),
            ]),
        )
        .await;
    assert_oauth_error(&r, 400, "invalid_grant", "user_signed_out");
    let actor: String = scalar(
        &ctx,
        "select actor_kind || ':' || actor_id from audit_log where account_uuid = $1 and action = 'oauth.token_revoked'",
        &carbon.uuid,
    )
    .await;
    assert_eq!(actor, format!("account:{}", carbon.uuid));
    // First-party sign-outs send no app webhook.
    let events: i64 = scalar(
        &ctx,
        "select count(*) from webhook_events where account_uuid = $1",
        &carbon.uuid,
    )
    .await;
    assert_eq!(events, 0);
}

#[tokio::test]
async fn a_misleading_token_type_hint_is_ignored() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let first_party = ctx.first_party_tokens(&carbon).await;
    assert_revoked(
        &revoke_public(&ctx, &first_party.access_token, "refresh_token").await,
        true,
    );
    let r = ctx
        .call(
            router(),
            Req::get("/v1/userinfo").bearer(&first_party.access_token),
        )
        .await;
    assert_eq!(r.error_code(), Some("token_revoked"));
}

#[tokio::test]
async fn revocation_needs_client_authentication_and_a_token() {
    let ctx = TestContext::new().await;
    let (app, secret) = ctx.app("briefcase").await;
    let r = ctx
        .call(
            router(),
            Req::post("/v1/oauth/revoke").form(&[("token", "sar_x")]),
        )
        .await;
    assert_oauth_error(&r, 401, "invalid_client", "not authenticated");
    let r = ctx
        .call(
            router(),
            Req::post("/v1/oauth/revoke")
                .basic(&app.app_id, "sa_app_wrong")
                .form(&[("token", "sar_x")]),
        )
        .await;
    assert_oauth_error(&r, 401, "invalid_client", "wrong");
    let r = ctx
        .call(
            router(),
            Req::post("/v1/oauth/revoke")
                .basic(&app.app_id, &secret)
                .form(&[("token_type_hint", "refresh_token")]),
        )
        .await;
    assert_oauth_error(&r, 400, "invalid_request", "token is required");
    // JSON bodies work like forms.
    let r = ctx
        .call(
            router(),
            Req::post("/v1/oauth/revoke")
                .basic(&app.app_id, &secret)
                .json(json!({"token": "sar_unknown"})),
        )
        .await;
    assert_revoked(&r, false);
}

#[tokio::test]
async fn proofs_and_other_secrets_answer_200_with_where_to_end_them() {
    let ctx = TestContext::new().await;
    let (app, secret) = ctx.app("briefcase").await;
    for (token, what, mentions) in [
        ("sap_a-proof-token", "a proof token", "/v1/proofs/revoke"),
        (
            "sapr_a-proof-refresh-token",
            "a proof refresh token",
            "/v1/proofs/revoke",
        ),
        ("stk-0123456789ab", "an STK", "/v1/me/silicons/{uuid}/stk"),
        ("sa_app_some-secret", "an app secret", "Silicon Apps"),
        (
            "sas_a-browser-session",
            "browser session",
            "/v1/session/signout",
        ),
        ("slt_a-short-lived-token", "short-lived token", "single-use"),
    ] {
        // RFC 7009 and the API contract: always 200; the body says nothing was revoked, what
        // the credential is, and where it is ended instead.
        let r = revoke(&ctx, &app.app_id, &secret, token).await;
        assert_revoked(&r, false);
        let message = s(&r.json, "message");
        assert!(message.contains(what), "{token}: {message}");
        assert!(message.contains(mentions), "{token}: {message}");
    }
}
