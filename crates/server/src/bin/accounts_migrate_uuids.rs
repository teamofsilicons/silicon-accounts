//! Offline standard UUID cutover. Requires an explicit database environment variable.
use accounts_core::uuid_migration;
use clap::{Parser, Subcommand};
use std::{fs::OpenOptions, io::Write, path::PathBuf, process::ExitCode};

#[derive(Parser)]
#[command(
    about = "Prepare or apply the immutable Accounts UUIDv4 mapping. Stop all writers before apply."
)]
struct Args {
    #[arg(long, default_value = "ACCOUNTS_DATABASE_URL")]
    database_env: String,
    #[command(subcommand)]
    command: Command,
}
#[derive(Subcommand)]
enum Command {
    /// Persist the plan and write a CSV for every dependent service (will not overwrite a file).
    Prepare {
        #[arg(long)]
        output: PathBuf,
    },
    /// Verify the complete persisted plan and simulate the transaction unless --apply is given.
    Migrate {
        #[arg(long)]
        file: PathBuf,
        #[arg(long, requires = "writers_stopped")]
        apply: bool,
        #[arg(long)]
        writers_stopped: bool,
    },
}
async fn run(args: Args) -> anyhow::Result<()> {
    let url = std::env::var(&args.database_env)?;
    let pool = accounts_core::db::connect_url(&url, 2).await?;
    anyhow::ensure!(
        accounts_core::db::pending_migrations(&pool)
            .await?
            .is_empty(),
        "run accounts-migrate before preparing UUID migration"
    );
    match args.command {
        Command::Prepare { output } => {
            // Reserve the export before modifying the plan. A failed write can be
            // recovered by exporting again; generated mappings remain persisted.
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(output)?;
            let rows = uuid_migration::prepare(&pool).await?;
            file.write_all(&uuid_migration::to_csv(&rows)?)?;
            file.sync_all()?;
            println!("Exported {} immutable account mappings.", rows.len());
        }
        Command::Migrate { file, apply, .. } => {
            let rows = uuid_migration::from_csv(&std::fs::read(file)?)?;
            let report = uuid_migration::apply(&pool, &rows, apply).await?;
            println!("{}", serde_json::to_string_pretty(&report)?);
        }
    }
    pool.close().await;
    Ok(())
}
#[tokio::main]
async fn main() -> ExitCode {
    match run(Args::parse()).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            // SQL errors can include complete account/token rows. Never emit those.
            if error.downcast_ref::<sqlx::Error>().is_some() {
                eprintln!(
                    "UUID migration failed and rolled back; inspect database constraints and writer state locally."
                );
            } else {
                eprintln!("UUID migration failed: {error}");
            }
            ExitCode::FAILURE
        }
    }
}
