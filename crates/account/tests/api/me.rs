//! `GET /v1/me` and `PATCH /v1/me`.

use accounts_core::events::types;
use accounts_core::models::Scope;
use accounts_core::repo::memberships;
use accounts_core::test_support::{Req, TestContext};
use serde_json::{Value, json};

use crate::common::*;

#[tokio::test]
async fn me_for_a_carbon_and_a_silicon() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let (silicon, _) = ctx.silicon(&carbon.uuid).await;

    let r = call(&ctx, Req::get("/v1/me").bearer(&token(&ctx, &carbon).await)).await;
    assert_status(&r, 200);
    assert_eq!(r.json["uuid"], carbon.uuid);
    assert_eq!(r.json["kind"], "carbon");
    assert_eq!(r.json["dob"], "2000-01-01");
    assert_eq!(r.json["emails"].as_array().map(Vec::len), Some(1));
    assert_eq!(r.json["emails"][0]["is_primary"], true);
    assert_eq!(r.json["phones"], json!([]));
    assert_eq!(r.json["identities"], json!([]));
    assert_eq!(r.json["custodian_of"], 1);
    assert!(r.json.get("custodian").is_none());
    assert!(
        r.json["created_at"]
            .as_str()
            .is_some_and(|t| t.ends_with('Z'))
    );

    let r = call(
        &ctx,
        Req::get("/v1/me").bearer(&token(&ctx, &silicon).await),
    )
    .await;
    assert_status(&r, 200);
    assert_eq!(r.json["kind"], "silicon");
    assert_eq!(
        r.json["custodian"]["id"],
        carbon.handle.clone().expect("id")
    );
    assert_eq!(r.json["webhook_url"], Value::Null);
    assert!(r.json["stk_rotated_at"].as_str().is_some());
    assert!(r.json.get("emails").is_none());

    let r = call(&ctx, Req::get("/v1/me")).await;
    assert_error(&r, 401, "unauthenticated");
}

#[tokio::test]
async fn patch_updates_and_tells_each_app_only_what_it_can_see() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let profile_only = member_app(&ctx, "profile", &carbon, &[Scope::Profile]).await;
    let with_tz = member_app(&ctx, "tz", &carbon, &[Scope::Profile, Scope::Timezone]).await;
    let removed = member_app(&ctx, "removed", &carbon, &[Scope::Profile, Scope::Timezone]).await;
    let mut conn = ctx.conn().await;
    memberships::remove_access(&mut conn, &removed, &carbon.uuid, &carbon.uuid)
        .await
        .expect("remove");
    drop(conn);
    let tok = token(&ctx, &carbon).await;

    let r = call(
        &ctx,
        Req::patch("/v1/me")
            .bearer(&tok)
            .json(json!({"display_name": "  Saket Dev ", "timezone": "asia/kolkata"})),
    )
    .await;
    assert_status(&r, 200);
    assert_eq!(r.json["display_name"], "Saket Dev");
    assert_eq!(r.json["timezone"], "Asia/Kolkata");
    assert_eq!(r.json["version"], carbon.version + 1);

    let a = events(&ctx, &profile_only, types::ACCOUNT_UPDATED).await;
    assert_eq!(a.len(), 1);
    assert_eq!(a[0]["data"]["changed"], json!(["display_name"]));
    assert_eq!(a[0]["data"]["account"]["display_name"], "Saket Dev");
    assert!(a[0]["data"]["account"].get("timezone").is_none());
    assert_eq!(
        a[0]["data"]["membership_id"],
        format!("{profile_only}:{}", carbon.uuid)
    );
    let b = events(&ctx, &with_tz, types::ACCOUNT_UPDATED).await;
    assert_eq!(b.len(), 1);
    assert_eq!(b[0]["data"]["changed"], json!(["display_name", "timezone"]));
    assert_eq!(b[0]["data"]["account"]["timezone"], "Asia/Kolkata");
    assert!(
        events(&ctx, &removed, types::ACCOUNT_UPDATED)
            .await
            .is_empty()
    );

    // A change only some apps can see reaches only them.
    let r = call(
        &ctx,
        Req::patch("/v1/me")
            .bearer(&tok)
            .json(json!({"timezone": "Europe/London", "dob": "1990-05-17"})),
    )
    .await;
    assert_status(&r, 200);
    assert_eq!(r.json["dob"], "1990-05-17");
    assert_eq!(
        events(&ctx, &profile_only, types::ACCOUNT_UPDATED)
            .await
            .len(),
        1
    );
    let b = events(&ctx, &with_tz, types::ACCOUNT_UPDATED).await;
    assert_eq!(b.len(), 2);
    assert_eq!(
        b[1]["data"]["changed"],
        json!(["timezone"]),
        "dob is not visible to it"
    );

    // Sending the same values changes nothing and notifies nobody.
    let before = reload(&ctx, &carbon.uuid).await.version;
    let r = call(
        &ctx,
        Req::patch("/v1/me")
            .bearer(&tok)
            .json(json!({"timezone": "Europe/London", "display_name": "Saket Dev"})),
    )
    .await;
    assert_status(&r, 200);
    assert_eq!(r.json["version"], before);
    assert_eq!(
        events(&ctx, &with_tz, types::ACCOUNT_UPDATED).await.len(),
        2
    );
    // An empty patch is a no-op too.
    let r = call(&ctx, Req::patch("/v1/me").bearer(&tok).json(json!({}))).await;
    assert_status(&r, 200);
    assert_eq!(r.json["version"], before);

    let audit: i64 = scalar(
        &ctx,
        "select count(*) from audit_log where account_uuid = $1 and action = 'account.profile.updated'",
        &carbon.uuid,
    )
    .await;
    assert_eq!(audit, 2);
}

