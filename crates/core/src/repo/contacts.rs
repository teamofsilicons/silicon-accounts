//! A Carbon's emails and phone numbers.
//!
//! Rules (UNDERSTANDING.md): up to 10 of each; any can sign in; exactly one primary; the primary
//! can't be removed (make another primary first); an email/phone belongs to one account only;
//! everything is verified before it's added.
//!
//! **Unverified rows.** The only unverified rows are the addresses an app import attached to an
//! account nobody has finished yet (status `unclaimed`): proving one of them is how its Carbon
//! finishes the account (`repo::accounts::finish_claim`, which removes the import's other,
//! unproven addresses). An unverified row on any other account is *unproven*: nobody showed they
//! own the address, so it identifies nobody ([`lookup`] treats it as no owner) and whoever proves
//! the address takes it over ([`after_proof`], [`add_verified`]). Migration 0002 removed the
//! unproven rows that existed before this rule.
//!
//! **Who an address signs in to** is [`lookup`] (or [`after_proof`] once the address was
//! proven): only a verified address of an active Carbon, or an address of an unfinished import.
//! Never authenticate with `repo::accounts::by_email` / `by_phone`, which match any row.
//!
//! Every function takes a [`ContactKind`]; `*_email` / `*_phone` wrappers exist for the common
//! calls. Values must already be normalized (`normalize::normalize_email` / `normalize_phone`).

use serde_json::json;
use sqlx::{Connection, PgConnection};

use crate::error::{ApiError, ApiResult};
use crate::models::{
    Account, AccountEmail, AccountField, AccountKind, AccountPhone, AccountStatus, ActorKind,
    VerifiedVia,
};
use crate::repo::audit::{self, AuditEntry};
use crate::repo::{accounts, is_unique_violation};
use crate::views::PrimaryContact;

/// Maximum emails (and, separately, phones) per Carbon.
pub const MAX_PER_KIND: i64 = 10;

/// Email or phone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContactKind {
    Email,
    Phone,
}

