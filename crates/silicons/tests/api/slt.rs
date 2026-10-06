//! `POST /v1/me/short-lived-tokens`.

use accounts_core::models::Scope;
use accounts_core::repo::tokens;
use accounts_core::test_support::{CarbonSpec, Req, TestContext};
use serde_json::json;

use crate::common::*;

async fn slt(ctx: &TestContext, bearer: &str, app_id: &str) -> accounts_core::test_support::Resp {
    call(
        ctx,
        Req::post("/v1/me/short-lived-tokens")
            .bearer(bearer)
            .json(json!({"app_id": app_id})),
    )
    .await
}

#[tokio::test]
async fn a_silicon_gets_an_slt_with_only_dob_and_timezone() {
    let ctx = TestContext::new().await;
    let custodian = ctx.carbon().await;
    let (silicon, _) = ctx.silicon(&custodian.uuid).await;
    let (app, _) = ctx.app("remind").await;
    set_app_config(
        &ctx,
        &app.app_id,
        json!({"redirect_uris": ["https://remind.example/cb"], "required_fields": ["timezone", "email"],
               "optional_fields": ["phone", "dob"]}),
    )
    .await;
    let t = token(&ctx, &silicon).await;
    let r = slt(&ctx, &t, &app.app_id.to_uppercase()).await;
    assert_eq!(r.status, 201, "{}", r.json);
    let value = r.json["slt"].as_str().expect("slt");
    assert!(value.starts_with("slt_"));
    assert_eq!(r.json["app_id"], app.app_id);
    assert_eq!(r.json["scope"], "profile dob timezone");
    let expires = ts(&r.json["expires_at"]);
    let delta = expires - time::OffsetDateTime::now_utc();
    assert!(
        delta > time::Duration::seconds(100) && delta <= time::Duration::seconds(121),
        "{delta}"
    );

    // The app can redeem it exactly once, for this account and these scopes.
    let row = tokens::consume_slt(&ctx.state.db, &ctx.state.keys.pepper, value, &app.app_id)
        .await
        .expect("redeemable");
    assert_eq!(row.account_uuid, silicon.uuid);
    assert_eq!(
        row.scope_list(),
        vec![Scope::Profile, Scope::Dob, Scope::Timezone]
    );
    assert!(
        tokens::consume_slt(&ctx.state.db, &ctx.state.keys.pepper, value, &app.app_id)
            .await
            .is_err()
    );
    let audited: (Option<String>, Option<String>, Option<String>) = sqlx::query_as(
        "select account_uuid, app_id, target_id from audit_log where action = 'slt.issued'",
    )
    .fetch_one(&ctx.state.db)
    .await
    .expect("audit");
    assert_eq!(
        audited,
        (None, Some(app.app_id.clone()), Some(silicon.uuid.clone())),
        "kept in the store, listed in no history (the exchange is the sign-in)"
    );
}

#[tokio::test]
async fn a_carbon_gets_required_fields_or_a_precise_requirements_missing() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await; // verified email, no phone
    let t = token(&ctx, &carbon).await;
    let (briefcase, _) = ctx.app("briefcase").await;
    set_app_config(
        &ctx,
        &briefcase.app_id,
        json!({"required_fields": ["email"], "optional_fields": ["timezone", "dob"]}),
    )
    .await;
    let r = slt(&ctx, &t, &briefcase.app_id).await;
    assert_eq!(r.status, 201, "{}", r.json);
    assert_eq!(r.json["scope"], "profile email");

    // Optional fields the Carbon already granted on the consent screen come along.
    ctx.membership(
        &briefcase.app_id,
        &carbon.uuid,
        &[Scope::Profile, Scope::Email, Scope::Timezone],
    )
    .await;
    let r = slt(&ctx, &t, &briefcase.app_id).await;
    assert_eq!(r.json["scope"], "profile email timezone");

    let (dm, _) = ctx.app("dm").await;
    set_app_config(
        &ctx,
        &dm.app_id,
        json!({"required_fields": ["phone", "email"]}),
    )
    .await;
    let r = slt(&ctx, &t, &dm.app_id).await;
    assert_eq!(r.status, 409, "{}", r.json);
    assert_eq!(r.error_code(), Some("requirements_missing"));
    assert_eq!(r.json["error"]["details"]["missing"], json!(["phone"]));
    assert!(
        r.json["error"]["message"]
            .as_str()
            .expect("m")
            .contains("phone number")
    );

    // A Silicon is never blocked by email/phone requirements.
    let (silicon, _) = ctx.silicon(&carbon.uuid).await;
    let st = token(&ctx, &silicon).await;
    let r = slt(&ctx, &st, &dm.app_id).await;
    assert_eq!(r.status, 201, "{}", r.json);
    assert_eq!(r.json["scope"], "profile");
}

