//! A manual review request, not account verification or authorization-domain provisioning.
//! One pending request per immutable account; request and both notifications commit together.

use accounts_core::delivery::{self, NewMessage};
use accounts_core::http::{AccountAuth, IdempotencyKey, Json, Path};
use accounts_core::models::{AccountStatus, ActorKind, App, MessageChannel};
use accounts_core::repo::{audit, contacts, idempotency};
use accounts_core::timefmt::{rfc3339_ms, rfc3339_ms_option};
use accounts_core::views::AppSummary;
use accounts_core::{ApiError, ApiResult, AppState, FieldErrors};
use axum::extract::State;
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::{Router, routing::get};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::PgConnection;
use time::OffsetDateTime;
use uuid::Uuid;

const RECIPIENTS: [&str; 2] = ["lords@teamofsilicons.com", "saket@teamofsilicons.com"];
const RESPONSE_HOURS: i64 = 48;

pub(crate) fn router() -> Router<AppState> {
    Router::new().route(
        "/v1/apps/{app_id}/account-verification-request",
        get(status).post(submit),
    )
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Input {
    reason: String,
}

#[derive(sqlx::FromRow)]
struct RequestRow {
    id: Uuid,
    account_uuid: String,
    context_app_id: String,
    reason: String,
    status: String,
    submitted_at: OffsetDateTime,
    response_expected_by: OffsetDateTime,
    reviewed_at: Option<OffsetDateTime>,
}

#[derive(Serialize)]
struct RequestView {
    request_id: Uuid,
    account_uuid: String,
    context_app: AppSummary,
    reason: String,
    status: String,
    #[serde(with = "rfc3339_ms")]
    submitted_at: OffsetDateTime,
    #[serde(with = "rfc3339_ms")]
    response_expected_by: OffsetDateTime,
    #[serde(with = "rfc3339_ms_option")]
    reviewed_at: Option<OffsetDateTime>,
}

async fn view(conn: &mut PgConnection, row: RequestRow) -> ApiResult<RequestView> {
    let app = accounts_core::repo::apps::get(conn, &row.context_app_id)
        .await?
        .ok_or_else(|| ApiError::internal("Verification request context app is missing."))?;
    Ok(RequestView {
        request_id: row.id,
        account_uuid: row.account_uuid,
        context_app: AppSummary::from(&app),
        reason: row.reason,
        status: row.status,
        submitted_at: row.submitted_at,
        response_expected_by: row.response_expected_by,
        reviewed_at: row.reviewed_at,
    })
}

async fn managed_app(conn: &mut PgConnection, who: &AccountAuth, app_id: &str) -> ApiResult<App> {
    if who.account.status != AccountStatus::Active {
        return Err(ApiError::forbidden(
            "account_not_active",
            "Only an active account can request manual verification.",
        ));
    }
    sqlx::query_as::<_, App>(concat!(
        "select ",
        accounts_core::app_columns!(),
        " from apps where app_id=$1 and (owner_uuid=$2 or exists(select 1 from app_authors aa \
         where aa.app_id=apps.app_id and aa.account_uuid=$2))"
    ))
    .bind(app_id)
    .bind(who.uuid())
    .fetch_optional(conn)
    .await?
    .ok_or_else(|| {
        ApiError::forbidden(
            "not_app_owner",
            "You must currently manage this app to view or submit an account verification request.",
        )
    })
}

fn no_store(mut response: Response) -> Response {
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("no-store"),
    );
    response
}

async fn status(
    State(state): State<AppState>,
    who: AccountAuth,
    Path(app_id): Path<String>,
) -> ApiResult<Response> {
    let mut conn = state.db.acquire().await?;
    managed_app(&mut conn, &who, &app_id).await?;
    let row=sqlx::query_as::<_,RequestRow>("select * from account_verification_requests where account_uuid=$1 order by submitted_at desc,id desc limit 1")
        .bind(who.uuid()).fetch_optional(&mut *conn).await?;
    let request = match row {
        Some(row) => Some(view(&mut conn, row).await?),
        None => None,
    };
    Ok(no_store(
        Json(json!({"request":request,"response_time_hours":RESPONSE_HOURS})).into_response(),
    ))
}

