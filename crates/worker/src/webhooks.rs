//! Webhook delivery engine.
//!
//! Core writes one `webhook_events` row (the exact JSON body) plus one `pending`
//! `webhook_deliveries` row per (event, target) inside the transaction of the change. This
//! module delivers them:
//!
//! 1. **Claim** due deliveries with `FOR UPDATE SKIP LOCKED` and give each a [`LEASE_SECONDS`]
//!    lease (`locked_until`), so several API nodes can run the worker without ever sending the
//!    same delivery concurrently. The loop runs on the [claim pipeline](crate::pipeline): it
//!    claims only as many deliveries as it has free slots ([`CONCURRENCY`]) and starts each the
//!    moment it is claimed, so a lease never runs down while its delivery waits in a queue. An
//!    attempt that hasn't finished [`CLAIM_BUDGET`] (50 s) after its claim (only a stalled
//!    database gets there; the HTTP request itself is cut at 10 s) is abandoned unrecorded. A
//!    crashed or stopped worker's lease simply runs out and another node retries: delivery is
//!    at-least-once, and receivers dedupe by `event_id`.
//! 2. **Resolve the target now**: the app's (or Silicon's) *current* webhook URL and *current*
//!    signing secret, so a rotated secret or a moved endpoint applies to retries and replays.
//! 3. **POST** the stored body with `Content-Type: application/json`,
//!    `User-Agent: SiliconAccounts-Webhooks/1`, `X-Accounts-Event-Id`, `X-Accounts-Event-Type`,
//!    `X-Accounts-Delivery-Id`, `X-Accounts-Timestamp` (unix seconds) and
//!    `X-Accounts-Signature: v1=<hex HMAC-SHA256(secret, "{timestamp}.{raw body}")>` — the key
//!    is the whole `whsec_…` string. Redirects are not followed and no proxy is used.
//! 4. **Record** a `webhook_attempts` row and the result: a 2xx within 10 s → `delivered`;
//!    anything else → retried after 10 s, 30 s, 1 min, 5 min, 15 min, 30 min, then hourly, until
//!    72 h after the event was created → `failed` (apps replay failed deliveries). A replayed
//!    delivery (attempts reset to 0) gets a fresh 72 h of retries counted from the replay
//!    (`requeued_at`); a replay made before that column existed is measured along the retry
//!    schedule instead.
//!
//! SSRF guard: with ACCOUNTS_WEBHOOK_ALLOW_PRIVATE=false only `https` URLs are contacted, local
//! host names and literal IPs that aren't [deliverable](is_deliverable_ip) (private, loopback,
//! link-local, reserved, and IPv6 forms that embed or translate to such an IPv4 address) are
//! refused, and the HTTP client resolves host names through [`GuardedResolver`], which refuses a
//! host if *any* of its addresses is not deliverable. The check happens in the connector itself,
//! so the address that was checked is the address that is connected to (no DNS-rebinding
//! window). A refusal stored for the app owner to read never names the addresses a host
//! resolved to, nor whether it resolved at all (that would map internal DNS); the server log
//! has the details.

use std::fmt;
use std::net::IpAddr;
use std::time::Duration;

use accounts_core::config::Settings;
use accounts_core::events::{self, DELIVERY_TIMEOUT_SECONDS, GIVE_UP_AFTER_HOURS};
use accounts_core::models::{AppStatus, WebhookTargetKind};
use accounts_core::{ApiResult, AppState, crypto, normalize};
use serde_json::{Value, json};
use sqlx::{PgConnection, PgPool};
use time::OffsetDateTime;
use tokio::time::Instant;
use uuid::Uuid;

use crate::Shutdown;
use crate::pipeline::{self, CLAIM_BUDGET, CLAIM_SECONDS, Pipeline};

/// Deliveries attempted at once; the loop never holds more leases than this.
pub const CONCURRENCY: usize = 16;
/// How long a claim is exclusive: [`CLAIM_SECONDS`], far longer than the 10 s attempt timeout.
pub const LEASE_SECONDS: i64 = CLAIM_SECONDS as i64;
/// Wait before looking again when fewer deliveries were due than slots were free.
pub const IDLE_POLL: Duration = Duration::from_secs(1);
/// Wait after a claim failed (database unavailable).
pub const ERROR_BACKOFF: Duration = Duration::from_secs(5);

/// Longest error text stored in `last_error` / `webhook_attempts.error`.
const MAX_ERROR_CHARS: usize = 500;
/// How much of a failed response body is quoted in the error.
const RESPONSE_SNIPPET_BYTES: usize = 256;

/// A delivery this worker holds the lease for, with its event.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct ClaimedDelivery {
    pub id: Uuid,
    pub event_id: Uuid,
    pub event_type: String,
    pub target_kind: WebhookTargetKind,
    /// app_id or Silicon uuid.
    pub target_id: String,
    /// The URL stored when the event was emitted (the current URL is looked up per attempt).
    pub url: String,
    /// Attempts made before this one (since the last replay).
    pub attempts: i32,
    pub manual_replays: i32,
    pub created_at: OffsetDateTime,
    /// When the delivery was last replayed (its fresh 72 h window starts there).
    pub requeued_at: Option<OffsetDateTime>,
    /// The lease (`locked_until`) this worker set; results are recorded only while it holds.
    pub lease: OffsetDateTime,
    /// The exact body to sign and send.
    pub payload: Value,
}

