//! Shared application state handed to every handler (`axum::Router<AppState>`).

use std::sync::Arc;
use std::time::Duration;

use secrecy::ExposeSecret;
use sqlx::PgPool;

use crate::config::Settings;
use crate::crypto::stk::StkHasher;
use crate::crypto::{CryptoError, Keyring, Pepper};
use crate::delivery::Sender;
use crate::jwt::{JwtError, JwtKeys};
use crate::repo::apps::AppCredentialCache;
use crate::telemetry::Telemetry;

/// Key material derived from settings.
#[derive(Clone, Debug)]
pub struct Keys {
    /// Hashes every stored token: `HMAC-SHA256(pepper, token)`.
    pub pepper: Pepper,
    /// Encrypts secrets we must read back (webhook secrets, BYO provider secrets).
    pub keyring: Keyring,
    /// Signs access tokens and id_tokens.
    pub jwt: JwtKeys,
    /// Argon2id parameters for STKs.
    pub stk: StkHasher,
}

/// Why the service can't start.
#[derive(Debug, thiserror::Error)]
pub enum StartupError {
    #[error(transparent)]
    Config(#[from] crate::config::ConfigError),
    #[error("encryption keyring: {0}")]
    Crypto(#[from] CryptoError),
    #[error("JWT signing key: {0}")]
    Jwt(#[from] JwtError),
    #[error("HTTP client: {0}")]
    Http(String),
    #[error("database: {0}")]
    Database(#[from] sqlx::Error),
    #[error("migrations: {0}")]
    Migrate(#[from] sqlx::migrate::MigrateError),
}

impl Keys {
    /// Parses the pepper, keyring and JWT key from settings (production Argon2 parameters).
    pub fn from_settings(settings: &Settings) -> Result<Keys, StartupError> {
        Ok(Keys {
            pepper: Pepper::from_base64url(settings.token_pepper.expose_secret())?,
            keyring: Keyring::from_json(
                settings.encryption_keyring.expose_secret(),
                settings.encryption_current_version,
            )?,
            jwt: JwtKeys::from_private_key(
                settings.jwt_private_key.expose_secret(),
                &settings.jwt_key_id,
                settings.issuer(),
            )?,
            stk: StkHasher::PRODUCTION,
        })
    }
}

/// Everything a request handler needs. Clone is cheap (all shared).
#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub settings: Arc<Settings>,
    pub keys: Arc<Keys>,
    /// Shared outbound HTTP client (no redirects, 10 s timeout).
    pub http: reqwest::Client,
    /// Email/SMS sender for the configured delivery mode.
    pub sender: Arc<dyn Sender>,
    /// 60 s cache of verified app credentials.
    pub app_cache: AppCredentialCache,
    pub telemetry: Telemetry,
}

impl std::fmt::Debug for AppState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AppState")
            .field("environment", &self.settings.environment)
            .field("public_url", &self.settings.public_url)
            .field("sender", &self.sender.name())
            .finish_non_exhaustive()
    }
}

/// The shared outbound HTTP client: rustls, 10 s timeout, 5 s connect timeout, no redirects
/// (webhook and provider calls must never be bounced elsewhere).
pub fn build_http_client() -> Result<reqwest::Client, StartupError> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .connect_timeout(Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(format!("SiliconAccounts/{}", crate::VERSION))
        .build()
        .map_err(|e| StartupError::Http(e.to_string()))
}

impl AppState {
    /// Builds the state from settings and a connected pool.
    pub fn new(settings: Settings, db: PgPool) -> Result<AppState, StartupError> {
        let keys = Keys::from_settings(&settings)?;
        let http = build_http_client()?;
        let sender = crate::delivery::sender_from_settings(&settings, &http);
        let telemetry = Telemetry::from_settings(&settings);
        Ok(AppState {
            db,
            settings: Arc::new(settings),
            keys: Arc::new(keys),
            http,
            sender,
            app_cache: AppCredentialCache::new(),
            telemetry,
        })
    }

    /// Replaces the sender (tests, mocks).
    pub fn with_sender(mut self, sender: Arc<dyn Sender>) -> AppState {
        self.sender = sender;
        self
    }

    /// Replaces the STK hasher parameters (tests use `StkHasher::FAST_FOR_TESTS`).
    pub fn with_stk_hasher(mut self, hasher: StkHasher) -> AppState {
        let mut keys = (*self.keys).clone();
        keys.stk = hasher;
        self.keys = Arc::new(keys);
        self
    }

    pub fn settings(&self) -> &Settings {
        &self.settings
    }

    pub fn pepper(&self) -> &Pepper {
        &self.keys.pepper
    }

    pub fn keyring(&self) -> &Keyring {
        &self.keys.keyring
    }

    pub fn jwt(&self) -> &JwtKeys {
        &self.keys.jwt
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_state_bounds<T: Clone + Send + Sync + 'static>() {}

    #[test]
    fn app_state_is_shareable() {
        // axum requires router state to be Clone + Send + Sync + 'static.
        assert_state_bounds::<AppState>();
        assert_state_bounds::<Keys>();
    }

    #[test]
    fn keys_parse_from_default_settings() {
        let keys = Keys::from_settings(&Settings::for_tests()).expect("dev keys parse");
        assert_eq!(keys.jwt.kid(), "dev-1");
        assert_eq!(keys.keyring.current_version(), 1);
    }
}
