//! `POST /v1/oauth/token`: every grant, RFC 6749 errors.

use std::time::Instant;

use accounts_core::http::{ClientAuth, ClientMeta, authenticate_client};
use accounts_core::views::TokenResponse;
use accounts_core::{AppState, DEVELOPER_APP_ID, FIRST_PARTY_APP_ID, OAuthError};
use axum::body::Bytes;
use axum::extract::State;
use axum::extract::rejection::BytesRejection;
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use serde::Deserialize;
use serde_json::json;

use crate::grants;
use crate::params::{opt, parse_body};
use crate::respond::{no_store, oauth_error};

/// Grant type of the short-lived-token exchange (a Silicon's or CLI's `slt_…` → its tokens).
/// The bare alias `slt` is accepted too.
pub const SLT_GRANT_TYPE: &str = "urn:silicon:params:oauth:grant-type:slt";

/// Grant type of the device flow (RFC 8628). The bare alias `device_code` is accepted too.
pub const DEVICE_CODE_GRANT_TYPE: &str = "urn:ietf:params:oauth:grant-type:device_code";

const SUPPORTED: &str = "authorization_code, refresh_token, urn:silicon:params:oauth:grant-type:slt or urn:ietf:params:oauth:grant-type:device_code";

/// Parameters of a token request. Every field is optional so a missing one gets a precise
/// error instead of a generic parse failure. No `Debug`: it carries secrets.
#[derive(Default, Deserialize)]
pub(crate) struct TokenParams {
    pub grant_type: Option<String>,
    pub client_id: Option<String>,
    pub client_secret: Option<String>,
    pub code: Option<String>,
    pub redirect_uri: Option<String>,
    pub code_verifier: Option<String>,
    pub refresh_token: Option<String>,
    pub scope: Option<String>,
    pub slt: Option<String>,
    pub device_code: Option<String>,
}

/// The grants the token endpoint supports.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Grant {
    AuthorizationCode,
    RefreshToken,
    Slt,
    DeviceCode,
}

impl Grant {
    fn parse(value: Option<&str>) -> Result<Grant, OAuthError> {
        let Some(value) = value else {
            return Err(OAuthError::invalid_request(format!(
                "grant_type is required: use {SUPPORTED}."
            )));
        };
        let why_not = match value {
            "authorization_code" => return Ok(Grant::AuthorizationCode),
            "refresh_token" => return Ok(Grant::RefreshToken),
            SLT_GRANT_TYPE | "slt" => return Ok(Grant::Slt),
            DEVICE_CODE_GRANT_TYPE | "device_code" => return Ok(Grant::DeviceCode),
            "client_credentials" => {
                " Silicon Accounts doesn't issue app-only access tokens: one app proves itself to another with an app verification proof (POST /v1/proofs/app-verification)."
            }
            "urn:ietf:params:oauth:grant-type:token-exchange"
            | "urn:ietf:params:oauth:grant-type:jwt-bearer" => {
                " To act for an account at another app, get a User verification proof (POST /v1/proofs/user-verification) with the account's access token."
            }
            "password" => {
                " Carbons never hand their credentials to apps: send them through the hosted sign-in (/authorize). Silicons get a short-lived token with `accounts login --app <app_id>` and the app exchanges it with grant_type=urn:silicon:params:oauth:grant-type:slt."
            }
            "implicit" | "token" => {
                " The implicit flow is not supported: use the authorization code flow with PKCE."
            }
            _ => "",
        };
        Err(OAuthError::unsupported_grant_type(format!(
            "grant_type '{value}' is not supported; use {SUPPORTED}.{why_not}"
        )))
    }

    /// The canonical grant type string.
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Grant::AuthorizationCode => "authorization_code",
            Grant::RefreshToken => "refresh_token",
            Grant::Slt => SLT_GRANT_TYPE,
            Grant::DeviceCode => DEVICE_CODE_GRANT_TYPE,
        }
    }
}

/// What a request was, for logs and telemetry (never secrets).
#[derive(Default)]
struct Trace {
    grant: Option<&'static str>,
    app_id: Option<String>,
}

