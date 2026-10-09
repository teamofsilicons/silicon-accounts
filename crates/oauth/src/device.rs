//! `POST /v1/device/authorize` (RFC 8628 sections 3.1 and 3.2): starts a device sign-in. The tool shows
//! `user_code` and `verification_uri`, the Carbon approves on the account site (`/device`, served
//! by the auth crate's `/v1/device/{user_code}` endpoints), and the tool polls
//! `POST /v1/oauth/token` with `grant_type=urn:ietf:params:oauth:grant-type:device_code`.
//!
//! Two kinds of client:
//! - the silicon-accounts CLI: no `client_id` (or `client_id=silicon-accounts`); first-party tokens;
//! - an app's own command-line tool: `client_id=<app_id>`, the app turned on `device_flow` in its
//!   sign-in setup (else 400 `unauthorized_client`). No secret is needed (a CLI on someone's
//!   machine can't keep one); with HTTP Basic the secret is checked. `scope` asks for details
//!   the app requests (`email`, `phone`, `dob`, `timezone`); the app's required details are
//!   always included, and `profile` always is.
//!
//! Body: JSON or form, all optional: `client_label` (shown on the approval page and the sessions
//! list), `client_id`, `scope`. Errors use the API error shape. Rate-limited per IP
//! ([`DEVICE_AUTHORIZE_PER_IP`]) and per app ([`DEVICE_AUTHORIZE_PER_APP`]).

use accounts_core::http::auth::basic_credentials;
use accounts_core::http::{ClientMeta, parse_form_or_json};
use accounts_core::models::{App, Scope, SigninConfig, normalize_scopes};
use accounts_core::repo::apps;
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

/// At most 600 device sign-ins started per app per 10 minutes.
pub const DEVICE_AUTHORIZE_PER_APP: Limit = Limit::new(600, 600);

