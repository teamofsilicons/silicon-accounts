//! Deliveries of a Silicon's own webhook, for the Silicon (`session(silicon)`) and its custodian
//! (`session(carbon)`). UNDERSTANDING: Silicon webhooks are separate from app webhooks "but follow
//! these same rules": every event has an `event_id` and is signed, deliveries are retried until
//! they succeed, and failed deliveries can be replayed. So a Silicon's webhook gets the delivery
//! API an app's webhook has (`GET /v1/apps/{app_id}/webhook/deliveries…`, `POST …/replay`):
//!
//! | endpoint | for |
//! |---|---|
//! | `GET /v1/me/webhook/deliveries?status&limit&cursor` | the Silicon |
//! | `GET /v1/me/webhook/deliveries/{id}` | the Silicon |
//! | `POST /v1/me/webhook/replay` (IDEMPOTENT) | the Silicon |
//! | `GET /v1/me/silicons/{uuid}/webhook/deliveries?status&limit&cursor` | its custodian |
//! | `GET /v1/me/silicons/{uuid}/webhook/deliveries/{id}` | its custodian |
//! | `POST /v1/me/silicons/{uuid}/webhook/replay` (IDEMPOTENT) | its custodian |
//!
//! - A list is newest first, `{"items": [delivery], "next_cursor"}`, where a delivery is
//!   `{id, event_id, type, account_uuid, url, status, attempts, last_status, last_error,
//!   next_attempt_at, last_attempt_at, delivered_at, created_at, manual_replays}` (the app
//!   delivery's shape); `status` keeps only `pending`, `delivered` or `failed` ones.
//! - One delivery adds `attempt_count`, `attempts` (each one's `attempted_at`, `status_code`,
//!   `error`, `duration_ms`) and `payload`, the exact body that was signed. Every event of a
//!   Silicon's webhook is about the Silicon itself, so nothing is withheld from it or its
//!   custodian (`payload_redacted` is always false).
//! - Replay takes `{"delivery_ids": […]}` or `{"status": "failed", "since"?}`, at most
//!   [`MAX_REPLAY`] per call, and re-queues each delivery: pending, attempts 0,
//!   `manual_replays` + 1 and a fresh 72 hours of retries counted from the replay
//!   (`requeued_at`), with the same event id and payload. The worker sends it to the Silicon's
//!   current webhook URL, signed with the current secret. The answer is `{"replayed": [ids],
//!   "skipped": [{delivery_id, reason, message}], "remaining", "not_replayable", "url"}`. Reasons
//!   are `not_found`, `already_pending` and `test_ping`. By status the oldest failed deliveries go
//!   first, and `remaining` counts the failed ones still waiting (call again until it is 0).
//! - Test pings are never replayed. A replay would get around the test rules (10 pings an hour,
//!   and only the latest ping is retried; see `own_webhook`), so send a new ping instead.
//!   `not_replayable` counts them.
//! - 409 `webhook_not_set` when the Silicon has no webhook to send a replay to.

use accounts_core::error::{ApiError, ApiResult, FieldErrors};
use accounts_core::events::types;
use accounts_core::http::{
    CarbonAuth, ClientMeta, IdempotencyKey, Json, PageParams, Path, Query, SiliconAuth, paginate,
};
use accounts_core::models::Account;
use accounts_core::repo::idempotency;
use accounts_core::state::AppState;
use accounts_core::timefmt::{format_rfc3339_ms, parse_rfc3339};
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::Response;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::PgConnection;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::common::{lock_my_silicon, lock_own_account, my_silicon};
use crate::history::Actor;
use crate::own_webhook::WEBHOOK_TESTS_PER_SILICON;

/// Most deliveries one replay request re-queues (as for an app's webhook).
pub const MAX_REPLAY: usize = 100;

/// `?status&limit&cursor` of a delivery list.
#[derive(Debug, Default, Deserialize)]
pub struct DeliveriesQuery {
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    limit: Option<i64>,
    #[serde(default)]
    cursor: Option<String>,
}

