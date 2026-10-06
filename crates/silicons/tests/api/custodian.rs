//! The custodian's side: `/v1/me/silicons…` (create, list, show, update, id, webhook, STK,
//! delete). Transfers are in `transfer.rs`.

use accounts_core::models::{AccountStatus, Scope};
use accounts_core::test_support::{Req, TestContext};
use serde_json::{Value, json};

use crate::common::*;

#[tokio::test]
async fn a_carbon_creates_an_active_silicon_and_is_its_custodian() {
    let ctx = TestContext::new().await;
    let saket = ctx.carbon().await;
    let t = token(&ctx, &saket).await;
    let id = silicon_id("made");
    let r = call(
        &ctx,
        Req::post("/v1/me/silicons").bearer(&t).json(json!({
            "id": id, "display_name": "Made", "webhook_url": "http://127.0.0.1:8593/hooks/made",
        })),
    )
    .await;
    assert_eq!(r.status, 201, "{}", r.json);
    let silicon = &r.json["silicon"];
    assert_eq!(silicon["status"], "active");
    assert_eq!(silicon["id"], id);
    assert_eq!(silicon["custodian"]["uuid"], saket.uuid);
    assert_eq!(
        silicon["custodian"]["id"],
        saket.handle.clone().expect("id")
    );
    assert_eq!(silicon["pending_transfer"], Value::Null);
    assert_eq!(
        silicon["timezone"], "UTC",
        "defaults to the custodian's timezone"
    );
    let stk = r.json["stk"].as_str().expect("generated");
    assert!(stk.starts_with("stk-") && stk.len() == 16);
    assert!(
        r.json["webhook_secret"]
            .as_str()
            .expect("secret")
            .starts_with("whsec_")
    );
    let uuid = silicon["uuid"].as_str().expect("uuid");

    // It signs in right away with the STK it was given.
    assert_eq!(login(&ctx, &id, stk).await.status, 200);
    assert_eq!(
        custodian_history(&ctx, uuid).await,
        vec![(None, saket.uuid.clone(), "created_by_custodian".to_string())]
    );
    assert_eq!(
        silicon_event_types(&ctx, uuid).await,
        vec!["silicon.created"]
    );
    // In the audit store, but listed through custodian_history only (no duplicate entries).
    let unlisted: Option<String> = sqlx::query_scalar(
        "select account_uuid from audit_log where action = 'silicon.created' and target_id = $1",
    )
    .bind(uuid)
    .fetch_one(&ctx.state.db)
    .await
    .expect("audit");
    assert_eq!(unlisted, None);

    // The Carbon's own view counts it.
    let mut conn = ctx.conn().await;
    assert_eq!(
        accounts_core::repo::accounts::count_silicons_in_custody(&mut conn, &saket.uuid)
            .await
            .expect("count"),
        1
    );
}

#[tokio::test]
async fn create_validates_and_is_idempotent() {
    let ctx = TestContext::new().await;
    let saket = ctx.carbon().await;
    let t = token(&ctx, &saket).await;
    let r = call(
        &ctx,
        Req::post("/v1/me/silicons")
            .bearer(&t)
            .json(json!({"id": "x", "display_name": "X"})),
    )
    .await;
    assert_eq!(r.error_code(), Some("invalid_id"));
    let r = call(
        &ctx,
        Req::post("/v1/me/silicons")
            .bearer(&t)
            .json(json!({"id": silicon_id("v"), "display_name": "", "stk": "stk-12"})),
    )
    .await;
    assert_eq!(r.status, 422);
    let fields = &r.json["error"]["details"]["fields"];
    assert!(fields["display_name"].is_string() && fields["stk"].is_string());

    let body = json!({"id": silicon_id("idem"), "display_name": "Idem"});
    let req = || {
        Req::post("/v1/me/silicons")
            .bearer(&t)
            .header("idempotency-key", "create-1")
            .json(body.clone())
    };
    let first = call(&ctx, req()).await;
    assert_eq!(first.status, 201, "{}", first.json);
    let second = call(&ctx, req()).await;
    assert_eq!(second.status, 201);
    assert_eq!(
        second.json["stk"], first.json["stk"],
        "the same generated STK is replayed"
    );
    assert_eq!(
        second
            .headers
            .get("idempotent-replayed")
            .map(|v| v.to_str().unwrap_or("")),
        Some("true")
    );
    let taken = call(
        &ctx,
        Req::post("/v1/me/silicons").bearer(&t).json(body.clone()),
    )
    .await;
    assert_eq!(taken.status, 409);
    assert_eq!(taken.error_code(), Some("id_taken"));

    // Silicons can't create Silicons.
    let (silicon, _) = ctx.silicon(&saket.uuid).await;
    let st = token(&ctx, &silicon).await;
    let r = call(
        &ctx,
        Req::post("/v1/me/silicons")
            .bearer(&st)
            .json(json!({"id": silicon_id("s"), "display_name": "S"})),
    )
    .await;
    assert_eq!(r.status, 403);
    assert_eq!(r.error_code(), Some("carbon_only"));
}

