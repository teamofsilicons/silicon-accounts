//! Accounts: creation (uuid from `account_number_seq`), lookups, ids (availability, change,
//! 10-day reservations, reclaim, history, the per-day change limit), profile updates, finishing
//! an imported account, the STK sign-in lock, deletion and releasing a Silicon that never became
//! active.

use serde::Serialize;
use serde_json::json;
use sqlx::{Connection, PgConnection, PgPool};
use time::{Date, OffsetDateTime};
use uuid::Uuid;

use crate::config::Settings;
use crate::error::{ApiError, ApiResult};
use crate::ids::{AccountId, IdError, handle_candidates, uuid_for_number};
use crate::models::{Account, AccountField, AccountKind, AccountStatus, ActorKind, VerifiedVia};
use crate::repo::contacts::{self, ContactKind};
use crate::repo::{audit, is_unique_violation};
use crate::views::AccountSummary;

/// Days an old id stays reserved for its previous owner.
pub const HANDLE_RESERVATION_DAYS: i64 = 10;

/// Most id changes one account can make in [`ID_CHANGE_WINDOW_SECONDS`], whoever makes them (a
/// Silicon's custodian counts too) and including reclaims. Every change keeps the old id
/// reserved for 10 days and notifies every member app, so without a limit one account could hold
/// any number of ids and flood its apps with webhooks; with it, an account holds at most 50
/// reserved ids at a time.
pub const ID_CHANGES_PER_DAY: i64 = 5;
/// The rolling window of [`ID_CHANGES_PER_DAY`]: 24 hours.
pub const ID_CHANGE_WINDOW_SECONDS: i64 = 86_400;

/// Consecutive wrong STKs that lock a Silicon's sign-in ([`begin_stk_attempt`]).
pub const MAX_STK_FAILURES: i32 = 10;
/// How long the STK sign-in lock lasts.
pub const STK_LOCK_SECONDS: i64 = 60;

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

/// The account that has a row for this (normalized) email, **verified or not**: for uniqueness
/// checks only. Never authenticate with it: an unverified row proves nothing about who someone
/// is. Who an address signs in to is `repo::contacts::lookup` (verified addresses of active
/// Carbons, and the addresses of an unfinished import).
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

/// The account that has a row for this E.164 phone number, **verified or not**: for uniqueness
/// checks only (see [`by_email`]; authenticate with `repo::contacts::lookup`).
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

/// A contact to attach at creation. `verified_via: None` = unverified, which only an `unclaimed`
/// (imported) account may have.
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
/// Errors: 422 `invalid_id` (not a c: id), 422 `email_limit_reached` / `phone_limit_reached`
/// (more than 10 of a kind), 409 `id_taken` (with `details.suggestions`), 409 `id_reserved`,
/// 409 `email_in_use` / `phone_in_use`.
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
    for (kind, list) in [
        (ContactKind::Email, &new.emails),
        (ContactKind::Phone, &new.phones),
    ] {
        if list.len() as i64 > contacts::MAX_PER_KIND {
            return Err(ApiError::unprocessable(
                format!("{}_limit_reached", kind.code()),
                format!(
                    "An account can have at most {} {}s, but {} were given.",
                    contacts::MAX_PER_KIND,
                    kind.noun(),
                    list.len()
                ),
            )
            .hint(format!(
                "Keep at most {} {}s for the account; the others can be added later.",
                contacts::MAX_PER_KIND,
                kind.noun()
            ))
            .detail("limit", contacts::MAX_PER_KIND));
        }
        // Unverified addresses exist only on imported accounts nobody finished yet.
        if new.status != AccountStatus::Unclaimed && list.iter().any(|c| c.verified_via.is_none()) {
            return Err(ApiError::internal(format!(
                "create_carbon: an unverified {} on a new {} account",
                kind.noun(),
                new.status
            )));
        }
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
    id_availability_for(conn, input, requester_uuid, None).await
}

