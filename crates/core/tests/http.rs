//! HTTP extractors end to end through a router: account auth (cookie + CSRF guard, Bearer with
//! audience and revocation), kind guards, app auth, app-or-owner, JSON errors and request ids.

use accounts_core::http::request_id;
use accounts_core::http::{
    AccountAuth, AppAuth, AppOrOwner, CarbonAuth, ClientMeta, Json, SiliconAuth,
};
use accounts_core::models::Scope;
use accounts_core::test_support::{Req, TestContext};
use accounts_core::{ApiError, AppState};
use axum::Router;
use axum::routing::{get, post};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Deserialize)]
struct Echo {
    name: String,
}

fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/me",
            get(|a: AccountAuth| async move {
                Json(json!({"uuid": a.uuid(), "cookie": a.is_cookie()}))
            })
            .post(|a: AccountAuth| async move { Json(json!({"uuid": a.uuid()})) }),
        )
        .route(
            "/carbon",
            get(|a: CarbonAuth| async move { Json(json!({"uuid": a.uuid()})) }),
        )
        .route(
            "/silicon",
            get(|a: SiliconAuth| async move { Json(json!({"uuid": a.uuid()})) }),
        )
        .route(
            "/optional",
            get(|a: Option<AccountAuth>| async move {
                Json(json!({"uuid": a.map(|a| a.account.uuid)}))
            }),
        )
        .route(
            "/app",
            get(|a: AppAuth| async move { Json(json!({"app_id": a.app.app_id})) }),
        )
        .route(
            "/v1/apps/{app_id}/thing",
            get(|a: AppOrOwner| async move {
                Json(json!({"app_id": a.app.app_id, "actor": a.history_actor()}))
            }),
        )
        .route(
            "/echo",
            post(|Json(b): Json<Echo>| async move { Json(json!({"name": b.name})) }),
        )
        .route(
            "/meta",
            get(|m: ClientMeta| async move { Json(json!({"ip": m.ip, "tz": m.ip_timezone})) }),
        )
        .route(
            "/boom",
            get(|| async { Err::<Json<Value>, _>(ApiError::internal("test failure detail")) }),
        )
        .layer(axum::middleware::from_fn(request_id::middleware))
}

#[tokio::test]
async fn bearer_tokens_must_be_first_party_and_live() {
    let ctx = TestContext::new().await;
    let c = ctx.carbon().await;
    let first_party = ctx.first_party_tokens(&c).await;
    let r = ctx
        .call(router(), Req::get("/me").bearer(&first_party.access_token))
        .await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(r.json["uuid"], c.uuid);
    assert_eq!(r.json["cookie"], false);
    // Bearer-authenticated mutations don't need an Origin.
    let r = ctx
        .call(router(), Req::post("/me").bearer(&first_party.access_token))
        .await;
    assert_eq!(r.status, 200);

    // A token issued to another app can't be used on account endpoints.
    let (app, _) = ctx.app("briefcase").await;
    let app_token = ctx.tokens_for(&c, &app.app_id, &[Scope::Profile]).await;
    let r = ctx
        .call(router(), Req::get("/me").bearer(&app_token.access_token))
        .await;
    assert_eq!(r.status, 401);
    assert_eq!(r.error_code(), Some("token_wrong_audience"));
    assert!(
        r.json["error"]["hint"]
            .as_str()
            .is_some_and(|h| h.contains("silicon-accounts login"))
    );

    // No credentials → 401 with guidance; optional auth → anonymous.
    let r = ctx.call(router(), Req::get("/me")).await;
    assert_eq!(r.status, 401);
    assert_eq!(r.error_code(), Some("unauthenticated"));
    let r = ctx.call(router(), Req::get("/optional")).await;
    assert_eq!(r.json["uuid"], Value::Null);
    // A broken Bearer is never silently ignored, even where auth is optional.
    let r = ctx
        .call(router(), Req::get("/optional").bearer("eyJnot.a.jwt"))
        .await;
    assert_eq!(r.status, 401);

    // Revoked families stop working immediately.
    let mut conn = ctx.conn().await;
    accounts_core::repo::tokens::revoke_families(
        &mut conn,
        &accounts_core::repo::tokens::RevokeFilter {
            account_uuid: &c.uuid,
            ..Default::default()
        },
        "user_signed_out",
    )
    .await
    .expect("revoke");
    let r = ctx
        .call(router(), Req::get("/me").bearer(&first_party.access_token))
        .await;
    assert_eq!(r.error_code(), Some("token_revoked"));
}

