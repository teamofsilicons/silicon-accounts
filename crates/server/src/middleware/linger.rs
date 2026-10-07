//! Request bodies answered before they were read to the end.
//!
//! Some answers go out before the request body was read: the 413 for a declared Content-Length
//! over the route's limit ([`super::limits`]), a 401 for an upload without a session, a 413 for a
//! stream past the limit, a rate limit. If the server then closes the connection while the client
//! is still uploading, the client's TCP stack gets a reset: the client sees EPIPE / ECONNRESET
//! instead of the answer, and a proxy in front of the API (the account site's /v1 rewrite)
//! answers a bare 500 of its own. hyper closes such a connection after the answer: it reads only
//! what is already buffered. So this layer reads the rest of the body and throws it away:
//!
//! - **Without `Expect: 100-continue`** (browsers, fetch, the CLI, proxies): the rest of the body
//!   is read first and then the answer goes out, so the client sees an ordinary exchange. When the
//!   whole body was read, the connection stays usable.
//! - **With `Expect: 100-continue` and a body nobody asked for yet**: the answer's head and body
//!   go out at once, so hyper never sends `100 Continue` and a client that waits for it never
//!   sends the body. The answer (chunked, `Connection: close`) ends only once the client stopped
//!   sending: a client that waits sends nothing within [`EXPECT_FIRST_BYTE_WAIT`]; a proxy that
//!   forwarded the expectation but streams the body anyway sends all of it first.
//!
//! The reading is bounded: at most [`MAX_UNREAD_BYTES`], at most the route's time budget, and it
//! stops once no data came for [`IDLE_WAIT`]. The byte bound counts what arrives, not what the
//! request declared: a proxy may forward only part of a body (the account site's rewrite forwards
//! at most 52 MB of any body, under the declared Content-Length), and it must still read the 413
//! of a body declared far over the limit. An answer after a body that was not read to the end
//! carries `Connection: close`. A request that ran past its time budget ([`LeaveUnread`]) is not
//! read any further: the budget bounds the whole request. HTTP/2 needs none of this (an unread
//! stream is reset on its own and the connection lives on), so only HTTP/1 requests are handled.

use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::Duration;

use axum::body::{Body, BodyDataStream, Bytes, HttpBody as _};
use axum::extract::{MatchedPath, Request, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, Version, header};
use axum::middleware::Next;
use axum::response::Response;
use futures::{Stream, StreamExt as _};
use tokio::time::Instant;

use crate::paths::{RouteClass, Timeouts};

/// The most of an unread body that is read and thrown away: more than the largest body limit
/// (50 MB imports, plus the envelope) and more than the account site's rewrite forwards of any
/// body (52 MB), so a body somewhat over any limit, and anything sent through the site, gets its
/// 413. A client still sending past this gets the answer and a closed connection.
pub const MAX_UNREAD_BYTES: u64 = 64 * 1024 * 1024;

/// Reading stops when the client sent nothing for this long.
pub const IDLE_WAIT: Duration = Duration::from_secs(5);

/// With `Expect: 100-continue`, how long the answer waits for a first byte of the body before it
/// ends: a client that waits for `100 Continue` sends none; a proxy that streams the body anyway
/// sends its first bytes right after the head.
pub const EXPECT_FIRST_BYTE_WAIT: Duration = Duration::from_secs(2);

/// Response extension: leave the rest of the body unread and close the connection (the request
/// ran past its time budget).
#[derive(Debug, Clone, Copy)]
pub struct LeaveUnread;

/// What a handler left of the request body.
struct Unread {
    body: BodyDataStream,
    /// Someone polled the body, so hyper already sent `100 Continue` if the client asked for it.
    polled: bool,
}

type Slot = Arc<Mutex<Option<Unread>>>;

/// The request body as the handler sees it. Dropped before its end, it hands the rest back to
/// [`linger`] through `slot`.
struct Reclaim {
    inner: Option<BodyDataStream>,
    polled: bool,
    ended: bool,
    slot: Slot,
}

impl Stream for Reclaim {
    type Item = Result<Bytes, axum::Error>;

    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let this = self.get_mut();
        let Some(inner) = this.inner.as_mut() else {
            return Poll::Ready(None);
        };
        this.polled = true;
        let next = inner.poll_next_unpin(cx);
        if matches!(next, Poll::Ready(None | Some(Err(_)))) {
            this.ended = true;
        }
        next
    }

    fn size_hint(&self) -> (usize, Option<usize>) {
        self.inner.as_ref().map_or((0, Some(0)), Stream::size_hint)
    }
}

impl Drop for Reclaim {
    fn drop(&mut self) {
        if self.ended {
            return;
        }
        let Some(body) = self.inner.take() else {
            return;
        };
        if body.is_end_stream() {
            return;
        }
        if let Ok(mut slot) = self.slot.lock() {
            *slot = Some(Unread {
                body,
                polled: self.polled,
            });
        }
    }
}

/// How reading the rest of a body ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Ending {
    /// The client sent the whole body.
    Complete,
    /// The body broke off (the client closed the connection, or sent invalid framing).
    Broken,
    /// No data for the idle wait.
    Idle,
    /// The route's time budget ran out.
    Budget,
    /// More than [`MAX_UNREAD_BYTES`].
    TooLarge,
}

