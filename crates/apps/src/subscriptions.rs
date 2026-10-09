//! An app's event subscriptions (app or owner): where its updates go, which updates it wants,
//! and whether each destination is active or paused.
//!
//! - `GET /v1/apps/{app_id}/subscriptions` → `{"items":[Subscription],"next_cursor":null}`.
//! - `POST /v1/apps/{app_id}/subscriptions` (Idempotency-Key, kept 10 minutes: a webhook create
//!   returns its signing secret once) `{"delivery":"webhook"|"stream","url"?,"updates"?,"status"?}`
//!   → 201 Subscription (+ `secret` for a webhook). `updates` omitted = the defaults
//!   ([`events::DEFAULT_UPDATES`]); `null` = every update. 409 `subscription_exists`.
//! - `GET /v1/apps/{app_id}/subscriptions/{subscription_id}` → Subscription.
//! - `PATCH …/{subscription_id}` (Idempotency-Key) `{"updates"?,"status"?,"url"?}` → Subscription.
//!   A webhook's new URL keeps its signing secret.
//! - `DELETE …/{subscription_id}` → 204. The webhook subscription is the app's webhook: deleting
//!   it removes the URL and secret like `DELETE /v1/apps/{app_id}/webhook`.
//! - `POST …/{subscription_id}/test` (Idempotency-Key) → 202 `{subscription_id,event_id,delivery_id}`:
//!   a `ping` on that subscription.
//!
//! At most one webhook and one stream subscription per app. The webhook subscription follows the
//! app's webhook (`PUT /v1/apps/{app_id}/webhook` manages the same thing; see core's
//! `repo::subscriptions`). A paused subscription gets nothing recorded until it is active again.

use accounts_core::events;
use accounts_core::http::{AppOrOwner, ClientMeta, IdempotencyKey, Json, Path};
use accounts_core::models::{SubscriptionDelivery, SubscriptionStatus};
use accounts_core::normalize::validate_webhook_url;
use accounts_core::repo::subscriptions::{self, Subscription};
use accounts_core::repo::{audit, idempotency};
use accounts_core::{ApiError, ApiResult, AppState, FieldErrors, timefmt};
use axum::Router;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Value, json};
use sqlx::PgConnection;
use uuid::Uuid;

use crate::signin_config::ensure_config_row;
use crate::util::caller_scope;

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/v1/apps/{app_id}/subscriptions",
            get(list_subscriptions).post(create_subscription),
        )
        .route(
            "/v1/apps/{app_id}/subscriptions/{subscription_id}",
            get(get_subscription)
                .patch(update_subscription)
                .delete(delete_subscription),
        )
        .route(
            "/v1/apps/{app_id}/subscriptions/{subscription_id}/test",
            post(test_subscription),
        )
}

/// `Some(None)` for an explicit `null`, `None` when the field is absent.
fn double_option<'de, D, T>(d: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(d).map(Some)
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct CreateBody {
    delivery: SubscriptionDelivery,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    url: Option<String>,
    #[serde(
        default,
        deserialize_with = "double_option",
        skip_serializing_if = "Option::is_none"
    )]
    updates: Option<Option<Vec<String>>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    status: Option<SubscriptionStatus>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct UpdateBody {
    #[serde(
        default,
        deserialize_with = "double_option",
        skip_serializing_if = "Option::is_none"
    )]
    updates: Option<Option<Vec<String>>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    status: Option<SubscriptionStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    url: Option<String>,
}

fn not_found(app_id: &str, raw: &str) -> ApiError {
    ApiError::not_found(
        "subscription_not_found",
        format!("The app '{app_id}' has no subscription '{}'.", raw.trim()),
    )
    .hint(format!(
        "List the app's subscriptions with GET /v1/apps/{app_id}/subscriptions."
    ))
}

fn parse_id(app_id: &str, raw: &str) -> ApiResult<Uuid> {
    Uuid::parse_str(raw.trim()).map_err(|_| not_found(app_id, raw))
}

/// `updates` as given: absent = `default`, `null` = every update, a list = validated.
fn resolve_updates(
    given: Option<Option<Vec<String>>>,
    default: Option<Vec<String>>,
) -> ApiResult<Option<Vec<String>>> {
    match given {
        None => Ok(default),
        Some(None) => Ok(None),
        Some(Some(list)) => subscriptions::validate_updates(&list).map(Some),
    }
}

fn url_error(message: impl Into<String>) -> ApiError {
    let mut f = FieldErrors::new();
    f.add("url", message);
    ApiError::validation(f)
}

