//! Periodic cleanup of expired working state.
//!
//! Nothing here can be used once it expired; rows are kept a little past expiry so a late
//! retry gets a precise "this expired / was already used" answer instead of "unknown". The
//! retention matches the sweeps of the crates that own the tables (auth, oauth, account), so
//! whichever sweep runs first deletes exactly the same rows. Deleted, in batches of 5,000 rows
//! so no statement holds locks for long:
//! - sign-in flows 1 day after they expired;
//! - authorization codes, short-lived tokens and device codes 7 days after they expired (a
//!   reused authorization code must still find its row to revoke the tokens issued from it);
//! - OTP challenges 1 day after they expired (core `otp::purge`);
//! - idempotency keys once their replay window ended (core `idempotency::purge`);
//! - id reservations 1 day after `reserved_until` (the id is already free then;
//!   `handle_history` keeps the record of the change);
//! - sign-up sessions 7 days after their 48 h lifetime ended or after they were used;
//! - rate-limit windows that ended over a day ago (core `rate_limit::purge`);
//! - the jti of every Silicon key assertion once the assertion expired (it can't be replayed
//!   after that anyway).
//!
//! History is never deleted: accounts, memberships, sessions, token families, refresh tokens,
//! proofs, webhook events/deliveries/attempts, messages, reports, imports, `audit_log`,
//! `signin_history`, `handle_history` and `custodian_history` stay.

use std::time::Duration;

use accounts_core::AppState;
use accounts_core::repo::{idempotency, otp, rate_limit};
use serde::Serialize;
use sqlx::PgPool;

use crate::Shutdown;

/// Time between sweeps.
pub const INTERVAL: Duration = Duration::from_secs(600);
/// Delay before the first sweep after start (lets the service settle).
pub const FIRST_RUN_DELAY: Duration = Duration::from_secs(30);
/// Rows deleted per statement.
pub const BATCH: u64 = 5_000;
/// Statements per table per sweep (bounds one sweep's work; the next sweep continues).
pub const MAX_BATCHES: usize = 200;

const SIGNIN_FLOWS: &str = "delete from signin_flows where id in \
    (select id from signin_flows where expires_at < now() - interval '1 day' limit 5000)";
const AUTHORIZATION_CODES: &str = "delete from authorization_codes where code_hash in \
    (select code_hash from authorization_codes where expires_at < now() - interval '7 days' limit 5000)";
const SHORT_LIVED_TOKENS: &str = "delete from short_lived_tokens where token_hash in \
    (select token_hash from short_lived_tokens where expires_at < now() - interval '7 days' limit 5000)";
const DEVICE_AUTHORIZATIONS: &str = "delete from device_authorizations where device_code_hash in \
    (select device_code_hash from device_authorizations where expires_at < now() - interval '7 days' limit 5000)";
const HANDLE_RESERVATIONS: &str = "delete from handle_reservations where handle in \
    (select handle from handle_reservations where reserved_until < now() - interval '1 day' limit 5000)";
const SILICON_KEY_ASSERTIONS: &str = "delete from silicon_key_assertions where (silicon_uuid, jti) in \
    (select silicon_uuid, jti from silicon_key_assertions where expires_at < now() limit 5000)";
const FEDERATED_TOKEN_USES: &str = "delete from federated_token_uses where (issuer, jti) in \
    (select issuer, jti from federated_token_uses where expires_at < now() limit 5000)";
const SIGNUP_SESSIONS: &str = "delete from signup_sessions where id in \
    (select id from signup_sessions where expires_at < now() - interval '7 days' \
       or consumed_at < now() - interval '7 days' limit 5000)";

/// Rows deleted by one sweep, per table, plus any step that failed.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct CleanupReport {
    pub signin_flows: u64,
    pub otp_challenges: u64,
    pub authorization_codes: u64,
    pub short_lived_tokens: u64,
    pub device_authorizations: u64,
    pub idempotency_keys: u64,
    pub handle_reservations: u64,
    pub signup_sessions: u64,
    pub rate_limits: u64,
    pub silicon_key_assertions: u64,
    pub federated_token_uses: u64,
    /// `"<table>: <error>"` for steps that failed (the others still ran).
    pub errors: Vec<String>,
}

