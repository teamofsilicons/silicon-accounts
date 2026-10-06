//! Endpoints owned by the server crate (02-api.md, marked [server]):
//!
//! | route | auth | |
//! |---|---|---|
//! | `GET /healthz` | public | liveness: `200 ok` |
//! | `GET /readyz` | public | readiness: `200 {"database":"ok"}` or `503` |
//! | `GET /v1/meta` | public | service name, version, environment, URLs (public, Silicon Apps, docs), providers, delivery |
//! | `POST /v1/reports` | optional session | bug report mailed to the report recipients |
//! | `POST /v1/telemetry/events` | public | client telemetry forwarded to Space Station |
//! | `GET /v1/dev/outbox` | public, dev only | messages recorded by the service (with OTP codes) |
//!
//! Plus the fallback: JSON 404 for unknown API routes, the account site for everything else.

use accounts_core::AppState;
use axum::Router;
use axum::routing::{get, post};

pub mod dev;
pub mod fallback;
pub mod health;
pub mod reports;
pub mod telemetry;

/// The server crate's routes.
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/healthz", get(health::healthz))
        .route("/readyz", get(health::readyz))
        .route("/v1/meta", get(health::meta))
        .route("/v1/reports", post(reports::create))
        .route("/v1/telemetry/events", post(telemetry::ingest))
        .route("/v1/dev/outbox", get(dev::outbox))
}
