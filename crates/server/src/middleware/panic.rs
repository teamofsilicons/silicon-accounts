//! A panicking handler becomes `500 internal` with the API error body (and the request id),
//! instead of a dropped connection — or `500 server_error` as an RFC 6749 body on the OAuth
//! token, revocation and introspection endpoints. The panic message is logged, never sent.

use std::any::Any;
use std::panic::AssertUnwindSafe;

use accounts_core::ApiError;
use axum::extract::Request;
use axum::middleware::Next;
use axum::response::Response;
use futures::FutureExt as _;

use crate::middleware::errors;

/// The panic payload as text (panics carry `&str` or `String`).
pub fn panic_message(payload: &(dyn Any + Send)) -> String {
    let text = payload
        .downcast_ref::<String>()
        .map(String::as_str)
        .or_else(|| payload.downcast_ref::<&str>().copied())
        .unwrap_or("a panic without a message");
    text.chars().take(500).collect()
}

/// Runs the rest of the stack and turns a panic into a 500 JSON error.
pub async fn catch_panic(req: Request, next: Next) -> Response {
    let method = req.method().clone();
    let path = req.uri().path().to_owned();
    match AssertUnwindSafe(next.run(req)).catch_unwind().await {
        Ok(response) => response,
        Err(payload) => errors::render(
            &path,
            ApiError::internal(format!(
                "the handler for {method} {path} panicked: {}",
                panic_message(payload.as_ref())
            )),
        ),
    }
}
