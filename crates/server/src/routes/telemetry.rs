//! `POST /v1/telemetry/events`: telemetry from clients (the CLI sends `cli.command` and
//! `cli.step` events), forwarded to Space Station.
//!
//! Body `{"events":[{"source":"cli","step":"login.device.approved","name":"cli.step",
//! "progress":0.9,"data":{…}}]}`: at most 50 events, names `^[a-z0-9_.]{1,64}$`, `progress`
//! 0..1, `data` a JSON object of at most 8 KB. Answers `202 {"accepted":n,"forwarded":bool}`.
//! Nothing is forwarded when the caller opted out (`X-Accounts-Telemetry: off` or the cookie
//! `sa_telemetry=off`) or when this deployment has telemetry disabled
//! (ACCOUNTS_TELEMETRY_ENABLED / _TABLE_KEY); the batch is still validated so clients learn
//! about mistakes. 120 batches per minute per IP.
//!
//! What is forwarded is cut down to what the CLI reports, word for word, so no identifier or
//! free text a client puts in an event ever reaches Space Station, whatever its shape:
//! - only the CLI's events: `source` `cli`, `name` `cli.command` or `cli.step`
//!   ([`forwarded_event`]); any other event is accepted and dropped;
//! - `step` as one of the CLI's step names or command paths ([`lists`]), else `other`
//!   ([`forwarded_step`]); `progress` to the hundredth;
//! - `data` with only the known fields of [`FIELDS`] ([`forwarded_data`]): flags, bounded
//!   counts, a few fixed words, a release version, and `command`, `os`, `arch` and
//!   `error_code` as one of the listed words, else `other`. `app_id` (or the CLI's `app`) is
//!   kept only on the short-lived-token step ([`SLT_STEPS`]). Everything else is dropped.

use accounts_core::http::{ClientMeta, Json};
use accounts_core::repo::rate_limit;
use accounts_core::{ApiError, AppState, FieldErrors};
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::middleware::observe::opted_out;

pub mod lists;

/// Most events per request.
pub const MAX_EVENTS: usize = 50;
/// Largest `data` object per event (serialized).
pub const MAX_DATA_BYTES: usize = 8 * 1024;

/// Request body.
#[derive(Debug, Clone, Deserialize)]
pub struct TelemetryBatch {
    pub events: Vec<IncomingEvent>,
}

/// One event. Unknown fields are ignored so newer clients keep working.
#[derive(Debug, Clone, Deserialize)]
pub struct IncomingEvent {
    /// Where it comes from: `cli`, `web`, …
    pub source: String,
    /// Which step of a flow (`login.device.approved`) or command (`silicon-accounts login status`).
    pub step: String,
    /// Event name, `^[a-z0-9_.]{1,64}$` (`cli.command`, `cli.step`).
    pub name: String,
    /// How far the flow got, 0..1.
    #[serde(default)]
    pub progress: Option<f64>,
    /// Context (a JSON object; never secrets).
    #[serde(default)]
    pub data: Value,
}

/// `^[a-z0-9_.]{1,64}$`.
pub fn valid_name(name: &str) -> bool {
    (1..=64).contains(&name.len())
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'.')
}

fn valid_source(source: &str) -> bool {
    (1..=64).contains(&source.len())
        && source.bytes().all(|b| {
            b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'.' || b == b'-'
        })
}

fn shorten(s: &str) -> String {
    let mut out: String = s.chars().take(80).collect();
    if s.chars().count() > 80 {
        out.push('…');
    }
    out
}

/// How a forwarded `data` field's value is checked; a value that doesn't fit is dropped.
#[derive(Debug, Clone, Copy)]
enum Shape {
    /// `true` or `false`.
    Flag,
    /// A whole number from 0 up to this.
    Count(u64),
    /// A process exit code: a whole number from -1000 to 1000.
    ExitCode,
    /// One of these words; any other value is dropped.
    OneOf(&'static [&'static str]),
    /// One of these words; any other string is forwarded as `other` (the lists of [`lists`]).
    Listed(&'static [&'static str]),
    /// A version: `1.2.3`, or `1.2.3-rc.1` (alpha, beta, rc, dev or pre, with an optional
    /// number).
    Version,
    /// An app id, on [`SLT_STEPS`] only.
    AppId,
}

