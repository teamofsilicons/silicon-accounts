//! A small stateful mock of the Silicon Accounts API on its own thread, plus helpers to
//! run the `accounts` binary in an isolated home.

#![allow(dead_code, clippy::unwrap_used)]

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use axum::body::{Body, to_bytes};
use axum::extract::{Request, State};
use axum::http::StatusCode;
use axum::response::Response;
use serde_json::{Value, json};

pub const SILICON_ID: &str = "si:scout";
pub const SILICON_UUID: &str = "b9Z";
pub const STK: &str = "stk-0123456789ab";
pub const CARBON_ID: &str = "c:saket";
pub const CARBON_UUID: &str = "a8K";
pub const CARBON_EMAIL: &str = "saket@example.com";
pub const CARBON_TOKEN: &str = "at-carbon";
pub const APP_ID: &str = "briefcase";
pub const APP_SECRET: &str = "sa_app_briefcase_test_secret";

#[derive(Default)]
pub struct MockState {
    /// (method, path, authorization, body)
    pub requests: Vec<(String, String, Option<String>, String)>,
    /// (method, path, query)
    pub queries: Vec<(String, String, String)>,
    pub telemetry_batches: Vec<Value>,
    /// The Silicon's currently valid access and refresh tokens (rotated on refresh).
    pub access_token: String,
    pub refresh_token: String,
    pub generation: u32,
    /// Device polls before approval.
    pub device_polls: u32,
    /// Custodian request polls; the request is accepted from this poll number on.
    pub request_polls: u32,
    pub accept_on_poll: u32,
    /// The Silicon's current STK (a test rotates it by changing this).
    pub stk: String,
    /// The Carbon's currently valid access token (a test revokes the session by changing it).
    pub carbon_token: String,
    /// The app's sign-in setup version and redirect URIs (PATCH signin-config changes them).
    pub config_version: i64,
    pub redirect_uris: Value,
}

pub struct Mock {
    pub url: String,
    pub state: Arc<Mutex<MockState>>,
}

impl Mock {
    pub fn start() -> Self {
        Self::start_with(2)
    }

    /// `accept_on_poll`: the custodian request reads `accepted` from this poll on.
    pub fn start_with(accept_on_poll: u32) -> Self {
        let state = Arc::new(Mutex::new(MockState {
            access_token: "at-1".into(),
            refresh_token: "sar_1".into(),
            generation: 1,
            accept_on_poll,
            stk: STK.into(),
            carbon_token: CARBON_TOKEN.into(),
            config_version: 4,
            redirect_uris: json!(["http://127.0.0.1:8593/briefcase/callback"]),
            ..MockState::default()
        }));
        let shared = state.clone();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            runtime.block_on(async move {
                let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
                tx.send(listener.local_addr().unwrap()).unwrap();
                let app = axum::Router::new().fallback(handle).with_state(shared);
                axum::serve(listener, app).await.unwrap();
            });
        });
        let addr = rx.recv().unwrap();
        Self {
            url: format!("http://{addr}"),
            state,
        }
    }

    pub fn count(&self, method: &str, path: &str) -> usize {
        self.requests(method, path).len()
    }

    /// (authorization, body) of every request to `method path`.
    pub fn requests(&self, method: &str, path: &str) -> Vec<(Option<String>, String)> {
        self.state
            .lock()
            .unwrap()
            .requests
            .iter()
            .filter(|r| r.0 == method && r.1 == path)
            .map(|r| (r.2.clone(), r.3.clone()))
            .collect()
    }

    pub fn telemetry(&self) -> Vec<Value> {
        self.state.lock().unwrap().telemetry_batches.clone()
    }

    /// Revokes every session of the Silicon and makes `stk` its STK, as a custodian's
    /// `rotate-stk` does: the stored access and refresh tokens stop working.
    pub fn rotate_stk(&self, stk: &str) {
        let mut st = self.state.lock().unwrap();
        st.stk = stk.to_owned();
        st.generation += 10;
        st.access_token = format!("at-{}", st.generation);
        st.refresh_token = format!("sar_{}", st.generation);
    }

    /// Revokes the Carbon's session (as `accounts sessions revoke` from another terminal).
    pub fn revoke_carbon_session(&self) {
        let mut st = self.state.lock().unwrap();
        st.carbon_token = format!("{CARBON_TOKEN}-{}", st.requests.len());
    }

    /// The query string of every request to `method path`.
    pub fn queries(&self, method: &str, path: &str) -> Vec<String> {
        self.state
            .lock()
            .unwrap()
            .queries
            .iter()
            .filter(|r| r.0 == method && r.1 == path)
            .map(|r| r.2.clone())
            .collect()
    }
}