/// Who is starting a device sign-in.
enum DeviceClient {
    /// The silicon-accounts CLI.
    FirstParty,
    /// An app's own tool, with the scopes it asks for.
    App(Box<App>, Vec<Scope>),
}

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
            .hint("Send JSON like {\"client_label\":\"silicon-accounts CLI on my-laptop\"}, or the same fields as a form; every field is optional.")
        })?
    };
    let client = resolve_client(&state, &headers, &params).await?;
    rate_limit::enforce_pool(
        &state.db,
        &rate_limit::bucket("device_authorize:ip", meta.ip_or_unknown()),
        DEVICE_AUTHORIZE_PER_IP,
        "device sign-ins started from this network",
    )
    .await?;
    let label = clean_label(params.client_label.as_deref());
    let start = match &client {
        DeviceClient::FirstParty => {
            if let Some(scope) = opt(params.scope.as_deref()) {
                // First-party tokens always carry `profile`; the scope is only checked for typos.
                Scope::parse_list(scope).map_err(|e| {
                    ApiError::bad_request("invalid_scope", format!("The scope parameter has {e}.")).hint(
                        "Omit scope: device sign-ins always get first-party tokens for the silicon-accounts app.",
                    )
                })?;
            }
            let mut conn = state.db.acquire().await?;
            tokens::create_device(&mut conn, &state.keys.pepper, label.as_deref()).await?
        }
        DeviceClient::App(app, scopes) => {
            rate_limit::enforce_pool(
                &state.db,
                &rate_limit::bucket("device_authorize:app", &app.app_id),
                DEVICE_AUTHORIZE_PER_APP,
                &format!("device sign-ins started for {}", app.name),
            )
            .await?;
            let mut conn = state.db.acquire().await?;
            tokens::create_app_device(
                &mut conn,
                &state.keys.pepper,
                &app.app_id,
                label.as_deref(),
                Some(scopes),
            )
            .await?
        }
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

/// The client of a device sign-in: the first-party CLI (no `client_id`, or
/// `silicon-accounts`), or an app that turned on `device_flow` (by `client_id`, or the user part
/// of HTTP Basic credentials, whose secret is then checked).
async fn resolve_client(
    state: &AppState,
    headers: &HeaderMap,
    params: &AuthorizeParams,
) -> Result<DeviceClient, ApiError> {
    let basic = basic_credentials(headers).map_err(|m| {
        ApiError::unauthenticated("invalid_app_credentials", m).hint(
            "Send Authorization: Basic base64(app_id:app_secret), or only client_id in the body.",
        )
    })?;
    let body_id = opt(params.client_id.as_deref()).map(str::to_string);
    let named = match (&basic, &body_id) {
        (Some((id, _)), Some(b)) if id != b => {
            return Err(ApiError::bad_request(
                "invalid_client",
                format!(
                    "client_id '{b}' in the body doesn't match the Basic credentials for '{id}'."
                ),
            ));
        }
        (Some((id, _)), _) => Some(id.clone()),
        (None, b) => b.clone(),
    };
    let Some(id) = named else {
        return Ok(DeviceClient::FirstParty);
    };
    if accounts_core::canonical_first_party_app_id(&id) == FIRST_PARTY_APP_ID {
        return Ok(DeviceClient::FirstParty);
    }
    let app = match &basic {
        Some((id, secret)) => state
            .app_cache
            .verify(&state.db, &state.keys.pepper, id, secret)
            .await
            .map_err(|e| e.to_api())?,
        None => {
            let mut conn = state.db.acquire().await?;
            apps::get(&mut conn, &id).await?.ok_or_else(|| {
                ApiError::bad_request(
                    "invalid_client",
                    format!("There is no app '{id}', so it can't start a device sign-in."),
                )
                .hint("Send the client_id (app_id) of your app as Silicon Apps shows it.")
            })?
        }
    };
    if !app.is_active() {
        return Err(ApiError::forbidden(
            "app_disabled",
            format!(
                "The app '{}' is disabled, so it can't sign anyone in.",
                app.app_id
            ),
        ));
    }
    let config = {
        let mut conn = state.db.acquire().await?;
        apps::effective_config(&mut conn, &state.settings, &app.app_id).await?
    };
    if !config.device_flow {
        return Err(ApiError::bad_request(
            "unauthorized_client",
            format!(
                "The app '{}' hasn't turned on device sign-ins, so its tools can't start one.",
                app.app_id
            ),
        )
        .hint("Its owner turns it on with PATCH /v1/apps/{app_id}/signin-config {\"device_flow\": true} (or the Accounts tab in the developer portal). Until then the app signs accounts in through /authorize."));
    }
    let scopes = requested_scopes(&config, opt(params.scope.as_deref()))?;
    Ok(DeviceClient::App(Box::new(app), scopes))
}

/// `profile`, the app's required details, and the optional ones `scope` asks for. A scope the
/// app doesn't request is `invalid_scope`.
fn requested_scopes(config: &SigninConfig, scope: Option<&str>) -> Result<Vec<Scope>, ApiError> {
    let mut scopes = vec![Scope::Profile];
    scopes.extend(config.required_fields.iter().map(|f| f.scope()));
    if let Some(scope) = scope {
        let asked = Scope::parse_list(scope).map_err(|e| {
            ApiError::bad_request("invalid_scope", format!("The scope parameter has {e}."))
                .hint("Ask for details the app requests, separated by spaces: profile email phone dob timezone.")
        })?;
        let offered: Vec<Scope> = config
            .requested_fields()
            .iter()
            .map(|f| f.scope())
            .collect();
        for s in asked {
            match s {
                Scope::Profile | Scope::Openid => {}
                other if offered.contains(&other) => scopes.push(other),
                other => {
                    return Err(ApiError::bad_request(
                        "invalid_scope",
                        format!(
                            "The scope '{}' isn't a detail this app asks for, so a device sign-in can't share it.",
                            other.as_str()
                        ),
                    )
                    .hint("Add it to the app's required or optional details first, or leave it out of scope."));
                }
            }
        }
    }
    Ok(normalize_scopes(scopes))
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
            clean_label(Some("  silicon-accounts CLI\non\t my-mac \u{7}")).as_deref(),
            Some("silicon-accounts CLI on my-mac")
        );
        let long = "x".repeat(250);
        assert_eq!(
            clean_label(Some(&long)).map(|l| l.chars().count()),
            Some(MAX_LABEL_CHARS)
        );
    }
}
