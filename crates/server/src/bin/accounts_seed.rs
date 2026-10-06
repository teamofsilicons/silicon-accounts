//! `accounts-seed`: loads the fake apps (the stand-in for Silicon Apps) into the database.
//!
//! Usage: `accounts-seed --fake-apps testkit/fake-apps.json [--force]`. The file is the
//! `POST /v1/internal/apps/sync` body (`{"apps":[…]}` or a bare array). Apps are upserted through
//! the same code as that endpoint: missing owners are created, existing apps keep their app id,
//! their user base and their sign-in setup, and each app's `signin_defaults` and webhook are
//! applied only when the app is first created — unless `--force`, which re-applies them.
//!
//! Reads the full ACCOUNTS_* configuration (the token pepper hashes app secrets, the keyring
//! encrypts webhook and provider secrets), so run it with the same environment as accounts-api.
//!
//! Exit codes: 0 seeded, 1 database or seeding failure, 2 bad arguments or configuration.

use std::path::PathBuf;
use std::process::ExitCode;

use accounts_core::secrecy::ExposeSecret;
use accounts_core::{AppState, Settings};

const USAGE: &str = concat!(
    "accounts-seed: load the fake apps into Silicon Accounts\n\n",
    "Usage: accounts-seed --fake-apps <path> [--force]\n\n",
    "  --fake-apps <path>  the apps file, e.g. testkit/fake-apps.json ({\"apps\":[…]} or a bare array)\n",
    "  --force             re-apply every app's signin_defaults and webhook, also for apps that exist\n\n",
    "Configuration comes from the ACCOUNTS_* environment (and .env outside production), like accounts-api.\n",
    "Run accounts-migrate first.\n\n",
    "Exit codes: 0 seeded, 1 database or seeding failure, 2 bad arguments or configuration."
);

struct Args {
    fake_apps: PathBuf,
    force: bool,
}

fn parse_args() -> Result<Option<Args>, String> {
    let mut args = std::env::args().skip(1);
    let mut fake_apps: Option<PathBuf> = None;
    let mut force = false;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "-h" | "--help" => return Ok(None),
            "--force" => force = true,
            "--fake-apps" => match args.next() {
                Some(v) => fake_apps = Some(PathBuf::from(v)),
                None => return Err("--fake-apps needs a path".into()),
            },
            other => match other.strip_prefix("--fake-apps=") {
                Some(v) => fake_apps = Some(PathBuf::from(v)),
                None => return Err(format!("unknown argument '{other}'")),
            },
        }
    }
    match fake_apps {
        Some(fake_apps) => Ok(Some(Args { fake_apps, force })),
        None => {
            Err("nothing to seed: pass --fake-apps <path> (e.g. testkit/fake-apps.json)".into())
        }
    }
}

#[tokio::main]
async fn main() -> ExitCode {
    let args = match parse_args() {
        Ok(Some(a)) => a,
        Ok(None) => {
            println!("{USAGE}");
            return ExitCode::SUCCESS;
        }
        Err(e) => {
            eprintln!("error: {e}\n\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    match run(args).await {
        Ok(()) => ExitCode::SUCCESS,
        Err((code, message)) => {
            eprintln!("{message}");
            ExitCode::from(code)
        }
    }
}

async fn run(args: Args) -> Result<(), (u8, String)> {
    let settings = Settings::from_env().map_err(|e| {
        (
            2,
            format!("{e}hint: accounts-seed needs the same ACCOUNTS_* configuration as accounts-api (see .env.example)."),
        )
    })?;
    accounts_core::telemetry::init_logging(&settings);
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
        return Err((
            1,
            format!(
                "error: the database at {db_url} is missing {} migration(s).\nhint: run `accounts-migrate` first.",
                pending.len()
            ),
        ));
    }
    let state = AppState::new(settings, pool).map_err(|e| (2, format!("error: {e}")))?;
    println!(
        "accounts-seed: seeding {} into {db_url}{}",
        args.fake_apps.display(),
        if args.force {
            " (--force: re-applying sign-in defaults and webhooks)"
        } else {
            ""
        }
    );
    let report = accounts_apps::seed_fake_apps(&state, &args.fake_apps, args.force)
        .await
        .map_err(|e| (1, format!("error: seeding failed: {e}")))?;
    print!("{report}");
    println!("accounts-seed: done; {} app(s) synced", report.apps.len());
    state.db.close().await;
    Ok(())
}