fn error(status: u16, code: &str, message: &str, hint: &str) -> (u16, Value) {
    (
        status,
        json!({ "error": { "code": code, "message": message, "hint": hint } }),
    )
}

fn silicon_tokens(state: &MockState) -> Value {
    json!({
        "access_token": state.access_token,
        "token_type": "Bearer",
        "expires_in": 1800,
        "refresh_token": state.refresh_token,
        "refresh_token_expires_at": "2029-03-24T12:00:00.000Z",
        "scope": "profile",
        "membership_id": format!("accounts:{SILICON_UUID}"),
        "account": {
            "uuid": SILICON_UUID, "membership_id": format!("accounts:{SILICON_UUID}"), "kind": "silicon",
            "id": SILICON_ID, "display_name": "Scout", "pfp_url": "https://iris.example/pfp/silicon?id=b9Z",
            "custodian": { "uuid": CARBON_UUID, "id": CARBON_ID }, "updated_at": "2026-10-06T12:00:00.000Z", "version": 3
        }
    })
}

fn carbon_tokens(state: &MockState) -> Value {
    json!({
        "access_token": state.carbon_token,
        "token_type": "Bearer",
        "expires_in": 1800,
        "refresh_token": "sar_carbon",
        "refresh_token_expires_at": "2029-03-24T12:00:00.000Z",
        "scope": "profile email",
        "membership_id": format!("accounts:{CARBON_UUID}"),
        "account": {
            "uuid": CARBON_UUID, "membership_id": format!("accounts:{CARBON_UUID}"), "kind": "carbon",
            "id": CARBON_ID, "display_name": "Saket", "pfp_url": "https://iris.example/pfp/carbon?id=a8K",
            "email": CARBON_EMAIL, "email_verified": true, "updated_at": "2026-10-06T12:00:00.000Z", "version": 5
        }
    })
}

fn silicon_me() -> Value {
    json!({
        "uuid": SILICON_UUID, "kind": "silicon", "id": SILICON_ID, "display_name": "Scout",
        "pfp_url": "https://iris.example/pfp/silicon?id=b9Z", "dob": "2026-10-06", "timezone": "UTC",
        "status": "active", "created_at": "2026-10-06T12:00:00.000Z", "updated_at": "2026-10-06T12:00:00.000Z",
        "version": 3, "custodian": { "uuid": CARBON_UUID, "kind": "carbon", "id": CARBON_ID, "display_name": "Saket",
        "pfp_url": "", "status": "active" }, "webhook_url": null, "stk_rotated_at": null
    })
}

fn carbon_me() -> Value {
    json!({
        "uuid": CARBON_UUID, "kind": "carbon", "id": CARBON_ID, "display_name": "Saket",
        "pfp_url": "https://iris.example/pfp/carbon?id=a8K", "dob": "2000-01-01", "timezone": "Asia/Kolkata",
        "status": "active", "created_at": "2026-10-06T12:00:00.000Z", "updated_at": "2026-10-06T12:00:00.000Z",
        "version": 5, "emails": [{ "email": CARBON_EMAIL, "is_primary": true, "verified_at": "2026-10-06T12:00:00.000Z", "verified_via": "code" }],
        "phones": [], "identities": [], "custodian_of": 1
    })
}

fn new_silicon(status: &str) -> Value {
    json!({
        "uuid": SILICON_UUID, "kind": "silicon", "id": SILICON_ID, "display_name": "Scout",
        "pfp_url": "https://iris.example/pfp/silicon?id=b9Z", "dob": "2026-10-06", "timezone": "UTC",
        "status": status, "created_at": "2026-10-06T12:00:00.000Z", "updated_at": "2026-10-06T12:00:00.000Z",
        "version": 1, "custodian": null, "webhook_url": null, "stk_rotated_at": null
    })
}

