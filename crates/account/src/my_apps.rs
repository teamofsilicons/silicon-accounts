//! The apps an account has signed into (its memberships), and removing an app's access.

use accounts_core::events;
use accounts_core::http::pagination::encode_cursor;
use accounts_core::http::{AccountAuth, ClientMeta, Json, Path, Query};
use accounts_core::models::MembershipStatus;
use accounts_core::repo::memberships;
use accounts_core::views::{AppSummary, Page};
use accounts_core::{
    ApiError, ApiResult, AppState, DEVELOPER_APP_ID, FIRST_PARTY_APP_ID, is_first_party_app_id,
};
use axum::extract::State;
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::json;
use time::OffsetDateTime;

use crate::util::{END_OF_TIME, audit_self, clip, from_micros, to_micros, track};

#[derive(Debug, Deserialize)]
pub(crate) struct ListQuery {
    limit: Option<i64>,
    cursor: Option<String>,
    status: Option<String>,
}

#[derive(Debug, sqlx::FromRow)]
struct Row {
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

/// One app in `GET /v1/me/apps`.
#[derive(Debug, Serialize)]
pub(crate) struct MyApp {
    app: AppSummary,
    membership_id: String,
    /// `active`, `access_removed` or `imported` (the app imported this account; it hasn't
    /// signed in there yet).
    status: MembershipStatus,
    /// `signin`, `slt` or `import`: how the membership started.
    source: String,
    granted_scopes: Vec<String>,
    #[serde(with = "accounts_core::timefmt::rfc3339_ms_option")]
    first_signed_in_at: Option<OffsetDateTime>,
    #[serde(with = "accounts_core::timefmt::rfc3339_ms_option")]
    last_signed_in_at: Option<OffsetDateTime>,
    #[serde(with = "accounts_core::timefmt::rfc3339_ms_option")]
    access_removed_at: Option<OffsetDateTime>,
    /// Live sign-ins (token families) the app holds for this account.
    active_sessions: i64,
}

/// Silicon Accounts' own apps: the account site and CLI (`accounts`) and the developer platform
/// (`developer`). They are never apps the account signed into.
const FIRST_PARTY_APPS: [&str; 2] = [FIRST_PARTY_APP_ID, DEVELOPER_APP_ID];

/// `GET /v1/me/apps?limit&cursor&status` → `{"items":[MyApp…],"next_cursor"}`, most recently
/// used first. The first-party apps (the account site and CLI, the developer platform) are not
/// listed.
pub(crate) async fn list(
    State(state): State<AppState>,
    me: AccountAuth,
    Query(q): Query<ListQuery>,
) -> ApiResult<Json<Page<MyApp>>> {
    let requested = q
        .status
        .as_deref()
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty());
    let status = match requested.as_deref() {
        None => None,
        Some(s) => Some(MembershipStatus::parse(s).ok_or_else(|| {
            ApiError::bad_request(
                "invalid_query",
                format!(
                    "The query parameter 'status' is '{}'; it must be one of {}.",
                    clip(s, 40),
                    MembershipStatus::expected()
                ),
            )
            .hint("Omit status to list every app.")
        })?),
    };
    let limit = q.limit.unwrap_or(50).clamp(1, 200);
    let params = accounts_core::http::PageParams {
        limit: Some(limit),
        cursor: q.cursor.clone(),
    };
    let (cursor_at, cursor_app) = match params.cursor::<(i64, String)>()? {
        Some((micros, app)) => (from_micros(micros)?, app),
        None => (END_OF_TIME, String::new()),
    };
    let rows: Vec<Row> = sqlx::query_as(
        "select m.app_id, m.membership_id, m.status, m.source, m.granted_scopes, m.first_signed_in_at, \
                m.last_signed_in_at, m.access_removed_at, coalesce(m.last_signed_in_at, m.created_at) as sort_at, \
                a.name, a.logo_url, a.logo_dark_url, a.homepage_url, \
                (select count(*) from token_families f where f.account_uuid = m.account_uuid and f.app_id = m.app_id \
                   and f.revoked_at is null and f.expires_at > now()) as active_sessions \
           from memberships m join apps a on a.app_id = m.app_id \
          where m.account_uuid = $1 and m.app_id <> all($2) and ($3::text is null or m.status = $3) \
            and (coalesce(m.last_signed_in_at, m.created_at), m.app_id) < ($4, $5) \
          order by coalesce(m.last_signed_in_at, m.created_at) desc, m.app_id desc \
          limit $6",
    )
    .bind(me.uuid())
    .bind(&FIRST_PARTY_APPS[..])
    .bind(status.map(|s| s.as_str()))
    .bind(cursor_at)
    // Without a cursor the bound time is later than any row, so the app id never decides.
    .bind(cursor_app)
    .bind(limit + 1)
    .fetch_all(&state.db)
    .await?;
    let mut items: Vec<(i64, String, MyApp)> = rows
        .into_iter()
        .map(|r| {
            (
                to_micros(r.sort_at),
                r.app_id.clone(),
                MyApp {
                    app: AppSummary {
                        app_id: r.app_id,
                        name: r.name,
                        logo_url: r.logo_url,
                        logo_dark_url: r.logo_dark_url,
                        homepage_url: r.homepage_url,
                    },
                    membership_id: r.membership_id,
                    status: r.status,
                    source: r.source,
                    granted_scopes: r.granted_scopes,
                    first_signed_in_at: r.first_signed_in_at,
                    last_signed_in_at: r.last_signed_in_at,
                    access_removed_at: r.access_removed_at,
                    active_sessions: r.active_sessions,
                },
            )
        })
        .collect();
    let next_cursor = if items.len() as i64 > limit {
        items.truncate(limit as usize);
        items
            .last()
            .map(|(micros, app, _)| encode_cursor(&(micros, app)))
    } else {
        None
    };
    Ok(Json(Page::new(
        items.into_iter().map(|(_, _, a)| a).collect(),
        next_cursor,
    )))
}

