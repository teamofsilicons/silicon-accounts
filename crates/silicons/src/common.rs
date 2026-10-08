//! Helpers shared by the handlers: id pre-checks, finding "my" Silicon, webhook storage, the
//! peek-only rate-limit check, and the row locks that keep custody consistent with account
//! deletion and STK rotation.
//!
//! # Locks on account rows
//!
//! The changes that end an account's ability to act update-lock its `silicon-accounts` row before they
//! look at anything else: `DELETE /v1/me` (the account crate) locks the Carbon before it checks
//! custody and deletes, and an STK rotation locks the Silicon before it revokes its sessions.
//! Everything here that relies on an account staying usable until it commits share-locks the
//! same row inside its transaction and re-checks under that lock ([`lock_own_account`],
//! [`lock_named_carbon`], [`lock_live_session`]). The two then serialize: either the deletion or
//! rotation commits first and the re-check refuses, or it waits and then sees (and refuses
//! because of, or revokes) what this transaction committed. Share locks don't conflict with each
//! other, so concurrent requests of one account never wait on one another.

use accounts_core::error::{ApiError, ApiResult};
use accounts_core::events;
use accounts_core::http::{AccountAuth, AuthVia};
use accounts_core::ids::AccountId;
use accounts_core::models::{Account, AccountKind, AccountStatus};
use accounts_core::repo::{accounts, rate_limit};
use accounts_core::state::AppState;
use accounts_core::timefmt::format_rfc3339_ms;
use sqlx::PgConnection;
use time::OffsetDateTime;
use uuid::Uuid;

/// Fails with the same precise errors as an id claim (409 `id_taken` with suggestions, 409
/// `id_reserved` with `reserved_until`) when `id` can't be taken. Run before the (slow) STK
/// hashing; the creation itself re-checks under a lock.
pub async fn ensure_id_free(conn: &mut PgConnection, id: &AccountId) -> ApiResult<()> {
    if accounts::is_id_free(conn, id, None).await? {
        return Ok(());
    }
    let full = id.to_string();
    if let Some((_, until)) = accounts::active_reservation(conn, &full).await? {
        let taken_now: bool =
            sqlx::query_scalar("select exists (select 1 from accounts where handle = $1)")
                .bind(&full)
                .fetch_one(&mut *conn)
                .await?;
        if !taken_now {
            let until = format_rfc3339_ms(until);
            return Err(ApiError::conflict(
                "id_reserved",
                format!(
                    "{full} was released recently and is reserved for its previous owner until {until}."
                ),
            )
            .hint("Pick another id, or wait until the reservation ends.")
            .detail("reserved_until", until));
        }
    }
    let suggestions: Vec<String> = accounts::suggest_ids(conn, id.kind(), &[id.handle()], 3)
        .await?
        .iter()
        .map(ToString::to_string)
        .collect();
    let hint = if suggestions.is_empty() {
        "Pick another id; check one with GET /v1/ids/available?id=si:<handle>.".to_string()
    } else {
        format!("Pick another id, for example {}.", suggestions.join(", "))
    };
    Err(
        ApiError::conflict("id_taken", format!("{full} is taken by another account."))
            .hint(hint)
            .detail("suggestions", suggestions),
    )
}

/// 404 `silicon_not_found` for a Silicon the caller is not custodian of (whether or not it
/// exists: other Carbons' Silicons are not revealed).
pub fn silicon_not_found(key: &str) -> ApiError {
    ApiError::not_found(
        "silicon_not_found",
        format!("You are not the custodian of a Silicon '{key}'."),
    )
    .hint(
        "List the Silicons you are custodian of with GET /v1/me/silicons (`silicon-accounts silicon list`). Only a \
         Silicon's custodian can manage it, and a self-created Silicon becomes yours only after you accept its \
         request (GET /v1/me/custodian-requests).",
    )
    .detail("silicon", key)
}

/// Finds a Silicon by uuid or current si:id and checks that `custodian_uuid` is its custodian.
pub async fn my_silicon(
    conn: &mut PgConnection,
    custodian_uuid: &str,
    key: &str,
) -> ApiResult<Account> {
    let key = key.trim();
    let found = if key.contains(':') {
        accounts::by_handle(conn, key).await?
    } else {
        accounts::get(conn, key).await?
    };
    match found {
        Some(a)
            if a.kind == AccountKind::Silicon
                && a.status != AccountStatus::Deleted
                && a.custodian_uuid.as_deref() == Some(custodian_uuid) =>
        {
            Ok(a)
        }
        _ => Err(silicon_not_found(key)),
    }
}

