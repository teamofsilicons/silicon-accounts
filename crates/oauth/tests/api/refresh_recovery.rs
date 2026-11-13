//! Real PostgreSQL tests of the refresh commit/retry boundary (no mocked rotation).
use accounts_core::models::Scope;
use accounts_core::test_support::{Req, Resp, TestContext, call, test_state};
use serde_json::Value;

use crate::common::*;

fn assert_refresh(r: &Resp) -> &Value {
    assert_eq!(r.status, 200, "expected refresh response, got {}", r.json);
    assert_eq!(header(r, "cache-control"), "no-store");
    assert_eq!(header(r, "pragma"), "no-cache");
    assert_eq!(r.json["token_type"], "Bearer");
    assert!(
        r.json["expires_in"]
            .as_i64()
            .is_some_and(|n| (0..=1800).contains(&n))
    );
    assert!(r.json["access_token_expires_at"].is_string());
    &r.json
}

async fn keyed(ctx: &TestContext, app: &str, secret: &str, token: &str, key: &str) -> Resp {
    ctx.call(
        router(),
        token_req(
            app,
            secret,
            &[("grant_type", "refresh_token"), ("refresh_token", token)],
        )
        .header("Idempotency-Key", key),
    )
    .await
}

async fn fixture() -> (TestContext, String, String, Value) {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let (app, secret) = ctx.app("recovery").await;
    let first = sign_in(
        &ctx,
        &app.app_id,
        &secret,
        &carbon,
        &[Scope::Profile, Scope::Email],
    )
    .await;
    (ctx, app.app_id, secret, first)
}

