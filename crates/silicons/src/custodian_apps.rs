//! A custodian's controls over the apps of a Silicon it is custodian of:
//!
//! | endpoint | what |
//! |---|---|
//! | `GET /v1/me/silicons/{uuid}/apps?status&limit&cursor` | the apps the Silicon signed into (its memberships), most recently used first |
//! | `DELETE /v1/me/silicons/{uuid}/apps/{app_id}` | remove the Silicon's access to one app: its sign-ins there end, the User verification proofs about it are revoked, the app gets `membership.access_removed` |
//! | `GET /v1/me/silicons/{uuid}/signins?limit&cursor` | the Silicon's sign-in history, newest first |
//! | `GET`/`PUT /v1/me/silicons/{uuid}/allowed-apps` | `{"allowed_apps": null | [app_id…]}`: the apps the Silicon may get short-lived tokens for (`null` = every app) |
//!
//! `{uuid}` also takes the Silicon's si:id. Silicons the caller is not custodian of are 404
//! `silicon_not_found`. The allow-list only decides new short-lived tokens (403
//! `app_not_allowed` for any other app); sign-ins the Silicon already has stay until the
//! custodian removes them.

use accounts_core::events;
use accounts_core::http::pagination::encode_cursor;
use accounts_core::http::{CarbonAuth, ClientMeta, Json, PageParams, Path, Query};
use accounts_core::ids::validate_app_id;
use accounts_core::models::{Account, MembershipStatus};
use accounts_core::repo::memberships;
use accounts_core::timefmt::format_rfc3339_ms;
use accounts_core::{ApiError, ApiResult, AppState, FieldErrors, is_first_party_app_id};
use axum::extract::State;
use axum::http::StatusCode;
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::PgConnection;
use time::OffsetDateTime;

use crate::common::{lock_my_silicon, my_silicon};
use crate::history::Actor;

/// Most apps one allow-list may name.
pub const MAX_ALLOWED_APPS: usize = 100;

fn micros(t: OffsetDateTime) -> i64 {
    (t.unix_timestamp_nanos() / 1000) as i64
}

fn from_micros(us: i64) -> ApiResult<OffsetDateTime> {
    OffsetDateTime::from_unix_timestamp_nanos(i128::from(us) * 1000).map_err(|_| {
        ApiError::bad_request("invalid_cursor", "The cursor is not valid for this list.")
            .hint("Pass the next_cursor value from the previous page unchanged, or omit cursor to start over.")
    })
}

/// A moment later than any row, for the first page.
fn end_of_time() -> OffsetDateTime {
    OffsetDateTime::from_unix_timestamp(32_503_680_000).unwrap_or(OffsetDateTime::now_utc())
}

#[derive(Debug, Default, Deserialize)]
pub(crate) struct AppsQuery {
    status: Option<String>,
    limit: Option<i64>,
    cursor: Option<String>,
}

#[derive(sqlx::FromRow)]
struct AppRow {
    app_id: String,
    membership_id: String,
    status: MembershipStatus,
    source: String,
    granted_scopes: Vec<String>,
    first_signed_in_at: Option<OffsetDateTime>,
    last_signed_in_at: Option<OffsetDateTime>,
    access_removed_at: Option<OffsetDateTime>,
    sort_at: OffsetDateTime,
    name: String,
    logo_url: Option<String>,
    logo_dark_url: Option<String>,
    homepage_url: Option<String>,
    active_sessions: i64,
}

