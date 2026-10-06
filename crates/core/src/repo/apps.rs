//! Apps: lookups, credential checks (with a 60 s in-memory cache) and the effective sign-in
//! configuration.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use sqlx::{PgConnection, PgPool};
use time::OffsetDateTime;

use crate::config::Settings;
use crate::crypto::{Pepper, constant_time_eq};
use crate::error::{ApiError, ApiResult, OAuthError};
use crate::models::{App, AppStatus, SigninConfig};

/// Fetches an app.
pub async fn get(conn: &mut PgConnection, app_id: &str) -> ApiResult<Option<App>> {
    Ok(sqlx::query_as::<_, App>(concat!(
        "select ",
        crate::app_columns!(),
        " from apps where app_id = $1"
    ))
    .bind(app_id)
    .fetch_optional(&mut *conn)
    .await?)
}

/// Fetches an app or fails: 404 `unknown_app`, 403 `app_disabled`.
pub async fn require_active(conn: &mut PgConnection, app_id: &str) -> ApiResult<App> {
    let app = get(conn, app_id)
        .await?
        .ok_or_else(|| unknown_app(app_id))?;
    if app.status != AppStatus::Active {
        return Err(app_disabled(&app));
    }
    Ok(app)
}

/// 404 `unknown_app`.
pub fn unknown_app(app_id: &str) -> ApiError {
    ApiError::not_found(
        "unknown_app",
        format!("No app with app_id '{app_id}' exists in Silicon Accounts."),
    )
    .hint("Check the app_id; apps are created in Silicon Apps.")
}

/// 403 `app_disabled`.
pub fn app_disabled(app: &App) -> ApiError {
    ApiError::forbidden(
        "app_disabled",
        format!(
            "The app '{}' is disabled, so nobody can sign in to it right now.",
            app.app_id
        ),
    )
    .hint("Ask the app's owner to re-enable it in Silicon Apps.")
}

/// Apps owned by a Carbon, newest first.
pub async fn owned_by(conn: &mut PgConnection, owner_uuid: &str) -> ApiResult<Vec<App>> {
    Ok(sqlx::query_as::<_, App>(concat!(
        "select ",
        crate::app_columns!(),
        " from apps where owner_uuid = $1 order by created_at desc, app_id"
    ))
    .bind(owner_uuid)
    .fetch_all(&mut *conn)
    .await?)
}

/// A row of `app_signin_configs` (secrets stay encrypted).
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct AppSigninRow {
    pub app_id: String,
    pub version: i64,
    pub config: serde_json::Value,
    pub google_client_secret_enc: Option<Vec<u8>>,
    pub apple_private_key_enc: Option<Vec<u8>>,
    pub webhook_url: Option<String>,
    pub webhook_secret_enc: Option<Vec<u8>>,
    pub updated_at: OffsetDateTime,
    pub updated_by: String,
}

impl AppSigninRow {
    /// Which BYO secrets are stored.
    pub fn secrets_present(&self) -> crate::models::ConfigSecretsPresent {
        crate::models::ConfigSecretsPresent {
            google_client_secret: self.google_client_secret_enc.is_some(),
            apple_private_key: self.apple_private_key_enc.is_some(),
        }
    }
}

/// Loads an app's stored sign-in row.
pub async fn signin_row(conn: &mut PgConnection, app_id: &str) -> ApiResult<Option<AppSigninRow>> {
    Ok(sqlx::query_as::<_, AppSigninRow>(
        "select app_id, version, config, google_client_secret_enc, apple_private_key_enc, webhook_url, \
         webhook_secret_enc, updated_at, updated_by from app_signin_configs where app_id = $1",
    )
    .bind(app_id)
    .fetch_optional(&mut *conn)
    .await?)
}

/// The effective sign-in config of an app (stored document or defaults, plus first-party rules).
pub async fn effective_config(
    conn: &mut PgConnection,
    settings: &Settings,
    app_id: &str,
) -> ApiResult<SigninConfig> {
    let stored = signin_row(conn, app_id).await?;
    let config = match stored {
        Some(row) => SigninConfig::from_stored(&row.config),
        None => SigninConfig::default(),
    };
    Ok(config.effective(settings, app_id))
}

