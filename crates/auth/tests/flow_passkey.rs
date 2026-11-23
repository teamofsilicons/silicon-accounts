//! Signing in with a passkey on the hosted sign-in: the method in the flow, a sign-in that goes
//! on like a code's, and every refusal (an unknown passkey, a replayed or foreign answer, an app
//! that turned passkeys off, a closed account, a cloned authenticator).

mod common;

use accounts_core::repo::passkeys;
use accounts_core::test_support::{Resp, TestContext};
use accounts_core::webauthn::testing::SoftPasskey;
use accounts_core::webauthn::{self, RegistrationResponse, RelyingParty};
use common::*;
use serde_json::{Value, json};

fn soft(ctx: &TestContext) -> SoftPasskey {
    let rp = RelyingParty::from_settings(&ctx.state.settings);
    SoftPasskey::new(&rp.id, &ctx.state.settings.public_origin)
}

/// Adds the passkey to the account as the account site would have.
async fn register(ctx: &TestContext, account_uuid: &str, key: &SoftPasskey) {
    let rp = RelyingParty::from_settings(&ctx.state.settings);
    let challenge = webauthn::new_challenge();
    let response: RegistrationResponse =
        serde_json::from_value(key.register(&json!({ "challenge": challenge }))).expect("parse");
    let new = webauthn::verify_registration(&rp, &challenge, &response).expect("registers");
    let mut conn = ctx.conn().await;
    passkeys::insert(&mut conn, account_uuid, &new, "Test passkey")
        .await
        .expect("insert");
}

/// Asks for the options and answers them with `key`; returns the response.
async fn passkey_sign_in(
    ctx: &TestContext,
    b: &mut Browser,
    id: &str,
    key: &mut SoftPasskey,
) -> (Resp, Value) {
    let r = b
        .post(ctx, &format!("/v1/flows/{id}/passkey/options"), json!({}))
        .await;
    assert_eq!(r.status, 200, "{}", r.json);
    let answer = key.sign_in(&r.json);
    let r = b
        .post(
            ctx,
            &format!("/v1/flows/{id}/passkey"),
            json!({ "credential": answer }),
        )
        .await;
    (r, answer)
}

#[tokio::test]
async fn signs_in_with_a_passkey() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let mut key = soft(&ctx);
    register(&ctx, &carbon.uuid, &key).await;
    let (app, _) = ctx.app("briefcase").await;
    let mut b = Browser::new(&ctx);
    let f = new_flow(&ctx, &mut b, &app.app_id, json!({})).await;
    assert!(
        f["methods"]
            .as_array()
            .is_some_and(|m| m.iter().any(|m| m == "passkey")),
        "every app offers passkeys unless it turns them off: {}",
        f["methods"]
    );
    let id = id_of(&f);

    let (r, answer) = passkey_sign_in(&ctx, &mut b, &id, &mut key).await;
    assert_eq!(r.status, 200, "{}", r.json);
    let f = &r.json["flow"];
    assert_eq!(f["step"], "details");
    assert_eq!(f["signed_in_as"]["uuid"], carbon.uuid.as_str());
    assert!(
        b.cookie("sa_session")
            .is_some_and(|c| c.starts_with("sas_"))
    );

    // The use is recorded: the counter, when, and the sign-in history.
    let (count, used): (i64, bool) = sqlx::query_as(
        "select sign_count, last_used_at is not null from passkeys where account_uuid = $1",
    )
    .bind(&carbon.uuid)
    .fetch_one(&ctx.state.db)
    .await
    .expect("passkey");
    assert_eq!((count, used), (1, true));

    // The same answer again: its challenge was used.
    let r = b
        .post(
            &ctx,
            &format!("/v1/flows/{id}/passkey"),
            json!({ "credential": answer }),
        )
        .await;
    assert_ne!(r.status, 200, "a replay must not sign in: {}", r.json);

    // Finishing the flow records the sign-in as a passkey's.
    let r = continue_page(&ctx, &mut b, &id, &[]).await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(r.json["flow"]["step"], "complete");
    let method: String = sqlx::query_scalar(
        "select method from signin_history where account_uuid = $1 and outcome = 'success' order by at desc limit 1",
    )
    .bind(&carbon.uuid)
    .fetch_one(&ctx.state.db)
    .await
    .expect("history");
    assert_eq!(method, "passkey");
}

