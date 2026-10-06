//! Who an email address or phone number signs in to.
//!
//! Only a **verified** email or phone identifies an account (UNDERSTANDING.md: "Every email
//! and phone number is verified before it's added"). The one exception is an imported account
//! nobody has finished yet (status `unclaimed`): an import lists its emails and phones
//! unverified, and proving one of them is how its Carbon finishes setting it up.
//!
//! Any other unverified row is *unproven*: nobody ever showed they own that address. Such rows
//! never sign anyone in. Finishing an import removes them (see [`drop_unverified`]), and
//! whoever proves such an address later takes it over (see [`after_proof`]): an app owner
//! must not be able to plant an address on someone's account by importing it.

use accounts_core::models::{Account, AccountField, AccountKind, AccountStatus, ActorKind};
use accounts_core::repo::accounts;
use accounts_core::repo::audit::{self, AuditEntry};
use accounts_core::repo::contacts::{self, ContactKind};
use accounts_core::{ApiResult, events};
use serde_json::json;
use sqlx::PgConnection;

/// Where an email or phone number leads.
#[derive(Debug, Clone)]
pub enum Holder {
    /// No account has it.
    Free,
    /// A verified email/phone of an active Carbon: proving it signs that Carbon in.
    Active(Account),
    /// Listed by an imported account nobody finished yet: proving it finishes that account.
    Unclaimed(Account),
    /// A verified email/phone of an account that can't sign in.
    Unavailable(Account),
    /// An unverified row on an account that isn't an unfinished import. It identifies nobody.
    Unproven(Account),
}

/// The account field an email/phone change shows up as.
pub fn field_of(kind: ContactKind) -> AccountField {
    match kind {
        ContactKind::Email => AccountField::Email,
        ContactKind::Phone => AccountField::Phone,
    }
}

/// Who `value` (normalized) leads to. Read-only.
pub async fn lookup(conn: &mut PgConnection, kind: ContactKind, value: &str) -> ApiResult<Holder> {
    let Some((uuid, verified)) = contacts::owner(conn, kind, value).await? else {
        return Ok(Holder::Free);
    };
    let Some(account) = accounts::get(conn, &uuid).await? else {
        return Ok(Holder::Free);
    };
    Ok(match (account.kind, account.status, verified) {
        (AccountKind::Carbon, AccountStatus::Unclaimed, _) => Holder::Unclaimed(account),
        (AccountKind::Carbon, AccountStatus::Active, true) => Holder::Active(account),
        (_, _, false) => Holder::Unproven(account),
        _ => Holder::Unavailable(account),
    })
}

/// Who `value` leads to once the Carbon in front of us has **proven** it (a code, or Google /
/// Apple): an unproven row on someone else's account is removed first, because it was never
/// theirs, which leaves the address free for the Carbon who proved it.
pub async fn after_proof(
    conn: &mut PgConnection,
    kind: ContactKind,
    value: &str,
    ip: Option<&str>,
) -> ApiResult<Holder> {
    match lookup(conn, kind, value).await? {
        Holder::Unproven(account) => {
            detach(conn, kind, value, &account, ip).await?;
            Ok(Holder::Free)
        }
        other => Ok(other),
    }
}

/// Removes one unproven row from an account (it stays in the importing app's own records,
/// `memberships.imported_profile`). Apps that could see it as the primary hear about it.
async fn detach(
    conn: &mut PgConnection,
    kind: ContactKind,
    value: &str,
    account: &Account,
    ip: Option<&str>,
) -> ApiResult<()> {
    let sql = match kind {
        ContactKind::Email => {
            "delete from account_emails where email = $1 and account_uuid = $2 and verified_at is null \
             returning is_primary"
        }
        ContactKind::Phone => {
            "delete from account_phones where phone = $1 and account_uuid = $2 and verified_at is null \
             returning is_primary"
        }
    };
    let removed: Option<bool> = sqlx::query_scalar(sql)
        .bind(value)
        .bind(&account.uuid)
        .fetch_optional(&mut *conn)
        .await?;
    let Some(was_primary) = removed else {
        return Ok(());
    };
    if was_primary {
        promote_oldest_verified(conn, kind, &account.uuid).await?;
        let updated = accounts::bump_version(conn, &account.uuid).await?;
        events::account_updated(conn, &updated, &[field_of(kind)]).await?;
    }
    audit::record(
        conn,
        &AuditEntry {
            account_uuid: Some(&account.uuid),
            target_kind: Some(kind.code()),
            details: json!({
                "kind": kind.code(),
                "was_primary": was_primary,
                "reason": "an unverified address left by an import was proven by another sign-in",
            }),
            ip,
            ..AuditEntry::new(ActorKind::System, None, "contact.unverified_removed")
        },
    )
    .await?;
    Ok(())
}

/// Removes every unverified email and phone of an account: what an import listed and the
/// Carbon who finished the account never proved. Returns the fields whose primary changed.
pub async fn drop_unverified(
    conn: &mut PgConnection,
    account_uuid: &str,
) -> ApiResult<Vec<AccountField>> {
    let mut changed = Vec::new();
    for kind in [ContactKind::Email, ContactKind::Phone] {
        let sql = match kind {
            ContactKind::Email => {
                "delete from account_emails where account_uuid = $1 and verified_at is null returning is_primary"
            }
            ContactKind::Phone => {
                "delete from account_phones where account_uuid = $1 and verified_at is null returning is_primary"
            }
        };
        let removed: Vec<bool> = sqlx::query_scalar(sql)
            .bind(account_uuid)
            .fetch_all(&mut *conn)
            .await?;
        if removed.iter().any(|primary| *primary) {
            promote_oldest_verified(conn, kind, account_uuid).await?;
            changed.push(field_of(kind));
        }
    }
    Ok(changed)
}

/// After a primary was removed: the oldest verified email/phone of that kind becomes primary
/// ("one of them is always the primary").
async fn promote_oldest_verified(
    conn: &mut PgConnection,
    kind: ContactKind,
    account_uuid: &str,
) -> ApiResult<()> {
    let sql = match kind {
        ContactKind::Email => {
            "update account_emails set is_primary = true where account_uuid = $1 and email = ( \
               select email from account_emails where account_uuid = $1 and verified_at is not null \
               order by created_at, email limit 1) \
             and not exists (select 1 from account_emails where account_uuid = $1 and is_primary)"
        }
        ContactKind::Phone => {
            "update account_phones set is_primary = true where account_uuid = $1 and phone = ( \
               select phone from account_phones where account_uuid = $1 and verified_at is not null \
               order by created_at, phone limit 1) \
             and not exists (select 1 from account_phones where account_uuid = $1 and is_primary)"
        }
    };
    sqlx::query(sql)
        .bind(account_uuid)
        .execute(&mut *conn)
        .await?;
    Ok(())
}
