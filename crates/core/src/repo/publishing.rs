//! Live organization authorization for Apps' projected publishing ownership.
use crate::{
    ApiError, ApiResult, AppState,
    http::{AccountAuth, AuthVia},
};
use axum::http::HeaderMap;
pub use silicon_publishing_policy::{Context, Permission, ResourceKind, ResourcePolicy};

pub async fn context(
    state: &AppState,
    auth: &AccountAuth,
    headers: &HeaderMap,
) -> ApiResult<Context> {
    let AuthVia::Bearer { claims, .. } = &auth.via else {
        return Err(ApiError::forbidden(
            "organization_session_required",
            "Use the developer portal or an Accounts access token to manage organization resources.",
        ));
    };
    let token = headers
        .get("authorization")
        .and_then(|h| h.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .ok_or_else(|| {
            ApiError::forbidden(
                "organization_session_required",
                "Use an access token to manage organization resources.",
            )
        })?;
    token_context(state, token, &claims.aud, auth.uuid()).await
}

pub async fn token_context(
    state: &AppState,
    token: &str,
    audience: &str,
    uuid: &str,
) -> ApiResult<Context> {
    silicon_publishing_policy::fetch(&state.settings.organizations_url, audience, token, uuid)
        .await
        .map_err(|e| ApiError::unavailable("organizations_unavailable", e))
}

/// None means a personal app, retaining its original owner/accepted-author rules.
pub async fn permitted(
    state: &AppState,
    auth: &AccountAuth,
    headers: &HeaderMap,
    app: &str,
    permission: Permission,
) -> ApiResult<Option<bool>> {
    let row: Option<(String, serde_json::Value)> = sqlx::query_as(
        "SELECT organization_id, access FROM app_organization_publishers WHERE app_id=$1",
    )
    .bind(app)
    .fetch_optional(&state.db)
    .await?;
    let Some((org, value)) = row else {
        return Ok(None);
    };
    let policy: ResourcePolicy = serde_json::from_value(value)
        .map_err(|_| ApiError::internal("Invalid organization resource policy."))?;
    Ok(Some(context(state, auth, headers).await?.allows(
        &org,
        ResourceKind::Apps,
        &policy,
        permission,
    )))
}

pub async fn manageable_apps(
    state: &AppState,
    auth: &AccountAuth,
    headers: &HeaderMap,
) -> ApiResult<Vec<String>> {
    let rows: Vec<(String, String, serde_json::Value)> =
        sqlx::query_as("SELECT app_id, organization_id, access FROM app_organization_publishers")
            .fetch_all(&state.db)
            .await?;
    if rows.is_empty() {
        return Ok(Vec::new());
    }
    let context = context(state, auth, headers).await?;
    let mut ids = Vec::new();
    for (id, org, value) in rows {
        let policy: ResourcePolicy = serde_json::from_value(value)
            .map_err(|_| ApiError::internal("Invalid organization resource policy."))?;
        if context.allows(&org, ResourceKind::Apps, &policy, Permission::Manage) {
            ids.push(id);
        }
    }
    Ok(ids)
}
