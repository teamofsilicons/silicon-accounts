//! The custodian-request expiry sweep.

use accounts_core::models::AccountStatus;
use accounts_core::test_support::{Req, TestContext};
use accounts_silicons::{SweepReport, expire_overdue};
use serde_json::json;

use crate::common::*;

#[tokio::test]
async fn the_sweep_expires_overdue_requests_and_releases_their_silicons() {
    let ctx = TestContext::new().await;
    let me = ctx.carbon().await;
    let t = token(&ctx, &me).await;
    let cid = me.handle.clone().expect("id");

    let overdue = self_created(
        &ctx,
        &cid,
        json!({"webhook_url": "http://127.0.0.1:8593/hooks/expiring"}),
    )
    .await;
    let fresh = self_created(&ctx, &cid, json!({})).await;
    let (silicon, _) = ctx.silicon(&me.uuid).await;
    let other = ctx.carbon().await;
    let tr = call(
        &ctx,
        Req::post(&format!("/v1/me/silicons/{}/transfer", silicon.uuid))
            .bearer(&t)
            .json(json!({"to": other.handle})),
    )
    .await;
    assert_eq!(tr.status, 201, "{}", tr.json);
    let overdue_id = overdue["request"]["id"].as_str().expect("id");
    let transfer_id = tr.json["request"]["id"].as_str().expect("id");
    make_overdue(&ctx, overdue_id).await;
    make_overdue(&ctx, transfer_id).await;

    let report = expire_overdue(&ctx.state).await.expect("sweep");
    assert_eq!(
        report,
        SweepReport {
            expired: 2,
            ..Default::default()
        }
    );

    // Initial: expired, Silicon released, told on its webhook.
    assert_eq!(request_row(&ctx, overdue_id).await.0, "expired");
    let uuid = overdue["silicon"]["uuid"].as_str().expect("uuid");
    let released = account(&ctx, uuid).await;
    assert_eq!(released.status, AccountStatus::Deleted);
    assert_eq!(released.handle, None);
    let events = silicon_events(&ctx, uuid).await;
    let (t2, p) = events.last().expect("event");
    assert_eq!(t2, "silicon.custodian.expired");
    assert_eq!(p["data"]["id"], overdue["silicon"]["id"]);
    assert_eq!(
        p["data"]["expired_at"].as_str().map(|s| s.is_empty()),
        Some(false)
    );
    assert_eq!(
        delivery_urls(&ctx, uuid, "silicon.custodian.expired").await,
        vec!["http://127.0.0.1:8593/hooks/expiring".to_string()]
    );
    let actions = audit_actions(&ctx, uuid).await;
    assert!(actions.contains(&"silicon.custodian.expired".to_string()));

    // Transfer: expired, nothing else changes.
    assert_eq!(request_row(&ctx, transfer_id).await.0, "expired");
    let kept = account(&ctx, &silicon.uuid).await;
    assert_eq!(kept.status, AccountStatus::Active);
    assert_eq!(kept.custodian_uuid.as_deref(), Some(me.uuid.as_str()));

    // Not yet due: untouched.
    assert_eq!(
        request_row(&ctx, fresh["request"]["id"].as_str().expect("id"))
            .await
            .0,
        "pending"
    );
    assert_eq!(
        account(&ctx, fresh["silicon"]["uuid"].as_str().expect("uuid"))
            .await
            .status,
        AccountStatus::PendingCustodian
    );

    // A second run has nothing to do.
    assert_eq!(
        expire_overdue(&ctx.state).await.expect("sweep"),
        SweepReport::default()
    );
}

#[tokio::test]
async fn the_sweep_handles_more_than_one_batch() {
    let ctx = TestContext::new().await;
    let me = ctx.carbon().await;
    let other = ctx.carbon().await;
    // 120 Silicons with an overdue transfer each (the batch size is 100).
    ctx.exec(&format!(
        "insert into accounts (uuid, number, kind, handle, status, display_name, pfp_url, dob, timezone, \
           custodian_uuid, stk_hash) \
         select 'bulk' || g, 1000000 + g, 'silicon', 'si:bulk-' || g, 'active', 'Bulk', \
           'https://iris.example/p.png', current_date, 'UTC', '{me}', 'x' from generate_series(1, 120) g; \
         insert into custodian_requests (id, silicon_uuid, kind, from_uuid, to_uuid, status, created_at, expires_at) \
         select gen_random_uuid(), 'bulk' || g, 'transfer', '{me}', '{other}', 'pending', \
           now() - interval '15 days', now() - interval '1 day' from generate_series(1, 120) g;",
        me = me.uuid,
        other = other.uuid
    ))
    .await;
    let report = expire_overdue(&ctx.state).await.expect("sweep");
    assert_eq!(
        report,
        SweepReport {
            expired: 120,
            ..Default::default()
        }
    );
    let pending: i64 =
        sqlx::query_scalar("select count(*) from custodian_requests where status = 'pending'")
            .fetch_one(&ctx.state.db)
            .await
            .expect("count");
    assert_eq!(pending, 0);
}