fn import_job(status: &str, processed: u64) -> Value {
    json!({
        "id": "job-1", "status": status, "format": "csv", "total_rows": 3, "processed_rows": processed,
        "counts": { "created": 1, "matched": 1, "updated": 0, "skipped": 0, "error": 1, "warnings": 1 },
        "created_at": "2026-10-06T12:00:00.000Z", "started_at": "2026-10-06T12:00:00.000Z",
        "finished_at": null, "error": null
    })
}

fn app_details(state: &MockState) -> Value {
    json!({ "app_id": APP_ID, "name": "Briefcase", "description": "", "status": "active", "source": "fake",
            "owner": { "uuid": CARBON_UUID, "kind": "carbon", "id": CARBON_ID, "display_name": "Saket", "pfp_url": "", "status": "active" },
            "signin_config": { "methods": { "email": true, "google": true, "apple": false, "phone": false },
                "method_order": ["google", "apple", "email", "phone"], "redirect_uris": state.redirect_uris,
                "required_fields": ["email"], "optional_fields": [], "allow_signup": true },
            "config_version": state.config_version, "webhook": { "url": null, "secret_set": false },
            "stats": { "users": 2, "active_last_30d": 1, "imported_unclaimed": 0 } })
}

fn delivery(id: &str, status: &str) -> Value {
    json!({ "id": id, "event_id": "e-1", "type": "silicon.updated", "account_uuid": SILICON_UUID,
            "url": "https://scout.example/hooks", "status": status, "attempts": 12, "last_status": 503,
            "last_error": null, "next_attempt_at": null, "last_attempt_at": "2026-10-06T12:00:00.000Z",
            "delivered_at": null, "created_at": "2026-10-03T12:00:00.000Z", "manual_replays": 0 })
}

fn delivery_detail() -> Value {
    let mut detail = delivery("d-1", "failed");
    detail["attempt_count"] = json!(12);
    detail["attempts"] = json!([{ "attempted_at": "2026-10-06T12:00:00.000Z", "status_code": 503, "error": null, "duration_ms": 41 }]);
    detail["payload"] = json!({ "event_id": "e-1", "type": "silicon.updated", "silicon": SILICON_UUID, "data": { "uuid": SILICON_UUID } });
    detail["payload_redacted"] = json!(false);
    detail
}

fn replay_result(body: &Value) -> Value {
    let replayed = match body.get("delivery_ids") {
        Some(Value::Array(ids)) => ids
            .iter()
            .filter(|id| *id != "d-pending")
            .cloned()
            .collect(),
        _ => vec![json!("d-1")],
    };
    let skipped: Vec<Value> = match body.get("delivery_ids") {
        Some(Value::Array(ids)) if ids.iter().any(|id| id == "d-pending") => vec![json!({
            "delivery_id": "d-pending", "reason": "already_pending",
            "message": "Delivery d-pending is still being retried; it is not replayed."
        })],
        _ => Vec::new(),
    };
    json!({ "replayed": replayed, "skipped": skipped, "remaining": if body.get("status").is_some() { 3 } else { 0 },
            "not_replayable": 1, "url": "https://scout.example/hooks" })
}

fn form(body: &str) -> HashMap<String, String> {
    url::form_urlencoded::parse(body.as_bytes())
        .into_owned()
        .collect()
}