#[tokio::test]
async fn cookie_sessions_need_a_site_origin_for_mutations() {
    let ctx = TestContext::new().await;
    let c = ctx.carbon().await;
    let cookie = ctx.browser_session(&c).await;
    let settings = ctx.state.settings.clone();
    let r = ctx
        .call(router(), Req::get("/me").session(&settings, &cookie))
        .await;
    assert_eq!(r.status, 200);
    assert_eq!(r.json["cookie"], true);
    let r = ctx
        .call(router(), Req::post("/me").session(&settings, &cookie))
        .await;
    assert_eq!(r.status, 200, "same-origin POST passes");

    let r = ctx
        .call(
            router(),
            Req::post("/me")
                .header("cookie", &format!("sa_session={cookie}"))
                .header("origin", "https://evil.test"),
        )
        .await;
    assert_eq!(r.status, 403);
    assert_eq!(r.error_code(), Some("origin_not_allowed"));
    let r = ctx
        .call(
            router(),
            Req::post("/me").header("cookie", &format!("sa_session={cookie}")),
        )
        .await;
    assert_eq!(
        r.error_code(),
        Some("origin_not_allowed"),
        "a missing Origin is refused too"
    );

    // A dead cookie: 401 where auth is required, anonymous where it is optional.
    let r = ctx
        .call(
            router(),
            Req::get("/me").header("cookie", "sa_session=sas_dead"),
        )
        .await;
    assert_eq!(r.error_code(), Some("session_expired"));
    let r = ctx
        .call(
            router(),
            Req::get("/optional").header("cookie", "sa_session=sas_dead"),
        )
        .await;
    assert_eq!(r.status, 200);
    assert_eq!(r.json["uuid"], Value::Null);
}

#[tokio::test]
async fn kind_guards() {
    let ctx = TestContext::new().await;
    let c = ctx.carbon().await;
    let (s, _) = ctx.silicon(&c.uuid).await;
    let ct = ctx.first_party_tokens(&c).await.access_token;
    let st = ctx.first_party_tokens(&s).await.access_token;
    assert_eq!(
        ctx.call(router(), Req::get("/carbon").bearer(&ct))
            .await
            .status,
        200
    );
    let r = ctx.call(router(), Req::get("/carbon").bearer(&st)).await;
    assert_eq!(
        (r.status.as_u16(), r.error_code()),
        (403, Some("carbon_only"))
    );
    assert_eq!(
        ctx.call(router(), Req::get("/silicon").bearer(&st))
            .await
            .status,
        200
    );
    let r = ctx.call(router(), Req::get("/silicon").bearer(&ct)).await;
    assert_eq!(
        (r.status.as_u16(), r.error_code()),
        (403, Some("silicon_only"))
    );
}

