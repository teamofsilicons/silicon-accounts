//! Postgres-backed fixed-window rate limits (`rate_limits` table), shared by every API node.
//!
//! Each bucket counts hits since its window started; when the window is older than its length
//! the next hit starts a new window. One atomic upsert per hit.

use sqlx::{PgConnection, PgPool};

use crate::error::{ApiError, ApiResult};

/// A limit: at most `max` hits per `window_seconds`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limit {
    pub max: i32,
    pub window_seconds: i64,
}

impl Limit {
    pub const fn new(max: i32, window_seconds: i64) -> Self {
        Limit {
            max,
            window_seconds,
        }
    }
}

/// Spec limits.
pub mod limits {
    use super::Limit;

    /// `GET /v1/ids/available`: 120 per minute per IP.
    pub const IDS_AVAILABLE_PER_IP: Limit = Limit::new(120, 60);
    /// `POST /v1/silicons` (self-create): 10 per hour per IP.
    pub const SILICON_SELF_CREATE_PER_IP: Limit = Limit::new(10, 3600);
    /// `POST /v1/reports`: 5 per hour per IP.
    pub const REPORTS_PER_IP: Limit = Limit::new(5, 3600);
    /// OTP sends: 30 per 10 minutes per IP (the per-destination limit is enforced by `otp::send`).
    pub const OTP_SEND_PER_IP: Limit = Limit::new(30, 600);
    /// A Silicon's own sign-in from one IP: 60 per minute, counted in one bucket
    /// ([`super::SILICON_LOGIN_BUCKET`]) for `POST /v1/silicons/login` (STK or key assertion) and
    /// `grant_type=jwt-bearer` at `POST /v1/oauth/token` (the same key assertion): every attempt
    /// at either endpoint counts against the one limit, so moving between them buys no extra
    /// attempts. A brute-force speed bump on top of the per-Silicon lockout.
    pub const SILICON_LOGIN_PER_IP: Limit = Limit::new(60, 60);
    /// `POST /v1/telemetry/events`: 120 per minute per IP.
    pub const TELEMETRY_PER_IP: Limit = Limit::new(120, 60);
}

/// The bucket name of [`limits::SILICON_LOGIN_PER_IP`] (keyed by IP with [`bucket`]).
pub const SILICON_LOGIN_BUCKET: &str = "silicon_login:ip";

/// Outcome of a hit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Allowed { remaining: i32 },
    Limited { retry_after_seconds: u64 },
}

/// Counts a hit on `bucket` (e.g. `ids_available:ip:1.2.3.4`) and decides.
pub async fn hit(conn: &mut PgConnection, bucket: &str, limit: Limit) -> ApiResult<Decision> {
    let (count, retry_after): (i32, f64) = sqlx::query_as(
        "insert into rate_limits (bucket, window_started_at, count) values ($1, now(), 1) \
         on conflict (bucket) do update set \
           window_started_at = case when rate_limits.window_started_at <= now() - make_interval(secs => $2) \
                                    then now() else rate_limits.window_started_at end, \
           count = case when rate_limits.window_started_at <= now() - make_interval(secs => $2) \
                        then 1 else rate_limits.count + 1 end \
         returning count, extract(epoch from (window_started_at + make_interval(secs => $2) - now()))::float8",
    )
    .bind(bucket)
    .bind(limit.window_seconds as f64)
    .fetch_one(&mut *conn)
    .await?;
    if count > limit.max {
        Ok(Decision::Limited {
            retry_after_seconds: retry_after.ceil().max(1.0) as u64,
        })
    } else {
        Ok(Decision::Allowed {
            remaining: limit.max - count,
        })
    }
}

/// Counts a hit and returns 429 `rate_limited` (with `Retry-After`) when over the limit.
/// `what` completes the message: "Too many {what}".
pub async fn enforce(
    conn: &mut PgConnection,
    bucket: &str,
    limit: Limit,
    what: &str,
) -> ApiResult<()> {
    match hit(conn, bucket, limit).await? {
        Decision::Allowed { .. } => Ok(()),
        Decision::Limited {
            retry_after_seconds,
        } => Err(ApiError::rate_limited(
            format!(
                "Too many {what}: the limit is {} per {}.",
                limit.max,
                describe_window(limit.window_seconds)
            ),
            retry_after_seconds,
        )),
    }
}

