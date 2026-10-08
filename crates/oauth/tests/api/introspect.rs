//! POST /v1/oauth/introspect (RFC 7662).

use accounts_core::jwt::AccessTokenInput;
use accounts_core::models::{AccountKind, Scope};
use accounts_core::test_support::{Req, Resp, TestContext};
use serde_json::json;
use uuid::Uuid;

use crate::common::*;

async fn introspect(ctx: &TestContext, app_id: &str, secret: &str, token: &str) -> Resp {
    ctx.call(
        router(),
        Req::post("/v1/oauth/introspect")
            .basic(app_id, secret)
            .form(&[("token", token)]),
    )
    .await
}

#[track_caller]
fn assert_inactive(r: &Resp) {
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(
        r.json,
        json!({"active": false}),
        "nothing else is disclosed"
    );
}

#[tokio::test]
async fn an_active_access_token() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let (app, secret) = ctx.app("briefcase").await;
    let tokens = sign_in(
        &ctx,
        &app.app_id,
        &secret,
        &carbon,
        &[Scope::Profile, Scope::Email],
    )
    .await;
    let r = introspect(&ctx, &app.app_id, &secret, s(&tokens, "access_token")).await;
    assert_eq!(r.status, 200);
    assert_eq!(header(&r, "cache-control"), "no-store");
    let j = &r.json;
    assert_eq!(j["active"], true);
    assert_eq!(j["token_type"], "access_token");
    assert_eq!(j["sub"], carbon.uuid.as_str());
    assert_eq!(j["aud"], app.app_id.as_str());
    assert_eq!(j["client_id"], app.app_id.as_str());
    assert_eq!(j["iss"], ctx.state.settings.issuer());
    assert_eq!(j["scope"], "profile email");
    assert_eq!(j["kind"], "carbon");
    let handle = carbon.handle.as_deref().expect("handle");
    assert_eq!(j["id"], handle);
    assert_eq!(j["username"], handle);
    assert_eq!(
        j["membership_id"],
        format!("{}:{}", app.app_id, carbon.uuid)
    );
    let (exp, iat) = (
        j["exp"].as_i64().expect("exp"),
        j["iat"].as_i64().expect("iat"),
    );
    assert_eq!(exp - iat, 1800);
    assert!(j["jti"].is_string() && j["nbf"].is_i64());
}

#[tokio::test]
async fn a_refresh_token_is_active_until_it_is_used() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let (app, secret) = ctx.app("briefcase").await;
    let first = sign_in(&ctx, &app.app_id, &secret, &carbon, &[Scope::Profile]).await;
    let r = introspect(&ctx, &app.app_id, &secret, s(&first, "refresh_token")).await;
    let j = &r.json;
    assert_eq!(j["active"], true, "{j}");
    assert_eq!(j["token_type"], "refresh_token");
    assert_eq!(j["sub"], carbon.uuid.as_str());
    assert_eq!(j["aud"], app.app_id.as_str());
    assert_eq!(j["scope"], "profile");
    assert_eq!(j["kind"], "carbon");
    let expires = time::OffsetDateTime::parse(
        s(&first, "refresh_token_expires_at"),
        &time::format_description::well_known::Rfc3339,
    )
    .expect("RFC 3339");
    assert_eq!(
        j["exp"],
        expires.unix_timestamp(),
        "the family's absolute expiry"
    );
    assert!(j["iat"].as_i64().expect("iat") <= time::OffsetDateTime::now_utc().unix_timestamp());

    let second =
        assert_tokens(&refresh(&ctx, &app.app_id, &secret, s(&first, "refresh_token")).await)
            .clone();
    assert_inactive(&introspect(&ctx, &app.app_id, &secret, s(&first, "refresh_token")).await);
    let r = introspect(&ctx, &app.app_id, &secret, s(&second, "refresh_token")).await;
    assert_eq!(r.json["active"], true);
}

