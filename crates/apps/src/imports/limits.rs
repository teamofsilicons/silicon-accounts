//! What one app, and one Silicon Accounts process, may spend on imports.
//!
//! - Submissions: at most [`SUBMISSIONS_PER_HOUR`] import requests per app per hour. Every
//!   request that reaches the parser counts (dry runs and refused files too: each one is read
//!   and parsed). An app already at the limit is refused before its body is read — except a
//!   request with an Idempotency-Key, which may be the retry of an import that went through and
//!   then gets its stored 202 back (new work under a key is still counted and refused).
//! - Rows: at most [`ROWS_PER_DAY`] rows per app per 24 hours, taken in the transaction that
//!   creates the job (so a refused or failed request costs nothing). Dry runs count: they say
//!   which emails and phone numbers have accounts, so they must not be a free lookup service.
//! - Capacity: at most [`MAX_CONCURRENT_IMPORTS`] import bodies are read and parsed at once per
//!   process (each holds up to 50 MB). A request waits up to [`SLOT_WAIT`] for a slot before it
//!   reads its body, then gets 503 `imports_busy` with `Retry-After`.
//!
//! Windows are fixed and live in the shared `rate_limits` table (one row per bucket), so every
//! API node enforces the same budget.

use std::sync::OnceLock;
use std::time::Duration;

use accounts_core::repo::rate_limit::{self, Limit};
use accounts_core::{ApiError, ApiResult};
use sqlx::{PgConnection, PgPool};
use tokio::sync::{Semaphore, SemaphorePermit};

/// Import requests per app per hour.
pub const SUBMISSIONS_PER_HOUR: Limit = Limit::new(60, 3600);
/// Imported rows (dry runs included) per app per 24 hours.
pub const ROWS_PER_DAY: i64 = 2_000_000;
const ROWS_WINDOW_SECONDS: i64 = 86_400;
/// Import bodies one process reads and parses at once.
pub const MAX_CONCURRENT_IMPORTS: usize = 2;
/// How long a request waits for a free slot.
pub const SLOT_WAIT: Duration = Duration::from_secs(30);
/// `Retry-After` of a busy answer.
const BUSY_RETRY_AFTER_SECONDS: u64 = 15;

fn submissions_bucket(app_id: &str) -> String {
    rate_limit::bucket("import_submissions:app", app_id)
}

fn rows_bucket(app_id: &str) -> String {
    rate_limit::bucket("import_rows:app", app_id)
}

fn too_many_submissions(app_id: &str, retry_after: u64) -> ApiError {
    ApiError::rate_limited(
        format!(
            "Too many import requests for the app '{app_id}': the limit is {} per {} (dry runs and refused files count).",
            SUBMISSIONS_PER_HOUR.max,
            rate_limit::describe_window(SUBMISSIONS_PER_HOUR.window_seconds)
        ),
        retry_after,
    )
    .hint(format!(
        "Wait {retry_after} seconds. Check files with one dry run, then import them; split big files into parts of up to 100,000 rows instead of many small requests."
    ))
    .detail("limit", SUBMISSIONS_PER_HOUR.max)
}

/// Refuses an app that already used its hourly submissions, before its body is read. Does not
/// count anything.
pub async fn precheck_submissions(pool: &PgPool, app_id: &str) -> ApiResult<()> {
    let row: Option<(i32, f64)> = sqlx::query_as(
        "select count, extract(epoch from (window_started_at + make_interval(secs => $2) - now()))::float8 \
         from rate_limits where bucket = $1",
    )
    .bind(submissions_bucket(app_id))
    .bind(SUBMISSIONS_PER_HOUR.window_seconds as f64)
    .fetch_optional(pool)
    .await?;
    match row {
        Some((count, left)) if left > 0.0 && count >= SUBMISSIONS_PER_HOUR.max => {
            Err(too_many_submissions(app_id, left.ceil().max(1.0) as u64))
        }
        _ => Ok(()),
    }
}

