//! `POST /v1/oauth/token`: every grant, RFC 6749 errors.

use std::time::Instant;

use accounts_core::http::{ClientAuth, ClientMeta, authenticate_client};
use accounts_core::repo::rate_limit;
use accounts_core::views::{TokenExchangeResponse, TokenResponse};
use accounts_core::{AppState, DEVELOPER_APP_ID, FIRST_PARTY_APP_ID, OAuthError};
use axum::body::Bytes;
use axum::extract::State;
use axum::extract::rejection::BytesRejection;
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::grants;
use crate::params::{opt, parse_body};
use crate::respond::{no_store, oauth_error};

/// Grant type of the short-lived-token exchange (a Silicon's or CLI's `slt_…` → its tokens).
/// The bare alias `slt` is accepted too.
pub const SLT_GRANT_TYPE: &str = "urn:silicon:params:oauth:grant-type:slt";

/// Grant type of the device flow (RFC 8628). The bare alias `device_code` is accepted too.
pub const DEVICE_CODE_GRANT_TYPE: &str = "urn:ietf:params:oauth:grant-type:device_code";

/// Grant type of a Silicon's key-signed assertion (RFC 7523), for the first-party client.
pub const JWT_BEARER_GRANT_TYPE: &str = "urn:ietf:params:oauth:grant-type:jwt-bearer";

/// Grant type of a token exchange (RFC 8693): a Silicon signs in with an outside OIDC token
/// it is trusted for (workload identity federation), for the first-party client.
pub const TOKEN_EXCHANGE_GRANT_TYPE: &str = accounts_core::federation::TOKEN_EXCHANGE_GRANT_TYPE;

const SUPPORTED: &str = "authorization_code, refresh_token, urn:silicon:params:oauth:grant-type:slt, urn:ietf:params:oauth:grant-type:device_code, urn:ietf:params:oauth:grant-type:jwt-bearer or urn:ietf:params:oauth:grant-type:token-exchange";

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
    pub assertion: Option<String>,
    pub subject_token: Option<String>,
    pub subject_token_type: Option<String>,
    pub requested_token_type: Option<String>,
    pub actor_token: Option<String>,
    pub silicon: Option<String>,
}

/// The grants the token endpoint supports.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Grant {
    AuthorizationCode,
    RefreshToken,
    Slt,
    DeviceCode,
    JwtBearer,
    TokenExchange,
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
            JWT_BEARER_GRANT_TYPE => return Ok(Grant::JwtBearer),
            TOKEN_EXCHANGE_GRANT_TYPE => return Ok(Grant::TokenExchange),
            "client_credentials" => {
                " Silicon Accounts doesn't issue app-only access tokens: one app proves itself to another with an App verification proof (POST /v1/proofs/app-verification)."
            }
            "password" => {
                " Carbons never hand their credentials to apps: send them through the hosted sign-in (/authorize). Silicons get a short-lived token with `silicon-accounts login --app <app_id>` and the app exchanges it with grant_type=urn:silicon:params:oauth:grant-type:slt."
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
            Grant::JwtBearer => JWT_BEARER_GRANT_TYPE,
            Grant::TokenExchange => TOKEN_EXCHANGE_GRANT_TYPE,
        }
    }
}

/// What a request was, for logs and telemetry (never secrets).
#[derive(Default)]
pub(crate) struct Trace {
    grant: Option<&'static str>,
    app_id: Option<String>,
    /// Seconds to wait before retrying, for a refusal that is a rate limit.
    pub(crate) retry_after: Option<u64>,
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
            let mut response = oauth_error(e);
            if let Some(seconds) = trace.retry_after
                && let Ok(v) = axum::http::HeaderValue::from_str(&seconds.to_string())
            {
                response
                    .headers_mut()
                    .insert(axum::http::header::RETRY_AFTER, v);
            }
            response
        }
    }
}

/// What a token request issued: a sign-in, or a sign-in from a token exchange (which also says
/// `issued_token_type`, RFC 8693).
#[derive(Serialize)]
#[serde(untagged)]
enum Issued {
    Tokens(Box<TokenResponse>),
    Exchanged(Box<TokenExchangeResponse>),
}

impl From<TokenResponse> for Issued {
    fn from(t: TokenResponse) -> Self {
        Issued::Tokens(Box::new(t))
    }
}

