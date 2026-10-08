//! `GET` / `POST /v1/userinfo` (OIDC Core §5.3): the account behind an access token, as the
//! token's app may see it — `AccountForApp` limited to the granted scopes, plus the OIDC claim
//! names (`sub`, `name`, `picture`, `email`, `email_verified`, `phone_number`,
//! `phone_number_verified`, `zoneinfo`, `birthdate`).
//!
//! Any audience works (first-party tokens too) as long as the token hasn't expired (strictly at
//! its `exp`), its sign-in is live, its app is active, the account isn't deleted and, for an
//! app's token, the account's membership with the app is active (`access_removed` /
//! `membership_inactive` otherwise). The token travels as `Authorization: Bearer …`, or, for
//! POST, as a form-encoded `access_token` (RFC 6750 §2.2), never both. Errors use the API error
//! shape plus a `WWW-Authenticate: Bearer …` header (RFC 6750 §3) so OIDC libraries understand
//! them.

use accounts_core::http::parse_form_or_json;
use accounts_core::models::{AccountKind, AppStatus, MembershipStatus, Scope};
use accounts_core::repo::tokens::{self, VerifiedAccess};
use accounts_core::timefmt::format_rfc3339_ms;
use accounts_core::views::load_account_for_app;
use accounts_core::{ApiError, AppState, is_first_party_app_id};
use axum::body::Bytes;
use axum::extract::State;
use axum::extract::rejection::BytesRejection;
use axum::http::header::{AUTHORIZATION, CONTENT_TYPE, WWW_AUTHENTICATE};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::Value;
use sqlx::PgConnection;
use time::OffsetDateTime;

use crate::credentials::{access_claims_ignoring_expiry, membership_state};
use crate::respond::{no_store, rfc6749_text};

const REALM: &str = "Bearer realm=\"Silicon Accounts\"";

#[derive(Default, Deserialize)]
struct UserinfoForm {
    access_token: Option<String>,
}

/// `GET /v1/userinfo`.
pub(crate) async fn userinfo_get(State(state): State<AppState>, headers: HeaderMap) -> Response {
    match bearer(&headers) {
        Ok(token) => answer(&state, token).await,
        Err(e) => bearer_error(e),
    }
}

