//! `GET /v1/events/stream`: account events as Server-Sent Events.
//!
//! Who gets which feed:
//!
//! | caller | feed |
//! |---|---|
//! | an app (`Authorization: Basic`) | the events recorded for its stream subscription: the same bodies its webhook gets, filtered by the updates the subscription picked (no stream subscription: 409 `stream_subscription_required`) |
//! | a Silicon (bearer token or session) | its own Silicon events (custodian decisions, changes to its account, ...) |
//! | a Carbon (bearer token or session) | the Silicon events of the Silicons it is custodian of |
//! | a self-created Silicon waiting for its custodian (`Authorization: Bearer sarq_…`) | its own Silicon events; the stream ends after the custodian's decision (`request_decided`) |
//!
//! Frames: `retry: 5000` first; then per event `id: <event_id>`, `event: <type>`,
//! `data: <the webhook body>`; a `: heartbeat` comment after 15 seconds without events; and
//! before the server ends a stream, `event: stream.closed` with `{"reason","message"}`
//! (`token_expired`, `access_removed`, `subscription_deleted`, `request_decided`,
//! `max_duration`, `server_restarting`). Reconnect with `Last-Event-ID` (or `?after=`) and
//! nothing is skipped: delivery is at least once, dedupe on `event_id`. `?types=a,b` keeps only
//! those event types.
//!
//! **Order and resume.** Events are read from `webhook_events` in `(tx_id, event_id)` order and
//! only below the oldest transaction still running (`pg_snapshot_xmin`), so an event whose
//! transaction commits late is never passed over. A new stream (no cursor) starts with the
//! events of transactions still running when it opened.
//!
//! **Load.** Each stream polls its feed once a second with one indexed query, holding a pooled
//! connection only for that query, and reads the next batch (at most 100 events) only after the
//! client took the last one, so a slow reader never piles events up in memory. At most
//! [`MAX_STREAMS_PER_CALLER`] streams per app or account and [`MAX_STREAMS_PER_NODE`] per API
//! node (429 `too_many_streams` / 503 `stream_capacity_reached`, both with `Retry-After`).
//! Credentials are checked again every 30 seconds, a bearer stream ends when its token
//! expires, and every stream ends after an hour so connections move between nodes.

use std::collections::{HashMap, VecDeque};
use std::convert::Infallible;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use accounts_core::events::{APP_EVENT_TYPES, SILICON_EVENT_TYPES};
use accounts_core::http::cookies::read_cookie;
use accounts_core::http::{AccountAuth, AuthVia, Query, SESSION_COOKIE};
use accounts_core::models::{AccountKind, App, SubscriptionDelivery};
use accounts_core::repo::{sessions, subscriptions, tokens};
use accounts_core::{ApiError, AppState};
use axum::Extension;
use axum::extract::{FromRequestParts, State};
use axum::http::header::AUTHORIZATION;
use axum::http::request::Parts;
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use futures::Stream;
use serde::Deserialize;
use serde_json::{Value, json};
use time::OffsetDateTime;
use tokio::sync::watch;
use tokio::time::Instant;
use uuid::Uuid;

/// Open streams one app or account may have on one API node.
pub const MAX_STREAMS_PER_CALLER: usize = 5;
/// Open streams one API node serves at once.
pub const MAX_STREAMS_PER_NODE: usize = 500;
/// Events read per query.
const BATCH: i64 = 100;
/// The reconnect delay clients are told (`retry:`).
pub const RETRY: Duration = Duration::from_secs(5);
/// Most event types one `?types=` may name.
const MAX_TYPES: usize = 20;

/// How often a stream polls, sends heartbeats and checks its credentials, and how long it lives.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Timing {
    pub poll: Duration,
    pub heartbeat: Duration,
    pub recheck: Duration,
    pub max_duration: Duration,
}

