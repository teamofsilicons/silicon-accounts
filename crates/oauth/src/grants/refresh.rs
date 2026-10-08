//! `grant_type=refresh_token`.
//!
//! Rotation, reuse detection, the 900-day absolute expiry and the account check are core's
//! `repo::tokens::refresh`. On top of it this grant:
//! - checks an optional `scope` parameter (a refresh may keep or narrow, never widen, the grant;
//!   RFC 6749 §6);
//! - refuses (and ends) a third-party sign-in whose membership is no longer active;
//! - tells the app `membership.signed_out` (reason `refresh_token_reuse`) when reuse revoked a
//!   family, and records it in the account's history.

use accounts_core::crypto::prefix;
use accounts_core::events::{self, signout_reason};
use accounts_core::http::{ClientAuth, ClientMeta};
use accounts_core::models::{
    ActorKind, MembershipStatus, Scope, scopes_from_strings, scopes_to_string,
};
use accounts_core::repo::audit;
use accounts_core::repo::tokens::{self, GrantError};
use accounts_core::timefmt::format_rfc3339_ms;
use accounts_core::views::TokenResponse;
use accounts_core::{ApiError, AppState, OAuthError, is_first_party_app_id};
use serde_json::json;
use uuid::Uuid;

use crate::credentials::{RefreshTokenInfo, refresh_token_info};
use crate::params::opt;
use crate::token::TokenParams;

/// Rotates a refresh token.
pub(crate) async fn exchange(
    state: &AppState,
    client: &ClientAuth,
    params: &TokenParams,
    meta: &ClientMeta,
) -> Result<TokenResponse, OAuthError> {
    let presented = opt(params.refresh_token.as_deref()).ok_or_else(|| {
        OAuthError::invalid_request(
            "refresh_token is required for grant_type=refresh_token: send the most recent refresh token (sar_...) you received; every refresh returns a new one.",
        )
    })?;
    let requested = match opt(params.scope.as_deref()) {
        Some(s) => Some(
            Scope::parse_list(s)
                .map_err(|e| OAuthError::invalid_scope(format!("The scope parameter has {e}.")))?,
        ),
        None => None,
    };
    if presented.starts_with(prefix::REFRESH) {
        let info = {
            let mut conn = state.db.acquire().await?;
            refresh_token_info(&mut conn, &state.keys.pepper, presented).await?
        };
        // Only a live, unused token of this client is checked here; everything else (unknown,
        // other app, revoked, expired, reused) gets core's precise answer below.
        if let Some(info) =
            info.filter(|i| i.app_id == client.app.app_id && i.family_active && !i.used)
        {
            // Silicon Accounts' own apps (`silicon-accounts`, `developer`) have no memberships.
            if !is_first_party_app_id(&info.app_id)
                && info.membership_status != Some(MembershipStatus::Active)
            {
                return Err(end_orphaned_sign_in(state, &info).await?);
            }
            if let Some(requested) = &requested {
                check_scope(requested, &info)?;
            }
        }
    }
    match tokens::refresh(
        &state.db,
        &state.keys,
        &state.settings,
        presented,
        &client.app.app_id,
    )
    .await
    {
        Ok(response) => Ok(response),
        Err(err) => {
            if let GrantError::Reused {
                family_id,
                app_id,
                account_uuid,
            } = &err
            {
                after_reuse(state, *family_id, app_id, account_uuid, meta).await;
            }
            Err(err.to_oauth())
        }
    }
}

/// A refresh may repeat or narrow the granted scopes but never add one. (Narrowing is
/// accepted and the full grant is returned in `scope`, which RFC 6749 §3.3 allows.)
fn check_scope(requested: &[Scope], info: &RefreshTokenInfo) -> Result<(), OAuthError> {
    let granted = scopes_from_strings(&info.scopes);
    let extra: Vec<&str> = requested
        .iter()
        .filter(|s| **s != Scope::OfflineAccess && !granted.contains(s))
        .map(Scope::as_str)
        .collect();
    if extra.is_empty() {
        return Ok(());
    }
    Err(OAuthError::invalid_scope(format!(
        "A refresh can't add scopes: '{}' {} not granted when the account signed in (granted: '{}'). Ask for more by sending the account through /authorize again.",
        extra.join(" "),
        if extra.len() == 1 { "was" } else { "were" },
        scopes_to_string(&granted)
    )))
}

/// The sign-in is live but its membership isn't (access removed, or never recorded): end the
/// family so it can't be used again and explain why.
async fn end_orphaned_sign_in(
    state: &AppState,
    info: &RefreshTokenInfo,
) -> Result<OAuthError, OAuthError> {
    let (reason, description) = match info.membership_status {
        Some(MembershipStatus::AccessRemoved) => (
            "access_removed",
            format!(
                "The account removed the access of the app '{}'{}, so this sign-in has ended; the account has to sign in to the app again.",
                info.app_id,
                info.access_removed_at
                    .map(|t| format!(" at {}", format_rfc3339_ms(t)))
                    .unwrap_or_default()
            ),
        ),
        _ => (
            "membership_inactive",
            format!(
                "The account has no active membership with the app '{}', so this sign-in can't be refreshed; the account has to sign in to the app again.",
                info.app_id
            ),
        ),
    };
    let mut conn = state.db.acquire().await?;
    tokens::revoke_family(&mut conn, info.family_id, reason).await?;
    tracing::warn!(family_id = %info.family_id, app_id = %info.app_id, reason, "refresh refused: the membership is not active; family revoked");
    Ok(OAuthError::invalid_grant(description))
}

/// Reuse revoked a family (core already committed that): notify the app and record it.
/// Failures are logged; the caller still answers `invalid_grant`.
async fn after_reuse(
    state: &AppState,
    family_id: Uuid,
    app_id: &str,
    account_uuid: &str,
    meta: &ClientMeta,
) {
    let result: Result<(), ApiError> = async {
        let mut tx = state.db.begin().await?;
        if !is_first_party_app_id(app_id) {
            events::membership_signed_out(
                &mut tx,
                app_id,
                account_uuid,
                signout_reason::REFRESH_TOKEN_REUSE,
            )
            .await?;
        }
        let family = family_id.to_string();
        audit::record(
            &mut tx,
            &audit::AuditEntry {
                target_kind: Some("token_family"),
                target_id: Some(&family),
                app_id: Some(app_id),
                account_uuid: Some(account_uuid),
                details: json!({"reason": signout_reason::REFRESH_TOKEN_REUSE}),
                ip: meta.ip.as_deref(),
                ..audit::AuditEntry::new(
                    ActorKind::App,
                    Some(app_id),
                    "oauth.refresh_reuse_detected",
                )
            },
        )
        .await?;
        tx.commit().await?;
        Ok(())
    }
    .await;
    if let Err(e) = result {
        tracing::error!(error = %e, family_id = %family_id, "could not record a refresh token reuse");
    }
}
