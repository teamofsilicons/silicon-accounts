//! What one app, and one Silicon Accounts process, may spend on imports.
//!
//! - Submissions: at most [`SUBMISSIONS_PER_HOUR`] import requests per app per hour. A request
//!   counts as soon as it gets an import slot, before its body is read (dry runs, refused files
//!   and uploads that stall or break off too: each one held a slot). An app already at the limit
//!   is refused before it waits for a slot. Not counted: a retry under an Idempotency-Key whose
//!   import already went through, which gets its stored 202 back even when the app has used up
//!   its hour (new work under a key is counted and refused like any other).
//! - Rows: at most [`ROWS_PER_DAY`] rows per app per 24 hours, taken in the transaction that
//!   creates the job (so a refused or failed request costs nothing). Dry runs count: they say
//!   which emails and phone numbers have accounts, so they must not be a free lookup service.
//! - Capacity: at most [`MAX_CONCURRENT_IMPORTS`] import bodies are read and parsed at once per
//!   process (each holds up to 50 MB), and at most [`MAX_CONCURRENT_IMPORTS_PER_APP`] of them
//!   for one app, so however many uploads one app opens, the other apps still get a slot. A
//!   request waits up to [`SLOT_WAIT`] for a slot before it reads its body, then gets 503
//!   `imports_busy` with `Retry-After`. A body has to keep arriving: after [`UPLOAD_GRACE`] it
//!   must average at least [`MIN_UPLOAD_BYTES_PER_SECOND`], or the read stops with 408
//!   `import_upload_too_slow` and the slot is free at once (a stalled client can't sit on a slot
//!   for the request's whole 5-minute budget).
//!
//! Windows are fixed and live in the shared `rate_limits` table (one row per bucket), so every
//! API node enforces the same budget (core's `rate_limit::peek`, `hit` and the weighted `take`).

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock, PoisonError};
use std::time::Duration;

use accounts_core::repo::rate_limit::{self, Limit};
use accounts_core::{ApiError, ApiResult};
use axum::http::StatusCode;
use sqlx::{PgConnection, PgPool};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, SemaphorePermit};
use tokio::time::Instant;

/// Import requests per app per hour.
pub const SUBMISSIONS_PER_HOUR: Limit = Limit::new(60, 3600);
/// Imported rows (dry runs included) per app per 24 hours.
pub const ROWS_PER_DAY: i64 = 2_000_000;
const ROWS_WINDOW_SECONDS: i64 = 86_400;
const ROWS_LIMIT: Limit = Limit::new(ROWS_PER_DAY as i32, ROWS_WINDOW_SECONDS);
/// Import bodies one process reads and parses at once.
pub const MAX_CONCURRENT_IMPORTS: usize = 2;
/// Of those, how many one app may hold.
pub const MAX_CONCURRENT_IMPORTS_PER_APP: usize = 1;
/// How long a request waits for a free slot.
pub const SLOT_WAIT: Duration = Duration::from_secs(30);
/// How long a body may take to get going before its pace counts.
pub const UPLOAD_GRACE: Duration = Duration::from_secs(10);
/// The slowest average pace a body may arrive at after [`UPLOAD_GRACE`] (32 KB/s; a 50 MB file
/// needs about 170 KB/s to fit the import request's 5 minutes anyway).
pub const MIN_UPLOAD_BYTES_PER_SECOND: u64 = 32 * 1024;
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
    let mut conn = pool.acquire().await?;
    match rate_limit::peek(&mut conn, &submissions_bucket(app_id), SUBMISSIONS_PER_HOUR).await? {
        rate_limit::Decision::Limited {
            retry_after_seconds,
        } => Err(too_many_submissions(app_id, retry_after_seconds)),
        rate_limit::Decision::Allowed { .. } => Ok(()),
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
    let n = i32::try_from(rows).unwrap_or(i32::MAX);
    if let rate_limit::Decision::Limited {
        retry_after_seconds,
    } = rate_limit::take(conn, &bucket, n, ROWS_LIMIT).await?
    {
        let left = match rate_limit::peek(conn, &bucket, ROWS_LIMIT).await? {
            rate_limit::Decision::Allowed { remaining } => i64::from(remaining),
            rate_limit::Decision::Limited { .. } => 0,
        };
        return Err(ApiError::rate_limited(
            format!(
                "The app '{app_id}' can import at most {ROWS_PER_DAY} rows per 24 hours (dry runs included); this import has {rows} rows and {left} are left in the current window."
            ),
            retry_after_seconds,
        )
        .hint(format!(
            "Import at most {left} rows now, or wait {retry_after_seconds} seconds for the window to reset."
        ))
        .detail("limit_rows", ROWS_PER_DAY)
        .detail("remaining_rows", left)
        .detail("import_rows", rows));
    }
    Ok(())
}