impl Timing {
    /// Production timing: poll every second, heartbeat after 15 s of quiet, credentials every
    /// 30 s, at most an hour per stream.
    pub const STANDARD: Timing = Timing {
        poll: Duration::from_secs(1),
        heartbeat: Duration::from_secs(15),
        recheck: Duration::from_secs(30),
        max_duration: Duration::from_secs(3600),
    };
}

/// The open streams of one API node: counts per caller, the timing, and the switch that ends
/// them all when the server shuts down (so a graceful stop never waits on a stream).
#[derive(Clone)]
pub struct StreamHub {
    inner: Arc<HubInner>,
}

struct HubInner {
    closing: watch::Sender<bool>,
    open: Mutex<HashMap<String, usize>>,
    timing: Timing,
}

impl Default for StreamHub {
    fn default() -> Self {
        StreamHub::new()
    }
}

impl std::fmt::Debug for StreamHub {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StreamHub")
            .field("open", &self.open_streams())
            .field("timing", &self.inner.timing)
            .finish()
    }
}

impl StreamHub {
    /// A hub with the production timing.
    pub fn new() -> StreamHub {
        StreamHub::with_timing(Timing::STANDARD)
    }

    /// A hub with other timing (tests).
    pub fn with_timing(timing: Timing) -> StreamHub {
        let (closing, _) = watch::channel(false);
        StreamHub {
            inner: Arc::new(HubInner {
                closing,
                open: Mutex::new(HashMap::new()),
                timing,
            }),
        }
    }

    /// Ends every open stream (`stream.closed` with `server_restarting`) and refuses new ones.
    pub fn close_all(&self) {
        self.inner.closing.send_replace(true);
    }

    /// Streams open right now.
    pub fn open_streams(&self) -> usize {
        self.inner
            .open
            .lock()
            .map(|m| m.values().sum())
            .unwrap_or(0)
    }

    fn acquire(&self, key: String) -> Result<Permit, ApiError> {
        if *self.inner.closing.borrow() {
            return Err(ApiError::unavailable(
                "stream_capacity_reached",
                "This Silicon Accounts server is restarting, so it opens no new event streams.",
            )
            .hint("Reconnect in a few seconds with Last-Event-ID; another server takes the stream.")
            .retry_after(RETRY.as_secs()));
        }
        let mut open = self
            .inner
            .open
            .lock()
            .map_err(|_| ApiError::internal("stream hub lock poisoned"))?;
        let total: usize = open.values().sum();
        if total >= MAX_STREAMS_PER_NODE {
            return Err(ApiError::unavailable(
                "stream_capacity_reached",
                format!("This Silicon Accounts server already serves {MAX_STREAMS_PER_NODE} event streams."),
            )
            .hint("Reconnect in a little while with Last-Event-ID, or read deliveries from your webhook meanwhile.")
            .retry_after(30));
        }
        let count = open.entry(key.clone()).or_insert(0);
        if *count >= MAX_STREAMS_PER_CALLER {
            return Err(ApiError::new(
                StatusCode::TOO_MANY_REQUESTS,
                "too_many_streams",
                format!(
                    "You already have {MAX_STREAMS_PER_CALLER} event streams open, the most one app or account may have at once."
                ),
            )
            .hint("Close a stream you no longer read (one stream carries every event of your feed), then retry.")
            .retry_after(10));
        }
        *count += 1;
        Ok(Permit {
            hub: self.clone(),
            key,
        })
    }
}

/// One open stream's place in the hub; freed when the stream ends or the client goes away.
struct Permit {
    hub: StreamHub,
    key: String,
}

impl Drop for Permit {
    fn drop(&mut self) {
        if let Ok(mut open) = self.hub.inner.open.lock()
            && let Some(count) = open.get_mut(&self.key)
        {
            *count = count.saturating_sub(1);
            if *count == 0 {
                open.remove(&self.key);
            }
        }
    }
}

