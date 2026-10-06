//! `POST /v1/me/id`: reservation, reclaim, errors and webhooks.

use accounts_core::events::types;
use accounts_core::models::Scope;
use accounts_core::repo::memberships;
use accounts_core::test_support::{CarbonSpec, Req, TestContext, rand_suffix};
use serde_json::{Value, json};
use time::OffsetDateTime;

use crate::common::*;

#[tokio::test]
async fn changing_the_id_reserves_the_old_one_for_its_owner() {
    let ctx = TestContext::new().await;
    let first = format!("first-{}", rand_suffix());
    let second = format!("second-{}", rand_suffix());
    let carbon = ctx
        .carbon_with(CarbonSpec {
            handle: Some(first.clone()),
            ..Default::default()
        })
        .await;
    let active_app = member_app(&ctx, "active", &carbon, &[Scope::Profile]).await;
    let (imported_app, _) = ctx.app("imported").await;
    ctx.set_app_webhook(
        &imported_app.app_id,
        "http://127.0.0.1:8593/imported/webhooks",
    )
    .await;
    let removed_app = member_app(&ctx, "gone", &carbon, &[Scope::Profile]).await;
    let mut conn = ctx.conn().await;
    memberships::upsert_imported(
        &mut conn,
        &imported_app.app_id,
        &carbon.uuid,
        Some("ext-9"),
        None,
        false,
    )
    .await
    .expect("imported membership");
    memberships::remove_access(&mut conn, &removed_app, &carbon.uuid, &carbon.uuid)
        .await
        .expect("remove access");
    drop(conn);
    let tok = token(&ctx, &carbon).await;

    let r = call(
        &ctx,
        Req::post("/v1/me/id")
            .bearer(&tok)
            .json(json!({ "id": format!("C:{}", second.to_uppercase()) })),
    )
    .await;
    assert_status(&r, 200);
    assert_eq!(r.json["id"], format!("c:{second}"));
    assert_eq!(r.json["version"], carbon.version + 1);
    assert!(r.json["emails"].as_array().is_some(), "returns the Me view");

    let until: OffsetDateTime = scalar(
        &ctx,
        "select reserved_until from handle_reservations where handle = $1",
        &format!("c:{first}"),
    )
    .await;
    let days = (until - OffsetDateTime::now_utc()).whole_hours() as f64 / 24.0;
    assert!(
        (9.9..=10.01).contains(&days),
        "reserved for 10 days, got {days}"
    );

    for app in [&active_app, &imported_app.app_id] {
        let evs = events(&ctx, app, types::ACCOUNT_ID_CHANGED).await;
        assert_eq!(evs.len(), 1, "{app}");
        assert_eq!(evs[0]["data"]["old_id"], format!("c:{first}"));
        assert_eq!(evs[0]["data"]["new_id"], format!("c:{second}"));
        assert_eq!(evs[0]["data"]["uuid"], carbon.uuid);
        assert_eq!(evs[0]["data"]["kind"], "carbon");
    }
    assert!(
        events(&ctx, &removed_app, types::ACCOUNT_ID_CHANGED)
            .await
            .is_empty()
    );

    // Nobody else can take the old id while it is reserved.
    let other = ctx.carbon().await;
    let r = call(
        &ctx,
        Req::post("/v1/me/id")
            .bearer(&token(&ctx, &other).await)
            .json(json!({ "id": format!("c:{first}") })),
    )
    .await;
    assert_error(&r, 409, "id_reserved");
    assert!(
        r.json["error"]["details"]["reserved_until"]
            .as_str()
            .is_some()
    );

    // The previous owner takes it back; that reservation disappears and the newer id is reserved.
    let r = call(
        &ctx,
        Req::post("/v1/me/id")
            .bearer(&tok)
            .json(json!({ "id": format!("c:{first}") })),
    )
    .await;
    assert_status(&r, 200);
    assert_eq!(r.json["id"], format!("c:{first}"));
    let reservations: Vec<String> = sqlx::query_scalar(
        "select handle from handle_reservations where account_uuid = $1 order by handle",
    )
    .bind(&carbon.uuid)
    .fetch_all(&ctx.state.db)
    .await
    .expect("reservations");
    assert_eq!(reservations, vec![format!("c:{second}")]);
    let history: i64 = scalar(
        &ctx,
        "select count(*) from handle_history where account_uuid = $1",
        &carbon.uuid,
    )
    .await;
    assert_eq!(history, 3, "created + two changes");
    assert_eq!(
        events(&ctx, &active_app, types::ACCOUNT_ID_CHANGED)
            .await
            .len(),
        2
    );
}

