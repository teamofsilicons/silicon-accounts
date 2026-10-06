//! Accounts: creation (uuid from `account_number_seq`), lookups, ids (availability, change,
//! 10-day reservations, reclaim, history), profile updates, STK bookkeeping, deletion/release.

use serde::Serialize;
use sqlx::{Connection, PgConnection, PgPool};
use time::{Date, OffsetDateTime};

use crate::config::Settings;
use crate::error::{ApiError, ApiResult};
use crate::ids::{AccountId, IdError, handle_candidates, uuid_for_number};
use crate::models::{Account, AccountField, AccountKind, AccountStatus, VerifiedVia};
use crate::repo::{audit, is_unique_violation};

/// Days an old id stays reserved for its previous owner.
pub const HANDLE_RESERVATION_DAYS: i64 = 10;

/// Fetches an account by uuid (any status).
pub async fn get(conn: &mut PgConnection, uuid: &str) -> ApiResult<Option<Account>> {
    Ok(sqlx::query_as::<_, Account>(concat!(
        "select ",
        crate::account_columns!(),
        " from accounts where uuid = $1"
    ))
    .bind(uuid)
    .fetch_optional(&mut *conn)
    .await?)
}

/// Fetches an account or fails with 404 `account_not_found`.
pub async fn require(conn: &mut PgConnection, uuid: &str) -> ApiResult<Account> {
    get(conn, uuid).await?.ok_or_else(|| {
        ApiError::not_found(
            "account_not_found",
            format!("No account has the uuid '{uuid}'."),
        )
        .hint("uuids are case-sensitive; check the value or look the account up by its id.")
    })
}

/// Fetches and row-locks an account (`for update`) inside a transaction.
pub async fn lock(conn: &mut PgConnection, uuid: &str) -> ApiResult<Option<Account>> {
    Ok(sqlx::query_as::<_, Account>(concat!(
        "select ",
        crate::account_columns!(),
        " from accounts where uuid = $1 for update"
    ))
    .bind(uuid)
    .fetch_optional(&mut *conn)
    .await?)
}

/// Fetches an account by its current id (`c:saket`, case-insensitive). Old ids don't resolve.
pub async fn by_handle(conn: &mut PgConnection, full_id: &str) -> ApiResult<Option<Account>> {
    Ok(sqlx::query_as::<_, Account>(concat!(
        "select ",
        crate::account_columns!(),
        " from accounts where handle = $1"
    ))
    .bind(full_id.trim().to_lowercase())
    .fetch_optional(&mut *conn)
    .await?)
}

/// The account that has this (normalized) email, verified or not.
pub async fn by_email(conn: &mut PgConnection, email: &str) -> ApiResult<Option<Account>> {
    Ok(sqlx::query_as::<_, Account>(concat!(
        "select ",
        crate::account_columns!(),
        " from accounts where uuid = (select account_uuid from account_emails where email = $1)"
    ))
    .bind(email)
    .fetch_optional(&mut *conn)
    .await?)
}

/// The account that has this E.164 phone number, verified or not.
pub async fn by_phone(conn: &mut PgConnection, phone: &str) -> ApiResult<Option<Account>> {
    Ok(sqlx::query_as::<_, Account>(concat!(
        "select ",
        crate::account_columns!(),
        " from accounts where uuid = (select account_uuid from account_phones where phone = $1)"
    ))
    .bind(phone)
    .fetch_optional(&mut *conn)
    .await?)
}

/// Resolves a uuid or a current `c:`/`si:` id.
pub async fn by_uuid_or_id(conn: &mut PgConnection, key: &str) -> ApiResult<Option<Account>> {
    let k = key.trim();
    if k.contains(':') {
        by_handle(conn, k).await
    } else {
        get(conn, k).await
    }
}

/// Number of non-deleted Silicons this Carbon is custodian of.
pub async fn count_silicons_in_custody(
    conn: &mut PgConnection,
    carbon_uuid: &str,
) -> ApiResult<i64> {
    Ok(sqlx::query_scalar::<_, i64>(
        "select count(*) from accounts where custodian_uuid = $1 and kind = 'silicon' and status <> 'deleted'",
    )
    .bind(carbon_uuid)
    .fetch_one(&mut *conn)
    .await?)
}

/// Non-deleted Silicons this Carbon is custodian of, oldest first.
pub async fn list_silicons_in_custody(
    conn: &mut PgConnection,
    carbon_uuid: &str,
) -> ApiResult<Vec<Account>> {
    Ok(sqlx::query_as::<_, Account>(concat!(
        "select ",
        crate::account_columns!(),
        " from accounts where custodian_uuid = $1 and kind = 'silicon' and status <> 'deleted' order by created_at, uuid"
    ))
    .bind(carbon_uuid)
    .fetch_all(&mut *conn)
    .await?)
}

