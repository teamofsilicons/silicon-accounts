//! Shared helpers for the integration tests.

#![allow(dead_code)]

use accounts_core::models::Account;
use accounts_core::test_support::{Req, Resp, TestContext};
use serde_json::{Value, json};

/// The crate's router.
pub fn router() -> axum::Router<accounts_core::AppState> {
    accounts_silicons::router()
}

/// Sends a request through the crate's router.
pub async fn call(ctx: &TestContext, req: Req) -> Resp {
    ctx.call(router(), req).await
}

/// A first-party access token (aud = accounts) for an account.
pub async fn token(ctx: &TestContext, account: &Account) -> String {
    ctx.first_party_tokens(account).await.access_token
}

/// `POST /v1/silicons` with a body.
pub async fn self_create(ctx: &TestContext, body: Value) -> Resp {
    call(ctx, Req::post("/v1/silicons").json(body)).await
}

/// A unique si:id.
pub fn silicon_id(prefix: &str) -> String {
    format!("si:{prefix}-{}", accounts_core::test_support::rand_suffix())
}

/// Self-creates a Silicon naming `custodian` (a c:id or email) and returns the 201 body.
pub async fn self_created(ctx: &TestContext, custodian: &str, extra: Value) -> Value {
    let mut body = json!({
        "id": silicon_id("scout"),
        "display_name": "Scout",
        "custodian": custodian,
    });
    if let (Some(b), Some(e)) = (body.as_object_mut(), extra.as_object()) {
        for (k, v) in e {
            b.insert(k.clone(), v.clone());
        }
    }
    let r = self_create(ctx, body).await;
    assert_eq!(r.status, 201, "self-create failed: {}", r.json);
    r.json
}

/// Silicon webhook events for a Silicon, oldest first: (type, payload).
pub async fn silicon_events(ctx: &TestContext, silicon_uuid: &str) -> Vec<(String, Value)> {
    sqlx::query_as(
        "select type, payload from webhook_events where target_kind = 'silicon' and target_id = $1 \
         order by occurred_at, event_id",
    )
    .bind(silicon_uuid)
    .fetch_all(&ctx.state.db)
    .await
    .expect("silicon events")
}

/// Event types only.
pub async fn silicon_event_types(ctx: &TestContext, silicon_uuid: &str) -> Vec<String> {
    silicon_events(ctx, silicon_uuid)
        .await
        .into_iter()
        .map(|(t, _)| t)
        .collect()
}

/// App webhook events sent to an app, oldest first: (type, payload).
pub async fn app_events(ctx: &TestContext, app_id: &str) -> Vec<(String, Value)> {
    sqlx::query_as(
        "select type, payload from webhook_events where target_kind = 'app' and target_id = $1 \
         order by occurred_at, event_id",
    )
    .bind(app_id)
    .fetch_all(&ctx.state.db)
    .await
    .expect("app events")
}

/// The delivery URLs queued for an event type of a target.
pub async fn delivery_urls(ctx: &TestContext, target_id: &str, event_type: &str) -> Vec<String> {
    sqlx::query_scalar(
        "select d.url from webhook_deliveries d join webhook_events e on e.event_id = d.event_id \
         where d.target_id = $1 and e.type = $2",
    )
    .bind(target_id)
    .bind(event_type)
    .fetch_all(&ctx.state.db)
    .await
    .expect("deliveries")
}

/// Loads an account row.
pub async fn account(ctx: &TestContext, uuid: &str) -> Account {
    let mut conn = ctx.conn().await;
    accounts_core::repo::accounts::require(&mut conn, uuid)
        .await
        .expect("account")
}

/// A custodian request row as JSON-ish tuple: (status, kind, to_uuid, to_email, decided_by).
pub async fn request_row(
    ctx: &TestContext,
    id: &str,
) -> (
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
) {
    sqlx::query_as(
        "select status, kind, to_uuid, to_email, decided_by from custodian_requests where id = $1::uuid",
    )
    .bind(id)
    .fetch_one(&ctx.state.db)
    .await
    .expect("request row")
}