#[tokio::test]
async fn email_domain_restrictions_apply_to_carbons() {
    let ctx = TestContext::new().await;
    let outsider = ctx.carbon().await; // @example.test
    let insider = ctx
        .carbon_with(CarbonSpec {
            email: Some(format!(
                "in-{}@university.test",
                accounts_core::test_support::rand_suffix()
            )),
            ..Default::default()
        })
        .await;
    let (campus, _) = ctx.app("campus").await;
    set_app_config(
        &ctx,
        &campus.app_id,
        json!({"required_fields": ["email"], "allowed_email_domains": ["university.test"]}),
    )
    .await;
    let r = slt(&ctx, &token(&ctx, &outsider).await, &campus.app_id).await;
    assert_eq!(r.status, 403, "{}", r.json);
    assert_eq!(r.error_code(), Some("email_domain_not_allowed"));
    let r = slt(&ctx, &token(&ctx, &insider).await, &campus.app_id).await;
    assert_eq!(r.status, 201, "{}", r.json);
}

#[tokio::test]
async fn app_and_auth_errors() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let t = token(&ctx, &carbon).await;

    let r = slt(&ctx, &t, "no-such-app").await;
    assert_eq!(r.status, 404);
    assert_eq!(r.error_code(), Some("unknown_app"));

    let (disabled, _) = ctx.app("off").await;
    ctx.exec(&format!(
        "update apps set status = 'disabled' where app_id = '{}'",
        disabled.app_id
    ))
    .await;
    let r = slt(&ctx, &t, &disabled.app_id).await;
    assert_eq!(r.status, 403);
    assert_eq!(r.error_code(), Some("app_disabled"));

    let r = slt(&ctx, &t, "accounts").await;
    assert_eq!(r.status, 422);
    assert_eq!(r.error_code(), Some("first_party_app"));

    let r = slt(&ctx, &t, "Not An App!").await;
    assert_eq!(r.status, 422);
    assert!(r.json["error"]["details"]["fields"]["app_id"].is_string());

    let r = call(
        &ctx,
        Req::post("/v1/me/short-lived-tokens").json(json!({"app_id": "remind"})),
    )
    .await;
    assert_eq!(r.status, 401);
    assert_eq!(r.error_code(), Some("unauthenticated"));

    // An app's own access token is not a first-party session.
    let (app, _) = ctx.app("other").await;
    let app_token = ctx
        .tokens_for(&carbon, &app.app_id, &[Scope::Profile])
        .await
        .access_token;
    let r = slt(&ctx, &app_token, &app.app_id).await;
    assert_eq!(r.status, 401);
    assert_eq!(r.error_code(), Some("token_wrong_audience"));
}

#[tokio::test]
async fn the_account_site_session_cookie_works_too() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let cookie = ctx.browser_session(&carbon).await;
    let (app, _) = ctx.app("site").await;
    let r = call(
        &ctx,
        Req::post("/v1/me/short-lived-tokens")
            .session(&ctx.state.settings, &cookie)
            .json(json!({"app_id": app.app_id})),
    )
    .await;
    assert_eq!(r.status, 201, "{}", r.json);
    // Without the site's Origin the cookie is refused (CSRF guard).
    let r = call(
        &ctx,
        Req::post("/v1/me/short-lived-tokens")
            .session(&ctx.state.settings, &cookie)
            .header("origin", "https://evil.example")
            .json(json!({"app_id": app.app_id})),
    )
    .await;
    assert_eq!(r.status, 403);
    assert_eq!(r.error_code(), Some("origin_not_allowed"));
}