/// [`id_availability`] from the point of view of another account the caller manages (a
/// custodian asking for one of its Silicons): `requester_label` (e.g. `si:scout`) names it in
/// the messages instead of "you".
pub async fn id_availability_for(
    conn: &mut PgConnection,
    input: &str,
    requester_uuid: Option<&str>,
    requester_label: Option<&str>,
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
            message: match (mine, requester_label) {
                (true, Some(label)) => format!("{full} is already the id of {label}."),
                (true, None) => format!("{full} is already your id."),
                (false, _) => format!("{full} is taken by another account."),
            },
            reclaimable: false,
        });
    }
    if let Some((holder, until)) = active_reservation(conn, &full).await? {
        if requester_uuid == Some(holder.as_str()) {
            let until = crate::timefmt::format_rfc3339_ms(until);
            return Ok(IdAvailability {
                id: full.clone(),
                available: true,
                reason: None,
                message: match requester_label {
                    Some(label) => format!(
                        "{full} was an id of {label}; it is reserved for {label} until {until} and you can take it back for it."
                    ),
                    None => format!(
                        "{full} was your id; it is reserved for you until {until} and you can take it back."
                    ),
                },
                reclaimable: true,
            });
        }
        return Ok(IdAvailability {
            id: full.clone(),
            available: false,
            reason: Some("reserved"),
            message: reserved_id_message(conn, &full, &holder, until).await?,
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
/// `handle_history`. Emit the webhooks (`events::notify_id_changed`) after this succeeds.
///
/// At most [`ID_CHANGES_PER_DAY`] changes per rolling 24 hours, counted from `handle_history`
/// under the account's row lock (so concurrent changes are counted exactly), whoever makes them.
/// Asking for the current id again changes nothing and never counts.
///
/// Errors: 404 `account_not_found`, 409 `account_deleted`, 422 `invalid_id` (wrong prefix),
/// 429 `rate_limited` (with `Retry-After`, `details.retry_at`), 409 `id_taken` (with
/// `details.suggestions`), 409 `id_reserved`.
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
    check_id_change_budget(&mut tx, &account).await?;
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

/// Refuses a new id change when the account's id already changed [`ID_CHANGES_PER_DAY`] times
/// in the last 24 hours (429 `rate_limited`). The caller holds the account's row lock.
async fn check_id_change_budget(conn: &mut PgConnection, account: &Account) -> ApiResult<()> {
    let (recent, retry_seconds, retry_at): (i64, Option<f64>, Option<OffsetDateTime>) =
        sqlx::query_as(
            "select count(*), \
                    extract(epoch from (min(changed_at) + make_interval(secs => $2) - now()))::float8, \
                    min(changed_at) + make_interval(secs => $2) \
               from (select changed_at from handle_history \
                      where account_uuid = $1 and old_handle is not null and new_handle is not null \
                        and changed_at > now() - make_interval(secs => $2) \
                      order by changed_at desc limit $3) recent",
        )
        .bind(&account.uuid)
        .bind(ID_CHANGE_WINDOW_SECONDS as f64)
        .bind(ID_CHANGES_PER_DAY)
        .fetch_one(&mut *conn)
        .await?;
    if recent < ID_CHANGES_PER_DAY {
        return Ok(());
    }
    // With `limit` the oldest row kept is the change that has to leave the window first.
    let retry = retry_seconds
        .map(|s| s.ceil().max(1.0) as u64)
        .unwrap_or(ID_CHANGE_WINDOW_SECONDS as u64);
    let when = retry_at
        .map(crate::timefmt::format_rfc3339_ms)
        .unwrap_or_else(|| format!("in {retry} seconds"));
    Err(ApiError::rate_limited(
        format!(
            "{} has already changed its id {ID_CHANGES_PER_DAY} times in the last 24 hours, which is the most an account can. Every change keeps the old id reserved for 10 days, so changes are limited to {ID_CHANGES_PER_DAY} per 24 hours.",
            account.display_id()
        ),
        retry,
    )
    .hint(format!(
        "Try again at {when} ({retry} seconds from now); {} stays the id until then.",
        account.display_id()
    ))
    .detail("limit", ID_CHANGES_PER_DAY)
    .detail("window_seconds", ID_CHANGE_WINDOW_SECONDS)
    .detail("retry_at", retry_at.map(crate::timefmt::format_rfc3339_ms)))
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
///
/// `stk_rotated_at` is the statement's clock (`clock_timestamp()`), taken once the Silicon's row
/// is locked by this update, not the start of the caller's transaction (`now()`). The token
/// endpoint refuses a short-lived token whose `created_at` is not later than `stk_rotated_at`
/// (it was minted by a sign-in the rotation ended), and every SLT is stored under a share lock
/// on this row: an SLT stored before the rotation committed before this lock was granted, so
/// it is older than this stamp. With the transaction's start time instead, an SLT whose
/// transaction began after the rotation's but committed before the rotation got the lock would
/// look newer than the rotation and stay usable.
pub async fn set_stk(
    conn: &mut PgConnection,
    silicon_uuid: &str,
    stk_hash: &str,
) -> ApiResult<OffsetDateTime> {
    let at: Option<OffsetDateTime> = sqlx::query_scalar(
        "update accounts set stk_hash = $2, stk_rotated_at = clock_timestamp(), stk_failed_attempts = 0, \
         stk_locked_until = null, updated_at = now() where uuid = $1 and kind = 'silicon' returning stk_rotated_at",
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

/// The answer of [`begin_stk_attempt`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StkAttempt {
    /// Check the STK now. `attempt` is this attempt's place in the current run of failures
    /// (1-based, already counted); report a wrong STK with [`stk_attempt_failed`].
    Check { attempt: i32 },
    /// Sign-in is locked (`login_locked`) for this many more seconds; don't check the STK.
    Locked { retry_after_seconds: u64 },
}

/// Charges one sign-in attempt to a Silicon **before** its STK is checked, atomically: one
/// statement counts the attempt unless sign-in is locked. So a burst of parallel guesses gets at
/// most `max_failures` STK checks per lock window, however many arrive at once: the attempt
/// beyond `max_failures` locks sign-in for `lock_seconds` right away, without being checked.
///
/// Then: a right STK → [`clear_stk_failures`] (inside the sign-in's transaction is fine); a
/// wrong one → [`stk_attempt_failed`] with the returned `attempt`. Takes the pool: the charge
/// must stick even though the request fails. Times are the database clock.
pub async fn begin_stk_attempt(
    pool: &PgPool,
    silicon_uuid: &str,
    max_failures: i32,
    lock_seconds: i64,
) -> ApiResult<StkAttempt> {
    let mut conn = pool.acquire().await?;
    let attempt: Option<i32> = sqlx::query_scalar(
        "update accounts set stk_failed_attempts = stk_failed_attempts + 1 \
         where uuid = $1 and (stk_locked_until is null or stk_locked_until <= now()) \
         returning stk_failed_attempts",
    )
    .bind(silicon_uuid)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(attempt) = attempt else {
        let seconds: Option<f64> = sqlx::query_scalar(
            "select extract(epoch from (stk_locked_until - now()))::float8 from accounts \
             where uuid = $1 and stk_locked_until > now()",
        )
        .bind(silicon_uuid)
        .fetch_optional(&mut *conn)
        .await?;
        return Ok(StkAttempt::Locked {
            retry_after_seconds: seconds.map(|s| s.ceil().max(1.0) as u64).unwrap_or(1),
        });
    };
    if attempt > max_failures {
        // More guesses in flight than the lock allows: lock now without checking this one.
        lock_stk_sign_in(&mut conn, silicon_uuid, lock_seconds).await?;
        return Ok(StkAttempt::Locked {
            retry_after_seconds: lock_seconds.max(1) as u64,
        });
    }
    Ok(StkAttempt::Check { attempt })
}

/// Reports that the STK of attempt `attempt` (from [`begin_stk_attempt`]) was wrong. The
/// attempt was already counted; when it was the `max_failures`th in a row, sign-in locks for
/// `lock_seconds` (the count starts over) and the lock's end is returned.
pub async fn stk_attempt_failed(
    pool: &PgPool,
    silicon_uuid: &str,
    attempt: i32,
    max_failures: i32,
    lock_seconds: i64,
) -> ApiResult<Option<OffsetDateTime>> {
    if attempt < max_failures {
        return Ok(None);
    }
    let mut conn = pool.acquire().await?;
    lock_stk_sign_in(&mut conn, silicon_uuid, lock_seconds)
        .await
        .map(Some)
}

async fn lock_stk_sign_in(
    conn: &mut PgConnection,
    silicon_uuid: &str,
    lock_seconds: i64,
) -> ApiResult<OffsetDateTime> {
    Ok(sqlx::query_scalar(
        "update accounts set stk_locked_until = now() + make_interval(secs => $2), stk_failed_attempts = 0 \
         where uuid = $1 returning stk_locked_until",
    )
    .bind(silicon_uuid)
    .bind(lock_seconds as f64)
    .fetch_one(&mut *conn)
    .await?)
}

/// Clears STK failure tracking after a successful sign-in.
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

/// What [`finish_claim`] did.
#[derive(Debug, Clone)]
pub struct ClaimFinished {
    /// The account, now active.
    pub account: Account,
    /// `email` / `phone` when the primary of that kind changed or became verified (apps holding
    /// that scope must hear about it, with the caller's other changes).
    pub changed: Vec<AccountField>,
}

/// Finishes an `unclaimed` Carbon an app imported, for the Carbon who just proved `proven`
/// (each `(kind, normalized value, how)`): every proven address becomes verified (added when it
/// isn't on the account; primary when the primary of its kind isn't verified), **every other
/// unverified email and phone is removed** (the import listed them and nobody proved them: an
/// unproven address must never sign anyone into this account; the importing app keeps its copy
/// in `memberships.imported_profile`), the status becomes `active` and `version` bumps when an
/// address changed. One transaction (a savepoint inside the caller's).
///
/// Profile and id changes are the caller's (`update_profile`, `change_id`), as are the webhooks
/// (`events::notify_profile_updated` with [`ClaimFinished::changed`] and the profile fields).
///
/// Errors: 404 `account_not_found`, 409 `account_not_unclaimed` (someone finished it already,
/// or it isn't an imported Carbon), and [`contacts::add_verified`]'s errors for a proven address
/// another account holds.
pub async fn finish_claim(
    conn: &mut PgConnection,
    account_uuid: &str,
    proven: &[(ContactKind, &str, VerifiedVia)],
) -> ApiResult<ClaimFinished> {
    let mut tx = conn.begin().await?;
    let current = lock(&mut tx, account_uuid).await?.ok_or_else(|| {
        ApiError::not_found(
            "account_not_found",
            format!("No account has the uuid '{account_uuid}'."),
        )
    })?;
    if current.kind != AccountKind::Carbon || current.status != AccountStatus::Unclaimed {
        tx.rollback().await?;
        return Err(ApiError::conflict(
            "account_not_unclaimed",
            format!(
                "{} is {}, not an imported account waiting to be finished, so it can't be claimed.",
                current.display_id(),
                current.status
            ),
        )
        .hint("Sign in with the account instead."));
    }
    let mut changed: Vec<AccountField> = Vec::new();
    for (kind, value, via) in proven {
        if contacts::prove(&mut tx, *kind, account_uuid, value, *via).await?
            && !changed.contains(&kind.field())
        {
            changed.push(kind.field());
        }
    }
    for field in contacts::drop_unverified(&mut tx, account_uuid).await? {
        if !changed.contains(&field) {
            changed.push(field);
        }
    }
    let account = sqlx::query_as::<_, Account>(concat!(
        "update accounts set status = 'active', updated_at = now(), \
           version = version + case when $2 then 1 else 0 end \
         where uuid = $1 returning ",
        crate::account_columns!()
    ))
    .bind(account_uuid)
    .bind(!changed.is_empty())
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(ClaimFinished { account, changed })
}

/// A self-created Silicon released by [`delete_account`] because the Carbon it named as its
/// custodian was deleted before accepting.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReleasedSilicon {
    pub uuid: String,
    /// The si:id it had (now free, without a reservation).
    pub old_id: Option<String>,
    /// Its initial custodian request (now `cancelled`).
    pub request_id: Uuid,
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
    /// Uploaded photos deleted (those no other account shows).
    pub deleted_photos: u64,
    /// Self-created Silicons that were waiting for this Carbon to accept them.
    pub released_silicons: Vec<ReleasedSilicon>,
    /// False when the account was already deleted (nothing was done).
    pub deleted_now: bool,
}

/// Deletes an account, all in one transaction (a savepoint inside the caller's):
///
/// - status `deleted`, `version` bumps; the id is reserved for 10 days (`reserve_id`), or
///   released at once (`false`);
/// - emails, phones and Google/Apple identities removed; browser sessions, token families
///   (`account_deleted`) and the User verification proofs about the account revoked (each with a
///   `proof.revoked` audit entry);
/// - the photo back to the Iris default, and its uploads that no other account shows deleted;
/// - memberships stay as the apps' history, without the personal data an app imported
///   (`imported_profile`; the app's own `external_id` stays, so it can match the deletion to its
///   records); every app with a live membership gets `account.deleted` (emitted here);
/// - a Silicon's STK is cleared, but its **webhook is kept**: the worker delivers to a target's
///   current webhook, and events emitted before the deletion must still reach it;
/// - a Carbon's pending custodian requests are cancelled. A Silicon that self-created naming
///   this Carbon can never be accepted now: it is told on its webhook
///   (`silicon.custodian.declined`, reason `custodian_account_deleted`) and released like a
///   decline ([`release_silicon`]; returned in [`DeletedAccount::released_silicons`], audit
///   `silicon.custodian_request.closed`).
///
/// "Every Silicon always has exactly one custodian": a Carbon who is still the custodian of a
/// Silicon that isn't deleted can't be deleted (409 `custodian_of_silicons`, `details.silicons`).
/// The check runs under the Carbon's row lock, and accepting a Silicon (or a transfer)
/// share-locks the accepting Carbon's row, so the two serialize.
///
/// Lock order: the pending custodian requests addressed to the account first, then the account
/// row (the order accepting or expiring a request uses). Idempotent: an already deleted account
/// is left as it is (`deleted_now: false`).
pub async fn delete_account(
    conn: &mut PgConnection,
    settings: &Settings,
    account_uuid: &str,
    actor: &str,
    reserve_id: bool,
) -> ApiResult<DeletedAccount> {
    let mut tx = conn.begin().await?;
    // Lock order: the pending requests addressed to the account first (accepting or expiring a
    // request locks the request before anything else), then the account.
    sqlx::query(
        "select id from custodian_requests where status = 'pending' and to_uuid = $1 order by id for update",
    )
    .bind(account_uuid)
    .fetch_all(&mut *tx)
    .await?;
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
            deleted_photos: 0,
            released_silicons: Vec::new(),
            deleted_now: false,
        });
    }
    if before.kind == AccountKind::Carbon {
        let silicons = list_silicons_in_custody(&mut tx, account_uuid).await?;
        if !silicons.is_empty() {
            tx.rollback().await?;
            return Err(custodian_of_silicons(&before, &silicons));
        }
    }
    let old = before.handle.clone();
    if let Some(h) = &old {
        lock_handles(&mut tx, &[h]).await?;
    }
    // Silicons waiting for this Carbon are told while both still have their ids. Read under the
    // account's lock: a self-creation naming this Carbon share-locks its row before it stores
    // its request, so every such request has committed by now and none is left out.
    let waiting: Vec<(Uuid, String)> = sqlx::query_as(
        "select id, silicon_uuid from custodian_requests \
         where status = 'pending' and to_uuid = $1 and kind = 'initial' order by id for update",
    )
    .bind(account_uuid)
    .fetch_all(&mut *tx)
    .await?;
    let custodian_label = old.clone().unwrap_or_else(|| account_uuid.to_string());
    let mut released_silicons = Vec::new();
    for (request_id, silicon_uuid) in &waiting {
        let Some(silicon) = lock(&mut tx, silicon_uuid).await? else {
            continue;
        };
        if silicon.status != AccountStatus::PendingCustodian {
            continue;
        }
        let decided_at: OffsetDateTime = sqlx::query_scalar(
            "update custodian_requests set status = 'cancelled', decided_at = now(), decided_by = $2 \
             where id = $1 returning decided_at",
        )
        .bind(request_id)
        .bind(account_uuid)
        .fetch_one(&mut *tx)
        .await?;
        crate::events::silicon_custodian_declined(
            &mut tx,
            &silicon,
            *request_id,
            &custodian_label,
            Some(decided_at),
            crate::events::declined_reason::CUSTODIAN_ACCOUNT_DELETED,
        )
        .await?;
        let released_id = release_silicon(&mut tx, silicon_uuid, "system").await?;
        audit::record(
            &mut tx,
            &audit::AuditEntry {
                target_kind: Some("silicon"),
                target_id: Some(silicon_uuid),
                account_uuid: Some(silicon_uuid),
                details: json!({
                    "request_id": request_id.to_string(),
                    "reason": crate::events::declined_reason::CUSTODIAN_ACCOUNT_DELETED,
                    "custodian": custodian_label,
                    "released_id": released_id,
                }),
                ..audit::AuditEntry::new(
                    ActorKind::System,
                    None,
                    "silicon.custodian_request.closed",
                )
            },
        )
        .await?;
        released_silicons.push(ReleasedSilicon {
            uuid: silicon_uuid.clone(),
            old_id: released_id,
            request_id: *request_id,
        });
    }
    let default_pfp =
        crate::pfp::default_pfp_url(&settings.iris_base_url, before.kind, account_uuid);
    sqlx::query(
        "update accounts set status = 'deleted', handle = null, deleted_at = now(), updated_at = now(), \
         version = version + 1, stk_hash = null, stk_failed_attempts = 0, stk_locked_until = null, \
         pfp_url = $2 where uuid = $1",
    )
    .bind(account_uuid)
    .bind(&default_pfp)
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
    let revoked_proofs = revoke_proofs(
        &mut tx,
        "account_uuid = $1",
        account_uuid,
        None,
        "system",
        "account_deleted",
        ActorKind::System,
        None,
    )
    .await?;
    sqlx::query(
        "update custodian_requests set status = 'cancelled', decided_at = now(), decided_by = $1 \
         where status = 'pending' and (silicon_uuid = $1 or to_uuid = $1)",
    )
    .bind(account_uuid)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "update memberships set imported_profile = null, updated_at = now() \
         where account_uuid = $1 and imported_profile is not null",
    )
    .bind(account_uuid)
    .execute(&mut *tx)
    .await?;
    let deleted_photos = crate::repo::photos::prune(&mut tx, settings, account_uuid).await?;
    crate::events::account_deleted(&mut tx, account_uuid).await?;
    tx.commit().await?;
    Ok(DeletedAccount {
        before,
        old_id: old,
        revoked_families,
        revoked_proofs,
        deleted_photos,
        released_silicons,
        deleted_now: true,
    })
}

