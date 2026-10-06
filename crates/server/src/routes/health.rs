//! Liveness, readiness and service metadata.

use accounts_core::http::Json;
use accounts_core::{AppState, PRODUCT_NAME, VERSION};
use axum::extract::State;
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use serde_json::json;

/// `GET /healthz`: the process is up (no dependencies checked).
pub async fn healthz() -> Response {
    let mut r = (StatusCode::OK, "ok").into_response();
    r.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    r
}

/// `GET /readyz`: `200 {"database":"ok"}` when Postgres answers, else `503` with the reason.
pub async fn readyz(State(state): State<AppState>) -> Response {
    let mut r = match accounts_core::db::ping(&state.db).await {
        Ok(()) => (StatusCode::OK, Json(json!({ "database": "ok" }))).into_response(),
        Err(e) => {
            tracing::warn!(error = %e, "readiness check failed: the database did not answer");
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({
                    "database": "unavailable",
                    "error": {
                        "code": "database_unavailable",
                        "message": "Silicon Accounts can't reach its database, so it is not ready to serve requests.",
                        "hint": "Check that Postgres is running and ACCOUNTS_DATABASE_URL points at it."
                    }
                })),
            )
                .into_response()
        }
    };
    r.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    r
}

/// `GET /v1/meta` body.
#[derive(Debug, Clone, Serialize)]
pub struct Meta {
    pub name: &'static str,
    pub version: &'static str,
    pub environment: &'static str,
    pub public_url: String,
    pub silicon_apps_url: String,
    /// Where the published docs live (ACCOUNTS_DOCS_URL).
    pub docs_url: String,
    pub providers: Providers,
    pub delivery: &'static str,
}

/// Managed ("one click") sign-in providers configured on this deployment.
#[derive(Debug, Clone, Copy, Serialize)]
pub struct Providers {
    pub google: bool,
    pub apple: bool,
}

/// `GET /v1/meta`: what this deployment is and offers.
pub async fn meta(State(state): State<AppState>) -> Json<Meta> {
    let s = &state.settings;
    Json(Meta {
        name: PRODUCT_NAME,
        version: VERSION,
        environment: s.environment.as_str(),
        public_url: s.public_url.clone(),
        silicon_apps_url: s.silicon_apps_url.clone(),
        docs_url: s.docs_url.clone(),
        providers: Providers {
            google: s.google.managed_configured(),
            apple: s.apple.managed_configured(),
        },
        delivery: s.delivery.as_str(),
    })
}
