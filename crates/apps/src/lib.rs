//! # silicon-accounts-apps (`accounts_apps`)
//!
//! Everything Silicon Accounts does for apps, except proofs and the token endpoint:
//!
//! | area | routes | module |
//! |---|---|---|
//! | public config (CORS `*`) | `GET /v1/apps/{app_id}/public` | [`apps`] |
//! | apps a Carbon owns | `GET /v1/me/owned-apps` | [`apps`] |
//! | app details (secrets masked, stats) | `GET /v1/apps/{app_id}` | [`apps`] |
//! | sign-in setup + branding | `PATCH /v1/apps/{app_id}/signin-config`, `GET …/signin-config/history` | [`signin_config`] |
//! | user base | `GET /v1/apps/{app_id}/users`, `GET …/users/{uuid}` | [`users`] |
//! | user imports | `POST|GET /v1/apps/{app_id}/imports`, `GET …/imports/{job_id}`, `GET …/imports/{job_id}/rows` | [`imports`] |
//! | app webhook | `PUT|DELETE /v1/apps/{app_id}/webhook`, `POST …/webhook/rotate-secret`, `POST …/webhook/test`, `GET …/webhook/deliveries[/{id}]`, `POST …/webhook/replay` | [`webhooks`] |
//! | Silicon Apps stand-in | `POST /v1/internal/apps/sync`, [`seed_fake_apps`] (used by `accounts-seed`) | [`sync`] |
//!
//! Auth: `/v1/apps/{app_id}/…` management routes take the app's own credentials
//! (`Authorization: Basic base64(app_id:app_secret)`) or the session of the Carbon who owns
//! the app (`accounts_core::http::AppOrOwner`). The sync route takes
//! `Authorization: Bearer <ACCOUNTS_INTERNAL_TOKEN>`.
//!
//! Background work: [`spawn_background`] runs the import job worker (claims queued jobs,
//! processes them in chunks of 500 rows per transaction, resumes jobs a crashed process left
//! behind). Tests drive the same code synchronously with [`imports::run_pending_jobs`].
//!
//! Server notes: the import route reads its body itself (up to 50 MB + 64 KB, after taking one
//! of the process's import slots, see [`imports::limits`]) and the sync route takes up to 5 MB
//! (route-level `DefaultBodyLimit`); a global hard body limit must not be smaller than that for
//! those two routes. `/v1/apps/{app_id}/public` sets `Access-Control-Allow-Origin: *` itself.

use accounts_core::AppState;
use axum::Router;
use tokio::task::JoinHandle;

pub mod apps;
pub mod imports;
pub mod signin_config;
pub mod sync;
pub mod users;
pub mod webhooks;

mod account_verification;
mod service_mail;
mod util;

pub use sync::{SeedError, SiliconAppsApp, SyncMode, SyncReport, SyncedApp, seed_fake_apps};

/// HTTP routes of this crate (see the module table above and the build spec 02-api.md).
pub fn router() -> Router<AppState> {
    Router::new()
        .merge(apps::router())
        .merge(signin_config::router())
        .merge(users::router())
        .merge(imports::router())
        .merge(webhooks::router())
        .merge(sync::router())
        .merge(service_mail::router())
        .merge(account_verification::router())
}

/// Background tasks of this crate: the import job worker.
pub fn spawn_background(state: AppState) -> Vec<JoinHandle<()>> {
    vec![imports::spawn_worker(state)]
}