#[tokio::test]
async fn app_credentials_and_owners() {
    let ctx = TestContext::new().await;
    let owner = ctx.carbon().await;
    let stranger = ctx.carbon().await;
    let (app, secret) = ctx.app_owned("ledgerly", Some(&owner.uuid)).await;
    let (other, other_secret) = ctx.app("other").await;

    let r = ctx
        .call(router(), Req::get("/app").basic(&app.app_id, &secret))
        .await;
    assert_eq!(r.json["app_id"], app.app_id);
    // Cached second call.
    let r = ctx
        .call(router(), Req::get("/app").basic(&app.app_id, &secret))
        .await;
    assert_eq!(r.status, 200);
    let r = ctx
        .call(
            router(),
            Req::get("/app").basic(&app.app_id, "sa_app_wrong"),
        )
        .await;
    assert_eq!(
        (r.status.as_u16(), r.error_code()),
        (401, Some("invalid_app_credentials"))
    );
    let r = ctx
        .call(router(), Req::get("/app").basic("nope-app", "x"))
        .await;
    assert_eq!(r.status, 401);
    let r = ctx.call(router(), Req::get("/app")).await;
    assert_eq!(r.error_code(), Some("app_credentials_required"));

    let path = format!("/v1/apps/{}/thing", app.app_id);
    let r = ctx
        .call(router(), Req::get(&path).basic(&app.app_id, &secret))
        .await;
    assert_eq!(r.json["actor"], "app");
    let r = ctx
        .call(
            router(),
            Req::get(&path).basic(&other.app_id, &other_secret),
        )
        .await;
    assert_eq!(
        (r.status.as_u16(), r.error_code()),
        (403, Some("app_mismatch"))
    );
    let owner_token = ctx.first_party_tokens(&owner).await.access_token;
    let r = ctx
        .call(router(), Req::get(&path).bearer(&owner_token))
        .await;
    assert_eq!(r.json["actor"], owner.uuid);
    let stranger_token = ctx.first_party_tokens(&stranger).await.access_token;
    let r = ctx
        .call(router(), Req::get(&path).bearer(&stranger_token))
        .await;
    assert_eq!(
        (r.status.as_u16(), r.error_code()),
        (403, Some("not_app_owner"))
    );
    let r = ctx
        .call(
            router(),
            Req::get("/v1/apps/missing-app/thing").bearer(&owner_token),
        )
        .await;
    assert_eq!(
        (r.status.as_u16(), r.error_code()),
        (404, Some("unknown_app"))
    );

    // Disabled apps can't use their credentials. Verified credentials are cached for 60 s, so
    // whoever changes an app's status or secret must invalidate the cache.
    ctx.exec(&format!(
        "update apps set status = 'disabled' where app_id = '{}'",
        other.app_id
    ))
    .await;
    let r = ctx
        .call(
            router(),
            Req::get("/app").basic(&other.app_id, &other_secret),
        )
        .await;
    assert_eq!(r.status, 200, "still cached");
    ctx.state.app_cache.invalidate(&other.app_id);
    let r = ctx
        .call(
            router(),
            Req::get("/app").basic(&other.app_id, &other_secret),
        )
        .await;
    assert_eq!(
        (r.status.as_u16(), r.error_code()),
        (403, Some("app_disabled"))
    );
}

#[tokio::test]
async fn json_errors_request_ids_and_meta() {
    let ctx = TestContext::new().await;
    let r = ctx
        .call(router(), Req::post("/echo").json(json!({"name": "x"})))
        .await;
    assert_eq!(r.json["name"], "x");
    let id = r
        .headers
        .get("x-request-id")
        .and_then(|v| v.to_str().ok())
        .expect("request id");
    assert_eq!(id.len(), 36);

    let r = ctx
        .call(
            router(),
            Req::post("/echo")
                .json(json!({"nom": "x"}))
                .header("x-request-id", "req-123"),
        )
        .await;
    assert_eq!(r.status, 422);
    assert_eq!(
        r.json["error"]["details"]["fields"]["name"],
        "missing field `name`"
    );
    assert_eq!(
        r.headers.get("x-request-id").and_then(|v| v.to_str().ok()),
        Some("req-123")
    );

    let r = ctx
        .call(
            router(),
            Req::get("/boom").header("x-request-id", "req-boom"),
        )
        .await;
    assert_eq!(r.status, 500);
    assert_eq!(r.json["error"]["code"], "internal");
    assert_eq!(r.json["error"]["details"]["request_id"], "req-boom");
    assert!(
        !r.json.to_string().contains("test failure detail"),
        "internals never leak"
    );

    let r = ctx
        .call(
            router(),
            Req::get("/meta").header("x-vercel-ip-timezone", "Asia/Kolkata"),
        )
        .await;
    assert_eq!(r.json["tz"], "Asia/Kolkata");
}
