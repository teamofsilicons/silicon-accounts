//! `GET /v1/me/custodian-requests` and accepting / declining a self-created Silicon's request.

use accounts_core::events;
use accounts_core::models::{AccountStatus, WebhookTargetKind};
use accounts_core::test_support::{CarbonSpec, Req, TestContext};
use serde_json::{Value, json};

use crate::common::*;

#[tokio::test]
async fn requests_are_listed_by_id_and_by_verified_email_only() {
    let ctx = TestContext::new().await;
    let email = format!(
        "multi-{}@example.test",
        accounts_core::test_support::rand_suffix()
    );
    let me = ctx
        .carbon_with(CarbonSpec {
            email: Some(email.clone()),
            ..Default::default()
        })
        .await;
    let t = token(&ctx, &me).await;
    let by_id = self_created(&ctx, me.handle.as_deref().expect("id"), json!({})).await;
    let by_email = self_created(&ctx, &email, json!({})).await;
    // An address I have but haven't verified doesn't count.
    let unverified = format!(
        "unverified-{}@example.test",
        accounts_core::test_support::rand_suffix()
    );
    ctx.exec(&format!(
        "insert into account_emails (email, account_uuid, is_primary, verified_at) values ('{unverified}', '{}', false, null)",
        me.uuid
    ))
    .await;
    let hidden = self_created(&ctx, &unverified, json!({})).await;
    // Someone else's request.
    let other = ctx.carbon().await;
    self_created(&ctx, other.handle.as_deref().expect("id"), json!({})).await;

    let r = call(&ctx, Req::get("/v1/me/custodian-requests").bearer(&t)).await;
    assert_eq!(r.status, 200, "{}", r.json);
    let items = r.json["items"].as_array().expect("items");
    let ids: Vec<&Value> = items.iter().map(|i| &i["id"]).collect();
    assert_eq!(
        ids,
        vec![&by_email["request"]["id"], &by_id["request"]["id"]],
        "newest first"
    );
    let item = &items[1];
    assert_eq!(item["kind"], "initial");
    assert_eq!(item["status"], "pending");
    assert_eq!(item["from"], Value::Null);
    assert_eq!(item["silicon"]["uuid"], by_id["silicon"]["uuid"]);
    assert_eq!(item["silicon"]["status"], "pending_custodian");
    assert_eq!(item["to"]["uuid"], me.uuid);
    assert!(item["created_at"].is_string() && item["expires_at"].is_string());

    // Pagination.
    let p1 = call(
        &ctx,
        Req::get("/v1/me/custodian-requests?limit=1").bearer(&t),
    )
    .await;
    assert_eq!(p1.json["items"].as_array().map(Vec::len), Some(1));
    let cursor = p1.json["next_cursor"].as_str().expect("cursor");
    let p2 = call(
        &ctx,
        Req::get(&format!(
            "/v1/me/custodian-requests?limit=1&cursor={cursor}"
        ))
        .bearer(&t),
    )
    .await;
    assert_eq!(p2.json["items"][0]["id"], by_id["request"]["id"]);
    assert_eq!(p2.json["next_cursor"], Value::Null);

    // Verifying the address makes that request appear.
    ctx.exec(&format!(
        "update account_emails set verified_at = now(), verified_via = 'code' where email = '{unverified}'"
    ))
    .await;
    let r = call(&ctx, Req::get("/v1/me/custodian-requests").bearer(&t)).await;
    assert_eq!(r.json["items"][0]["id"], hidden["request"]["id"]);

    // Overdue requests are not offered.
    make_overdue(&ctx, by_id["request"]["id"].as_str().expect("id")).await;
    let r = call(&ctx, Req::get("/v1/me/custodian-requests").bearer(&t)).await;
    assert_eq!(r.json["items"].as_array().map(Vec::len), Some(2));

    // Silicons have no custodian requests.
    let (silicon, _) = ctx.silicon(&me.uuid).await;
    let r = call(
        &ctx,
        Req::get("/v1/me/custodian-requests").bearer(&token(&ctx, &silicon).await),
    )
    .await;
    assert_eq!(r.status, 403);
    assert_eq!(r.error_code(), Some("carbon_only"));
}

