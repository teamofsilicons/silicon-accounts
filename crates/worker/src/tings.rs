//! Accounts outbox -> Ting. Stable keys, bounded claims and fenced completion make retries safe.
use crate::{
    Shutdown,
    pipeline::{self, Pipeline},
};
use accounts_core::{ApiError, ApiResult, AppState, FIRST_PARTY_APP_ID, ting};
use accounts_proofs::{
    input::IssueAppVerificationBody,
    issue::{self, Issuer},
};
use serde_json::{Value, json};
use std::time::Duration;
use uuid::Uuid;

#[derive(Clone, Debug, sqlx::FromRow)]
pub struct Delivery {
    pub id: Uuid,
    pub payload: Value,
    pub lease_id: Uuid,
    pub session_id: Option<String>,
    pub retry_deadline: Option<time::OffsetDateTime>,
}

async fn proof(state: &AppState, scope: &str) -> ApiResult<String> {
    let mut conn = state.db.acquire().await?;
    let app = accounts_core::repo::apps::get(&mut conn, FIRST_PARTY_APP_ID)
        .await?
        .ok_or_else(|| ApiError::internal("Accounts app missing"))?;
    drop(conn);
    let result = issue::app_verification(
        state,
        &Issuer::app(&app, None),
        &IssueAppVerificationBody {
            receiving_app: Some("ting".into()),
            audiences: None,
            scopes: Some(vec![scope.into()]),
            access_ttl_seconds: Some(300),
        },
        "internal Ting delivery",
    )
    .await?;
    // This worker never refreshes proofs. Keep their authority as short as the send attempt.
    sqlx::query("update proof_families set expires_at=$2 where id=$1")
        .bind(result.proof_id)
        .bind(result.expires_at)
        .execute(&state.db)
        .await?;
    Ok(result.proof_token)
}

pub async fn ensure_catalog(state: &AppState) -> ApiResult<()> {
    let token = proof(state, "types.manage").await?;
    let account_schema = json!({
        "type": "object",
        "required": ["event_id", "type", "occurred_at", "silicon", "data"],
        "properties": {
            "event_id": {"type": "string"}, "type": {"type": "string"},
            "occurred_at": {"type": "string"}, "silicon": {"type": "string"},
            "data": {"type": "object"}
        }
    });
    let mut definitions: Vec<(String, &str, Value)> = ting::TYPES
        .iter()
        .map(|(_, name, description)| {
            (
                format!("{}.{name}", ting::APP),
                *description,
                account_schema.clone(),
            )
        })
        .collect();
    definitions.push((
        ting::REQUEST_TYPE.into(),
        "A pending custodian request changed; fetch it with its request token.",
        json!({"type":"object", "required":["request_id"], "additionalProperties":false,
            "properties":{"request_id":{"type":"string"}}}),
    ));
    for (kind, description, schema) in definitions {
        let response = state
            .http
            .post(format!(
                "{}/v1/apps/{}/types",
                state.settings.ting_url.trim_end_matches('/'),
                ting::APP
            ))
            .bearer_auth(&token)
            .json(&json!({"type":kind,"description":description,"schema":schema}))
            .send()
            .await
            .map_err(|_| {
                ApiError::unavailable("ting_unavailable", "Ting catalog is unavailable.")
            })?;
        let status = response.status();
        if !status.is_success() {
            // Identical catalog registrations return 200. Conflicting definitions must
            // hold the queue for an operator, never send against an incompatible schema.
            return Err(ApiError::unavailable(
                "ting_catalog_pending",
                format!("Ting type registration returned HTTP {}.", status.as_u16()),
            ));
        }
    }
    Ok(())
}

pub async fn claim(state: &AppState, limit: usize) -> ApiResult<Vec<Delivery>> {
    // Removed request bindings never become account-wide deliveries. Terminal account states
    // cannot receive personal data. Waiting for activation/subscription does not discard it.
    sqlx::query("update silicon_tings t set status='cancelled',last_error='destination_ended' where t.status='pending' and (t.lease_until is null or t.lease_until<now()) and ((t.session_id is not null and not exists(select 1 from silicon_ting_requests r where r.request_id=t.request_id and r.generation=t.generation and r.session_id=t.session_id)) or (t.session_id is null and exists(select 1 from accounts a where a.uuid=t.account_uuid and a.status not in ('active','pending_custodian'))))")
        .execute(&state.db).await?;
    // Ting retains idempotency keys for 14 days. Never retry an ambiguous accepted send
    // beyond that window; preserve it for operator reconciliation instead of duplicating it.
    sqlx::query("update silicon_tings set status='failed',last_error='ting_retry_window_ended' where status='pending' and retry_deadline<=now() and (lease_until is null or lease_until<now())")
        .execute(&state.db).await?;
    let lease = Uuid::new_v4();
    Ok(sqlx::query_as("with due as (select t.id from silicon_tings t join accounts a on a.uuid=t.account_uuid where t.status='pending' and t.next_attempt_at<=now() and (t.lease_until is null or t.lease_until<now()) and (t.session_id is not null or a.status='active') order by t.next_attempt_at,t.id for update of t skip locked limit $1) update silicon_tings t set lease_id=$2,lease_until=now()+interval '60 seconds',attempts=attempts+1 from due where t.id=due.id returning t.id,t.payload,t.lease_id,t.session_id,t.retry_deadline")
        .bind(limit as i64).bind(lease).fetch_all(&state.db).await?)
}

