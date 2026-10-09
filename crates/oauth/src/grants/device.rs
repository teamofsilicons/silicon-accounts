//! `grant_type=urn:ietf:params:oauth:grant-type:device_code` (RFC 8628 §3.4): a command-line
//! tool polls with the device code until the Carbon approves it on the account site.
//!
//! Two kinds of device sign-in share this grant:
//! - the silicon-accounts CLI (`client_id=silicon-accounts`): first-party tokens
//!   (`aud = silicon-accounts`, origin `device`) labelled with the CLI's `client_label`;
//! - an app's own tool (the app turned on `device_flow`; it polls with its `client_id`, with or
//!   without its secret): tokens for the app with the scopes the Carbon approved, and a sign-in
//!   like any other (the membership becomes active, the sign-in is recorded). Refused when the
//!   Carbon removed the app's access after approving.
//!
//! Answers while waiting: `authorization_pending`, `slow_down` (polled within 5 s), then
//! `access_denied` or `expired_token` (10 minutes), all from core's `repo::tokens::poll_app_device`.
//! A code started by another app is `invalid_grant` and stays untouched.

use accounts_core::crypto::{describe_token, prefix};
use accounts_core::http::{ClientAuth, ClientMeta};
use accounts_core::models::{MembershipSource, Scope, TokenOrigin};
use accounts_core::repo::audit::{self, SigninRecord};
use accounts_core::repo::memberships::{self, GrantMode};
use accounts_core::repo::tokens::{self, IssueRequest};
use accounts_core::views::TokenResponse;
use accounts_core::{AppState, FIRST_PARTY_APP_ID, OAuthError};

use crate::grants::{grant_account, lock_membership, removed_after_issue};
use crate::params::opt;
use crate::token::{DEVICE_CODE_GRANT_TYPE, TokenParams};

/// Label of a device sign-in whose CLI sent no `client_label`.
const DEFAULT_LABEL: &str = "silicon-accounts CLI";

/// Polls a device code (the caller already checked the client may use the device flow).
pub(crate) async fn exchange(
    state: &AppState,
    client: &ClientAuth,
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
    let app_id = client.app.app_id.as_str();
    let approved = tokens::poll_app_device(&state.db, &state.keys.pepper, device_code, app_id)
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
    let first_party = app_id == FIRST_PARTY_APP_ID;
    let scopes: Vec<Scope> = if first_party {
        vec![Scope::Profile]
    } else {
        let membership = lock_membership(&mut tx, app_id, &account.uuid).await?;
        let approved_at = approved.approved_at.unwrap_or(approved.created_at);
        if let Some(refused) = removed_after_issue(
            membership.as_ref(),
            &account,
            app_id,
            approved_at,
            "this device sign-in was approved",
            "start the sign-in again for a new code.",
        ) {
            tx.commit().await?;
            return Err(refused);
        }
        let scopes = approved.scope_list();
        memberships::upsert_signin(
            &mut tx,
            app_id,
            &account.uuid,
            MembershipSource::Signin,
            &scopes,
            GrantMode::Union,
        )
        .await?;
        scopes
    };
    audit::signin(
        &mut tx,
        &SigninRecord {
            account_uuid: Some(&account.uuid),
            app_id: Some(app_id),
            method: audit::method::DEVICE,
            outcome: audit::outcome::SUCCESS,
            ip: meta.ip.as_deref(),
            user_agent: meta.user_agent.as_deref(),
        },
    )
    .await?;
    let default_label = if first_party {
        DEFAULT_LABEL.to_string()
    } else {
        format!("{} command line", client.app.name)
    };
    let response = tokens::issue_tokens(
        &mut tx,
        &state.keys,
        &state.settings,
        IssueRequest {
            account: &account,
            app_id,
            origin: TokenOrigin::Device,
            scopes: &scopes,
            browser_session_id: None,
            label: Some(approved.client_label.as_deref().unwrap_or(&default_label)),
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
