//! Shared helpers for the account API tests.

use accounts_core::AppState;
use accounts_core::models::{Account, AccountKind, AccountStatus, Scope};
use accounts_core::repo::accounts::{self, NewSilicon};
use accounts_core::test_support::{Req, Resp, TestContext, rand_suffix};
use axum::Router;
use serde_json::Value;

pub fn router() -> Router<AppState> {
    accounts_account::router()
}

/// Sends a request through the account router.
pub async fn call(ctx: &TestContext, req: Req) -> Resp {
    ctx.call(router(), req).await
}

/// A first-party (aud = silicon-accounts) access token for the account.
pub async fn token(ctx: &TestContext, account: &Account) -> String {
    ctx.first_party_tokens(account).await.access_token
}

/// Asserts status + error code, printing the body on failure.
#[track_caller]
pub fn assert_error(r: &Resp, status: u16, code: &str) {
    assert_eq!(
        (r.status.as_u16(), r.error_code()),
        (status, Some(code)),
        "unexpected response: {}",
        r.json
    );
}

/// Asserts a status, printing the body on failure.
#[track_caller]
pub fn assert_status(r: &Resp, status: u16) {
    assert_eq!(r.status.as_u16(), status, "unexpected response: {}", r.json);
}

/// Stored webhook payloads for a target (app_id or Silicon uuid) and event type, oldest first.
pub async fn events(ctx: &TestContext, target_id: &str, event_type: &str) -> Vec<Value> {
    sqlx::query_scalar(
        "select payload from webhook_events where target_id = $1 and type = $2 order by occurred_at, event_id",
    )
    .bind(target_id)
    .bind(event_type)
    .fetch_all(&ctx.state.db)
    .await
    .expect("webhook events")
}

/// Every stored webhook event type for a target, oldest first.
pub async fn event_types(ctx: &TestContext, target_id: &str) -> Vec<String> {
    sqlx::query_scalar(
        "select type from webhook_events where target_id = $1 order by occurred_at, event_id",
    )
    .bind(target_id)
    .fetch_all(&ctx.state.db)
    .await
    .expect("webhook event types")
}

/// An app with a webhook and an active membership of `account` granting `scopes`.
pub async fn member_app(
    ctx: &TestContext,
    prefix: &str,
    account: &Account,
    scopes: &[Scope],
) -> String {
    let (app, _) = ctx.app(prefix).await;
    ctx.set_app_webhook(
        &app.app_id,
        &format!("http://127.0.0.1:8593/{}/webhooks", app.app_id),
    )
    .await;
    ctx.membership(&app.app_id, &account.uuid, scopes).await;
    app.app_id
}

/// Gives a Silicon its own webhook.
pub async fn set_silicon_webhook(ctx: &TestContext, silicon_uuid: &str) {
    let (_, enc) =
        accounts_core::events::new_webhook_secret(&ctx.state.keys.keyring).expect("webhook secret");
    let mut conn = ctx.conn().await;
    accounts::set_silicon_webhook(
        &mut conn,
        silicon_uuid,
        Some("http://127.0.0.1:8593/hooks/silicon"),
        Some(&enc),
    )
    .await
    .expect("set silicon webhook");
}

/// A self-created Silicon still waiting for a custodian (no custodian yet).
pub async fn pending_silicon(ctx: &TestContext) -> Account {
    let hash = ctx
        .state
        .keys
        .stk
        .hash(&accounts_core::crypto::stk::generate())
        .expect("stk hash");
    let mut conn = ctx.conn().await;
    accounts::create_silicon(
        &mut conn,
        &ctx.state.settings,
        NewSilicon {
            id: accounts_core::ids::AccountId::new(
                AccountKind::Silicon,
                &format!("p-{}", rand_suffix()),
            )
            .expect("id"),
            display_name: "Waiting Silicon".into(),
            pfp_url: None,
            timezone: "UTC".into(),
            status: AccountStatus::PendingCustodian,
            custodian_uuid: None,
            stk_hash: hash,
            webhook_url: None,
            webhook_secret_enc: None,
            actor: "test".into(),
        },
    )
    .await
    .expect("pending silicon")
}

