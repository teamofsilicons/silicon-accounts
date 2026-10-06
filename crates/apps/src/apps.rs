//! App identity routes:
//!
//! - `GET /v1/apps/{app_id}/public` (public, `Access-Control-Allow-Origin: *`): what the embed
//!   buttons and the SDK need to render an app's sign-in buttons, including the
//!   `allowed_origins` that may frame the embed (the account site turns them into the embed
//!   page's `frame-ancestors`; a CSP is public anyway).
//! - `GET /v1/me/owned-apps` (Carbon session): the apps the Carbon owns.
//! - `GET /v1/apps/{app_id}` (app or owner): the app, its sign-in setup with secrets masked,
//!   its webhook (secret masked) and user base statistics.

use accounts_core::http::pagination::paginate;
use accounts_core::http::{AppOrOwner, CarbonAuth, Path, Query};
use accounts_core::models::{App, AppSource, AppStatus, SigninConfig};
use accounts_core::repo::{accounts, apps as apps_repo};
use accounts_core::views::AccountSummary;
use accounts_core::{ApiResult, AppState};
use axum::extract::State;
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::PgConnection;
use time::OffsetDateTime;

use crate::util::{from_micros, micros};

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/apps/{app_id}/public", get(public_config))
        .route("/v1/me/owned-apps", get(owned_apps))
        .route("/v1/apps/{app_id}", get(app_details))
}

/// `GET /v1/apps/{app_id}/public`. Errors carry the CORS header too, so a cross-origin embed can
/// read why it failed.
async fn public_config(State(state): State<AppState>, Path(app_id): Path<String>) -> Response {
    let mut response = match public_body(&state, &app_id).await {
        Ok(body) => (StatusCode::OK, Json(body)).into_response(),
        Err(e) => e.into_response(),
    };
    let headers = response.headers_mut();
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static("*"),
    );
    // Branding changes must show up immediately in embeds; let caches revalidate every time.
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    response
}

async fn public_body(state: &AppState, app_id: &str) -> ApiResult<Value> {
    let mut conn = state.db.acquire().await?;
    let app = apps_repo::require_active(&mut conn, app_id).await?;
    let config = apps_repo::effective_config(&mut conn, &state.settings, app_id).await?;
    Ok(json!({
        "app_id": app.app_id,
        "name": app.name,
        "logo_url": app.logo_url,
        "logo_dark_url": app.logo_dark_url,
        "homepage_url": app.homepage_url,
        "methods": config.available_methods(&state.settings),
        "branding": config.branding,
        "copy": config.copy,
        // Origins that may embed the sign-in iframe (frame-ancestors) and use the SDK.
        "allowed_origins": config.allowed_origins,
    }))
}

/// Query of `GET /v1/me/owned-apps`.
#[derive(Debug, Default, Deserialize)]
struct OwnedQuery {
    limit: Option<i64>,
    cursor: Option<String>,
}

/// One item of `GET /v1/me/owned-apps`.
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct OwnedApp {
    pub app_id: String,
    pub name: String,
    pub logo_url: Option<String>,
    pub status: AppStatus,
    pub source: AppSource,
    /// Live members (active or imported) whose account isn't deleted.
    pub users: i64,
    #[serde(with = "accounts_core::timefmt::rfc3339_ms")]
    pub created_at: OffsetDateTime,
}

async fn owned_apps(
    State(state): State<AppState>,
    me: CarbonAuth,
    Query(q): Query<OwnedQuery>,
) -> ApiResult<Response> {
    let page = accounts_core::http::PageParams {
        limit: q.limit,
        cursor: q.cursor,
    };
    let limit = page.limit();
    let cursor: Option<(i64, String)> = page.cursor()?;
    let (after_ts, after_id) = match cursor {
        Some((us, id)) => (Some(from_micros(us)?), Some(id)),
        None => (None, None),
    };
    let mut conn = state.db.acquire().await?;
    let rows = sqlx::query_as::<_, OwnedApp>(
        "select a.app_id, a.name, a.logo_url, a.status, a.source, a.created_at, \
           (select count(*) from memberships m join accounts ac on ac.uuid = m.account_uuid \
             where m.app_id = a.app_id and m.status in ('active', 'imported') and ac.status <> 'deleted') as users \
         from apps a where a.owner_uuid = $1 \
           and ($2::timestamptz is null or (a.created_at, a.app_id) < ($2, $3)) \
         order by a.created_at desc, a.app_id desc limit $4",
    )
    .bind(me.uuid())
    .bind(after_ts)
    .bind(after_id)
    .bind(limit + 1)
    .fetch_all(&mut *conn)
    .await?;
    let page = paginate(rows, limit, |r| (micros(r.created_at), r.app_id.clone()));
    Ok(Json(page).into_response())
}