#[tokio::test]
async fn id_change_errors_are_precise() {
    let ctx = TestContext::new().await;
    let taken = format!("taken-{}", rand_suffix());
    ctx.carbon_with(CarbonSpec {
        handle: Some(taken.clone()),
        ..Default::default()
    })
    .await;
    let carbon = ctx.carbon().await;
    let tok = token(&ctx, &carbon).await;
    let post = |id: Value| {
        Req::post("/v1/me/id")
            .bearer(&tok)
            .json(json!({ "id": id }))
    };

    let r = call(&ctx, post(json!("c:ab"))).await;
    assert_error(&r, 422, "invalid_id");
    assert_eq!(r.json["error"]["details"]["reason"], "invalid");
    let r = call(&ctx, post(json!("c:has space"))).await;
    assert_error(&r, 422, "invalid_id");
    assert!(
        r.json["error"]["message"]
            .as_str()
            .is_some_and(|m| m.contains("a space"))
    );
    let r = call(&ctx, post(json!("si:my-silicon"))).await;
    assert_error(&r, 422, "invalid_id");
    let r = call(&ctx, post(json!("c:admin"))).await;
    assert_error(&r, 422, "invalid_id");
    assert_eq!(r.json["error"]["details"]["reason"], "reserved_word");
    let r = call(&ctx, post(json!(format!("c:{taken}")))).await;
    assert_error(&r, 409, "id_taken");
    assert!(
        r.json["error"]["details"]["suggestions"]
            .as_array()
            .is_some_and(|s| !s.is_empty())
    );
    let r = call(&ctx, Req::post("/v1/me/id").bearer(&tok).json(json!({}))).await;
    assert_error(&r, 422, "validation_failed");

    // A bare handle gets the account's prefix; the same id again is a no-op.
    let bare = format!("bare-{}", rand_suffix());
    let r = call(&ctx, post(json!(bare))).await;
    assert_status(&r, 200);
    assert_eq!(r.json["id"], format!("c:{bare}"));
    let version = r.json["version"].clone();
    let r = call(&ctx, post(json!(format!("c:{bare}")))).await;
    assert_status(&r, 200);
    assert_eq!(r.json["version"], version);

    let unauth = call(&ctx, Req::post("/v1/me/id").json(json!({"id": "c:x-y-z"}))).await;
    assert_error(&unauth, 401, "unauthenticated");
}

#[tokio::test]
async fn a_silicon_changes_its_own_id() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let (silicon, _) = ctx.silicon(&carbon.uuid).await;
    set_silicon_webhook(&ctx, &silicon.uuid).await;
    let app = member_app(&ctx, "remind", &silicon, &[Scope::Profile]).await;
    let new_handle = format!("scout-{}", rand_suffix());

    let r = call(
        &ctx,
        Req::post("/v1/me/id")
            .bearer(&token(&ctx, &silicon).await)
            .header("idempotency-key", "rename-1")
            .json(json!({ "id": new_handle })),
    )
    .await;
    assert_status(&r, 200);
    assert_eq!(r.json["id"], format!("si:{new_handle}"));
    assert_eq!(r.json["kind"], "silicon");

    let own = events(&ctx, &silicon.uuid, types::SILICON_ID_CHANGED).await;
    assert_eq!(own.len(), 1);
    assert_eq!(own[0]["data"]["new_id"], format!("si:{new_handle}"));
    assert_eq!(
        own[0]["data"]["old_id"],
        silicon.handle.clone().expect("id")
    );
    let app_events = events(&ctx, &app, types::ACCOUNT_ID_CHANGED).await;
    assert_eq!(app_events.len(), 1);
    assert_eq!(app_events[0]["data"]["kind"], "silicon");
}