/// What happened to one claimed delivery.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeliveryOutcome {
    /// The endpoint answered 2xx.
    Delivered { delivery_id: Uuid, status: u16 },
    /// It failed and will be retried at `next_attempt_at`.
    Retrying {
        delivery_id: Uuid,
        status: Option<u16>,
        error: String,
        next_attempt_at: OffsetDateTime,
    },
    /// It failed for good (72 h window over, or the target can't receive webhooks any more).
    Failed {
        delivery_id: Uuid,
        status: Option<u16>,
        error: String,
    },
    /// The lease ran out before the result was recorded and another worker took over; that
    /// worker's result counts (the attempt itself is still recorded).
    LeaseLost { delivery_id: Uuid },
    /// The attempt didn't finish within [`CLAIM_BUDGET`] of its claim (it stalled, e.g. on the
    /// database), so it was abandoned before it could outlive its lease. Nothing was recorded;
    /// it is retried (by any worker) once the lease runs out.
    Abandoned { delivery_id: Uuid },
}

impl DeliveryOutcome {
    pub fn delivery_id(&self) -> Uuid {
        match self {
            DeliveryOutcome::Delivered { delivery_id, .. }
            | DeliveryOutcome::Retrying { delivery_id, .. }
            | DeliveryOutcome::Failed { delivery_id, .. }
            | DeliveryOutcome::LeaseLost { delivery_id }
            | DeliveryOutcome::Abandoned { delivery_id } => *delivery_id,
        }
    }
}

/// Claims up to `limit` due deliveries and leases them for `lease_seconds`.
pub async fn claim_due(
    pool: &PgPool,
    limit: i64,
    lease_seconds: i64,
) -> ApiResult<Vec<ClaimedDelivery>> {
    Ok(sqlx::query_as::<_, ClaimedDelivery>(
        "with due as ( \
           select id from webhook_deliveries \
            where status = 'pending' and next_attempt_at <= now() \
              and (locked_until is null or locked_until <= now()) \
            order by next_attempt_at, created_at \
            limit $1 \
            for update skip locked) \
         update webhook_deliveries d set locked_until = now() + make_interval(secs => $2) \
           from due, webhook_events e \
          where d.id = due.id and e.event_id = d.event_id and e.identity_migrated_at is null \
         returning d.id, d.event_id, e.type as event_type, d.target_kind, d.target_id, d.url, d.attempts, \
                   d.manual_replays, d.created_at, d.requeued_at, d.locked_until as lease, e.payload",
    )
    .bind(limit)
    .bind(lease_seconds as f64)
    .fetch_all(pool)
    .await?)
}

/// Seconds from the first attempt to the attempt after `attempts` failures, following
/// [`events::retry_delay_seconds`].
pub fn schedule_elapsed_seconds(attempts: i32) -> i64 {
    (1..=attempts.max(0)).map(events::retry_delay_seconds).sum()
}

/// Telemetry progress of a delivery after an attempt: 1.0 once it is settled (delivered, or
/// failed for good), otherwise the share of its 72 h retry window used so far — since the event
/// was created, or since its last replay (a replay gets a fresh window; one made before
/// `requeued_at` existed is measured along the retry schedule) — capped below 1.0.
pub fn delivery_progress(
    outcome: &DeliveryOutcome,
    d: &ClaimedDelivery,
    now: OffsetDateTime,
) -> f64 {
    match outcome {
        DeliveryOutcome::Delivered { .. } | DeliveryOutcome::Failed { .. } => 1.0,
        DeliveryOutcome::Retrying { .. }
        | DeliveryOutcome::LeaseLost { .. }
        | DeliveryOutcome::Abandoned { .. } => {
            let window = (GIVE_UP_AFTER_HOURS * 3600) as f64;
            let used = match d.requeued_at {
                Some(at) => (now - at).as_seconds_f64(),
                None if d.manual_replays > 0 => {
                    schedule_elapsed_seconds(d.attempts.saturating_add(1)) as f64
                }
                None => (now - d.created_at).as_seconds_f64(),
            };
            (used / window).clamp(0.0, 0.99)
        }
    }
}

/// The receiving end of a delivery as it is configured right now.
#[derive(Debug, Clone)]
struct Target {
    url: Option<String>,
    secret_enc: Option<Vec<u8>>,
    disabled: bool,
}

async fn load_target(
    conn: &mut PgConnection,
    kind: WebhookTargetKind,
    id: &str,
) -> ApiResult<Option<Target>> {
    Ok(match kind {
        WebhookTargetKind::App => {
            let row: Option<(AppStatus, Option<String>, Option<Vec<u8>>)> = sqlx::query_as(
                "select a.status, c.webhook_url, c.webhook_secret_enc from apps a \
                 left join app_signin_configs c on c.app_id = a.app_id where a.app_id = $1",
            )
            .bind(id)
            .fetch_optional(&mut *conn)
            .await?;
            row.map(|(status, url, secret_enc)| Target {
                url,
                secret_enc,
                disabled: status != AppStatus::Active,
            })
        }
        WebhookTargetKind::Silicon => {
            // A Silicon's own webhook is also delivered after it was released or deleted, as long
            // as the endpoint and secret are still stored (e.g. silicon.custodian.declined).
            let row: Option<(Option<String>, Option<Vec<u8>>)> = sqlx::query_as(
                "select webhook_url, webhook_secret_enc from accounts where uuid = $1 and kind = 'silicon'",
            )
            .bind(id)
            .fetch_optional(&mut *conn)
            .await?;
            row.map(|(url, secret_enc)| Target {
                url,
                secret_enc,
                disabled: false,
            })
        }
    })
}