/// Custodian history rows of a Silicon, oldest first: (from, to, kind).
pub async fn custodian_history(
    ctx: &TestContext,
    silicon_uuid: &str,
) -> Vec<(Option<String>, String, String)> {
    sqlx::query_as(
        "select from_uuid, to_uuid, kind from custodian_history where silicon_uuid = $1 order by at, id",
    )
    .bind(silicon_uuid)
    .fetch_all(&ctx.state.db)
    .await
    .expect("custodian history")
}

/// Audit actions recorded in an account's history.
pub async fn audit_actions(ctx: &TestContext, account_uuid: &str) -> Vec<String> {
    sqlx::query_scalar("select action from audit_log where account_uuid = $1 order by id")
        .bind(account_uuid)
        .fetch_all(&ctx.state.db)
        .await
        .expect("audit")
}

/// Makes a pending request overdue (time travel).
pub async fn make_overdue(ctx: &TestContext, request_id: &str) {
    ctx.exec(&format!(
        "update custodian_requests set expires_at = now() - interval '1 second', \
         created_at = now() - interval '14 days 1 second' where id = '{request_id}'"
    ))
    .await;
}

/// Accepts a request as `carbon` through the API.
pub async fn accept(ctx: &TestContext, carbon_token: &str, request_id: &str) -> Resp {
    call(
        ctx,
        Req::post(&format!("/v1/me/custodian-requests/{request_id}/accept")).bearer(carbon_token),
    )
    .await
}

/// Declines a request as `carbon` through the API.
pub async fn decline(ctx: &TestContext, carbon_token: &str, request_id: &str) -> Resp {
    call(
        ctx,
        Req::post(&format!("/v1/me/custodian-requests/{request_id}/decline")).bearer(carbon_token),
    )
    .await
}

/// Signs a Silicon in through the API.
pub async fn login(ctx: &TestContext, id: &str, stk: &str) -> Resp {
    call(
        ctx,
        Req::post("/v1/silicons/login").json(json!({"id": id, "stk": stk})),
    )
    .await
}

/// Creates a Silicon through `POST /v1/me/silicons` as `carbon_token`; returns the 201 body.
pub async fn custodian_created(ctx: &TestContext, carbon_token: &str, extra: Value) -> Value {
    let mut body = json!({"id": silicon_id("helper"), "display_name": "Helper"});
    if let (Some(b), Some(e)) = (body.as_object_mut(), extra.as_object()) {
        for (k, v) in e {
            b.insert(k.clone(), v.clone());
        }
    }
    let r = call(
        ctx,
        Req::post("/v1/me/silicons").bearer(carbon_token).json(body),
    )
    .await;
    assert_eq!(r.status, 201, "custodian create failed: {}", r.json);
    r.json
}

/// Sets an app's sign-in config document (required/optional fields, domains, …).
pub async fn set_app_config(ctx: &TestContext, app_id: &str, config: Value) {
    sqlx::query("update app_signin_configs set config = $2 where app_id = $1")
        .bind(app_id)
        .bind(config)
        .execute(&ctx.state.db)
        .await
        .expect("set config");
}

/// Parses an RFC 3339 timestamp from a JSON value.
pub fn ts(v: &Value) -> time::OffsetDateTime {
    accounts_core::timefmt::parse_rfc3339(v.as_str().expect("timestamp string")).expect("rfc3339")
}

/// Sends a request through the crate's router from a spawned task (for interleaving tests).
pub fn spawn_call(ctx: &TestContext, req: Req) -> tokio::task::JoinHandle<Resp> {
    let state = ctx.state.clone();
    tokio::spawn(
        async move { accounts_core::test_support::call(router().with_state(state), req).await },
    )
}