async fn handle(State(state): State<Arc<Mutex<MockState>>>, request: Request) -> Response {
    let (parts, body) = request.into_parts();
    let body = String::from_utf8(to_bytes(body, 1 << 20).await.unwrap_or_default().to_vec())
        .unwrap_or_default();
    let method = parts.method.to_string();
    let path = parts.uri.path().to_owned();
    let query = parts.uri.query().unwrap_or("").to_owned();
    let auth = parts
        .headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    let mut st = state.lock().unwrap();
    st.requests
        .push((method.clone(), path.clone(), auth.clone(), body.clone()));
    st.queries
        .push((method.clone(), path.clone(), query.clone()));
    let silicon_bearer = auth.as_deref() == Some(&format!("Bearer {}", st.access_token));
    let carbon_bearer = auth.as_deref() == Some(&format!("Bearer {}", st.carbon_token));
    let basic = format!("Basic {}", base64_encode(&format!("{APP_ID}:{APP_SECRET}")));
    let app_auth = auth.as_deref() == Some(basic.as_str());
    let json_body: Value = serde_json::from_str(&body).unwrap_or(Value::Null);

    let (status, value): (u16, Value) = match (method.as_str(), path.as_str()) {
        ("POST", "/v1/silicons/login") => {
            if json_body["id"] == SILICON_ID && json_body["stk"] == st.stk.as_str() {
                (200, silicon_tokens(&st))
            } else {
                error(
                    401,
                    "invalid_credentials",
                    "The si:id or STK is wrong.",
                    "Check both; ask the custodian to rotate the STK if it was lost.",
                )
            }
        }
        ("GET", "/v1/me") if silicon_bearer => (200, silicon_me()),
        ("GET", "/v1/me") if carbon_bearer => (200, carbon_me()),
        ("GET", "/v1/me") => error(
            401,
            "unauthenticated",
            "The access token is missing, expired or revoked.",
            "Sign in again.",
        ),
        ("POST", "/v1/me/short-lived-tokens") if silicon_bearer || carbon_bearer => (
            201,
            json!({ "slt": "slt_test_token", "app_id": json_body["app_id"], "expires_at": "2099-01-01T00:02:00.000Z" }),
        ),
        ("POST", "/v1/device/authorize") => (
            200,
            json!({ "device_code": "sad_device", "user_code": "WDJB-MJHT",
                    "verification_uri": "http://127.0.0.1/device", "verification_uri_complete": "http://127.0.0.1/device?code=WDJB-MJHT",
                    "expires_in": 600, "interval": 1 }),
        ),
        ("POST", "/v1/cli/login/start") => {
            if json_body["email"] == CARBON_EMAIL {
                (
                    200,
                    json!({ "challenge_id": "ch-1", "destination": "s***@example.com", "expires_at": "2099-01-01T00:10:00.000Z" }),
                )
            } else {
                error(
                    404,
                    "account_not_found",
                    "No Carbon account has that email or phone.",
                    "Sign up at accounts.teamofsilicons.com first.",
                )
            }
        }
        ("POST", "/v1/cli/login/verify") => {
            if json_body["challenge_id"] == "ch-1" && json_body["code"] == "123456" {
                (200, carbon_tokens(&st))
            } else {
                let (status, mut value) = error(
                    422,
                    "invalid_code",
                    "That code is wrong.",
                    "Check the latest code we sent; 9 attempts left.",
                );
                value["error"]["details"] = json!({ "remaining_attempts": 9 });
                (status, value)
            }
        }
        ("POST", "/v1/oauth/token") => {
            let f = form(&body);
            match f.get("grant_type").map(String::as_str) {
                Some("refresh_token") if f.get("refresh_token") == Some(&st.refresh_token) => {
                    st.generation += 1;
                    st.access_token = format!("at-{}", st.generation);
                    st.refresh_token = format!("sar_{}", st.generation);
                    (200, silicon_tokens(&st))
                }
                Some("refresh_token") => (
                    400,
                    json!({ "error": "invalid_grant", "error_description": "The refresh token was already used; the whole session was revoked." }),
                ),
                Some("authorization_code")
                    if f.get("code").map(String::as_str) == Some("sac_good") =>
                {
                    (200, carbon_tokens(&st))
                }
                Some("urn:ietf:params:oauth:grant-type:device_code") => {
                    st.device_polls += 1;
                    if st.device_polls < 2 {
                        (400, json!({ "error": "authorization_pending" }))
                    } else {
                        (200, carbon_tokens(&st))
                    }
                }
                _ => (400, json!({ "error": "unsupported_grant_type" })),
            }
        }
        ("POST", "/v1/oauth/revoke") => (200, json!({})),
        ("GET", "/v1/ids/available") => {
            let q = form(&query);
            let id = q.get("id").cloned().unwrap_or_default();
            if let Some(silicon) = q.get("for") {
                if !carbon_bearer {
                    error(
                        401,
                        "unauthenticated",
                        "?for= needs the custodian's session.",
                        "Sign in as the custodian.",
                    )
                } else if silicon == SILICON_ID || silicon == SILICON_UUID {
                    (
                        200,
                        json!({ "id": id, "available": true, "reason": null, "message": format!("{id} was an id of {SILICON_ID}; you can take it back for it."), "reclaimable": true }),
                    )
                } else {
                    error(
                        404,
                        "silicon_not_found",
                        &format!("You are not the custodian of a Silicon '{silicon}'."),
                        "List your Silicons with `accounts silicon list`.",
                    )
                }
            } else if id == "c:taken" {
                (
                    200,
                    json!({ "id": id, "available": false, "reason": "taken", "message": "c:taken belongs to another account.", "reclaimable": false }),
                )
            } else if id.contains(' ') {
                (
                    200,
                    json!({ "id": id, "available": false, "reason": "invalid", "message": "Ids can't contain spaces.", "reclaimable": false }),
                )
            } else {
                (
                    200,
                    json!({ "id": id, "available": true, "reason": null, "message": null, "reclaimable": false }),
                )
            }
        }
        ("POST", "/v1/silicons") => (
            201,
            json!({
                "silicon": new_silicon("pending_custodian"),
                "stk": STK,
                "request": { "id": "req-1", "status": "pending", "expires_at": "2099-01-01T00:00:00.000Z", "custodian": json_body["custodian"] },
                "request_token": "sarq_poll",
                "webhook_secret": null
            }),
        ),
        ("GET", "/v1/silicons/requests/req-1") if auth.as_deref() == Some("Bearer sarq_poll") => {
            st.request_polls += 1;
            let status = if st.request_polls >= st.accept_on_poll {
                "accepted"
            } else {
                "pending"
            };
            (
                200,
                json!({ "id": "req-1", "status": status, "expires_at": "2099-01-01T00:00:00.000Z",
                        "decided_at": if status == "accepted" { json!("2026-10-06T12:05:00.000Z") } else { Value::Null },
                        "silicon": { "uuid": SILICON_UUID, "id": SILICON_ID, "status": if status == "accepted" { "active" } else { "pending_custodian" } } }),
            )
        }
        ("POST", "/v1/me/silicons") if carbon_bearer => (
            201,
            json!({ "silicon": new_silicon("active"), "stk": STK, "webhook_secret": null }),
        ),
        ("GET", "/v1/apps/briefcase") if app_auth => (200, app_details(&st)),
        ("GET", "/v1/apps/briefcase") => error(
            401,
            "invalid_client",
            "The app credentials were rejected.",
            "Check the app id and secret.",
        ),
        ("POST", "/v1/apps/briefcase/imports") if app_auth => {
            (202, json!({ "job": import_job("queued", 0) }))
        }
        ("GET", "/v1/apps/briefcase/imports/job-1") if app_auth => {
            (200, json!({ "job": import_job("completed", 3) }))
        }
        ("GET", "/v1/apps/briefcase/imports/job-1/rows") if app_auth => (
            200,
            json!({ "items": [{ "row_number": 3, "outcome": "error", "account_uuid": null, "id": null,
                "messages": [{ "level": "error", "code": "missing_identifier", "message": "Row 3 has no valid email or phone.", "field": null }],
                "input": { "name": "Nobody" } }], "next_cursor": null }),
        ),
        ("POST", "/v1/proofs/ata") if app_auth => {
            if json_body.get("audiences").is_some() {
                error(
                    422,
                    "ata_single_app",
                    "An ATA proof is for exactly one app; ask for one proof per app.",
                    "Send {\"receiving_app\": \"remind\"} to POST /v1/proofs/ata instead of \"audiences\".",
                )
            } else {
                (
                    201,
                    json!({ "proof_id": "p-ata", "kind": "ata", "proof_token": "sap_ata", "expires_at": "2099-01-01T00:30:00.000Z",
                        "proof_refresh_token": "sapr_ata", "refresh_expires_at": "2099-06-01T00:00:00.000Z",
                        "issuing_app": APP_ID, "receiving_app": json_body["receiving_app"], "user": null,
                        "scopes": json_body.get("scopes").cloned().unwrap_or_else(|| json!([])) }),
                )
            }
        }
        ("POST", "/v1/proofs/verify") if app_auth => {
            if json_body["proof_token"] == "sap_valid" {
                (
                    200,
                    json!({ "valid": true, "proof_id": "p1", "kind": "obo", "expires_at": "2099-01-01T00:30:00.000Z",
                    "issuing_app": { "app_id": "dm", "name": "DM" }, "receiving_app": { "app_id": APP_ID, "name": "Briefcase" },
                    "user": { "uuid": CARBON_UUID, "id": CARBON_ID, "kind": "carbon", "membership_id": "dm:a8K" }, "scopes": ["files.write"] }),
                )
            } else {
                (200, json!({ "valid": false, "expires_at": null }))
            }
        }
        ("POST", "/v1/proofs/verify") => error(
            401,
            "invalid_client",
            "The app credentials were rejected.",
            "Check the app id and secret.",
        ),
        ("POST", "/v1/reports") => {
            if json_body["message"]
                .as_str()
                .unwrap_or_default()
                .chars()
                .count()
                > 10_000
            {
                error(
                    422,
                    "validation_failed",
                    "The report message is longer than 10000 characters.",
                    "Shorten it.",
                )
            } else {
                (
                    201,
                    json!({ "report_id": "rep-1", "status": "queued", "recipients": 3 }),
                )
            }
        }
        // A Silicon's own webhook deliveries, and its custodian's view of them.
        ("GET", "/v1/me/webhook/deliveries") if silicon_bearer => (
            200,
            json!({ "items": [delivery("d-1", "failed")], "next_cursor": null }),
        ),
        ("GET", "/v1/me/silicons/b9Z/webhook/deliveries") if carbon_bearer => (
            200,
            json!({ "items": [delivery("d-1", "failed")], "next_cursor": "c-2" }),
        ),
        ("GET", "/v1/me/webhook/deliveries/d-1") if silicon_bearer => (200, delivery_detail()),
        ("GET", "/v1/me/silicons/b9Z/webhook/deliveries/d-1") if carbon_bearer => {
            (200, delivery_detail())
        }
        ("POST", "/v1/me/webhook/replay") if silicon_bearer => (200, replay_result(&json_body)),
        ("POST", "/v1/me/silicons/b9Z/webhook/replay") if carbon_bearer => {
            (200, replay_result(&json_body))
        }
        ("GET", "/v1/me/silicons") if carbon_bearer => (
            200,
            json!({ "items": [{ "silicon": new_silicon("active"), "pending_transfer": null }], "next_cursor": null }),
        ),
        ("GET", "/v1/apps/briefcase/imports/job-failed") if app_auth => {
            let mut job = import_job("failed", 1);
            job["id"] = json!("job-failed");
            job["error"] = json!(
                "The worker processing this import stopped (the server restarted or crashed) more than twice."
            );
            (200, json!({ "job": job }))
        }
        ("GET", "/v1/apps/briefcase/imports/job-dry") if app_auth => {
            let mut job = import_job("completed", 3);
            job["id"] = json!("job-dry");
            job["dry_run"] = json!(true);
            (200, json!({ "job": job }))
        }
        ("PATCH", "/v1/apps/briefcase/signin-config") if app_auth => {
            // Like the service: a patch that changes nothing makes no new version.
            if let Some(uris) = json_body.get("redirect_uris")
                && *uris != st.redirect_uris
            {
                st.redirect_uris = uris.clone();
                st.config_version += 1;
            }
            (200, app_details(&st))
        }
        ("GET", "/v1/apps/briefcase/signin-config/history") if app_auth => (
            200,
            json!({ "items": [{ "version": st.config_version, "actor": CARBON_UUID,
                "actor_account": { "uuid": CARBON_UUID, "kind": "carbon", "id": CARBON_ID, "display_name": "Saket", "pfp_url": "", "status": "active" },
                "changes": [{ "path": "redirect_uris", "before": [], "after": st.redirect_uris }],
                "at": "2026-10-06T12:00:00.000Z" }], "next_cursor": null }),
        ),
        ("POST", "/v1/telemetry/events") => {
            st.telemetry_batches
                .push(serde_json::from_str(&body).unwrap_or(Value::Null));
            (202, json!({}))
        }
        // Like the service: a revoked or unknown access token is refused on every account route.
        (_, p)
            if p.starts_with("/v1/me")
                && auth.as_deref().is_some_and(|a| a.starts_with("Bearer "))
                && !silicon_bearer
                && !carbon_bearer =>
        {
            error(
                401,
                "unauthenticated",
                "The access token is missing, expired or revoked.",
                "Sign in again.",
            )
        }
        _ => error(
            404,
            "not_found",
            &format!("mock has no route for {method} {path}"),
            "Register it in the test.",
        ),
    };
    let mut response = Response::new(Body::from(value.to_string()));
    *response.status_mut() = StatusCode::from_u16(status).unwrap();
    response
        .headers_mut()
        .insert("content-type", "application/json".parse().unwrap());
    response
        .headers_mut()
        .insert("x-request-id", "req-test-1".parse().unwrap());
    response
}