/// The import slots of a process: [`MAX_CONCURRENT_IMPORTS`] in all, at most
/// [`MAX_CONCURRENT_IMPORTS_PER_APP`] per app.
pub(crate) struct Slots {
    all: Semaphore,
    per_app_max: usize,
    /// One gate per app with a request holding or waiting for a slot (removed when unused).
    apps: Mutex<HashMap<String, Arc<Semaphore>>>,
}

/// One import slot (of the process, and of its app); both are given back when it drops.
pub(crate) struct Slot<'a> {
    slots: &'a Slots,
    app_id: String,
    app: Option<OwnedSemaphorePermit>,
    all: Option<SemaphorePermit<'a>>,
}

impl std::fmt::Debug for Slot<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Slot")
            .field("app_id", &self.app_id)
            .finish()
    }
}

impl Drop for Slot<'_> {
    fn drop(&mut self) {
        self.all.take();
        self.app.take();
        self.slots.forget_unused(&self.app_id);
    }
}

impl Slots {
    pub(crate) fn new(total: usize, per_app: usize) -> Slots {
        Slots {
            all: Semaphore::new(total),
            per_app_max: per_app,
            apps: Mutex::new(HashMap::new()),
        }
    }

    fn gate(&self, app_id: &str) -> Arc<Semaphore> {
        let mut apps = self.apps.lock().unwrap_or_else(PoisonError::into_inner);
        apps.entry(app_id.to_string())
            .or_insert_with(|| Arc::new(Semaphore::new(self.per_app_max)))
            .clone()
    }

    /// Drops the app's gate once nobody holds or waits for it (they all hold a clone).
    fn forget_unused(&self, app_id: &str) {
        let mut apps = self.apps.lock().unwrap_or_else(PoisonError::into_inner);
        if apps.get(app_id).is_some_and(|g| Arc::strong_count(g) == 1) {
            apps.remove(app_id);
        }
    }

    /// Apps with a gate (for tests).
    #[cfg(test)]
    fn gates(&self) -> usize {
        self.apps
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .len()
    }

    /// Waits up to `wait` for one of the app's slots and then one of the process's; 503
    /// `imports_busy` when none frees up in time.
    pub(crate) async fn acquire(&self, app_id: &str, wait: Duration) -> ApiResult<Slot<'_>> {
        let deadline = Instant::now() + wait;
        let gate = self.gate(app_id);
        let app = tokio::time::timeout_at(deadline, gate.clone().acquire_owned()).await;
        drop(gate);
        let Ok(Ok(app)) = app else {
            self.forget_unused(app_id);
            return Err(busy(
                format!(
                    "This Silicon Accounts server is already reading {} import{} of the app '{app_id}' (one app gets at most {} of the server's {MAX_CONCURRENT_IMPORTS} import slots at once) and none finished within {} seconds, so this import wasn't read; nothing was imported.",
                    self.per_app_max,
                    if self.per_app_max == 1 { "" } else { "s" },
                    self.per_app_max,
                    wait.as_secs()
                ),
                "Send this app's imports one at a time: retry",
            ));
        };
        let mut slot = Slot {
            slots: self,
            app_id: app_id.to_string(),
            app: Some(app),
            all: None,
        };
        match tokio::time::timeout_at(deadline, self.all.acquire()).await {
            Ok(Ok(permit)) => {
                slot.all = Some(permit);
                Ok(slot)
            }
            _ => Err(busy(
                format!(
                    "This Silicon Accounts server is already reading {MAX_CONCURRENT_IMPORTS} other imports and none finished within {} seconds, so this import wasn't read; nothing was imported.",
                    wait.as_secs()
                ),
                "Retry",
            )),
        }
    }
}

fn busy(message: String, first: &str) -> ApiError {
    ApiError::unavailable("imports_busy", message)
        .hint(format!(
            "{first} in {BUSY_RETRY_AFTER_SECONDS} seconds (with the same Idempotency-Key, so a retry never creates two jobs)."
        ))
        .retry_after(BUSY_RETRY_AFTER_SECONDS)
}

/// The import slots of this process.
pub(crate) fn slots() -> &'static Slots {
    static SLOTS: OnceLock<Slots> = OnceLock::new();
    SLOTS.get_or_init(|| Slots::new(MAX_CONCURRENT_IMPORTS, MAX_CONCURRENT_IMPORTS_PER_APP))
}

/// The slowest pace an import body may arrive at.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Pace {
    /// How long a body may take to get going before its pace counts.
    pub grace: Duration,
    /// The slowest average pace after `grace`.
    pub min_bytes_per_second: u64,
}

