//! Process logging. Silicon Accounts records no telemetry: logs stay on the host.

use crate::config::Settings;

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