/// A contact to attach at creation. `verified_via: None` = unverified (imports only).
#[derive(Debug, Clone)]
pub struct NewContact {
    /// Normalized email or E.164 phone.
    pub value: String,
    pub verified_via: Option<VerifiedVia>,
}

/// Input for [`create_carbon`].
#[derive(Debug, Clone)]
pub struct NewCarbon {
    pub id: AccountId,
    /// Validated display name.
    pub display_name: String,
    /// `None` = the Iris default.
    pub pfp_url: Option<String>,
    pub dob: Date,
    /// Normalized IANA timezone.
    pub timezone: String,
    /// `Active` (sign-up) or `Unclaimed` (import).
    pub status: AccountStatus,
    /// First email becomes primary.
    pub emails: Vec<NewContact>,
    /// First phone becomes primary.
    pub phones: Vec<NewContact>,
    /// Who did it (account uuid, `import`, `system`) for handle history.
    pub actor: String,
}

/// Input for [`create_silicon`]. The dob is the creation date.
#[derive(Debug, Clone)]
pub struct NewSilicon {
    pub id: AccountId,
    pub display_name: String,
    pub pfp_url: Option<String>,
    pub timezone: String,
    /// `Active` (created by its custodian) or `PendingCustodian` (self-created).
    pub status: AccountStatus,
    /// Required when `Active`.
    pub custodian_uuid: Option<String>,
    /// Argon2id PHC string of the STK.
    pub stk_hash: String,
    pub webhook_url: Option<String>,
    /// Keyring-encrypted webhook secret.
    pub webhook_secret_enc: Option<Vec<u8>>,
    pub actor: String,
}

/// Creates a Carbon: takes the next uuid, claims the id, attaches emails/phones.
///
/// Errors: 422 `invalid_id` (not a c: id), 409 `id_taken` (with `details.suggestions`),
/// 409 `id_reserved`, 409 `email_in_use` / `phone_in_use`.
pub async fn create_carbon(
    conn: &mut PgConnection,
    settings: &Settings,
    new: NewCarbon,
) -> ApiResult<Account> {
    if new.id.kind() != AccountKind::Carbon {
        return Err(invalid_id(&IdError::WrongKind {
            input: new.id.to_string(),
            expected: AccountKind::Carbon,
        }));
    }
    if !matches!(new.status, AccountStatus::Active | AccountStatus::Unclaimed) {
        return Err(ApiError::internal(format!(
            "create_carbon called with status {}",
            new.status
        )));
    }
    let mut tx = conn.begin().await?;
    let full = new.id.to_string();
    lock_handles(&mut tx, &[&full]).await?;
    ensure_claimable(&mut tx, &new.id, None).await?;
    for e in &new.emails {
        ensure_contact_free(&mut tx, "email", &e.value).await?;
    }
    for p in &new.phones {
        ensure_contact_free(&mut tx, "phone", &p.value).await?;
    }

    let number: i64 = sqlx::query_scalar("select nextval('account_number_seq')")
        .fetch_one(&mut *tx)
        .await?;
    let uuid = uuid_for_number(number as u64);
    let pfp = new.pfp_url.clone().unwrap_or_else(|| {
        crate::pfp::default_pfp_url(&settings.iris_base_url, AccountKind::Carbon, &uuid)
    });
    let account = sqlx::query_as::<_, Account>(concat!(
        "insert into accounts (uuid, number, kind, handle, status, display_name, pfp_url, dob, timezone) \
         values ($1, $2, 'carbon', $3, $4, $5, $6, $7, $8) returning ",
        crate::account_columns!()
    ))
    .bind(&uuid)
    .bind(number)
    .bind(&full)
    .bind(new.status)
    .bind(&new.display_name)
    .bind(&pfp)
    .bind(new.dob)
    .bind(&new.timezone)
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| map_handle_conflict(e, &full))?;

    for (i, e) in new.emails.iter().enumerate() {
        insert_contact(&mut tx, "email", &uuid, &e.value, i == 0, e.verified_via).await?;
    }
    for (i, p) in new.phones.iter().enumerate() {
        // Phones are only ever proven by a code.
        let via = p.verified_via.map(|_| VerifiedVia::Code);
        insert_contact(&mut tx, "phone", &uuid, &p.value, i == 0, via).await?;
    }
    audit::handle_history(&mut tx, &uuid, None, Some(&full), &new.actor).await?;
    tx.commit().await?;
    Ok(account)
}