/// 400 `first_party_app` for Silicon Accounts' own apps (`accounts`, `developer`): they are not
/// apps the account signed into, so there is no access to remove. What they hold are sessions of
/// Silicon Accounts itself, which `DELETE /v1/me/sessions/{id}` signs out.
fn first_party_refusal(app_id: &str) -> ApiError {
    let refusal = if app_id == DEVELOPER_APP_ID {
        ApiError::bad_request(
            "first_party_app",
            "The developer platform (developer.teamofsilicons.com, app_id 'developer') is part of Silicon Accounts, not an app you signed into, so it has no access to your account to remove.",
        )
        .hint("To sign the developer site out, revoke its sign-in with DELETE /v1/me/sessions/{id} (GET /v1/me/sessions lists it with kind developer).")
    } else {
        ApiError::bad_request(
            "first_party_app",
            "Silicon Accounts itself (the account site and the accounts CLI) can't lose access to your account.",
        )
        .hint("To sign out a browser or CLI, revoke it with DELETE /v1/me/sessions/{id} (list them with GET /v1/me/sessions).")
    };
    refusal.detail("app_id", app_id)
}

/// `DELETE /v1/me/apps/{app_id}` → 204. Removes the app's access: its sign-ins (token families)
/// for this account are revoked, the OBO proofs it issued about this account are revoked, the
/// membership becomes `access_removed`, and the app gets `membership.access_removed`. Removing
/// access that is already removed changes nothing (no second webhook). Silicon Accounts' own apps
/// are refused (see [`first_party_refusal`]).
pub(crate) async fn remove_access(
    State(state): State<AppState>,
    me: AccountAuth,
    meta: ClientMeta,
    Path(app_id): Path<String>,
) -> ApiResult<StatusCode> {
    let app_id = app_id.trim().to_string();
    if is_first_party_app_id(&app_id) {
        return Err(first_party_refusal(&app_id));
    }
    let mut tx = state.db.begin().await?;
    let status: Option<MembershipStatus> = sqlx::query_scalar(
        "select status from memberships where app_id = $1 and account_uuid = $2 for update",
    )
    .bind(&app_id)
    .bind(me.uuid())
    .fetch_optional(&mut *tx)
    .await?;
    match status {
        None => {
            return Err(ApiError::not_found(
                "membership_not_found",
                format!(
                    "{} has never signed into an app with the app_id '{}'.",
                    me.account.display_id(),
                    clip(&app_id, 60)
                ),
            )
            .hint("List the apps you've signed into with GET /v1/me/apps."));
        }
        Some(MembershipStatus::AccessRemoved) => {
            tx.commit().await?;
            return Ok(StatusCode::NO_CONTENT);
        }
        Some(_) => {}
    }
    let removed = memberships::remove_access(&mut tx, &app_id, me.uuid(), me.uuid()).await?;
    events::membership_access_removed(&mut tx, &app_id, me.uuid()).await?;
    audit_self(
        &mut tx,
        me.uuid(),
        "membership.access_removed",
        Some(&app_id),
        json!({
            "membership_id": removed.membership.membership_id,
            "revoked_sessions": removed.revoked_families,
            "revoked_proofs": removed.revoked_proofs,
        }),
        meta.ip.as_deref(),
    )
    .await?;
    tx.commit().await?;
    track(
        &state,
        "apps",
        "account.app_access.removed",
        json!({
            "kind": me.kind(),
            "revoked_sessions": removed.revoked_families,
            "revoked_proofs": removed.revoked_proofs,
        }),
    );
    Ok(StatusCode::NO_CONTENT)
}
