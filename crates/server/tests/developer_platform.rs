//! The developer platform (developers.teamofsilicons.com) against the composed service router:
//! what its tokens (`aud = developer`) may do on the real routes, and the start-up upkeep of its
//! first-party app.

use accounts_core::models::Scope;
use accounts_core::test_support::{Req, Resp, TestContext, call};
use accounts_server::first_party::{DeveloperSync, sync_developer_app};
use serde_json::{Value, json};

async fn send(ctx: &TestContext, req: Req) -> Resp {
    call(accounts_server::build_router(ctx.state.clone()), req).await
}

#[tokio::test]
async fn developer_tokens_read_the_carbon_and_manage_their_apps_only() {
    let ctx = TestContext::new().await;
    let owner = ctx.carbon().await;
    let (app, _) = ctx.app_owned("ledgerly", Some(&owner.uuid)).await;
    let (remind, _) = ctx.app("remind").await;
    let dev = ctx
        .tokens_for(&owner, accounts_core::DEVELOPER_APP_ID, &[Scope::Profile])
        .await
        .access_token;
    let base = format!("/v1/apps/{}", app.app_id);

    // Identity reads.
    let r = send(&ctx, Req::get("/v1/me").bearer(&dev)).await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(r.json["uuid"], owner.uuid);
    let r = send(&ctx, Req::get("/v1/session").bearer(&dev)).await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(r.json["account"]["uuid"], owner.uuid);
    assert_eq!(r.json["session"]["kind"], "token");
    let r = send(&ctx, Req::get("/v1/me/owned-apps").bearer(&dev)).await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert!(
        r.json["items"]
            .as_array()
            .is_some_and(|items| items.iter().any(|i| i["app_id"] == app.app_id.as_str())),
        "{}",
        r.json
    );
    let r = send(&ctx, Req::get("/v1/meta").bearer(&dev)).await;
    assert_eq!(r.status, 200);
    assert_eq!(r.json["developer_url"], "http://localhost:8600");

    // The owner routes of the app: details, history, user base, proofs (read and write).
    for path in [
        base.clone(),
        format!("{base}/signin-config/history"),
        format!("{base}/users"),
        format!("{base}/proofs"),
        format!("{base}/imports"),
        format!("{base}/webhook/deliveries"),
    ] {
        let r = send(&ctx, Req::get(&path).bearer(&dev)).await;
        assert_eq!(r.status, 200, "GET {path}: {}", r.json);
    }
    let r = send(
        &ctx,
        Req::post(&format!("{base}/proofs/app-verification"))
            .bearer(&dev)
            .json(json!({"receiving_app": remind.app_id})),
    )
    .await;
    assert_eq!(r.status, 201, "{}", r.json);
    assert_eq!(r.json["receiving_app"], remind.app_id);
    let proof_id = r.json["proof_id"].as_str().unwrap_or_default().to_string();
    let r = send(
        &ctx,
        Req::delete(&format!("{base}/proofs/{proof_id}")).bearer(&dev),
    )
    .await;
    assert_eq!(r.status, 204, "{}", r.json);
    // Another Carbon's app stays closed.
    let r = send(
        &ctx,
        Req::get(&format!("/v1/apps/{}", remind.app_id)).bearer(&dev),
    )
    .await;
    assert_eq!(r.status, 403);
    assert_eq!(r.error_code(), Some("not_app_owner"));

    // Everything about the account itself is refused with a precise 401.
    let refused: Vec<Req> = vec![
        Req::patch("/v1/me").json(json!({"display_name": "Hijacked"})),
        Req::post("/v1/me/id").json(json!({"id": "c:hijacked"})),
        Req::get("/v1/me/emails"),
        Req::post("/v1/me/emails").json(json!({"email": "x@example.test"})),
        Req::get("/v1/me/apps"),
        Req::get("/v1/me/proofs"),
        Req::get("/v1/me/sessions"),
        Req::get("/v1/me/history"),
        Req::get("/v1/me/silicons"),
        Req::post("/v1/me/silicons").json(json!({"id": "si:sneaky", "display_name": "Sneaky"})),
        Req::post("/v1/me/short-lived-tokens").json(json!({"app_id": remind.app_id})),
        Req::post("/v1/session/signout"),
        Req::delete("/v1/me").json(json!({"confirm": owner.id()})),
    ];
    for req in refused {
        let r = send(&ctx, req.bearer(&dev)).await;
        assert_eq!(r.status, 401, "{}", r.json);
        assert_eq!(r.error_code(), Some("token_wrong_audience"), "{}", r.json);
        assert!(
            r.json["error"]["message"]
                .as_str()
                .is_some_and(|m| m.contains("developer platform")),
            "{}",
            r.json
        );
    }
    // Nothing changed.
    let r = send(&ctx, Req::get("/v1/me").bearer(&dev)).await;
    assert_eq!(
        r.json["display_name"],
        Value::String(owner.display_name.clone())
    );
    assert_eq!(r.json["id"], owner.id());
}

#[tokio::test]
async fn the_developer_app_records_this_deployments_callback() {
    let ctx = TestContext::new().await;
    let stored = |ctx: &TestContext| {
        let pool = ctx.state.db.clone();
        async move {
            sqlx::query_as::<_, (Value, i64)>(
                "select config->'redirect_uris', version from app_signin_configs where app_id = 'developer'",
            )
            .fetch_one(&pool)
            .await
            .expect("the developer app's sign-in setup")
        }
    };
    let (uris, version) = stored(&ctx).await;
    assert_eq!(
        uris,
        // The immutable historical migration starts with the former hostname.
        json!(["https://developer.teamofsilicons.com/auth/callback"])
    );
    assert_eq!(version, 1);

    let done = sync_developer_app(&ctx.state).await.expect("sync");
    assert_eq!(done, DeveloperSync::Updated { version: 2 });
    let (uris, version) = stored(&ctx).await;
    assert_eq!(uris, json!(["http://localhost:8600/auth/callback"]));
    assert_eq!(version, 2);
    let history: (String, Value) = sqlx::query_as(
        "select actor, changes from app_config_history where app_id = 'developer' and version = 2",
    )
    .fetch_one(&ctx.state.db)
    .await
    .expect("history");
    assert_eq!(history.0, "system");
    assert_eq!(history.1[0]["path"], "redirect_uris");
    assert_eq!(
        history.1[0]["before"],
        json!(["https://developer.teamofsilicons.com/auth/callback"])
    );

    // Idempotent.
    assert_eq!(
        sync_developer_app(&ctx.state).await.expect("sync"),
        DeveloperSync::Unchanged
    );
    assert_eq!(stored(&ctx).await.1, 2);
    let homepage: String =
        sqlx::query_scalar("select homepage_url from apps where app_id='developer'")
            .fetch_one(&ctx.state.db)
            .await
            .expect("developer homepage");
    assert_eq!(homepage, "http://localhost:8600");

    // The app is Silicon Accounts' own: no owner, no usable secret, first-party.
    let row: (Option<String>, String, String) =
        sqlx::query_as("select owner_uuid, source, status from apps where app_id = 'developer'")
            .fetch_one(&ctx.state.db)
            .await
            .expect("developer app");
    assert_eq!(row, (None, "first_party".to_string(), "active".to_string()));
    let homepage: Option<String> =
        sqlx::query_scalar("select homepage_url from apps where app_id = 'silicon-accounts'")
            .fetch_one(&ctx.state.db)
            .await
            .expect("silicon-accounts app");
    assert_eq!(
        homepage.as_deref(),
        Some("https://accounts.teamofsilicons.com")
    );
}