impl ContactKind {
    /// `email` / `phone` (used in error codes).
    pub fn code(&self) -> &'static str {
        match self {
            ContactKind::Email => "email",
            ContactKind::Phone => "phone",
        }
    }

    /// `email` / `phone number` (used in messages).
    pub fn noun(&self) -> &'static str {
        match self {
            ContactKind::Email => "email",
            ContactKind::Phone => "phone number",
        }
    }

    /// The account field a change of this kind shows up as (`account.updated`).
    pub fn field(&self) -> AccountField {
        match self {
            ContactKind::Email => AccountField::Email,
            ContactKind::Phone => AccountField::Phone,
        }
    }

    fn sql_detach(&self) -> &'static str {
        match self {
            ContactKind::Email => {
                "delete from account_emails where email = $1 and account_uuid = $2 and verified_at is null \
                 returning is_primary"
            }
            ContactKind::Phone => {
                "delete from account_phones where phone = $1 and account_uuid = $2 and verified_at is null \
                 returning is_primary"
            }
        }
    }

    fn sql_drop_unverified(&self) -> &'static str {
        match self {
            ContactKind::Email => {
                "delete from account_emails where account_uuid = $1 and verified_at is null returning is_primary"
            }
            ContactKind::Phone => {
                "delete from account_phones where account_uuid = $1 and verified_at is null returning is_primary"
            }
        }
    }

    fn sql_promote_oldest_verified(&self) -> &'static str {
        match self {
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
        }
    }

    fn sql_owner(&self) -> &'static str {
        match self {
            ContactKind::Email => {
                "select account_uuid, verified_at is not null from account_emails where email = $1"
            }
            ContactKind::Phone => {
                "select account_uuid, verified_at is not null from account_phones where phone = $1"
            }
        }
    }

    fn sql_count(&self) -> &'static str {
        match self {
            ContactKind::Email => "select count(*) from account_emails where account_uuid = $1",
            ContactKind::Phone => "select count(*) from account_phones where account_uuid = $1",
        }
    }

    fn sql_has_primary(&self) -> &'static str {
        match self {
            ContactKind::Email => {
                "select exists (select 1 from account_emails where account_uuid = $1 and is_primary)"
            }
            ContactKind::Phone => {
                "select exists (select 1 from account_phones where account_uuid = $1 and is_primary)"
            }
        }
    }

    fn sql_insert(&self) -> &'static str {
        match self {
            ContactKind::Email => {
                "insert into account_emails (email, account_uuid, is_primary, verified_at, verified_via) \
                 values ($1, $2, $3, now(), $4)"
            }
            ContactKind::Phone => {
                "insert into account_phones (phone, account_uuid, is_primary, verified_at, verified_via) \
                 values ($1, $2, $3, now(), $4)"
            }
        }
    }

    fn sql_mark_verified(&self) -> &'static str {
        match self {
            ContactKind::Email => {
                "update account_emails set verified_at = coalesce(verified_at, now()), \
                 verified_via = coalesce(verified_via, $3) where email = $1 and account_uuid = $2"
            }
            ContactKind::Phone => {
                "update account_phones set verified_at = coalesce(verified_at, now()), \
                 verified_via = coalesce(verified_via, $3) where phone = $1 and account_uuid = $2"
            }
        }
    }

    fn sql_row(&self) -> &'static str {
        match self {
            ContactKind::Email => {
                "select is_primary, verified_at is not null from account_emails where email = $1 and account_uuid = $2"
            }
            ContactKind::Phone => {
                "select is_primary, verified_at is not null from account_phones where phone = $1 and account_uuid = $2"
            }
        }
    }

    fn sql_clear_primary(&self) -> &'static str {
        match self {
            ContactKind::Email => {
                "update account_emails set is_primary = false where account_uuid = $1 and is_primary and email <> $2"
            }
            ContactKind::Phone => {
                "update account_phones set is_primary = false where account_uuid = $1 and is_primary and phone <> $2"
            }
        }
    }

    fn sql_set_primary(&self) -> &'static str {
        match self {
            ContactKind::Email => {
                "update account_emails set is_primary = true where account_uuid = $1 and email = $2"
            }
            ContactKind::Phone => {
                "update account_phones set is_primary = true where account_uuid = $1 and phone = $2"
            }
        }
    }

    fn sql_delete(&self) -> &'static str {
        match self {
            ContactKind::Email => {
                "delete from account_emails where account_uuid = $1 and email = $2"
            }
            ContactKind::Phone => {
                "delete from account_phones where account_uuid = $1 and phone = $2"
            }
        }
    }

    fn sql_primary(&self) -> &'static str {
        match self {
            ContactKind::Email => {
                "select email, verified_at is not null from account_emails where account_uuid = $1 and is_primary"
            }
            ContactKind::Phone => {
                "select phone, verified_at is not null from account_phones where account_uuid = $1 and is_primary"
            }
        }
    }
}

/// A Carbon's emails, primary first.
pub async fn list_emails(
    conn: &mut PgConnection,
    account_uuid: &str,
) -> ApiResult<Vec<AccountEmail>> {
    Ok(sqlx::query_as::<_, AccountEmail>(
        "select email, account_uuid, is_primary, verified_at, verified_via, created_at from account_emails \
         where account_uuid = $1 order by is_primary desc, created_at, email",
    )
    .bind(account_uuid)
    .fetch_all(&mut *conn)
    .await?)
}

/// A Carbon's phone numbers, primary first.
pub async fn list_phones(
    conn: &mut PgConnection,
    account_uuid: &str,
) -> ApiResult<Vec<AccountPhone>> {
    Ok(sqlx::query_as::<_, AccountPhone>(
        "select phone, account_uuid, is_primary, verified_at, verified_via, created_at from account_phones \
         where account_uuid = $1 order by is_primary desc, created_at, phone",
    )
    .bind(account_uuid)
    .fetch_all(&mut *conn)
    .await?)
}

