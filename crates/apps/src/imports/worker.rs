//! The import job worker.
//!
//! A job is processed by exactly one worker at a time: the worker holds a session-level
//! Postgres advisory lock (`import_job:<id>`) on a connection detached from the pool for the
//! whole job. If that process dies, Postgres drops the connection and the lock, and the next
//! worker pass (any instance) finds the job still `running`, takes the lock and resumes after
//! the last committed chunk. Jobs of one app run one after another.
//!
//! Each resume is recorded (audit `app.import.resumed`). A job whose worker already stopped
//! [`MAX_RESUMES`] + 1 times is marked `failed` instead of being resumed again: a job that
//! keeps taking its process down (a deploy is fine, a crash loop is not) must not stall every
//! other request of the server that runs it.

use std::sync::OnceLock;
use std::time::Duration;

use accounts_core::models::ActorKind;
use accounts_core::repo::audit;
use accounts_core::{ApiError, ApiResult, AppState};
use serde_json::Value;
use sqlx::{Connection, PgConnection};
use tokio::sync::Notify;
use tokio::task::JoinHandle;
use uuid::Uuid;

use super::JobRecord;
use super::engine::{CHUNK_ROWS, JobCtx, process_chunk, rebuild_state, summary};
use super::input::ImportOptions;

static WAKE: OnceLock<Notify> = OnceLock::new();

fn notifier() -> &'static Notify {
    WAKE.get_or_init(Notify::new)
}

/// Wakes the worker of this process (a job was just queued).
pub(crate) fn wake() {
    notifier().notify_one();
}

/// How often the worker looks for jobs queued by other instances or left behind by a crash.
const POLL: Duration = Duration::from_secs(2);

/// How many times a job left `running` by a stopped worker is resumed.
pub const MAX_RESUMES: i64 = 2;

/// What a job says when its worker stopped too often.
const STOPPED_TOO_OFTEN: &str = "The worker processing this import stopped (the server restarted or crashed) more than twice while it ran, so it was not resumed again. Rows reported with an outcome were imported; re-submit the file to import the rest (rows already imported match their accounts), and report it with `silicon-accounts report` if it happens again.";

/// Starts the worker loop.
pub fn spawn_worker(state: AppState) -> JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            // Each pass runs in its own task: even a panic can't stop the worker.
            let pass_state = state.clone();
            match tokio::spawn(async move { run_pending_jobs(&pass_state).await }).await {
                Ok(Ok(0)) => {}
                Ok(Ok(n)) => tracing::info!(jobs = n, "import worker finished jobs"),
                Ok(Err(e)) => tracing::error!(error = %e, "import worker pass failed"),
                Err(e) => tracing::error!(error = %e, "import worker pass crashed"),
            }
            tokio::select! {
                _ = notifier().notified() => {}
                _ = tokio::time::sleep(POLL) => {}
            }
        }
    })
}

const LOCK_KEY: &str = "hashtextextended('import_job:' || $1::text, 0)";

/// Processes every job that is queued or was left `running` by a dead worker, one after
/// another, and returns how many it finished. The background worker calls this in a loop; tests
/// call it directly to run imports synchronously.
pub async fn run_pending_jobs(state: &AppState) -> ApiResult<usize> {
    let mut done = 0;
    let running: Vec<Uuid> = sqlx::query_scalar(
        "select id from import_jobs where status = 'running' order by created_at, id",
    )
    .fetch_all(&state.db)
    .await?;
    for id in running {
        let mut conn = state.db.acquire().await?.detach();
        let locked: bool = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
            "select pg_try_advisory_lock({LOCK_KEY})"
        )))
        .bind(id)
        .fetch_one(&mut conn)
        .await?;
        if !locked {
            // Another worker is on it.
            let _ = conn.close().await;
            continue;
        }
        let job = sqlx::query_as::<_, JobRecord>(sqlx::AssertSqlSafe(format!(
            "select {} from import_jobs where id = $1 and status = 'running'",
            super::JOB_COLUMNS
        )))
        .bind(id)
        .fetch_optional(&mut conn)
        .await?;
        match job {
            Some(job) => {
                if resume_or_fail(&mut conn, &job).await? {
                    tracing::warn!(job_id = %id, app_id = %job.app_id, "resuming an import job a stopped worker left running");
                    run_guarded(state, conn, job).await;
                } else {
                    tracing::error!(job_id = %id, app_id = %job.app_id, "an import job stopped its worker too often; marked failed");
                    state.telemetry.record(
                        "accounts-api",
                        "import",
                        "import.failed",
                        serde_json::json!({"job_id": id, "app_id": job.app_id, "code": "worker_stopped_repeatedly"}),
                    );
                    release(conn, id).await;
                }
                done += 1;
            }
            None => release(conn, id).await,
        }
    }
    loop {
        let mut conn = state.db.acquire().await?.detach();
        let Some(job) = claim_next(&mut conn).await? else {
            let _ = conn.close().await;
            break;
        };
        run_guarded(state, conn, job).await;
        done += 1;
    }
    Ok(done)
}

