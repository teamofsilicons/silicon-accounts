//! Idempotency keys for externally initiated changes (endpoints marked IDEMPOTENT).
//!
//! Same key + same caller + same endpoint (the `scope`) + same body within 24 h → the stored
//! response is replayed with `Idempotent-Replayed: true`. Same key with a different body → 409
//! `idempotency_key_reused`. A second request arriving while the first still runs → 409
//! `idempotency_in_progress`. Failed requests (any error) are not stored, so retrying them runs
//! them again.
//!
//! **Secret-bearing responses** (`secret_bearing = true`: a generated STK, a webhook secret, a
//! `sarq_` request token, proof tokens) hold secrets that exist nowhere else in clear (an STK is
//! "shown exactly once and only its hash is stored"). They are replayable for 10 minutes only and
//! stored **sealed** with the keyring (AES-256-GCM, bound to their scope and key) as
//! `{"$sealed": "<base64url>"}`, opened only to replay them: a database read (a backup, a support
//! query, a leaked dump) reveals no secret. A sealed response that can't be opened any more (the
//! keyring lost its key) answers 409 `idempotency_result_unavailable` instead of running the
//! request again.
//!
//! Most handlers just call [`run`]:
//!
//! ```ignore
//! let scope = idempotency::scope(&format!("account:{}", me.uuid()), "POST", "/v1/me/silicons");
//! idempotency::run(&state, key.as_deref(), &scope, &body, true, || async {
//!     // ... do the work ...
//!     Ok((StatusCode::CREATED, json!({ "silicon": view, "stk": stk })))
//! }).await
//! ```

use std::future::Future;

