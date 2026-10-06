//! The `Idempotency-Key` header (1–200 visible ASCII characters). Use
//! `Option<IdempotencyKey>` and pass `key.as_deref()` to `repo::idempotency::run`.

use axum::extract::{FromRequestParts, OptionalFromRequestParts};
use axum::http::request::Parts;

use crate::error::ApiError;

/// Header name.
pub const HEADER: &str = "idempotency-key";

/// A validated idempotency key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IdempotencyKey(pub String);

impl IdempotencyKey {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::ops::Deref for IdempotencyKey {
    type Target = str;
    fn deref(&self) -> &str {
        &self.0
    }
}

fn parse(parts: &Parts) -> Result<Option<IdempotencyKey>, ApiError> {
    let Some(raw) = parts.headers.get(HEADER) else {
        return Ok(None);
    };
    let invalid = || {
        ApiError::bad_request(
            "invalid_idempotency_key",
            "The Idempotency-Key header must be 1 to 200 visible ASCII characters (a UUID works well).",
        )
        .hint("Send a fresh random key per operation and reuse it only when retrying that same operation.")
    };
    let v = raw.to_str().map_err(|_| invalid())?.trim();
    if v.is_empty() || v.len() > 200 || !v.bytes().all(|b| (0x21..=0x7e).contains(&b)) {
        return Err(invalid());
    }
    Ok(Some(IdempotencyKey(v.to_string())))
}

impl<S: Send + Sync> FromRequestParts<S> for IdempotencyKey {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        parse(parts)?.ok_or_else(|| {
            ApiError::bad_request(
                "idempotency_key_required",
                "This endpoint needs an Idempotency-Key header.",
            )
            .hint(
                "Send Idempotency-Key: <a fresh UUID> so a retry never performs the change twice.",
            )
        })
    }
}

impl<S: Send + Sync> OptionalFromRequestParts<S> for IdempotencyKey {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        _state: &S,
    ) -> Result<Option<Self>, Self::Rejection> {
        parse(parts)
    }
}