/// Creates a Silicon (dob = today). Errors as [`create_carbon`], plus 422 `invalid_id` for a
/// non-si: id.
pub async fn create_silicon(
    conn: &mut PgConnection,
    settings: &Settings,
    new: NewSilicon,
) -> ApiResult<Account> {
    if new.id.kind() != AccountKind::Silicon {
        return Err(invalid_id(&IdError::WrongKind {
            input: new.id.to_string(),
            expected: AccountKind::Silicon,
        }));
    }
    match (new.status, &new.custodian_uuid) {
        (AccountStatus::Active, Some(_)) | (AccountStatus::PendingCustodian, _) => {}
        _ => {
            return Err(ApiError::internal(format!(
                "create_silicon called with status {} and custodian {:?}",
                new.status, new.custodian_uuid
            )));
        }
    }
    let mut tx = conn.begin().await?;
    let full = new.id.to_string();
    lock_handles(&mut tx, &[&full]).await?;
    ensure_claimable(&mut tx, &new.id, None).await?;
    let number: i64 = sqlx::query_scalar("select nextval('account_number_seq')")
        .fetch_one(&mut *tx)
        .await?;
    let uuid = uuid_for_number(number as u64);
    let pfp = new.pfp_url.clone().unwrap_or_else(|| {
        crate::pfp::default_pfp_url(&settings.iris_base_url, AccountKind::Silicon, &uuid)
    });
    let account = sqlx::query_as::<_, Account>(concat!(
        "insert into accounts (uuid, number, kind, handle, status, display_name, pfp_url, dob, timezone, \
         custodian_uuid, stk_hash, stk_rotated_at, webhook_url, webhook_secret_enc) \
         values ($1, $2, 'silicon', $3, $4, $5, $6, (now() at time zone 'utc')::date, $7, $8, $9, now(), $10, $11) returning ",
        crate::account_columns!()
    ))
    .bind(&uuid)
    .bind(number)
    .bind(&full)
    .bind(new.status)
    .bind(&new.display_name)
    .bind(&pfp)
    .bind(&new.timezone)
    .bind(&new.custodian_uuid)
    .bind(&new.stk_hash)
    .bind(&new.webhook_url)
    .bind(&new.webhook_secret_enc)
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| map_handle_conflict(e, &full))?;
    audit::handle_history(&mut tx, &uuid, None, Some(&full), &new.actor).await?;
    tx.commit().await?;
    Ok(account)
}

/// Result of `GET /v1/ids/available`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct IdAvailability {
    pub id: String,
    pub available: bool,
    /// `taken` | `reserved` | `reserved_word` | `invalid` | null.
    pub reason: Option<&'static str>,
    pub message: String,
    /// True when the id is reserved for the requester (their old id) and they can take it back.
    pub reclaimable: bool,
}

/// Checks whether `input` can be taken, optionally from the point of view of `requester_uuid`.
/// Invalid ids are reported (not errors).
pub async fn id_availability(
    conn: &mut PgConnection,
    input: &str,
    requester_uuid: Option<&str>,
) -> ApiResult<IdAvailability> {
    let id = match AccountId::parse(input) {
        Ok(id) => id,
        Err(e) => {
            return Ok(IdAvailability {
                id: input.trim().to_string(),
                available: false,
                reason: Some(e.reason()),
                message: e.to_string(),
                reclaimable: false,
            });
        }
    };
    let full = id.to_string();
    let owner: Option<String> = sqlx::query_scalar("select uuid from accounts where handle = $1")
        .bind(&full)
        .fetch_optional(&mut *conn)
        .await?;
    if let Some(owner) = owner {
        let mine = requester_uuid == Some(owner.as_str());
        return Ok(IdAvailability {
            id: full.clone(),
            available: false,
            reason: Some("taken"),
            message: if mine {
                format!("{full} is already your id.")
            } else {
                format!("{full} is taken by another account.")
            },
            reclaimable: false,
        });
    }
    if let Some((holder, until)) = active_reservation(conn, &full).await? {
        if requester_uuid == Some(holder.as_str()) {
            return Ok(IdAvailability {
                id: full.clone(),
                available: true,
                reason: None,
                message: format!(
                    "{full} was your id; it is reserved for you until {} and you can take it back.",
                    crate::timefmt::format_rfc3339_ms(until)
                ),
                reclaimable: true,
            });
        }
        return Ok(IdAvailability {
            id: full.clone(),
            available: false,
            reason: Some("reserved"),
            message: format!(
                "{full} was released recently and is reserved for its previous owner until {}.",
                crate::timefmt::format_rfc3339_ms(until)
            ),
            reclaimable: false,
        });
    }
    Ok(IdAvailability {
        id: full.clone(),
        available: true,
        reason: None,
        message: format!("{full} is available."),
        reclaimable: false,
    })
}

