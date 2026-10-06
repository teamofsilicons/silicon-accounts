//! The app's sign-in setup:
//!
//! - `PATCH /v1/apps/{app_id}/signin-config` (app or owner, Idempotency-Key): deep-merges a
//!   partial SigninConfig (objects merge, arrays and scalars replace, `null` resets a field),
//!   validates the whole result with field paths (`details.fields`), stores Bring-your-own
//!   provider secrets encrypted outside the document, bumps the version and records a history
//!   entry whose diff never contains a secret. `expected_version` guards against lost updates
//!   (409 `config_version_conflict`). Returns the `GET /v1/apps/{app_id}` body.
//! - `GET /v1/apps/{app_id}/signin-config/history` (app or owner): the changes, newest first.

use accounts_core::error::FieldErrors;
use accounts_core::http::pagination::paginate;
use accounts_core::http::{AppOrOwner, ClientMeta, IdempotencyKey, Json, Query};
use accounts_core::models::{ConfigSecretsPresent, SigninConfig};
use accounts_core::repo::{apps as apps_repo, audit, idempotency};
use accounts_core::views::AccountSummary;
use accounts_core::{ApiError, ApiResult, AppState};
use axum::Router;
use axum::extract::{DefaultBodyLimit, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use time::OffsetDateTime;

use crate::util::caller_scope;

/// Largest PATCH body.
pub const SIGNIN_CONFIG_BODY_LIMIT: usize = 512 * 1024;

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/v1/apps/{app_id}/signin-config",
            // Branding may carry two inline data:image logos of up to 128 KB each.
            patch(patch_signin_config).layer(DefaultBodyLimit::max(SIGNIN_CONFIG_BODY_LIMIT)),
        )
        .route("/v1/apps/{app_id}/signin-config/history", get(history))
}

/// What a PATCH does to one Bring-your-own secret.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum SecretChange {
    /// Not mentioned: keep what is stored.
    Keep,
    /// A new value (already validated and normalized).
    Set(String),
    /// `null`: remove the stored secret.
    Remove,
}

/// A PATCH body split into the document patch, the version guard and the secrets.
#[derive(Debug, Clone)]
pub(crate) struct PatchParts {
    pub patch: Value,
    pub expected_version: Option<i64>,
    pub google_client_secret: SecretChange,
    pub apple_private_key: SecretChange,
}

/// Placeholder written into history diffs instead of secret values.
pub(crate) const REDACTED: &str = "[redacted]";

/// Splits a PATCH body (or a `signin_defaults` document): removes `expected_version`, the
/// secrets (`google.client_secret`, `apple.private_key`) and the read-only masks
/// (`google.client_secret_set`, `apple.private_key_set`, echoed back by clients that PATCH what
/// they GET), validating what it removes. Errors are keyed by field path.
pub(crate) fn split_patch(
    body: &Value,
    allow_expected_version: bool,
) -> Result<PatchParts, FieldErrors> {
    let mut errors = FieldErrors::new();
    let Value::Object(map) = body else {
        errors.add("", "the sign-in config patch must be a JSON object");
        return Err(errors);
    };
    let mut map: Map<String, Value> = map.clone();

    let expected_version = if allow_expected_version {
        match map.remove("expected_version") {
            None | Some(Value::Null) => None,
            Some(Value::Number(n)) if n.as_i64().is_some_and(|v| v >= 0) => n.as_i64(),
            Some(_) => {
                errors.add(
                    "expected_version",
                    "must be a non-negative integer: the config_version from GET /v1/apps/{app_id}",
                );
                None
            }
        }
    } else {
        None
    };

    let google_client_secret = take_secret(
        &mut map,
        "google",
        "client_secret",
        "client_secret_set",
        &mut errors,
    )
    .map(|c| match c {
        SecretChange::Set(s) => match validate_google_secret(&s) {
            Ok(v) => SecretChange::Set(v),
            Err(m) => {
                errors.add("google.client_secret", m);
                SecretChange::Keep
            }
        },
        other => other,
    })
    .unwrap_or(SecretChange::Keep);
    let apple_private_key = take_secret(
        &mut map,
        "apple",
        "private_key",
        "private_key_set",
        &mut errors,
    )
    .map(|c| match c {
        SecretChange::Set(s) => match validate_apple_key(&s) {
            Ok(v) => SecretChange::Set(v),
            Err(m) => {
                errors.add("apple.private_key", m);
                SecretChange::Keep
            }
        },
        other => other,
    })
    .unwrap_or(SecretChange::Keep);

    if !errors.is_empty() {
        return Err(errors);
    }
    Ok(PatchParts {
        patch: Value::Object(map),
        expected_version,
        google_client_secret,
        apple_private_key,
    })
}

