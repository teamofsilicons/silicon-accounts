//! Body limits and time budgets per route class (see [`crate::paths::RouteClass`]).
//!
//! A declared `Content-Length` above the limit is refused before the handler runs; a body
//! without one (chunked) is wrapped in `http_body_util::Limited`, so reading past the limit
//! fails with axum's 413 rejection (core's `Json` extractor turns it into `payload_too_large`,
//! and [`super::policy`] does the same for handlers that read the body themselves). Both
//! errors made here are rendered by [`super::errors::render`] (RFC 6749 bodies on the OAuth
//! token, revocation and introspection endpoints).
//!
//! A refused body is still read (and thrown away, up to 64 MB) by [`super::linger`], so a
//! client or proxy that is still uploading reads the 413 instead of a reset connection. A
//! request that runs past its time budget is not read any further
//! ([`super::linger::LeaveUnread`]).

use std::time::Duration;

use accounts_core::ApiError;
use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, Method, StatusCode, header};
use axum::middleware::Next;
use axum::response::Response;
use http_body_util::Limited;

use crate::middleware::errors;
use crate::middleware::linger::LeaveUnread;
use crate::paths::{self, RouteClass, Timeouts};

/// The 413 error for `method path`.
pub fn payload_too_large(method: &Method, path: &str, declared: Option<u64>) -> ApiError {
    let class = RouteClass::of(method, path);
    let limit = class.body_limit();
    let size = match declared {
        Some(n) => format!("The request body is {n} bytes, but"),
        None => "The request body is too large:".to_string(),
    };
    ApiError::new(
        StatusCode::PAYLOAD_TOO_LARGE,
        "payload_too_large",
        format!(
            "{size} {method} {path} accepts at most {} ({limit} bytes).",
            class.limit_label()
        ),
    )
    .hint(match class {
        RouteClass::Default if paths::is_oauth_rfc6749_path(path) => {
            "OAuth requests are small form posts: send only the parameters the request needs."
        }
        RouteClass::Default => "Send a smaller body: most endpoints accept at most 64 KB (POST /v1/me/photo takes 2 MB, POST /v1/apps/{app_id}/imports 50 MB).",
        RouteClass::PhotoUpload => "Upload a smaller image (at most 2 MB): resize or compress it first.",
        RouteClass::Import => "Split the import into files of at most 50 MB and 100,000 rows each.",
        RouteClass::InternalSync => "Sync the apps in smaller batches (at most 5 MB per request).",
        RouteClass::SigninConfig => "Inline logos may be at most 128 KB each; host larger logos and use https URLs.",
    })
    .detail("limit_bytes", limit)
}

/// The error when a request runs past its time budget.
pub fn timed_out(method: &Method, path: &str, budget: Duration) -> ApiError {
    ApiError::unavailable(
        "request_timeout",
        format!(
            "Silicon Accounts did not finish {method} {path} within {} seconds, so it stopped working on it; the change may or may not have been applied.",
            budget.as_secs()
        ),
    )
    .hint("Check the current state, then retry. For changes, retry with the same Idempotency-Key so the change is never applied twice.")
    .detail("timeout_seconds", budget.as_secs())
}

fn declared_length(headers: &HeaderMap) -> Option<u64> {
    headers
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse().ok())
}

/// Enforces the body limit and the time budget of the request's route class.
pub async fn limits(State(timeouts): State<Timeouts>, req: Request, next: Next) -> Response {
    let method = req.method().clone();
    let path = req.uri().path().to_owned();
    let class = RouteClass::of(&method, &path);
    let limit = class.body_limit();
    if let Some(declared) = declared_length(req.headers())
        && declared > limit as u64
    {
        return errors::render(&path, payload_too_large(&method, &path, Some(declared)));
    }
    let req = req.map(|body| Body::new(Limited::new(body, limit)));
    let budget = class.timeout(&timeouts);
    match tokio::time::timeout(budget, next.run(req)).await {
        Ok(response) => response,
        Err(_) => {
            tracing::warn!(%method, %path, seconds = budget.as_secs(), "request ran past its time budget");
            let mut response = errors::render(&path, timed_out(&method, &path, budget));
            // The budget bounds the whole request: whatever body is left stays unread.
            response.extensions_mut().insert(LeaveUnread);
            response
        }
    }
}