async fn handle(
    state: &AppState,
    meta: &ClientMeta,
    headers: &HeaderMap,
    body: Result<Bytes, BytesRejection>,
    trace: &mut Trace,
) -> Result<Issued, OAuthError> {
    let params: TokenParams = parse_body(headers, body, "The token request")?;
    let grant = Grant::parse(opt(params.grant_type.as_deref()))?;
    trace.grant = Some(grant.as_str());
    if grant == Grant::JwtBearer {
        limit_silicon_sign_ins(state, meta, trace).await?;
    }
    // A token exchange signs a Silicon into Silicon Accounts itself, so a CI job may leave the
    // client out: it is the first-party client.
    let client_id = match (grant, opt(params.client_id.as_deref())) {
        (Grant::TokenExchange, None)
            if !headers.contains_key(axum::http::header::AUTHORIZATION) =>
        {
            Some(FIRST_PARTY_APP_ID)
        }
        (_, id) => id,
    };
    let client =
        authenticate_client(state, headers, client_id, params.client_secret.as_deref()).await?;
    trace.app_id = Some(client.app.app_id.clone());
    if grant == Grant::TokenExchange {
        if client.app.app_id != FIRST_PARTY_APP_ID {
            return Err(OAuthError::unauthorized_client(format!(
                "grant_type={TOKEN_EXCHANGE_GRANT_TYPE} signs a Silicon into Silicon Accounts itself with a trusted outside token: send client_id={FIRST_PARTY_APP_ID} (or no client at all). To act for an account at another app, get a User verification proof (POST /v1/proofs/user-verification)."
            )));
        }
        let response = grants::federated::exchange(state, &params, meta, trace).await?;
        return Ok(Issued::Exchanged(Box::new(response)));
    }
    let tokens = issue(state, meta, &params, grant, &client).await?;
    Ok(tokens.into())
}

async fn issue(
    state: &AppState,
    meta: &ClientMeta,
    params: &TokenParams,
    grant: Grant,
    client: &ClientAuth,
) -> Result<TokenResponse, OAuthError> {
    match grant {
        Grant::AuthorizationCode => {
            // Public clients redeem their own codes, and the grant requires PKCE S256 for them
            // (a code alone proves nothing without a secret): the developer platform, and the
            // command-line and desktop tools of apps that turned on `public_client`.
            if client.app.app_id != DEVELOPER_APP_ID
                && !(client.public && app_setting(state, client, |c| c.public_client).await?)
            {
                refuse_public_client(client, grant)?;
            }
            grants::code::exchange(state, client, params, meta).await
        }
        // Public or not, a client only ever refreshes its own tokens (core checks the family).
        Grant::RefreshToken => grants::refresh::exchange(state, client, params, meta).await,
        Grant::Slt => {
            // An app's own command-line or desktop tool has no server to keep a secret in, so an
            // app that turned on `public_client` may exchange with its client_id alone: the SLT
            // is the proof (single use, 120 s, bound to this app, and only the account that
            // minted it can hand it over). Other apps still need their secret.
            if !(client.public
                && !accounts_core::is_first_party_app_id(&client.app.app_id)
                && app_setting(state, client, |c| c.public_client).await?)
            {
                refuse_public_client(client, grant)?;
            }
            grants::slt::exchange(state, client, params, meta).await
        }
        Grant::DeviceCode => {
            require_device_client(state, client).await?;
            grants::device::exchange(state, client, params, meta).await
        }
        Grant::JwtBearer => {
            // A Silicon's own sign-in to Silicon Accounts: first-party tokens only.
            if client.app.app_id != FIRST_PARTY_APP_ID {
                return Err(OAuthError::unauthorized_client(format!(
                    "grant_type={JWT_BEARER_GRANT_TYPE} signs a Silicon into Silicon Accounts itself: send client_id={FIRST_PARTY_APP_ID}. To act for an account at another app, get a User verification proof (POST /v1/proofs/user-verification)."
                )));
            }
            let assertion = opt(params.assertion.as_deref()).ok_or_else(|| {
                OAuthError::invalid_request(format!(
                    "assertion is required for grant_type={JWT_BEARER_GRANT_TYPE}: a JWT signed with one of the Silicon's registered keys."
                ))
            })?;
            accounts_core::silicon_keys::sign_in(state, meta, assertion, None)
                .await
                .map_err(|e| {
                    if e.is_server_error() {
                        OAuthError::server_error(e.message)
                    } else {
                        let hint = e.hint.map(|h| format!(" {h}")).unwrap_or_default();
                        OAuthError::invalid_grant(format!("{}{hint}", e.message))
                    }
                })
        }
        Grant::TokenExchange => Err(OAuthError::server_error(
            "a token exchange reached the token-issuing path",
        )),
    }
}