fn describe_target(kind: WebhookTargetKind, id: &str) -> String {
    match kind {
        WebhookTargetKind::App => format!("the app '{id}'"),
        WebhookTargetKind::Silicon => format!("the Silicon {id}"),
    }
}

/// One attempt's result, before it is recorded.
#[derive(Debug, Clone)]
struct Attempt {
    status_code: Option<u16>,
    /// `None` = delivered.
    error: Option<String>,
    /// No retry can succeed (the target is gone or can't sign); fail now.
    permanent: bool,
    duration_ms: i32,
    /// The URL used (or that would have been used).
    url: Option<String>,
}

impl Attempt {
    fn not_sent(error: String, permanent: bool, url: Option<String>) -> Attempt {
        Attempt {
            status_code: None,
            error: Some(truncate(&error, MAX_ERROR_CHARS)),
            permanent,
            duration_ms: 0,
            url,
        }
    }
}

/// Delivers webhooks with its own HTTP client (10 s timeout, no redirects, no proxy, SSRF-guarded
/// DNS). Cheap to clone.
#[derive(Clone)]
pub struct WebhookDeliverer {
    state: AppState,
    client: reqwest::Client,
}

impl fmt::Debug for WebhookDeliverer {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("WebhookDeliverer")
            .field("allow_private", &self.state.settings.webhook_allow_private)
            .finish_non_exhaustive()
    }
}

/// Builds the delivery client. `allow_private = false` turns on the resolver guard.
pub fn build_client(allow_private: bool) -> Result<reqwest::Client, reqwest::Error> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(DELIVERY_TIMEOUT_SECONDS))
        .connect_timeout(Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::none())
        // A proxy would resolve the host itself and bypass the address checks.
        .no_proxy()
        .user_agent(events::USER_AGENT)
        .pool_idle_timeout(Duration::from_secs(30))
        .pool_max_idle_per_host(4)
        .dns_resolver(GuardedResolver { allow_private })
        .build()
}

impl WebhookDeliverer {
    /// A deliverer for the state's settings.
    pub fn new(state: &AppState) -> Result<WebhookDeliverer, reqwest::Error> {
        Ok(WebhookDeliverer {
            client: build_client(state.settings.webhook_allow_private)?,
            state: state.clone(),
        })
    }

    /// One round of the loop: claims up to `limit` due deliveries (at most [`CONCURRENCY`], so
    /// every claimed delivery is attempted at once) and attempts them in parallel; returns what
    /// happened to each. [`run`] does this continuously.
    pub async fn deliver_due(&self, limit: i64) -> ApiResult<Vec<DeliveryOutcome>> {
        self.deliver_due_within(limit, CLAIM_BUDGET).await
    }

    /// [`WebhookDeliverer::deliver_due`] with another claim budget (tests use a short one).
    pub async fn deliver_due_within(
        &self,
        limit: i64,
        budget: Duration,
    ) -> ApiResult<Vec<DeliveryOutcome>> {
        let limit = limit.clamp(0, CONCURRENCY as i64);
        let claimed_at = Instant::now();
        let claimed = claim_due(&self.state.db, limit, LEASE_SECONDS).await?;
        let deadline = claimed_at + budget;
        let results = futures::future::join_all(
            claimed
                .into_iter()
                .map(|d| async move { self.process_logged(&d, deadline).await }),
        )
        .await;
        Ok(results.into_iter().flatten().collect())
    }

    /// Attempts one claimed delivery and records the result (see [`claim_due`]); the attempt
    /// must finish within [`CLAIM_BUDGET`] from now.
    pub async fn deliver_claimed(&self, d: &ClaimedDelivery) -> ApiResult<DeliveryOutcome> {
        self.process(d, Instant::now() + CLAIM_BUDGET).await
    }

    /// [`WebhookDeliverer::process`], logging a failure to process (the delivery is retried
    /// when its lease ends).
    async fn process_logged(
        &self,
        d: &ClaimedDelivery,
        deadline: Instant,
    ) -> Option<DeliveryOutcome> {
        match self.process(d, deadline).await {
            Ok(outcome) => Some(outcome),
            Err(e) => {
                tracing::error!(
                    delivery_id = %d.id,
                    error = %e,
                    "could not process a webhook delivery; it is retried when its lease ends"
                );
                None
            }
        }
    }

    /// Attempts the delivery (abandoned at `deadline`), then records the result. Recording is
    /// not bounded by the deadline: it only lands while this worker still holds the lease.
    async fn process(&self, d: &ClaimedDelivery, deadline: Instant) -> ApiResult<DeliveryOutcome> {
        let attempt = match tokio::time::timeout_at(deadline, self.attempt(d)).await {
            Ok(attempt) => attempt?,
            Err(_) => {
                tracing::error!(
                    delivery_id = %d.id,
                    event_id = %d.event_id,
                    budget_seconds = CLAIM_BUDGET.as_secs(),
                    "webhook attempt did not finish in time (a stalled database?); abandoned before it could outlive its lease, and retried when the lease ends"
                );
                let outcome = DeliveryOutcome::Abandoned { delivery_id: d.id };
                self.observe(d, None, &outcome);
                return Ok(outcome);
            }
        };
        let outcome = self.record(d, &attempt).await?;
        self.observe(d, Some(&attempt), &outcome);
        Ok(outcome)
    }

