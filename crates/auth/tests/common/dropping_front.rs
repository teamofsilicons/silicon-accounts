//! A provider endpoint that drops kept-alive connections: plain HTTP/1.1 in front of another
//! server (the mock provider), answering `answers_per_connection` requests on each connection
//! and then closing that connection, unanswered, when the next request arrives on it.
//!
//! That is exactly what a client sees when it reuses a pooled keep-alive connection the
//! provider has already closed: the request is written, then the connection ends before any
//! answer ("connection closed before message completed"). Servers close idle connections long
//! before reqwest stops reusing them (Node's default keep-alive is 5 s, reqwest's pool keeps
//! idle connections for 90 s), so under load a sign-in can land on such a connection.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

pub struct DroppingFront {
    /// `http://127.0.0.1:<port>`; paths are forwarded unchanged to the upstream.
    pub base: String,
    connections: Arc<AtomicUsize>,
    answered: Arc<AtomicUsize>,
    dropped: Arc<AtomicUsize>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for DroppingFront {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl DroppingFront {
    pub async fn start(upstream: &str, answers_per_connection: usize) -> DroppingFront {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind the dropping front");
        let base = format!("http://{}", listener.local_addr().expect("addr"));
        let connections = Arc::new(AtomicUsize::new(0));
        let answered = Arc::new(AtomicUsize::new(0));
        let dropped = Arc::new(AtomicUsize::new(0));
        let task = {
            let (connections, answered, dropped) =
                (connections.clone(), answered.clone(), dropped.clone());
            let upstream = upstream.trim_end_matches('/').to_string();
            tokio::spawn(async move {
                while let Ok((socket, _)) = listener.accept().await {
                    connections.fetch_add(1, Ordering::SeqCst);
                    tokio::spawn(serve(
                        socket,
                        upstream.clone(),
                        answers_per_connection,
                        answered.clone(),
                        dropped.clone(),
                    ));
                }
            })
        };
        DroppingFront {
            base,
            connections,
            answered,
            dropped,
            task,
        }
    }

    /// Connections accepted so far.
    pub fn connections(&self) -> usize {
        self.connections.load(Ordering::SeqCst)
    }

    /// Requests answered (forwarded to the upstream and its answer passed back).
    pub fn answered(&self) -> usize {
        self.answered.load(Ordering::SeqCst)
    }

    /// Requests that arrived on a connection that had used up its answers: read, then the
    /// connection was closed without a byte of answer.
    pub fn dropped(&self) -> usize {
        self.dropped.load(Ordering::SeqCst)
    }
}

async fn serve(
    mut socket: TcpStream,
    upstream: String,
    answers_per_connection: usize,
    answered: Arc<AtomicUsize>,
    dropped: Arc<AtomicUsize>,
) {
    let client = reqwest::Client::new();
    let mut buf: Vec<u8> = Vec::new();
    let mut served = 0;
    loop {
        // One request: its head, then Content-Length bytes of body.
        let head_end = loop {
            if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                break i + 4;
            }
            if !read_more(&mut socket, &mut buf).await {
                return;
            }
        };
        let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
        let header = |name: &str| {
            head.lines().skip(1).find_map(|l| {
                let (k, v) = l.split_once(':')?;
                k.trim()
                    .eq_ignore_ascii_case(name)
                    .then(|| v.trim().to_string())
            })
        };
        let length: usize = header("content-length")
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);
        while buf.len() < head_end + length {
            if !read_more(&mut socket, &mut buf).await {
                return;
            }
        }
        let body = buf[head_end..head_end + length].to_vec();
        buf.drain(..head_end + length);
        if served >= answers_per_connection {
            // The provider already let this connection go: nothing comes back.
            dropped.fetch_add(1, Ordering::SeqCst);
            return;
        }
        let mut request_line = head.lines().next().unwrap_or("").split(' ');
        let method = request_line.next().unwrap_or("GET").to_string();
        let path = request_line.next().unwrap_or("/").to_string();
        let mut request = client.request(
            reqwest::Method::from_bytes(method.as_bytes()).unwrap_or(reqwest::Method::GET),
            format!("{upstream}{path}"),
        );
        if let Some(t) = header("content-type") {
            request = request.header(reqwest::header::CONTENT_TYPE, t);
        }
        let (status, answer) = match request.body(body).send().await {
            Ok(r) => (r.status(), r.bytes().await.unwrap_or_default().to_vec()),
            Err(_) => (reqwest::StatusCode::BAD_GATEWAY, b"{}".to_vec()),
        };
        let mut out = format!(
            "HTTP/1.1 {} {}\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n",
            status.as_u16(),
            status.canonical_reason().unwrap_or("Status"),
            answer.len()
        )
        .into_bytes();
        out.extend_from_slice(&answer);
        if socket.write_all(&out).await.is_err() {
            return;
        }
        served += 1;
        answered.fetch_add(1, Ordering::SeqCst);
    }
}

async fn read_more(socket: &mut TcpStream, buf: &mut Vec<u8>) -> bool {
    let mut chunk = [0u8; 8192];
    match socket.read(&mut chunk).await {
        Ok(0) | Err(_) => false,
        Ok(n) => {
            buf.extend_from_slice(&chunk[..n]);
            true
        }
    }
}
