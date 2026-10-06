//! `GET /v1/me/identities`, `DELETE /v1/me/identities/{provider}/{subject}`.

use accounts_core::models::Provider;
use accounts_core::repo::identities;
use accounts_core::test_support::{CarbonSpec, Req, TestContext};

use crate::common::*;

#[tokio::test]
async fn list_and_disconnect_identities() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let mut conn = ctx.conn().await;
    identities::link(
        &mut conn,
        Provider::Google,
        "1170000001",
        "managed-google",
        &carbon.uuid,
        Some("me@gmail.test"),
    )
    .await
    .expect("google");
    identities::link(
        &mut conn,
        Provider::Apple,
        "001234.abcd.5678",
        "managed-apple",
        &carbon.uuid,
        None,
    )
    .await
    .expect("apple");
    drop(conn);
    let tok = token(&ctx, &carbon).await;

    let r = call(&ctx, Req::get("/v1/me/identities").bearer(&tok)).await;
    assert_status(&r, 200);
    let items = r.json["items"].as_array().expect("items");
    assert_eq!(items.len(), 2);
    assert_eq!(items[0]["provider"], "google");
    assert_eq!(items[0]["subject"], "1170000001");
    assert_eq!(items[0]["email"], "me@gmail.test");
    assert!(items[0].get("client_id").is_none());

    let r = call(
        &ctx,
        Req::delete("/v1/me/identities/Google/1170000001").bearer(&tok),
    )
    .await;
    assert_status(&r, 204);
    let r = call(
        &ctx,
        Req::delete("/v1/me/identities/google/1170000001").bearer(&tok),
    )
    .await;
    assert_error(&r, 404, "identity_not_found");
    let r = call(&ctx, Req::delete("/v1/me/identities/github/1").bearer(&tok)).await;
    assert_error(&r, 400, "invalid_provider");
    let r = call(&ctx, Req::get("/v1/me/identities").bearer(&tok)).await;
    assert_eq!(r.json["items"].as_array().map(Vec::len), Some(1));
    assert_eq!(r.json["items"][0]["subject"], "001234.abcd.5678");

    // Another account's identity can't be disconnected from here.
    let other = ctx.carbon().await;
    let r = call(
        &ctx,
        Req::delete("/v1/me/identities/apple/001234.abcd.5678").bearer(&token(&ctx, &other).await),
    )
    .await;
    assert_error(&r, 404, "identity_not_found");
    let audit: i64 = scalar(
        &ctx,
        "select count(*) from audit_log where account_uuid = $1 and action = 'account.identity.unlinked'",
        &carbon.uuid,
    )
    .await;
    assert_eq!(audit, 1);
}

#[tokio::test]
async fn the_last_way_to_sign_in_stays() {
    let ctx = TestContext::new().await;
    let carbon = ctx
        .carbon_with(CarbonSpec {
            email: Some(String::new()),
            ..Default::default()
        })
        .await;
    identities::link(
        &mut *ctx.conn().await,
        Provider::Google,
        "only-way",
        "managed",
        &carbon.uuid,
        None,
    )
    .await
    .expect("link");
    let r = call(
        &ctx,
        Req::delete("/v1/me/identities/google/only-way").bearer(&token(&ctx, &carbon).await),
    )
    .await;
    assert_error(&r, 409, "last_sign_in_method");
    assert!(
        r.json["error"]["hint"]
            .as_str()
            .is_some_and(|h| h.contains("POST /v1/me/emails"))
    );

    let (silicon, _) = ctx.silicon(&carbon.uuid).await;
    let r = call(
        &ctx,
        Req::get("/v1/me/identities").bearer(&token(&ctx, &silicon).await),
    )
    .await;
    assert_error(&r, 403, "carbon_only");
}
