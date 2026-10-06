//! Checking 6-digit codes with the lockout counted per email address or phone number.
//!
//! `repo::otp::verify` counts wrong codes per challenge, and every sign-in flow (and every CLI
//! code sign-in) has its own challenge. Counted only that way, opening more flows to the same
//! address would buy more guesses. UNDERSTANDING.md: "after 10 failed tries there's a cooldown
//! of 1 minute before trying again", so this module counts per destination:
//!
//! - while any code to the address is locked, no code to it is checked (423);
//! - wrong codes of every live challenge to the address add up; the 10th in a row locks every
//!   one of them for the cooldown (`ACCOUNTS_OTP_LOCK_SECONDS`, 60 s) and the streak starts
//!   again afterwards; a right code ends the streak;
//! - `details.remaining_attempts` counts down for the address, not for the challenge.
//!
//! The check runs in one transaction that row-locks every live code of the address (in id
//! order), so parallel guesses at the same address are counted one after another and a burst
//! can't slip past the lock. It answers exactly like `repo::otp::verify` (same codes, shapes
//! and headers). When a lock starts on a sign-in code for an address that belongs to an
//! account, the account's sign-in history records the failed attempt (UNDERSTANDING.md
//! "History").

use accounts_core::crypto::constant_time_eq;
use accounts_core::models::{ActorKind, OtpChannel, OtpPurpose};
use accounts_core::repo::audit::{self, AuditEntry, SigninRecord};
use accounts_core::repo::contacts::ContactKind;
use accounts_core::repo::otp::{self, MAX_FAILED_STREAK, OtpChallenge};
use accounts_core::timefmt::format_rfc3339_ms;
use accounts_core::{ApiError, ApiResult, AppState};
use serde_json::json;
use sqlx::PgConnection;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::contact::{self, Holder};

/// Columns of [`OtpChallenge`], in its field order.
macro_rules! challenge_columns {
    () => {
        "id, purpose, channel, destination, code_hash, account_uuid, flow_id, failed_streak, total_failures, \
         locked_until, created_at, expires_at, consumed_at"
    };
}

/// Who is trying to sign in with the code (for the sign-in history of the address's owner).
#[derive(Debug, Clone, Copy)]
pub struct Attempt<'a> {
    /// The app being signed into (`accounts` for the CLI).
    pub app_id: &'a str,
    pub ip: Option<&'a str>,
    pub user_agent: Option<&'a str>,
}

