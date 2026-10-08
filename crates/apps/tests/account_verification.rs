mod common;

use accounts_core::models::Scope;
use accounts_core::test_support::{Req, TestContext};
use common::{call, owned_app};
use serde_json::json;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

async fn request_count(ctx: &TestContext) -> i64 {
    sqlx::query_scalar("select count(*) from account_verification_requests")
        .fetch_one(&ctx.state.db)
        .await
        .expect("request count")
}
async fn message_count(ctx: &TestContext) -> i64 {
    sqlx::query_scalar(
        "select count(*) from outbound_messages where purpose='account_verification_request'",
    )
    .fetch_one(&ctx.state.db)
    .await
    .expect("mail count")
}

#[tokio::test]
async fn submission_durably_records_reason_and_both_fixed_notifications_once() {
    let ctx = TestContext::new().await;
    let app = owned_app(&ctx, "manual-review").await;
    let token = ctx
        .tokens_for(&app.owner, "developer", &[Scope::Profile])
        .await
        .access_token;
    let path = format!("/v1/apps/{}/account-verification-request", app.app_id);
    let empty = call(&ctx, Req::get(&path).bearer(&token)).await;
    assert_eq!(empty.status, 200);
    assert!(empty.json["request"].is_null());
    let body = json!({"reason":"  Demo: review eligibility for sign-in on my own domain.\nNo domain provisioning requested.  "});
    let send = || {
        Req::post(&path)
            .bearer(&token)
            .header("idempotency-key", "review-demo")
            .json(body.clone())
    };
    let first = call(&ctx, send()).await;
    assert_eq!(first.status, 201, "{}", first.json);
    assert_eq!(first.headers["cache-control"], "no-store");
    assert_eq!(first.json["created"], true);
    let r = &first.json["request"];
    assert_eq!(r["status"], "pending");
    assert_eq!(r["account_uuid"], app.owner.uuid);
    assert_eq!(r["context_app"]["app_id"], app.app_id);
    assert!(r.get("verified").is_none() && r.get("domain_enabled").is_none());
    assert_eq!(r["reason"], body["reason"].as_str().expect("reason").trim());
    let submitted = OffsetDateTime::parse(r["submitted_at"].as_str().expect("submitted"), &Rfc3339)
        .expect("date");
    let expected = OffsetDateTime::parse(
        r["response_expected_by"].as_str().expect("estimate"),
        &Rfc3339,
    )
    .expect("date");
    assert_eq!((expected - submitted).whole_hours(), 48);
    let request_id = r["request_id"].as_str().expect("request id");
    let messages:Vec<(String,String,String,String,Option<String>)>=sqlx::query_as(
        "select n.recipient,m.to_address,m.text_body,m.status,m.html_body from account_verification_request_notifications n join outbound_messages m on m.id=n.message_id where n.request_id=$1::uuid order by n.recipient")
        .bind(request_id).fetch_all(&ctx.state.db).await.expect("linked messages");
    assert_eq!(messages.len(), 2);
    assert_eq!(
        messages.iter().map(|r| r.0.as_str()).collect::<Vec<_>>(),
        vec!["lords@teamofsilicons.com", "saket@teamofsilicons.com"]
    );
    for (recipient, to, text, status, html) in messages {
        assert_eq!(recipient, to);
        assert_eq!(status, "local", "tests never send live mail");
        assert!(
            html.is_none(),
            "request text is plain text, not interpreted HTML"
        );
        for expected in [
            request_id,
            app.owner.uuid.as_str(),
            app.owner.display_name.as_str(),
            app.app_id.as_str(),
            "up to 48 hours",
            "not automatic approval",
            body["reason"].as_str().expect("reason").trim(),
        ] {
            assert!(text.contains(expected), "missing {expected}");
        }
        assert!(!text.contains(&token) && !text.contains(&app.secret));
    }
    let replay = call(&ctx, send()).await;
    assert_eq!(replay.status, 201);
    assert_eq!(replay.json, first.json);
    let conflict = call(
        &ctx,
        Req::post(&path)
            .bearer(&token)
            .header("idempotency-key", "review-demo")
            .json(json!({"reason":"Different request"})),
    )
    .await;
    assert_eq!(conflict.status, 409);
    let duplicate = call(
        &ctx,
        Req::post(&path)
            .bearer(&token)
            .json(json!({"reason":"Please send more notifications"})),
    )
    .await;
    assert_eq!(duplicate.status, 200);
    assert_eq!(duplicate.json["created"], false);
    assert_eq!(duplicate.json["request"], first.json["request"]);
    assert_eq!(request_count(&ctx).await, 1);
    assert_eq!(message_count(&ctx).await, 2);
    let current = call(&ctx, Req::get(&path).bearer(&token)).await;
    assert_eq!(current.json["request"], first.json["request"]);
    let state: String = sqlx::query_scalar("select status from accounts where uuid=$1")
        .bind(&app.owner.uuid)
        .fetch_one(&ctx.state.db)
        .await
        .expect("account unchanged");
    assert_eq!(state, "active");
}

