//! Developer platform tokens (`aud = developer`): they act for the Carbon they belong to only
//! on `GET /v1/me`, `GET /v1/session`, `GET /v1/me/owned-apps` and the owner routes of apps
//! (`AppOrOwner`); everything else answers 401 `token_wrong_audience`.

use accounts_core::http::{AccountAuth, AppOrOwner, CarbonAuth, request_id};
use accounts_core::models::Scope;
use accounts_core::test_support::{Req, TestContext};
use accounts_core::{AppState, http::Json};
use axum::Router;
use axum::routing::get;
use serde_json::json;

fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/v1/me",
            get(|a: AccountAuth| async move { Json(json!({"uuid": a.uuid()})) })
                .patch(|a: AccountAuth| async move { Json(json!({"uuid": a.uuid()})) }),
        )
        .route(
            "/v1/session",
            get(|a: AccountAuth| async move { Json(json!({"uuid": a.uuid()})) }),
        )
        .route(
            "/v1/me/owned-apps",
            get(|a: CarbonAuth| async move { Json(json!({"uuid": a.uuid()})) }),
        )
        .route(
            "/v1/me/emails",
            get(|a: CarbonAuth| async move { Json(json!({"uuid": a.uuid()})) }),
        )
        .route(
            "/v1/ids/available",
            get(|a: Option<AccountAuth>| async move {
                Json(json!({"uuid": a.map(|a| a.account.uuid)}))
            }),
        )
        .route(
            "/v1/apps/{app_id}/thing",
            get(|a: AppOrOwner| async move {
                Json(json!({"app_id": a.app.app_id, "actor": a.history_actor()}))
            })
            .post(|a: AppOrOwner| async move { Json(json!({"app_id": a.app.app_id})) }),
        )
        .layer(axum::middleware::from_fn(request_id::middleware))
}

