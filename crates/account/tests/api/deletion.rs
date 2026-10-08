//! `DELETE /v1/me`, and the reservation sweep.

use accounts_core::events::types;
use accounts_core::models::{Provider, Scope};
use accounts_core::repo::{contacts, identities};
use accounts_core::test_support::{Req, TestContext};
use serde_json::json;
use uuid::Uuid;

use crate::common::*;

#[tokio::test]
async fn custodians_must_hand_over_their_silicons_first() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let (silicon, _) = ctx.silicon(&carbon.uuid).await;
    let id = carbon.handle.clone().expect("id");
    let r = call(
        &ctx,
        Req::delete("/v1/me")
            .bearer(&token(&ctx, &carbon).await)
            .json(json!({ "confirm": id })),
    )
    .await;
    assert_error(&r, 409, "custodian_of_silicons");
    let listed = &r.json["error"]["details"]["silicons"];
    assert_eq!(listed[0]["uuid"], silicon.uuid);
    assert_eq!(listed[0]["id"], silicon.handle.clone().expect("id"));
    assert!(
        r.json["error"]["hint"]
            .as_str()
            .is_some_and(|h| h.contains("transfer"))
    );
    assert_eq!(reload(&ctx, &carbon.uuid).await.status.as_str(), "active");
}

#[tokio::test]
async fn deletion_must_be_confirmed_with_the_current_id() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let tok = token(&ctx, &carbon).await;
    let r = call(&ctx, Req::delete("/v1/me").bearer(&tok)).await;
    assert_error(&r, 422, "confirmation_required");
    let r = call(
        &ctx,
        Req::delete("/v1/me")
            .bearer(&tok)
            .json(json!({ "confirm": "c:someone-else" })),
    )
    .await;
    assert_error(&r, 422, "confirmation_mismatch");
    assert!(
        r.json["error"]["message"]
            .as_str()
            .is_some_and(|m| m.contains("nothing was deleted"))
    );

    let (silicon, _) = ctx.silicon(&carbon.uuid).await;
    let r = call(
        &ctx,
        Req::delete("/v1/me")
            .bearer(&token(&ctx, &silicon).await)
            .json(json!({ "confirm": silicon.handle.clone().expect("id") })),
    )
    .await;
    assert_error(&r, 403, "custodian_required");
    assert!(
        r.json["error"]["message"]
            .as_str()
            .is_some_and(|m| m.contains(carbon.handle.as_deref().unwrap_or_default()))
    );
}