fn take_secret(
    map: &mut Map<String, Value>,
    section: &str,
    key: &str,
    mask_key: &str,
    errors: &mut FieldErrors,
) -> Option<SecretChange> {
    let Some(Value::Object(sec)) = map.get_mut(section) else {
        return None;
    };
    sec.remove(mask_key);
    match sec.remove(key) {
        None => None,
        Some(Value::Null) => Some(SecretChange::Remove),
        Some(Value::String(s)) => Some(SecretChange::Set(s)),
        Some(_) => {
            errors.add(
                format!("{section}.{key}"),
                "must be a string (or null to remove the stored value)",
            );
            None
        }
    }
}

/// A Google OAuth client secret: 1..=512 visible ASCII characters, no spaces.
pub(crate) fn validate_google_secret(s: &str) -> Result<String, String> {
    let t = s.trim();
    if t.is_empty() {
        return Err("is empty; paste the client secret of your Google OAuth client (or send null to remove it)".into());
    }
    if t.len() > 512 {
        return Err("is longer than 512 characters, which no Google client secret is".into());
    }
    if !t.bytes().all(|b| (0x21..=0x7e).contains(&b)) {
        return Err(
            "must be visible ASCII characters without spaces, exactly as Google shows it".into(),
        );
    }
    Ok(t.to_string())
}

/// An Apple Sign in key: the `.p8` file, a PKCS#8 PEM EC P-256 private key. Literal `\n`
/// escapes (from copying out of an env file) are turned into newlines first.
pub(crate) fn validate_apple_key(s: &str) -> Result<String, String> {
    use p256::pkcs8::DecodePrivateKey as _;
    let mut pem = s.trim().to_string();
    if !pem.contains('\n') && pem.contains("\\n") {
        pem = pem.replace("\\n", "\n");
    }
    if !pem.starts_with("-----BEGIN PRIVATE KEY-----") {
        return Err(
            "must be the .p8 key from Apple in PEM form, starting with -----BEGIN PRIVATE KEY-----"
                .into(),
        );
    }
    if pem.len() > 4096 {
        return Err("is longer than 4096 characters, which no Apple .p8 key is".into());
    }
    match p256::SecretKey::from_pkcs8_pem(&pem) {
        Ok(_) => {
            if !pem.ends_with('\n') {
                pem.push('\n');
            }
            Ok(pem)
        }
        Err(_) => Err("is not a valid PKCS#8 EC P-256 private key; use the unmodified .p8 file Apple gave you for Sign in with Apple".into()),
    }
}

/// One entry of a history diff.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub(crate) struct Change {
    pub path: String,
    pub before: Value,
    pub after: Value,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub secret: bool,
}

/// Leaf-level differences between two config documents: objects recurse, arrays and scalars are
/// compared whole (arrays replace on PATCH, so a changed list is one change).
pub(crate) fn diff(before: &Value, after: &Value, path: &str, out: &mut Vec<Change>) {
    match (before, after) {
        (Value::Object(b), Value::Object(a)) => {
            let mut keys: Vec<&String> = b.keys().chain(a.keys()).collect();
            keys.sort();
            keys.dedup();
            for k in keys {
                let child = if path.is_empty() {
                    k.clone()
                } else {
                    format!("{path}.{k}")
                };
                diff(
                    b.get(k).unwrap_or(&Value::Null),
                    a.get(k).unwrap_or(&Value::Null),
                    &child,
                    out,
                );
            }
        }
        (b, a) if b != a => out.push(Change {
            path: path.to_string(),
            before: b.clone(),
            after: a.clone(),
            secret: false,
        }),
        _ => {}
    }
}

