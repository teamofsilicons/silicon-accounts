//! Transfers: `POST`/`DELETE /v1/me/silicons/{uuid}/transfer` and their acceptance/decline.

use accounts_core::models::Scope;
use accounts_core::test_support::{CarbonSpec, Req, TestContext};
use serde_json::{Value, json};

use crate::common::*;

async fn transfer(
    ctx: &TestContext,
    bearer: &str,
    silicon: &str,
    to: &str,
) -> accounts_core::test_support::Resp {
    call(
        ctx,
        Req::post(&format!("/v1/me/silicons/{silicon}/transfer"))
            .bearer(bearer)
            .json(json!({"to": to})),
    )
    .await
}

#[tokio::test]
async fn transfer_accepted_moves_the_silicon_and_tells_everyone() {
    let ctx = TestContext::new().await;
    let from = ctx.carbon().await;
    let to_email = format!(
        "to-{}@example.test",
        accounts_core::test_support::rand_suffix()
    );
    let to = ctx
        .carbon_with(CarbonSpec {
            email: Some(to_email.clone()),
            ..Default::default()
        })
        .await;
    let ft = token(&ctx, &from).await;
    let tt = token(&ctx, &to).await;
    let (silicon, _) = ctx.silicon(&from.uuid).await;
    let hook = call(
        &ctx,
        Req::put(&format!("/v1/me/silicons/{}/webhook", silicon.uuid))
            .bearer(&ft)
            .json(json!({"url": "http://127.0.0.1:8593/hooks/tr"})),
    )
    .await;
    assert_eq!(hook.status, 200);
    let (app, _) = ctx.app("member").await;
    ctx.set_app_webhook(&app.app_id, "http://127.0.0.1:8593/member/webhooks")
        .await;
    ctx.membership(&app.app_id, &silicon.uuid, &[Scope::Profile])
        .await;

    let r = transfer(&ctx, &ft, &silicon.uuid, to.handle.as_deref().expect("id")).await;
    assert_eq!(r.status, 201, "{}", r.json);
    let request = &r.json["request"];
    assert_eq!(request["kind"], "transfer");
    assert_eq!(request["status"], "pending");
    assert_eq!(request["silicon"]["uuid"], silicon.uuid);
    assert_eq!(request["from"]["uuid"], from.uuid);
    assert_eq!(request["to"]["uuid"], to.uuid);
    let request_id = request["id"].as_str().expect("id").to_string();
    // The receiving Carbon got an email at their primary address.
    let mail = ctx.outbox(&to_email).await;
    assert_eq!(mail[0].0, "custodian_transfer");
    assert!(mail[0].1.contains(silicon.handle.as_deref().expect("id")));
    // The custodian sees it as pending; the receiver sees it in their requests.
    let shown = call(
        &ctx,
        Req::get(&format!("/v1/me/silicons/{}", silicon.uuid)).bearer(&ft),
    )
    .await;
    assert_eq!(shown.json["pending_transfer"]["id"], request_id);
    assert_eq!(shown.json["pending_transfer"]["to"]["uuid"], to.uuid);
    let list = call(&ctx, Req::get("/v1/me/custodian-requests").bearer(&tt)).await;
    assert_eq!(list.json["items"][0]["id"], request_id);
    assert_eq!(list.json["items"][0]["from"]["uuid"], from.uuid);
    // Nothing changed yet.
    assert_eq!(
        account(&ctx, &silicon.uuid).await.custodian_uuid.as_deref(),
        Some(from.uuid.as_str())
    );

    assert_eq!(accept(&ctx, &tt, &request_id).await.status, 204);
    let after = account(&ctx, &silicon.uuid).await;
    assert_eq!(after.custodian_uuid.as_deref(), Some(to.uuid.as_str()));
    assert_eq!(after.version, silicon.version + 1);
    assert_eq!(
        custodian_history(&ctx, &silicon.uuid).await.last().cloned(),
        Some((
            Some(from.uuid.clone()),
            to.uuid.clone(),
            "transfer".to_string()
        ))
    );
    // silicon.custodian.changed to the Silicon, silicon.custodian_changed to its apps.
    let own = silicon_events(&ctx, &silicon.uuid).await;
    let (t, p) = own.last().expect("event");
    assert_eq!(t, "silicon.custodian.changed");
    assert_eq!(p["data"]["from"]["uuid"], from.uuid);
    assert_eq!(p["data"]["to"]["uuid"], to.uuid);
    let apps = app_events(&ctx, &app.app_id).await;
    assert_eq!(
        apps.last().map(|(t, _)| t.as_str()),
        Some("silicon.custodian_changed")
    );
    assert_eq!(
        apps.last().map(|(_, p)| p["data"]["to"]["id"].clone()),
        Some(json!(to.handle))
    );
    // The old custodian can't manage it any more; the new one can.
    let r = call(
        &ctx,
        Req::get(&format!("/v1/me/silicons/{}", silicon.uuid)).bearer(&ft),
    )
    .await;
    assert_eq!(r.error_code(), Some("silicon_not_found"));
    let r = call(
        &ctx,
        Req::get(&format!("/v1/me/silicons/{}", silicon.uuid)).bearer(&tt),
    )
    .await;
    assert_eq!(r.status, 200);
    assert_eq!(r.json["pending_transfer"], Value::Null);
    assert_eq!(r.json["custodian"]["uuid"], to.uuid);
    // Both histories record it.
    assert!(
        audit_actions(&ctx, &from.uuid)
            .await
            .contains(&"silicon.custodian.transfer.accepted".to_string())
    );
    assert!(
        audit_actions(&ctx, &to.uuid)
            .await
            .contains(&"silicon.custodian.transfer.accepted".to_string())
    );
}

