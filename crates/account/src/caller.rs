//! "App or session" authentication for the account lookups (`GET /v1/accounts/…`): apps send
//! their credentials (`Authorization: Basic`), Carbons and Silicons their session cookie or a
//! first-party Bearer access token.

use accounts_core::http::cookies::{SESSION_COOKIE, read_cookie};
use accounts_core::http::{AccountAuth, AppAuth};
use accounts_core::models::App;
use accounts_core::{ApiError, AppState};
use axum::extract::{FromRef, FromRequestParts};
use axum::http::header::AUTHORIZATION;
use axum::http::request::Parts;

/// Who is looking an account up.
#[derive(Debug, Clone)]
pub(crate) enum Caller {
    /// An app with its own credentials.
    App(Box<App>),
    /// A signed-in Carbon or Silicon.
    Account(Box<AccountAuth>),
}

impl Caller {
    /// `app:{app_id}` or `account:{uuid}` (for logs).
    pub(crate) fn describe(&self) -> String {
        match self {
            Caller::App(app) => format!("app:{}", app.app_id),
            Caller::Account(a) => format!("account:{}", a.uuid()),
        }
    }
}

fn is_basic(parts: &Parts) -> bool {
    parts
        .headers
        .get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim_start().split_once(' '))
        .is_some_and(|(scheme, _)| scheme.eq_ignore_ascii_case("basic"))
}

impl<S> FromRequestParts<S> for Caller
where
    AppState: FromRef<S>,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        if is_basic(parts) {
            let app = <AppAuth as FromRequestParts<S>>::from_request_parts(parts, state).await?;
            return Ok(Caller::App(Box::new(app.app)));
        }
        let app_state = AppState::from_ref(state);
        let has_credentials = parts.headers.contains_key(AUTHORIZATION)
            || read_cookie(&parts.headers, &app_state.settings, SESSION_COOKIE).is_some();
        if !has_credentials {
            return Err(ApiError::unauthenticated(
                "unauthenticated",
                "Looking up an account needs credentials: an app sends Authorization: Basic base64(app_id:app_secret); a Carbon or Silicon sends its session cookie or an Authorization: Bearer access token issued to the accounts app.",
            )
            .hint("Apps: use the app_id and secret from Silicon Apps. Carbons and Silicons: sign in with `accounts login` first."));
        }
        let auth = <AccountAuth as FromRequestParts<S>>::from_request_parts(parts, state).await?;
        Ok(Caller::Account(Box::new(auth)))
    }
}