#[tokio::test]
async fn deleting_an_account_removes_it_everywhere() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let old_id = carbon.handle.clone().expect("id");
    let app = member_app(&ctx, "briefcase", &carbon, &[Scope::Profile, Scope::Email]).await;
    let mut conn = ctx.conn().await;
    contacts::add_verified_phone(&mut conn, &carbon.uuid, "+919876543210")
        .await
        .expect("phone");
    identities::link(
        &mut conn,
        Provider::Google,
        "g-1",
        "managed",
        &carbon.uuid,
        None,
    )
    .await
    .expect("identity");
    drop(conn);
    let app_tokens = ctx.tokens_for(&carbon, &app, &[Scope::Profile]).await;
    let cli = token(&ctx, &carbon).await;
    let cookie = ctx.browser_session(&carbon).await;
    let upload = call(
        &ctx,
        raw(
            Req::post("/v1/me/photo").bearer(&cli),
            Some("image/png"),
            images::png(4, 4),
        ),
    )
    .await;
    assert_status(&upload, 201);
    let photo_url = upload.json["pfp_url"].as_str().expect("url").to_string();
    let proof = Uuid::now_v7();
    sqlx::query(
        "insert into proof_families (id, kind, issuing_app, audiences, account_uuid, access_ttl_seconds, expires_at) \
         values ($1, 'user_verification', $2, '{other}', $3, 600, now() + interval '900 days')",
    )
    .bind(proof)
    .bind(&app)
    .bind(&carbon.uuid)
    .execute(&ctx.state.db)
    .await
    .expect("proof");

    let r = call(
        &ctx,
        Req::delete("/v1/me")
            .session(&ctx.state.settings, &cookie)
            .json(json!({ "confirm": old_id.to_uppercase() })),
    )
    .await;
    assert_status(&r, 204);
    let set_cookie = r
        .headers
        .get("set-cookie")
        .and_then(|v| v.to_str().ok())
        .expect("cookie cleared");
    assert!(set_cookie.contains("Max-Age=0"));

    let gone = reload(&ctx, &carbon.uuid).await;
    assert_eq!(gone.status.as_str(), "deleted");
    assert_eq!(gone.handle, None);
    assert!(
        gone.pfp_url
            .starts_with("https://iris.teamofsilicons.com/pfp/carbon")
    );
    let reserved: i64 = scalar(
        &ctx,
        "select count(*) from handle_reservations where handle = $1",
        &old_id,
    )
    .await;
    assert_eq!(reserved, 1, "the id is reserved for 10 days");
    for table in ["account_emails", "account_phones", "identities", "photos"] {
        let n: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
            "select count(*) from {table} where account_uuid = $1"
        )))
        .bind(&carbon.uuid)
        .fetch_one(&ctx.state.db)
        .await
        .expect("count");
        assert_eq!(n, 0, "{table} emptied");
    }
    let live_families: i64 = scalar(
        &ctx,
        "select count(*) from token_families where account_uuid = $1 and revoked_at is null",
        &carbon.uuid,
    )
    .await;
    assert_eq!(live_families, 0);
    let proof_revoked: bool =
        sqlx::query_scalar("select revoked_at is not null from proof_families where id = $1")
            .bind(proof)
            .fetch_one(&ctx.state.db)
            .await
            .expect("proof");
    assert!(proof_revoked);
    let evs = events(&ctx, &app, types::ACCOUNT_DELETED).await;
    assert_eq!(evs.len(), 1);
    assert_eq!(evs[0]["data"]["uuid"], carbon.uuid);
    assert_eq!(
        evs[0]["data"]["membership_id"],
        format!("{app}:{}", carbon.uuid)
    );
    assert!(
        accounts_core::repo::tokens::refresh(
            &ctx.state.db,
            &ctx.state.keys,
            &ctx.state.settings,
            &app_tokens.refresh_token,
            &app,
        )
        .await
        .is_err()
    );

    // Every credential is dead, the photo is gone, lookups say deleted, the id is reserved.
    let r = call(
        &ctx,
        Req::get("/v1/me").session(&ctx.state.settings, &cookie),
    )
    .await;
    assert_status(&r, 401);
    let r = call(&ctx, Req::get("/v1/me").bearer(&cli)).await;
    assert_status(&r, 401);
    let i = photo_url.find("/v1/photos/").expect("photo path");
    let r = call(&ctx, Req::get(&photo_url[i..])).await;
    assert_error(&r, 404, "photo_not_found");
    let other = ctx.carbon().await;
    let other_tok = token(&ctx, &other).await;
    let r = call(
        &ctx,
        Req::get(&format!("/v1/accounts/{}", carbon.uuid)).bearer(&other_tok),
    )
    .await;
    assert_error(&r, 404, "account_deleted");
    let r = call(
        &ctx,
        Req::get(&format!(
            "/v1/ids/available?id={}",
            old_id.replace(':', "%3A")
        )),
    )
    .await;
    assert_eq!(r.json["reason"], "reserved");
    let audit: i64 = scalar(
        &ctx,
        "select count(*) from audit_log where account_uuid = $1 and action = 'account.deleted'",
        &carbon.uuid,
    )
    .await;
    assert_eq!(audit, 1);
}