/// True when nobody has the id and nobody else holds a live reservation on it.
pub async fn is_id_free(
    conn: &mut PgConnection,
    id: &AccountId,
    requester_uuid: Option<&str>,
) -> ApiResult<bool> {
    let full = id.to_string();
    let taken: bool =
        sqlx::query_scalar("select exists (select 1 from accounts where handle = $1)")
            .bind(&full)
            .fetch_one(&mut *conn)
            .await?;
    if taken {
        return Ok(false);
    }
    Ok(match active_reservation(conn, &full).await? {
        Some((holder, _)) => requester_uuid == Some(holder.as_str()),
        None => true,
    })
}

/// Up to `count` available ids built from `seeds` (email local part, name, desired username), in
/// suggestion order. Falls back to random handles if the seeds are exhausted.
pub async fn suggest_ids(
    conn: &mut PgConnection,
    kind: AccountKind,
    seeds: &[&str],
    count: usize,
) -> ApiResult<Vec<AccountId>> {
    let mut out: Vec<AccountId> = Vec::new();
    let candidates: Vec<String> = handle_candidates(seeds).take(80).collect();
    for chunk in candidates.chunks(40) {
        let fulls: Vec<String> = chunk
            .iter()
            .map(|h| format!("{}{h}", kind.prefix()))
            .collect();
        let free: Vec<String> = sqlx::query_scalar(
            "select c.h from unnest($1::text[]) with ordinality as c(h, ord) \
             where not exists (select 1 from accounts a where a.handle = c.h) \
               and not exists (select 1 from handle_reservations r where r.handle = c.h and r.reserved_until > now()) \
             order by c.ord",
        )
        .bind(&fulls)
        .fetch_all(&mut *conn)
        .await?;
        for f in free {
            if let Ok(id) = AccountId::parse(&f)
                && !out.contains(&id)
            {
                out.push(id);
            }
            if out.len() >= count {
                return Ok(out);
            }
        }
    }
    while out.len() < count {
        let random = format!(
            "{}-{}",
            kind.as_str(),
            hex::encode(crate::crypto::random_bytes::<4>())
        );
        if let Ok(id) = AccountId::new(kind, &random)
            && is_id_free(conn, &id, None).await?
            && !out.contains(&id)
        {
            out.push(id);
        }
    }
    Ok(out)
}

/// The best available id for the seeds (see [`suggest_ids`]).
pub async fn suggest_id(
    conn: &mut PgConnection,
    kind: AccountKind,
    seeds: &[&str],
) -> ApiResult<AccountId> {
    let mut ids = suggest_ids(conn, kind, seeds, 1).await?;
    ids.pop()
        .ok_or_else(|| ApiError::internal("suggest_ids returned no id"))
}

/// Outcome of [`change_id`].
#[derive(Debug, Clone)]
pub struct IdChange {
    pub account: Account,
    pub old_id: String,
    pub new_id: String,
    /// False when the new id equals the current one (nothing happened).
    pub changed: bool,
    /// True when the account took back one of its own reserved ids.
    pub reclaimed: bool,
}

/// Changes an account's id. The old id is reserved for 10 days for this account; reclaiming one
/// of the account's own reserved ids removes that reservation. Bumps `version` and writes
/// `handle_history`. Emit the webhooks (`events::account_id_changed`) after this succeeds.
///
/// Errors: 404 `account_not_found`, 409 `account_deleted`, 422 `invalid_id` (wrong prefix),
/// 409 `id_taken` (with `details.suggestions`), 409 `id_reserved`.
pub async fn change_id(
    conn: &mut PgConnection,
    account_uuid: &str,
    new_id: &AccountId,
    actor: &str,
) -> ApiResult<IdChange> {
    let mut tx = conn.begin().await?;
    let account = lock(&mut tx, account_uuid).await?.ok_or_else(|| {
        ApiError::not_found(
            "account_not_found",
            format!("No account has the uuid '{account_uuid}'."),
        )
    })?;
    let Some(old) = account.handle.clone() else {
        return Err(ApiError::conflict(
            "account_deleted",
            format!("Account {account_uuid} is deleted; its id can't change."),
        ));
    };
    if account.status == AccountStatus::Deleted {
        return Err(ApiError::conflict(
            "account_deleted",
            format!("{old} is deleted; its id can't change."),
        ));
    }
    if new_id.kind() != account.kind {
        return Err(invalid_id(&IdError::WrongKind {
            input: new_id.to_string(),
            expected: account.kind,
        }));
    }
    let new_full = new_id.to_string();
    if new_full == old {
        tx.commit().await?;
        return Ok(IdChange {
            account,
            old_id: old.clone(),
            new_id: new_full,
            changed: false,
            reclaimed: false,
        });
    }
    lock_handles(&mut tx, &[&old, &new_full]).await?;
    let claim = ensure_claimable(&mut tx, new_id, Some(account_uuid)).await?;
    if claim == Claim::ReclaimOwn {
        sqlx::query("delete from handle_reservations where handle = $1")
            .bind(&new_full)
            .execute(&mut *tx)
            .await?;
    }
    let updated = sqlx::query_as::<_, Account>(concat!(
        "update accounts set handle = $2, version = version + 1, updated_at = now() where uuid = $1 returning ",
        crate::account_columns!()
    ))
    .bind(account_uuid)
    .bind(&new_full)
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| map_handle_conflict(e, &new_full))?;
    reserve_handle(&mut tx, &old, account_uuid).await?;
    audit::handle_history(&mut tx, account_uuid, Some(&old), Some(&new_full), actor).await?;
    tx.commit().await?;
    Ok(IdChange {
        account: updated,
        old_id: old,
        new_id: new_full,
        changed: true,
        reclaimed: claim == Claim::ReclaimOwn,
    })
}

