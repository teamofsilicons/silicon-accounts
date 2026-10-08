//! Errors the middleware itself makes (413 body limit, 503 time budget, 500 panic, rewritten
//! plain-text errors) in the shape the endpoint's clients read: the API error object
//! `{"error":{"code","message","hint","details"}}` everywhere, except on the OAuth token,
//! revocation and introspection endpoints ([`paths::is_oauth_rfc6749_path`]), which answer
//! RFC 6749 bodies `{"error":"invalid_request","error_description":"…"}` like their handlers do,
//! because generic OAuth/OIDC libraries read `error` as a string.
//!
//! Either way the status code stays, `X-Request-Id` is set, and `Retry-After` is kept.

use accounts_core::http::request_id;
use accounts_core::{ApiError, OAuthError};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};

use crate::paths;

/// Renders a middleware error for a request to `path`.
pub fn render(path: &str, error: ApiError) -> Response {
    if !paths::is_oauth_rfc6749_path(path) {
        return error.into_response();
    }
    let retry_after = error.retry_after;
    let mut response = to_oauth(path, &error).into_response();
    if let Some(secs) = retry_after
        && let Ok(v) = HeaderValue::from_str(&secs.to_string())
    {
        response.headers_mut().insert(header::RETRY_AFTER, v);
    }
    response
}

/// The RFC 6749 form of a middleware error, with the same status. `error` is
/// `invalid_client` (401), `temporarily_unavailable` (503), `server_error` (other 5xx) or
/// `invalid_request` (other 4xx). `error_description` says what happened and what to do; for
/// 5xx it carries the request id, since the body has no `details`.
pub fn to_oauth(path: &str, error: &ApiError) -> OAuthError {
    let status = error.status;
    let code = match status {
        StatusCode::UNAUTHORIZED => "invalid_client",
        StatusCode::SERVICE_UNAVAILABLE => "temporarily_unavailable",
        s if s.is_server_error() => "server_error",
        _ => "invalid_request",
    };
    let request_id = request_id::current();
    let description = if status == StatusCode::SERVICE_UNAVAILABLE {
        // The API hint (retry with the same Idempotency-Key) doesn't apply to OAuth requests.
        let redeemed = if path == "/v1/oauth/token" {
            " An authorization code or refresh token redeemed before the timeout can't be redeemed again: if the retry answers invalid_grant, sign in again."
        } else {
            ""
        };
        let reference = request_id
            .map(|id| format!(" (request id {id})"))
            .unwrap_or_default();
        format!(
            "{} Retry the request in a moment.{redeemed}{reference}",
            error.message
        )
    } else if status.is_server_error() {
        // Never the internal context: ApiError::internal logged it already.
        let include = match request_id {
            Some(id) => format!("the request id {id}"),
            None => "the X-Request-Id header of this response".to_string(),
        };
        format!(
            "Silicon Accounts failed while handling this request; this is a fault on our side, not in your request. Retry in a moment; if it keeps failing, report it with `silicon-accounts report \"<what you did>\"` and include {include}."
        )
    } else {
        match &error.hint {
            Some(hint) => format!("{} {hint}", error.message),
            None => error.message.clone(),
        }
    };
    OAuthError::new(status, code, description)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn statuses_map_to_rfc6749_codes() {
        let too_large = ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "payload_too_large",
            "The request body is 70000 bytes, but POST /v1/oauth/token accepts at most 64 KB (65536 bytes).",
        )
        .hint("Send a smaller body.");
        let e = to_oauth("/v1/oauth/token", &too_large);
        assert_eq!(
            (e.status, e.error.as_ref()),
            (StatusCode::PAYLOAD_TOO_LARGE, "invalid_request")
        );
        assert_eq!(
            e.description,
            "The request body is 70000 bytes, but POST /v1/oauth/token accepts at most 64 KB (65536 bytes). Send a smaller body."
        );

        let timeout = ApiError::unavailable(
            "request_timeout",
            "Silicon Accounts did not finish POST /v1/oauth/token within 30 seconds.",
        );
        let e = to_oauth("/v1/oauth/token", &timeout);
        assert_eq!(e.error, "temporarily_unavailable");
        assert!(e.description.contains("invalid_grant"), "{}", e.description);
        let e = to_oauth("/v1/oauth/revoke", &timeout);
        assert!(
            !e.description.contains("invalid_grant"),
            "{}",
            e.description
        );

        let e = to_oauth(
            "/v1/oauth/introspect",
            &ApiError::internal("boom: secret detail"),
        );
        assert_eq!((e.status.as_u16(), e.error.as_ref()), (500, "server_error"));
        assert!(!e.description.contains("secret detail"));

        let unauth = ApiError::new(
            StatusCode::UNAUTHORIZED,
            "unauthenticated",
            "No credentials.",
        );
        assert_eq!(to_oauth("/v1/oauth/token", &unauth).error, "invalid_client");
    }
}
