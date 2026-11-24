//! `GET/POST /v1/me/passkeys`, `POST /v1/me/passkeys/options`, `PATCH/DELETE /v1/me/passkeys/{id}`.

use accounts_core::test_support::{Req, TestContext};
use accounts_core::webauthn::RelyingParty;
use accounts_core::webauthn::testing::SoftPasskey;
use serde_json::{Value, json};

use crate::common::*;

fn soft(ctx: &TestContext) -> SoftPasskey {
    let rp = RelyingParty::from_settings(&ctx.state.settings);
    SoftPasskey::new(&rp.id, &ctx.state.settings.public_origin)
}

/// Adds a passkey through the two calls the account site makes; returns the passkey.
async fn add(ctx: &TestContext, cookie: &str, key: &SoftPasskey, name: Option<&str>) -> Value {
    let r = call(
        ctx,
        Req::post("/v1/me/passkeys/options").session(&ctx.state.settings, cookie),
    )
    .await;
    assert_status(&r, 200);
    let mut body = json!({ "credential": key.register(&r.json) });
    if let Some(name) = name {
        body["name"] = json!(name);
    }
    let r = call(
        ctx,
        Req::post("/v1/me/passkeys")
            .session(&ctx.state.settings, cookie)
            .json(body),
    )
    .await;
    assert_status(&r, 201);
    r.json
}

#[tokio::test]
async fn adds_lists_renames_and_removes() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let cookie = ctx.browser_session(&carbon).await;
    let key = soft(&ctx);

    // The options name the account and ask for a discoverable credential.
    let r = call(
        &ctx,
        Req::post("/v1/me/passkeys/options").session(&ctx.state.settings, &cookie),
    )
    .await;
    assert_status(&r, 200);
    assert_eq!(r.json["authenticatorSelection"]["residentKey"], "required");
    assert_eq!(r.json["attestation"], "none");
    assert!(r.json["challenge"].as_str().is_some_and(|c| c.len() >= 40));

    let added = add(&ctx, &cookie, &key, Some("  iCloud Keychain ")).await;
    assert_eq!(added["name"], "iCloud Keychain");
    assert_eq!(added["last_used_at"], Value::Null);
    let id = added["id"].as_str().expect("id").to_string();

    // A second key gets the default name, and the first is excluded from the next options.
    let other = soft(&ctx);
    let second = add(&ctx, &cookie, &other, None).await;
    assert_eq!(second["name"], "Passkey");
    let r = call(
        &ctx,
        Req::post("/v1/me/passkeys/options").session(&ctx.state.settings, &cookie),
    )
    .await;
    assert_eq!(
        r.json["excludeCredentials"].as_array().map(Vec::len),
        Some(2)
    );

    let tok = token(&ctx, &carbon).await;
    let r = call(&ctx, Req::get("/v1/me/passkeys").bearer(&tok)).await;
    assert_status(&r, 200);
    assert_eq!(r.json["items"].as_array().map(Vec::len), Some(2));
    assert_eq!(r.json["items"][0]["id"], id.as_str());
    // GET /v1/me carries them too.
    let r = call(&ctx, Req::get("/v1/me").bearer(&tok)).await;
    assert_eq!(r.json["passkeys"].as_array().map(Vec::len), Some(2));

    let r = call(
        &ctx,
        Req::patch(&format!("/v1/me/passkeys/{id}"))
            .bearer(&tok)
            .json(json!({ "name": "MacBook" })),
    )
    .await;
    assert_status(&r, 200);
    assert_eq!(r.json["name"], "MacBook");
    let r = call(
        &ctx,
        Req::patch(&format!("/v1/me/passkeys/{id}"))
            .bearer(&tok)
            .json(json!({ "name": "x".repeat(65) })),
    )
    .await;
    assert_error(&r, 400, "invalid_passkey_name");

    let r = call(
        &ctx,
        Req::delete(&format!("/v1/me/passkeys/{id}")).bearer(&tok),
    )
    .await;
    assert_status(&r, 204);
    let r = call(
        &ctx,
        Req::delete(&format!("/v1/me/passkeys/{id}")).bearer(&tok),
    )
    .await;
    assert_error(&r, 404, "passkey_not_found");

    // Every change is in the account's history.
    let actions: Vec<String> = sqlx::query_scalar(
        "select action from audit_log where account_uuid = $1 and action like 'account.passkey.%' order by at",
    )
    .bind(&carbon.uuid)
    .fetch_all(&ctx.state.db)
    .await
    .expect("audit");
    assert_eq!(
        actions,
        vec![
            "account.passkey.added",
            "account.passkey.added",
            "account.passkey.renamed",
            "account.passkey.removed"
        ]
    );
}