/// `{"delivery_ids": […]}` or `{"status": "failed", "since"?: "…"}`.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ReplayBody {
    #[serde(default)]
    delivery_ids: Option<Vec<String>>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    since: Option<String>,
}

/// Who is asking: the Silicon itself, or its custodian. Errors point at that caller's routes.
#[derive(Debug, Clone, Copy)]
enum Caller<'a> {
    Silicon,
    Custodian { carbon_uuid: &'a str },
}

impl Caller<'_> {
    fn deliveries_path(self, silicon: &Account) -> String {
        match self {
            Caller::Silicon => "/v1/me/webhook/deliveries".into(),
            Caller::Custodian { .. } => {
                format!("/v1/me/silicons/{}/webhook/deliveries", silicon.uuid)
            }
        }
    }

    fn webhook_path(self, silicon: &Account) -> String {
        match self {
            Caller::Silicon => "/v1/me/webhook".into(),
            Caller::Custodian { .. } => format!("/v1/me/silicons/{}/webhook", silicon.uuid),
        }
    }

    fn label(self) -> &'static str {
        match self {
            Caller::Silicon => "silicon",
            Caller::Custodian { .. } => "custodian",
        }
    }
}

// ---- the Silicon's routes ---------------------------------------------------------------------

/// `GET /v1/me/webhook/deliveries`.
pub async fn own_list(
    State(state): State<AppState>,
    me: SiliconAuth,
    Query(q): Query<DeliveriesQuery>,
) -> ApiResult<Json<Value>> {
    let mut conn = state.db.acquire().await?;
    Ok(Json(list(&mut conn, &me.account, q).await?))
}

/// `GET /v1/me/webhook/deliveries/{id}`.
pub async fn own_show(
    State(state): State<AppState>,
    me: SiliconAuth,
    Path(delivery_id): Path<String>,
) -> ApiResult<Json<Value>> {
    let mut conn = state.db.acquire().await?;
    Ok(Json(
        show(&mut conn, &me.account, &delivery_id, Caller::Silicon).await?,
    ))
}

/// `POST /v1/me/webhook/replay`.
pub async fn own_replay(
    State(state): State<AppState>,
    me: SiliconAuth,
    meta: ClientMeta,
    key: Option<IdempotencyKey>,
    Json(body): Json<ReplayBody>,
) -> ApiResult<Response> {
    let scope = idempotency::scope(
        &format!("account:{}", me.uuid()),
        "POST",
        "/v1/me/webhook/replay",
    );
    idempotency::run(&state, key.as_deref(), &scope, &body, false, || async {
        let selection = parse_replay(&body)?;
        let mut tx = state.db.begin().await?;
        // Share-locked: the webhook URL read here is the one the replay is sent to.
        let silicon =
            lock_own_account(&mut tx, &me.account, "replay its webhook deliveries").await?;
        let actor = Actor::account(me.uuid(), meta.ip.as_deref());
        let result = replay(&mut tx, &silicon, &selection, actor, Caller::Silicon).await?;
        tx.commit().await?;
        Ok((StatusCode::OK, result))
    })
    .await
}

// ---- the custodian's routes -------------------------------------------------------------------

/// `GET /v1/me/silicons/{uuid}/webhook/deliveries`.
pub async fn custodian_list(
    State(state): State<AppState>,
    me: CarbonAuth,
    Path(key): Path<String>,
    Query(q): Query<DeliveriesQuery>,
) -> ApiResult<Json<Value>> {
    let mut conn = state.db.acquire().await?;
    let silicon = my_silicon(&mut conn, me.uuid(), &key).await?;
    Ok(Json(list(&mut conn, &silicon, q).await?))
}

/// `GET /v1/me/silicons/{uuid}/webhook/deliveries/{id}`.
pub async fn custodian_show(
    State(state): State<AppState>,
    me: CarbonAuth,
    Path((key, delivery_id)): Path<(String, String)>,
) -> ApiResult<Json<Value>> {
    let mut conn = state.db.acquire().await?;
    let silicon = my_silicon(&mut conn, me.uuid(), &key).await?;
    let caller = Caller::Custodian {
        carbon_uuid: me.uuid(),
    };
    Ok(Json(show(&mut conn, &silicon, &delivery_id, caller).await?))
}

