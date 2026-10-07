//! Answers sent before the request body was read, over real sockets (a hyper server and a raw
//! HTTP/1.1 client): a 413 for a declared Content-Length over the route's limit, a 401 for an
//! upload without a session, a 413 for a streamed body past the limit, a 413 for a body declared
//! over 64 MB of which a proxy forwards only part.
//!
//! The client must be able to send its whole body and then read the answer. An answer followed
//! by closing the connection while the client still uploads makes the client's TCP stack reset
//! the connection: the client (or a proxy in front of the API, such as the account site's /v1
//! rewrite) then gets EPIPE / ECONNRESET instead of the answer.

use std::net::SocketAddr;
use std::time::{Duration, Instant};

use accounts_core::test_support::TestContext;
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

const MIB: usize = 1024 * 1024;

/// Serves the full router on a random local port.
async fn serve(ctx: &TestContext) -> SocketAddr {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("local addr");
    let app = accounts_server::build_router(ctx.state.clone());
    tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .expect("serve");
    });
    addr
}

/// One response as read off the wire.
#[derive(Debug, Default)]
struct Answer {
    /// Interim (1xx) statuses that came before it, e.g. 100 Continue.
    interim: Vec<u16>,
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Answer {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(n, _)| n.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or(Value::Null)
    }

    fn code(&self) -> Option<String> {
        self.json()["error"]["code"].as_str().map(str::to_string)
    }
}

/// Reads bytes until `buf` holds `\r\n\r\n`; returns the head's length (with the blank line).
async fn read_head(stream: &mut TcpStream, buf: &mut Vec<u8>) -> std::io::Result<usize> {
    loop {
        if let Some(end) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            return Ok(end + 4);
        }
        let mut chunk = [0u8; 16 * 1024];
        let n = stream.read(&mut chunk).await?;
        if n == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                format!(
                    "the connection closed before a response head ({} bytes read)",
                    buf.len()
                ),
            ));
        }
        buf.extend_from_slice(&chunk[..n]);
    }
}

/// Makes sure `buf` holds at least `n` bytes.
async fn fill(stream: &mut TcpStream, buf: &mut Vec<u8>, n: usize) -> std::io::Result<()> {
    while buf.len() < n {
        let mut chunk = [0u8; 16 * 1024];
        let read = stream.read(&mut chunk).await?;
        if read == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "the connection closed inside the response body",
            ));
        }
        buf.extend_from_slice(&chunk[..read]);
    }
    Ok(())
}

/// Reads one response (skipping interim 1xx answers, which are recorded), with its body
/// (Content-Length or chunked). Bytes after it stay in `buf`.
async fn read_answer(stream: &mut TcpStream, buf: &mut Vec<u8>) -> std::io::Result<Answer> {
    let mut answer = Answer::default();
    loop {
        let head_len = read_head(stream, buf).await?;
        let head = String::from_utf8_lossy(&buf[..head_len]).to_string();
        buf.drain(..head_len);
        let mut lines = head.split("\r\n");
        let status: u16 = lines
            .next()
            .and_then(|l| l.split(' ').nth(1))
            .and_then(|s| s.parse().ok())
            .unwrap_or_default();
        if (100..200).contains(&status) {
            answer.interim.push(status);
            continue;
        }
        answer.status = status;
        answer.headers = lines
            .filter(|l| !l.is_empty())
            .filter_map(|l| l.split_once(':'))
            .map(|(n, v)| (n.trim().to_ascii_lowercase(), v.trim().to_string()))
            .collect();
        break;
    }
    if answer
        .header("transfer-encoding")
        .is_some_and(|t| t.eq_ignore_ascii_case("chunked"))
    {
        loop {
            let line_end = loop {
                if let Some(p) = buf.windows(2).position(|w| w == b"\r\n") {
                    break p;
                }
                let have = buf.len();
                fill(stream, buf, have + 1).await?;
            };
            let size_line = String::from_utf8_lossy(&buf[..line_end]).to_string();
            let size = usize::from_str_radix(size_line.split(';').next().unwrap_or("").trim(), 16)
                .map_err(|e| std::io::Error::other(format!("bad chunk size {size_line:?}: {e}")))?;
            buf.drain(..line_end + 2);
            fill(stream, buf, size + 2).await?;
            answer.body.extend_from_slice(&buf[..size]);
            buf.drain(..size + 2);
            if size == 0 {
                break;
            }
        }
    } else if let Some(len) = answer
        .header("content-length")
        .and_then(|l| l.parse::<usize>().ok())
    {
        fill(stream, buf, len).await?;
        answer.body = buf.drain(..len).collect();
    } else {
        stream.read_to_end(buf).await?;
        answer.body = std::mem::take(buf);
    }
    Ok(answer)
}

