//! The grants of the token endpoint, one module each, plus what they share.
//!
//! # Locking
//!
//! A grant that starts a sign-in decides inside the transaction that issues the tokens, and
//! takes the rows it decides on in the order every other writer of them uses: first a share
//! lock on the account row ([`grant_account`]), then an update lock on the membership row
//! ([`lock_membership`]). The changes that end sign-ins lock the same rows before they revoke
//! the token families they can see: STK rotation and account deletion lock the account, and
//! "remove app access" (`DELETE /v1/me/apps/{app_id}`) locks the membership. So either the grant
//! waits for such a change and then sees it (and refuses), or the change waits for the grant and
//! then sees, and revokes, the family the grant issued. A sign-in never outlives a change that
//! should have ended it.

pub(crate) mod code;
pub(crate) mod device;
pub(crate) mod federated;
pub(crate) mod refresh;
pub(crate) mod slt;

use accounts_core::OAuthError;
use accounts_core::models::{Account, AccountStatus, MembershipStatus};
use accounts_core::timefmt::format_rfc3339_ms;
use sqlx::PgConnection;
use time::OffsetDateTime;

use crate::credentials::MembershipState;

/// `invalid_grant` for an account that exists but can't receive tokens.
pub(crate) fn inactive_account(account: &Account) -> OAuthError {
    let id = account
        .handle
        .clone()
        .unwrap_or_else(|| format!("with uuid {}", account.uuid));
    OAuthError::invalid_grant(match account.status {
        AccountStatus::Deleted => format!(
            "The account {} was deleted, so no tokens can be issued for it.",
            account.uuid
        ),
        AccountStatus::PendingCustodian => format!(
            "The Silicon {id} can't sign in yet: its custodian hasn't accepted it. Tokens are issued once the custodian accepts the request on accounts.teamofsilicons.com."
        ),
        AccountStatus::Unclaimed => format!(
            "The Carbon {id} was imported by an app and hasn't finished setting up the account; it must sign in once through the hosted pages (/authorize) before tokens can be issued."
        ),
        AccountStatus::Active => format!("The account {id} can't receive tokens right now."),
    })
}

/// `invalid_grant` for a grant whose account no longer exists.
pub(crate) fn missing_account(uuid: &str) -> OAuthError {
    OAuthError::invalid_grant(format!(
        "The account {uuid} this grant was issued for no longer exists."
    ))
}

/// The account of a grant, share-locked until the transaction ends (see the module docs):
/// `Ok(Ok(account))` when it may receive tokens, `Ok(Err(refusal))` when it can't (the caller
/// decides whether to commit first), `Err` for server failures.
///
/// While the lock is held the account can't be deleted, its STK can't be rotated and its
/// profile can't change, so what the grant decides and the account view it returns hold until
/// it commits.
pub(crate) async fn grant_account(
    conn: &mut PgConnection,
    uuid: &str,
) -> Result<Result<Account, OAuthError>, OAuthError> {
    let account = sqlx::query_as::<_, Account>(concat!(
        "select ",
        accounts_core::account_columns!(),
        " from accounts where uuid = $1 for share"
    ))
    .bind(uuid)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(match account {
        Some(account) if account.status == AccountStatus::Active => Ok(account),
        Some(account) => Err(inactive_account(&account)),
        None => Err(missing_account(uuid)),
    })
}

/// Locks the account's membership with the app (`for update`, see the module docs) and returns
/// its state; `None` when the account never signed in to the app. The lock is an update lock
/// because a grant that goes on to record the sign-in (`memberships::upsert_signin`) updates
/// the same row: a share lock upgraded later could deadlock two concurrent sign-ins.
pub(crate) async fn lock_membership(
    conn: &mut PgConnection,
    app_id: &str,
    account_uuid: &str,
) -> Result<Option<MembershipState>, OAuthError> {
    Ok(sqlx::query_as::<_, MembershipState>(
        "select status, access_removed_at from memberships \
         where app_id = $1 and account_uuid = $2 for update",
    )
    .bind(app_id)
    .bind(account_uuid)
    .fetch_optional(&mut *conn)
    .await?)
}

/// `invalid_grant` when the account removed the app's access at or after `issued_at`, the
/// moment the grant (`what`: "this code", "this short-lived token") was issued. Such a grant
/// predates the account's decision and must not undo it; a grant issued after the removal is a
/// new sign-in and may restore the access. `again` says how the account signs in again.
pub(crate) fn removed_after_issue(
    membership: Option<&MembershipState>,
    account: &Account,
    app_id: &str,
    issued_at: OffsetDateTime,
    what: &str,
    again: &str,
) -> Option<OAuthError> {
    let m = membership.filter(|m| m.status == MembershipStatus::AccessRemoved)?;
    let removed_at = m.access_removed_at.filter(|at| *at >= issued_at)?;
    Some(OAuthError::invalid_grant(format!(
        "{} removed the access of the app '{app_id}' at {}, after {what} was issued at {}, so it can't be exchanged; {again}",
        account.display_id(),
        format_rfc3339_ms(removed_at),
        format_rfc3339_ms(issued_at),
    )))
}
