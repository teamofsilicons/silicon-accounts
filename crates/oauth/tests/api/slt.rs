//! `grant_type=urn:silicon:params:oauth:grant-type:slt` (alias `slt`).

use accounts_core::models::{Account, Scope};
use accounts_core::repo::{memberships, tokens};
use accounts_core::test_support::TestContext;

use crate::common::*;

const SLT_GRANT: &str = "urn:silicon:params:oauth:grant-type:slt";

async fn make_slt(ctx: &TestContext, account: &Account, app_id: &str, scopes: &[Scope]) -> String {
    let mut conn = ctx.conn().await;
    tokens::create_slt(
        &mut conn,
        &ctx.state.keys.pepper,
        &account.uuid,
        app_id,
        scopes,
    )
    .await
    .expect("create SLT")
    .0
}

async fn exchange_slt(
    ctx: &TestContext,
    app_id: &str,
    secret: &str,
    grant: &str,
    slt: &str,
) -> accounts_core::test_support::Resp {
    ctx.call(
        router(),
        token_req(app_id, secret, &[("grant_type", grant), ("slt", slt)]),
    )
    .await
}

#[tokio::test]
async fn a_silicon_signs_into_an_app_with_a_short_lived_token() {
    let ctx = TestContext::new().await;
    let custodian = ctx.carbon().await;
    let (silicon, _) = ctx.silicon(&custodian.uuid).await;
    let (app, secret) = ctx.app("remind").await;
    let slt = make_slt(
        &ctx,
        &silicon,
        &app.app_id,
        &[Scope::Profile, Scope::Timezone],
    )
    .await;
    let r = exchange_slt(&ctx, &app.app_id, &secret, SLT_GRANT, &slt).await;
    let body = assert_tokens(&r).clone();
    assert_eq!(body["scope"], "profile timezone");
    let account = &body["account"];
    assert_eq!(account["kind"], "silicon");
    assert_eq!(account["uuid"], silicon.uuid.as_str());
    assert_eq!(account["timezone"], "UTC");
    assert!(account.get("email").is_none() && account.get("phone").is_none());
    assert_eq!(account["custodian"]["uuid"], custodian.uuid.as_str());
    assert_eq!(
        account["custodian"]["id"],
        custodian.handle.as_deref().expect("handle")
    );

    // It is a sign-in: membership (source slt), history, a token family of origin slt.
    let mut conn = ctx.conn().await;
    let m = memberships::get(&mut conn, &app.app_id, &silicon.uuid)
        .await
        .expect("query")
        .expect("membership");
    assert_eq!(m.status.as_str(), "active");
    assert_eq!(m.source.as_str(), "slt");
    assert_eq!(m.scopes(), vec![Scope::Profile, Scope::Timezone]);
    assert!(m.first_signed_in_at.is_some() && m.last_signed_in_at.is_some());
    drop(conn);
    let history: String = scalar(
        &ctx,
        "select method || ':' || outcome || ':' || app_id from signin_history where account_uuid = $1",
        &silicon.uuid,
    )
    .await;
    assert_eq!(history, format!("slt:success:{}", app.app_id));
    let origin: String = scalar(
        &ctx,
        "select origin from token_families where account_uuid = $1",
        &silicon.uuid,
    )
    .await;
    assert_eq!(origin, "slt");

    // The app keeps the Silicon signed in with the refresh token.
    assert_tokens(&refresh(&ctx, &app.app_id, &secret, s(&body, "refresh_token")).await);
}

#[tokio::test]
async fn the_bare_alias_works_and_each_token_works_once() {
    let ctx = TestContext::new().await;
    let custodian = ctx.carbon().await;
    let (silicon, _) = ctx.silicon(&custodian.uuid).await;
    let (app, secret) = ctx.app("remind").await;
    let slt = make_slt(&ctx, &silicon, &app.app_id, &[Scope::Profile]).await;
    assert_tokens(&exchange_slt(&ctx, &app.app_id, &secret, "slt", &slt).await);
    let r = exchange_slt(&ctx, &app.app_id, &secret, SLT_GRANT, &slt).await;
    assert_oauth_error(&r, 400, "invalid_grant", "already used");
}

#[tokio::test]
async fn a_short_lived_token_is_bound_to_its_app() {
    let ctx = TestContext::new().await;
    let custodian = ctx.carbon().await;
    let (silicon, _) = ctx.silicon(&custodian.uuid).await;
    let (app, secret) = ctx.app("remind").await;
    let (other, other_secret) = ctx.app("briefcase").await;
    let slt = make_slt(&ctx, &silicon, &app.app_id, &[Scope::Profile]).await;
    let r = exchange_slt(&ctx, &other.app_id, &other_secret, SLT_GRANT, &slt).await;
    assert_oauth_error(&r, 400, "invalid_grant", &app.app_id);
    assert!(s(&r.json, "error_description").contains(&other.app_id));
    // Presenting it to the wrong app used it up.
    let r = exchange_slt(&ctx, &app.app_id, &secret, SLT_GRANT, &slt).await;
    assert_oauth_error(&r, 400, "invalid_grant", "already used");
}