/// `POST /v1/userinfo` (Authorization header or a form `access_token`).
pub(crate) async fn userinfo_post(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> Response {
    let from_header = match bearer(&headers) {
        Ok(token) => token,
        Err(e) => return bearer_error(e),
    };
    let from_body = match body
        .map_err(|r| {
            ApiError::invalid_request(format!(
                "The request body could not be read: {}.",
                r.body_text()
            ))
        })
        .and_then(|bytes| form_token(&headers, &bytes))
    {
        Ok(token) => token,
        Err(e) => return bearer_error(e),
    };
    let token = match (from_header, from_body) {
        (Some(_), Some(_)) => {
            return bearer_error(
                ApiError::invalid_request(
                    "The access token was sent twice: in the Authorization header and as the access_token form field. Send it exactly once (RFC 6750 section 2).",
                )
                .hint("Prefer Authorization: Bearer <access token>."),
            );
        }
        (header, body) => header.or(body),
    };
    answer(&state, token).await
}

async fn answer(state: &AppState, token: Option<String>) -> Response {
    let Some(token) = token else {
        return bearer_error(
            ApiError::unauthenticated(
                "unauthenticated",
                "/v1/userinfo needs an access token: send Authorization: Bearer <access token>.",
            )
            .hint("Use the access_token your app received from POST /v1/oauth/token."),
        );
    };
    match userinfo(state, &token).await {
        Ok(view) => no_store(StatusCode::OK, &view),
        Err(e) => bearer_error(e),
    }
}

async fn userinfo(state: &AppState, token: &str) -> Result<Value, ApiError> {
    let mut conn = state.db.acquire().await?;
    let now = OffsetDateTime::now_utc().unix_timestamp();
    // Core's verification allows 30 s of clock skew; this server issued the token and is the
    // clock, so a token stops working at its `exp` (the 30-minute contract, not 30 min 30 s).
    let verified = match tokens::verify_access_token(&mut conn, &state.keys, token, None).await {
        Ok(v) if v.claims.exp <= now => return Err(expired(state, v.claims.exp)),
        Ok(v) => v,
        // Whichever check failed, a genuine token past its `exp` is reported as expired, with
        // the moment it expired.
        Err(e) => {
            return Err(
                match access_claims_ignoring_expiry(&state.keys.jwt, token) {
                    Some(claims) if claims.exp <= now && !e.is_server_error() => {
                        expired(state, claims.exp)
                    }
                    _ => e,
                },
            );
        }
    };
    // A disabled app's tokens stop reading accounts, like its credentials stop working.
    let app_status: Option<AppStatus> =
        sqlx::query_scalar("select status from apps where app_id = $1")
            .bind(&verified.family.app_id)
            .fetch_optional(&mut *conn)
            .await?;
    if app_status != Some(AppStatus::Active) {
        return Err(ApiError::unauthenticated(
            "app_disabled",
            format!(
                "This access token was issued to the app '{}', which is disabled, so it can't read accounts right now.",
                verified.family.app_id
            ),
        )
        .hint("Ask the app's owner to re-enable it in Silicon Apps; its tokens work again once it is active."));
    }
    if !is_first_party_app_id(&verified.family.app_id) {
        require_membership(&mut conn, &verified).await?;
    }
    let scopes = verified.family.scope_list();
    let view = load_account_for_app(
        &mut conn,
        &verified.account,
        &verified.family.app_id,
        &scopes,
    )
    .await?;
    let mut info = view.userinfo_json();
    // Silicon Apps evaluates private domain grants against any verified email. This
    // catalog-only extension is still gated by explicit email consent; other apps
    // retain the existing primary-email contract.
    if verified.family.app_id == "apps"
        && verified.account.kind == AccountKind::Carbon
        && scopes.contains(&Scope::Email)
    {
        let emails: Vec<String> = sqlx::query_scalar(
            "select email from account_emails where account_uuid=$1 and verified_at is not null order by email",
        ).bind(&verified.account.uuid).fetch_all(&mut *conn).await?;
        info["verified_emails"] = serde_json::json!(emails);
    }
    Ok(info)
}

/// 401 `invalid_token` for an access token past its `exp`.
fn expired(state: &AppState, exp: i64) -> ApiError {
    let at = OffsetDateTime::from_unix_timestamp(exp)
        .map_or_else(|_| format!("unix time {exp}"), format_rfc3339_ms);
    ApiError::unauthenticated(
        "invalid_token",
        format!(
            "The access token expired at {at} (access tokens last {}).",
            duration_text(state.settings.access_token_ttl_seconds)
        ),
    )
    .hint("Refresh it with POST /v1/oauth/token grant_type=refresh_token (the accounts CLI does this automatically).")
    .detail("expired_at", at)
}

/// `1800` → "30 minutes"; durations that aren't whole minutes stay in seconds.
fn duration_text(seconds: i64) -> String {
    match seconds {
        60 => "1 minute".to_string(),
        s if s > 0 && s % 60 == 0 => format!("{} minutes", s / 60),
        s => format!("{s} seconds"),
    }
}

/// An app's token reads the account only while the account's membership with the app is
/// active (as introspection reports it). Normally removing access or deleting the account also
/// revokes the sign-in; this keeps an app that lost access from reading the account even if a
/// sign-in somehow survived that.
async fn require_membership(
    conn: &mut PgConnection,
    verified: &VerifiedAccess,
) -> Result<(), ApiError> {
    let app_id = verified.family.app_id.as_str();
    let account = &verified.account;
    match membership_state(conn, app_id, &account.uuid).await? {
        Some(m) if m.status == MembershipStatus::Active => Ok(()),
        Some(m) if m.status == MembershipStatus::AccessRemoved => Err(ApiError::unauthenticated(
            "access_removed",
            format!(
                "{} removed the access of the app '{app_id}'{}, so the app's tokens can't read the account any more.",
                account.display_id(),
                m.access_removed_at
                    .map(|at| format!(" at {}", format_rfc3339_ms(at)))
                    .unwrap_or_default()
            ),
        )
        .hint("The account has to sign in to the app again before the app can read it.")),
        _ => Err(ApiError::unauthenticated(
            "membership_inactive",
            format!(
                "{} has no active membership with the app '{app_id}', so this access token can't read the account.",
                account.display_id()
            ),
        )
        .hint("The account has to sign in to the app again.")),
    }
}

/// The bearer token of the Authorization header: `Ok(None)` without the header, an error for
/// another scheme or an empty token.
fn bearer(headers: &HeaderMap) -> Result<Option<String>, ApiError> {
    let Some(value) = headers.get(AUTHORIZATION) else {
        return Ok(None);
    };
    let raw = value
        .to_str()
        .map_err(|_| {
            ApiError::unauthenticated(
                "invalid_token",
                "The Authorization header is not valid text.",
            )
        })?
        .trim();
    let (scheme, rest) = raw
        .split_once(' ')
        .map_or((raw, ""), |(s, r)| (s, r.trim()));
    if !scheme.eq_ignore_ascii_case("bearer") {
        return Err(ApiError::unauthenticated(
            "invalid_authorization",
            format!(
                "/v1/userinfo takes Authorization: Bearer <access token>; the '{scheme}' scheme is not accepted here."
            ),
        )
        .hint("Send the access token of the account's sign-in, not app credentials."));
    }
    if rest.is_empty() {
        return Err(ApiError::unauthenticated(
            "invalid_token",
            "The Authorization header says Bearer but carries no token.",
        )
        .hint("Send Authorization: Bearer <access token>."));
    }
    Ok(Some(rest.to_string()))
}

/// The `access_token` of a form-encoded body (RFC 6750 §2.2); other bodies are ignored.
fn form_token(headers: &HeaderMap, body: &Bytes) -> Result<Option<String>, ApiError> {
    let is_form = headers
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .and_then(|ct| ct.split(';').next())
        .is_some_and(|mime| {
            mime.trim()
                .eq_ignore_ascii_case("application/x-www-form-urlencoded")
        });
    if !is_form || body.iter().all(u8::is_ascii_whitespace) {
        return Ok(None);
    }
    let form: UserinfoForm = parse_form_or_json(headers, body).map_err(|m| {
        ApiError::invalid_request(format!("The userinfo request body could not be read: {m}."))
    })?;
    Ok(form
        .access_token
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty()))
}

/// The API error plus `WWW-Authenticate` (RFC 6750 §3): no error code when no token was sent,
/// `invalid_token` for a token that doesn't work, `invalid_request` for a malformed request.
fn bearer_error(e: ApiError) -> Response {
    let challenge = match (e.status, e.code.as_ref()) {
        (StatusCode::UNAUTHORIZED, "unauthenticated" | "invalid_authorization") => {
            Some(REALM.to_string())
        }
        (StatusCode::UNAUTHORIZED, _) => Some(format!(
            "{REALM}, error=\"invalid_token\", error_description=\"{}\"",
            rfc6749_text(&e.message)
        )),
        (StatusCode::BAD_REQUEST, _) => Some(format!(
            "{REALM}, error=\"invalid_request\", error_description=\"{}\"",
            rfc6749_text(&e.message)
        )),
        _ => None,
    };
    let mut response = e.into_response();
    if let Some(v) = challenge.and_then(|c| HeaderValue::from_str(&c).ok()) {
        response.headers_mut().insert(WWW_AUTHENTICATE, v);
    }
    response
}
