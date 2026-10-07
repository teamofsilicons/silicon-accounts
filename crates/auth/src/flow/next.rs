//! Moving a flow forward once it knows its account: the details pages (see [`super::details`])
//! → complete.
//!
//! Scope rules:
//! - `profile` is always granted;
//! - the app's `required_fields` are always shared (a missing email/phone is added on its
//!   details page);
//! - optional details (the app's `optional_fields`, plus any detail the `scope` parameter asks
//!   for that the app doesn't request) are shared only when the Carbon ticks them;
//! - a Carbon who has nothing new to see (signed in before, granted everything the app requires
//!   and the `scope` parameter asks for, nothing missing, `prompt` isn't `consent`) completes
//!   straight away; the first-party apps (`accounts`, `developer`) never show the pages.

use accounts_core::http::ClientMeta;
use accounts_core::models::{Account, MembershipSource, Scope, SigninConfig, normalize_scopes};
use accounts_core::repo::audit::{self, SigninRecord};
use accounts_core::repo::contacts;
use accounts_core::repo::memberships::{self, GrantMode};
use accounts_core::repo::sessions;
use accounts_core::repo::tokens::{self, NewAuthCode};
use accounts_core::{ApiError, ApiResult, AppState};
use serde_json::json;
use sqlx::PgConnection;

use super::FlowApp;
use super::details;
use super::model::{Flow, FlowError, Step};
use crate::util::{encrypt_text, telemetry, with_query};

/// What a returning Carbon's grant must cover without showing a page: profile + required
/// details + details the `scope` parameter asks for.
pub fn needed_scopes(flow: &Flow, config: &SigninConfig) -> Vec<Scope> {
    let mut out = vec![Scope::Profile];
    out.extend(config.required_fields.iter().map(|f| f.scope()));
    out.extend(details::asked_in_scope(flow).iter().map(|f| f.scope()));
    normalize_scopes(out)
}

/// After the account is known: the first details page, or straight to complete.
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
    details::start(conn, state, meta, flow, fa, account).await
}

/// How the grant of a completing flow is decided.
#[derive(Debug, Clone)]
pub enum Grant {
    /// No page was shown: keep what was granted before, plus what the app needs now.
    Auto,
    /// The Carbon's answers on the details pages: exactly these scopes (replacing the previous
    /// grant, so an optional detail they unticked stops being shared).
    Chosen(Vec<Scope>),
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
            Grant::Chosen(s) => (s, GrantMode::Replace),
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

/// The Carbon cancelled on a details page or the review page:
/// `redirect_uri?error=access_denied&state=…`.
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
