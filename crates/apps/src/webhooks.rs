//! The app's webhook (app or owner):
//!
//! - `PUT /v1/apps/{app_id}/webhook` `{"url"}` → `{"url","secret"}`: a new signing secret every
//!   time the URL is set (shown once).
//! - `DELETE /v1/apps/{app_id}/webhook` → 204. Pending deliveries become `failed` (replayable
//!   once a new URL is set).
//! - `POST /v1/apps/{app_id}/webhook/rotate-secret` → `{"secret"}`.
//! - `POST /v1/apps/{app_id}/webhook/test` → enqueues a `ping` → `{"event_id","delivery_id"}`.
//! - `GET /v1/apps/{app_id}/webhook/deliveries?status&limit&cursor`, `GET …/deliveries/{id}`
//!   (+ attempts + the payload, `payload_redacted` when the app may no longer see it).
//! - `POST /v1/apps/{app_id}/webhook/replay` (Idempotency-Key) `{"delivery_ids":[…]}` or
//!   `{"status":"failed","since":"…"}` (max 100): re-queues with attempts 0, manual_replays+1
//!   and `requeued_at` = now (a fresh 72 h of retries from the replay), keeping the event id and
//!   payload; the worker sends it to the CURRENT url signed with the CURRENT secret. Response `{"replayed":[ids],"skipped":[{delivery_id,reason,message}],
//!   "remaining","not_replayable","url"}`.
//!
//! Account data and lost access (one rule, [`DataAccess`]): a delivery whose payload carries
//! account data is only replayed — and its payload only shown — while the account has a live
//! membership with the app (`active` or `imported`) and is not deleted. Otherwise replay skips
//! it (`membership_inactive` / `account_deleted`) and the detail shows `data` cut down to
//! `{uuid, membership_id}`. Notices that the relationship ended (`membership.access_removed`,
//! `membership.signed_out`, `account.deleted`) and `ping` carry no account data and are always
//! replayable. Replay by status picks only replayable deliveries (oldest first), so withheld
//! ones never block newer ones; `remaining` counts replayable failed deliveries still waiting
//! (call again until it is 0) and `not_replayable` the failed ones that will never be sent.
//!
//! Delivery itself (signing, retries) belongs to the worker crate.

use accounts_core::events::{self, types};
use accounts_core::http::pagination::paginate;
use accounts_core::http::{AppOrOwner, ClientMeta, IdempotencyKey, Json, Path, Query};
use accounts_core::normalize::validate_webhook_url;
use accounts_core::repo::{audit, idempotency};
use accounts_core::{ApiError, ApiResult, AppState, FieldErrors};
use axum::Router;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::signin_config::ensure_config_row;
use crate::util::{caller_scope, from_micros, micros};

/// Most deliveries one replay request re-queues.
pub const MAX_REPLAY: usize = 100;

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/v1/apps/{app_id}/webhook",
            put(set_webhook).delete(remove_webhook),
        )
        .route(
            "/v1/apps/{app_id}/webhook/rotate-secret",
            post(rotate_secret),
        )
        .route("/v1/apps/{app_id}/webhook/test", post(test_webhook))
        .route("/v1/apps/{app_id}/webhook/deliveries", get(list_deliveries))
        .route(
            "/v1/apps/{app_id}/webhook/deliveries/{delivery_id}",
            get(get_delivery),
        )
        .route("/v1/apps/{app_id}/webhook/replay", post(replay))
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct SetWebhook {
    url: String,
}

fn webhook_not_set(app_id: &str) -> ApiError {
    ApiError::conflict(
        "webhook_not_set",
        format!("The app '{app_id}' has no webhook URL, so there is nowhere to send events."),
    )
    .hint("Set one first with PUT /v1/apps/{app_id}/webhook {\"url\":\"https://…\"}.")
}

async fn current_webhook(conn: &mut sqlx::PgConnection, app_id: &str) -> ApiResult<Option<String>> {
    Ok(accounts_core::repo::apps::webhook_target(conn, app_id)
        .await?
        .map(|(url, _)| url))
}

