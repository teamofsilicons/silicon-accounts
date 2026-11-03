//! The authenticated Organizations bridge and account-owned linked-account operations.
use accounts_core::http::cookies::{append_cookie, session_cookie};
use accounts_core::http::{AccountAuth, AppAuth, ClientMeta, IdempotencyKey, Json};
use accounts_core::models::{Account, AccountKind, AccountStatus, TokenOrigin};
use accounts_core::repo::{
    accounts, audit, contacts, idempotency, organizations as orgs, sessions, tokens,
};
use accounts_core::{ApiError, ApiResult, AppState};
use axum::{
    Router,
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post, put},
};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::PgConnection;
use uuid::Uuid;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/internal/organizations/actor", post(actor))
        .route(
            "/v1/internal/organizations/linked-accounts",
            post(actor_linked),
        )
        .route("/v1/internal/organizations/events", get(events))
        .route("/v1/internal/organizations/{org}", put(upsert))
        .route("/v1/internal/organizations/{org}/accounts", post(create))
        .route(
            "/v1/internal/organizations/{org}/accounts/{uuid}",
            get(work_profile),
        )
        .route(
            "/v1/internal/organizations/{org}/accounts/{uuid}/policy",
            put(policy),
        )
        .route(
            "/v1/internal/organizations/{org}/accounts/{uuid}/{action}",
            post(action),
        )
        .route("/v1/me/linked-accounts", get(linked))
        .route("/v1/me/linked-accounts/requests", get(link_requests))
        .route(
            "/v1/me/linked-accounts/requests/{id}/{action}",
            post(link_request_action),
        )
        .route("/v1/me/linked-accounts/link", post(link))
        .route("/v1/me/linked-accounts/link/start", post(link_start))
        .route("/v1/me/linked-accounts/link/complete", post(link_complete))
        .route("/v1/me/linked-accounts/switch", post(switch))
        .route("/v1/me/personal-account", post(personal))
}
pub(super) fn service(auth: &AppAuth) -> ApiResult<()> {
    if auth.app.app_id != orgs::APP_ID {
        return Err(ApiError::forbidden(
            "organizations_service_required",
            "Only Silicon Organizations may use this bridge.",
        ));
    }
    Ok(())
}
pub(super) fn string<'a>(v: &'a Value, key: &str) -> ApiResult<&'a str> {
    v.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| {
            ApiError::unprocessable(
                "missing_field",
                format!("'{key}' must be a nonempty string."),
            )
        })
}
pub(super) async fn verified_actor(state: &AppState, token: &str) -> ApiResult<Account> {
    let mut conn = state.db.acquire().await?;
    let v = tokens::verify_access_token(&mut conn, &state.keys, token, Some(orgs::APP_ID)).await?;
    if !v.account.is_active() {
        return Err(ApiError::unauthenticated(
            "account_not_active",
            "This account is no longer active.",
        ));
    }
    Ok(v.account)
}
pub(super) async fn account_value(conn: &mut PgConnection, a: &Account) -> ApiResult<Value> {
    let mut v = serde_json::to_value(accounts_core::views::AccountSummary::from_account(a))?;
    let org = orgs::organization(conn, &a.uuid).await?;
    v["org_id"] = json!(org.as_ref().map(|o| o.org_id.as_str()));
    v["org"] = json!(org);
    v["timezone"] = json!(a.timezone);
    Ok(v)
}
async fn actor(
    State(state): State<AppState>,
    auth: AppAuth,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    service(&auth)?;
    let account = verified_actor(&state, string(&body, "access_token")?).await?;
    let mut conn = state.db.acquire().await?;
    Ok(Json(account_value(&mut conn, &account).await?))
}
async fn actor_linked(
    State(state): State<AppState>,
    auth: AppAuth,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    service(&auth)?;
    let account = verified_actor(&state, string(&body, "access_token")?).await?;
    let mut conn = state.db.acquire().await?;
    let mut value = orgs::linked_accounts(&mut conn, &account.uuid, Some(orgs::APP_ID)).await?;
    let main = orgs::main_uuid(&mut conn, &account.uuid).await?;
    let ids: Vec<String> = sqlx::query_scalar("select distinct i.invite_id from organization_invitations i where i.status='pending' and i.expires_at>now() and (i.account_uuid=$1 or i.account_uuid=$2 or i.account_uuid in(select account_uuid from account_links where main_uuid=$2) or i.email in(select email from account_emails where verified_at is not null and (account_uuid=$1 or account_uuid=$2 or account_uuid in(select account_uuid from account_links where main_uuid=$2)))) order by i.invite_id").bind(&account.uuid).bind(main).fetch_all(&mut *conn).await?;
    value["invitation_ids"] = json!(ids);
    Ok(Json(value))
}
async fn work_profile(
    State(state): State<AppState>,
    auth: AppAuth,
    Path((org, uuid)): Path<(String, String)>,
) -> ApiResult<Json<Value>> {
    service(&auth)?;
    let mut conn = state.db.acquire().await?;
    let account = orgs::require_work(&mut conn, &org, &uuid).await?;
    Ok(Json(account_value(&mut conn, &account).await?))
}
async fn upsert(
    State(state): State<AppState>,
    auth: AppAuth,
    Path(org): Path<String>,
    key: Option<IdempotencyKey>,
    Json(body): Json<Value>,
) -> ApiResult<Response> {
    service(&auth)?;
    let org = orgs::validate_org_id(&org)?;
    idempotency::run(&state,key.as_deref(),&format!("org:{org}:projection"),&body,false,||async{
        let name=string(&body,"name")?.trim();accounts_core::normalize::validate_display_name(name).map_err(|e|ApiError::unprocessable("invalid_display_name",e))?;
        let version=body.get("version").and_then(Value::as_i64).unwrap_or(1);
        let logo=body.get("logo_url").and_then(Value::as_str);
        if let Some(logo)=logo{accounts_core::normalize::validate_https_url(logo).map_err(|e|ApiError::unprocessable("invalid_logo_url",e))?;}
        if version<1{return Err(ApiError::unprocessable("invalid_version","Version must be positive."))}
        let mut tx=state.db.begin().await?;
        let row:Option<(String,Option<String>,i64)>=sqlx::query_as("select name,logo_url,version from organization_projections where org_id=$1 for update").bind(&org).fetch_optional(&mut *tx).await?;
        if let Some((old_name,old_logo,old_version))=row {if old_version>version || (old_version==version&&(old_name!=name||old_logo.as_deref()!=logo)){return Err(ApiError::conflict("stale_organization_projection","The organization projection version is stale or already used."))}}
        sqlx::query("insert into organization_projections(org_id,name,logo_url,version) values($1,$2,$3,$4) on conflict(org_id) do update set name=excluded.name,logo_url=excluded.logo_url,version=excluded.version,updated_at=now()").bind(&org).bind(name).bind(logo).bind(version).execute(&mut *tx).await?;
        tx.commit().await?;Ok((StatusCode::OK,json!({"org_id":org,"name":name,"logo_url":logo,"version":version})))
    }).await
}
pub(super) async fn reserve_work_handle(
    conn: &mut PgConnection,
    org: &str,
    handle: &str,
    own: Option<&str>,
) -> ApiResult<()> {
    let name = format!("{handle}.{org}");
    sqlx::query("select pg_advisory_xact_lock(hashtextextended($1,728391))")
        .bind(&name)
        .execute(&mut *conn)
        .await?;
    let taken:bool=sqlx::query_scalar("select exists(select 1 from accounts where org_id=$1 and split_part(split_part(handle,':',2),'.',1)=$2 and ($3::text is null or uuid<>$3))").bind(org).bind(handle).bind(own).fetch_one(&mut *conn).await?;
    if taken {
        return Err(ApiError::conflict(
            "work_handle_taken",
            "This handle is already used by a Carbon or Silicon in the organization.",
        ));
    }
    let reserved:bool=sqlx::query_scalar("select exists(select 1 from handle_reservations where split_part(handle,':',2)=$1 and reserved_until>now() and ($2::text is null or account_uuid<>$2))").bind(name).bind(own).fetch_one(&mut *conn).await?;
    if reserved {
        return Err(ApiError::conflict(
            "work_handle_reserved",
            "This handle is reserved for its previous account for 10 days.",
        ));
    }
    Ok(())
}
async fn create(
    State(state): State<AppState>,
    auth: AppAuth,
    Path(org): Path<String>,
    key: Option<IdempotencyKey>,
    Json(body): Json<Value>,
) -> ApiResult<Response> {
    service(&auth)?;
    let org = orgs::validate_org_id(&org)?;
    let normalized_actor = match body.get("actor_token").and_then(Value::as_str) {
        Some(token) => Some(verified_actor(&state, token).await?),
        None => None,
    };
    let mut fingerprint = body.clone();
    if let Some(map) = fingerprint.as_object_mut() {
        map.remove("actor_token");
        if let Some(actor) = &normalized_actor {
            map.insert("actor_uuid".into(), json!(actor.uuid));
        }
    }
    let effective_key = key
        .as_deref()
        .or_else(|| body.get("operation_id").and_then(Value::as_str));
    idempotency::run(&state,None,&format!("org:{org}:create_account"),&fingerprint,true,||async{
        let scope=format!("org:{org}:create_account");
        let mut tx=state.db.begin().await?;
        if let Some(saved)=durable_replay(&mut tx,&state,&scope,effective_key,&fingerprint).await?{tx.commit().await?;return Ok((StatusCode::CREATED,saved))}
        let kind=AccountKind::parse(string(&body,"kind")?).ok_or_else(||ApiError::unprocessable("invalid_kind","kind must be carbon or silicon."))?;
        let handle=accounts_core::ids::validate_handle(string(&body,"handle")?).map_err(|e|accounts::invalid_id_error(&e))?;
        let actor=normalized_actor.clone();
        let exists:bool=sqlx::query_scalar("select exists(select 1 from organization_projections where org_id=$1)").bind(&org).fetch_one(&mut *tx).await?;
        if !exists{return Err(ApiError::not_found("organization_not_found","Register the organization projection before creating its accounts."))}
        reserve_work_handle(&mut tx,&org,&handle,None).await?;
        let mut profile=body.clone();let mut email=None;let mut linked_to=None;
        if let Some(invite)=body.get("invitation_id").and_then(Value::as_str){
            if kind!=AccountKind::Carbon{return Err(ApiError::unprocessable("carbon_invitation_required","Carbon invitations cannot create Silicons."))}
            let accepted=crate::work_invitations::accept_proof(&mut tx,&state,&org,invite,&handle,actor.as_ref(),body.get("invitation_proof").and_then(Value::as_str)).await?;
            email=accepted.email;linked_to=accepted.linked_to;profile=accepted.profile;
        }else if let Some(actor)=&actor {
            if body.get("link_to_actor").and_then(Value::as_bool).unwrap_or(true) {
                if orgs::org_id(&mut tx,&actor.uuid).await?.is_some(){return Err(ApiError::forbidden("personal_account_required","Create an organization from a personal account."))}
                if actor.kind!=kind{return Err(ApiError::unprocessable("account_kind_mismatch","The creator's work account must have the same kind as their personal account."))}
                linked_to=Some(actor.uuid.clone());
                if profile.get("display_name").is_none(){profile["display_name"]=json!(actor.display_name);}
                if profile.get("timezone").is_none(){profile["timezone"]=json!(actor.timezone);}
                if profile.get("dob").is_none(){profile["dob"]=json!(accounts_core::timefmt::format_date(actor.dob));}
            }
        }else if kind==AccountKind::Carbon{return Err(ApiError::forbidden("invitation_required","Creating a Carbon work account requires an accepted invitation or the personal creator's proof."))}
        let display_name=profile.get("display_name").and_then(Value::as_str).unwrap_or(&handle).trim();accounts_core::normalize::validate_display_name(display_name).map_err(|e|ApiError::unprocessable("invalid_display_name",e))?;
        let timezone=accounts_core::normalize::normalize_timezone(profile.get("timezone").and_then(Value::as_str).unwrap_or("UTC")).map_err(|e|ApiError::unprocessable("invalid_timezone",e))?;
        let uuid=accounts_core::ids::new_account_uuid();let id=format!("{}{handle}.{org}",kind.prefix());
        let stk=(kind==AccountKind::Silicon).then(accounts_core::crypto::stk::generate);
        let hash=match &stk{Some(s)=>Some(state.keys.stk.hash_async(s.clone()).await?),None=>None};
        let dob=profile.get("dob").and_then(Value::as_str).map(accounts_core::timefmt::parse_date).transpose().map_err(|_|ApiError::unprocessable("invalid_dob","dob must be YYYY-MM-DD."))?;
        let pfp=accounts_core::pfp::default_pfp_url(&state.settings.iris_base_url,kind,&uuid);
        sqlx::query("insert into accounts(uuid,number,kind,handle,status,display_name,pfp_url,dob,timezone,stk_hash,stk_rotated_at,org_id) values($1,nextval('account_number_seq'),$2,$3,'active',$4,$5,coalesce($6,(now() at time zone 'utc')::date),$7,$8,case when $8::text is null then null else now() end,$9)")
            .bind(&uuid).bind(kind).bind(&id).bind(display_name).bind(pfp).bind(dob).bind(timezone).bind(hash).bind(&org).execute(&mut *tx).await?;
        let initial_policy:orgs::Policy=match body.get("initial_policy"){Some(policy)=>serde_json::from_value(policy.clone()).map_err(|e|ApiError::unprocessable("invalid_policy",e.to_string()))?,None=>orgs::Policy{version:1,mode:"everywhere".into(),apps:vec![],extra_apps:vec![],excluded_apps:vec![]}};
        orgs::update_policy(&mut tx,&uuid,&initial_policy).await?;
        if let Some(email)=email{contacts::add_verified_email(&mut tx,&uuid,&email,accounts_core::models::VerifiedVia::Code).await?;}
        if let Some(main)=linked_to{orgs::link(&mut tx,&main,&uuid).await?;}
        if let Some(invite)=body.get("invitation_id").and_then(Value::as_str){sqlx::query("update organization_invitations set status='accepted',created_account_uuid=$2,proof_hash=null where invite_id=$1").bind(invite).bind(&uuid).execute(&mut *tx).await?;}
        audit::handle_history(&mut tx,&uuid,None,Some(&id),"organization").await?;
        orgs::record(&mut tx,&uuid,actor.as_ref().map(|a|a.uuid.as_str()),None,"account.work_created",json!({"id":id,"kind":kind})).await?;
        let account=accounts::require(&mut tx,&uuid).await?;let value=account_value(&mut tx,&account).await?;
        let slt=if body.get("invitation_proof").and_then(Value::as_str).is_some(){Some(tokens::create_slt(&mut tx,&state.keys.pepper,&uuid,orgs::APP_ID,&[accounts_core::models::Scope::Profile,accounts_core::models::Scope::Email]).await?.0)}else{None};
        let result=json!({"account":value,"stk":stk,"slt":slt});
        durable_save(&mut tx,&state,&scope,effective_key,&fingerprint,&result).await?;
        tx.commit().await?;
        Ok((StatusCode::CREATED,result))
    }).await
}
async fn policy(
    State(state): State<AppState>,
    auth: AppAuth,
    Path((org, uuid)): Path<(String, String)>,
    key: Option<IdempotencyKey>,
    Json(body): Json<Value>,
) -> ApiResult<Response> {
    service(&auth)?;
    idempotency::run(
        &state,
        key.as_deref(),
        &format!("org:{org}:{uuid}:policy"),
        &body,
        false,
        || async {
            let policy: orgs::Policy = serde_json::from_value(body.clone())
                .map_err(|e| ApiError::unprocessable("invalid_policy", e.to_string()))?;
            let mut tx = state.db.begin().await?;
            orgs::require_work(&mut tx, &org, &uuid).await?;
            let removed = orgs::update_policy(&mut tx, &uuid, &policy).await?;
            tx.commit().await?;
            Ok((
                StatusCode::OK,
                json!({"version":policy.version,"removed_apps":removed}),
            ))
        },
    )
    .await
}
async fn action(
    State(state): State<AppState>,
    auth: AppAuth,
    Path((org, uuid, action)): Path<(String, String, String)>,
    key: Option<IdempotencyKey>,
    Json(body): Json<Value>,
) -> ApiResult<Response> {
    service(&auth)?;
    let mut fingerprint = body.clone();
    if let Some(map) = fingerprint.as_object_mut() {
        map.remove("proof_token");
    }
    idempotency::run(&state,None,&format!("org:{org}:{uuid}:{action}"),&fingerprint,action=="stk",||async{
        let scope=format!("org:{org}:{uuid}:{action}");
        let mut tx=state.db.begin().await?;
        if let Some(saved)=durable_replay(&mut tx,&state,&scope,key.as_deref(),&fingerprint).await?{tx.commit().await?;return Ok((StatusCode::OK,saved))}
        let account=orgs::require_work(&mut tx,&org,&uuid).await?;
        let mut result=json!({"ok":true});
        match action.as_str(){
            "link-request"=>{
                if !account.is_silicon()||!account.is_active(){return Err(ApiError::unprocessable("active_silicon_required","Link requests require an active organization Silicon."))}
                let target=accounts::by_uuid_or_id(&mut tx,string(&body,"target_id")?).await?.ok_or_else(||ApiError::not_found("account_not_found","The personal Silicon was not found."))?;
                if !target.is_silicon()||!target.is_active()||orgs::org_id(&mut tx,&target.uuid).await?.is_some(){return Err(ApiError::unprocessable("personal_silicon_required","Select an active personal Silicon."))}
                if orgs::linked(&mut tx,&uuid,&target.uuid).await?{return Err(ApiError::conflict("accounts_already_linked","These accounts are already linked."))}
                let id=Uuid::new_v4();
                let expires:time::OffsetDateTime=sqlx::query_scalar("insert into account_link_requests(id,source_uuid,requested_target_uuid,authorized_org_id,expires_at) values($1,$2,$3,$4,now()+interval '14 days') returning expires_at").bind(id).bind(&uuid).bind(&target.uuid).bind(&org).fetch_one(&mut *tx).await?;
                result=json!({"request_id":id,"expires_at":accounts_core::timefmt::format_rfc3339_ms(expires)});
            },
            "notify-linked"=>{
                let proof=string(&body,"proof_token")?;
                let notification=body.get("notification").ok_or_else(||ApiError::unprocessable("notification_required","Provide the notification object."))?;
                let kind=string(notification,"type")?;
                if !kind.starts_with("silicon-organizations."){return Err(ApiError::unprocessable("invalid_notification_type","Use a Silicon Organizations notification type."))}
                let stable_key=string(notification,"key")?;
                let main=orgs::main_uuid(&mut tx,&uuid).await?;
                let recipients:Vec<String>=sqlx::query_scalar("select uuid from accounts where uuid<>$1 and status='active' and (uuid=$2 or uuid in(select account_uuid from account_links where main_uuid=$2) or uuid in(select recipient_uuid from organization_notification_accounts where account_uuid=$1 and expires_at>now())) order by uuid").bind(&uuid).bind(main).fetch_all(&mut *tx).await?;
                let base=std::env::var("ACCOUNTS_TING_URL").unwrap_or_else(|_|"https://ting.teamofsilicons.com".into());
                for recipient in &recipients{
                    let mut payload=notification.clone();payload["for"]=json!(recipient);payload["key"]=json!(format!("{stable_key}:linked:{recipient}"));
                    let response=state.http.post(format!("{}/v1/tings",base.trim_end_matches('/'))).bearer_auth(proof).json(&payload).send().await.map_err(|_|ApiError::unavailable("ting_unavailable","Ting could not be reached; retry this notification with the same key."))?;
                    if !response.status().is_success(){return Err(ApiError::unavailable("ting_delivery_failed",format!("Ting refused a linked-account notification (HTTP {}). Retry the same notification after its subscription or service access is available.",response.status().as_u16())))}
                }
                sqlx::query("delete from organization_notification_accounts where account_uuid=$1").bind(&uuid).execute(&mut *tx).await?;
                result=json!({"delivered":recipients.len()});
            },
            "rename"=>{let handle=accounts_core::ids::validate_handle(string(&body,"handle")?).map_err(|e|accounts::invalid_id_error(&e))?;
                reserve_work_handle(&mut tx,&org,&handle,Some(&uuid)).await?;
                let id=accounts_core::ids::AccountId::parse(&format!("{}{handle}.{org}",account.kind.prefix())).map_err(|e|accounts::invalid_id_error(&e))?;
                let change=accounts::change_id(&mut tx,&uuid,&id,"organization").await?;
                if change.changed{accounts_core::events::notify_id_changed(&mut tx,&change.account,&change.old_id,&change.new_id).await?;}
                result=account_value(&mut tx,&change.account).await?;
            },
            "stk"=>{if !account.is_silicon(){return Err(ApiError::unprocessable("silicon_required","Only Silicons have an STK."))}
                accounts::lock(&mut tx,&uuid).await?;let stk=accounts_core::crypto::stk::generate();let hash=state.keys.stk.hash_async(stk.clone()).await?;
                accounts::set_stk(&mut tx,&uuid,&hash).await?;
                let families=tokens::revoke_families(&mut tx,&tokens::RevokeFilter{account_uuid:&uuid,..Default::default()},"stk_rotated").await?;
                sessions::revoke_all(&mut tx,&uuid,None).await?;accounts_core::events::signed_out_for_families(&mut tx,&families,"stk_rotated").await?;
                result=json!({"stk":stk});
            },
            "close"=>{accounts::delete_account(&mut tx,&state.settings,&uuid,"organization",true).await?;},
            "profile"=>{let display=body.get("display_name").and_then(Value::as_str);let timezone=body.get("timezone").and_then(Value::as_str);
                if let Some(v)=display{accounts_core::normalize::validate_display_name(v).map_err(|e|ApiError::unprocessable("invalid_display_name",e))?;}let timezone=timezone.map(accounts_core::normalize::normalize_timezone).transpose().map_err(|e|ApiError::unprocessable("invalid_timezone",e))?;
                let photo=match body.get("pfp_url") {None=>None,Some(Value::Null)=>Some(accounts_core::pfp::default_pfp_url(&state.settings.iris_base_url,account.kind,&uuid)),Some(Value::String(url))=>{accounts_core::normalize::validate_https_url(url).map_err(|e|ApiError::unprocessable("invalid_pfp_url",e))?;Some(url.clone())},_=>return Err(ApiError::unprocessable("invalid_pfp_url","Use an HTTPS URL or null to reset the photo."))};
                sqlx::query("update accounts set display_name=coalesce($2,display_name),timezone=coalesce($3,timezone),pfp_url=coalesce($4,pfp_url),updated_at=now(),version=version+1 where uuid=$1").bind(&uuid).bind(display).bind(timezone).bind(photo).execute(&mut *tx).await?;
                let a=accounts::require(&mut tx,&uuid).await?;accounts_core::events::notify_profile_updated(&mut tx,&a,&[accounts_core::models::AccountField::DisplayName,accounts_core::models::AccountField::Timezone,accounts_core::models::AccountField::PfpUrl]).await?;
                result=account_value(&mut tx,&a).await?;
            },
            _=>return Err(ApiError::not_found("unknown_account_action","Use rename, profile, stk, close, link-request or notify-linked.")),
        }
        orgs::record(&mut tx,&uuid,None,None,&format!("account.{action}"),json!({})).await?;
        durable_save(&mut tx,&state,&scope,key.as_deref(),&fingerprint,&result).await?;
        tx.commit().await?;Ok((StatusCode::OK,result))
    }).await
}
#[derive(Deserialize)]
struct EventsQuery {
    #[serde(default)]
    after: i64,
    limit: Option<i64>,
}
async fn events(
    State(state): State<AppState>,
    auth: AppAuth,
    Query(q): Query<EventsQuery>,
) -> ApiResult<Json<Value>> {
    service(&auth)?;
    let items:Vec<Value>=sqlx::query_scalar("select jsonb_build_object('cursor',cursor,'event_id',event_id,'org_id',org_id,'account_uuid',account_uuid,'actor_id',actor_id,'app_id',app_id,'kind',kind,'details',details,'occurred_at',occurred_at) from organization_work_events where cursor>$1 order by cursor limit $2").bind(q.after).bind(q.limit.unwrap_or(200).clamp(1,1000)).fetch_all(&state.db).await?;
    let next = items
        .last()
        .and_then(|i| i["cursor"].as_i64())
        .unwrap_or(q.after);
    Ok(Json(json!({"items":items,"next_cursor":next})))
}
async fn linked(State(state): State<AppState>, auth: AccountAuth) -> ApiResult<Json<Value>> {
    let mut conn = state.db.acquire().await?;
    Ok(Json(
        orgs::linked_accounts(&mut conn, auth.uuid(), None).await?,
    ))
}
async fn link_requests(State(state): State<AppState>, auth: AccountAuth) -> ApiResult<Json<Value>> {
    let items:Vec<Value>=sqlx::query_scalar("select jsonb_build_object('id',r.id,'source',jsonb_build_object('uuid',s.uuid,'id',s.handle,'kind',s.kind,'display_name',s.display_name,'org',jsonb_build_object('org_id',o.org_id,'name',o.name,'logo_url',o.logo_url)),'target',jsonb_build_object('uuid',t.uuid,'id',t.handle,'kind',t.kind,'display_name',t.display_name),'expires_at',r.expires_at) from account_link_requests r join accounts s on s.uuid=r.source_uuid join accounts t on t.uuid=r.requested_target_uuid join organization_projections o on o.org_id=r.authorized_org_id where (t.uuid=$1 or t.custodian_uuid=$1) and s.status='active' and t.status='active' and r.completed_at is null and r.declined_at is null and r.expires_at>now() order by r.expires_at,r.id").bind(auth.uuid()).fetch_all(&state.db).await?;
    Ok(Json(json!({"items":items})))
}
async fn link_request_action(
    State(state): State<AppState>,
    auth: AccountAuth,
    Path((id, action)): Path<(Uuid, String)>,
) -> ApiResult<Json<Value>> {
    if action != "accept" && action != "decline" {
        return Err(ApiError::unprocessable(
            "invalid_action",
            "Use accept or decline.",
        ));
    }
    let mut tx = state.db.begin().await?;
    let row:Option<(String,String,Option<time::OffsetDateTime>,Option<time::OffsetDateTime>)>=sqlx::query_as("select source_uuid,requested_target_uuid,completed_at,declined_at from account_link_requests where id=$1 and authorized_org_id is not null and expires_at>now() for update").bind(id).fetch_optional(&mut *tx).await?;
    let (source, target, completed, declined) = row.ok_or_else(|| {
        ApiError::gone(
            "link_request_unavailable",
            "This link request expired or was not found.",
        )
    })?;
    let target_account = accounts::require(&mut tx, &target).await?;
    if !target_account.is_active()
        || (auth.uuid() != target && target_account.custodian_uuid.as_deref() != Some(auth.uuid()))
    {
        return Err(ApiError::forbidden(
            "link_recipient_required",
            "Only the personal Silicon or its current custodian may decide this request.",
        ));
    }
    if completed.is_some() || declined.is_some() {
        let status = if completed.is_some() {
            "accepted"
        } else {
            "declined"
        };
        if (action == "accept") != completed.is_some() {
            return Err(ApiError::conflict(
                "link_request_decided",
                "This request was already decided.",
            ));
        }
        return Ok(Json(json!({"status":status})));
    }
    if action == "accept" {
        orgs::link(&mut tx, &source, &target).await?;
        sqlx::query(
            "update account_link_requests set completed_at=now(),target_uuid=$2 where id=$1",
        )
        .bind(id)
        .bind(&target)
        .execute(&mut *tx)
        .await?;
    } else {
        sqlx::query("update account_link_requests set declined_at=now() where id=$1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    orgs::record(
        &mut tx,
        &source,
        Some(auth.uuid()),
        None,
        if action == "accept" {
            "account.link_accepted"
        } else {
            "account.link_declined"
        },
        json!({}),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(
        json!({"status":if action=="accept"{"accepted"}else{"declined"}}),
    ))
}
async fn link(
    State(state): State<AppState>,
    auth: AccountAuth,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let mut tx = state.db.begin().await?;
    let target = tokens::verify_access_token(
        &mut tx,
        &state.keys,
        string(&body, "target_access_token")?,
        Some(accounts_core::FIRST_PARTY_APP_ID),
    )
    .await?;
    orgs::link(&mut tx, auth.uuid(), &target.account.uuid).await?;
    let v = orgs::linked_accounts(&mut tx, auth.uuid(), None).await?;
    tx.commit().await?;
    Ok(Json(v))
}
async fn link_start(State(state): State<AppState>, auth: AccountAuth) -> ApiResult<Json<Value>> {
    let id = Uuid::new_v4();
    sqlx::query(
        "insert into account_link_requests(id,source_uuid,source_session) values($1,$2,$3)",
    )
    .bind(id)
    .bind(auth.uuid())
    .bind(auth.session_id())
    .execute(&state.db)
    .await?;
    Ok(Json(
        json!({"link_id":id,"authorize_url":format!("{}/sign-in?prompt=login&link_id={id}",state.settings.public_url.trim_end_matches('/'))}),
    ))
}
async fn link_complete(
    State(state): State<AppState>,
    auth: AccountAuth,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let id = Uuid::parse_str(string(&body, "link_id")?)
        .map_err(|_| ApiError::unprocessable("invalid_link_id", "link_id must be a UUID."))?;
    let mut tx = state.db.begin().await?;
    let row:Option<(String,Option<String>)>=sqlx::query_as("select source_uuid,target_uuid from account_link_requests where id=$1 and expires_at>now() and completed_at is null for update").bind(id).fetch_optional(&mut *tx).await?;
    let (source, target) = row.ok_or_else(|| {
        ApiError::gone(
            "link_expired",
            "This account linking request expired or was already used.",
        )
    })?;
    let target = target.ok_or_else(|| {
        ApiError::conflict(
            "link_authentication_required",
            "Sign in to the other account before confirming the link.",
        )
    })?;
    if auth.uuid() != source {
        return Err(ApiError::forbidden(
            "link_account_mismatch",
            "This linking request belongs to different accounts.",
        ));
    }
    let live:bool=sqlx::query_scalar("select exists(select 1 from account_link_requests r join browser_sessions s on s.id=r.source_session where r.id=$1 and s.account_uuid=r.source_uuid and s.revoked_at is null and s.expires_at>now())").bind(id).fetch_one(&mut *tx).await?;
    if !live {
        return Err(ApiError::unauthenticated(
            "link_initiator_expired",
            "The original session ended. Begin linking again.",
        ));
    }
    orgs::link(&mut tx, &source, &target).await?;
    sqlx::query("update account_link_requests set completed_at=now() where id=$1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    let v = orgs::linked_accounts(&mut tx, auth.uuid(), None).await?;
    tx.commit().await?;
    Ok(Json(v))
}
async fn switched(
    state: &AppState,
    auth: &AccountAuth,
    meta: &ClientMeta,
    target: &Account,
) -> ApiResult<Response> {
    let mut tx = state.db.begin().await?;
    let target = sqlx::query_as::<_, Account>(concat!(
        "select ",
        accounts_core::account_columns!(),
        " from accounts where uuid=$1 for share"
    ))
    .bind(&target.uuid)
    .fetch_one(&mut *tx)
    .await?;
    if !orgs::linked(&mut tx, auth.uuid(), &target.uuid).await? {
        return Err(ApiError::forbidden(
            "account_not_linked",
            "Prove control of both accounts and link them before switching.",
        ));
    }
    if !target.is_active() {
        return Err(ApiError::forbidden(
            "account_not_active",
            "This account is no longer active.",
        ));
    }
    let view = accounts_core::views::load_me(&mut tx, &target).await?;
    let response = if auth.is_cookie() {
        let (token, _) = sessions::create(
            &mut tx,
            &state.keys.pepper,
            &target.uuid,
            meta.ip.as_deref(),
            meta.user_agent.as_deref(),
        )
        .await?;
        let mut response = Json(view).into_response();
        append_cookie(
            response.headers_mut(),
            &session_cookie(&state.settings, &token),
        );
        response
    } else {
        let tokens = tokens::issue_tokens(
            &mut tx,
            &state.keys,
            &state.settings,
            tokens::IssueRequest {
                account: &target,
                app_id: accounts_core::FIRST_PARTY_APP_ID,
                scopes: &[accounts_core::models::Scope::Profile],
                origin: TokenOrigin::CliCode,
                browser_session_id: None,
                label: Some("Linked account"),
                ip: meta.ip.as_deref(),
                user_agent: meta.user_agent.as_deref(),
                nonce: None,
                auth_time: None,
            },
        )
        .await?;
        Json(json!({"account":view,"tokens":tokens})).into_response()
    };
    tx.commit().await?;
    Ok(response)
}
async fn switch(
    State(state): State<AppState>,
    auth: AccountAuth,
    meta: ClientMeta,
    Json(body): Json<Value>,
) -> ApiResult<Response> {
    let mut conn = state.db.acquire().await?;
    let target = accounts::require(&mut conn, string(&body, "account_uuid")?).await?;
    drop(conn);
    switched(&state, &auth, &meta, &target).await
}
async fn personal(
    State(state): State<AppState>,
    auth: AccountAuth,
    meta: ClientMeta,
    key: Option<IdempotencyKey>,
    Json(body): Json<Value>,
) -> ApiResult<Response> {
    if auth.kind() != AccountKind::Carbon {
        return Err(ApiError::forbidden(
            "carbon_required",
            "A Silicon personal account must be created with its own Carbon custodian, then linked.",
        ));
    }
    let response = idempotency::run(
        &state,
        None,
        &format!("account:{}:personal", auth.uuid()),
        &body,
        false,
        || async {
            let scope = format!("account:{}:personal", auth.uuid());
            let mut tx = state.db.begin().await?;
            if let Some(saved) =
                durable_replay(&mut tx, &state, &scope, key.as_deref(), &body).await?
            {
                tx.commit().await?;
                return Ok((StatusCode::CREATED, saved));
            }
            sqlx::query("select pg_advisory_xact_lock(73002912)")
                .execute(&mut *tx)
                .await?;
            if orgs::org_id(&mut tx, auth.uuid()).await?.is_none() {
                return Err(ApiError::conflict(
                    "personal_account_exists",
                    "This account is already a personal account.",
                ));
            }
            let main = orgs::main_uuid(&mut tx, auth.uuid()).await?;
            if orgs::org_id(&mut tx, &main).await?.is_none() {
                return Err(ApiError::conflict(
                    "personal_account_exists",
                    "Your linked accounts already have a personal account.",
                ));
            }
            let id = accounts_core::ids::AccountId::parse_for_kind(
                string(&body, "id")?,
                AccountKind::Carbon,
            )
            .map_err(|e| accounts::invalid_id_error(&e))?;
            let name = body
                .get("display_name")
                .and_then(Value::as_str)
                .unwrap_or(&auth.account.display_name);
            accounts_core::normalize::validate_display_name(name)
                .map_err(|e| ApiError::unprocessable("invalid_display_name", e))?;
            let account = accounts::create_carbon(
                &mut tx,
                &state.settings,
                accounts::NewCarbon {
                    id,
                    display_name: name.into(),
                    pfp_url: None,
                    dob: auth.account.dob,
                    timezone: auth.account.timezone.clone(),
                    status: AccountStatus::Active,
                    emails: vec![],
                    phones: vec![],
                    actor: auth.uuid().into(),
                },
            )
            .await?;
            orgs::link(&mut tx, auth.uuid(), &account.uuid).await?;
            let result = json!({"uuid":account.uuid});
            durable_save(&mut tx, &state, &scope, key.as_deref(), &body, &result).await?;
            tx.commit().await?;
            Ok((StatusCode::CREATED, result))
        },
    )
    .await?;
    // Keep the idempotent operation's response stable; clients switch explicitly using its UUID.
    let _ = meta;
    Ok(response)
}

/// Bridge receipts commit with the work they recover, independent of the HTTP replay cache.
pub(super) async fn durable_replay(
    conn: &mut PgConnection,
    state: &AppState,
    scope: &str,
    key: Option<&str>,
    body: &Value,
) -> ApiResult<Option<Value>> {
    let Some(key) = key else { return Ok(None) };
    sqlx::query("select pg_advisory_xact_lock(hashtextextended($1,192847))")
        .bind(format!("{scope}:{key}"))
        .execute(&mut *conn)
        .await?;
    let saved:Option<(Vec<u8>,Value,bool)>=sqlx::query_as("select request_hash,response,expires_at<=now() from organization_bridge_receipts where scope=$1 and key_hash=$2").bind(scope).bind(state.keys.pepper.hash(key)).fetch_optional(&mut *conn).await?;
    let Some((hash, response, expired)) = saved else {
        return Ok(None);
    };
    if hash != idempotency::request_hash(body) {
        return Err(ApiError::conflict(
            "idempotency_key_reused",
            "This operation key belongs to a different request.",
        ));
    }
    if expired {
        return Err(ApiError::conflict(
            "operation_result_expired",
            "This operation already completed, but its private result expired. Reconcile its existing resource; do not repeat creation.",
        ));
    }
    let result = idempotency::unseal(&state.keys.keyring, scope, key, &response)?;
    if let Some(uuid) = result
        .get("account")
        .and_then(|a| a.get("uuid"))
        .and_then(Value::as_str)
    {
        let account = accounts::require(conn, uuid).await?;
        if !account.is_active() {
            return Err(ApiError::conflict(
                "operation_account_closed",
                "This operation's account has since been closed.",
            ));
        }
        if let Some(slt) = result.get("slt").and_then(Value::as_str) {
            // A lost creation response must not strand a proved guest after the SLT's
            // ordinary two-minute window. Spent grants keep their original value so
            // the separately keyed exchange receipt can recover the same session.
            sqlx::query("update short_lived_tokens set expires_at=now()+interval '2 minutes' where token_hash=$1 and account_uuid=$2 and app_id='silicon-organizations' and consumed_at is null").bind(state.keys.pepper.hash(slt)).bind(uuid).execute(&mut *conn).await?;
        }
    }
    Ok(Some(result))
}
pub(super) async fn durable_save(
    conn: &mut PgConnection,
    state: &AppState,
    scope: &str,
    key: Option<&str>,
    body: &Value,
    response: &Value,
) -> ApiResult<()> {
    let Some(key) = key else { return Ok(()) };
    let sealed = idempotency::seal(&state.keys.keyring, scope, key, response)?;
    sqlx::query("insert into organization_bridge_receipts(scope,key_hash,request_hash,response) values($1,$2,$3,$4)").bind(scope).bind(state.keys.pepper.hash(key)).bind(idempotency::request_hash(body)).bind(sealed).execute(conn).await?;
    Ok(())
}