/// Records a resume of a job a stopped worker left `running` (committed before any work, so
/// it counts even if this attempt dies too) — or, past [`MAX_RESUMES`], marks it failed.
/// Returns whether to resume.
async fn resume_or_fail(conn: &mut PgConnection, job: &JobRecord) -> ApiResult<bool> {
    let job_id = job.id.to_string();
    let resumes: i64 = sqlx::query_scalar(
        "select count(*) from audit_log where app_id = $1 and action = 'app.import.resumed' and target_id = $2",
    )
    .bind(&job.app_id)
    .bind(&job_id)
    .fetch_one(&mut *conn)
    .await?;
    if resumes >= MAX_RESUMES {
        sqlx::query(
            "update import_jobs set status = 'failed', finished_at = now(), error = $2 where id = $1 and status = 'running'",
        )
        .bind(job.id)
        .bind(STOPPED_TOO_OFTEN)
        .execute(&mut *conn)
        .await?;
        audit::record(
            conn,
            &audit::AuditEntry {
                target_kind: Some("import_job"),
                target_id: Some(&job_id),
                app_id: Some(&job.app_id),
                details: serde_json::json!({"resumes": resumes, "processed_rows": job.processed_rows}),
                ..audit::AuditEntry::new(ActorKind::System, None, "app.import.failed")
            },
        )
        .await?;
        return Ok(false);
    }
    audit::record(
        conn,
        &audit::AuditEntry {
            target_kind: Some("import_job"),
            target_id: Some(&job_id),
            app_id: Some(&job.app_id),
            details: serde_json::json!({"resume": resumes + 1, "processed_rows": job.processed_rows}),
            ..audit::AuditEntry::new(ActorKind::System, None, "app.import.resumed")
        },
    )
    .await?;
    Ok(true)
}

/// What a job says when the task processing it crashed.
const CRASHED: &str = "Silicon Accounts hit an internal error while importing this file, so the job stopped. Rows reported with an outcome were imported; re-submit the file to import the rest (rows already imported match their accounts).";

/// Runs a job in its own task, so a panic can't take the worker (or other jobs) down: the job is
/// marked failed instead of being resumed, and failing, forever.
async fn run_guarded(state: &AppState, conn: PgConnection, job: JobRecord) {
    let id = job.id;
    let task_state = state.clone();
    let task = tokio::spawn(async move {
        let mut conn = conn;
        run_job(&task_state, &mut conn, job).await;
        release(conn, id).await;
    });
    if let Err(e) = task.await {
        tracing::error!(job_id = %id, error = %e, "import job task crashed");
        let _ = sqlx::query(
            "update import_jobs set status = 'failed', finished_at = now(), error = $2 where id = $1 and status = 'running'",
        )
        .bind(id)
        .bind(CRASHED)
        .execute(&state.db)
        .await;
    }
}

async fn release(mut conn: PgConnection, id: Uuid) {
    let _ = sqlx::query(sqlx::AssertSqlSafe(format!(
        "select pg_advisory_unlock({LOCK_KEY})"
    )))
    .bind(id)
    .execute(&mut conn)
    .await;
    let _ = conn.close().await;
}

/// Claims the oldest queued job whose app has no running job, taking its lock before anyone
/// can see it as running.
async fn claim_next(conn: &mut PgConnection) -> ApiResult<Option<JobRecord>> {
    let mut tx = conn.begin().await?;
    let id: Option<Uuid> = sqlx::query_scalar(
        "select j.id from import_jobs j where j.status = 'queued' \
           and not exists (select 1 from import_jobs r where r.app_id = j.app_id and r.status = 'running') \
         order by j.created_at, j.id limit 1 for update skip locked",
    )
    .fetch_optional(&mut *tx)
    .await?;
    let Some(id) = id else {
        tx.rollback().await?;
        return Ok(None);
    };
    let locked: bool = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "select pg_try_advisory_lock({LOCK_KEY})"
    )))
    .bind(id)
    .fetch_one(&mut *tx)
    .await?;
    if !locked {
        tx.rollback().await?;
        return Ok(None);
    }
    let job = sqlx::query_as::<_, JobRecord>(sqlx::AssertSqlSafe(format!(
        "update import_jobs set status = 'running', started_at = coalesce(started_at, now()) where id = $1 returning {}",
        super::JOB_COLUMNS
    )))
    .bind(id)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Some(job))
}

/// Runs a job to completion; any failure marks it `failed` with a precise reason.
async fn run_job(state: &AppState, conn: &mut PgConnection, job: JobRecord) {
    let id = job.id;
    if let Err(e) = process_job(state, conn, &job).await {
        tracing::error!(job_id = %id, app_id = %job.app_id, error = %e, "import job failed");
        state.telemetry.record(
            "accounts-api",
            "import",
            "import.failed",
            serde_json::json!({"job_id": id, "app_id": job.app_id, "code": e.code, "status": e.status.as_u16()}),
        );
        let reason = e.message.clone();
        let _ = sqlx::query(
            "update import_jobs set status = 'failed', finished_at = now(), error = $2 where id = $1",
        )
        .bind(id)
        .bind(reason)
        .execute(&mut *conn)
        .await;
    }
}

