//! Returning sessions show linked identities before any "Continue as" action.
mod common;

use accounts_core::http::cookies::{SESSION_COOKIE, cookie_name};
use accounts_core::models::Account;
use accounts_core::repo::{accounts, organizations};
use accounts_core::test_support::TestContext;
use common::*;
use serde_json::{Value, json};

async fn linked_pair(ctx: &TestContext) -> (Account, Account) {
    let personal = ctx.carbon().await;
    let work = ctx.carbon().await;
    sqlx::query(
        "insert into organization_projections(org_id,name) values('testorg','Test organization')",
    )
    .execute(&ctx.state.db)
    .await
    .unwrap();
    sqlx::query("update accounts set org_id='testorg',handle='c:member.testorg' where uuid=$1")
        .bind(&work.uuid)
        .execute(&ctx.state.db)
        .await
        .unwrap();
    // The work identity uses the personal identity's verified sign-in method.
    sqlx::query("delete from account_emails where account_uuid=$1")
        .bind(&work.uuid)
        .execute(&ctx.state.db)
        .await
        .unwrap();
    sqlx::query("insert into organization_account_policies(account_uuid,version,mode) values($1,1,'everywhere')")
        .bind(&work.uuid).execute(&ctx.state.db).await.unwrap();
    organizations::link(&mut *ctx.conn().await, &personal.uuid, &work.uuid)
        .await
        .unwrap();
    let work = accounts::require(&mut *ctx.conn().await, &work.uuid)
        .await
        .unwrap();
    (personal, work)
}

async fn remember(ctx: &TestContext, b: &mut Browser, account: &Account) {
    b.cookies.insert(
        cookie_name(&ctx.state.settings, SESSION_COOKIE),
        ctx.browser_session(account).await,
    );
}

fn assert_choices(flow: &Value, personal: &Account, work: &Account) {
    assert_eq!(flow["step"], "select_account", "{flow}");
    let choices = flow["accounts"].as_array().unwrap();
    assert_eq!(choices.len(), 2);
    assert_eq!(choices[0]["uuid"], personal.uuid);
    assert_eq!(choices[0]["org"], Value::Null);
    assert_eq!(choices[1]["uuid"], work.uuid);
    assert_eq!(choices[1]["org"]["name"], "Test organization");
    assert_eq!(flow["redirect_to"], Value::Null);
}

async fn select(
    ctx: &TestContext,
    b: &mut Browser,
    flow: &Value,
    uuid: &str,
) -> accounts_core::test_support::Resp {
    b.post(
        ctx,
        &format!("/v1/flows/{}/select-account", id_of(flow)),
        json!({"account_uuid":uuid}),
    )
    .await
}

#[tokio::test]
async fn either_remembered_identity_shows_both_and_selects_directly() {
    let ctx = TestContext::new().await;
    let (personal, work) = linked_pair(&ctx).await;
    let mut b = Browser::new(&ctx);
    remember(&ctx, &mut b, &personal).await;
    let cookie = b
        .cookie(&cookie_name(&ctx.state.settings, SESSION_COOKIE))
        .unwrap()
        .to_owned();
    let flow = new_flow(&ctx, &mut b, "silicon-accounts", json!({})).await;
    assert_choices(&flow, &personal, &work);
    assert_eq!(
        b.cookie(&cookie_name(&ctx.state.settings, SESSION_COOKIE)),
        Some(cookie.as_str())
    );
    let grants: i64 =
        sqlx::query_scalar("select count(*) from authorization_codes where flow_id=$1")
            .bind(id_of(&flow))
            .fetch_one(&ctx.state.db)
            .await
            .unwrap();
    assert_eq!(
        grants, 0,
        "showing the chooser must not authorize either account"
    );
    let refreshed = b.get(&ctx, &format!("/v1/flows/{}", id_of(&flow))).await;
    assert_choices(&refreshed.json["flow"], &personal, &work);
    let r = select(&ctx, &mut b, &flow, &work.uuid).await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(r.json["flow"]["step"], "complete");
    assert_eq!(r.json["flow"]["signed_in_as"]["uuid"], work.uuid);
    // Work remains remembered, but personal is equally accessible on the next sign-in.
    let flow = new_flow(&ctx, &mut b, "silicon-accounts", json!({"method":"email"})).await;
    assert_choices(&flow, &personal, &work);
    let r = select(&ctx, &mut b, &flow, &personal.uuid).await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(r.json["flow"]["signed_in_as"]["uuid"], personal.uuid);
}