/// [`UPLOAD_GRACE`] and [`MIN_UPLOAD_BYTES_PER_SECOND`].
pub(crate) const UPLOAD_PACE: Pace = Pace {
    grace: UPLOAD_GRACE,
    min_bytes_per_second: MIN_UPLOAD_BYTES_PER_SECOND,
};

impl Pace {
    /// When a body that has `received` bytes after starting at `started` falls behind: the
    /// grace plus the time `received` bytes take at the minimum pace.
    pub(crate) fn deadline(&self, started: Instant, received: usize) -> Instant {
        let earned =
            Duration::from_secs_f64(received as f64 / self.min_bytes_per_second.max(1) as f64);
        started + self.grace + earned
    }

    /// 408 `import_upload_too_slow`: the body fell behind, so its slot was given back.
    pub(crate) fn too_slow(&self, received: usize, elapsed: Duration) -> ApiError {
        ApiError::new(
            StatusCode::REQUEST_TIMEOUT,
            "import_upload_too_slow",
            format!(
                "The import body arrived too slowly: {received} bytes in {} seconds. After its first {} seconds an import upload must average at least {} KB/s, so this server stopped reading it and gave its import slot to the next import; nothing was imported.",
                elapsed.as_secs(),
                self.grace.as_secs(),
                self.min_bytes_per_second / 1024
            ),
        )
        .hint("Send the file again from a faster or steadier connection, or split it into smaller files (with an Idempotency-Key per file).")
        .detail("received_bytes", received as u64)
        .detail("min_bytes_per_second", self.min_bytes_per_second)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const WAIT: Duration = Duration::from_millis(30);

    #[tokio::test]
    async fn a_full_server_answers_busy_with_retry_after() {
        let slots = Slots::new(1, 1);
        let held = slots.acquire("a", WAIT).await.expect("free slot");
        let e = slots.acquire("b", WAIT).await.expect_err("busy");
        assert_eq!(e.status.as_u16(), 503);
        assert_eq!(e.code, "imports_busy");
        assert_eq!(e.retry_after, Some(BUSY_RETRY_AFTER_SECONDS));
        assert!(e.message.contains("nothing was imported"), "{}", e.message);
        assert!(
            e.hint
                .as_deref()
                .is_some_and(|h| h.contains("Idempotency-Key")),
            "{:?}",
            e.hint
        );
        drop(held);
        assert!(slots.acquire("b", WAIT).await.is_ok());
    }

    /// One app's uploads, however many, never take every slot: the other apps still import.
    #[tokio::test]
    async fn one_app_never_holds_every_slot() {
        let slots = Slots::new(2, 1);
        let first = slots.acquire("pixel", WAIT).await.expect("pixel's slot");
        let e = slots
            .acquire("pixel", WAIT)
            .await
            .expect_err("pixel waits for its own");
        assert_eq!(e.code, "imports_busy");
        assert!(e.message.contains("of the app 'pixel'"), "{}", e.message);
        assert_eq!(e.retry_after, Some(BUSY_RETRY_AFTER_SECONDS));
        let crm = slots
            .acquire("crm", WAIT)
            .await
            .expect("another app gets the other slot");
        // Both slots are taken now: a third app waits, then is told the server is busy.
        let e = slots.acquire("third", WAIT).await.expect_err("busy");
        assert!(e.message.contains("2 other imports"), "{}", e.message);
        drop(crm);
        // A second pixel request gets pixel's slot as soon as the first one is done.
        let next = slots.acquire("pixel", Duration::from_secs(5));
        let release = async move {
            tokio::time::sleep(Duration::from_millis(20)).await;
            drop(first);
        };
        let (next, ()) = tokio::join!(next, release);
        let next = next.expect("pixel's next import gets the slot");
        assert_eq!(slots.gates(), 1);
        drop(next);
        // Nobody holds or waits: no gate is left behind.
        assert_eq!(slots.gates(), 0);
    }

    #[test]
    fn the_upload_pace_deadline_grows_with_what_arrived() {
        let t0 = Instant::now();
        assert_eq!(UPLOAD_PACE.deadline(t0, 0), t0 + UPLOAD_GRACE);
        assert_eq!(
            UPLOAD_PACE.deadline(t0, (MIN_UPLOAD_BYTES_PER_SECOND * 3) as usize),
            t0 + UPLOAD_GRACE + Duration::from_secs(3)
        );
        let e = UPLOAD_PACE.too_slow(160, Duration::from_secs(10));
        assert_eq!(e.status.as_u16(), 408);
        assert_eq!(e.code, "import_upload_too_slow");
        assert!(
            e.message.contains("160 bytes in 10 seconds"),
            "{}",
            e.message
        );
        assert!(e.message.contains("nothing was imported"), "{}", e.message);
    }
}
