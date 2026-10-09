//! Authentication extractors.
//!
//! - [`AccountAuth`]: the session cookie (`sa_session` / `__Host-sa_session`), or
//!   `Authorization: Bearer <access JWT>` whose `aud` is `silicon-accounts` (or `developer` on the
//!   routes listed below) and whose family is active.
//!   Cookie-authenticated POST/PUT/PATCH/DELETE must pass the origin guard (CSRF).
//!   `Option<AccountAuth>` = optional auth: no credentials → `None`; an invalid cookie → `None`;
//!   an invalid Bearer token → error (explicit credentials are never silently ignored).
//! - [`CarbonAuth`] / [`SiliconAuth`]: [`AccountAuth`] restricted by kind.
//! - [`AppAuth`]: `Authorization: Basic base64(app_id:app_secret)`, verified through the 60 s
//!   credential cache.
//! - [`authenticate_client`]: client authentication for `/v1/oauth/*` (Basic or body fields,
//!   plus the public first-party clients `silicon-accounts` and `developer`), with RFC 6749 errors.
//! - [`AppOrOwner`]: for `/v1/apps/{app_id}/…` — the app's own credentials or an accepted
//!   Carbon/Silicon author's session. Silicon Apps access tokens are accepted only on
//!   these author routes, with a live membership in the Apps application.
//!
//! # Developer platform tokens (`aud = developer`)
//!
//! developers.teamofsilicons.com signs Carbons in as the first-party public client `developer`.
//! Its access tokens act for the Carbon they belong to on exactly these routes
//! ([`developer_audience_allowed`]): `GET /v1/me`, `GET /v1/session`, `GET /v1/me/owned-apps`,
//! `GET /v1/me/app-verifications`, `GET /v1/apps/{app_id}/proofs/{proof_id}/history`,
//! and every owner route of an app ([`AppOrOwner`]: `/v1/apps/{app_id}/…` — details, sign-in
//! setup and its history, user base, imports, webhook and deliveries, proofs). Everywhere else
//! they are refused with 401 `token_wrong_audience`, so a leaked developer-platform token can't
//! change the account itself (ids, emails, Silicons, STKs, sessions, apps signed into).
//! The two verification-history reads use first-party account authentication and then the
//! same owner-or-accepted-author check; app credentials and Apps-scoped tokens cannot use them.
//! `GET/POST /v1/apps/{app_id}/account-verification-request` also accepts first-party developer
//! tokens, for that account's manual request after the same current app-management check.

use axum::extract::{
    FromRef, FromRequestParts, MatchedPath, OptionalFromRequestParts, RawPathParams,
};
use axum::http::header::AUTHORIZATION;
use axum::http::request::Parts;
use axum::http::{HeaderMap, Method};
use base64::Engine as _;
use uuid::Uuid;

use crate::error::{ApiError, OAuthError};
use crate::http::check_origin;
use crate::http::cookies::{SESSION_COOKIE, read_cookie};
use crate::jwt::AccessClaims;
use crate::models::{Account, AccountKind, AccountStatus, ActorKind, App};
use crate::repo::{accounts, apps, sessions, tokens};
use crate::state::AppState;

/// How the account authenticated.
#[derive(Debug, Clone)]
pub enum AuthVia {
    /// Browser session cookie.
    Session { session_id: Uuid },
    /// First-party access token (aud = silicon-accounts): CLI, Silicon login, device flow.
    Bearer {
        family_id: Uuid,
        claims: Box<AccessClaims>,
    },
}

/// A signed-in Carbon or Silicon.
#[derive(Debug, Clone)]
pub struct AccountAuth {
    pub account: Account,
    pub via: AuthVia,
}

impl AccountAuth {
    pub fn uuid(&self) -> &str {
        &self.account.uuid
    }

    pub fn kind(&self) -> AccountKind {
        self.account.kind
    }

    /// The browser session id (cookie auth).
    pub fn session_id(&self) -> Option<Uuid> {
        match &self.via {
            AuthVia::Session { session_id } => Some(*session_id),
            AuthVia::Bearer { .. } => None,
        }
    }

    /// The token family id (Bearer auth).
    pub fn family_id(&self) -> Option<Uuid> {
        match &self.via {
            AuthVia::Bearer { family_id, .. } => Some(*family_id),
            AuthVia::Session { .. } => None,
        }
    }

    pub fn is_cookie(&self) -> bool {
        matches!(self.via, AuthVia::Session { .. })
    }
}

