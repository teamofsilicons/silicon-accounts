//! Database pool and migrations.
//!
//! Migrations live in `/migrations` and are embedded at compile time ([`MIGRATOR`]).
//! [`migrate`] runs them and reports what it applied (never silent).

use std::str::FromStr;
use std::time::Duration;

use secrecy::ExposeSecret;
use sqlx::migrate::Migrator;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use sqlx::{Connection, PgConnection, PgPool};

use crate::config::Settings;

/// The embedded migrations.
pub static MIGRATOR: Migrator = sqlx::migrate!("../../migrations");

/// Connects a pool for the settings' database URL.
pub async fn connect(settings: &Settings) -> Result<PgPool, sqlx::Error> {
    connect_url(
        settings.database_url.expose_secret(),
        settings.database_max_connections,
    )
    .await
}

/// Connects a pool to `url` with `max_connections`.
pub async fn connect_url(url: &str, max_connections: u32) -> Result<PgPool, sqlx::Error> {
    let options = PgConnectOptions::from_str(url)?.application_name("silicon-accounts");
    // Fail fast with the real reason (refused, bad password, unknown database) instead of the
    // pool's generic "timed out" after its retries.
    let probe = PgConnection::connect_with(&options).await?;
    let _ = probe.close().await;
    PgPoolOptions::new()
        .max_connections(max_connections)
        .min_connections(0)
        .acquire_timeout(Duration::from_secs(10))
        .idle_timeout(Some(Duration::from_secs(300)))
        .connect_with(options)
        .await
}

/// One migration version and description.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MigrationInfo {
    pub version: i64,
    pub description: String,
}

/// What [`migrate`] did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MigrationReport {
    /// Applied by this run.
    pub applied_now: Vec<MigrationInfo>,
    /// Already applied before this run.
    pub already_applied: Vec<MigrationInfo>,
}

async fn applied(pool: &PgPool) -> Result<Vec<MigrationInfo>, sqlx::Error> {
    let exists: bool = sqlx::query_scalar("select to_regclass('_sqlx_migrations') is not null")
        .fetch_one(pool)
        .await?;
    if !exists {
        return Ok(Vec::new());
    }
    let rows: Vec<(i64, String)> = sqlx::query_as(
        "select version, description from _sqlx_migrations where success order by version",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(version, description)| MigrationInfo {
            version,
            description,
        })
        .collect())
}

/// Runs pending migrations and reports which ran now and which were already applied.
pub async fn migrate(pool: &PgPool) -> Result<MigrationReport, sqlx::migrate::MigrateError> {
    let before = applied(pool).await?;
    MIGRATOR.run(pool).await?;
    let after = applied(pool).await?;
    let applied_now = after
        .iter()
        .filter(|m| !before.contains(m))
        .cloned()
        .collect();
    Ok(MigrationReport {
        applied_now,
        already_applied: before,
    })
}

/// Embedded migrations not yet applied to the database (empty = up to date).
pub async fn pending_migrations(pool: &PgPool) -> Result<Vec<MigrationInfo>, sqlx::Error> {
    let applied = applied(pool).await?;
    Ok(MIGRATOR
        .iter()
        .filter(|m| m.migration_type.is_up_migration())
        .filter(|m| !applied.iter().any(|a| a.version == m.version))
        .map(|m| MigrationInfo {
            version: m.version,
            description: m.description.to_string(),
        })
        .collect())
}

/// Health check: `select 1`.
pub async fn ping(pool: &PgPool) -> Result<(), sqlx::Error> {
    sqlx::query_scalar::<_, i32>("select 1")
        .fetch_one(pool)
        .await
        .map(|_| ())
}