#[tokio::test]
async fn declined_or_cancelled_transfers_change_nothing() {
    let ctx = TestContext::new().await;
    let from = ctx.carbon().await;
    let to = ctx.carbon().await;
    let ft = token(&ctx, &from).await;
    let tt = token(&ctx, &to).await;
    let (silicon, _) = ctx.silicon(&from.uuid).await;

    let r = transfer(&ctx, &ft, &silicon.uuid, to.handle.as_deref().expect("id")).await;
    let id = r.json["request"]["id"].as_str().expect("id").to_string();
    assert_eq!(decline(&ctx, &tt, &id).await.status, 204);
    assert_eq!(
        account(&ctx, &silicon.uuid).await.custodian_uuid.as_deref(),
        Some(from.uuid.as_str())
    );
    assert_eq!(request_row(&ctx, &id).await.0, "declined");
    assert_eq!(
        account(&ctx, &silicon.uuid).await.status,
        accounts_core::models::AccountStatus::Active
    );

    let r = transfer(&ctx, &ft, &silicon.uuid, to.handle.as_deref().expect("id")).await;
    assert_eq!(r.status, 201, "a new transfer after a decline: {}", r.json);
    let id2 = r.json["request"]["id"].as_str().expect("id").to_string();
    let c = call(
        &ctx,
        Req::delete(&format!("/v1/me/silicons/{}/transfer", silicon.uuid)).bearer(&ft),
    )
    .await;
    assert_eq!(c.status, 204, "{}", c.json);
    let (status, _, _, _, decided_by) = request_row(&ctx, &id2).await;
    assert_eq!(status, "cancelled");
    assert_eq!(decided_by.as_deref(), Some(from.uuid.as_str()));
    // The receiver can no longer accept it.
    let r = accept(&ctx, &tt, &id2).await;
    assert_eq!(r.status, 409);
    assert_eq!(r.error_code(), Some("custodian_request_not_pending"));
    // Nothing left to cancel.
    let c = call(
        &ctx,
        Req::delete(&format!("/v1/me/silicons/{}/transfer", silicon.uuid)).bearer(&ft),
    )
    .await;
    assert_eq!(c.status, 404);
    assert_eq!(c.error_code(), Some("transfer_not_found"));
    assert_eq!(custodian_history(&ctx, &silicon.uuid).await.len(), 0);
}