fn unauthenticated() -> ApiError {
    ApiError::unauthenticated(
        "unauthenticated",
        "This endpoint needs a signed-in account: send the account site's session cookie, or an Authorization: Bearer access token issued to the silicon-accounts app.",
    )
    .hint("Carbons: run `silicon-accounts login`. Silicons: run `silicon-accounts login --silicon si:<handle> --stk-stdin` (or set ACCOUNTS_SILICON and ACCOUNTS_STK).")
}

/// Read-only identity and managed verification routes a developer token may use (GET/HEAD). The
/// owner routes of apps accept it through [`AppOrOwner`].
pub const DEVELOPER_READ_ROUTES: &[&str] = &[
    "/v1/me",
    "/v1/session",
    "/v1/me/owned-apps",
    "/v1/me/app-verifications",
    "/v1/apps/{app_id}/proofs/{proof_id}/history",
    "/v1/apps/{app_id}/account-verification-request",
];

/// True when an access token issued to the developer platform (`aud = developer`) may act on
/// this request outside [`AppOrOwner`]: a GET (or HEAD) of one of [`DEVELOPER_READ_ROUTES`],
/// or POST to the exact manual account-verification request route. Judged by the route the
/// request matched (axum's `MatchedPath`), never a client-controlled path prefix.
pub fn developer_audience_allowed(parts: &Parts) -> bool {
    if parts.method == Method::POST
        && parts
            .extensions
            .get::<MatchedPath>()
            .is_some_and(|p| p.as_str() == "/v1/apps/{app_id}/account-verification-request")
    {
        return true;
    }
    if !matches!(parts.method, Method::GET | Method::HEAD) {
        return false;
    }
    parts
        .extensions
        .get::<MatchedPath>()
        .is_some_and(|p| DEVELOPER_READ_ROUTES.contains(&p.as_str()))
}

/// 401 `token_wrong_audience` for a valid access token whose `aud` can't act here.
fn wrong_audience(parts: &Parts, aud: &str, developer_allowed: bool) -> ApiError {
    let route = parts
        .extensions
        .get::<MatchedPath>()
        .map_or_else(|| parts.uri.path().to_string(), |p| p.as_str().to_string());
    if aud == crate::DEVELOPER_APP_ID {
        return ApiError::unauthenticated(
            "token_wrong_audience",
            format!(
                "This access token was issued to the developer platform (aud '{}'), which may only read the signed-in account (GET /v1/me, GET /v1/session), list its managed apps and App verifications (GET /v1/me/owned-apps, GET /v1/me/app-verifications) and manage those apps (/v1/apps/{{app_id}}/…); it can't be used for {} {route}.",
                crate::DEVELOPER_APP_ID,
                parts.method
            ),
        )
        .hint("Use a token issued to 'silicon-accounts' for this: sign in with `silicon-accounts login` (Carbons) or `silicon-accounts login --silicon si:<handle> --stk-stdin` (Silicons), or use the account site.")
        .detail("aud", aud.to_string());
    }
    let expected = if developer_allowed {
        format!(
            "'{}' (or '{}')",
            crate::FIRST_PARTY_APP_ID,
            crate::DEVELOPER_APP_ID
        )
    } else {
        format!("'{}'", crate::FIRST_PARTY_APP_ID)
    };
    ApiError::unauthenticated(
        "token_wrong_audience",
        format!("This access token was issued to the app '{aud}', but this endpoint needs a token issued to {expected}."),
    )
    .hint("Use a first-party token: sign in with `silicon-accounts login` (Carbons) or `silicon-accounts login --silicon si:<handle> --stk-stdin` (Silicons).")
    .detail("aud", aud.to_string())
}