async fn submit(
    State(state): State<AppState>,
    who: AccountAuth,
    Path(app_id): Path<String>,
    key: Option<IdempotencyKey>,
    Json(input): Json<Input>,
) -> ApiResult<Response> {
    let reason = input.reason.trim();
    let mut errors = FieldErrors::new();
    if reason.is_empty() || reason.chars().count() > 5000 {
        errors.add(
            "reason",
            "Explain why you need account verification using 1–5,000 characters.",
        );
    }
    if reason.contains('\0') {
        errors.add("reason", "The reason must not contain a NUL character.");
    }
    errors.into_result()?;
    // Authorization precedes idempotency replay, so removing an author also denies retries.
    let mut conn = state.db.acquire().await?;
    managed_app(&mut conn, &who, &app_id).await?;
    drop(conn);
    let scope = idempotency::scope(
        &format!("account:{}", who.uuid()),
        "POST",
        &format!("/v1/apps/{app_id}/account-verification-request"),
    );
    let response=idempotency::run(&state,key.as_deref(),&scope,&input,false,||async {
        let mut tx=state.db.begin().await?;
        // Serializes requests across ALL managed apps for this account; unique index is the
        // durable backstop. A duplicate request never queues additional notification rows.
        let current_status: AccountStatus=sqlx::query_scalar("select status from accounts where uuid=$1 for update")
            .bind(who.uuid()).fetch_one(&mut *tx).await?;
        if current_status != AccountStatus::Active {
            return Err(ApiError::forbidden("account_not_active", "Only an active account can request manual verification."));
        }
        let app=managed_app(&mut tx,&who,&app_id).await?;
        let pending=sqlx::query_as::<_,RequestRow>("select * from account_verification_requests where account_uuid=$1 and status='pending'")
            .bind(who.uuid()).fetch_optional(&mut *tx).await?;
        if let Some(row)=pending {
            let request=view(&mut tx,row).await?;
            tx.commit().await?;
            return Ok((StatusCode::OK,json!({"request":request,"created":false,"response_time_hours":RESPONSE_HOURS})));
        }
        let row=sqlx::query_as::<_,RequestRow>("insert into account_verification_requests(id,account_uuid,context_app_id,reason) values($1,$2,$3,$4) returning *")
            .bind(Uuid::now_v7()).bind(who.uuid()).bind(&app_id).bind(reason)
            .fetch_one(&mut *tx).await?;
        let request_id=row.id;
        let email=contacts::primary_email(&mut tx,who.uuid()).await?.filter(|email| email.verified).map(|email| email.value);
        let contact=email.as_deref().unwrap_or("No verified primary email is available.");
        let body=format!("Manual account verification request {request_id}\n\nPurpose: eligibility to run this app's sign-in and authorization on the developer's own domain.\n\nRequester: {} ({})\nImmutable account UUID: {}\nVerified primary email: {contact}\nContext app: {} ({})\nSubmitted: {}\nResponse estimate: up to 48 hours (by {}). This is a response estimate, not automatic approval.\n\nReason supplied by the requester:\n{reason}\n\nReview context: {}/apps/{}/sign-in\n\nThe request is pending. No account verification, domain permission, or custom-domain hosting has been enabled by submission.",
            who.account.display_name,who.account.display_id(),who.uuid(),app.name,app.app_id,
            accounts_core::timefmt::format_rfc3339_ms(row.submitted_at),
            accounts_core::timefmt::format_rfc3339_ms(row.response_expected_by),
            state.settings.developer_url.trim_end_matches('/'),app.app_id);
        let mut messages=Vec::with_capacity(2);
        for recipient in RECIPIENTS {
            let message=delivery::enqueue(&mut tx,&state.settings,&NewMessage{
                channel:MessageChannel::Email,to:recipient.into(),
                subject:Some(format!("Account verification request: {}",app.app_id)),
                text_body:body.clone(),html_body:None,purpose:"account_verification_request".into(),
            }).await?;
            sqlx::query("insert into account_verification_request_notifications(request_id,recipient,message_id) values($1,$2,$3)")
                .bind(request_id).bind(recipient).bind(message).execute(&mut *tx).await?;
            messages.push(message);
        }
        audit::record(&mut tx,&audit::AuditEntry{
            target_kind:Some("account_verification_request"),target_id:Some(&request_id.to_string()),
            app_id:Some(&app_id),account_uuid:Some(who.uuid()),
            details:json!({"status":"pending","context_app_id":app_id,"response_time_hours":RESPONSE_HOURS}),
            ..audit::AuditEntry::new(ActorKind::Account,Some(who.uuid()),"account.verification.requested")
        }).await?;
        let request=view(&mut tx,row).await?;
        tx.commit().await?;
        for message in messages { delivery::spawn_deliver(&state,message); }
        Ok((StatusCode::CREATED,json!({"request":request,"created":true,"response_time_hours":RESPONSE_HOURS})))
    }).await?;
    Ok(no_store(response))
}