    async fn attempt(&self, d: &ClaimedDelivery) -> ApiResult<Attempt> {
        let target = {
            let mut conn = self.state.db.acquire().await?;
            load_target(&mut conn, d.target_kind, &d.target_id).await?
        };
        let who = describe_target(d.target_kind, &d.target_id);
        let Some(target) = target else {
            return Ok(Attempt::not_sent(
                format!("Not sent: {who} no longer exists."),
                true,
                None,
            ));
        };
        if target.disabled {
            return Ok(Attempt::not_sent(
                format!(
                    "Not sent: {who} is disabled. Delivery resumes if it is re-enabled within {GIVE_UP_AFTER_HOURS} hours of the event."
                ),
                false,
                target.url,
            ));
        }
        let Some(url) = target.url else {
            return Ok(Attempt::not_sent(
                format!(
                    "Not sent: {who} has no webhook endpoint any more (it was removed after this event was created). Set an endpoint and replay the delivery to send it."
                ),
                true,
                None,
            ));
        };
        let Some(secret_enc) = target.secret_enc else {
            return Ok(Attempt::not_sent(
                format!(
                    "Not sent: {who} has no webhook signing secret, so the event can't be signed. Set the webhook again to get a new secret, then replay the delivery."
                ),
                true,
                Some(url),
            ));
        };
        let secret = match self.state.keys.keyring.decrypt_string(&secret_enc) {
            Ok(s) => s,
            Err(e) => {
                tracing::error!(delivery_id = %d.id, error = %e, "webhook secret could not be decrypted");
                return Ok(Attempt::not_sent(
                    format!(
                        "Not sent: the signing secret of {who} could not be decrypted (its key version may be missing from ACCOUNTS_ENCRYPTION_KEYRING); retrying."
                    ),
                    false,
                    Some(url),
                ));
            }
        };
        let parsed = match check_url(&self.state.settings, &url) {
            Ok(u) => u,
            Err(why) => return Ok(Attempt::not_sent(why, false, Some(url))),
        };
        let body = serde_json::to_vec(&d.payload)?;
        let timestamp = OffsetDateTime::now_utc().unix_timestamp();
        let signature = crypto::webhook_signature(&secret, timestamp, &body);
        let started = Instant::now();
        let sent = self
            .client
            .post(parsed)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .header(events::HEADER_EVENT_ID, d.event_id.to_string())
            .header(events::HEADER_EVENT_TYPE, d.event_type.as_str())
            .header(events::HEADER_DELIVERY_ID, d.id.to_string())
            .header(events::HEADER_TIMESTAMP, timestamp.to_string())
            .header(events::HEADER_SIGNATURE, signature)
            .body(body)
            .send()
            .await;
        let mut attempt = Attempt {
            status_code: None,
            error: None,
            permanent: false,
            duration_ms: 0,
            url: Some(url),
        };
        match sent {
            Ok(response) => {
                let status = response.status();
                attempt.status_code = Some(status.as_u16());
                if !status.is_success() {
                    let location = response
                        .headers()
                        .get(reqwest::header::LOCATION)
                        .and_then(|v| v.to_str().ok())
                        .map(str::to_string);
                    let snippet = read_snippet(response).await;
                    attempt.error = Some(truncate(
                        &describe_status(status, location.as_deref(), &snippet),
                        MAX_ERROR_CHARS,
                    ));
                }
            }
            Err(e) => {
                if let Some(blocked) = find_source::<BlockedAddress>(&e) {
                    // The stored error leaves the addresses out (app owners read it); the log
                    // keeps them for whoever runs the service.
                    tracing::warn!(
                        delivery_id = %d.id,
                        host = %blocked.host,
                        refused_address = ?blocked.ip,
                        lookup_error = ?blocked.lookup_error,
                        "webhook not sent: the SSRF guard refused its host"
                    );
                }
                attempt.error = Some(truncate(&describe_send_error(&e), MAX_ERROR_CHARS));
            }
        }
        attempt.duration_ms = i32::try_from(started.elapsed().as_millis()).unwrap_or(i32::MAX);
        Ok(attempt)
    }

