//! Telemetry to Space Station and process logging.
//!
//! [`Telemetry::record`] queues one self-contained event `{service, environment, version, source,
//! step, event, progress, context}` and never blocks or fails. It is active only when
//! ACCOUNTS_TELEMETRY_ENABLED is true and ACCOUNTS_TELEMETRY_TABLE_KEY is set; otherwise every
//! call is a no-op.
//!
//! **Opting out.** A caller opts out of telemetry for a request with the header
//! `X-Accounts-Telemetry: off` or the cookie `sa_telemetry=off` (the account site's switch; the
//! cookie also covers requests a page can't add headers to, such as image loads). The server
//! runs each request inside [`with_request_opt_out`], and [`Telemetry::record_progress`] drops
//! every event recorded inside an opted-out request: the request log event and every event a
//! handler records. Background work (webhook delivery, import jobs, sweeps) is the service's
//! own and keeps reporting.

use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::http::HeaderMap;
use secrecy::ExposeSecret;
use serde_json::{Value, json};

use crate::config::Settings;

/// Header with which a caller opts out of telemetry for one request.
pub const OPT_OUT_HEADER: &str = "x-accounts-telemetry";

/// Cookie with which a browser opts out of telemetry (set by the account site, readable by it;
/// `__Host-sa_telemetry` is accepted too).
pub const OPT_OUT_COOKIE: &str = "sa_telemetry";

/// True for the opt-out values `off`, `0`, `false` and `no` (any case).
fn is_off(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "off" | "0" | "false" | "no"
    )
}

/// True when a request opted out of telemetry: `X-Accounts-Telemetry: off` (or 0/false/no), or
/// the cookie `sa_telemetry=off` (also `__Host-sa_telemetry`).
pub fn request_opts_out(headers: &HeaderMap) -> bool {
    let by_header = headers
        .get_all(OPT_OUT_HEADER)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .any(is_off);
    by_header
        || headers
            .get_all(axum::http::header::COOKIE)
            .iter()
            .filter_map(|v| v.to_str().ok())
            .flat_map(|v| v.split(';'))
            .filter_map(|pair| pair.split_once('='))
            .any(|(name, value)| {
                let name = name.trim();
                (name == OPT_OUT_COOKIE || name == "__Host-sa_telemetry")
                    && is_off(value.trim().trim_matches('"'))
            })
}

tokio::task_local! {
    /// Whether the request this task serves opted out of telemetry.
    static REQUEST_OPTED_OUT: bool;
}

/// Runs `future` (one request) with its telemetry choice: while it runs, events recorded by
/// this task are dropped when `opted_out` is true.
pub async fn with_request_opt_out<F: Future>(opted_out: bool, future: F) -> F::Output {
    REQUEST_OPTED_OUT.scope(opted_out, future).await
}

/// True inside a request that opted out of telemetry (see [`with_request_opt_out`]).
pub fn current_request_opted_out() -> bool {
    REQUEST_OPTED_OUT.try_with(|v| *v).unwrap_or(false)
}

/// Events captured by [`Telemetry::capturing`] (tests).
pub type CapturedEvents = Arc<Mutex<Vec<Value>>>;

/// Cheap to clone; shared by every request.
#[derive(Clone, Default)]
pub struct Telemetry {
    client: Option<Arc<space_station::SpaceClient>>,
    /// Test sink: every recorded event is also kept here.
    captured: Option<CapturedEvents>,
    environment: &'static str,
}

impl std::fmt::Debug for Telemetry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Telemetry")
            .field("enabled", &self.is_enabled())
            .finish()
    }
}

impl Telemetry {
    /// Telemetry that drops everything.
    pub fn disabled() -> Telemetry {
        Telemetry {
            client: None,
            captured: None,
            environment: "",
        }
    }

    /// Telemetry that keeps every event in memory instead of sending it (for tests: what would
    /// reach Space Station, with the opt-out rules applied).
    pub fn capturing() -> (Telemetry, CapturedEvents) {
        let sink: CapturedEvents = Arc::new(Mutex::new(Vec::new()));
        (
            Telemetry {
                client: None,
                captured: Some(sink.clone()),
                environment: "test",
            },
            sink,
        )
    }

    /// Builds from settings; a missing key or a client error leaves telemetry disabled.
    pub fn from_settings(settings: &Settings) -> Telemetry {
        let environment = settings.environment.as_str();
        let off = Telemetry {
            client: None,
            captured: None,
            environment,
        };
        if !settings.telemetry_enabled {
            return off;
        }
        let Some(key) = &settings.telemetry_table_key else {
            return off;
        };
        let built = space_station::SpaceClient::builder(key.expose_secret())
            .flush_timeout(Duration::from_millis(500))
            .on_error(|e| tracing::debug!(error = %e, "telemetry event dropped"))
            .build();
        match built {
            Ok(client) => Telemetry {
                client: Some(Arc::new(client)),
                ..off
            },
            Err(e) => {
                tracing::warn!(error = %e, "Space Station telemetry disabled: the table key was rejected");
                off
            }
        }
    }