async fn set_webhook(
    State(state): State<AppState>,
    auth: AppOrOwner,
    meta: ClientMeta,
    key: Option<IdempotencyKey>,
    Json(body): Json<SetWebhook>,
) -> ApiResult<Response> {
    let app_id = auth.app.app_id.clone();
    let scope = idempotency::scope(
        &caller_scope(&auth),
        "PUT",
        &format!("/v1/apps/{app_id}/webhook"),
    );
    // The response carries a fresh secret: a retry with the same key gets the same secret for
    // 10 minutes instead of rotating it again.
    let mut r = idempotency::run(&state, key.as_deref(), &scope, &body, true, || async {
        let url = validate_webhook_url(&state.settings, &body.url).map_err(|m| {
            let mut f = FieldErrors::new();
            f.add("url", m);
            ApiError::validation(f)
        })?;
        let url = url.to_string();
        let (secret, enc) = events::new_webhook_secret(&state.keys.keyring)?;
        let mut tx = state.db.begin().await?;
        ensure_config_row(&mut tx, &app_id).await?;
        let previous: Option<String> = sqlx::query_scalar(
            "select webhook_url from app_signin_configs where app_id = $1 for update",
        )
        .bind(&app_id)
        .fetch_one(&mut *tx)
        .await?;
        sqlx::query(
            "update app_signin_configs set webhook_url = $2, webhook_secret_enc = $3, updated_at = now() where app_id = $1",
        )
        .bind(&app_id)
        .bind(&url)
        .bind(&enc)
        .execute(&mut *tx)
        .await?;
        let (actor_kind, actor_id) = auth.audit_actor();
        audit::record(
            &mut tx,
            &audit::AuditEntry {
                target_kind: Some("app"),
                target_id: Some(&app_id),
                app_id: Some(&app_id),
                details: json!({"url": url, "previous_url": previous}),
                ip: meta.ip.as_deref(),
                ..audit::AuditEntry::new(actor_kind, Some(&actor_id), "app.webhook.set")
            },
        )
        .await?;
        tx.commit().await?;
        Ok((StatusCode::OK, json!({"url": url, "secret": secret})))
    })
    .await?;
    no_store(&mut r);
    Ok(r)
}

fn no_store(r: &mut Response) {
    r.headers_mut().insert(
        axum::http::header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("no-store"),
    );
}