/// Whether `bucket` has room for one more hit, **without counting anything**: callers that
/// count only successful requests (`enforce` once the work succeeded) use it to refuse a flood
/// of over-limit requests before doing any real work.
pub async fn peek(conn: &mut PgConnection, bucket: &str, limit: Limit) -> ApiResult<Decision> {
    let row: Option<(i32, f64)> = sqlx::query_as(
        "select count, extract(epoch from (window_started_at + make_interval(secs => $2) - now()))::float8 \
         from rate_limits where bucket = $1 and window_started_at > now() - make_interval(secs => $2)",
    )
    .bind(bucket)
    .bind(limit.window_seconds as f64)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(match row {
        Some((count, retry_after)) if count >= limit.max => Decision::Limited {
            retry_after_seconds: retry_after.ceil().max(1.0) as u64,
        },
        Some((count, _)) => Decision::Allowed {
            remaining: limit.max - count,
        },
        None => Decision::Allowed {
            remaining: limit.max,
        },
    })
}

/// Takes `n` units at once from `bucket`'s budget (a weighted hit, e.g. imported rows): refused
/// as a whole (nothing taken) when it would go over `limit.max` in the current window. The
/// bucket row stays locked until the caller's transaction ends, so concurrent takes can't
/// overspend it; take it inside the transaction whose success it pays for.
pub async fn take(
    conn: &mut PgConnection,
    bucket: &str,
    n: i32,
    limit: Limit,
) -> ApiResult<Decision> {
    sqlx::query(
        "insert into rate_limits (bucket, window_started_at, count) values ($1, now(), 0) \
         on conflict (bucket) do nothing",
    )
    .bind(bucket)
    .execute(&mut *conn)
    .await?;
    let (used, elapsed): (i32, f64) = sqlx::query_as(
        "select count, extract(epoch from (now() - window_started_at))::float8 from rate_limits \
         where bucket = $1 for update",
    )
    .bind(bucket)
    .fetch_one(&mut *conn)
    .await?;
    let expired = elapsed >= limit.window_seconds as f64;
    let used = if expired { 0 } else { used };
    if i64::from(used) + i64::from(n) > i64::from(limit.max) {
        let retry_after = (limit.window_seconds as f64 - elapsed).ceil().max(1.0) as u64;
        return Ok(Decision::Limited {
            retry_after_seconds: retry_after,
        });
    }
    sqlx::query(
        "update rate_limits set count = $2, \
           window_started_at = case when $3 then now() else window_started_at end \
         where bucket = $1",
    )
    .bind(bucket)
    .bind(used + n)
    .bind(expired)
    .execute(&mut *conn)
    .await?;
    Ok(Decision::Allowed {
        remaining: limit.max - used - n,
    })
}

/// Same as [`enforce`] on a pool connection (the hit is committed immediately).
pub async fn enforce_pool(pool: &PgPool, bucket: &str, limit: Limit, what: &str) -> ApiResult<()> {
    let mut conn = pool.acquire().await?;
    enforce(&mut conn, bucket, limit, what).await
}

/// Bucket key helper: `"{name}:{key}"`.
pub fn bucket(name: &str, key: &str) -> String {
    format!("{name}:{key}")
}

/// Deletes buckets whose window ended over a day ago (run from a sweep).
pub async fn purge(conn: &mut PgConnection) -> ApiResult<u64> {
    Ok(
        sqlx::query("delete from rate_limits where window_started_at < now() - interval '1 day'")
            .execute(&mut *conn)
            .await?
            .rows_affected(),
    )
}

/// `60` → "minute", `600` → "10 minutes", `3600` → "hour".
pub fn describe_window(seconds: i64) -> String {
    match seconds {
        60 => "minute".into(),
        3600 => "hour".into(),
        86_400 => "day".into(),
        s if s % 3600 == 0 => format!("{} hours", s / 3600),
        s if s % 60 == 0 => format!("{} minutes", s / 60),
        s => format!("{s} seconds"),
    }
}
