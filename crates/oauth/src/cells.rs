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
        .route("/v1/internal/cells/apps/{app}", post(app_info))
        .route(
            "/v1/internal/cells/links/{cell}/{app}",
            put(link).delete(unlink),
        )
        .route(
            "/v1/internal/cells/links/{cell}/{app}/callback",
            put(update_callback),
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
async fn app_info(
    State(state): State<AppState>,
    auth: AppAuth,
    Path(app): Path<String>,
    Json(input): Json<AuthorToken>,
) -> ApiResult<Response> {
    service(&auth)?;
    let (actor, _) = verify_author(&state, &input.access_token).await?;
    let mut tx = state.db.begin().await?;
    let target = require_app_author(&mut tx, &app, &actor).await?;
    let authors:Vec<accounts_core::models::Account>=sqlx::query_as("select a.* from accounts a join app_authors au on au.account_uuid=a.uuid where au.app_id=$1 and a.status='active' order by au.joined_at,a.uuid").bind(&app).fetch_all(&mut *tx).await?;
    let mut authors = authors
        .iter()
        .map(accounts_core::views::AccountSummary::from_account)
        .collect::<Vec<_>>();
    // Legacy Apps records may have only owner_uuid, before author synchronization.
    if let Some(owner) = target.owner_uuid.as_deref()
        && !authors.iter().any(|a| a.uuid == owner)
        && let Some(owner) = accounts_core::repo::accounts::get(&mut tx, owner).await?
        && owner.status == AccountStatus::Active
    {
        authors.insert(
            0,
            accounts_core::views::AccountSummary::from_account(&owner),
        );
    }
    Ok(super::respond::no_store(
        StatusCode::OK,
        &json!({"app_id":target.app_id,"name":target.name,"authors":authors}),
    ))
}
async fn require_app_author(
    conn: &mut sqlx::PgConnection,
    app: &str,
    actor: &str,
) -> ApiResult<accounts_core::models::App> {
    let target = apps::require_active(conn, app).await?;
    if target.is_first_party() {
        return Err(ApiError::forbidden(
            "first_party_delegation_forbidden",
            "Accounts and Developer cannot delegate their own identity privileges to a cell.",
        ));
    }
    let coauthor: bool = sqlx::query_scalar(
        "select exists(select 1 from app_authors where app_id=$1 and account_uuid=$2)",
    )
    .bind(app)
    .bind(actor)
    .fetch_one(conn)
    .await?;
    if target.owner_uuid.as_deref() != Some(actor) && !coauthor {
        return Err(ApiError::forbidden(
            "app_author_required",
            "Linking a cell requires an accepted author of this app.",
        ));
    }
    Ok(target)
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
    require_app_author(&mut tx, &app, &actor).await?;
    // The cell UUID is globally assigned by the Cells service. The app author
    // cannot silently replace a live cell's callback with an unrelated address.
    if let Some(existing) = sqlx::query_scalar::<_, String>(
        "select callback_uri from cells_app_links where cell_uuid=$1 and app_id=$2 for update",
    )
    .bind(cell)
    .bind(&app)
    .fetch_optional(&mut *tx)
    .await?
        && existing != input.callback_uri
    {
        return Err(ApiError::conflict(
            "cell_callback_conflict",
            "The permanent callback of an existing cell delegation cannot be replaced.",
        ));
    }
    let redirects = apps::signin_row(&mut tx, &app)
        .await?
        .map(|row| accounts_core::models::SigninConfig::from_stored(&row.config))
        .unwrap_or_default()
        .effective(&state.settings, &app)
        .redirect_uris;
    sqlx::query("insert into cells_app_links(cell_uuid,app_id,callback_uri,linked_by) values($1,$2,$3,$4) on conflict(cell_uuid,app_id) do update set callback_uri=excluded.callback_uri,linked_by=excluded.linked_by,revoked_at=null")
        .bind(cell).bind(&app).bind(&input.callback_uri).bind(&actor).execute(&mut *tx).await?;
    let (_, generated_secret) = accounts_core::events::new_webhook_secret(&state.keys.keyring)?;
    let sealed: Vec<u8> = sqlx::query_scalar("update cells_app_links set webhook_secret_enc=coalesce(webhook_secret_enc,$3) where cell_uuid=$1 and app_id=$2 returning webhook_secret_enc")
        .bind(cell).bind(&app).bind(generated_secret).fetch_one(&mut *tx).await?;
    let webhook_secret = state.keys.keyring.decrypt_string(&sealed)?;
    audit::record(&mut tx,&audit::AuditEntry{app_id:Some(&app),details:json!({"cell_uuid":cell,"callback_uri":input.callback_uri,"idempotency_key":key.as_str()}),..audit::AuditEntry::new(ActorKind::Account,Some(&actor),"cell.linked")}).await?;
    tx.commit().await?;
    Ok(super::respond::no_store(
        StatusCode::OK,
        &json!({"cell_uuid":cell,"app_id":app,"callback_uri":input.callback_uri,"webhook_secret":webhook_secret,"redirect_uris":redirects.into_iter().filter(|v|v!=&input.callback_uri).collect::<Vec<_>>()}),
    ))
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct CallbackUpdate {
    base_callback_uri: String,
    custom_callback_uri: Option<String>,
    generation: i64,
}

/// Cells has already proved DNS ownership and TLS readiness. This bridge can
/// update only an existing delegation, never create authority over another app.
async fn update_callback(
    State(state): State<AppState>,
    auth: AppAuth,
    Path((cell, app)): Path<(Uuid, String)>,
    key: IdempotencyKey,
    Json(input): Json<CallbackUpdate>,
) -> ApiResult<Response> {
    service(&auth)?;
    callback(&input.base_callback_uri)?;
    if input.generation < 1 {
        return Err(ApiError::invalid_request(
            "generation must be a positive integer.",
        ));
    }
    if let Some(custom) = &input.custom_callback_uri {
        callback(custom)?;
        let url = url::Url::parse(custom)
            .map_err(|_| ApiError::invalid_request("The custom callback URL is invalid."))?;
        if url.scheme() != "https" || custom == &input.base_callback_uri {
            return Err(ApiError::invalid_request(
                "A custom callback must use HTTPS and differ from the permanent callback.",
            ));
        }
    }
    let mut tx = state.db.begin().await?;
    sqlx::query("select pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(format!("cells-link:{cell}:{app}"))
        .execute(&mut *tx)
        .await?;
    let link: Option<(String, Option<String>, i64, bool)> = sqlx::query_as(
        "select callback_uri,custom_callback_uri,callback_generation,callback_suspended from cells_app_links where cell_uuid=$1 and app_id=$2 and revoked_at is null for update",
    ).bind(cell).bind(&app).fetch_optional(&mut *tx).await?;
    let (base, current, generation, suspended) = link.ok_or_else(|| {
        ApiError::forbidden(
            "cell_app_not_linked",
            "This app has no active delegation to this cell.",
        )
    })?;
    let request_hash = idempotency::request_hash(&input);
    let prior: Option<Vec<u8>> = sqlx::query_scalar(
        "select request_hash from cells_callback_commands where cell_uuid=$1 and app_id=$2 and key=$3",
    ).bind(cell).bind(&app).bind(key.as_str()).fetch_optional(&mut *tx).await?;
    if prior.as_ref().is_some_and(|hash| hash != &request_hash) {
        return Err(ApiError::conflict(
            "idempotency_key_reused",
            "This callback command key already names a different request.",
        ));
    }
    if base != input.base_callback_uri {
        return Err(ApiError::conflict(
            "cell_callback_conflict",
            "The permanent callback does not match this delegation.",
        ));
    }
    if input.generation < generation
        || input.generation == generation && input.custom_callback_uri != current
    {
        return Err(ApiError::conflict(
            "cell_callback_generation_conflict",
            "This callback update was superseded by a newer domain generation.",
        ));
    }
    // Removal still succeeds for a disabled app; adding a callback may not grant
    // fresh sign-in authority to a disabled or first-party app.
    if input.custom_callback_uri.is_some() {
        let target = apps::require_active(&mut tx, &app).await?;
        if target.is_first_party() {
            return Err(ApiError::forbidden(
                "first_party_delegation_forbidden",
                "First-party identity privileges cannot be delegated to a cell.",
            ));
        }
    }
    if input.generation > generation || suspended {
        sqlx::query("update cells_app_links set custom_callback_uri=$3,callback_generation=$4,callback_suspended=false where cell_uuid=$1 and app_id=$2")
            .bind(cell).bind(&app).bind(&input.custom_callback_uri).bind(input.generation)
            .execute(&mut *tx).await?;
        audit::record(&mut tx, &audit::AuditEntry {
            app_id: Some(&app),
            details: json!({"cell_uuid":cell,"generation":input.generation,"custom_callback_uri":input.custom_callback_uri,"idempotency_key":key.as_str()}),
            ..audit::AuditEntry::new(ActorKind::App, Some(CELLS), "cell.callback.updated")
        }).await?;
    }
    sqlx::query("insert into cells_callback_commands(cell_uuid,app_id,key,request_hash) values($1,$2,$3,$4) on conflict do nothing")
        .bind(cell).bind(&app).bind(key.as_str()).bind(request_hash).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(super::respond::no_store(
        StatusCode::OK,
        &json!({
            "cell_uuid":cell,"app_id":app,"callback_uri":base,
            "custom_callback_uri":input.custom_callback_uri,"generation":input.generation,
        }),
    ))
}

async fn unlink(
    State(state): State<AppState>,
    auth: AppAuth,
    Path((cell, app)): Path<(Uuid, String)>,
) -> ApiResult<Response> {
    service(&auth)?;
    let mut tx = state.db.begin().await?;
    sqlx::query("update cells_app_links set revoked_at=now(),callback_suspended=true where cell_uuid=$1 and app_id=$2 and revoked_at is null").bind(cell).bind(&app).execute(&mut *tx).await?;
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
    let mut admission = state.db.begin().await?;
    let callbacks: Option<(String, Option<String>)> = sqlx::query_as(
        "select callback_uri,case when callback_suspended then null else custom_callback_uri end from cells_app_links where cell_uuid=$1 and app_id=$2 and revoked_at is null for share",
    ).bind(cell).bind(&app).fetch_optional(&mut *admission).await?;
    let (base_callback, custom_callback) = callbacks.ok_or_else(|| {
        ApiError::forbidden(
            "cell_app_not_linked",
            "This app has no active delegation to this cell.",
        )
    })?;
    if input.grant_type == "authorization_code"
        && input.redirect_uri.as_deref() != Some(base_callback.as_str())
        && (custom_callback.is_none() || input.redirect_uri != custom_callback)
    {
        return Err(ApiError::invalid_request(
            "The authorization code must return to this cell's current registered callback.",
        ));
    }
    apps::require_active(&mut admission, &app).await?;
    let scope = format!("cells:{cell}:{app}:token");
    // Seal token responses and replay uncertain network responses without consuming
    // a single-use code/SLT twice or accidentally reusing a rotating refresh token.
    let mut response = idempotency::run(&state,Some(key.as_str()),&scope,&input,true,||async {
        let mut tx=state.db.begin().await?;
        let target=apps::require_active(&mut tx,&app).await?;
        let params=TokenParams{grant_type:Some(input.grant_type.clone()),code:input.code.clone(),redirect_uri:input.redirect_uri.clone(),code_verifier:input.code_verifier.clone(),slt:input.slt.clone(),refresh_token:input.refresh_token.clone(),..Default::default()};
        let tokens=match input.grant_type.as_str(){
            "authorization_code"=>{
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
    admission.commit().await?;
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
