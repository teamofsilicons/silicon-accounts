//! API version negotiation.
//!
//! A caller may pin the API version with the request header `Accounts-Version: 2026-10-01`.
//! Every answer on an API path (`/v1`, `/.well-known`, `/openapi.json`, the probes) says which
//! version served it in the response header `Accounts-Version`. Without the header the current
//! version serves the request, so every client written before versions existed keeps working.
//! A version this deployment doesn't serve is refused before anything runs: 400
//! `unsupported_version` with the supported list (an RFC 6749 body on the OAuth token,
//! revocation and introspection endpoints, like every error there).

use accounts_core::ApiError;
use axum::extract::Request;
use axum::http::{HeaderName, HeaderValue, StatusCode, header};
use axum::middleware::Next;
use axum::response::Response;

use crate::middleware::errors;
use crate::paths;

/// The request and response header.
pub const HEADER: HeaderName = HeaderName::from_static("accounts-version");

/// The version served when a request names none.
pub const CURRENT: &str = "2026-10-01";

/// Every version this deployment serves, oldest first.
pub const SUPPORTED: &[&str] = &[CURRENT];

/// The 400 for a version this deployment doesn't serve.
pub fn unsupported(requested: &str) -> ApiError {
    let shown: String = requested.chars().take(64).collect();
    ApiError::new(
        StatusCode::BAD_REQUEST,
        "unsupported_version",
        format!(
            "Silicon Accounts does not serve the API version '{shown}' named in the Accounts-Version header. It serves {}.",
            SUPPORTED.join(", ")
        ),
    )
    .hint(format!(
        "Send Accounts-Version: {CURRENT}, or leave the header out to get the current version. GET /v1/capabilities lists the versions."
    ))
    .detail("requested", shown)
    .detail("supported", SUPPORTED.to_vec())
    .detail("current", CURRENT)
}

/// The version a request asks for: `Ok(CURRENT)` without the header, the matching supported
/// version, or the refusal.
pub fn negotiate(headers: &axum::http::HeaderMap) -> Result<&'static str, ApiError> {
    let Some(raw) = headers.get(&HEADER) else {
        return Ok(CURRENT);
    };
    let text = raw.to_str().unwrap_or("").trim();
    SUPPORTED
        .iter()
        .find(|v| **v == text)
        .copied()
        .ok_or_else(|| unsupported(text))
}

/// Applies version negotiation to API paths.
pub async fn version(req: Request, next: Next) -> Response {
    let path = req.uri().path().to_owned();
    if !paths::is_api_path(&path) {
        return next.run(req).await;
    }
    let served = match negotiate(req.headers()) {
        Ok(v) => v,
        Err(e) => {
            let mut response = errors::render(&path, e);
            stamp(&mut response, CURRENT);
            return response;
        }
    };
    let mut response = next.run(req).await;
    stamp(&mut response, served);
    response
}

fn stamp(response: &mut Response, served: &'static str) {
    let h = response.headers_mut();
    h.insert(HEADER, HeaderValue::from_static(served));
    // A cache in front must keep answers for different versions apart.
    let has_vary = h.get_all(header::VARY).iter().any(|v| {
        v.to_str()
            .is_ok_and(|s| s.to_ascii_lowercase().contains("accounts-version"))
    });
    if !has_vary {
        h.append(header::VARY, HeaderValue::from_static("Accounts-Version"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderMap;

    #[test]
    fn negotiation() {
        let mut h = HeaderMap::new();
        assert_eq!(negotiate(&h).expect("default"), CURRENT);
        h.insert(HEADER, HeaderValue::from_static(" 2026-10-01 "));
        assert_eq!(negotiate(&h).expect("pinned"), "2026-10-01");
        h.insert(HEADER, HeaderValue::from_static("2025-01-01"));
        let e = negotiate(&h).expect_err("unknown");
        assert_eq!(e.status, StatusCode::BAD_REQUEST);
        assert_eq!(e.code, "unsupported_version");
        assert_eq!(e.details["supported"][0], CURRENT);
        assert_eq!(e.details["requested"], "2025-01-01");
        assert!(e.hint.as_deref().is_some_and(|h| h.contains(CURRENT)));
    }
}