/// Every `data` field forwarded, with its shape: the fields the silicon-accounts CLI sends.
/// `null` is forwarded for any of them (the CLI sends `error_code: null` on success and
/// `account_kind: null` when signed out).
const FIELDS: &[(&str, Shape)] = &[
    // Every CLI event.
    ("command", Shape::Listed(lists::COMMANDS)),
    ("cli_version", Shape::Version),
    ("os", Shape::Listed(lists::OS)),
    ("arch", Shape::Listed(lists::ARCH)),
    // `cli.command`: how the command ended.
    ("outcome", Shape::OneOf(&["ok", "error"])),
    ("exit_code", Shape::ExitCode),
    ("error_code", Shape::Listed(lists::ERROR_CODES)),
    // A day at most.
    ("duration_ms", Shape::Count(86_400_000)),
    ("json", Shape::Flag),
    ("account_kind", Shape::OneOf(&["carbon", "silicon"])),
    // `cli.step` details.
    ("kind", Shape::OneOf(&["carbon", "silicon"])),
    (
        "method",
        Shape::OneOf(&[
            "device",
            "email",
            "phone",
            "silicon_stk",
            "silicon_key",
            "federated",
        ]),
    ),
    ("channel", Shape::OneOf(&["email", "phone"])),
    ("browser_opened", Shape::Flag),
    ("dry_run", Shape::Flag),
    ("format", Shape::OneOf(&["csv", "json"])),
    // A day at most (identity tokens live an hour at most).
    ("ttl_seconds", Shape::Count(86_400)),
    ("wait", Shape::Flag),
    ("webhook", Shape::Flag),
    ("signed_in", Shape::Flag),
    ("app", Shape::AppId),
    ("app_id", Shape::AppId),
];

/// The steps on which an app id is forwarded: getting a short-lived token for an app.
pub const SLT_STEPS: &[&str] = &["login.slt.issued"];

/// What an open-ended value is forwarded as: itself when it is one of `words`, else `other`.
const OTHER: &str = "other";

/// Whether an event is forwarded at all: only the CLI's (`source` `cli`, `name` `cli.command`
/// or `cli.step`). Others are accepted and dropped.
pub fn forwarded_event(source: &str, name: &str) -> bool {
    lists::SOURCES.contains(&source) && lists::NAMES.contains(&name)
}

/// What `step` is forwarded as: itself when it is one of the CLI's step names
/// (`login.device.approved`) or command paths (`app webhook set`), `other` for anything else.
pub fn forwarded_step(step: &str) -> &str {
    if lists::STEPS.contains(&step) || lists::COMMANDS.contains(&step) {
        step
    } else {
        OTHER
    }
}

/// `progress` to the hundredth: how far a flow got, and no room for anything else.
pub fn forwarded_progress(progress: Option<f64>) -> Option<f64> {
    progress.map(|p| (p * 100.0).round() / 100.0)
}

/// `^\d{1,9}\.\d{1,9}\.\d{1,9}(-(alpha|beta|rc|dev|pre)(\.\d{1,9})?)?$`.
fn is_version(v: &str) -> bool {
    let number = |n: &str| (1..=9).contains(&n.len()) && n.bytes().all(|b| b.is_ascii_digit());
    let (core, pre) = match v.split_once('-') {
        Some((core, pre)) => (core, Some(pre)),
        None => (v, None),
    };
    let parts: Vec<&str> = core.split('.').collect();
    parts.len() == 3
        && parts.iter().all(|n| number(n))
        && pre.is_none_or(|pre| {
            let (label, n) = match pre.split_once('.') {
                Some((label, n)) => (label, Some(n)),
                None => (pre, None),
            };
            ["alpha", "beta", "rc", "dev", "pre"].contains(&label) && n.is_none_or(number)
        })
}