#[tokio::test]
async fn patch_reports_every_invalid_field() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let tok = token(&ctx, &carbon).await;
    let r = call(
        &ctx,
        Req::patch("/v1/me").bearer(&tok).json(json!({
            "display_name": "",
            "timezone": "Mars/Olympus",
            "dob": "3020-01-01",
            "pfp_url": "http://example.com/me.png",
            "id": "c:other",
            "email": "x@example.com",
            "favourite_colour": "blue",
        })),
    )
    .await;
    assert_error(&r, 422, "validation_failed");
    let fields = &r.json["error"]["details"]["fields"];
    for f in [
        "display_name",
        "timezone",
        "dob",
        "pfp_url",
        "id",
        "email",
        "favourite_colour",
    ] {
        assert!(fields[f].as_str().is_some(), "{f} not reported: {fields}");
    }
    assert!(
        fields["id"]
            .as_str()
            .is_some_and(|m| m.contains("POST /v1/me/id"))
    );
    assert!(
        fields["email"]
            .as_str()
            .is_some_and(|m| m.contains("/v1/me/emails"))
    );
    assert!(
        fields["pfp_url"]
            .as_str()
            .is_some_and(|m| m.contains("https"))
    );

    let r = call(
        &ctx,
        Req::patch("/v1/me")
            .bearer(&tok)
            .json(json!({"display_name": 7})),
    )
    .await;
    assert_error(&r, 422, "validation_failed");
    let r = call(&ctx, Req::patch("/v1/me").bearer(&tok).json(json!("hi"))).await;
    assert_error(&r, 422, "validation_failed");
    let r = call(
        &ctx,
        Req::patch("/v1/me")
            .bearer(&tok)
            .header("content-type", "application/json")
            .json(json!({}))
            .header("content-type", "text/plain"),
    )
    .await;
    assert_error(&r, 400, "invalid_content_type");

    // Nothing was applied.
    let after = reload(&ctx, &carbon.uuid).await;
    assert_eq!(after.version, carbon.version);
    assert_eq!(after.display_name, carbon.display_name);
}

#[tokio::test]
async fn silicons_update_themselves_but_never_their_dob() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let (silicon, _) = ctx.silicon(&carbon.uuid).await;
    set_silicon_webhook(&ctx, &silicon.uuid).await;
    let app = member_app(&ctx, "remind", &silicon, &[Scope::Profile, Scope::Timezone]).await;
    let tok = token(&ctx, &silicon).await;

    let r = call(
        &ctx,
        Req::patch("/v1/me")
            .bearer(&tok)
            .json(json!({"display_name": "Scout", "timezone": "UTC"})),
    )
    .await;
    assert_status(&r, 200);
    assert_eq!(r.json["display_name"], "Scout");
    let own = events(&ctx, &silicon.uuid, types::SILICON_UPDATED).await;
    assert_eq!(own.len(), 1);
    assert_eq!(own[0]["silicon"], silicon.uuid);
    assert_eq!(own[0]["data"]["changed"], json!(["display_name"]));
    let app_events = events(&ctx, &app, types::ACCOUNT_UPDATED).await;
    assert_eq!(app_events.len(), 1);
    assert_eq!(
        app_events[0]["data"]["account"]["custodian"]["id"],
        carbon.handle.clone().expect("id")
    );

    let r = call(
        &ctx,
        Req::patch("/v1/me")
            .bearer(&tok)
            .json(json!({"dob": "1999-01-01"})),
    )
    .await;
    assert_error(&r, 422, "dob_immutable");
    let same = accounts_core::timefmt::format_date(silicon.dob);
    let r = call(
        &ctx,
        Req::patch("/v1/me").bearer(&tok).json(json!({"dob": same})),
    )
    .await;
    assert_status(&r, 200);
}

