//! A custodian's controls over its Silicon's apps: list them and the Silicon's sign-ins, remove
//! one app's access, and limit which apps the Silicon may get short-lived tokens for.

use accounts_core::models::Scope;
use accounts_core::test_support::{Req, TestContext};
use serde_json::{Value, json};

use crate::common::*;

async fn slt(ctx: &TestContext, bearer: &str, app_id: &str) -> accounts_core::test_support::Resp {
    call(
        ctx,
        Req::post("/v1/me/short-lived-tokens")
            .bearer(bearer)
            .json(json!({"app_id": app_id})),
    )
    .await
}

#[tokio::test]
async fn a_custodian_sees_and_removes_its_silicons_apps() {
    let ctx = TestContext::new().await;
    let custodian = ctx.carbon().await;
    let (silicon, _) = ctx.silicon(&custodian.uuid).await;
    let (briefcase, _) = ctx.app("briefcase").await;
    let (dm, _) = ctx.app("dm").await;
    let hook = ctx
        .set_app_webhook(&briefcase.app_id, "http://127.0.0.1:8593/b/hooks")
        .await;
    let _ = hook;
    ctx.membership(&briefcase.app_id, &silicon.uuid, &[Scope::Profile])
        .await;
    ctx.membership(&dm.app_id, &silicon.uuid, &[Scope::Profile])
        .await;
    let app_tokens = ctx
        .tokens_for(&silicon, &briefcase.app_id, &[Scope::Profile])
        .await;
    accounts_core::repo::audit::signin(
        &mut *ctx.conn().await,
        &accounts_core::repo::audit::SigninRecord {
            account_uuid: Some(&silicon.uuid),
            app_id: Some(&briefcase.app_id),
            method: "slt",
            outcome: "success",
            ip: Some("203.0.113.9"),
            user_agent: Some("scout/1.0"),
        },
    )
    .await
    .expect("signin");
    let t = token(&ctx, &custodian).await;
    let base = format!("/v1/me/silicons/{}", silicon.uuid);

    let r = call(&ctx, Req::get(&format!("{base}/apps")).bearer(&t)).await;
    assert_eq!(r.status, 200, "{}", r.json);
    let apps: Vec<&str> = r.json["items"]
        .as_array()
        .expect("items")
        .iter()
        .filter_map(|i| i["app"]["app_id"].as_str())
        .collect();
    assert_eq!(apps.len(), 2, "{}", r.json);
    assert!(apps.contains(&briefcase.app_id.as_str()));
    let item = r.json["items"]
        .as_array()
        .expect("items")
        .iter()
        .find(|i| i["app"]["app_id"] == briefcase.app_id.as_str())
        .expect("briefcase");
    assert_eq!(item["status"], "active");
    assert_eq!(item["active_sessions"], 1);
    // By si:id too, with a page size.
    let handle = silicon.handle.clone().expect("si:id");
    let r = call(
        &ctx,
        Req::get(&format!("/v1/me/silicons/{handle}/apps?limit=1")).bearer(&t),
    )
    .await;
    assert_eq!(r.json["items"].as_array().map(Vec::len), Some(1));
    assert!(r.json["next_cursor"].is_string());

    let r = call(&ctx, Req::get(&format!("{base}/signins")).bearer(&t)).await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(
        r.json["items"][0]["app"]["app_id"],
        briefcase.app_id.as_str()
    );
    assert_eq!(r.json["items"][0]["method"], "slt");
    assert_eq!(r.json["items"][0]["ip"], "203.0.113.9");

    // Removing briefcase ends its sign-ins and tells the app.
    let r = call(
        &ctx,
        Req::delete(&format!("{base}/apps/{}", briefcase.app_id)).bearer(&t),
    )
    .await;
    assert_eq!(r.status, 204, "{}", r.json);
    let family_live: bool = sqlx::query_scalar(
        "select revoked_at is null from token_families where account_uuid = $1 and app_id = $2",
    )
    .bind(&silicon.uuid)
    .bind(&briefcase.app_id)
    .fetch_one(&ctx.state.db)
    .await
    .expect("family");
    assert!(!family_live, "the sign-in ended");
    let _ = app_tokens;
    let types: Vec<String> = app_events(&ctx, &briefcase.app_id)
        .await
        .into_iter()
        .map(|(t, _)| t)
        .collect();
    assert!(
        types.contains(&"membership.access_removed".to_string()),
        "{types:?}"
    );
    let r = call(
        &ctx,
        Req::get(&format!("{base}/apps?status=access_removed")).bearer(&t),
    )
    .await;
    assert_eq!(
        r.json["items"][0]["app"]["app_id"],
        briefcase.app_id.as_str()
    );
    // Again: nothing changes.
    let r = call(
        &ctx,
        Req::delete(&format!("{base}/apps/{}", briefcase.app_id)).bearer(&t),
    )
    .await;
    assert_eq!(r.status, 204);
    let r = call(
        &ctx,
        Req::delete(&format!("{base}/apps/never-used")).bearer(&t),
    )
    .await;
    assert_eq!(r.status, 404);
    assert_eq!(r.error_code(), Some("membership_not_found"));
    let r = call(
        &ctx,
        Req::delete(&format!("{base}/apps/silicon-accounts")).bearer(&t),
    )
    .await;
    assert_eq!(r.error_code(), Some("first_party_app"));

    // Only its custodian.
    let stranger = ctx.carbon().await;
    let st = token(&ctx, &stranger).await;
    for path in [
        format!("{base}/apps"),
        format!("{base}/signins"),
        format!("{base}/allowed-apps"),
    ] {
        let r = call(&ctx, Req::get(&path).bearer(&st)).await;
        assert_eq!(r.status, 404, "{path}");
        assert_eq!(r.error_code(), Some("silicon_not_found"));
    }
    let st = token(&ctx, &silicon).await;
    let r = call(&ctx, Req::get(&format!("{base}/apps")).bearer(&st)).await;
    assert_eq!(r.error_code(), Some("carbon_only"));
}