/// `POST /v1/oauth/token`.
pub(crate) async fn token(
    State(state): State<AppState>,
    meta: ClientMeta,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> Response {
    let started = Instant::now();
    let mut trace = Trace::default();
    let result = handle(&state, &meta, &headers, body, &mut trace).await;
    let duration_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
    match result {
        Ok(tokens) => {
            tracing::debug!(grant = ?trace.grant, app_id = ?trace.app_id, duration_ms, "tokens issued");
            state.telemetry.record(
                "oauth",
                "token",
                "token_issued",
                json!({"grant_type": trace.grant, "app_id": trace.app_id, "duration_ms": duration_ms}),
            );
            no_store(StatusCode::OK, &tokens)
        }
        Err(e) => {
            tracing::debug!(grant = ?trace.grant, app_id = ?trace.app_id, error = %e.error, "token request refused");
            state.telemetry.record(
                "oauth",
                "token",
                "token_refused",
                json!({"grant_type": trace.grant, "app_id": trace.app_id, "error": e.error, "duration_ms": duration_ms}),
            );
            oauth_error(e)
        }
    }
}

async fn handle(
    state: &AppState,
    meta: &ClientMeta,
    headers: &HeaderMap,
    body: Result<Bytes, BytesRejection>,
    trace: &mut Trace,
) -> Result<TokenResponse, OAuthError> {
    let params: TokenParams = parse_body(headers, body, "The token request")?;
    let grant = Grant::parse(opt(params.grant_type.as_deref()))?;
    trace.grant = Some(grant.as_str());
    let client = authenticate_client(
        state,
        headers,
        params.client_id.as_deref(),
        params.client_secret.as_deref(),
    )
    .await?;
    trace.app_id = Some(client.app.app_id.clone());
    match grant {
        Grant::AuthorizationCode => {
            // The developer platform is a public client: it redeems its own codes, and the
            // grant requires PKCE S256 for it (a code alone proves nothing without a secret).
            if client.app.app_id != DEVELOPER_APP_ID {
                refuse_public_client(&client, grant)?;
            }
            grants::code::exchange(state, &client, &params, meta).await
        }
        // Public or not, a client only ever refreshes its own tokens (core checks the family).
        Grant::RefreshToken => grants::refresh::exchange(state, &client, &params, meta).await,
        Grant::Slt => {
            refuse_public_client(&client, grant)?;
            grants::slt::exchange(state, &client, &params, meta).await
        }
        Grant::DeviceCode => {
            require_first_party(&client)?;
            grants::device::exchange(state, &params, meta).await
        }
    }
}

/// The public first-party clients: `accounts` may only refresh and poll device codes,
/// `developer` may only redeem its codes (PKCE S256) and refresh.
fn refuse_public_client(client: &ClientAuth, grant: Grant) -> Result<(), OAuthError> {
    if client.public {
        let allowed = if client.app.app_id == DEVELOPER_APP_ID {
            "grant_type=authorization_code (with PKCE S256) and grant_type=refresh_token"
                .to_string()
        } else {
            format!("grant_type=refresh_token and grant_type={DEVICE_CODE_GRANT_TYPE}")
        };
        return Err(OAuthError::unauthorized_client(format!(
            "grant_type={} needs a confidential client. client_id={} without a client_secret is a first-party public client, which may only use {allowed}; apps authenticate with their own client_id and client_secret (HTTP Basic or in the body).",
            grant.as_str(),
            client.app.app_id
        )));
    }
    Ok(())
}

/// Device codes belong to the first-party app (the accounts CLI).
fn require_first_party(client: &ClientAuth) -> Result<(), OAuthError> {
    if client.app.app_id != FIRST_PARTY_APP_ID {
        return Err(OAuthError::unauthorized_client(format!(
            "grant_type={DEVICE_CODE_GRANT_TYPE} is only for the first-party client '{FIRST_PARTY_APP_ID}' (the accounts CLI: send client_id={FIRST_PARTY_APP_ID} without a client_secret). The app '{}' signs accounts in through /authorize and exchanges the code with grant_type=authorization_code.",
            client.app.app_id
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grant_types() {
        assert_eq!(
            Grant::parse(Some("authorization_code")).ok(),
            Some(Grant::AuthorizationCode)
        );
        assert_eq!(Grant::parse(Some("slt")).ok(), Some(Grant::Slt));
        assert_eq!(Grant::parse(Some(SLT_GRANT_TYPE)).ok(), Some(Grant::Slt));
        assert_eq!(
            Grant::parse(Some(DEVICE_CODE_GRANT_TYPE)).ok(),
            Some(Grant::DeviceCode)
        );
        let e = Grant::parse(None).expect_err("missing");
        assert_eq!(e.error, "invalid_request");
        let e = Grant::parse(Some("client_credentials")).expect_err("unsupported");
        assert_eq!(e.error, "unsupported_grant_type");
        assert!(
            e.description.contains("/v1/proofs/app-verification"),
            "{}",
            e.description
        );
        let e = Grant::parse(Some("password")).expect_err("unsupported");
        assert!(e.description.contains("/authorize"), "{}", e.description);
        let e = Grant::parse(Some("magic")).expect_err("unsupported");
        assert!(e.description.contains("'magic'"), "{}", e.description);
    }
}
