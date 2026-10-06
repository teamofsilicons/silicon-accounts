//! Idempotency keys for externally initiated changes (endpoints marked IDEMPOTENT).
//!
//! Same key + same caller + same endpoint (the `scope`) + same body within 24 h → the stored
//! response is replayed with `Idempotent-Replayed: true`. Same key with a different body → 409
//! `idempotency_key_reused`. A response that carries a freshly generated secret (an STK, a
//! webhook secret, a proof token) is replayable for 10 minutes only. A second request arriving
//! while the first still runs → 409 `idempotency_in_progress`. Failed requests (any error) are
//! not stored, so retrying them runs them again.
//!
//! Most handlers just call [`run`]:
//!
//! ```ignore
//! let scope = idempotency::scope(&format!("account:{}", me.uuid), "POST", "/v1/me/silicons");
//! idempotency::run(&state.db, key.as_deref(), &scope, &body, true, || async {
//!     // ... do the work ...
//!     Ok((StatusCode::CREATED, json!({ "silicon": view, "stk": stk })))
//! }).await
//! ```

use std::future::Future;

use axum::http::{HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use serde_json::Value;
use sqlx::PgPool;

use crate::error::{ApiError, ApiResult};

/// Normal replay window.
pub const REPLAY_WINDOW_SECONDS: i64 = 24 * 3600;
/// Replay window for responses that contain a freshly generated secret.
pub const SECRET_REPLAY_WINDOW_SECONDS: i64 = 600;
/// How long an in-progress placeholder blocks retries (a crashed request frees its key after this).
pub const IN_PROGRESS_SECONDS: i64 = 120;
/// Response header set on replays.
pub const REPLAYED_HEADER: &str = "idempotent-replayed";

/// The scope string: `"{caller} {METHOD} {route}"`, e.g. `"app:briefcase POST /v1/proofs/obo"`.
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

/// Stores the response of a successful request.
pub async fn complete(
    pool: &PgPool,
    scope: &str,
    key: &str,
    status: StatusCode,
    body: &Value,
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
    .bind(body)
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

fn json_response(status: StatusCode, body: Value, replayed: bool) -> Response {
    let mut r = (status, axum::Json(body)).into_response();
    if replayed {
        r.headers_mut()
            .insert(REPLAYED_HEADER, HeaderValue::from_static("true"));
    }
    r
}

/// Runs `work` at most once per idempotency key (see module docs). Without a key it just runs.
/// `secret_bearing` = the response contains a freshly generated secret (10-minute replay).
pub async fn run<F, Fut>(
    pool: &PgPool,
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
    let hash = request_hash(request);
    match begin(pool, scope, key, &hash).await? {
        Begin::Replay { status, body } => Ok(json_response(status, body, true)),
        Begin::Proceed => match work().await {
            Ok((status, body)) => {
                if let Err(e) = complete(pool, scope, key, status, &body, secret_bearing).await {
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