async fn resolve(
    parts: &Parts,
    state: &AppState,
    optional: bool,
    developer_allowed: bool,
    apps_owner_allowed: bool,
) -> Result<Option<AccountAuth>, ApiError> {
    if let Some(h) = parts.headers.get(AUTHORIZATION) {
        let raw = h
            .to_str()
            .map_err(|_| {
                ApiError::unauthenticated(
                    "invalid_authorization",
                    "The Authorization header is not valid text.",
                )
            })?
            .trim();
        let (scheme, rest) = raw
            .split_once(' ')
            .map(|(s, r)| (s, r.trim()))
            .unwrap_or((raw, ""));
        if scheme.eq_ignore_ascii_case("bearer") {
            if rest.is_empty() {
                return Err(ApiError::unauthenticated(
                    "invalid_token",
                    "The Authorization header says Bearer but carries no token.",
                )
                .hint("Send Authorization: Bearer <access token>."));
            }
            let mut conn = state.db.acquire().await?;
            // The audience is checked here rather than by core's verification: which first-party
            // audiences may act depends on the route (see the module docs).
            let v = tokens::verify_access_token(&mut conn, &state.keys, rest, None).await?;
            let aud = v.claims.aud.as_str();
            let apps_owner_route = aud == crate::SILICON_APPS_APP_ID
                && apps_owner_allowed
                && parts
                    .extensions
                    .get::<MatchedPath>()
                    .is_some_and(|p| p.as_str().starts_with("/v1/apps/"));
            if apps_owner_route {
                let active: bool = sqlx::query_scalar("select exists(select 1 from memberships m join apps a on a.app_id=m.app_id where m.app_id='silicon-apps' and m.account_uuid=$1 and m.status='active' and a.status='active')")
                    .bind(&v.account.uuid).fetch_one(&mut *conn).await?;
                if !active {
                    return Err(ApiError::unauthenticated(
                        "access_removed",
                        "The account no longer has access to Silicon Apps.",
                    ));
                }
            }
            let accepted = apps_owner_route
                || aud == crate::FIRST_PARTY_APP_ID
                || (aud == crate::DEVELOPER_APP_ID && developer_allowed);
            if !accepted {
                return Err(wrong_audience(parts, aud, developer_allowed));
            }
            return Ok(Some(AccountAuth {
                account: v.account,
                via: AuthVia::Bearer {
                    family_id: v.family.id,
                    claims: Box::new(v.claims),
                },
            }));
        }
        if scheme.eq_ignore_ascii_case("basic") {
            return Err(ApiError::unauthenticated(
                "account_auth_required",
                "This endpoint acts for a signed-in Carbon or Silicon, so app credentials (Basic) can't be used here.",
            )
            .hint("Use the account's session cookie or an Authorization: Bearer access token issued to the silicon-accounts app."));
        }
        return Err(ApiError::unauthenticated(
            "invalid_authorization",
            format!(
                "The Authorization scheme '{scheme}' is not supported here; use Bearer <access token>."
            ),
        ));
    }
    let Some(cookie) = read_cookie(&parts.headers, &state.settings, SESSION_COOKIE) else {
        return Ok(None);
    };
    let mut conn = state.db.acquire().await?;
    let Some(session) = sessions::lookup(&mut conn, &state.keys.pepper, &cookie).await? else {
        if optional {
            return Ok(None);
        }
        return Err(ApiError::unauthenticated(
            "session_expired",
            "Your session cookie is no longer valid: you signed out, it was revoked, or it expired.",
        )
        .hint(format!("Sign in again at {}.", state.settings.public_url)));
    };
    check_origin(&state.settings, &parts.headers, &parts.method)?;
    let account = accounts::get(&mut conn, &session.account_uuid)
        .await?
        .ok_or_else(unauthenticated)?;
    if account.status == AccountStatus::Deleted {
        return Err(ApiError::unauthenticated(
            "account_deleted",
            "The account of this session was deleted.",
        ));
    }
    sessions::touch(&mut conn, session.id).await?;
    Ok(Some(AccountAuth {
        account,
        via: AuthVia::Session {
            session_id: session.id,
        },
    }))
}

impl<S> FromRequestParts<S> for AccountAuth
where
    AppState: FromRef<S>,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let state = AppState::from_ref(state);
        let developer_allowed = developer_audience_allowed(parts);
        resolve(parts, &state, false, developer_allowed, false)
            .await?
            .ok_or_else(unauthenticated)
    }
}

impl<S> OptionalFromRequestParts<S> for AccountAuth
where
    AppState: FromRef<S>,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &S,
    ) -> Result<Option<Self>, Self::Rejection> {
        let state = AppState::from_ref(state);
        let developer_allowed = developer_audience_allowed(parts);
        resolve(parts, &state, true, developer_allowed, false).await
    }
}

/// A signed-in Carbon (403 `carbon_only` for Silicons).
#[derive(Debug, Clone)]
pub struct CarbonAuth(pub AccountAuth);

impl std::ops::Deref for CarbonAuth {
    type Target = AccountAuth;
    fn deref(&self) -> &AccountAuth {
        &self.0
    }
}

