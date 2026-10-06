//! Request parsing for the OAuth endpoints: `application/x-www-form-urlencoded` (RFC 6749) or
//! JSON bodies, with RFC 6749 errors that name the problem.

use accounts_core::OAuthError;
use accounts_core::http::parse_form_or_json;
use axum::body::Bytes;
use axum::extract::rejection::BytesRejection;
use axum::http::{HeaderMap, StatusCode};
use serde::de::DeserializeOwned;

/// Reads an OAuth request body into `T`. An empty body means "no parameters" (so a missing
/// `grant_type` or `token` gets its own precise error). Unknown parameters are ignored
/// (RFC 6749 §3.2); a repeated parameter is refused.
pub(crate) fn parse_body<T: DeserializeOwned + Default>(
    headers: &HeaderMap,
    body: Result<Bytes, BytesRejection>,
    what: &str,
) -> Result<T, OAuthError> {
    let bytes = body.map_err(|r| body_rejection(&r))?;
    if bytes.iter().all(u8::is_ascii_whitespace) {
        return Ok(T::default());
    }
    parse_form_or_json(headers, &bytes).map_err(|m| {
        OAuthError::invalid_request(format!(
            "{what} could not be read: {m}. Send the parameters once each, as application/x-www-form-urlencoded (or a JSON object of strings)."
        ))
    })
}

/// The OAuth error for a body that could not be buffered (too large, broken connection).
pub(crate) fn body_rejection(r: &BytesRejection) -> OAuthError {
    if r.status() == StatusCode::PAYLOAD_TOO_LARGE {
        OAuthError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "invalid_request",
            "The request body is too large; OAuth requests are small form posts (bodies are limited to 64 KB).",
        )
    } else {
        OAuthError::invalid_request(format!(
            "The request body could not be read: {}.",
            r.body_text()
        ))
    }
}

/// A trimmed, non-empty parameter value.
pub(crate) fn opt(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|s| !s.is_empty())
}