    /// True when events go somewhere (Space Station, or the test sink).
    pub fn is_enabled(&self) -> bool {
        self.client.is_some() || self.captured.is_some()
    }

    /// Records an event (no-op when disabled). Never put secrets or codes in `data`.
    pub fn record(&self, source: &str, step: &str, name: &str, data: Value) {
        self.record_progress(source, step, name, None, data);
    }

    /// Records an event with a progress fraction (0.0..=1.0). Dropped inside a request that
    /// opted out (see the module docs).
    pub fn record_progress(
        &self,
        source: &str,
        step: &str,
        name: &str,
        progress: Option<f64>,
        data: Value,
    ) {
        if !self.is_enabled() || current_request_opted_out() {
            return;
        }
        let event = json!({
            "service": "silicon-accounts",
            "environment": self.environment,
            "version": crate::VERSION,
            "source": source,
            "step": step,
            "event": name,
            "progress": progress,
            "context": data,
        });
        if let Some(sink) = &self.captured
            && let Ok(mut events) = sink.lock()
        {
            events.push(event.clone());
        }
        if let Some(client) = &self.client {
            client.record(event);
        }
    }
}

/// Installs the global `tracing` subscriber: JSON lines in production, human-readable otherwise.
/// Safe to call more than once (later calls are ignored).
pub fn init_logging(settings: &Settings) {
    use tracing_subscriber::EnvFilter;
    let filter =
        EnvFilter::try_new(&settings.log_filter).unwrap_or_else(|_| EnvFilter::new("info"));
    if settings.environment.is_production() {
        let _ = tracing_subscriber::fmt()
            .with_env_filter(filter)
            .json()
            .with_current_span(false)
            .try_init();
    } else {
        // Colours only for a terminal: log files and CI output stay free of escape codes.
        let _ = tracing_subscriber::fmt()
            .with_env_filter(filter)
            .with_target(true)
            .with_ansi(std::io::IsTerminal::is_terminal(&std::io::stdout()))
            .try_init();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disabled_without_key_and_never_fails() {
        let mut s = Settings::for_tests();
        s.telemetry_enabled = true;
        let t = Telemetry::from_settings(&s);
        assert!(!t.is_enabled());
        t.record("api", "test", "noop", json!({"x": 1}));
    }

    #[test]
    fn opt_out_by_header_or_cookie() {
        use axum::http::HeaderValue;
        let mut h = HeaderMap::new();
        assert!(!request_opts_out(&h));
        h.insert(OPT_OUT_HEADER, HeaderValue::from_static("OFF"));
        assert!(request_opts_out(&h));
        h.insert(OPT_OUT_HEADER, HeaderValue::from_static("on"));
        assert!(!request_opts_out(&h));
        h.insert(
            axum::http::header::COOKIE,
            HeaderValue::from_static("sa_session=sas_x; sa_telemetry=off"),
        );
        assert!(request_opts_out(&h), "the cookie alone opts out");
        h.insert(
            axum::http::header::COOKIE,
            HeaderValue::from_static("__Host-sa_telemetry=0"),
        );
        assert!(request_opts_out(&h));
        h.insert(
            axum::http::header::COOKIE,
            HeaderValue::from_static("sa_telemetry=on; other=off"),
        );
        assert!(!request_opts_out(&h));
    }

    #[tokio::test]
    async fn events_inside_an_opted_out_request_are_dropped() {
        let (t, sink) = Telemetry::capturing();
        t.record("api", "outside", "kept.outside", json!({}));
        with_request_opt_out(true, async {
            t.record("api", "inside", "dropped", json!({}));
            // Nested work of the same task is covered too.
            async { t.record("api", "nested", "dropped.nested", json!({})) }.await;
        })
        .await;
        with_request_opt_out(false, async {
            t.record("api", "inside", "kept.inside", json!({}));
        })
        .await;
        let names: Vec<String> = sink
            .lock()
            .expect("sink")
            .iter()
            .map(|e| e["event"].as_str().unwrap_or_default().to_string())
            .collect();
        assert_eq!(names, vec!["kept.outside", "kept.inside"]);
        assert!(!current_request_opted_out());
    }

    #[test]
    fn bad_key_disables_instead_of_failing() {
        let mut s = Settings::for_tests();
        s.telemetry_enabled = true;
        s.telemetry_table_key = Some(secrecy::SecretString::from("not-a-key"));
        let t = Telemetry::from_settings(&s);
        assert!(!t.is_enabled());
    }
}