#[tokio::test]
async fn transfer_rules() {
    let ctx = TestContext::new().await;
    let email = format!(
        "me-{}@example.test",
        accounts_core::test_support::rand_suffix()
    );
    let me = ctx
        .carbon_with(CarbonSpec {
            email: Some(email.clone()),
            ..Default::default()
        })
        .await;
    let other = ctx.carbon().await;
    let t = token(&ctx, &me).await;
    let (silicon, _) = ctx.silicon(&me.uuid).await;

    for to_self in [me.handle.clone().expect("id"), email.to_uppercase()] {
        let r = transfer(&ctx, &t, &silicon.uuid, &to_self).await;
        assert_eq!(r.status, 422, "{to_self}: {}", r.json);
        assert_eq!(r.error_code(), Some("transfer_to_self"));
    }
    let r = transfer(&ctx, &t, &silicon.uuid, "c:no-such-carbon").await;
    assert_eq!(r.status, 404);
    assert_eq!(r.error_code(), Some("custodian_not_found"));
    let (another_silicon, _) = ctx.silicon(&me.uuid).await;
    let r = transfer(
        &ctx,
        &t,
        &silicon.uuid,
        another_silicon.handle.as_deref().expect("id"),
    )
    .await;
    assert_eq!(r.status, 422);
    assert!(
        r.json["error"]["details"]["fields"]["to"]
            .as_str()
            .expect("m")
            .contains("Carbon")
    );

    let first = transfer(
        &ctx,
        &t,
        &silicon.uuid,
        other.handle.as_deref().expect("id"),
    )
    .await;
    assert_eq!(first.status, 201);
    let second = transfer(&ctx, &t, &silicon.uuid, "someone@example.test").await;
    assert_eq!(second.status, 409);
    assert_eq!(second.error_code(), Some("transfer_pending"));
    assert_eq!(
        second.json["error"]["details"]["request_id"],
        first.json["request"]["id"]
    );

    // Only the custodian can transfer.
    let ot = token(&ctx, &other).await;
    let r = transfer(&ctx, &ot, &silicon.uuid, me.handle.as_deref().expect("id")).await;
    assert_eq!(r.error_code(), Some("silicon_not_found"));

    // Someone who isn't the receiver can't accept it.
    let stranger = ctx.carbon().await;
    let r = accept(
        &ctx,
        &token(&ctx, &stranger).await,
        first.json["request"]["id"].as_str().expect("id"),
    )
    .await;
    assert_eq!(r.status, 404);
    assert_eq!(r.error_code(), Some("custodian_request_not_found"));
}

#[tokio::test]
async fn transfer_to_an_email_without_an_account_waits_for_the_sign_up() {
    let ctx = TestContext::new().await;
    let from = ctx.carbon().await;
    let ft = token(&ctx, &from).await;
    let (silicon, _) = ctx.silicon(&from.uuid).await;
    let email = format!(
        "future-{}@example.test",
        accounts_core::test_support::rand_suffix()
    );
    let r = transfer(&ctx, &ft, &silicon.uuid, &email).await;
    assert_eq!(r.status, 201, "{}", r.json);
    assert_eq!(r.json["request"]["to"]["email"], email);
    let mail = ctx.outbox(&email).await;
    assert_eq!(mail[0].0, "custodian_transfer");
    assert!(mail[0].1.contains("sign up"), "{}", mail[0].1);

    let newcomer = ctx
        .carbon_with(CarbonSpec {
            email: Some(email.clone()),
            ..Default::default()
        })
        .await;
    let nt = token(&ctx, &newcomer).await;
    let id = r.json["request"]["id"].as_str().expect("id");
    assert_eq!(accept(&ctx, &nt, id).await.status, 204);
    assert_eq!(
        account(&ctx, &silicon.uuid).await.custodian_uuid.as_deref(),
        Some(newcomer.uuid.as_str())
    );
}