/// A key-signed assertion is the credential `POST /v1/silicons/login` takes too, so it counts
/// against the same limit, in the same bucket: 60 Silicon sign-in attempts per minute per
/// address across both endpoints (core's `rate_limit::SILICON_LOGIN_BUCKET`). Every attempt
/// counts, before the client or the assertion is checked. Over it: 429 `rate_limited` with
/// `Retry-After`.
async fn limit_silicon_sign_ins(
    state: &AppState,
    meta: &ClientMeta,
    trace: &mut Trace,
) -> Result<(), OAuthError> {
    let limited = rate_limit::enforce_pool(
        &state.db,
        &rate_limit::bucket(rate_limit::SILICON_LOGIN_BUCKET, meta.ip_or_unknown()),
        rate_limit::limits::SILICON_LOGIN_PER_IP,
        "Silicon sign-in attempts from this network",
    )
    .await;
    match limited {
        Ok(()) => Ok(()),
        Err(e) if e.status == StatusCode::TOO_MANY_REQUESTS => {
            trace.retry_after = e.retry_after;
            let hint = e
                .hint
                .as_deref()
                .map(|h| format!(" {h}"))
                .unwrap_or_default();
            Err(OAuthError::new(
                StatusCode::TOO_MANY_REQUESTS,
                "rate_limited",
                format!("{}{hint}", e.message),
            ))
        }
        Err(e) => Err(OAuthError::server_error(e.message)),
    }
}

/// One setting of the client app's sign-in setup.
async fn app_setting(
    state: &AppState,
    client: &ClientAuth,
    pick: impl Fn(&accounts_core::models::SigninConfig) -> bool,
) -> Result<bool, OAuthError> {
    let mut conn = state.db.acquire().await?;
    let config =
        accounts_core::repo::apps::effective_config(&mut conn, &state.settings, &client.app.app_id)
            .await
            .map_err(|e| OAuthError::server_error(e.message))?;
    Ok(pick(&config))
}

/// Public clients (`client_id` without a secret) may only use some grants: `silicon-accounts`
/// refreshes and polls device codes, `developer` redeems its codes (PKCE S256) and refreshes,
/// and an app's public tools do what its sign-in setup turned on (`device_flow`: poll device
/// codes; `public_client`: redeem codes with PKCE S256 and exchange short-lived tokens), plus
/// refresh.
fn refuse_public_client(client: &ClientAuth, grant: Grant) -> Result<(), OAuthError> {
    if client.public {
        let allowed = if client.app.app_id == DEVELOPER_APP_ID {
            "grant_type=authorization_code (with PKCE S256) and grant_type=refresh_token"
                .to_string()
        } else if client.app.app_id == FIRST_PARTY_APP_ID {
            format!("grant_type=refresh_token and grant_type={DEVICE_CODE_GRANT_TYPE}")
        } else {
            format!(
                "grant_type=refresh_token, grant_type={DEVICE_CODE_GRANT_TYPE} (with device_flow on), and grant_type=authorization_code with PKCE S256 and grant_type={SLT_GRANT_TYPE} (with public_client on)"
            )
        };
        return Err(OAuthError::unauthorized_client(format!(
            "grant_type={} needs a confidential client. client_id={} without a client_secret is a public client, which may only use {allowed}; send the app's client_secret too (HTTP Basic or in the body) for anything else.",
            grant.as_str(),
            client.app.app_id
        )));
    }
    Ok(())
}

/// Device codes are for the first-party CLI and for apps that turned on `device_flow`.
async fn require_device_client(state: &AppState, client: &ClientAuth) -> Result<(), OAuthError> {
    if client.app.app_id == DEVELOPER_APP_ID {
        return Err(OAuthError::unauthorized_client(format!(
            "grant_type={DEVICE_CODE_GRANT_TYPE} is only for the first-party client '{FIRST_PARTY_APP_ID}' (the silicon-accounts CLI) and for apps that turn on device_flow; the developer platform signs Carbons in with authorization codes."
        )));
    }
    if client.app.app_id == FIRST_PARTY_APP_ID
        || app_setting(state, client, |c| c.device_flow).await?
    {
        return Ok(());
    }
    Err(OAuthError::unauthorized_client(format!(
        "grant_type={DEVICE_CODE_GRANT_TYPE} is not turned on for the app '{}'. An app lets its own command-line tool sign Carbons in with a code once it sets \"device_flow\": true in its sign-in setup (PATCH /v1/apps/{{app_id}}/signin-config); until then it signs accounts in through /authorize.",
        client.app.app_id
    )))
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
            e.description.contains("App verification proof")
                && e.description.contains("/v1/proofs/app-verification"),
            "{}",
            e.description
        );
        let e = Grant::parse(Some("password")).expect_err("unsupported");
        assert!(e.description.contains("/authorize"), "{}", e.description);
        let e = Grant::parse(Some("magic")).expect_err("unsupported");
        assert!(e.description.contains("'magic'"), "{}", e.description);
    }
}
