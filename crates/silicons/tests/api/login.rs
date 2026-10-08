//! `POST /v1/silicons/login`: si:id + STK → first-party tokens.

use accounts_core::test_support::{Req, TestContext, call as raw_call};
use serde_json::{Value, json};

use crate::common::*;

async fn family_rows(ctx: &TestContext, uuid: &str) -> Vec<(String, String, Option<String>)> {
    sqlx::query_as(
        "select app_id, origin, label from token_families where account_uuid = $1 order by created_at",
    )
    .bind(uuid)
    .fetch_all(&ctx.state.db)
    .await
    .expect("families")
}

async fn signins(ctx: &TestContext, uuid: Option<&str>) -> Vec<(String, String)> {
    sqlx::query_as(
        "select method, outcome from signin_history where account_uuid is not distinct from $1 order by id",
    )
    .bind(uuid)
    .fetch_all(&ctx.state.db)
    .await
    .expect("signins")
}

#[tokio::test]
async fn an_active_silicon_signs_in_and_gets_first_party_tokens() {
    let ctx = TestContext::new().await;
    let custodian = ctx.carbon().await;
    let (silicon, stk) = ctx.silicon(&custodian.uuid).await;
    let id = silicon.handle.clone().expect("id");
    let r = call(
        &ctx,
        Req::post("/v1/silicons/login")
            .header("user-agent", "accounts-cli/0.1")
            .json(json!({"id": id.to_uppercase(), "stk": stk.to_uppercase(), "client_label": " scout on mac\n"})),
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(
        r.headers
            .get("cache-control")
            .map(|v| v.to_str().unwrap_or("")),
        Some("no-store"),
        "token responses are never cached"
    );
    assert_eq!(r.json["token_type"], "Bearer");
    assert_eq!(r.json["expires_in"], 1800);
    assert!(
        r.json["refresh_token"]
            .as_str()
            .expect("refresh")
            .starts_with("sar_")
    );
    assert_eq!(
        r.json["membership_id"],
        format!("silicon-accounts:{}", silicon.uuid)
    );
    assert_eq!(r.json["account"]["kind"], "silicon");
    assert_eq!(r.json["account"]["id"], id);
    assert_eq!(r.json["account"]["custodian"]["uuid"], custodian.uuid);
    assert_eq!(r.json["scope"], "profile");
    let claims = ctx
        .state
        .keys
        .jwt
        .verify_access(
            r.json["access_token"].as_str().expect("jwt"),
            Some("silicon-accounts"),
        )
        .expect("valid first-party JWT");
    assert_eq!(claims.sub, silicon.uuid);
    assert_eq!(
        family_rows(&ctx, &silicon.uuid).await,
        vec![(
            "silicon-accounts".to_string(),
            "silicon_login".to_string(),
            Some("scout on mac".to_string())
        )]
    );
    assert_eq!(
        signins(&ctx, Some(&silicon.uuid)).await,
        vec![("silicon_stk".to_string(), "success".to_string())]
    );
    // The token works as a session for this crate's endpoints.
    let (app, _) = ctx.app("remind").await;
    let slt = call(
        &ctx,
        Req::post("/v1/me/short-lived-tokens")
            .bearer(r.json["access_token"].as_str().expect("jwt"))
            .json(json!({"app_id": app.app_id})),
    )
    .await;
    assert_eq!(slt.status, 201, "{}", slt.json);
}

#[tokio::test]
async fn unknown_ids_and_wrong_stks_get_the_same_answer() {
    let ctx = TestContext::new().await;
    let custodian = ctx.carbon().await;
    let (silicon, _) = ctx.silicon(&custodian.uuid).await;
    let wrong = login(
        &ctx,
        silicon.handle.as_deref().expect("id"),
        "stk-000000000000",
    )
    .await;
    let unknown = login(&ctx, "si:nobody-at-all", "stk-000000000000").await;
    assert_eq!(wrong.status, 401);
    assert_eq!(unknown.status, 401);
    assert_eq!(wrong.error_code(), Some("invalid_credentials"));
    assert_eq!(
        wrong.json, unknown.json,
        "no difference an attacker could use"
    );
    assert_eq!(
        signins(&ctx, Some(&silicon.uuid)).await,
        vec![("silicon_stk".to_string(), "failed".to_string())]
    );
    assert_eq!(
        signins(&ctx, None).await,
        vec![("silicon_stk".to_string(), "failed".to_string())]
    );
    assert!(family_rows(&ctx, &silicon.uuid).await.is_empty());
}

#[tokio::test]
async fn ten_wrong_stks_lock_sign_in_for_a_minute() {
    let ctx = TestContext::new().await;
    let custodian = ctx.carbon().await;
    let (silicon, stk) = ctx.silicon(&custodian.uuid).await;
    let id = silicon.handle.clone().expect("id");
    for i in 1..10 {
        let r = login(&ctx, &id, "stk-0000000000aa").await;
        assert_eq!(r.status, 401, "attempt {i}: {}", r.json);
    }
    let tenth = login(&ctx, &id, "stk-0000000000aa").await;
    assert_eq!(tenth.status, 423, "{}", tenth.json);
    assert_eq!(tenth.error_code(), Some("login_locked"));
    assert_eq!(tenth.json["error"]["details"]["retry_after_seconds"], 60);
    assert_eq!(
        tenth
            .headers
            .get("retry-after")
            .map(|v| v.to_str().unwrap_or("")),
        Some("60")
    );
    // Locked even with the right STK.
    let right = login(&ctx, &id, &stk).await;
    assert_eq!(right.status, 423);
    let secs = right.json["error"]["details"]["retry_after_seconds"]
        .as_u64()
        .expect("secs");
    assert!((1..=60).contains(&secs));
    // After the minute (time travel) the right STK works and the count starts over.
    ctx.exec(&format!(
        "update accounts set stk_locked_until = now() - interval '1 second' where uuid = '{}'",
        silicon.uuid
    ))
    .await;
    let ok = login(&ctx, &id, &stk).await;
    assert_eq!(ok.status, 200, "{}", ok.json);
    let fails: i32 = sqlx::query_scalar("select stk_failed_attempts from accounts where uuid = $1")
        .bind(&silicon.uuid)
        .fetch_one(&ctx.state.db)
        .await
        .expect("fails");
    assert_eq!(fails, 0);
    // A fresh run of failures is needed to lock again.
    let r = login(&ctx, &id, "stk-0000000000aa").await;
    assert_eq!(r.status, 401);
}

#[tokio::test]
async fn a_pending_silicon_with_the_right_stk_is_told_to_wait() {
    let ctx = TestContext::new().await;
    let saket = ctx.carbon().await;
    let created = self_created(&ctx, saket.handle.as_deref().expect("id"), json!({})).await;
    let id = created["silicon"]["id"].as_str().expect("id");
    let stk = created["stk"].as_str().expect("stk");
    let r = login(&ctx, id, stk).await;
    assert_eq!(r.status, 403, "{}", r.json);
    assert_eq!(r.error_code(), Some("custodian_pending"));
    assert_eq!(
        r.json["error"]["details"]["request_id"],
        created["request"]["id"]
    );
    assert_eq!(
        r.json["error"]["details"]["custodian"],
        saket.handle.clone().expect("id")
    );
    let message = r.json["error"]["message"].as_str().expect("m");
    assert!(message.contains(saket.handle.as_deref().expect("id")) && message.contains("expires"));
    assert!(
        r.json["error"]["hint"]
            .as_str()
            .expect("h")
            .contains("/v1/silicons/requests/")
    );
    // The wrong STK on a pending Silicon is just invalid credentials.
    let wrong = login(&ctx, id, "stk-ffffffffffff").await;
    assert_eq!(wrong.error_code(), Some("invalid_credentials"));
    // Once accepted it signs in.
    let t = token(&ctx, &saket).await;
    let request_id = created["request"]["id"].as_str().expect("rid");
    assert_eq!(accept(&ctx, &t, request_id).await.status, 204);
    assert_eq!(login(&ctx, id, stk).await.status, 200);
}

#[tokio::test]
async fn declined_expired_and_deleted_silicons_are_told_why() {
    let ctx = TestContext::new().await;
    let saket = ctx.carbon().await;
    let t = token(&ctx, &saket).await;
    let cid = saket.handle.clone().expect("id");

    let declined = self_created(&ctx, &cid, json!({})).await;
    assert_eq!(
        decline(&ctx, &t, declined["request"]["id"].as_str().expect("id"))
            .await
            .status,
        204
    );
    let r = login(
        &ctx,
        declined["silicon"]["id"].as_str().expect("id"),
        declined["stk"].as_str().expect("stk"),
    )
    .await;
    assert_eq!(r.status, 403, "{}", r.json);
    assert_eq!(r.error_code(), Some("custodian_declined"));

    // Expired by the sweep's rules, discovered at sign-in (right STK).
    let expired = self_created(&ctx, &cid, json!({})).await;
    make_overdue(&ctx, expired["request"]["id"].as_str().expect("id")).await;
    let r = login(
        &ctx,
        expired["silicon"]["id"].as_str().expect("id"),
        expired["stk"].as_str().expect("stk"),
    )
    .await;
    assert_eq!(r.status, 403, "{}", r.json);
    assert_eq!(r.error_code(), Some("custodian_expired"));
    let (status, ..) = request_row(&ctx, expired["request"]["id"].as_str().expect("id")).await;
    assert_eq!(status, "expired");
    // And on the next try the id is simply gone, with the same reason.
    let r = login(
        &ctx,
        expired["silicon"]["id"].as_str().expect("id"),
        expired["stk"].as_str().expect("stk"),
    )
    .await;
    assert_eq!(r.error_code(), Some("custodian_expired"));

    // Deleted by its custodian.
    let (silicon, stk) = ctx.silicon(&saket.uuid).await;
    let id = silicon.handle.clone().expect("id");
    let d = call(
        &ctx,
        Req::delete(&format!("/v1/me/silicons/{}", silicon.uuid))
            .bearer(&t)
            .json(json!({"confirm": id})),
    )
    .await;
    assert_eq!(d.status, 204, "{}", d.json);
    let r = login(&ctx, &id, &stk).await;
    assert_eq!(r.status, 403);
    assert_eq!(r.error_code(), Some("account_deleted"));

    // A renamed id is not explained (it just doesn't sign in).
    let (renamed, stk2) = ctx.silicon(&saket.uuid).await;
    let old = renamed.handle.clone().expect("id");
    let c = call(
        &ctx,
        Req::post(&format!("/v1/me/silicons/{}/id", renamed.uuid))
            .bearer(&t)
            .json(json!({"id": silicon_id("newname")})),
    )
    .await;
    assert_eq!(c.status, 200);
    let r = login(&ctx, &old, &stk2).await;
    assert_eq!(r.error_code(), Some("invalid_credentials"));
}

#[tokio::test]
async fn malformed_input_is_rejected_precisely() {
    let ctx = TestContext::new().await;
    let r = login(&ctx, "c:saket", "stk-0123456789ab").await;
    assert_eq!(r.status, 422);
    assert_eq!(r.error_code(), Some("invalid_id"));
    assert!(
        r.json["error"]["hint"]
            .as_str()
            .expect("h")
            .contains("silicon-accounts login")
    );

    let r = login(&ctx, "si:scout", "stk-xyz").await;
    assert_eq!(r.status, 422);
    assert_eq!(r.error_code(), Some("invalid_stk"));

    let r = call(
        &ctx,
        Req::post("/v1/silicons/login").json(json!({"id": "si:scout"})),
    )
    .await;
    assert_eq!(r.status, 422);
    assert!(r.json["error"]["details"]["fields"]["stk"].is_string());

    let r = call(
        &ctx,
        Req::post("/v1/silicons/login")
            .json(json!({"id": "si:scout", "stk": "stk-0123456789ab", "app_id": "x"})),
    )
    .await;
    assert_eq!(r.status, 422, "unknown fields are refused: {}", r.json);
}

#[tokio::test]
async fn sign_in_attempts_are_limited_per_network() {
    let ctx = TestContext::new().await;
    // Pretend this network already made 60 attempts this minute.
    ctx.exec(
        "insert into rate_limits (bucket, window_started_at, count) values ('silicon_login:ip:unknown', now(), 60)",
    )
    .await;
    let r = login(&ctx, "si:anyone", "stk-0123456789ab").await;
    assert_eq!(r.status, 429, "{}", r.json);
    assert_eq!(r.error_code(), Some("rate_limited"));
    assert!(r.headers.get("retry-after").is_some());
}

#[tokio::test]
async fn a_rotation_kills_the_old_stk_at_once() {
    let ctx = TestContext::new().await;
    let saket = ctx.carbon().await;
    let t = token(&ctx, &saket).await;
    let (silicon, old_stk) = ctx.silicon(&saket.uuid).await;
    let id = silicon.handle.clone().expect("id");
    let first = login(&ctx, &id, &old_stk).await;
    assert_eq!(first.status, 200);
    let rotated = call(
        &ctx,
        Req::post(&format!("/v1/me/silicons/{}/stk", silicon.uuid))
            .bearer(&t)
            .json(json!({})),
    )
    .await;
    assert_eq!(rotated.status, 200, "{}", rotated.json);
    let new_stk = rotated.json["stk"].as_str().expect("new").to_string();
    assert_eq!(login(&ctx, &id, &old_stk).await.status, 401);
    assert_eq!(login(&ctx, &id, &new_stk).await.status, 200);
    // The session from before the rotation is dead.
    let old_session = first.json["access_token"].as_str().expect("jwt");
    let r = call(
        &ctx,
        Req::put("/v1/me/webhook")
            .bearer(old_session)
            .json(json!({"url": "http://127.0.0.1:8593/hooks/x"})),
    )
    .await;
    assert_eq!(r.status, 401);
    assert_eq!(r.error_code(), Some("token_revoked"));
    let _: Value = r.json;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn parallel_guesses_get_no_more_than_ten_checks() {
    let ctx = TestContext::new().await;
    let custodian = ctx.carbon().await;
    let (silicon, stk) = ctx.silicon(&custodian.uuid).await;
    let id = silicon.handle.clone().expect("id");
    let mut tasks = Vec::new();
    for i in 0..30 {
        let state = ctx.state.clone();
        let id = id.clone();
        tasks.push(tokio::spawn(async move {
            let r = raw_call(
                router().with_state(state),
                Req::post("/v1/silicons/login")
                    .json(json!({"id": id, "stk": format!("stk-{i:012x}")})),
            )
            .await;
            r.status.as_u16()
        }));
    }
    let mut statuses = Vec::new();
    for t in tasks {
        statuses.push(t.await.expect("task"));
    }
    let wrong = statuses.iter().filter(|s| **s == 401).count();
    let locked = statuses.iter().filter(|s| **s == 423).count();
    assert!(
        wrong <= 9,
        "at most 9 plain failures before the lock: {statuses:?}"
    );
    assert_eq!(wrong + locked, 30, "{statuses:?}");
    // Locked now, even for the right STK.
    assert_eq!(login(&ctx, &id, &stk).await.status, 423);
}
