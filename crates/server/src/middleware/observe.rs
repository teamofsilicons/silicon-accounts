//! Request logging. Silicon Accounts records no telemetry.
//!
//! Each request runs inside a `request` span (method, route, request id), so every log line a
//! handler writes carries the request id. When it finishes, one line is logged with the method,
//! the route template, the status and the duration. Only route templates are logged
//! (`/v1/flows/{id}/verify`), never raw paths or query strings, which can carry ids and OAuth
//! codes. Health probes log at debug level.
//!
//! The `X-Accounts-Telemetry` header and the `sa_telemetry` cookie that older clients and the
//! other Silicon apps send are accepted and ignored.

use std::time::Instant;

use accounts_core::http::RequestId;
use axum::extract::{MatchedPath, Request};
use axum::middleware::Next;
use axum::response::Response;
use tracing::Instrument as _;

use crate::paths;

/// The route label: the matched template, or what kind of unmatched request it was.
fn route_label(matched: Option<&MatchedPath>, path: &str) -> String {
    match matched {
        Some(m) => m.as_str().to_string(),
        None if paths::is_api_path(path) => "(no route)".into(),
        None if paths::is_asset_path(path) => "(static asset)".into(),
        None => "(account site)".into(),
    }
}

/// Logs the request.
pub async fn observe(req: Request, next: Next) -> Response {
    let started = Instant::now();
    let method = req.method().clone();
    let path = req.uri().path().to_owned();
    let route = route_label(req.extensions().get::<MatchedPath>(), &path);
    let request_id = req
        .extensions()
        .get::<RequestId>()
        .map(|r| r.0.clone())
        .unwrap_or_default();
    let quiet = paths::is_health_path(&path);
    let span = tracing::info_span!("request", %method, route = %route, request_id = %request_id);
    let response = next.run(req).instrument(span).await;
    let status = response.status().as_u16();
    let duration_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
    if quiet {
        tracing::debug!(%method, %route, status, duration_ms, %request_id, "request");
    } else if status >= 500 {
        tracing::error!(%method, %route, status, duration_ms, %request_id, "request failed");
    } else {
        tracing::info!(%method, %route, status, duration_ms, %request_id, "request");
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_never_carry_raw_paths() {
        assert_eq!(route_label(None, "/v1/nope/abc"), "(no route)");
        assert_eq!(route_label(None, "/assets/app-1.js"), "(static asset)");
        assert_eq!(route_label(None, "/authorize/flow/xyz"), "(account site)");
    }
}