/// [`my_silicon`], then row-locks it (inside a transaction) and checks custody again under the
/// lock.
pub async fn lock_my_silicon(
    conn: &mut PgConnection,
    custodian_uuid: &str,
    key: &str,
) -> ApiResult<Account> {
    let found = my_silicon(conn, custodian_uuid, key).await?;
    match accounts::lock(conn, &found.uuid).await? {
        Some(a)
            if a.status != AccountStatus::Deleted
                && a.custodian_uuid.as_deref() == Some(custodian_uuid) =>
        {
            Ok(a)
        }
        _ => Err(silicon_not_found(key.trim())),
    }
}

/// Parses a custodian request id from a path; anything that isn't a UUID is simply not found.
pub fn parse_request_id(raw: &str) -> Option<Uuid> {
    Uuid::parse_str(raw.trim()).ok()
}

/// 404 `custodian_request_not_found`.
pub fn request_not_found(raw: &str) -> ApiError {
    ApiError::not_found(
        "custodian_request_not_found",
        format!("No pending custodian request '{}' is addressed to you.", raw.trim()),
    )
    .hint("List the requests waiting for you with GET /v1/me/custodian-requests (`silicon-accounts custodian requests`). Requests named by email show up once that email is verified on your account.")
    .detail("request_id", raw.trim())
}

/// Stores a new webhook URL with a fresh signing secret; returns the secret (show it once).
pub async fn set_silicon_webhook(
    conn: &mut PgConnection,
    state: &AppState,
    silicon_uuid: &str,
    url: &str,
) -> ApiResult<String> {
    let (secret, enc) = events::new_webhook_secret(&state.keys.keyring)?;
    accounts::set_silicon_webhook(conn, silicon_uuid, Some(url), Some(&enc)).await?;
    Ok(secret)
}

/// 429 when `bucket` has already used up its current window, without counting this request
/// (core's `rate_limit::peek`; requests are counted with `rate_limit::enforce` only once they
/// succeed). This keeps a flood of over-limit requests from costing any real work.
pub async fn ensure_rate_room(
    conn: &mut PgConnection,
    bucket: &str,
    limit: rate_limit::Limit,
    what: &str,
) -> ApiResult<()> {
    match rate_limit::peek(conn, bucket, limit).await? {
        rate_limit::Decision::Limited {
            retry_after_seconds,
        } => Err(ApiError::rate_limited(
            format!(
                "Too many {what}: the limit is {} per {}.",
                limit.max,
                rate_limit::describe_window(limit.window_seconds)
            ),
            retry_after_seconds,
        )),
        rate_limit::Decision::Allowed { .. } => Ok(()),
    }
}

/// Share-locks an account row for the rest of the transaction (see the module docs).
async fn lock_shared(conn: &mut PgConnection, uuid: &str) -> ApiResult<Option<Account>> {
    Ok(sqlx::query_as::<_, Account>(concat!(
        "select ",
        accounts_core::account_columns!(),
        " from accounts where uuid = $1 for share"
    ))
    .bind(uuid)
    .fetch_optional(&mut *conn)
    .await?)
}

/// The signed-in account (`me`, as authenticated) can no longer act: deleted (401
/// `account_deleted`, like the session extractors say) or otherwise not active (403
/// `account_not_active`).
fn own_account_inactive(me: &Account, now: Option<&Account>, doing: &str) -> ApiError {
    match now.map(|a| a.status) {
        Some(status) if status != AccountStatus::Deleted && status != AccountStatus::Active => {
            ApiError::forbidden(
                "account_not_active",
                format!(
                    "Your account {} is {status}, so it can't {doing}.",
                    me.display_id()
                ),
            )
        }
        _ => ApiError::unauthenticated(
            "account_deleted",
            format!(
                "Your account {} was deleted while this request was being handled, so it can't {doing}; nothing was changed.",
                me.display_id()
            ),
        )
        .hint("A deleted account can't sign in or act any more; sign in with another account."),
    }
}

