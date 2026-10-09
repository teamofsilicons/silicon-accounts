//! Silicon key credentials: Ed25519 public keys a Silicon signs in with instead of its STK, so
//! an unattended Silicon never has to hold a bearer secret (core's `silicon_keys`).
//!
//! | endpoint | who | what |
//! |---|---|---|
//! | `POST /v1/silicons/{id}/keys` | the Silicon, or its custodian | `{"public_key", "name"?}` → 201 the key |
//! | `GET /v1/silicons/{id}/keys` | the same | `{"items": [key…], "next_cursor": null}`, newest first, revoked ones too |
//! | `DELETE /v1/silicons/{id}/keys/{key_id}` | the same | 204: the key stops working and the sign-ins it started end |
//!
//! `{id}` is the Silicon's si:id or uuid. Anyone else gets 404 `silicon_not_found`. At most
//! [`MAX_KEYS_PER_SILICON`] live keys. Signing in: `POST /v1/silicons/login`
//! `{"assertion": "<JWT>"}` (see `login`), or the token endpoint's
//! `urn:ietf:params:oauth:grant-type:jwt-bearer` grant.

use accounts_core::http::{AccountAuth, ClientMeta, Json, Path};
use accounts_core::models::{Account, AccountKind, AccountStatus};
use accounts_core::repo::{accounts, tokens};
use accounts_core::silicon_keys::{
    MAX_KEYS_PER_SILICON, MAX_NAME_CHARS, SiliconKey, parse_public_key,
};
use accounts_core::{ApiError, ApiResult, AppState, FieldErrors};
use axum::extract::State;
use axum::http::StatusCode;
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::PgConnection;
use uuid::Uuid;

use crate::common::silicon_not_found;
use crate::history::Actor;

const KEY_COLUMNS: &str = "id, silicon_uuid, name, public_key, fingerprint, created_by, created_at, last_used_at, revoked_at";

/// The Silicon `{id}` when the caller is it or its custodian.
pub(crate) async fn silicon_for(
    conn: &mut PgConnection,
    me: &AccountAuth,
    key: &str,
) -> ApiResult<Account> {
    let key = key.trim();
    let found = if key.contains(':') {
        accounts::by_handle(conn, key).await?
    } else {
        accounts::get(conn, key).await?
    };
    match found {
        Some(a)
            if a.kind == AccountKind::Silicon
                && a.status != AccountStatus::Deleted
                && (a.uuid == me.account.uuid
                    || a.custodian_uuid.as_deref() == Some(me.account.uuid.as_str())) =>
        {
            Ok(a)
        }
        _ => Err(silicon_not_found(key)),
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct AddKeyBody {
    public_key: String,
    #[serde(default)]
    name: Option<String>,
}

/// `POST /v1/silicons/{id}/keys`.
pub(crate) async fn add(
    State(state): State<AppState>,
    me: AccountAuth,
    meta: ClientMeta,
    Path(key): Path<String>,
    Json(body): Json<AddKeyBody>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let public = parse_public_key(&body.public_key).map_err(|m| {
        let mut f = FieldErrors::new();
        f.add("public_key", m);
        ApiError::validation(f)
    })?;
    let name: String = body
        .name
        .as_deref()
        .map(|n| {
            n.split(|c: char| c.is_whitespace() || c.is_control())
                .filter(|p| !p.is_empty())
                .collect::<Vec<_>>()
                .join(" ")
        })
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "key".to_string());
    if name.chars().count() > MAX_NAME_CHARS {
        let mut f = FieldErrors::new();
        f.add("name", format!("at most {MAX_NAME_CHARS} characters"));
        return Err(ApiError::validation(f));
    }
    let mut tx = state.db.begin().await?;
    let silicon = silicon_for(&mut tx, &me, &key).await?;
    // A CI job signed in with an outside token acts as the Silicon, but never adds a way in.
    if accounts_core::federation::is_federated_session(&mut tx, &me).await? {
        return Err(accounts_core::federation::federated_session_refused("keys"));
    }
    let Some(silicon) = accounts::lock(&mut tx, &silicon.uuid).await? else {
        return Err(silicon_not_found(&key));
    };
    if silicon.status != AccountStatus::Active {
        return Err(ApiError::forbidden(
            "account_not_active",
            format!(
                "{} is {}, so it can't get keys.",
                silicon.display_id(),
                silicon.status
            ),
        ));
    }
    let live: i64 = sqlx::query_scalar(
        "select count(*) from silicon_keys where silicon_uuid = $1 and revoked_at is null",
    )
    .bind(&silicon.uuid)
    .fetch_one(&mut *tx)
    .await?;
    if live >= MAX_KEYS_PER_SILICON {
        return Err(ApiError::conflict(
            "too_many_keys",
            format!(
                "{} already has {MAX_KEYS_PER_SILICON} keys, the most a Silicon may have.",
                silicon.display_id()
            ),
        )
        .hint("Revoke a key it no longer uses (DELETE /v1/silicons/{id}/keys/{key_id}), then add this one."));
    }
    let existing: Option<Uuid> = sqlx::query_scalar(
        "select id from silicon_keys where silicon_uuid = $1 and public_key = $2 and revoked_at is null",
    )
    .bind(&silicon.uuid)
    .bind(&public.0[..])
    .fetch_optional(&mut *tx)
    .await?;
    if let Some(id) = existing {
        return Err(ApiError::conflict(
            "key_exists",
            format!("{} already has this key ({id}).", silicon.display_id()),
        )
        .detail("key_id", id.to_string()));
    }
    let row: SiliconKey = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "insert into silicon_keys (id, silicon_uuid, name, public_key, fingerprint, created_by) \
         values ($1, $2, $3, $4, $5, $6) returning {KEY_COLUMNS}"
    )))
    .bind(Uuid::now_v7())
    .bind(&silicon.uuid)
    .bind(&name)
    .bind(&public.0[..])
    .bind(public.fingerprint())
    .bind(&me.account.uuid)
    .fetch_one(&mut *tx)
    .await?;
    Actor::account(&me.account.uuid, meta.ip.as_deref())
        .record_for(
            &mut tx,
            "silicon.key.added",
            &[Some(&me.account.uuid), Some(&silicon.uuid)],
            &silicon.uuid,
            json!({"key_id": row.id, "name": row.name, "fingerprint": row.fingerprint}),
        )
        .await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(row.view())))
}