/// Verifies a code: the same answers as `repo::otp::verify`, with the lockout counted per
/// destination. Returns the consumed challenge. `attempt` is given for sign-in codes.
///
/// Errors: 422 `invalid_code` (not 6 digits: not counted; wrong: `details.remaining_attempts`,
/// and on the 10th `locked_until` + `Retry-After`), 423 `verification_locked`, 410
/// `code_expired`, 409 `code_already_used`, 404 `challenge_not_found` (unknown, or bound to
/// another flow/account/purpose).
pub async fn verify(
    state: &AppState,
    challenge_id: Uuid,
    code: &str,
    expect: &otp::Expect<'_>,
    attempt: Option<Attempt<'_>>,
) -> ApiResult<OtpChallenge> {
    let code = code.trim();
    if code.len() != 6 || !code.chars().all(|c| c.is_ascii_digit()) {
        return Err(ApiError::unprocessable(
            "invalid_code",
            format!(
                "The code must be exactly 6 digits; got '{}'.",
                code.chars().take(12).collect::<String>()
            ),
        )
        .hint("Type the 6-digit code from the message."));
    }
    let mut tx = state.db.begin().await?;
    let destination: Option<String> =
        sqlx::query_scalar("select destination from otp_challenges where id = $1")
            .bind(challenge_id)
            .fetch_optional(&mut *tx)
            .await?;
    let Some(destination) = destination else {
        return Err(not_found(challenge_id));
    };
    // This challenge and every code to the address that counts (live, or still locked),
    // locked in one order so concurrent checks of the address run one after another.
    let rows: Vec<OtpChallenge> = sqlx::query_as(concat!(
        "select ",
        challenge_columns!(),
        " from otp_challenges where destination = $1 \
           and (id = $2 or (consumed_at is null and expires_at > now()) or locked_until > now()) \
         order by id for update"
    ))
    .bind(&destination)
    .bind(challenge_id)
    .fetch_all(&mut *tx)
    .await?;
    let Some(c) = rows.iter().find(|r| r.id == challenge_id).cloned() else {
        return Err(not_found(challenge_id));
    };
    if !is_bound(&c, expect) {
        return Err(not_found(challenge_id));
    }
    if c.consumed_at.is_some() {
        return Err(ApiError::conflict(
            "code_already_used",
            "This code was already used successfully.",
        )
        .hint("Request a new code if you need to verify again."));
    }
    let now = OffsetDateTime::now_utc();
    if let Some(until) = rows
        .iter()
        .filter_map(|r| r.locked_until)
        .filter(|l| *l > now)
        .max()
    {
        return Err(locked(&c, until));
    }
    if c.expires_at <= now {
        return Err(ApiError::gone(
            "code_expired",
            format!(
                "This code expired at {} (codes last {} minutes), or a newer code replaced it.",
                format_rfc3339_ms(c.expires_at),
                state.settings.otp_ttl_seconds / 60
            ),
        )
        .hint("Use the most recent code, or request a new one."));
    }

    if constant_time_eq(&state.keys.pepper.hash(code), &c.code_hash) {
        let done: OtpChallenge = sqlx::query_as(concat!(
            "update otp_challenges set consumed_at = now(), failed_streak = 0, locked_until = null \
             where id = $1 returning ",
            challenge_columns!()
        ))
        .bind(c.id)
        .fetch_one(&mut *tx)
        .await?;
        // A right code ends the streak for the whole address.
        sqlx::query(
            "update otp_challenges set failed_streak = 0 where destination = $1 and id <> $2 \
             and consumed_at is null and expires_at > now() and failed_streak > 0",
        )
        .bind(&destination)
        .bind(c.id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        return Ok(done);
    }

    // A wrong code: one more for the address's streak.
    sqlx::query(
        "update otp_challenges set failed_streak = failed_streak + 1, total_failures = total_failures + 1 \
         where id = $1",
    )
    .bind(c.id)
    .execute(&mut *tx)
    .await?;
    let streak: i64 = sqlx::query_scalar(
        "select coalesce(sum(failed_streak), 0)::bigint from otp_challenges \
         where destination = $1 and consumed_at is null and expires_at > now()",
    )
    .bind(&destination)
    .fetch_one(&mut *tx)
    .await?;
    let lock_seconds = state.settings.otp_lock_seconds;
    let max = i64::from(MAX_FAILED_STREAK);
    let until = if streak >= max {
        // The 10th in a row: every live code to the address waits out the cooldown, and the
        // streak starts again after it.
        let locked: Vec<Option<OffsetDateTime>> = sqlx::query_scalar(
            "update otp_challenges set locked_until = now() + make_interval(secs => $2), failed_streak = 0 \
             where destination = $1 and consumed_at is null and expires_at > now() returning locked_until",
        )
        .bind(&destination)
        .bind(lock_seconds as f64)
        .fetch_all(&mut *tx)
        .await?;
        let until = locked.into_iter().flatten().max();
        if let Some(attempt) = attempt
            && matches!(c.purpose, OtpPurpose::Signin | OtpPurpose::CliLogin)
        {
            record_lock(&mut tx, &c, attempt, until).await?;
        }
        until
    } else {
        None
    };
    tx.commit().await?;

    Err(match until {
        Some(until) => {
            let secs = seconds_until(until);
            ApiError::unprocessable(
                "invalid_code",
                format!(
                    "That code is wrong. It was the {MAX_FAILED_STREAK}th wrong code in a row for {}, so verification is locked for {lock_seconds} seconds.",
                    c.masked_destination()
                ),
            )
            .detail("remaining_attempts", 0)
            .detail("locked_until", format_rfc3339_ms(until))
            .retry_after(secs)
            .hint(format!("Wait {secs} seconds, then try again."))
        }
        None => {
            let remaining = (max - streak).max(1);
            ApiError::unprocessable(
                "invalid_code",
                format!(
                    "That code is wrong; {remaining} more tries for {} before a {lock_seconds} second cooldown.",
                    c.masked_destination()
                ),
            )
            .detail("remaining_attempts", remaining)
            .hint("Check the latest code you received and type it again.")
        }
    })
}

/// The binding test of `repo::otp::verify` (a mismatch looks like "not found").
fn is_bound(c: &OtpChallenge, expect: &otp::Expect<'_>) -> bool {
    expect.purpose.is_none_or(|p| p == c.purpose)
        && expect
            .flow_id
            .is_none_or(|f| c.flow_id.as_deref() == Some(f))
        && expect
            .account_uuid
            .is_none_or(|a| c.account_uuid.as_deref() == Some(a))
}

/// 404 `challenge_not_found`.
fn not_found(challenge_id: Uuid) -> ApiError {
    ApiError::not_found(
        "challenge_not_found",
        format!("No verification code '{challenge_id}' is waiting here."),
    )
    .hint("Request a new code.")
}

/// Whole seconds until `until` (rounded up, at least 1): a fresh 60 s lock says 60.
fn seconds_until(until: OffsetDateTime) -> u64 {
    ((until - OffsetDateTime::now_utc()).as_seconds_f64().ceil() as u64).max(1)
}

/// 423 `verification_locked` for the address.
fn locked(c: &OtpChallenge, until: OffsetDateTime) -> ApiError {
    let secs = seconds_until(until);
    ApiError::locked(
        "verification_locked",
        format!(
            "Too many wrong codes in a row for {}: verification is locked for {secs} more seconds (until {}).",
            c.masked_destination(),
            format_rfc3339_ms(until)
        ),
        secs,
    )
    .hint(format!(
        "Wait {secs} seconds, then type the code again. Every code sent to this address waits out the same cooldown."
    ))
    .detail("locked_until", format_rfc3339_ms(until))
}

/// A lock started on a sign-in code: the owner of the address (if any) sees a failed sign-in
/// in its history, and the audit log keeps the lock.
async fn record_lock(
    conn: &mut PgConnection,
    c: &OtpChallenge,
    attempt: Attempt<'_>,
    until: Option<OffsetDateTime>,
) -> ApiResult<()> {
    let (kind, method) = match c.channel {
        OtpChannel::Email => (ContactKind::Email, audit::method::EMAIL),
        OtpChannel::Phone => (ContactKind::Phone, audit::method::PHONE),
    };
    let Holder::Active(owner) = contact::lookup(conn, kind, &c.destination).await? else {
        return Ok(());
    };
    audit::signin(
        conn,
        &SigninRecord {
            account_uuid: Some(&owner.uuid),
            app_id: Some(attempt.app_id),
            method,
            outcome: audit::outcome::FAILED,
            ip: attempt.ip,
            user_agent: attempt.user_agent,
        },
    )
    .await?;
    audit::record(
        conn,
        &AuditEntry {
            account_uuid: Some(&owner.uuid),
            app_id: Some(attempt.app_id),
            target_kind: Some(kind.code()),
            details: json!({
                "destination": c.masked_destination(),
                "purpose": c.purpose.as_str(),
                "wrong_codes": MAX_FAILED_STREAK,
                "locked_until": until.map(format_rfc3339_ms),
            }),
            ip: attempt.ip,
            ..AuditEntry::new(ActorKind::System, None, "signin.locked")
        },
    )
    .await
}