    async fn record(&self, d: &ClaimedDelivery, a: &Attempt) -> ApiResult<DeliveryOutcome> {
        let mut tx = self.state.db.begin().await?;
        sqlx::query(
            "insert into webhook_attempts (delivery_id, status_code, error, duration_ms) values ($1, $2, $3, $4)",
        )
        .bind(d.id)
        .bind(a.status_code.map(i32::from))
        .bind(&a.error)
        .bind(a.duration_ms)
        .execute(&mut *tx)
        .await?;
        let outcome = match &a.error {
            None => {
                let updated = sqlx::query(
                    "update webhook_deliveries set status = 'delivered', attempts = attempts + 1, \
                       last_attempt_at = now(), last_status = $2, last_error = null, delivered_at = now(), \
                       locked_until = null, url = coalesce($3, url) \
                     where id = $1 and status = 'pending' and locked_until = $4",
                )
                .bind(d.id)
                .bind(a.status_code.map(i32::from))
                .bind(&a.url)
                .bind(d.lease)
                .execute(&mut *tx)
                .await?
                .rows_affected();
                if updated == 0 {
                    DeliveryOutcome::LeaseLost { delivery_id: d.id }
                } else {
                    DeliveryOutcome::Delivered {
                        delivery_id: d.id,
                        status: a.status_code.unwrap_or(200),
                    }
                }
            }
            Some(error) => {
                let attempts_after = d.attempts.saturating_add(1);
                let delay = events::retry_delay_seconds(attempts_after);
                // A replay restarts the 72 h window from `requeued_at`; a replay made before that
                // column existed (no timestamp) is measured along the retry schedule.
                let replay_window_over = d.manual_replays > 0
                    && d.requeued_at.is_none()
                    && schedule_elapsed_seconds(attempts_after) > GIVE_UP_AFTER_HOURS * 3600;
                let row: Option<(String, OffsetDateTime)> = sqlx::query_as(
                    "with cur as ( \
                       select id, ($5 or $6 or ((manual_replays = 0 or requeued_at is not null) and \
                                   now() + make_interval(secs => $7) > coalesce(requeued_at, created_at) + make_interval(hours => $8))) as give_up \
                         from webhook_deliveries \
                        where id = $1 and status = 'pending' and locked_until = $9 \
                        for update) \
                     update webhook_deliveries w set attempts = w.attempts + 1, last_attempt_at = now(), \
                       last_status = $2, last_error = $3, url = coalesce($4, w.url), locked_until = null, \
                       status = case when cur.give_up then 'failed' else 'pending' end, \
                       next_attempt_at = case when cur.give_up then w.next_attempt_at \
                                              else now() + make_interval(secs => $7) end \
                      from cur where w.id = cur.id \
                     returning w.status, w.next_attempt_at",
                )
                .bind(d.id)
                .bind(a.status_code.map(i32::from))
                .bind(error)
                .bind(&a.url)
                .bind(a.permanent)
                .bind(replay_window_over)
                .bind(delay as f64)
                .bind(GIVE_UP_AFTER_HOURS as i32)
                .bind(d.lease)
                .fetch_optional(&mut *tx)
                .await?;
                match row {
                    None => DeliveryOutcome::LeaseLost { delivery_id: d.id },
                    Some((status, _)) if status == "failed" => DeliveryOutcome::Failed {
                        delivery_id: d.id,
                        status: a.status_code,
                        error: error.clone(),
                    },
                    Some((_, next_attempt_at)) => DeliveryOutcome::Retrying {
                        delivery_id: d.id,
                        status: a.status_code,
                        error: error.clone(),
                        next_attempt_at,
                    },
                }
            }
        };
        tx.commit().await?;
        Ok(outcome)
    }

    /// Logs the outcome and records the `webhook.<outcome>` telemetry event. `a` is `None` when
    /// the attempt was abandoned.
    fn observe(&self, d: &ClaimedDelivery, a: Option<&Attempt>, outcome: &DeliveryOutcome) {
        let status_code = a.and_then(|a| a.status_code);
        let duration_ms = a.map(|a| a.duration_ms);
        let (name, outcome_label) = match outcome {
            DeliveryOutcome::Delivered { .. } => {
                tracing::info!(
                    delivery_id = %d.id, event_id = %d.event_id, event_type = %d.event_type,
                    target = %describe_target(d.target_kind, &d.target_id), attempt = d.attempts + 1,
                    status = ?status_code, duration_ms = ?duration_ms, "webhook delivered"
                );
                ("webhook.delivered", "delivered")
            }
            DeliveryOutcome::Retrying {
                error,
                next_attempt_at,
                ..
            } => {
                tracing::warn!(
                    delivery_id = %d.id, event_id = %d.event_id, event_type = %d.event_type,
                    target = %describe_target(d.target_kind, &d.target_id), attempt = d.attempts + 1,
                    status = ?status_code, error = %error,
                    next_attempt_at = %accounts_core::timefmt::format_rfc3339_ms(*next_attempt_at),
                    "webhook delivery failed; will retry"
                );
                ("webhook.retrying", "retrying")
            }
            DeliveryOutcome::Failed { error, .. } => {
                tracing::warn!(
                    delivery_id = %d.id, event_id = %d.event_id, event_type = %d.event_type,
                    target = %describe_target(d.target_kind, &d.target_id), attempt = d.attempts + 1,
                    status = ?status_code, error = %error,
                    "webhook delivery failed for good; it can be replayed"
                );
                ("webhook.failed", "failed")
            }
            DeliveryOutcome::LeaseLost { .. } => {
                tracing::warn!(
                    delivery_id = %d.id,
                    "webhook delivery lease ran out before its result was recorded; another worker owns it now"
                );
                ("webhook.lease_lost", "lease_lost")
            }
            // Logged where it happened.
            DeliveryOutcome::Abandoned { .. } => ("webhook.abandoned", "abandoned"),
        };
        self.state.telemetry.record_progress(
            "worker",
            "webhook_delivery",
            name,
            Some(delivery_progress(outcome, d, OffsetDateTime::now_utc())),
            json!({
                "outcome": outcome_label,
                "target_kind": d.target_kind,
                "event_type": d.event_type,
                "attempt": d.attempts + 1,
                "manual_replays": d.manual_replays,
                "status_code": status_code,
                "duration_ms": duration_ms,
            }),
        );
    }
}