#[tokio::test]
async fn accepting_activates_the_silicon_with_me_as_custodian() {
    let ctx = TestContext::new().await;
    let me = ctx.carbon().await;
    let t = token(&ctx, &me).await;
    let created = self_created(
        &ctx,
        me.handle.as_deref().expect("id"),
        json!({"webhook_url": "http://127.0.0.1:8593/hooks/accepted"}),
    )
    .await;
    let uuid = created["silicon"]["uuid"].as_str().expect("uuid");
    let id = created["request"]["id"].as_str().expect("id");
    let r = accept(&ctx, &t, id).await;
    assert_eq!(r.status, 204, "{}", r.json);
    assert!(r.body.is_empty());

    let silicon = account(&ctx, uuid).await;
    assert_eq!(silicon.status, AccountStatus::Active);
    assert_eq!(silicon.custodian_uuid.as_deref(), Some(me.uuid.as_str()));
    let (status, _, to_uuid, _, decided_by) = request_row(&ctx, id).await;
    assert_eq!(status, "accepted");
    assert_eq!(to_uuid.as_deref(), Some(me.uuid.as_str()));
    assert_eq!(decided_by.as_deref(), Some(me.uuid.as_str()));
    assert_eq!(
        custodian_history(&ctx, uuid).await,
        vec![(None, me.uuid.clone(), "initial_accepted".to_string())]
    );
    let events = silicon_events(&ctx, uuid).await;
    let (t2, p) = events.last().expect("event");
    assert_eq!(t2, "silicon.custodian.accepted");
    assert_eq!(p["data"]["request_id"], id);
    assert_eq!(p["data"]["custodian"]["uuid"], me.uuid);
    assert_eq!(p["data"]["silicon"]["status"], "active");
    // It is now in my list and signs in.
    let list = call(&ctx, Req::get("/v1/me/silicons").bearer(&t)).await;
    assert_eq!(list.json["items"][0]["uuid"], uuid);
    let ok = login(
        &ctx,
        created["silicon"]["id"].as_str().expect("id"),
        created["stk"].as_str().expect("stk"),
    )
    .await;
    assert_eq!(ok.status, 200, "{}", ok.json);
    assert!(
        audit_actions(&ctx, &me.uuid)
            .await
            .contains(&"silicon.custodian.accepted".to_string())
    );

    // Deciding twice is refused precisely.
    let again = accept(&ctx, &t, id).await;
    assert_eq!(again.status, 409);
    assert_eq!(again.error_code(), Some("custodian_request_not_pending"));
    assert_eq!(again.json["error"]["details"]["status"], "accepted");
}

#[tokio::test]
async fn declining_releases_the_silicon_and_still_reaches_its_webhook() {
    let ctx = TestContext::new().await;
    let me = ctx.carbon().await;
    let t = token(&ctx, &me).await;
    let created = self_created(
        &ctx,
        me.handle.as_deref().expect("id"),
        json!({"webhook_url": "http://127.0.0.1:8593/hooks/declined"}),
    )
    .await;
    let uuid = created["silicon"]["uuid"].as_str().expect("uuid");
    let sid = created["silicon"]["id"].as_str().expect("id").to_string();
    let id = created["request"]["id"].as_str().expect("id");
    assert_eq!(decline(&ctx, &t, id).await.status, 204);

    let silicon = account(&ctx, uuid).await;
    assert_eq!(silicon.status, AccountStatus::Deleted);
    assert_eq!(silicon.handle, None);
    assert_eq!(silicon.stk_hash, None);
    assert_eq!(request_row(&ctx, id).await.0, "declined");
    let events = silicon_events(&ctx, uuid).await;
    let (t2, p) = events.last().expect("event");
    assert_eq!(t2, "silicon.custodian.declined");
    assert_eq!(p["data"]["id"], sid);
    assert_eq!(p["data"]["released"], true);
    assert_eq!(p["data"]["custodian"], me.handle.clone().expect("id"));
    // The worker delivers to the Silicon's *current* webhook: it must still be there.
    let mut conn = ctx.conn().await;
    let url = events::current_url(&mut conn, WebhookTargetKind::Silicon, uuid)
        .await
        .expect("url");
    assert_eq!(url.as_deref(), Some("http://127.0.0.1:8593/hooks/declined"));
    let secret = events::current_secret(
        &mut conn,
        &ctx.state.keys.keyring,
        WebhookTargetKind::Silicon,
        uuid,
    )
    .await
    .expect("secret");
    assert_eq!(secret.as_deref(), created["webhook_secret"].as_str());
    drop(conn);

    // Released at once: no 10-day reservation, anyone can take the id.
    let other = ctx.carbon().await;
    let r = call(
        &ctx,
        Req::post("/v1/me/silicons")
            .bearer(&token(&ctx, &other).await)
            .json(json!({"id": sid, "display_name": "Taken over"})),
    )
    .await;
    assert_eq!(r.status, 201, "{}", r.json);
    let history: Vec<(Option<String>, Option<String>, String)> = sqlx::query_as(
        "select old_handle, new_handle, changed_by from handle_history where account_uuid = $1 order by id",
    )
    .bind(uuid)
    .fetch_all(&ctx.state.db)
    .await
    .expect("history");
    assert_eq!(
        history.last().cloned(),
        Some((Some(sid.clone()), None, me.uuid.clone()))
    );
}