#[tokio::test]
async fn shared_email_authentication_offers_both_without_a_second_login() {
    let ctx = TestContext::new().await;
    let (personal, work) = linked_pair(&ctx).await;
    let mut b = Browser::new(&ctx);
    let flow = new_flow(&ctx, &mut b, "silicon-accounts", json!({})).await;
    assert_eq!(flow["step"], "choose_method");
    assert_eq!(flow["accounts"], json!([]));
    let email = format!("{}@example.test", personal.id().trim_start_matches("c:"));
    let r = email_and_verify(&ctx, &mut b, &id_of(&flow), &email).await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_choices(&r.json["flow"], &personal, &work);
    let r = select(&ctx, &mut b, &r.json["flow"], &work.uuid).await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(r.json["flow"]["step"], "complete");
}

#[tokio::test]
async fn fresh_authentication_and_silent_prompt_keep_their_contracts() {
    let ctx = TestContext::new().await;
    let (personal, work) = linked_pair(&ctx).await;
    let (app, _) = app_with(&ctx, "forgetful", json!({"remember_browser":false})).await;
    let mut b = Browser::new(&ctx);
    remember(&ctx, &mut b, &personal).await;
    for (app_id, extra) in [
        ("silicon-accounts", json!({"prompt":"login"})),
        (app.app_id.as_str(), json!({})),
    ] {
        let flow = new_flow(&ctx, &mut b, app_id, extra).await;
        assert_eq!(flow["step"], "choose_method");
        assert_eq!(flow["signed_in_as"], Value::Null);
        assert_eq!(flow["accounts"], json!([]));
        assert_ne!(select(&ctx, &mut b, &flow, &work.uuid).await.status, 200);
    }
    let flow = new_flow(&ctx, &mut b, "silicon-accounts", json!({"prompt":"none"})).await;
    assert_eq!(flow["step"], "failed");
    assert_eq!(flow["error"]["code"], "interaction_required");
    let flow = new_flow(
        &ctx,
        &mut b,
        "silicon-accounts",
        json!({"prompt":"select_account"}),
    )
    .await;
    assert_choices(&flow, &personal, &work);
    let r = b
        .post(
            &ctx,
            &format!("/v1/flows/{}/switch", id_of(&flow)),
            json!({}),
        )
        .await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(r.json["flow"]["step"], "choose_method");
    assert_eq!(r.json["flow"]["accounts"], json!([]));
    assert_eq!(r.json["flow"]["signed_in_as"], Value::Null);
}

