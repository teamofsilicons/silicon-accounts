//! Private delivery bridge for Silicon Apps. Identity contacts never leave Accounts.
use accounts_core::delivery::{self, NewMessage};
use accounts_core::http::{IdempotencyKey, Json};
use accounts_core::models::MessageChannel;
use accounts_core::repo::idempotency;
use accounts_core::{ApiError, ApiResult, AppState};
use axum::{
    Router,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::Response,
    routing::post,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

pub(crate) fn router() -> Router<AppState> {
    Router::new().route("/v1/internal/apps/mail", post(send))
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Input {
    kind: String,
    body: Value,
}

async fn send(
    State(state): State<AppState>,
    headers: HeaderMap,
    key: IdempotencyKey,
    Json(input): Json<Input>,
) -> ApiResult<Response> {
    super::sync::authorize_internal(&state, &headers)?;
    idempotency::run(&state,Some(key.as_str()),"internal:apps:mail",&input,false,||async {
        let (recipients,subject,text,purpose) = match input.kind.as_str() {
            "mail.invite" => {
                let b=&input.body;
                let destination=b["to"].as_str().ok_or_else(||ApiError::invalid_request("Invite to is required."))?;
                let to=if destination.starts_with("c:") {
                    let uuid=b["account_uuid"].as_str().ok_or_else(||ApiError::invalid_request("A c:id invitation needs its resolved account_uuid."))?;
                    let email:Option<String>=sqlx::query_scalar("select e.email from account_emails e join accounts a on a.uuid=e.account_uuid where a.uuid=$1 and a.kind='carbon' and a.status='active' and e.verified_at is not null order by e.is_primary desc,e.created_at limit 1")
                        .bind(uuid).fetch_optional(&state.db).await?;
                    email.ok_or_else(||ApiError::unprocessable("verified_email_missing","The invited Carbon has no verified email for delivery."))?
                } else { accounts_core::normalize::normalize_email(destination)?.to_string() };
                let app_id=b["app_id"].as_str().ok_or_else(||ApiError::invalid_request("Invite app_id is required."))?;
                accounts_core::ids::validate_app_id(app_id).map_err(ApiError::invalid_request)?;
                let exists:bool=sqlx::query_scalar("select exists(select 1 from apps where app_id=$1)").bind(app_id).fetch_one(&state.db).await?;
                if !exists {return Err(ApiError::unprocessable("unknown_app","The invitation's app does not exist in Accounts."));}
                (vec![to],format!("Invitation to author {app_id} on Silicon Apps"),format!("You have been invited to become an author of {app_id}.\n\nSign in to Silicon Developers to accept or decline: {}/invitations\n\nYou are not an author until you accept.",state.settings.developer_url.trim_end_matches('/')),"apps_invite")
            },
            "mail.report" => {
                let message=input.body["message"].as_str().filter(|m|!m.trim().is_empty() && m.len()<=20000).ok_or_else(||ApiError::invalid_request("Report message must contain 1–20,000 bytes."))?;
                let pr=input.body["pr"].as_str().unwrap_or("");
                if !pr.is_empty(){accounts_core::normalize::validate_https_url(pr).map_err(ApiError::invalid_request)?;}
                (vec!["saketdev12@gmail.com".into(),"shubhastro2@gmail.com".into(),"bugs@teamofsilicons.com".into()],"Silicon Apps bug report".into(),format!("{message}\n\nPatch: {pr}"),"apps_report")
            },
            _ => return Err(ApiError::invalid_request("kind must be mail.invite or mail.report.")),
        };
        let mut tx=state.db.begin().await?;
        let mut ids=Vec::new();
        for to in &recipients {
            ids.push(delivery::enqueue(&mut tx,&state.settings,&NewMessage{channel:MessageChannel::Email,to:to.clone(),subject:Some(subject.clone()),text_body:text.clone(),html_body:None,purpose:purpose.into()}).await?);
        }
        tx.commit().await?;
        for id in ids {delivery::spawn_deliver(&state,id);}
        Ok((StatusCode::ACCEPTED,json!({"status":"queued","recipients":recipients.len()})))
    }).await
}
