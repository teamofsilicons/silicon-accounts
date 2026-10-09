//! `accounts-api`: the Silicon Accounts HTTP service.
//!
//! Reads the ACCOUNTS_* settings (and `.env` outside production; every problem is reported at
//! once), connects to Postgres, refuses a database with pending migrations, loads the
//! phone-number metadata, records ACCOUNTS_DEVELOPER_URL in the developer platform's stored
//! sign-in setup, starts the background tasks when ACCOUNTS_WORKER_ENABLED, and serves
//! on ACCOUNTS_BIND_ADDR until Ctrl-C / SIGTERM. On shutdown, at the same moment, it stops
//! accepting connections and lets in-flight requests finish (at most 30 s), and the worker stops
//! claiming work and finishes the sends it has in flight (normally within one 10 s send timeout;
//! cut off after 20 s, when another node retries them once their 60 s claim ends). The whole
//! stop takes at most 30 s.
//!
//! Exit codes: 0 clean shutdown, 1 runtime failure (database, port), 2 invalid configuration.

use std::net::SocketAddr;
use std::process::ExitCode;
use std::time::Duration;

use accounts_core::secrecy::ExposeSecret;
use accounts_core::{AppState, Settings};
use accounts_server::BackgroundTasks;
use tokio::sync::watch;

/// How long in-flight requests may run after shutdown starts.
const DRAIN_TIMEOUT: Duration = Duration::from_secs(30);
/// How long the worker may take to finish the sends in flight: one send takes at most its 10 s
/// HTTP timeout, plus a little database time, so 20 s covers it with room to spare.
const WORKER_GRACE: Duration = Duration::from_secs(20);

#[tokio::main]
async fn main() -> ExitCode {
    match run().await {
        Ok(()) => ExitCode::SUCCESS,
        Err((code, message)) => {
            tracing::error!("{message}");
            eprintln!("{message}");
            ExitCode::from(code)
        }
    }
}