#[tokio::test]
async fn patch_photo_url_rules() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let other = ctx.carbon().await;
    let tok = token(&ctx, &carbon).await;

    let r = call(
        &ctx,
        Req::patch("/v1/me")
            .bearer(&tok)
            .json(json!({"pfp_url": "https://cdn.example.com/me.png"})),
    )
    .await;
    assert_status(&r, 200);
    assert_eq!(r.json["pfp_url"], "https://cdn.example.com/me.png");

    let r = call(
        &ctx,
        Req::patch("/v1/me")
            .bearer(&tok)
            .json(json!({"pfp_url": null})),
    )
    .await;
    assert_status(&r, 200);
    assert_eq!(
        r.json["pfp_url"],
        format!(
            "https://iris.teamofsilicons.com/pfp/carbon?id={}",
            carbon.uuid
        )
    );

    // Another account's uploaded photo can't be borrowed.
    let up = call(
        &ctx,
        raw(
            Req::post("/v1/me/photo").bearer(&token(&ctx, &other).await),
            Some("image/png"),
            images::png(8, 8),
        ),
    )
    .await;
    assert_status(&up, 201);
    let theirs = up.json["pfp_url"].as_str().expect("url").to_string();
    let r = call(
        &ctx,
        Req::patch("/v1/me")
            .bearer(&tok)
            .json(json!({"pfp_url": theirs})),
    )
    .await;
    assert_error(&r, 422, "validation_failed");
    assert!(
        r.json["error"]["details"]["fields"]["pfp_url"]
            .as_str()
            .is_some()
    );
}

#[tokio::test]
async fn cookie_patches_need_the_site_origin() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let cookie = ctx.browser_session(&carbon).await;
    let body = json!({"display_name": "Via Cookie"});

    let r = call(
        &ctx,
        Req::patch("/v1/me")
            .header("cookie", &format!("sa_session={cookie}"))
            .json(body.clone()),
    )
    .await;
    assert_error(&r, 403, "origin_not_allowed");
    let r = call(
        &ctx,
        Req::patch("/v1/me")
            .header("cookie", &format!("sa_session={cookie}"))
            .header("origin", "https://evil.example")
            .json(body.clone()),
    )
    .await;
    assert_error(&r, 403, "origin_not_allowed");
    let r = call(
        &ctx,
        Req::patch("/v1/me")
            .session(&ctx.state.settings, &cookie)
            .json(body),
    )
    .await;
    assert_status(&r, 200);
    assert_eq!(r.json["display_name"], "Via Cookie");
}

#[tokio::test]
async fn patch_is_idempotent_with_a_key() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let tok = token(&ctx, &carbon).await;
    let req = |name: &str| {
        Req::patch("/v1/me")
            .bearer(&tok)
            .header("idempotency-key", "patch-1")
            .json(json!({ "display_name": name }))
    };
    let first = call(&ctx, req("Once")).await;
    assert_status(&first, 200);
    let again = call(&ctx, req("Once")).await;
    assert_status(&again, 200);
    assert_eq!(
        again
            .headers
            .get("idempotent-replayed")
            .and_then(|v| v.to_str().ok()),
        Some("true")
    );
    assert_eq!(again.json, first.json);
    let reused = call(&ctx, req("Twice")).await;
    assert_error(&reused, 409, "idempotency_key_reused");
}

async fn upload(ctx: &TestContext, tok: &str, side: u32) -> String {
    let r = call(
        ctx,
        raw(
            Req::post("/v1/me/photo").bearer(tok),
            Some("image/png"),
            images::png(side, side),
        ),
    )
    .await;
    assert_status(&r, 201);
    r.json["pfp_url"].as_str().expect("pfp_url").to_string()
}

fn photo_path(url: &str) -> String {
    url[url.find("/v1/photos/").expect("a photo url")..].to_string()
}