async fn process_job(state: &AppState, conn: &mut PgConnection, job: &JobRecord) -> ApiResult<()> {
    let options: ImportOptions = serde_json::from_value(job.options.clone()).unwrap_or_default();
    let ctx = JobCtx {
        job_id: job.id,
        app_id: job.app_id.clone(),
        options,
        today: accounts_core::timefmt::today_utc(),
        iris_base_url: state.settings.iris_base_url.clone(),
        photo_url_prefix: accounts_core::pfp::photo_url_prefix(&state.settings),
    };
    // This connection runs the same few statements hundreds of times while the tables they read
    // grow by up to 100k rows. A generic plan cached while the tables were small (sequential
    // scans) would make every later chunk slower; custom plans follow the current table sizes.
    // The connection is dedicated to this job and closed after it, so the setting dies with it.
    sqlx::query("set plan_cache_mode = force_custom_plan")
        .execute(&mut *conn)
        .await?;
    let mut st = rebuild_state(conn, &ctx).await?;
    let started = std::time::Instant::now();
    let total = job.total_rows.max(1) as f64;
    let event = |name: &str, progress: f64, extra: serde_json::Value| {
        // Ids and counts only: never row data.
        let mut data = serde_json::json!({
            "job_id": job.id, "app_id": job.app_id, "format": job.format, "dry_run": ctx.options.dry_run,
            "total_rows": job.total_rows,
        });
        if let (Some(d), Some(e)) = (data.as_object_mut(), extra.as_object()) {
            d.extend(e.clone());
        }
        state
            .telemetry
            .record_progress("accounts-api", "import", name, Some(progress), data);
    };
    event(
        if st.last_row > 0 {
            "import.resumed"
        } else {
            "import.started"
        },
        f64::from(st.last_row) / total,
        serde_json::json!({}),
    );
    let mut reported_tenth = (f64::from(st.last_row) / total * 10.0) as i64;
    loop {
        let chunk: Vec<(i32, Value)> = sqlx::query_as(
            "select row_number, input from import_job_rows where job_id = $1 and row_number > $2 \
             order by row_number limit $3",
        )
        .bind(job.id)
        .bind(st.last_row)
        .bind(CHUNK_ROWS)
        .fetch_all(&mut *conn)
        .await?;
        let (Some(first), Some(last)) = (chunk.first().map(|c| c.0), chunk.last().map(|c| c.0))
        else {
            break;
        };
        let mut attempt = 0;
        loop {
            match process_chunk(conn, &ctx, &mut st, &chunk).await {
                Ok(()) => {
                    // One progress event per 10% (a 100k-row job has 200 chunks).
                    let tenth = (f64::from(st.last_row) / total * 10.0) as i64;
                    if tenth > reported_tenth && tenth < 10 {
                        reported_tenth = tenth;
                        event(
                            "import.progress",
                            f64::from(st.last_row) / total,
                            serde_json::json!({"processed_rows": st.last_row}),
                        );
                    }
                    break;
                }
                Err(e) if e.is_server_error() && attempt < 2 => {
                    attempt += 1;
                    tracing::warn!(job_id = %job.id, rows = %format!("{first}-{last}"), error = %e, "retrying an import chunk");
                    tokio::time::sleep(Duration::from_millis(500 * attempt)).await;
                }
                Err(e) if e.is_server_error() => {
                    // The cause is logged by ApiError::internal; the job says what it means.
                    return Err(ApiError {
                        message: format!(
                            "Silicon Accounts hit an internal error while importing rows {first}–{last}, so the job stopped there. Rows before {first} were imported; re-submit the file to import the rest (rows already imported match their accounts)."
                        ),
                        ..e
                    });
                }
                Err(e) => {
                    return Err(ApiError {
                        message: format!(
                            "Rows {first}–{last} could not be imported: {}",
                            e.message
                        ),
                        ..e
                    });
                }
            }
        }
    }
    sqlx::query(
        "update import_jobs set status = 'completed', finished_at = now(), processed_rows = total_rows, counts = $2 \
         where id = $1",
    )
    .bind(job.id)
    .bind(serde_json::to_value(st.counts)?)
    .execute(&mut *conn)
    .await?;
    let elapsed_ms = started.elapsed().as_millis().max(1) as f64;
    event(
        "import.completed",
        1.0,
        serde_json::json!({
            "counts": st.counts,
            "duration_ms": elapsed_ms as u64,
            "rows_per_second": (f64::from(job.total_rows) * 1000.0 / elapsed_ms).round(),
        }),
    );
    let (actor_kind, actor_id) = if job.created_by == "app" {
        (ActorKind::App, job.app_id.clone())
    } else {
        (ActorKind::Account, job.created_by.clone())
    };
    let _ = audit::record(
        conn,
        &audit::AuditEntry {
            target_kind: Some("import_job"),
            target_id: Some(&job.id.to_string()),
            app_id: Some(&job.app_id),
            details: summary(&ctx, &st.counts),
            ..audit::AuditEntry::new(actor_kind, Some(&actor_id), "app.import.completed")
        },
    )
    .await;
    Ok(())
}