/// Validated profile changes (`None` = keep). Validate inputs with `normalize::*` first.
#[derive(Debug, Clone, Default)]
pub struct ProfileUpdate {
    pub display_name: Option<String>,
    pub timezone: Option<String>,
    pub dob: Option<Date>,
    pub pfp_url: Option<String>,
}

/// Applies profile changes; only fields that actually change are written. Bumps `version` when
/// anything changed and returns the changed fields (feed them to `events::account_updated`).
/// A Silicon's dob is immutable (422 `dob_immutable`).
pub async fn update_profile(
    conn: &mut PgConnection,
    account_uuid: &str,
    update: &ProfileUpdate,
) -> ApiResult<(Account, Vec<AccountField>)> {
    let mut tx = conn.begin().await?;
    let account = lock(&mut tx, account_uuid).await?.ok_or_else(|| {
        ApiError::not_found(
            "account_not_found",
            format!("No account has the uuid '{account_uuid}'."),
        )
    })?;
    if account.status == AccountStatus::Deleted {
        return Err(ApiError::conflict(
            "account_deleted",
            format!("Account {account_uuid} is deleted."),
        ));
    }
    let mut changed = Vec::new();
    if let Some(n) = &update.display_name
        && *n != account.display_name
    {
        changed.push(AccountField::DisplayName);
    }
    if let Some(t) = &update.timezone
        && *t != account.timezone
    {
        changed.push(AccountField::Timezone);
    }
    if let Some(d) = update.dob
        && d != account.dob
    {
        if account.kind == AccountKind::Silicon {
            return Err(ApiError::unprocessable(
                    "dob_immutable",
                    format!(
                        "A Silicon's date of birth is the day its account was created ({}) and can't change.",
                        crate::timefmt::format_date(account.dob)
                    ),
                )
                .hint("Leave dob out of the request."));
        }
        changed.push(AccountField::Dob);
    }
    if let Some(p) = &update.pfp_url
        && *p != account.pfp_url
    {
        changed.push(AccountField::PfpUrl);
    }
    if changed.is_empty() {
        tx.commit().await?;
        return Ok((account, changed));
    }
    let updated = sqlx::query_as::<_, Account>(concat!(
        "update accounts set display_name = coalesce($2, display_name), timezone = coalesce($3, timezone), \
         dob = coalesce($4, dob), pfp_url = coalesce($5, pfp_url), version = version + 1, updated_at = now() \
         where uuid = $1 returning ",
        crate::account_columns!()
    ))
    .bind(account_uuid)
    .bind(&update.display_name)
    .bind(&update.timezone)
    .bind(update.dob)
    .bind(&update.pfp_url)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok((updated, changed))
}

/// Bumps `version` (and `updated_at`) after a change that apps can see but that is stored
/// elsewhere, such as a new primary email. Returns the updated account.
pub async fn bump_version(conn: &mut PgConnection, account_uuid: &str) -> ApiResult<Account> {
    Ok(sqlx::query_as::<_, Account>(concat!(
        "update accounts set version = version + 1, updated_at = now() where uuid = $1 returning ",
        crate::account_columns!()
    ))
    .bind(account_uuid)
    .fetch_one(&mut *conn)
    .await?)
}

/// Sets the status (e.g. `pending_custodian` → `active`).
pub async fn set_status(
    conn: &mut PgConnection,
    account_uuid: &str,
    status: AccountStatus,
) -> ApiResult<Account> {
    Ok(sqlx::query_as::<_, Account>(concat!(
        "update accounts set status = $2, updated_at = now() where uuid = $1 returning ",
        crate::account_columns!()
    ))
    .bind(account_uuid)
    .bind(status)
    .fetch_one(&mut *conn)
    .await?)
}