#[tokio::test]
async fn selection_rechecks_link_session_and_organization_policy() {
    let ctx = TestContext::new().await;
    let (personal, work) = linked_pair(&ctx).await;
    let unrelated = ctx.carbon().await;
    let (app, _) = ctx.app("restricted").await;
    let mut b = Browser::new(&ctx);
    remember(&ctx, &mut b, &personal).await;
    let flow = new_flow(&ctx, &mut b, &app.app_id, json!({})).await;
    assert_choices(&flow, &personal, &work);
    assert_eq!(
        select(&ctx, &mut b, &flow, &unrelated.uuid)
            .await
            .error_code(),
        Some("account_not_linked")
    );
    // A policy changed after rendering must still prevent the work sign-in.
    sqlx::query(
        "update organization_account_policies set mode='only',version=2 where account_uuid=$1",
    )
    .bind(&work.uuid)
    .execute(&ctx.state.db)
    .await
    .unwrap();
    assert_eq!(
        select(&ctx, &mut b, &flow, &work.uuid).await.error_code(),
        Some("organization_app_not_allowed")
    );
    let refreshed = b.get(&ctx, &format!("/v1/flows/{}", id_of(&flow))).await;
    assert_eq!(refreshed.json["flow"]["accounts"][1]["allowed"], false);
    // Selecting from a stale tab after a different browser sign-in is rejected.
    remember(&ctx, &mut b, &unrelated).await;
    assert_eq!(
        select(&ctx, &mut b, &flow, &personal.uuid)
            .await
            .error_code(),
        Some("account_not_linked")
    );
    b.cookies
        .remove(&cookie_name(&ctx.state.settings, SESSION_COOKIE));
    assert_eq!(
        select(&ctx, &mut b, &flow, &personal.uuid)
            .await
            .error_code(),
        Some("session_required")
    );
    remember(&ctx, &mut b, &personal).await;
    sqlx::query("delete from account_links where account_uuid=$1")
        .bind(&work.uuid)
        .execute(&ctx.state.db)
        .await
        .unwrap();
    assert_eq!(
        select(&ctx, &mut b, &flow, &work.uuid).await.error_code(),
        Some("account_not_linked")
    );
}

#[tokio::test]
async fn a_waiting_chooser_cannot_continue_after_expiry_or_disable() {
    let ctx = TestContext::new().await;
    let (personal, work) = linked_pair(&ctx).await;
    let (app, _) = ctx.app("waiting").await;
    let mut b = Browser::new(&ctx);
    remember(&ctx, &mut b, &personal).await;
    let flow = new_flow(&ctx, &mut b, &app.app_id, json!({})).await;
    sqlx::query("update signin_flows set expires_at=now()-interval '1 second' where id=$1")
        .bind(id_of(&flow))
        .execute(&ctx.state.db)
        .await
        .unwrap();
    assert_eq!(
        select(&ctx, &mut b, &flow, &work.uuid).await.error_code(),
        Some("flow_expired")
    );
    let flow = new_flow(&ctx, &mut b, &app.app_id, json!({})).await;
    sqlx::query("update apps set status='disabled' where app_id=$1")
        .bind(&app.app_id)
        .execute(&ctx.state.db)
        .await
        .unwrap();
    assert_eq!(
        select(&ctx, &mut b, &flow, &work.uuid).await.error_code(),
        Some("app_disabled")
    );
    let flow = new_flow(&ctx, &mut b, "silicon-accounts", json!({})).await;
    sqlx::query("update accounts set status='deleted',handle=null where uuid=$1")
        .bind(&personal.uuid)
        .execute(&ctx.state.db)
        .await
        .unwrap();
    assert_eq!(
        select(&ctx, &mut b, &flow, &work.uuid).await.error_code(),
        Some("session_required")
    );
}

#[tokio::test]
async fn choosing_an_identity_keeps_the_remembered_auth_time() {
    let ctx = TestContext::new().await;
    let (personal, work) = linked_pair(&ctx).await;
    let mut b = Browser::new(&ctx);
    remember(&ctx, &mut b, &personal).await;
    sqlx::query("update browser_sessions set authenticated_at=now()-interval '30 days' where account_uuid=$1")
        .bind(&personal.uuid)
        .execute(&ctx.state.db)
        .await
        .unwrap();
    // First another identity (a new session), then the browser's own one (the same session).
    for _ in 0..2 {
        let flow = new_flow(&ctx, &mut b, "silicon-accounts", json!({})).await;
        assert_choices(&flow, &personal, &work);
        let r = select(&ctx, &mut b, &flow, &work.uuid).await;
        assert_eq!(r.json["flow"]["step"], "complete", "{}", r.json);
        let old: bool = sqlx::query_scalar(
            "select auth_time < now()-interval '29 days' from authorization_codes where flow_id=$1",
        )
        .bind(id_of(&flow))
        .fetch_one(&ctx.state.db)
        .await
        .unwrap();
        assert!(old, "choosing an account is not a new proof");
    }
}
