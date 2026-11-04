//! The authenticated registry-to-Accounts bridge for Interface auth configuration.
//!
//! This stores configuration only: it does not issue interface or app tokens.
//! The registry checks accepted authorship before asserting an actor UUID.
use accounts_core::delivery::{self, NewMessage};
use accounts_core::http::{IdempotencyKey, Json};
use accounts_core::models::{AccountStatus, ActorKind, MessageChannel};
use accounts_core::repo::audit;
use accounts_core::repo::{accounts, apps, idempotency};
use accounts_core::secrecy::ExposeSecret;
use accounts_core::{ApiError, ApiResult, AppState, crypto};
use axum::{
    Router,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

fn authorize_interface_service(state: &AppState, headers: &HeaderMap) -> ApiResult<()> {
    let expected = state
        .settings
        .interfaces_internal_token
        .as_ref()
        .ok_or_else(|| {
            ApiError::forbidden(
                "interface_internal_api_disabled",
                "The Interface service credential is not configured.",
            )
        })?;
    let presented = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().split_once(' '))
        .and_then(|(scheme, token)| scheme.eq_ignore_ascii_case("bearer").then(|| token.trim()))
        .filter(|token| !token.is_empty())
        .ok_or_else(|| {
            ApiError::unauthenticated(
                "internal_token_required",
                "An Interface service credential is required.",
            )
        })?;
    let a = crypto::sha256(presented.as_bytes());
    let b = crypto::sha256(expected.expose_secret().as_bytes());
    if !crypto::constant_time_eq(&a, &b) {
        return Err(ApiError::unauthenticated(
            "invalid_internal_token",
            "The Interface service credential is invalid.",
        ));
    }
    Ok(())
}

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/internal/interfaces/sync", post(sync))
        .route("/v1/internal/interfaces/sync/ack", post(ack_sync))
        .route(
            "/v1/internal/interfaces/eligibility/{uuid}",
            get(eligibility),
        )
        .route("/v1/internal/interfaces/accounts/{id}", get(account))
        .route(
            "/v1/internal/interfaces/{id}/requests",
            get(list_requests).post(request_tier),
        )
}

fn no_store(status: StatusCode, body: Value) -> Response {
    let mut response = (status, axum::Json(body)).into_response();
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("no-store"),
    );
    response
}

async fn active_account(
    conn: &mut sqlx::PgConnection,
    id: &str,
) -> ApiResult<accounts_core::models::Account> {
    let account = if id.starts_with("c:") || id.starts_with("si:") {
        accounts::by_handle(conn, id).await?
    } else {
        accounts::get(conn, id).await?
    }
    .ok_or_else(|| ApiError::not_found("account_not_found", "The account was not found."))?;
    if account.status != AccountStatus::Active {
        return Err(ApiError::forbidden(
            "account_not_active",
            "The account is not active.",
        ));
    }
    Ok(account)
}