/// 409 `custodian_of_silicons`: a Carbon who still has Silicons in custody can't be deleted.
fn custodian_of_silicons(carbon: &Account, silicons: &[Account]) -> ApiError {
    let ids: Vec<String> = silicons.iter().map(|s| s.display_id()).collect();
    let summaries: Vec<AccountSummary> =
        silicons.iter().map(AccountSummary::from_account).collect();
    ApiError::conflict(
        "custodian_of_silicons",
        format!(
            "{} is the custodian of {} Silicon(s) ({}), and every Silicon must always have a custodian, so the account can't be deleted yet.",
            carbon.display_id(),
            silicons.len(),
            ids.join(", ")
        ),
    )
    .hint("Transfer each Silicon to another Carbon (POST /v1/me/silicons/{uuid}/transfer, accepted by them) or delete it (DELETE /v1/me/silicons/{uuid}), then delete the account.")
    .detail("silicons", serde_json::to_value(summaries).unwrap_or_default())
}

/// Revokes the live proofs matching `filter` (`account_uuid = $1`, optionally `and issuing_app =
/// $2`) with `reason`, each with a `proof.revoked` audit entry (target `proof`, the issuing app,
/// the account; details `{kind, reason, via, audiences, revoked_at}`) like the proofs crate
/// writes for its own revocations. One statement, so a proof is never revoked without its entry.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn revoke_proofs(
    conn: &mut PgConnection,
    filter: &'static str,
    account_uuid: &str,
    issuing_app: Option<&str>,
    revoked_by: &str,
    reason: &str,
    actor_kind: ActorKind,
    actor_id: Option<&str>,
) -> ApiResult<u64> {
    let sql = format!(
        "with revoked as ( \
           update proof_families f set revoked_at = now(), revoked_by = $3, revoke_reason = $4 \
            where {filter} and ($2::text is null or issuing_app = $2) and revoked_at is null \
           returning f.id, f.kind, f.issuing_app, f.account_uuid, f.audiences, f.revoked_at) \
         insert into audit_log (actor_kind, actor_id, action, target_kind, target_id, app_id, account_uuid, details) \
         select $5, $6, 'proof.revoked', 'proof', r.id::text, r.issuing_app, r.account_uuid, \
                jsonb_build_object('kind', r.kind, 'reason', $4::text, 'via', $4::text, 'audiences', r.audiences, \
                  'revoked_at', to_char(r.revoked_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')) \
           from revoked r"
    );
    Ok(sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(account_uuid)
        .bind(issuing_app)
        .bind(revoked_by)
        .bind(reason)
        .bind(actor_kind)
        .bind(actor_id)
        .execute(&mut *conn)
        .await?
        .rows_affected())
}

