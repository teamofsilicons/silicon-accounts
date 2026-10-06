//! `Idempotency-Key` handling for the endpoints whose responses carry freshly generated secrets:
//! `POST /v1/silicons` (a generated STK, the `sarq_` request token, a `whsec_` webhook secret),
//! `POST /v1/me/silicons` (STK, webhook secret) and `POST /v1/me/silicons/{uuid}/stk` (STK).
//!
//! The contract is core's `idempotency::run` with `secret_bearing = true`: the same key, caller,
//! endpoint and body replay the stored response (`Idempotent-Replayed: true`) for 10 minutes;
//! another body is 409 `idempotency_key_reused`; failures are not stored.
//!
//! The difference is what is stored. Core keeps the response JSON as it is, but these responses
//! hold secrets that exist nowhere else in clear: an STK is "shown exactly once and only its
//! hash is stored" (UNDERSTANDING), the request token is stored only as an HMAC and the webhook
//! secret only keyring-encrypted. So the stored response is sealed with the keyring (AES-256-GCM)
//! as `{"sealed": "<base64url>"}`, bound to its scope and key, and unsealed only to replay it. A
//! database read (a backup, a support query, a leaked dump) reveals no secret.

use std::future::Future;

use accounts_core::crypto::{self, Keyring};
use accounts_core::error::{ApiError, ApiResult};
use accounts_core::repo::idempotency::{self, Begin};
use accounts_core::state::AppState;
use axum::http::{HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use serde_json::{Value, json};

/// Key of the sealed response in the stored JSON.
const SEALED: &str = "sealed";
/// Stored instead when sealing failed: a retry must neither run the request again nor see the
/// secrets in clear, so it gets 409 `idempotency_result_unavailable`.
const UNAVAILABLE: &str = "unavailable";

fn respond(status: StatusCode, body: Value, replayed: bool) -> Response {
    let mut r = (status, axum::Json(body)).into_response();
    if replayed {
        r.headers_mut().insert(
            idempotency::REPLAYED_HEADER,
            HeaderValue::from_static("true"),
        );
    }
    r
}

/// The stored form of a response: sealed with the keyring, bound to `scope` and `key`.
pub fn seal(keyring: &Keyring, scope: &str, key: &str, body: &Value) -> ApiResult<Value> {
    let plain = json!({"scope": scope, "key": key, "body": body}).to_string();
    let sealed = keyring.encrypt_str(&plain)?;
    Ok(json!({ SEALED: crypto::b64url(&sealed) }))
}

/// The response to replay from its stored form. Responses stored before sealing existed are
/// replayed as they are.
pub fn unseal(keyring: &Keyring, scope: &str, key: &str, stored: &Value) -> ApiResult<Value> {
    if stored.get(UNAVAILABLE).is_some() {
        return Err(unavailable(key));
    }
    let Some(sealed) = stored.get(SEALED).and_then(Value::as_str) else {
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
    .hint("The change was made: look at the current state instead of retrying (GET /v1/me/silicons, GET /v1/silicons/requests/{id}). A custodian can rotate a lost STK. To run the request again, send a new Idempotency-Key.")
}

/// Runs `work` at most once per idempotency key, like core's `idempotency::run` with
/// `secret_bearing = true`, but stores the response sealed (see the module docs). Without a key
/// it just runs.
pub async fn run_secret<F, Fut>(
    state: &AppState,
    key: Option<&str>,
    scope: &str,
    request: &impl Serialize,
    work: F,
) -> Result<Response, ApiError>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = ApiResult<(StatusCode, Value)>>,
{
    let Some(key) = key else {
        let (status, body) = work().await?;
        return Ok(respond(status, body, false));
    };
    let hash = idempotency::request_hash(request);
    match idempotency::begin(&state.db, scope, key, &hash).await? {
        Begin::Replay { status, body } => {
            let body = unseal(&state.keys.keyring, scope, key, &body)?;
            Ok(respond(status, body, true))
        }
        Begin::Proceed => match work().await {
            Ok((status, body)) => {
                let stored = seal(&state.keys.keyring, scope, key, &body).unwrap_or_else(|e| {
                    tracing::error!(error = %e, "could not seal an idempotent response; retries get idempotency_result_unavailable");
                    json!({ UNAVAILABLE: true })
                });
                if let Err(e) =
                    idempotency::complete(&state.db, scope, key, status, &stored, true).await
                {
                    tracing::error!(error = %e, "could not store idempotent response");
                }
                Ok(respond(status, body, false))
            }
            Err(e) => {
                if let Err(e2) = idempotency::abandon(&state.db, scope, key).await {
                    tracing::error!(error = %e2, "could not release idempotency key");
                }
                Err(e)
            }
        },
    }
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
        let tampered = json!({"sealed": "AAAA"});
        assert_eq!(
            unseal(&k, "s", "key-1", &tampered)
                .expect_err("tampered")
                .code,
            "idempotency_result_unavailable"
        );
        assert_eq!(
            unseal(&k, "s", "key-1", &json!({"unavailable": true}))
                .expect_err("unavailable")
                .code,
            "idempotency_result_unavailable"
        );
        // Rows stored before sealing existed replay as they are.
        let legacy = json!({"silicon": {"uuid": "abc"}});
        assert_eq!(unseal(&k, "s", "key-1", &legacy).expect("legacy"), legacy);
    }
}
