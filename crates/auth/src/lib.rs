//! # silicon-accounts-auth (`accounts_auth`)
//!
//! Signing Carbons in. This crate owns:
//!
//! - **The hosted sign-in flow** (`/v1/flows/*`), driven by the SPA at `/authorize`:
//!   `choose_method → verify_code → (signup | requirements | consent | complete)`. Email and
//!   phone codes, sign-up with a 48-hour sign-up session, the requirements step (add a missing
//!   email or phone with an inline code), the what's-shared (consent) screen and the
//!   authorization code that ends the flow. See [`flow`].
//! - **Google and Apple** (`/v1/flows/{id}/oauth/{provider}` and
//!   `/v1/oauth/callback/{provider}`): one-click (managed) or bring-your-own credentials, the
//!   Apple ES256 client secret, id_token verification against the provider's JWKS and identity
//!   linking. See [`providers`].
//! - **Connecting Google or Apple to a signed-in Carbon** (`POST /v1/me/identities/{provider}`,
//!   the account site's "Connect Google"): a provider round trip in the browser that links the
//!   provider account and adds its verified email without a code. See [`link`].
//! - **Browser sessions** (`/v1/session`, `/v1/session/signout`).
//! - **Device approval** (`/v1/device/{user_code}`, `…/approve`, `…/deny`): the browser half of
//!   the CLI device flow (the oauth crate owns `/v1/device/authorize` and the polling grant).
//! - **CLI code sign-in** (`/v1/cli/login/start`, `/v1/cli/login/verify`).
//!
//! Two rules every sign-in path here follows, both enforced by core:
//!
//! - only a **verified** email or phone identifies an account (an unfinished import is the one
//!   exception), and whoever proves an address takes over an unproven row of it: core's
//!   `repo::contacts::lookup` / `after_proof`; finishing an import removes its unproven
//!   addresses (`repo::accounts::finish_claim`);
//! - the 10-tries code lockout counts **per address**, across flows, the CLI, requirement codes
//!   and the account site's add codes: core's `repo::otp::verify`.
//!
//! Everything shared (extractors, repositories, events, errors, cookies) comes from
//! `accounts_core`; this crate only adds what is specific to signing in. The only tables it
//! owns are `signin_flows` and `signup_sessions`; it reads and writes the shared ones through
//! core's repositories.

use accounts_core::AppState;
use axum::Router;
use axum::routing::{get, post};
use tokio::task::JoinHandle;

mod cli_login;
mod device;
pub mod flow;
pub mod link;
pub mod providers;
mod session;
pub mod suggest;
pub mod sweep;
mod util;

/// HTTP routes of this crate (see the build spec 02-api.md, sections marked `[auth]`).
pub fn router() -> Router<AppState> {
    Router::new()
        // Hosted sign-in flow.
        .route("/v1/flows", post(flow::create::create_flow))
        .route("/v1/flows/{id}", get(flow::handlers::get_flow))
        .route("/v1/flows/{id}/continue", post(flow::handlers::continue_as))
        .route(
            "/v1/flows/{id}/switch",
            post(flow::handlers::switch_account),
        )
        .route(
            "/v1/flows/{id}/email",
            post(flow::handlers::send_email_code),
        )
        .route(
            "/v1/flows/{id}/phone",
            post(flow::handlers::send_phone_code),
        )
        .route("/v1/flows/{id}/resend", post(flow::handlers::resend_code))
        .route("/v1/flows/{id}/verify", post(flow::handlers::verify_code))
        // Connecting Google/Apple to the signed-in Carbon (account site).
        .route("/v1/me/identities/{provider}", post(link::start_link))
        .route("/v1/flows/{id}/signup", post(flow::signup::submit_signup))
        .route(
            "/v1/flows/{id}/signup/photo",
            post(flow::signup::upload_signup_photo),
        )
        .route(
            "/v1/flows/{id}/requirements/email",
            post(flow::requirements::send_email_requirement),
        )
        .route(
            "/v1/flows/{id}/requirements/phone",
            post(flow::requirements::send_phone_requirement),
        )
        .route(
            "/v1/flows/{id}/requirements/verify",
            post(flow::requirements::verify_requirement),
        )
        .route(
            "/v1/flows/{id}/consent",
            post(flow::consent::submit_consent),
        )
        // Google and Apple.
        .route(
            "/v1/flows/{id}/oauth/{provider}",
            post(providers::start::start_provider),
        )
        .route(
            "/v1/oauth/callback/{provider}",
            get(providers::callback::callback_get).post(providers::callback::callback_post),
        )
        // Browser session.
        .route("/v1/session", get(session::get_session))
        .route("/v1/session/signout", post(session::signout))
        // Device approval (the CLI device flow's browser half).
        .route("/v1/device/{user_code}", get(device::show))
        .route("/v1/device/{user_code}/approve", post(device::approve))
        .route("/v1/device/{user_code}/deny", post(device::deny))
        // CLI code sign-in.
        .route("/v1/cli/login/start", post(cli_login::start))
        .route("/v1/cli/login/verify", post(cli_login::verify))
}

/// Background tasks: a sweep that deletes long-expired sign-in flows and sign-up sessions.
pub fn spawn_background(state: AppState) -> Vec<JoinHandle<()>> {
    vec![sweep::spawn(state)]
}
