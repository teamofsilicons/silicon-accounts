//! # silicon-accounts-server (`accounts_server`)
//!
//! Composes the Silicon Accounts service:
//!
//! - [`build_router`]: every feature crate's router (auth, oauth, account, silicons, apps,
//!   proofs, worker) plus the server's own endpoints ([`routes`]: health, meta, reports,
//!   telemetry, dev outbox), the account site and its embed/SDK files ([`web`]), the fallback
//!   (JSON 404 for unknown API routes, the site for everything else), all wrapped in the
//!   middleware stack ([`middleware`]: request ids, logging + Space Station telemetry, security
//!   headers, CORS, JSON errors, body limits, time budgets, panic recovery).
//! - [`spawn_background`]: every crate's background tasks, with a graceful stop for the worker.
//! - [`first_party::sync_developer_app`]: at start-up, the stored redirect URI of the developer
//!   platform's first-party app follows `ACCOUNTS_DEVELOPER_URL`.
//! - [`shutdown_signal`]: Ctrl-C / SIGTERM.
//!
//! The binaries live in `src/bin/`: `accounts-api` (the service), `accounts-migrate` (applies
//! database migrations) and `accounts-seed` (loads the fake apps).

use accounts_core::AppState;
use axum::Router;

pub mod background;
pub mod first_party;
pub mod middleware;
pub mod paths;
pub mod routes;
pub mod web;

pub use background::{BackgroundTasks, spawn_background};
pub use middleware::Policy;

/// The complete service router with the standard [`Policy`].
pub fn build_router(state: AppState) -> Router {
    build_router_with(state, Policy::default())
}

/// The complete service router with a custom [`Policy`] (tests shorten time budgets).
pub fn build_router_with(state: AppState, policy: Policy) -> Router {
    let app = Router::new()
        .merge(accounts_auth::router())
        .merge(accounts_oauth::router())
        .merge(accounts_account::router())
        .merge(accounts_silicons::router())
        .merge(accounts_apps::router())
        .merge(accounts_proofs::router())
        .merge(accounts_worker::router())
        .merge(routes::router())
        .merge(web::router())
        .fallback(routes::fallback::fallback);
    middleware::apply(app, &state, policy).with_state(state)
}

/// Resolves on Ctrl-C or SIGTERM.
pub async fn shutdown_signal() {
    let ctrl_c = async {
        if let Err(e) = tokio::signal::ctrl_c().await {
            tracing::error!(error = %e, "could not listen for Ctrl-C");
            std::future::pending::<()>().await;
        }
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut s) => {
                s.recv().await;
            }
            Err(e) => {
                tracing::error!(error = %e, "could not listen for SIGTERM");
                std::future::pending::<()>().await;
            }
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    tracing::info!("shutdown requested: finishing in-flight requests");
}

/// `postgres://role:***@host/db` — a database URL safe to print (the password is masked).
pub fn redact_database_url(raw: &str) -> String {
    match url::Url::parse(raw) {
        Ok(mut u) => {
            if u.password().is_some() {
                let _ = u.set_password(Some("***"));
            }
            u.to_string()
        }
        Err(_) => "<unparseable database URL>".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_passwords() {
        assert_eq!(
            redact_database_url("postgres://u:secret@h:5432/db"),
            "postgres://u:***@h:5432/db"
        );
        assert_eq!(
            redact_database_url("postgres://postgres@127.0.0.1:5444/x"),
            "postgres://postgres@127.0.0.1:5444/x"
        );
    }
}