fn base64_encode(text: &str) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let bytes = text.as_bytes();
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(ALPHABET[((n >> (18 - 6 * i)) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// An isolated environment for one test: its own HOME, no inherited ACCOUNTS_* settings.
pub struct Env {
    pub home: tempfile::TempDir,
}

impl Env {
    pub fn new() -> Self {
        Self {
            home: tempfile::tempdir().unwrap(),
        }
    }

    pub fn path(&self) -> &Path {
        self.home.path()
    }

    pub fn state_file(&self, name: &str) -> PathBuf {
        self.home.path().join(".accounts").join(name)
    }

    /// The same isolated command as [`Env::cmd`], as a `std::process::Command` (for a test that
    /// chooses where stdout goes).
    pub fn std_cmd(&self) -> std::process::Command {
        let mut cmd = std::process::Command::new(env!("CARGO_BIN_EXE_accounts"));
        for var in [
            "SILICON_HOME",
            "ACCOUNTS_HOME",
            "ACCOUNTS_URL",
            "ACCOUNTS_SILICON",
            "ACCOUNTS_STK",
            "ACCOUNTS_APP_ID",
            "ACCOUNTS_APP_SECRET",
            "ACCOUNTS_TIMEOUT_SECONDS",
            "ACCOUNTS_ALLOW_INSECURE_HTTP",
            "TZ",
        ] {
            cmd.env_remove(var);
        }
        cmd.env("HOME", self.home.path())
            .env("ACCOUNTS_TELEMETRY", "0")
            .env("ACCOUNTS_NO_BROWSER", "1")
            .env("NO_COLOR", "1")
            .env("HOSTNAME", "test-host");
        cmd
    }

    pub fn cmd(&self) -> assert_cmd::Command {
        let mut cmd = assert_cmd::Command::new(env!("CARGO_BIN_EXE_accounts"));
        for var in [
            "SILICON_HOME",
            "ACCOUNTS_HOME",
            "ACCOUNTS_URL",
            "ACCOUNTS_SILICON",
            "ACCOUNTS_STK",
            "ACCOUNTS_APP_ID",
            "ACCOUNTS_APP_SECRET",
            "ACCOUNTS_TIMEOUT_SECONDS",
            "ACCOUNTS_ALLOW_INSECURE_HTTP",
            "TZ",
        ] {
            cmd.env_remove(var);
        }
        cmd.env("HOME", self.home.path())
            .env("ACCOUNTS_TELEMETRY", "0")
            .env("ACCOUNTS_NO_BROWSER", "1")
            .env("NO_COLOR", "1")
            .env("HOSTNAME", "test-host")
            .timeout(std::time::Duration::from_secs(60));
        cmd
    }
}

/// Parses stdout as JSON.
pub fn stdout_json(output: &std::process::Output) -> Value {
    serde_json::from_slice(&output.stdout).unwrap_or_else(|e| {
        panic!(
            "stdout is not JSON ({e}):\n{}\nstderr:\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        )
    })
}
