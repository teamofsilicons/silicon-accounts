//! A Carbon's emails and phone numbers.
//!
//! Rules (UNDERSTANDING.md): up to 10 of each; any can sign in; exactly one primary; the primary
//! can't be removed (make another primary first); an email/phone belongs to one account only;
//! everything is verified before it's added (imported unclaimed rows are the only unverified
//! ones, and become verified when proven).
//!
//! Every function takes a [`ContactKind`]; `*_email` / `*_phone` wrappers exist for the common
//! calls. Values must already be normalized (`normalize::normalize_email` / `normalize_phone`).

use sqlx::{Connection, PgConnection};

use crate::error::{ApiError, ApiResult};
use crate::models::{AccountEmail, AccountPhone, VerifiedVia};
use crate::repo::is_unique_violation;
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
/// Errors: 409 `{email|phone}_in_use` (another account has it), 409 `{kind}_already_added`
/// (already verified on this account), 422 `{kind}_limit_reached` (10 already).
/// An unverified (imported) row on the same account passes: verifying it marks it verified.
pub async fn check_can_add(
    conn: &mut PgConnection,
    kind: ContactKind,
    account_uuid: &str,
    value: &str,
) -> ApiResult<()> {
    if let Some((holder, verified)) = owner(conn, kind, value).await? {
        if holder != account_uuid {
            return Err(in_use(kind, value));
        }
        if verified {
            return Err(already_added(kind, value));
        }
        return Ok(());
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

/// What [`add_verified`] did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AddOutcome {
    /// It became the primary (the account had none).
    pub became_primary: bool,
    /// It was already on the account unverified and is now verified.
    pub was_unverified: bool,
}

/// Adds a proven email/phone to a Carbon (first one becomes primary). Same errors as
/// [`check_can_add`]; serialized per account so the limit holds under concurrency.
pub async fn add_verified(
    conn: &mut PgConnection,
    kind: ContactKind,
    account_uuid: &str,
    value: &str,
    via: VerifiedVia,
) -> ApiResult<AddOutcome> {
    let mut tx = conn.begin().await?;
    lock_account(&mut tx, account_uuid).await?;
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

async fn lock_account(conn: &mut PgConnection, account_uuid: &str) -> ApiResult<()> {
    let found: Option<String> =
        sqlx::query_scalar("select uuid from accounts where uuid = $1 for update")
            .bind(account_uuid)
            .fetch_optional(&mut *conn)
            .await?;
    found.map(|_| ()).ok_or_else(|| {
        ApiError::not_found(
            "account_not_found",
            format!("No account has the uuid '{account_uuid}'."),
        )
    })
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
