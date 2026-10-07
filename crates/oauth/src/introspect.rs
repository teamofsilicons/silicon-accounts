//! `POST /v1/oauth/introspect` (RFC 7662): is a token of the calling app live right now?
//!
//! Needs the app's credentials (the first-party public client can't introspect). Only tokens
//! issued to the calling app are ever reported active. An access token is active while its
//! signature verifies, it hasn't expired (strictly: from its `exp` on it is inactive; no clock
//! skew leeway, this server is the clock), its sign-in (family) is live, its account is active
//! and, for apps, the membership is still active. A refresh token is active while it is the
//! current (unused) token of a live family under the same conditions. Anything else is exactly
//! `{"active":false}` (RFC 7662 §2.2: nothing about inactive tokens is disclosed).
//!
//! `id`/`username` are the account's current `c:`/`si:` id (it can change; key on `sub`).

use accounts_core::http::authenticate_client;
use accounts_core::ids::membership_id;
use accounts_core::models::{
    AccountStatus, App, MembershipStatus, scopes_from_strings, scopes_to_string,
};
use accounts_core::repo::{accounts, tokens};
use accounts_core::{AppState, OAuthError, is_first_party_app_id};
use axum::body::Bytes;
use axum::extract::State;
use axum::extract::rejection::BytesRejection;
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::PgConnection;
use time::OffsetDateTime;

use crate::credentials::{Presented, classify, membership_status, refresh_token_info};
use crate::params::{opt, parse_body};
use crate::respond::{no_store, oauth_error};

/// `token_type_hint` is accepted and ignored (the prefix says what a token is).
#[derive(Default, Deserialize)]
struct IntrospectParams {
    token: Option<String>,
    client_id: Option<String>,
    client_secret: Option<String>,
}

/// `POST /v1/oauth/introspect`.
pub(crate) async fn introspect(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> Response {
    match handle(&state, &headers, body).await {
        Ok(answer) => no_store(StatusCode::OK, &answer),
        Err(e) => oauth_error(e),
    }
}

async fn handle(
    state: &AppState,
    headers: &HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> Result<Value, OAuthError> {
    let params: IntrospectParams = parse_body(headers, body, "The introspection request")?;
    let client = authenticate_client(
        state,
        headers,
        params.client_id.as_deref(),
        params.client_secret.as_deref(),
    )
    .await?;
    if client.public {
        return Err(OAuthError::invalid_client(format!(
            "Token introspection needs the app's own credentials (HTTP Basic, or client_id and client_secret in the body). client_id={} without a secret is a first-party public client, accepted only by its own grants and by /v1/oauth/revoke.",
            client.app.app_id
        )));
    }
    let token = opt(params.token.as_deref()).ok_or_else(|| {
        OAuthError::invalid_request(
            "token is required: send the access token or refresh token to introspect as the 'token' parameter (RFC 7662).",
        )
    })?;
    let mut conn = state.db.acquire().await?;
    let answer = match classify(token) {
        Presented::Access => access_token(&mut conn, state, &client.app, token).await?,
        Presented::Refresh => refresh_token(&mut conn, state, &client.app, token).await?,
        Presented::Other { .. } | Presented::Unknown => None,
    };
    Ok(answer.unwrap_or_else(|| json!({"active": false})))
}

/// True when `app` may currently see the account: first-party, or an active membership.
async fn membership_live(
    conn: &mut PgConnection,
    app: &App,
    account_uuid: &str,
) -> Result<bool, OAuthError> {
    if is_first_party_app_id(&app.app_id) {
        return Ok(true);
    }
    Ok(membership_status(conn, &app.app_id, account_uuid).await? == Some(MembershipStatus::Active))
}

async fn access_token(
    conn: &mut PgConnection,
    state: &AppState,
    app: &App,
    token: &str,
) -> Result<Option<Value>, OAuthError> {
    let verified =
        match tokens::verify_access_token(conn, &state.keys, token, Some(&app.app_id)).await {
            Ok(v) => v,
            Err(e) if e.is_server_error() => return Err(e.into()),
            Err(_) => return Ok(None),
        };
    // Core's verification allows 30 s of clock skew for tokens checked elsewhere. This server
    // issued the token and its clock is the authority here, so a token is inactive from its
    // `exp` on (RFC 7519 §4.1.4), and an answer never carries an `exp` in the past.
    if verified.claims.exp <= OffsetDateTime::now_utc().unix_timestamp() {
        return Ok(None);
    }
    if verified.account.status != AccountStatus::Active
        || !membership_live(conn, app, &verified.account.uuid).await?
    {
        return Ok(None);
    }
    let c = &verified.claims;
    Ok(Some(json!({
        "active": true,
        "token_type": "access_token",
        "iss": c.iss,
        "sub": c.sub,
        "aud": c.aud,
        "client_id": c.aud,
        "exp": c.exp,
        "iat": c.iat,
        "nbf": c.nbf,
        "jti": c.jti,
        "scope": c.scope,
        "kind": verified.account.kind,
        "id": verified.account.handle,
        "username": verified.account.handle,
        "membership_id": c.mid,
    })))
}

async fn refresh_token(
    conn: &mut PgConnection,
    state: &AppState,
    app: &App,
    token: &str,
) -> Result<Option<Value>, OAuthError> {
    let Some(info) = refresh_token_info(conn, &state.keys.pepper, token).await? else {
        return Ok(None);
    };
    if info.app_id != app.app_id || !info.family_active || info.used {
        return Ok(None);
    }
    if !is_first_party_app_id(&app.app_id)
        && info.membership_status != Some(MembershipStatus::Active)
    {
        return Ok(None);
    }
    let Some(account) = accounts::get(conn, &info.account_uuid).await? else {
        return Ok(None);
    };
    if account.status != AccountStatus::Active {
        return Ok(None);
    }
    Ok(Some(json!({
        "active": true,
        "token_type": "refresh_token",
        "iss": state.settings.issuer(),
        "sub": account.uuid,
        "aud": info.app_id,
        "client_id": info.app_id,
        "exp": info.family_expires_at.unix_timestamp(),
        "iat": info.created_at.unix_timestamp(),
        "scope": scopes_to_string(&scopes_from_strings(&info.scopes)),
        "kind": account.kind,
        "id": account.handle,
        "username": account.handle,
        "membership_id": membership_id(&info.app_id, &account.uuid),
    })))
}
