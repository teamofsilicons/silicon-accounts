//! `X-Request-Id`: taken from the request when it is sane, generated (UUIDv7) otherwise, echoed
//! on every response and available to error rendering through a task-local.
//!
//! Install once on the whole router: `.layer(axum::middleware::from_fn(request_id::middleware))`.

use std::convert::Infallible;
use std::future::Future;

use axum::extract::{FromRequestParts, Request};
use axum::http::HeaderValue;
use axum::http::request::Parts;
use axum::middleware::Next;
use axum::response::Response;

/// Header name (lowercase).
pub const HEADER: &str = "x-request-id";

tokio::task_local! {
    static REQUEST_ID: String;
}

/// The current request's id, when called inside a request (or [`scope`]).
pub fn current() -> Option<String> {
    REQUEST_ID.try_with(Clone::clone).ok()
}

/// Runs `f` with `id` as the current request id.
pub async fn scope<F: Future>(id: String, f: F) -> F::Output {
    REQUEST_ID.scope(id, f).await
}

fn sane(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_.:".contains(c))
}

/// The request id as an extractor (always present under [`middleware`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequestId(pub String);

impl<S: Send + Sync> FromRequestParts<S> for RequestId {
    type Rejection = Infallible;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        Ok(parts
            .extensions
            .get::<RequestId>()
            .cloned()
            .or_else(|| current().map(RequestId))
            .unwrap_or_else(|| RequestId(uuid::Uuid::now_v7().to_string())))
    }
}

/// Middleware: assigns the id, scopes it for the handler and echoes `X-Request-Id`.
pub async fn middleware(mut req: Request, next: Next) -> Response {
    let id = req
        .headers()
        .get(HEADER)
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|v| sane(v))
        .map(str::to_string)
        .unwrap_or_else(|| uuid::Uuid::now_v7().to_string());
    req.extensions_mut().insert(RequestId(id.clone()));
    let mut response = REQUEST_ID.scope(id.clone(), next.run(req)).await;
    if let Ok(v) = HeaderValue::from_str(&id) {
        response.headers_mut().insert(HEADER, v);
    }
    response
}
