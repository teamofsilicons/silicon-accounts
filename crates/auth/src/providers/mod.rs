//! Google and Apple sign-in.
//!
//! - [`start`]: `POST /v1/flows/{id}/oauth/{provider}` builds the provider's authorize URL
//!   (state bound to the flow, nonce, PKCE S256 for Google, `response_mode=form_post` for
//!   Apple) with the app's own client (`mode: byo`) or ours (`mode: managed`).
//! - [`callback`]: `GET|POST /v1/oauth/callback/{provider}` accepts an answer only from the
//!   browser that started the sign-in (its `sa_flow` cookie; Apple's cookieless form_post
//!   continues through a same-site 303), exchanges the code, verifies the id_token
//!   ([`id_token`]) and resolves the identity (known identity → its account; verified email of
//!   an account → link; else sign-up).
//! - [`apple`]: Apple's client secret, an ES256 JWT signed with the `.p8` key.
//!
//! All provider URLs come from settings (`ACCOUNTS_GOOGLE_*`, `ACCOUNTS_APPLE_*`), so tests and
//! development point them at the testkit's mock-oidc.

pub mod apple;
pub mod callback;
pub mod id_token;
pub mod start;

use accounts_core::models::{Provider, ProviderMode};
use accounts_core::repo::apps;
use accounts_core::secrecy::ExposeSecret;
use accounts_core::{ApiError, ApiResult, AppState, Settings};
use sqlx::PgConnection;

use crate::flow::FlowApp;

/// How we authenticate to the provider's token endpoint.
#[derive(Clone)]
pub enum Credential {
    /// Google: the OAuth client secret (client_secret_post).
    GoogleSecret(String),
    /// Apple: the `.p8` key that signs the client secret JWT.
    AppleKey {
        team_id: String,
        key_id: String,
        private_key_pem: String,
    },
}

impl std::fmt::Debug for Credential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Credential::GoogleSecret(_) => f.write_str("GoogleSecret(redacted)"),
            Credential::AppleKey {
                team_id, key_id, ..
            } => f
                .debug_struct("AppleKey")
                .field("team_id", team_id)
                .field("key_id", key_id)
                .finish_non_exhaustive(),
        }
    }
}

/// The client used for one app and provider.
#[derive(Debug, Clone)]
pub struct ProviderClient {
    pub provider: Provider,
    pub mode: ProviderMode,
    /// Google OAuth client id, or Apple Services ID.
    pub client_id: String,
    pub credential: Credential,
}

/// Provider endpoints and accepted issuers (from settings).
#[derive(Debug, Clone)]
pub struct Endpoints {
    pub auth_url: String,
    pub token_url: String,
    pub jwks_url: String,
    pub issuers: Vec<String>,
}

/// The endpoints of a provider.
pub fn endpoints(settings: &Settings, provider: Provider) -> Endpoints {
    match provider {
        Provider::Google => Endpoints {
            auth_url: settings.google.auth_url.clone(),
            token_url: settings.google.token_url.clone(),
            jwks_url: settings.google.jwks_url.clone(),
            issuers: settings.google.issuers.clone(),
        },
        Provider::Apple => Endpoints {
            auth_url: settings.apple.auth_url.clone(),
            token_url: settings.apple.token_url.clone(),
            jwks_url: settings.apple.jwks_url.clone(),
            issuers: vec![settings.apple.issuer.clone()],
        },
    }
}

/// Where the provider sends the browser back: `{PUBLIC_URL}/v1/oauth/callback/{provider}`.
pub fn callback_url(settings: &Settings, provider: Provider) -> String {
    settings.url(&format!("/v1/oauth/callback/{}", provider.as_str()))
}

fn not_configured(message: String, hint: &str) -> ApiError {
    ApiError::unavailable("provider_not_configured", message).hint(hint)
}

