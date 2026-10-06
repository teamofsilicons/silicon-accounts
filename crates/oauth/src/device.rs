//! `POST /v1/device/authorize` (RFC 8628 §3.1–3.2): starts a device sign-in for the accounts
//! CLI. The CLI shows `user_code` and `verification_uri`, the Carbon approves on the account
//! site (`/device`, served by the auth crate's `/v1/device/{user_code}` endpoints), and the CLI
//! polls `POST /v1/oauth/token` with `grant_type=urn:ietf:params:oauth:grant-type:device_code`.
//!
//! Public (no credentials): only the first-party client `accounts` uses the device flow, so a
//! `client_id` naming another app is refused. Body: JSON or form, all optional —
//! `client_label` (shown on the approval page and the sessions list), `client_id`, `scope`.
//! Errors use the API error shape. Rate-limited per IP ([`DEVICE_AUTHORIZE_PER_IP`]).

use accounts_core::http::auth::basic_credentials;
use accounts_core::http::{ClientMeta, parse_form_or_json};
use accounts_core::models::Scope;
use accounts_core::repo::rate_limit::{self, Limit};
use accounts_core::repo::tokens::{self, DEVICE_CODE_TTL_SECONDS};
use accounts_core::{ApiError, AppState, FIRST_PARTY_APP_ID};
use axum::body::Bytes;
use axum::extract::State;
use axum::extract::rejection::BytesRejection;
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

use crate::params::opt;
use crate::respond::no_store;

/// At most 60 device sign-ins started per IP per 10 minutes.
pub const DEVICE_AUTHORIZE_PER_IP: Limit = Limit::new(60, 600);

/// Longest `client_label` kept (longer ones are cut).
const MAX_LABEL_CHARS: usize = 100;

#[derive(Default, Deserialize)]
struct AuthorizeParams {
    client_label: Option<String>,
    client_id: Option<String>,
    scope: Option<String>,
}

/// The RFC 8628 device authorization response, plus `expires_at`.
#[derive(Serialize)]
struct DeviceAuthorizationBody {
    device_code: String,
    user_code: String,
    verification_uri: String,
    verification_uri_complete: String,
    expires_in: i64,
    interval: i64,
    #[serde(with = "accounts_core::timefmt::rfc3339_ms")]
    expires_at: OffsetDateTime,
}

/// `POST /v1/device/authorize`.
pub(crate) async fn authorize(
    State(state): State<AppState>,
    meta: ClientMeta,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> Result<Response, ApiError> {
    let bytes = body.map_err(|r| {
        if r.status() == StatusCode::PAYLOAD_TOO_LARGE {
            ApiError::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                "payload_too_large",
                "The request body is too large; a device authorization only carries a short client_label.",
            )
        } else {
            ApiError::invalid_request(format!(
                "The request body could not be read: {}.",
                r.body_text()
            ))
        }
    })?;
    let params: AuthorizeParams = if bytes.iter().all(u8::is_ascii_whitespace) {
        AuthorizeParams::default()
    } else {
        parse_form_or_json(&headers, &bytes).map_err(|m| {
            ApiError::invalid_request(format!(
                "POST /v1/device/authorize could not read its body: {m}."
            ))
            .hint("Send JSON like {\"client_label\":\"accounts CLI on my-laptop\"}, or the same fields as a form; every field is optional.")
        })?
    };
    check_client(&headers, &params)?;
    if let Some(scope) = opt(params.scope.as_deref()) {
        // First-party tokens always carry `profile`; the scope is only checked for typos.
        Scope::parse_list(scope).map_err(|e| {
            ApiError::bad_request("invalid_scope", format!("The scope parameter has {e}.")).hint(
                "Omit scope: device sign-ins always get first-party tokens for the accounts app.",
            )
        })?;
    }
    rate_limit::enforce_pool(
        &state.db,
        &rate_limit::bucket("device_authorize:ip", meta.ip_or_unknown()),
        DEVICE_AUTHORIZE_PER_IP,
        "device sign-ins started from this network",
    )
    .await?;
    let label = clean_label(params.client_label.as_deref());
    let start = {
        let mut conn = state.db.acquire().await?;
        tokens::create_device(&mut conn, &state.keys.pepper, label.as_deref()).await?
    };
    let verification_uri = state.settings.url("/device");
    let verification_uri_complete = format!("{verification_uri}?code={}", start.user_code);
    Ok(no_store(
        StatusCode::OK,
        &DeviceAuthorizationBody {
            device_code: start.device_code,
            user_code: start.user_code,
            verification_uri,
            verification_uri_complete,
            expires_in: DEVICE_CODE_TTL_SECONDS,
            interval: start.interval,
            expires_at: start.expires_at,
        },
    ))
}

/// Only the first-party client may start a device sign-in (by `client_id`, or the user part of
/// HTTP Basic credentials).
fn check_client(headers: &HeaderMap, params: &AuthorizeParams) -> Result<(), ApiError> {
    let basic_id = basic_credentials(headers).ok().flatten().map(|(id, _)| id);
    let named = opt(params.client_id.as_deref())
        .map(str::to_string)
        .into_iter()
        .chain(basic_id);
    for id in named {
        if id != FIRST_PARTY_APP_ID {
            return Err(ApiError::bad_request(
                "unauthorized_client",
                format!(
                    "The device flow is only for the first-party client '{FIRST_PARTY_APP_ID}' (the accounts CLI), not for the app '{id}'."
                ),
            )
            .hint("Apps sign accounts in through the hosted pages (/authorize) and exchange the code at POST /v1/oauth/token. Omit client_id, or send client_id=accounts."));
        }
    }
    Ok(())
}

/// Trims, turns control characters and runs of whitespace into single spaces, and keeps at most
/// [`MAX_LABEL_CHARS`] characters. Empty → `None`.
fn clean_label(label: Option<&str>) -> Option<String> {
    let cleaned = label?
        .split(|c: char| c.is_whitespace() || c.is_control())
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let cleaned: String = cleaned.chars().take(MAX_LABEL_CHARS).collect();
    let cleaned = cleaned.trim_end().to_string();
    (!cleaned.is_empty()).then_some(cleaned)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_are_cleaned() {
        assert_eq!(clean_label(None), None);
        assert_eq!(clean_label(Some("   ")), None);
        assert_eq!(
            clean_label(Some("  accounts CLI\non\t my-mac \u{7}")).as_deref(),
            Some("accounts CLI on my-mac")
        );
        let long = "x".repeat(250);
        assert_eq!(
            clean_label(Some(&long)).map(|l| l.chars().count()),
            Some(MAX_LABEL_CHARS)
        );
    }
}