async fn remove_webhook(
    State(state): State<AppState>,
    auth: AppOrOwner,
    meta: ClientMeta,
) -> ApiResult<Response> {
    let app_id = auth.app.app_id.as_str();
    let mut tx = state.db.begin().await?;
    let previous: Option<Option<String>> = sqlx::query_scalar(
        "select webhook_url from app_signin_configs where app_id = $1 for update",
    )
    .bind(app_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(Some(previous)) = previous else {
        // Already gone: deleting is idempotent.
        tx.commit().await?;
        return Ok(StatusCode::NO_CONTENT.into_response());
    };
    sqlx::query(
        "update app_signin_configs set webhook_url = null, webhook_secret_enc = null, updated_at = now() where app_id = $1",
    )
    .bind(app_id)
    .execute(&mut *tx)
    .await?;
    // Nothing can be delivered without a URL: fail what is pending now, so it shows up as
    // replayable instead of waiting out the 72 h retry window.
    let failed = sqlx::query(
        "update webhook_deliveries set status = 'failed', locked_until = null, \
         last_error = 'The app removed its webhook URL before this event could be delivered; replay it after setting a new URL.' \
         where target_kind = 'app' and target_id = $1 and status = 'pending'",
    )
    .bind(app_id)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    let (actor_kind, actor_id) = auth.audit_actor();
    audit::record(
        &mut tx,
        &audit::AuditEntry {
            target_kind: Some("app"),
            target_id: Some(app_id),
            app_id: Some(app_id),
            details: json!({"previous_url": previous, "pending_deliveries_failed": failed}),
            ip: meta.ip.as_deref(),
            ..audit::AuditEntry::new(actor_kind, Some(&actor_id), "app.webhook.removed")
        },
    )
    .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn rotate_secret(
    State(state): State<AppState>,
    auth: AppOrOwner,
    meta: ClientMeta,
    key: Option<IdempotencyKey>,
) -> ApiResult<Response> {
    let app_id = auth.app.app_id.clone();
    let scope = idempotency::scope(
        &caller_scope(&auth),
        "POST",
        &format!("/v1/apps/{app_id}/webhook/rotate-secret"),
    );
    let mut r = idempotency::run(&state, key.as_deref(), &scope, &json!({}), true, || async {
        let (secret, enc) = events::new_webhook_secret(&state.keys.keyring)?;
        let mut tx = state.db.begin().await?;
        let url: Option<Option<String>> = sqlx::query_scalar(
            "select webhook_url from app_signin_configs where app_id = $1 for update",
        )
        .bind(&app_id)
        .fetch_optional(&mut *tx)
        .await?;
        if !matches!(url, Some(Some(_))) {
            return Err(webhook_not_set(&app_id));
        }
        sqlx::query(
            "update app_signin_configs set webhook_secret_enc = $2, updated_at = now() where app_id = $1",
        )
        .bind(&app_id)
        .bind(&enc)
        .execute(&mut *tx)
        .await?;
        let (actor_kind, actor_id) = auth.audit_actor();
        audit::record(
            &mut tx,
            &audit::AuditEntry {
                target_kind: Some("app"),
                target_id: Some(&app_id),
                app_id: Some(&app_id),
                ip: meta.ip.as_deref(),
                ..audit::AuditEntry::new(actor_kind, Some(&actor_id), "app.webhook.secret_rotated")
            },
        )
        .await?;
        tx.commit().await?;
        Ok((StatusCode::OK, json!({"secret": secret})))
    })
    .await?;
    no_store(&mut r);
    Ok(r)
}

async fn test_webhook(
    State(state): State<AppState>,
    auth: AppOrOwner,
    key: Option<IdempotencyKey>,
) -> ApiResult<Response> {
    let app_id = auth.app.app_id.clone();
    let scope = idempotency::scope(
        &caller_scope(&auth),
        "POST",
        &format!("/v1/apps/{app_id}/webhook/test"),
    );
    idempotency::run(&state, key.as_deref(), &scope, &json!({}), false, || async {
        let mut tx = state.db.begin().await?;
        let emitted = events::ping_app(&mut tx, &app_id)
            .await?
            .ok_or_else(|| webhook_not_set(&app_id))?;
        tx.commit().await?;
        Ok((
            StatusCode::ACCEPTED,
            json!({"event_id": emitted.event_id, "delivery_id": emitted.delivery_id, "type": types::PING}),
        ))
    })
    .await
}

#[derive(Debug, Default, Deserialize)]
struct DeliveriesQuery {
    status: Option<String>,
    limit: Option<i64>,
    cursor: Option<String>,
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

const DELIVERY_SELECT: &str = "select d.id, d.event_id, e.type as event_type, e.account_uuid, d.url, d.status, \
     d.attempts, d.last_status, d.last_error, d.next_attempt_at, d.last_attempt_at, d.delivered_at, d.created_at, \
     d.manual_replays from webhook_deliveries d join webhook_events e on e.event_id = d.event_id ";

impl DeliveryRow {
    fn view(&self) -> Value {
        let ts = |t: Option<OffsetDateTime>| t.map(accounts_core::timefmt::format_rfc3339_ms);
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
            // Only pending deliveries have a next attempt.
            "next_attempt_at": ts((self.status == "pending").then_some(self.next_attempt_at)),
            "last_attempt_at": ts(self.last_attempt_at),
            "delivered_at": ts(self.delivered_at),
            "created_at": accounts_core::timefmt::format_rfc3339_ms(self.created_at),
            "manual_replays": self.manual_replays,
        })
    }
}

fn parse_delivery_status(param: &str, v: Option<&str>) -> ApiResult<Option<&'static str>> {
    crate::util::parse_choice(
        param,
        v,
        |s| match s {
            "pending" => Some("pending"),
            "delivered" => Some("delivered"),
            "failed" => Some("failed"),
            _ => None,
        },
        "pending, delivered, failed",
    )
}

