//! One-time upgrade of encrypted verification retry responses. Historical route names occur
//! only here: current APIs, payloads and clients use the full verification names.

use accounts_core::{ApiResult, AppState, repo::idempotency};
use serde_json::Value;

/// Run before the API listens. Preserve the original token, request hash, key and expiry,
/// including a refresh response whose refresh token has already been consumed.
pub async fn migrate_retry_responses(state: &AppState) -> ApiResult<()> {
    let mut tx = state.db.begin().await?;
    sqlx::query("select pg_advisory_xact_lock(110011)")
        .execute(&mut *tx)
        .await?;
    let rows: Vec<(String, String, Value)> = sqlx::query_as(
        "select scope, key, response from idempotency_keys where expires_at > now() \
         and status_code > 0 and (scope ~ ' POST /v1/proofs/(ata|obo|refresh)$' \
         or scope ~ ' POST /v1/apps/[^/]+/proofs/ata$') for update",
    )
    .fetch_all(&mut *tx)
    .await?;
    for (scope, key, stored) in rows {
        let new_scope = if let Some(base) = scope.strip_suffix("/proofs/ata") {
            format!("{base}/proofs/app-verification")
        } else if let Some(base) = scope.strip_suffix("/proofs/obo") {
            format!("{base}/proofs/user-verification")
        } else {
            scope.clone()
        };
        let mut body = idempotency::unseal(&state.keys.keyring, &scope, &key, &stored)?;
        let kind = match body.get("kind").and_then(Value::as_str) {
            Some("ata") => Some("app_verification"),
            Some("obo") => Some("user_verification"),
            _ => None,
        };
        if let Some(kind) = kind {
            body["kind"] = Value::String(kind.into());
        }
        if kind.is_none() && new_scope == scope {
            continue;
        }
        let response = idempotency::seal(&state.keys.keyring, &new_scope, &key, &body)?;
        sqlx::query("update idempotency_keys set scope=$1, response=$2 where scope=$3 and key=$4")
            .bind(new_scope)
            .bind(response)
            .bind(scope)
            .bind(key)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(())
}
