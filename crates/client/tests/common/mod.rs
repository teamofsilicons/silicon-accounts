//! A tiny scripted HTTP mock on axum: register replies per `METHOD /path`, then inspect
//! what the client sent.

#![allow(dead_code, clippy::unwrap_used)]

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

use axum::body::{Body, to_bytes};
use axum::extract::{Request, State};
use axum::http::{HeaderName, HeaderValue, StatusCode};
use axum::response::Response;
use serde_json::Value;

#[derive(Clone, Debug)]
pub struct Reply {
    pub status: u16,
    pub body: String,
    pub headers: Vec<(String, String)>,
}

impl Reply {
    pub fn json(status: u16, body: Value) -> Self {
        Self {
            status,
            body: body.to_string(),
            headers: vec![("content-type".into(), "application/json".into())],
        }
    }

    pub fn text(status: u16, body: &str) -> Self {
        Self {
            status,
            body: body.to_owned(),
            headers: vec![("content-type".into(), "text/html".into())],
        }
    }

    pub fn empty(status: u16) -> Self {
        Self {
            status,
            body: String::new(),
            headers: vec![],
        }
    }

    pub fn header(mut self, name: &str, value: &str) -> Self {
        self.headers.push((name.to_owned(), value.to_owned()));
        self
    }
}

#[derive(Clone, Debug)]
pub struct Recorded {
    pub method: String,
    pub path: String,
    pub query: Option<String>,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Recorded {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    pub fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap()
    }

    pub fn form(&self) -> HashMap<String, String> {
        url::form_urlencoded::parse(&self.body)
            .into_owned()
            .collect()
    }
}

#[derive(Default)]
struct MockState {
    routes: HashMap<String, VecDeque<Reply>>,
    requests: Vec<Recorded>,
}

#[derive(Clone)]
pub struct Mock {
    pub url: String,
    state: Arc<Mutex<MockState>>,
}

impl Mock {
    pub async fn start() -> Self {
        let state = Arc::new(Mutex::new(MockState::default()));
        let app = axum::Router::new()
            .fallback(handle)
            .with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        Self {
            url: format!("http://{addr}"),
            state,
        }
    }

    /// Queue a reply for `METHOD /path`. Replies are used in order; the last one repeats.
    pub fn on(&self, method: &str, path: &str, reply: Reply) {
        let key = format!("{method} {path}");
        self.state
            .lock()
            .unwrap()
            .routes
            .entry(key)
            .or_default()
            .push_back(reply);
    }

    pub fn requests(&self) -> Vec<Recorded> {
        self.state.lock().unwrap().requests.clone()
    }

    pub fn requests_to(&self, method: &str, path: &str) -> Vec<Recorded> {
        self.requests()
            .into_iter()
            .filter(|r| r.method == method && r.path == path)
            .collect()
    }
}

async fn handle(State(state): State<Arc<Mutex<MockState>>>, request: Request) -> Response {
    let (parts, body) = request.into_parts();
    let body = to_bytes(body, 64 * 1024 * 1024)
        .await
        .unwrap_or_default()
        .to_vec();
    let recorded = Recorded {
        method: parts.method.to_string(),
        path: parts.uri.path().to_owned(),
        query: parts.uri.query().map(str::to_owned),
        headers: parts
            .headers
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or_default().to_owned()))
            .collect(),
        body,
    };
    let key = format!("{} {}", recorded.method, recorded.path);
    let reply = {
        let mut guard = state.lock().unwrap();
        guard.requests.push(recorded);
        match guard.routes.get_mut(&key) {
            Some(queue) if queue.len() > 1 => queue.pop_front(),
            Some(queue) => queue.front().cloned(),
            None => None,
        }
    };
    let reply = reply.unwrap_or_else(|| {
        Reply::json(
            404,
            serde_json::json!({"error": {"code": "not_found", "message": format!("mock has no route for {key}"), "hint": "register it in the test"}}),
        )
    });
    let mut response = Response::new(Body::from(reply.body));
    *response.status_mut() = StatusCode::from_u16(reply.status).unwrap();
    for (name, value) in reply.headers {
        response.headers_mut().insert(
            HeaderName::from_bytes(name.as_bytes()).unwrap(),
            HeaderValue::from_str(&value).unwrap(),
        );
    }
    response
}