/// Releases a self-created Silicon that never became active (its custodian declined, never
/// accepted within 14 days, or deleted their account before answering): status `deleted`, the
/// id freed at once (no reservation: it was never active), the STK cleared, `handle_history`
/// written, any still-pending request of the Silicon cancelled (decided by `actor`). Returns the
/// released id, or `None` when the Silicon isn't waiting for a custodian (nothing is done).
///
/// Its webhook URL and secret are **kept**: the `silicon.custodian.declined` / `.expired` event
/// is delivered by the worker to the Silicon's *current* webhook, after this commits.
///
/// Order for the decline and expiry handlers: decide the request first (`declined` /
/// `expired`), emit the event while the Silicon still has its id, then release. Releasing first
/// would cancel the still-pending request.
pub async fn release_silicon(
    conn: &mut PgConnection,
    silicon_uuid: &str,
    actor: &str,
) -> ApiResult<Option<String>> {
    let mut tx = conn.begin().await?;
    let Some(silicon) = lock(&mut tx, silicon_uuid).await? else {
        tx.commit().await?;
        return Ok(None);
    };
    if silicon.kind != AccountKind::Silicon || silicon.status != AccountStatus::PendingCustodian {
        tx.commit().await?;
        return Ok(None);
    }
    let old = silicon.handle.clone();
    if let Some(h) = &old {
        lock_handles(&mut tx, &[h]).await?;
    }
    sqlx::query(
        "update accounts set status = 'deleted', handle = null, deleted_at = now(), updated_at = now(), \
         version = version + 1, stk_hash = null, stk_failed_attempts = 0, stk_locked_until = null \
         where uuid = $1",
    )
    .bind(silicon_uuid)
    .execute(&mut *tx)
    .await?;
    if let Some(h) = &old {
        audit::handle_history(&mut tx, silicon_uuid, Some(h), None, actor).await?;
    }
    // A waiting Silicon can't sign in, so these find nothing; they make sure of it.
    sqlx::query(
        "update token_families set revoked_at = now(), revoke_reason = 'account_released' \
         where account_uuid = $1 and revoked_at is null",
    )
    .bind(silicon_uuid)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "update browser_sessions set revoked_at = now() where account_uuid = $1 and revoked_at is null",
    )
    .bind(silicon_uuid)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "update custodian_requests set status = 'cancelled', decided_at = now(), decided_by = $2 \
         where silicon_uuid = $1 and status = 'pending'",
    )
    .bind(silicon_uuid)
    .bind(actor)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(old)
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

/// Why someone else can't take `full_id` while `holder` keeps a reservation on it until `until`.
/// The old id of a live account is reserved so that account can take it back; the id of a
/// deleted account can never be reclaimed, only taken by anyone once the hold ends.
pub async fn reserved_id_message(
    conn: &mut PgConnection,
    full_id: &str,
    holder: &str,
    until: OffsetDateTime,
) -> ApiResult<String> {
    let until = crate::timefmt::format_rfc3339_ms(until);
    let deleted: bool = sqlx::query_scalar(
        "select coalesce((select status = 'deleted' from accounts where uuid = $1), false)",
    )
    .bind(holder)
    .fetch_one(&mut *conn)
    .await?;
    Ok(if deleted {
        format!(
            "{full_id} belonged to an account that was deleted; it is held until {until} and can be taken after that."
        )
    } else {
        format!(
            "{full_id} was released recently and is reserved for its previous owner until {until}."
        )
    })
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
        Some((holder, until)) => Err(ApiError::conflict(
            "id_reserved",
            reserved_id_message(conn, &full, &holder, until).await?,
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