#[tokio::test]
async fn tokens_of_other_apps_are_never_active() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let (app, secret) = ctx.app("briefcase").await;
    let (other, other_secret) = ctx.app("dm").await;
    let tokens = sign_in(&ctx, &app.app_id, &secret, &carbon, &[Scope::Profile]).await;
    assert_inactive(
        &introspect(
            &ctx,
            &other.app_id,
            &other_secret,
            s(&tokens, "access_token"),
        )
        .await,
    );
    assert_inactive(
        &introspect(
            &ctx,
            &other.app_id,
            &other_secret,
            s(&tokens, "refresh_token"),
        )
        .await,
    );
    let first_party = ctx.first_party_tokens(&carbon).await;
    assert_inactive(&introspect(&ctx, &app.app_id, &secret, &first_party.access_token).await);
}

#[tokio::test]
async fn revoked_expired_removed_and_garbage_tokens_are_inactive() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let (app, secret) = ctx.app("briefcase").await;

    // Garbage and other credentials.
    for token in [
        "garbage",
        "sap_proof",
        "sac_code",
        "eyJhbGciOiJub25lIn0.e30.",
    ] {
        assert_inactive(&introspect(&ctx, &app.app_id, &secret, token).await);
    }

    // An access token past its expiry.
    let tokens = sign_in(&ctx, &app.app_id, &secret, &carbon, &[Scope::Profile]).await;
    let family: Uuid = {
        let mut conn = ctx.conn().await;
        sqlx::query_scalar("select id from token_families where account_uuid = $1")
            .bind(&carbon.uuid)
            .fetch_one(&mut *conn)
            .await
            .expect("family")
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
    assert_inactive(&introspect(&ctx, &app.app_id, &secret, &expired).await);
    // Expired a few seconds ago: inside the clock-skew leeway other verifiers allow, but this
    // server is the clock, so it is inactive (never `active` with an `exp` in the past).
    let (just_expired, _) = ctx
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
            ttl_seconds: -5,
        })
        .expect("sign");
    assert_inactive(&introspect(&ctx, &app.app_id, &secret, &just_expired).await);

    // Access removed (even if the family were somehow still live).
    ctx.exec("update memberships set status = 'access_removed', access_removed_at = now()")
        .await;
    assert_inactive(&introspect(&ctx, &app.app_id, &secret, s(&tokens, "access_token")).await);
    assert_inactive(&introspect(&ctx, &app.app_id, &secret, s(&tokens, "refresh_token")).await);
    ctx.exec("update memberships set status = 'active', access_removed_at = null")
        .await;
    assert_eq!(
        introspect(&ctx, &app.app_id, &secret, s(&tokens, "access_token"))
            .await
            .json["active"],
        true
    );

    // Revoked.
    ctx.exec("update token_families set revoked_at = now(), revoke_reason = 'app_revoked'")
        .await;
    assert_inactive(&introspect(&ctx, &app.app_id, &secret, s(&tokens, "access_token")).await);
    assert_inactive(&introspect(&ctx, &app.app_id, &secret, s(&tokens, "refresh_token")).await);
}

#[tokio::test]
async fn introspection_needs_the_apps_credentials_and_a_token() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let (app, secret) = ctx.app("briefcase").await;
    let first_party = ctx.first_party_tokens(&carbon).await;
    let r = ctx
        .call(
            router(),
            Req::post("/v1/oauth/introspect").form(&[
                ("token", first_party.access_token.as_str()),
                ("client_id", "silicon-accounts"),
            ]),
        )
        .await;
    assert_oauth_error(&r, 401, "invalid_client", "needs the app's own credentials");
    let r = ctx
        .call(
            router(),
            Req::post("/v1/oauth/introspect").form(&[("token", "sar_x")]),
        )
        .await;
    assert_oauth_error(&r, 401, "invalid_client", "not authenticated");
    let r = ctx
        .call(
            router(),
            Req::post("/v1/oauth/introspect")
                .basic(&app.app_id, &secret)
                .form(&[("token_type_hint", "access_token")]),
        )
        .await;
    assert_oauth_error(&r, 400, "invalid_request", "token is required");
    // client_secret_post works.
    let tokens = sign_in(&ctx, &app.app_id, &secret, &carbon, &[Scope::Profile]).await;
    let r = ctx
        .call(
            router(),
            Req::post("/v1/oauth/introspect").form(&[
                ("token", s(&tokens, "access_token")),
                ("client_id", app.app_id.as_str()),
                ("client_secret", secret.as_str()),
            ]),
        )
        .await;
    assert_eq!(r.json["active"], true, "{}", r.json);
}