/// `GET /v1/silicons/{id}/keys`.
pub(crate) async fn list(
    State(state): State<AppState>,
    me: AccountAuth,
    Path(key): Path<String>,
) -> ApiResult<Json<Value>> {
    let mut conn = state.db.acquire().await?;
    let silicon = silicon_for(&mut conn, &me, &key).await?;
    let rows: Vec<SiliconKey> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "select {KEY_COLUMNS} from silicon_keys where silicon_uuid = $1 order by created_at desc, id desc limit 200"
    )))
    .bind(&silicon.uuid)
    .fetch_all(&mut *conn)
    .await?;
    let items: Vec<Value> = rows.iter().map(SiliconKey::view).collect();
    Ok(Json(json!({"items": items, "next_cursor": Value::Null})))
}

/// `DELETE /v1/silicons/{id}/keys/{key_id}`.
pub(crate) async fn revoke(
    State(state): State<AppState>,
    me: AccountAuth,
    meta: ClientMeta,
    Path((key, key_id)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    let not_found = || {
        ApiError::not_found(
            "key_not_found",
            format!("No key '{}' belongs to this Silicon.", key_id.trim()),
        )
        .hint("List its keys with GET /v1/silicons/{id}/keys.")
    };
    let id = Uuid::parse_str(key_id.trim()).map_err(|_| not_found())?;
    let mut tx = state.db.begin().await?;
    let silicon = silicon_for(&mut tx, &me, &key).await?;
    let row: Option<SiliconKey> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "select {KEY_COLUMNS} from silicon_keys where id = $1 and silicon_uuid = $2 for update"
    )))
    .bind(id)
    .bind(&silicon.uuid)
    .fetch_optional(&mut *tx)
    .await?;
    let row = row.ok_or_else(not_found)?;
    if row.revoked_at.is_some() {
        tx.commit().await?;
        return Ok(StatusCode::NO_CONTENT);
    }
    sqlx::query("update silicon_keys set revoked_at = now(), revoked_by = $2 where id = $1")
        .bind(id)
        .bind(&me.account.uuid)
        .execute(&mut *tx)
        .await?;
    // The sign-ins the key started end with it.
    let families: Vec<Uuid> = sqlx::query_scalar(
        "select s.family_id from silicon_key_sessions s join token_families f on f.id = s.family_id \
         where s.key_id = $1 and f.revoked_at is null",
    )
    .bind(id)
    .fetch_all(&mut *tx)
    .await?;
    for family in &families {
        tokens::revoke_family(&mut tx, *family, "silicon_key_revoked").await?;
    }
    Actor::account(&me.account.uuid, meta.ip.as_deref())
        .record_for(
            &mut tx,
            "silicon.key.revoked",
            &[Some(&me.account.uuid), Some(&silicon.uuid)],
            &silicon.uuid,
            json!({"key_id": id, "name": row.name, "fingerprint": row.fingerprint, "ended_sessions": families.len()}),
        )
        .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}