async fn list_deliveries(
    State(state): State<AppState>,
    auth: AppOrOwner,
    Query(q): Query<DeliveriesQuery>,
) -> ApiResult<Response> {
    let status = parse_delivery_status("status", q.status.as_deref())?;
    let params = accounts_core::http::PageParams {
        limit: q.limit,
        cursor: q.cursor,
    };
    let limit = params.limit();
    let (after_ts, after_id) = match params.cursor::<(i64, Uuid)>()? {
        Some((us, id)) => (Some(from_micros(us)?), Some(id)),
        None => (None, None),
    };
    let sql = format!(
        "{DELIVERY_SELECT} where d.target_kind = 'app' and d.target_id = $1 \
           and ($2::text is null or d.status = $2) \
           and ($3::timestamptz is null or (d.created_at, d.id) < ($3, $4)) \
         order by d.created_at desc, d.id desc limit $5"
    );
    let mut conn = state.db.acquire().await?;
    let rows = sqlx::query_as::<_, DeliveryRow>(sqlx::AssertSqlSafe(sql))
        .bind(&auth.app.app_id)
        .bind(status)
        .bind(after_ts)
        .bind(after_id)
        .bind(limit + 1)
        .fetch_all(&mut *conn)
        .await?;
    let page = paginate(rows, limit, |r| (micros(r.created_at), r.id));
    let items: Vec<Value> = page.items.iter().map(DeliveryRow::view).collect();
    Ok(axum::Json(json!({"items": items, "next_cursor": page.next_cursor})).into_response())
}

fn delivery_not_found(id: &str, app_id: &str) -> ApiError {
    ApiError::not_found(
        "delivery_not_found",
        format!("No webhook delivery '{id}' exists for the app '{app_id}'."),
    )
    .hint("List deliveries with GET /v1/apps/{app_id}/webhook/deliveries to find delivery ids.")
}

#[derive(Debug, sqlx::FromRow)]
struct AttemptRow {
    attempted_at: OffsetDateTime,
    status_code: Option<i32>,
    error: Option<String>,
    duration_ms: i32,
}

async fn get_delivery(
    State(state): State<AppState>,
    auth: AppOrOwner,
    Path((_app_id, delivery_id)): Path<(String, String)>,
) -> ApiResult<Response> {
    let app_id = auth.app.app_id.as_str();
    let id = Uuid::parse_str(delivery_id.trim())
        .map_err(|_| delivery_not_found(&delivery_id, app_id))?;
    let mut conn = state.db.acquire().await?;
    let sql =
        format!("{DELIVERY_SELECT} where d.id = $1 and d.target_kind = 'app' and d.target_id = $2");
    let row = sqlx::query_as::<_, DeliveryRow>(sqlx::AssertSqlSafe(sql))
        .bind(id)
        .bind(app_id)
        .fetch_optional(&mut *conn)
        .await?
        .ok_or_else(|| delivery_not_found(&delivery_id, app_id))?;
    let payload: Value =
        sqlx::query_scalar("select payload from webhook_events where event_id = $1")
            .bind(row.event_id)
            .fetch_one(&mut *conn)
            .await?;
    let (membership_status, account_status): (Option<String>, Option<String>) =
        match &row.account_uuid {
            Some(uuid) => sqlx::query_as(
                "select (select status from memberships where app_id = $1 and account_uuid = $2), \
                        (select status from accounts where uuid = $2)",
            )
            .bind(app_id)
            .bind(uuid)
            .fetch_one(&mut *conn)
            .await?,
            None => (None, None),
        };
    let access = DataAccess::of(
        &row.event_type,
        row.account_uuid.as_deref(),
        membership_status.as_deref(),
        account_status.as_deref(),
    );
    let payload = match (&row.account_uuid, access) {
        (Some(uuid), a) if a != DataAccess::Allowed => redact(payload, app_id, uuid),
        _ => payload,
    };
    let attempts = sqlx::query_as::<_, AttemptRow>(
        "select attempted_at, status_code, error, duration_ms from webhook_attempts where delivery_id = $1 \
         order by attempted_at, id",
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
                            "attempted_at": accounts_core::timefmt::format_rfc3339_ms(a.attempted_at),
                            "status_code": a.status_code,
                            "error": a.error,
                            "duration_ms": a.duration_ms,
                        })
                    })
                    .collect(),
            ),
        );
        obj.insert("payload".into(), payload);
        obj.insert(
            "payload_redacted".into(),
            Value::Bool(access != DataAccess::Allowed),
        );
        if access != DataAccess::Allowed {
            obj.insert(
                "payload_redacted_reason".into(),
                Value::String(format!(
                    "Only who it was about is shown because {}: an app that lost access to an account no longer sees its data, and this delivery can't be replayed.",
                    access.why()
                )),
            );
        }
    }
    Ok(axum::Json(view).into_response())
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ReplayBody {
    #[serde(default)]
    delivery_ids: Option<Vec<String>>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    since: Option<String>,
}