/// What a client that uploads a whole body before reading saw.
#[derive(Debug)]
struct Exchange {
    /// Writing the head and the whole body succeeded.
    upload: std::io::Result<()>,
    /// The answer (or why it could not be read).
    answer: std::io::Result<Answer>,
}

impl Exchange {
    fn clean(&self) -> bool {
        self.upload.is_ok() && self.answer.is_ok()
    }

    fn answer(&self) -> &Answer {
        self.answer.as_ref().expect("an answer")
    }

    fn summary(&self) -> String {
        let upload = match &self.upload {
            Ok(()) => "upload ok".to_string(),
            Err(e) => format!("upload failed ({:?}: {e})", e.kind()),
        };
        let answer = match &self.answer {
            Ok(a) => format!(
                "{} {:?} {}",
                a.status,
                a.code(),
                String::from_utf8_lossy(&a.body)
                    .chars()
                    .take(160)
                    .collect::<String>()
            ),
            Err(e) => format!("no answer ({:?}: {e})", e.kind()),
        };
        format!("{upload}; {answer}")
    }
}

/// Writes `head` and then `body` (in 64 KB writes, as a proxy streams it), then reads the answer.
async fn upload_then_read(stream: &mut TcpStream, head: &str, body: &[u8]) -> Exchange {
    let upload = async {
        stream.write_all(head.as_bytes()).await?;
        for chunk in body.chunks(64 * 1024) {
            stream.write_all(chunk).await?;
        }
        stream.flush().await
    }
    .await;
    let mut buf = Vec::new();
    let answer = read_answer(stream, &mut buf).await;
    Exchange { upload, answer }
}

async fn connect(addr: SocketAddr) -> TcpStream {
    let stream = TcpStream::connect(addr).await.expect("connect");
    stream.set_nodelay(true).expect("nodelay");
    stream
}

fn post_head(path: &str, extra: &[(&str, String)]) -> String {
    let mut head = format!("POST {path} HTTP/1.1\r\nhost: localhost\r\n");
    for (name, value) in extra {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str("\r\n");
    head
}

/// A whole client exchange with a time limit, so a hang fails the test instead of stalling it.
async fn within<T>(what: &str, f: impl std::future::Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(60), f)
        .await
        .unwrap_or_else(|_| panic!("{what}: no answer within 60 s"))
}

#[tokio::test]
async fn a_declared_body_over_the_limit_is_read_before_the_413() {
    let ctx = TestContext::new().await;
    let addr = serve(&ctx).await;
    // Photo route (2 MB): one byte over, and the sizes a client may really send; the import
    // route (50 MB): 51 MB. Every try, a fresh connection.
    let cases: Vec<(&str, usize, usize)> = vec![
        ("/v1/me/photo", 2 * MIB + 1, 8),
        ("/v1/me/photo", 4 * MIB, 3),
        ("/v1/me/photo", 8 * MIB, 3),
        ("/v1/apps/some-app/imports", 51 * MIB, 2),
    ];
    for (path, size, tries) in cases {
        let body = vec![b'a'; size];
        for attempt in 0..tries {
            let mut stream = connect(addr).await;
            let head = post_head(
                path,
                &[
                    ("content-type", "image/png".to_string()),
                    ("content-length", size.to_string()),
                ],
            );
            let exchange = within(path, upload_then_read(&mut stream, &head, &body)).await;
            assert!(
                exchange.clean(),
                "{path} with {size} bytes, try {attempt}: {}",
                exchange.summary()
            );
            let answer = exchange.answer();
            assert_eq!(answer.status, 413, "{}", exchange.summary());
            assert_eq!(answer.code().as_deref(), Some("payload_too_large"));
            assert!(answer.interim.is_empty(), "no 100 Continue was asked for");
            let message = answer.json()["error"]["message"]
                .as_str()
                .unwrap_or_default()
                .to_string();
            assert!(
                message.contains(&format!("The request body is {size} bytes")),
                "{message}"
            );
            // The whole body was read, so the connection stays usable.
            assert_ne!(answer.header("connection"), Some("close"));
            stream
                .write_all(b"GET /v1/meta HTTP/1.1\r\nhost: localhost\r\n\r\n")
                .await
                .expect("second request");
            let mut buf = Vec::new();
            let meta = within("meta", read_answer(&mut stream, &mut buf))
                .await
                .expect("meta answer on the same connection");
            assert_eq!(meta.status, 200);
            assert_eq!(meta.json()["name"], "Silicon Accounts");
        }
    }
}

