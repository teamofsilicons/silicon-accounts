//! History writers: `audit_log`, `signin_history`, `handle_history`.

use serde_json::Value;
use sqlx::PgConnection;

use crate::error::ApiResult;
use crate::models::ActorKind;

/// One audit record. `action` is dotted (`silicon.stk.rotated`, `app.signin_config.updated`).
#[derive(Debug, Clone)]
pub struct AuditEntry<'a> {
    pub actor_kind: ActorKind,
    /// Account uuid, app_id, or null for system.
    pub actor_id: Option<&'a str>,
    pub action: &'a str,
    pub target_kind: Option<&'a str>,
    pub target_id: Option<&'a str>,
    pub app_id: Option<&'a str>,
    /// The account the action is about (shows in its history).
    pub account_uuid: Option<&'a str>,
    /// Never put secrets here.
    pub details: Value,
    pub ip: Option<&'a str>,
}

impl<'a> AuditEntry<'a> {
    /// A minimal entry: actor + action; fill the rest with struct update syntax.
    pub fn new(actor_kind: ActorKind, actor_id: Option<&'a str>, action: &'a str) -> Self {
        AuditEntry {
            actor_kind,
            actor_id,
            action,
            target_kind: None,
            target_id: None,
            app_id: None,
            account_uuid: None,
            details: Value::Object(Default::default()),
            ip: None,
        }
    }
}

/// Writes an audit record.
pub async fn record(conn: &mut PgConnection, e: &AuditEntry<'_>) -> ApiResult<()> {
    sqlx::query(
        "insert into audit_log (actor_kind, actor_id, action, target_kind, target_id, app_id, account_uuid, details, ip) \
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
    )
    .bind(e.actor_kind)
    .bind(e.actor_id)
    .bind(e.action)
    .bind(e.target_kind)
    .bind(e.target_id)
    .bind(e.app_id)
    .bind(e.account_uuid)
    .bind(&e.details)
    .bind(e.ip)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Sign-in methods recorded in `signin_history.method`.
pub mod method {
    pub const EMAIL: &str = "email";
    pub const PHONE: &str = "phone";
    pub const GOOGLE: &str = "google";
    pub const APPLE: &str = "apple";
    pub const SILICON_STK: &str = "silicon_stk";
    pub const SLT: &str = "slt";
    pub const DEVICE: &str = "device";
    pub const SESSION: &str = "session";
    /// A Silicon's key-signed assertion.
    pub const SILICON_KEY: &str = "silicon_key";
    /// An outside OIDC token the Silicon is trusted for (workload identity federation).
    pub const FEDERATED: &str = "federated";
}

/// Sign-in outcomes recorded in `signin_history.outcome`.
pub mod outcome {
    pub const SUCCESS: &str = "success";
    pub const FAILED: &str = "failed";
    pub const NEW_ACCOUNT: &str = "new_account";
}

/// One sign-in attempt.
#[derive(Debug, Clone)]
pub struct SigninRecord<'a> {
    pub account_uuid: Option<&'a str>,
    pub app_id: Option<&'a str>,
    /// See [`method`].
    pub method: &'a str,
    /// See [`outcome`].
    pub outcome: &'a str,
    pub ip: Option<&'a str>,
    pub user_agent: Option<&'a str>,
}

/// Writes a sign-in history row.
pub async fn signin(conn: &mut PgConnection, r: &SigninRecord<'_>) -> ApiResult<()> {
    sqlx::query(
        "insert into signin_history (account_uuid, app_id, method, outcome, ip, user_agent) values ($1, $2, $3, $4, $5, $6)",
    )
    .bind(r.account_uuid)
    .bind(r.app_id)
    .bind(r.method)
    .bind(r.outcome)
    .bind(r.ip)
    .bind(r.user_agent.map(|u| u.chars().take(400).collect::<String>()))
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Writes a `handle_history` row (`old` null at creation, `new` null at deletion).
/// `changed_by` is an account uuid, `import` or `system`.
pub async fn handle_history(
    conn: &mut PgConnection,
    account_uuid: &str,
    old: Option<&str>,
    new: Option<&str>,
    changed_by: &str,
) -> ApiResult<()> {
    sqlx::query("insert into handle_history (account_uuid, old_handle, new_handle, changed_by) values ($1, $2, $3, $4)")
        .bind(account_uuid)
        .bind(old)
        .bind(new)
        .bind(changed_by)
        .execute(&mut *conn)
        .await?;
    Ok(())
}
