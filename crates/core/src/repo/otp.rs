//! One-time codes (6 digits, 10 minutes) for email and phone verification.
//!
//! Contract (UNDERSTANDING.md): sending is limited to 10 codes per destination per rolling 10
//! minutes (plus 30 per IP per 10 minutes), then 429 until the window passes. Verifying: after 10
//! consecutive wrong codes there is a 60 s cooldown (423), then 10 more tries.
//!
//! Exact behaviour of [`verify`]:
//! - wrong code, tries 1–9 of a streak → 422 `invalid_code`, `details.remaining_attempts` 9..1;
//! - the 10th wrong code in a row → 422 `invalid_code` with `remaining_attempts: 0`,
//!   `details.locked_until` and `details.retry_after_seconds` (the cooldown starts now);
//! - any attempt during the cooldown (even the right code) → 423 `verification_locked`;
//! - after the cooldown the streak starts again from 0.
//!
//! A resend creates a new challenge and retires the previous one for the same destination,
//! purpose and flow/account (its code stops working); the failure streak and any running
//! cooldown carry over, so resending never bypasses the lock.

use sqlx::{PgConnection, PgPool};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::config::Settings;
use crate::crypto::{Pepper, constant_time_eq, generate_otp};
use crate::error::{ApiError, ApiResult};
use crate::models::{OtpChannel, OtpPurpose};
use crate::repo::rate_limit;

/// Codes per destination per window.
pub const MAX_SENDS_PER_DESTINATION: i64 = 10;
/// The send window.
pub const SEND_WINDOW_SECONDS: i64 = 600;
/// Consecutive wrong codes before the cooldown.
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

/// A new challenge and its plaintext code (deliver it, never log it).
#[derive(Debug, Clone)]
pub struct CreatedChallenge {
    pub challenge: OtpChallenge,
    pub code: String,
}

/// Creates a challenge after enforcing the send limits (429 `rate_limited` with
/// `Retry-After`). Deliver `code` with `delivery::enqueue_otp` in the same transaction.
pub async fn send(
    conn: &mut PgConnection,
    pepper: &Pepper,
    settings: &Settings,
    new: &NewChallenge<'_>,
) -> ApiResult<CreatedChallenge> {
    let (recent, oldest): (i64, Option<OffsetDateTime>) = sqlx::query_as(
        "select count(*), min(created_at) from (select created_at from otp_challenges \
           where destination = $1 and created_at > now() - make_interval(secs => $2) \
           order by created_at desc limit $3) r",
    )
    .bind(new.destination)
    .bind(SEND_WINDOW_SECONDS as f64)
    .bind(MAX_SENDS_PER_DESTINATION)
    .fetch_one(&mut *conn)
    .await?;
    if recent >= MAX_SENDS_PER_DESTINATION {
        let retry = match oldest {
            Some(t) => {
                let free_at = t + time::Duration::seconds(SEND_WINDOW_SECONDS);
                (free_at - OffsetDateTime::now_utc()).whole_seconds().max(1) as u64
            }
            None => SEND_WINDOW_SECONDS as u64,
        };
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
            conn,
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
    .fetch_all(&mut *conn)
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
    .fetch_one(&mut *conn)
    .await?;
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

/// Checks a code (see the module docs for the exact responses). Returns the consumed challenge.
/// Takes the pool so failure counts persist although the request fails.
pub async fn verify(
    pool: &PgPool,
    pepper: &Pepper,
    settings: &Settings,
    challenge_id: Uuid,
    code: &str,
    expect: &Expect<'_>,
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
    let row = sqlx::query_as::<_, OtpChallenge>(concat!(
        "select ",
        challenge_columns!(),
        " from otp_challenges where id = $1 for update"
    ))
    .bind(challenge_id)
    .fetch_optional(&mut *tx)
    .await?;
    let not_found = || {
        ApiError::not_found(
            "challenge_not_found",
            format!("No verification code '{challenge_id}' is waiting here."),
        )
        .hint("Request a new code.")
    };
    let Some(c) = row else {
        return Err(not_found());
    };
    let bound_ok = expect.purpose.is_none_or(|p| p == c.purpose)
        && expect
            .flow_id
            .is_none_or(|f| c.flow_id.as_deref() == Some(f))
        && expect
            .account_uuid
            .is_none_or(|a| c.account_uuid.as_deref() == Some(a));
    if !bound_ok {
        return Err(not_found());
    }
    if c.consumed_at.is_some() {
        return Err(ApiError::conflict(
            "code_already_used",
            "This code was already used successfully.",
        )
        .hint("Request a new code if you need to verify again."));
    }
    let now = OffsetDateTime::now_utc();
    if let Some(until) = c.locked_until
        && until > now
    {
        let secs = (until - now).whole_seconds().max(1) as u64;
        return Err(ApiError::locked(
                "verification_locked",
                format!(
                    "Too many wrong codes in a row: verification is locked for {secs} more seconds (until {}).",
                    crate::timefmt::format_rfc3339_ms(until)
                ),
                secs,
            )
            .hint(format!("Wait {secs} seconds, then type the code again.")));
    }
    if c.expires_at <= now {
        return Err(ApiError::gone(
            "code_expired",
            format!(
                "This code expired at {} (codes last {} minutes), or a newer code replaced it.",
                crate::timefmt::format_rfc3339_ms(c.expires_at),
                settings.otp_ttl_seconds / 60
            ),
        )
        .hint("Use the most recent code, or request a new one."));
    }
    if constant_time_eq(&pepper.hash(code), &c.code_hash) {
        let done = sqlx::query_as::<_, OtpChallenge>(concat!(
            "update otp_challenges set consumed_at = now(), failed_streak = 0, locked_until = null where id = $1 returning ",
            challenge_columns!()
        ))
        .bind(c.id)
        .fetch_one(&mut *tx)
        .await?;
        tx.commit().await?;
        return Ok(done);
    }
    // Wrong code: a streak that started after an expired lock begins again from zero.
    let streak = c.failed_streak + 1;
    let locks_now = streak >= MAX_FAILED_STREAK;
    let locked_until: Option<OffsetDateTime> = sqlx::query_scalar(
        "update otp_challenges set total_failures = total_failures + 1, \
           failed_streak = case when $2 then 0 else $3 end, \
           locked_until = case when $2 then now() + make_interval(secs => $4) else null end \
         where id = $1 returning locked_until",
    )
    .bind(c.id)
    .bind(locks_now)
    .bind(streak)
    .bind(settings.otp_lock_seconds as f64)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    let remaining = if locks_now {
        0
    } else {
        MAX_FAILED_STREAK - streak
    };
    let mut err = ApiError::unprocessable(
        "invalid_code",
        if locks_now {
            format!(
                "That code is wrong. It was the {MAX_FAILED_STREAK}th wrong code in a row, so verification is locked for {} seconds.",
                settings.otp_lock_seconds
            )
        } else {
            format!("That code is wrong; {remaining} more tries before a {} second cooldown.", settings.otp_lock_seconds)
        },
    )
    .detail("remaining_attempts", remaining);
    if let (true, Some(until)) = (locks_now, locked_until) {
        err = err
            .detail("locked_until", crate::timefmt::format_rfc3339_ms(until))
            .retry_after(settings.otp_lock_seconds as u64)
            .hint(format!(
                "Wait {} seconds, then try again.",
                settings.otp_lock_seconds
            ));
    } else {
        err = err.hint("Check the latest code you received and type it again.");
    }
    Err(err)
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
