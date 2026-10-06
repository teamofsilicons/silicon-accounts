//! Moving a flow forward once it knows its account: requirements → consent → complete.
//!
//! Scope rules (02-api.md):
//! - `profile` is always granted;
//! - the app's `required_fields` are required: missing email/phone sends the flow to the
//!   requirements step (dob and timezone always exist);
//! - optional = the app's `optional_fields` plus any detail the `scope` parameter asks for that
//!   isn't required (the Carbon may decline each);
//! - consent is skipped when the account already granted everything the app now needs
//!   (profile + required + details asked for in `scope`) and `prompt` isn't `consent`; the
//!   first-party app never shows it.

use accounts_core::http::ClientMeta;
use accounts_core::models::{
    Account, ContactField, MembershipSource, MembershipStatus, Scope, SigninConfig,
    normalize_scopes,
};
use accounts_core::repo::audit::{self, SigninRecord};
use accounts_core::repo::contacts::{self, ContactKind};
use accounts_core::repo::memberships::{self, GrantMode};
use accounts_core::repo::sessions;
use accounts_core::repo::tokens::{self, NewAuthCode};
use accounts_core::{ApiError, ApiResult, AppState};
use serde_json::json;
use sqlx::PgConnection;

use super::FlowApp;
use super::model::{Flow, FlowError, Step};
use crate::util::{encrypt_text, telemetry, with_query};

/// Contact scopes (the details an app can see beyond its profile).
const CONTACT_SCOPES: [Scope; 4] = [Scope::Email, Scope::Phone, Scope::Dob, Scope::Timezone];

/// Scopes of the app's required fields.
pub fn required_scopes(config: &SigninConfig) -> Vec<Scope> {
    let mut out: Vec<Scope> = config.required_fields.iter().map(|f| f.scope()).collect();
    out.sort();
    out.dedup();
    out
}

/// Details the `scope` parameter asked for (email, phone, dob, timezone).
pub fn requested_contact_scopes(flow: &Flow) -> Vec<Scope> {
    flow.requested_scopes
        .iter()
        .copied()
        .filter(|s| CONTACT_SCOPES.contains(s))
        .collect()
}

/// Optional details: the app's optional fields plus requested ones that aren't required.
pub fn optional_scopes(flow: &Flow, config: &SigninConfig) -> Vec<Scope> {
    let required = required_scopes(config);
    let mut out: Vec<Scope> = config
        .optional_fields
        .iter()
        .map(|f| f.scope())
        .chain(requested_contact_scopes(flow))
        .filter(|s| !required.contains(s))
        .collect();
    out.sort();
    out.dedup();
    out
}

/// What the app needs now: profile + required + requested details.
pub fn needed_scopes(flow: &Flow, config: &SigninConfig) -> Vec<Scope> {
    let mut out = vec![Scope::Profile];
    out.extend(required_scopes(config));
    out.extend(requested_contact_scopes(flow));
    normalize_scopes(out)
}

/// Required details the account doesn't have yet (only email and phone can be missing: every
/// account has a date of birth and a timezone). A detail counts only when its primary is
/// verified.
pub async fn missing_requirements(
    conn: &mut PgConnection,
    config: &SigninConfig,
    account: &Account,
) -> ApiResult<Vec<ContactField>> {
    let mut missing = Vec::new();
    for field in &config.required_fields {
        let kind = match field {
            ContactField::Email => ContactKind::Email,
            ContactField::Phone => ContactKind::Phone,
            ContactField::Dob | ContactField::Timezone => continue,
        };
        let primary = contacts::primary(conn, kind, &account.uuid).await?;
        if !primary.is_some_and(|p| p.verified) && !missing.contains(field) {
            missing.push(*field);
        }
    }
    Ok(missing)
}

/// True when the what's-shared screen must be shown.
pub async fn needs_consent(
    conn: &mut PgConnection,
    flow: &Flow,
    fa: &FlowApp,
    account: &Account,
) -> ApiResult<bool> {
    if fa.first_party() {
        return Ok(false);
    }
    if flow.prompt.consent {
        return Ok(true);
    }
    let Some(m) = memberships::get(conn, &fa.app.app_id, &account.uuid).await? else {
        return Ok(true);
    };
    if m.status != MembershipStatus::Active {
        return Ok(true);
    }
    let granted = m.scopes();
    Ok(!needed_scopes(flow, &fa.config)
        .iter()
        .all(|s| granted.contains(s)))
}

