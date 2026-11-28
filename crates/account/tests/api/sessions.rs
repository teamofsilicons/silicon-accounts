//! `GET /v1/me/sessions`, `DELETE /v1/me/sessions/{id}`.

use accounts_core::models::Scope;
use accounts_core::test_support::{Req, TestContext};
use serde_json::Value;

use crate::common::*;

fn sessions_of(page: &Value) -> Vec<Value> {
    page["items"].as_array().cloned().expect("items")
}

#[tokio::test]
async fn lists_browser_and_cli_sessions_and_marks_the_current_one() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let cookie = ctx.browser_session(&carbon).await;
    let tok = token(&ctx, &carbon).await;
    // Another app's sign-in is not a Silicon Accounts session.
    let (app, _) = ctx.app("elsewhere").await;
    ctx.tokens_for(&carbon, &app.app_id, &[Scope::Profile])
        .await;

    let r = call(
        &ctx,
        Req::get("/v1/me/sessions").session(&ctx.state.settings, &cookie),
    )
    .await;
    assert_status(&r, 200);
    let items = sessions_of(&r.json);
    assert_eq!(items.len(), 2, "{}", r.json);
    let browser = items
        .iter()
        .find(|s| s["kind"] == "browser")
        .expect("browser");
    let cli = items.iter().find(|s| s["kind"] == "cli").expect("cli");
    assert_eq!(browser["current"], true);
    assert_eq!(browser["ip"], "127.0.0.1");
    assert_eq!(cli["current"], false);
    assert_eq!(cli["label"], "test");
    assert_eq!(cli["origin"], "cli_code");
    assert!(cli["expires_at"].as_str().is_some());

    let r = call(&ctx, Req::get("/v1/me/sessions").bearer(&tok)).await;
    let items = sessions_of(&r.json);
    assert_eq!(
        items.iter().find(|s| s["kind"] == "cli").expect("cli")["current"],
        true
    );
    assert_eq!(
        items
            .iter()
            .find(|s| s["kind"] == "browser")
            .expect("browser")["current"],
        false
    );

    // Pagination across both kinds.
    for _ in 0..3 {
        ctx.browser_session(&carbon).await;
        ctx.first_party_tokens(&carbon).await;
    }
    let mut seen = Vec::new();
    let mut cursor: Option<String> = None;
    for _ in 0..10 {
        let path = match &cursor {
            Some(c) => format!("/v1/me/sessions?limit=3&cursor={c}"),
            None => "/v1/me/sessions?limit=3".to_string(),
        };
        let r = call(&ctx, Req::get(&path).bearer(&tok)).await;
        assert_status(&r, 200);
        for s in sessions_of(&r.json) {
            seen.push(s["id"].as_str().expect("id").to_string());
        }
        match r.json["next_cursor"].as_str() {
            Some(c) => cursor = Some(c.to_string()),
            None => break,
        }
    }
    let total = seen.len();
    seen.sort();
    seen.dedup();
    assert_eq!((total, seen.len()), (8, 8), "every session exactly once");
}

#[tokio::test]
async fn revoking_sessions_signs_them_out() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let cookie = ctx.browser_session(&carbon).await;
    let tok = token(&ctx, &carbon).await;
    let listed = call(&ctx, Req::get("/v1/me/sessions").bearer(&tok)).await;
    let id_of = |kind: &str| {
        sessions_of(&listed.json)
            .into_iter()
            .find(|s| s["kind"] == kind)
            .and_then(|s| s["id"].as_str().map(str::to_string))
            .expect("session id")
    };
    let browser_id = id_of("browser");
    let cli_id = id_of("cli");

    // The CLI revokes the browser session: the cookie stops working.
    let r = call(
        &ctx,
        Req::delete(&format!("/v1/me/sessions/{browser_id}")).bearer(&tok),
    )
    .await;
    assert_status(&r, 204);
    assert!(
        r.headers.get("set-cookie").is_none(),
        "not the caller's own cookie"
    );
    let r = call(
        &ctx,
        Req::get("/v1/me").session(&ctx.state.settings, &cookie),
    )
    .await;
    assert_error(&r, 401, "session_expired");

    // A new browser session revokes the CLI sign-in: the token stops working.
    let cookie2 = ctx.browser_session(&carbon).await;
    let r = call(
        &ctx,
        Req::delete(&format!("/v1/me/sessions/{cli_id}")).session(&ctx.state.settings, &cookie2),
    )
    .await;
    assert_status(&r, 204);
    let r = call(&ctx, Req::get("/v1/me").bearer(&tok)).await;
    assert_error(&r, 401, "token_revoked");

    // Revoking the session making the request signs it out and clears the cookie.
    let own = call(
        &ctx,
        Req::get("/v1/me/sessions").session(&ctx.state.settings, &cookie2),
    )
    .await;
    let own_id = sessions_of(&own.json)
        .into_iter()
        .find(|s| s["current"] == true)
        .and_then(|s| s["id"].as_str().map(str::to_string))
        .expect("current session");
    let r = call(
        &ctx,
        Req::delete(&format!("/v1/me/sessions/{own_id}")).session(&ctx.state.settings, &cookie2),
    )
    .await;
    assert_status(&r, 204);
    let set_cookie = r
        .headers
        .get("set-cookie")
        .and_then(|v| v.to_str().ok())
        .expect("cookie cleared");
    assert!(set_cookie.starts_with("sa_session=") && set_cookie.contains("Max-Age=0"));
}