/// Share-locks the signed-in Carbon's own account row and checks, under the lock, that it is
/// still active; returns its current row. Use it before making the Carbon a custodian (creating
/// a Silicon, accepting a request): `DELETE /v1/me` update-locks the same row before it checks
/// custody, so either the deletion commits first and this refuses (401 `account_deleted`), or it
/// waits and then finds the Silicon in this Carbon's custody (409 `custodian_of_silicons`).
/// Without the lock both could succeed, leaving a Silicon whose custodian is a deleted account.
pub async fn lock_own_account(
    conn: &mut PgConnection,
    me: &Account,
    doing: &str,
) -> ApiResult<Account> {
    match lock_shared(conn, &me.uuid).await? {
        Some(now) if now.status == AccountStatus::Active => Ok(now),
        now => Err(own_account_inactive(me, now.as_ref(), doing)),
    }
}

/// 404 `custodian_not_found`: no active Carbon has the id `full`.
pub fn custodian_not_found(full: &str, what_for: &str) -> ApiError {
    ApiError::not_found(
        "custodian_not_found",
        format!("No active Carbon has the id {full}, so it can't {what_for}."),
    )
    .hint("Check the id (ids are case-insensitive; old ids stop resolving after a change), or name the Carbon by email instead: an invitation goes out even when they have no account yet.")
    .detail("custodian", full)
}

/// Share-locks a Carbon named by c:id (the custodian a self-created Silicon asks for, or the
/// receiver of a transfer) and checks, under the lock, that it is still an active Carbon. A
/// request addressed to its uuid then either commits before the Carbon's deletion (which then
/// cancels it, and releases a self-created Silicon waiting on it) or the deletion commits first
/// and this refuses with the same 404 `custodian_not_found` as naming an unknown id. Without the
/// lock a request could stay pending for 14 days, addressed to an account that can never answer.
pub async fn lock_named_carbon(
    conn: &mut PgConnection,
    carbon_uuid: &str,
    full_id: &str,
    what_for: &str,
) -> ApiResult<Account> {
    match lock_shared(conn, carbon_uuid).await? {
        Some(a) if a.kind == AccountKind::Carbon && a.is_active() => Ok(a),
        _ => Err(custodian_not_found(full_id, what_for)),
    }
}

/// Share-locks the signed-in account's row and checks, under the lock, that the account is still
/// active and that the session or token family that authenticated this request is still live;
/// returns the account's current row.
///
/// Anything that hands out a credential derived from the session (a short-lived token) must do
/// this in the transaction that stores it. An STK rotation update-locks the Silicon's row before
/// it revokes every session and stamps `stk_rotated_at`, so a credential stored under this lock
/// either commits before the rotation takes effect (and is older than the new `stk_rotated_at`,
/// which the token endpoint checks) or is refused here because its session was just revoked.
pub async fn lock_live_session(
    conn: &mut PgConnection,
    auth: &AccountAuth,
    doing: &str,
) -> ApiResult<Account> {
    let me = &auth.account;
    let now = lock_shared(conn, &me.uuid).await?;
    let account = match now {
        Some(a) if a.status == AccountStatus::Active => a,
        now => return Err(own_account_inactive(me, now.as_ref(), doing)),
    };
    match &auth.via {
        AuthVia::Bearer { family_id, .. } => {
            let family: Option<(Option<OffsetDateTime>, Option<String>, bool)> = sqlx::query_as(
                "select revoked_at, revoke_reason, expires_at <= now() from token_families where id = $1",
            )
            .bind(family_id)
            .fetch_optional(&mut *conn)
            .await?;
            match family {
                Some((None, _, false)) => {}
                Some((Some(at), reason, _)) => {
                    return Err(ApiError::unauthenticated(
                        "token_revoked",
                        format!(
                            "The sign-in behind this access token was revoked at {} ({}) while this request was being handled; nothing was issued.",
                            format_rfc3339_ms(at),
                            reason.as_deref().unwrap_or("revoked")
                        ),
                    )
                    .hint("Sign in again."));
                }
                _ => {
                    return Err(ApiError::unauthenticated(
                        "token_revoked",
                        "The sign-in behind this access token expired or no longer exists; nothing was issued.",
                    )
                    .hint("Sign in again."));
                }
            }
        }
        AuthVia::Session { session_id } => {
            let live: Option<bool> = sqlx::query_scalar(
                "select revoked_at is null and expires_at > now() from browser_sessions where id = $1",
            )
            .bind(session_id)
            .fetch_optional(&mut *conn)
            .await?;
            if live != Some(true) {
                return Err(ApiError::unauthenticated(
                    "session_expired",
                    "Your session ended (you signed out, it was revoked, or it expired) while this request was being handled; nothing was issued.",
                )
                .hint("Sign in again on the account site."));
            }
        }
    }
    Ok(account)
}
