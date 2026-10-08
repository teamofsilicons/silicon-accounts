//! `GET /v1/me/apps`, `DELETE /v1/me/apps/{app_id}`.

use accounts_core::events::types;
use accounts_core::models::{MembershipSource, Scope};
use accounts_core::repo::memberships::{self, GrantMode};
use accounts_core::test_support::{Req, TestContext};
use serde_json::Value;
use uuid::Uuid;

use crate::common::*;

/// Inserts an active OBO proof family issued by `issuing_app` about `account_uuid`.
async fn obo_proof(
    ctx: &TestContext,
    issuing_app: &str,
    audience: &str,
    account_uuid: &str,
) -> Uuid {
    let id = Uuid::now_v7();
    sqlx::query(
        "insert into proof_families (id, kind, issuing_app, audiences, account_uuid, scopes, access_ttl_seconds, expires_at) \
         values ($1, 'obo', $2, $3, $4, '{files.write}', 600, now() + interval '900 days')",
    )
    .bind(id)
    .bind(issuing_app)
    .bind(vec![audience.to_string()])
    .bind(account_uuid)
    .execute(&ctx.state.db)
    .await
    .expect("proof family");
    id
}

fn app_ids(page: &Value) -> Vec<String> {
    page["items"]
        .as_array()
        .expect("items")
        .iter()
        .map(|i| i["app"]["app_id"].as_str().unwrap_or_default().to_string())
        .collect()
}

#[tokio::test]
async fn lists_the_apps_signed_into() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let active = member_app(&ctx, "active", &carbon, &[Scope::Profile, Scope::Email]).await;
    ctx.tokens_for(&carbon, &active, &[Scope::Profile]).await;
    ctx.tokens_for(&carbon, &active, &[Scope::Profile]).await;
    let (imported, _) = ctx.app("imported").await;
    let removed = member_app(&ctx, "removed", &carbon, &[Scope::Profile]).await;
    let mut conn = ctx.conn().await;
    memberships::upsert_imported(
        &mut conn,
        &imported.app_id,
        &carbon.uuid,
        Some("crm-7"),
        None,
        false,
    )
    .await
    .expect("import");
    memberships::remove_access(&mut conn, &removed, &carbon.uuid, &carbon.uuid)
        .await
        .expect("remove");
    // Signing in to the account site or the developer platform is not "an app you signed into"
    // (neither records a membership; one left behind is still not listed).
    for first_party in [
        accounts_core::FIRST_PARTY_APP_ID,
        accounts_core::DEVELOPER_APP_ID,
    ] {
        memberships::upsert_signin(
            &mut conn,
            first_party,
            &carbon.uuid,
            MembershipSource::Signin,
            &[Scope::Profile],
            GrantMode::Replace,
        )
        .await
        .expect("first-party membership");
    }
    drop(conn);
    ctx.exec(&format!(
        "update memberships set last_signed_in_at = now() - interval '1 day' where app_id = '{removed}'"
    ))
    .await;
    let tok = token(&ctx, &carbon).await;

    let r = call(&ctx, Req::get("/v1/me/apps").bearer(&tok)).await;
    assert_status(&r, 200);
    let ids = app_ids(&r.json);
    assert_eq!(ids.len(), 3, "{}", r.json);
    assert!(!ids.contains(&accounts_core::FIRST_PARTY_APP_ID.to_string()));
    assert!(!ids.contains(&accounts_core::DEVELOPER_APP_ID.to_string()));
    let item = |app: &str| {
        r.json["items"]
            .as_array()
            .and_then(|a| a.iter().find(|i| i["app"]["app_id"] == app))
            .cloned()
            .expect("listed")
    };
    let a = item(&active);
    assert_eq!(a["status"], "active");
    assert_eq!(a["active_sessions"], 2);
    assert_eq!(a["granted_scopes"], serde_json::json!(["profile", "email"]));
    assert_eq!(a["membership_id"], format!("{active}:{}", carbon.uuid));
    assert!(
        a["app"]["name"]
            .as_str()
            .is_some_and(|n| n.starts_with("Test app"))
    );
    assert!(a["first_signed_in_at"].as_str().is_some());
    let i = item(&imported.app_id);
    assert_eq!(i["status"], "imported");
    assert_eq!(i["source"], "import");
    assert_eq!(i["first_signed_in_at"], Value::Null);
    let x = item(&removed);
    assert_eq!(x["status"], "access_removed");
    assert!(x["access_removed_at"].as_str().is_some());

    let r = call(&ctx, Req::get("/v1/me/apps?status=active").bearer(&tok)).await;
    assert_eq!(app_ids(&r.json), vec![active.clone()]);
    let r = call(&ctx, Req::get("/v1/me/apps?status=gone").bearer(&tok)).await;
    assert_error(&r, 400, "invalid_query");

    // Pages follow the cursor without repeats or gaps.
    let r = call(&ctx, Req::get("/v1/me/apps?limit=2").bearer(&tok)).await;
    assert_eq!(app_ids(&r.json).len(), 2);
    let cursor = r.json["next_cursor"]
        .as_str()
        .expect("next page")
        .to_string();
    let r2 = call(
        &ctx,
        Req::get(&format!("/v1/me/apps?limit=2&cursor={cursor}")).bearer(&tok),
    )
    .await;
    assert_status(&r2, 200);
    let mut all = app_ids(&r.json);
    all.extend(app_ids(&r2.json));
    all.sort();
    let mut expected = ids.clone();
    expected.sort();
    assert_eq!(all, expected);
    assert_eq!(r2.json["next_cursor"], Value::Null);
    let r = call(&ctx, Req::get("/v1/me/apps?cursor=bogus").bearer(&tok)).await;
    assert_error(&r, 400, "invalid_cursor");
}