/// `POST /v1/me/silicons/{uuid}/webhook/replay`.
pub async fn custodian_replay(
    State(state): State<AppState>,
    me: CarbonAuth,
    meta: ClientMeta,
    key: Option<IdempotencyKey>,
    Path(silicon_key): Path<String>,
    Json(body): Json<ReplayBody>,
) -> ApiResult<Response> {
    let scope = idempotency::scope(
        &format!("account:{}", me.uuid()),
        "POST",
        &format!("/v1/me/silicons/{}/webhook/replay", silicon_key.trim()),
    );
    idempotency::run(&state, key.as_deref(), &scope, &body, false, || async {
        let selection = parse_replay(&body)?;
        let mut tx = state.db.begin().await?;
        let silicon = lock_my_silicon(&mut tx, me.uuid(), &silicon_key).await?;
        let actor = Actor::account(me.uuid(), meta.ip.as_deref());
        let caller = Caller::Custodian {
            carbon_uuid: me.uuid(),
        };
        let result = replay(&mut tx, &silicon, &selection, actor, caller).await?;
        tx.commit().await?;
        Ok((StatusCode::OK, result))
    })
    .await
}

// ---- listing ----------------------------------------------------------------------------------

/// The columns of a delivery and its event, for the Silicon `$1`.
macro_rules! delivery_select {
    () => {
        "select d.id, d.event_id, e.type as event_type, e.account_uuid, d.url, d.status, d.attempts, \
         d.last_status, d.last_error, d.next_attempt_at, d.last_attempt_at, d.delivered_at, \
         d.created_at, d.manual_replays \
         from webhook_deliveries d join webhook_events e on e.event_id = d.event_id \
         where d.target_kind = 'silicon' and d.target_id = $1 "
    };
}

#[derive(Debug, Clone, sqlx::FromRow)]
struct DeliveryRow {
    id: Uuid,
    event_id: Uuid,
    event_type: String,
    account_uuid: Option<String>,
    url: String,
    status: String,
    attempts: i32,
    last_status: Option<i32>,
    last_error: Option<String>,
    next_attempt_at: OffsetDateTime,
    last_attempt_at: Option<OffsetDateTime>,
    delivered_at: Option<OffsetDateTime>,
    created_at: OffsetDateTime,
    manual_replays: i32,
}

impl DeliveryRow {
    fn view(&self) -> Value {
        let ts = |t: Option<OffsetDateTime>| t.map(format_rfc3339_ms);
        json!({
            "id": self.id,
            "event_id": self.event_id,
            "type": self.event_type,
            "account_uuid": self.account_uuid,
            "url": self.url,
            "status": self.status,
            "attempts": self.attempts,
            "last_status": self.last_status,
            "last_error": self.last_error,
            // Only a pending delivery has a next attempt.
            "next_attempt_at": ts((self.status == "pending").then_some(self.next_attempt_at)),
            "last_attempt_at": ts(self.last_attempt_at),
            "delivered_at": ts(self.delivered_at),
            "created_at": format_rfc3339_ms(self.created_at),
            "manual_replays": self.manual_replays,
        })
    }
}

#[derive(Debug, sqlx::FromRow)]
struct AttemptRow {
    attempted_at: OffsetDateTime,
    status_code: Option<i32>,
    error: Option<String>,
    duration_ms: i32,
}

/// `status=` of a delivery list.
fn parse_status(value: Option<&str>) -> ApiResult<Option<&'static str>> {
    match value.map(str::trim).filter(|v| !v.is_empty()) {
        None => Ok(None),
        Some("pending") => Ok(Some("pending")),
        Some("delivered") => Ok(Some("delivered")),
        Some("failed") => Ok(Some("failed")),
        Some(other) => Err(ApiError::bad_request(
            "invalid_query",
            format!(
                "The query parameter 'status' is '{other}', which is not one of pending, delivered, failed."
            ),
        )
        .hint("Use status=failed for the deliveries a replay would send again, or leave status out for all of them.")),
    }
}