impl Ending {
    fn as_str(self) -> &'static str {
        match self {
            Ending::Complete => "complete",
            Ending::Broken => "broken",
            Ending::Idle => "idle",
            Ending::Budget => "time_budget",
            Ending::TooLarge => "too_large",
        }
    }
}

/// Limits of one read.
#[derive(Debug, Clone, Copy)]
struct Bounds {
    budget: Duration,
    first_wait: Duration,
    idle: Duration,
    max_bytes: u64,
}

/// Reads `body` to its end within `bounds`, throwing the data away.
async fn read_rest(mut body: BodyDataStream, bounds: Bounds) -> (u64, Ending) {
    let deadline = Instant::now() + bounds.budget;
    let mut bytes = 0u64;
    let mut wait = bounds.first_wait;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return (bytes, Ending::Budget);
        }
        match tokio::time::timeout(wait.min(left), body.next()).await {
            Err(_) if wait < left => return (bytes, Ending::Idle),
            Err(_) => return (bytes, Ending::Budget),
            Ok(None) => return (bytes, Ending::Complete),
            Ok(Some(Err(_))) => return (bytes, Ending::Broken),
            Ok(Some(Ok(chunk))) => {
                bytes = bytes.saturating_add(chunk.len() as u64);
                if bytes > bounds.max_bytes {
                    return (bytes, Ending::TooLarge);
                }
                wait = bounds.idle;
            }
        }
    }
}

fn log(route: &str, how: &'static str, bytes: u64, ending: Ending) {
    if ending == Ending::Complete {
        tracing::debug!(
            route,
            how,
            bytes,
            "read the rest of a request body answered early"
        );
    } else {
        tracing::info!(
            route,
            how,
            bytes,
            ending = ending.as_str(),
            "stopped reading a request body answered early; the connection closes"
        );
    }
}

fn expects_continue(version: Version, headers: &HeaderMap) -> bool {
    version == Version::HTTP_11
        && headers
            .get(header::EXPECT)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.trim().eq_ignore_ascii_case("100-continue"))
}

fn close(response: &mut Response) {
    response
        .headers_mut()
        .insert(header::CONNECTION, HeaderValue::from_static("close"));
}

/// Statuses whose answer carries a body (the rest is read while that body goes out).
fn has_body(method: &Method, status: StatusCode) -> bool {
    *method != Method::HEAD
        && !status.is_informational()
        && status != StatusCode::NO_CONTENT
        && status != StatusCode::NOT_MODIFIED
}

/// Sends `response` at once (head, then its body) and ends it once the rest of `body` was read.
/// Nothing polls the request body before the answer's body is polled, which hyper does only after
/// it wrote the head, so hyper never sends `100 Continue`.
fn answer_then_read(
    response: Response,
    body: BodyDataStream,
    bounds: Bounds,
    route: String,
) -> Response {
    let (mut parts, answer) = response.into_parts();
    // Chunked: a client must not see the answer end before it stopped sending.
    parts.headers.remove(header::CONTENT_LENGTH);
    parts
        .headers
        .insert(header::CONNECTION, HeaderValue::from_static("close"));
    let rest = futures::stream::once(async move {
        let (bytes, ending) = read_rest(body, bounds).await;
        log(
            &route,
            "after the answer (expect 100-continue)",
            bytes,
            ending,
        );
        None::<Result<Bytes, axum::Error>>
    })
    .filter_map(std::future::ready);
    Response::from_parts(
        parts,
        Body::from_stream(answer.into_data_stream().chain(rest)),
    )
}