/// The value forwarded for a field of `shape`, or `None` to drop it.
fn forwarded_value(shape: Shape, value: &Value, step: &str) -> Option<Value> {
    let kept = match (shape, value) {
        (Shape::AppId, _) if !SLT_STEPS.contains(&step) => false,
        (_, Value::Null) => true,
        (Shape::Flag, Value::Bool(_)) => true,
        (Shape::Count(max), Value::Number(n)) => n.as_u64().is_some_and(|c| c <= max),
        (Shape::ExitCode, Value::Number(n)) => {
            n.as_i64().is_some_and(|c| (-1000..=1000).contains(&c))
        }
        (Shape::OneOf(words), Value::String(s)) => words.contains(&s.as_str()),
        (Shape::Listed(words), Value::String(s)) => {
            return Some(Value::from(if words.contains(&s.as_str()) {
                s.as_str()
            } else {
                OTHER
            }));
        }
        (Shape::Version, Value::String(s)) => is_version(s),
        (Shape::AppId, Value::String(s)) => accounts_core::ids::validate_app_id(s).is_ok(),
        _ => false,
    };
    kept.then(|| value.clone())
}

/// The `data` forwarded for an event at `step`: only the fields of [`FIELDS`] whose values fit
/// their shape, open-ended words outside their lists as `other`, everything else dropped.
pub fn forwarded_data(step: &str, data: &Value) -> serde_json::Map<String, Value> {
    let mut out = serde_json::Map::new();
    let Value::Object(map) = data else {
        return out;
    };
    for (key, shape) in FIELDS {
        if let Some(value) = map
            .get(*key)
            .and_then(|value| forwarded_value(*shape, value, step))
        {
            out.insert((*key).to_string(), value);
        }
    }
    out
}

/// Checks every event; all problems are reported at once, keyed `events[i].field`.
pub fn validate(batch: &TelemetryBatch) -> Result<(), ApiError> {
    let mut fields = FieldErrors::new();
    if batch.events.len() > MAX_EVENTS {
        fields.add(
            "events",
            format!(
                "has {} events; send at most {MAX_EVENTS} per request",
                batch.events.len()
            ),
        );
        return fields.into_result();
    }
    for (i, e) in batch.events.iter().enumerate() {
        if !valid_name(&e.name) {
            fields.add(
                format!("events[{i}].name"),
                format!(
                    "'{}' must match ^[a-z0-9_.]{{1,64}}$ (lowercase letters, digits, '_' and '.'), e.g. cli.command",
                    shorten(&e.name)
                ),
            );
        }
        if !valid_source(&e.source) {
            fields.add(
                format!("events[{i}].source"),
                format!(
                    "'{}' must be 1-64 characters of a-z, 0-9, '_', '.' and '-', e.g. cli",
                    shorten(&e.source)
                ),
            );
        }
        let step_chars = e.step.chars().count();
        if e.step.trim().is_empty() || step_chars > 200 || e.step.chars().any(char::is_control) {
            fields.add(
                format!("events[{i}].step"),
                "must be 1-200 printable characters, e.g. login.device.approved",
            );
        }
        if let Some(p) = e.progress
            && !(p.is_finite() && (0.0..=1.0).contains(&p))
        {
            fields.add(
                format!("events[{i}].progress"),
                format!("is {p}; it must be a number from 0 to 1"),
            );
        }
        match &e.data {
            Value::Null | Value::Object(_) => {
                let size = serde_json::to_vec(&e.data).map(|v| v.len()).unwrap_or(0);
                if size > MAX_DATA_BYTES {
                    fields.add(
                        format!("events[{i}].data"),
                        format!("is {size} bytes of JSON; the limit is {MAX_DATA_BYTES}"),
                    );
                }
            }
            other => fields.add(
                format!("events[{i}].data"),
                format!(
                    "must be a JSON object, not {}",
                    match other {
                        Value::Array(_) => "an array",
                        Value::String(_) => "a string",
                        Value::Number(_) => "a number",
                        _ => "a boolean",
                    }
                ),
            ),
        }
    }
    fields.into_result()
}

