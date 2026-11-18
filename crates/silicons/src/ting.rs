//! Explicit Ting enrollment and capability-bound pending-request session rebinding.
use accounts_core::http::{AccountAuth, AuthVia, Json, Path};
use accounts_core::models::AccountKind;
use accounts_core::{ApiError, AppState, FIRST_PARTY_APP_ID, ting};
use accounts_proofs::{
    input::IssueUserVerificationBody,
    issue::{self, Issuer},
};
use axum::{extract::State, http::HeaderMap};
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

pub async fn retired() -> ApiError {
    ting::retired()
}

pub async fn enable(
    State(state): State<AppState>,
    auth: AccountAuth,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    if auth.kind() != AccountKind::Silicon {
        return Err(ApiError::forbidden(
            "silicon_required",
            "Enable these notifications while signed in as the Silicon.",
        ));
    }
    if !matches!(auth.via, AuthVia::Bearer { .. }) {
        return Err(ApiError::unprocessable(
            "silicon_cli_required",
            "Use silicon-accounts notifications enable from the Silicon's signed-in CLI profile.",
        ));
    }
    let token = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().split_once(' '))
        .filter(|(scheme, _)| scheme.eq_ignore_ascii_case("bearer"))
        .map(|(_, token)| token.trim())
        .filter(|token| !token.is_empty())
        .ok_or_else(|| {
            ApiError::unauthenticated("invalid_token", "A Silicon access token is required.")
        })?;
    let mut conn = state.db.acquire().await?;
    let app = accounts_core::repo::apps::get(&mut conn, FIRST_PARTY_APP_ID)
        .await?
        .ok_or_else(|| ApiError::internal("Accounts app missing"))?;
    drop(conn);
    let proof = issue::user_verification(
        &state,
        &Issuer::app(&app, None),
        &IssueUserVerificationBody {
            subject_token: token.into(),
            receiving_app: "ting".into(),
            scopes: Some(vec!["subscriptions.register".into()]),
            access_ttl_seconds: Some(300),
        },
    )
    .await?;
    sqlx::query("update proof_families set expires_at=$2 where id=$1")
        .bind(proof.proof_id)
        .bind(proof.expires_at)
        .execute(&state.db)
        .await?;
    let response = state
        .http
        .post(format!(
            "{}/v1/subscriptions",
            state.settings.ting_url.trim_end_matches('/')
        ))
        .bearer_auth(&proof.proof_token)
        .json(&json!({"app_id":FIRST_PARTY_APP_ID,"for":auth.uuid()}))
        .send()
        .await
        .map_err(|_| {
            ApiError::unavailable(
                "ting_unavailable",
                "Ting could not be reached. Retry notifications enable.",
            )
        })?;
    let status = response.status();
    let body: Value = response.json().await.unwrap_or(Value::Null);
    if !status.is_success()
        || body.get("id").and_then(Value::as_str).is_none()
        || body["app_id"] != FIRST_PARTY_APP_ID
        || body["for"] != auth.uuid()
        || body["active"] != true
    {
        return Err(ApiError::unavailable(
            "ting_enrollment_failed",
            format!(
                "Ting did not confirm registration (HTTP {}). Retry notifications enable.",
                status.as_u16()
            ),
        ));
    }
    sqlx::query("update silicon_tings set next_attempt_at=now() where account_uuid=$1 and status='pending' and session_id is null")
        .bind(auth.uuid()).execute(&state.db).await?;
    Ok(Json(
        json!({"enabled":true,"channel":"ting","app_id":FIRST_PARTY_APP_ID,"subscription_id":body["id"],"account_uuid":auth.uuid()}),
    ))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionBody {
    pub session_id: String,
}

/// The request token authorizes rebinding only this one request's minimal wake-up hints.
pub async fn bind_request(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(raw): Path<String>,
    Json(body): Json<SessionBody>,
) -> Result<Json<Value>, ApiError> {
    ting::validate_session(&body.session_id)?;
    let token = super::self_create::request_token(&headers)?;
    let not_found = || {
        ApiError::not_found(
            "custodian_request_not_found",
            "No request matches this token.",
        )
    };
    let id = super::common::parse_request_id(&raw).ok_or_else(not_found)?;
    let mut tx = state.db.begin().await?;
    let request = super::requests::lock(&mut tx, id)
        .await?
        .ok_or_else(not_found)?;
    if !request.is_initial()
        || !request
            .request_token_hash
            .as_deref()
            .is_some_and(|hash| state.keys.pepper.verify(&token, hash))
    {
        return Err(not_found());
    }
    // Polling remains authoritative even if the decision happened during reconnect.
    // Retrying the same binding is idempotent; a new socket gets a fresh generation.
    let previous: Option<String> =
        sqlx::query_scalar("select session_id from silicon_ting_requests where request_id=$1")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?;
    if previous.as_deref() != Some(&body.session_id) {
        accounts_core::repo::rate_limit::enforce(
            &mut tx,
            &format!("ting_request_session:{id}"),
            accounts_core::repo::rate_limit::Limit::new(60, 3600),
            "Ting session changes for this request",
        )
        .await?;
        sqlx::query("insert into silicon_ting_requests(request_id,session_id,generation) values($1,$2,$3) on conflict(request_id) do update set session_id=excluded.session_id,generation=excluded.generation,updated_at=now()")
            .bind(id).bind(&body.session_id).bind(Uuid::new_v4()).execute(&mut *tx).await?;
        sqlx::query("update silicon_tings set status='cancelled',last_error='session_replaced' where request_id=$1 and status='pending'")
            .bind(id).execute(&mut *tx).await?;
        ting::enqueue_request(&mut tx, id).await?;
    }
    tx.commit().await?;
    Ok(Json(
        json!({"request_id":id,"session_id":body.session_id,"channel":"ting"}),
    ))
}