/// Event types whose payload carries no account data: telling an app that its relationship
/// with an account ended (or a test ping) is always allowed.
const NO_ACCOUNT_DATA: [&str; 4] = [
    types::PING,
    types::MEMBERSHIP_ACCESS_REMOVED,
    types::MEMBERSHIP_SIGNED_OUT,
    types::ACCOUNT_DELETED,
];

fn replayable_without_membership(event_type: &str) -> bool {
    NO_ACCOUNT_DATA.contains(&event_type)
}

/// Whether an app may (still) receive the account data a delivery carries.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DataAccess {
    /// No account data in it, or the account is a live member that isn't deleted.
    Allowed,
    /// The account removed the app's access.
    AccessRemoved,
    /// The account has no membership with the app.
    NoMembership,
    /// The account was deleted.
    AccountDeleted,
}

impl DataAccess {
    /// The rule, from the event and the account's current membership and status.
    pub fn of(
        event_type: &str,
        account_uuid: Option<&str>,
        membership_status: Option<&str>,
        account_status: Option<&str>,
    ) -> DataAccess {
        if account_uuid.is_none() || replayable_without_membership(event_type) {
            return DataAccess::Allowed;
        }
        // A missing account row counts as deleted.
        if matches!(account_status, None | Some("deleted")) {
            return DataAccess::AccountDeleted;
        }
        match membership_status {
            Some("active" | "imported") => DataAccess::Allowed,
            Some("access_removed") => DataAccess::AccessRemoved,
            _ => DataAccess::NoMembership,
        }
    }

    /// The replay skip reason.
    pub fn reason(self) -> &'static str {
        match self {
            DataAccess::AccountDeleted => "account_deleted",
            _ => "membership_inactive",
        }
    }

    fn why(self) -> &'static str {
        match self {
            DataAccess::Allowed => "the account is a member",
            DataAccess::AccessRemoved => "the account removed this app's access",
            DataAccess::NoMembership => "the account has no membership with this app any more",
            DataAccess::AccountDeleted => "the account was deleted",
        }
    }
}

/// [`DataAccess::of`] as SQL over `e` (webhook_events), `m` (the membership, left joined) and
/// `a` (the account, left joined): true when the delivery may be sent.
fn replayable_sql() -> String {
    let types = NO_ACCOUNT_DATA
        .iter()
        .map(|t| format!("'{t}'"))
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "coalesce(e.account_uuid is null or e.type in ({types}) \
           or (m.status in ('active', 'imported') and a.status <> 'deleted'), false)"
    )
}

/// The payload of a delivery the app may no longer see: `data` cut down to who it was about.
fn redact(mut payload: Value, app_id: &str, uuid: &str) -> Value {
    if let Some(obj) = payload.as_object_mut() {
        obj.insert(
            "data".into(),
            json!({"uuid": uuid, "membership_id": format!("{app_id}:{uuid}")}),
        );
    }
    payload
}

async fn replay(
    State(state): State<AppState>,
    auth: AppOrOwner,
    meta: ClientMeta,
    key: Option<IdempotencyKey>,
    Json(body): Json<ReplayBody>,
) -> ApiResult<Response> {
    let app_id = auth.app.app_id.clone();
    let scope = idempotency::scope(
        &caller_scope(&auth),
        "POST",
        &format!("/v1/apps/{app_id}/webhook/replay"),
    );
    idempotency::run(&state, key.as_deref(), &scope, &body, false, || async {
        let result = run_replay(&state, &auth, &body, meta.ip.as_deref()).await?;
        Ok((StatusCode::OK, result))
    })
    .await
}

