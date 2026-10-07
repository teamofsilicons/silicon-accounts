//! User imports (app or owner):
//!
//! - `POST /v1/apps/{app_id}/imports` (Idempotency-Key): `Content-Type: text/csv` with options as
//!   query parameters, or `application/json` `{"rows":[…],"options":{…}}` → 202
//!   `{"job": ImportJob}`. At most 100,000 rows / 50 MB. Whole-request problems (unknown
//!   columns, empty file, structure past the limits of [`input`], …) are refused before a job
//!   exists; rows are processed by the background worker ([`run_pending_jobs`]). Budgets
//!   ([`limits`]): 60 requests per app per hour (counted when the request gets its import slot,
//!   before its body is read), 2,000,000 rows per app per 24 hours (dry runs included), and at
//!   most 2 bodies read and parsed at once per process, at most 1 of them per app; a body that
//!   falls behind 32 KB/s (after its first 10 seconds) is dropped with 408
//!   `import_upload_too_slow`, which frees its slot.
//! - `GET /v1/apps/{app_id}/imports` (newest first), `GET …/imports/{job_id}` → `{"job": …}`.
//! - `GET …/imports/{job_id}/rows?outcome&level&code&limit&cursor` → rows in file order:
//!   `{"row_number","outcome","account_uuid","id","messages":[{level,code,message,field?}],"input"}`.
//!   In a dry run, matched rows never name the account (`account_uuid` and `id` are null): a
//!   dry run writes nothing the Carbon could ever see, so it must not map emails or phone
//!   numbers to accounts.
//!
//! ImportJob: `{"id","app_id","status":"queued|running|completed|failed","format","options",
//! "dry_run","total_rows","processed_rows","counts":{"created","matched","updated","skipped",
//! "error","warnings"},"created_by","created_at","started_at","finished_at","error"}`.
//!
//! Storage note: `import_job_rows.input` holds the stored row of [`input`] (`{"row": {import
//! column: value as received}, "ignored"?, "ignored_count"?, "extra_cells"?, "missing_cells"?,
//! "header_cells"?}`) plus `"id": "c:…"` once processed; the API shows `row` as `input` (with
//! `_ignored_columns` / `_ignored_count` / `_extra_cells` when present) and the id as `id`.

pub mod engine;
pub mod input;
pub mod limits;
pub mod rules;
pub mod worker;

use accounts_core::http::pagination::paginate;
use accounts_core::http::{AppOrOwner, ClientMeta, IdempotencyKey, Path, Query};
use accounts_core::repo::{audit, idempotency};
use accounts_core::{ApiError, ApiResult, AppState};
use axum::Router;
use axum::body::{Body, Bytes, HttpBody};
use axum::extract::{RawQuery, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use http_body_util::BodyExt;
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::PgPool;
use time::OffsetDateTime;
use tokio::time::Instant;
use uuid::Uuid;

pub use engine::{Counts, Outcome};
pub use input::{ALLOWED_COLUMNS, ImportOptions, MAX_BYTES, MAX_ROWS};
pub use limits::{
    MAX_CONCURRENT_IMPORTS, MAX_CONCURRENT_IMPORTS_PER_APP, MIN_UPLOAD_BYTES_PER_SECOND,
    ROWS_PER_DAY, SUBMISSIONS_PER_HOUR, UPLOAD_GRACE,
};
pub use rules::{Level, RowMessage};
pub use worker::{run_pending_jobs, spawn_worker};

use crate::util::{caller_scope, from_micros, micros};

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        // The handler reads the body itself (after taking an import slot), up to 50 MB plus a
        // little headroom so it can answer with its own precise 413.
        .route(
            "/v1/apps/{app_id}/imports",
            post(create_import).get(list_imports),
        )
        .route("/v1/apps/{app_id}/imports/{job_id}", get(get_import))
        .route("/v1/apps/{app_id}/imports/{job_id}/rows", get(import_rows))
}

/// A row of `import_jobs`.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct JobRecord {
    pub id: Uuid,
    pub app_id: String,
    pub status: String,
    pub format: String,
    pub options: Value,
    pub total_rows: i32,
    pub processed_rows: i32,
    pub counts: Value,
    pub error: Option<String>,
    pub created_by: String,
    pub created_at: OffsetDateTime,
    pub started_at: Option<OffsetDateTime>,
    pub finished_at: Option<OffsetDateTime>,
}

pub(crate) const JOB_COLUMNS: &str = "id, app_id, status, format, options, total_rows, processed_rows, counts, \
     error, created_by, created_at, started_at, finished_at";