/// `GET /v1/me/silicons/{uuid}/apps`.
pub(crate) async fn list_apps(
    State(state): State<AppState>,
    me: CarbonAuth,
    Path(key): Path<String>,
    Query(q): Query<AppsQuery>,
) -> ApiResult<Json<Value>> {
    let mut conn = state.db.acquire().await?;
    let silicon = my_silicon(&mut conn, me.uuid(), &key).await?;
    let status = match q
        .status
        .as_deref()
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty())
    {
        None => None,
        Some(s) => Some(MembershipStatus::parse(&s).ok_or_else(|| {
            ApiError::bad_request(
                "invalid_query",
                format!(
                    "The query parameter 'status' is '{}'; it must be one of {}.",
                    s.chars().take(40).collect::<String>(),
                    MembershipStatus::expected()
                ),
            )
            .hint("Omit status to list every app.")
        })?),
    };
    let params = PageParams {
        limit: q.limit,
        cursor: q.cursor.clone(),
    };
    let limit = params.limit();
    let (cursor_at, cursor_app) = match params.cursor::<(i64, String)>()? {
        Some((us, app)) => (from_micros(us)?, app),
        None => (end_of_time(), String::new()),
    };
    let rows: Vec<AppRow> = sqlx::query_as(
        "select m.app_id, m.membership_id, m.status, m.source, m.granted_scopes, m.first_signed_in_at, \
                m.last_signed_in_at, m.access_removed_at, coalesce(m.last_signed_in_at, m.created_at) as sort_at, \
                a.name, a.logo_url, a.logo_dark_url, a.homepage_url, \
                (select count(*) from token_families f where f.account_uuid = m.account_uuid and f.app_id = m.app_id \
                   and f.revoked_at is null and f.expires_at > now()) as active_sessions \
           from memberships m join apps a on a.app_id = m.app_id \
          where m.account_uuid = $1 and m.app_id not in ('silicon-accounts', 'developer') \
            and ($2::text is null or m.status = $2) \
            and (coalesce(m.last_signed_in_at, m.created_at), m.app_id) < ($3, $4) \
          order by coalesce(m.last_signed_in_at, m.created_at) desc, m.app_id desc \
          limit $5",
    )
    .bind(&silicon.uuid)
    .bind(status.map(|s| s.as_str()))
    .bind(cursor_at)
    .bind(cursor_app)
    .bind(limit + 1)
    .fetch_all(&mut *conn)
    .await?;
    let more = rows.len() as i64 > limit;
    let rows: Vec<AppRow> = rows.into_iter().take(limit as usize).collect();
    let next_cursor = if more {
        rows.last()
            .map(|r| encode_cursor(&(micros(r.sort_at), r.app_id.clone())))
    } else {
        None
    };
    let ts = |t: Option<OffsetDateTime>| t.map(format_rfc3339_ms);
    let items: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "app": {
                    "app_id": r.app_id, "name": r.name, "logo_url": r.logo_url,
                    "logo_dark_url": r.logo_dark_url, "homepage_url": r.homepage_url,
                },
                "membership_id": r.membership_id,
                "status": r.status,
                "source": r.source,
                "granted_scopes": r.granted_scopes,
                "first_signed_in_at": ts(r.first_signed_in_at),
                "last_signed_in_at": ts(r.last_signed_in_at),
                "access_removed_at": ts(r.access_removed_at),
                "active_sessions": r.active_sessions,
            })
        })
        .collect();
    Ok(Json(json!({"items": items, "next_cursor": next_cursor})))
}

/// `DELETE /v1/me/silicons/{uuid}/apps/{app_id}` → 204. Repeating it changes nothing.
pub(crate) async fn remove_app(
    State(state): State<AppState>,
    me: CarbonAuth,
    meta: ClientMeta,
    Path((key, app_id)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    let app_id = app_id.trim().to_ascii_lowercase();
    let mut tx = state.db.begin().await?;
    let silicon = lock_my_silicon(&mut tx, me.uuid(), &key).await?;
    if is_first_party_app_id(&app_id) {
        return Err(ApiError::bad_request(
            "first_party_app",
            "Silicon Accounts itself can't lose access to a Silicon; its sign-ins are sessions of Silicon Accounts.",
        )
        .hint("To end every sign-in of the Silicon, rotate its STK (POST /v1/me/silicons/{uuid}/stk).")
        .detail("app_id", app_id));
    }
    let status: Option<MembershipStatus> = sqlx::query_scalar(
        "select status from memberships where app_id = $1 and account_uuid = $2 for update",
    )
    .bind(&app_id)
    .bind(&silicon.uuid)
    .fetch_optional(&mut *tx)
    .await?;
    match status {
        None => {
            return Err(ApiError::not_found(
                "membership_not_found",
                format!(
                    "{} has never signed into an app with the app_id '{}'.",
                    silicon.display_id(),
                    app_id.chars().take(60).collect::<String>()
                ),
            )
            .hint("List its apps with GET /v1/me/silicons/{uuid}/apps."));
        }
        Some(MembershipStatus::AccessRemoved) => {
            tx.commit().await?;
            return Ok(StatusCode::NO_CONTENT);
        }
        Some(_) => {}
    }
    let removed = memberships::remove_access(&mut tx, &app_id, &silicon.uuid, me.uuid()).await?;
    events::membership_access_removed(&mut tx, &app_id, &silicon.uuid).await?;
    Actor::account(me.uuid(), meta.ip.as_deref())
        .record_for(
            &mut tx,
            "membership.access_removed_by_custodian",
            &[Some(me.uuid()), Some(&silicon.uuid)],
            &silicon.uuid,
            json!({
                "app_id": app_id,
                "membership_id": removed.membership.membership_id,
                "revoked_sessions": removed.revoked_families,
                "revoked_proofs": removed.revoked_proofs,
            }),
        )
        .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Default, Deserialize)]
