//! `grant_type=urn:ietf:params:oauth:grant-type:device_code` (RFC 8628 §3.4): the silicon-accounts CLI
//! polls with the device code until the Carbon approves it on the account site.
//!
//! Answers while waiting: `authorization_pending`, `slow_down` (polled within 5 s), then
//! `access_denied` or `expired_token` (10 minutes), all from core's `repo::tokens::poll_device`.
//! Approval yields first-party tokens (`aud = silicon-accounts`, origin `device`) labelled with the
//! CLI's `client_label`, and a sign-in history entry.

use accounts_core::crypto::{describe_token, prefix};
use accounts_core::http::ClientMeta;
use accounts_core::models::{Scope, TokenOrigin};
use accounts_core::repo::audit::{self, SigninRecord};
use accounts_core::repo::tokens::{self, IssueRequest};
use accounts_core::views::TokenResponse;
use accounts_core::{AppState, FIRST_PARTY_APP_ID, OAuthError};

use crate::grants::grant_account;
use crate::params::opt;
use crate::token::{DEVICE_CODE_GRANT_TYPE, TokenParams};

/// Label of a device sign-in whose CLI sent no `client_label`.
const DEFAULT_LABEL: &str = "silicon-accounts CLI";

/// Polls a device code (the caller already checked the client is `silicon-accounts`).
pub(crate) async fn exchange(
    state: &AppState,
    params: &TokenParams,
    meta: &ClientMeta,
) -> Result<TokenResponse, OAuthError> {
    let device_code = opt(params.device_code.as_deref()).ok_or_else(|| {
        OAuthError::invalid_request(format!(
            "device_code is required for grant_type={DEVICE_CODE_GRANT_TYPE}: send the device_code that POST /v1/device/authorize returned."
        ))
    })?;
    if !device_code.starts_with(prefix::DEVICE_CODE) {
        let what = describe_token(device_code).unwrap_or("not a Silicon Accounts device code");
        return Err(OAuthError::invalid_grant(format!(
            "device_code must be a device code (it starts with sad_), but this is {what}."
        )));
    }
    let approved = tokens::poll_device(&state.db, &state.keys.pepper, device_code)
        .await
        .map_err(|e| e.to_oauth())?;
    let uuid = approved.account_uuid.clone().ok_or_else(|| {
        OAuthError::server_error("an approved device authorization has no account")
    })?;

    let mut tx = state.db.begin().await?;
    let account = match grant_account(&mut tx, &uuid).await? {
        Ok(account) => account,
        Err(refused) => return Err(refused),
    };
    audit::signin(
        &mut tx,
        &SigninRecord {
            account_uuid: Some(&account.uuid),
            app_id: Some(FIRST_PARTY_APP_ID),
            method: audit::method::DEVICE,
            outcome: audit::outcome::SUCCESS,
            ip: meta.ip.as_deref(),
            user_agent: meta.user_agent.as_deref(),
        },
    )
    .await?;
    let response = tokens::issue_tokens(
        &mut tx,
        &state.keys,
        &state.settings,
        IssueRequest {
            account: &account,
            app_id: FIRST_PARTY_APP_ID,
            origin: TokenOrigin::Device,
            scopes: &[Scope::Profile],
            browser_session_id: None,
            label: Some(approved.client_label.as_deref().unwrap_or(DEFAULT_LABEL)),
            ip: meta.ip.as_deref(),
            user_agent: meta.user_agent.as_deref(),
            nonce: None,
            auth_time: None,
        },
    )
    .await?;
    tx.commit().await?;
    Ok(response)
}
