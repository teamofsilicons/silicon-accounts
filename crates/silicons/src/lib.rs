//! # silicon-accounts-silicons (`accounts_silicons`)
//!
//! Everything about Silicon accounts that is not generic account management:
//!
//! | endpoint | auth | what |
//! |---|---|---|
//! | `POST /v1/silicons` | public, IDEMPOTENT | a Silicon creates its own account and names its custodian (c:id or email) |
//! | `GET /v1/silicons/requests/{id}` | `Bearer sarq_…` | the custodian's decision, for the waiting Silicon |
//! | `POST /v1/silicons/login` | public | si:id + STK, or a key-signed assertion → first-party tokens |
//! | `GET`/`POST /v1/silicons/{id}/keys`, `DELETE …/keys/{key_id}` | the Silicon or its custodian | the Silicon's Ed25519 keys |
//! | `GET`/`POST /v1/silicons/{id}/federations`, `DELETE …/federations/{federation_id}` | the Silicon or its custodian | trust relationships: which outside OIDC tokens (CI jobs) sign the Silicon in |
//! | `GET`/`PUT /v1/silicons/{id}/identity-audiences` | the Silicon or its custodian (`PUT`: the custodian) | the outside services the Silicon may get identity tokens for |
//! | `POST /v1/me/identity-tokens` | session (Silicon) | an OIDC identity token for one allowed outside audience (AWS, Google Cloud, Microsoft Entra) |
//! | `POST /v1/me/short-lived-tokens` | session | a 2-minute single-use token to sign into one app |
//! | `PUT`/`DELETE /v1/me/webhook`, `POST /v1/me/webhook/test` | session (Silicon) | the Silicon's own webhook |
//! | `GET /v1/me/webhook/deliveries[/{id}]`, `POST /v1/me/webhook/replay` (IDEMPOTENT) | session (Silicon) | its webhook's deliveries: list, inspect, replay |
//! | `/v1/me/silicons…` | session (Carbon) | the custodian's side: create, view, edit, photo upload, id, webhook (and its deliveries), STK, transfer, delete, the Silicon's apps, sign-ins and allowed apps |
//! | `/v1/me/custodian-requests…` | session (Carbon) | requests addressed to me: list, accept, decline |
//!
//! [`spawn_background`] starts the custodian-request expiry sweep (every minute). Overdue
//! requests are also expired the moment anything reads them, so nothing depends on the sweep's
//! timing.
//!
//! Limits: 10 self-creations per hour per IP (the contract number; only successful ones count)
//! plus [`SELF_CREATE_ATTEMPTS_PER_IP`] attempts of any outcome; at most
//! [`MAX_PENDING_PER_CUSTODIAN`] self-created Silicons waiting for the same c:id or email
//! address; [`MAX_STK_FAILURES`] wrong STKs lock sign-in for [`LOCK_SECONDS`];
//! [`WEBHOOK_TESTS_PER_SILICON`] test pings per hour.
//!
//! Responses carrying a freshly generated secret (STK, `sarq_` request token, `whsec_` webhook
//! secret) are replayable with an Idempotency-Key for 10 minutes and stored sealed with the
//! keyring meanwhile, never in clear (core's `idempotency::run` with `secret_bearing`).
//!
//! Generic self-service (`GET/PATCH /v1/me`, `POST /v1/me/id`) for Silicons lives in the account
//! crate. Shared rules (ids, STK format, events, delivery, extractors) come from `accounts_core`.

mod common;
mod custodian;
mod custodian_apps;
mod custodian_requests;
mod federations;
mod history;
mod identity;
mod input;
mod keys;
mod lifecycle;
mod login;
mod notify;
mod own_webhook;
mod requests;
mod self_create;
mod slt;
mod stk;
pub mod sweep;
mod views;
mod webhook_deliveries;

use accounts_core::AppState;
use axum::Router;
use axum::http::HeaderValue;
use axum::http::header::{CACHE_CONTROL, PRAGMA};
use axum::response::Response;
use axum::routing::{get, post, put};
use tokio::task::JoinHandle;

pub use identity::IDENTITY_TOKENS_PER_SILICON;
pub use login::{LOCK_SECONDS, MAX_STK_FAILURES};
pub use own_webhook::WEBHOOK_TESTS_PER_SILICON;
pub use requests::{MAX_PENDING_PER_CUSTODIAN, REQUEST_TTL_DAYS};
pub use self_create::SELF_CREATE_ATTEMPTS_PER_IP;
pub use sweep::{SWEEP_INTERVAL, SweepReport, expire_overdue};
pub use webhook_deliveries::MAX_REPLAY;