pub(crate) struct SigninsQuery {
    limit: Option<i64>,
    cursor: Option<String>,
}

#[derive(sqlx::FromRow)]
struct SigninRow {
    id: i64,
    at: OffsetDateTime,
    app_id: Option<String>,
    app_name: Option<String>,
    method: String,
    outcome: String,
    ip: Option<String>,
    user_agent: Option<String>,
}

/// `GET /v1/me/silicons/{uuid}/signins`.
pub(crate) async fn list_signins(
    State(state): State<AppState>,
    me: CarbonAuth,
    Path(key): Path<String>,
    Query(q): Query<SigninsQuery>,
) -> ApiResult<Json<Value>> {
    let mut conn = state.db.acquire().await?;
    let silicon = my_silicon(&mut conn, me.uuid(), &key).await?;
    let params = PageParams {
        limit: q.limit,
        cursor: q.cursor.clone(),
    };
    let limit = params.limit();
    let before: i64 = params.cursor::<i64>()?.unwrap_or(i64::MAX);
    let rows: Vec<SigninRow> = sqlx::query_as(
        "select h.id, h.at, h.app_id, a.name as app_name, h.method, h.outcome, h.ip, h.user_agent \
           from signin_history h left join apps a on a.app_id = h.app_id \
          where h.account_uuid = $1 and h.id < $2 order by h.id desc limit $3",
    )
    .bind(&silicon.uuid)
    .bind(before)
    .bind(limit + 1)
    .fetch_all(&mut *conn)
    .await?;
    let more = rows.len() as i64 > limit;
    let rows: Vec<SigninRow> = rows.into_iter().take(limit as usize).collect();
    let next_cursor = if more {
        rows.last().map(|r| encode_cursor(&r.id))
    } else {
        None
    };
    let items: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "at": format_rfc3339_ms(r.at),
                "app": r.app_id.as_ref().map(|id| json!({"app_id": id, "name": r.app_name})),
                "method": r.method,
                "outcome": r.outcome,
                "ip": r.ip,
                "user_agent": r.user_agent,
            })
        })
        .collect();
    Ok(Json(json!({"items": items, "next_cursor": next_cursor})))
}

/// The Silicon's allow-list (`None` = every app).
pub async fn allowed_apps(
    conn: &mut PgConnection,
    silicon_uuid: &str,
) -> ApiResult<Option<Vec<String>>> {
    Ok(
        sqlx::query_scalar("select slt_allowed_apps from accounts where uuid = $1")
            .bind(silicon_uuid)
            .fetch_optional(&mut *conn)
            .await?
            .flatten(),
    )
}

fn allowed_view(silicon: &Account, allowed: Option<Vec<String>>) -> Value {
    json!({"silicon": {"uuid": silicon.uuid, "id": silicon.handle}, "allowed_apps": allowed})
}