#[tokio::test]
async fn only_your_own_first_party_sessions_can_be_revoked() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let other = ctx.carbon().await;
    let tok = token(&ctx, &carbon).await;
    let other_tok = token(&ctx, &other).await;
    let other_sessions = call(&ctx, Req::get("/v1/me/sessions").bearer(&other_tok)).await;
    let other_id = sessions_of(&other_sessions.json)[0]["id"]
        .as_str()
        .expect("id")
        .to_string();
    let r = call(
        &ctx,
        Req::delete(&format!("/v1/me/sessions/{other_id}")).bearer(&tok),
    )
    .await;
    assert_error(&r, 404, "session_not_found");
    let r = call(&ctx, Req::get("/v1/me").bearer(&other_tok)).await;
    assert_status(&r, 200);

    let (app, _) = ctx.app("elsewhere").await;
    ctx.tokens_for(&carbon, &app.app_id, &[Scope::Profile])
        .await;
    let app_family: String =
        sqlx::query_scalar("select id::text from token_families where app_id = $1")
            .bind(&app.app_id)
            .fetch_one(&ctx.state.db)
            .await
            .expect("family");
    let r = call(
        &ctx,
        Req::delete(&format!("/v1/me/sessions/{app_family}")).bearer(&tok),
    )
    .await;
    assert_error(&r, 404, "session_not_found");
    let r = call(&ctx, Req::delete("/v1/me/sessions/not-a-uuid").bearer(&tok)).await;
    assert_error(&r, 404, "session_not_found");
}

/// Sign-ins to the developer platform (developers.teamofsilicons.com, aud = developer) are
/// sessions of Silicon Accounts too: listed, named, and ended from the account site.
#[tokio::test]
async fn developer_platform_sign_ins_are_listed_and_can_be_signed_out() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let cookie = ctx.browser_session(&carbon).await;
    let developer = ctx
        .tokens_for(&carbon, accounts_core::DEVELOPER_APP_ID, &[Scope::Profile])
        .await;

    let r = call(
        &ctx,
        Req::get("/v1/me/sessions").session(&ctx.state.settings, &cookie),
    )
    .await;
    assert_status(&r, 200);
    let items = sessions_of(&r.json);
    assert_eq!(items.len(), 2, "{}", r.json);
    let dev = items
        .iter()
        .find(|s| s["kind"] == "developer")
        .expect("developer platform session");
    assert_eq!(
        dev["label"], "Silicon Developer (developers.teamofsilicons.com)",
        "{dev}"
    );
    assert_eq!(dev["current"], false);
    let dev_id = dev["id"].as_str().expect("id").to_string();

    let r = call(
        &ctx,
        Req::delete(&format!("/v1/me/sessions/{dev_id}")).session(&ctx.state.settings, &cookie),
    )
    .await;
    assert_status(&r, 204);
    let revoked: Option<time::OffsetDateTime> =
        sqlx::query_scalar("select revoked_at from token_families where id = $1::uuid")
            .bind(&dev_id)
            .fetch_one(&ctx.state.db)
            .await
            .expect("family");
    assert!(
        revoked.is_some(),
        "the developer platform's refresh token stops working"
    );
    assert!(!developer.refresh_token.is_empty());

    let r = call(
        &ctx,
        Req::get("/v1/me/sessions").session(&ctx.state.settings, &cookie),
    )
    .await;
    assert!(
        sessions_of(&r.json)
            .iter()
            .all(|s| s["kind"] != "developer"),
        "{}",
        r.json
    );
}