#[tokio::test]
async fn short_lived_tokens_last_two_minutes() {
    let ctx = TestContext::new().await;
    let custodian = ctx.carbon().await;
    let (silicon, _) = ctx.silicon(&custodian.uuid).await;
    let (app, secret) = ctx.app("remind").await;
    let slt = make_slt(&ctx, &silicon, &app.app_id, &[Scope::Profile]).await;
    let ttl: f64 = scalar(
        &ctx,
        "select extract(epoch from expires_at - created_at)::float8 from short_lived_tokens where account_uuid = $1",
        &silicon.uuid,
    )
    .await;
    assert!((ttl - 120.0).abs() < 1.0, "{ttl}");
    ctx.exec("update short_lived_tokens set expires_at = now() - interval '1 second'")
        .await;
    let r = exchange_slt(&ctx, &app.app_id, &secret, SLT_GRANT, &slt).await;
    assert_oauth_error(&r, 400, "invalid_grant", "expired");
}

#[tokio::test]
async fn a_silicon_whose_custodian_has_not_accepted_cannot_sign_in() {
    let ctx = TestContext::new().await;
    let custodian = ctx.carbon().await;
    let (silicon, _) = ctx.silicon(&custodian.uuid).await;
    let (app, secret) = ctx.app("remind").await;
    let slt = make_slt(&ctx, &silicon, &app.app_id, &[Scope::Profile]).await;
    ctx.exec(&format!(
        "update accounts set status = 'pending_custodian' where uuid = '{}'",
        silicon.uuid
    ))
    .await;
    let r = exchange_slt(&ctx, &app.app_id, &secret, SLT_GRANT, &slt).await;
    assert_oauth_error(&r, 400, "invalid_grant", "custodian hasn't accepted");
    let outcome: String = scalar(
        &ctx,
        "select outcome from signin_history where account_uuid = $1",
        &silicon.uuid,
    )
    .await;
    assert_eq!(outcome, "failed");
    let memberships: i64 = scalar(
        &ctx,
        "select count(*) from memberships where account_uuid = $1",
        &silicon.uuid,
    )
    .await;
    assert_eq!(memberships, 0);
}

#[tokio::test]
async fn the_public_client_cannot_exchange_short_lived_tokens() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let (app, _) = ctx.app("remind").await;
    let slt = make_slt(&ctx, &carbon, &app.app_id, &[Scope::Profile]).await;
    let r = ctx
        .call(
            router(),
            public_token_req(&[("grant_type", SLT_GRANT), ("slt", &slt)]),
        )
        .await;
    assert_oauth_error(&r, 400, "unauthorized_client", "public client");
}

#[tokio::test]
async fn signing_in_again_with_an_slt_restores_removed_access() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let (app, secret) = ctx.app("remind").await;
    ctx.membership(&app.app_id, &carbon.uuid, &[Scope::Profile, Scope::Email])
        .await;
    {
        let mut conn = ctx.conn().await;
        memberships::remove_access(&mut conn, &app.app_id, &carbon.uuid, &carbon.uuid)
            .await
            .expect("remove access");
    }
    let slt = make_slt(&ctx, &carbon, &app.app_id, &[Scope::Profile]).await;
    let r = exchange_slt(&ctx, &app.app_id, &secret, SLT_GRANT, &slt).await;
    assert_eq!(assert_tokens(&r)["scope"], "profile");
    let mut conn = ctx.conn().await;
    let m = memberships::get(&mut conn, &app.app_id, &carbon.uuid)
        .await
        .expect("query")
        .expect("membership");
    assert_eq!(m.status.as_str(), "active");
    assert_eq!(
        m.source.as_str(),
        "signin",
        "the source of the first sign-in stays"
    );
    assert_eq!(
        m.scopes(),
        vec![Scope::Profile],
        "removed access forgot the old grant"
    );
}