/// After the account is known: requirements, consent or straight to complete.
pub async fn advance(
    conn: &mut PgConnection,
    state: &AppState,
    meta: &ClientMeta,
    flow: &mut Flow,
    fa: &FlowApp,
    account: &Account,
) -> ApiResult<()> {
    flow.account_uuid = Some(account.uuid.clone());
    flow.challenge_id = None;
    flow.signup_session_id = None;
    flow.extras.provider = None;
    flow.extras.pending = None;
    flow.extras.error = None;
    if !missing_requirements(conn, &fa.config, account)
        .await?
        .is_empty()
    {
        flow.step = Step::Requirements;
        return Ok(());
    }
    if needs_consent(conn, flow, fa, account).await? {
        flow.step = Step::Consent;
        return Ok(());
    }
    complete(conn, state, meta, flow, fa, account, Grant::Auto).await
}

/// How the grant of a completing flow is decided.
#[derive(Debug, Clone)]
pub enum Grant {
    /// No consent screen: keep what was granted before (adding nothing new).
    Auto,
    /// The consent screen's answer: exactly these scopes (replacing the previous grant).
    Consent(Vec<Scope>),
}

/// Ends the flow with an authorization code: membership (except for the first-party app),
/// sign-in history, the code, and `redirect_to = redirect_uri?code=…&state=…`.
pub async fn complete(
    conn: &mut PgConnection,
    state: &AppState,
    meta: &ClientMeta,
    flow: &mut Flow,
    fa: &FlowApp,
    account: &Account,
    grant: Grant,
) -> ApiResult<()> {
    let mut scopes: Vec<Scope> = if fa.first_party() {
        // The account site and CLI are Silicon Accounts itself: no membership, no consent.
        vec![Scope::Profile]
    } else {
        let (scopes, mode) = match grant {
            Grant::Auto => (needed_scopes(flow, &fa.config), GrantMode::Union),
            Grant::Consent(s) => (s, GrantMode::Replace),
        };
        memberships::upsert_signin(
            conn,
            &fa.app.app_id,
            &account.uuid,
            MembershipSource::Signin,
            &scopes,
            mode,
        )
        .await?
        .scopes()
    };
    if flow.wants_openid() {
        scopes.push(Scope::Openid);
    }
    let scopes = normalize_scopes(scopes);
    // When the Carbon actually authenticated: the browser session's last proof of identity
    // (just now for a code, Google or Apple; earlier for continue-as and prompt=none).
    let auth_time = match flow.extras.browser_session_id {
        Some(id) => sessions::authenticated_at(conn, id).await?,
        None => None,
    };
    audit::signin(
        conn,
        &SigninRecord {
            account_uuid: Some(&account.uuid),
            app_id: Some(&fa.app.app_id),
            method: flow
                .extras
                .auth_method
                .as_deref()
                .unwrap_or(audit::method::SESSION),
            outcome: if flow.extras.new_account {
                audit::outcome::NEW_ACCOUNT
            } else {
                audit::outcome::SUCCESS
            },
            ip: meta.ip.as_deref(),
            user_agent: meta.user_agent.as_deref(),
        },
    )
    .await?;
    let code = tokens::create_code(
        conn,
        &state.keys.pepper,
        &NewAuthCode {
            flow_id: &flow.id,
            app_id: &fa.app.app_id,
            account_uuid: &account.uuid,
            redirect_uri: &flow.redirect_uri,
            code_challenge: flow.code_challenge.as_deref(),
            code_challenge_method: flow.code_challenge_method.as_deref(),
            scopes: &scopes,
            nonce: flow.nonce.as_deref(),
            browser_session_id: flow.extras.browser_session_id,
            auth_time,
        },
    )
    .await?;
    let redirect = with_query(
        &flow.redirect_uri,
        &[("code", Some(&code)), ("state", flow.state.as_deref())],
    );
    finish(state, flow, Step::Complete, &redirect)?;
    telemetry(
        state,
        "flow.completed",
        Some(1.0),
        json!({
            "app_id": fa.app.app_id,
            "method": flow.extras.auth_method,
            "new_account": flow.extras.new_account,
            "scopes": accounts_core::models::scopes_to_string(&scopes),
        }),
    );
    Ok(())
}

