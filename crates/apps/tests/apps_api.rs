//! Public config, owned apps, app details and the app-or-owner auth rules.

mod common;

use accounts_core::models::{AccountStatus, Scope};
use accounts_core::repo::memberships;
use accounts_core::test_support::{CarbonSpec, Req, TestContext};
use common::{call, owned_app};
use serde_json::json;

#[tokio::test]
async fn public_config_is_cors_open_and_lists_available_methods() {
    let ctx = TestContext::new().await;
    let a = owned_app(&ctx, "pub").await;

    let r = call(&ctx, Req::get(&format!("/v1/apps/{}/public", a.app_id))).await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(r.headers["access-control-allow-origin"], "*");
    assert_eq!(r.json["app_id"], a.app_id.as_str());
    assert_eq!(r.json["methods"], json!(["email"]));
    assert_eq!(r.json["branding"]["light"]["primary"], "#1F5FB8");
    assert_eq!(
        r.json["branding"]["dark"]["primary"], "#1F5FB8",
        "filled buttons keep the brand blue in dark mode too"
    );
    assert_eq!(r.json["copy"]["title"], serde_json::Value::Null);
    assert_eq!(r.json["allowed_origins"], json!([]));
    assert!(
        r.json.get("signin_config").is_none(),
        "public config never shows the setup"
    );

    // Managed Google without managed credentials is hidden (the button could only fail).
    let r = call(
        &ctx,
        Req::patch(&format!("/v1/apps/{}/signin-config", a.app_id))
            .basic(&a.app_id, &a.secret)
            .json(json!({"methods": {"google": true, "phone": true}, "method_order": ["phone", "google", "email"],
                         "branding": {"radius": 28}, "copy": {"title": "Sign in to Pub"},
                         "allowed_origins": ["https://pub.example.com/", "http://localhost:3000"]})),
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.json);
    let r = call(&ctx, Req::get(&format!("/v1/apps/{}/public", a.app_id))).await;
    assert_eq!(r.json["methods"], json!(["phone", "email"]));
    assert_eq!(r.json["branding"]["radius"], 28);
    assert_eq!(r.json["copy"]["title"], "Sign in to Pub");
    // What the embed page needs for its frame-ancestors (normalized, no trailing slash).
    assert_eq!(
        r.json["allowed_origins"],
        json!(["https://pub.example.com", "http://localhost:3000"])
    );

    let r = call(&ctx, Req::get("/v1/apps/nope-nope/public")).await;
    assert_eq!(r.status, 404);
    assert_eq!(r.error_code(), Some("unknown_app"));
    assert_eq!(
        r.headers["access-control-allow-origin"], "*",
        "errors are readable cross-origin too"
    );

    ctx.exec(&format!(
        "update apps set status = 'disabled' where app_id = '{}'",
        a.app_id
    ))
    .await;
    let r = call(&ctx, Req::get(&format!("/v1/apps/{}/public", a.app_id))).await;
    assert_eq!(r.status, 403);
    assert_eq!(r.error_code(), Some("app_disabled"));
}

#[tokio::test]
async fn owned_apps_lists_the_carbons_apps_with_user_counts() {
    let ctx = TestContext::new().await;
    let a = owned_app(&ctx, "own-a").await;
    let (b, _) = ctx.app_owned("own-b", Some(&a.owner.uuid)).await;
    let other = owned_app(&ctx, "other").await;

    // Users: 2 active + 1 imported count; an access_removed one doesn't.
    let c1 = ctx.carbon().await;
    let c2 = ctx.carbon().await;
    let c3 = ctx.carbon().await;
    ctx.membership(&a.app_id, &c1.uuid, &[Scope::Profile]).await;
    ctx.membership(&a.app_id, &c2.uuid, &[Scope::Profile]).await;
    let removed = ctx.carbon().await;
    ctx.membership(&a.app_id, &removed.uuid, &[Scope::Profile])
        .await;
    {
        let mut conn = ctx.conn().await;
        memberships::upsert_imported(
            &mut conn,
            &a.app_id,
            &c3.uuid,
            Some("ext-3"),
            Some(&json!({})),
            false,
        )
        .await
        .expect("imported");
        memberships::remove_access(&mut conn, &a.app_id, &removed.uuid, &removed.uuid)
            .await
            .expect("removed");
    }

    let r = call(
        &ctx,
        Req::get("/v1/me/owned-apps").session(&ctx.state.settings, &a.cookie),
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.json);
    let items = r.json["items"].as_array().expect("items");
    let ids: Vec<&str> = items.iter().filter_map(|i| i["app_id"].as_str()).collect();
    assert_eq!(ids.len(), 2);
    assert!(ids.contains(&a.app_id.as_str()) && ids.contains(&b.app_id.as_str()));
    assert!(!ids.contains(&other.app_id.as_str()));
    let mine = items
        .iter()
        .find(|i| i["app_id"] == a.app_id.as_str())
        .expect("app a");
    assert_eq!(mine["users"], 3);
    assert_eq!(mine["status"], "active");
    assert_eq!(mine["source"], "fake");
    assert!(
        mine["created_at"]
            .as_str()
            .is_some_and(|t| t.ends_with('Z'))
    );

    // Bearer tokens work too, and pages follow the cursor.
    let token = ctx.first_party_tokens(&a.owner).await.access_token;
    let r = call(&ctx, Req::get("/v1/me/owned-apps?limit=1").bearer(&token)).await;
    assert_eq!(r.json["items"].as_array().map(Vec::len), Some(1));
    let cursor = r.json["next_cursor"]
        .as_str()
        .expect("next page")
        .to_string();
    let r2 = call(
        &ctx,
        Req::get(&format!("/v1/me/owned-apps?limit=1&cursor={cursor}")).bearer(&token),
    )
    .await;
    assert_eq!(r2.json["items"].as_array().map(Vec::len), Some(1));
    assert_ne!(r.json["items"][0]["app_id"], r2.json["items"][0]["app_id"]);
    assert_eq!(r2.json["next_cursor"], serde_json::Value::Null);

    // Only Carbons own apps; no session → 401.
    let (silicon, _) = ctx.silicon(&a.owner.uuid).await;
    let token = ctx.first_party_tokens(&silicon).await.access_token;
    let r = call(&ctx, Req::get("/v1/me/owned-apps").bearer(&token)).await;
    assert_eq!(r.status, 403);
    assert_eq!(r.error_code(), Some("carbon_only"));
    let r = call(&ctx, Req::get("/v1/me/owned-apps")).await;
    assert_eq!(r.status, 401);
    let r = call(
        &ctx,
        Req::get("/v1/me/owned-apps?cursor=garbage")
            .bearer(&ctx.first_party_tokens(&a.owner).await.access_token),
    )
    .await;
    assert_eq!(r.error_code(), Some("invalid_cursor"));
}