/// Makes `custodian_uuid` the Silicon's custodian (and sets its status). Bumps `version`.
pub async fn set_custodian(
    conn: &mut PgConnection,
    silicon_uuid: &str,
    custodian_uuid: &str,
    status: AccountStatus,
) -> ApiResult<Account> {
    Ok(sqlx::query_as::<_, Account>(concat!(
        "update accounts set custodian_uuid = $2, status = $3, version = version + 1, updated_at = now() \
         where uuid = $1 and kind = 'silicon' returning ",
        crate::account_columns!()
    ))
    .bind(silicon_uuid)
    .bind(custodian_uuid)
    .bind(status)
    .fetch_one(&mut *conn)
    .await?)
}

/// Replaces a Silicon's STK hash: the old STK stops working immediately; failures reset.
/// Returns `stk_rotated_at`.
pub async fn set_stk(
    conn: &mut PgConnection,
    silicon_uuid: &str,
    stk_hash: &str,
) -> ApiResult<OffsetDateTime> {
    let at: Option<OffsetDateTime> = sqlx::query_scalar(
        "update accounts set stk_hash = $2, stk_rotated_at = now(), stk_failed_attempts = 0, stk_locked_until = null, \
         updated_at = now() where uuid = $1 and kind = 'silicon' returning stk_rotated_at",
    )
    .bind(silicon_uuid)
    .bind(stk_hash)
    .fetch_optional(&mut *conn)
    .await?
    .flatten();
    at.ok_or_else(|| {
        ApiError::not_found(
            "silicon_not_found",
            format!("No Silicon has the uuid '{silicon_uuid}'."),
        )
    })
}

/// Records a wrong STK. After `max_failures` consecutive failures the login locks for
/// `lock_seconds` and the counter restarts. Returns the lock expiry when this failure locked it.
/// Takes the pool so the failure persists even though the request fails.
pub async fn record_stk_failure(
    pool: &PgPool,
    silicon_uuid: &str,
    max_failures: i32,
    lock_seconds: i64,
) -> ApiResult<Option<OffsetDateTime>> {
    let row: Option<(i32, Option<OffsetDateTime>)> = sqlx::query_as(
        "update accounts set \
           stk_failed_attempts = case when stk_failed_attempts + 1 >= $2 then 0 else stk_failed_attempts + 1 end, \
           stk_locked_until = case when stk_failed_attempts + 1 >= $2 then now() + make_interval(secs => $3) else stk_locked_until end \
         where uuid = $1 returning stk_failed_attempts, stk_locked_until",
    )
    .bind(silicon_uuid)
    .bind(max_failures)
    .bind(lock_seconds as f64)
    .fetch_optional(pool)
    .await?;
    Ok(match row {
        Some((0, Some(until))) => Some(until),
        _ => None,
    })
}

