//! Telemetry to Space Station and process logging.
//!
//! [`Telemetry::record`] queues one self-contained event `{service, environment, version, source,
//! step, event, progress, context}` and never blocks or fails. It is active only when
//! ACCOUNTS_TELEMETRY_ENABLED is true and ACCOUNTS_TELEMETRY_TABLE_KEY is set; otherwise every
//! call is a no-op.

use std::sync::Arc;
use std::time::Duration;

use secrecy::ExposeSecret;
use serde_json::{Value, json};

use crate::config::Settings;

/// Cheap to clone; shared by every request.
#[derive(Clone, Default)]
pub struct Telemetry {
    client: Option<Arc<space_station::SpaceClient>>,
    environment: &'static str,
}

impl std::fmt::Debug for Telemetry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Telemetry")
            .field("enabled", &self.client.is_some())
            .finish()
    }
}

impl Telemetry {
    /// Telemetry that drops everything.
    pub fn disabled() -> Telemetry {
        Telemetry {
            client: None,
            environment: "",
        }
    }

    /// Builds from settings; a missing key or a client error leaves telemetry disabled.
    pub fn from_settings(settings: &Settings) -> Telemetry {
        let environment = settings.environment.as_str();
        if !settings.telemetry_enabled {
            return Telemetry {
                client: None,
                environment,
            };
        }
        let Some(key) = &settings.telemetry_table_key else {
            return Telemetry {
                client: None,
                environment,
            };
        };
        let built = space_station::SpaceClient::builder(key.expose_secret())
            .flush_timeout(Duration::from_millis(500))
            .on_error(|e| tracing::debug!(error = %e, "telemetry event dropped"))
            .build();
        match built {
            Ok(client) => Telemetry {
                client: Some(Arc::new(client)),
                environment,
            },
            Err(e) => {
                tracing::warn!(error = %e, "Space Station telemetry disabled: the table key was rejected");
                Telemetry {
                    client: None,
                    environment,
                }
            }
        }
    }

    pub fn is_enabled(&self) -> bool {
        self.client.is_some()
    }

    /// Records an event (no-op when disabled). Never put secrets or codes in `data`.
    pub fn record(&self, source: &str, step: &str, name: &str, data: Value) {
        self.record_progress(source, step, name, None, data);
    }

    /// Records an event with a progress fraction (0.0..=1.0).
    pub fn record_progress(
        &self,
        source: &str,
        step: &str,
        name: &str,
        progress: Option<f64>,
        data: Value,
    ) {
        if let Some(client) = &self.client {
            client.record(json!({
                "service": "silicon-accounts",
                "environment": self.environment,
                "version": crate::VERSION,
                "source": source,
                "step": step,
                "event": name,
                "progress": progress,
                "context": data,
            }));
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
    fn bad_key_disables_instead_of_failing() {
        let mut s = Settings::for_tests();
        s.telemetry_enabled = true;
        s.telemetry_table_key = Some(secrecy::SecretString::from("not-a-key"));
        let t = Telemetry::from_settings(&s);
        assert!(!t.is_enabled());
    }
}