/// Microseconds since the Unix epoch: the precision Postgres stores, so a keyset cursor built
/// from it never skips or repeats a row.
fn micros(t: OffsetDateTime) -> i64 {
    (t.unix_timestamp_nanos() / 1000) as i64
}

fn from_micros(us: i64) -> ApiResult<OffsetDateTime> {
    OffsetDateTime::from_unix_timestamp_nanos(i128::from(us) * 1000).map_err(|_| {
        ApiError::bad_request("invalid_cursor", "The cursor is not valid for this list.")
            .hint("Pass the next_cursor value from the previous page unchanged, or omit cursor to start over.")
    })
}

/// A page of the Silicon's deliveries, newest first.
async fn list(conn: &mut PgConnection, silicon: &Account, q: DeliveriesQuery) -> ApiResult<Value> {
    let status = parse_status(q.status.as_deref())?;
    let params = PageParams {
        limit: q.limit,
        cursor: q.cursor,
    };
    let limit = params.limit();
    let (after_ts, after_id) = match params.cursor::<(i64, Uuid)>()? {
        Some((us, id)) => (Some(from_micros(us)?), Some(id)),
        None => (None, None),
    };
    let rows = sqlx::query_as::<_, DeliveryRow>(concat!(
        delivery_select!(),
        "and ($2::text is null or d.status = $2) \
         and ($3::timestamptz is null or (d.created_at, d.id) < ($3, $4)) \
         order by d.created_at desc, d.id desc limit $5"
    ))
    .bind(&silicon.uuid)
    .bind(status)
    .bind(after_ts)
    .bind(after_id)
    .bind(limit + 1)
    .fetch_all(&mut *conn)
    .await?;
    let page = paginate(rows, limit, |r| (micros(r.created_at), r.id));
    let items: Vec<Value> = page.items.iter().map(DeliveryRow::view).collect();
    Ok(json!({"items": items, "next_cursor": page.next_cursor}))
}

/// 404 `delivery_not_found`.
fn delivery_not_found(raw: &str, silicon: &Account, caller: Caller<'_>) -> ApiError {
    ApiError::not_found(
        "delivery_not_found",
        format!(
            "No webhook delivery '{}' exists for the Silicon {}.",
            raw.trim(),
            silicon.display_id()
        ),
    )
    .hint(format!(
        "List the Silicon's deliveries with GET {} to find delivery ids.",
        caller.deliveries_path(silicon)
    ))
    .detail("delivery_id", raw.trim())
}

/// One delivery of the Silicon, with its attempts and the exact payload that was signed.
async fn show(
    conn: &mut PgConnection,
    silicon: &Account,
    raw: &str,
    caller: Caller<'_>,
) -> ApiResult<Value> {
    let id = Uuid::parse_str(raw.trim()).map_err(|_| delivery_not_found(raw, silicon, caller))?;
    let row = sqlx::query_as::<_, DeliveryRow>(concat!(delivery_select!(), "and d.id = $2"))
        .bind(&silicon.uuid)
        .bind(id)
        .fetch_optional(&mut *conn)
        .await?
        .ok_or_else(|| delivery_not_found(raw, silicon, caller))?;
    let payload: Value =
        sqlx::query_scalar("select payload from webhook_events where event_id = $1")
            .bind(row.event_id)
            .fetch_one(&mut *conn)
            .await?;
    let attempts = sqlx::query_as::<_, AttemptRow>(
        "select attempted_at, status_code, error, duration_ms from webhook_attempts \
         where delivery_id = $1 order by attempted_at, id",
    )
    .bind(id)
    .fetch_all(&mut *conn)
    .await?;
    let mut view = row.view();
    if let Some(obj) = view.as_object_mut() {
        obj.insert("attempt_count".into(), json!(row.attempts));
        obj.insert(
            "attempts".into(),
            Value::Array(
                attempts
                    .into_iter()
                    .map(|a| {
                        json!({
                            "attempted_at": format_rfc3339_ms(a.attempted_at),
                            "status_code": a.status_code,
                            "error": a.error,
                            "duration_ms": a.duration_ms,
                        })
                    })
                    .collect(),
            ),
        );
        obj.insert("payload".into(), payload);
        obj.insert("payload_redacted".into(), Value::Bool(false));
    }
    Ok(view)
}