/// `POST /v1/telemetry/events` → `202 {"accepted","forwarded"}`.
pub async fn ingest(
    State(state): State<AppState>,
    meta: ClientMeta,
    headers: HeaderMap,
    Json(batch): Json<TelemetryBatch>,
) -> Result<Response, ApiError> {
    validate(&batch)?;
    let forwarded = !opted_out(&headers) && state.telemetry.is_enabled();
    if forwarded {
        rate_limit::enforce_pool(
            &state.db,
            &rate_limit::bucket("telemetry:ip", meta.ip_or_unknown()),
            rate_limit::limits::TELEMETRY_PER_IP,
            "telemetry batches from this network",
        )
        .await?;
        // Only the CLI's events, with known words and fields: no identifiers, no free text.
        for e in batch
            .events
            .iter()
            .filter(|e| forwarded_event(&e.source, &e.name))
        {
            let mut data = forwarded_data(&e.step, &e.data);
            // Mark client-reported events so they are never mistaken for the service's own.
            data.insert("reported_by".into(), json!("client"));
            state.telemetry.record_progress(
                &e.source,
                forwarded_step(&e.step),
                &e.name,
                forwarded_progress(e.progress),
                Value::Object(data),
            );
        }
    }
    Ok((
        StatusCode::ACCEPTED,
        Json(json!({ "accepted": batch.events.len(), "forwarded": forwarded })),
    )
        .into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(name: &str) -> IncomingEvent {
        IncomingEvent {
            source: "cli".into(),
            step: "silicon-accounts login status".into(),
            name: name.into(),
            progress: Some(1.0),
            data: json!({"outcome": "ok"}),
        }
    }

    #[test]
    fn only_known_fields_in_their_shapes_are_forwarded() {
        let data = json!({
            "command": "silicon webhook replay", "cli_version": "0.4.0-rc.1",
            "os": "linux", "arch": "x86_64", "outcome": "ok", "exit_code": 0,
            "error_code": null, "duration_ms": 12, "json": false, "account_kind": null,
            "dry_run": true, "format": "csv", "ttl_seconds": 600, "wait": false,
            "webhook": true, "signed_in": true, "channel": "email", "browser_opened": false,
            "app": "briefcase", "app_id": "briefcase", "source": "github-actions",
            "email": "a@b.c",
        });
        let out = forwarded_data("login.done", &data);
        let mut keys: Vec<&str> = out.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            vec![
                "account_kind",
                "arch",
                "browser_opened",
                "channel",
                "cli_version",
                "command",
                "dry_run",
                "duration_ms",
                "error_code",
                "exit_code",
                "format",
                "json",
                "os",
                "outcome",
                "signed_in",
                "ttl_seconds",
                "wait",
                "webhook",
            ]
        );
        // App ids on the short-lived-token step only, and only when they are app ids.
        let slt = forwarded_data("login.slt.issued", &data);
        assert_eq!(slt["app"], "briefcase");
        assert_eq!(slt["app_id"], "briefcase");
        let bad = forwarded_data(
            "login.slt.issued",
            &json!({"app": "Saket's App", "app_id": "si:scout"}),
        );
        assert!(bad.is_empty(), "{bad:?}");
        // Values of another shape are dropped.
        for (key, value) in [
            ("cli_version", json!("latest")),
            ("cli_version", json!("1.2")),
            ("cli_version", json!("0.4.0-rc.1+build.7")),
            ("cli_version", json!("0.4.0-saket.example.com")),
            ("command", json!(["login"])),
            ("os", json!(1)),
            ("exit_code", json!(1_000_000)),
            ("exit_code", json!("1")),
            ("duration_ms", json!(-1)),
            ("duration_ms", json!(1.5)),
            ("duration_ms", json!(14_155_550_100_u64)),
            ("ttl_seconds", json!(86_401)),
            ("json", json!("true")),
            ("outcome", json!("maybe")),
            ("method", json!("password")),
        ] {
            assert!(
                forwarded_data("login.done", &json!({ key: value })).is_empty(),
                "{key}: {value}"
            );
        }
        assert!(forwarded_data("login.done", &json!(["not", "an", "object"])).is_empty());
    }

    /// Open-ended words go through only when the CLI could have sent them: an identifier or
    /// free text in any shape becomes `other`.
    #[test]
    fn open_ended_words_are_forwarded_only_from_their_lists() {
        let words = json!({
            "command": "app webhook set", "os": "macos", "arch": "aarch64",
            "error_code": "webhook_not_set",
        });
        assert_eq!(
            Value::Object(forwarded_data("app webhook set", &words)),
            words
        );
        for (key, value) in [
            ("command", "login as saket"),
            ("command", "saket example com"),
            ("command", "login --as saket@example.com"),
            ("os", "saket"),
            ("os", "Saket's Mac"),
            ("arch", "saket_laptop"),
            ("error_code", "saket_example_com"),
            ("error_code", "Not Found"),
        ] {
            assert_eq!(
                forwarded_data("login.done", &json!({ key: value }))[key],
                "other",
                "{key}: {value}"
            );
        }
    }

    #[test]
    fn steps_are_forwarded_only_as_the_clis_steps_or_commands() {
        assert_eq!(
            forwarded_step("login.device.approved"),
            "login.device.approved"
        );
        assert_eq!(forwarded_step("app webhook set"), "app webhook set");
        assert_eq!(forwarded_step("session.refreshed"), "session.refreshed");
        for made_up in [
            "signed in as saket@example.com",
            "signed in saket",
            "login.saket_example_com",
            "user.saket.example.com",
            "login as saket",
            "login.Saket",
            "/home/runner",
            "a..b",
        ] {
            assert_eq!(forwarded_step(made_up), "other", "{made_up}");
        }
    }

    #[test]
    fn only_the_clis_events_are_forwarded() {
        assert!(forwarded_event("cli", "cli.command"));
        assert!(forwarded_event("cli", "cli.step"));
        for (source, name) in [
            ("saket.example.com", "cli.step"),
            ("0b6f5a8e-5d1c-4a8e-9f00-2b1b9d5c7e11", "cli.command"),
            ("web", "web.step"),
            ("cli", "saket.example.com"),
        ] {
            assert!(!forwarded_event(source, name), "{source} {name}");
        }
        assert_eq!(forwarded_progress(Some(0.4155550100)), Some(0.42));
        assert_eq!(forwarded_progress(None), None);
    }

    #[test]
    fn accepts_the_cli_events() {
        let batch = TelemetryBatch {
            events: vec![event("cli.command"), event("cli.step")],
        };
        assert!(validate(&batch).is_ok());
    }

    #[test]
    fn rejects_bad_events_with_paths() {
        let mut bad = event("CLI Command!");
        bad.progress = Some(1.5);
        bad.data = json!([1, 2]);
        bad.source = "".into();
        let e = validate(&TelemetryBatch {
            events: vec![event("ok"), bad],
        })
        .expect_err("invalid");
        let f = &e.details["fields"];
        assert!(
            f["events[1].name"]
                .as_str()
                .is_some_and(|m| m.contains("^[a-z0-9_.]{1,64}$"))
        );
        assert!(f["events[1].progress"].is_string());
        assert!(
            f["events[1].data"]
                .as_str()
                .is_some_and(|m| m.contains("an array"))
        );
        assert!(f["events[1].source"].is_string());
        assert!(f.get("events[0].name").is_none());

        let many = TelemetryBatch {
            events: (0..51).map(|_| event("cli.step")).collect(),
        };
        let e = validate(&many).expect_err("too many");
        assert!(
            e.details["fields"]["events"]
                .as_str()
                .is_some_and(|m| m.contains("51 events"))
        );
        assert!(valid_name(&"a".repeat(64)) && !valid_name(&"a".repeat(65)));
    }
}