/// Counts one import request against the hourly limit.
pub async fn count_submission(pool: &PgPool, app_id: &str) -> ApiResult<()> {
    let mut conn = pool.acquire().await?;
    match rate_limit::hit(&mut conn, &submissions_bucket(app_id), SUBMISSIONS_PER_HOUR).await? {
        rate_limit::Decision::Allowed { .. } => Ok(()),
        rate_limit::Decision::Limited {
            retry_after_seconds,
        } => Err(too_many_submissions(app_id, retry_after_seconds)),
    }
}

/// Takes `rows` from the app's daily row budget (inside the caller's transaction; the budget row
/// stays locked until it commits, so concurrent imports of one app can't overspend it).
pub async fn take_rows(conn: &mut PgConnection, app_id: &str, rows: i64) -> ApiResult<()> {
    let bucket = rows_bucket(app_id);
    sqlx::query(
        "insert into rate_limits (bucket, window_started_at, count) values ($1, now(), 0) \
         on conflict (bucket) do nothing",
    )
    .bind(&bucket)
    .execute(&mut *conn)
    .await?;
    let (used, elapsed): (i32, f64) = sqlx::query_as(
        "select count, extract(epoch from (now() - window_started_at))::float8 from rate_limits \
         where bucket = $1 for update",
    )
    .bind(&bucket)
    .fetch_one(&mut *conn)
    .await?;
    let expired = elapsed >= ROWS_WINDOW_SECONDS as f64;
    let used = if expired { 0 } else { i64::from(used) };
    if used + rows > ROWS_PER_DAY {
        let left = (ROWS_PER_DAY - used).max(0);
        let retry_after = (ROWS_WINDOW_SECONDS as f64 - elapsed).ceil().max(1.0) as u64;
        return Err(ApiError::rate_limited(
            format!(
                "The app '{app_id}' can import at most {ROWS_PER_DAY} rows per 24 hours (dry runs included); this import has {rows} rows and {left} are left in the current window."
            ),
            retry_after,
        )
        .hint(format!(
            "Import at most {left} rows now, or wait {retry_after} seconds for the window to reset."
        ))
        .detail("limit_rows", ROWS_PER_DAY)
        .detail("remaining_rows", left)
        .detail("import_rows", rows));
    }
    sqlx::query(
        "update rate_limits set count = $2, \
           window_started_at = case when $3 then now() else window_started_at end \
         where bucket = $1",
    )
    .bind(&bucket)
    .bind(i32::try_from(used + rows).unwrap_or(i32::MAX))
    .bind(expired)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// The import slots of this process.
pub(crate) fn slots() -> &'static Semaphore {
    static SLOTS: OnceLock<Semaphore> = OnceLock::new();
    SLOTS.get_or_init(|| Semaphore::new(MAX_CONCURRENT_IMPORTS))
}

/// Waits up to `wait` for a slot; 503 `imports_busy` when none frees up.
pub(crate) async fn acquire_slot(
    sem: &Semaphore,
    wait: Duration,
) -> ApiResult<SemaphorePermit<'_>> {
    match tokio::time::timeout(wait, sem.acquire()).await {
        Ok(Ok(permit)) => Ok(permit),
        _ => Err(ApiError::unavailable(
            "imports_busy",
            format!(
                "This Silicon Accounts server is already reading {MAX_CONCURRENT_IMPORTS} other imports and none finished within {} seconds, so this import wasn't read; nothing was imported.",
                wait.as_secs()
            ),
        )
        .hint(format!(
            "Retry in {BUSY_RETRY_AFTER_SECONDS} seconds (with the same Idempotency-Key, so a retry never creates two jobs)."
        ))
        .retry_after(BUSY_RETRY_AFTER_SECONDS)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_full_server_answers_busy_with_retry_after() {
        let sem = Semaphore::new(1);
        let held = acquire_slot(&sem, Duration::from_millis(10))
            .await
            .expect("free slot");
        let e = acquire_slot(&sem, Duration::from_millis(30))
            .await
            .expect_err("busy");
        assert_eq!(e.status.as_u16(), 503);
        assert_eq!(e.code, "imports_busy");
        assert_eq!(e.retry_after, Some(BUSY_RETRY_AFTER_SECONDS));
        drop(held);
        assert!(acquire_slot(&sem, Duration::from_millis(10)).await.is_ok());
    }
}