#[tokio::test]
async fn list_and_show_only_my_silicons() {
    let ctx = TestContext::new().await;
    let saket = ctx.carbon().await;
    let other = ctx.carbon().await;
    let t = token(&ctx, &saket).await;
    let mut mine = Vec::new();
    for _ in 0..3 {
        mine.push(ctx.silicon(&saket.uuid).await.0);
    }
    let (theirs, _) = ctx.silicon(&other.uuid).await;
    // A self-created Silicon naming me is not mine until I accept.
    self_created(&ctx, saket.handle.as_deref().expect("id"), json!({})).await;

    let page1 = call(&ctx, Req::get("/v1/me/silicons?limit=2").bearer(&t)).await;
    assert_eq!(page1.status, 200, "{}", page1.json);
    assert_eq!(page1.json["items"].as_array().map(Vec::len), Some(2));
    assert_eq!(page1.json["items"][0]["uuid"], mine[0].uuid, "oldest first");
    assert_eq!(page1.json["items"][0]["pending_transfer"], Value::Null);
    assert_eq!(page1.json["items"][0]["custodian"]["uuid"], saket.uuid);
    let cursor = page1.json["next_cursor"].as_str().expect("cursor");
    let page2 = call(
        &ctx,
        Req::get(&format!("/v1/me/silicons?limit=2&cursor={cursor}")).bearer(&t),
    )
    .await;
    assert_eq!(page2.json["items"].as_array().map(Vec::len), Some(1));
    assert_eq!(page2.json["items"][0]["uuid"], mine[2].uuid);
    assert_eq!(page2.json["next_cursor"], Value::Null);
    let bad = call(&ctx, Req::get("/v1/me/silicons?cursor=nope").bearer(&t)).await;
    assert_eq!(bad.error_code(), Some("invalid_cursor"));

    // By uuid or by si:id.
    let r = call(
        &ctx,
        Req::get(&format!("/v1/me/silicons/{}", mine[1].uuid)).bearer(&t),
    )
    .await;
    assert_eq!(r.status, 200);
    assert_eq!(r.json["id"], mine[1].handle.clone().expect("id"));
    let r = call(
        &ctx,
        Req::get(&format!(
            "/v1/me/silicons/{}",
            mine[1].handle.as_deref().expect("id").to_uppercase()
        ))
        .bearer(&t),
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(r.json["uuid"], mine[1].uuid);

    // Someone else's Silicon looks exactly like one that doesn't exist.
    let r = call(
        &ctx,
        Req::get(&format!("/v1/me/silicons/{}", theirs.uuid)).bearer(&t),
    )
    .await;
    assert_eq!(r.status, 404);
    assert_eq!(r.error_code(), Some("silicon_not_found"));
    let r = call(&ctx, Req::get("/v1/me/silicons/zzzzzz").bearer(&t)).await;
    assert_eq!(r.error_code(), Some("silicon_not_found"));
}

#[tokio::test]
async fn update_tells_member_apps_and_the_silicon() {
    let ctx = TestContext::new().await;
    let saket = ctx.carbon().await;
    let t = token(&ctx, &saket).await;
    let (silicon, _) = ctx.silicon(&saket.uuid).await;
    let set = call(
        &ctx,
        Req::put(&format!("/v1/me/silicons/{}/webhook", silicon.uuid))
            .bearer(&t)
            .json(json!({"url": "http://127.0.0.1:8593/hooks/upd"})),
    )
    .await;
    assert_eq!(set.status, 200, "{}", set.json);
    let (sees_tz, _) = ctx.app("seestz").await;
    let (profile_only, _) = ctx.app("profile").await;
    ctx.set_app_webhook(&sees_tz.app_id, "http://127.0.0.1:8593/seestz/webhooks")
        .await;
    ctx.set_app_webhook(
        &profile_only.app_id,
        "http://127.0.0.1:8593/profile/webhooks",
    )
    .await;
    ctx.membership(
        &sees_tz.app_id,
        &silicon.uuid,
        &[Scope::Profile, Scope::Timezone],
    )
    .await;
    ctx.membership(&profile_only.app_id, &silicon.uuid, &[Scope::Profile])
        .await;

    let r = call(
        &ctx,
        Req::patch(&format!("/v1/me/silicons/{}", silicon.uuid))
            .bearer(&t)
            .json(json!({"timezone": "asia/tokyo"})),
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(r.json["timezone"], "Asia/Tokyo");
    assert_eq!(r.json["version"], silicon.version + 1);
    // Only the app that can see timezones hears about it; the Silicon always does.
    let seen = app_events(&ctx, &sees_tz.app_id).await;
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].0, "account.updated");
    assert_eq!(seen[0].1["data"]["changed"], json!(["timezone"]));
    assert_eq!(seen[0].1["data"]["account"]["timezone"], "Asia/Tokyo");
    assert!(app_events(&ctx, &profile_only.app_id).await.is_empty());
    let own = silicon_events(&ctx, &silicon.uuid).await;
    assert_eq!(own.last().map(|(t, _)| t.as_str()), Some("silicon.updated"));

    // Display name + photo: everyone sees those.
    let r = call(
        &ctx,
        Req::patch(&format!("/v1/me/silicons/{}", silicon.uuid))
            .bearer(&t)
            .json(json!({"display_name": "Renamed", "pfp_url": "https://cdn.example.com/s.png"})),
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(r.json["pfp_url"], "https://cdn.example.com/s.png");
    assert_eq!(app_events(&ctx, &profile_only.app_id).await.len(), 1);
    // null resets the photo to the Iris default.
    let r = call(
        &ctx,
        Req::patch(&format!("/v1/me/silicons/{}", silicon.uuid))
            .bearer(&t)
            .json(json!({"pfp_url": null})),
    )
    .await;
    assert!(
        r.json["pfp_url"]
            .as_str()
            .expect("pfp")
            .ends_with(&format!("/pfp/silicon?id={}", silicon.uuid))
    );

    // A no-op changes nothing and tells nobody.
    let before = app_events(&ctx, &profile_only.app_id).await.len();
    let r = call(
        &ctx,
        Req::patch(&format!("/v1/me/silicons/{}", silicon.uuid))
            .bearer(&t)
            .json(json!({"display_name": "Renamed"})),
    )
    .await;
    assert_eq!(r.status, 200);
    assert_eq!(app_events(&ctx, &profile_only.app_id).await.len(), before);

    // The unchanged dob and id may be sent back (whole-profile round trips).
    let r = call(
        &ctx,
        Req::patch(&format!("/v1/me/silicons/{}", silicon.uuid))
            .bearer(&t)
            .json(json!({"dob": accounts_core::timefmt::format_date(silicon.dob), "id": silicon.handle})),
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.json);

    // Refused: dob, id, bad values.
    let r = call(
        &ctx,
        Req::patch(&format!("/v1/me/silicons/{}", silicon.uuid))
            .bearer(&t)
            .json(json!({"dob": "2000-01-01"})),
    )
    .await;
    assert_eq!(r.status, 422);
    assert_eq!(r.error_code(), Some("dob_immutable"));
    let r = call(
        &ctx,
        Req::patch(&format!("/v1/me/silicons/{}", silicon.uuid))
            .bearer(&t)
            .json(json!({"id": "si:other", "timezone": "Nowhere/Land"})),
    )
    .await;
    assert_eq!(r.status, 422);
    let fields = &r.json["error"]["details"]["fields"];
    assert!(fields["id"].as_str().expect("id").contains("/id"));
    assert!(fields["timezone"].is_string());
    let other = ctx.carbon().await;
    let r = call(
        &ctx,
        Req::patch(&format!("/v1/me/silicons/{}", silicon.uuid))
            .bearer(&token(&ctx, &other).await)
            .json(json!({"display_name": "Mine now"})),
    )
    .await;
    assert_eq!(r.error_code(), Some("silicon_not_found"));
}

#[tokio::test]
async fn id_change_reserves_the_old_id_and_notifies() {
    let ctx = TestContext::new().await;
    let saket = ctx.carbon().await;
    let t = token(&ctx, &saket).await;
    let (silicon, _) = ctx.silicon(&saket.uuid).await;
    let old = silicon.handle.clone().expect("id");
    let set = call(
        &ctx,
        Req::put(&format!("/v1/me/silicons/{}/webhook", silicon.uuid))
            .bearer(&t)
            .json(json!({"url": "http://127.0.0.1:8593/hooks/idc"})),
    )
    .await;
    assert_eq!(set.status, 200);
    let (app, _) = ctx.app("member").await;
    ctx.set_app_webhook(&app.app_id, "http://127.0.0.1:8593/member/webhooks")
        .await;
    ctx.membership(&app.app_id, &silicon.uuid, &[Scope::Profile])
        .await;

    let new_id = silicon_id("fresh");
    let r = call(
        &ctx,
        Req::post(&format!("/v1/me/silicons/{}/id", silicon.uuid))
            .bearer(&t)
            .json(json!({"id": new_id.trim_start_matches("si:")})),
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(r.json["id"], new_id);
    let apps = app_events(&ctx, &app.app_id).await;
    assert_eq!(apps[0].0, "account.id_changed");
    assert_eq!(apps[0].1["data"]["old_id"], old);
    assert_eq!(apps[0].1["data"]["new_id"], new_id);
    assert_eq!(apps[0].1["data"]["kind"], "silicon");
    let own = silicon_events(&ctx, &silicon.uuid).await;
    assert_eq!(
        own.last().map(|(t, _)| t.as_str()),
        Some("silicon.id_changed")
    );

    // The old id is reserved for its previous owner, who can take it back.
    let someone = ctx.carbon().await;
    let st = token(&ctx, &someone).await;
    let r = call(
        &ctx,
        Req::post("/v1/me/silicons")
            .bearer(&st)
            .json(json!({"id": old, "display_name": "Thief"})),
    )
    .await;
    assert_eq!(r.error_code(), Some("id_reserved"));
    let r = call(
        &ctx,
        Req::post(&format!("/v1/me/silicons/{}/id", silicon.uuid))
            .bearer(&t)
            .json(json!({"id": old})),
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(r.json["id"], old);

    // Errors.
    let r = call(
        &ctx,
        Req::post(&format!("/v1/me/silicons/{}/id", silicon.uuid))
            .bearer(&t)
            .json(json!({"id": "c:carbon-id"})),
    )
    .await;
    assert_eq!(r.error_code(), Some("invalid_id"));
    let (taken, _) = ctx.silicon(&saket.uuid).await;
    let r = call(
        &ctx,
        Req::post(&format!("/v1/me/silicons/{}/id", silicon.uuid))
            .bearer(&t)
            .json(json!({"id": taken.handle})),
    )
    .await;
    assert_eq!(r.status, 409);
    assert_eq!(r.error_code(), Some("id_taken"));
}

#[tokio::test]
async fn custodian_manages_the_silicon_webhook() {
    let ctx = TestContext::new().await;
    let saket = ctx.carbon().await;
    let t = token(&ctx, &saket).await;
    let (silicon, _) = ctx.silicon(&saket.uuid).await;
    let r = call(
        &ctx,
        Req::put(&format!("/v1/me/silicons/{}/webhook", silicon.uuid))
            .bearer(&t)
            .json(json!({"url": "http://127.0.0.1:8593/hooks/c"})),
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert!(
        r.json["webhook_secret"]
            .as_str()
            .expect("s")
            .starts_with("whsec_")
    );
    let shown = call(
        &ctx,
        Req::get(&format!("/v1/me/silicons/{}", silicon.uuid)).bearer(&t),
    )
    .await;
    assert_eq!(shown.json["webhook_url"], "http://127.0.0.1:8593/hooks/c");
    let r = call(
        &ctx,
        Req::delete(&format!("/v1/me/silicons/{}/webhook", silicon.uuid)).bearer(&t),
    )
    .await;
    assert_eq!(r.status, 204);
    assert_eq!(account(&ctx, &silicon.uuid).await.webhook_url, None);
    let r = call(
        &ctx,
        Req::put(&format!("/v1/me/silicons/{}/webhook", silicon.uuid))
            .bearer(&t)
            .json(json!({"url": "javascript:alert(1)"})),
    )
    .await;
    assert_eq!(r.status, 422);
}

#[tokio::test]
async fn stk_rotation_kills_the_old_stk_and_every_session() {
    let ctx = TestContext::new().await;
    let saket = ctx.carbon().await;
    let t = token(&ctx, &saket).await;
    let (silicon, old_stk) = ctx.silicon(&saket.uuid).await;
    let id = silicon.handle.clone().expect("id");
    let set = call(
        &ctx,
        Req::put(&format!("/v1/me/silicons/{}/webhook", silicon.uuid))
            .bearer(&t)
            .json(json!({"url": "http://127.0.0.1:8593/hooks/rot"})),
    )
    .await;
    assert_eq!(set.status, 200);
    // Signed into two apps (one with a webhook) and the first-party app.
    let (remind, _) = ctx.app("remind").await;
    let (quiet, _) = ctx.app("quiet").await;
    ctx.set_app_webhook(&remind.app_id, "http://127.0.0.1:8593/remind/webhooks")
        .await;
    ctx.membership(&remind.app_id, &silicon.uuid, &[Scope::Profile])
        .await;
    ctx.membership(&quiet.app_id, &silicon.uuid, &[Scope::Profile])
        .await;
    ctx.tokens_for(&silicon, &remind.app_id, &[Scope::Profile])
        .await;
    ctx.tokens_for(&silicon, &quiet.app_id, &[Scope::Profile])
        .await;
    let session = login(&ctx, &id, &old_stk).await;
    assert_eq!(session.status, 200);

    let r = call(
        &ctx,
        Req::post(&format!("/v1/me/silicons/{}/stk", silicon.uuid))
            .bearer(&t)
            .json(json!({"stk": "0123456789abcdef0123"})),
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(r.json["stk"], Value::Null, "a chosen STK is never echoed");
    assert!(r.json["rotated_at"].is_string());
    assert_eq!(r.json["revoked_sessions"], 3);

    assert_eq!(login(&ctx, &id, &old_stk).await.status, 401);
    assert_eq!(
        login(&ctx, &id, "stk-0123456789abcdef0123").await.status,
        200
    );
    let active: i64 = sqlx::query_scalar(
        "select count(*) from token_families where account_uuid = $1 and revoked_at is null",
    )
    .bind(&silicon.uuid)
    .fetch_one(&ctx.state.db)
    .await
    .expect("count");
    assert_eq!(active, 1, "only the sign-in made after the rotation");
    let reasons: Vec<String> = sqlx::query_scalar(
        "select distinct revoke_reason from token_families where account_uuid = $1 and revoked_at is not null",
    )
    .bind(&silicon.uuid)
    .fetch_all(&ctx.state.db)
    .await
    .expect("reasons");
    assert_eq!(reasons, vec!["stk_rotated".to_string()]);

    // Apps were told the Silicon signed out (only the one with a webhook gets a delivery).
    let events = app_events(&ctx, &remind.app_id).await;
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].0, "membership.signed_out");
    assert_eq!(events[0].1["data"]["reason"], "stk_rotated");
    assert_eq!(
        events[0].1["data"]["membership_id"],
        format!("{}:{}", remind.app_id, silicon.uuid)
    );
    // The Silicon was told too.
    let own = silicon_events(&ctx, &silicon.uuid).await;
    let (last_type, last) = own.last().expect("event");
    assert_eq!(last_type, "silicon.stk_rotated");
    assert_eq!(last["data"]["rotated_by"]["uuid"], saket.uuid);

    // Generated rotation + idempotent retry returns the same STK once.
    let req = || {
        Req::post(&format!("/v1/me/silicons/{}/stk", silicon.uuid))
            .bearer(&t)
            .header("idempotency-key", "rotate-1")
            .json(json!({}))
    };
    let a = call(&ctx, req()).await;
    let b = call(&ctx, req()).await;
    assert_eq!(a.status, 200, "{}", a.json);
    assert_eq!(a.json["stk"], b.json["stk"]);
    assert_eq!(
        login(&ctx, &id, a.json["stk"].as_str().expect("stk"))
            .await
            .status,
        200
    );

    // Validation and custody.
    let r = call(
        &ctx,
        Req::post(&format!("/v1/me/silicons/{}/stk", silicon.uuid))
            .bearer(&t)
            .json(json!({"stk": "short"})),
    )
    .await;
    assert_eq!(r.status, 422);
    assert!(r.json["error"]["details"]["fields"]["stk"].is_string());
    let other = ctx.carbon().await;
    let r = call(
        &ctx,
        Req::post(&format!("/v1/me/silicons/{}/stk", silicon.uuid))
            .bearer(&token(&ctx, &other).await)
            .json(json!({})),
    )
    .await;
    assert_eq!(r.error_code(), Some("silicon_not_found"));
}

#[tokio::test]
async fn delete_needs_the_exact_id_and_tells_apps() {
    let ctx = TestContext::new().await;
    let saket = ctx.carbon().await;
    let t = token(&ctx, &saket).await;
    let (silicon, stk) = ctx.silicon(&saket.uuid).await;
    let id = silicon.handle.clone().expect("id");
    let (app, _) = ctx.app("member").await;
    ctx.set_app_webhook(&app.app_id, "http://127.0.0.1:8593/member/webhooks")
        .await;
    ctx.membership(&app.app_id, &silicon.uuid, &[Scope::Profile])
        .await;
    // A pending transfer is cancelled by the deletion.
    let other = ctx.carbon().await;
    let tr = call(
        &ctx,
        Req::post(&format!("/v1/me/silicons/{}/transfer", silicon.uuid))
            .bearer(&t)
            .json(json!({"to": other.handle})),
    )
    .await;
    assert_eq!(tr.status, 201, "{}", tr.json);

    let r = call(
        &ctx,
        Req::delete(&format!("/v1/me/silicons/{}", silicon.uuid))
            .bearer(&t)
            .json(json!({"confirm": "si:something-else"})),
    )
    .await;
    assert_eq!(r.status, 422);
    assert_eq!(r.error_code(), Some("confirmation_mismatch"));
    let r = call(
        &ctx,
        Req::delete(&format!("/v1/me/silicons/{}", silicon.uuid)).bearer(&t),
    )
    .await;
    assert_eq!(r.status, 422);
    assert!(r.json["error"]["details"]["fields"]["confirm"].is_string());

    let r = call(
        &ctx,
        Req::delete(&format!("/v1/me/silicons/{}", silicon.uuid))
            .bearer(&t)
            .json(json!({"confirm": id.trim_start_matches("si:").to_uppercase()})),
    )
    .await;
    assert_eq!(r.status, 204, "{}", r.json);
    let gone = account(&ctx, &silicon.uuid).await;
    assert_eq!(gone.status, AccountStatus::Deleted);
    assert_eq!(gone.handle, None);
    let events = app_events(&ctx, &app.app_id).await;
    assert_eq!(
        events.last().map(|(t, _)| t.as_str()),
        Some("account.deleted")
    );
    let (status, ..) = request_row(&ctx, tr.json["request"]["id"].as_str().expect("id")).await;
    assert_eq!(status, "cancelled");
    assert_eq!(
        login(&ctx, &id, &stk).await.error_code(),
        Some("account_deleted")
    );
    // Its id stays reserved for 10 days.
    let r = call(
        &ctx,
        Req::post("/v1/me/silicons")
            .bearer(&t)
            .json(json!({"id": id, "display_name": "Again"})),
    )
    .await;
    assert_eq!(r.error_code(), Some("id_reserved"));
    let r = call(
        &ctx,
        Req::get(&format!("/v1/me/silicons/{}", silicon.uuid)).bearer(&t),
    )
    .await;
    assert_eq!(r.error_code(), Some("silicon_not_found"));
}

#[tokio::test]
async fn created_and_rotated_stks_are_replayed_but_never_stored_in_clear() {
    let ctx = TestContext::new().await;
    let saket = ctx.carbon().await;
    let t = token(&ctx, &saket).await;

    // POST /v1/me/silicons: a generated STK and a webhook secret.
    let body = json!({"id": silicon_id("sealed"), "display_name": "Sealed",
                      "webhook_url": "http://127.0.0.1:8593/hooks/sealed"});
    let create = || {
        Req::post("/v1/me/silicons")
            .bearer(&t)
            .header("idempotency-key", "create-sealed")
            .json(body.clone())
    };
    let first = call(&ctx, create()).await;
    assert_eq!(first.status, 201, "{}", first.json);
    let stored = stored_idempotent_response(&ctx, "create-sealed").await;
    for needle in [
        first.json["stk"].as_str().expect("stk"),
        first.json["webhook_secret"].as_str().expect("secret"),
        "stk-",
        "whsec_",
    ] {
        assert!(
            !stored.contains(needle),
            "{needle} is stored in clear: {stored}"
        );
    }
    let again = call(&ctx, create()).await;
    assert_eq!(again.status, 201);
    assert_eq!(again.json, first.json);

    // POST /v1/me/silicons/{uuid}/stk: the rotated STK.
    let uuid = first.json["silicon"]["uuid"]
        .as_str()
        .expect("uuid")
        .to_string();
    let rotate = || {
        Req::post(&format!("/v1/me/silicons/{uuid}/stk"))
            .bearer(&t)
            .header("idempotency-key", "rotate-sealed")
            .json(json!({}))
    };
    let rotated = call(&ctx, rotate()).await;
    assert_eq!(rotated.status, 200, "{}", rotated.json);
    let stk = rotated.json["stk"].as_str().expect("stk").to_string();
    let stored = stored_idempotent_response(&ctx, "rotate-sealed").await;
    assert!(
        !stored.contains(&stk) && !stored.contains("stk-"),
        "{stored}"
    );
    let replayed = call(&ctx, rotate()).await;
    assert_eq!(replayed.status, 200);
    assert_eq!(replayed.json["stk"], stk.as_str());
    assert_eq!(
        replayed
            .headers
            .get("idempotent-replayed")
            .map(|v| v.to_str().unwrap_or("")),
        Some("true")
    );
    // Rotated once, not twice: the replayed STK is the one that signs in.
    let id = first.json["silicon"]["id"].as_str().expect("id");
    assert_eq!(login(&ctx, id, &stk).await.status, 200);
}

#[tokio::test]
async fn deleting_a_silicon_deletes_its_uploaded_photos() {
    let ctx = TestContext::new().await;
    let saket = ctx.carbon().await;
    let t = token(&ctx, &saket).await;
    let (silicon, _) = ctx.silicon(&saket.uuid).await;
    // An uploaded photo of the Silicon (POST /v1/me/photo, account crate) and one of the
    // custodian's own.
    let photo = uuid::Uuid::now_v7();
    let custodian_photo = uuid::Uuid::now_v7();
    for (id, owner) in [(photo, &silicon.uuid), (custodian_photo, &saket.uuid)] {
        sqlx::query(
            "insert into photos (id, account_uuid, content_type, bytes) values ($1, $2, 'image/png', '\\x89504e47'::bytea)",
        )
        .bind(id)
        .bind(owner)
        .execute(&ctx.state.db)
        .await
        .expect("photo");
    }
    sqlx::query("update accounts set pfp_url = $2 where uuid = $1")
        .bind(&silicon.uuid)
        .bind(ctx.state.settings.url(&format!("/v1/photos/{photo}")))
        .execute(&ctx.state.db)
        .await
        .expect("pfp");

    let r = call(
        &ctx,
        Req::delete(&format!("/v1/me/silicons/{}", silicon.uuid))
            .bearer(&t)
            .json(json!({"confirm": silicon.handle})),
    )
    .await;
    assert_eq!(r.status, 204, "{}", r.json);
    let photos: Vec<(uuid::Uuid, String)> =
        sqlx::query_as("select id, account_uuid from photos order by created_at")
            .fetch_all(&ctx.state.db)
            .await
            .expect("photos");
    assert_eq!(
        photos,
        vec![(custodian_photo, saket.uuid.clone())],
        "only the Silicon's uploads are gone"
    );
    let gone = account(&ctx, &silicon.uuid).await;
    assert_eq!(gone.status, AccountStatus::Deleted);
    assert_eq!(
        gone.pfp_url,
        accounts_core::pfp::default_pfp_url(
            &ctx.state.settings.iris_base_url,
            accounts_core::models::AccountKind::Silicon,
            &silicon.uuid
        )
    );
    let details: Value = sqlx::query_scalar(
        "select details from audit_log where action = 'silicon.deleted' and account_uuid = $1",
    )
    .bind(&saket.uuid)
    .fetch_one(&ctx.state.db)
    .await
    .expect("audit");
    assert_eq!(details["deleted_photos"], 1);
}