/// The URL rules at delivery time: always http(s) without credentials; with
/// ACCOUNTS_WEBHOOK_ALLOW_PRIVATE=false only https to non-local hosts and public literal IPs
/// (core's `normalize::validate_webhook_url`, which judges literal IPs with
/// [`is_deliverable_ip`]); host names are checked again by [`GuardedResolver`] when connecting.
pub fn check_url(settings: &Settings, raw: &str) -> Result<reqwest::Url, String> {
    match normalize::validate_webhook_url(settings, raw) {
        Ok(u) => Ok(u),
        Err(why) if settings.webhook_allow_private => {
            Err(format!("Not sent: the webhook URL is invalid: {why}."))
        }
        Err(why) => Err(format!(
            "Not sent: refused by the SSRF guard (ACCOUNTS_WEBHOOK_ALLOW_PRIVATE=false): {why}."
        )),
    }
}

/// True when a webhook may be sent to `ip` while private targets are refused: core's
/// [`normalize::is_public_ip`], the one rule shared by URL validation (when a URL is set) and
/// delivery (literal IPs and every resolved address). IPv4-mapped, NAT64 and 6to4 addresses
/// count as the IPv4 address they carry; other IPv6 outside global unicast, Teredo, ORCHID,
/// benchmarking and documentation ranges are refused.
pub fn is_deliverable_ip(ip: IpAddr) -> bool {
    normalize::is_public_ip(ip)
}

async fn read_snippet(mut response: reqwest::Response) -> String {
    let mut buf: Vec<u8> = Vec::new();
    while buf.len() < RESPONSE_SNIPPET_BYTES {
        match response.chunk().await {
            Ok(Some(chunk)) => buf.extend_from_slice(&chunk),
            Ok(None) | Err(_) => break,
        }
    }
    buf.truncate(RESPONSE_SNIPPET_BYTES);
    let text = String::from_utf8_lossy(&buf);
    text.chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn describe_status(status: reqwest::StatusCode, location: Option<&str>, snippet: &str) -> String {
    let reason = status.canonical_reason().unwrap_or("");
    let code = status.as_u16();
    let head = if reason.is_empty() {
        format!("HTTP {code}")
    } else {
        format!("HTTP {code} {reason}")
    };
    if status.is_redirection() {
        return match location {
            Some(to) => format!(
                "{head}: the endpoint redirected to {to}, and redirects are not followed. Set the webhook URL to the final address."
            ),
            None => format!(
                "{head}: the endpoint answered with a redirect, and redirects are not followed. Set the webhook URL to the final address."
            ),
        };
    }
    if snippet.is_empty() {
        format!(
            "{head}: the endpoint must answer with a 2xx status within {DELIVERY_TIMEOUT_SECONDS} seconds."
        )
    } else {
        format!(
            "{head}: the endpoint must answer with a 2xx status within {DELIVERY_TIMEOUT_SECONDS} seconds. Response body: {snippet}"
        )
    }
}

fn describe_send_error(e: &reqwest::Error) -> String {
    if let Some(blocked) = find_source::<BlockedAddress>(e) {
        return format!(
            "Not sent: refused by the SSRF guard (ACCOUNTS_WEBHOOK_ALLOW_PRIVATE=false): {blocked}. Point the webhook at a public https URL; the next retry uses it."
        );
    }
    if let Some(lookup) = find_source::<LookupFailed>(e) {
        return format!("Could not connect: {lookup}.");
    }
    if e.is_timeout() {
        return format!(
            "No response within {DELIVERY_TIMEOUT_SECONDS} seconds: the endpoint must answer with a 2xx status within {DELIVERY_TIMEOUT_SECONDS} seconds (do slow work after answering)."
        );
    }
    let root = root_cause(e);
    if e.is_connect() {
        format!("Could not connect to the endpoint: {root}.")
    } else {
        format!("The request failed: {root}.")
    }
}

fn find_source<'a, T: std::error::Error + 'static>(
    e: &'a (dyn std::error::Error + 'static),
) -> Option<&'a T> {
    let mut current: Option<&(dyn std::error::Error + 'static)> = Some(e);
    while let Some(err) = current {
        if let Some(found) = err.downcast_ref::<T>() {
            return Some(found);
        }
        current = err.source();
    }
    None
}

fn root_cause(e: &(dyn std::error::Error + 'static)) -> String {
    let mut current: &(dyn std::error::Error + 'static) = e;
    while let Some(next) = current.source() {
        current = next;
    }
    current.to_string()
}

fn truncate(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        s.to_string()
    } else {
        let mut out: String = s.chars().take(max_chars.saturating_sub(1)).collect();
        out.push('…');
        out
    }
}

/// The SSRF guard's resolver and its refusals live in core (`normalize`), shared with URL
/// validation; re-exported here for the delivery client.
pub use accounts_core::normalize::{BlockedAddress, LookupFailed, resolve_checked};

/// The delivery client's DNS resolver: plain system resolution plus, when private targets are
/// not allowed, a refusal of any host that has an address that isn't deliverable. Because the
/// connector uses exactly the addresses returned here, the check can't be bypassed by DNS
/// rebinding.
#[derive(Debug, Clone, Copy)]
pub struct GuardedResolver {
    pub allow_private: bool,
}

impl reqwest::dns::Resolve for GuardedResolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let host = name.as_str().to_string();
        let allow_private = self.allow_private;
        Box::pin(async move {
            let addrs = resolve_checked(&host, allow_private).await?;
            Ok(Box::new(addrs.into_iter()) as reqwest::dns::Addrs)
        })
    }
}

