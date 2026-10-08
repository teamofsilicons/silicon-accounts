//! One-time codes (6 digits, 10 minutes) for email and phone verification.
//!
//! Contract (UNDERSTANDING.md): sending is limited to 10 codes per destination per rolling 10
//! minutes (plus 30 per IP per 10 minutes), then 429 until the window passes. Verifying: after 10
//! failed tries there is a 60 s cooldown (423), then 10 more tries.
//!
//! Both limits count **per destination** (the email address or phone number), whichever flow,
//! account or purpose a code was sent for:
//! - [`send`] serializes the sends to one destination (an advisory lock held until the caller's
//!   transaction ends), so a burst of parallel requests can't all pass the count;
//! - [`verify`] row-locks every live code of the destination in one order, so parallel guesses
//!   are counted one after another; wrong codes of every live code to the address add up to one
//!   streak, and the 10th in a row locks all of them. Opening more sign-in flows (or adding the
//!   address to an account) therefore never buys more guesses.
//!
//! Exact behaviour of [`verify`]:
//! - wrong code, tries 1–9 of the address's streak → 422 `invalid_code`,
//!   `details.remaining_attempts` 9..1;
//! - the 10th wrong code in a row → 422 `invalid_code` with `remaining_attempts: 0`,
//!   `details.locked_until` and `Retry-After` (the cooldown starts now, for every live code to the
//!   address);
//! - any attempt during the cooldown (even the right code) → 423 `verification_locked`;
//! - after the cooldown the streak starts again from 0; a right code ends the streak.
//!
//! A resend creates a new challenge and retires the previous one for the same destination,
//! purpose and flow/account (its code stops working); the failure streak and any running
//! cooldown carry over, so resending never bypasses the lock. Times are compared with the
//! database clock.

use serde_json::json;
use sqlx::{Connection, PgConnection, PgPool};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::config::Settings;
use crate::crypto::{Pepper, constant_time_eq, generate_otp};
use crate::error::{ApiError, ApiResult};
use crate::models::{ActorKind, OtpChannel, OtpPurpose};
use crate::repo::audit::{self, AuditEntry, SigninRecord};
use crate::repo::contacts::{self, ContactKind, Holder};
use crate::repo::rate_limit;
use crate::timefmt::format_rfc3339_ms;

/// Codes per destination per window.
pub const MAX_SENDS_PER_DESTINATION: i64 = 10;
/// The send window.
pub const SEND_WINDOW_SECONDS: i64 = 600;
/// Consecutive wrong codes (per destination) before the cooldown.
pub const MAX_FAILED_STREAK: i32 = 10;
/// Suggested wait before offering "resend" in UIs (not enforced).
pub const RESEND_HINT_SECONDS: i64 = 30;

macro_rules! challenge_columns {
    () => {
        "id, purpose, channel, destination, code_hash, account_uuid, flow_id, failed_streak, total_failures, \
         locked_until, created_at, expires_at, consumed_at"
    };
}

/// A stored challenge (the code itself is never stored).
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct OtpChallenge {
    pub id: Uuid,
    pub purpose: OtpPurpose,
    pub channel: OtpChannel,
    /// Normalized email or E.164 phone.
    pub destination: String,
    pub code_hash: Vec<u8>,
    pub account_uuid: Option<String>,
    pub flow_id: Option<String>,
    pub failed_streak: i32,
    pub total_failures: i32,
    pub locked_until: Option<OffsetDateTime>,
    pub created_at: OffsetDateTime,
    pub expires_at: OffsetDateTime,
    pub consumed_at: Option<OffsetDateTime>,
}

impl OtpChallenge {
    /// The destination masked for display (`s***@gmail.com`, `+91******3210`).
    pub fn masked_destination(&self) -> String {
        match self.channel {
            OtpChannel::Email => crate::normalize::mask_email(&self.destination),
            OtpChannel::Phone => crate::normalize::mask_phone(&self.destination),
        }
    }

    /// When a UI should offer "resend".
    pub fn resend_available_at(&self) -> OffsetDateTime {
        self.created_at + time::Duration::seconds(RESEND_HINT_SECONDS)
    }
}

/// Input for [`send`].
#[derive(Debug, Clone)]
pub struct NewChallenge<'a> {
    pub purpose: OtpPurpose,
    pub channel: OtpChannel,
    /// Normalized email or E.164 phone.
    pub destination: &'a str,
    /// The account the code is for, when known (adding an email, requirements, CLI login).
    pub account_uuid: Option<&'a str>,
    /// The hosted sign-in flow, when sent from one.
    pub flow_id: Option<&'a str>,
    /// Client IP for the per-IP limit.
    pub ip: Option<&'a str>,
}