pub async fn deliver(state: &AppState, row: &Delivery) -> ApiResult<()> {
    // Recheck the binding immediately before sending. A changed connection never inherits
    // the old session's queued payload or key. A concurrent old send contains only a hint.
    let current:bool=sqlx::query_scalar("select exists(select 1 from silicon_tings t where t.id=$1 and t.lease_id=$2 and t.status='pending' and (t.session_id is not null or exists(select 1 from accounts a where a.uuid=t.account_uuid and a.status='active')) and (t.session_id is null or exists(select 1 from silicon_ting_requests r where r.request_id=t.request_id and r.generation=t.generation and r.session_id=t.session_id)))")
        .bind(row.id).bind(row.lease_id).fetch_one(&state.db).await?;
    if !current {
        return Ok(());
    }
    let token = proof(state, "tings.send").await?;
    // Persist before the HTTP call: a crash after acceptance must have the same bound.
    let armed = sqlx::query("update silicon_tings set retry_deadline=coalesce(retry_deadline,now()+interval '13 days') where id=$1 and lease_id=$2 and status='pending' and (retry_deadline is null or retry_deadline>now())")
        .bind(row.id).bind(row.lease_id).execute(&state.db).await?.rows_affected();
    if armed == 0 {
        return Ok(());
    }
    let mut definitive_rejection = false;
    let response = state
        .http
        .post(format!(
            "{}/v1/tings",
            state.settings.ting_url.trim_end_matches('/')
        ))
        .bearer_auth(token)
        .json(&row.payload)
        .send()
        .await;
    let (status, error) = match response {
        Ok(r) => {
            let http = r.status();
            let body: Value = r.json().await.unwrap_or(Value::Null);
            if http.is_success()
                && body.get("id").and_then(Value::as_str).is_some()
                && body.get("key") == row.payload.get("key")
                && matches!(
                    body.get("status").and_then(Value::as_str),
                    Some("accepted" | "blocked")
                )
            {
                ("accepted", None)
            } else {
                let code = body
                    .pointer("/error/code")
                    .or_else(|| body.get("code"))
                    .and_then(Value::as_str)
                    .unwrap_or("ting_invalid_response");
                definitive_rejection = http.is_client_error()
                    && body
                        .pointer("/error/code")
                        .or_else(|| body.get("code"))
                        .and_then(Value::as_str)
                        .is_some();
                // Only explicit dead-session errors are terminal; never reinterpret a timeout
                // or permission failure as permission to broadcast to the account.
                let terminal = row.session_id.is_some()
                    && matches!(
                        code,
                        "session_gone"
                            | "receiver_gone"
                            | "session_not_found"
                            | "receiver_not_found"
                            | "session_unavailable"
                            | "session_mismatch"
                            | "session_not_active"
                    );
                (
                    if terminal { "cancelled" } else { "pending" },
                    Some(code.to_string()),
                )
            }
        }
        Err(_) => ("pending", Some("ting_unavailable".into())),
    };
    sqlx::query("update silicon_tings set status=$3,last_error=$4,retry_deadline=case when $5 then null else retry_deadline end,accepted_at=case when $3='accepted' then now() else null end,next_attempt_at=now()+make_interval(secs=>least(3600,10*power(2,least(attempts,8)))::double precision),lease_id=null,lease_until=null where id=$1 and lease_id=$2 and status='pending'")
        .bind(row.id).bind(row.lease_id).bind(status).bind(error).bind(definitive_rejection && row.retry_deadline.is_none()).execute(&state.db).await?;
    Ok(())
}

pub async fn run(state: AppState, mut shutdown: Shutdown) {
    loop {
        let catalog = tokio::select! {
            biased;
            _ = shutdown.triggered() => return,
            result = ensure_catalog(&state) => result,
        };
        match catalog {
            Ok(()) => break,
            Err(e) => {
                tracing::warn!(code=%e.code,"Ting catalog unavailable; account notifications remain queued")
            }
        }
        if !shutdown.sleep(Duration::from_secs(30)).await {
            return;
        }
    }
    let claiming = state.clone();
    Pipeline{name:"tings",concurrency:4,idle_poll:Duration::from_secs(2),error_backoff:Duration::from_secs(10)}.run(shutdown,
        move |n| {let state=claiming.clone();async move {claim(&state,n).await}},
        move |row,at| {let state=state.clone();async move {
            match tokio::time::timeout_at(pipeline::deadline(at),deliver(&state,&row)).await {
                Ok(Ok(()))=>{},_=>tracing::warn!(delivery_id=%row.id,"Ting attempt interrupted; its lease will expire"),
            }
        }}).await;
}
