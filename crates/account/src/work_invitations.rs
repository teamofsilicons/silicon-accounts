//! Accounts proves an invite's fixed email without creating a personal account.
use super::organizations::{durable_replay, durable_save, service, string};
use accounts_core::http::{AppAuth, ClientMeta, IdempotencyKey, Json};
use accounts_core::models::{Account, AccountKind, MessageChannel, OtpChannel, OtpPurpose};
use accounts_core::repo::{accounts, contacts, idempotency, organizations as orgs, otp};
use accounts_core::{ApiError, ApiResult, AppState};
use axum::{
    Router,
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde_json::{Value, json};
use sqlx::PgConnection;
use time::OffsetDateTime;
use uuid::Uuid;

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/v1/internal/organizations/{org}/invitations",
            post(register),
        )
        .route(
            "/v1/internal/organizations/{org}/invitations/{id}/{action}",
            post(invite_action),
        )
        .route("/v1/internal/organizations/{org}/mail", post(mail))
        .route("/v1/work-invitations/{ticket}", get(show))
        .route("/v1/work-invitations/{ticket}/email-code", post(send_code))
        .route("/v1/work-invitations/{ticket}/verify", post(verify))
}
#[derive(sqlx::FromRow)]
struct Invitation {
    invite_id: String,
    org_id: String,
    email: Option<String>,
    account_uuid: Option<String>,
    handle: String,
    return_to: String,
    expires_at: OffsetDateTime,
    profile: Option<Value>,
}
async fn ticket(conn: &mut PgConnection, state: &AppState, ticket: &str) -> ApiResult<Invitation> {
    sqlx::query_as("select invite_id,org_id,email,account_uuid,handle,return_to,status,expires_at,proof_hash,proof_expires_at,profile from organization_invitations where ticket_hash=$1 and status='pending' and expires_at>now()")
        .bind(state.keys.pepper.hash(ticket)).fetch_optional(conn).await?.ok_or_else(||ApiError::gone("invitation_unavailable","This invitation expired, was cancelled, or has already been accepted."))
}
async fn register(
    State(state): State<AppState>,
    auth: AppAuth,
    Path(org): Path<String>,
    key: Option<IdempotencyKey>,
    Json(body): Json<Value>,
) -> ApiResult<Response> {
    service(&auth)?;
    idempotency::run(&state,None,&format!("org:{org}:invitation"),&body,true,||async{
        let scope=format!("org:{org}:invitation");
        let mut tx=state.db.begin().await?;
        if let Some(saved)=durable_replay(&mut tx,&state,&scope,key.as_deref(),&body).await?{tx.commit().await?;return Ok((StatusCode::CREATED,saved))}
        let id=string(&body,"invite_id")?;let handle=accounts_core::ids::validate_handle(string(&body,"handle")?).map_err(|e|accounts::invalid_id_error(&e))?;
        let email=body.get("email").and_then(Value::as_str).map(accounts_core::normalize::normalize_email).transpose()?;
        let account_uuid=if let Some(v)=body.get("account_uuid").and_then(Value::as_str){
            let a=accounts::by_uuid_or_id(&mut tx,v).await?.ok_or_else(||ApiError::not_found("account_not_found","The invited Carbon was not found."))?;
            if !a.is_carbon()||!a.is_active(){return Err(ApiError::unprocessable("carbon_required","Invite an active Carbon."))}Some(a.uuid)
        }else{None};
        if email.is_none()&&account_uuid.is_none(){return Err(ApiError::unprocessable("invite_target_required","Provide an email or Carbon account_uuid."))}
        let return_to=string(&body,"return_to")?;
        let base=std::env::var("ACCOUNTS_ORGANIZATIONS_URL").unwrap_or_else(|_|"https://organizations.teamofsilicons.com".into());
        if !return_to.starts_with(&format!("{}/",base.trim_end_matches('/'))){return Err(ApiError::unprocessable("invalid_return_to","Invitation return_to must be on the configured Silicon Organizations site."))}
        let expires=body.get("expires_at").and_then(Value::as_str).map(accounts_core::timefmt::parse_rfc3339).transpose().map_err(|_|ApiError::unprocessable("invalid_expiry","expires_at must be an RFC 3339 timestamp."))?;
        let token=accounts_core::crypto::random_token("sawi_");
        sqlx::query("insert into organization_invitations(invite_id,org_id,ticket_hash,email,account_uuid,handle,return_to,expires_at) values($1,$2,$3,$4,$5,$6,$7,least(coalesce($8,now()+interval '14 days'),now()+interval '14 days'))")
            .bind(id).bind(&org).bind(state.keys.pepper.hash(&token)).bind(email).bind(account_uuid).bind(handle).bind(return_to).bind(expires).execute(&mut *tx).await?;
        let result=json!({"invitation_id":id,"ticket":token,"acceptance_url":format!("{}/work-invitations/{token}",state.settings.public_url.trim_end_matches('/'))});
        durable_save(&mut tx,&state,&scope,key.as_deref(),&body,&result).await?;
        tx.commit().await?;Ok((StatusCode::CREATED,result))
    }).await
}
async fn invite_action(
    State(state): State<AppState>,
    auth: AppAuth,
    Path((org, id, action)): Path<(String, String, String)>,
    key: Option<IdempotencyKey>,
    Json(body): Json<Value>,
) -> ApiResult<Response> {
    service(&auth)?;
    let actor = match body.get("actor_token").and_then(Value::as_str) {
        Some(token) => Some(super::organizations::verified_actor(&state, token).await?),
        None => None,
    };
    if action == "check" {
        let mut conn = state.db.acquire().await?;
        let invite:Option<(Option<String>,Option<String>)>=sqlx::query_as("select account_uuid,email from organization_invitations where invite_id=$1 and org_id=$2 and status='pending' and expires_at>now()").bind(&id).bind(&org).fetch_optional(&mut *conn).await?;
        let (target, email) = invite.ok_or_else(|| {
            ApiError::gone(
                "invitation_unavailable",
                "This invitation is no longer pending.",
            )
        })?;
        let owner = match email {
            Some(email) => contacts::owner(&mut conn, contacts::ContactKind::Email, &email)
                .await?
                .filter(|(_, verified)| *verified)
                .map(|(uuid, _)| uuid),
            None => None,
        };
        let can_accept = actor.as_ref().is_some_and(|a| {
            a.is_carbon()
                && (target.as_deref() == Some(&a.uuid) || owner.as_deref() == Some(&a.uuid))
        });
        return Ok((StatusCode::OK,axum::Json(json!({"can_accept":can_accept,"linking_required":target.is_some()||owner.is_some()}))).into_response());
    }
    let mut fingerprint = body.clone();
    if let Some(map) = fingerprint.as_object_mut() {
        map.remove("actor_token");
        map.remove("proof_token");
        if let Some(actor) = &actor {
            map.insert("actor_uuid".into(), json!(actor.uuid));
        }
    }
    idempotency::run(&state,None,&format!("org:{org}:invite:{id}:{action}"),&fingerprint,false,||async{
        if action == "notify" {
            let scope=format!("org:{org}:invite:{id}:notify");
            let mut tx=state.db.begin().await?;
            if let Some(saved)=durable_replay(&mut tx,&state,&scope,key.as_deref(),&fingerprint).await?{tx.commit().await?;return Ok((StatusCode::OK,saved))}
            let target:Option<String>=sqlx::query_scalar("select coalesce(i.account_uuid,(select e.account_uuid from account_emails e where e.email=i.email and e.verified_at is not null)) from organization_invitations i where i.invite_id=$1 and i.org_id=$2 and i.status='pending' and i.expires_at>now()").bind(&id).bind(&org).fetch_optional(&mut *tx).await?.flatten();
            let mut delivered=0;
            if let Some(target)=target {
                let mut notification=body.get("notification").cloned().ok_or_else(||ApiError::unprocessable("notification_required","Provide a notification."))?;
                validate_notification_type(string(&notification,"type")?)?;
                let stable_key=string(&notification,"key")?.to_owned();
                notification["for"]=json!(target);notification["key"]=json!(format!("{stable_key}:invite:{id}"));
                let base=&state.settings.ting_url;
                let response=state.http.post(format!("{}/v1/tings",base.trim_end_matches('/'))).bearer_auth(string(&body,"proof_token")?).json(&notification).send().await.map_err(|_|ApiError::unavailable("ting_unavailable","Ting could not be reached; retry the same notification."))?;
                if !response.status().is_success(){return Err(ApiError::unavailable("ting_delivery_failed","Ting refused this invitation notification. Retry after the recipient's subscription is available."))}
                delivered=1;
            }
            let result=json!({"delivered":delivered});durable_save(&mut tx,&state,&scope,key.as_deref(),&fingerprint,&result).await?;tx.commit().await?;
            return Ok((StatusCode::OK,result));
        }
        if action == "decline" {
            let scope=format!("org:{org}:invite:{id}:decline");
            let mut tx = state.db.begin().await?;
            if let Some(saved)=durable_replay(&mut tx,&state,&scope,key.as_deref(),&fingerprint).await?{tx.commit().await?;return Ok((StatusCode::OK,saved))}
            let invite: Option<(Option<String>,Option<String>,bool)> = sqlx::query_as("select account_uuid,email,coalesce(proof_hash=$3 and proof_expires_at>now(),false) from organization_invitations where invite_id=$1 and org_id=$2 and status='pending' and expires_at>now() for update")
                .bind(&id).bind(&org).bind(body.get("invitation_proof").and_then(Value::as_str).map(|p|state.keys.pepper.hash(p))).fetch_optional(&mut *tx).await?;
            let (target,email,proved)=invite.ok_or_else(||ApiError::gone("invitation_unavailable","This invitation is no longer pending."))?;
            let mut authorized=proved;
            if let Some(actor)=&actor {
                authorized |= target.as_deref()==Some(&actor.uuid);
                if let Some(email)=email {
                    authorized |= contacts::owner(&mut tx,contacts::ContactKind::Email,&email).await?.is_some_and(|(uuid,verified)|uuid==actor.uuid&&verified);
                }
            }
            if !authorized{return Err(ApiError::forbidden("invitation_recipient_required","Declining requires proof of the invited account or invited email."))}
            sqlx::query("update organization_invitations set status='declined',proof_hash=null where invite_id=$1").bind(&id).execute(&mut *tx).await?;
            let result=json!({"updated":true});durable_save(&mut tx,&state,&scope,key.as_deref(),&fingerprint,&result).await?;
            tx.commit().await?;
            return Ok((StatusCode::OK,result));
        }
        let n=match action.as_str(){
            "cancel"=>sqlx::query("update organization_invitations set status='cancelled',proof_hash=null where invite_id=$1 and org_id=$2 and status='pending'").bind(&id).bind(&org).execute(&state.db).await?.rows_affected(),
            "resend"=>sqlx::query("update organization_invitations set expires_at=now()+interval '14 days' where invite_id=$1 and org_id=$2 and status='pending'").bind(&id).bind(&org).execute(&state.db).await?.rows_affected(),
            _=>return Err(ApiError::unprocessable("invalid_invitation_action","Use cancel, resend or decline.")),
        };Ok((StatusCode::OK,json!({"updated":n>0})))
    }).await
}
async fn show(State(state): State<AppState>, Path(value): Path<String>) -> ApiResult<Json<Value>> {
    let mut conn = state.db.acquire().await?;
    let invite = ticket(&mut conn, &state, &value).await?;
    let org: orgs::Organization =
        sqlx::query_as("select org_id,name,logo_url from organization_projections where org_id=$1")
            .bind(&invite.org_id)
            .fetch_one(&mut *conn)
            .await?;
    let exists = if let Some(email) = &invite.email {
        accounts::by_email(&mut conn, email).await?.is_some()
    } else {
        true
    };
    Ok(Json(
        json!({"invitation_id":invite.invite_id,"org":org,"handle":invite.handle,"email":invite.email.as_deref().map(accounts_core::normalize::mask_email),"needs_link":exists||invite.account_uuid.is_some(),"return_to":invite.return_to,"expires_at":accounts_core::timefmt::format_rfc3339_ms(invite.expires_at)}),
    ))
}
async fn send_code(
    State(state): State<AppState>,
    meta: ClientMeta,
    Path(value): Path<String>,
) -> ApiResult<Json<Value>> {
    let mut tx = state.db.begin().await?;
    let invite = ticket(&mut tx, &state, &value).await?;
    let email = invite.email.ok_or_else(|| {
        ApiError::forbidden(
            "sign_in_required",
            "Sign in to the Carbon account this invitation was addressed to.",
        )
    })?;
    if invite.account_uuid.is_some() || accounts::by_email(&mut tx, &email).await?.is_some() {
        return Err(ApiError::conflict(
            "sign_in_required",
            "This email already belongs to an account. Sign in to that account to accept and link your work account.",
        ));
    }
    let binding = format!("organization-invite:{}", invite.invite_id);
    let sent = otp::send(
        &mut tx,
        &state.keys.pepper,
        &state.settings,
        &otp::NewChallenge {
            purpose: OtpPurpose::Requirement,
            channel: OtpChannel::Email,
            destination: &email,
            account_uuid: None,
            flow_id: Some(&binding),
            ip: meta.ip.as_deref(),
        },
    )
    .await?;
    accounts_core::delivery::enqueue_otp(
        &mut tx,
        &state.settings,
        &sent.challenge,
        &sent.code,
        Some("Silicon Organizations"),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(
        json!({"challenge_id":sent.challenge.id,"expires_at":accounts_core::timefmt::format_rfc3339_ms(sent.challenge.expires_at),"destination":sent.challenge.masked_destination()}),
    ))
}
async fn verify(
    State(state): State<AppState>,
    Path(value): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let mut conn = state.db.acquire().await?;
    let invite = ticket(&mut conn, &state, &value).await?;
    let email = invite
        .email
        .ok_or_else(|| ApiError::forbidden("sign_in_required", "Sign in to the invited Carbon."))?;
    if accounts::by_email(&mut conn, &email).await?.is_some() {
        return Err(ApiError::conflict(
            "sign_in_required",
            "This email already has an account; sign in and link the work account.",
        ));
    }
    drop(conn);
    let challenge = Uuid::parse_str(string(&body, "challenge_id")?).map_err(|_| {
        ApiError::unprocessable("invalid_challenge_id", "challenge_id must be a UUID.")
    })?;
    let binding = format!("organization-invite:{}", invite.invite_id);
    let name = string(&body, "display_name")?;
    accounts_core::normalize::validate_display_name(name)
        .map_err(|e| ApiError::unprocessable("invalid_display_name", e))?;
    let timezone = accounts_core::normalize::normalize_timezone(
        body.get("timezone")
            .and_then(Value::as_str)
            .unwrap_or("UTC"),
    )
    .map_err(|e| ApiError::unprocessable("invalid_timezone", e))?;
    let dob = accounts_core::timefmt::parse_date(string(&body, "dob")?)
        .map_err(|_| ApiError::unprocessable("invalid_dob", "dob must be YYYY-MM-DD."))?;
    accounts_core::normalize::validate_dob(dob, OffsetDateTime::now_utc().date())
        .map_err(|e| ApiError::unprocessable("invalid_dob", e))?;
    let verified = otp::verify(
        &state.db,
        &state.keys.pepper,
        &state.settings,
        challenge,
        string(&body, "code")?,
        &otp::Expect {
            purpose: Some(OtpPurpose::Requirement),
            flow_id: Some(&binding),
            account_uuid: None,
        },
        None,
    )
    .await?;
    if verified.destination != email {
        return Err(ApiError::forbidden(
            "invitation_email_mismatch",
            "This code did not verify the invited email.",
        ));
    }
    let proof = accounts_core::crypto::random_token("sawp_");
    let n=sqlx::query("update organization_invitations set proof_hash=$2,proof_expires_at=now()+interval '15 minutes',profile=$3 where invite_id=$1 and status='pending' and expires_at>now()")
        .bind(&invite.invite_id).bind(state.keys.pepper.hash(&proof)).bind(json!({"display_name":name,"timezone":timezone,"dob":string(&body,"dob")?})).execute(&state.db).await?.rows_affected();
    if n == 0 {
        return Err(ApiError::gone(
            "invitation_unavailable",
            "The invitation is no longer pending.",
        ));
    }
    Ok(Json(
        json!({"invitation_proof":proof,"invitation_id":invite.invite_id,"return_to":invite.return_to}),
    ))
}
pub(super) struct Accepted {
    pub email: Option<String>,
    pub linked_to: Option<String>,
    pub profile: Value,
}
pub(super) async fn accept_proof(
    conn: &mut PgConnection,
    state: &AppState,
    org: &str,
    id: &str,
    handle: &str,
    actor: Option<&Account>,
    proof: Option<&str>,
) -> ApiResult<Accepted> {
    let invite:Invitation=sqlx::query_as("select invite_id,org_id,email,account_uuid,handle,return_to,status,expires_at,proof_hash,proof_expires_at,profile from organization_invitations where invite_id=$1 and org_id=$2 and status='pending' and expires_at>now() for update").bind(id).bind(org).fetch_optional(&mut *conn).await?.ok_or_else(||ApiError::gone("invitation_unavailable","This invitation is no longer pending."))?;
    if invite.handle != handle {
        return Err(ApiError::conflict(
            "invitation_handle_mismatch",
            "Use the work handle approved in the invitation.",
        ));
    }
    if let Some(actor) = actor {
        if actor.kind != AccountKind::Carbon {
            return Err(ApiError::forbidden(
                "carbon_required",
                "This invitation is for a Carbon.",
            ));
        }
        let target_matches = invite.account_uuid.as_deref() == Some(&actor.uuid);
        let email_matches = if let Some(email) = &invite.email {
            contacts::owner(conn, contacts::ContactKind::Email, email)
                .await?
                .is_some_and(|(uuid, verified)| uuid == actor.uuid && verified)
        } else {
            false
        };
        if target_matches || email_matches {
            return Ok(Accepted {
                email: None,
                linked_to: Some(actor.uuid.clone()),
                profile: json!({"display_name":actor.display_name,"timezone":actor.timezone,"dob":accounts_core::timefmt::format_date(actor.dob)}),
            });
        }
        // A new, unowned invited email may be proved independently and optionally
        // linked to this signed-in Carbon. Existing email ownership never moves.
    }
    let proof = proof.ok_or_else(|| {
        ApiError::unauthenticated(
            "invitation_proof_required",
            "Sign in to the invited account, or verify the invited email in Silicon Accounts.",
        )
    })?;
    let valid:bool=sqlx::query_scalar("select coalesce(proof_hash=$2 and proof_expires_at>now(),false) from organization_invitations where invite_id=$1").bind(id).bind(state.keys.pepper.hash(proof)).fetch_one(&mut *conn).await?;
    if !valid {
        return Err(ApiError::unauthenticated(
            "invalid_invitation_proof",
            "This invitation proof is invalid or expired.",
        ));
    }
    if invite.account_uuid.is_some() {
        return Err(ApiError::forbidden(
            "sign_in_required",
            "Sign in to the account this invitation names.",
        ));
    }
    let email = invite.email.ok_or_else(|| {
        ApiError::unprocessable("invitation_email_required", "This invitation has no email.")
    })?;
    if accounts::by_email(conn, &email).await?.is_some() {
        return Err(ApiError::conflict(
            "sign_in_required",
            "The invited email now belongs to an account. Sign in to it and link the work account.",
        ));
    }
    Ok(Accepted {
        email: Some(email),
        linked_to: actor.map(|a| a.uuid.clone()),
        profile: invite.profile.ok_or_else(|| {
            ApiError::conflict(
                "invitation_profile_required",
                "Complete the work account profile first.",
            )
        })?,
    })
}
async fn mail(
    State(state): State<AppState>,
    auth: AppAuth,
    Path(org): Path<String>,
    key: Option<IdempotencyKey>,
    Json(body): Json<Value>,
) -> ApiResult<Response> {
    service(&auth)?;
    idempotency::run(&state,None,&format!("org:{org}:mail"),&body,false,||async{
        let scope=format!("org:{org}:mail");let mut tx=state.db.begin().await?;
        if let Some(saved)=durable_replay(&mut tx,&state,&scope,key.as_deref(),&body).await?{tx.commit().await?;return Ok((StatusCode::ACCEPTED,saved))}
        let mut destinations=vec![];
        if org=="system" {
            let email=body.get("to_email").and_then(Value::as_str).unwrap_or("");
            if body.get("kind").and_then(Value::as_str)!=Some("bug_report") || !state.settings.report_recipients.iter().any(|r| r==email) || body.get("to_uuid").is_some(){return Err(ApiError::forbidden("report_recipient_forbidden","System mail is restricted to configured bug-report recipients."))}
        }
        if let Some(email)=body.get("to_email").and_then(Value::as_str){destinations.push(accounts_core::normalize::normalize_email(email)?);}
        if let Some(uuid)=body.get("to_uuid").and_then(Value::as_str){
            let own=orgs::org_id(&mut tx,uuid).await?.as_deref()==Some(&org);
            let invited:bool=sqlx::query_scalar("select exists(select 1 from organization_invitations where org_id=$1 and account_uuid=$2)").bind(&org).bind(uuid).fetch_one(&mut *tx).await?;
            if !own&&!invited{return Err(ApiError::forbidden("notification_recipient_forbidden","Notify only this organization's work accounts or invited Carbons."))}
            let main=orgs::main_uuid(&mut tx,uuid).await?;
            let emails:Vec<String>=sqlx::query_scalar("select email from account_emails where verified_at is not null and (account_uuid=$1 or account_uuid=$2 or account_uuid in (select account_uuid from account_links where main_uuid=$2)) order by is_primary desc,email").bind(uuid).bind(&main).fetch_all(&mut *tx).await?;
            destinations.extend(emails);
            let old:Vec<String>=sqlx::query_scalar("select email from organization_notification_contacts where account_uuid=$1 and expires_at>now()").bind(uuid).fetch_all(&mut *tx).await?;destinations.extend(old);
        }
        destinations.sort();destinations.dedup();let mut ids=vec![];
        for email in destinations{ids.push(accounts_core::delivery::enqueue(&mut tx,&state.settings,&accounts_core::delivery::NewMessage{channel:MessageChannel::Email,to:email,subject:Some(string(&body,"subject")?.into()),text_body:string(&body,"text_body")?.into(),html_body:None,purpose:"organization_notification".into()}).await?);}
        let result=json!({"queued":ids.len(),"message_ids":ids});
        durable_save(&mut tx,&state,&scope,key.as_deref(),&body,&result).await?;
        if let Some(uuid)=body.get("to_uuid").and_then(Value::as_str){sqlx::query("delete from organization_notification_contacts where account_uuid=$1").bind(uuid).execute(&mut *tx).await?;}
        tx.commit().await?;Ok((StatusCode::ACCEPTED,result))
    }).await
}

// Keep historical requests replayable while Organizations rolls onto Ting 0.4.
// Do not rewrite the type or key: both are part of the durable send fingerprint.
fn validate_notification_type(kind: &str) -> ApiResult<()> {
    match kind {
        "silicon-organizations.inviteSent" | "silicon-organizations.invite.sent" => Ok(()),
        _ => Err(ApiError::unprocessable(
            "invalid_notification_type",
            "Use silicon-organizations.inviteSent for invitation notifications.",
        )),
    }
}

#[cfg(test)]
mod notification_tests {
    use super::validate_notification_type;

    #[test]
    fn accepts_current_and_replayable_legacy_invites_only() {
        for kind in [
            "silicon-organizations.inviteSent",
            "silicon-organizations.invite.sent",
        ] {
            assert!(validate_notification_type(kind).is_ok());
        }
        for kind in [
            "other.inviteSent",
            "silicon-organizations.roleChanged",
            "silicon-organizations.inviteSent.extra",
        ] {
            assert!(validate_notification_type(kind).is_err());
        }
    }
}