/// The primary contact of a kind (value + verified).
pub async fn primary(
    conn: &mut PgConnection,
    kind: ContactKind,
    account_uuid: &str,
) -> ApiResult<Option<PrimaryContact>> {
    Ok(sqlx::query_as::<_, (String, bool)>(kind.sql_primary())
        .bind(account_uuid)
        .fetch_optional(&mut *conn)
        .await?
        .map(|(value, verified)| PrimaryContact { value, verified }))
}

pub async fn primary_email(
    conn: &mut PgConnection,
    account_uuid: &str,
) -> ApiResult<Option<PrimaryContact>> {
    primary(conn, ContactKind::Email, account_uuid).await
}

pub async fn primary_phone(
    conn: &mut PgConnection,
    account_uuid: &str,
) -> ApiResult<Option<PrimaryContact>> {
    primary(conn, ContactKind::Phone, account_uuid).await
}

/// Who owns a value: `(account_uuid, verified)`.
pub async fn owner(
    conn: &mut PgConnection,
    kind: ContactKind,
    value: &str,
) -> ApiResult<Option<(String, bool)>> {
    Ok(sqlx::query_as::<_, (String, bool)>(kind.sql_owner())
        .bind(value)
        .fetch_optional(&mut *conn)
        .await?)
}

/// Checks, before sending a verification code, that `value` can be added to the account.
///
/// Errors: 409 `{email|phone}_in_use` (another account has it, verified, or as the address of
/// an unfinished import), 409 `{kind}_already_added` (already verified on this account), 422
/// `{kind}_limit_reached` (10 already). An unverified (imported) row on the same account passes:
/// verifying it marks it verified. An unproven row on another account (see the module docs)
/// passes too: proving the address takes it over.
pub async fn check_can_add(
    conn: &mut PgConnection,
    kind: ContactKind,
    account_uuid: &str,
    value: &str,
) -> ApiResult<()> {
    match owner(conn, kind, value).await? {
        Some((holder, verified)) if holder == account_uuid => {
            return if verified {
                Err(already_added(kind, value))
            } else {
                Ok(())
            };
        }
        // Taken by another account, unless it is an unproven row there (the prover takes it).
        Some((holder, verified)) if verified || !is_unproven_on(conn, &holder).await? => {
            return Err(in_use(kind, value));
        }
        Some(_) | None => {}
    }
    let count: i64 = sqlx::query_scalar(kind.sql_count())
        .bind(account_uuid)
        .fetch_one(&mut *conn)
        .await?;
    if count >= MAX_PER_KIND {
        return Err(limit_reached(kind));
    }
    Ok(())
}

/// True when an unverified row held by `holder_uuid` is unproven: the account is not an
/// unfinished import (see the module docs).
async fn is_unproven_on(conn: &mut PgConnection, holder_uuid: &str) -> ApiResult<bool> {
    Ok(accounts::get(conn, holder_uuid)
        .await?
        .is_none_or(|a| !(a.kind == AccountKind::Carbon && a.status == AccountStatus::Unclaimed)))
}

/// What [`add_verified`] did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AddOutcome {
    /// It became the primary (the account had none).
    pub became_primary: bool,
    /// It was already on the account unverified and is now verified.
    pub was_unverified: bool,
}