impl<S> FromRequestParts<S> for CarbonAuth
where
    AppState: FromRef<S>,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let auth = <AccountAuth as FromRequestParts<S>>::from_request_parts(parts, state).await?;
        if auth.kind() != AccountKind::Carbon {
            return Err(ApiError::forbidden(
                "carbon_only",
                format!("This endpoint is for Carbons, but you are signed in as the Silicon {}.", auth.account.display_id()),
            )
            .hint("A Silicon manages itself through /v1/me; its custodian manages it through /v1/me/silicons."));
        }
        Ok(CarbonAuth(auth))
    }
}

/// A signed-in Silicon (403 `silicon_only` for Carbons).
#[derive(Debug, Clone)]
pub struct SiliconAuth(pub AccountAuth);

impl std::ops::Deref for SiliconAuth {
    type Target = AccountAuth;
    fn deref(&self) -> &AccountAuth {
        &self.0
    }
}

impl<S> FromRequestParts<S> for SiliconAuth
where
    AppState: FromRef<S>,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let auth = <AccountAuth as FromRequestParts<S>>::from_request_parts(parts, state).await?;
        if auth.kind() != AccountKind::Silicon {
            return Err(ApiError::forbidden(
                "silicon_only",
                format!(
                    "This endpoint is for Silicons, but you are signed in as the Carbon {}.",
                    auth.account.display_id()
                ),
            )
            .hint("Custodians manage their Silicons through /v1/me/silicons/{uuid}."));
        }
        Ok(SiliconAuth(auth))
    }
}

/// Parses `Authorization: Basic base64(id:secret)` (percent-decoding both parts, RFC 6749
/// §2.3.1). `Ok(None)` when there is no Basic header; `Err` with a precise message when it is
/// malformed.
pub fn basic_credentials(headers: &HeaderMap) -> Result<Option<(String, String)>, String> {
    let Some(h) = headers.get(AUTHORIZATION) else {
        return Ok(None);
    };
    let raw = h
        .to_str()
        .map_err(|_| "The Authorization header is not valid text.".to_string())?
        .trim();
    let Some((scheme, rest)) = raw.split_once(' ') else {
        return Ok(None);
    };
    if !scheme.eq_ignore_ascii_case("basic") {
        return Ok(None);
    }
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(rest.trim())
        .map_err(|_| {
            "The Basic credentials are not valid base64 of app_id:app_secret.".to_string()
        })?;
    let text = String::from_utf8(decoded)
        .map_err(|_| "The Basic credentials are not UTF-8.".to_string())?;
    let (id, secret) = text.split_once(':').ok_or_else(|| {
        "The Basic credentials must be base64 of app_id:app_secret (with a colon).".to_string()
    })?;
    let id = percent_encoding::percent_decode_str(id)
        .decode_utf8_lossy()
        .trim()
        .to_string();
    let secret = percent_encoding::percent_decode_str(secret)
        .decode_utf8_lossy()
        .trim()
        .to_string();
    if id.is_empty() || secret.is_empty() {
        return Err("The Basic credentials have an empty app_id or app_secret.".into());
    }
    Ok(Some((id, secret)))
}

/// An app authenticated with `Authorization: Basic`.
#[derive(Debug, Clone)]
pub struct AppAuth {
    pub app: App,
}

impl<S> FromRequestParts<S> for AppAuth
where
    AppState: FromRef<S>,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let state = AppState::from_ref(state);
        match basic_credentials(&parts.headers) {
            Err(m) => Err(ApiError::unauthenticated("invalid_app_credentials", m)
                .hint("Send Authorization: Basic base64(app_id:app_secret).")),
            Ok(None) => Err(ApiError::unauthenticated(
                "app_credentials_required",
                "This endpoint is called by apps: send Authorization: Basic base64(app_id:app_secret).",
            )
            .hint("Find the app_id and secret in Silicon Apps.")),
            Ok(Some((id, secret))) => state
                .app_cache
                .verify(&state.db, &state.keys.pepper, &id, &secret)
                .await
                .map(|app| AppAuth { app })
                .map_err(|e| e.to_api()),
        }
    }
}

/// A client authenticated at `/v1/oauth/*`.
#[derive(Debug, Clone)]
pub struct ClientAuth {
    pub app: App,
    /// True for a first-party public client sent without a secret: `client_id=silicon-accounts` (the
    /// silicon-accounts CLI: device-code and refresh-token grants, revocation) or `client_id=developer`
    /// (the developer platform: authorization code with PKCE S256, refresh token, revocation).
    /// Each only ever touches its own tokens.
    pub public: bool,
}