#[tokio::test]
async fn an_allow_list_limits_short_lived_tokens() {
    let ctx = TestContext::new().await;
    let custodian = ctx.carbon().await;
    let (silicon, _) = ctx.silicon(&custodian.uuid).await;
    let (briefcase, _) = ctx.app("briefcase").await;
    let (dm, _) = ctx.app("dm").await;
    let t = token(&ctx, &custodian).await;
    let st = token(&ctx, &silicon).await;
    let url = format!("/v1/me/silicons/{}/allowed-apps", silicon.uuid);

    let r = call(&ctx, Req::get(&url).bearer(&t)).await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(r.json["allowed_apps"], Value::Null, "every app by default");
    assert_eq!(slt(&ctx, &st, &dm.app_id).await.status, 201);

    let r = call(
        &ctx,
        Req::put(&url)
            .bearer(&t)
            .json(json!({"allowed_apps": [briefcase.app_id.to_uppercase(), briefcase.app_id]})),
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(r.json["allowed_apps"], json!([briefcase.app_id]));
    assert_eq!(slt(&ctx, &st, &briefcase.app_id).await.status, 201);
    let r = slt(&ctx, &st, &dm.app_id).await;
    assert_eq!(r.status, 403, "{}", r.json);
    assert_eq!(r.error_code(), Some("app_not_allowed"));
    assert_eq!(
        r.json["error"]["details"]["allowed_apps"],
        json!([briefcase.app_id])
    );
    assert_eq!(r.json["error"]["details"]["app_id"], dm.app_id.as_str());
    assert!(
        r.json["error"]["hint"]
            .as_str()
            .is_some_and(|h| h.contains("custodian"))
    );

    // An empty list allows nothing; null allows everything again.
    let r = call(
        &ctx,
        Req::put(&url).bearer(&t).json(json!({"allowed_apps": []})),
    )
    .await;
    assert_eq!(r.json["allowed_apps"], json!([]));
    assert_eq!(slt(&ctx, &st, &briefcase.app_id).await.status, 403);
    let r = call(
        &ctx,
        Req::put(&url)
            .bearer(&t)
            .json(json!({"allowed_apps": null})),
    )
    .await;
    assert_eq!(r.json["allowed_apps"], Value::Null);
    assert_eq!(slt(&ctx, &st, &dm.app_id).await.status, 201);

    // Unknown or impossible apps are refused, naming them.
    let r = call(
        &ctx,
        Req::put(&url)
            .bearer(&t)
            .json(json!({"allowed_apps": ["no-such-app"]})),
    )
    .await;
    assert_eq!(r.status, 422);
    assert_eq!(r.error_code(), Some("unknown_app"));
    assert_eq!(
        r.json["error"]["details"]["unknown"],
        json!(["no-such-app"])
    );
    let r = call(
        &ctx,
        Req::put(&url)
            .bearer(&t)
            .json(json!({"allowed_apps": ["Not An Id", "silicon-accounts"]})),
    )
    .await;
    assert_eq!(r.status, 422);
    assert!(r.json["error"]["details"]["fields"]["allowed_apps[0]"].is_string());
    assert!(r.json["error"]["details"]["fields"]["allowed_apps[1]"].is_string());
    let r = call(&ctx, Req::put(&url).bearer(&t).json(json!({"apps": []}))).await;
    assert_eq!(r.status, 422, "unknown fields are refused");
}