#[tokio::test]
async fn only_the_addressed_carbon_decides_and_overdue_requests_expire() {
    let ctx = TestContext::new().await;
    let me = ctx.carbon().await;
    let stranger = ctx.carbon().await;
    let created = self_created(&ctx, me.handle.as_deref().expect("id"), json!({})).await;
    let id = created["request"]["id"].as_str().expect("id");
    let r = accept(&ctx, &token(&ctx, &stranger).await, id).await;
    assert_eq!(r.status, 404);
    assert_eq!(r.error_code(), Some("custodian_request_not_found"));
    let r = decline(&ctx, &token(&ctx, &stranger).await, id).await;
    assert_eq!(r.status, 404);
    let r = accept(&ctx, &token(&ctx, &me).await, "not-a-request").await;
    assert_eq!(r.status, 404);
    let r = call(
        &ctx,
        Req::post(&format!("/v1/me/custodian-requests/{id}/accept")),
    )
    .await;
    assert_eq!(r.status, 401);

    make_overdue(&ctx, id).await;
    let r = accept(&ctx, &token(&ctx, &me).await, id).await;
    assert_eq!(r.status, 410, "{}", r.json);
    assert_eq!(r.error_code(), Some("custodian_request_expired"));
    assert_eq!(request_row(&ctx, id).await.0, "expired");
    let silicon = account(&ctx, created["silicon"]["uuid"].as_str().expect("uuid")).await;
    assert_eq!(silicon.status, AccountStatus::Deleted);
    // Once recorded as expired it stays a 410, not a generic conflict.
    let r = decline(&ctx, &token(&ctx, &me).await, id).await;
    assert_eq!(r.status, 410);
    assert_eq!(r.error_code(), Some("custodian_request_expired"));
}

#[tokio::test]
async fn cookie_sessions_need_the_site_origin() {
    let ctx = TestContext::new().await;
    let me = ctx.carbon().await;
    let cookie = ctx.browser_session(&me).await;
    let created = self_created(&ctx, me.handle.as_deref().expect("id"), json!({})).await;
    let id = created["request"]["id"].as_str().expect("id");
    let r = call(
        &ctx,
        Req::post(&format!("/v1/me/custodian-requests/{id}/accept"))
            .session(&ctx.state.settings, &cookie)
            .header("origin", "https://evil.example"),
    )
    .await;
    assert_eq!(r.status, 403);
    assert_eq!(r.error_code(), Some("origin_not_allowed"));
    let r = call(
        &ctx,
        Req::post(&format!("/v1/me/custodian-requests/{id}/accept"))
            .session(&ctx.state.settings, &cookie),
    )
    .await;
    assert_eq!(r.status, 204, "{}", r.json);
}