/// Which deliveries a replay request names.
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
                    format!("is '{status}'; only failed deliveries can be replayed by status (name delivered ones by id)"),
                );
            }
            let since = match body.since.as_deref() {
                Some(s) => match accounts_core::timefmt::parse_rfc3339(s) {
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

#[derive(Debug, sqlx::FromRow)]
struct ReplayCandidate {
    id: Uuid,
    event_id: Uuid,
    event_type: String,
    account_uuid: Option<String>,
    status: String,
    membership_status: Option<String>,
    account_status: Option<String>,
}

async fn run_replay(
    state: &AppState,
    auth: &AppOrOwner,
    body: &ReplayBody,
    ip: Option<&str>,
) -> ApiResult<Value> {
    let app_id = auth.app.app_id.as_str();
    let selection = parse_replay(body)?;
    let mut tx = state.db.begin().await?;
    let url = current_webhook(&mut tx, app_id)
        .await?
        .ok_or_else(|| webhook_not_set(app_id))?;
    const CANDIDATES: &str = "select d.id, d.event_id, e.type as event_type, e.account_uuid, d.status, \
           m.status as membership_status, a.status as account_status \
         from webhook_deliveries d join webhook_events e on e.event_id = d.event_id \
         left join memberships m on m.app_id = d.target_id and m.account_uuid = e.account_uuid \
         left join accounts a on a.uuid = e.account_uuid \
         where d.target_kind = 'app' and d.target_id = $1 ";
    let replayable = replayable_sql();
    let (candidates, requested): (Vec<ReplayCandidate>, Vec<Uuid>) = match &selection {
        ReplaySelection::Ids(ids) => {
            let sql = format!("{CANDIDATES} and d.id = any($2) for update of d");
            let rows = sqlx::query_as::<_, ReplayCandidate>(sqlx::AssertSqlSafe(sql))
                .bind(app_id)
                .bind(ids)
                .fetch_all(&mut *tx)
                .await?;
            (rows, ids.clone())
        }
        ReplaySelection::Failed { since } => {
            // Only replayable ones (oldest first: apps should see replayed events in the order
            // they happened), so withheld deliveries never take the places of newer ones.
            let sql = format!(
                "{CANDIDATES} and d.status = 'failed' and ($2::timestamptz is null or d.created_at >= $2) \
                 and {replayable} order by d.created_at, d.id limit $3 for update of d"
            );
            let rows = sqlx::query_as::<_, ReplayCandidate>(sqlx::AssertSqlSafe(sql))
                .bind(app_id)
                .bind(since)
                .bind(MAX_REPLAY as i64)
                .fetch_all(&mut *tx)
                .await?;
            let ids = rows.iter().map(|r| r.id).collect();
            (rows, ids)
        }
    };

    let mut replay_ids: Vec<Uuid> = Vec::new();
    let mut skipped: Vec<Value> = Vec::new();
    let mut withheld = 0i64;
    for id in &requested {
        let Some(c) = candidates.iter().find(|c| c.id == *id) else {
            skipped.push(json!({
                "delivery_id": id, "reason": "not_found",
                "message": format!("No webhook delivery '{id}' exists for the app '{app_id}'."),
            }));
            continue;
        };
        if c.status == "pending" {
            skipped.push(json!({
                "delivery_id": c.id, "event_id": c.event_id, "type": c.event_type, "reason": "already_pending",
                "message": "This delivery is still pending; the worker is already retrying it.",
            }));
            continue;
        }
        let access = DataAccess::of(
            &c.event_type,
            c.account_uuid.as_deref(),
            c.membership_status.as_deref(),
            c.account_status.as_deref(),
        );
        if access != DataAccess::Allowed {
            withheld += 1;
            skipped.push(json!({
                "delivery_id": c.id, "event_id": c.event_id, "type": c.event_type, "reason": access.reason(),
                "message": format!("Not replayed because {}; an app that lost access never gets account data replayed.", access.why()),
            }));
            continue;
        }
        replay_ids.push(c.id);
    }

    if !replay_ids.is_empty() {
        sqlx::query(
            "update webhook_deliveries set status = 'pending', attempts = 0, next_attempt_at = now(), \
             locked_until = null, delivered_at = null, manual_replays = manual_replays + 1, url = $3, \
             requeued_at = now() \
             where target_kind = 'app' and target_id = $1 and id = any($2)",
        )
        .bind(app_id)
        .bind(&replay_ids)
        .bind(&url)
        .execute(&mut *tx)
        .await?;
    }
    // What is left after this call: replayable failed deliveries still waiting (call again),
    // and failed ones that will never be sent.
    let (remaining, not_replayable) = match &selection {
        ReplaySelection::Ids(_) => (0, withheld),
        ReplaySelection::Failed { since } => {
            let sql = format!(
                "select count(*) filter (where {replayable}), count(*) filter (where not {replayable}) \
                 from webhook_deliveries d join webhook_events e on e.event_id = d.event_id \
                 left join memberships m on m.app_id = d.target_id and m.account_uuid = e.account_uuid \
                 left join accounts a on a.uuid = e.account_uuid \
                 where d.target_kind = 'app' and d.target_id = $1 and d.status = 'failed' \
                   and ($2::timestamptz is null or d.created_at >= $2)"
            );
            sqlx::query_as::<_, (i64, i64)>(sqlx::AssertSqlSafe(sql))
                .bind(app_id)
                .bind(since)
                .fetch_one(&mut *tx)
                .await?
        }
    };
    let (actor_kind, actor_id) = auth.audit_actor();
    audit::record(
        &mut tx,
        &audit::AuditEntry {
            target_kind: Some("app"),
            target_id: Some(app_id),
            app_id: Some(app_id),
            details: json!({"replayed": replay_ids.len(), "skipped": skipped.len(), "not_replayable": not_replayable}),
            ip,
            ..audit::AuditEntry::new(actor_kind, Some(&actor_id), "app.webhook.replayed")
        },
    )
    .await?;
    tx.commit().await?;
    Ok(json!({
        "replayed": replay_ids,
        "skipped": skipped,
        "remaining": remaining,
        "not_replayable": not_replayable,
        "url": url,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replay_body_rules() {
        let parse = |v: Value| parse_replay(&serde_json::from_value(v).expect("shape"));
        assert!(matches!(
            parse(json!({"status": "failed"})),
            Ok(ReplaySelection::Failed { since: None })
        ));
        assert!(matches!(
            parse(json!({"status": "failed", "since": "2026-10-01T00:00:00Z"})),
            Ok(ReplaySelection::Failed { since: Some(_) })
        ));
        let id = Uuid::now_v7().to_string();
        assert!(
            matches!(parse(json!({"delivery_ids": [id.clone(), id]})), Ok(ReplaySelection::Ids(v)) if v.len() == 1)
        );
        for bad in [
            json!({}),
            json!({"delivery_ids": []}),
            json!({"delivery_ids": ["nope"]}),
            json!({"status": "delivered"}),
            json!({"status": "failed", "since": "yesterday"}),
            json!({"status": "failed", "delivery_ids": []}),
        ] {
            let e = parse(bad.clone())
                .err()
                .unwrap_or_else(|| panic!("{bad} should fail"));
            assert_eq!(e.code, "validation_failed", "{bad}");
        }
        let many: Vec<String> = (0..101).map(|_| Uuid::now_v7().to_string()).collect();
        assert!(parse(json!({"delivery_ids": many})).is_err());
    }

    #[test]
    fn termination_events_replay_without_membership() {
        assert!(replayable_without_membership("membership.access_removed"));
        assert!(replayable_without_membership("ping"));
        assert!(!replayable_without_membership("account.updated"));
        assert!(!replayable_without_membership("account.id_changed"));
    }

    #[test]
    fn data_access_needs_a_live_membership_and_a_live_account() {
        use DataAccess::*;
        let of = DataAccess::of;
        assert_eq!(
            of(
                "account.updated",
                Some("a1"),
                Some("active"),
                Some("active")
            ),
            Allowed
        );
        assert_eq!(
            of(
                "account.updated",
                Some("a1"),
                Some("imported"),
                Some("unclaimed")
            ),
            Allowed
        );
        assert_eq!(
            of(
                "account.updated",
                Some("a1"),
                Some("access_removed"),
                Some("active")
            ),
            AccessRemoved
        );
        assert_eq!(
            of("account.id_changed", Some("a1"), None, Some("active")),
            NoMembership
        );
        assert_eq!(
            of(
                "account.updated",
                Some("a1"),
                Some("active"),
                Some("deleted")
            ),
            AccountDeleted
        );
        assert_eq!(
            of("account.updated", Some("a1"), Some("active"), None),
            AccountDeleted
        );
        assert_eq!(
            of(
                "account.deleted",
                Some("a1"),
                Some("active"),
                Some("deleted")
            ),
            Allowed
        );
        assert_eq!(of("ping", None, None, None), Allowed);
        assert_eq!(AccountDeleted.reason(), "account_deleted");
        assert_eq!(AccessRemoved.reason(), "membership_inactive");
        let p = redact(
            json!({"event_id": "e", "data": {"uuid": "a1", "account": {"email": "x@y.z"}}}),
            "app",
            "a1",
        );
        assert_eq!(
            p,
            json!({"event_id": "e", "data": {"uuid": "a1", "membership_id": "app:a1"}})
        );
    }
}