/// Who opened the stream.
pub enum Caller {
    /// An app with its Basic credentials.
    App { app: Box<App>, secret: String },
    /// A signed-in Carbon or Silicon.
    Account {
        auth: Box<AccountAuth>,
        credential: AccountCredential,
    },
    /// A self-created Silicon with its `sarq_` request token.
    Request {
        silicon_uuid: String,
        request_id: Uuid,
    },
}

/// What an account stream re-checks.
pub enum AccountCredential {
    /// A bearer access token and its expiry (unix seconds).
    Bearer { token: String, exp: i64 },
    /// The account site's session cookie.
    Cookie { cookie: String },
}

fn no_credentials() -> ApiError {
    ApiError::unauthenticated(
        "unauthenticated",
        "The event stream needs credentials: an app's Authorization: Basic base64(app_id:app_secret), a Carbon's or Silicon's Authorization: Bearer access token, or a waiting Silicon's Bearer sarq_ request token.",
    )
    .hint("Silicons: sign in with `silicon-accounts login --silicon si:<handle> --stk-stdin` and send the access token. Apps: send your app credentials and create a stream subscription first.")
}

impl FromRequestParts<AppState> for Caller {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, ApiError> {
        let header = parts
            .headers
            .get(AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .map(str::trim)
            .map(str::to_owned);
        if let Some(raw) = &header {
            let (scheme, rest) = raw
                .split_once(' ')
                .map(|(s, r)| (s, r.trim()))
                .unwrap_or((raw.as_str(), ""));
            if scheme.eq_ignore_ascii_case("basic") {
                let (id, secret) = accounts_core::http::auth::basic_credentials(&parts.headers)
                    .map_err(|m| {
                        ApiError::unauthenticated("invalid_app_credentials", m)
                            .hint("Send Authorization: Basic base64(app_id:app_secret).")
                    })?
                    .ok_or_else(no_credentials)?;
                let app = state
                    .app_cache
                    .verify(&state.db, &state.keys.pepper, &id, &secret)
                    .await
                    .map_err(|e| e.to_api())?;
                return Ok(Caller::App {
                    app: Box::new(app),
                    secret,
                });
            }
            if scheme.eq_ignore_ascii_case("bearer")
                && rest.starts_with(accounts_core::crypto::prefix::SILICON_REQUEST)
            {
                let hash = state.keys.pepper.hash(rest);
                let row: Option<(Uuid, String)> = sqlx::query_as(
                    "select id, silicon_uuid from custodian_requests \
                     where request_token_hash = $1 and kind = 'initial'",
                )
                .bind(&hash)
                .fetch_optional(&state.db)
                .await?;
                let (request_id, silicon_uuid) = row.ok_or_else(|| {
                    ApiError::unauthenticated(
                        "invalid_request_token",
                        "This sarq_ request token doesn't belong to any custodian request.",
                    )
                    .hint("Use the request_token from the same POST /v1/silicons response. Once your custodian accepted, sign in with your STK instead.")
                })?;
                return Ok(Caller::Request {
                    silicon_uuid,
                    request_id,
                });
            }
        }
        let auth =
            <Option<AccountAuth> as FromRequestParts<AppState>>::from_request_parts(parts, state)
                .await?
                .ok_or_else(no_credentials)?;
        let credential = match &auth.via {
            AuthVia::Bearer { claims, .. } => AccountCredential::Bearer {
                token: header
                    .as_deref()
                    .and_then(|h| h.split_once(' '))
                    .map(|(_, t)| t.trim().to_string())
                    .unwrap_or_default(),
                exp: claims.exp,
            },
            AuthVia::Session { .. } => AccountCredential::Cookie {
                cookie: read_cookie(&parts.headers, &state.settings, SESSION_COOKIE)
                    .unwrap_or_default(),
            },
        };
        Ok(Caller::Account {
            auth: Box::new(auth),
            credential,
        })
    }
}

/// Which events a stream carries.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Feed {
    /// An app's stream subscription.
    App {
        app_id: String,
        subscription_id: Uuid,
    },
    /// One Silicon's own events.
    Silicon { uuid: String },
    /// The Silicon events of every Silicon a Carbon is custodian of.
    Custodian { carbon_uuid: String },
}