#[tokio::test]
async fn removing_access_revokes_sign_ins_and_proofs() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let app = member_app(&ctx, "briefcase", &carbon, &[Scope::Profile]).await;
    let other_app = member_app(&ctx, "dm", &carbon, &[Scope::Profile]).await;
    let tokens = ctx.tokens_for(&carbon, &app, &[Scope::Profile]).await;
    let other_tokens = ctx.tokens_for(&carbon, &other_app, &[Scope::Profile]).await;
    let issued_by_app = obo_proof(&ctx, &app, &other_app, &carbon.uuid).await;
    let issued_by_other = obo_proof(&ctx, &other_app, &app, &carbon.uuid).await;
    let cookie = ctx.browser_session(&carbon).await;

    let r = call(
        &ctx,
        Req::delete(&format!("/v1/me/apps/{app}")).session(&ctx.state.settings, &cookie),
    )
    .await;
    assert_status(&r, 204);

    let status: String = sqlx::query_scalar(
        "select status from memberships where app_id = $1 and account_uuid = $2",
    )
    .bind(&app)
    .bind(&carbon.uuid)
    .fetch_one(&ctx.state.db)
    .await
    .expect("membership");
    assert_eq!(status, "access_removed");
    let live: Vec<(String, Option<String>)> = sqlx::query_as(
        "select app_id, revoke_reason from token_families where account_uuid = $1 and app_id <> 'accounts' order by app_id",
    )
    .bind(&carbon.uuid)
    .fetch_all(&ctx.state.db)
    .await
    .expect("families");
    for (app_id, reason) in &live {
        if *app_id == app {
            assert_eq!(reason.as_deref(), Some("access_removed"));
        } else {
            assert_eq!(reason, &None, "other apps keep their sign-ins");
        }
    }
    let refresh = accounts_core::repo::tokens::refresh(
        &ctx.state.db,
        &ctx.state.keys,
        &ctx.state.settings,
        &tokens.refresh_token,
        &app,
    )
    .await;
    assert!(refresh.is_err(), "the app's refresh token is dead");
    assert!(
        accounts_core::repo::tokens::refresh(
            &ctx.state.db,
            &ctx.state.keys,
            &ctx.state.settings,
            &other_tokens.refresh_token,
            &other_app,
        )
        .await
        .is_ok()
    );
    let revoked = |id: Uuid| {
        let db = ctx.state.db.clone();
        async move {
            sqlx::query_scalar::<_, bool>(
                "select revoked_at is not null from proof_families where id = $1",
            )
            .bind(id)
            .fetch_one(&db)
            .await
            .expect("proof")
        }
    };
    assert!(
        revoked(issued_by_app).await,
        "proofs the app issued about me are revoked"
    );
    assert!(!revoked(issued_by_other).await);

    let evs = events(&ctx, &app, types::MEMBERSHIP_ACCESS_REMOVED).await;
    assert_eq!(evs.len(), 1);
    assert_eq!(
        evs[0]["data"]["membership_id"],
        format!("{app}:{}", carbon.uuid)
    );
    assert_eq!(evs[0]["data"]["uuid"], carbon.uuid);
    assert_eq!(evs[0]["app_id"], app);
    assert_eq!(
        event_types(&ctx, &app).await,
        vec![types::MEMBERSHIP_ACCESS_REMOVED.to_string()],
        "one event, no separate sign-out notice"
    );

    // Removing again changes nothing and sends nothing.
    let r = call(
        &ctx,
        Req::delete(&format!("/v1/me/apps/{app}")).session(&ctx.state.settings, &cookie),
    )
    .await;
    assert_status(&r, 204);
    assert_eq!(
        events(&ctx, &app, types::MEMBERSHIP_ACCESS_REMOVED)
            .await
            .len(),
        1
    );
    // The app no longer hears about changes to the account.
    let r = call(
        &ctx,
        Req::patch("/v1/me")
            .session(&ctx.state.settings, &cookie)
            .json(serde_json::json!({"display_name": "After Removal"})),
    )
    .await;
    assert_status(&r, 200);
    assert!(events(&ctx, &app, types::ACCOUNT_UPDATED).await.is_empty());
    assert_eq!(
        events(&ctx, &other_app, types::ACCOUNT_UPDATED).await.len(),
        1
    );
}