impl JobRecord {
    /// The job's options.
    pub fn options(&self) -> ImportOptions {
        serde_json::from_value(self.options.clone()).unwrap_or_default()
    }

    /// The API view (ImportJob).
    pub fn view(&self) -> Value {
        let ts = |t: Option<OffsetDateTime>| t.map(accounts_core::timefmt::format_rfc3339_ms);
        let options = self.options();
        json!({
            "id": self.id,
            "app_id": self.app_id,
            "status": self.status,
            "format": self.format,
            "options": options,
            "dry_run": options.dry_run,
            "total_rows": self.total_rows,
            "processed_rows": self.processed_rows,
            "counts": Counts::from_value(&self.counts),
            "created_by": self.created_by,
            "created_at": accounts_core::timefmt::format_rfc3339_ms(self.created_at),
            "started_at": ts(self.started_at),
            "finished_at": ts(self.finished_at),
            "error": self.error,
        })
    }
}

fn import_not_found(job_id: &str, app_id: &str) -> ApiError {
    ApiError::not_found(
        "import_not_found",
        format!("No import job '{job_id}' exists for the app '{app_id}'."),
    )
    .hint("List the app's imports with GET /v1/apps/{app_id}/imports; job ids come from the 202 response of POST …/imports.")
}

/// Most bytes read from an import body: 50 MB plus room for the JSON envelope, so a body just
/// over the limit gets the precise 413 below instead of a read error.
const READ_LIMIT: usize = MAX_BYTES + 64 * 1024;

async fn create_import(
    State(state): State<AppState>,
    auth: AppOrOwner,
    meta: ClientMeta,
    key: Option<IdempotencyKey>,
    headers: HeaderMap,
    RawQuery(query): RawQuery,
    body: Body,
) -> ApiResult<Response> {
    let app_id = auth.app.app_id.clone();
    let scope = idempotency::scope(
        &caller_scope(&auth),
        "POST",
        &format!("/v1/apps/{app_id}/imports"),
    );
    // A retry under an Idempotency-Key of an import that went through gets its stored 202 back,
    // even when the app has used up its hour: it is neither refused up front nor counted.
    let retry = match key.as_deref() {
        Some(k) => went_through(&state.db, &scope, k).await?,
        None => false,
    };
    // Refusals that cost nothing come before up to 50 MB are read.
    if !retry {
        limits::precheck_submissions(&state.db, &app_id).await?;
    }
    // The slot bounds how many bodies this process (and this app) holds and parses at once; it
    // is kept until the job exists. Taking one is what counts against the app's hour: an upload
    // that stalls or breaks off held a slot too.
    let _slot = limits::slots().acquire(&app_id, limits::SLOT_WAIT).await?;
    if !retry {
        limits::count_submission(&state.db, &app_id).await?;
    }
    let body = read_body(body).await?;
    let content_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    // The body can be 50 MB: the idempotency fingerprint is its hash, not the body.
    let fingerprint = json!({
        "content_type": content_type,
        "query": query,
        "sha256": hex::encode(accounts_core::crypto::sha256(&body)),
    });
    idempotency::run(
        &state,
        key.as_deref(),
        &scope,
        &fingerprint,
        false,
        || async {
            let parsed =
                parse_off_runtime(content_type.clone(), query.clone(), body.clone()).await?;
            let job = create_job(&state, &auth, parsed, meta.ip.as_deref()).await?;
            worker::wake();
            Ok((StatusCode::ACCEPTED, json!({"job": job.view()})))
        },
    )
    .await
}

