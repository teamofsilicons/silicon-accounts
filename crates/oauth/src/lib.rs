//! # silicon-accounts-oauth (`accounts_oauth`)
//!
//! The OAuth 2.0 and OIDC surface of Silicon Accounts: how apps (and the silicon-accounts CLI)
//! turn a finished sign-in into tokens, keep them fresh, check them and end them.
//!
//! | route | what |
//! |---|---|
//! | `POST /v1/oauth/token` | every grant: `authorization_code`, `refresh_token`, `urn:silicon:params:oauth:grant-type:slt` (alias `slt`), `urn:ietf:params:oauth:grant-type:device_code`, `urn:ietf:params:oauth:grant-type:jwt-bearer`, `urn:ietf:params:oauth:grant-type:token-exchange` (a Silicon's trusted outside OIDC token; the sign-in ends when that token expires) |
//! | `POST /v1/oauth/revoke` | RFC 7009: ends the sign-in (token family) behind a refresh or access token; always 200 once the client is authenticated |
//! | `POST /v1/oauth/introspect` | RFC 7662: is this token of the calling app live right now? |
//! | `GET`/`POST /v1/userinfo` | the account as the token's app may see it, plus the OIDC claim names |
//! | `GET /.well-known/openid-configuration` | OIDC discovery |
//! | `GET /.well-known/jwks.json` | the Ed25519 key that signs access tokens and `id_tokens`, and the RS256 key of identity tokens |
//! | `POST /v1/device/authorize` | RFC 8628: starts a device sign-in for the silicon-accounts CLI |
//!
//! Rules that hold across the crate:
//! - `/v1/oauth/*` answer errors as RFC 6749 bodies (`{"error","error_description"}`) because
//!   generic OAuth/OIDC libraries expect them; every description says exactly what was wrong.
//!   Token, revocation and introspection responses are never cacheable (`Cache-Control: no-store`).
//! - Clients authenticate with HTTP Basic or `client_id` + `client_secret` in the body. Two
//!   first-party public clients need no secret, and each only ever touches its own tokens:
//!   `client_id=silicon-accounts` (the silicon-accounts CLI: the `refresh_token` and device-code grants, and
//!   revocation) and `client_id=developer` (the developer platform: `authorization_code` with
//!   PKCE S256 required, `refresh_token`, and revocation).
//! - An authorization code is consumed and its tokens issued in one transaction that holds the
//!   code's row lock: exactly one concurrent redemption wins, and every losing redemption runs
//!   after the winner committed, so the reuse path always revokes the winner's tokens
//!   (RFC 6749 §4.1.2). Any refused redemption burns the code.
//! - Grants that start a sign-in (code, SLT, device) decide under row locks: the account row
//!   (share) and then the membership row (update). STK rotation, account deletion and "remove
//!   app access" lock the same rows before revoking sign-ins, so a sign-in is never issued
//!   past such a change: the grant either sees the change and refuses, or the change sees and
//!   revokes the new sign-in. An SLT is refused when the Silicon's STK was rotated, or the
//!   account removed the app's access, after the SLT was issued (a code likewise for removal).
//! - An SLT minted by a sign-in from a trusted outside token (a CI job) starts an app sign-in
//!   that ends no later than that CI sign-in and is linked to its trust: the exchange refuses
//!   once the trust is removed (deciding under a share lock on the trust row, which removal
//!   update-locks first), and removing the trust later ends the app sign-in too.
//! - Apps that turned on `public_client` may exchange SLTs with their `client_id` alone (their
//!   command-line or desktop tool has no server for a secret); every other app sends its secret.
//! - An access token stops working at its `exp` on introspection and userinfo (no clock-skew
//!   leeway: this server issued it). An app's token reads the account (userinfo) only while the
//!   account's membership with the app is active, as introspection reports it.
//! - Refresh tokens rotate on every use; presenting a used one revokes its whole family and the
//!   app hears `membership.signed_out` (reason `refresh_token_reuse`).
//! - Contract numbers come from core: access tokens 1800 s (`ACCOUNTS_ACCESS_TOKEN_TTL_SECONDS`,
//!   which production pins), refresh families 900 days (absolute), codes and SLTs 120 s, device
//!   codes 600 s polled every 5 s (`accounts_core::repo::tokens`).
//! - Revocation, refresh-token reuse and code reuse are written to `audit_log` as
//!   `oauth.token_revoked`, `oauth.refresh_reuse_detected` and `oauth.code_reuse_detected`;
//!   SLT, device and token-exchange sign-ins to `signin_history` (methods `slt`, or
//!   `slt_public_client` when an app's public client exchanged the SLT without a secret, `device`
//!   and `federated`). Code exchanges
//!   don't add history: the consent step that issued the code already recorded the sign-in.

mod credentials;
mod device;
mod discovery;
mod grants;
mod introspect;
mod params;
mod respond;
mod revoke;
mod sweep;
mod token;
mod userinfo;

use accounts_core::AppState;
use axum::Router;
use axum::routing::{get, post};
use tokio::task::JoinHandle;

pub use device::DEVICE_AUTHORIZE_PER_IP;
pub use sweep::{GRANT_RETENTION_DAYS, PurgedGrants, purge_expired_grants};
pub use token::{DEVICE_CODE_GRANT_TYPE, SLT_GRANT_TYPE, TOKEN_EXCHANGE_GRANT_TYPE};

/// The `membership.signed_out` reason sent when a reused authorization code revokes the
/// tokens issued from it (core's `events::signout_reason::AUTHORIZATION_CODE_REUSE`).
pub const SIGNOUT_REASON_CODE_REUSE: &str =
    accounts_core::events::signout_reason::AUTHORIZATION_CODE_REUSE;

/// HTTP routes of this crate (merged into the API router by the server crate).
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/oauth/token", post(token::token))
        .route("/v1/oauth/revoke", post(revoke::revoke))
        .route("/v1/oauth/introspect", post(introspect::introspect))
        .route(
            "/v1/userinfo",
            get(userinfo::userinfo_get).post(userinfo::userinfo_post),
        )
        .route(
            "/.well-known/openid-configuration",
            get(discovery::openid_configuration),
        )
        .route("/.well-known/jwks.json", get(discovery::jwks))
        .route("/v1/device/authorize", post(device::authorize))
}

/// Background tasks of this crate: a sweep that deletes authorization codes, short-lived tokens
/// and device authorizations that expired more than [`GRANT_RETENTION_DAYS`] days ago.
#[must_use]
pub fn spawn_background(state: AppState) -> Vec<JoinHandle<()>> {
    vec![tokio::spawn(sweep::run(state))]
}