/// A new challenge and its plaintext code (deliver it, never log it). `Debug` hides the code.
#[derive(Clone)]
pub struct CreatedChallenge {
    pub challenge: OtpChallenge,
    pub code: String,
}

impl std::fmt::Debug for CreatedChallenge {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CreatedChallenge")
            .field("challenge", &self.challenge)
            .field("code", &"[redacted]")
            .finish()
    }
}

/// Creates a challenge after enforcing the send limits (429 `rate_limited` with `Retry-After`).
/// Deliver `code` with `delivery::enqueue_otp` in the same transaction.
///
/// Sends to one destination are serialized: the advisory lock taken here is held until the
/// caller's transaction ends, so concurrent sends are counted one after another and the
/// per-destination limit holds exactly. Call it inside a transaction (with a plain connection
/// the lock lasts only for this function, which still serializes the count and the insert).
pub async fn send(
    conn: &mut PgConnection,
    pepper: &Pepper,
    settings: &Settings,
    new: &NewChallenge<'_>,
) -> ApiResult<CreatedChallenge> {
    let mut tx = conn.begin().await?;
    sqlx::query("select pg_advisory_xact_lock(hashtextextended('otp_send:' || $1, 0))")
        .bind(new.destination)
        .execute(&mut *tx)
        .await?;
    let (recent, retry_after): (i64, Option<f64>) = sqlx::query_as(
        "select count(*), \
                extract(epoch from (min(created_at) + make_interval(secs => $2) - now()))::float8 \
           from (select created_at from otp_challenges \
                  where destination = $1 and created_at > now() - make_interval(secs => $2) \
                  order by created_at desc limit $3) r",
    )
    .bind(new.destination)
    .bind(SEND_WINDOW_SECONDS as f64)
    .bind(MAX_SENDS_PER_DESTINATION)
    .fetch_one(&mut *tx)
    .await?;
    if recent >= MAX_SENDS_PER_DESTINATION {
        let retry = retry_after
            .map(|s| s.ceil().max(1.0) as u64)
            .unwrap_or(SEND_WINDOW_SECONDS as u64);
        let masked = match new.channel {
            OtpChannel::Email => crate::normalize::mask_email(new.destination),
            OtpChannel::Phone => crate::normalize::mask_phone(new.destination),
        };
        return Err(ApiError::rate_limited(
            format!(
                "Too many codes were sent to {masked}: the limit is {MAX_SENDS_PER_DESTINATION} per {} minutes.",
                SEND_WINDOW_SECONDS / 60
            ),
            retry,
        )
        .hint(format!("Wait {retry} seconds, then request a new code. The last code sent still works until it expires.")));
    }
    if let Some(ip) = new.ip {
        rate_limit::enforce(
            &mut tx,
            &rate_limit::bucket("otp_send:ip", ip),
            rate_limit::limits::OTP_SEND_PER_IP,
            "verification codes requested from this network",
        )
        .await?;
    }

    // Retire the previous live challenge for the same target, carrying the failure state.
    let previous: Option<(i32, i32, Option<OffsetDateTime>)> = sqlx::query_as::<_, (i32, i32, Option<OffsetDateTime>)>(
        "with prev as ( \
           select id from otp_challenges where destination = $1 and purpose = $2 \
             and coalesce(flow_id, '') = coalesce($3, '') and coalesce(account_uuid, '') = coalesce($4, '') \
             and consumed_at is null and expires_at > now() \
           for update) \
         update otp_challenges c set expires_at = now() from prev where c.id = prev.id \
         returning c.failed_streak, c.total_failures, case when c.locked_until > now() then c.locked_until end",
    )
    .bind(new.destination)
    .bind(new.purpose)
    .bind(new.flow_id)
    .bind(new.account_uuid)
    .fetch_all(&mut *tx)
    .await?
    .into_iter()
    .reduce(|a, b| (a.0.max(b.0), a.1.max(b.1), a.2.max(b.2)));
    let (streak, total, locked_until) = previous.unwrap_or((0, 0, None));

    let code = generate_otp();
    let challenge = sqlx::query_as::<_, OtpChallenge>(concat!(
        "insert into otp_challenges (id, purpose, channel, destination, code_hash, account_uuid, flow_id, \
           failed_streak, total_failures, locked_until, expires_at) \
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now() + make_interval(secs => $11)) returning ",
        challenge_columns!()
    ))
    .bind(Uuid::now_v7())
    .bind(new.purpose)
    .bind(new.channel)
    .bind(new.destination)
    .bind(pepper.hash(&code))
    .bind(new.account_uuid)
    .bind(new.flow_id)
    .bind(streak)
    .bind(total)
    .bind(locked_until)
    .bind(settings.otp_ttl_seconds as f64)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(CreatedChallenge { challenge, code })
}