async fn account(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult<Response> {
    authorize_interface_service(&state, &headers)?;
    let mut conn = state.db.acquire().await?;
    let account = active_account(&mut conn, &id).await?;
    Ok(no_store(
        StatusCode::OK,
        json!({"uuid":account.uuid,"id":account.handle,"display_name":account.display_name,"pfp_url":account.pfp_url}),
    ))
}

async fn eligibility(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(uuid): Path<String>,
) -> ApiResult<Response> {
    authorize_interface_service(&state, &headers)?;
    let mut conn = state.db.acquire().await?;
    let actor = active_account(&mut conn, &uuid).await?;
    let (verified, trusted): (bool, bool) = sqlx::query_as(
        "select verified,trusted from interface_creator_eligibility where account_uuid=$1",
    )
    .bind(&actor.uuid)
    .fetch_optional(&mut *conn)
    .await?
    .unwrap_or((false, false));
    Ok(no_store(
        StatusCode::OK,
        json!({"verified":verified,"trusted":trusted}),
    ))
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Sync {
    interface_id: String,
    actor_uuid: String,
    revision: i64,
    name: String,
    logo_url: Option<String>,
    kind: String,
    app_ids: Vec<String>,
    redirect_uris: Vec<String>,
    allowed_origins: Vec<String>,
    branding: Value,
    #[serde(default = "empty_object")]
    signin_config: Value,
    app_descriptions: Value,
    active: bool,
    #[serde(default)]
    rotate_secret: bool,
}

fn empty_object() -> Value {
    json!({})
}

/// Cell development domains use subdomains of localhost. Only that exact DNS
/// suffix is permitted over HTTP; all other structural rules remain unchanged.
fn validate_interface_url(value: &str, origin: bool) -> Result<(), String> {
    use accounts_core::models::signin_config::{
        is_valid_domain, validate_origin, validate_redirect_uri,
    };
    let validate = |v: &str| {
        if origin {
            validate_origin(v)
        } else {
            validate_redirect_uri(v)
        }
    };
    match validate(value) {
        Ok(()) => Ok(()),
        Err(original) => {
            let mut url = url::Url::parse(value).map_err(|_| original.clone())?;
            let local = url.scheme() == "http"
                && url
                    .host_str()
                    .is_some_and(|host| host.ends_with(".localhost") && is_valid_domain(host));
            if !local || !url.username().is_empty() || url.password().is_some() {
                return Err(original);
            }
            url.set_scheme("https").map_err(|_| original.clone())?;
            validate(url.as_str())
        }
    }
}

fn validate(input: &Sync) -> ApiResult<()> {
    let valid_id = (3..=64).contains(&input.interface_id.len())
        && input
            .interface_id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-');
    if !valid_id
        || input.revision < 1
        || input.name.trim().is_empty()
        || input.name.chars().count() > 200
        || input.name.contains('\0')
    {
        return Err(ApiError::invalid_request(
            "Provide a valid interface ID, positive revision, and name of at most 200 characters.",
        ));
    }
    if !["unverified", "verified", "trusted"].contains(&input.kind.as_str()) {
        return Err(ApiError::invalid_request(
            "kind must be unverified, verified or trusted.",
        ));
    }
    if input.app_ids.len() > 100 || (input.kind != "trusted" && input.app_ids.is_empty()) {
        return Err(ApiError::invalid_request(
            "An unverified or verified interface must name 1 to 100 apps.",
        ));
    }
    let unique: std::collections::HashSet<_> = input.app_ids.iter().collect();
    if unique.len() != input.app_ids.len()
        || input
            .app_ids
            .iter()
            .any(|s| s == "silicon-accounts" || s == "developer")
    {
        return Err(ApiError::invalid_request(
            "App IDs must be unique and cannot delegate Accounts or Developer identity privileges.",
        ));
    }
    if input.redirect_uris.len() > 100 || input.allowed_origins.len() > 100 {
        return Err(ApiError::invalid_request(
            "At most 100 redirect URIs and origins are allowed.",
        ));
    }
    for uri in &input.redirect_uris {
        validate_interface_url(uri, false).map_err(ApiError::invalid_request)?;
    }
    for origin in &input.allowed_origins {
        validate_interface_url(origin, true).map_err(ApiError::invalid_request)?;
    }
    if input
        .signin_config
        .get("public_client")
        .is_some_and(|v| !v.is_boolean())
    {
        return Err(ApiError::invalid_request(
            "signin_config.public_client must be a boolean.",
        ));
    }
    if !input.branding.is_object()
        || !input.signin_config.is_object()
        || !input.app_descriptions.is_object()
    {
        return Err(ApiError::invalid_request(
            "branding, signin_config and app_descriptions must be JSON objects.",
        ));
    }
    let mut patch = serde_json::Map::new();
    patch.insert("branding".into(), input.branding.clone());
    for (key, value) in input.signin_config.as_object().expect("checked object") {
        if ![
            "public_client",
            "methods",
            "method_order",
            "copy",
            "required_fields",
            "optional_fields",
            "flow",
            "allow_signup",
            "remember_browser",
            "allowed_email_domains",
        ]
        .contains(&key.as_str())
        {
            return Err(ApiError::invalid_request(format!(
                "The interface sign-in setting '{key}' is not supported."
            )));
        }
        if key != "public_client" {
            patch.insert(key.clone(), value.clone());
        }
    }
    accounts_core::models::SigninConfig::default()
        .apply_patch(
            &Value::Object(patch),
            accounts_core::models::signin_config::ConfigSecretsPresent::default(),
        )
        .map_err(ApiError::validation)?;
    if input.app_descriptions.as_object().is_some_and(|m| {
        m.iter().any(|(id, value)| {
            (!input.app_ids.contains(id) && input.kind != "trusted")
                || value.as_str().is_none_or(|s| {
                    s.chars().count() > 500 || s.chars().any(|c| c.is_control() && c != '\n')
                })
        })
    }) {
        return Err(ApiError::invalid_request(
            "App descriptions must map named app IDs to plain text of at most 500 characters.",
        ));
    }
    Ok(())
}

async fn sync(
    State(state): State<AppState>,
    headers: HeaderMap,
    key: IdempotencyKey,
    Json(input): Json<Sync>,
) -> ApiResult<Response> {
    authorize_interface_service(&state, &headers)?;
    validate(&input)?;
    let mut tx = state.db.begin().await?;
    active_account(&mut tx, &input.actor_uuid).await?;
    sqlx::query("select pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(format!("interface-sync:{}", input.interface_id))
        .execute(&mut *tx)
        .await?;
    let hash = idempotency::request_hash(&input);
    let scope = format!("interface-sync:{}", input.interface_id);
    let prior: Option<(Vec<u8>, Value)> = sqlx::query_as("select request_hash,sealed_response from interface_sync_operations where interface_id=$1 and key=$2")
        .bind(&input.interface_id).bind(key.as_str()).fetch_optional(&mut *tx).await?;
    if let Some((stored_hash, sealed)) = prior {
        if stored_hash != hash {
            return Err(ApiError::conflict(
                "idempotency_key_reused",
                "This key was used for a different interface sync.",
            ));
        }
        let body = idempotency::unseal(&state.keys.keyring, &scope, key.as_str(), &sealed)?;
        tx.commit().await?;
        return Ok(no_store(StatusCode::OK, body));
    }
    let old: Option<(String,i64,String,Vec<String>)> = sqlx::query_as("select owner_uuid,revision,kind,app_ids from interface_auth_clients where interface_id=$1 for update")
        .bind(&input.interface_id).fetch_optional(&mut *tx).await?;
    if old
        .as_ref()
        .is_some_and(|(_, revision, _, _)| input.revision <= *revision)
    {
        return Err(ApiError::conflict(
            "interface_revision_conflict",
            "This interface revision is stale or already applied.",
        ));
    }
    let rank = |kind: &str| match kind {
        "trusted" => 2,
        "verified" => 1,
        _ => 0,
    };
    if old
        .as_ref()
        .map_or(true, |(_, _, kind, _)| rank(&input.kind) > rank(kind))
    {
        let allowed: Option<(bool, bool)> = sqlx::query_as(
            "select verified,trusted from interface_creator_eligibility where account_uuid=$1",
        )
        .bind(&input.actor_uuid)
        .fetch_optional(&mut *tx)
        .await?;
        let (verified, trusted) = allowed.unwrap_or((false, false));
        if (input.kind == "verified" && !verified) || (input.kind == "trusted" && !trusted) {
            return Err(ApiError::forbidden(
                "interface_tier_not_allowed",
                "This account is not eligible to create or upgrade an interface to that tier.",
            ));
        }
    }
    for app_id in &input.app_ids {
        apps::require_active(&mut tx, app_id).await?;
    }
    let make_secret = old.is_none() || input.rotate_secret;
    let secret = make_secret.then(|| crypto::random_token("sif_secret_"));
    let secret_hash = secret.as_ref().map(|s| state.keys.pepper.hash(s));
    sqlx::query("insert into interface_auth_clients(interface_id,owner_uuid,revision,kind,name,logo_url,app_ids,redirect_uris,allowed_origins,branding,signin_config,app_descriptions,active,secret_hash) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,coalesce($14,(select secret_hash from interface_auth_clients where interface_id=$1))) on conflict(interface_id) do update set revision=excluded.revision,kind=excluded.kind,name=excluded.name,logo_url=excluded.logo_url,app_ids=excluded.app_ids,redirect_uris=excluded.redirect_uris,allowed_origins=excluded.allowed_origins,branding=excluded.branding,signin_config=excluded.signin_config,app_descriptions=excluded.app_descriptions,active=excluded.active,secret_hash=coalesce($14,interface_auth_clients.secret_hash),updated_at=now()")
        .bind(&input.interface_id).bind(&input.actor_uuid).bind(input.revision).bind(&input.kind).bind(&input.name).bind(&input.logo_url).bind(&input.app_ids).bind(&input.redirect_uris).bind(&input.allowed_origins).bind(&input.branding).bind(&input.signin_config).bind(&input.app_descriptions).bind(input.active).bind(&secret_hash).execute(&mut *tx).await?;
    if let Some((_, _, previous_kind, previous_apps)) = &old {
        let removed: Vec<String> = previous_apps
            .iter()
            .filter(|id| !input.app_ids.contains(id))
            .cloned()
            .collect();
        if !input.active
            || input.rotate_secret
            || previous_kind != &input.kind
            || !removed.is_empty()
        {
            sqlx::query("update interface_sessions set revoked_at=now(),revoke_reason='interface_configuration_changed' where interface_id=$1 and revoked_at is null and (not $2 or $3 or kind<>$4 or (kind<>'trusted' and approved_apps && $5))")
                .bind(&input.interface_id).bind(input.active).bind(input.rotate_secret).bind(&input.kind).bind(&removed).execute(&mut *tx).await?;
            sqlx::query("update token_families set revoked_at=coalesce(revoked_at,now()),revoke_reason=coalesce(revoke_reason,'interface_configuration_changed') where id in (select f.family_id from interface_app_token_families f join interface_sessions s on s.id=f.session_id where s.interface_id=$1 and s.revoked_at is not null)")
                .bind(&input.interface_id).execute(&mut *tx).await?;
            sqlx::query("update interface_token_operations set sealed_response=$2 where session_id in (select id from interface_sessions where interface_id=$1 and revoked_at is not null)")
                .bind(&input.interface_id).bind(json!({"$unavailable":true})).execute(&mut *tx).await?;
        }
    }
    let mut body =
        json!({"interface_id":input.interface_id,"kind":input.kind,"revision":input.revision});
    if let Some(secret) = secret {
        body["interface_secret"] = json!(secret);
    }
    let sealed = idempotency::seal(&state.keys.keyring, &scope, key.as_str(), &body)?;
    sqlx::query("insert into interface_sync_operations(interface_id,key,request_hash,sealed_response) values($1,$2,$3,$4)")
        .bind(&input.interface_id).bind(key.as_str()).bind(hash).bind(sealed).execute(&mut *tx).await?;
    audit::record(&mut tx, &audit::AuditEntry {
        account_uuid: Some(&input.actor_uuid),
        target_kind: Some("interface"), target_id: Some(&input.interface_id),
        details: json!({"revision":input.revision,"kind":input.kind,"active":input.active,"secret_rotated":make_secret}),
        ..audit::AuditEntry::new(ActorKind::Account, Some(&input.actor_uuid), "interface.auth.synced")
    }).await?;
    tx.commit().await?;
    Ok(no_store(StatusCode::OK, body))
}

#[derive(Deserialize)]
struct RequestQuery {
    actor_uuid: String,
}

async fn list_requests(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(query): Query<RequestQuery>,
) -> ApiResult<Response> {
    authorize_interface_service(&state, &headers)?;
    let mut conn = state.db.acquire().await?;
    active_account(&mut conn, &query.actor_uuid).await?;
    let exists: bool = sqlx::query_scalar(
        "select exists(select 1 from interface_auth_clients where interface_id=$1)",
    )
    .bind(&id)
    .fetch_one(&mut *conn)
    .await?;
    if !exists {
        return Err(ApiError::not_found(
            "interface_not_found",
            "The interface was not found.",
        ));
    }
    // A request is private to the requester, including when coauthors manage the same interface.
    let rows: Vec<Value> = sqlx::query_scalar("select jsonb_build_object('id',id,'interface_id',interface_id,'actor_uuid',actor_uuid,'kind',kind,'reason',reason,'status',status,'created_at',created_at,'reviewed_at',reviewed_at) from interface_tier_requests where actor_uuid=$1 and interface_id=$2 order by created_at desc")
        .bind(&query.actor_uuid).bind(&id).fetch_all(&mut *conn).await?;
    Ok(no_store(StatusCode::OK, json!({"requests":rows})))
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct TierRequest {
    actor_uuid: String,
    kind: String,
    reason: String,
}

async fn request_tier(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    key: IdempotencyKey,
    Json(input): Json<TierRequest>,
) -> ApiResult<Response> {
    authorize_interface_service(&state, &headers)?;
    let reason = input.reason.trim();
    if !["verified", "trusted"].contains(&input.kind.as_str())
        || reason.is_empty()
        || reason.chars().count() > 5000
        || reason.contains('\0')
    {
        return Err(ApiError::invalid_request(
            "Choose verified or trusted and provide a reason of 1 to 5,000 characters.",
        ));
    }
    let mut tx = state.db.begin().await?;
    let actor = active_account(&mut tx, &input.actor_uuid).await?;
    // Lock by actor+tier, since pending requests are shared across interfaces.
    sqlx::query("select pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(format!(
            "interface-tier-request:{}:{}",
            input.actor_uuid, input.kind
        ))
        .execute(&mut *tx)
        .await?;
    let exists: bool = sqlx::query_scalar(
        "select exists(select 1 from interface_auth_clients where interface_id=$1)",
    )
    .bind(&id)
    .fetch_one(&mut *tx)
    .await?;
    if !exists {
        return Err(ApiError::not_found(
            "interface_not_found",
            "The interface was not found.",
        ));
    }
    let hash = idempotency::request_hash(&input);
    let prior: Option<(Vec<u8>,uuid::Uuid,bool)> = sqlx::query_as("select request_hash,request_id,created from interface_tier_request_operations where interface_id=$1 and key=$2")
        .bind(&id).bind(key.as_str()).fetch_optional(&mut *tx).await?;
    let (request_id, created) = if let Some((prior_hash, request_id, created)) = prior {
        if prior_hash != hash {
            return Err(ApiError::conflict(
                "idempotency_key_reused",
                "This key was used for a different tier request.",
            ));
        }
        (request_id, created)
    } else {
        let existing: Option<uuid::Uuid> = sqlx::query_scalar("select id from interface_tier_requests where actor_uuid=$1 and kind=$2 and status='pending'")
            .bind(&input.actor_uuid).bind(&input.kind).fetch_optional(&mut *tx).await?;
        let (request_id, created) = if let Some(existing) = existing {
            (existing, false)
        } else {
            let request_id = uuid::Uuid::now_v7();
            sqlx::query("insert into interface_tier_requests(id,interface_id,actor_uuid,kind,reason) values($1,$2,$3,$4,$5)")
                .bind(request_id).bind(&id).bind(&input.actor_uuid).bind(&input.kind).bind(reason).execute(&mut *tx).await?;
            let email = accounts_core::repo::contacts::primary_email(&mut tx, &input.actor_uuid)
                .await?
                .filter(|email| email.verified)
                .map(|email| email.value);
            let body = format!(
                "Interface {} request {request_id}\n\nInterface: {id}\nRequester: {} ({})\nImmutable account UUID: {}\nVerified primary email: {}\n\nReason:\n{reason}\n\nThe request is pending; submission grants no eligibility or trust.",
                input.kind,
                actor.display_name,
                actor.display_id(),
                actor.uuid,
                email.as_deref().unwrap_or("Not available")
            );
            for recipient in ["lords@teamofsilicons.com", "saket@teamofsilicons.com"] {
                let message = delivery::enqueue(
                    &mut tx,
                    &state.settings,
                    &NewMessage {
                        channel: MessageChannel::Email,
                        to: recipient.into(),
                        subject: Some(format!("Interface {} request: {id}", input.kind)),
                        text_body: body.clone(),
                        html_body: None,
                        purpose: "interface_tier_request".into(),
                    },
                )
                .await?;
                sqlx::query("insert into interface_tier_request_notifications(request_id,recipient,message_id) values($1,$2,$3)")
                    .bind(request_id).bind(recipient).bind(message).execute(&mut *tx).await?;
            }
            audit::record(
                &mut tx,
                &audit::AuditEntry {
                    account_uuid: Some(&input.actor_uuid),
                    target_kind: Some("interface"),
                    target_id: Some(&id),
                    details: json!({"request_id":request_id,"kind":input.kind}),
                    ..audit::AuditEntry::new(
                        ActorKind::Account,
                        Some(&input.actor_uuid),
                        "interface.tier.requested",
                    )
                },
            )
            .await?;
            (request_id, true)
        };
        sqlx::query("insert into interface_tier_request_operations(interface_id,key,request_hash,request_id,created) values($1,$2,$3,$4,$5)")
            .bind(&id).bind(key.as_str()).bind(hash).bind(request_id).bind(created).execute(&mut *tx).await?;
        (request_id, created)
    };
    let view: Value = sqlx::query_scalar("select jsonb_build_object('id',id,'interface_id',interface_id,'actor_uuid',actor_uuid,'kind',kind,'reason',reason,'status',status,'created_at',created_at,'reviewed_at',reviewed_at) from interface_tier_requests where id=$1")
        .bind(request_id).fetch_one(&mut *tx).await?;
    tx.commit().await?;
    Ok(no_store(
        StatusCode::OK,
        json!({"request":view,"created":created}),
    ))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SyncAck {
    interface_id: String,
    key: String,
}
async fn ack_sync(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<SyncAck>,
) -> ApiResult<Response> {
    authorize_interface_service(&state, &headers)?;
    if input.key.is_empty()
        || input.key.len() > 200
        || !input.key.bytes().all(|b| (0x21..=0x7e).contains(&b))
    {
        return Err(ApiError::invalid_request(
            "A valid operation key is required.",
        ));
    }
    let mut tx = state.db.begin().await?;
    let saved:Option<Value>=sqlx::query_scalar("select sealed_response from interface_sync_operations where interface_id=$1 and key=$2 for update")
        .bind(&input.interface_id).bind(&input.key).fetch_optional(&mut *tx).await?;
    let sealed = saved.ok_or_else(|| {
        ApiError::not_found(
            "sync_operation_not_found",
            "This sync operation was not found.",
        )
    })?;
    let scope = format!("interface-sync:{}", input.interface_id);
    let mut result = idempotency::unseal(&state.keys.keyring, &scope, &input.key, &sealed)?;
    if let Some(map) = result.as_object_mut() {
        map.remove("interface_secret");
    }
    let cleaned = idempotency::seal(&state.keys.keyring, &scope, &input.key, &result)?;
    sqlx::query("update interface_sync_operations set sealed_response=$3,acknowledged_at=coalesce(acknowledged_at,now()) where interface_id=$1 and key=$2")
        .bind(&input.interface_id).bind(&input.key).bind(cleaned).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(no_store(StatusCode::OK, json!({"acknowledged":true})))
}
