//! Request logging and Space Station telemetry.
//!
//! Each request runs inside a `request` span (method, route, request id), so every log line a
//! handler writes carries the request id. When it finishes, one line is logged and one
//! self-contained `http.request` event goes to Space Station: source `api`, step
//! `"{METHOD} {route template}"`, progress 1.0 (the request is answered), and the method,
//! route, status, outcome and duration.
//! Only route templates are recorded (`/v1/flows/{id}/verify`), never raw paths or query
//! strings, which can carry ids and OAuth codes. Health probes and static files are skipped,
//! and so is any request that carries `X-Accounts-Telemetry: off` (the caller opted out).

use std::time::Instant;

use accounts_core::AppState;
use accounts_core::http::RequestId;
use axum::extract::{MatchedPath, Request, State};
use axum::middleware::Next;
use axum::response::Response;
use serde_json::json;
use tracing::Instrument as _;

use crate::paths;

/// Header with which callers opt out of telemetry.
pub const TELEMETRY_HEADER: &str = "x-accounts-telemetry";

/// True when the request opted out of telemetry (`X-Accounts-Telemetry: off`).
pub fn opted_out(headers: &axum::http::HeaderMap) -> bool {
    headers
        .get(TELEMETRY_HEADER)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| {
            matches!(
                v.trim().to_ascii_lowercase().as_str(),
                "off" | "0" | "false" | "no"
            )
        })
}

/// The route label: the matched template, or what kind of unmatched request it was.
fn route_label(matched: Option<&MatchedPath>, path: &str) -> String {
    match matched {
        Some(m) => m.as_str().to_string(),
        None if paths::is_api_path(path) => "(no route)".into(),
        None if paths::is_asset_path(path) => "(static asset)".into(),
        None => "(account site)".into(),
    }
}

/// Logs the request and records the telemetry event.
pub async fn observe(State(state): State<AppState>, req: Request, next: Next) -> Response {
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
    let record = !quiet
        && !opted_out(req.headers())
        && !paths::is_asset_path(&path)
        && route != "(account site)";
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
    if record {
        let outcome = match status {
            500.. => "server_error",
            400..=499 => "client_error",
            _ => "ok",
        };
        state.telemetry.record_progress(
            "api",
            &format!("{method} {route}"),
            "http.request",
            Some(1.0),
            json!({
                "method": method.as_str(),
                "route": route,
                "status": status,
                "outcome": outcome,
                "duration_ms": duration_ms,
                "request_id": request_id,
            }),
        );
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderMap;

    #[test]
    fn opt_out_header() {
        let mut h = HeaderMap::new();
        assert!(!opted_out(&h));
        h.insert(TELEMETRY_HEADER, "OFF".parse().expect("hv"));
        assert!(opted_out(&h));
        h.insert(TELEMETRY_HEADER, "on".parse().expect("hv"));
        assert!(!opted_out(&h));
    }

    #[test]
    fn labels_never_carry_raw_paths() {
        assert_eq!(route_label(None, "/v1/nope/abc"), "(no route)");
        assert_eq!(route_label(None, "/assets/app-1.js"), "(static asset)");
        assert_eq!(route_label(None, "/authorize/flow/xyz"), "(account site)");
    }
}
