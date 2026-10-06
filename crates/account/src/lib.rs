//! # silicon-accounts-account (`accounts_account`)
//!
//! Account management for a signed-in Carbon or Silicon, plus the public account lookups:
//!
//! | route | auth | what |
//! |---|---|---|
//! | `GET /v1/ids/available?id=` | public (120/min per IP) | can this `c:`/`si:` id be taken (or reclaimed by me)? |
//! | `GET /v1/accounts/{uuid}` | app or session (600/min per caller) | AccountSummary (+ `custodian` for Silicons) |
//! | `GET /v1/accounts/by-id/{id}` | app or session (600/min per caller) | AccountSummary of the current owner of an id |
//! | `GET` / `PATCH` / `DELETE /v1/me` | session | the Me view; profile changes; account deletion (Carbons) |
//! | `POST /v1/me/id` | session | change my id (old id reserved 10 days, reclaimable; 5 changes per 24 h) |
//! | `POST` / `DELETE /v1/me/photo`, `GET /v1/photos/{id}` | session / public | profile photos |
//! | `/v1/me/emails…`, `/v1/me/phones…` | session (Carbon) | add (code), verify, primary, remove |
//! | `/v1/me/identities…` | session (Carbon) | linked Google/Apple identities |
//! | `/v1/me/apps…` | session | apps I signed into; remove an app's access |
//! | `/v1/me/sessions…` | session | browser sessions and first-party sign-ins; revoke |
//! | `GET /v1/me/history` | session | one timeline over sign-ins, id changes, custodians, proofs, app access and account changes |
//!
//! Everything shared (auth extractors, repositories, webhook events, errors) comes from
//! `accounts_core`; see `crates/core/README.md`. The exact shapes are in this crate's README.

use std::time::Duration;

use accounts_core::{ApiResult, AppState};
use axum::Router;
use axum::routing::{delete, get, post};
use sqlx::PgPool;
use tokio::task::JoinHandle;

mod caller;
mod contacts;
mod deletion;
mod history;
mod identities;
pub mod image;
mod lookup;
mod my_apps;
mod photos;
mod profile;
mod sessions;
mod util;

pub use contacts::{CONTACT_ADDS_PER_ACCOUNT, CONTACT_ADDS_PER_IP};
pub use lookup::LOOKUPS_PER_MINUTE;
pub use photos::{MAX_PHOTO_BYTES, PHOTO_UPLOADS_PER_HOUR};
pub use profile::{ID_CHANGE_WINDOW_SECONDS, ID_CHANGES_PER_DAY};

/// HTTP routes of this crate (see the build spec 02-api.md, sections marked [account]).
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/ids/available", get(lookup::id_available))
        .route("/v1/accounts/by-id/{id}", get(lookup::by_id))
        .route("/v1/accounts/{uuid}", get(lookup::by_uuid))
        .route(
            "/v1/me",
            get(profile::get_me)
                .patch(profile::patch_me)
                .delete(deletion::delete_me),
        )
        .route("/v1/me/id", post(profile::change_id))
        .route("/v1/me/photo", post(photos::upload).delete(photos::remove))
        .route("/v1/photos/{id}", get(photos::serve))
        .route(
            "/v1/me/emails",
            get(contacts::list_emails).post(contacts::add_email),
        )
        .route("/v1/me/emails/verify", post(contacts::verify_email))
        .route(
            "/v1/me/emails/{email}/primary",
            post(contacts::make_email_primary),
        )
        .route("/v1/me/emails/{email}", delete(contacts::remove_email))
        .route(
            "/v1/me/phones",
            get(contacts::list_phones).post(contacts::add_phone),
        )
        .route("/v1/me/phones/verify", post(contacts::verify_phone))
        .route(
            "/v1/me/phones/{phone}/primary",
            post(contacts::make_phone_primary),
        )
        .route("/v1/me/phones/{phone}", delete(contacts::remove_phone))
        .route("/v1/me/identities", get(identities::list))
        .route(
            "/v1/me/identities/{provider}/{subject}",
            delete(identities::unlink),
        )
        .route("/v1/me/apps", get(my_apps::list))
        .route("/v1/me/apps/{app_id}", delete(my_apps::remove_access))
        .route("/v1/me/sessions", get(sessions::list))
        .route("/v1/me/sessions/{id}", delete(sessions::revoke))
        .route("/v1/me/history", get(history::list))
}

/// How often the reservation sweep runs.
const SWEEP_EVERY: Duration = Duration::from_secs(3600);

/// Background tasks of this crate: an hourly sweep that deletes id reservations that ended over
/// a day ago (expired reservations are already ignored everywhere; this only keeps the table
/// small).
pub fn spawn_background(state: AppState) -> Vec<JoinHandle<()>> {
    vec![tokio::spawn(async move {
        let mut tick = tokio::time::interval(SWEEP_EVERY);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tick.tick().await;
            match sweep_expired_reservations(&state.db).await {
                Ok(0) => {}
                Ok(n) => tracing::debug!(removed = n, "swept expired id reservations"),
                Err(e) => {
                    tracing::warn!(error = %e, "id reservation sweep failed; retrying next hour")
                }
            }
        }
    })]
}

/// Deletes id reservations (old ids held for their previous owner) that ended over a day ago.
/// Returns how many rows were removed.
pub async fn sweep_expired_reservations(db: &PgPool) -> ApiResult<u64> {
    Ok(sqlx::query(
        "delete from handle_reservations where reserved_until < now() - interval '1 day'",
    )
    .execute(db)
    .await?
    .rows_affected())
}