/// Clears STK failure tracking after a successful login.
pub async fn clear_stk_failures(conn: &mut PgConnection, silicon_uuid: &str) -> ApiResult<()> {
    sqlx::query(
        "update accounts set stk_failed_attempts = 0, stk_locked_until = null where uuid = $1 \
         and (stk_failed_attempts <> 0 or stk_locked_until is not null)",
    )
    .bind(silicon_uuid)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Sets or removes a Silicon's own webhook (url + keyring-encrypted secret).
pub async fn set_silicon_webhook(
    conn: &mut PgConnection,
    silicon_uuid: &str,
    url: Option<&str>,
    secret_enc: Option<&[u8]>,
) -> ApiResult<Account> {
    Ok(sqlx::query_as::<_, Account>(concat!(
        "update accounts set webhook_url = $2, webhook_secret_enc = $3, updated_at = now() \
         where uuid = $1 and kind = 'silicon' returning ",
        crate::account_columns!()
    ))
    .bind(silicon_uuid)
    .bind(url)
    .bind(secret_enc)
    .fetch_one(&mut *conn)
    .await?)
}

/// What [`delete_account`] did.
#[derive(Debug, Clone)]
pub struct DeletedAccount {
    /// The account as it was before deletion.
    pub before: Account,
    /// The id it had (now reserved, or released).
    pub old_id: Option<String>,
    pub revoked_families: u64,
    pub revoked_proofs: u64,
}

/// Deletes an account: status `deleted`, id reserved for 10 days (`reserve_id = true`) or
/// released immediately (`false`: a Silicon whose custodian declined / never accepted), emails,
/// phones and identities removed, browser sessions, token families and OBO proofs revoked,
/// pending custodian requests cancelled, STK and Silicon webhook cleared. Memberships stay as
/// history. Idempotent for already-deleted accounts. Check custody rules and emit
/// `events::account_deleted` in the caller.
pub async fn delete_account(
    conn: &mut PgConnection,
    account_uuid: &str,
    actor: &str,
    reserve_id: bool,
) -> ApiResult<DeletedAccount> {
    let mut tx = conn.begin().await?;
    let before = lock(&mut tx, account_uuid).await?.ok_or_else(|| {
        ApiError::not_found(
            "account_not_found",
            format!("No account has the uuid '{account_uuid}'."),
        )
    })?;
    if before.status == AccountStatus::Deleted {
        tx.commit().await?;
        return Ok(DeletedAccount {
            old_id: before.handle.clone(),
            before,
            revoked_families: 0,
            revoked_proofs: 0,
        });
    }
    let old = before.handle.clone();
    if let Some(h) = &old {
        lock_handles(&mut tx, &[h]).await?;
    }
    sqlx::query(
        "update accounts set status = 'deleted', handle = null, deleted_at = now(), updated_at = now(), \
         version = version + 1, stk_hash = null, stk_failed_attempts = 0, stk_locked_until = null, \
         webhook_url = null, webhook_secret_enc = null where uuid = $1",
    )
    .bind(account_uuid)
    .execute(&mut *tx)
    .await?;
    if let Some(h) = &old {
        if reserve_id {
            reserve_handle(&mut tx, h, account_uuid).await?;
        }
        audit::handle_history(&mut tx, account_uuid, Some(h), None, actor).await?;
    }
    for table in ["account_emails", "account_phones", "identities"] {
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "delete from {table} where account_uuid = $1"
        )))
        .bind(account_uuid)
        .execute(&mut *tx)
        .await?;
    }
    sqlx::query("update browser_sessions set revoked_at = now() where account_uuid = $1 and revoked_at is null")
        .bind(account_uuid)
        .execute(&mut *tx)
        .await?;
    let revoked_families = sqlx::query(
        "update token_families set revoked_at = now(), revoke_reason = 'account_deleted' \
         where account_uuid = $1 and revoked_at is null",
    )
    .bind(account_uuid)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    let revoked_proofs = sqlx::query(
        "update proof_families set revoked_at = now(), revoked_by = 'system', revoke_reason = 'account_deleted' \
         where account_uuid = $1 and revoked_at is null",
    )
    .bind(account_uuid)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    sqlx::query(
        "update custodian_requests set status = 'cancelled', decided_at = now(), decided_by = $1 \
         where status = 'pending' and (silicon_uuid = $1 or to_uuid = $1)",
    )
    .bind(account_uuid)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(DeletedAccount {
        before,
        old_id: old,
        revoked_families,
        revoked_proofs,
    })
}

/// Releases a Silicon that never became active (custodian declined or never accepted): deleted,
/// id free immediately (no reservation).
pub async fn release_silicon(
    conn: &mut PgConnection,
    silicon_uuid: &str,
    actor: &str,
) -> ApiResult<DeletedAccount> {
    delete_account(conn, silicon_uuid, actor, false).await
}

/// The live reservation of an id: (holder uuid, reserved_until).
pub async fn active_reservation(
    conn: &mut PgConnection,
    full_id: &str,
) -> ApiResult<Option<(String, OffsetDateTime)>> {
    Ok(sqlx::query_as::<_, (String, OffsetDateTime)>(
        "select account_uuid, reserved_until from handle_reservations where handle = $1 and reserved_until > now()",
    )
    .bind(full_id)
    .fetch_optional(&mut *conn)
    .await?)
}

