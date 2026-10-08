//! The cleanup sweep deletes expired working state and never touches history.

use accounts_core::test_support::TestContext;
use accounts_worker::cleanup;

async fn count(ctx: &TestContext, sql: &'static str) -> i64 {
    sqlx::query_scalar(sql)
        .fetch_one(&mut *ctx.conn().await)
        .await
        .expect("count")
}

#[tokio::test]
async fn deletes_expired_state_and_keeps_live_rows_and_history() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let u = &carbon.uuid;
    // For each table: rows past the retention (deleted) and rows recently expired or live (kept).
    ctx.exec(&format!(
        "insert into signin_flows (id, binding_hash, app_id, redirect_uri, step, expires_at) values \
           ('flow-old', '\\x01', 'silicon-accounts', 'http://localhost:8590/', 'choose_method', now() - interval '2 days'), \
           ('flow-recent', '\\x02', 'silicon-accounts', 'http://localhost:8590/', 'choose_method', now() - interval '1 hour'), \
           ('flow-live', '\\x03', 'silicon-accounts', 'http://localhost:8590/', 'choose_method', now() + interval '1 hour'); \
         insert into otp_challenges (id, purpose, channel, destination, code_hash, expires_at, created_at) values \
           (gen_random_uuid(), 'signin', 'email', 'a@example.test', '\\x01', now() - interval '2 days', now() - interval '2 days'), \
           (gen_random_uuid(), 'signin', 'email', 'b@example.test', '\\x02', now() + interval '5 minutes', now()); \
         insert into authorization_codes (code_hash, flow_id, app_id, account_uuid, redirect_uri, scopes, expires_at) values \
           ('\\x01', 'f', 'silicon-accounts', '{u}', 'http://localhost:8590/', '{{profile}}', now() - interval '8 days'), \
           ('\\x02', 'f', 'silicon-accounts', '{u}', 'http://localhost:8590/', '{{profile}}', now() - interval '2 days'); \
         insert into short_lived_tokens (token_hash, account_uuid, app_id, scopes, expires_at) values \
           ('\\x01', '{u}', 'silicon-accounts', '{{profile}}', now() - interval '8 days'), \
           ('\\x02', '{u}', 'silicon-accounts', '{{profile}}', now() - interval '10 minutes'); \
         insert into device_authorizations (device_code_hash, user_code, status, expires_at) values \
           ('\\x01', 'AAAA-AAAA', 'pending', now() - interval '8 days'), \
           ('\\x02', 'BBBB-BBBB', 'pending', now() + interval '10 minutes'); \
         insert into idempotency_keys (scope, key, request_hash, status_code, response, expires_at) values \
           ('ip:1 POST /v1/reports', 'old', '\\x01', 201, '{{}}', now() - interval '1 minute'), \
           ('ip:1 POST /v1/reports', 'live', '\\x02', 201, '{{}}', now() + interval '1 hour'); \
         insert into handle_reservations (handle, account_uuid, reserved_until) values \
           ('c:gone-reservation', '{u}', now() - interval '2 days'), \
           ('c:recent-reservation', '{u}', now() - interval '1 hour'), \
           ('c:live-reservation', '{u}', now() + interval '9 days'); \
         insert into signup_sessions (id, secret_hash, expires_at, created_at, consumed_at) values \
           (gen_random_uuid(), '\\x01', now() - interval '8 days', now() - interval '10 days', null), \
           (gen_random_uuid(), '\\x02', now() - interval '6 days', now() - interval '8 days', now() - interval '8 days'), \
           (gen_random_uuid(), '\\x03', now() - interval '2 days', now() - interval '4 days', null), \
           (gen_random_uuid(), '\\x04', now() + interval '47 hours', now() - interval '1 hour', null); \
         insert into rate_limits (bucket, window_started_at, count) values \
           ('reports:ip:old', now() - interval '2 days', 3), ('reports:ip:live', now(), 1); \
         insert into audit_log (at, actor_kind, action, account_uuid) values (now() - interval '400 days', 'system', 'test.old', '{u}'); \
         insert into signin_history (account_uuid, method, outcome, at) values ('{u}', 'email', 'success', now() - interval '400 days'); \
         insert into handle_history (account_uuid, old_handle, new_handle, changed_at) values ('{u}', 'c:a', 'c:b', now() - interval '400 days');"
    ))
    .await;
    let audit_before = count(&ctx, "select count(*) from audit_log").await;
    let handle_history_before = count(&ctx, "select count(*) from handle_history").await;

    let report = cleanup::run_once(&ctx.state).await;
    assert!(report.errors.is_empty(), "{:?}", report.errors);
    assert_eq!(report.signin_flows, 1);
    assert_eq!(report.otp_challenges, 1);
    assert_eq!(report.authorization_codes, 1);
    assert_eq!(report.short_lived_tokens, 1);
    assert_eq!(report.device_authorizations, 1);
    assert_eq!(report.idempotency_keys, 1);
    assert_eq!(report.handle_reservations, 1);
    assert_eq!(
        report.signup_sessions, 2,
        "expired a week ago, or used a week ago"
    );
    assert_eq!(report.rate_limits, 1);
    assert_eq!(report.total(), 10);

    assert_eq!(count(&ctx, "select count(*) from signin_flows").await, 2);
    assert_eq!(count(&ctx, "select count(*) from otp_challenges").await, 1);
    assert_eq!(
        count(&ctx, "select count(*) from authorization_codes").await,
        1
    );
    assert_eq!(
        count(&ctx, "select count(*) from short_lived_tokens").await,
        1
    );
    assert_eq!(
        count(&ctx, "select count(*) from device_authorizations").await,
        1
    );
    assert_eq!(
        count(&ctx, "select count(*) from idempotency_keys").await,
        1
    );
    assert_eq!(
        count(
            &ctx,
            "select count(*) from handle_reservations where handle = 'c:live-reservation'"
        )
        .await,
        1
    );
    assert_eq!(
        count(&ctx, "select count(*) from handle_reservations").await,
        2,
        "a reservation that ended an hour ago is kept for a day"
    );
    assert_eq!(count(&ctx, "select count(*) from signup_sessions").await, 2);
    assert_eq!(count(&ctx, "select count(*) from rate_limits").await, 1);

    // History is untouched.
    assert_eq!(
        count(&ctx, "select count(*) from audit_log").await,
        audit_before
    );
    assert_eq!(
        count(&ctx, "select count(*) from handle_history").await,
        handle_history_before
    );
    assert_eq!(count(&ctx, "select count(*) from signin_history").await, 1);

    let again = cleanup::run_once(&ctx.state).await;
    assert_eq!(again.total(), 0, "a second sweep finds nothing");
}
