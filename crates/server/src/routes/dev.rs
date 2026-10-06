//! `GET /v1/dev/outbox`: the messages this service recorded (local delivery mode stores them
//! instead of sending), newest first, with the 6-digit code parsed out of verification-code
//! messages so tests and local development can sign in without a mailbox.
//!
//! Served only when ACCOUNTS_EXPOSE_DEV_OUTBOX=true and the environment is not production. In
//! production the route answers exactly like a route that does not exist.

use accounts_core::http::{Json, Query};
use accounts_core::models::MessageChannel;
use accounts_core::{ApiError, AppState, delivery, timefmt};
use axum::extract::State;
use axum::http::Method;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::routes::fallback::route_not_found;

/// Query: `?to=&purpose=&limit=` (limit 1..200, default 50).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct OutboxQuery {
    /// Exact address (email or E.164 phone), case-insensitive.
    pub to: Option<String>,
    /// Exact purpose, e.g. `otp_signin`, `custodian_request`, `report`.
    pub purpose: Option<String>,
    pub limit: Option<i64>,
}

#[derive(Debug, sqlx::FromRow)]
struct OutboxRow {
    id: Uuid,
    channel: MessageChannel,
    to_address: String,
    subject: Option<String>,
    text_body: String,
    purpose: String,
    status: String,
    attempts: i32,
    last_error: Option<String>,
    created_at: OffsetDateTime,
    sent_at: Option<OffsetDateTime>,
}

/// One message in the outbox.
#[derive(Debug, Clone, Serialize)]
pub struct OutboxItem {
    pub id: Uuid,
    pub channel: MessageChannel,
    pub to: String,
    pub subject: Option<String>,
    pub text_body: String,
    pub purpose: String,
    /// `local` | `pending` | `sent` | `failed`.
    pub status: String,
    pub attempts: i32,
    pub last_error: Option<String>,
    #[serde(with = "timefmt::rfc3339_ms")]
    pub created_at: OffsetDateTime,
    #[serde(with = "timefmt::rfc3339_ms_option")]
    pub sent_at: Option<OffsetDateTime>,
    /// The verification code of an OTP message (`purpose` starting with `otp_`), else null.
    pub code: Option<String>,
}

/// `GET /v1/dev/outbox` → `{"items":[…],"next_cursor":null}`.
pub async fn outbox(
    State(state): State<AppState>,
    Query(q): Query<OutboxQuery>,
) -> Result<Json<Value>, ApiError> {
    if state.settings.environment.is_production() {
        return Err(route_not_found(&Method::GET, "/v1/dev/outbox"));
    }
    if !state.settings.dev_outbox_enabled() {
        return Err(ApiError::not_found(
            "dev_outbox_disabled",
            "The dev outbox is turned off on this server, so recorded messages can't be listed.",
        )
        .hint("Start the service with ACCOUNTS_EXPOSE_DEV_OUTBOX=true (development and test only; production refuses it)."));
    }
    let limit = q.limit.unwrap_or(50).clamp(1, 200);
    let to = q.to.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let purpose = q
        .purpose
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let rows = sqlx::query_as::<_, OutboxRow>(
        "select id, channel, to_address, subject, text_body, purpose, status, attempts, last_error, created_at, sent_at \
         from outbound_messages \
         where ($1::text is null or lower(to_address) = lower($1)) and ($2::text is null or purpose = $2) \
         order by created_at desc, id desc limit $3",
    )
    .bind(to)
    .bind(purpose)
    .bind(limit)
    .fetch_all(&state.db)
    .await?;
    let items: Vec<OutboxItem> = rows
        .into_iter()
        .map(|r| OutboxItem {
            code: if r.purpose.starts_with("otp_") {
                delivery::extract_code(&r.text_body)
            } else {
                None
            },
            id: r.id,
            channel: r.channel,
            to: r.to_address,
            subject: r.subject,
            text_body: r.text_body,
            purpose: r.purpose,
            status: r.status,
            attempts: r.attempts,
            last_error: r.last_error,
            created_at: r.created_at,
            sent_at: r.sent_at,
        })
        .collect();
    Ok(Json(json!({ "items": items, "next_cursor": null })))
}
