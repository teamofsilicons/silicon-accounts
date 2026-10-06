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
    /// `POST /v1/silicons/login`: 60 per minute per IP (brute-force speed bump on top of the
    /// per-Silicon lockout).
    pub const SILICON_LOGIN_PER_IP: Limit = Limit::new(60, 60);
    /// `POST /v1/telemetry/events`: 120 per minute per IP.
    pub const TELEMETRY_PER_IP: Limit = Limit::new(120, 60);
}

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