#[tokio::test]
async fn silicons_waiting_for_a_deleted_carbon_are_released() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let waiting = pending_silicon(&ctx).await;
    let waiting_id = waiting.handle.clone().expect("id");
    set_silicon_webhook(&ctx, &waiting.uuid).await;
    let request = Uuid::now_v7();
    sqlx::query(
        "insert into custodian_requests (id, silicon_uuid, kind, to_uuid, status, expires_at) \
         values ($1, $2, 'initial', $3, 'pending', now() + interval '14 days')",
    )
    .bind(request)
    .bind(&waiting.uuid)
    .bind(&carbon.uuid)
    .execute(&ctx.state.db)
    .await
    .expect("request");

    let r = call(
        &ctx,
        Req::delete("/v1/me")
            .bearer(&token(&ctx, &carbon).await)
            .json(json!({ "confirm": carbon.handle.clone().expect("id") })),
    )
    .await;
    assert_status(&r, 204);

    let released = reload(&ctx, &waiting.uuid).await;
    assert_eq!(released.status.as_str(), "deleted");
    assert_eq!(released.handle, None);
    assert!(
        released.webhook_url.is_some(),
        "kept so the notice can be delivered"
    );
    let reserved: i64 = scalar(
        &ctx,
        "select count(*) from handle_reservations where handle = $1",
        &waiting_id,
    )
    .await;
    assert_eq!(reserved, 0, "a released Silicon's id is free at once");
    let status: String = sqlx::query_scalar("select status from custodian_requests where id = $1")
        .bind(request)
        .fetch_one(&ctx.state.db)
        .await
        .expect("request");
    assert_eq!(status, "cancelled");
    let evs = events(&ctx, &waiting.uuid, types::SILICON_CUSTODIAN_DECLINED).await;
    assert_eq!(evs.len(), 1);
    // The same payload the silicons crate sends when its sweep releases such a Silicon.
    let data = &evs[0]["data"];
    let mut keys: Vec<&str> = data
        .as_object()
        .expect("object")
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        vec![
            "custodian",
            "decided_at",
            "id",
            "reason",
            "released",
            "request_id",
            "uuid"
        ]
    );
    assert_eq!(data["reason"], "custodian_account_deleted");
    assert_eq!(data["id"], waiting_id);
    assert_eq!(data["uuid"], waiting.uuid);
    assert_eq!(data["request_id"], request.to_string());
    assert_eq!(data["custodian"], carbon.handle.clone().expect("id"));
    assert_eq!(data["released"], true);
    assert!(
        data["decided_at"]
            .as_str()
            .is_some_and(|t| t.ends_with('Z') && t.len() == 24),
        "{data}"
    );
    let closed: (String, serde_json::Value) = sqlx::query_as(
        "select target_kind, details from audit_log where account_uuid = $1 and action = 'silicon.custodian_request.closed'",
    )
    .bind(&waiting.uuid)
    .fetch_one(&ctx.state.db)
    .await
    .expect("audit entry");
    assert_eq!(closed.0, "silicon");
    assert_eq!(closed.1["released_id"], waiting_id);
    assert_eq!(closed.1["reason"], "custodian_account_deleted");
    let r = call(
        &ctx,
        Req::get(&format!(
            "/v1/ids/available?id={}",
            waiting_id.replace(':', "%3A")
        )),
    )
    .await;
    assert_eq!(r.json["available"], true);
}

#[tokio::test]
async fn the_sweep_drops_reservations_that_ended() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    sqlx::query(
        "insert into handle_reservations (handle, account_uuid, reserved_until) values \
         ('c:long-gone', $1, now() - interval '3 days'), ('c:still-held', $1, now() + interval '3 days')",
    )
    .bind(&carbon.uuid)
    .execute(&ctx.state.db)
    .await
    .expect("reservations");
    let removed = accounts_account::sweep_expired_reservations(&ctx.state.db)
        .await
        .expect("sweep");
    assert_eq!(removed, 1);
    let left: Vec<String> = sqlx::query_scalar("select handle from handle_reservations")
        .fetch_all(&ctx.state.db)
        .await
        .expect("left");
    assert_eq!(left, vec!["c:still-held".to_string()]);
}