#[tokio::test]
async fn removing_access_errors() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let tok = token(&ctx, &carbon).await;
    let r = call(&ctx, Req::delete("/v1/me/apps/never-used").bearer(&tok)).await;
    assert_error(&r, 404, "membership_not_found");
    let r = call(&ctx, Req::delete("/v1/me/apps/accounts").bearer(&tok)).await;
    assert_error(&r, 400, "first_party_app");
    let r = call(&ctx, Req::delete("/v1/me/apps/never-used")).await;
    assert_error(&r, 401, "unauthenticated");
}

/// The developer platform (developers.teamofsilicons.com) is first-party like Silicon Accounts
/// itself: while the Carbon is signed in to it, removing it as an app is refused and points at
/// the session to sign out. It once answered 404 "has never signed into an app with the app_id
/// 'developer'", which was false.
#[tokio::test]
async fn removing_the_developer_platform_is_refused_like_silicon_accounts() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let cookie = ctx.browser_session(&carbon).await;
    let developer = ctx
        .tokens_for(&carbon, accounts_core::DEVELOPER_APP_ID, &[Scope::Profile])
        .await;

    let r = call(
        &ctx,
        Req::delete("/v1/me/apps/developer").session(&ctx.state.settings, &cookie),
    )
    .await;
    assert_error(&r, 400, "first_party_app");
    let message = r.json["error"]["message"].as_str().unwrap_or_default();
    assert!(
        message.contains("developers.teamofsilicons.com") && message.contains("Silicon Accounts"),
        "{}",
        r.json
    );
    assert!(
        !message.contains("never signed into"),
        "the Carbon is signed in to it: {}",
        r.json
    );
    assert!(
        r.json["error"]["hint"].as_str().is_some_and(
            |h| h.contains("DELETE /v1/me/sessions/{id}") && h.contains("GET /v1/me/sessions")
        ),
        "{}",
        r.json
    );
    assert_eq!(r.json["error"]["details"]["app_id"], "developer");
    // Silicon Accounts itself names itself, not the developer platform.
    let r = call(
        &ctx,
        Req::delete("/v1/me/apps/accounts").session(&ctx.state.settings, &cookie),
    )
    .await;
    assert_error(&r, 400, "first_party_app");
    assert!(
        !r.json["error"]["message"]
            .as_str()
            .unwrap_or_default()
            .contains("developer"),
        "{}",
        r.json
    );

    // Nothing was touched: the developer site's sign-in is live, and still listed as a session.
    let live: bool = sqlx::query_scalar(
        "select revoked_at is null from token_families where account_uuid = $1 and app_id = 'developer'",
    )
    .bind(&carbon.uuid)
    .fetch_one(&ctx.state.db)
    .await
    .expect("developer family");
    assert!(live && !developer.refresh_token.is_empty());
    let sessions = call(
        &ctx,
        Req::get("/v1/me/sessions").session(&ctx.state.settings, &cookie),
    )
    .await;
    assert!(
        sessions.json["items"]
            .as_array()
            .is_some_and(|items| items.iter().any(|s| s["kind"] == "developer")),
        "{}",
        sessions.json
    );
    assert!(
        event_types(&ctx, accounts_core::DEVELOPER_APP_ID)
            .await
            .is_empty(),
        "no webhook event for a first-party app"
    );
}