/// The redacted history entry for a secret change (`None` when nothing changes).
pub(crate) fn secret_change_entry(
    path: &str,
    stored: Option<&str>,
    change: &SecretChange,
) -> Option<Change> {
    let redacted = |present: bool| {
        if present {
            Value::String(REDACTED.into())
        } else {
            Value::Null
        }
    };
    match change {
        SecretChange::Keep => None,
        SecretChange::Remove if stored.is_none() => None,
        SecretChange::Remove => Some(Change {
            path: path.into(),
            before: redacted(true),
            after: Value::Null,
            secret: true,
        }),
        SecretChange::Set(new) if stored == Some(new.as_str()) => None,
        SecretChange::Set(_) => Some(Change {
            path: path.into(),
            before: redacted(stored.is_some()),
            after: redacted(true),
            secret: true,
        }),
    }
}

async fn patch_signin_config(
    State(state): State<AppState>,
    auth: AppOrOwner,
    meta: ClientMeta,
    key: Option<IdempotencyKey>,
    Json(body): Json<Value>,
) -> ApiResult<Response> {
    let app_id = auth.app.app_id.clone();
    let scope = idempotency::scope(
        &caller_scope(&auth),
        "PATCH",
        &format!("/v1/apps/{app_id}/signin-config"),
    );
    idempotency::run(&state, key.as_deref(), &scope, &body, false, || async {
        let parts = split_patch(&body, true).map_err(ApiError::validation)?;
        apply(&state, &auth, parts, meta.ip.as_deref()).await?;
        let mut conn = state.db.acquire().await?;
        let details = crate::apps::details_body(&mut conn, &state, &auth.app).await?;
        Ok((StatusCode::OK, details))
    })
    .await
}

/// Applies a split PATCH inside one transaction (row locked), recording history and audit.
async fn apply(
    state: &AppState,
    auth: &AppOrOwner,
    parts: PatchParts,
    ip: Option<&str>,
) -> ApiResult<()> {
    let app_id = auth.app.app_id.as_str();
    let mut tx = state.db.begin().await?;
    ensure_config_row(&mut tx, app_id).await?;
    let row = lock_config_row(&mut tx, app_id).await?;
    if let Some(expected) = parts.expected_version
        && expected != row.version
    {
        return Err(ApiError::conflict(
            "config_version_conflict",
            format!(
                "The sign-in config of '{app_id}' is at version {}, but this change was made against version {expected}; someone else changed it in between.",
                row.version
            ),
        )
        .hint("GET /v1/apps/{app_id} for the current config and config_version, re-apply your change, and send it again.")
        .detail("expected_version", expected)
        .detail("current_version", row.version));
    }
    let stored_google = decrypt_opt(state, row.google_client_secret_enc.as_deref())?;
    let stored_apple = decrypt_opt(state, row.apple_private_key_enc.as_deref())?;
    let present = ConfigSecretsPresent {
        google_client_secret: present_after(&parts.google_client_secret, stored_google.is_some()),
        apple_private_key: present_after(&parts.apple_private_key, stored_apple.is_some()),
    };
    let current = SigninConfig::from_stored(&row.config);
    let updated = current
        .apply_patch(&parts.patch, present)
        .map_err(ApiError::validation)?;

    let before = serde_json::to_value(&current)?;
    let after = serde_json::to_value(&updated)?;
    let mut changes = Vec::new();
    diff(&before, &after, "", &mut changes);
    changes.extend(secret_change_entry(
        "google.client_secret",
        stored_google.as_deref(),
        &parts.google_client_secret,
    ));
    changes.extend(secret_change_entry(
        "apple.private_key",
        stored_apple.as_deref(),
        &parts.apple_private_key,
    ));
    if changes.is_empty() {
        // Nothing differs: no new version, no history entry.
        tx.commit().await?;
        return Ok(());
    }

    let google_enc = new_secret_column(
        state,
        &parts.google_client_secret,
        row.google_client_secret_enc,
    )?;
    let apple_enc = new_secret_column(state, &parts.apple_private_key, row.apple_private_key_enc)?;
    let actor = auth.history_actor();
    let version: i64 = sqlx::query_scalar(
        "update app_signin_configs set config = $2, version = version + 1, google_client_secret_enc = $3, \
         apple_private_key_enc = $4, updated_at = now(), updated_by = $5 where app_id = $1 returning version",
    )
    .bind(app_id)
    .bind(&after)
    .bind(google_enc)
    .bind(apple_enc)
    .bind(&actor)
    .fetch_one(&mut *tx)
    .await?;
    sqlx::query(
        "insert into app_config_history (app_id, version, actor, changes) values ($1, $2, $3, $4)",
    )
    .bind(app_id)
    .bind(version)
    .bind(&actor)
    .bind(serde_json::to_value(&changes)?)
    .execute(&mut *tx)
    .await?;
    let (actor_kind, actor_id) = auth.audit_actor();
    let paths: Vec<&str> = changes.iter().map(|c| c.path.as_str()).collect();
    audit::record(
        &mut tx,
        &audit::AuditEntry {
            target_kind: Some("app"),
            target_id: Some(app_id),
            app_id: Some(app_id),
            details: json!({"version": version, "changed": paths}),
            ip,
            ..audit::AuditEntry::new(actor_kind, Some(&actor_id), "app.signin_config.updated")
        },
    )
    .await?;
    tx.commit().await?;
    Ok(())
}