/// The webhook URL and whether a signing secret is set.
async fn webhook_columns(
    conn: &mut PgConnection,
    app_id: &str,
) -> ApiResult<(Option<String>, bool)> {
    let row: Option<(Option<String>, bool)> = sqlx::query_as(
        "select webhook_url, webhook_secret_enc is not null from app_signin_configs where app_id = $1",
    )
    .bind(app_id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(row.unwrap_or((None, false)))
}

/// The Subscription object.
async fn view(state: &AppState, conn: &mut PgConnection, s: &Subscription) -> ApiResult<Value> {
    let (url, secret_set) = match s.delivery {
        SubscriptionDelivery::Webhook => webhook_columns(conn, &s.app_id).await?,
        SubscriptionDelivery::Stream => (None, false),
    };
    let stream_url = (s.delivery == SubscriptionDelivery::Stream)
        .then(|| format!("{}/v1/events/stream", state.settings.public_url));
    Ok(json!({
        "id": s.id,
        "app_id": s.app_id,
        "delivery": s.delivery,
        "status": s.status,
        "url": url,
        "secret_set": secret_set,
        "updates": s.updates,
        "event_types": s.event_types(),
        "stream_url": stream_url,
        "created_at": timefmt::format_rfc3339_ms(s.created_at),
        "updated_at": timefmt::format_rfc3339_ms(s.updated_at),
    }))
}

async fn record_audit(
    conn: &mut PgConnection,
    auth: &AppOrOwner,
    meta: &ClientMeta,
    action: &str,
    details: Value,
) -> ApiResult<()> {
    let app_id = auth.app.app_id.as_str();
    let (actor_kind, actor_id) = auth.audit_actor();
    audit::record(
        conn,
        &audit::AuditEntry {
            target_kind: Some("app"),
            target_id: Some(app_id),
            app_id: Some(app_id),
            details,
            ip: meta.ip.as_deref(),
            ..audit::AuditEntry::new(actor_kind, Some(&actor_id), action)
        },
    )
    .await?;
    Ok(())
}

fn no_store(r: &mut Response) {
    r.headers_mut().insert(
        axum::http::header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("no-store"),
    );
}

async fn list_subscriptions(
    State(state): State<AppState>,
    auth: AppOrOwner,
) -> ApiResult<Response> {
    let mut conn = state.db.acquire().await?;
    let mut items = Vec::new();
    for s in subscriptions::list(&mut conn, &auth.app.app_id).await? {
        items.push(view(&state, &mut conn, &s).await?);
    }
    Ok(axum::Json(json!({"items": items, "next_cursor": Value::Null})).into_response())
}

async fn get_subscription(
    State(state): State<AppState>,
    auth: AppOrOwner,
    Path((_app_id, raw_id)): Path<(String, String)>,
) -> ApiResult<Response> {
    let app_id = auth.app.app_id.as_str();
    let id = parse_id(app_id, &raw_id)?;
    let mut conn = state.db.acquire().await?;
    let s = subscriptions::get(&mut conn, app_id, id)
        .await?
        .ok_or_else(|| not_found(app_id, &raw_id))?;
    Ok(axum::Json(view(&state, &mut conn, &s).await?).into_response())
}

async fn create_subscription(
    State(state): State<AppState>,
    auth: AppOrOwner,
    meta: ClientMeta,
    key: Option<IdempotencyKey>,
    Json(body): Json<CreateBody>,
) -> ApiResult<Response> {
    let app_id = auth.app.app_id.clone();
    let scope = idempotency::scope(
        &caller_scope(&auth),
        "POST",
        &format!("/v1/apps/{app_id}/subscriptions"),
    );
    // A webhook create answers with its new signing secret: a retry with the same key gets the
    // same secret for 10 minutes instead of a second subscription attempt.
    let mut r = idempotency::run(&state, key.as_deref(), &scope, &body, true, || async {
        let defaults = Some(events::DEFAULT_UPDATES.iter().map(|s| s.to_string()).collect());
        let updates = resolve_updates(body.updates.clone(), defaults)?;
        let status = body.status.unwrap_or(SubscriptionStatus::Active);
        let mut tx = state.db.begin().await?;
        let (subscription, secret) = match body.delivery {
            SubscriptionDelivery::Webhook => {
                let raw = body.url.as_deref().ok_or_else(|| {
                    url_error("a webhook subscription needs the https URL to send updates to")
                })?;
                let url = validate_webhook_url(&state.settings, raw)
                    .map_err(url_error)?
                    .to_string();
                ensure_config_row(&mut tx, &app_id).await?;
                let current: Option<String> = sqlx::query_scalar(
                    "select webhook_url from app_signin_configs where app_id = $1 for update",
                )
                .bind(&app_id)
                .fetch_one(&mut *tx)
                .await?;
                if current.is_some()
                    && let Some(existing) =
                        subscriptions::by_delivery(&mut tx, &app_id, SubscriptionDelivery::Webhook)
                            .await?
                {
                    return Err(subscriptions::already_exists(&app_id, &existing));
                }
                let (secret, enc) = events::new_webhook_secret(&state.keys.keyring)?;
                sqlx::query(
                    "update app_signin_configs set webhook_url = $2, webhook_secret_enc = $3, \
                     webhook_events = $4, updated_at = now() where app_id = $1",
                )
                .bind(&app_id)
                .bind(&url)
                .bind(&enc)
                .bind(subscriptions::updates_to_json(updates.as_deref()))
                .execute(&mut *tx)
                .await?;
                let created =
                    subscriptions::by_delivery(&mut tx, &app_id, SubscriptionDelivery::Webhook)
                        .await?
                        .ok_or_else(|| {
                            ApiError::internal("the webhook subscription was not created with the URL")
                        })?;
                (created, Some(secret))
            }
            SubscriptionDelivery::Stream => {
                if body.url.is_some() {
                    return Err(url_error(
                        "a stream subscription has no URL: open GET /v1/events/stream with the app's credentials instead",
                    ));
                }
                let created =
                    subscriptions::insert_stream(&mut tx, &app_id, updates.as_deref(), status)
                        .await?;
                (created, None)
            }
        };
        if status != subscription.status {
            subscriptions::set_status(&mut tx, subscription.id, status).await?;
        }
        let subscription = subscriptions::get(&mut tx, &app_id, subscription.id)
            .await?
            .ok_or_else(|| ApiError::internal("the new subscription vanished"))?;
        record_audit(
            &mut tx,
            &auth,
            &meta,
            "app.subscription.created",
            json!({
                "subscription_id": subscription.id,
                "delivery": subscription.delivery,
                "status": subscription.status,
                "updates": subscription.updates,
            }),
        )
        .await?;
        let mut out = view(&state, &mut tx, &subscription).await?;
        tx.commit().await?;
        if let Some(secret) = secret {
            out["secret"] = json!(secret);
        }
        Ok((StatusCode::CREATED, out))
    })
    .await?;
    no_store(&mut r);
    Ok(r)
}

async fn update_subscription(
    State(state): State<AppState>,
    auth: AppOrOwner,
    meta: ClientMeta,
    key: Option<IdempotencyKey>,
    Path((_app_id, raw_id)): Path<(String, String)>,
    Json(body): Json<UpdateBody>,
) -> ApiResult<Response> {
    let app_id = auth.app.app_id.clone();
    let id = parse_id(&app_id, &raw_id)?;
    let scope = idempotency::scope(
        &caller_scope(&auth),
        "PATCH",
        &format!("/v1/apps/{app_id}/subscriptions/{id}"),
    );
    idempotency::run(&state, key.as_deref(), &scope, &body, false, || async {
        if body.updates.is_none() && body.status.is_none() && body.url.is_none() {
            return Err(ApiError::unprocessable(
                "validation_failed",
                "The request changes nothing: send updates, status or url.",
            )
            .hint("For example {\"status\":\"paused\"} or {\"updates\":[\"id_change\",\"account_deleted\"]}."));
        }
        let mut tx = state.db.begin().await?;
        let current = subscriptions::lock(&mut tx, &app_id, id)
            .await?
            .ok_or_else(|| not_found(&app_id, &raw_id))?;
        let mut changed: Vec<&str> = Vec::new();
        if let Some(raw) = &body.url {
            if current.delivery != SubscriptionDelivery::Webhook {
                return Err(url_error(
                    "a stream subscription has no URL; only a webhook subscription has one",
                ));
            }
            let url = validate_webhook_url(&state.settings, raw)
                .map_err(url_error)?
                .to_string();
            sqlx::query(
                "update app_signin_configs set webhook_url = $2, updated_at = now() where app_id = $1",
            )
            .bind(&app_id)
            .bind(&url)
            .execute(&mut *tx)
            .await?;
            changed.push("url");
        }
        if body.updates.is_some() {
            let updates = resolve_updates(body.updates.clone(), current.updates.clone())?;
            match current.delivery {
                SubscriptionDelivery::Webhook => {
                    subscriptions::set_webhook_updates(&mut tx, &app_id, updates.as_deref())
                        .await?
                }
                SubscriptionDelivery::Stream => {
                    subscriptions::set_stream_updates(&mut tx, id, updates.as_deref()).await?
                }
            }
            changed.push("updates");
        }
        if let Some(status) = body.status {
            subscriptions::set_status(&mut tx, id, status).await?;
            changed.push("status");
        }
        let updated = subscriptions::get(&mut tx, &app_id, id)
            .await?
            .ok_or_else(|| not_found(&app_id, &raw_id))?;
        record_audit(
            &mut tx,
            &auth,
            &meta,
            "app.subscription.updated",
            json!({
                "subscription_id": id,
                "delivery": updated.delivery,
                "changed": changed,
                "status": updated.status,
                "updates": updated.updates,
            }),
        )
        .await?;
        let out = view(&state, &mut tx, &updated).await?;
        tx.commit().await?;
        Ok((StatusCode::OK, out))
    })
    .await
}

async fn delete_subscription(
    State(state): State<AppState>,
    auth: AppOrOwner,
    meta: ClientMeta,
    Path((_app_id, raw_id)): Path<(String, String)>,
) -> ApiResult<Response> {
    let app_id = auth.app.app_id.clone();
    let id = parse_id(&app_id, &raw_id)?;
    let mut tx = state.db.begin().await?;
    let current = subscriptions::lock(&mut tx, &app_id, id)
        .await?
        .ok_or_else(|| not_found(&app_id, &raw_id))?;
    let details = match current.delivery {
        SubscriptionDelivery::Webhook => {
            let (previous, failed) = crate::webhooks::clear_webhook(&mut tx, &app_id)
                .await?
                .unwrap_or_default();
            json!({
                "subscription_id": id, "delivery": current.delivery,
                "previous_url": previous, "pending_deliveries_failed": failed,
            })
        }
        SubscriptionDelivery::Stream => {
            subscriptions::delete_stream(&mut tx, id).await?;
            json!({"subscription_id": id, "delivery": current.delivery})
        }
    };
    record_audit(&mut tx, &auth, &meta, "app.subscription.deleted", details).await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn test_subscription(
    State(state): State<AppState>,
    auth: AppOrOwner,
    key: Option<IdempotencyKey>,
    Path((_app_id, raw_id)): Path<(String, String)>,
) -> ApiResult<Response> {
    let app_id = auth.app.app_id.clone();
    let id = parse_id(&app_id, &raw_id)?;
    let scope = idempotency::scope(
        &caller_scope(&auth),
        "POST",
        &format!("/v1/apps/{app_id}/subscriptions/{id}/test"),
    );
    idempotency::run(
        &state,
        key.as_deref(),
        &scope,
        &json!({}),
        false,
        || async {
            let mut tx = state.db.begin().await?;
            let subscription = subscriptions::lock(&mut tx, &app_id, id)
                .await?
                .ok_or_else(|| not_found(&app_id, &raw_id))?;
            let (event_id, emitted) = events::ping_subscription(&mut tx, &subscription).await?;
            tx.commit().await?;
            Ok((
                StatusCode::ACCEPTED,
                json!({
                    "subscription_id": id,
                    "event_id": event_id,
                    "delivery_id": emitted.map(|e| e.delivery_id),
                    "type": events::types::PING,
                }),
            ))
        },
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bodies_tell_absent_from_null() {
        let b: CreateBody = serde_json::from_value(json!({"delivery": "stream"})).expect("body");
        assert_eq!(b.updates, None);
        let b: CreateBody =
            serde_json::from_value(json!({"delivery": "stream", "updates": null})).expect("body");
        assert_eq!(b.updates, Some(None));
        assert_eq!(
            serde_json::to_value(&b).expect("json"),
            json!({"delivery": "stream", "updates": null})
        );
        let b: UpdateBody =
            serde_json::from_value(json!({"updates": ["id_change"]})).expect("body");
        assert_eq!(b.updates, Some(Some(vec!["id_change".to_string()])));
        assert!(serde_json::from_value::<UpdateBody>(json!({"events": []})).is_err());
        let defaults = Some(vec!["id_change".to_string()]);
        assert_eq!(
            resolve_updates(None, defaults.clone()).expect("ok"),
            defaults
        );
        assert_eq!(resolve_updates(Some(None), defaults).expect("ok"), None);
    }
}