#[tokio::test]
async fn a_transfer_waiting_for_a_deleted_carbon_is_just_cancelled() {
    let ctx = TestContext::new().await;
    let custodian = ctx.carbon().await;
    let leaving = ctx.carbon().await;
    let (silicon, _) = ctx.silicon(&custodian.uuid).await;
    set_silicon_webhook(&ctx, &silicon.uuid).await;
    let request = Uuid::now_v7();
    sqlx::query(
        "insert into custodian_requests (id, silicon_uuid, kind, from_uuid, to_uuid, status, expires_at) \
         values ($1, $2, 'transfer', $3, $4, 'pending', now() + interval '14 days')",
    )
    .bind(request)
    .bind(&silicon.uuid)
    .bind(&custodian.uuid)
    .bind(&leaving.uuid)
    .execute(&ctx.state.db)
    .await
    .expect("transfer request");

    let r = call(
        &ctx,
        Req::delete("/v1/me")
            .bearer(&token(&ctx, &leaving).await)
            .json(json!({ "confirm": leaving.handle.clone().expect("id") })),
    )
    .await;
    assert_status(&r, 204);
    let status: String = sqlx::query_scalar("select status from custodian_requests where id = $1")
        .bind(request)
        .fetch_one(&ctx.state.db)
        .await
        .expect("request");
    assert_eq!(status, "cancelled");
    let kept = reload(&ctx, &silicon.uuid).await;
    assert_eq!(kept.status.as_str(), "active");
    assert_eq!(
        kept.custodian_uuid.as_deref(),
        Some(custodian.uuid.as_str())
    );
    assert!(
        events(&ctx, &silicon.uuid, types::SILICON_CUSTODIAN_DECLINED)
            .await
            .is_empty()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_second_delete_in_flight_does_nothing() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let app = member_app(&ctx, "twice", &carbon, &[Scope::Profile]).await;
    let tok = token(&ctx, &carbon).await;
    let cookie = ctx.browser_session(&carbon).await;
    let id = carbon.handle.clone().expect("id");

    // Both requests authenticate, then queue behind a transaction holding the account row.
    let mut holder = ctx.state.db.begin().await.expect("begin");
    sqlx::query("select 1 from accounts where uuid = $1 for update")
        .bind(&carbon.uuid)
        .execute(&mut *holder)
        .await
        .expect("lock");
    let by_token = call(
        &ctx,
        Req::delete("/v1/me")
            .bearer(&tok)
            .json(json!({ "confirm": id })),
    );
    let by_cookie = call(
        &ctx,
        Req::delete("/v1/me")
            .session(&ctx.state.settings, &cookie)
            .json(json!({ "confirm": id })),
    );
    let release = async {
        wait_for_lock_waiters(&ctx, 2).await;
        holder.commit().await.expect("commit");
    };
    let (a, b, ()) = tokio::join!(by_token, by_cookie, release);
    assert_status(&a, 204);
    assert_status(&b, 204);
    assert!(
        b.headers
            .get("set-cookie")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|c| c.contains("Max-Age=0")),
        "the cookie request still clears its cookie"
    );
    assert_eq!(events(&ctx, &app, types::ACCOUNT_DELETED).await.len(), 1);
    let audits: i64 = scalar(
        &ctx,
        "select count(*) from audit_log where account_uuid = $1 and action = 'account.deleted'",
        &carbon.uuid,
    )
    .await;
    assert_eq!(audits, 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_confirmation_naming_an_id_changed_meanwhile_deletes_nothing() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let tok = token(&ctx, &carbon).await;
    let old_id = carbon.handle.clone().expect("id");
    let mut holder = ctx.state.db.begin().await.expect("begin");
    sqlx::query("select 1 from accounts where uuid = $1 for update")
        .bind(&carbon.uuid)
        .execute(&mut *holder)
        .await
        .expect("lock");
    let delete = call(
        &ctx,
        Req::delete("/v1/me")
            .bearer(&tok)
            .json(json!({ "confirm": old_id })),
    );
    let new_id = accounts_core::ids::AccountId::new(
        accounts_core::models::AccountKind::Carbon,
        &format!("moved-{}", accounts_core::test_support::rand_suffix()),
    )
    .expect("id");
    let rename = async {
        wait_for_lock_waiters(&ctx, 1).await;
        accounts_core::repo::accounts::change_id(&mut holder, &carbon.uuid, &new_id, &carbon.uuid)
            .await
            .expect("change id");
        holder.commit().await.expect("commit");
    };
    let (r, ()) = tokio::join!(delete, rename);
    assert_error(&r, 422, "confirmation_mismatch");
    assert!(
        r.json["error"]["hint"]
            .as_str()
            .is_some_and(|h| h.contains(&new_id.to_string())),
        "{}",
        r.json
    );
    assert_eq!(reload(&ctx, &carbon.uuid).await.status.as_str(), "active");
}

#[tokio::test]
async fn deleting_keeps_a_photo_another_account_shows() {
    let ctx = TestContext::new().await;
    let leaving = ctx.carbon().await;
    let staying = ctx.carbon().await;
    let (silicon, _) = ctx.silicon(&leaving.uuid).await;
    let tok = token(&ctx, &leaving).await;
    let upload = |side: u32| {
        raw(
            Req::post("/v1/me/photo").bearer(&tok),
            Some("image/png"),
            images::png(side, side),
        )
    };
    let given = call(&ctx, upload(3)).await.json["pfp_url"]
        .as_str()
        .expect("url")
        .to_string();
    sqlx::query("update accounts set pfp_url = $2, custodian_uuid = $3 where uuid = $1")
        .bind(&silicon.uuid)
        .bind(&given)
        .bind(&staying.uuid)
        .execute(&ctx.state.db)
        .await
        .expect("the Silicon shows it and was transferred");
    let own = call(&ctx, upload(4)).await.json["pfp_url"]
        .as_str()
        .expect("url")
        .to_string();

    let r = call(
        &ctx,
        Req::delete("/v1/me")
            .bearer(&tok)
            .json(json!({ "confirm": leaving.handle.clone().expect("id") })),
    )
    .await;
    assert_status(&r, 204);
    let path = |url: &str| url[url.find("/v1/photos/").expect("photo path")..].to_string();
    assert_status(&call(&ctx, Req::get(&path(&given))).await, 200);
    assert_error(
        &call(&ctx, Req::get(&path(&own))).await,
        404,
        "photo_not_found",
    );
    assert_eq!(reload(&ctx, &silicon.uuid).await.pfp_url, given);
}