impl Feed {
    /// The SQL condition on `webhook_events e` selecting this feed (`$1` = [`Feed::key`]).
    fn condition(&self) -> &'static str {
        match self {
            Feed::App { .. } => "e.subscription_id = $1::uuid",
            Feed::Silicon { .. } => "e.target_kind = 'silicon' and e.target_id = $1",
            Feed::Custodian { .. } => {
                "e.target_kind = 'silicon' and e.target_id in \
                 (select a.uuid::text from accounts a where a.kind = 'silicon' and a.custodian_uuid = $1)"
            }
        }
    }

    fn key(&self) -> String {
        match self {
            Feed::App {
                subscription_id, ..
            } => subscription_id.to_string(),
            Feed::Silicon { uuid } => uuid.clone(),
            Feed::Custodian { carbon_uuid } => carbon_uuid.clone(),
        }
    }

    fn event_types(&self) -> &'static [&'static str] {
        match self {
            Feed::App { .. } => APP_EVENT_TYPES,
            Feed::Silicon { .. } | Feed::Custodian { .. } => SILICON_EVENT_TYPES,
        }
    }

    fn kind(&self) -> &'static str {
        match self {
            Feed::App { .. } => "app",
            Feed::Silicon { .. } => "silicon",
            Feed::Custodian { .. } => "custodian",
        }
    }
}

/// A position in a feed: after the event `(tx_id, event_id)`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Cursor {
    tx: u64,
    id: Uuid,
}

/// `?after=&types=`.
#[derive(Debug, Default, Deserialize)]
pub struct StreamQuery {
    /// Resume after this event id (`Last-Event-ID` wins when both are sent).
    pub after: Option<String>,
    /// Comma-separated event types to keep.
    pub types: Option<String>,
}

fn unknown_event(raw: &str) -> ApiError {
    let shown: String = raw.chars().take(80).collect();
    ApiError::bad_request(
        "unknown_event_id",
        format!("'{shown}' is not an event of this stream, so there is nowhere to resume from."),
    )
    .hint("Resume with the id of the last event this stream sent you (Last-Event-ID or ?after=), or connect without one to start with new events.")
}

fn stream_subscription_required(app_id: &str) -> ApiError {
    ApiError::conflict(
        "stream_subscription_required",
        format!("The app '{app_id}' has no stream subscription, so no events are kept for its stream."),
    )
    .hint(format!(
        "Create one with POST /v1/apps/{app_id}/subscriptions {{\"delivery\":\"stream\"}} (pick its updates there), then open the stream again."
    ))
}

fn parse_types(raw: Option<&str>, feed: &Feed) -> Result<Option<Vec<String>>, ApiError> {
    let Some(raw) = raw.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    let wanted: Vec<String> = raw
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    let allowed = feed.event_types();
    let unknown: Vec<&str> = wanted
        .iter()
        .map(String::as_str)
        .filter(|t| !allowed.contains(t))
        .collect();
    if wanted.len() > MAX_TYPES || !unknown.is_empty() {
        return Err(ApiError::bad_request(
            "invalid_query",
            if unknown.is_empty() {
                format!("The query parameter 'types' names more than {MAX_TYPES} event types.")
            } else {
                format!(
                    "The query parameter 'types' names {}, which this stream never carries.",
                    unknown.join(", ")
                )
            },
        )
        .hint(format!(
            "This stream carries {}; list the ones you want separated by commas, or leave types out.",
            allowed.join(", ")
        ))
        .detail("allowed", allowed.to_vec()));
    }
    Ok(Some(wanted))
}