#[tokio::test]
async fn spawn_background_starts_the_sweep() {
    let ctx = TestContext::new().await;
    let me = ctx.carbon().await;
    let created = self_created(&ctx, me.handle.as_deref().expect("id"), json!({})).await;
    let id = created["request"]["id"].as_str().expect("id").to_string();
    make_overdue(&ctx, &id).await;
    let handles = accounts_silicons::spawn_background(ctx.state.clone());
    assert_eq!(handles.len(), 1);
    // The first run happens right away.
    let mut expired = false;
    for _ in 0..100 {
        if request_row(&ctx, &id).await.0 == "expired" {
            expired = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    for h in handles {
        h.abort();
    }
    assert!(expired, "the background sweep expired the overdue request");
}

#[tokio::test]
async fn silicons_named_by_a_deleted_carbon_are_released() {
    let ctx = TestContext::new().await;
    let gone = ctx.carbon().await;
    let cid = gone.handle.clone().expect("id");
    let polled = self_created(
        &ctx,
        &cid,
        json!({"webhook_url": "http://127.0.0.1:8593/hooks/orphan"}),
    )
    .await;
    let signs_in = self_created(&ctx, &cid, json!({})).await;
    let swept = self_created(&ctx, &cid, json!({})).await;

    // The named Carbon deletes their account (core cancels requests addressed to them).
    let mut conn = ctx.conn().await;
    accounts_core::repo::accounts::delete_account(&mut conn, &gone.uuid, &gone.uuid, true)
        .await
        .expect("delete");
    drop(conn);

    // Polling shows the cancelled request and releases the Silicon at once.
    let r = call(
        &ctx,
        Req::get(&format!(
            "/v1/silicons/requests/{}",
            polled["request"]["id"].as_str().expect("id")
        ))
        .bearer(polled["request_token"].as_str().expect("token")),
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(r.json["status"], "cancelled");
    assert_eq!(r.json["silicon"]["status"], "deleted");
    let uuid = polled["silicon"]["uuid"].as_str().expect("uuid");
    let events = silicon_events(&ctx, uuid).await;
    let (t, p) = events.last().expect("event");
    assert_eq!(t, "silicon.custodian.declined");
    assert_eq!(p["data"]["reason"], "custodian_account_deleted");

    // Signing in (right STK) explains it and releases the Silicon.
    let r = login(
        &ctx,
        signs_in["silicon"]["id"].as_str().expect("id"),
        signs_in["stk"].as_str().expect("stk"),
    )
    .await;
    assert_eq!(r.status, 403, "{}", r.json);
    assert_eq!(r.error_code(), Some("custodian_declined"));
    assert!(
        r.json["error"]["message"]
            .as_str()
            .expect("m")
            .contains("deleted their account")
    );
    assert_eq!(
        account(&ctx, signs_in["silicon"]["uuid"].as_str().expect("uuid"))
            .await
            .status,
        AccountStatus::Deleted
    );
    let again = login(
        &ctx,
        signs_in["silicon"]["id"].as_str().expect("id"),
        signs_in["stk"].as_str().expect("stk"),
    )
    .await;
    assert_eq!(again.error_code(), Some("custodian_declined"));

    // The sweep releases the rest.
    let report = expire_overdue(&ctx.state).await.expect("sweep");
    assert_eq!(
        report,
        SweepReport {
            released_orphans: 1,
            ..Default::default()
        }
    );
    let released = account(&ctx, swept["silicon"]["uuid"].as_str().expect("uuid")).await;
    assert_eq!(released.status, AccountStatus::Deleted);
    assert_eq!(released.handle, None);
    assert_eq!(
        expire_overdue(&ctx.state).await.expect("sweep"),
        SweepReport::default()
    );
}