async fn run() -> Result<(), (u8, String)> {
    let settings = Settings::from_env().map_err(|e| {
        (
            2,
            format!("{e}hint: fix the variables above (see .env.example for every variable and its default)."),
        )
    })?;
    accounts_core::telemetry::init_logging(&settings);
    if let Some(dist) = &settings.web_dist
        && !dist.join("index.html").is_file()
    {
        return Err((
            2,
            format!(
                "error: ACCOUNTS_WEB_DIST is {} but it has no index.html, so the account site can't be served.\nhint: build it with `pnpm -C web build` and point ACCOUNTS_WEB_DIST at web/dist, or unset ACCOUNTS_WEB_DIST to serve only the API.",
                dist.display()
            ),
        ));
    }
    let db_url = accounts_server::redact_database_url(settings.database_url.expose_secret());
    let pool = accounts_core::db::connect(&settings).await.map_err(|e| {
        (
            1,
            format!(
                "error: could not connect to the database at {db_url}: {e}\nhint: start Postgres (scripts/dev-db.sh) or fix ACCOUNTS_DATABASE_URL."
            ),
        )
    })?;
    let pending = accounts_core::db::pending_migrations(&pool)
        .await
        .map_err(|e| {
            (
                1,
                format!("error: could not read the migration state of {db_url}: {e}"),
            )
        })?;
    if !pending.is_empty() {
        let list: Vec<String> = pending
            .iter()
            .map(|m| format!("{:04} {}", m.version, m.description))
            .collect();
        return Err((
            1,
            format!(
                "error: the database at {db_url} is missing {} migration(s): {}\nhint: run `accounts-migrate` first.",
                pending.len(),
                list.join(", ")
            ),
        ));
    }
    // The phone-number metadata loads on the first number parsed (about 1 s unoptimized, far longer
    // on a busy machine): load it before listening, so readiness means no request waits for it.
    if let Err(e) =
        tokio::task::spawn_blocking(accounts_core::normalize::warm_up_phone_metadata).await
    {
        tracing::warn!(error = %e, "loading the phone-number metadata at start-up failed; the first phone number will load it");
    }
    let bind_addr = settings.bind_addr;
    let worker_enabled = settings.worker_enabled;
    let state = AppState::new(settings, pool).map_err(|e| {
        (
            2,
            format!("error: {e}\nhint: check ACCOUNTS_TOKEN_PEPPER, ACCOUNTS_ENCRYPTION_KEYRING and ACCOUNTS_JWT_PRIVATE_KEY."),
        )
    })?;
    accounts_proofs::migration::migrate_retry_responses(&state)
        .await
        .map_err(|e| {
            (
                2,
                format!("error: verification retry migration failed: {e}"),
            )
        })?;
    // The stored setup of the developer platform's app says this deployment's callback.
    match accounts_server::first_party::sync_developer_app(&state).await {
        Ok(accounts_server::first_party::DeveloperSync::Updated { version }) => tracing::info!(
            redirect_uri = %state.settings.developer_callback_url(),
            version,
            "the developer platform's stored redirect URI now follows ACCOUNTS_DEVELOPER_URL"
        ),
        Ok(accounts_server::first_party::DeveloperSync::Unchanged) => {}
        Ok(accounts_server::first_party::DeveloperSync::Missing) => tracing::warn!(
            "the first-party app 'developer' is missing, so the developer platform can't sign anyone in; run accounts-migrate"
        ),
        Err(e) => tracing::warn!(
            error = %e,
            "could not record ACCOUNTS_DEVELOPER_URL in the developer platform's stored sign-in setup (its sign-ins are unaffected)"
        ),
    }
    let listener = tokio::net::TcpListener::bind(bind_addr).await.map_err(|e| {
        (
            1,
            format!(
                "error: could not listen on {bind_addr}: {e}\nhint: another process may use the port; stop it or change ACCOUNTS_BIND_ADDR."
            ),
        )
    })?;
    let background = if worker_enabled {
        accounts_server::spawn_background(&state)
    } else {
        BackgroundTasks::none()
    };
    let streams = accounts_server::StreamHub::new();
    let app = accounts_server::build_router_with_streams(
        state.clone(),
        accounts_server::Policy::default(),
        streams.clone(),
    );
    tracing::info!(
        bind = %bind_addr,
        public_url = %state.settings.public_url,
        environment = %state.settings.environment,
        delivery = state.settings.delivery.as_str(),
        web_dist = ?state.settings.web_dist,
        background_tasks = background.len(),
        telemetry = state.telemetry.is_enabled(),
        "Silicon Accounts is listening"
    );
    state.telemetry.record_progress(
        "api",
        "startup",
        "api.started",
        Some(1.0),
        serde_json::json!({
            "version": accounts_core::VERSION,
            "worker": worker_enabled,
            "web": state.settings.web_dist.is_some(),
            "delivery": state.settings.delivery.as_str(),
        }),
    );

    let (stop_tx, stop_rx) = watch::channel(false);
    tokio::spawn(async move {
        accounts_server::shutdown_signal().await;
        // Event streams never end on their own: close them now so the drain doesn't wait on
        // them (clients reconnect elsewhere with Last-Event-ID).
        streams.close_all();
        let _ = stop_tx.send(true);
    });
    let mut graceful_rx = stop_rx.clone();
    let server = axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(async move {
        let _ = graceful_rx.wait_for(|stop| *stop).await;
    });
    let mut deadline_rx = stop_rx.clone();
    let deadline = async move {
        let _ = deadline_rx.wait_for(|stop| *stop).await;
        tokio::time::sleep(DRAIN_TIMEOUT).await;
    };
    let http = async move {
        tokio::select! {
            result = server.into_future() => result.map_err(|e| (1, format!("error: the server stopped: {e}"))),
            _ = deadline => {
                tracing::warn!(seconds = DRAIN_TIMEOUT.as_secs(), "requests were still running after the drain timeout; stopping anyway");
                Ok(())
            }
        }
    };
    tokio::pin!(http);
    // The worker is told to stop as soon as shutdown starts, not after requests drained: it
    // stops claiming at once and finishes its sends while requests finish, so the whole stop
    // fits in DRAIN_TIMEOUT.
    let mut worker_rx = stop_rx;
    let served = tokio::select! {
        result = &mut http => {
            // The server ended without a stop signal (it failed): stop the worker too.
            background.shutdown(WORKER_GRACE).await;
            result
        }
        _ = worker_rx.wait_for(|stop| *stop) => {
            let (result, ()) = tokio::join!(&mut http, background.shutdown(WORKER_GRACE));
            result
        }
    };
    state.telemetry.record_progress(
        "api",
        "shutdown",
        "api.stopped",
        Some(1.0),
        serde_json::json!({ "version": accounts_core::VERSION, "clean": served.is_ok() }),
    );
    tracing::info!("Silicon Accounts stopped");
    served
}