/// The app's webhook target: (url, encrypted secret).
pub async fn webhook_target(
    conn: &mut PgConnection,
    app_id: &str,
) -> ApiResult<Option<(String, Option<Vec<u8>>)>> {
    let row: Option<(Option<String>, Option<Vec<u8>>)> = sqlx::query_as(
        "select webhook_url, webhook_secret_enc from app_signin_configs where app_id = $1",
    )
    .bind(app_id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(row.and_then(|(url, secret)| url.map(|u| (u, secret))))
}

/// Why app credentials were refused.
#[derive(Debug, Clone)]
pub enum AppAuthError {
    /// No such app.
    UnknownApp(String),
    /// The secret is wrong.
    BadSecret(String),
    /// The app exists but is disabled.
    Disabled(String),
    /// Malformed or missing credentials.
    Malformed(String),
    /// Database failure.
    Internal(String),
}

impl AppAuthError {
    /// The `ApiError` for non-OAuth endpoints.
    pub fn to_api(&self) -> ApiError {
        match self {
            AppAuthError::UnknownApp(id) => ApiError::unauthenticated(
                "invalid_app_credentials",
                format!("No app with app_id '{id}' exists, so these app credentials are not valid."),
            )
            .hint("Send Authorization: Basic base64(app_id:app_secret) with the credentials from Silicon Apps."),
            AppAuthError::BadSecret(id) => ApiError::unauthenticated(
                "invalid_app_credentials",
                format!("The app secret sent for '{id}' is wrong."),
            )
            .hint("Use the app's current secret from Silicon Apps (secrets start with sa_app_)."),
            AppAuthError::Disabled(id) => ApiError::forbidden(
                "app_disabled",
                format!("The app '{id}' is disabled, so its credentials can't be used."),
            )
            .hint("Re-enable the app in Silicon Apps."),
            AppAuthError::Malformed(m) => ApiError::unauthenticated("invalid_app_credentials", m.clone())
                .hint("Send Authorization: Basic base64(app_id:app_secret)."),
            AppAuthError::Internal(m) => ApiError::internal(m.clone()),
        }
    }

    /// The RFC 6749 error for `/v1/oauth/*`.
    pub fn to_oauth(&self) -> OAuthError {
        match self {
            AppAuthError::UnknownApp(id) => {
                OAuthError::invalid_client(format!("No app with client_id '{id}' exists."))
            }
            AppAuthError::BadSecret(id) => {
                OAuthError::invalid_client(format!("The client_secret sent for '{id}' is wrong."))
            }
            AppAuthError::Disabled(id) => OAuthError::invalid_client(format!(
                "The app '{id}' is disabled, so it can't use the token endpoint."
            )),
            AppAuthError::Malformed(m) => OAuthError::invalid_client(m.clone()),
            AppAuthError::Internal(m) => OAuthError::server_error(m),
        }
    }
}

/// (app_id, HMAC of the presented secret) → verified app.
type CacheMap = HashMap<(String, Vec<u8>), CachedApp>;

#[derive(Clone)]
struct CachedApp {
    app: App,
    at: Instant,
}

/// In-memory cache of verified app credentials, keyed by `(app_id, HMAC(pepper, secret))`,
/// valid for 60 s. Only successful verifications are cached. Cheap to clone (shared).
#[derive(Clone, Default)]
pub struct AppCredentialCache {
    inner: Arc<Mutex<CacheMap>>,
    ttl: Option<Duration>,
}

impl std::fmt::Debug for AppCredentialCache {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("AppCredentialCache")
    }
}

impl AppCredentialCache {
    /// A cache with the standard 60 s TTL.
    pub fn new() -> Self {
        AppCredentialCache {
            inner: Arc::default(),
            ttl: Some(Duration::from_secs(60)),
        }
    }

    fn ttl(&self) -> Duration {
        self.ttl.unwrap_or(Duration::from_secs(60))
    }

    /// Drops every cached entry of an app (call after its secret or status changes).
    pub fn invalidate(&self, app_id: &str) {
        if let Ok(mut map) = self.inner.lock() {
            map.retain(|(id, _), _| id != app_id);
        }
    }

    /// Verifies `app_id` + `secret`. Cached for 60 s after a success.
    pub async fn verify(
        &self,
        pool: &PgPool,
        pepper: &Pepper,
        app_id: &str,
        secret: &str,
    ) -> Result<App, AppAuthError> {
        if app_id.is_empty() || app_id.len() > 64 {
            return Err(AppAuthError::Malformed(format!(
                "'{app_id}' is not an app id."
            )));
        }
        let hash = pepper.hash(secret);
        let key = (app_id.to_string(), hash.clone());
        if let Ok(mut map) = self.inner.lock()
            && let Some(hit) = map.get(&key)
        {
            if hit.at.elapsed() < self.ttl() {
                return if hit.app.status == AppStatus::Active {
                    Ok(hit.app.clone())
                } else {
                    Err(AppAuthError::Disabled(app_id.to_string()))
                };
            }
            map.remove(&key);
        }
        let mut conn = pool
            .acquire()
            .await
            .map_err(|e| AppAuthError::Internal(format!("database: {e}")))?;
        let app = get(&mut conn, app_id)
            .await
            .map_err(|e| AppAuthError::Internal(e.message.clone()))?
            .ok_or_else(|| AppAuthError::UnknownApp(app_id.to_string()))?;
        if !constant_time_eq(&app.secret_hash, &hash) {
            return Err(AppAuthError::BadSecret(app_id.to_string()));
        }
        if let Ok(mut map) = self.inner.lock() {
            if map.len() > 10_000 {
                map.clear();
            }
            map.insert(
                key,
                CachedApp {
                    app: app.clone(),
                    at: Instant::now(),
                },
            );
        }
        if app.status != AppStatus::Active {
            return Err(AppAuthError::Disabled(app_id.to_string()));
        }
        Ok(app)
    }
}
