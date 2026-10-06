//! `POST /v1/oauth/revoke` (RFC 7009): ends the sign-in (token family) behind a refresh token
//! or an access token of the calling client.
//!
//! - Apps authenticate as usual; the first-party public client (`client_id=accounts`, no
//!   secret) can revoke first-party tokens only (`accounts logout`).
//! - A token of another app is never revoked, and is answered exactly like an unknown one, so
//!   the endpoint can't be used to probe other apps' tokens.
//! - An access token is accepted even after it expired (its signature still proves which
//!   sign-in it belongs to).
//! - Revoking an app's sign-in emits `membership.signed_out` (reason `app_revoked`) to that app;
//!   a first-party sign-out is recorded with reason `user_signed_out`.
//! - The answer is always 200 once the client is authenticated (RFC 7009 §2.2, and the API
//!   contract); the body says what happened: `{"revoked":true}` or
//!   `{"revoked":false,"message":…}`. Credentials this endpoint doesn't end (proof tokens, STKs,
//!   app secrets, browser sessions…) get `revoked:false` with where to end them instead, so
//!   nobody reading the answer believes a proof was revoked when it wasn't.

use accounts_core::events::{self, signout_reason};
use accounts_core::http::{ClientAuth, ClientMeta, authenticate_client};
use accounts_core::models::ActorKind;
use accounts_core::repo::audit;
use accounts_core::repo::tokens::{self, TokenFamily};
use accounts_core::{AppState, FIRST_PARTY_APP_ID, OAuthError};
use axum::body::Bytes;
use axum::extract::State;
use axum::extract::rejection::BytesRejection;
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::credentials::{Presented, access_claims_ignoring_expiry, classify, where_to_revoke};
use crate::params::{opt, parse_body};
use crate::respond::{no_store, oauth_error};

/// `token_type_hint` is accepted and ignored (unknown parameters are): the token's prefix says
/// what it is, which RFC 7009 §2.1 allows.
#[derive(Default, Deserialize)]
struct RevokeParams {
    token: Option<String>,
    client_id: Option<String>,
    client_secret: Option<String>,
}

/// The 200 body.
#[derive(Debug, Serialize)]
struct Outcome {
    revoked: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

/// `POST /v1/oauth/revoke`.
pub(crate) async fn revoke(
    State(state): State<AppState>,
    meta: ClientMeta,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> Response {
    match handle(&state, &meta, &headers, body).await {
        Ok(outcome) => no_store(StatusCode::OK, &outcome),
        Err(e) => oauth_error(e),
    }
}

async fn handle(
    state: &AppState,
    meta: &ClientMeta,
    headers: &HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> Result<Outcome, OAuthError> {
    let params: RevokeParams = parse_body(headers, body, "The revocation request")?;
    let client = authenticate_client(
        state,
        headers,
        params.client_id.as_deref(),
        params.client_secret.as_deref(),
    )
    .await?;
    let token = opt(params.token.as_deref()).ok_or_else(|| {
        OAuthError::invalid_request(
            "token is required: send the refresh token (sar_...) or the access token to revoke as the 'token' parameter (RFC 7009).",
        )
    })?;
    let (family, token_type) = match classify(token) {
        Presented::Refresh => {
            let mut conn = state.db.acquire().await?;
            let found = tokens::family_for_refresh_token(&mut conn, &state.keys.pepper, token)
                .await?
                .map(|(family, _, _)| family);
            (found, "refresh_token")
        }
        Presented::Access => {
            let found = match access_claims_ignoring_expiry(&state.keys.jwt, token) {
                Some(claims) => match claims.family_id() {
                    Some(fid) => {
                        let mut conn = state.db.acquire().await?;
                        tokens::find_family(&mut conn, fid)
                            .await?
                            .filter(|f| f.account_uuid == claims.sub && f.app_id == claims.aud)
                    }
                    None => None,
                },
                None => None,
            };
            (found, "access_token")
        }
        Presented::Other { prefix, what } => {
            // Judged by the prefix the client itself sent, so saying what it is discloses
            // nothing about anyone's tokens.
            return Ok(Outcome {
                revoked: false,
                message: Some(format!(
                    "Nothing was revoked: this is {what}, and /v1/oauth/revoke only ends sign-ins (refresh tokens sar_... and access tokens). {}",
                    where_to_revoke(prefix)
                )),
            });
        }
        Presented::Unknown => (None, "unknown"),
    };
    let Some(family) = family.filter(|f| f.app_id == client.app.app_id) else {
        return Ok(not_revoked(&client));
    };
    end_sign_in(state, &client, meta, family, token_type).await?;
    Ok(Outcome {
        revoked: true,
        message: None,
    })
}

/// Revokes the family (if it is still live), tells the app and records it.
async fn end_sign_in(
    state: &AppState,
    client: &ClientAuth,
    meta: &ClientMeta,
    family: TokenFamily,
    token_type: &str,
) -> Result<(), OAuthError> {
    let first_party = family.app_id == FIRST_PARTY_APP_ID;
    let reason = if first_party {
        signout_reason::USER_SIGNED_OUT
    } else {
        signout_reason::APP_REVOKED
    };
    let mut tx = state.db.begin().await?;
    // `revoke_family` only touches a family that isn't revoked yet, so repeating a revocation
    // changes nothing and notifies nobody twice.
    let Some(revoked) = tokens::revoke_family(&mut tx, family.id, reason).await? else {
        return Ok(());
    };
    if !first_party && revoked.expires_at > time::OffsetDateTime::now_utc() {
        events::membership_signed_out(&mut tx, &revoked.app_id, &revoked.account_uuid, reason)
            .await?;
    }
    let family_id = revoked.id.to_string();
    let (actor_kind, actor_id) = if first_party {
        (ActorKind::Account, revoked.account_uuid.as_str())
    } else {
        (ActorKind::App, client.app.app_id.as_str())
    };
    audit::record(
        &mut tx,
        &audit::AuditEntry {
            target_kind: Some("token_family"),
            target_id: Some(&family_id),
            app_id: Some(&revoked.app_id),
            account_uuid: Some(&revoked.account_uuid),
            details: json!({"reason": reason, "token_type": token_type, "label": revoked.label}),
            ip: meta.ip.as_deref(),
            ..audit::AuditEntry::new(actor_kind, Some(actor_id), "oauth.token_revoked")
        },
    )
    .await?;
    tx.commit().await?;
    Ok(())
}

/// Unknown, malformed, or another client's token: nothing happens, and the answer doesn't say
/// which of those it was.
fn not_revoked(client: &ClientAuth) -> Outcome {
    Outcome {
        revoked: false,
        message: Some(format!(
            "Nothing was revoked: this is not a refresh or access token issued to '{}' (it is unknown, malformed, or belongs to another app). RFC 7009 answers 200 either way.",
            client.app.app_id
        )),
    }
}
