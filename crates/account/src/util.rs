//! Small helpers shared by the handlers of this crate.

use accounts_core::models::ActorKind;
use accounts_core::repo::audit::{self, AuditEntry};
use accounts_core::repo::idempotency;
use accounts_core::{ApiError, ApiResult, AppState};
use serde::Serialize;
use serde_json::{Value, json};
use sqlx::PgConnection;
use time::OffsetDateTime;
use time::macros::datetime;

/// The idempotency scope of an account's own request: `account:{uuid} {METHOD} {route}`.
pub(crate) fn idem_scope(account_uuid: &str, method: &str, route: &str) -> String {
    idempotency::scope(&format!("account:{account_uuid}"), method, route)
}

/// Writes an audit record about the signed-in account, done by that account.
pub(crate) async fn audit_self(
    conn: &mut PgConnection,
    account_uuid: &str,
    action: &str,
    app_id: Option<&str>,
    details: Value,
    ip: Option<&str>,
) -> ApiResult<()> {
    audit::record(
        conn,
        &AuditEntry {
            actor_kind: ActorKind::Account,
            actor_id: Some(account_uuid),
            action,
            target_kind: Some("account"),
            target_id: Some(account_uuid),
            app_id,
            account_uuid: Some(account_uuid),
            details,
            ip,
        },
    )
    .await
}

/// Records a telemetry event about an account action (a no-op unless Space Station is
/// configured). `context` must never hold personal data: no ids, uuids, emails or numbers.
pub(crate) fn track(state: &AppState, step: &str, name: &str, context: Value) {
    state.telemetry.record("api.account", step, name, context);
}

/// `{"items":[...],"next_cursor":null}` for lists that always fit in one page.
pub(crate) fn single_page<T: Serialize>(items: &[T]) -> ApiResult<Value> {
    Ok(json!({ "items": serde_json::to_value(items)?, "next_cursor": Value::Null }))
}

/// A timestamp as whole microseconds since the Unix epoch (Postgres precision), for cursors.
pub(crate) fn to_micros(t: OffsetDateTime) -> i64 {
    (t.unix_timestamp_nanos() / 1_000) as i64
}

/// The inverse of [`to_micros`]; an out-of-range value is an invalid cursor.
pub(crate) fn from_micros(micros: i64) -> ApiResult<OffsetDateTime> {
    OffsetDateTime::from_unix_timestamp_nanos(i128::from(micros) * 1_000).map_err(|_| {
        ApiError::bad_request("invalid_cursor", "The cursor is not valid for this list.").hint(
            "Pass the next_cursor value from the previous page unchanged, or omit cursor to start over.",
        )
    })
}

/// A timestamp later than anything stored: the keyset start of a newest-first list.
pub(crate) const END_OF_TIME: OffsetDateTime = datetime!(9999-12-31 23:59:59 UTC);

/// Formats a timestamp the API way (`2026-10-06T12:00:00.000Z`).
pub(crate) fn ts(t: OffsetDateTime) -> String {
    accounts_core::timefmt::format_rfc3339_ms(t)
}

/// A JSON value's type for "must be a string, not a number" messages.
pub(crate) fn json_type(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "a boolean",
        Value::Number(_) => "a number",
        Value::String(_) => "a string",
        Value::Array(_) => "a list",
        Value::Object(_) => "an object",
    }
}

/// Shortens caller input echoed in messages (ids, emails, paths) so errors stay readable.
pub(crate) fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let head: String = s.chars().take(max).collect();
        format!("{head}…")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn micros_round_trip() {
        let t = datetime!(2026-10-06 12:00:00.123456 UTC);
        assert_eq!(from_micros(to_micros(t)).expect("valid"), t);
        assert!(from_micros(i64::MAX).is_err());
    }

    #[test]
    fn clipping() {
        assert_eq!(clip("abc", 5), "abc");
        assert_eq!(clip("abcdef", 3), "abc…");
    }
}