/// The Carbon declined on the what's-shared screen: `redirect_uri?error=access_denied&state=…`.
pub async fn decline(
    conn: &mut PgConnection,
    state: &AppState,
    meta: &ClientMeta,
    flow: &mut Flow,
    fa: &FlowApp,
    account: &Account,
) -> ApiResult<()> {
    audit::signin(
        conn,
        &SigninRecord {
            account_uuid: Some(&account.uuid),
            app_id: Some(&fa.app.app_id),
            method: flow
                .extras
                .auth_method
                .as_deref()
                .unwrap_or(audit::method::SESSION),
            outcome: audit::outcome::FAILED,
            ip: meta.ip.as_deref(),
            user_agent: meta.user_agent.as_deref(),
        },
    )
    .await?;
    let redirect = error_redirect(
        flow,
        "access_denied",
        "The Carbon declined to share their details with the app.",
    );
    finish(state, flow, Step::Complete, &redirect)?;
    telemetry(
        state,
        "flow.declined",
        Some(1.0),
        json!({"app_id": fa.app.app_id}),
    );
    Ok(())
}

/// Ends the flow without a sign-in (`prompt=none` that can't sign in silently): step
/// `failed`, the error on the flow and `redirect_to = redirect_uri?error=…&state=…`.
pub fn fail(state: &AppState, flow: &mut Flow, error: FlowError) -> ApiResult<()> {
    let redirect = error_redirect(flow, &error.code, &error.message);
    telemetry(
        state,
        "flow.failed",
        Some(1.0),
        json!({"app_id": flow.app_id, "error": error.code}),
    );
    flow.extras.error = Some(error);
    finish(state, flow, Step::Failed, &redirect)
}

/// `redirect_uri?error=…&error_description=…&state=…` (RFC 6749 §4.1.2.1).
pub fn error_redirect(flow: &Flow, error: &str, description: &str) -> String {
    with_query(
        &flow.redirect_uri,
        &[
            ("error", Some(error)),
            ("error_description", Some(description)),
            ("state", flow.state.as_deref()),
        ],
    )
}

/// Ends a flow at `complete` with `redirect` as its `redirect_to` (used by flows that don't end
/// with an authorization code, such as connecting Google or Apple to an account).
pub(crate) fn complete_with(state: &AppState, flow: &mut Flow, redirect: &str) -> ApiResult<()> {
    finish(state, flow, Step::Complete, redirect)
}

fn finish(state: &AppState, flow: &mut Flow, step: Step, redirect: &str) -> ApiResult<()> {
    flow.step = step;
    flow.result_redirect = Some(encrypt_text(&state.keys.keyring, redirect)?);
    flow.completed_at = Some(time::OffsetDateTime::now_utc());
    flow.challenge_id = None;
    flow.signup_session_id = None;
    flow.extras.provider = None;
    flow.extras.pending = None;
    Ok(())
}

/// True when the app accepts this account under `allowed_email_domains`: no restriction, or
/// the account has a verified email in one of the domains.
pub async fn account_domain_allowed(
    conn: &mut PgConnection,
    config: &SigninConfig,
    account: &Account,
) -> ApiResult<bool> {
    if config.allowed_email_domains.is_empty() {
        return Ok(true);
    }
    let emails = contacts::verified_emails(conn, &account.uuid).await?;
    Ok(emails.iter().any(|e| config.email_domain_allowed(e)))
}

/// 403 `email_domain_not_allowed`.
pub fn domain_not_allowed(fa: &FlowApp, email: Option<&str>) -> ApiError {
    let domains = fa.config.allowed_email_domains.join(", ");
    let message = match email {
        Some(e) => format!(
            "{} only accepts email addresses at {domains}; {e} is not one of them.",
            fa.app.name
        ),
        None => format!(
            "{} only accepts accounts with a verified email address at {domains}.",
            fa.app.name
        ),
    };
    ApiError::forbidden("email_domain_not_allowed", message)
        .hint(format!("Sign in with an email address at {domains}."))
        .detail("allowed_domains", fa.config.allowed_email_domains.clone())
}

/// 403 `signup_not_allowed`.
pub fn signup_not_allowed(fa: &FlowApp) -> ApiError {
    ApiError::forbidden(
        "signup_not_allowed",
        format!(
            "{} doesn't accept new accounts: only Carbons who already have a Silicon Accounts account (or were imported by the app) can sign in.",
            fa.app.name
        ),
    )
    .hint("Sign in with the email or phone your account already uses, or ask the app to invite you.")
}