// ---- replay -----------------------------------------------------------------------------------

/// Which deliveries a replay request names.
#[derive(Debug, Clone, PartialEq, Eq)]
enum ReplaySelection {
    Ids(Vec<Uuid>),
    Failed { since: Option<OffsetDateTime> },
}

fn parse_replay(body: &ReplayBody) -> ApiResult<ReplaySelection> {
    let mut f = FieldErrors::new();
    match (&body.delivery_ids, &body.status) {
        (Some(_), Some(_)) => {
            f.add(
                "delivery_ids",
                "send either delivery_ids or status, not both",
            );
        }
        (None, None) => {
            f.add(
                "delivery_ids",
                "is required (or send {\"status\":\"failed\"} to replay failed deliveries)",
            );
        }
        (Some(ids), None) => {
            if body.since.is_some() {
                f.add("since", "only works together with status");
            }
            if ids.is_empty() {
                f.add("delivery_ids", "must name at least one delivery id");
            } else if ids.len() > MAX_REPLAY {
                f.add(
                    "delivery_ids",
                    format!(
                        "names {} deliveries; at most {MAX_REPLAY} can be replayed per request",
                        ids.len()
                    ),
                );
            }
            let mut out = Vec::with_capacity(ids.len());
            for (i, id) in ids.iter().enumerate() {
                match Uuid::parse_str(id.trim()) {
                    Ok(u) => {
                        if !out.contains(&u) {
                            out.push(u);
                        }
                    }
                    Err(_) => f.add(
                        format!("delivery_ids[{i}]"),
                        format!("'{id}' is not a delivery id"),
                    ),
                }
            }
            f.into_result()?;
            return Ok(ReplaySelection::Ids(out));
        }
        (None, Some(status)) => {
            if status != "failed" {
                f.add(
                    "status",
                    format!(
                        "is '{status}'; only failed deliveries can be replayed by status (name delivered ones by id)"
                    ),
                );
            }
            let since = match body.since.as_deref() {
                Some(s) => match parse_rfc3339(s) {
                    Ok(t) => Some(t),
                    Err(m) => {
                        f.add("since", m);
                        None
                    }
                },
                None => None,
            };
            f.into_result()?;
            return Ok(ReplaySelection::Failed { since });
        }
    }
    Err(ApiError::validation(f))
}

/// 409 `webhook_not_set`: nowhere to send a replay.
fn webhook_not_set(silicon: &Account, caller: Caller<'_>) -> ApiError {
    ApiError::conflict(
        "webhook_not_set",
        format!(
            "{} has no webhook, so there is nowhere to send replayed deliveries.",
            silicon.display_id()
        ),
    )
    .hint(format!(
        "Set one first with PUT {} {{\"url\": \"https://…\"}}, then replay: deliveries go to the current URL, signed with the current secret.",
        caller.webhook_path(silicon)
    ))
}

/// A delivery of the Silicon `$1` that a replay may re-queue, row-locked by the query using it.
macro_rules! candidate_select {
    () => {
        "select d.id, d.event_id, e.type as event_type, d.status, e.identity_migrated_at is not null as identity_migrated \
         from webhook_deliveries d join webhook_events e on e.event_id = d.event_id \
         where d.target_kind = 'silicon' and d.target_id = $1 "
    };
}