/// "Keep" on Home's "Still using …?" is stored on the sign-in itself, so every browser stops
/// asking (Anil, 2026-11-26). Only your own live sign-ins can be kept.
#[tokio::test]
async fn keeping_a_sign_in_is_recorded_on_it() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let other = ctx.carbon().await;
    let cookie = ctx.browser_session(&carbon).await;
    let tok = token(&ctx, &carbon).await;
    let other_tok = token(&ctx, &other).await;
    let listed = call(&ctx, Req::get("/v1/me/sessions").bearer(&tok)).await;
    for s in sessions_of(&listed.json) {
        assert!(s["kept_at"].is_null(), "{s}");
    }
    let id_of = |kind: &str| {
        sessions_of(&listed.json)
            .into_iter()
            .find(|s| s["kind"] == kind)
            .and_then(|s| s["id"].as_str().map(str::to_string))
            .expect("session id")
    };
    for id in [id_of("browser"), id_of("cli")] {
        let r = call(
            &ctx,
            Req::post(&format!("/v1/me/sessions/{id}/keep")).bearer(&tok),
        )
        .await;
        assert_status(&r, 204);
    }
    let r = call(
        &ctx,
        Req::get("/v1/me/sessions").session(&ctx.state.settings, &cookie),
    )
    .await;
    for s in sessions_of(&r.json) {
        assert!(s["kept_at"].as_str().is_some(), "{s}");
    }

    // Someone else's sign-in, an unknown id and a signed-out one are not found.
    let browser_id = id_of("browser");
    let r = call(
        &ctx,
        Req::post(&format!("/v1/me/sessions/{browser_id}/keep")).bearer(&other_tok),
    )
    .await;
    assert_error(&r, 404, "session_not_found");
    let r = call(
        &ctx,
        Req::post("/v1/me/sessions/not-a-uuid/keep").bearer(&tok),
    )
    .await;
    assert_error(&r, 404, "session_not_found");
    let r = call(
        &ctx,
        Req::delete(&format!("/v1/me/sessions/{browser_id}")).bearer(&tok),
    )
    .await;
    assert_status(&r, 204);
    let r = call(
        &ctx,
        Req::post(&format!("/v1/me/sessions/{browser_id}/keep")).bearer(&tok),
    )
    .await;
    assert_error(&r, 404, "session_not_found");
}

/// A browser session ends 60 days after its last use, within its 900-day limit (Anil, 2026-11-26).
#[tokio::test]
async fn browser_sessions_end_after_sixty_days_unused() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let cookie = ctx.browser_session(&carbon).await;
    let id: uuid::Uuid = sqlx::query_scalar(
        "select id from browser_sessions where account_uuid = $1 order by created_at desc limit 1",
    )
    .bind(&carbon.uuid)
    .fetch_one(&ctx.state.db)
    .await
    .expect("session");
    let days_left = |ctx: &TestContext| {
        let db = ctx.state.db.clone();
        async move {
            sqlx::query_scalar::<_, f64>(
                "select extract(epoch from expires_at - now())::float8 / 86400 from browser_sessions where id = $1",
            )
            .bind(id)
            .fetch_one(&db)
            .await
            .expect("expires_at")
        }
    };
    let left = days_left(&ctx).await;
    assert!((59.9..=60.0).contains(&left), "new session: {left} days");

    // Used again after a quiet week: 60 days from now again.
    sqlx::query("update browser_sessions set last_seen_at = now() - interval '7 days', expires_at = now() + interval '53 days' where id = $1")
        .bind(id)
        .execute(&ctx.state.db)
        .await
        .expect("age");
    let r = call(
        &ctx,
        Req::get("/v1/me").session(&ctx.state.settings, &cookie),
    )
    .await;
    assert_status(&r, 200);
    let left = days_left(&ctx).await;
    assert!((59.9..=60.0).contains(&left), "after use: {left} days");

    // Never past 900 days from its creation.
    sqlx::query("update browser_sessions set created_at = now() - interval '880 days', last_seen_at = now() - interval '1 day' where id = $1")
        .bind(id)
        .execute(&ctx.state.db)
        .await
        .expect("age");
    let r = call(
        &ctx,
        Req::get("/v1/me").session(&ctx.state.settings, &cookie),
    )
    .await;
    assert_status(&r, 200);
    let left = days_left(&ctx).await;
    assert!((19.9..=20.0).contains(&left), "near the limit: {left} days");

    // Unused past its 60 days: signed out.
    sqlx::query(
        "update browser_sessions set expires_at = now() - interval '1 second' where id = $1",
    )
    .bind(id)
    .execute(&ctx.state.db)
    .await
    .expect("expire");
    let r = call(
        &ctx,
        Req::get("/v1/me").session(&ctx.state.settings, &cookie),
    )
    .await;
    assert_error(&r, 401, "session_expired");
}
