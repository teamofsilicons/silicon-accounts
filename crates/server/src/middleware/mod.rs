//! The middleware stack every request passes through, outermost first:
//!
//! 1. `request_id` (core) — assigns/echoes `X-Request-Id` and scopes it for error bodies.
//! 2. [`linger`] — reads (and throws away) whatever request body the rest of the stack answered
//!    without reading to the end (a 413 for a declared Content-Length over the limit, a 401 on
//!    an upload), so a client or proxy still uploading gets the answer instead of a reset
//!    connection. With `Expect: 100-continue` it wraps the answer's body itself, so it sits
//!    outside every layer that might read an answer's body.
//! 3. [`observe`] — one log line per request (inside a span carrying the request id) and a
//!    Space Station `http.request` event with the route template, method, status and duration.
//! 4. [`policy`] — security headers + CSP, CORS (`*` only for an app's public config, the SDK
//!    and discovery; no CORS headers anywhere else), and JSON bodies for error responses that
//!    were produced as plain text (405s, framework rejections).
//! 5. [`version`]: API version negotiation. `Accounts-Version` on the request pins a
//!    version (an unknown one is 400 `unsupported_version`), and every API answer says which
//!    version served it.
//! 6. `DefaultBodyLimit::disable()` + [`limits`] — the per-route body limit (64 KB default,
//!    2 MB `POST /v1/me/photo`, 50 MB `POST /v1/apps/{app_id}/imports`, 5 MB
//!    `POST /v1/internal/apps/sync`, 512 KB `PATCH /v1/apps/{app_id}/signin-config`), enforced
//!    on the declared `Content-Length` and on the body stream itself, and the per-route time
//!    budget (30 s; 60 s photo and sync; 5 min imports).
//! 7. [`panic`] — a panicking handler becomes a 500 JSON error with the request id.
//!
//! Errors made by these layers use the API error object, except on `/v1/oauth/token`,
//! `/v1/oauth/revoke` and `/v1/oauth/introspect`, which get RFC 6749 bodies ([`errors`]).
//!
//! The layers are applied with `Router::layer`, so they run after routing: [`observe`] sees
//! the matched route template, and the fallback (404 / SPA) gets the same treatment.

use accounts_core::AppState;
use accounts_core::http::request_id;
use axum::Router;
use axum::extract::DefaultBodyLimit;

use crate::paths::Timeouts;

pub mod errors;
pub mod limits;
pub mod linger;
pub mod observe;
pub mod panic;
pub mod policy;
pub mod version;

/// Tunables of the stack (tests shorten the time budgets).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Policy {
    pub timeouts: Timeouts,
}

impl Default for Policy {
    fn default() -> Self {
        Policy {
            timeouts: Timeouts::STANDARD,
        }
    }
}

/// Wraps `router` (all routes and its fallback) in the full stack.
pub fn apply(router: Router<AppState>, state: &AppState, policy: Policy) -> Router<AppState> {
    router
        .layer(axum::middleware::from_fn(panic::catch_panic))
        .layer(axum::middleware::from_fn_with_state(
            policy.timeouts,
            limits::limits,
        ))
        // The extractors' built-in 2 MB default would cap imports; `limits` sets the real limit.
        .layer(DefaultBodyLimit::disable())
        .layer(axum::middleware::from_fn(version::version))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            policy::response_policy,
        ))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            observe::observe,
        ))
        .layer(axum::middleware::from_fn_with_state(
            policy.timeouts,
            linger::linger,
        ))
        .layer(axum::middleware::from_fn(request_id::middleware))
}