/// Live reservations held by an account (its recent old ids), newest first.
pub async fn reservations_of(
    conn: &mut PgConnection,
    account_uuid: &str,
) -> ApiResult<Vec<(String, OffsetDateTime)>> {
    Ok(sqlx::query_as::<_, (String, OffsetDateTime)>(
        "select handle, reserved_until from handle_reservations where account_uuid = $1 and reserved_until > now() \
         order by reserved_until desc",
    )
    .bind(account_uuid)
    .fetch_all(&mut *conn)
    .await?)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Claim {
    Free,
    ReclaimOwn,
}

/// Serializes concurrent claims of the same ids for the rest of the transaction.
async fn lock_handles(conn: &mut PgConnection, handles: &[&str]) -> ApiResult<()> {
    let mut sorted: Vec<&str> = handles.to_vec();
    sorted.sort_unstable();
    sorted.dedup();
    for h in sorted {
        sqlx::query("select pg_advisory_xact_lock(hashtextextended('handle:' || $1, 0))")
            .bind(h)
            .execute(&mut *conn)
            .await?;
    }
    Ok(())
}

async fn ensure_claimable(
    conn: &mut PgConnection,
    id: &AccountId,
    requester_uuid: Option<&str>,
) -> ApiResult<Claim> {
    let full = id.to_string();
    let owner: Option<String> = sqlx::query_scalar("select uuid from accounts where handle = $1")
        .bind(&full)
        .fetch_optional(&mut *conn)
        .await?;
    if owner.is_some() {
        return Err(id_taken(conn, id).await);
    }
    match active_reservation(conn, &full).await? {
        Some((holder, _)) if requester_uuid == Some(holder.as_str()) => Ok(Claim::ReclaimOwn),
        Some((_, until)) => Err(ApiError::conflict(
            "id_reserved",
            format!(
                "{full} was released recently and is reserved for its previous owner until {}.",
                crate::timefmt::format_rfc3339_ms(until)
            ),
        )
        .hint("Pick another id, or wait until the reservation ends.")
        .detail("reserved_until", crate::timefmt::format_rfc3339_ms(until))),
        None => {
            sqlx::query(
                "delete from handle_reservations where handle = $1 and reserved_until <= now()",
            )
            .bind(&full)
            .execute(&mut *conn)
            .await?;
            Ok(Claim::Free)
        }
    }
}

async fn id_taken(conn: &mut PgConnection, id: &AccountId) -> ApiError {
    let suggestions = suggest_ids(conn, id.kind(), &[id.handle()], 3)
        .await
        .unwrap_or_default();
    let list: Vec<String> = suggestions.iter().map(|s| s.to_string()).collect();
    let hint = if list.is_empty() {
        "Pick another id.".to_string()
    } else {
        format!("Pick another id, for example {}.", list.join(", "))
    };
    ApiError::conflict("id_taken", format!("{id} is taken by another account."))
        .hint(hint)
        .detail("suggestions", list)
}

fn map_handle_conflict(e: sqlx::Error, full: &str) -> ApiError {
    if is_unique_violation(&e, Some("accounts_handle_key")) {
        ApiError::conflict(
            "id_taken",
            format!("{full} was just taken by another account."),
        )
        .hint("Pick another id and try again.")
    } else {
        e.into()
    }
}

async fn reserve_handle(conn: &mut PgConnection, full: &str, account_uuid: &str) -> ApiResult<()> {
    sqlx::query(
        "insert into handle_reservations (handle, account_uuid, reserved_until) \
         values ($1, $2, now() + make_interval(days => $3)) \
         on conflict (handle) do update set account_uuid = excluded.account_uuid, \
           reserved_until = excluded.reserved_until, created_at = now()",
    )
    .bind(full)
    .bind(account_uuid)
    .bind(HANDLE_RESERVATION_DAYS as i32)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

async fn ensure_contact_free(conn: &mut PgConnection, kind: &str, value: &str) -> ApiResult<()> {
    let sql = if kind == "email" {
        "select exists (select 1 from account_emails where email = $1)"
    } else {
        "select exists (select 1 from account_phones where phone = $1)"
    };
    let used: bool = sqlx::query_scalar(sql)
        .bind(value)
        .fetch_one(&mut *conn)
        .await?;
    if used {
        return Err(contact_in_use(kind, value));
    }
    Ok(())
}

fn contact_in_use(kind: &str, value: &str) -> ApiError {
    if kind == "email" {
        ApiError::conflict("email_in_use", format!("{value} already belongs to another account."))
            .hint("An email can only belong to one account. Sign in with it instead, or use another email.")
    } else {
        ApiError::conflict("phone_in_use", format!("{value} already belongs to another account."))
            .hint("A phone number can only belong to one account. Sign in with it instead, or use another number.")
    }
}

async fn insert_contact(
    conn: &mut PgConnection,
    kind: &str,
    account_uuid: &str,
    value: &str,
    primary: bool,
    via: Option<VerifiedVia>,
) -> ApiResult<()> {
    let sql = if kind == "email" {
        "insert into account_emails (email, account_uuid, is_primary, verified_at, verified_via) \
         values ($1, $2, $3, case when $4::text is null then null else now() end, $4)"
    } else {
        "insert into account_phones (phone, account_uuid, is_primary, verified_at, verified_via) \
         values ($1, $2, $3, case when $4::text is null then null else now() end, $4)"
    };
    sqlx::query(sql)
        .bind(value)
        .bind(account_uuid)
        .bind(primary)
        .bind(via.map(|v| v.as_str()))
        .execute(&mut *conn)
        .await
        .map_err(|e| {
            if is_unique_violation(&e, None) {
                contact_in_use(kind, value)
            } else {
                e.into()
            }
        })?;
    Ok(())
}

fn invalid_id(e: &IdError) -> ApiError {
    ApiError::unprocessable("invalid_id", e.to_string())
        .hint(e.hint())
        .detail("reason", e.reason())
}

/// Maps an [`IdError`] to the API error used by id-taking endpoints (422 `invalid_id`, with
/// `details.reason` = `invalid` | `reserved_word`).
pub fn invalid_id_error(e: &IdError) -> ApiError {
    invalid_id(e)
}