#[tokio::test]
async fn first_party_current_management_and_requester_isolation_are_enforced() {
    let ctx = TestContext::new().await;
    let app = owned_app(&ctx, "manual-auth").await;
    let owner_token = ctx
        .tokens_for(&app.owner, "developer", &[Scope::Profile])
        .await
        .access_token;
    let stranger = ctx.carbon().await;
    let stranger_token = ctx
        .tokens_for(&stranger, "developer", &[Scope::Profile])
        .await
        .access_token;
    let other_token = ctx
        .tokens_for(&app.owner, &app.app_id, &[Scope::Profile])
        .await
        .access_token;
    // A real Apps audience with a live membership is still not first-party.
    sqlx::query("insert into apps(app_id,name,secret_hash,status,source) select 'apps',name,secret_hash,status,source from apps where app_id=$1")
        .bind(&app.app_id).execute(&ctx.state.db).await.expect("Apps fixture");
    ctx.membership("apps", &app.owner.uuid, &[Scope::Profile])
        .await;
    let apps_token = ctx
        .tokens_for(&app.owner, "apps", &[Scope::Profile])
        .await
        .access_token;
    let path = format!("/v1/apps/{}/account-verification-request", app.app_id);
    for request in [
        Req::get(&path),
        Req::get(&path).basic(&app.app_id, &app.secret),
        Req::get(&path).bearer(&other_token),
        Req::get(&path).bearer(&apps_token),
        Req::post(&path)
            .basic(&app.app_id, &app.secret)
            .json(json!({"reason":"x"})),
        Req::post(&path)
            .bearer(&apps_token)
            .json(json!({"reason":"x"})),
    ] {
        assert_eq!(call(&ctx, request).await.status, 401);
    }
    for request in [
        Req::get(&path),
        Req::post(&path).json(json!({"reason":"x"})),
    ] {
        assert_eq!(
            call(&ctx, request.bearer(&stranger_token)).await.status,
            403
        );
    }
    let p = call(
        &ctx,
        Req::post(&path)
            .bearer(&owner_token)
            .json(json!({"reason":"Owner request"})),
    )
    .await;
    assert_eq!(p.status, 201, "{}", p.json);
    sqlx::query("insert into app_authors(app_id,account_uuid) values($1,$2)")
        .bind(&app.app_id)
        .bind(&stranger.uuid)
        .execute(&ctx.state.db)
        .await
        .expect("coauthor");
    assert!(
        call(&ctx, Req::get(&path).bearer(&stranger_token))
            .await
            .json["request"]
            .is_null(),
        "coauthor cannot read owner's request reason"
    );
    let p = call(
        &ctx,
        Req::post(&path)
            .bearer(&stranger_token)
            .header("idempotency-key", "coauthor-request")
            .json(json!({"reason":"Author request"})),
    )
    .await;
    assert_eq!(p.status, 201, "{}", p.json);
    assert_eq!(p.json["request"]["account_uuid"], stranger.uuid);
    sqlx::query("delete from app_authors where app_id=$1 and account_uuid=$2")
        .bind(&app.app_id)
        .bind(&stranger.uuid)
        .execute(&ctx.state.db)
        .await
        .expect("remove coauthor");
    assert_eq!(
        call(&ctx, Req::get(&path).bearer(&stranger_token))
            .await
            .status,
        403
    );
    assert_eq!(
        call(
            &ctx,
            Req::post(&path)
                .bearer(&stranger_token)
                .header("idempotency-key", "coauthor-request")
                .json(json!({"reason":"Author request"}))
        )
        .await
        .status,
        403,
        "removal also denies an idempotency replay"
    );
    assert_eq!(request_count(&ctx).await, 2);
    assert_eq!(message_count(&ctx).await, 4);
    let fp = ctx.first_party_tokens(&app.owner).await.access_token;
    assert_eq!(call(&ctx, Req::get(&path).bearer(&fp)).await.status, 200);
    assert_eq!(
        call(
            &ctx,
            Req::get(&path).session(&ctx.state.settings, &app.cookie)
        )
        .await
        .status,
        200
    );
    sqlx::query(
        "update token_families set revoked_at=now() where account_uuid=$1 and app_id='developer'",
    )
    .bind(&app.owner.uuid)
    .execute(&ctx.state.db)
    .await
    .expect("revoke sign-in");
    assert_eq!(
        call(
            &ctx,
            Req::post(&path)
                .bearer(&owner_token)
                .json(json!({"reason":"again"}))
        )
        .await
        .status,
        401
    );
}