use axum::http::{HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use serde_json::{Value, json};
use sqlx::PgPool;

use crate::crypto::{self, Keyring};
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

/// Normal replay window.
pub const REPLAY_WINDOW_SECONDS: i64 = 24 * 3600;
/// Replay window for responses that contain a freshly generated secret.
pub const SECRET_REPLAY_WINDOW_SECONDS: i64 = 600;
/// How long an in-progress placeholder blocks retries (a crashed request frees its key after this).
pub const IN_PROGRESS_SECONDS: i64 = 120;
/// Response header set on replays.
pub const REPLAYED_HEADER: &str = "idempotent-replayed";

/// Key of the sealed response in the stored JSON.
const SEALED: &str = "$sealed";
/// Stored instead when sealing failed: a retry must neither run the request again nor see the
/// secrets in clear, so it gets 409 `idempotency_result_unavailable`.
const UNAVAILABLE: &str = "$unavailable";

/// The scope string: `"{caller} {METHOD} {route}"`, e.g. `"app:briefcase POST /v1/proofs/user-verification"`.
/// For public endpoints use the client IP as caller (`"ip:1.2.3.4"`).
pub fn scope(caller: &str, method: &str, route: &str) -> String {
    format!("{caller} {method} {route}")
}

/// SHA-256 of the request's canonical JSON (key order and whitespace don't matter).
pub fn request_hash(request: &impl Serialize) -> Vec<u8> {
    let canonical = serde_json::to_value(request)
        .map(|v| v.to_string())
        .unwrap_or_default();
    crate::crypto::sha256(canonical.as_bytes()).to_vec()
}

/// Outcome of [`begin`].
#[derive(Debug, Clone, PartialEq)]
pub enum Begin {
    /// Run the request, then call [`complete`] (or [`abandon`] on failure).
    Proceed,
    /// Return this stored response with `Idempotent-Replayed: true`.
    Replay { status: StatusCode, body: Value },
}

/// Claims `key` for this request or finds the earlier result.
pub async fn begin(pool: &PgPool, scope: &str, key: &str, request_hash: &[u8]) -> ApiResult<Begin> {
    for _ in 0..3 {
        let claimed: Option<i32> = sqlx::query_scalar(
            "insert into idempotency_keys (scope, key, request_hash, status_code, response, expires_at) \
             values ($1, $2, $3, 0, 'null'::jsonb, now() + make_interval(secs => $4)) \
             on conflict (scope, key) do update set request_hash = excluded.request_hash, status_code = 0, \
               response = 'null'::jsonb, created_at = now(), expires_at = excluded.expires_at \
             where idempotency_keys.expires_at <= now() \
             returning 1",
        )
        .bind(scope)
        .bind(key)
        .bind(request_hash)
        .bind(IN_PROGRESS_SECONDS as f64)
        .fetch_optional(pool)
        .await?;
        if claimed.is_some() {
            return Ok(Begin::Proceed);
        }
        let existing: Option<(Vec<u8>, i32, Value)> = sqlx::query_as(
            "select request_hash, status_code, response from idempotency_keys \
             where scope = $1 and key = $2 and expires_at > now()",
        )
        .bind(scope)
        .bind(key)
        .fetch_optional(pool)
        .await?;
        let Some((hash, status, body)) = existing else {
            continue;
        };
        if hash != request_hash {
            return Err(ApiError::conflict(
                "idempotency_key_reused",
                format!("Idempotency-Key '{key}' was already used for a different request body on this endpoint."),
            )
            .hint("Use a new Idempotency-Key for a new request; reuse a key only to retry the exact same request."));
        }
        if status == 0 {
            return Err(ApiError::conflict(
                "idempotency_in_progress",
                format!("A request with Idempotency-Key '{key}' is still being processed."),
            )
            .hint("Retry in a few seconds to get its result."));
        }
        let status = StatusCode::from_u16(status as u16).unwrap_or(StatusCode::OK);
        return Ok(Begin::Replay { status, body });
    }
    Err(ApiError::conflict(
        "idempotency_in_progress",
        format!("Idempotency-Key '{key}' is busy."),
    )
    .hint("Retry in a few seconds."))
}

/// Stores the response of a successful request: `stored` as given (for a secret-bearing
/// response, its [`seal`]ed form), replayable for 24 h, or 10 minutes when `secret_bearing`.
pub async fn complete(
    pool: &PgPool,
    scope: &str,
    key: &str,
    status: StatusCode,
    stored: &Value,
    secret_bearing: bool,
) -> ApiResult<()> {
    let ttl = if secret_bearing {
        SECRET_REPLAY_WINDOW_SECONDS
    } else {
        REPLAY_WINDOW_SECONDS
    };
    sqlx::query(
        "update idempotency_keys set status_code = $3, response = $4, expires_at = now() + make_interval(secs => $5) \
         where scope = $1 and key = $2",
    )
    .bind(scope)
    .bind(key)
    .bind(status.as_u16() as i32)
    .bind(stored)
    .bind(ttl as f64)
    .execute(pool)
    .await?;
    Ok(())
}

/// Releases the key after a failed request so a retry runs again.
pub async fn abandon(pool: &PgPool, scope: &str, key: &str) -> ApiResult<()> {
    sqlx::query("delete from idempotency_keys where scope = $1 and key = $2 and status_code = 0")
        .bind(scope)
        .bind(key)
        .execute(pool)
        .await?;
    Ok(())
}

/// The stored form of a secret-bearing response: sealed with the keyring, bound to `scope` and
/// `key` (moved to another row it doesn't open).
pub fn seal(keyring: &Keyring, scope: &str, key: &str, body: &Value) -> ApiResult<Value> {
    let plain = json!({"scope": scope, "key": key, "body": body}).to_string();
    let sealed = keyring.encrypt_str(&plain)?;
    Ok(json!({ SEALED: crypto::b64url(&sealed) }))
}

/// The response to replay from the stored form of a secret-bearing response. Errors: 409
/// `idempotency_result_unavailable` when it can't be opened (or sealing had failed).
pub fn unseal(keyring: &Keyring, scope: &str, key: &str, stored: &Value) -> ApiResult<Value> {
    if stored.get(UNAVAILABLE).is_some() {
        return Err(unavailable(key));
    }
    let Some(sealed) = stored.get(SEALED).and_then(Value::as_str) else {
        // Stored before sealing existed (at most 10 minutes before the upgrade).
        return Ok(stored.clone());
    };
    let opened = crypto::b64url_decode(sealed)
        .and_then(|bytes| keyring.decrypt_string(&bytes))
        .ok()
        .and_then(|plain| serde_json::from_str::<Value>(&plain).ok());
    match opened {
        Some(v) if v["scope"] == scope && v["key"] == key => Ok(v["body"].clone()),
        _ => {
            tracing::error!(scope, "a sealed idempotent response could not be opened");
            Err(unavailable(key))
        }
    }
}

/// 409 `idempotency_result_unavailable`: the request ran, but its result can't be shown again.
fn unavailable(key: &str) -> ApiError {
    ApiError::conflict(
        "idempotency_result_unavailable",
        format!(
            "The request with Idempotency-Key '{key}' already succeeded, but its stored result can't be read back any more, so it can't be shown again (it contained a secret that is shown only once)."
        ),
    )
    .hint("The change was made: look at the current state instead of retrying. A lost STK can be rotated by the Silicon's custodian, a lost webhook secret rotated, a lost proof refreshed or revoked. To run the request again, send a new Idempotency-Key.")
}

fn json_response(status: StatusCode, body: Value, replayed: bool) -> Response {
    let mut r = (status, axum::Json(body)).into_response();
    if replayed {
        r.headers_mut()
            .insert(REPLAYED_HEADER, HeaderValue::from_static("true"));
    }
    r
}

/// Runs `work` at most once per idempotency key (see module docs). Without a key it just runs.
/// `secret_bearing` = the response contains a freshly generated secret: it is stored sealed with
/// `state.keys.keyring` and replayable for 10 minutes.
pub async fn run<F, Fut>(
    state: &AppState,
    key: Option<&str>,
    scope: &str,
    request: &impl Serialize,
    secret_bearing: bool,
    work: F,
) -> Result<Response, ApiError>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = ApiResult<(StatusCode, Value)>>,
{
    let Some(key) = key else {
        let (status, body) = work().await?;
        return Ok(json_response(status, body, false));
    };
    let pool = &state.db;
    let keyring = &state.keys.keyring;
    let hash = request_hash(request);
    match begin(pool, scope, key, &hash).await? {
        Begin::Replay { status, body } => {
            let body = if secret_bearing {
                unseal(keyring, scope, key, &body)?
            } else {
                body
            };
            Ok(json_response(status, body, true))
        }
        Begin::Proceed => match work().await {
            Ok((status, body)) => {
                let stored = if secret_bearing {
                    seal(keyring, scope, key, &body).unwrap_or_else(|e| {
                        tracing::error!(error = %e, "could not seal an idempotent response; retries get idempotency_result_unavailable");
                        json!({ UNAVAILABLE: true })
                    })
                } else {
                    body.clone()
                };
                if let Err(e) = complete(pool, scope, key, status, &stored, secret_bearing).await {
                    tracing::error!(error = %e, "could not store idempotent response");
                }
                Ok(json_response(status, body, false))
            }
            Err(e) => {
                if let Err(e2) = abandon(pool, scope, key).await {
                    tracing::error!(error = %e2, "could not release idempotency key");
                }
                Err(e)
            }
        },
    }
}

/// Deletes expired keys (sweep).
pub async fn purge(pool: &PgPool) -> ApiResult<u64> {
    Ok(
        sqlx::query("delete from idempotency_keys where expires_at < now()")
            .execute(pool)
            .await?
            .rows_affected(),
    )
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;

    fn keyring() -> Keyring {
        let mut keys = BTreeMap::new();
        keys.insert(1u8, [7u8; 32]);
        Keyring::new(&keys, 1).expect("keyring")
    }

    #[test]
    fn sealed_responses_hide_secrets_and_open_only_for_their_key() {
        let k = keyring();
        let body = json!({"stk": "stk-0123456789ab", "request_token": "sarq_x", "webhook_secret": "whsec_y"});
        let stored = seal(&k, "ip:1.2.3.4 POST /v1/silicons", "key-1", &body).expect("seal");
        let text = stored.to_string();
        for secret in ["stk-", "sarq_", "whsec_", "0123456789ab"] {
            assert!(!text.contains(secret), "{secret} leaked into {text}");
        }
        assert_eq!(
            unseal(&k, "ip:1.2.3.4 POST /v1/silicons", "key-1", &stored).expect("open"),
            body
        );
        // Bound to its scope and key: moved to another row it doesn't open.
        let moved =
            unseal(&k, "ip:1.2.3.4 POST /v1/silicons", "key-2", &stored).expect_err("bound");
        assert_eq!(moved.code, "idempotency_result_unavailable");
        let tampered = json!({"$sealed": "AAAA"});
        assert_eq!(
            unseal(&k, "s", "key-1", &tampered)
                .expect_err("tampered")
                .code,
            "idempotency_result_unavailable"
        );
        assert_eq!(
            unseal(&k, "s", "key-1", &json!({"$unavailable": true}))
                .expect_err("unavailable")
                .code,
            "idempotency_result_unavailable"
        );
        // Rows stored before sealing existed replay as they are.
        let legacy = json!({"silicon": {"uuid": "abc"}});
        assert_eq!(unseal(&k, "s", "key-1", &legacy).expect("legacy"), legacy);
    }
}
