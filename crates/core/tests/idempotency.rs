//! Idempotency: replay, key reuse with a different body, the 10-minute window for responses with
//! fresh secrets, and failures that are not stored.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use accounts_core::ApiError;
use accounts_core::repo::idempotency::{self, REPLAYED_HEADER};
use accounts_core::test_support::TestContext;
use axum::http::StatusCode;
use serde_json::json;

async fn body_of(r: axum::response::Response) -> serde_json::Value {
    let bytes = axum::body::to_bytes(r.into_body(), 1 << 20)
        .await
        .expect("body");
    serde_json::from_slice(&bytes).expect("json")
}

#[tokio::test]
async fn same_key_and_body_replays_without_running_twice() {
    let ctx = TestContext::new().await;
    let runs = Arc::new(AtomicUsize::new(0));
    let scope = idempotency::scope("account:a8K", "POST", "/v1/me/silicons");
    let body = json!({"id": "si:scout", "display_name": "Scout"});
    let work = |n: Arc<AtomicUsize>| async move {
        let i = n.fetch_add(1, Ordering::SeqCst) + 1;
        Ok((
            StatusCode::CREATED,
            json!({"run": i, "stk": "stk-0123456789ab"}),
        ))
    };

    let r1 = idempotency::run(&ctx.state, Some("key-1"), &scope, &body, true, || {
        work(runs.clone())
    })
    .await
    .expect("first");
    assert_eq!(r1.status(), StatusCode::CREATED);
    assert!(r1.headers().get(REPLAYED_HEADER).is_none());
    let b1 = body_of(r1).await;

    // Key order in the request body doesn't matter.
    let reordered = json!({"display_name": "Scout", "id": "si:scout"});
    let r2 = idempotency::run(&ctx.state, Some("key-1"), &scope, &reordered, true, || {
        work(runs.clone())
    })
    .await
    .expect("replay");
    assert_eq!(r2.status(), StatusCode::CREATED);
    assert_eq!(
        r2.headers()
            .get(REPLAYED_HEADER)
            .and_then(|v| v.to_str().ok()),
        Some("true")
    );
    assert_eq!(body_of(r2).await, b1);
    assert_eq!(runs.load(Ordering::SeqCst), 1);

    // The stored response holds no secret in clear: it is sealed with the keyring.
    let stored: String = sqlx::query_scalar(
        "select response::text from idempotency_keys where scope = $1 and key = 'key-1'",
    )
    .bind(&scope)
    .fetch_one(&ctx.state.db)
    .await
    .expect("row");
    assert!(
        !stored.contains("stk-") && stored.contains("$sealed"),
        "stored in clear: {stored}"
    );
    // A sealed result that can't be opened any more is never run again.
    sqlx::query(
        "update idempotency_keys set response = '{\"$sealed\": \"AAAA\"}'::jsonb where scope = $1 and key = 'key-1'",
    )
    .bind(&scope)
    .execute(&ctx.state.db)
    .await
    .expect("corrupt");
    let err = idempotency::run(&ctx.state, Some("key-1"), &scope, &body, true, || {
        work(runs.clone())
    })
    .await
    .expect_err("unavailable");
    assert_eq!(err.code, "idempotency_result_unavailable");
    assert_eq!(runs.load(Ordering::SeqCst), 1);

    // Same key, different body → 409.
    let other = json!({"id": "si:other", "display_name": "Other"});
    let err = idempotency::run(&ctx.state, Some("key-1"), &scope, &other, true, || {
        work(runs.clone())
    })
    .await
    .expect_err("reused");
    assert_eq!(err.code, "idempotency_key_reused");
    assert_eq!(err.status, StatusCode::CONFLICT);

    // Same key in another scope (another caller or endpoint) is independent.
    let scope2 = idempotency::scope("account:zQo", "POST", "/v1/me/silicons");
    idempotency::run(&ctx.state, Some("key-1"), &scope2, &other, true, || {
        work(runs.clone())
    })
    .await
    .expect("other scope");
    assert_eq!(runs.load(Ordering::SeqCst), 2);

    // Secret-bearing responses are replayable for 10 minutes only.
    let expires: time::OffsetDateTime = sqlx::query_scalar(
        "select expires_at from idempotency_keys where scope = $1 and key = 'key-1'",
    )
    .bind(&scope)
    .fetch_one(&ctx.state.db)
    .await
    .expect("row");
    let secs = (expires - time::OffsetDateTime::now_utc()).whole_seconds();
    assert!((590..=600).contains(&secs), "{secs}");
    sqlx::query(
        "update idempotency_keys set expires_at = now() - interval '1 second' where scope = $1",
    )
    .bind(&scope)
    .execute(&ctx.state.db)
    .await
    .expect("time travel");
    let r3 = idempotency::run(&ctx.state, Some("key-1"), &scope, &body, true, || {
        work(runs.clone())
    })
    .await
    .expect("runs again");
    assert!(r3.headers().get(REPLAYED_HEADER).is_none());
    assert_eq!(runs.load(Ordering::SeqCst), 3);
}

