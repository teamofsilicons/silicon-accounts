//! The browser's own Silicon Accounts session (`sa_session`) as the flow sees it.

use accounts_core::http::ClientMeta;
use accounts_core::http::cookies::{SESSION_COOKIE, read_cookie, session_cookie};
use accounts_core::models::{Account, AccountKind, AccountStatus};
use accounts_core::repo::{accounts, sessions};
use accounts_core::{ApiError, ApiResult, AppState};
use axum::http::HeaderMap;
use cookie::Cookie;
use sqlx::PgConnection;
use uuid::Uuid;

use super::model::Flow;

/// The account the browser is signed in as.
#[derive(Debug, Clone)]
pub struct BrowserAccount {
    pub session_id: Uuid,
    pub account: Account,
}

impl BrowserAccount {
    /// An active Carbon (the only accounts that use the hosted pages).
    pub fn is_active_carbon(&self) -> bool {
        self.account.kind == AccountKind::Carbon && self.account.status == AccountStatus::Active
    }
}

/// The browser's live session and its account, if any.
pub async fn current(
    conn: &mut PgConnection,
    state: &AppState,
    headers: &HeaderMap,
) -> ApiResult<Option<BrowserAccount>> {
    let Some(token) = read_cookie(headers, &state.settings, SESSION_COOKIE) else {
        return Ok(None);
    };
    let Some(session) = sessions::lookup(conn, &state.keys.pepper, &token).await? else {
        return Ok(None);
    };
    Ok(accounts::get(conn, &session.account_uuid)
        .await?
        .map(|account| BrowserAccount {
            session_id: session.id,
            account,
        }))
}

/// Result of [`sign_in`].
#[derive(Debug)]
pub struct SignedIn {
    pub session_id: Uuid,
    /// The new `sa_session` cookie (none when the browser already had a session for the account).
    pub cookie: Option<Cookie<'static>>,
}

/// Signs the browser in as `account_uuid`, which just proved who it is (a code, Google, Apple, a
/// finished sign-up): keeps its session when it already belongs to that account (and records the
/// new authentication on it, `authenticated_at`, the `auth_time` of the codes it completes);
/// otherwise revokes it (its cookie is about to be replaced, so nobody should hold a live copy of
/// it) and creates a new one.
pub async fn sign_in(
    conn: &mut PgConnection,
    state: &AppState,
    headers: &HeaderMap,
    meta: &ClientMeta,
    account_uuid: &str,
) -> ApiResult<SignedIn> {
    if let Some(token) = read_cookie(headers, &state.settings, SESSION_COOKIE)
        && let Some(existing) = sessions::lookup(conn, &state.keys.pepper, &token).await?
    {
        if existing.account_uuid == account_uuid {
            sessions::mark_authenticated(conn, existing.id).await?;
            return Ok(SignedIn {
                session_id: existing.id,
                cookie: None,
            });
        }
        sessions::revoke(conn, &existing.account_uuid, existing.id).await?;
    }
    let (token, session) = sessions::create(
        conn,
        &state.keys.pepper,
        account_uuid,
        meta.ip.as_deref(),
        meta.user_agent.as_deref(),
    )
    .await?;
    Ok(SignedIn {
        session_id: session.id,
        cookie: Some(session_cookie(&state.settings, &token)),
    })
}

/// The flow's account, which must still be the browser's signed-in account (steps that act
/// for the account: requirements and consent).
///
/// Errors: 401 `session_required` (the browser signed out or the session expired), 409
/// `account_changed` (the browser is now signed in as someone else), 403 `account_not_active`.
pub async fn require_flow_account(
    conn: &mut PgConnection,
    state: &AppState,
    headers: &HeaderMap,
    flow: &Flow,
) -> ApiResult<Account> {
    let Some(flow_account) = flow.account_uuid.as_deref() else {
        return Err(ApiError::internal(format!(
            "flow {} is at {} without an account",
            flow.id,
            flow.step.as_str()
        )));
    };
    let browser = current(conn, state, headers).await?;
    let Some(browser) = browser else {
        return Err(ApiError::unauthenticated(
            "session_required",
            format!(
                "This browser is no longer signed in (it signed out, or the session expired), so sign-in flow '{}' can't continue for its account.",
                flow.id
            ),
        )
        .hint(format!(
            "Call POST /v1/flows/{}/switch and sign in again.",
            flow.id
        )));
    };
    if browser.account.uuid != flow_account {
        let now = browser.account.display_id();
        return Err(ApiError::conflict(
            "account_changed",
            format!(
                "This browser is now signed in as {now}, but sign-in flow '{}' was signing in a different account.",
                flow.id
            ),
        )
        .hint(format!(
            "Call POST /v1/flows/{}/switch to choose the account again.",
            flow.id
        )));
    }
    if !browser.is_active_carbon() {
        return Err(not_active(&browser.account));
    }
    Ok(browser.account)
}

/// 403 `account_not_active`.
pub fn not_active(account: &Account) -> ApiError {
    ApiError::forbidden(
        "account_not_active",
        format!(
            "{} is {}, so it can't sign in to apps.",
            account.display_id(),
            account.status
        ),
    )
    .hint("Sign in with another account.")
}