#[tokio::test]
async fn lost_reply_is_recovered_after_restart_without_rotating_again() {
    let (ctx, app, secret, first) = fixture().await;
    let initial = keyed(
        &ctx,
        &app,
        &secret,
        s(&first, "refresh_token"),
        "operation-1",
    )
    .await;
    let expected = assert_refresh(&initial);
    // Independent server state/connection pool: there is no process-local recovery cache.
    let pool = accounts_core::db::connect_url(&ctx.db.url, 4)
        .await
        .expect("new pool");
    let recovered = call(
        router().with_state(test_state(pool)),
        token_req(
            &app,
            &secret,
            &[
                ("grant_type", "refresh_token"),
                ("refresh_token", s(&first, "refresh_token")),
            ],
        )
        .header("Idempotency-Key", "operation-1"),
    )
    .await;
    let actual = assert_refresh(&recovered);
    for name in [
        "access_token",
        "refresh_token",
        "access_token_expires_at",
        "refresh_token_expires_at",
    ] {
        assert_eq!(actual[name], expected[name]);
    }
    let rotations: i64 = scalar(&ctx,"select count(*) from refresh_tokens r join token_families f on f.id=r.family_id where f.app_id=$1 and used_at is not null",&app).await;
    assert_eq!(rotations, 1);
    let encrypted: Vec<u8> = scalar(
        &ctx,
        "select response from refresh_recoveries where app_id=$1",
        &app,
    )
    .await;
    assert!(
        !encrypted
            .windows(s(actual, "refresh_token").len())
            .any(|w| w == s(actual, "refresh_token").as_bytes())
    );
    assert!(
        app_events(&ctx, &app, "membership.signed_out")
            .await
            .is_empty()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_nodes_share_one_rotation_and_keep_the_family_live() {
    let (ctx, app, secret, first) = fixture().await;
    let mut tasks = Vec::new();
    for _ in 0..8 {
        let state = test_state(ctx.state.db.clone());
        let app = app.clone();
        let secret = secret.clone();
        let token = s(&first, "refresh_token").to_owned();
        tasks.push(tokio::spawn(async move {
            for _ in 0..50 {
                let r = call(
                    router().with_state(state.clone()),
                    token_req(
                        &app,
                        &secret,
                        &[("grant_type", "refresh_token"), ("refresh_token", &token)],
                    )
                    .header("Idempotency-Key", "one-shared-operation"),
                )
                .await;
                if r.status == 409 {
                    assert_eq!(r.json["error"], "refresh_in_progress");
                    assert_eq!(
                        r.headers.get("retry-after").and_then(|h| h.to_str().ok()),
                        Some("1")
                    );
                    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                    continue;
                }
                return assert_refresh(&r).clone();
            }
            panic!("refresh did not finish");
        }));
    }
    let mut answers = Vec::new();
    for t in tasks {
        answers.push(t.await.expect("node"));
    }
    assert!(
        answers
            .iter()
            .all(|r| r["refresh_token"] == answers[0]["refresh_token"])
    );
    let live: i64 = scalar(
        &ctx,
        "select count(*) from token_families where app_id=$1 and revoked_at is null",
        &app,
    )
    .await;
    assert_eq!(live, 1);
    let used:i64=scalar(&ctx,"select count(*) from refresh_tokens r join token_families f on f.id=r.family_id where app_id=$1 and used_at is not null",&app).await;
    assert_eq!(used, 1);
}

#[tokio::test]
async fn failed_recovery_write_rolls_back_the_rotation() {
    let (ctx, app, secret, first) = fixture().await;
    ctx.exec("create function fail_recovery() returns trigger language plpgsql as $$ begin raise exception 'injected recovery failure'; end $$; create trigger fail_recovery before insert on refresh_recoveries for each row execute function fail_recovery()").await;
    let failed = keyed(&ctx, &app, &secret, s(&first, "refresh_token"), "atomic").await;
    assert_eq!(failed.status, 500);
    let used:i64=scalar(&ctx,"select count(*) from refresh_tokens r join token_families f on f.id=r.family_id where app_id=$1 and used_at is not null",&app).await;
    assert_eq!(
        used, 0,
        "the token consumption must roll back with the response write"
    );
    ctx.exec("drop trigger fail_recovery on refresh_recoveries")
        .await;
    assert_refresh(&keyed(&ctx, &app, &secret, s(&first, "refresh_token"), "atomic").await);
}

#[tokio::test]
async fn a_key_cannot_be_rebound_to_another_token_or_scope() {
    let (ctx, app, secret, first) = fixture().await;
    let good = keyed(&ctx, &app, &secret, s(&first, "refresh_token"), "bound").await;
    let second = assert_refresh(&good);
    let conflict = keyed(&ctx, &app, &secret, s(second, "refresh_token"), "bound").await;
    assert_eq!(conflict.status, 409);
    assert_eq!(conflict.json["error"], "idempotency_key_reused");
    let scope = ctx
        .call(
            router(),
            token_req(
                &app,
                &secret,
                &[
                    ("grant_type", "refresh_token"),
                    ("refresh_token", s(&first, "refresh_token")),
                    ("scope", "profile"),
                ],
            )
            .header("Idempotency-Key", "bound"),
        )
        .await;
    assert_eq!(scope.status, 409);
    assert_eq!(scope.json["error"], "idempotency_key_reused");
    assert_refresh(
        &keyed(
            &ctx,
            &app,
            &secret,
            s(second, "refresh_token"),
            "next-generation",
        )
        .await,
    );
    let old = keyed(&ctx, &app, &secret, s(&first, "refresh_token"), "bound").await;
    assert_eq!(old.status, 409);
    assert_eq!(old.json["error"], "refresh_superseded");
}

#[tokio::test]
async fn unrecognized_reuse_still_revokes_the_family() {
    let (ctx, app, secret, first) = fixture().await;
    assert_refresh(&keyed(&ctx, &app, &secret, s(&first, "refresh_token"), "original").await);
    let replay = keyed(&ctx, &app, &secret, s(&first, "refresh_token"), "different").await;
    assert_oauth_error(&replay, 400, "invalid_grant", "already used");
    let recognized = keyed(&ctx, &app, &secret, s(&first, "refresh_token"), "original").await;
    assert_oauth_error(&recognized, 400, "invalid_grant", "revoked");
}

#[tokio::test]
async fn recovery_rechecks_revocation_expiry_account_and_membership() {
    for sql in [
        "update token_families set revoked_at=now(),revoke_reason='logout'",
        "update token_families set expires_at=now()-interval '1 second'",
        "update accounts set status='deleted'",
        "update memberships set status='access_removed'",
    ] {
        let (ctx, app, secret, first) = fixture().await;
        assert_refresh(&keyed(&ctx, &app, &secret, s(&first, "refresh_token"), "authority").await);
        ctx.exec(sql).await;
        let replay = keyed(&ctx, &app, &secret, s(&first, "refresh_token"), "authority").await;
        assert_eq!(replay.status, 400, "{sql}");
        assert_eq!(replay.json["error"], "invalid_grant", "{sql}");
        assert!(replay.json.get("access_token").is_none());
    }
}

#[tokio::test]
async fn expired_or_unreadable_recovery_results_do_not_revoke_the_signin() {
    for sql in [
        "update refresh_recoveries set expires_at=now()-interval '1 second'",
        "update refresh_recoveries set response=decode('00000000','hex')",
    ] {
        let (ctx, app, secret, first) = fixture().await;
        let reply = keyed(&ctx, &app, &secret, s(&first, "refresh_token"), "retained").await;
        let successor = s(assert_refresh(&reply), "refresh_token");
        ctx.exec(sql).await;
        let retry = keyed(&ctx, &app, &secret, s(&first, "refresh_token"), "retained").await;
        assert_eq!(retry.status, 409);
        assert_eq!(retry.json["error"], "refresh_result_unavailable");
        assert_refresh(&keyed(&ctx, &app, &secret, successor, "new").await);
    }
}

#[tokio::test]
async fn recovery_cannot_restart_access_token_expiry() {
    let (ctx, app, secret, first) = fixture().await;
    let first_reply = keyed(&ctx, &app, &secret, s(&first, "refresh_token"), "clock").await;
    let tokens = assert_refresh(&first_reply);
    tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
    let retry = keyed(&ctx, &app, &secret, s(&first, "refresh_token"), "clock").await;
    let recovered = assert_refresh(&retry);
    assert_eq!(
        tokens["access_token_expires_at"],
        recovered["access_token_expires_at"]
    );
    assert!(recovered["expires_in"].as_i64() < tokens["expires_in"].as_i64());
}

#[tokio::test]
async fn malformed_keys_and_wrong_clients_cannot_recover() {
    let (ctx, app, secret, first) = fixture().await;
    let token = s(&first, "refresh_token");
    for key in ["", "has spaces", &"x".repeat(201)] {
        let r = keyed(&ctx, &app, &secret, token, key).await;
        assert_eq!(r.status, 400);
        assert_eq!(r.json["error"], "invalid_request");
    }
    assert_refresh(&keyed(&ctx, &app, &secret, token, "valid").await);
    let (other, other_secret) = ctx.app("other").await;
    let wrong = keyed(&ctx, &other.app_id, &other_secret, token, "valid").await;
    assert_eq!(wrong.status, 400);
    assert_eq!(wrong.json["error"], "invalid_grant");
    let invalid = keyed(&ctx, &app, "wrong-secret", token, "valid").await;
    assert_eq!(invalid.status, 401);
    let me = ctx
        .call(
            router(),
            Req::get("/v1/userinfo").bearer(s(
                assert_refresh(&keyed(&ctx, &app, &secret, token, "valid").await),
                "access_token",
            )),
        )
        .await;
    assert_eq!(me.status, 200);
}

#[tokio::test]
async fn expired_access_can_recover_the_successor_and_rotate_it() {
    let (mut ctx, app, secret, first) = fixture().await;
    let mut settings = accounts_core::test_support::test_settings();
    settings.access_token_ttl_seconds = 1;
    ctx.state = accounts_core::test_support::test_state_with(ctx.db.pool.clone(), settings);
    let reply = keyed(
        &ctx,
        &app,
        &secret,
        s(&first, "refresh_token"),
        "short-access",
    )
    .await;
    let issued = assert_refresh(&reply);
    tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
    let retry = keyed(
        &ctx,
        &app,
        &secret,
        s(&first, "refresh_token"),
        "short-access",
    )
    .await;
    let recovered = assert_refresh(&retry);
    assert_eq!(recovered["expires_in"], 0);
    assert_eq!(issued["refresh_token"], recovered["refresh_token"]);
    assert_eq!(
        issued["access_token_expires_at"],
        recovered["access_token_expires_at"]
    );
    assert_refresh(
        &keyed(
            &ctx,
            &app,
            &secret,
            s(recovered, "refresh_token"),
            "next-access",
        )
        .await,
    );
}

#[tokio::test]
async fn cleanup_retires_ciphertext_but_retains_recognized_operation() {
    for invalidate in [
        "update refresh_recoveries set expires_at=now()-interval '1 second'",
        "update token_families set revoked_at=now(),revoke_reason='logout'",
    ] {
        let (ctx, app, secret, first) = fixture().await;
        assert_refresh(&keyed(&ctx, &app, &secret, s(&first, "refresh_token"), "purged").await);
        ctx.exec(invalidate).await;
        assert_eq!(
            accounts_core::repo::refresh_recovery::purge(&ctx.state.db)
                .await
                .unwrap(),
            1
        );
        let retained: i64 = scalar(
            &ctx,
            "select count(*) from refresh_recoveries where app_id=$1 and response is null",
            &app,
        )
        .await;
        assert_eq!(retained, 1);
        assert_eq!(
            accounts_core::repo::refresh_recovery::purge(&ctx.state.db)
                .await
                .unwrap(),
            0
        );
        let retry = keyed(&ctx, &app, &secret, s(&first, "refresh_token"), "purged").await;
        assert!(matches!(retry.status.as_u16(), 400 | 409));
        assert!(retry.json.get("access_token").is_none());
    }
}

#[tokio::test]
async fn recovery_scope_binding_is_canonical() {
    let (ctx, app, secret, first) = fixture().await;
    let mut results = Vec::new();
    for scope in ["email profile", "profile email profile"] {
        let r = ctx
            .call(
                router(),
                token_req(
                    &app,
                    &secret,
                    &[
                        ("grant_type", "refresh_token"),
                        ("refresh_token", s(&first, "refresh_token")),
                        ("scope", scope),
                    ],
                )
                .header("Idempotency-Key", "canonical"),
            )
            .await;
        results.push(assert_refresh(&r)["refresh_token"].clone());
    }
    assert_eq!(results[0], results[1]);
}

#[tokio::test]
async fn encrypted_results_cannot_be_moved_between_accounts() {
    let (ctx, app, secret, first) = fixture().await;
    let other = ctx.carbon().await;
    let other_tokens = sign_in(&ctx, &app, &secret, &other, &[Scope::Profile]).await;
    assert_refresh(
        &keyed(
            &ctx,
            &app,
            &secret,
            s(&first, "refresh_token"),
            "first-account",
        )
        .await,
    );
    assert_refresh(
        &keyed(
            &ctx,
            &app,
            &secret,
            s(&other_tokens, "refresh_token"),
            "other-account",
        )
        .await,
    );
    ctx.exec("update refresh_recoveries a set response=b.response from refresh_recoveries b where a.app_id=b.app_id and a.family_id<>b.family_id").await;
    let retry = keyed(
        &ctx,
        &app,
        &secret,
        s(&first, "refresh_token"),
        "first-account",
    )
    .await;
    assert_eq!(retry.status, 409);
    assert_eq!(retry.json["error"], "refresh_result_unavailable");
    assert!(retry.json.get("access_token").is_none());
}