#[tokio::test]
async fn details_require_the_app_or_its_owner_and_mask_secrets() {
    let ctx = TestContext::new().await;
    let a = owned_app(&ctx, "det").await;
    let other = owned_app(&ctx, "det-other").await;
    let path = format!("/v1/apps/{}", a.app_id);

    let r = call(&ctx, Req::get(&path).basic(&a.app_id, &a.secret)).await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(r.json["app_id"], a.app_id.as_str());
    assert_eq!(r.json["owner"]["uuid"], a.owner.uuid.as_str());
    assert_eq!(
        r.json["owner"]["id"],
        a.owner.handle.as_deref().unwrap_or_default()
    );
    assert_eq!(r.json["status"], "active");
    assert_eq!(r.json["source"], "fake");
    assert_eq!(r.json["config_version"], 1);
    assert_eq!(
        r.json["signin_config"]["google"]["client_secret_set"],
        false
    );
    assert_eq!(r.json["signin_config"]["apple"]["private_key_set"], false);
    assert_eq!(
        r.json["signin_config"]["redirect_uris"][0],
        format!("http://127.0.0.1:8593/{}/callback", a.app_id)
    );
    assert_eq!(r.json["webhook"], json!({"url": null, "secret_set": false}));
    assert_eq!(
        r.json["stats"],
        json!({"users": 0, "active_last_30d": 0, "imported_unclaimed": 0})
    );

    // The owner's session (cookie or first-party bearer) works too.
    let r = call(
        &ctx,
        Req::get(&path).session(&ctx.state.settings, &a.cookie),
    )
    .await;
    assert_eq!(r.status, 200);
    let token = ctx.first_party_tokens(&a.owner).await.access_token;
    assert_eq!(call(&ctx, Req::get(&path).bearer(&token)).await.status, 200);

    // Someone else's session → not_app_owner; another app's credentials → app_mismatch.
    let r = call(
        &ctx,
        Req::get(&path).session(&ctx.state.settings, &other.cookie),
    )
    .await;
    assert_eq!(r.status, 403);
    assert_eq!(r.error_code(), Some("not_app_owner"));
    let r = call(&ctx, Req::get(&path).basic(&other.app_id, &other.secret)).await;
    assert_eq!(r.status, 403);
    assert_eq!(r.error_code(), Some("app_mismatch"));
    let r = call(&ctx, Req::get(&path).basic(&a.app_id, "sa_app_wrong")).await;
    assert_eq!(r.status, 401);
    assert_eq!(r.error_code(), Some("invalid_app_credentials"));
    let r = call(&ctx, Req::get(&path)).await;
    assert_eq!(r.status, 401);
    let r = call(
        &ctx,
        Req::get("/v1/apps/missing-app").session(&ctx.state.settings, &a.cookie),
    )
    .await;
    assert_eq!(r.status, 404);
    assert_eq!(r.error_code(), Some("unknown_app"));

    // A Silicon can't own apps, even with a first-party token.
    let (silicon, _) = ctx.silicon(&a.owner.uuid).await;
    let token = ctx.first_party_tokens(&silicon).await.access_token;
    let r = call(&ctx, Req::get(&path).bearer(&token)).await;
    assert_eq!(r.error_code(), Some("not_app_owner"));

    // Stats.
    let active = ctx.carbon().await;
    ctx.membership(&a.app_id, &active.uuid, &[Scope::Profile])
        .await;
    let unclaimed = ctx
        .carbon_with(CarbonSpec {
            status: Some(AccountStatus::Unclaimed),
            ..Default::default()
        })
        .await;
    {
        let mut conn = ctx.conn().await;
        memberships::upsert_imported(&mut conn, &a.app_id, &unclaimed.uuid, None, None, false)
            .await
            .expect("imported");
    }
    let r = call(&ctx, Req::get(&path).basic(&a.app_id, &a.secret)).await;
    assert_eq!(
        r.json["stats"],
        json!({"users": 2, "active_last_30d": 1, "imported_unclaimed": 1})
    );

    // A disabled app can't use its credentials; its owner still manages it.
    ctx.exec(&format!(
        "update apps set status = 'disabled' where app_id = '{}'",
        a.app_id
    ))
    .await;
    ctx.state.app_cache.invalidate(&a.app_id);
    let r = call(&ctx, Req::get(&path).basic(&a.app_id, &a.secret)).await;
    assert_eq!(r.status, 403);
    assert_eq!(r.error_code(), Some("app_disabled"));
    let r = call(
        &ctx,
        Req::get(&path).session(&ctx.state.settings, &a.cookie),
    )
    .await;
    assert_eq!(r.status, 200);
    assert_eq!(r.json["status"], "disabled");
}