#[tokio::test]
async fn expect_100_continue_gets_the_413_without_being_asked_for_the_body() {
    let ctx = TestContext::new().await;
    let addr = serve(&ctx).await;
    for (path, size) in [
        ("/v1/apps/some-app/imports", 51 * MIB),
        ("/v1/me/photo", 2 * MIB + 1),
    ] {
        let mut stream = connect(addr).await;
        let head = post_head(
            path,
            &[
                ("content-type", "text/csv".to_string()),
                ("content-length", size.to_string()),
                ("expect", "100-continue".to_string()),
            ],
        );
        stream.write_all(head.as_bytes()).await.expect("head");
        let started = Instant::now();
        let mut buf = Vec::new();
        let answer = within(path, read_answer(&mut stream, &mut buf))
            .await
            .expect("an answer without sending the body");
        assert!(
            answer.interim.is_empty(),
            "{path}: the body is refused, so it is never asked for (got {:?})",
            answer.interim
        );
        assert_eq!(answer.status, 413);
        assert_eq!(answer.code().as_deref(), Some("payload_too_large"));
        assert_eq!(answer.header("connection"), Some("close"));
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "{path}: the answer ended {:?} after the head",
            started.elapsed()
        );
        // The server closes the connection afterwards.
        let mut rest = Vec::new();
        let closed = within("close", stream.read_to_end(&mut rest)).await;
        assert!(
            closed.is_ok() && rest.is_empty(),
            "{path}: {closed:?} {rest:?}"
        );
    }
}

#[tokio::test]
async fn expect_100_continue_from_a_proxy_that_sends_the_body_anyway() {
    // Proxies such as the account site's /v1 rewrite forward `Expect: 100-continue` but stream
    // the body at once without waiting for 100 Continue.
    let ctx = TestContext::new().await;
    let addr = serve(&ctx).await;
    for (path, size, tries) in [
        ("/v1/me/photo", 2 * MIB + 1, 6),
        ("/v1/me/photo", 8 * MIB, 2),
        ("/v1/apps/some-app/imports", 51 * MIB, 2),
    ] {
        let body = vec![b'a'; size];
        for attempt in 0..tries {
            let mut stream = connect(addr).await;
            let head = post_head(
                path,
                &[
                    ("content-type", "text/csv".to_string()),
                    ("content-length", size.to_string()),
                    ("expect", "100-continue".to_string()),
                ],
            );
            let exchange = within(path, upload_then_read(&mut stream, &head, &body)).await;
            assert!(
                exchange.clean(),
                "{path} with {size} bytes, try {attempt}: {}",
                exchange.summary()
            );
            let answer = exchange.answer();
            assert_eq!(answer.status, 413, "{}", exchange.summary());
            assert_eq!(answer.code().as_deref(), Some("payload_too_large"));
            assert!(answer.interim.is_empty(), "{:?}", answer.interim);
        }
    }
}

