//! App event subscriptions (`app_event_subscriptions`): where an app's updates go (its webhook,
//! or the event stream), which updates it wants and whether each destination is active.
//!
//! At most one subscription per delivery per app. The webhook subscription follows the app's
//! webhook columns in `app_signin_configs` (a database trigger keeps it so, whoever writes them):
//! it exists exactly while `webhook_url` is set, and its `updates` are `webhook_events`. So its
//! URL, secret and updates are written there ([`set_webhook_updates`]); only its status lives
//! here. A stream subscription is a row of its own.
//!
//! `updates` = `None` means every update (what webhooks set up before subscriptions receive);
//! otherwise the names in [`crate::events::APP_UPDATE_CHOICES`].

use serde_json::{Value, json};
use sqlx::PgConnection;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};
use crate::events;
use crate::models::{SubscriptionDelivery, SubscriptionStatus};

/// One subscription.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Subscription {
    pub id: Uuid,
    pub app_id: String,
    pub delivery: SubscriptionDelivery,
    pub status: SubscriptionStatus,
    /// `None` = every update.
    pub updates: Option<Vec<String>>,
    pub created_at: OffsetDateTime,
    pub updated_at: OffsetDateTime,
}

impl Subscription {
    /// True when this subscription wants the update `choice` (see
    /// [`events::APP_UPDATE_CHOICES`]).
    pub fn wants(&self, choice: &str) -> bool {
        wants(self.updates.as_deref(), choice)
    }

    /// The event types it receives.
    pub fn event_types(&self) -> Vec<&'static str> {
        events::event_types_for_updates(self.updates.as_deref())
    }

    pub fn is_active(&self) -> bool {
        self.status == SubscriptionStatus::Active
    }
}

/// True when `updates` (`None` = every update) includes `choice`.
pub fn wants(updates: Option<&[String]>, choice: &str) -> bool {
    updates.is_none_or(|items| items.iter().any(|item| item == choice))
}

/// Reads a stored `updates` value (`null` or a JSON array of names).
pub fn updates_from_json(value: Option<&Value>) -> Option<Vec<String>> {
    value.and_then(Value::as_array).map(|items| {
        items
            .iter()
            .filter_map(|s| s.as_str().map(str::to_owned))
            .collect()
    })
}

/// The stored form of `updates`.
pub fn updates_to_json(updates: Option<&[String]>) -> Option<Value> {
    updates.map(|u| json!(u))
}

#[derive(sqlx::FromRow)]
struct Row {
    id: Uuid,
    app_id: String,
    delivery: SubscriptionDelivery,
    status: SubscriptionStatus,
    updates: Option<Value>,
    created_at: OffsetDateTime,
    updated_at: OffsetDateTime,
}

impl From<Row> for Subscription {
    fn from(r: Row) -> Self {
        Subscription {
            id: r.id,
            app_id: r.app_id,
            delivery: r.delivery,
            status: r.status,
            updates: updates_from_json(r.updates.as_ref()),
            created_at: r.created_at,
            updated_at: r.updated_at,
        }
    }
}

const COLUMNS: &str = "id, app_id, delivery, status, updates, created_at, updated_at";

/// The app's subscriptions, the webhook first.
pub async fn list(conn: &mut PgConnection, app_id: &str) -> ApiResult<Vec<Subscription>> {
    let rows: Vec<Row> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "select {COLUMNS} from app_event_subscriptions where app_id = $1 order by delivery desc"
    )))
    .bind(app_id)
    .fetch_all(&mut *conn)
    .await?;
    Ok(rows.into_iter().map(Subscription::from).collect())
}

/// One subscription of the app.
pub async fn get(
    conn: &mut PgConnection,
    app_id: &str,
    id: Uuid,
) -> ApiResult<Option<Subscription>> {
    let row: Option<Row> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "select {COLUMNS} from app_event_subscriptions where app_id = $1 and id = $2"
    )))
    .bind(app_id)
    .bind(id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(row.map(Subscription::from))
}

/// The app's subscription for one delivery.
pub async fn by_delivery(
    conn: &mut PgConnection,
    app_id: &str,
    delivery: SubscriptionDelivery,
) -> ApiResult<Option<Subscription>> {
    let row: Option<Row> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "select {COLUMNS} from app_event_subscriptions where app_id = $1 and delivery = $2"
    )))
    .bind(app_id)
    .bind(delivery)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(row.map(Subscription::from))
}

/// Locks and reads one subscription (inside a transaction).
pub async fn lock(
    conn: &mut PgConnection,
    app_id: &str,
    id: Uuid,
) -> ApiResult<Option<Subscription>> {
    let row: Option<Row> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "select {COLUMNS} from app_event_subscriptions where app_id = $1 and id = $2 for update"
    )))
    .bind(app_id)
    .bind(id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(row.map(Subscription::from))
}

