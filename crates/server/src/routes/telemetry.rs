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

use accounts_core::http::{ClientMeta, Json};
use accounts_core::repo::rate_limit;
use accounts_core::{ApiError, AppState, FieldErrors};
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::middleware::observe::opted_out;

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
    /// Which step of a flow (`login.device.approved`) or command (`accounts login status`).
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
        for e in &batch.events {
            let mut data = match &e.data {
                Value::Object(map) => Value::Object(map.clone()),
                _ => json!({}),
            };
            // Mark client-reported events so they are never mistaken for the service's own.
            data["reported_by"] = json!("client");
            state
                .telemetry
                .record_progress(&e.source, &e.step, &e.name, e.progress, data);
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
            step: "accounts login status".into(),
            name: name.into(),
            progress: Some(1.0),
            data: json!({"outcome": "ok"}),
        }
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
