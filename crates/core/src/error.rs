//! Error responses.
//!
//! [`ApiError`] renders the body every non-OAuth endpoint uses:
//! `{"error":{"code","message","hint","details"}}`. `message` says exactly what was wrong and why;
//! `hint` says what to do next. 429/423 responses carry `Retry-After` and
//! `details.retry_after_seconds`; 500s never leak internals and carry `details.request_id`.
//!
//! [`OAuthError`] renders RFC 6749 bodies (`{"error","error_description"}`) for `/v1/oauth/*`.

use std::borrow::Cow;
use std::collections::BTreeMap;
use std::fmt;

use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::{Map, Value, json};

use crate::http::request_id;

/// Result alias for handlers and repositories.
pub type ApiResult<T> = Result<T, ApiError>;

/// An error returned to the caller with the spec's JSON shape.
#[derive(Debug, Clone)]
pub struct ApiError {
    pub status: StatusCode,
    pub code: Cow<'static, str>,
    pub message: String,
    pub hint: Option<String>,
    pub details: Map<String, Value>,
    /// Seconds until a retry can succeed (429 / 423); adds `Retry-After`.
    pub retry_after: Option<u64>,
}

impl ApiError {
    /// A new error with a status, a stable snake_case code and a precise message.
    pub fn new(
        status: StatusCode,
        code: impl Into<Cow<'static, str>>,
        message: impl Into<String>,
    ) -> Self {
        ApiError {
            status,
            code: code.into(),
            message: message.into(),
            hint: None,
            details: Map::new(),
            retry_after: None,
        }
    }

    /// Adds what the caller should do next.
    pub fn hint(mut self, hint: impl Into<String>) -> Self {
        self.hint = Some(hint.into());
        self
    }

    /// Adds one `details` entry.
    pub fn detail(mut self, key: &str, value: impl Into<Value>) -> Self {
        self.details.insert(key.to_string(), value.into());
        self
    }

    /// Merges a JSON object into `details` (non-objects are stored under `details.info`).
    pub fn details(mut self, value: Value) -> Self {
        match value {
            Value::Object(map) => self.details.extend(map),
            other => {
                self.details.insert("info".into(), other);
            }
        }
        self
    }

    /// Sets `Retry-After` and `details.retry_after_seconds`.
    pub fn retry_after(mut self, seconds: u64) -> Self {
        let seconds = seconds.max(1);
        self.retry_after = Some(seconds);
        self.details
            .insert("retry_after_seconds".into(), json!(seconds));
        self
    }

    /// 400 with a specific code.
    pub fn bad_request(code: impl Into<Cow<'static, str>>, message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, code, message)
    }