/// True when reading failed because the body is longer than allowed (here or by the server's
/// own body limit).
fn too_long(e: &(dyn std::error::Error + 'static)) -> bool {
    let mut cause: Option<&(dyn std::error::Error + 'static)> = Some(e);
    while let Some(err) = cause {
        if err.is::<http_body_util::LengthLimitError>() {
            return true;
        }
        cause = err.source();
    }
    false
}

/// True when `key` holds the stored result of an import that went through (core's
/// `idempotency::begin` replays it).
async fn went_through(pool: &PgPool, scope: &str, key: &str) -> ApiResult<bool> {
    Ok(sqlx::query_scalar(
        "select exists (select 1 from idempotency_keys \
           where scope = $1 and key = $2 and status_code <> 0 and expires_at > now())",
    )
    .bind(scope)
    .bind(key)
    .fetch_one(pool)
    .await?)
}

/// Reads the body (holding an import slot), at most [`READ_LIMIT`] bytes, and only while it
/// keeps the minimum pace ([`limits::UPLOAD_PACE`]): a stalled upload is dropped with 408
/// `import_upload_too_slow` instead of keeping its slot for the request's whole budget.
async fn read_body(body: Body) -> ApiResult<Bytes> {
    read_paced_body(body, limits::UPLOAD_PACE).await
}

async fn read_paced_body(mut body: Body, pace: limits::Pace) -> ApiResult<Bytes> {
    let started = Instant::now();
    let expected = usize::try_from(body.size_hint().lower()).unwrap_or(READ_LIMIT);
    let mut buf: Vec<u8> = Vec::with_capacity(expected.min(READ_LIMIT));
    loop {
        let deadline = pace.deadline(started, buf.len());
        let frame = match tokio::time::timeout_at(deadline, body.frame()).await {
            Err(_) => return Err(pace.too_slow(buf.len(), started.elapsed())),
            Ok(None) => break,
            Ok(Some(Err(e))) if too_long(&e) => return Err(input::payload_too_large()),
            Ok(Some(Err(e))) => {
                return Err(ApiError::bad_request(
                    "invalid_body",
                    format!("The import body could not be read: {e}."),
                )
                .hint("Send the whole file in one request body (Content-Length or chunked)."));
            }
            Ok(Some(Ok(frame))) => frame,
        };
        if let Ok(data) = frame.into_data() {
            if buf.len() + data.len() > READ_LIMIT {
                return Err(input::payload_too_large());
            }
            buf.extend_from_slice(&data);
        }
    }
    if buf.len() > MAX_BYTES {
        return Err(input::payload_too_large());
    }
    Ok(Bytes::from(buf))
}

/// Parses on the blocking pool: a 50 MB body takes CPU time the async workers (which serve
/// every sign-in) must not spend.
async fn parse_off_runtime(
    content_type: Option<String>,
    query: Option<String>,
    body: Bytes,
) -> ApiResult<input::ParsedImport> {
    tokio::task::spawn_blocking(move || {
        input::parse_request(content_type.as_deref(), query.as_deref(), &body)
    })
    .await
    .map_err(|e| ApiError::internal(format!("import parser task: {e}")))?
}

/// Stores a validated import as a queued job with one pending row per input row (and takes the
/// rows from the app's daily budget in the same transaction).
async fn create_job(
    state: &AppState,
    auth: &AppOrOwner,
    parsed: input::ParsedImport,
    ip: Option<&str>,
) -> ApiResult<JobRecord> {
    let id = Uuid::now_v7();
    let app_id = auth.app.app_id.as_str();
    let total = parsed.rows.len() as i32;
    let mut tx = state.db.begin().await?;
    limits::take_rows(&mut tx, app_id, i64::from(total)).await?;
    let job = sqlx::query_as::<_, JobRecord>(sqlx::AssertSqlSafe(format!(
        "insert into import_jobs (id, app_id, status, format, options, total_rows, processed_rows, counts, created_by) \
         values ($1, $2, 'queued', $3, $4, $5, 0, $6, $7) returning {JOB_COLUMNS}"
    )))
    .bind(id)
    .bind(app_id)
    .bind(parsed.format.as_str())
    .bind(serde_json::to_value(&parsed.options)?)
    .bind(total)
    .bind(serde_json::to_value(Counts::default())?)
    .bind(auth.history_actor())
    .fetch_one(&mut *tx)
    .await?;
    for (chunk_index, chunk) in parsed.rows.chunks(2000).enumerate() {
        let start = (chunk_index * 2000) as i32;
        let numbers: Vec<i32> = (1..=chunk.len() as i32).map(|i| start + i).collect();
        // Rows travel as JSON text (what the parser produced) and become jsonb here.
        sqlx::query(
            "insert into import_job_rows (job_id, row_number, input, outcome) \
             select $1, n, i::jsonb, 'pending' from unnest($2::int[], $3::text[]) as x(n, i)",
        )
        .bind(id)
        .bind(&numbers)
        .bind(chunk)
        .execute(&mut *tx)
        .await?;
    }
    let (actor_kind, actor_id) = auth.audit_actor();
    audit::record(
        &mut tx,
        &audit::AuditEntry {
            target_kind: Some("import_job"),
            target_id: Some(&id.to_string()),
            app_id: Some(app_id),
            details: json!({
                "rows": total, "format": parsed.format.as_str(), "options": parsed.options,
                "ignored_columns": parsed.unknown_columns,
            }),
            ip,
            ..audit::AuditEntry::new(actor_kind, Some(&actor_id), "app.import.created")
        },
    )
    .await?;
    tx.commit().await?;
    Ok(job)
}

#[derive(Debug, Default, Deserialize)]
struct ListQuery {
    limit: Option<i64>,
    cursor: Option<String>,
}

async fn list_imports(
    State(state): State<AppState>,
    auth: AppOrOwner,
    Query(q): Query<ListQuery>,
) -> ApiResult<Response> {
    let params = accounts_core::http::PageParams {
        limit: q.limit,
        cursor: q.cursor,
    };
    let limit = params.limit();
    let (after_ts, after_id) = match params.cursor::<(i64, Uuid)>()? {
        Some((us, id)) => (Some(from_micros(us)?), Some(id)),
        None => (None, None),
    };
    let mut conn = state.db.acquire().await?;
    let rows = sqlx::query_as::<_, JobRecord>(sqlx::AssertSqlSafe(format!(
        "select {JOB_COLUMNS} from import_jobs where app_id = $1 \
           and ($2::timestamptz is null or (created_at, id) < ($2, $3)) \
         order by created_at desc, id desc limit $4"
    )))
    .bind(&auth.app.app_id)
    .bind(after_ts)
    .bind(after_id)
    .bind(limit + 1)
    .fetch_all(&mut *conn)
    .await?;
    let page = paginate(rows, limit, |r| (micros(r.created_at), r.id));
    let items: Vec<Value> = page.items.iter().map(JobRecord::view).collect();
    Ok(axum::Json(json!({"items": items, "next_cursor": page.next_cursor})).into_response())
}

async fn load_job(
    conn: &mut sqlx::PgConnection,
    app_id: &str,
    job_id: &str,
) -> ApiResult<JobRecord> {
    let id = Uuid::parse_str(job_id.trim()).map_err(|_| import_not_found(job_id, app_id))?;
    sqlx::query_as::<_, JobRecord>(sqlx::AssertSqlSafe(format!(
        "select {JOB_COLUMNS} from import_jobs where id = $1 and app_id = $2"
    )))
    .bind(id)
    .bind(app_id)
    .fetch_optional(&mut *conn)
    .await?
    .ok_or_else(|| import_not_found(job_id, app_id))
}

async fn get_import(
    State(state): State<AppState>,
    auth: AppOrOwner,
    Path((_app_id, job_id)): Path<(String, String)>,
) -> ApiResult<Response> {
    let mut conn = state.db.acquire().await?;
    let job = load_job(&mut conn, &auth.app.app_id, &job_id).await?;
    Ok(axum::Json(json!({"job": job.view()})).into_response())
}

#[derive(Debug, Default, Deserialize)]
struct RowsQuery {
    outcome: Option<String>,
    level: Option<String>,
    code: Option<String>,
    limit: Option<i64>,
    cursor: Option<String>,
}

#[derive(Debug, sqlx::FromRow)]
struct RowRecord {
    row_number: i32,
    outcome: String,
    account_uuid: Option<String>,
    messages: Value,
    input: Value,
}

impl RowRecord {
    /// The API view of a row. In a dry run a matched row doesn't name its account: the dry run
    /// writes nothing the Carbon could see, so it must not work as an email → account lookup.
    fn view(&self, dry_run: bool) -> Value {
        let mut input = self.input.get("row").cloned().unwrap_or_else(|| json!({}));
        if let Some(obj) = input.as_object_mut() {
            for (stored, shown) in [
                ("extra_cells", "_extra_cells"),
                ("ignored", "_ignored_columns"),
                ("ignored_count", "_ignored_count"),
            ] {
                if let Some(v) = self.input.get(stored) {
                    obj.insert(shown.into(), v.clone());
                }
            }
        }
        let hide = dry_run && matches!(self.outcome.as_str(), "matched" | "updated");
        let (account_uuid, id) = if hide {
            (Value::Null, Value::Null)
        } else {
            (
                json!(self.account_uuid),
                self.input.get("id").cloned().unwrap_or(Value::Null),
            )
        };
        json!({
            "row_number": self.row_number,
            "outcome": self.outcome,
            "account_uuid": account_uuid,
            "id": id,
            "messages": self.messages,
            "input": input,
        })
    }
}

async fn import_rows(
    State(state): State<AppState>,
    auth: AppOrOwner,
    Path((_app_id, job_id)): Path<(String, String)>,
    Query(q): Query<RowsQuery>,
) -> ApiResult<Response> {
    let outcome = crate::util::parse_choice(
        "outcome",
        q.outcome.as_deref(),
        Outcome::parse,
        "pending, created, matched, updated, skipped, error",
    )?;
    let level = crate::util::parse_choice(
        "level",
        q.level.as_deref(),
        |s| matches!(s, "error" | "warning" | "info").then(|| s.to_string()),
        "error, warning, info",
    )?;
    let code = q
        .code
        .as_deref()
        .map(str::trim)
        .filter(|c| !c.is_empty())
        .map(str::to_string);
    if let Some(c) = &code
        && (c.len() > 64 || !c.chars().all(|ch| ch.is_ascii_lowercase() || ch == '_'))
    {
        return Err(ApiError::bad_request(
            "invalid_query",
            format!(
                "The query parameter 'code' is '{c}', which is not a message code like id_conflict."
            ),
        ));
    }
    let params = accounts_core::http::PageParams {
        limit: q.limit,
        cursor: q.cursor,
    };
    let limit = params.limit();
    let after: Option<i32> = params.cursor()?;
    let mut conn = state.db.acquire().await?;
    let job = load_job(&mut conn, &auth.app.app_id, &job_id).await?;
    let rows = sqlx::query_as::<_, RowRecord>(
        "select row_number, outcome, account_uuid, messages, input from import_job_rows where job_id = $1 \
           and ($2::text is null or outcome = $2) \
           and ($3::jsonb is null or messages @> $3) \
           and ($4::jsonb is null or messages @> $4) \
           and ($5::int is null or row_number > $5) \
         order by row_number limit $6",
    )
    .bind(job.id)
    .bind(outcome.map(|o| o.as_str()))
    .bind(level.map(|l| json!([{"level": l}])))
    .bind(code.map(|c| json!([{"code": c}])))
    .bind(after)
    .bind(limit + 1)
    .fetch_all(&mut *conn)
    .await?;
    let page = paginate(rows, limit, |r| r.row_number);
    let dry_run = job.options().dry_run;
    let items: Vec<Value> = page.items.iter().map(|r| r.view(dry_run)).collect();
    Ok(axum::Json(json!({"items": items, "next_cursor": page.next_cursor})).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    /// A body that sends `chunks` (each after its delay), then ends, or stalls when `stall`.
    fn paced(chunks: Vec<(u64, &'static [u8])>, stall: bool) -> Body {
        let stream = futures::stream::unfold(chunks.into_iter(), move |mut rest| async move {
            match rest.next() {
                Some((ms, bytes)) => {
                    tokio::time::sleep(Duration::from_millis(ms)).await;
                    Some((Ok::<_, std::io::Error>(Bytes::from_static(bytes)), rest))
                }
                None if stall => futures::future::pending().await,
                None => None,
            }
        });
        Body::from_stream(stream)
    }

    const PACE: limits::Pace = limits::Pace {
        grace: Duration::from_millis(200),
        min_bytes_per_second: 1024,
    };

    #[tokio::test]
    async fn a_body_that_keeps_its_pace_is_read_whole() {
        let body = paced(
            vec![(0, b"email\n"), (50, b"a@x.test\n"), (50, b"b@x.test\n")],
            false,
        );
        let bytes = read_paced_body(body, PACE).await.expect("read");
        assert_eq!(&bytes[..], b"email\na@x.test\nb@x.test\n");
    }

    /// The imports-busy finding: an upload that trickles (or stops) gives its slot back after
    /// the grace instead of holding it for the request's whole budget.
    #[tokio::test]
    async fn a_stalled_body_is_dropped_after_the_grace() {
        let started = Instant::now();
        let body = paced(vec![(0, b"email,display_name\n")], true);
        let e = read_paced_body(body, PACE).await.expect_err("too slow");
        let took = started.elapsed();
        assert_eq!(e.status, StatusCode::REQUEST_TIMEOUT);
        assert_eq!(e.code, "import_upload_too_slow");
        assert_eq!(e.details["received_bytes"], 19);
        assert!(e.message.contains("19 bytes"), "{}", e.message);
        assert!(e.message.contains("nothing was imported"), "{}", e.message);
        // 200 ms of grace plus the ~19 ms that 19 bytes earn at 1 KB/s.
        assert!(
            took >= Duration::from_millis(210) && took < Duration::from_secs(2),
            "{took:?}"
        );

        // Trickling (a byte every 100 ms = 10 B/s) falls behind just the same.
        let trickle: Vec<(u64, &'static [u8])> = (0..100).map(|_| (100, &b"x"[..])).collect();
        let e = read_paced_body(paced(trickle, false), PACE)
            .await
            .expect_err("too slow");
        assert_eq!(e.code, "import_upload_too_slow");
    }
}