/// Adds a proven email/phone to a Carbon (first one becomes primary). Same errors as
/// [`check_can_add`], plus 409 `account_deleted`; serialized per account so the limit holds
/// under concurrency. An unproven row of the address on another account is removed first (the
/// Carbon in front of us proved it; see [`after_proof`]).
pub async fn add_verified(
    conn: &mut PgConnection,
    kind: ContactKind,
    account_uuid: &str,
    value: &str,
    via: VerifiedVia,
) -> ApiResult<AddOutcome> {
    let mut tx = conn.begin().await?;
    lock_account(&mut tx, account_uuid).await?;
    if let Some((holder, verified)) = owner(&mut tx, kind, value).await?
        && holder != account_uuid
    {
        let unproven = if verified {
            None
        } else {
            accounts::get(&mut tx, &holder).await?.filter(|a| {
                !(a.kind == AccountKind::Carbon && a.status == AccountStatus::Unclaimed)
            })
        };
        match unproven {
            Some(other) => detach(&mut tx, kind, value, &other, None).await?,
            None => return Err(in_use(kind, value)),
        }
    }
    if let Some((holder, verified)) = owner(&mut tx, kind, value).await? {
        if holder != account_uuid {
            return Err(in_use(kind, value));
        }
        if verified {
            return Err(already_added(kind, value));
        }
        sqlx::query(kind.sql_mark_verified())
            .bind(value)
            .bind(account_uuid)
            .bind(via)
            .execute(&mut *tx)
            .await?;
        let has_primary: bool = sqlx::query_scalar(kind.sql_has_primary())
            .bind(account_uuid)
            .fetch_one(&mut *tx)
            .await?;
        if !has_primary {
            sqlx::query(kind.sql_set_primary())
                .bind(account_uuid)
                .bind(value)
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
        return Ok(AddOutcome {
            became_primary: !has_primary,
            was_unverified: true,
        });
    }
    let count: i64 = sqlx::query_scalar(kind.sql_count())
        .bind(account_uuid)
        .fetch_one(&mut *tx)
        .await?;
    if count >= MAX_PER_KIND {
        return Err(limit_reached(kind));
    }
    let has_primary: bool = sqlx::query_scalar(kind.sql_has_primary())
        .bind(account_uuid)
        .fetch_one(&mut *tx)
        .await?;
    sqlx::query(kind.sql_insert())
        .bind(value)
        .bind(account_uuid)
        .bind(!has_primary)
        .bind(via)
        .execute(&mut *tx)
        .await
        .map_err(|e| {
            if is_unique_violation(&e, None) {
                in_use(kind, value)
            } else {
                e.into()
            }
        })?;
    tx.commit().await?;
    Ok(AddOutcome {
        became_primary: !has_primary,
        was_unverified: false,
    })
}

/// Marks an existing row verified (e.g. an imported email proven at sign-in). Returns false if
/// the account doesn't have it.
pub async fn mark_verified(
    conn: &mut PgConnection,
    kind: ContactKind,
    account_uuid: &str,
    value: &str,
    via: VerifiedVia,
) -> ApiResult<bool> {
    Ok(sqlx::query(kind.sql_mark_verified())
        .bind(value)
        .bind(account_uuid)
        .bind(via)
        .execute(&mut *conn)
        .await?
        .rows_affected()
        > 0)
}

/// Makes a verified email/phone the primary. Returns false when it already was.
/// Errors: 404 `{kind}_not_found`, 409 `{kind}_not_verified`.
pub async fn set_primary(
    conn: &mut PgConnection,
    kind: ContactKind,
    account_uuid: &str,
    value: &str,
) -> ApiResult<bool> {
    let mut tx = conn.begin().await?;
    lock_account(&mut tx, account_uuid).await?;
    let row: Option<(bool, bool)> = sqlx::query_as(kind.sql_row())
        .bind(value)
        .bind(account_uuid)
        .fetch_optional(&mut *tx)
        .await?;
    let Some((is_primary, verified)) = row else {
        return Err(not_found(kind, value));
    };
    if is_primary {
        tx.commit().await?;
        return Ok(false);
    }
    if !verified {
        return Err(ApiError::conflict(
            format!("{}_not_verified", kind.code()),
            format!(
                "{value} isn't verified yet, so it can't be the primary {}.",
                kind.noun()
            ),
        )
        .hint(format!(
            "Verify it first by adding it again: a code will be sent to {value}."
        )));
    }
    sqlx::query(kind.sql_clear_primary())
        .bind(account_uuid)
        .bind(value)
        .execute(&mut *tx)
        .await?;
    sqlx::query(kind.sql_set_primary())
        .bind(account_uuid)
        .bind(value)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(true)
}

/// Removes a non-primary email/phone. Errors: 404 `{kind}_not_found`, 409 `cannot_remove_primary`.
pub async fn remove(
    conn: &mut PgConnection,
    kind: ContactKind,
    account_uuid: &str,
    value: &str,
) -> ApiResult<()> {
    let mut tx = conn.begin().await?;
    lock_account(&mut tx, account_uuid).await?;
    let row: Option<(bool, bool)> = sqlx::query_as(kind.sql_row())
        .bind(value)
        .bind(account_uuid)
        .fetch_optional(&mut *tx)
        .await?;
    let Some((is_primary, _)) = row else {
        return Err(not_found(kind, value));
    };
    if is_primary {
        return Err(ApiError::conflict(
            "cannot_remove_primary",
            format!(
                "{value} is your primary {} and the primary can't be removed.",
                kind.noun()
            ),
        )
        .hint(format!(
            "Make another {} the primary first, then remove {value}.",
            kind.noun()
        )));
    }
    sqlx::query(kind.sql_delete())
        .bind(account_uuid)
        .bind(value)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

pub async fn add_verified_email(
    conn: &mut PgConnection,
    account_uuid: &str,
    email: &str,
    via: VerifiedVia,
) -> ApiResult<AddOutcome> {
    add_verified(conn, ContactKind::Email, account_uuid, email, via).await
}

pub async fn add_verified_phone(
    conn: &mut PgConnection,
    account_uuid: &str,
    phone: &str,
) -> ApiResult<AddOutcome> {
    add_verified(
        conn,
        ContactKind::Phone,
        account_uuid,
        phone,
        VerifiedVia::Code,
    )
    .await
}

pub async fn set_primary_email(
    conn: &mut PgConnection,
    account_uuid: &str,
    email: &str,
) -> ApiResult<bool> {
    set_primary(conn, ContactKind::Email, account_uuid, email).await
}

pub async fn set_primary_phone(
    conn: &mut PgConnection,
    account_uuid: &str,
    phone: &str,
) -> ApiResult<bool> {
    set_primary(conn, ContactKind::Phone, account_uuid, phone).await
}

pub async fn remove_email(
    conn: &mut PgConnection,
    account_uuid: &str,
    email: &str,
) -> ApiResult<()> {
    remove(conn, ContactKind::Email, account_uuid, email).await
}

pub async fn remove_phone(
    conn: &mut PgConnection,
    account_uuid: &str,
    phone: &str,
) -> ApiResult<()> {
    remove(conn, ContactKind::Phone, account_uuid, phone).await
}

/// Verified emails of an account (used to find custodian requests addressed by email).
pub async fn verified_emails(
    conn: &mut PgConnection,
    account_uuid: &str,
) -> ApiResult<Vec<String>> {
    Ok(sqlx::query_scalar(
        "select email from account_emails where account_uuid = $1 and verified_at is not null order by email",
    )
    .bind(account_uuid)
    .fetch_all(&mut *conn)
    .await?)
}

/// Row-locks the account (`for update`). Errors: 404 `account_not_found`, 409
/// `account_deleted` (a request that authenticated just before the account was deleted must not
/// attach an address to it, where nobody could ever use it again).
async fn lock_account(conn: &mut PgConnection, account_uuid: &str) -> ApiResult<()> {
    let found: Option<AccountStatus> =
        sqlx::query_scalar("select status from accounts where uuid = $1 for update")
            .bind(account_uuid)
            .fetch_optional(&mut *conn)
            .await?;
    match found {
        None => Err(ApiError::not_found(
            "account_not_found",
            format!("No account has the uuid '{account_uuid}'."),
        )),
        Some(AccountStatus::Deleted) => Err(ApiError::conflict(
            "account_deleted",
            format!(
                "The account {account_uuid} was deleted (possibly while this request was being handled), so nothing can be added to it."
            ),
        )
        .hint("Nothing was changed. Sign in with an account that still exists.")),
        Some(_) => Ok(()),
    }
}

/// Where an email address or phone number leads, for signing in (see the module docs).
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
    kind.field()
}

/// Who `value` (normalized) leads to. Read-only. The only lookup to authenticate with.
pub async fn lookup(conn: &mut PgConnection, kind: ContactKind, value: &str) -> ApiResult<Holder> {
    let Some((uuid, verified)) = owner(conn, kind, value).await? else {
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
/// theirs, which leaves the address free for the Carbon who proved it (the answer is then
/// [`Holder::Free`]).
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
    let removed: Option<bool> = sqlx::query_scalar(kind.sql_detach())
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
        crate::events::account_updated(conn, &updated, &[kind.field()]).await?;
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
        let removed: Vec<bool> = sqlx::query_scalar(kind.sql_drop_unverified())
            .bind(account_uuid)
            .fetch_all(&mut *conn)
            .await?;
        if removed.iter().any(|primary| *primary) {
            promote_oldest_verified(conn, kind, account_uuid).await?;
            changed.push(kind.field());
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
    sqlx::query(kind.sql_promote_oldest_verified())
        .bind(account_uuid)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// Records that the account's Carbon proved `value` (a code, Google or Apple): marks it verified
/// when it is already on the account, adds it otherwise ([`add_verified`]), and makes it the
/// primary when the current primary of that kind isn't verified. Returns true when the primary
/// changed or became verified (apps holding the email/phone scope must hear about it).
///
/// Errors: as [`add_verified`] (409 `email_in_use` when another account has it meanwhile).
pub async fn prove(
    conn: &mut PgConnection,
    kind: ContactKind,
    account_uuid: &str,
    value: &str,
    via: VerifiedVia,
) -> ApiResult<bool> {
    let before = primary(conn, kind, account_uuid).await?;
    let on_account = owner(conn, kind, value)
        .await?
        .is_some_and(|(holder, _)| holder == account_uuid);
    if on_account {
        mark_verified(conn, kind, account_uuid, value, via).await?;
    } else {
        add_verified(conn, kind, account_uuid, value, via).await?;
    }
    if !before.as_ref().is_some_and(|p| p.verified) {
        set_primary(conn, kind, account_uuid, value).await?;
    }
    let after = primary(conn, kind, account_uuid).await?;
    Ok(before.map(|p| (p.value, p.verified)) != after.map(|p| (p.value, p.verified)))
}

fn in_use(kind: ContactKind, value: &str) -> ApiError {
    ApiError::conflict(format!("{}_in_use", kind.code()), format!("{value} already belongs to another account."))
        .hint(format!(
            "A {} can only belong to one account. Sign in with it to use that account, or add a different {}.",
            kind.noun(),
            kind.noun()
        ))
}

fn already_added(kind: ContactKind, value: &str) -> ApiError {
    ApiError::conflict(
        format!("{}_already_added", kind.code()),
        format!("{value} is already on your account and verified."),
    )
    .hint(format!(
        "Nothing to do; to make it your primary {}, use the primary action.",
        kind.noun()
    ))
}

fn limit_reached(kind: ContactKind) -> ApiError {
    ApiError::unprocessable(
        format!("{}_limit_reached", kind.code()),
        format!(
            "Your account already has {MAX_PER_KIND} {}s, the most it can have.",
            kind.noun()
        ),
    )
    .hint(format!(
        "Remove a {} you no longer use, then add the new one.",
        kind.noun()
    ))
}

fn not_found(kind: ContactKind, value: &str) -> ApiError {
    ApiError::not_found(
        format!("{}_not_found", kind.code()),
        format!("{value} is not on your account."),
    )
    .hint(format!(
        "List your {}s to see what is on the account.",
        kind.noun()
    ))
}