/// Authenticates the client of a token/revoke/introspect request: HTTP Basic, or `client_id` +
/// `client_secret` in the body, or `client_id=silicon-accounts` / `client_id=developer` alone (the
/// first-party public clients; what each may do is decided by the endpoint).
pub async fn authenticate_client(
    state: &AppState,
    headers: &HeaderMap,
    body_client_id: Option<&str>,
    body_client_secret: Option<&str>,
) -> Result<ClientAuth, OAuthError> {
    let body_id = body_client_id.map(str::trim).filter(|s| !s.is_empty());
    let body_secret = body_client_secret.map(str::trim).filter(|s| !s.is_empty());
    let basic = basic_credentials(headers).map_err(OAuthError::invalid_client)?;
    let (id, secret) = match (basic, body_id, body_secret) {
        (Some(_), _, Some(_)) => {
            return Err(OAuthError::invalid_request(
                "The client authenticated twice (Basic header and client_secret in the body); use exactly one method.",
            ));
        }
        (Some((id, _)), Some(bid), None) if bid != id => {
            return Err(OAuthError::invalid_client(format!(
                "client_id '{bid}' in the body doesn't match the Basic credentials for '{id}'."
            )));
        }
        (Some((id, secret)), _, None) => (id, secret),
        (None, Some(id), Some(secret)) => (id.to_string(), secret.to_string()),
        (None, Some(id), None)
            if crate::is_first_party_app_id(crate::canonical_first_party_app_id(id)) =>
        {
            let id = crate::canonical_first_party_app_id(id);
            let mut conn = state.db.acquire().await?;
            let app = apps::get(&mut conn, id)
                .await
                .map_err(|e| OAuthError::server_error(e.message))?
                .ok_or_else(|| {
                    OAuthError::server_error(format!(
                        "the first-party app '{id}' is missing; run the migrations (accounts-migrate)"
                    ))
                })?;
            if !app.is_active() {
                return Err(OAuthError::invalid_client(format!(
                    "The first-party client '{id}' is disabled on this deployment."
                )));
            }
            return Ok(ClientAuth { app, public: true });
        }
        (None, Some(id), None) => {
            // An app whose command-line or desktop tools are public clients (it turned on
            // `device_flow` or `public_client` in its sign-in setup) may name itself alone;
            // what such a client may do is decided by the endpoint.
            let mut conn = state.db.acquire().await?;
            let app = apps::get(&mut conn, id)
                .await
                .map_err(|e| OAuthError::server_error(e.message))?;
            if let Some(app) = app {
                let config = apps::effective_config(&mut conn, &state.settings, &app.app_id)
                    .await
                    .map_err(|e| OAuthError::server_error(e.message))?;
                if config.device_flow || config.public_client {
                    if !app.is_active() {
                        return Err(OAuthError::invalid_client(format!(
                            "The app '{id}' is disabled, so it can't sign anyone in."
                        )));
                    }
                    return Ok(ClientAuth { app, public: true });
                }
            }
            return Err(OAuthError::invalid_client(format!(
                "client_secret is required for the app '{id}'; send it with HTTP Basic or as client_secret in the body. An app's command-line or desktop tool can sign in without a secret once the app turns on device_flow or public_client in its sign-in setup."
            )));
        }
        (None, None, _) => {
            return Err(OAuthError::invalid_client(
                "The client is not authenticated: use HTTP Basic (client_id:client_secret) or send client_id and client_secret in the body.",
            ));
        }
    };
    let app = state
        .app_cache
        .verify(&state.db, &state.keys.pepper, &id, &secret)
        .await
        .map_err(|e| e.to_oauth())?;
    Ok(ClientAuth { app, public: false })
}

/// Who is acting in an [`AppOrOwner`] request.
#[derive(Debug, Clone)]
pub enum AppActor {
    /// The app with its own credentials.
    App,
    /// The Carbon who owns the app, through their session.
    Owner(Box<Account>),
}

/// The app of a `/v1/apps/{app_id}/…` route, authorized by its own credentials or by its owner.
#[derive(Debug, Clone)]
pub struct AppOrOwner {
    pub app: App,
    pub actor: AppActor,
}

impl AppOrOwner {
    /// `app` or the owner's uuid (the `actor` of app_config_history, import jobs, …).
    pub fn history_actor(&self) -> String {
        match &self.actor {
            AppActor::App => "app".to_string(),
            AppActor::Owner(a) => a.uuid.clone(),
        }
    }

