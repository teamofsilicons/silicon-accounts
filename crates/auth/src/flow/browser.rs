//! The browser's own Silicon Accounts session (`sa_session`) as the flow sees it.

use accounts_core::http::ClientMeta;
use accounts_core::http::browser_profiles::BrowserProfiles;
pub use accounts_core::http::browser_profiles::Selection as SignedIn;
use accounts_core::http::cookies::{SESSION_COOKIE, read_cookie};
use accounts_core::models::{Account, AccountKind, AccountStatus};
use accounts_core::repo::{accounts, sessions};
use accounts_core::{ApiError, ApiResult, AppState};
use axum::http::HeaderMap;
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

/// Record an independent proof, preserving the browser’s other signed-in accounts.
pub async fn sign_in(
    conn: &mut PgConnection,
    state: &AppState,
    headers: &HeaderMap,
    meta: &ClientMeta,
    account_uuid: &str,
    preserve_browser: bool,
) -> ApiResult<SignedIn> {
    if preserve_browser {
        let (_, session) = sessions::create(
            conn,
            &state.keys.pepper,
            account_uuid,
            meta.ip.as_deref(),
            meta.user_agent.as_deref(),
        )
        .await?;
        return Ok(SignedIn {
            session_id: session.id,
            cookies: Vec::new(),
        });
    }
    BrowserProfiles::load(conn, state, headers)
        .await?
        .select(conn, state, meta, account_uuid, true)
        .await
}

/// The flow's account, which must still be the browser's signed-in account (steps that act
/// for the account: details and review).
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

/// Build chooser rows from still-live proof, even when a remembered flow is reopened.
pub async fn choices(
    conn: &mut PgConnection,
    anchor: &str,
    flow: &Flow,
    app: &str,
) -> ApiResult<Vec<serde_json::Value>> {
    let ids: Vec<String> = if flow.extras.saved_sessions.is_empty() {
        Vec::new()
    } else {
        sqlx::query_scalar("select s.account_uuid from browser_sessions s join accounts a on a.uuid=s.account_uuid where s.id=any($1) and s.revoked_at is null and s.expires_at>now() and a.status='active' order by s.last_seen_at desc, s.id")
            .bind(&flow.extras.saved_sessions).fetch_all(&mut *conn).await?
    };
    accounts_core::http::browser_profiles::choices(conn, anchor, &ids, Some(app)).await
}