/// Fetches a challenge.
pub async fn get(conn: &mut PgConnection, id: Uuid) -> ApiResult<Option<OtpChallenge>> {
    Ok(sqlx::query_as::<_, OtpChallenge>(concat!(
        "select ",
        challenge_columns!(),
        " from otp_challenges where id = $1"
    ))
    .bind(id)
    .fetch_optional(&mut *conn)
    .await?)
}

/// What the caller expects the challenge to be bound to. A mismatch looks like "not found".
#[derive(Debug, Clone, Default)]
pub struct Expect<'a> {
    pub purpose: Option<OtpPurpose>,
    pub flow_id: Option<&'a str>,
    pub account_uuid: Option<&'a str>,
}

/// Who is trying to sign in with a code, for the sign-in history of the address's owner. Pass it
/// for sign-in codes (`signin`, `cli_login`): when such a code starts a lock and the address
/// belongs to an active Carbon, its sign-in history gets a `failed` row and the audit log
/// `signin.locked` (UNDERSTANDING.md "History").
#[derive(Debug, Clone, Copy)]
pub struct Attempt<'a> {
    /// The app being signed into (`silicon-accounts` for the CLI).
    pub app_id: &'a str,
    pub ip: Option<&'a str>,
    pub user_agent: Option<&'a str>,
}

/// Checks a code (see the module docs for the exact responses). Returns the consumed challenge.
/// Takes the pool so failure counts persist although the request fails.
///
/// Errors: 422 `invalid_code` (not 6 digits: not counted; wrong: `details.remaining_attempts`,
/// and on the 10th `locked_until` + `Retry-After`), 423 `verification_locked`, 410
/// `code_expired`, 409 `code_already_used`, 404 `challenge_not_found` (unknown, or bound to
/// another flow/account/purpose).
pub async fn verify(
    pool: &PgPool,
    pepper: &Pepper,
    settings: &Settings,
    challenge_id: Uuid,
    code: &str,
    expect: &Expect<'_>,
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
    let mut tx = pool.begin().await?;
    let (destination, now): (Option<String>, OffsetDateTime) =
        sqlx::query_as("select (select destination from otp_challenges where id = $1), now()")
            .bind(challenge_id)
            .fetch_one(&mut *tx)
            .await?;
    let Some(destination) = destination else {
        return Err(not_found(challenge_id));
    };
    // This challenge and every code to the address that counts (live, or still locked), locked
    // in one order so concurrent checks of the address run one after another.
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
    if let Some(until) = rows
        .iter()
        .filter_map(|r| r.locked_until)
        .filter(|l| *l > now)
        .max()
    {
        return Err(locked(&c, until, now));
    }
    if c.expires_at <= now {
        return Err(ApiError::gone(
            "code_expired",
            format!(
                "This code expired at {} (codes last {} minutes), or a newer code replaced it.",
                format_rfc3339_ms(c.expires_at),
                settings.otp_ttl_seconds / 60
            ),
        )
        .hint("Use the most recent code, or request a new one."));
    }

    if constant_time_eq(&pepper.hash(code), &c.code_hash) {
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
    let lock_seconds = settings.otp_lock_seconds;
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
            let secs = seconds_until(until, now);
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
                    "That code is wrong; {remaining} more {} for {} before a {lock_seconds} second cooldown.",
                    if remaining == 1 { "try" } else { "tries" },
                    c.masked_destination()
                ),
            )
            .detail("remaining_attempts", remaining)
            .hint("Check the latest code you received and type it again.")
        }
    })
}

/// The binding test (a mismatch looks like "not found").
fn is_bound(c: &OtpChallenge, expect: &Expect<'_>) -> bool {
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

/// Whole seconds from `now` until `until` (rounded up, at least 1): a fresh 60 s lock says 60.
fn seconds_until(until: OffsetDateTime, now: OffsetDateTime) -> u64 {
    ((until - now).as_seconds_f64().ceil() as u64).max(1)
}

/// 423 `verification_locked` for the address.
fn locked(c: &OtpChallenge, until: OffsetDateTime, now: OffsetDateTime) -> ApiError {
    let secs = seconds_until(until, now);
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
    let Holder::Active(owner) = contacts::lookup(conn, kind, &c.destination).await? else {
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

/// Deletes challenges that expired over a day ago (sweep).
pub async fn purge(conn: &mut PgConnection) -> ApiResult<u64> {
    Ok(
        sqlx::query("delete from otp_challenges where expires_at < now() - interval '1 day'")
            .execute(&mut *conn)
            .await?
            .rows_affected(),
    )
}