/// `GET /v1/events/stream`.
pub async fn stream(
    State(state): State<AppState>,
    Extension(hub): Extension<StreamHub>,
    headers: HeaderMap,
    caller: Caller,
    Query(q): Query<StreamQuery>,
) -> Result<Response, ApiError> {
    let (feed, permit_key, check) = match caller {
        Caller::App { app, secret } => {
            let mut conn = state.db.acquire().await?;
            let sub =
                subscriptions::by_delivery(&mut conn, &app.app_id, SubscriptionDelivery::Stream)
                    .await?
                    .ok_or_else(|| stream_subscription_required(&app.app_id))?;
            (
                Feed::App {
                    app_id: app.app_id.clone(),
                    subscription_id: sub.id,
                },
                format!("app:{}", app.app_id),
                Check::App {
                    app_id: app.app_id.clone(),
                    secret,
                    subscription_id: sub.id,
                },
            )
        }
        Caller::Account { auth, credential } => {
            let uuid = auth.account.uuid.clone();
            let feed = match auth.account.kind {
                AccountKind::Silicon => Feed::Silicon { uuid: uuid.clone() },
                AccountKind::Carbon => Feed::Custodian {
                    carbon_uuid: uuid.clone(),
                },
            };
            let check = match credential {
                AccountCredential::Bearer { token, exp } => Check::Bearer { token, exp },
                AccountCredential::Cookie { cookie } => Check::Cookie { cookie },
            };
            (feed, format!("account:{uuid}"), check)
        }
        Caller::Request {
            silicon_uuid,
            request_id,
        } => (
            Feed::Silicon {
                uuid: silicon_uuid.clone(),
            },
            format!("account:{silicon_uuid}"),
            Check::Request { request_id },
        ),
    };
    let types = parse_types(q.types.as_deref(), &feed)?;
    let last_event_id = headers
        .get("last-event-id")
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    let resume = last_event_id.or_else(|| {
        q.after
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    });
    let cursor = {
        let mut conn = state.db.acquire().await?;
        match &resume {
            Some(raw) => {
                let id = Uuid::parse_str(raw).map_err(|_| unknown_event(raw))?;
                let sql = format!(
                    "select e.tx_id::text from webhook_events e where e.event_id = $2 and {}",
                    feed.condition()
                );
                let tx: Option<String> = sqlx::query_scalar(sqlx::AssertSqlSafe(sql))
                    .bind(feed.key())
                    .bind(id)
                    .fetch_optional(&mut *conn)
                    .await?;
                let tx = tx
                    .and_then(|t| t.parse::<u64>().ok())
                    .ok_or_else(|| unknown_event(raw))?;
                Cursor { tx, id }
            }
            None => {
                let xmin: String =
                    sqlx::query_scalar("select pg_snapshot_xmin(pg_current_snapshot())::text")
                        .fetch_one(&mut *conn)
                        .await?;
                let xmin: u64 = xmin
                    .parse()
                    .map_err(|_| ApiError::internal(format!("unreadable xmin '{xmin}'")))?;
                Cursor {
                    tx: xmin.saturating_sub(1),
                    id: Uuid::max(),
                }
            }
        }
    };
    let permit = hub.acquire(permit_key)?;
    let timing = hub.inner.timing;
    tracing::info!(
        feed = feed.kind(),
        resumed = resume.is_some(),
        "event stream opened"
    );
    let st = StreamState {
        state,
        closing: hub.inner.closing.subscribe(),
        feed,
        check,
        cursor,
        types,
        pending: VecDeque::new(),
        opened_at: Instant::now(),
        checked_at: Instant::now(),
        greeted: false,
        done: false,
        pending_close: None,
        close_reason: None,
        sent: 0,
        timing,
        opted_out: accounts_core::telemetry::request_opts_out(&headers),
        _permit: permit,
    };
    let sse = Sse::new(into_stream(st)).keep_alive(
        KeepAlive::new()
            .interval(timing.heartbeat)
            .text("heartbeat"),
    );
    let mut response = sse.into_response();
    let h = response.headers_mut();
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    h.insert("x-accel-buffering", HeaderValue::from_static("no"));
    Ok(response)
}

