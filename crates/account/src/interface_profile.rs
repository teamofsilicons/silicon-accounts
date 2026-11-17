//! Profile access delegated to an interface. Every response is an app-scoped
//! view. The first-party account extractor and credential routes stay private.
use accounts_core::{
    ApiError, ApiResult, AppState, PROFILE_APP_ID,
    http::{ClientMeta, IdempotencyKey, Json},
    models::{Account, Scope},
    photo_upload,
    repo::{idempotency, organizations, tokens},
    views,
};
use axum::{
    Router,
    body::Body,
    extract::{FromRequestParts, State},
    http::{HeaderMap, StatusCode, header, request::Parts},
    response::Response,
    routing::{get, post},
};
use serde_json::{Value, json};
use sqlx::PgConnection;
use uuid::Uuid;

use crate::{photos, profile};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/interface-accounts/me", get(read).patch(update))
        .route("/v1/interface-accounts/me/id", post(change_id))
        .route("/v1/interface-accounts/me/photo", post(upload))
}

struct Grant {
    account: Account,
    family: Uuid,
    scopes: Vec<Scope>,
}

impl FromRequestParts<AppState> for Grant {
    type Rejection = ApiError;
    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> ApiResult<Self> {
        let token = parts
            .headers
            .get(header::AUTHORIZATION)
            .and_then(|h| h.to_str().ok())
            .and_then(|h| h.strip_prefix("Bearer "))
            .ok_or_else(|| {
                ApiError::unauthenticated(
                    "access_token_required",
                    "Send the access token for the account management app.",
                )
            })?;
        let mut conn = state.db.acquire().await?;
        let v = tokens::verify_access_token(&mut conn, &state.keys, token, Some(PROFILE_APP_ID))
            .await?;
        let granted: Option<Vec<String>> = sqlx::query_scalar(
            "select m.granted_scopes from interface_app_token_families f
             join interface_sessions s on s.id=f.session_id
             join interface_auth_clients c on c.interface_id=s.interface_id
             join memberships m on m.account_uuid=s.account_uuid and m.app_id=f.app_id
             join apps a on a.app_id=m.app_id
             where f.family_id=$1 and f.app_id=$2 and s.account_uuid=$3 and m.status='active'
             and a.status='active' and c.active and s.revoked_at is null and s.expires_at>now()
             and f.app_id=any(s.approved_apps) and f.app_id=any(c.app_ids)",
        )
        .bind(v.family.id)
        .bind(PROFILE_APP_ID)
        .bind(&v.account.uuid)
        .fetch_optional(&mut *conn)
        .await?;
        let granted = granted.filter(|_| v.account.is_active()).ok_or_else(|| {
            ApiError::forbidden(
                "interface_grant_required",
                "Authorize the account management app in this interface.",
            )
        })?;
        organizations::check(&mut conn, &v.account.uuid, PROFILE_APP_ID).await?;
        let scopes = v
            .claims
            .scopes()
            .into_iter()
            .filter(|s| {
                granted.iter().any(|g| g == s.as_str())
                    && v.family.scopes.iter().any(|g| g == s.as_str())
            })
            .collect();
        Ok(Self {
            account: v.account,
            family: v.family.id,
            scopes,
        })
    }
}

impl Grant {
    fn require(&self, scope: Scope) -> ApiResult<()> {
        if self.scopes.contains(&scope) {
            return Ok(());
        }
        Err(ApiError::forbidden(
            "insufficient_scope",
            format!("This operation requires {}.", scope.as_str()),
        ))
    }
    async fn view(&self, conn: &mut PgConnection, account: &Account) -> ApiResult<Value> {
        Ok(serde_json::to_value(
            views::load_account_for_app(conn, account, PROFILE_APP_ID, &self.scopes).await?,
        )?)
    }
    fn operation(&self, name: &str) -> String {
        format!("interface-profile:{}:{name}", self.family)
    }
}

async fn read(State(state): State<AppState>, grant: Grant) -> ApiResult<Json<Value>> {
    Ok(Json(
        grant
            .view(&mut *state.db.acquire().await?, &grant.account)
            .await?,
    ))
}

async fn update(
    State(state): State<AppState>,
    grant: Grant,
    meta: ClientMeta,
    key: IdempotencyKey,
    Json(body): Json<Value>,
) -> ApiResult<Response> {
    grant.require(Scope::ProfileWrite)?;
    for (field, scope) in [("dob", Scope::Dob), ("timezone", Scope::Timezone)] {
        if body.get(field).is_some() {
            grant.require(scope)?;
        }
    }
    idempotency::run(
        &state,
        Some(key.as_str()),
        &grant.operation("patch"),
        &body,
        false,
        || async {
            let mut tx = state.db.begin().await?;
            profile::apply_patch(&mut tx, &state, &grant.account, &body, &meta).await?;
            tx.commit().await?;
            Ok((StatusCode::NO_CONTENT, Value::Null))
        },
    )
    .await
}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct Id {
    id: String,
}

async fn change_id(
    State(state): State<AppState>,
    grant: Grant,
    meta: ClientMeta,
    key: IdempotencyKey,
    Json(body): Json<Id>,
) -> ApiResult<Response> {
    grant.require(Scope::ProfileWrite)?;
    idempotency::run(
        &state,
        Some(key.as_str()),
        &grant.operation("id"),
        &body,
        false,
        || async {
            let mut tx = state.db.begin().await?;
            profile::apply_id(&mut tx, &grant.account, &body.id, &meta).await?;
            tx.commit().await?;
            Ok((StatusCode::NO_CONTENT, Value::Null))
        },
    )
    .await
}

async fn upload(
    State(state): State<AppState>,
    grant: Grant,
    meta: ClientMeta,
    key: IdempotencyKey,
    headers: HeaderMap,
    body: Body,
) -> ApiResult<Response> {
    grant.require(Scope::ProfileWrite)?;
    let upload = photo_upload::read(&headers, body, "/v1/interface-accounts/me/photo").await?;
    idempotency::run(
        &state,
        Some(key.as_str()),
        &grant.operation("photo"),
        &upload.fingerprint(),
        false,
        || async {
            photo_upload::count_account_upload(&state.db, &grant.account.uuid).await?;
            let mut tx = state.db.begin().await?;
            let (account, _) =
                photos::apply_upload(&mut tx, &state, &grant.account.uuid, &upload, &meta).await?;
            tx.commit().await?;
            Ok((StatusCode::CREATED, json!({"pfp_url":account.pfp_url})))
        },
    )
    .await
}