#[tokio::test]
async fn an_overdue_transfer_cannot_be_accepted_or_cancelled() {
    let ctx = TestContext::new().await;
    let from = ctx.carbon().await;
    let to = ctx.carbon().await;
    let ft = token(&ctx, &from).await;
    let (silicon, _) = ctx.silicon(&from.uuid).await;
    let r = transfer(&ctx, &ft, &silicon.uuid, to.handle.as_deref().expect("id")).await;
    let id = r.json["request"]["id"].as_str().expect("id").to_string();
    make_overdue(&ctx, &id).await;
    // Not shown as pending any more.
    let shown = call(
        &ctx,
        Req::get(&format!("/v1/me/silicons/{}", silicon.uuid)).bearer(&ft),
    )
    .await;
    assert_eq!(shown.json["pending_transfer"], Value::Null);
    let r = accept(&ctx, &token(&ctx, &to).await, &id).await;
    assert_eq!(r.status, 410, "{}", r.json);
    assert_eq!(r.error_code(), Some("custodian_request_expired"));
    assert_eq!(request_row(&ctx, &id).await.0, "expired");
    assert_eq!(
        account(&ctx, &silicon.uuid).await.custodian_uuid.as_deref(),
        Some(from.uuid.as_str())
    );

    let r2 = transfer(&ctx, &ft, &silicon.uuid, to.handle.as_deref().expect("id")).await;
    let id2 = r2.json["request"]["id"].as_str().expect("id").to_string();
    make_overdue(&ctx, &id2).await;
    let c = call(
        &ctx,
        Req::delete(&format!("/v1/me/silicons/{}/transfer", silicon.uuid)).bearer(&ft),
    )
    .await;
    assert_eq!(c.status, 404);
    assert!(
        c.json["error"]["message"]
            .as_str()
            .expect("m")
            .contains("expired")
    );
    assert_eq!(request_row(&ctx, &id2).await.0, "expired");

    // An overdue transfer never blocks a new one.
    let r3 = transfer(&ctx, &ft, &silicon.uuid, to.handle.as_deref().expect("id")).await;
    let id3 = r3.json["request"]["id"].as_str().expect("id").to_string();
    make_overdue(&ctx, &id3).await;
    let r4 = transfer(&ctx, &ft, &silicon.uuid, to.handle.as_deref().expect("id")).await;
    assert_eq!(r4.status, 201, "{}", r4.json);
    assert_eq!(request_row(&ctx, &id3).await.0, "expired");
}

#[tokio::test]
async fn transfer_requests_are_rate_limited_per_custodian() {
    let ctx = TestContext::new().await;
    let from = ctx.carbon().await;
    let to = ctx.carbon().await;
    let ft = token(&ctx, &from).await;
    let (silicon, _) = ctx.silicon(&from.uuid).await;
    ctx.exec(&format!(
        "insert into rate_limits (bucket, window_started_at, count) values ('silicon_transfer:account:{}', now(), 30)",
        from.uuid
    ))
    .await;
    let r = transfer(&ctx, &ft, &silicon.uuid, to.handle.as_deref().expect("id")).await;
    assert_eq!(r.status, 429, "{}", r.json);
    let n: i64 = sqlx::query_scalar("select count(*) from custodian_requests")
        .fetch_one(&ctx.state.db)
        .await
        .expect("count");
    assert_eq!(n, 0, "a refused transfer leaves nothing behind");
    let mails: i64 = sqlx::query_scalar(
        "select count(*) from outbound_messages where purpose = 'custodian_transfer'",
    )
    .fetch_one(&ctx.state.db)
    .await
    .expect("count");
    assert_eq!(mails, 0, "and sends no email");
}