#[tokio::test]
async fn a_short_lived_token_minted_before_access_was_removed_is_refused() {
    let ctx = TestContext::new().await;
    let custodian = ctx.carbon().await;
    let (silicon, _) = ctx.silicon(&custodian.uuid).await;
    let (app, secret) = ctx.app("remind").await;
    ctx.membership(&app.app_id, &silicon.uuid, &[Scope::Profile])
        .await;
    let slt = make_slt(&ctx, &silicon, &app.app_id, &[Scope::Profile]).await;
    begin_access_removal(&ctx.state, &app.app_id, &silicon.uuid)
        .await
        .commit()
        .await
        .expect("commit the removal");

    let r = exchange_slt(&ctx, &app.app_id, &secret, SLT_GRANT, &slt).await;
    assert_oauth_error(&r, 400, "invalid_grant", "removed the access");
    let description = s(&r.json, "error_description");
    assert!(
        description.contains("after this short-lived token was issued"),
        "{description}"
    );
    assert!(
        description.contains(&format!("accounts login --app {}", app.app_id)),
        "{description}"
    );
    // The account's decision stands, and the attempt is in its history.
    let status: String = scalar(
        &ctx,
        "select status from memberships where account_uuid = $1",
        &silicon.uuid,
    )
    .await;
    assert_eq!(status, "access_removed");
    assert_eq!(live_families(&ctx, &silicon.uuid).await, 0);
    let outcome: String = scalar(
        &ctx,
        "select outcome from signin_history where account_uuid = $1",
        &silicon.uuid,
    )
    .await;
    assert_eq!(outcome, "failed");
    // The token is used up.
    let r = exchange_slt(&ctx, &app.app_id, &secret, SLT_GRANT, &slt).await;
    assert_oauth_error(&r, 400, "invalid_grant", "already used");
}

#[tokio::test]
async fn a_short_lived_token_minted_before_an_stk_rotation_is_refused() {
    let ctx = TestContext::new().await;
    let custodian = ctx.carbon().await;
    let (silicon, _) = ctx.silicon(&custodian.uuid).await;
    let (app, secret) = ctx.app("remind").await;
    let slt = make_slt(&ctx, &silicon, &app.app_id, &[Scope::Profile]).await;
    begin_stk_rotation(&ctx.state, &silicon.uuid)
        .await
        .commit()
        .await
        .expect("commit the rotation");

    let r = exchange_slt(&ctx, &app.app_id, &secret, SLT_GRANT, &slt).await;
    assert_oauth_error(&r, 400, "invalid_grant", "rotated its STK");
    let description = s(&r.json, "error_description");
    assert!(
        description.contains(silicon.handle.as_deref().expect("handle")),
        "{description}"
    );
    assert!(
        description.contains(&format!("accounts login --app {}", app.app_id)),
        "{description}"
    );
    assert_eq!(live_families(&ctx, &silicon.uuid).await, 0);
    let memberships: i64 = scalar(
        &ctx,
        "select count(*) from memberships where account_uuid = $1",
        &silicon.uuid,
    )
    .await;
    assert_eq!(memberships, 0, "a refused sign-in records no membership");
    let outcome: String = scalar(
        &ctx,
        "select method || ':' || outcome from signin_history where account_uuid = $1",
        &silicon.uuid,
    )
    .await;
    assert_eq!(outcome, "slt:failed");

    // A token minted after the rotation (by a sign-in with the new STK) works.
    let fresh = make_slt(&ctx, &silicon, &app.app_id, &[Scope::Profile]).await;
    assert_tokens(&exchange_slt(&ctx, &app.app_id, &secret, SLT_GRANT, &fresh).await);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_exchange_during_an_stk_rotation_waits_for_it_and_is_refused() {
    let ctx = TestContext::new().await;
    let custodian = ctx.carbon().await;
    let (silicon, _) = ctx.silicon(&custodian.uuid).await;
    let (app, secret) = ctx.app("remind").await;
    let slt = make_slt(&ctx, &silicon, &app.app_id, &[Scope::Profile]).await;

    // The custodian's rotation is in flight: it holds the Silicon's row and has revoked every
    // sign-in it can see.
    let rotation = begin_stk_rotation(&ctx.state, &silicon.uuid).await;
    let exchange = spawn_token_request(
        &ctx,
        token_req(
            &app.app_id,
            &secret,
            &[("grant_type", SLT_GRANT), ("slt", &slt)],
        ),
    );
    wait_for_lock_waiters(&ctx, 1).await;
    assert!(!exchange.is_finished());
    rotation.commit().await.expect("commit the rotation");

    let r = exchange.await.expect("exchange task");
    assert_oauth_error(&r, 400, "invalid_grant", "rotated its STK");
    assert_eq!(
        live_families(&ctx, &silicon.uuid).await,
        0,
        "no sign-in survives the rotation"
    );
}

#[tokio::test]
async fn missing_and_wrong_kinds_of_short_lived_tokens() {
    let ctx = TestContext::new().await;
    let (app, secret) = ctx.app("remind").await;
    let r = ctx
        .call(
            router(),
            token_req(&app.app_id, &secret, &[("grant_type", SLT_GRANT)]),
        )
        .await;
    assert_oauth_error(&r, 400, "invalid_request", "slt is required");
    let r = exchange_slt(&ctx, &app.app_id, &secret, SLT_GRANT, "stk-0123456789ab").await;
    assert_oauth_error(&r, 400, "invalid_grant", "an STK");
    let r = exchange_slt(&ctx, &app.app_id, &secret, SLT_GRANT, "slt_unknown").await;
    assert_oauth_error(&r, 400, "invalid_grant", "not known");
}