/// Waits until at least `n` sessions of this test's database are blocked on a lock (a row lock
/// or an advisory lock), so an interleaving test knows a request reached the lock it tests.
pub async fn wait_for_lock_waiters(ctx: &TestContext, n: i64) {
    for _ in 0..1000 {
        let waiting: i64 = sqlx::query_scalar(
            "select count(*) from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'",
        )
        .fetch_one(&ctx.state.db)
        .await
        .expect("pg_stat_activity");
        if waiting >= n {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    panic!("expected {n} sessions waiting on a lock");
}

/// Step one of the account crate's `DELETE /v1/me`, with the same locks in the same order: the
/// pending custodian requests addressed to the Carbon's uuid, then the Carbon's own row (both
/// `for update`). The returned transaction holds them; finish with [`finish_account_deletion`].
pub async fn begin_account_deletion(
    pool: &sqlx::PgPool,
    carbon_uuid: &str,
) -> sqlx::Transaction<'static, sqlx::Postgres> {
    let mut tx = pool.begin().await.expect("begin");
    sqlx::query(
        "select id from custodian_requests where status = 'pending' and to_uuid = $1 for update",
    )
    .bind(carbon_uuid)
    .fetch_all(&mut *tx)
    .await
    .expect("lock requests");
    accounts_core::repo::accounts::lock(&mut tx, carbon_uuid)
        .await
        .expect("lock account");
    tx
}

/// Step two of `DELETE /v1/me`: refuse while the Carbon is custodian of a Silicon (what the
/// endpoint answers with 409 `custodian_of_silicons`), else delete the account and commit.
pub async fn finish_account_deletion(
    mut tx: sqlx::Transaction<'static, sqlx::Postgres>,
    carbon_uuid: &str,
) -> Result<(), String> {
    let silicons = accounts_core::repo::accounts::list_silicons_in_custody(&mut tx, carbon_uuid)
        .await
        .expect("custody");
    if !silicons.is_empty() {
        tx.rollback().await.expect("rollback");
        return Err("custodian_of_silicons".into());
    }
    accounts_core::repo::accounts::delete_account(
        &mut tx,
        &accounts_core::Settings::for_tests(),
        carbon_uuid,
        carbon_uuid,
        true,
    )
    .await
    .expect("delete");
    tx.commit().await.expect("commit");
    Ok(())
}

/// Both steps of `DELETE /v1/me` (see [`begin_account_deletion`]), from a spawned task.
pub fn spawn_account_deletion(
    ctx: &TestContext,
    carbon_uuid: &str,
) -> tokio::task::JoinHandle<Result<(), String>> {
    let (pool, uuid) = (ctx.state.db.clone(), carbon_uuid.to_string());
    tokio::spawn(async move {
        let tx = begin_account_deletion(&pool, &uuid).await;
        finish_account_deletion(tx, &uuid).await
    })
}

/// `select … for update` on an account row in a new transaction (a stand-in for another request
/// holding it); roll it back to release.
pub async fn hold_row_lock(
    ctx: &TestContext,
    uuid: &str,
    mode: &str,
) -> sqlx::Transaction<'static, sqlx::Postgres> {
    let mut tx = ctx.state.db.begin().await.expect("begin");
    let sql = match mode {
        "share" => "select uuid from accounts where uuid = $1 for share",
        _ => "select uuid from accounts where uuid = $1 for update",
    };
    sqlx::query(sql)
        .bind(uuid)
        .fetch_all(&mut *tx)
        .await
        .expect("row lock");
    tx
}

/// Every Silicon (any status) whose custodian is `carbon_uuid`: (uuid, status).
pub async fn silicons_of(ctx: &TestContext, carbon_uuid: &str) -> Vec<(String, String)> {
    sqlx::query_as("select uuid, status from accounts where custodian_uuid = $1 order by number")
        .bind(carbon_uuid)
        .fetch_all(&ctx.state.db)
        .await
        .expect("silicons")
}

/// The stored idempotency responses for a key, as JSON text.
pub async fn stored_idempotent_response(ctx: &TestContext, key: &str) -> String {
    sqlx::query_scalar("select response::text from idempotency_keys where key = $1")
        .bind(key)
        .fetch_one(&ctx.state.db)
        .await
        .expect("stored response")
}