#[tokio::test]
async fn a_body_declared_over_64_mb_that_a_proxy_forwards_in_part_gets_the_413() {
    // The account site's rewrite forwards at most 52 MB of any body and keeps the declared
    // Content-Length, then waits for the answer. The bytes that arrive, not the declared length,
    // decide how much is read: all 52 MB are, and once nothing more comes the 413 goes out.
    let ctx = TestContext::new().await;
    let addr = serve(&ctx).await;
    let declared = 100 * MIB;
    let forwarded = vec![b'a'; 52 * MIB];
    for expect in [false, true] {
        let mut stream = connect(addr).await;
        let mut extra = vec![
            ("content-type", "text/csv".to_string()),
            ("content-length", declared.to_string()),
        ];
        if expect {
            extra.push(("expect", "100-continue".to_string()));
        }
        let head = post_head("/v1/apps/some-app/imports", &extra);
        let started = Instant::now();
        let exchange = within(
            "partly forwarded import",
            upload_then_read(&mut stream, &head, &forwarded),
        )
        .await;
        assert!(
            exchange.clean(),
            "expect 100-continue {expect}: {}",
            exchange.summary()
        );
        let answer = exchange.answer();
        assert_eq!(answer.status, 413, "{}", exchange.summary());
        assert_eq!(answer.code().as_deref(), Some("payload_too_large"));
        assert!(answer.interim.is_empty(), "{:?}", answer.interim);
        assert!(
            answer.json()["error"]["message"]
                .as_str()
                .is_some_and(|m| m.contains(&format!("The request body is {declared} bytes"))),
            "{}",
            exchange.summary()
        );
        // The body never ended, so the connection does not stay open.
        assert_eq!(answer.header("connection"), Some("close"));
        assert!(
            started.elapsed() < Duration::from_secs(30),
            "expect 100-continue {expect}: answered after {:?}",
            started.elapsed()
        );
    }
}

#[tokio::test]
async fn an_upload_refused_before_its_body_was_read_still_gets_its_answer() {
    let ctx = TestContext::new().await;
    let addr = serve(&ctx).await;
    // 1.5 MB is within the photo limit; without a session the route answers 401 before it
    // reads the body.
    let body = vec![0u8; 3 * MIB / 2];
    for attempt in 0..6 {
        let mut stream = connect(addr).await;
        let head = post_head(
            "/v1/me/photo",
            &[
                ("content-type", "image/png".to_string()),
                ("content-length", body.len().to_string()),
            ],
        );
        let exchange = within("photo", upload_then_read(&mut stream, &head, &body)).await;
        assert!(exchange.clean(), "try {attempt}: {}", exchange.summary());
        assert_eq!(exchange.answer().status, 401, "{}", exchange.summary());
    }
}

#[tokio::test]
async fn a_streamed_body_past_the_limit_gets_the_413_after_the_upload() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let token = ctx.first_party_tokens(&carbon).await.access_token;
    let addr = serve(&ctx).await;
    // Chunked (no Content-Length): the photo handler stops reading past 2 MB and answers 413.
    let mut chunked = Vec::new();
    for piece in vec![0u8; 3 * MIB].chunks(256 * 1024) {
        chunked.extend_from_slice(format!("{:x}\r\n", piece.len()).as_bytes());
        chunked.extend_from_slice(piece);
        chunked.extend_from_slice(b"\r\n");
    }
    chunked.extend_from_slice(b"0\r\n\r\n");
    for attempt in 0..4 {
        let mut stream = connect(addr).await;
        let head = post_head(
            "/v1/me/photo",
            &[
                ("authorization", format!("Bearer {token}")),
                ("content-type", "image/png".to_string()),
                ("transfer-encoding", "chunked".to_string()),
            ],
        );
        let exchange = within(
            "chunked photo",
            upload_then_read(&mut stream, &head, &chunked),
        )
        .await;
        assert!(exchange.clean(), "try {attempt}: {}", exchange.summary());
        // The photo handler's own 413 (it stops reading past 2 MB).
        assert_eq!(exchange.answer().status, 413, "{}", exchange.summary());
        assert_eq!(exchange.answer().code().as_deref(), Some("photo_too_large"));
    }
}
