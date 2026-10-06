//! # silicon-accounts-proofs (`accounts_proofs`)
//!
//! Proofs: Silicon Accounts issues and verifies them; consent screens and what each endpoint
//! does stay with the apps (UNDERSTANDING.md, "Proofs (OBO and ATA)").
//!
//! - **OBO** (on behalf of): app A got an account's consent itself and holds the account's
//!   access token; it trades that token (`subject_token`) for a proof that app B verifies. The
//!   proof stands on the account's sign-in at app A and dies with it (sign-in revoked or expired,
//!   app access removed, account deleted).
//! - **ATA** (app to app): app A gets a proof for the apps it names (the audiences); each of
//!   them can verify that the token really comes from app A.
//!
//! Proofs follow the sign-in token logic: a proof token (`sap_…`, 60..1800 s, default 1800 s)
//! plus a proof refresh token (`sapr_…`) kept by the issuing app, rotated on every refresh, with
//! reuse detection (presenting a used refresh token revokes the proof). A proof lives at most
//! 900 days. Only `HMAC(pepper, token)` is stored.
//!
//! | route | auth | |
//! |---|---|---|
//! | `POST /v1/proofs/obo` | app | issue an OBO proof (IDEMPOTENT) |
//! | `POST /v1/proofs/ata` | app | issue an ATA proof (IDEMPOTENT) |
//! | `POST /v1/proofs/refresh` | issuing app | rotate (optional `Idempotency-Key`) |
//! | `POST /v1/proofs/verify` | receiving app | `{"valid":true,…}` or exactly `{"valid":false,"expires_at":null}` |
//! | `POST /v1/proofs/revoke` | issuing app | by `proof_id`, `proof_token` or `proof_refresh_token` |
//! | `GET /v1/apps/{app_id}/proofs` | app or owner | proofs the app issued |
//! | `POST /v1/apps/{app_id}/proofs/ata` | app or owner | the ATA page stand-in (IDEMPOTENT) |
//! | `DELETE /v1/apps/{app_id}/proofs/{proof_id}` | app or owner | revoke |
//! | `GET /v1/me/proofs` | session | OBO proofs issued on my behalf |
//! | `DELETE /v1/me/proofs/{proof_id}` | session | revoke one |
//!
//! Verification is one indexed query (token → family → issuing app, plus the OBO grant rows by
//! primary key) after the verifying app's credentials pass the 60 s in-memory credential cache.

pub mod handlers;
pub mod input;
pub mod issue;
pub mod model;
pub mod refresh;
pub mod store;
pub mod subject;
pub mod views;

use std::time::Duration;

use accounts_core::AppState;
use axum::Router;
use axum::routing::{delete, get, post};
use tokio::task::JoinHandle;

/// HTTP routes of this crate (see the module docs and the build spec 02-api.md).
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/proofs/obo", post(handlers::issue_obo))
        .route("/v1/proofs/ata", post(handlers::issue_ata))
        .route("/v1/proofs/refresh", post(handlers::refresh))
        .route("/v1/proofs/verify", post(handlers::verify))
        .route("/v1/proofs/revoke", post(handlers::revoke))
        .route("/v1/apps/{app_id}/proofs", get(handlers::list_app_proofs))
        .route(
            "/v1/apps/{app_id}/proofs/ata",
            post(handlers::issue_ata_for_app),
        )
        .route(
            "/v1/apps/{app_id}/proofs/{proof_id}",
            delete(handlers::revoke_app_proof),
        )
        .route("/v1/me/proofs", get(handlers::list_my_proofs))
        .route(
            "/v1/me/proofs/{proof_id}",
            delete(handlers::revoke_my_proof),
        )
}

/// How long after start the first sweep runs, and how often after that.
const SWEEP_FIRST_DELAY: Duration = Duration::from_secs(120);
const SWEEP_EVERY: Duration = Duration::from_secs(3600);

/// Background tasks: an hourly sweep that stores the end of OBO proofs whose sign-in was
/// revoked and deletes proof tokens nobody can use any more (see [`store::sweep`]). Proof rows
/// stay as history.
pub fn spawn_background(state: AppState) -> Vec<JoinHandle<()>> {
    let pool = state.db.clone();
    vec![tokio::spawn(async move {
        let mut tick =
            tokio::time::interval_at(tokio::time::Instant::now() + SWEEP_FIRST_DELAY, SWEEP_EVERY);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tick.tick().await;
            match store::sweep(&pool).await {
                Ok(r)
                    if r.sign_in_revocations_recorded
                        + r.expired_access_tokens
                        + r.dead_family_tokens
                        > 0 =>
                {
                    tracing::info!(
                        sign_in_revocations_recorded = r.sign_in_revocations_recorded,
                        expired_access_tokens = r.expired_access_tokens,
                        dead_family_tokens = r.dead_family_tokens,
                        "proof sweep"
                    )
                }
                Ok(_) => {}
                Err(e) => {
                    tracing::warn!(error = %e, "proof sweep failed; retrying next hour")
                }
            }
        }
    })]
}