#[tokio::test]
async fn an_account_changes_its_id_at_most_five_times_a_day() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let app = member_app(&ctx, "hoard", &carbon, &[Scope::Profile]).await;
    let tok = token(&ctx, &carbon).await;
    let base = format!("h{}", rand_suffix());
    let post = |id: String| {
        Req::post("/v1/me/id")
            .bearer(&tok)
            .json(json!({ "id": id }))
    };
    for i in 0..accounts_account::ID_CHANGES_PER_DAY {
        let r = call(&ctx, post(format!("c:{base}-{i}"))).await;
        assert_status(&r, 200);
    }
    let last = format!("c:{base}-4");

    let r = call(&ctx, post(format!("c:{base}-5"))).await;
    assert_error(&r, 429, "rate_limited");
    let retry: u64 = r
        .headers
        .get("retry-after")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok())
        .expect("Retry-After");
    assert!((86_000..=86_400).contains(&retry), "{retry}");
    let details = &r.json["error"]["details"];
    assert_eq!(details["limit"], 5);
    assert_eq!(details["window_seconds"], 86_400);
    assert!(
        details["retry_at"]
            .as_str()
            .is_some_and(|t| t.ends_with('Z'))
    );
    let message = r.json["error"]["message"].as_str().expect("message");
    assert!(
        message.contains(&last) && message.contains("5 times"),
        "{message}"
    );
    assert!(
        r.json["error"]["hint"]
            .as_str()
            .is_some_and(|h| h.contains(&last)),
        "{}",
        r.json
    );

    // Taking back one of its own reserved ids is a change too.
    let r = call(&ctx, post(format!("c:{base}-0"))).await;
    assert_error(&r, 429, "rate_limited");
    // Asking for the current id again changes nothing and is always fine.
    let r = call(&ctx, post(last.clone())).await;
    assert_status(&r, 200);
    assert_eq!(r.json["id"], last);

    // Nothing beyond the limit happened: five reservations, five webhooks.
    let held: i64 = scalar(
        &ctx,
        "select count(*) from handle_reservations where account_uuid = $1 and reserved_until > now()",
        &carbon.uuid,
    )
    .await;
    assert_eq!(held, 5);
    assert_eq!(events(&ctx, &app, types::ACCOUNT_ID_CHANGED).await.len(), 5);
    assert_eq!(reload(&ctx, &carbon.uuid).await.handle, Some(last));

    // The window rolls: once the changes are a day old the account can change again.
    ctx.exec(&format!(
        "update handle_history set changed_at = changed_at - interval '25 hours' where account_uuid = '{}'",
        carbon.uuid
    ))
    .await;
    let r = call(&ctx, post(format!("c:{base}-5"))).await;
    assert_status(&r, 200);
    assert_eq!(r.json["id"], format!("c:{base}-5"));
}

#[tokio::test]
async fn a_silicons_id_budget_counts_its_custodians_changes() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let (silicon, _) = ctx.silicon(&carbon.uuid).await;
    let base = format!("s{}", rand_suffix());
    // The custodian renames it five times (as POST /v1/me/silicons/{uuid}/id does).
    let mut conn = ctx.conn().await;
    for i in 0..5 {
        let id = accounts_core::ids::AccountId::new(
            accounts_core::models::AccountKind::Silicon,
            &format!("{base}-{i}"),
        )
        .expect("id");
        accounts_core::repo::accounts::change_id(&mut conn, &silicon.uuid, &id, &carbon.uuid)
            .await
            .expect("custodian change");
    }
    drop(conn);
    let r = call(
        &ctx,
        Req::post("/v1/me/id")
            .bearer(&token(&ctx, &silicon).await)
            .json(json!({ "id": format!("{base}-own") })),
    )
    .await;
    assert_error(&r, 429, "rate_limited");
    assert!(
        r.json["error"]["message"]
            .as_str()
            .is_some_and(|m| m.contains(&format!("si:{base}-4"))),
        "{}",
        r.json
    );
}