    /// 400 `invalid_request`.
    pub fn invalid_request(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "invalid_request", message)
    }

    /// 401 with a specific code.
    pub fn unauthenticated(code: impl Into<Cow<'static, str>>, message: impl Into<String>) -> Self {
        Self::new(StatusCode::UNAUTHORIZED, code, message)
    }

    /// 403 with a specific code.
    pub fn forbidden(code: impl Into<Cow<'static, str>>, message: impl Into<String>) -> Self {
        Self::new(StatusCode::FORBIDDEN, code, message)
    }

    /// 404 with a specific code.
    pub fn not_found(code: impl Into<Cow<'static, str>>, message: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, code, message)
    }

    /// 409 with a specific code.
    pub fn conflict(code: impl Into<Cow<'static, str>>, message: impl Into<String>) -> Self {
        Self::new(StatusCode::CONFLICT, code, message)
    }

    /// 410 with a specific code (expired things).
    pub fn gone(code: impl Into<Cow<'static, str>>, message: impl Into<String>) -> Self {
        Self::new(StatusCode::GONE, code, message)
    }

    /// 422 with a specific code.
    pub fn unprocessable(code: impl Into<Cow<'static, str>>, message: impl Into<String>) -> Self {
        Self::new(StatusCode::UNPROCESSABLE_ENTITY, code, message)
    }

    /// 422 `validation_failed` with `details.fields` (path → problem).
    pub fn validation(fields: FieldErrors) -> Self {
        let message = fields.summary();
        let mut e = Self::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "validation_failed",
            message,
        )
        .hint("Fix the fields listed in details.fields and send the request again.");
        e.details.insert("fields".into(), fields.to_json());
        e
    }

    /// 423 with a specific code and the seconds until it unlocks.
    pub fn locked(
        code: impl Into<Cow<'static, str>>,
        message: impl Into<String>,
        retry_after_seconds: u64,
    ) -> Self {
        Self::new(StatusCode::LOCKED, code, message).retry_after(retry_after_seconds)
    }

    /// 429 `rate_limited` with the seconds until the window allows another request.
    pub fn rate_limited(message: impl Into<String>, retry_after_seconds: u64) -> Self {
        Self::new(StatusCode::TOO_MANY_REQUESTS, "rate_limited", message)
            .retry_after(retry_after_seconds)
            .hint(format!(
                "Wait {} seconds before trying again.",
                retry_after_seconds.max(1)
            ))
    }

    /// 503 with a specific code.
    pub fn unavailable(code: impl Into<Cow<'static, str>>, message: impl Into<String>) -> Self {
        Self::new(StatusCode::SERVICE_UNAVAILABLE, code, message)
    }

    /// 500 `internal`. Logs `context` (never sent to the caller).
    pub fn internal(context: impl fmt::Display) -> Self {
        tracing::error!(error = %context, "internal error");
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal",
            "Silicon Accounts failed while handling this request; this is a fault on our side, not in your input.",
        )
        .hint("Retry in a moment. If it keeps failing, report it with `accounts report \"<what you did>\"` and include details.request_id.")
    }

    /// True for 5xx.
    pub fn is_server_error(&self) -> bool {
        self.status.is_server_error()
    }

    /// The JSON body (`{"error":{...}}`) without the request id.
    pub fn body(&self) -> Value {
        let mut inner = Map::new();
        inner.insert("code".into(), Value::String(self.code.to_string()));
        inner.insert("message".into(), Value::String(self.message.clone()));
        if let Some(h) = &self.hint {
            inner.insert("hint".into(), Value::String(h.clone()));
        }
        if !self.details.is_empty() {
            inner.insert("details".into(), Value::Object(self.details.clone()));
        }
        json!({ "error": Value::Object(inner) })
    }
}

impl fmt::Display for ApiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{} {}: {}",
            self.status.as_u16(),
            self.code,
            self.message
        )?;
        if let Some(h) = &self.hint {
            write!(f, " (hint: {h})")?;
        }
        Ok(())
    }
}

impl std::error::Error for ApiError {}

impl IntoResponse for ApiError {
    fn into_response(mut self) -> Response {
        let request_id = request_id::current();
        if self.status.is_server_error()
            && let Some(id) = &request_id
        {
            self.details
                .insert("request_id".into(), Value::String(id.clone()));
        }
        let mut response = (self.status, axum::Json(self.body())).into_response();
        let headers = response.headers_mut();
        if let Some(secs) = self.retry_after
            && let Ok(v) = HeaderValue::from_str(&secs.to_string())
        {
            headers.insert(header::RETRY_AFTER, v);
        }
        if let Some(id) = request_id
            && let Ok(v) = HeaderValue::from_str(&id)
        {
            headers.insert(request_id::HEADER, v);
        }
        if self.status == StatusCode::UNAUTHORIZED {
            headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
        }
        response
    }
}

impl From<sqlx::Error> for ApiError {
    fn from(e: sqlx::Error) -> Self {
        match &e {
            sqlx::Error::PoolTimedOut | sqlx::Error::PoolClosed => {
                tracing::error!(error = %e, "database pool unavailable");
                ApiError::unavailable(
                    "database_unavailable",
                    "Silicon Accounts can't reach its database right now, so nothing was changed.",
                )
                .hint("Retry in a few seconds.")
            }
            _ => ApiError::internal(format!("database: {e}")),
        }
    }
}

impl From<serde_json::Error> for ApiError {
    fn from(e: serde_json::Error) -> Self {
        ApiError::internal(format!("json: {e}"))
    }
}

impl From<anyhow::Error> for ApiError {
    fn from(e: anyhow::Error) -> Self {
        ApiError::internal(format!("{e:#}"))
    }
}