/// What a stream re-checks every [`Timing::recheck`].
enum Check {
    App {
        app_id: String,
        secret: String,
        subscription_id: Uuid,
    },
    Bearer {
        token: String,
        exp: i64,
    },
    Cookie {
        cookie: String,
    },
    Request {
        request_id: Uuid,
    },
}

/// Why a stream ends (`stream.closed` `reason`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Close {
    TokenExpired,
    AccessRemoved,
    SubscriptionDeleted,
    RequestDecided,
    MaxDuration,
    ServerRestarting,
}

impl Close {
    fn reason(self) -> &'static str {
        match self {
            Close::TokenExpired => "token_expired",
            Close::AccessRemoved => "access_removed",
            Close::SubscriptionDeleted => "subscription_deleted",
            Close::RequestDecided => "request_decided",
            Close::MaxDuration => "max_duration",
            Close::ServerRestarting => "server_restarting",
        }
    }

    fn message(self) -> &'static str {
        match self {
            Close::TokenExpired => {
                "Your access token expired. Refresh it and reconnect with Last-Event-ID."
            }
            Close::AccessRemoved => {
                "These credentials no longer work (signed out, revoked, rotated, or the account or app was deleted or disabled)."
            }
            Close::SubscriptionDeleted => {
                "The app's stream subscription was deleted, so nothing more is kept for this stream."
            }
            Close::RequestDecided => {
                "Your custodian request was decided. If it was accepted, sign in with your STK and stream with your access token."
            }
            Close::MaxDuration => "Streams last at most an hour. Reconnect with Last-Event-ID.",
            Close::ServerRestarting => {
                "This server is restarting. Reconnect with Last-Event-ID in a few seconds."
            }
        }
    }
}

struct StreamState {
    state: AppState,
    closing: watch::Receiver<bool>,
    feed: Feed,
    check: Check,
    cursor: Cursor,
    types: Option<Vec<String>>,
    pending: VecDeque<Event>,
    opened_at: Instant,
    checked_at: Instant,
    greeted: bool,
    done: bool,
    pending_close: Option<Close>,
    close_reason: Option<Close>,
    sent: u64,
    timing: Timing,
    opted_out: bool,
    _permit: Permit,
}

impl Drop for StreamState {
    fn drop(&mut self) {
        let reason = self.close_reason.map_or("client_closed", Close::reason);
        let seconds = self.opened_at.elapsed().as_secs();
        tracing::info!(
            feed = self.feed.kind(),
            reason,
            events = self.sent,
            seconds,
            "event stream closed"
        );
        if !self.opted_out {
            let mut context = json!({
                "feed": self.feed.kind(),
                "reason": reason,
                "events_sent": self.sent,
                "duration_seconds": seconds,
            });
            if let Feed::App { app_id, .. } = &self.feed {
                context["app_id"] = json!(app_id);
            }
            self.state.telemetry.record_progress(
                "api",
                "GET /v1/events/stream",
                "events.stream_closed",
                Some(1.0),
                context,
            );
        }
    }
}

#[derive(sqlx::FromRow)]
struct EventRow {
    event_id: Uuid,
    #[sqlx(rename = "type")]
    event_type: String,
    payload: Value,
    tx: String,
}