    /// Audit actor (kind, id).
    pub fn audit_actor(&self) -> (ActorKind, String) {
        match &self.actor {
            AppActor::App => (ActorKind::App, self.app.app_id.clone()),
            AppActor::Owner(a) => (ActorKind::Account, a.uuid.clone()),
        }
    }

    pub fn is_owner(&self) -> bool {
        matches!(self.actor, AppActor::Owner(_))
    }
}

impl<S> FromRequestParts<S> for AppOrOwner
where
    AppState: FromRef<S>,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let app_state = AppState::from_ref(state);
        let params = RawPathParams::from_request_parts(parts, state)
            .await
            .map_err(|e| {
                ApiError::internal(format!("AppOrOwner path params: {}", e.body_text()))
            })?;
        let app_id = params
            .iter()
            .find(|(k, _)| *k == "app_id")
            .map(|(_, v)| v.to_string())
            .ok_or_else(|| ApiError::internal("AppOrOwner used on a route without {app_id}"))?;

        match basic_credentials(&parts.headers) {
            Err(m) => Err(ApiError::unauthenticated("invalid_app_credentials", m)
                .hint("Send Authorization: Basic base64(app_id:app_secret).")),
            Ok(Some((id, secret))) => {
                let app = app_state
                    .app_cache
                    .verify(&app_state.db, &app_state.keys.pepper, &id, &secret)
                    .await
                    .map_err(|e| e.to_api())?;
                if app.app_id != app_id {
                    return Err(ApiError::forbidden(
                        "app_mismatch",
                        format!("These credentials belong to the app '{}', but this URL is about the app '{app_id}'.", app.app_id),
                    )
                    .hint(format!("Call /v1/apps/{}/… with these credentials, or use the credentials of '{app_id}'.", app.app_id)));
                }
                Ok(AppOrOwner {
                    app,
                    actor: AppActor::App,
                })
            }
            Ok(None) => {
                // Every owner route of an app accepts the developer platform's tokens.
                let auth = resolve(parts, &app_state, false, true, true).await?.ok_or_else(|| {
                    ApiError::unauthenticated(
                        "unauthenticated",
                        format!(
                            "Managing the app '{app_id}' needs the app's credentials (Authorization: Basic base64(app_id:app_secret)) or the session of the Carbon who owns it."
                        ),
                    )
                })?;
                let mut conn = app_state.db.acquire().await?;
                let app = apps::get(&mut conn, &app_id)
                    .await?
                    .ok_or_else(|| apps::unknown_app(&app_id))?;
                let coauthor: bool = sqlx::query_scalar(
                    "select exists(select 1 from app_authors where app_id=$1 and account_uuid=$2)",
                )
                .bind(&app_id)
                .bind(auth.uuid())
                .fetch_one(&mut *conn)
                .await?;
                if app.owner_uuid.as_deref() != Some(auth.uuid()) && !coauthor {
                    return Err(ApiError::forbidden(
                        "not_app_owner",
                        format!(
                            "{} is not the owner of the app '{app_id}'.",
                            auth.account.display_id()
                        ),
                    )
                    .hint("Sign in as the app's owner, or use the app's own credentials."));
                }
                Ok(AppOrOwner {
                    app,
                    actor: AppActor::Owner(Box::new(auth.account)),
                })
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn basic_parsing() {
        let mut h = HeaderMap::new();
        assert_eq!(basic_credentials(&h), Ok(None));
        let enc = base64::engine::general_purpose::STANDARD.encode("briefcase:sa_app_secret%2B1");
        h.insert(AUTHORIZATION, format!("Basic {enc}").parse().expect("hv"));
        assert_eq!(
            basic_credentials(&h),
            Ok(Some(("briefcase".into(), "sa_app_secret+1".into())))
        );
        h.insert(AUTHORIZATION, "Basic !!!".parse().expect("hv"));
        assert!(basic_credentials(&h).is_err());
        h.insert(AUTHORIZATION, "Bearer abc".parse().expect("hv"));
        assert_eq!(basic_credentials(&h), Ok(None));
        let enc = base64::engine::general_purpose::STANDARD.encode("nocolon");
        h.insert(AUTHORIZATION, format!("Basic {enc}").parse().expect("hv"));
        assert!(
            basic_credentials(&h)
                .expect_err("no colon")
                .contains("colon")
        );
    }
}