/// 409 `subscription_exists`: the app already has a subscription of this delivery.
pub fn already_exists(app_id: &str, existing: &Subscription) -> ApiError {
    ApiError::conflict(
        "subscription_exists",
        format!(
            "The app '{app_id}' already has a {} subscription ({}); an app has at most one of each.",
            existing.delivery, existing.id
        ),
    )
    .hint(format!(
        "Change it with PATCH /v1/apps/{app_id}/subscriptions/{}, or delete it first.",
        existing.id
    ))
    .detail("subscription_id", existing.id.to_string())
}

/// Creates the app's stream subscription. 409 `subscription_exists` when it has one.
pub async fn insert_stream(
    conn: &mut PgConnection,
    app_id: &str,
    updates: Option<&[String]>,
    status: SubscriptionStatus,
) -> ApiResult<Subscription> {
    let row: Option<Row> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "insert into app_event_subscriptions (id, app_id, delivery, updates, status) \
         values ($1, $2, 'stream', $3, $4) on conflict (app_id, delivery) do nothing returning {COLUMNS}"
    )))
    .bind(Uuid::now_v7())
    .bind(app_id)
    .bind(updates_to_json(updates))
    .bind(status)
    .fetch_optional(&mut *conn)
    .await?;
    match row {
        Some(row) => Ok(row.into()),
        None => {
            let existing = by_delivery(conn, app_id, SubscriptionDelivery::Stream)
                .await?
                .ok_or_else(|| ApiError::internal("stream subscription vanished during insert"))?;
            Err(already_exists(app_id, &existing))
        }
    }
}

/// Sets the updates of the app's webhook subscription: writes `webhook_events`, which the
/// trigger copies into the subscription.
pub async fn set_webhook_updates(
    conn: &mut PgConnection,
    app_id: &str,
    updates: Option<&[String]>,
) -> ApiResult<()> {
    sqlx::query(
        "update app_signin_configs set webhook_events = $2, updated_at = now() where app_id = $1",
    )
    .bind(app_id)
    .bind(updates_to_json(updates))
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Sets the updates of a stream subscription.
pub async fn set_stream_updates(
    conn: &mut PgConnection,
    id: Uuid,
    updates: Option<&[String]>,
) -> ApiResult<()> {
    sqlx::query(
        "update app_event_subscriptions set updates = $2, updated_at = now() where id = $1 and delivery = 'stream'",
    )
    .bind(id)
    .bind(updates_to_json(updates))
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Sets a subscription's status.
pub async fn set_status(
    conn: &mut PgConnection,
    id: Uuid,
    status: SubscriptionStatus,
) -> ApiResult<()> {
    sqlx::query(
        "update app_event_subscriptions set status = $2, updated_at = now() where id = $1 and status <> $2",
    )
    .bind(id)
    .bind(status)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Deletes a stream subscription (the webhook subscription goes with the webhook URL).
pub async fn delete_stream(conn: &mut PgConnection, id: Uuid) -> ApiResult<bool> {
    Ok(
        sqlx::query("delete from app_event_subscriptions where id = $1 and delivery = 'stream'")
            .bind(id)
            .execute(&mut *conn)
            .await?
            .rows_affected()
            > 0,
    )
}

/// Validates a list of update names: known, no duplicates (kept in the given order).
/// 422 `invalid_updates` naming the unknown ones.
pub fn validate_updates(updates: &[String]) -> ApiResult<Vec<String>> {
    let unknown: Vec<&str> = updates
        .iter()
        .map(String::as_str)
        .filter(|u| !events::APP_UPDATE_CHOICES.contains(u))
        .collect();
    if !unknown.is_empty() {
        return Err(ApiError::unprocessable(
            "invalid_updates",
            format!(
                "Unknown update{}: {}. The updates are {}.",
                if unknown.len() == 1 { "" } else { "s" },
                unknown.join(", "),
                events::APP_UPDATE_CHOICES.join(", ")
            ),
        )
        .hint("Pick from the listed updates, or send null to receive every update.")
        .detail("allowed", events::APP_UPDATE_CHOICES.to_vec()));
    }
    let mut out: Vec<String> = Vec::with_capacity(updates.len());
    for u in updates {
        if !out.contains(u) {
            out.push(u.clone());
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wants_and_validation() {
        assert!(wants(None, "timezone_change"));
        let picked = vec!["id_change".to_string()];
        assert!(wants(Some(&picked), "id_change"));
        assert!(!wants(Some(&picked), "pfp_change"));
        assert!(!wants(Some(&[]), "id_change"));
        let ok = validate_updates(&["pfp_change".into(), "id_change".into(), "pfp_change".into()])
            .expect("valid");
        assert_eq!(ok, vec!["pfp_change", "id_change"]);
        let e = validate_updates(&["nope".into(), "id_change".into()]).expect_err("unknown");
        assert_eq!(e.code, "invalid_updates");
        assert!(e.message.contains("nope"), "{}", e.message);
        assert_eq!(e.details["allowed"].as_array().map(Vec::len), Some(9));
        assert_eq!(
            updates_from_json(Some(&json!(["a", 1, "b"]))),
            Some(vec!["a".into(), "b".into()])
        );
        assert_eq!(updates_from_json(Some(&Value::Null)), None);
        assert_eq!(updates_from_json(None), None);
    }
}
