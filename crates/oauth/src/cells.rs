//! Explicit, app-authorized Cells delegation. Never reads or returns app secrets.
use super::{grants, token::TokenParams};
use accounts_core::http::{AppAuth, ClientAuth, ClientMeta, IdempotencyKey, Json};
use accounts_core::models::{AccountStatus, ActorKind};
use accounts_core::repo::{apps, audit, idempotency, tokens};
use accounts_core::{ApiError, ApiResult, AppState, OAuthError};
use axum::{
    Router,
    extract::{Path, State},
    http::StatusCode,
    response::Response,
    routing::{post, put},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;

const CELLS: &str = "silicon-cells";
pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/internal/cells/author", post(author))
        .route(
            "/v1/internal/cells/links/{cell}/{app}",
            put(link).delete(unlink),
        )
        .route(
            "/v1/internal/cells/links/{cell}/{app}/token",
            post(exchange),
        )
        .route(
            "/v1/internal/cells/links/{cell}/{app}/introspect",
            post(introspect),
        )
        .route("/v1/internal/cells/links/{cell}/{app}/revoke", post(revoke))
}
fn service(auth: &AppAuth) -> ApiResult<()> {
    if auth.app.app_id != CELLS {
        return Err(ApiError::forbidden(
            "cells_service_required",
            "Only the Silicon Cells service may use this delegation bridge.",
        ));
    }
    Ok(())
}
fn oauth(e: OAuthError) -> ApiError {
    ApiError::new(e.status, e.error, e.description)
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct AuthorToken {
    access_token: String,
}
async fn verify_author(state: &AppState, token: &str) -> ApiResult<(String, Value)> {
    let mut conn = state.db.acquire().await?;
    let verified = tokens::verify_access_token(&mut conn, &state.keys, token, None).await?;
    if ![CELLS, accounts_core::DEVELOPER_APP_ID].contains(&verified.family.app_id.as_str())
        || verified.claims.exp <= time::OffsetDateTime::now_utc().unix_timestamp()
        || verified.account.status != AccountStatus::Active
    {
        return Err(ApiError::unauthenticated(
            "cells_author_token_required",
            "Use a live access token issued to silicon-cells or the developer platform.",
        ));
    }
    drop(conn);
    // Reuse the standard scoped view and live membership checks. In particular,
    // removing the Cells app's access also ends author access to this bridge.
    let view = super::userinfo::userinfo(state, token).await?;
    Ok((verified.account.uuid, view))
}
async fn author(
    State(state): State<AppState>,
    auth: AppAuth,
    Json(input): Json<AuthorToken>,
) -> ApiResult<Response> {
    service(&auth)?;
    let (_, view) = verify_author(&state, &input.access_token).await?;
    Ok(super::respond::no_store(StatusCode::OK, &view))
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Link {
    actor_token: String,
    callback_uri: String,
}
fn callback(uri: &str) -> ApiResult<()> {
    let url = url::Url::parse(uri)
        .map_err(|_| ApiError::invalid_request("callback_uri must be an absolute HTTPS URL."))?;
    let local = url
        .host_str()
        .is_some_and(|h| h == "localhost" || h.ends_with(".localhost") || h == "127.0.0.1");
    if !(url.scheme() == "https" || (local && url.scheme() == "http"))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/auth/callback"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(ApiError::invalid_request(
            "A cell callback must use HTTPS and the exact /auth/callback path, without credentials, query or fragment. HTTP is allowed only on loopback.",
        ));
    }
    Ok(())
}
async fn link(
    State(state): State<AppState>,
    auth: AppAuth,
    Path((cell, app)): Path<(Uuid, String)>,
    key: IdempotencyKey,
    Json(input): Json<Link>,
) -> ApiResult<Response> {
    service(&auth)?;
    callback(&input.callback_uri)?;
    let (actor, _) = verify_author(&state, &input.actor_token).await?;
    let mut tx = state.db.begin().await?;
    sqlx::query("select pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(format!("cells-link:{cell}:{app}"))
        .execute(&mut *tx)
        .await?;
    let target = apps::require_active(&mut tx, &app).await?;
    if target.is_first_party() {
        return Err(ApiError::forbidden(
            "first_party_delegation_forbidden",
            "Accounts and Developer cannot delegate their own identity privileges to a cell.",
        ));
    }
    let coauthor: bool = sqlx::query_scalar(
        "select exists(select 1 from app_authors where app_id=$1 and account_uuid=$2)",
    )
    .bind(&app)
    .bind(&actor)
    .fetch_one(&mut *tx)
    .await?;
    if target.owner_uuid.as_deref() != Some(&actor) && !coauthor {
        return Err(ApiError::forbidden(
            "app_author_required",
            "Linking a cell requires an accepted author of this app.",
        ));
    }
    // The cell UUID is globally assigned by the Cells service. The app author
    // cannot silently replace a live cell's callback with an unrelated address.
    if let Some(existing)=sqlx::query_scalar::<_,String>("select callback_uri from cells_app_links where cell_uuid=$1 and app_id=$2 and revoked_at is null for update").bind(cell).bind(&app).fetch_optional(&mut *tx).await? && existing!=input.callback_uri {
        return Err(ApiError::conflict("cell_callback_conflict","Unlink the previous callback before replacing this cell's callback."));
    }
    let redirects = apps::signin_row(&mut tx, &app)
        .await?
        .map(|row| accounts_core::models::SigninConfig::from_stored(&row.config))
        .unwrap_or_default()
        .effective(&state.settings, &app)
        .redirect_uris;
    sqlx::query("insert into cells_app_links(cell_uuid,app_id,callback_uri,linked_by) values($1,$2,$3,$4) on conflict(cell_uuid,app_id) do update set callback_uri=excluded.callback_uri,linked_by=excluded.linked_by,revoked_at=null")
        .bind(cell).bind(&app).bind(&input.callback_uri).bind(&actor).execute(&mut *tx).await?;
    audit::record(&mut tx,&audit::AuditEntry{app_id:Some(&app),details:json!({"cell_uuid":cell,"callback_uri":input.callback_uri,"idempotency_key":key.as_str()}),..audit::AuditEntry::new(ActorKind::Account,Some(&actor),"cell.linked")}).await?;
    tx.commit().await?;
    Ok(super::respond::no_store(
        StatusCode::OK,
        &json!({"cell_uuid":cell,"app_id":app,"callback_uri":input.callback_uri,"redirect_uris":redirects.into_iter().filter(|v|v!=&input.callback_uri).collect::<Vec<_>>()}),
    ))
}
async fn unlink(
    State(state): State<AppState>,
    auth: AppAuth,
    Path((cell, app)): Path<(Uuid, String)>,
) -> ApiResult<Response> {
    service(&auth)?;
    let mut tx = state.db.begin().await?;
    sqlx::query("update cells_app_links set revoked_at=now() where cell_uuid=$1 and app_id=$2 and revoked_at is null").bind(cell).bind(&app).execute(&mut *tx).await?;
    let families: Vec<Uuid> = sqlx::query_scalar(
        "select family_id from cells_token_families where cell_uuid=$1 and app_id=$2",
    )
    .bind(cell)
    .bind(&app)
    .fetch_all(&mut *tx)
    .await?;
    for family in families {
        if let Some(family) = tokens::revoke_family(&mut tx, family, "cell_unlinked").await? {
            accounts_core::events::membership_signed_out(
                &mut tx,
                &app,
                &family.account_uuid,
                "cell_unlinked",
            )
            .await?;
        }
    }
    audit::record(
        &mut tx,
        &audit::AuditEntry {
            app_id: Some(&app),
            details: json!({"cell_uuid":cell}),
            ..audit::AuditEntry::new(ActorKind::App, Some(CELLS), "cell.unlinked")
        },
    )
    .await?;
    tx.commit().await?;
    Ok(super::respond::no_store(
        StatusCode::OK,
        &json!({"unlinked":true}),
    ))
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Exchange {
    grant_type: String,
    code: Option<String>,
    redirect_uri: Option<String>,
    code_verifier: Option<String>,
    slt: Option<String>,
    refresh_token: Option<String>,
}
async fn exchange(
    State(state): State<AppState>,
    auth: AppAuth,
    Path((cell, app)): Path<(Uuid, String)>,
    meta: ClientMeta,
    key: IdempotencyKey,
    Json(input): Json<Exchange>,
) -> ApiResult<Response> {
    service(&auth)?;
    let scope = format!("cells:{cell}:{app}:token");
    // Seal token responses and replay uncertain network responses without consuming
    // a single-use code/SLT twice or accidentally reusing a rotating refresh token.
    let mut response = idempotency::run(&state,Some(key.as_str()),&scope,&input,true,||async {
        let mut tx=state.db.begin().await?;
        let callback:Option<String>=sqlx::query_scalar("select callback_uri from cells_app_links where cell_uuid=$1 and app_id=$2 and revoked_at is null for share").bind(cell).bind(&app).fetch_optional(&mut *tx).await?;
        let callback=callback.ok_or_else(||ApiError::forbidden("cell_app_not_linked","This app has no active delegation to this cell."))?;
        let target=apps::require_active(&mut tx,&app).await?;
        let params=TokenParams{grant_type:Some(input.grant_type.clone()),code:input.code.clone(),redirect_uri:input.redirect_uri.clone(),code_verifier:input.code_verifier.clone(),slt:input.slt.clone(),refresh_token:input.refresh_token.clone(),..Default::default()};
        let tokens=match input.grant_type.as_str(){
            "authorization_code"=>{
                if input.redirect_uri.as_deref()!=Some(&callback){return Err(ApiError::invalid_request("The authorization code must return to this cell's registered callback."));}
                // Public=true enforces S256 PKCE even though the Cells service has
                // authenticated. It cannot exchange another backend's stolen code.
                grants::code::exchange(&state,&ClientAuth{app:target,public:true},&params,&meta).await.map_err(oauth)?
            },
            "slt"|super::token::SLT_GRANT_TYPE=>grants::slt::exchange(&state,&ClientAuth{app:target,public:false},&params,&meta).await.map_err(oauth)?,
            "refresh_token"=>{
                let token=input.refresh_token.as_deref().ok_or_else(||ApiError::invalid_request("refresh_token is required."))?;
                let family=super::credentials::refresh_token_info(&mut tx,&state.keys.pepper,token).await?.map(|v|v.family_id);
                bound(&mut tx,cell,&app,family).await?;
                grants::refresh::exchange(&state,&ClientAuth{app:target,public:false},&params,&meta).await.map_err(oauth)?
            },
            _=>return Err(ApiError::invalid_request("Cells delegation supports authorization_code with S256 PKCE, slt, and refresh_token.")),
        };
        let family=state.keys.jwt.verify_access(&tokens.access_token,Some(&app)).map_err(|_|ApiError::internal("Issued token could not be verified."))?.family_id().ok_or_else(||ApiError::internal("Issued token has no family."))?;
        sqlx::query("insert into cells_token_families(family_id,cell_uuid,app_id) values($1,$2,$3) on conflict(family_id) do nothing").bind(family).bind(cell).bind(&app).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok((StatusCode::OK,serde_json::to_value(tokens).map_err(|_|ApiError::internal("Could not encode token response."))?))
    }).await?;
    response.headers_mut().insert(
        "cache-control",
        axum::http::HeaderValue::from_static("no-store"),
    );
    response
        .headers_mut()
        .insert("pragma", axum::http::HeaderValue::from_static("no-cache"));
    Ok(response)
}
async fn bound(
    conn: &mut sqlx::PgConnection,
    cell: Uuid,
    app: &str,
    family: Option<Uuid>,
) -> ApiResult<Uuid> {
    let family = family.ok_or_else(|| {
        ApiError::unauthenticated(
            "cell_session_required",
            "The token is not a session issued through this cell.",
        )
    })?;
    let allowed:bool=sqlx::query_scalar("select exists(select 1 from cells_token_families f join cells_app_links l using(cell_uuid,app_id) where f.family_id=$1 and f.cell_uuid=$2 and f.app_id=$3 and l.revoked_at is null)").bind(family).bind(cell).bind(app).fetch_one(conn).await?;
    if !allowed {
        return Err(ApiError::unauthenticated(
            "cell_session_required",
            "The session was issued through a different cell or its app was unlinked.",
        ));
    }
    Ok(family)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Presented {
    token: String,
}
async fn introspect(
    State(state): State<AppState>,
    auth: AppAuth,
    Path((cell, app)): Path<(Uuid, String)>,
    Json(input): Json<Presented>,
) -> ApiResult<Response> {
    service(&auth)?;
    let mut conn = state.db.acquire().await?;
    let target = apps::require_active(&mut conn, &app).await?;
    let family = state
        .keys
        .jwt
        .verify_access(&input.token, Some(&app))
        .ok()
        .and_then(|c| c.family_id());
    if bound(&mut conn, cell, &app, family).await.is_err() {
        return Ok(super::respond::no_store(
            StatusCode::OK,
            &json!({"active":false}),
        ));
    }
    let active = super::introspect::access_token(&mut conn, &state, &target, &input.token)
        .await
        .map_err(oauth)?;
    drop(conn);
    let result = if let Some(mut result) = active {
        result["account"] = super::userinfo::userinfo(&state, &input.token).await?;
        result
    } else {
        json!({"active":false})
    };
    Ok(super::respond::no_store(StatusCode::OK, &result))
}
async fn revoke(
    State(state): State<AppState>,
    auth: AppAuth,
    Path((cell, app)): Path<(Uuid, String)>,
    Json(input): Json<Presented>,
) -> ApiResult<Response> {
    service(&auth)?;
    let mut tx = state.db.begin().await?;
    let family = if input
        .token
        .starts_with(accounts_core::crypto::prefix::REFRESH)
    {
        super::credentials::refresh_token_info(&mut tx, &state.keys.pepper, &input.token)
            .await?
            .map(|f| f.family_id)
    } else {
        state
            .keys
            .jwt
            .verify_access_ignoring_expiry(&input.token)
            .ok()
            .filter(|c| c.aud == app)
            .and_then(|c| c.family_id())
    };
    if let Ok(family) = bound(&mut tx, cell, &app, family).await
        && let Some(family) = tokens::revoke_family(&mut tx, family, "cell_sign_out").await?
    {
        accounts_core::events::membership_signed_out(
            &mut tx,
            &app,
            &family.account_uuid,
            "cell_sign_out",
        )
        .await?;
    }
    tx.commit().await?;
    Ok(super::respond::no_store(
        StatusCode::OK,
        &json!({"revoked":true}),
    ))
}