async fn app_details(State(state): State<AppState>, auth: AppOrOwner) -> ApiResult<Response> {
    let mut conn = state.db.acquire().await?;
    let body = details_body(&mut conn, &state, &auth.app).await?;
    Ok(Json(body).into_response())
}

/// User base statistics. Deleted accounts are history, never members.
#[derive(Debug, Clone, Copy, Default, Serialize, sqlx::FromRow)]
pub struct AppStats {
    /// Live members: active or imported memberships of accounts that aren't deleted.
    pub users: i64,
    /// Active members (not deleted) who signed in during the last 30 days.
    pub active_last_30d: i64,
    /// Imported members whose account was created by an import and never finished setup.
    pub imported_unclaimed: i64,
}

/// Counts the user base of an app.
pub async fn app_stats(conn: &mut PgConnection, app_id: &str) -> ApiResult<AppStats> {
    Ok(sqlx::query_as::<_, AppStats>(
        "select \
           count(*) filter (where m.status in ('active', 'imported') and a.status <> 'deleted') as users, \
           count(*) filter (where m.status = 'active' and a.status <> 'deleted' \
                            and m.last_signed_in_at > now() - interval '30 days') as active_last_30d, \
           count(*) filter (where m.status = 'imported' and a.status = 'unclaimed') as imported_unclaimed \
         from memberships m join accounts a on a.uuid = m.account_uuid where m.app_id = $1",
    )
    .bind(app_id)
    .fetch_one(&mut *conn)
    .await?)
}

/// The stored sign-in config as JSON with BYO secrets masked as
/// `google.client_secret_set` / `apple.private_key_set`, plus its version and webhook info.
pub(crate) struct MaskedConfig {
    pub config: Value,
    pub version: i64,
    pub webhook_url: Option<String>,
    pub webhook_secret_set: bool,
}

pub(crate) async fn masked_config(
    conn: &mut PgConnection,
    app_id: &str,
) -> ApiResult<MaskedConfig> {
    let row = apps_repo::signin_row(conn, app_id).await?;
    let (config, version, google_set, apple_set, webhook_url, webhook_secret_set) = match &row {
        Some(r) => (
            SigninConfig::from_stored(&r.config),
            r.version,
            r.google_client_secret_enc.is_some(),
            r.apple_private_key_enc.is_some(),
            r.webhook_url.clone(),
            r.webhook_secret_enc.is_some(),
        ),
        // An app without a stored row uses the defaults; the first PATCH creates version 1.
        None => (SigninConfig::default(), 0, false, false, None, false),
    };
    let mut value = serde_json::to_value(&config)?;
    if let Some(g) = value.get_mut("google").and_then(Value::as_object_mut) {
        g.insert("client_secret_set".into(), Value::Bool(google_set));
    }
    if let Some(a) = value.get_mut("apple").and_then(Value::as_object_mut) {
        a.insert("private_key_set".into(), Value::Bool(apple_set));
    }
    Ok(MaskedConfig {
        config: value,
        version,
        webhook_url,
        webhook_secret_set,
    })
}

/// The `GET /v1/apps/{app_id}` body (also returned by `PATCH …/signin-config`).
pub(crate) async fn details_body(
    conn: &mut PgConnection,
    state: &AppState,
    app: &App,
) -> ApiResult<Value> {
    let _ = state;
    // Re-read the app: the extractor's copy may come from the 60 s credential cache.
    let app = apps_repo::get(conn, &app.app_id)
        .await?
        .ok_or_else(|| apps_repo::unknown_app(&app.app_id))?;
    let masked = masked_config(conn, &app.app_id).await?;
    let owner = match &app.owner_uuid {
        Some(uuid) => accounts::get(conn, uuid)
            .await?
            .as_ref()
            .map(AccountSummary::from_account),
        None => None,
    };
    let stats = app_stats(conn, &app.app_id).await?;
    Ok(json!({
        "app_id": app.app_id,
        "name": app.name,
        "description": app.description,
        "logo_url": app.logo_url,
        "logo_dark_url": app.logo_dark_url,
        "homepage_url": app.homepage_url,
        "owner": owner,
        "status": app.status,
        "source": app.source,
        "created_at": accounts_core::timefmt::format_rfc3339_ms(app.created_at),
        "updated_at": accounts_core::timefmt::format_rfc3339_ms(app.updated_at),
        "signin_config": masked.config,
        "config_version": masked.version,
        "webhook": {"url": masked.webhook_url, "secret_set": masked.webhook_secret_set},
        "stats": stats,
    }))
}