fn present_after(change: &SecretChange, stored: bool) -> bool {
    match change {
        SecretChange::Keep => stored,
        SecretChange::Set(_) => true,
        SecretChange::Remove => false,
    }
}

fn decrypt_opt(state: &AppState, enc: Option<&[u8]>) -> ApiResult<Option<String>> {
    match enc {
        // A secret that no longer decrypts (lost key version) counts as "something else", so
        // a new value is always recorded as a change.
        Some(bytes) => Ok(state.keys.keyring.decrypt_string(bytes).ok()),
        None => Ok(None),
    }
}

fn new_secret_column(
    state: &AppState,
    change: &SecretChange,
    stored: Option<Vec<u8>>,
) -> ApiResult<Option<Vec<u8>>> {
    Ok(match change {
        SecretChange::Keep => stored,
        SecretChange::Remove => None,
        SecretChange::Set(v) => Some(state.keys.keyring.encrypt_str(v)?),
    })
}

/// Creates the default config row when an app has none yet (version 1, defaults).
pub(crate) async fn ensure_config_row(
    conn: &mut sqlx::PgConnection,
    app_id: &str,
) -> ApiResult<()> {
    sqlx::query(
        "insert into app_signin_configs (app_id, config) values ($1, $2) on conflict (app_id) do nothing",
    )
    .bind(app_id)
    .bind(serde_json::to_value(SigninConfig::default())?)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

pub(crate) async fn lock_config_row(
    conn: &mut sqlx::PgConnection,
    app_id: &str,
) -> ApiResult<apps_repo::AppSigninRow> {
    Ok(sqlx::query_as::<_, apps_repo::AppSigninRow>(
        "select app_id, version, config, google_client_secret_enc, apple_private_key_enc, webhook_url, \
         webhook_secret_enc, updated_at, updated_by from app_signin_configs where app_id = $1 for update",
    )
    .bind(app_id)
    .fetch_one(&mut *conn)
    .await?)
}

#[derive(Debug, Default, Deserialize)]
struct HistoryQuery {
    limit: Option<i64>,
    cursor: Option<String>,
}

#[derive(Debug, sqlx::FromRow)]
struct HistoryRow {
    id: i64,
    version: i64,
    actor: String,
    changes: Value,
    at: OffsetDateTime,
    actor_uuid: Option<String>,
}

async fn history(
    State(state): State<AppState>,
    auth: AppOrOwner,
    Query(q): Query<HistoryQuery>,
) -> ApiResult<Response> {
    let params = accounts_core::http::PageParams {
        limit: q.limit,
        cursor: q.cursor,
    };
    let limit = params.limit();
    let before_id: Option<i64> = params.cursor()?;
    let mut conn = state.db.acquire().await?;
    let rows = sqlx::query_as::<_, HistoryRow>(
        "select h.id, h.version, h.actor, h.changes, h.at, a.uuid as actor_uuid from app_config_history h \
         left join accounts a on a.uuid = h.actor \
         where h.app_id = $1 and ($2::bigint is null or h.id < $2) order by h.id desc limit $3",
    )
    .bind(&auth.app.app_id)
    .bind(before_id)
    .bind(limit + 1)
    .fetch_all(&mut *conn)
    .await?;
    let page = paginate(rows, limit, |r| r.id);
    let mut items = Vec::with_capacity(page.items.len());
    for r in page.items {
        let actor_account = match &r.actor_uuid {
            Some(uuid) => accounts_core::repo::accounts::get(&mut conn, uuid)
                .await?
                .as_ref()
                .map(AccountSummary::from_account),
            None => None,
        };
        items.push(json!({
            "version": r.version,
            "actor": r.actor,
            "actor_account": actor_account,
            "changes": r.changes,
            "at": accounts_core::timefmt::format_rfc3339_ms(r.at),
        }));
    }
    Ok(axum::Json(json!({"items": items, "next_cursor": page.next_cursor})).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    const P8: &str = "-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgGdfFP1jFA4pzuhrh\nu9NNiwVnz8fs9N558N3uNB5RWF2hRANCAAT0i9TKV75AItnA5uq9Jwj+RT0uZEkx\nSLO0NtZA5x+rWTG+GkKWDp5R/fNlUSV/zza5ndQDaXpXC9EC9sofkPjd\n-----END PRIVATE KEY-----\n";

    #[test]
    fn split_removes_secrets_masks_and_version() {
        let body = json!({
            "expected_version": 3,
            "google": {"mode": "byo", "client_id": "x.apps.googleusercontent.com", "client_secret": " GOCSPX-abc ", "client_secret_set": true},
            "apple": {"private_key": null, "private_key_set": false},
            "branding": {"radius": 20}
        });
        let parts = split_patch(&body, true).expect("valid");
        assert_eq!(parts.expected_version, Some(3));
        assert_eq!(
            parts.google_client_secret,
            SecretChange::Set("GOCSPX-abc".into())
        );
        assert_eq!(parts.apple_private_key, SecretChange::Remove);
        assert_eq!(
            parts.patch,
            json!({"google": {"mode": "byo", "client_id": "x.apps.googleusercontent.com"}, "apple": {}, "branding": {"radius": 20}})
        );
    }

    #[test]
    fn split_validates_secrets_with_paths() {
        let err = split_patch(
            &json!({"google": {"client_secret": 5}, "expected_version": "x"}),
            true,
        )
        .expect_err("invalid");
        assert!(err.get("google.client_secret").is_some());
        assert!(err.get("expected_version").is_some());
        let err = split_patch(&json!({"apple": {"private_key": "not a key"}}), true)
            .expect_err("bad key");
        assert!(
            err.get("apple.private_key")
                .is_some_and(|m| m.contains("BEGIN PRIVATE KEY"))
        );
        let ok = split_patch(
            &json!({"apple": {"private_key": P8.replace('\n', "\\n")}}),
            true,
        )
        .expect("escaped key");
        assert_eq!(ok.apple_private_key, SecretChange::Set(P8.to_string()));
        assert!(split_patch(&json!([1]), true).is_err());
    }

    #[test]
    fn diffs_are_leaf_level_and_secrets_redacted() {
        let mut out = Vec::new();
        diff(
            &json!({"a": {"b": 1, "c": [1, 2]}, "d": "x"}),
            &json!({"a": {"b": 2, "c": [1, 2]}, "d": "x", "e": true}),
            "",
            &mut out,
        );
        let paths: Vec<&str> = out.iter().map(|c| c.path.as_str()).collect();
        assert_eq!(paths, vec!["a.b", "e"]);
        let c = secret_change_entry(
            "google.client_secret",
            Some("old"),
            &SecretChange::Set("new".into()),
        )
        .expect("change");
        let v = serde_json::to_value(&c).expect("json");
        assert_eq!(v["before"], REDACTED);
        assert_eq!(v["after"], REDACTED);
        assert!(!v.to_string().contains("new") && !v.to_string().contains("old"));
        assert!(
            secret_change_entry("x", Some("same"), &SecretChange::Set("same".into())).is_none()
        );
        assert!(secret_change_entry("x", None, &SecretChange::Remove).is_none());
    }
}