#[tokio::test]
async fn own_photo_urls_must_be_written_exactly() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let (silicon, _) = ctx.silicon(&carbon.uuid).await;
    let app = member_app(&ctx, "photo", &carbon, &[Scope::Profile]).await;
    let tok = token(&ctx, &carbon).await;
    let older = upload(&ctx, &tok, 8).await;
    // Its Silicon shows the older upload, so it is kept after the next upload.
    sqlx::query("update accounts set pfp_url = $2 where uuid = $1")
        .bind(&silicon.uuid)
        .bind(&older)
        .execute(&ctx.state.db)
        .await
        .expect("silicon shows the older photo");
    let current = upload(&ctx, &tok, 9).await;
    let i = older.find("/v1/photos/").expect("photo url") + "/v1/photos/".len();
    let upper = format!("{}{}", &older[..i], older[i..].to_uppercase());

    for variant in [
        format!("{older}?v=2"),
        format!("{older}#x"),
        format!("{older}/"),
        upper,
    ] {
        let r = call(
            &ctx,
            Req::patch("/v1/me")
                .bearer(&tok)
                .json(json!({ "pfp_url": variant })),
        )
        .await;
        assert_error(&r, 422, "validation_failed");
        let problem = r.json["error"]["details"]["fields"]["pfp_url"]
            .as_str()
            .expect("pfp_url problem");
        assert!(
            problem.contains(&format!("use {older} exactly")),
            "{problem}"
        );
    }
    // Nothing changed and nothing was deleted.
    assert_eq!(reload(&ctx, &carbon.uuid).await.pfp_url, current);
    for url in [&older, &current] {
        assert_status(&call(&ctx, Req::get(&photo_path(url))).await, 200);
    }
    assert_eq!(events(&ctx, &app, types::ACCOUNT_UPDATED).await.len(), 2);

    // The exact URL of an own upload is accepted; the upload it replaces is deleted.
    let r = call(
        &ctx,
        Req::patch("/v1/me")
            .bearer(&tok)
            .json(json!({ "pfp_url": older })),
    )
    .await;
    assert_status(&r, 200);
    assert_eq!(r.json["pfp_url"], older);
    assert_status(&call(&ctx, Req::get(&photo_path(&older))).await, 200);
    assert_error(
        &call(&ctx, Req::get(&photo_path(&current))).await,
        404,
        "photo_not_found",
    );
}

#[tokio::test]
async fn a_silicon_can_send_back_the_photo_its_custodian_gave_it() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let (silicon, _) = ctx.silicon(&carbon.uuid).await;
    let theirs = upload(&ctx, &token(&ctx, &carbon).await, 6).await;
    sqlx::query("update accounts set pfp_url = $2 where uuid = $1")
        .bind(&silicon.uuid)
        .bind(&theirs)
        .execute(&ctx.state.db)
        .await
        .expect("the custodian set the Silicon's photo");
    let tok = token(&ctx, &silicon).await;
    let me = call(&ctx, Req::get("/v1/me").bearer(&tok)).await;
    let r = call(
        &ctx,
        Req::patch("/v1/me").bearer(&tok).json(json!({
            "display_name": "Renamed",
            "timezone": me.json["timezone"].clone(),
            "pfp_url": me.json["pfp_url"].clone(),
        })),
    )
    .await;
    assert_status(&r, 200);
    assert_eq!(r.json["display_name"], "Renamed");
    assert_eq!(r.json["pfp_url"], theirs);
    // Choosing another account's upload as a new photo is still refused.
    let other = ctx.carbon().await;
    let foreign = upload(&ctx, &token(&ctx, &other).await, 5).await;
    let r = call(
        &ctx,
        Req::patch("/v1/me")
            .bearer(&tok)
            .json(json!({ "pfp_url": foreign })),
    )
    .await;
    assert_error(&r, 422, "validation_failed");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_photo_check_runs_under_the_account_lock() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let (silicon, _) = ctx.silicon(&carbon.uuid).await;
    let tok = token(&ctx, &carbon).await;
    let kept = upload(&ctx, &tok, 4).await;
    sqlx::query("update accounts set pfp_url = $2 where uuid = $1")
        .bind(&silicon.uuid)
        .bind(&kept)
        .execute(&ctx.state.db)
        .await
        .expect("silicon shows it");
    let current = upload(&ctx, &tok, 5).await;
    let photo_id = uuid::Uuid::parse_str(&kept[kept.rfind('/').expect("id") + 1..]).expect("id");

    // While the PATCH waits for the account row, another request (holding it) deletes the
    // photo. The PATCH must see that, not set pfp_url to a photo that no longer exists.
    let mut other = ctx.state.db.begin().await.expect("begin");
    sqlx::query("select 1 from accounts where uuid = $1 for update")
        .bind(&carbon.uuid)
        .execute(&mut *other)
        .await
        .expect("lock");
    let patch = call(
        &ctx,
        Req::patch("/v1/me")
            .bearer(&tok)
            .json(json!({ "pfp_url": kept })),
    );
    let prune = async {
        wait_for_lock_waiters(&ctx, 1).await;
        sqlx::query("delete from photos where id = $1")
            .bind(photo_id)
            .execute(&mut *other)
            .await
            .expect("delete photo");
        other.commit().await.expect("commit");
    };
    let (r, ()) = tokio::join!(patch, prune);
    assert_error(&r, 422, "validation_failed");
    assert_eq!(reload(&ctx, &carbon.uuid).await.pfp_url, current);
}
