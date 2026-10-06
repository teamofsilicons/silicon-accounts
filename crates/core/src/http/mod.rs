//! HTTP building blocks shared by every router: extractors, cookies, the CSRF origin guard,
//! request ids and pagination.
//!
//! | extractor | gives | fails with |
//! |---|---|---|
//! | [`AccountAuth`] | signed-in account (session cookie, or Bearer JWT with aud=accounts) | 401 / 403 `origin_not_allowed` |
//! | [`CarbonAuth`] / [`SiliconAuth`] | same, restricted by kind | 403 `carbon_only` / `silicon_only` |
//! | [`AppAuth`] | app from `Authorization: Basic` | 401 `invalid_app_credentials` / 403 `app_disabled` |
//! | [`AppOrOwner`] | app of `{app_id}` via its credentials or its owner's session | 403 `app_mismatch` / `not_app_owner`, 404 `unknown_app` |
//! | [`ClientMeta`] | ip, user agent, ip timezone, origin | never |
//! | [`IdempotencyKey`] | `Idempotency-Key` header | 400 `invalid_idempotency_key` |
//! | [`Json`], [`Query`], [`Path`] | typed input | 400 / 422 with the field path |
//!
//! `Option<AccountAuth>`, `Option<IdempotencyKey>` work for optional auth / keys.

pub mod auth;
pub mod cookies;
pub mod extract;
pub mod idempotency;
pub mod meta;
pub mod pagination;
pub mod request_id;

pub use auth::{
    AccountAuth, AppActor, AppAuth, AppOrOwner, AuthVia, CarbonAuth, ClientAuth, SiliconAuth,
    authenticate_client,
};
pub use cookies::{FLOW_COOKIE, SESSION_COOKIE, SIGNUP_COOKIE};
pub use extract::{Json, Path, Query, parse_form_or_json};
pub use idempotency::IdempotencyKey;
pub use meta::ClientMeta;
pub use pagination::{PageParams, decode_cursor, encode_cursor, paginate};
pub use request_id::RequestId;

use axum::http::{HeaderMap, Method};

use crate::config::Settings;
use crate::error::ApiError;

/// CSRF guard for cookie-authenticated requests: POST/PUT/PATCH/DELETE must carry an `Origin`
/// equal to ACCOUNTS_PUBLIC_URL's origin or an ACCOUNTS_EXTRA_ALLOWED_ORIGINS entry
/// (403 `origin_not_allowed`). Safe methods always pass.
pub fn check_origin(
    settings: &Settings,
    headers: &HeaderMap,
    method: &Method,
) -> Result<(), ApiError> {
    if matches!(*method, Method::GET | Method::HEAD | Method::OPTIONS) {
        return Ok(());
    }
    let origin = headers
        .get(axum::http::header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .map(str::trim);
    match origin {
        Some(o) if settings.is_allowed_origin(o) => Ok(()),
        Some(o) => Err(ApiError::forbidden(
            "origin_not_allowed",
            format!("A cookie-authenticated {method} must come from {}; this one came from '{o}'.", settings.public_origin),
        )
        .hint("Call the API from the account site, or authenticate with an Authorization: Bearer access token instead of the cookie.")),
        None => Err(ApiError::forbidden(
            "origin_not_allowed",
            format!("A cookie-authenticated {method} must send an Origin header equal to {}.", settings.public_origin),
        )
        .hint("Browsers send Origin automatically; other clients should use an Authorization: Bearer access token.")),
    }
}