impl From<crate::crypto::CryptoError> for ApiError {
    fn from(e: crate::crypto::CryptoError) -> Self {
        ApiError::internal(format!("crypto: {e}"))
    }
}

impl From<crate::jwt::JwtError> for ApiError {
    fn from(e: crate::jwt::JwtError) -> Self {
        ApiError::internal(format!("jwt: {e}"))
    }
}

/// Validation problems keyed by field path (`branding.light.primary`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FieldErrors(pub BTreeMap<String, String>);

impl FieldErrors {
    pub fn new() -> Self {
        Self::default()
    }

    /// Records a problem for `path` (the first problem per path wins).
    pub fn add(&mut self, path: impl Into<String>, problem: impl Into<String>) {
        self.0.entry(path.into()).or_insert_with(|| problem.into());
    }

    /// Records every problem of `other` under `prefix.` (or as-is when prefix is empty).
    pub fn extend_prefixed(&mut self, prefix: &str, other: FieldErrors) {
        for (k, v) in other.0 {
            let path = if prefix.is_empty() {
                k
            } else if k.is_empty() {
                prefix.to_string()
            } else {
                format!("{prefix}.{k}")
            };
            self.add(path, v);
        }
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn get(&self, path: &str) -> Option<&str> {
        self.0.get(path).map(String::as_str)
    }

    /// `Ok(())` when empty, else the 422 [`ApiError`].
    pub fn into_result(self) -> Result<(), ApiError> {
        if self.is_empty() {
            Ok(())
        } else {
            Err(ApiError::validation(self))
        }
    }

    /// One-line summary used as the error message.
    pub fn summary(&self) -> String {
        let mut parts: Vec<String> = self
            .0
            .iter()
            .take(3)
            .map(|(k, v)| format!("{k}: {v}"))
            .collect();
        if self.0.len() > 3 {
            parts.push(format!("and {} more", self.0.len() - 3));
        }
        if parts.is_empty() {
            "The request has invalid fields.".to_string()
        } else {
            format!("Invalid fields — {}.", parts.join("; "))
        }
    }

    pub fn to_json(&self) -> Value {
        Value::Object(
            self.0
                .iter()
                .map(|(k, v)| (k.clone(), Value::String(v.clone())))
                .collect(),
        )
    }
}

/// RFC 6749 error for `/v1/oauth/*`: `{"error":"invalid_grant","error_description":"..."}`.
#[derive(Debug, Clone)]
pub struct OAuthError {
    pub status: StatusCode,
    pub error: Cow<'static, str>,
    pub description: String,
}

impl OAuthError {
    pub fn new(
        status: StatusCode,
        error: impl Into<Cow<'static, str>>,
        description: impl Into<String>,
    ) -> Self {
        OAuthError {
            status,
            error: error.into(),
            description: description.into(),
        }
    }

    /// 400 invalid_request.
    pub fn invalid_request(description: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "invalid_request", description)
    }

    /// 401 invalid_client (adds `WWW-Authenticate: Basic`).
    pub fn invalid_client(description: impl Into<String>) -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "invalid_client", description)
    }

    /// 400 invalid_grant.
    pub fn invalid_grant(description: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "invalid_grant", description)
    }

    /// 400 unauthorized_client.
    pub fn unauthorized_client(description: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "unauthorized_client", description)
    }

    /// 400 unsupported_grant_type.
    pub fn unsupported_grant_type(description: impl Into<String>) -> Self {
        Self::new(
            StatusCode::BAD_REQUEST,
            "unsupported_grant_type",
            description,
        )
    }

    /// 400 invalid_scope.
    pub fn invalid_scope(description: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "invalid_scope", description)
    }

    /// 400 authorization_pending (device flow).
    pub fn authorization_pending(description: impl Into<String>) -> Self {
        Self::new(
            StatusCode::BAD_REQUEST,
            "authorization_pending",
            description,
        )
    }

    /// 400 slow_down (device flow).
    pub fn slow_down(description: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "slow_down", description)
    }

    /// 400 access_denied.
    pub fn access_denied(description: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "access_denied", description)
    }

    /// 400 expired_token (device flow).
    pub fn expired_token(description: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "expired_token", description)
    }

    /// 500 server_error (logs `context`).
    pub fn server_error(context: impl fmt::Display) -> Self {
        tracing::error!(error = %context, "oauth internal error");
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "server_error",
            "Silicon Accounts failed while handling this token request; retry in a moment.",
        )
    }

    pub fn body(&self) -> Value {
        json!({ "error": self.error.to_string(), "error_description": self.description })
    }
}