/// The webhook loop: claims and delivers until `shutdown` triggers, then lets the attempts in
/// flight finish (at most about one 10 s attempt timeout).
pub async fn run(deliverer: WebhookDeliverer, shutdown: Shutdown) {
    tracing::info!(
        allow_private = deliverer.state.settings.webhook_allow_private,
        concurrency = CONCURRENCY,
        "webhook delivery started"
    );
    let db = deliverer.state.db.clone();
    let worker = deliverer.clone();
    Pipeline {
        name: "webhooks",
        concurrency: CONCURRENCY,
        idle_poll: IDLE_POLL,
        error_backoff: ERROR_BACKOFF,
    }
    .run(
        shutdown,
        move |free| {
            let db = db.clone();
            async move { claim_due(&db, free as i64, LEASE_SECONDS).await }
        },
        move |d: ClaimedDelivery, claimed_at| {
            let worker = worker.clone();
            async move {
                worker
                    .process_logged(&d, pipeline::deadline(claimed_at))
                    .await;
            }
        },
    )
    .await;
    tracing::info!("webhook delivery stopped");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schedule_covers_72_hours_in_78_attempts() {
        assert_eq!(schedule_elapsed_seconds(0), 0);
        assert_eq!(schedule_elapsed_seconds(1), 10);
        assert_eq!(schedule_elapsed_seconds(6), 10 + 30 + 60 + 300 + 900 + 1800);
        let window = GIVE_UP_AFTER_HOURS * 3600;
        assert!(schedule_elapsed_seconds(77) <= window);
        assert!(schedule_elapsed_seconds(78) > window);
    }

    #[test]
    fn status_descriptions_are_precise() {
        let s = describe_status(reqwest::StatusCode::INTERNAL_SERVER_ERROR, None, "boom");
        assert!(s.starts_with("HTTP 500 Internal Server Error"), "{s}");
        assert!(s.contains("Response body: boom"), "{s}");
        let r = describe_status(
            reqwest::StatusCode::MOVED_PERMANENTLY,
            Some("https://x.example/hooks"),
            "",
        );
        assert!(r.contains("redirected to https://x.example/hooks"), "{r}");
        assert!(r.contains("not followed"), "{r}");
    }

    #[test]
    fn truncation_keeps_char_boundaries() {
        assert_eq!(truncate("abc", 5), "abc");
        assert_eq!(truncate("ééééé", 3), "éé…");
    }

    /// Text an app owner may read must not reveal what a host resolved to.
    fn assert_no_address(text: &str) {
        for leak in [
            "127.0.0.1",
            "::1",
            "127.",
            "resolves to ::",
            "could not be resolved",
        ] {
            assert!(!text.contains(leak), "'{leak}' leaked into: {text}");
        }
    }

    #[tokio::test]
    async fn resolver_refuses_loopback_unless_private_is_allowed() {
        let err = resolve_checked("localhost", false)
            .await
            .expect_err("localhost resolves to loopback");
        let blocked = err
            .downcast_ref::<BlockedAddress>()
            .expect("a BlockedAddress error");
        assert!(blocked.ip.is_some_and(|ip| ip.is_loopback()));
        let text = blocked.to_string();
        assert!(text.contains("'localhost' has no public address"), "{text}");
        assert_no_address(&text);
        let ok = resolve_checked("localhost", true)
            .await
            .expect("allowed in development");
        assert!(!ok.is_empty());
    }

    #[tokio::test]
    async fn an_unresolvable_name_reads_like_a_private_one_under_the_guard() {
        // `.invalid` never resolves (RFC 6761).
        let err = resolve_checked("no-such-host.invalid", false)
            .await
            .expect_err("does not resolve");
        let blocked = err
            .downcast_ref::<BlockedAddress>()
            .expect("a BlockedAddress error");
        assert!(blocked.ip.is_none() && blocked.lookup_error.is_some());
        let loopback = resolve_checked("localhost", false)
            .await
            .expect_err("loopback")
            .to_string();
        assert_eq!(
            blocked
                .to_string()
                .replace("no-such-host.invalid", "localhost"),
            loopback,
            "the two refusals must be indistinguishable"
        );
        // In development the precise reason is fine.
        let dev = resolve_checked("no-such-host.invalid", true)
            .await
            .expect_err("does not resolve");
        assert!(dev.to_string().contains("could not be resolved"), "{dev}");
    }

    #[test]
    fn deliverable_addresses() {
        let refused = [
            "10.0.0.1",
            "127.0.0.1",
            "169.254.169.254",
            "100.64.0.1",
            "0.0.0.0",
            "192.0.2.1",
            "198.18.0.1",
            "224.0.0.1",
            "255.255.255.255",
            "::",
            "::1",
            "::127.0.0.1",        // IPv4-compatible loopback
            "::a00:1",            // IPv4-compatible 10.0.0.1
            "::ffff:127.0.0.1",   // IPv4-mapped loopback
            "::ffff:0:7f00:1",    // IPv4-translated (SIIT) loopback
            "64:ff9b::a9fe:a9fe", // NAT64 of 169.254.169.254
            "64:ff9b::a00:1",     // NAT64 of 10.0.0.1
            "64:ff9b:1::808:808", // local-use NAT64 prefix
            "2002:7f00:1::",      // 6to4 of 127.0.0.1
            "2002:a00:1::1",      // 6to4 of 10.0.0.1
            "2001::1",            // Teredo
            "2001:2::1",          // benchmarking
            "2001:10::1",         // ORCHID
            "2001:20::1",         // ORCHIDv2
            "2001:db8::1",        // documentation
            "3fff::1",            // documentation (RFC 9637)
            "100::1",             // discard-only
            "5f00::1",            // SRv6 SIDs
            "fc00::1",            // unique-local
            "fd12:3456::1",       // unique-local
            "fe80::1",            // link-local
            "fec0::1",            // site-local (deprecated)
            "ff02::1",            // multicast
        ];
        for ip in refused {
            let parsed: IpAddr = ip.parse().expect(ip);
            assert!(!is_deliverable_ip(parsed), "{ip} must be refused");
        }
        let allowed = [
            "8.8.8.8",
            "1.1.1.1",
            "2606:4700:4700::1111",
            "2001:4860:4860::8888",
            "2a00:1450:4001::64",
            "64:ff9b::808:808", // NAT64 of 8.8.8.8
            "::ffff:8.8.8.8",   // IPv4-mapped 8.8.8.8
            "2002:808:808::1",  // 6to4 of 8.8.8.8
        ];
        for ip in allowed {
            let parsed: IpAddr = ip.parse().expect(ip);
            assert!(is_deliverable_ip(parsed), "{ip} must be allowed");
        }
    }

    #[test]
    fn delivery_progress_tracks_the_retry_window() {
        let now = OffsetDateTime::now_utc();
        let d = |created_hours_ago: i64, attempts: i32, manual_replays: i32| ClaimedDelivery {
            id: Uuid::now_v7(),
            event_id: Uuid::now_v7(),
            event_type: "ping".into(),
            target_kind: WebhookTargetKind::App,
            target_id: "app".into(),
            url: "https://hooks.example.com".into(),
            attempts,
            manual_replays,
            created_at: now - time::Duration::hours(created_hours_ago),
            requeued_at: None,
            lease: now,
            payload: Value::Null,
        };
        let retrying = DeliveryOutcome::Retrying {
            delivery_id: Uuid::nil(),
            status: Some(500),
            error: "HTTP 500".into(),
            next_attempt_at: now,
        };
        let delivered = DeliveryOutcome::Delivered {
            delivery_id: Uuid::nil(),
            status: 200,
        };
        assert_eq!(delivery_progress(&delivered, &d(0, 0, 0), now), 1.0);
        assert_eq!(delivery_progress(&retrying, &d(0, 0, 0), now), 0.0);
        assert!((delivery_progress(&retrying, &d(36, 5, 0), now) - 0.5).abs() < 1e-9);
        assert_eq!(delivery_progress(&retrying, &d(100, 5, 0), now), 0.99);
        // A replay of an old event starts a fresh window, from the replay...
        let replayed = ClaimedDelivery {
            requeued_at: Some(now - time::Duration::hours(18)),
            ..d(100, 3, 1)
        };
        assert!((delivery_progress(&retrying, &replayed, now) - 0.25).abs() < 1e-9);
        // ...or, for a replay made before the replay time was stored, along the schedule.
        let replay = delivery_progress(&retrying, &d(100, 0, 1), now);
        assert!(replay > 0.0 && replay < 0.01, "{replay}");
    }

    #[test]
    fn url_check_follows_the_private_setting() {
        let mut s = Settings::for_tests();
        s.webhook_allow_private = true;
        assert!(check_url(&s, "http://127.0.0.1:9/x").is_ok());
        assert!(check_url(&s, "https://[64:ff9b::a00:1]/x").is_ok());
        assert!(
            check_url(&s, "ftp://example.com/x")
                .expect_err("scheme")
                .contains("invalid")
        );
        s.webhook_allow_private = false;
        let e = check_url(&s, "http://example.com/x").expect_err("https only");
        assert!(e.contains("SSRF guard") && e.contains("https"), "{e}");
        let e = check_url(&s, "https://10.1.2.3/x").expect_err("private literal");
        assert!(e.contains("private or reserved IP"), "{e}");
        let e = check_url(&s, "https://[::1]/x").expect_err("loopback v6");
        assert!(e.contains("private or reserved IP"), "{e}");
        let e = check_url(&s, "https://localhost/x").expect_err("local name");
        assert!(e.contains("local host"), "{e}");
        for url in [
            "https://[64:ff9b::a9fe:a9fe]/x",
            "https://[64:ff9b::a00:1]/x",
            "https://[::127.0.0.1]/x",
            "https://[::ffff:0:7f00:1]/x",
            "https://[2002:7f00:1::]/x",
            "https://[::ffff:127.0.0.1]/x",
            "https://[2001::1]/x",
            "https://[fec0::1]/x",
            "https://0x7f.1/x",
            "https://2130706433/x",
            "https://127.0.0.1./x",
        ] {
            let e = check_url(&s, url).expect_err(url);
            assert!(
                e.contains("SSRF guard") && e.contains("private or reserved IP"),
                "{url}: {e}"
            );
        }
        assert!(check_url(&s, "https://hooks.example.com/x").is_ok());
        assert!(check_url(&s, "https://[2606:4700:4700::1111]/x").is_ok());
        assert!(check_url(&s, "https://[64:ff9b::808:808]/x").is_ok());
        assert!(check_url(&s, "https://8.8.8.8/x").is_ok());
    }
}