#[tokio::test]
async fn developer_tokens_read_identity_and_manage_owned_apps_only() {
    let ctx = TestContext::new().await;
    let owner = ctx.carbon().await;
    let (owned, _) = ctx.app_owned("ledgerly", Some(&owner.uuid)).await;
    let (theirs, _) = ctx.app("briefcase").await;
    let dev = ctx
        .tokens_for(&owner, accounts_core::DEVELOPER_APP_ID, &[Scope::Profile])
        .await
        .access_token;

    for path in ["/v1/me", "/v1/session", "/v1/me/owned-apps"] {
        let r = ctx.call(router(), Req::get(path).bearer(&dev)).await;
        assert_eq!(r.status, 200, "{path}: {}", r.json);
        assert_eq!(r.json["uuid"], owner.uuid, "{path}");
    }
    // Every owner route of an app the Carbon owns, reads and writes.
    let path = format!("/v1/apps/{}/thing", owned.app_id);
    let r = ctx.call(router(), Req::get(&path).bearer(&dev)).await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(r.json["actor"], owner.uuid);
    let r = ctx.call(router(), Req::post(&path).bearer(&dev)).await;
    assert_eq!(r.status, 200, "{}", r.json);
    // …but not another Carbon's app.
    let r = ctx
        .call(
            router(),
            Req::get(&format!("/v1/apps/{}/thing", theirs.app_id)).bearer(&dev),
        )
        .await;
    assert_eq!(r.status, 403);
    assert_eq!(r.error_code(), Some("not_app_owner"));

    // Everything else is refused precisely, even where auth is optional.
    for req in [
        Req::patch("/v1/me").json(json!({"display_name": "x"})),
        Req::get("/v1/me/emails"),
        Req::get("/v1/ids/available?id=c:x"),
    ] {
        let r = ctx.call(router(), req.bearer(&dev)).await;
        assert_eq!(r.status, 401, "{}", r.json);
        assert_eq!(r.error_code(), Some("token_wrong_audience"));
        let message = r.json["error"]["message"].as_str().unwrap_or_default();
        assert!(message.contains("developer platform"), "{message}");
        assert!(
            r.json["error"]["hint"]
                .as_str()
                .is_some_and(|h| h.contains("silicon-accounts login")),
            "{}",
            r.json
        );
        assert_eq!(r.json["error"]["details"]["aud"], "developer");
    }
    let r = ctx
        .call(router(), Req::patch("/v1/me").bearer(&dev).json(json!({})))
        .await;
    assert!(
        r.json["error"]["message"]
            .as_str()
            .is_some_and(|m| m.contains("PATCH /v1/me")),
        "names the refused route: {}",
        r.json
    );

    // First-party tokens keep working everywhere; other apps' tokens nowhere.
    let fp = ctx.first_party_tokens(&owner).await.access_token;
    for req in [
        Req::get("/v1/me"),
        Req::patch("/v1/me").json(json!({})),
        Req::get("/v1/me/emails"),
        Req::get(&path),
    ] {
        let r = ctx.call(router(), req.bearer(&fp)).await;
        assert_eq!(r.status, 200, "{}", r.json);
    }
    let app_token = ctx
        .tokens_for(&owner, &theirs.app_id, &[Scope::Profile])
        .await
        .access_token;
    let r = ctx
        .call(router(), Req::get("/v1/me").bearer(&app_token))
        .await;
    assert_eq!(r.status, 401);
    assert_eq!(r.error_code(), Some("token_wrong_audience"));
    assert!(
        r.json["error"]["message"]
            .as_str()
            .is_some_and(|m| m.contains("'silicon-accounts' (or 'developer')")),
        "{}",
        r.json
    );
    let r = ctx
        .call(router(), Req::get("/v1/me/emails").bearer(&app_token))
        .await;
    assert!(
        r.json["error"]["message"]
            .as_str()
            .is_some_and(|m| m.ends_with("issued to 'silicon-accounts'.")),
        "{}",
        r.json
    );
    let r = ctx.call(router(), Req::get(&path).bearer(&app_token)).await;
    assert_eq!(r.status, 401);
    assert_eq!(r.error_code(), Some("token_wrong_audience"));

    // A revoked developer platform sign-in stops working at once.
    let mut conn = ctx.conn().await;
    accounts_core::repo::tokens::revoke_families(
        &mut conn,
        &accounts_core::repo::tokens::RevokeFilter {
            account_uuid: &owner.uuid,
            app_id: Some(accounts_core::DEVELOPER_APP_ID),
            ..Default::default()
        },
        "user_signed_out",
    )
    .await
    .expect("revoke");
    drop(conn);
    let r = ctx.call(router(), Req::get("/v1/me").bearer(&dev)).await;
    assert_eq!(r.error_code(), Some("token_revoked"));
}

#[tokio::test]
async fn developer_portal_coauthors_have_the_same_app_boundary_as_owners() {
    let ctx = TestContext::new().await;
    let owner = ctx.carbon().await;
    let author = ctx.carbon().await;
    let (app, _) = ctx.app_owned("shared-portal-app", Some(&owner.uuid)).await;
    let token = ctx
        .tokens_for(&author, accounts_core::DEVELOPER_APP_ID, &[Scope::Profile])
        .await
        .access_token;
    let path = format!("/v1/apps/{}/thing", app.app_id);
    let response = ctx.call(router(), Req::post(&path).bearer(&token)).await;
    assert_eq!(response.status, 403, "{}", response.json);
    let mut conn = ctx.conn().await;
    sqlx::query("insert into app_authors(app_id,account_uuid) values($1,$2)")
        .bind(&app.app_id)
        .bind(&author.uuid)
        .execute(&mut *conn)
        .await
        .expect("add author");
    drop(conn);
    for request in [Req::get(&path), Req::post(&path)] {
        let response = ctx.call(router(), request.bearer(&token)).await;
        assert_eq!(response.status, 200, "{}", response.json);
    }
    let mut conn = ctx.conn().await;
    sqlx::query("delete from app_authors where app_id=$1 and account_uuid=$2")
        .bind(&app.app_id)
        .bind(&author.uuid)
        .execute(&mut *conn)
        .await
        .expect("remove author");
    drop(conn);
    let response = ctx.call(router(), Req::get(&path).bearer(&token)).await;
    assert_eq!(response.status, 403, "{}", response.json);
}
