//! Requests no route matched: unknown API paths get a JSON 404; everything else is the account
//! site (static files, or `index.html` for client-side routes) when ACCOUNTS_WEB_DIST is set.

use accounts_core::{ApiError, AppState};
use axum::extract::{Request, State};
use axum::http::Method;
use axum::response::{IntoResponse, Response};

use crate::paths;

/// 404 `route_not_found` for an unknown endpoint.
pub fn route_not_found(method: &Method, path: &str) -> ApiError {
    ApiError::not_found(
        "route_not_found",
        format!("There is no endpoint {method} {path} in Silicon Accounts."),
    )
    .hint("Check the method and the path: the API lives under /v1 and /.well-known (the API server itself also answers /healthz and /readyz). GET /v1/meta describes this server; the API reference is at https://accounts.teamofsilicons.com/docs.")
}

/// The router's fallback.
pub async fn fallback(State(state): State<AppState>, req: Request) -> Response {
    let method = req.method().clone();
    let path = req.uri().path().to_owned();
    if paths::is_api_path(&path) {
        return route_not_found(&method, &path).into_response();
    }
    let Some(dist) = state.settings.web_dist.clone() else {
        return ApiError::not_found(
            "route_not_found",
            format!(
                "There is no endpoint {method} {path}: this server only serves the API, because ACCOUNTS_WEB_DIST is not set."
            ),
        )
        .hint(format!(
            "Open the account site at {}, call an endpoint under /v1, or set ACCOUNTS_WEB_DIST to the built site (web/dist).",
            state.settings.public_url
        ))
        .into_response();
    };
    if method != Method::GET && method != Method::HEAD {
        return route_not_found(&method, &path).into_response();
    }
    crate::web::serve_site(&dist, req).await
}
