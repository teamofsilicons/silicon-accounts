//! `accounts-migrate`: applies the embedded database migrations and reports every version.
//!
//! Usage: `accounts-migrate [--database-url <url>] [--check]`. The URL comes from the flag, else
//! ACCOUNTS_DATABASE_URL (environment, or `.env` outside production), else the local dev
//! database. Only the database URL is read, so it works before the rest of the configuration
//! exists. `--check` lists pending migrations without applying them (for deploy gates).
//!
//! Exit codes: 0 migrated (or nothing to do), 1 database or migration failure, 2 bad arguments,
//! 3 `--check` found pending migrations.

use std::process::ExitCode;

const DEFAULT_URL: &str = "postgres://postgres@127.0.0.1:5444/silicon_accounts";

const USAGE: &str = concat!(
    "accounts-migrate: apply Silicon Accounts database migrations\n\n",
    "Usage: accounts-migrate [--database-url <url>] [--check]\n\n",
    "  --database-url <url>  the database to migrate (default: ACCOUNTS_DATABASE_URL from the\n",
    "                        environment or .env, else postgres://postgres@127.0.0.1:5444/silicon_accounts)\n",
    "  --check               list pending migrations without applying them\n\n",
    "Exit codes: 0 migrated or up to date, 1 database or migration failure, 2 bad arguments,\n",
    "3 --check found pending migrations."
);

struct Args {
    url: Option<String>,
    check: bool,
}

fn parse_args() -> Result<Option<Args>, String> {
    let mut args = std::env::args().skip(1);
    let mut parsed = Args {
        url: None,
        check: false,
    };
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "-h" | "--help" => return Ok(None),
            "--check" => parsed.check = true,
            "--database-url" => match args.next() {
                Some(v) => parsed.url = Some(v),
                None => return Err("--database-url needs a value".into()),
            },
            other => match other.strip_prefix("--database-url=") {
                Some(v) => parsed.url = Some(v.to_string()),
                None => return Err(format!("unknown argument '{other}'")),
            },
        }
    }
    Ok(Some(parsed))
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
    let production = std::env::var("ACCOUNTS_ENVIRONMENT")
        .is_ok_and(|v| v.trim().eq_ignore_ascii_case("production"));
    if !production {
        let _ = dotenvy::dotenv();
    }
    let url = args
        .url
        .or_else(|| {
            std::env::var("ACCOUNTS_DATABASE_URL")
                .ok()
                .filter(|v| !v.trim().is_empty())
        })
        .unwrap_or_else(|| DEFAULT_URL.to_string());
    let shown = accounts_server::redact_database_url(&url);
    println!("accounts-migrate: database {shown}");

    let pool = match accounts_core::db::connect_url(&url, 2).await {
        Ok(p) => p,
        Err(e) => {
            eprintln!(
                "error: could not connect to {shown}: {e}\nhint: start Postgres (scripts/dev-db.sh) or pass the right --database-url."
            );
            return ExitCode::from(1);
        }
    };
    let pending = match accounts_core::db::pending_migrations(&pool).await {
        Ok(p) => p,
        Err(e) => {
            eprintln!("error: could not read the migration state of {shown}: {e}");
            pool.close().await;
            return ExitCode::from(1);
        }
    };
    if pending.is_empty() {
        println!("  pending: none");
    } else {
        for m in &pending {
            println!("  pending {:04} {}", m.version, m.description);
        }
    }
    if args.check {
        pool.close().await;
        return if pending.is_empty() {
            println!("accounts-migrate: up to date");
            ExitCode::SUCCESS
        } else {
            println!(
                "accounts-migrate: {} migration(s) pending; run accounts-migrate without --check to apply them",
                pending.len()
            );
            ExitCode::from(3)
        };
    }
    let code = match accounts_core::db::migrate(&pool).await {
        Ok(report) => {
            for m in &report.applied_now {
                println!("  applied {:04} {}", m.version, m.description);
            }
            if report.applied_now.is_empty() {
                println!("  nothing to apply: the database is up to date");
            }
            match report.applied_now.last().or(report.already_applied.last()) {
                Some(l) => println!(
                    "accounts-migrate: done; {} applied now, {} already applied, latest is {:04} {}",
                    report.applied_now.len(),
                    report.already_applied.len(),
                    l.version,
                    l.description
                ),
                None => println!("accounts-migrate: done; no migrations exist"),
            }
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!(
                "error: migrating {shown} failed: {e}\nhint: if a migration was edited after it was applied, restore it and add a new numbered migration instead."
            );
            ExitCode::from(1)
        }
    };
    pool.close().await;
    code
}