/// Reloads an account row.
pub async fn reload(ctx: &TestContext, uuid: &str) -> Account {
    let mut conn = ctx.conn().await;
    accounts::require(&mut conn, uuid).await.expect("account")
}

/// The newest 6-digit code sent to an address.
pub async fn latest_code(ctx: &TestContext, to: &str) -> String {
    let messages = ctx.outbox(to).await;
    let (_, text) = messages.first().expect("a message was sent");
    accounts_core::delivery::extract_code(text).expect("a code in the message")
}

/// Waits until at least `n` sessions of this test's database are blocked on a lock (requests
/// queued behind a transaction the test holds open), so concurrency tests don't rely on sleeps.
pub async fn wait_for_lock_waiters(ctx: &TestContext, n: i64) {
    for _ in 0..500 {
        let waiting: i64 = sqlx::query_scalar(
            "select count(*) from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'",
        )
        .fetch_one(&ctx.state.db)
        .await
        .expect("pg_stat_activity");
        if waiting >= n {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    panic!("{n} request(s) never queued behind the test's lock within 10 seconds");
}

/// Runs a scalar query.
pub async fn scalar<T>(ctx: &TestContext, sql: &'static str, arg: &str) -> T
where
    T: Send + Unpin + for<'r> sqlx::Decode<'r, sqlx::Postgres> + sqlx::Type<sqlx::Postgres>,
{
    sqlx::query_scalar(sql)
        .bind(arg)
        .fetch_one(&ctx.state.db)
        .await
        .expect("scalar query")
}

/// Image samples with valid headers.
pub mod images {
    pub fn png(width: u32, height: u32) -> Vec<u8> {
        let mut v = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        v.extend_from_slice(&13u32.to_be_bytes());
        v.extend_from_slice(b"IHDR");
        v.extend_from_slice(&width.to_be_bytes());
        v.extend_from_slice(&height.to_be_bytes());
        v.extend_from_slice(&[8, 6, 0, 0, 0, 0x1F, 0x15, 0xC4, 0x89]);
        v.extend_from_slice(&[0, 0, 0, 0, b'I', b'E', b'N', b'D', 0xAE, 0x42, 0x60, 0x82]);
        v
    }

    pub fn jpeg(width: u16, height: u16) -> Vec<u8> {
        let mut v = vec![0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10];
        v.extend_from_slice(b"JFIF\0");
        v.extend_from_slice(&[0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
        v.extend_from_slice(&[0xFF, 0xC0, 0x00, 0x11, 0x08]);
        v.extend_from_slice(&height.to_be_bytes());
        v.extend_from_slice(&width.to_be_bytes());
        v.extend_from_slice(&[0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
        v.extend_from_slice(&[0xFF, 0xDA, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3F, 0x00]);
        v.extend_from_slice(&[0x12, 0x34, 0xFF, 0xD9]);
        v
    }

    pub fn gif(width: u16, height: u16) -> Vec<u8> {
        let mut v = b"GIF89a".to_vec();
        v.extend_from_slice(&width.to_le_bytes());
        v.extend_from_slice(&height.to_le_bytes());
        v.extend_from_slice(&[0x00, 0x00, 0x00, 0x3B]);
        v
    }

    pub fn webp(width: u32, height: u32) -> Vec<u8> {
        let bits: u32 = (width - 1) | ((height - 1) << 14);
        let mut chunk = vec![0x2f];
        chunk.extend_from_slice(&bits.to_le_bytes());
        chunk.extend_from_slice(&[0, 0, 0]);
        let mut v = b"RIFF".to_vec();
        v.extend_from_slice(&((4 + 8 + chunk.len()) as u32).to_le_bytes());
        v.extend_from_slice(b"WEBPVP8L");
        v.extend_from_slice(&(chunk.len() as u32).to_le_bytes());
        v.extend_from_slice(&chunk);
        v
    }
}

/// A raw-body request (photo uploads).
pub fn raw(mut req: Req, content_type: Option<&str>, body: Vec<u8>) -> Req {
    req.body = body;
    match content_type {
        Some(ct) => req.header("content-type", ct),
        None => req,
    }
}
