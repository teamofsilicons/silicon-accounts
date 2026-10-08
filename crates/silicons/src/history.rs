//! History writers for this crate: `audit_log` entries (who did what to which Silicon, shown in
//! the account's history) and `custodian_history` (every custodian change of a Silicon).
//!
//! Action names follow the account history's rules: anything with `custodian` or `transfer` is
//! listed under custodian events, except `….accepted` ones (`custodian_history` already shows
//! those); everything else is listed as a security event.

use accounts_core::error::ApiResult;
use accounts_core::models::ActorKind;
use accounts_core::repo::audit::{self, AuditEntry};
use serde_json::Value;
use sqlx::PgConnection;
use uuid::Uuid;

/// `custodian_history.kind` values.
pub mod custody {
    pub const CREATED_BY_CUSTODIAN: &str = "created_by_custodian";
    pub const INITIAL_ACCEPTED: &str = "initial_accepted";
    pub const TRANSFER: &str = "transfer";
}

/// Who performs the audited actions of one request.
#[derive(Debug, Clone, Copy)]
pub struct Actor<'a> {
    pub kind: ActorKind,
    /// Account uuid (or `None` for the system).
    pub id: Option<&'a str>,
    pub ip: Option<&'a str>,
}

impl<'a> Actor<'a> {
    /// A signed-in account (or a Silicon creating itself).
    pub fn account(uuid: &'a str, ip: Option<&'a str>) -> Actor<'a> {
        Actor {
            kind: ActorKind::Account,
            id: Some(uuid),
            ip,
        }
    }

    /// The service itself (the expiry sweep).
    pub fn system() -> Actor<'static> {
        Actor {
            kind: ActorKind::System,
            id: None,
            ip: None,
        }
    }

    /// Writes one audit entry about the Silicon `silicon_uuid`, shown in `account_uuid`'s history.
    /// Never put secrets in `details`.
    pub async fn record(
        &self,
        conn: &mut PgConnection,
        action: &str,
        account_uuid: &str,
        silicon_uuid: &str,
        details: Value,
    ) -> ApiResult<()> {
        audit::record(
            conn,
            &AuditEntry {
                target_kind: Some("silicon"),
                target_id: Some(silicon_uuid),
                account_uuid: Some(account_uuid),
                details,
                ip: self.ip,
                ..AuditEntry::new(self.kind, self.id, action)
            },
        )
        .await
    }

    /// Writes an audit entry that is kept in the store but listed in nobody's history (the
    /// account history already shows the same event from `custodian_history` or
    /// `signin_history`).
    pub async fn record_unlisted(
        &self,
        conn: &mut PgConnection,
        action: &str,
        target: (&str, &str),
        app_id: Option<&str>,
        details: Value,
    ) -> ApiResult<()> {
        audit::record(
            conn,
            &AuditEntry {
                target_kind: Some(target.0),
                target_id: Some(target.1),
                app_id,
                details,
                ip: self.ip,
                ..AuditEntry::new(self.kind, self.id, action)
            },
        )
        .await
    }

    /// Writes the same audit entry into the history of every account in `silicon-accounts` (deduplicated,
    /// `None`s skipped).
    pub async fn record_for(
        &self,
        conn: &mut PgConnection,
        action: &str,
        accounts: &[Option<&str>],
        silicon_uuid: &str,
        details: Value,
    ) -> ApiResult<()> {
        let mut seen: Vec<&str> = Vec::new();
        for uuid in accounts.iter().flatten() {
            if seen.contains(uuid) {
                continue;
            }
            seen.push(uuid);
            self.record(conn, action, uuid, silicon_uuid, details.clone())
                .await?;
        }
        Ok(())
    }
}

/// `https://hooks.example.com:8443` from a webhook URL. Audit entries keep only this: a path or
/// query string may carry a token.
pub fn url_origin(url: &str) -> String {
    match url.split_once("://") {
        Some((scheme, rest)) => {
            let host = rest.split(['/', '?', '#']).next().unwrap_or("");
            format!("{scheme}://{host}")
        }
        None => String::new(),
    }
}

/// Appends a custodian change (`from` is null for a Silicon's first custodian).
pub async fn custodian_change(
    conn: &mut PgConnection,
    silicon_uuid: &str,
    from_uuid: Option<&str>,
    to_uuid: &str,
    kind: &str,
    request_id: Option<Uuid>,
) -> ApiResult<()> {
    sqlx::query(
        "insert into custodian_history (silicon_uuid, from_uuid, to_uuid, kind, request_id) values ($1, $2, $3, $4, $5)",
    )
    .bind(silicon_uuid)
    .bind(from_uuid)
    .bind(to_uuid)
    .bind(kind)
    .bind(request_id)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::url_origin;

    #[test]
    fn origins_drop_paths_and_queries() {
        assert_eq!(
            url_origin("https://hooks.example.com:8443/in/abc?token=secret#x"),
            "https://hooks.example.com:8443"
        );
        assert_eq!(url_origin("http://127.0.0.1:8593"), "http://127.0.0.1:8593");
        assert_eq!(url_origin("nonsense"), "");
    }
}
