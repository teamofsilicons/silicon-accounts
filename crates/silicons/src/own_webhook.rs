//! A Silicon's own webhook, managed by the Silicon itself (`session(silicon)`):
//!
//! - `PUT /v1/me/webhook` `{"url"}` → `{"webhook_url","webhook_secret"}` (a new secret every time)
//! - `DELETE /v1/me/webhook` → 204
//! - `POST /v1/me/webhook/test` → 202 `{"event_id","delivery_id","type","url","superseded_pings"}`
//!   (queues a `ping`)
//!
//! A test ping is a signed POST to a URL the Silicon chose, retried for up to 72 hours while it
//! fails, so the test button must not be a way to aim traffic at someone else's server: a
//! Silicon may queue [`WEBHOOK_TESTS_PER_SILICON`] pings per hour (429 after that), and a new
//! ping supersedes the Silicon's earlier test pings that are still waiting to be retried (they
//! become `failed`), so at most one test ping per Silicon is ever being retried. A new test is
//! attempted right away, so superseding never delays one.
//!
//! The custodian manages the same webhook through `/v1/me/silicons/{uuid}/webhook`.

use accounts_core::error::{ApiError, FieldErrors};
use accounts_core::events::{self, types};
use accounts_core::http::{ClientMeta, Json, SiliconAuth};
use accounts_core::repo::accounts;
use accounts_core::repo::rate_limit::{self, Limit};
use accounts_core::state::AppState;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::common::set_silicon_webhook;
use crate::history::{Actor, url_origin};
use crate::input;

/// Test pings a Silicon may queue per hour (see the module docs).
pub const WEBHOOK_TESTS_PER_SILICON: Limit = Limit::new(10, 3600);

/// `last_error` of a test ping replaced by a newer one.
const SUPERSEDED: &str = "Superseded by a newer test ping (POST /v1/me/webhook/test); only the latest test ping is retried.";

/// `{"url": "https://…"}`.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WebhookBody {
    pub url: String,
}

/// Validates the URL of a [`WebhookBody`] (422 `validation_failed`, field `url`).
pub fn webhook_url(state: &AppState, body: &WebhookBody) -> Result<String, ApiError> {
    match input::webhook_url(&state.settings, Some(&body.url)) {
        Ok(Some(url)) => Ok(url),
        Ok(None) => Err(ApiError::internal(
            "webhook URL validation returned nothing",
        )),
        Err(problem) => {
            let mut fields = FieldErrors::new();
            fields.add("url", problem);
            Err(ApiError::validation(fields))
        }
    }
}

/// `PUT /v1/me/webhook`.
pub async fn set(
    State(state): State<AppState>,
    me: SiliconAuth,
    meta: ClientMeta,
    Json(body): Json<WebhookBody>,
) -> Result<Json<Value>, ApiError> {
    let url = webhook_url(&state, &body)?;
    let mut tx = state.db.begin().await?;
    let secret = set_silicon_webhook(&mut tx, &state, me.uuid(), &url).await?;
    Actor::account(me.uuid(), meta.ip.as_deref())
        .record(
            &mut tx,
            "silicon.webhook.set",
            me.uuid(),
            me.uuid(),
            json!({"url_origin": url_origin(&url), "by": "silicon"}),
        )
        .await?;
    tx.commit().await?;
    Ok(Json(json!({"webhook_url": url, "webhook_secret": secret})))
}

/// `DELETE /v1/me/webhook`.
pub async fn remove(
    State(state): State<AppState>,
    me: SiliconAuth,
    meta: ClientMeta,
) -> Result<Response, ApiError> {
    let mut tx = state.db.begin().await?;
    let had = me.account.webhook_url.is_some();
    accounts::set_silicon_webhook(&mut tx, me.uuid(), None, None).await?;
    if had {
        Actor::account(me.uuid(), meta.ip.as_deref())
            .record(
                &mut tx,
                "silicon.webhook.removed",
                me.uuid(),
                me.uuid(),
                json!({"by": "silicon"}),
            )
            .await?;
    }
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

/// `POST /v1/me/webhook/test`.
pub async fn test(
    State(state): State<AppState>,
    me: SiliconAuth,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let mut tx = state.db.begin().await?;
    let webhook_url: Option<String> =
        sqlx::query_scalar("select webhook_url from accounts where uuid = $1")
            .bind(me.uuid())
            .fetch_optional(&mut *tx)
            .await?
            .flatten();
    let Some(url) = webhook_url else {
        return Err(webhook_not_set(&me));
    };
    // Counted inside the transaction: only pings that are actually queued use up the limit.
    rate_limit::enforce(
        &mut tx,
        &rate_limit::bucket("silicon_webhook_test:silicon", me.uuid()),
        WEBHOOK_TESTS_PER_SILICON,
        "webhook test pings for this Silicon",
    )
    .await
    .map_err(|e| {
        e.hint("Wait for details.retry_after_seconds. The last test ping is still being retried meanwhile; check whether it arrived (X-Accounts-Event-Id) before sending another.")
    })?;
    // Earlier test pings still waiting for a retry are replaced by this one. A ping a worker is
    // sending right now (leased) is left to finish.
    let superseded = sqlx::query(
        "update webhook_deliveries d set status = 'failed', last_error = $3 \
           from webhook_events e \
          where e.event_id = d.event_id and e.type = $2 \
            and d.target_kind = 'silicon' and d.target_id = $1 and d.status = 'pending' \
            and (d.locked_until is null or d.locked_until <= now())",
    )
    .bind(me.uuid())
    .bind(types::PING)
    .bind(SUPERSEDED)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    let Some(event) = events::ping_silicon(&mut tx, me.uuid()).await? else {
        return Err(webhook_not_set(&me));
    };
    tx.commit().await?;
    Ok((
        StatusCode::ACCEPTED,
        Json(json!({
            "event_id": event.event_id.to_string(),
            "delivery_id": event.delivery_id.to_string(),
            "type": event.event_type,
            "url": url,
            "superseded_pings": superseded,
        })),
    ))
}

/// 409 `webhook_not_set`.
fn webhook_not_set(me: &SiliconAuth) -> ApiError {
    ApiError::conflict(
        "webhook_not_set",
        format!("{} has no webhook to test.", me.account.display_id()),
    )
    .hint("Set one first with PUT /v1/me/webhook {\"url\": \"https://…\"} (`silicon-accounts webhook set <url>`).")
}