/// `GET /v1/me/silicons/{uuid}/allowed-apps`.
pub(crate) async fn get_allowed_apps(
    State(state): State<AppState>,
    me: CarbonAuth,
    Path(key): Path<String>,
) -> ApiResult<Json<Value>> {
    let mut conn = state.db.acquire().await?;
    let silicon = my_silicon(&mut conn, me.uuid(), &key).await?;
    let allowed = allowed_apps(&mut conn, &silicon.uuid).await?;
    Ok(Json(allowed_view(&silicon, allowed)))
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct AllowedAppsBody {
    allowed_apps: Option<Vec<String>>,
}

/// `PUT /v1/me/silicons/{uuid}/allowed-apps` `{"allowed_apps": null | [app_id…]}`.
pub(crate) async fn set_allowed_apps(
    State(state): State<AppState>,
    me: CarbonAuth,
    meta: ClientMeta,
    Path(key): Path<String>,
    Json(body): Json<AllowedAppsBody>,
) -> ApiResult<Json<Value>> {
    let list = match body.allowed_apps {
        None => None,
        Some(list) => {
            let mut fields = FieldErrors::new();
            if list.len() > MAX_ALLOWED_APPS {
                fields.add(
                    "allowed_apps",
                    format!("at most {MAX_ALLOWED_APPS} apps, got {}", list.len()),
                );
            }
            let mut out: Vec<String> = Vec::new();
            for (i, raw) in list.iter().enumerate() {
                let id = raw.trim().to_ascii_lowercase();
                if let Err(m) = validate_app_id(&id) {
                    fields.add(format!("allowed_apps[{i}]"), m);
                } else if is_first_party_app_id(&id) {
                    fields.add(
                        format!("allowed_apps[{i}]"),
                        "Silicon Accounts' own apps need no short-lived tokens",
                    );
                } else if !out.contains(&id) {
                    out.push(id);
                }
            }
            if !fields.is_empty() {
                return Err(ApiError::validation(fields));
            }
            Some(out)
        }
    };
    let mut tx = state.db.begin().await?;
    let silicon = lock_my_silicon(&mut tx, me.uuid(), &key).await?;
    if let Some(list) = &list {
        let known: Vec<String> =
            sqlx::query_scalar("select app_id from apps where app_id = any($1)")
                .bind(list)
                .fetch_all(&mut *tx)
                .await?;
        let unknown: Vec<String> = list
            .iter()
            .filter(|a| !known.contains(a))
            .cloned()
            .collect();
        if !unknown.is_empty() {
            return Err(ApiError::unprocessable(
                "unknown_app",
                format!(
                    "No app has the app_id {}.",
                    unknown
                        .iter()
                        .map(|a| format!("'{a}'"))
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
            )
            .hint("Check the app ids in Silicon Apps; the list may only name apps that exist.")
            .detail("unknown", unknown));
        }
    }
    sqlx::query("update accounts set slt_allowed_apps = $2, updated_at = now() where uuid = $1")
        .bind(&silicon.uuid)
        .bind(&list)
        .execute(&mut *tx)
        .await?;
    Actor::account(me.uuid(), meta.ip.as_deref())
        .record_for(
            &mut tx,
            "silicon.allowed_apps.set",
            &[Some(me.uuid()), Some(&silicon.uuid)],
            &silicon.uuid,
            json!({"allowed_apps": list}),
        )
        .await?;
    tx.commit().await?;
    Ok(Json(allowed_view(&silicon, list)))
}

/// 403 `app_not_allowed`: the custodian's allow-list doesn't name `app_id`.
pub fn app_not_allowed(silicon: &Account, app_id: &str, allowed: &[String]) -> ApiError {
    ApiError::forbidden(
        "app_not_allowed",
        format!(
            "{}'s custodian only lets it sign into {}, so it can't get a short-lived token for '{app_id}'.",
            silicon.display_id(),
            if allowed.is_empty() {
                "no apps".to_string()
            } else {
                allowed.join(", ")
            }
        ),
    )
    .hint("Ask your custodian to add the app (`silicon-accounts silicon apps allow <si:id> <app_id>`).")
    .detail("app_id", app_id)
    .detail("allowed_apps", allowed.to_vec())
}