#[tokio::test]
async fn needs_a_recent_browser_sign_in() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;

    // An access token can't add one: the ceremony is in the browser.
    let tok = token(&ctx, &carbon).await;
    let r = call(&ctx, Req::post("/v1/me/passkeys/options").bearer(&tok)).await;
    assert_error(&r, 400, "browser_session_required");

    // A session signed in an hour ago must sign in again.
    let cookie = ctx.browser_session(&carbon).await;
    ctx.exec(&format!(
        "update browser_sessions set authenticated_at = now() - interval '1 hour' where account_uuid = '{}'",
        carbon.uuid
    ))
    .await;
    let r = call(
        &ctx,
        Req::post("/v1/me/passkeys/options").session(&ctx.state.settings, &cookie),
    )
    .await;
    assert_error(&r, 403, "reauthentication_required");
}

#[tokio::test]
async fn refuses_a_bad_or_late_credential() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let cookie = ctx.browser_session(&carbon).await;

    // No registration open.
    let key = soft(&ctx);
    let r = call(
        &ctx,
        Req::post("/v1/me/passkeys")
            .session(&ctx.state.settings, &cookie)
            .json(json!({ "credential": key.register(&json!({ "challenge": "AAAA" })) })),
    )
    .await;
    assert_error(&r, 409, "passkey_registration_expired");

    // A credential made on another origin.
    let r = call(
        &ctx,
        Req::post("/v1/me/passkeys/options").session(&ctx.state.settings, &cookie),
    )
    .await;
    let rp = RelyingParty::from_settings(&ctx.state.settings);
    let phish = SoftPasskey::new(&rp.id, "https://evil.example");
    let r = call(
        &ctx,
        Req::post("/v1/me/passkeys")
            .session(&ctx.state.settings, &cookie)
            .json(json!({ "credential": phish.register(&r.json) })),
    )
    .await;
    assert_error(&r, 400, "passkey_invalid");

    // A registration is used once: the refused attempt used it up.
    let r = call(
        &ctx,
        Req::post("/v1/me/passkeys")
            .session(&ctx.state.settings, &cookie)
            .json(json!({ "credential": key.register(&json!({ "challenge": "AAAA" })) })),
    )
    .await;
    assert_error(&r, 409, "passkey_registration_expired");

    // The same passkey can't be added to a second account.
    add(&ctx, &cookie, &key, None).await;
    let other = ctx.carbon().await;
    let other_cookie = ctx.browser_session(&other).await;
    let r = call(
        &ctx,
        Req::post("/v1/me/passkeys/options").session(&ctx.state.settings, &other_cookie),
    )
    .await;
    let r = call(
        &ctx,
        Req::post("/v1/me/passkeys")
            .session(&ctx.state.settings, &other_cookie)
            .json(json!({ "credential": key.register(&r.json) })),
    )
    .await;
    assert_error(&r, 409, "passkey_in_use");
}

#[tokio::test]
async fn keeps_a_way_in() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let cookie = ctx.browser_session(&carbon).await;
    let key = soft(&ctx);
    let added = add(&ctx, &cookie, &key, None).await;
    let id = added["id"].as_str().expect("id");

    // With the email gone, the passkey is the only way in: it stays.
    ctx.exec(&format!(
        "delete from account_emails where account_uuid = '{0}'; delete from account_phones where account_uuid = '{0}'",
        carbon.uuid
    ))
    .await;
    let tok = token(&ctx, &carbon).await;
    let r = call(
        &ctx,
        Req::delete(&format!("/v1/me/passkeys/{id}")).bearer(&tok),
    )
    .await;
    assert_error(&r, 409, "last_sign_in_method");
}

#[tokio::test]
async fn silicons_have_none() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let (silicon, _) = ctx.silicon(&carbon.uuid).await;
    let tok = token(&ctx, &silicon).await;
    let r = call(&ctx, Req::get("/v1/me/passkeys").bearer(&tok)).await;
    assert_error(&r, 403, "carbon_only");
}