/// Reads whatever request body the rest of the stack left unread before the answer goes out
/// (module docs).
pub async fn linger(State(timeouts): State<Timeouts>, req: Request, next: Next) -> Response {
    if !matches!(req.version(), Version::HTTP_10 | Version::HTTP_11) || req.body().is_end_stream() {
        return next.run(req).await;
    }
    let method = req.method().clone();
    let class = RouteClass::of(&method, req.uri().path());
    let route = req
        .extensions()
        .get::<MatchedPath>()
        .map_or_else(|| "(no route)".to_string(), |m| m.as_str().to_string());
    let expects_continue = expects_continue(req.version(), req.headers());
    let slot: Slot = Arc::new(Mutex::new(None));
    let handed = slot.clone();
    let req = req.map(move |body| {
        Body::from_stream(Reclaim {
            inner: Some(body.into_data_stream()),
            polled: false,
            ended: false,
            slot: handed,
        })
    });
    let mut response = next.run(req).await;
    let unread = slot.lock().ok().and_then(|mut s| s.take());
    let Some(Unread { body, polled }) = unread else {
        return response;
    };
    if response.extensions().get::<LeaveUnread>().is_some() {
        drop(body);
        close(&mut response);
        return response;
    }
    let bounds = Bounds {
        budget: class.timeout(&timeouts),
        first_wait: IDLE_WAIT,
        idle: IDLE_WAIT,
        max_bytes: MAX_UNREAD_BYTES,
    };
    if expects_continue && !polled {
        if has_body(&method, response.status()) {
            let bounds = Bounds {
                first_wait: EXPECT_FIRST_BYTE_WAIT,
                ..bounds
            };
            return answer_then_read(response, body, bounds, route);
        }
        drop(body);
        close(&mut response);
        return response;
    }
    let (bytes, ending) = read_rest(body, bounds).await;
    log(&route, "before the answer", bytes, ending);
    if ending != Ending::Complete {
        close(&mut response);
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chunks(sizes: &[usize]) -> BodyDataStream {
        let items: Vec<Result<Bytes, std::io::Error>> = sizes
            .iter()
            .map(|n| Ok(Bytes::from(vec![0u8; *n])))
            .collect();
        Body::from_stream(futures::stream::iter(items)).into_data_stream()
    }

    fn bounds() -> Bounds {
        Bounds {
            budget: Duration::from_secs(30),
            first_wait: Duration::from_secs(2),
            idle: Duration::from_secs(5),
            max_bytes: 1000,
        }
    }

    #[tokio::test]
    async fn reads_to_the_end_and_counts() {
        assert_eq!(
            read_rest(chunks(&[100, 200, 300]), bounds()).await,
            (600, Ending::Complete)
        );
        assert_eq!(
            read_rest(chunks(&[]), bounds()).await,
            (0, Ending::Complete)
        );
    }

    #[tokio::test]
    async fn stops_past_the_byte_cap() {
        assert_eq!(
            read_rest(chunks(&[600, 600, 600]), bounds()).await,
            (1200, Ending::TooLarge)
        );
    }

    #[tokio::test]
    async fn stops_on_a_broken_body() {
        let items: Vec<Result<Bytes, std::io::Error>> = vec![
            Ok(Bytes::from_static(b"abc")),
            Err(std::io::Error::other("connection reset")),
        ];
        let body = Body::from_stream(futures::stream::iter(items)).into_data_stream();
        assert_eq!(read_rest(body, bounds()).await, (3, Ending::Broken));
    }

    /// A body that sends `first` and then nothing (a client waiting for something).
    fn stalls_after(first: Option<usize>) -> BodyDataStream {
        let start = futures::stream::iter(
            first.map(|n| Ok::<Bytes, std::io::Error>(Bytes::from(vec![0u8; n]))),
        );
        Body::from_stream(start.chain(futures::stream::pending())).into_data_stream()
    }

    #[tokio::test]
    async fn waits_for_a_first_byte_then_for_more() {
        let quick = Bounds {
            budget: Duration::from_secs(20),
            first_wait: Duration::from_millis(100),
            idle: Duration::from_millis(1500),
            max_bytes: 1000,
        };
        let started = Instant::now();
        assert_eq!(
            read_rest(stalls_after(None), quick).await,
            (0, Ending::Idle)
        );
        let waited = started.elapsed();
        assert!(
            waited >= Duration::from_millis(100) && waited < Duration::from_millis(1400),
            "the first-byte wait, not the idle wait: {waited:?}"
        );
        let started = Instant::now();
        assert_eq!(
            read_rest(stalls_after(Some(10)), quick).await,
            (10, Ending::Idle)
        );
        let waited = started.elapsed();
        assert!(
            waited >= Duration::from_millis(1500) && waited < Duration::from_secs(10),
            "the idle wait once data came: {waited:?}"
        );
    }

    #[tokio::test]
    async fn never_runs_past_the_budget() {
        // A trickle: a byte every 100 ms never trips the 400 ms idle wait; the budget ends it.
        let trickle = futures::stream::unfold((), |()| async {
            tokio::time::sleep(Duration::from_millis(100)).await;
            Some((Ok::<Bytes, std::io::Error>(Bytes::from_static(b"x")), ()))
        });
        let body = Body::from_stream(trickle).into_data_stream();
        let started = Instant::now();
        let (bytes, ending) = read_rest(
            body,
            Bounds {
                budget: Duration::from_millis(1000),
                first_wait: Duration::from_millis(400),
                idle: Duration::from_millis(400),
                max_bytes: 1000,
            },
        )
        .await;
        let waited = started.elapsed();
        assert_eq!(ending, Ending::Budget);
        assert!((3..=10).contains(&bytes), "{bytes} bytes");
        assert!(
            waited >= Duration::from_millis(1000) && waited < Duration::from_secs(5),
            "{waited:?}"
        );
    }

    #[test]
    fn expectation_and_bodies() {
        let mut h = HeaderMap::new();
        assert!(!expects_continue(Version::HTTP_11, &h));
        h.insert(header::EXPECT, HeaderValue::from_static("100-Continue"));
        assert!(expects_continue(Version::HTTP_11, &h));
        assert!(
            !expects_continue(Version::HTTP_10, &h),
            "HTTP/1.0 has no 100 Continue"
        );
        assert!(has_body(&Method::POST, StatusCode::PAYLOAD_TOO_LARGE));
        assert!(!has_body(&Method::POST, StatusCode::NO_CONTENT));
        assert!(!has_body(&Method::HEAD, StatusCode::OK));
    }
}