impl fmt::Display for OAuthError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.error, self.description)
    }
}

impl std::error::Error for OAuthError {}

impl IntoResponse for OAuthError {
    fn into_response(self) -> Response {
        let mut response = (self.status, axum::Json(self.body())).into_response();
        let headers = response.headers_mut();
        headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
        headers.insert(header::PRAGMA, HeaderValue::from_static("no-cache"));
        if self.status == StatusCode::UNAUTHORIZED {
            headers.insert(
                header::WWW_AUTHENTICATE,
                HeaderValue::from_static("Basic realm=\"Silicon Accounts\""),
            );
        }
        if let Some(id) = request_id::current()
            && let Ok(v) = HeaderValue::from_str(&id)
        {
            headers.insert(request_id::HEADER, v);
        }
        response
    }
}

impl From<sqlx::Error> for OAuthError {
    fn from(e: sqlx::Error) -> Self {
        OAuthError::server_error(format!("database: {e}"))
    }
}

impl From<ApiError> for OAuthError {
    /// Maps an [`ApiError`] onto the closest OAuth error (used when shared helpers are reused
    /// by `/v1/oauth/*`).
    fn from(e: ApiError) -> Self {
        let error: &'static str = match e.status {
            StatusCode::UNAUTHORIZED => "invalid_client",
            s if s.is_server_error() => "server_error",
            StatusCode::BAD_REQUEST | StatusCode::UNPROCESSABLE_ENTITY => "invalid_request",
            _ => "invalid_grant",
        };
        let status = match error {
            "invalid_client" => StatusCode::UNAUTHORIZED,
            "server_error" => StatusCode::INTERNAL_SERVER_ERROR,
            _ => StatusCode::BAD_REQUEST,
        };
        let description = match &e.hint {
            Some(h) => format!("{} {}", e.message, h),
            None => e.message.clone(),
        };
        OAuthError::new(status, error, description)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn api_error_body_shape() {
        let e = ApiError::conflict("id_taken", "c:saket is taken.")
            .hint("Pick another id.")
            .detail("suggestions", json!(["c:saket-2"]));
        let body = e.body();
        assert_eq!(body["error"]["code"], "id_taken");
        assert_eq!(body["error"]["message"], "c:saket is taken.");
        assert_eq!(body["error"]["hint"], "Pick another id.");
        assert_eq!(body["error"]["details"]["suggestions"][0], "c:saket-2");
    }

    #[test]
    fn rate_limited_sets_retry_after() {
        let e = ApiError::rate_limited("Too many codes.", 42);
        assert_eq!(e.status, StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(e.details["retry_after_seconds"], 42);
        let response = e.into_response();
        assert_eq!(
            response
                .headers()
                .get(header::RETRY_AFTER)
                .and_then(|v| v.to_str().ok()),
            Some("42")
        );
    }

    #[test]
    fn field_errors_render_as_details() {
        let mut f = FieldErrors::new();
        f.add("branding.light.primary", "must be a #RRGGBB colour");
        f.add("radius", "must be between 0 and 40");
        let e = ApiError::validation(f);
        assert_eq!(e.status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(
            e.details["fields"]["branding.light.primary"],
            "must be a #RRGGBB colour"
        );
        assert!(e.message.contains("radius"));
    }

    #[test]
    fn oauth_error_shape() {
        let e = OAuthError::invalid_client("unknown app");
        assert_eq!(
            e.body(),
            json!({"error": "invalid_client", "error_description": "unknown app"})
        );
        let r = e.into_response();
        assert_eq!(r.status(), StatusCode::UNAUTHORIZED);
        assert!(r.headers().get(header::WWW_AUTHENTICATE).is_some());
    }
}