impl CleanupReport {
    /// Total rows deleted.
    pub fn total(&self) -> u64 {
        self.signin_flows
            + self.otp_challenges
            + self.authorization_codes
            + self.short_lived_tokens
            + self.device_authorizations
            + self.idempotency_keys
            + self.handle_reservations
            + self.signup_sessions
            + self.rate_limits
            + self.silicon_key_assertions
            + self.federated_token_uses
    }
}

async fn purge_batched(pool: &PgPool, sql: &'static str) -> Result<u64, sqlx::Error> {
    let mut total = 0;
    for _ in 0..MAX_BATCHES {
        let deleted = sqlx::query(sql).execute(pool).await?.rows_affected();
        total += deleted;
        if deleted < BATCH {
            break;
        }
    }
    Ok(total)
}

/// The deleted-row count of one step, or 0 after noting its error.
fn tally<E: std::fmt::Display>(
    errors: &mut Vec<String>,
    table: &str,
    result: Result<u64, E>,
) -> u64 {
    match result {
        Ok(n) => n,
        Err(e) => {
            errors.push(format!("{table}: {e}"));
            0
        }
    }
}

/// Runs one sweep. Every step runs even when an earlier one failed.
pub async fn run_once(state: &AppState) -> CleanupReport {
    let pool = &state.db;
    let mut r = CleanupReport::default();
    let e = &mut r.errors;
    r.signin_flows = tally(e, "signin_flows", purge_batched(pool, SIGNIN_FLOWS).await);
    r.authorization_codes = tally(
        e,
        "authorization_codes",
        purge_batched(pool, AUTHORIZATION_CODES).await,
    );
    r.short_lived_tokens = tally(
        e,
        "short_lived_tokens",
        purge_batched(pool, SHORT_LIVED_TOKENS).await,
    );
    r.device_authorizations = tally(
        e,
        "device_authorizations",
        purge_batched(pool, DEVICE_AUTHORIZATIONS).await,
    );
    r.handle_reservations = tally(
        e,
        "handle_reservations",
        purge_batched(pool, HANDLE_RESERVATIONS).await,
    );
    r.signup_sessions = tally(
        e,
        "signup_sessions",
        purge_batched(pool, SIGNUP_SESSIONS).await,
    );
    r.silicon_key_assertions = tally(
        e,
        "silicon_key_assertions",
        purge_batched(pool, SILICON_KEY_ASSERTIONS).await,
    );
    r.federated_token_uses = tally(
        e,
        "federated_token_uses",
        purge_batched(pool, FEDERATED_TOKEN_USES).await,
    );
    match pool.acquire().await {
        Ok(mut conn) => {
            r.otp_challenges = tally(e, "otp_challenges", otp::purge(&mut conn).await);
            r.rate_limits = tally(e, "rate_limits", rate_limit::purge(&mut conn).await);
        }
        Err(err) => e.push(format!("otp_challenges, rate_limits: {err}")),
    }
    r.idempotency_keys = tally(e, "idempotency_keys", idempotency::purge(pool).await);
    r
}

fn log_and_record(state: &AppState, report: &CleanupReport) {
    if report.errors.is_empty() {
        if report.total() > 0 {
            tracing::info!(
                deleted = report.total(),
                signin_flows = report.signin_flows,
                otp_challenges = report.otp_challenges,
                authorization_codes = report.authorization_codes,
                short_lived_tokens = report.short_lived_tokens,
                device_authorizations = report.device_authorizations,
                idempotency_keys = report.idempotency_keys,
                handle_reservations = report.handle_reservations,
                signup_sessions = report.signup_sessions,
                rate_limits = report.rate_limits,
                "cleanup deleted expired rows"
            );
        } else {
            tracing::debug!("cleanup found nothing expired");
        }
    } else {
        tracing::error!(errors = ?report.errors, deleted = report.total(), "cleanup steps failed; the next sweep retries them");
    }
    state.telemetry.record_progress(
        "worker",
        "cleanup",
        "cleanup.swept",
        Some(1.0),
        serde_json::to_value(report).unwrap_or_default(),
    );
}

/// The cleanup loop: a sweep shortly after start, then every [`INTERVAL`], until `shutdown`.
pub async fn run(state: AppState, mut shutdown: Shutdown) {
    if !shutdown.sleep(FIRST_RUN_DELAY).await {
        return;
    }
    loop {
        let report = run_once(&state).await;
        log_and_record(&state, &report);
        if !shutdown.sleep(INTERVAL).await {
            break;
        }
    }
    tracing::info!("cleanup stopped");
}
