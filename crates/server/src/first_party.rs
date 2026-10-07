//! Start-up upkeep of Silicon Accounts' own apps.
//!
//! The first-party app `developer` (the developer platform, migration 0005) may only send its
//! sign-ins back to `{ACCOUNTS_DEVELOPER_URL}/auth/callback`. The rule itself is applied in code
//! from the settings (`SigninConfig::effective` / `redirect_allowed`); this keeps the stored
//! sign-in setup saying the same thing, so whatever reads the stored document (the config
//! history, an operator in psql) sees this deployment's URL rather than migration 0005's
//! production default. When the URL differs, `accounts-api` writes it at start-up as a new
//! config version with a history entry by `system`. Nobody else can change that setup: the app
//! has no owner and no secret.

use accounts_core::{AppState, DEVELOPER_APP_ID};
use serde_json::{Value, json};

/// What [`sync_developer_app`] did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeveloperSync {
    /// The stored redirect URI already was the configured callback.
    Unchanged,
    /// The redirect URI was rewritten; the new config version.
    Updated { version: i64 },
    /// The app doesn't exist (migration 0005 not applied).
    Missing,
}

/// Points the stored redirect URIs of the first-party app `developer` at this deployment's
/// developer platform: exactly `[settings.developer_callback_url()]`. Idempotent; concurrent
/// starts of several nodes with the same settings write it once.
pub async fn sync_developer_app(state: &AppState) -> Result<DeveloperSync, sqlx::Error> {
    let wanted: Value = json!([state.settings.developer_callback_url()]);
    let mut tx = state.db.begin().await?;
    let before: Option<Value> = sqlx::query_scalar(
        "select coalesce(config->'redirect_uris', 'null'::jsonb) \
           from app_signin_configs where app_id = $1 for update",
    )
    .bind(DEVELOPER_APP_ID)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(before) = before else {
        return Ok(DeveloperSync::Missing);
    };
    if before == wanted {
        return Ok(DeveloperSync::Unchanged);
    }
    let version: i64 = sqlx::query_scalar(
        "update app_signin_configs \
            set config = jsonb_set(config, '{redirect_uris}', $2::jsonb, true), \
                version = version + 1, updated_at = now(), updated_by = 'system' \
          where app_id = $1 returning version",
    )
    .bind(DEVELOPER_APP_ID)
    .bind(&wanted)
    .fetch_one(&mut *tx)
    .await?;
    sqlx::query(
        "insert into app_config_history (app_id, version, actor, changes) values ($1, $2, 'system', $3)",
    )
    .bind(DEVELOPER_APP_ID)
    .bind(version)
    .bind(json!([{
        "path": "redirect_uris",
        "before": before,
        "after": wanted,
        "reason": "ACCOUNTS_DEVELOPER_URL of this deployment (written at start-up by accounts-api)",
    }]))
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(DeveloperSync::Updated { version })
}