/// Resolves the client for an app: its own credentials (`byo`) or ours (`managed`).
///
/// Errors: 503 `provider_not_configured` when the credentials it needs are missing.
pub async fn resolve_client(
    conn: &mut PgConnection,
    state: &AppState,
    fa: &FlowApp,
    provider: Provider,
) -> ApiResult<ProviderClient> {
    let settings = &state.settings;
    let app_id = &fa.app.app_id;
    match provider {
        Provider::Google => match fa.config.google.mode {
            ProviderMode::Managed => match (&settings.google.client_id, &settings.google.client_secret) {
                (Some(id), Some(secret)) => Ok(ProviderClient {
                    provider,
                    mode: ProviderMode::Managed,
                    client_id: id.clone(),
                    credential: Credential::GoogleSecret(secret.expose_secret().to_string()),
                }),
                _ => Err(not_configured(
                    "Sign in with Google isn't available: this Silicon Accounts has no managed Google client (ACCOUNTS_GOOGLE_CLIENT_ID and ACCOUNTS_GOOGLE_CLIENT_SECRET are not set).".into(),
                    "Use another sign-in method. The app can also bring its own Google client (google.mode = byo).",
                )),
            },
            ProviderMode::Byo => {
                let client_id = fa.config.google.client_id.clone().ok_or_else(|| {
                    not_configured(
                        format!("The app '{app_id}' uses its own Google client, but no google.client_id is set."),
                        "The app's owner must set google.client_id and google.client_secret in the sign-in setup.",
                    )
                })?;
                let row = apps::signin_row(conn, app_id).await?;
                let enc = row.and_then(|r| r.google_client_secret_enc).ok_or_else(|| {
                    not_configured(
                        format!("The app '{app_id}' uses its own Google client, but its client secret isn't stored."),
                        "The app's owner must set google.client_secret in the sign-in setup.",
                    )
                })?;
                let secret = state.keys.keyring.decrypt_string(&enc)?;
                Ok(ProviderClient {
                    provider,
                    mode: ProviderMode::Byo,
                    client_id,
                    credential: Credential::GoogleSecret(secret),
                })
            }
        },
        Provider::Apple => match fa.config.apple.mode {
            ProviderMode::Managed => match (
                &settings.apple.services_id,
                &settings.apple.team_id,
                &settings.apple.key_id,
                &settings.apple.private_key,
            ) {
                (Some(services_id), Some(team_id), Some(key_id), Some(key)) => Ok(ProviderClient {
                    provider,
                    mode: ProviderMode::Managed,
                    client_id: services_id.clone(),
                    credential: Credential::AppleKey {
                        team_id: team_id.clone(),
                        key_id: key_id.clone(),
                        private_key_pem: key.expose_secret().to_string(),
                    },
                }),
                _ => Err(not_configured(
                    "Sign in with Apple isn't available: this Silicon Accounts has no managed Apple setup (ACCOUNTS_APPLE_SERVICES_ID, _TEAM_ID, _KEY_ID and _PRIVATE_KEY are not all set).".into(),
                    "Use another sign-in method. The app can also bring its own Apple setup (apple.mode = byo).",
                )),
            },
            ProviderMode::Byo => {
                let cfg = &fa.config.apple;
                let (Some(services_id), Some(team_id), Some(key_id)) =
                    (cfg.services_id.clone(), cfg.team_id.clone(), cfg.key_id.clone())
                else {
                    return Err(not_configured(
                        format!("The app '{app_id}' uses its own Apple setup, but apple.services_id, team_id and key_id are not all set."),
                        "The app's owner must complete the Apple section of the sign-in setup.",
                    ));
                };
                let row = apps::signin_row(conn, app_id).await?;
                let enc = row.and_then(|r| r.apple_private_key_enc).ok_or_else(|| {
                    not_configured(
                        format!("The app '{app_id}' uses its own Apple setup, but its .p8 private key isn't stored."),
                        "The app's owner must set apple.private_key in the sign-in setup.",
                    )
                })?;
                let pem = state.keys.keyring.decrypt_string(&enc)?;
                Ok(ProviderClient {
                    provider,
                    mode: ProviderMode::Byo,
                    client_id: services_id,
                    credential: Credential::AppleKey {
                        team_id,
                        key_id,
                        private_key_pem: pem,
                    },
                })
            }
        },
    }
}