#[tokio::test]
async fn refuses_an_unknown_or_foreign_passkey() {
    let ctx = TestContext::new().await;
    let (app, _) = ctx.app("briefcase").await;
    let mut b = Browser::new(&ctx);
    let f = new_flow(&ctx, &mut b, &app.app_id, json!({})).await;
    let id = id_of(&f);

    // Never added to an account: it signs nobody up.
    let mut stranger = soft(&ctx);
    let (r, _) = passkey_sign_in(&ctx, &mut b, &id, &mut stranger).await;
    assert_eq!(r.error_code(), Some("passkey_unknown"), "{}", r.json);
    // The flow remembers why and can be used again.
    let r = b.get(&ctx, &format!("/v1/flows/{id}")).await;
    assert_eq!(r.json["flow"]["step"], "choose_method");
    assert_eq!(r.json["flow"]["error"]["code"], "passkey_unknown");

    // Answered on another origin (a phishing page relaying a real passkey's id).
    let carbon = ctx.carbon().await;
    let real = soft(&ctx);
    register(&ctx, &carbon.uuid, &real).await;
    let rp = RelyingParty::from_settings(&ctx.state.settings);
    let mut phished = SoftPasskey::new(&rp.id, "https://evil.example");
    phished.credential_id = real.credential_id.clone();
    let (r, _) = passkey_sign_in(&ctx, &mut b, &id, &mut phished).await;
    assert_eq!(r.error_code(), Some("passkey_invalid"), "{}", r.json);
    assert!(b.cookie("sa_session").is_none());
}

#[tokio::test]
async fn follows_the_app_and_the_account() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let mut key = soft(&ctx);
    register(&ctx, &carbon.uuid, &key).await;

    // An app that turned passkeys off doesn't offer them.
    let (app, _) = app_with(
        &ctx,
        "nopasskey",
        json!({ "methods": { "email": true, "passkey": false } }),
    )
    .await;
    let mut b = Browser::new(&ctx);
    let f = new_flow(&ctx, &mut b, &app.app_id, json!({})).await;
    assert!(
        !f["methods"]
            .as_array()
            .is_some_and(|m| m.iter().any(|m| m == "passkey"))
    );
    let r = b
        .post(
            &ctx,
            &format!("/v1/flows/{}/passkey/options", id_of(&f)),
            json!({}),
        )
        .await;
    assert_eq!(r.error_code(), Some("method_not_enabled"), "{}", r.json);

    // A closed account can't sign in with its passkey.
    let (app, _) = ctx.app("briefcase").await;
    let f = new_flow(&ctx, &mut b, &app.app_id, json!({})).await;
    let id = id_of(&f);
    ctx.exec(&format!(
        "update accounts set status = 'deleted' where uuid = '{}'",
        carbon.uuid
    ))
    .await;
    let (r, _) = passkey_sign_in(&ctx, &mut b, &id, &mut key).await;
    assert_eq!(r.error_code(), Some("account_unavailable"), "{}", r.json);
}

#[tokio::test]
async fn refuses_a_cloned_authenticator() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let mut key = soft(&ctx);
    register(&ctx, &carbon.uuid, &key).await;
    ctx.exec(&format!(
        "update passkeys set sign_count = 99 where account_uuid = '{}'",
        carbon.uuid
    ))
    .await;
    let (app, _) = ctx.app("briefcase").await;
    let mut b = Browser::new(&ctx);
    let f = new_flow(&ctx, &mut b, &app.app_id, json!({})).await;
    let (r, _) = passkey_sign_in(&ctx, &mut b, &id_of(&f), &mut key).await;
    assert_eq!(r.error_code(), Some("passkey_invalid"), "{}", r.json);
    let failed: i64 = sqlx::query_scalar(
        "select count(*) from signin_history where account_uuid = $1 and method = 'passkey' and outcome = 'failed'",
    )
    .bind(&carbon.uuid)
    .fetch_one(&ctx.state.db)
    .await
    .expect("history");
    assert_eq!(failed, 1);
}