impl StreamState {
    /// The next events of the feed after the cursor (only finished transactions).
    async fn fetch(&mut self) -> Result<Vec<EventRow>, ApiError> {
        let sql = format!(
            "select e.event_id, e.type, e.payload, e.tx_id::text as tx from webhook_events e \
             where {} and e.tx_id < pg_snapshot_xmin(pg_current_snapshot()) \
               and (e.tx_id, e.event_id) > ($2::text::xid8, $3) \
               and ($4::text[] is null or e.type = any($4)) \
             order by e.tx_id, e.event_id limit {BATCH}",
            self.feed.condition()
        );
        let mut conn = self.state.db.acquire().await?;
        Ok(sqlx::query_as::<_, EventRow>(sqlx::AssertSqlSafe(sql))
            .bind(self.feed.key())
            .bind(self.cursor.tx.to_string())
            .bind(self.cursor.id)
            .bind(self.types.clone())
            .fetch_all(&mut *conn)
            .await?)
    }

    /// `Some(reason)` when the stream must end now.
    async fn recheck(&mut self) -> Option<Close> {
        let state = self.state.clone();
        let result: Result<Option<Close>, ApiError> = async {
            match &self.check {
                Check::App {
                    app_id,
                    secret,
                    subscription_id,
                } => {
                    if state
                        .app_cache
                        .verify(&state.db, &state.keys.pepper, app_id, secret)
                        .await
                        .is_err()
                    {
                        return Ok(Some(Close::AccessRemoved));
                    }
                    let mut conn = state.db.acquire().await?;
                    let alive = subscriptions::get(&mut conn, app_id, *subscription_id)
                        .await?
                        .is_some();
                    Ok((!alive).then_some(Close::SubscriptionDeleted))
                }
                Check::Bearer { token, .. } => {
                    let mut conn = state.db.acquire().await?;
                    match tokens::verify_access_token(&mut conn, &state.keys, token, None).await {
                        Ok(_) => Ok(None),
                        Err(e) if e.is_server_error() => Err(e),
                        Err(_) => Ok(Some(Close::AccessRemoved)),
                    }
                }
                Check::Cookie { cookie } => {
                    let mut conn = state.db.acquire().await?;
                    let alive = sessions::lookup(&mut conn, &state.keys.pepper, cookie)
                        .await?
                        .is_some();
                    Ok((!alive).then_some(Close::AccessRemoved))
                }
                Check::Request { request_id } => {
                    let exists: bool = sqlx::query_scalar(
                        "select exists(select 1 from custodian_requests where id = $1)",
                    )
                    .bind(request_id)
                    .fetch_one(&state.db)
                    .await?;
                    Ok((!exists).then_some(Close::AccessRemoved))
                }
            }
        }
        .await;
        match result {
            Ok(close) => close,
            Err(e) => {
                // The database is unreachable: keep the stream and try again next time.
                tracing::warn!(error = %e, "could not re-check an event stream's credentials");
                None
            }
        }
    }

    /// True when a request-token stream's request is no longer pending.
    async fn request_decided(&self) -> bool {
        let Check::Request { request_id } = &self.check else {
            return false;
        };
        let status: Result<Option<(String, bool)>, sqlx::Error> = sqlx::query_as(
            "select status, expires_at <= now() from custodian_requests where id = $1",
        )
        .bind(request_id)
        .fetch_optional(&self.state.db)
        .await;
        match status {
            Ok(Some((status, overdue))) => status != "pending" || overdue,
            Ok(None) => true,
            Err(_) => false,
        }
    }

    /// Queues fetched rows as frames and moves the cursor past them.
    fn queue(&mut self, rows: Vec<EventRow>) {
        for row in rows {
            if let Ok(tx) = row.tx.parse::<u64>() {
                self.cursor = Cursor {
                    tx,
                    id: row.event_id,
                };
            }
            self.pending.push_back(
                Event::default()
                    .id(row.event_id.to_string())
                    .event(row.event_type)
                    .data(row.payload.to_string()),
            );
        }
    }

    fn closing_event(&mut self, close: Close) -> Event {
        self.done = true;
        self.close_reason = Some(close);
        Event::default()
            .event("stream.closed")
            .data(json!({"reason": close.reason(), "message": close.message()}).to_string())
    }