#[tokio::test]
async fn ordinary_responses_replay_for_a_day_and_failures_are_not_stored() {
    let ctx = TestContext::new().await;
    let scope = idempotency::scope("app:briefcase", "POST", "/v1/apps/briefcase/webhook/replay");
    let body = json!({"delivery_ids": []});
    idempotency::run(&ctx.state, Some("k"), &scope, &body, false, || async {
        Ok((StatusCode::OK, json!({"ok": true})))
    })
    .await
    .expect("ok");
    let expires: time::OffsetDateTime =
        sqlx::query_scalar("select expires_at from idempotency_keys where key = 'k'")
            .fetch_one(&ctx.state.db)
            .await
            .expect("row");
    let hours = (expires - time::OffsetDateTime::now_utc()).whole_hours();
    assert!((23..=24).contains(&hours), "{hours}");
    // Ordinary responses are stored as they are.
    let stored: serde_json::Value =
        sqlx::query_scalar("select response from idempotency_keys where key = 'k'")
            .fetch_one(&ctx.state.db)
            .await
            .expect("row");
    assert_eq!(stored, json!({"ok": true}));

    let runs = Arc::new(AtomicUsize::new(0));
    let failing = |n: Arc<AtomicUsize>| async move {
        n.fetch_add(1, Ordering::SeqCst);
        Err::<(StatusCode, serde_json::Value), _>(ApiError::conflict("id_taken", "taken"))
    };
    for _ in 0..2 {
        let err = idempotency::run(&ctx.state, Some("k2"), &scope, &body, false, || {
            failing(runs.clone())
        })
        .await
        .expect_err("fails");
        assert_eq!(err.code, "id_taken");
    }
    assert_eq!(
        runs.load(Ordering::SeqCst),
        2,
        "failed requests run again on retry"
    );

    // No key: always runs.
    let r = idempotency::run(&ctx.state, None, &scope, &body, false, || async {
        Ok((StatusCode::ACCEPTED, json!({})))
    })
    .await
    .expect("no key");
    assert_eq!(r.status(), StatusCode::ACCEPTED);
}

#[tokio::test]
async fn concurrent_duplicate_sees_in_progress() {
    let ctx = TestContext::new().await;
    let scope = idempotency::scope("ip:1.2.3.4", "POST", "/v1/silicons");
    let hash = idempotency::request_hash(&json!({"a": 1}));
    assert_eq!(
        idempotency::begin(&ctx.state.db, &scope, "k", &hash)
            .await
            .expect("claim"),
        idempotency::Begin::Proceed
    );
    let err = idempotency::begin(&ctx.state.db, &scope, "k", &hash)
        .await
        .expect_err("busy");
    assert_eq!(err.code, "idempotency_in_progress");
    idempotency::abandon(&ctx.state.db, &scope, "k")
        .await
        .expect("abandon");
    assert_eq!(
        idempotency::begin(&ctx.state.db, &scope, "k", &hash)
            .await
            .expect("claim again"),
        idempotency::Begin::Proceed
    );
}