/// A delivery a replay request named (or picked by status).
#[derive(Debug, sqlx::FromRow)]
struct Candidate {
    identity_migrated: bool,
    id: Uuid,
    event_id: Uuid,
    event_type: String,
    status: String,
}

/// Re-queues the selected deliveries of `silicon` (its row locked by the caller, so its
/// `webhook_url` is current) and records the replay in the history of the Silicon and of the
/// custodian who asked. See the module docs for the rules and the answer.
async fn replay(
    conn: &mut PgConnection,
    silicon: &Account,
    selection: &ReplaySelection,
    actor: Actor<'_>,
    caller: Caller<'_>,
) -> ApiResult<Value> {
    let url = silicon
        .webhook_url
        .clone()
        .ok_or_else(|| webhook_not_set(silicon, caller))?;
    let (candidates, requested): (Vec<Candidate>, Vec<Uuid>) = match selection {
        ReplaySelection::Ids(ids) => {
            let rows = sqlx::query_as::<_, Candidate>(concat!(
                candidate_select!(),
                "and d.id = any($2) for update of d"
            ))
            .bind(&silicon.uuid)
            .bind(ids)
            .fetch_all(&mut *conn)
            .await?;
            (rows, ids.clone())
        }
        ReplaySelection::Failed { since } => {
            // Oldest first (the Silicon should see replayed events in the order they happened);
            // test pings are never picked, so they can't take the places of real events.
            let rows = sqlx::query_as::<_, Candidate>(concat!(
                candidate_select!(),
                "and d.status = 'failed' and ($2::timestamptz is null or d.created_at >= $2) \
                 and e.type <> 'ping' and e.identity_migrated_at is null order by d.created_at, d.id limit $3 for update of d"
            ))
            .bind(&silicon.uuid)
            .bind(since)
            .bind(MAX_REPLAY as i64)
            .fetch_all(&mut *conn)
            .await?;
            let ids = rows.iter().map(|r| r.id).collect();
            (rows, ids)
        }
    };

    let mut replayed: Vec<Uuid> = Vec::new();
    let mut skipped: Vec<Value> = Vec::new();
    let mut pings = 0i64;
    for id in &requested {
        let Some(c) = candidates.iter().find(|c| c.id == *id) else {
            skipped.push(json!({
                "delivery_id": id, "reason": "not_found",
                "message": format!("No webhook delivery '{id}' exists for the Silicon {}.", silicon.display_id()),
            }));
            continue;
        };
        if c.identity_migrated {
            pings += 1;
            skipped.push(json!({"delivery_id":c.id,"event_id":c.event_id,"reason":"account_uuid_migrated",
                "message":"This historical event was superseded by fresh account state during UUID migration."}));
            continue;
        }
        if c.status == "pending" {
            skipped.push(json!({
                "delivery_id": c.id, "event_id": c.event_id, "type": c.event_type, "reason": "already_pending",
                "message": "This delivery is still pending; the worker is already retrying it.",
            }));
            continue;
        }
        if c.event_type == types::PING {
            pings += 1;
            skipped.push(json!({
                "delivery_id": c.id, "event_id": c.event_id, "type": c.event_type, "reason": "test_ping",
                "message": format!(
                    "Test pings are not replayed (that would get around the limit of {} test pings an hour); send a new one with POST /v1/me/webhook/test.",
                    WEBHOOK_TESTS_PER_SILICON.max
                ),
            }));
            continue;
        }
        replayed.push(c.id);
    }

    if !replayed.is_empty() {
        sqlx::query(
            "update webhook_deliveries set status = 'pending', attempts = 0, next_attempt_at = now(), \
             locked_until = null, delivered_at = null, manual_replays = manual_replays + 1, url = $3, \
             requeued_at = now() \
             where target_kind = 'silicon' and target_id = $1 and id = any($2)",
        )
        .bind(&silicon.uuid)
        .bind(&replayed)
        .bind(&url)
        .execute(&mut *conn)
        .await?;
    }
    // What is left after this call: failed deliveries a replay would still send (call again),
    // and failed test pings, which are never sent again.
    let (remaining, not_replayable) = match selection {
        ReplaySelection::Ids(_) => (0, pings),
        ReplaySelection::Failed { since } => {
            sqlx::query_as::<_, (i64, i64)>(
                "select count(*) filter (where e.type <> 'ping' and e.identity_migrated_at is null), count(*) filter (where e.type = 'ping' or e.identity_migrated_at is not null) \
                 from webhook_deliveries d join webhook_events e on e.event_id = d.event_id \
                 where d.target_kind = 'silicon' and d.target_id = $1 and d.status = 'failed' \
                   and ($2::timestamptz is null or d.created_at >= $2)",
            )
            .bind(&silicon.uuid)
            .bind(since)
            .fetch_one(&mut *conn)
            .await?
        }
    };
    let custodian = match caller {
        Caller::Silicon => None,
        Caller::Custodian { carbon_uuid } => Some(carbon_uuid),
    };
    actor
        .record_for(
            conn,
            "silicon.webhook.replayed",
            &[Some(&silicon.uuid), custodian],
            &silicon.uuid,
            json!({"replayed": replayed.len(), "skipped": skipped.len(),
                   "not_replayable": not_replayable, "by": caller.label()}),
        )
        .await?;
    tracing::info!(silicon = %silicon.uuid, replayed = replayed.len(), skipped = skipped.len(), by = caller.label(), "Silicon webhook deliveries replayed");
    Ok(json!({
        "replayed": replayed,
        "skipped": skipped,
        "remaining": remaining,
        "not_replayable": not_replayable,
        "url": url,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(v: Value) -> ApiResult<ReplaySelection> {
        parse_replay(&serde_json::from_value(v).expect("shape"))
    }

    #[test]
    fn replay_bodies_follow_the_app_rules() {
        assert_eq!(
            parse(json!({"status": "failed"})).expect("ok"),
            ReplaySelection::Failed { since: None }
        );
        assert!(matches!(
            parse(json!({"status": "failed", "since": "2026-10-01T00:00:00Z"})),
            Ok(ReplaySelection::Failed { since: Some(_) })
        ));
        let id = Uuid::now_v7();
        assert_eq!(
            parse(json!({"delivery_ids": [id.to_string(), format!(" {id} ")]})).expect("ok"),
            ReplaySelection::Ids(vec![id]),
            "duplicates collapse"
        );
        for bad in [
            json!({}),
            json!({"delivery_ids": []}),
            json!({"delivery_ids": ["nope"]}),
            json!({"delivery_ids": [id.to_string()], "since": "2026-10-01T00:00:00Z"}),
            json!({"status": "delivered"}),
            json!({"status": "failed", "since": "yesterday"}),
            json!({"status": "failed", "delivery_ids": [id.to_string()]}),
        ] {
            let e = parse(bad.clone())
                .err()
                .unwrap_or_else(|| panic!("{bad} should be refused"));
            assert_eq!(e.code, "validation_failed", "{bad}");
        }
        let many: Vec<String> = (0..=MAX_REPLAY)
            .map(|_| Uuid::now_v7().to_string())
            .collect();
        assert!(parse(json!({"delivery_ids": many})).is_err());
        assert!(
            serde_json::from_value::<ReplayBody>(json!({"ids": []})).is_err(),
            "unknown fields are refused"
        );
    }

    #[test]
    fn list_filters_are_precise() {
        assert_eq!(parse_status(None).expect("none"), None);
        assert_eq!(parse_status(Some(" ")).expect("blank"), None);
        assert_eq!(parse_status(Some("failed")).expect("ok"), Some("failed"));
        let e = parse_status(Some("lost")).expect_err("refused");
        assert_eq!(e.code, "invalid_query");
        assert!(e.message.contains("'lost'"));
    }

    #[test]
    fn cursor_times_round_trip() {
        let t = OffsetDateTime::from_unix_timestamp_nanos(1_759_752_000_123_456_000).expect("time");
        assert_eq!(from_micros(micros(t)).expect("back"), t);
    }
}