/// HTTP routes of this crate (see the table above and the build spec 02-api.md).
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/silicons", post(self_create::create))
        .route("/v1/silicons/login", post(login::login))
        .route("/v1/silicons/{id}/keys", get(keys::list).post(keys::add))
        .route(
            "/v1/silicons/{id}/keys/{key_id}",
            axum::routing::delete(keys::revoke),
        )
        .route(
            "/v1/silicons/{id}/federations",
            get(federations::list).post(federations::add),
        )
        .route(
            "/v1/silicons/{id}/federations/{federation_id}",
            axum::routing::delete(federations::remove),
        )
        .route(
            "/v1/silicons/{id}/identity-audiences",
            get(identity::get_audiences).put(identity::set_audiences),
        )
        .route("/v1/me/identity-tokens", post(identity::issue))
        .route(
            "/v1/silicons/requests/{id}",
            get(self_create::request_status),
        )
        .route("/v1/me/short-lived-tokens", post(slt::create))
        .route(
            "/v1/me/webhook",
            put(own_webhook::set).delete(own_webhook::remove),
        )
        .route("/v1/me/webhook/test", post(own_webhook::test))
        .route(
            "/v1/me/webhook/deliveries",
            get(webhook_deliveries::own_list),
        )
        .route(
            "/v1/me/webhook/deliveries/{id}",
            get(webhook_deliveries::own_show),
        )
        .route(
            "/v1/me/webhook/replay",
            post(webhook_deliveries::own_replay),
        )
        .route(
            "/v1/me/silicons",
            get(custodian::list).post(custodian::create),
        )
        .route(
            "/v1/me/silicons/{uuid}",
            get(custodian::show)
                .patch(custodian::update)
                .delete(custodian::delete),
        )
        .route("/v1/me/silicons/{uuid}/id", post(custodian::change_id))
        .route(
            "/v1/me/silicons/{uuid}/photo",
            post(custodian::upload_photo),
        )
        .route(
            "/v1/me/silicons/{uuid}/webhook",
            put(custodian::set_webhook).delete(custodian::remove_webhook),
        )
        .route(
            "/v1/me/silicons/{uuid}/webhook/deliveries",
            get(webhook_deliveries::custodian_list),
        )
        .route(
            "/v1/me/silicons/{uuid}/webhook/deliveries/{id}",
            get(webhook_deliveries::custodian_show),
        )
        .route(
            "/v1/me/silicons/{uuid}/webhook/replay",
            post(webhook_deliveries::custodian_replay),
        )
        .route("/v1/me/silicons/{uuid}/stk", post(custodian::rotate_stk))
        .route(
            "/v1/me/silicons/{uuid}/apps",
            get(custodian_apps::list_apps),
        )
        .route(
            "/v1/me/silicons/{uuid}/apps/{app_id}",
            axum::routing::delete(custodian_apps::remove_app),
        )
        .route(
            "/v1/me/silicons/{uuid}/signins",
            get(custodian_apps::list_signins),
        )
        .route(
            "/v1/me/silicons/{uuid}/allowed-apps",
            get(custodian_apps::get_allowed_apps).put(custodian_apps::set_allowed_apps),
        )
        .route(
            "/v1/me/silicons/{uuid}/transfer",
            post(custodian::transfer).delete(custodian::cancel_transfer),
        )
        .route("/v1/me/custodian-requests", get(custodian_requests::list))
        .route(
            "/v1/me/custodian-requests/{id}/accept",
            post(custodian_requests::accept),
        )
        .route(
            "/v1/me/custodian-requests/{id}/decline",
            post(custodian_requests::decline),
        )
        .layer(axum::middleware::map_response(no_store))
}

/// Every response here is account-specific and many carry secrets (STKs, tokens, SLTs, webhook
/// secrets), so nothing may be cached (RFC 6749 §5.1 for the token responses).
async fn no_store(mut response: Response) -> Response {
    let headers = response.headers_mut();
    headers
        .entry(CACHE_CONTROL)
        .or_insert(HeaderValue::from_static("no-store"));
    headers
        .entry(PRAGMA)
        .or_insert(HeaderValue::from_static("no-cache"));
    response
}

/// Background tasks of this crate: the custodian-request expiry sweep. `accounts-api` starts
/// them when ACCOUNTS_WORKER_ENABLED is true.
pub fn spawn_background(state: AppState) -> Vec<JoinHandle<()>> {
    vec![sweep::spawn(state)]
}