    /// The next frame, or `None` when the stream is over.
    async fn next_frame(&mut self) -> Option<Event> {
        if self.done {
            return None;
        }
        if !self.greeted {
            self.greeted = true;
            return Some(Event::default().retry(RETRY).comment("connected"));
        }
        loop {
            if let Some(ev) = self.pending.pop_front() {
                self.sent += 1;
                return Some(ev);
            }
            if let Some(close) = self.pending_close.take() {
                return Some(self.closing_event(close));
            }
            if *self.closing.borrow() {
                return Some(self.closing_event(Close::ServerRestarting));
            }
            if self.opened_at.elapsed() >= self.timing.max_duration {
                return Some(self.closing_event(Close::MaxDuration));
            }
            if let Check::Bearer { exp, .. } = &self.check
                && OffsetDateTime::now_utc().unix_timestamp() >= *exp
            {
                return Some(self.closing_event(Close::TokenExpired));
            }
            if self.checked_at.elapsed() >= self.timing.recheck {
                self.checked_at = Instant::now();
                if let Some(close) = self.recheck().await {
                    // Send what was recorded up to now (the event that says why, such as
                    // silicon.stk_rotated), then close.
                    if let Ok(rows) = self.fetch().await {
                        self.queue(rows);
                    }
                    self.pending_close = Some(close);
                    continue;
                }
            }
            match self.fetch().await {
                Ok(rows) if !rows.is_empty() => {
                    self.queue(rows);
                    continue;
                }
                Ok(_) => {
                    if self.request_decided().await {
                        return Some(self.closing_event(Close::RequestDecided));
                    }
                }
                Err(e) => {
                    tracing::warn!(error = %e, feed = self.feed.kind(), "event stream poll failed; retrying");
                }
            }
            let mut closing = self.closing.clone();
            tokio::select! {
                _ = tokio::time::sleep(self.timing.poll) => {}
                _ = closing.wait_for(|stop| *stop) => {}
            }
        }
    }
}

fn into_stream(st: StreamState) -> impl Stream<Item = Result<Event, Infallible>> + Send {
    futures::stream::unfold(st, |mut st| async move {
        let frame = st.next_frame().await?;
        Some((Ok(frame), st))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permits_count_per_caller_and_free_on_drop() {
        let hub = StreamHub::new();
        let mut held = Vec::new();
        for _ in 0..MAX_STREAMS_PER_CALLER {
            held.push(hub.acquire("app:briefcase".into()).expect("permit"));
        }
        let e = hub
            .acquire("app:briefcase".into())
            .err()
            .expect("over the per-caller limit");
        assert_eq!(e.status, StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(e.code, "too_many_streams");
        assert!(e.retry_after.is_some());
        assert!(
            hub.acquire("app:dm".into()).is_ok(),
            "other callers are separate"
        );
        assert_eq!(hub.open_streams(), MAX_STREAMS_PER_CALLER);
        held.pop();
        assert!(hub.acquire("app:briefcase".into()).is_ok());
        drop(held);
        assert_eq!(hub.open_streams(), 0);
        hub.close_all();
        let e = hub.acquire("app:dm".into()).err().expect("closing");
        assert_eq!(e.status, StatusCode::SERVICE_UNAVAILABLE);
    }

    #[test]
    fn types_are_checked_against_the_feed() {
        let app = Feed::App {
            app_id: "briefcase".into(),
            subscription_id: Uuid::nil(),
        };
        assert_eq!(parse_types(None, &app).expect("none"), None);
        assert_eq!(
            parse_types(Some(" account.updated , ping "), &app).expect("ok"),
            Some(vec!["account.updated".to_string(), "ping".to_string()])
        );
        let e = parse_types(Some("silicon.updated"), &app).expect_err("not an app event");
        assert_eq!(e.code, "invalid_query");
        let silicon = Feed::Silicon { uuid: "K1E".into() };
        assert!(parse_types(Some("silicon.custodian.accepted"), &silicon).is_ok());
    }
}