#[tokio::test]
async fn concurrent_requests_across_apps_do_not_duplicate_notifications() {
    let ctx = TestContext::new().await;
    let app = owned_app(&ctx, "manual-race").await;
    let (second, _) = ctx.app_owned("second", Some(&app.owner.uuid)).await;
    let token = ctx
        .tokens_for(&app.owner, "developer", &[Scope::Profile])
        .await
        .access_token;
    let futures = (0..8).map(|i| {
        let req = Req::post(&format!(
            "/v1/apps/{}/account-verification-request",
            if i % 2 == 0 {
                &app.app_id
            } else {
                &second.app_id
            }
        ))
        .bearer(&token)
        .json(json!({"reason":format!("Concurrent reason {i}")}));
        call(&ctx, req)
    });
    let responses = futures::future::join_all(futures).await;
    assert_eq!(responses.iter().filter(|r| r.status == 201).count(), 1);
    assert_eq!(responses.iter().filter(|r| r.status == 200).count(), 7);
    let id = &responses[0].json["request"]["request_id"];
    assert!(
        responses
            .iter()
            .all(|r| r.json["request"]["request_id"] == *id)
    );
    assert_eq!(request_count(&ctx).await, 1);
    assert_eq!(message_count(&ctx).await, 2);
}

#[tokio::test]
async fn validates_reason_and_rolls_back_request_if_second_notification_cannot_queue() {
    let ctx = TestContext::new().await;
    let app = owned_app(&ctx, "manual-atomic").await;
    let token = ctx
        .tokens_for(&app.owner, "developer", &[Scope::Profile])
        .await
        .access_token;
    let path = format!("/v1/apps/{}/account-verification-request", app.app_id);
    for reason in [
        " \n\t".to_string(),
        "x".repeat(5001),
        "A reason\0with a NUL".to_string(),
    ] {
        let r = call(
            &ctx,
            Req::post(&path)
                .bearer(&token)
                .json(json!({"reason":reason})),
        )
        .await;
        assert_eq!(r.status, 422);
        assert!(
            r.json["error"]["details"]["fields"]["reason"].is_string()
                || r.json["error"]["details"]["fields"]["reason"].is_array()
        );
    }
    assert_eq!(
        call(
            &ctx,
            Req::post(&path)
                .bearer(&token)
                .json(json!({"reason":"valid","to":"someone@example.org"}))
        )
        .await
        .status,
        422
    );
    ctx.exec("alter table outbound_messages add constraint test_reject_second_recipient check (to_address <> 'saket@teamofsilicons.com')").await;
    let r = call(
        &ctx,
        Req::post(&path)
            .bearer(&token)
            .json(json!({"reason":"Atomic test"})),
    )
    .await;
    assert_eq!(r.status, 500);
    assert_eq!(request_count(&ctx).await, 0);
    assert_eq!(
        message_count(&ctx).await,
        0,
        "first outbox message rolled back with second failure"
    );
}

#[tokio::test]
async fn silicon_without_email_can_submit_and_unverified_contact_is_not_disclosed() {
    let ctx = TestContext::new().await;
    let app = owned_app(&ctx, "manual-contact").await;
    let (silicon, stk) = ctx.silicon(&app.owner.uuid).await;
    sqlx::query("insert into app_authors(app_id,account_uuid) values($1,$2)")
        .bind(&app.app_id)
        .bind(&silicon.uuid)
        .execute(&ctx.state.db)
        .await
        .expect("Silicon author");
    let token = ctx
        .tokens_for(&silicon, "developer", &[Scope::Profile])
        .await
        .access_token;
    let path = format!("/v1/apps/{}/account-verification-request", app.app_id);
    let r = call(
        &ctx,
        Req::post(&path)
            .bearer(&token)
            .json(json!({"reason":"Silicon demo"})),
    )
    .await;
    assert_eq!(r.status, 201, "{}", r.json);
    let bodies: Vec<String> = sqlx::query_scalar(
        "select text_body from outbound_messages where purpose='account_verification_request'",
    )
    .fetch_all(&ctx.state.db)
    .await
    .expect("bodies");
    assert_eq!(bodies.len(), 2);
    for body in bodies {
        assert!(body.contains("No verified primary email is available."));
        assert!(body.contains(&silicon.uuid));
        assert!(!body.contains(&stk));
    }
    let unverified: Option<String> = sqlx::query_scalar(
        "update account_emails set verified_at=null where account_uuid=$1 returning email",
    )
    .bind(&app.owner.uuid)
    .fetch_optional(&ctx.state.db)
    .await
    .expect("unverify contact");
    let token = ctx
        .tokens_for(&app.owner, "developer", &[Scope::Profile])
        .await
        .access_token;
    let r = call(
        &ctx,
        Req::post(&path)
            .bearer(&token)
            .json(json!({"reason":"Carbon with no verified contact"})),
    )
    .await;
    assert_eq!(r.status, 201, "{}", r.json);
    let bodies:Vec<String>=sqlx::query_scalar("select m.text_body from outbound_messages m join account_verification_request_notifications n on n.message_id=m.id where n.request_id=$1::uuid")
        .bind(r.json["request"]["request_id"].as_str().expect("id")).fetch_all(&ctx.state.db).await.expect("bodies");
    for body in bodies {
        assert!(body.contains("No verified primary email is available."));
        if let Some(email) = &unverified {
            assert!(!body.contains(email));
        }
    }
}
