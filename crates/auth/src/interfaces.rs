//! Interface authorization. The authenticated Accounts browser session owns
//! each approval; the interface itself never receives a Carbon's credentials.
use accounts_core::{
    ApiError, ApiResult, AppState,
    crypto::{self, pkce},
    http::{AccountAuth, IdempotencyKey, Json},
    models::{Account, ContactField, MembershipSource, Scope, TokenOrigin},
    repo::{
        accounts, apps, contacts, idempotency,
        memberships::{self, GrantMode},
        organizations,
        tokens::{self, IssueRequest},
    },
};
use axum::{
    Router,
    extract::{Path, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::PgConnection;
use uuid::Uuid;

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/interface-auth/{id}/info", get(info))
        .route("/v1/verified-interface-auth/start", post(verified_start))
        .route("/v1/verified-interface-auth/action", post(verified_action))
        .route("/v1/interface-auth/flows", post(start))
        .route("/v1/interface-auth/flows/{flow}/decision", post(decide))
        .route("/v1/interface-auth/token", post(token))
        .route("/v1/interface-auth/revoke", post(revoke))
        .route("/v1/interface-auth/introspect", post(introspect))
        .route("/v1/me/interface-sessions", get(my_sessions))
        .route(
            "/v1/me/interface-sessions/{session}",
            axum::routing::delete(remove_my_session),
        )
        .route(
            "/v1/me/interfaces/{id}",
            axum::routing::delete(remove_my_interface),
        )
}

fn response(body: Value) -> Response {
    let mut r = (StatusCode::OK, axum::Json(body)).into_response();
    r.headers_mut().insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("no-store"),
    );
    r
}

#[derive(sqlx::FromRow)]
struct Client {
    interface_id: String,
    revision: i64,
    kind: String,
    name: String,
    logo_url: Option<String>,
    app_ids: Vec<String>,
    redirect_uris: Vec<String>,
    allowed_origins: Vec<String>,
    branding: Value,
    signin_config: Value,
    app_descriptions: Value,
    active: bool,
    secret_hash: Vec<u8>,
}
async fn client(conn: &mut PgConnection, id: &str) -> ApiResult<Client> {
    let c = sqlx::query_as::<_,Client>("select interface_id,revision,kind,name,logo_url,app_ids,redirect_uris,allowed_origins,branding,signin_config,app_descriptions,active,secret_hash from interface_auth_clients where interface_id=$1 for share")
        .bind(id).fetch_optional(conn).await?.ok_or_else(||ApiError::not_found("interface_not_found","This interface is not registered."))?;
    if !c.active {
        return Err(ApiError::forbidden(
            "interface_disabled",
            "This interface is not accepting sign-ins.",
        ));
    }
    Ok(c)
}

async fn info(State(state): State<AppState>, Path(id): Path<String>) -> ApiResult<Response> {
    let mut conn = state.db.acquire().await?;
    let c = client(&mut conn, &id).await?;
    Ok(response(
        json!({"interface_id":c.interface_id,"name":c.name,"logo_url":c.logo_url,"branding":c.branding}),
    ))
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct InterfaceBinding {
    pub interface_id: String,
    pub redirect_uri: String,
    pub state: String,
    pub code_challenge: String,
}
pub(crate) fn binding_hash(state: &AppState, binding: &InterfaceBinding) -> String {
    crypto::b64url(
        &state
            .keys
            .pepper
            .hash(&serde_json::to_string(binding).unwrap_or_default()),
    )
}
fn signin_policy(config: &Value) -> Value {
    let mut policy = serde_json::Map::new();
    for key in [
        "required_fields",
        "optional_fields",
        "flow",
        "allow_signup",
        "remember_browser",
        "allowed_email_domains",
    ] {
        if let Some(value) = config.get(key) {
            policy.insert(key.into(), value.clone());
        }
    }
    Value::Object(policy)
}
fn requires_interface_signin(config: &Value) -> bool {
    [
        "required_fields",
        "optional_fields",
        "allowed_email_domains",
    ]
    .iter()
    .any(|key| {
        config
            .get(key)
            .and_then(Value::as_array)
            .is_some_and(|v| !v.is_empty())
    }) || config.get("flow").is_some_and(|v| !v.is_null())
        || config.get("allow_signup") == Some(&json!(false))
        || config.get("remember_browser") == Some(&json!(false))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Start {
    interface_id: String,
    redirect_uri: String,
    state: String,
    code_challenge: String,
    code_challenge_method: String,
    #[serde(default)]
    signin_proof: Option<String>,
}

/// Accounts, Developer and Silicon Apps tokens manage accounts and apps; an Interface never gets one.
fn delegation_forbidden() -> ApiError {
    ApiError::forbidden(
        "first_party_delegation_forbidden",
        "Accounts, Developer and Silicon Apps privileges cannot be delegated.",
    )
}

/// Builds precisely what the Carbon is asked to authorize, including target app
/// details. A missing required email/phone or a work policy denial fails closed.
async fn descriptors(
    conn: &mut PgConnection,
    state: &AppState,
    c: &Client,
    account: &Account,
    ids: &[String],
) -> ApiResult<Vec<Value>> {
    let mut result = Vec::with_capacity(ids.len());
    for id in ids {
        // Checked here, where every grant passes (start, consent, code exchange, refresh), and not
        // only when the registry lists the apps: a stored row must not be able to slip one through.
        if accounts_core::is_privileged_app_id(id) {
            return Err(delegation_forbidden());
        }
        let app = apps::require_active(conn, id).await?;
        organizations::check(conn, &account.uuid, id).await?;
        let config = apps::effective_config(conn, &state.settings, id).await?;
        if !super::flow::next::account_domain_allowed(conn, &config, account).await? {
            return Err(ApiError::forbidden(
                "email_domain_not_allowed",
                format!("{} does not accept this account's email domain.", app.name),
            ));
        }
        for field in &config.required_fields {
            let present = match field {
                ContactField::Email => contacts::primary_email(conn, &account.uuid)
                    .await?
                    .is_some_and(|c| c.verified),
                ContactField::Phone => contacts::primary_phone(conn, &account.uuid)
                    .await?
                    .is_some_and(|c| c.verified),
                ContactField::Dob | ContactField::Timezone => true,
            };
            if !present {
                return Err(ApiError::forbidden(
                    "required_detail_missing",
                    format!(
                        "{} requires {}. Add it to your account before signing in.",
                        app.name,
                        field.label()
                    ),
                )
                .detail("field", field.as_str())
                .detail("app_id", id.as_str()));
            }
        }
        let scopes: Vec<&str> = std::iter::once("profile")
            .chain(config.required_fields.iter().map(|f| f.scope().as_str()))
            .collect();
        let optional_scopes: Vec<&str> = config
            .optional_fields
            .iter()
            .map(|f| f.scope().as_str())
            .collect();
        result.push(json!({"app_id":id,"name":app.name,"logo_url":app.logo_url,"description":c.app_descriptions.get(id).and_then(Value::as_str),"scopes":scopes,"optional_scopes":optional_scopes,"selected_optional_scopes":[]}));
    }
    Ok(result)
}

async fn start(
    State(state): State<AppState>,
    who: AccountAuth,
    Json(input): Json<Start>,
) -> ApiResult<Response> {
    begin_interface(state, who, input, None).await
}

/// Internal verified flows supply their already authenticated scope grant.
async fn begin_interface(
    state: AppState,
    who: AccountAuth,
    input: Start,
    verified_scopes: Option<Vec<String>>,
) -> ApiResult<Response> {
    let session_id = who.session_id().ok_or_else(|| {
        ApiError::forbidden(
            "browser_session_required",
            "Use the signed-in Accounts browser session.",
        )
    })?;
    if input.state.is_empty()
        || input.state.len() > 1024
        || input.state.chars().any(char::is_control)
    {
        return Err(ApiError::invalid_request(
            "state must be a nonempty printable value of at most 1024 bytes.",
        ));
    }
    if input.code_challenge_method != "S256"
        || input.code_challenge.len() != 43
        || !input
            .code_challenge
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(ApiError::invalid_request(
            "An S256 PKCE code challenge is required.",
        ));
    }
    let mut tx = state.db.begin().await?;
    let c = client(&mut tx, &input.interface_id).await?;
    if !c.redirect_uris.contains(&input.redirect_uri) {
        return Err(ApiError::bad_request(
            "redirect_uri_not_registered",
            "The redirect URI is not registered for this interface.",
        ));
    }
    let mut interface_scopes = verified_scopes
        .clone()
        .unwrap_or_else(|| vec!["profile".into()]);
    let mut proof_hash = None;
    if verified_scopes.is_none() {
        if input.signin_proof.is_none() && requires_interface_signin(&c.signin_config) {
            return Err(ApiError::forbidden(
                "interface_signin_required",
                "Complete this Interface's sign-in pages first.",
            ));
        }
        if let Some(proof) = input.signin_proof.as_deref() {
            let hash = state.keys.pepper.hash(proof);
            let row:Option<(String,String,Option<Uuid>,bool,bool)>=sqlx::query_as("select flow_id,account_uuid,browser_session_id,(consumed_at is not null),(expires_at>now()) from authorization_codes where code_hash=$1 and app_id=$2 for update")
                .bind(&hash).bind(accounts_core::FIRST_PARTY_APP_ID).fetch_optional(&mut *tx).await?;
            let (flow_id, account_uuid, browser_session, consumed, live) =
                row.ok_or_else(|| {
                    ApiError::forbidden(
                        "invalid_signin_proof",
                        "The Interface sign-in proof is invalid.",
                    )
                })?;
            let signin = crate::flow::model::get(&mut tx, &flow_id)
                .await?
                .ok_or_else(|| {
                    ApiError::forbidden(
                        "invalid_signin_proof",
                        "The Interface sign-in proof is invalid.",
                    )
                })?;
            let binding = InterfaceBinding {
                interface_id: input.interface_id.clone(),
                redirect_uri: input.redirect_uri.clone(),
                state: input.state.clone(),
                code_challenge: input.code_challenge.clone(),
            };
            if !live
                || account_uuid != who.uuid()
                || browser_session != Some(session_id)
                || signin.extras.interface_id.as_deref() != Some(&input.interface_id)
                || signin.extras.interface_revision != Some(c.revision)
                || signin.extras.interface_request_binding.as_deref()
                    != Some(binding_hash(&state, &binding).as_str())
            {
                return Err(ApiError::forbidden(
                    "invalid_signin_proof",
                    "The Interface sign-in proof does not match this request, account, browser or configuration.",
                ));
            }
            if consumed {
                let prior:Option<(String,Value)>=sqlx::query_as("select id,app_descriptors from interface_login_flows where signin_code_hash=$1 and interface_id=$2 and interface_revision=$3 and account_uuid=$4 and browser_session_id=$5 and expires_at>now()")
                    .bind(&hash).bind(&c.interface_id).bind(c.revision).bind(who.uuid()).bind(session_id).fetch_optional(&mut *tx).await?;
                let (flow, display) = prior.ok_or_else(|| {
                    ApiError::forbidden(
                        "invalid_signin_proof",
                        "The Interface sign-in proof was already used.",
                    )
                })?;
                tx.commit().await?;
                return Ok(response(
                    json!({"flow_id":flow,"interface":{"interface_id":c.interface_id,"name":c.name,"logo_url":c.logo_url,"branding":c.branding},"apps":display,"consent_required":c.kind!="trusted"}),
                ));
            }
            interface_scopes = signin.extras.interface_scopes;
            proof_hash = Some(hash);
        }
    }
    let display = descriptors(&mut tx, &state, &c, &who.account, &c.app_ids).await?;
    let flow = crypto::random_token("siflow_");
    sqlx::query("insert into interface_login_flows(id,interface_id,interface_revision,account_uuid,browser_session_id,redirect_uri,state,code_challenge,app_ids,app_descriptors,kind,signin_code_hash,interface_scopes,signin_policy) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)")
        .bind(&flow).bind(&c.interface_id).bind(c.revision).bind(who.uuid()).bind(session_id).bind(&input.redirect_uri).bind(&input.state).bind(&input.code_challenge).bind(&c.app_ids).bind(json!(display)).bind(&c.kind).bind(&proof_hash).bind(&interface_scopes).bind(signin_policy(&c.signin_config)).execute(&mut *tx).await?;
    if let Some(hash) = proof_hash {
        sqlx::query("update authorization_codes set consumed_at=now() where code_hash=$1")
            .bind(hash)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(response(
        json!({"flow_id":flow,"interface":{"interface_id":c.interface_id,"name":c.name,"logo_url":c.logo_url,"branding":c.branding},"apps":display,"consent_required":c.kind!="trusted"}),
    ))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Decision {
    approve: bool,
    #[serde(default)]
    optional_scopes: std::collections::BTreeMap<String, Vec<String>>,
}

fn base_descriptors(value: &Value) -> Value {
    let mut result = value.clone();
    if let Some(items) = result.as_array_mut() {
        for item in items {
            item["selected_optional_scopes"] = json!([]);
        }
    }
    result
}

fn select_optional_scopes(
    base: &Value,
    choices: &std::collections::BTreeMap<String, Vec<String>>,
) -> ApiResult<Value> {
    let mut result = base_descriptors(base);
    let apps = result
        .as_array_mut()
        .ok_or_else(|| ApiError::internal("The app review is invalid."))?;
    for (app_id, selected) in choices {
        let app = apps
            .iter_mut()
            .find(|item| item["app_id"].as_str() == Some(app_id))
            .ok_or_else(|| {
                ApiError::invalid_request("Optional details name an app outside this sign-in.")
            })?;
        let allowed = app["optional_scopes"]
            .as_array()
            .ok_or_else(|| ApiError::internal("The app review is invalid."))?;
        let mut unique = selected.clone();
        unique.sort();
        unique.dedup();
        if unique.len() != selected.len()
            || unique
                .iter()
                .any(|scope| !allowed.iter().any(|v| v.as_str() == Some(scope)))
        {
            return Err(ApiError::invalid_request(
                "Only the optional details displayed for each app may be selected.",
            ));
        }
        app["selected_optional_scopes"] = json!(unique);
    }
    Ok(result)
}

#[derive(sqlx::FromRow)]
struct Flow {
    interface_id: String,
    interface_revision: i64,
    account_uuid: String,
    browser_session_id: Uuid,
    redirect_uri: String,
    state: String,
    app_ids: Vec<String>,
    app_descriptors: Value,
    kind: String,
    decision: Option<String>,
    result_sealed: Option<Vec<u8>>,
    live: bool,
}
async fn decide(
    State(state): State<AppState>,
    who: AccountAuth,
    Path(flow): Path<String>,
    Json(input): Json<Decision>,
) -> ApiResult<Response> {
    let session_id = who.session_id().ok_or_else(|| {
        ApiError::forbidden(
            "browser_session_required",
            "Use the signed-in Accounts browser session.",
        )
    })?;
    let mut tx = state.db.begin().await?;
    let row=sqlx::query_as::<_,Flow>("select interface_id,interface_revision,account_uuid,browser_session_id,redirect_uri,state,app_ids,app_descriptors,kind,decision,result_sealed,(expires_at>now()) as live from interface_login_flows where id=$1 for update")
        .bind(&flow).fetch_optional(&mut *tx).await?.ok_or_else(||ApiError::not_found("flow_not_found","This interface sign-in was not found."))?;
    if row.account_uuid != who.uuid() || row.browser_session_id != session_id {
        return Err(ApiError::forbidden(
            "flow_browser_mismatch",
            "This sign-in belongs to another browser session.",
        ));
    }
    if !row.live {
        return Err(ApiError::gone(
            "flow_expired",
            "This interface sign-in has expired.",
        ));
    }
    let c = client(&mut tx, &row.interface_id).await?;
    if c.revision != row.interface_revision || c.kind != row.kind {
        return Err(ApiError::conflict(
            "interface_changed",
            "The interface changed during sign-in. Start again.",
        ));
    }
    let approved_descriptors =
        select_optional_scopes(&row.app_descriptors, &input.optional_scopes)?;
    if let Some(decision) = row.decision {
        if (decision == "approved") != input.approve
            || (input.approve && approved_descriptors != row.app_descriptors)
        {
            return Err(ApiError::conflict(
                "flow_decided",
                "This sign-in already has a different decision.",
            ));
        }
        let sealed = row
            .result_sealed
            .ok_or_else(|| ApiError::internal("The sign-in result is missing."))?;
        let url = state.keys.keyring.decrypt_string(&sealed)?;
        tx.commit().await?;
        return Ok(response(json!({"redirect_to":url})));
    }
    if input.approve {
        let current = descriptors(&mut tx, &state, &c, &who.account, &row.app_ids).await?;
        if json!(current) != base_descriptors(&row.app_descriptors) {
            return Err(ApiError::conflict(
                "app_requirements_changed",
                "An app's sign-in requirements changed. Start again to review them.",
            ));
        }
    }
    let code = input.approve.then(|| crypto::random_token("sifcode_"));
    let redirect = super::util::with_query(
        &row.redirect_uri,
        &[
            ("code", code.as_deref()),
            (
                "error",
                if input.approve {
                    None
                } else {
                    Some("access_denied")
                },
            ),
            ("state", Some(&row.state)),
        ],
    );
    let sealed = state.keys.keyring.encrypt_str(&redirect)?;
    sqlx::query("update interface_login_flows set decision=$2,code_hash=$3,code_expires_at=case when $3::bytea is null then null else now()+interval '2 minutes' end,result_sealed=$4,app_descriptors=$5 where id=$1")
        .bind(&flow).bind(if input.approve {"approved"} else {"denied"}).bind(code.as_deref().map(|v|state.keys.pepper.hash(v))).bind(sealed).bind(approved_descriptors).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(response(json!({"redirect_to":redirect})))
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct TokenRequest {
    interface_id: String,
    grant_type: String,
    client_secret: Option<String>,
    code: Option<String>,
    redirect_uri: Option<String>,
    code_verifier: Option<String>,
    refresh_token: Option<String>,
    app_id: Option<String>,
}

#[derive(sqlx::FromRow)]
struct Code {
    id: String,
    interface_revision: i64,
    account_uuid: String,
    redirect_uri: String,
    code_challenge: String,
    app_ids: Vec<String>,
    app_descriptors: Value,
    interface_scopes: Vec<String>,
    signin_policy: Value,
    kind: String,
    decision: Option<String>,
    live: bool,
    consumed: bool,
    session_id: Option<Uuid>,
}
#[derive(sqlx::FromRow)]
struct InterfaceSession {
    id: Uuid,
    interface_id: String,
    account_uuid: String,
    approved_apps: Vec<String>,
    approved_descriptors: Value,
    interface_scopes: Vec<String>,
    signin_policy: Value,
    kind: String,
    expires_at: time::OffsetDateTime,
    live: bool,
}

fn verify_client(
    c: &Client,
    secret: Option<&str>,
    state: &AppState,
    headers: &HeaderMap,
) -> ApiResult<()> {
    if let Some(origin) = headers.get(header::ORIGIN) {
        let origin = origin.to_str().map_err(|_| {
            ApiError::forbidden("origin_not_allowed", "The request origin is invalid.")
        })?;
        if !c.allowed_origins.iter().any(|allowed| allowed == origin) {
            return Err(ApiError::forbidden(
                "origin_not_allowed",
                "This origin is not registered for the interface.",
            ));
        }
    }
    let public = c
        .signin_config
        .get("public_client")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    if !public && secret.is_none() {
        return Err(ApiError::unauthenticated(
            "invalid_client",
            "This interface requires its client secret.",
        ));
    }
    if let Some(secret) = secret
        && !state.keys.pepper.verify(secret, &c.secret_hash)
    {
        return Err(ApiError::unauthenticated(
            "invalid_client",
            "The interface secret is not valid.",
        ));
    }
    Ok(())
}

async fn revoke_session(conn: &mut PgConnection, session_id: Uuid, why: &str) -> ApiResult<()> {
    sqlx::query("update interface_sessions set revoked_at=coalesce(revoked_at,now()),revoke_reason=coalesce(revoke_reason,$2) where id=$1")
        .bind(session_id).bind(why).execute(&mut *conn).await?;
    sqlx::query("update token_families set revoked_at=coalesce(revoked_at,now()),revoke_reason=coalesce(revoke_reason,$2) where id in (select family_id from interface_app_token_families where session_id=$1)")
        .bind(session_id).bind(why).execute(&mut *conn).await?;
    sqlx::query("update interface_token_operations set sealed_response=$2 where session_id=$1 and sealed_response<>$2")
        .bind(session_id)
        .bind(json!({"$unavailable":true}))
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// Issue scoped app access credentials. App refresh credentials are never sent
/// to the Interface; the distinct interface refresh credential controls renewal.
async fn issue_apps(
    conn: &mut PgConnection,
    state: &AppState,
    c: &Client,
    session: &InterfaceSession,
    account: &Account,
    first: bool,
    new_app: Option<&str>,
) -> ApiResult<Value> {
    let display = descriptors(conn, state, c, account, &session.approved_apps).await?;
    if session.kind != "trusted"
        && json!(display) != base_descriptors(&session.approved_descriptors)
    {
        return Err(ApiError::conflict(
            "app_requirements_changed",
            "An app's sign-in requirements changed. Sign in to the interface again to review them.",
        ));
    }
    let mut result = serde_json::Map::new();
    let ends_by = session
        .expires_at
        .min(time::OffsetDateTime::now_utc() + time::Duration::hours(1));
    for item in &display {
        let app_id = item["app_id"]
            .as_str()
            .ok_or_else(|| ApiError::internal("App descriptor is missing its ID."))?;
        let config = apps::effective_config(conn, &state.settings, app_id).await?;
        let mut scopes = vec![Scope::Profile];
        scopes.extend(config.required_fields.iter().map(ContactField::scope));
        if let Some(selected) = session
            .approved_descriptors
            .as_array()
            .and_then(|apps| {
                apps.iter()
                    .find(|app| app["app_id"].as_str() == Some(app_id))
            })
            .and_then(|app| app["selected_optional_scopes"].as_array())
        {
            scopes.extend(
                selected
                    .iter()
                    .filter_map(|value| value.as_str().and_then(Scope::parse)),
            );
        }
        if first || new_app == Some(app_id) {
            if session.kind == "trusted" {
                let existing: Option<String> = sqlx::query_scalar(
                    "select status from memberships where app_id=$1 and account_uuid=$2 for update",
                )
                .bind(app_id)
                .bind(&account.uuid)
                .fetch_optional(&mut *conn)
                .await?;
                if existing.as_deref() == Some("access_removed") {
                    return Err(ApiError::forbidden(
                        "app_access_removed",
                        format!(
                            "The account removed {app_id}'s access. Sign in to that app explicitly before using it through a trusted Interface."
                        ),
                    ));
                }
            }
            memberships::upsert_signin(
                conn,
                app_id,
                &account.uuid,
                MembershipSource::Signin,
                &scopes,
                GrantMode::Union,
            )
            .await?;
        } else {
            let active: Option<String> = sqlx::query_scalar(
                "select status from memberships where app_id=$1 and account_uuid=$2 for share",
            )
            .bind(app_id)
            .bind(&account.uuid)
            .fetch_optional(&mut *conn)
            .await?;
            if active.as_deref() != Some("active") {
                return Err(ApiError::forbidden(
                    "app_access_removed",
                    format!("Access to {app_id} was removed. Sign in again."),
                ));
            }
        }
        let (issued, family) = tokens::issue_tokens_until(
            conn,
            &state.keys,
            &state.settings,
            IssueRequest {
                account,
                app_id,
                origin: TokenOrigin::AuthorizationCode,
                scopes: &scopes,
                browser_session_id: None,
                label: Some("Silicon Interface"),
                ip: None,
                user_agent: None,
                nonce: None,
                auth_time: None,
            },
            ends_by,
        )
        .await?;
        sqlx::query("insert into interface_app_token_families(family_id,session_id,app_id) values($1,$2,$3)")
            .bind(family.id).bind(session.id).bind(app_id).execute(&mut *conn).await?;
        result.insert(app_id.to_string(),json!({"access_token":issued.access_token,"token_type":issued.token_type,"expires_in":issued.expires_in,"access_token_expires_at":accounts_core::timefmt::format_rfc3339_ms(issued.access_token_expires_at),"scope":issued.scope,"account":issued.account}));
    }
    Ok(Value::Object(result))
}

async fn interface_account_view(
    conn: &mut PgConnection,
    account: &Account,
    scopes: &[String],
) -> ApiResult<Value> {
    let mut view = json!({"uuid":account.uuid,"id":account.handle,"kind":account.kind,"display_name":account.display_name});
    if scopes.iter().any(|s| s == "email") {
        view["email"] = json!(
            contacts::primary_email(conn, &account.uuid)
                .await?
                .filter(|v| v.verified)
                .map(|v| v.value)
        );
    }
    if scopes.iter().any(|s| s == "phone") {
        view["phone"] = json!(
            contacts::primary_phone(conn, &account.uuid)
                .await?
                .filter(|v| v.verified)
                .map(|v| v.value)
        );
    }
    if scopes.iter().any(|s| s == "dob") {
        view["dob"] = json!(accounts_core::timefmt::format_date(account.dob));
    }
    if scopes.iter().any(|s| s == "timezone") {
        view["timezone"] = json!(account.timezone);
    }
    Ok(view)
}

async fn active_subject(conn: &mut PgConnection, uuid: &str) -> ApiResult<Account> {
    let _: Option<String> =
        sqlx::query_scalar("select uuid from accounts where uuid=$1 and status='active' for share")
            .bind(uuid)
            .fetch_optional(&mut *conn)
            .await?;
    let account = accounts::get(conn, uuid).await?.ok_or_else(|| {
        ApiError::unauthenticated("invalid_grant", "The account no longer exists.")
    })?;
    if !account.is_active() {
        return Err(ApiError::unauthenticated(
            "invalid_grant",
            "The account is not active.",
        ));
    }
    Ok(account)
}

async fn read_session(conn: &mut PgConnection, id: Uuid) -> ApiResult<InterfaceSession> {
    sqlx::query_as::<_,InterfaceSession>("select id,interface_id,account_uuid,approved_apps,approved_descriptors,interface_scopes,signin_policy,kind,expires_at,(revoked_at is null and expires_at>now()) as live from interface_sessions where id=$1 for update")
        .bind(id).fetch_optional(conn).await?.ok_or_else(||ApiError::unauthenticated("invalid_grant","The interface session was not found."))
}

async fn token(
    State(state): State<AppState>,
    headers: HeaderMap,
    key: IdempotencyKey,
    Json(input): Json<TokenRequest>,
) -> ApiResult<Response> {
    if (input.grant_type == "authorization_code"
        && (input.refresh_token.is_some() || input.app_id.is_some()))
        || (input.grant_type == "refresh_token"
            && (input.code.is_some()
                || input.redirect_uri.is_some()
                || input.code_verifier.is_some()))
    {
        return Err(ApiError::invalid_request(
            "The request contains fields for a different grant.",
        ));
    }
    if !["authorization_code", "refresh_token"].contains(&input.grant_type.as_str()) {
        return Err(ApiError::invalid_request(
            "Use authorization_code or refresh_token.",
        ));
    }
    let mut tx = state.db.begin().await?;
    let c = client(&mut tx, &input.interface_id).await?;
    verify_client(&c, input.client_secret.as_deref(), &state, &headers)?;
    let scope = format!("interface-token:{}", input.interface_id);
    sqlx::query("select pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(format!("{scope}:{}", key.as_str()))
        .execute(&mut *tx)
        .await?;
    let hash = idempotency::request_hash(&input);
    let prior:Option<(Vec<u8>,Uuid,Value)>=sqlx::query_as("select request_hash,session_id,sealed_response from interface_token_operations where interface_id=$1 and key=$2")
        .bind(&input.interface_id).bind(key.as_str()).fetch_optional(&mut *tx).await?;
    if let Some((prior_hash, session_id, sealed)) = prior {
        if prior_hash != hash {
            return Err(ApiError::conflict(
                "idempotency_key_reused",
                "This operation key belongs to another token request.",
            ));
        }
        let session = read_session(&mut tx, session_id).await?;
        if !session.live {
            return Err(ApiError::conflict(
                "token_result_unavailable",
                "The session ended or its token result expired. Sign in again.",
            ));
        }
        let account = active_subject(&mut tx, &session.account_uuid).await?;
        validate_existing_session(&mut tx, &state, &c, &session, &account).await?;
        let body = idempotency::unseal(&state.keys.keyring, &scope, key.as_str(), &sealed)?;
        let returned = body["refresh_token"]
            .as_str()
            .ok_or_else(|| ApiError::internal("The token receipt is invalid."))?;
        let current: bool = sqlx::query_scalar("select exists(select 1 from interface_refresh_tokens where token_hash=$1 and session_id=$2 and used_at is null)")
            .bind(state.keys.pepper.hash(returned)).bind(session.id).fetch_one(&mut *tx).await?;
        if !current {
            return Err(ApiError::conflict(
                "token_result_superseded",
                "The interface session already refreshed. Use the most recent credentials.",
            ));
        }
        tx.commit().await?;
        return Ok(response(body));
    }
    let session = if input.grant_type == "authorization_code" {
        let code = input
            .code
            .as_deref()
            .filter(|x| x.starts_with("sifcode_"))
            .ok_or_else(|| ApiError::invalid_request("The authorization code is required."))?;
        let redirect = input
            .redirect_uri
            .as_deref()
            .ok_or_else(|| ApiError::invalid_request("redirect_uri is required."))?;
        let verifier = input
            .code_verifier
            .as_deref()
            .ok_or_else(|| ApiError::invalid_request("code_verifier is required."))?;
        pkce::validate_verifier(verifier).map_err(ApiError::invalid_request)?;
        let flow=sqlx::query_as::<_,Code>("select id,interface_revision,account_uuid,redirect_uri,code_challenge,app_ids,app_descriptors,interface_scopes,signin_policy,kind,decision,(code_expires_at>now()) as live,(consumed_at is not null) as consumed,session_id from interface_login_flows where interface_id=$1 and code_hash=$2 for update")
            .bind(&input.interface_id).bind(state.keys.pepper.hash(code)).fetch_optional(&mut *tx).await?.ok_or_else(||ApiError::unauthenticated("invalid_grant","The authorization code is invalid."))?;
        if flow.redirect_uri != redirect
            || !pkce::verify(Some("S256"), verifier, &flow.code_challenge)
        {
            return Err(ApiError::unauthenticated(
                "invalid_grant",
                "The redirect URI or PKCE verifier does not match.",
            ));
        }
        if flow.consumed {
            if let Some(session_id) = flow.session_id {
                revoke_session(&mut tx, session_id, "authorization_code_reuse").await?;
            }
            tx.commit().await?;
            return Err(ApiError::unauthenticated(
                "invalid_grant",
                "This authorization code was already used; its interface session was revoked.",
            ));
        }
        if !flow.live
            || flow.decision.as_deref() != Some("approved")
            || flow.interface_revision != c.revision
            || flow.kind != c.kind
        {
            return Err(ApiError::unauthenticated(
                "invalid_grant",
                "The code expired or the interface changed; sign in again.",
            ));
        }
        let account = active_subject(&mut tx, &flow.account_uuid).await?;
        if json!(descriptors(&mut tx, &state, &c, &account, &flow.app_ids).await?)
            != base_descriptors(&flow.app_descriptors)
        {
            return Err(ApiError::conflict(
                "app_requirements_changed",
                "An app's sign-in requirements changed. Sign in again.",
            ));
        }
        let id = Uuid::now_v7();
        sqlx::query("insert into interface_sessions(id,interface_id,account_uuid,approved_apps,approved_descriptors,kind,interface_scopes,signin_policy) values($1,$2,$3,$4,$5,$6,$7,$8)")
            .bind(id).bind(&input.interface_id).bind(&flow.account_uuid).bind(&flow.app_ids).bind(&flow.app_descriptors).bind(&flow.kind).bind(&flow.interface_scopes).bind(&flow.signin_policy).execute(&mut *tx).await?;
        sqlx::query("update interface_login_flows set consumed_at=now(),session_id=$2 where id=$1")
            .bind(&flow.id)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        let session = read_session(&mut tx, id).await?;
        let app_tokens = issue_apps(&mut tx, &state, &c, &session, &account, true, None).await?;
        (session, app_tokens, account)
    } else {
        let refresh = input
            .refresh_token
            .as_deref()
            .filter(|x| x.starts_with("sifr_"))
            .ok_or_else(|| ApiError::invalid_request("The interface refresh token is required."))?;
        let row:Option<(Uuid,bool)>=sqlx::query_as("select session_id,(used_at is not null) from interface_refresh_tokens where token_hash=$1 for update")
            .bind(state.keys.pepper.hash(refresh)).fetch_optional(&mut *tx).await?;
        let (session_id, used) = row.ok_or_else(|| {
            ApiError::unauthenticated("invalid_grant", "The refresh token is invalid.")
        })?;
        let mut session = read_session(&mut tx, session_id).await?;
        if session.interface_id != input.interface_id || !session.live {
            return Err(ApiError::unauthenticated(
                "invalid_grant",
                "The interface session is no longer active.",
            ));
        }
        if used {
            revoke_session(&mut tx, session_id, "refresh_token_reuse").await?;
            tx.commit().await?;
            return Err(ApiError::unauthenticated(
                "invalid_grant",
                "This refresh token was already used; the interface session was revoked.",
            ));
        }
        if session.kind != c.kind
            || (session.kind != "trusted"
                && session
                    .approved_apps
                    .iter()
                    .any(|id| !c.app_ids.contains(id)))
        {
            return Err(ApiError::unauthenticated(
                "invalid_grant",
                "The interface's approved apps or tier changed; sign in again.",
            ));
        }
        let account = active_subject(&mut tx, &session.account_uuid).await?;
        validate_existing_session(&mut tx, &state, &c, &session, &account).await?;
        let mut new_app = None;
        if let Some(app_id) = input.app_id.as_deref() {
            if session.kind != "trusted" {
                return Err(ApiError::forbidden(
                    "trusted_interface_required",
                    "Only a trusted interface may add an app without another sign-in.",
                ));
            }
            if accounts_core::is_privileged_app_id(app_id) {
                return Err(delegation_forbidden());
            }
            if !session.approved_apps.iter().any(|id| id == app_id) {
                session.approved_apps.push(app_id.to_string());
                new_app = Some(app_id.to_string());
                sqlx::query("update interface_sessions set approved_apps=$2 where id=$1")
                    .bind(session.id)
                    .bind(&session.approved_apps)
                    .execute(&mut *tx)
                    .await?;
            }
        }
        let app_tokens = issue_apps(
            &mut tx,
            &state,
            &c,
            &session,
            &account,
            false,
            new_app.as_deref(),
        )
        .await?;
        sqlx::query("update interface_refresh_tokens set used_at=now() where token_hash=$1")
            .bind(state.keys.pepper.hash(refresh))
            .execute(&mut *tx)
            .await?;
        (session, app_tokens, account)
    };
    let (session, app_tokens, account) = session;
    let refresh = crypto::random_token("sifr_");
    sqlx::query("insert into interface_refresh_tokens(token_hash,session_id) values($1,$2)")
        .bind(state.keys.pepper.hash(&refresh))
        .bind(session.id)
        .execute(&mut *tx)
        .await?;
    let account_view = interface_account_view(&mut tx, &account, &session.interface_scopes).await?;
    let body = json!({"interface_id":input.interface_id,"session_id":session.id,"expires_at":accounts_core::timefmt::format_rfc3339_ms(session.expires_at),"account":account_view,"refresh_token":refresh,"apps":app_tokens});
    let sealed = idempotency::seal(&state.keys.keyring, &scope, key.as_str(), &body)?;
    sqlx::query("update interface_token_operations set sealed_response=$2 where session_id=$1 and sealed_response<>$2")
        .bind(session.id)
        .bind(json!({"$unavailable":true}))
        .execute(&mut *tx)
        .await?;
    sqlx::query("insert into interface_token_operations(interface_id,key,request_hash,session_id,sealed_response) values($1,$2,$3,$4,$5)")
        .bind(&input.interface_id).bind(key.as_str()).bind(hash).bind(session.id).bind(sealed).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(response(body))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Revoke {
    interface_id: String,
    client_secret: Option<String>,
    refresh_token: String,
}
async fn revoke(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<Revoke>,
) -> ApiResult<Response> {
    let mut tx = state.db.begin().await?;
    let c = client(&mut tx, &input.interface_id).await?;
    verify_client(&c, input.client_secret.as_deref(), &state, &headers)?;
    let session:Option<Uuid>=sqlx::query_scalar("select s.id from interface_refresh_tokens r join interface_sessions s on s.id=r.session_id where r.token_hash=$1 and s.interface_id=$2 for update of s")
        .bind(state.keys.pepper.hash(&input.refresh_token)).bind(&input.interface_id).fetch_optional(&mut *tx).await?;
    if let Some(id) = session {
        revoke_session(&mut tx, id, "interface_signout").await?;
    }
    tx.commit().await?;
    Ok(response(json!({"revoked":true})))
}

async fn validate_existing_session(
    conn: &mut PgConnection,
    state: &AppState,
    c: &Client,
    session: &InterfaceSession,
    account: &Account,
) -> ApiResult<()> {
    if !session.live
        || session.interface_id != c.interface_id
        || session.kind != c.kind
        || session.signin_policy != signin_policy(&c.signin_config)
        || (session.kind != "trusted"
            && session
                .approved_apps
                .iter()
                .any(|id| !c.app_ids.contains(id)))
    {
        return Err(ApiError::unauthenticated(
            "invalid_grant",
            "The interface session no longer has its approved access.",
        ));
    }
    for field in ["email", "phone"] {
        if session.interface_scopes.iter().any(|scope| scope == field) {
            let present = if field == "email" {
                contacts::primary_email(conn, &account.uuid)
                    .await?
                    .is_some_and(|c| c.verified)
            } else {
                contacts::primary_phone(conn, &account.uuid)
                    .await?
                    .is_some_and(|c| c.verified)
            };
            if !present {
                return Err(ApiError::unauthenticated(
                    "invalid_grant",
                    "A shared Interface contact is no longer verified.",
                ));
            }
        }
    }
    let config = accounts_core::models::SigninConfig::from_stored(&c.signin_config);
    if !crate::flow::next::account_domain_allowed(conn, &config, account).await? {
        return Err(ApiError::unauthenticated(
            "invalid_grant",
            "The Interface's allowed email domains no longer permit this account.",
        ));
    }
    let current = descriptors(conn, state, c, account, &session.approved_apps).await?;
    if session.kind != "trusted"
        && json!(current) != base_descriptors(&session.approved_descriptors)
    {
        return Err(ApiError::unauthenticated(
            "invalid_grant",
            "The apps' sign-in requirements changed.",
        ));
    }
    for app_id in &session.approved_apps {
        let active: Option<String> = sqlx::query_scalar(
            "select status from memberships where app_id=$1 and account_uuid=$2 for share",
        )
        .bind(app_id)
        .bind(&account.uuid)
        .fetch_optional(&mut *conn)
        .await?;
        if active.as_deref() != Some("active") {
            return Err(ApiError::unauthenticated(
                "invalid_grant",
                "The account removed an app's access.",
            ));
        }
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Introspect {
    interface_id: String,
    client_secret: Option<String>,
    refresh_token: String,
}
async fn introspect(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<Introspect>,
) -> ApiResult<Response> {
    let mut tx = state.db.begin().await?;
    let c = match client(&mut tx, &input.interface_id).await {
        Ok(c) => c,
        Err(e) if !e.is_server_error() => return Ok(response(json!({"active":false}))),
        Err(e) => return Err(e),
    };
    verify_client(&c, input.client_secret.as_deref(), &state, &headers)?;
    let id:Option<Uuid>=sqlx::query_scalar("select s.id from interface_refresh_tokens r join interface_sessions s on s.id=r.session_id where r.token_hash=$1 and r.used_at is null and s.interface_id=$2")
        .bind(state.keys.pepper.hash(&input.refresh_token)).bind(&input.interface_id).fetch_optional(&mut *tx).await?;
    let Some(id) = id else {
        return Ok(response(json!({"active":false})));
    };
    let session = read_session(&mut tx, id).await?;
    let current:bool = sqlx::query_scalar("select exists(select 1 from interface_refresh_tokens where token_hash=$1 and session_id=$2 and used_at is null)")
        .bind(state.keys.pepper.hash(&input.refresh_token)).bind(id).fetch_one(&mut *tx).await?;
    if !current {
        return Ok(response(json!({"active":false})));
    }
    let account = match active_subject(&mut tx, &session.account_uuid).await {
        Ok(a) => a,
        Err(e) if !e.is_server_error() => return Ok(response(json!({"active":false}))),
        Err(e) => return Err(e),
    };
    if let Err(e) = validate_existing_session(&mut tx, &state, &c, &session, &account).await {
        if e.is_server_error() {
            return Err(e);
        }
        return Ok(response(json!({"active":false})));
    }
    tx.commit().await?;
    Ok(response(
        json!({"active":true,"interface_id":input.interface_id,"session_id":session.id,"expires_at":accounts_core::timefmt::format_rfc3339_ms(session.expires_at),"account":{"uuid":account.uuid,"id":account.handle,"kind":account.kind,"display_name":account.display_name}}),
    ))
}

/// The account can inspect and end Interface sessions without removing app access
/// or touching app sign-ins that were created outside the Interface.
async fn my_sessions(State(state): State<AppState>, who: AccountAuth) -> ApiResult<Response> {
    let rows:Vec<Value>=sqlx::query_scalar("select jsonb_build_object('session_id',s.id,'interface_id',s.interface_id,'name',c.name,'logo_url',c.logo_url,'apps',to_jsonb(s.approved_apps),'created_at',s.created_at,'expires_at',s.expires_at) from interface_sessions s join interface_auth_clients c on c.interface_id=s.interface_id where s.account_uuid=$1 and s.revoked_at is null and s.expires_at>now() order by s.created_at desc")
        .bind(who.uuid()).fetch_all(&state.db).await?;
    Ok(response(json!({"sessions":rows})))
}
async fn remove_my_session(
    State(state): State<AppState>,
    who: AccountAuth,
    Path(id): Path<Uuid>,
) -> ApiResult<Response> {
    let mut tx = state.db.begin().await?;
    let owns: bool = sqlx::query_scalar(
        "select exists(select 1 from interface_sessions where id=$1 and account_uuid=$2)",
    )
    .bind(id)
    .bind(who.uuid())
    .fetch_one(&mut *tx)
    .await?;
    if !owns {
        return Err(ApiError::not_found(
            "interface_session_not_found",
            "This interface session was not found.",
        ));
    }
    revoke_session(&mut tx, id, "account_removed_interface_access").await?;
    accounts_core::repo::audit::record(
        &mut tx,
        &accounts_core::repo::audit::AuditEntry {
            account_uuid: Some(who.uuid()),
            target_kind: Some("interface_session"),
            target_id: Some(&id.to_string()),
            ..accounts_core::repo::audit::AuditEntry::new(
                accounts_core::models::ActorKind::Account,
                Some(who.uuid()),
                "interface.session.revoked",
            )
        },
    )
    .await?;
    tx.commit().await?;
    Ok(response(json!({"revoked":true})))
}
async fn remove_my_interface(
    State(state): State<AppState>,
    who: AccountAuth,
    Path(id): Path<String>,
) -> ApiResult<Response> {
    let mut tx = state.db.begin().await?;
    let ids:Vec<Uuid>=sqlx::query_scalar("select id from interface_sessions where interface_id=$1 and account_uuid=$2 and revoked_at is null order by id for update")
        .bind(&id).bind(who.uuid()).fetch_all(&mut *tx).await?;
    for session_id in &ids {
        revoke_session(&mut tx, *session_id, "account_removed_interface_access").await?;
    }
    if !ids.is_empty() {
        accounts_core::repo::audit::record(
            &mut tx,
            &accounts_core::repo::audit::AuditEntry {
                account_uuid: Some(who.uuid()),
                target_kind: Some("interface"),
                target_id: Some(&id),
                details: json!({"sessions":ids.len()}),
                ..accounts_core::repo::audit::AuditEntry::new(
                    accounts_core::models::ActorKind::Account,
                    Some(who.uuid()),
                    "interface.access.removed",
                )
            },
        )
        .await?;
    }
    tx.commit().await?;
    Ok(response(json!({"revoked_sessions":ids.len()})))
}

// Verified self-hosted credential collection is a confidential backend bridge.
// Browsers never receive Accounts cookies and these routes have no CORS grant.
static VERIFIED_ACTIONS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);

fn verified_secret(
    c: &Client,
    state: &AppState,
    headers: &HeaderMap,
    origin: &str,
) -> ApiResult<()> {
    if headers.contains_key(header::ORIGIN) {
        return Err(ApiError::forbidden(
            "backend_required",
            "Verified sign-in must be called by the Interface's confidential backend.",
        ));
    }
    if !["verified", "trusted"].contains(&c.kind.as_str()) {
        return Err(ApiError::forbidden(
            "verified_interface_required",
            "This Interface is not approved for self-hosted sign-in.",
        ));
    }
    if !c.allowed_origins.iter().any(|allowed| allowed == origin) {
        return Err(ApiError::forbidden(
            "origin_not_allowed",
            "The Interface origin is not registered.",
        ));
    }
    let secret = headers
        .get(header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "))
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            ApiError::unauthenticated(
                "interface_secret_required",
                "A verified Interface backend must authenticate with its secret.",
            )
        })?;
    if !state.keys.pepper.verify(secret, &c.secret_hash) {
        return Err(ApiError::unauthenticated(
            "invalid_client",
            "The Interface secret is invalid.",
        ));
    }
    Ok(())
}
fn bridge_headers(
    state: &AppState,
    jar: &std::collections::BTreeMap<String, String>,
) -> ApiResult<HeaderMap> {
    let mut headers = HeaderMap::new();
    headers.insert(
        header::ORIGIN,
        header::HeaderValue::from_str(&state.settings.public_origin)
            .map_err(|_| ApiError::internal("Invalid Accounts origin."))?,
    );
    let cookie = jar
        .iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("; ");
    if !cookie.is_empty() {
        headers.insert(
            header::COOKIE,
            header::HeaderValue::from_str(&cookie)
                .map_err(|_| ApiError::internal("Invalid stored flow cookie."))?,
        );
    }
    Ok(headers)
}
fn merge_bridge_cookies(
    jar: &mut std::collections::BTreeMap<String, String>,
    cookies: Vec<cookie::Cookie<'static>>,
) {
    for cookie in cookies {
        if cookie.value().is_empty() {
            jar.remove(cookie.name());
        } else {
            jar.insert(cookie.name().to_string(), cookie.value().to_string());
        }
    }
}
fn public_flow_view(view: crate::flow::FlowView) -> ApiResult<Value> {
    let denied = view
        .redirect_to
        .as_deref()
        .and_then(|url| url::Url::parse(url).ok())
        .is_some_and(|url| {
            url.query_pairs()
                .any(|(key, value)| key == "error" && value == "access_denied")
        });
    let mut value = serde_json::to_value(view)?;
    // This is Accounts' first-party code, not the Interface's code.
    value["redirect_to"] = Value::Null;
    if denied {
        value["outcome"] = json!("denied");
    }
    Ok(value)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct VerifiedStart {
    interface_id: String,
    interface_origin: String,
    redirect_uri: String,
    state: String,
    code_challenge: String,
    code_challenge_method: String,
}
async fn verified_start(
    State(state): State<AppState>,
    meta: accounts_core::http::ClientMeta,
    headers: HeaderMap,
    Json(input): Json<VerifiedStart>,
) -> ApiResult<Response> {
    let mut conn = state.db.acquire().await?;
    let c = client(&mut conn, &input.interface_id).await?;
    verified_secret(&c, &state, &headers, &input.interface_origin)?;
    let initial_revision = c.revision;
    if !c.redirect_uris.contains(&input.redirect_uri) {
        return Err(ApiError::bad_request(
            "redirect_uri_not_registered",
            "The redirect URI is not registered for this Interface.",
        ));
    }
    if input.state.is_empty()
        || input.state.len() > 1024
        || input.state.chars().any(char::is_control)
        || input.code_challenge_method != "S256"
        || input.code_challenge.len() != 43
        || !input
            .code_challenge
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(ApiError::invalid_request(
            "A valid state and S256 PKCE challenge are required.",
        ));
    }
    drop(conn);
    let _permit = VERIFIED_ACTIONS
        .acquire()
        .await
        .map_err(|_| ApiError::internal("Verified sign-in is unavailable."))?;
    let mut initial_headers = HeaderMap::new();
    initial_headers.insert(
        header::ORIGIN,
        header::HeaderValue::from_str(&state.settings.public_origin)
            .map_err(|_| ApiError::internal("Invalid Accounts origin."))?,
    );
    let body = crate::flow::create::CreateFlowBody {
        app_id: Some(accounts_core::FIRST_PARTY_APP_ID.into()),
        interface_id: Some(input.interface_id.clone()),
        redirect_uri: Some(format!(
            "{}/sign-in",
            state.settings.public_origin.trim_end_matches('/')
        )),
        state: Some(crypto::random_token("")),
        ..Default::default()
    };
    let started =
        crate::flow::create::create_flow(State(state.clone()), meta, initial_headers, Json(body))
            .await?;
    let flow_id = started.view.id.clone();
    let view = public_flow_view(started.view)?;
    let mut jar = std::collections::BTreeMap::new();
    merge_bridge_cookies(&mut jar, started.cookies);
    if !jar.contains_key(&accounts_core::http::cookies::cookie_name(
        &state.settings,
        accounts_core::http::FLOW_COOKIE,
    )) {
        return Err(ApiError::internal(
            "The Accounts flow did not set its binding.",
        ));
    }
    let capability = crypto::random_token("sivf_");
    let sealed = state
        .keys
        .keyring
        .encrypt_str(&serde_json::to_string(&jar)?)?;
    let mut tx = state.db.begin().await?;
    let c = client(&mut tx, &input.interface_id).await?;
    verified_secret(&c, &state, &headers, &input.interface_origin)?;
    if c.revision != initial_revision || !c.redirect_uris.contains(&input.redirect_uri) {
        return Err(ApiError::conflict(
            "interface_changed",
            "The Interface changed; start again.",
        ));
    }
    sqlx::query("insert into verified_interface_auth_flows(capability_hash,interface_id,signin_flow_id,sealed_cookies,interface_origin,redirect_uri,state,code_challenge,interface_revision) values($1,$2,$3,$4,$5,$6,$7,$8,$9)")
        .bind(state.keys.pepper.hash(&capability)).bind(&input.interface_id).bind(&flow_id).bind(sealed).bind(&input.interface_origin).bind(&input.redirect_uri).bind(&input.state).bind(&input.code_challenge).bind(initial_revision).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(response(json!({"capability":capability,"flow":view})))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct VerifiedAction {
    interface_id: String,
    interface_origin: String,
    capability: String,
    action: String,
    #[serde(default)]
    payload: Value,
}
#[derive(sqlx::FromRow)]
struct VerifiedBridge {
    interface_revision: i64,
    signin_flow_id: String,
    sealed_cookies: Vec<u8>,
    interface_origin: String,
    redirect_uri: String,
    state: String,
    code_challenge: String,
    interface_flow_id: Option<String>,
    review_snapshot: Option<Value>,
    decision_hash: Option<Vec<u8>>,
    decision_result: Option<Value>,
    live: bool,
}
fn parse_payload<T: serde::de::DeserializeOwned>(value: Value) -> ApiResult<T> {
    serde_json::from_value(value)
        .map_err(|_| ApiError::invalid_request("The verified sign-in action payload is invalid."))
}
async fn response_json(response: Response) -> ApiResult<Value> {
    let bytes = axum::body::to_bytes(response.into_body(), 2 * 1024 * 1024)
        .await
        .map_err(|_| ApiError::internal("Could not read the flow result."))?;
    serde_json::from_slice(&bytes)
        .map_err(|_| ApiError::internal("The flow returned invalid JSON."))
}
/// Recover a cookie only when the same bound flow already committed a proof.
/// This closes the crash window between the Accounts flow's commit and the
/// bridge's encrypted-cookie commit without replaying a code or creating a
/// second account. The replacement cookie and revocation commit together.
async fn recover_verified_cookie(
    conn: &mut PgConnection,
    state: &AppState,
    flow_id: &str,
    jar: &mut std::collections::BTreeMap<String, String>,
    meta: &accounts_core::http::ClientMeta,
) -> ApiResult<bool> {
    let headers = bridge_headers(state, jar)?;
    let flow = crate::flow::model::get(conn, flow_id)
        .await?
        .ok_or_else(|| {
            ApiError::not_found("flow_not_found", "The Accounts sign-in was not found.")
        })?;
    crate::flow::model::check_binding(state, &headers, &flow)?;
    crate::flow::model::ensure_live(&flow)?;
    let mut changed = false;
    if flow.step == crate::flow::Step::Signup {
        if let Some(signup_id) = flow.signup_session_id {
            let current = crate::flow::signup::from_cookie(conn, state, &headers).await?;
            if current
                .as_ref()
                .is_none_or(|s| s.id != signup_id || s.consumed_at.is_some() || s.expired)
            {
                let token = crypto::random_token(accounts_core::crypto::prefix::SIGNUP);
                let changed_rows=sqlx::query("update signup_sessions set secret_hash=$2 where id=$1 and consumed_at is null and expires_at>now()")
                    .bind(signup_id).bind(state.keys.pepper.hash(&token)).execute(&mut *conn).await?.rows_affected();
                if changed_rows != 1 {
                    return Err(ApiError::gone(
                        "signup_expired",
                        "The sign-up proof expired. Start sign-in again.",
                    ));
                }
                jar.insert(
                    accounts_core::http::cookies::cookie_name(
                        &state.settings,
                        accounts_core::http::SIGNUP_COOKIE,
                    ),
                    token,
                );
                changed = true;
            }
        }
    }
    if let (Some(account_uuid), Some(proof_id)) =
        (&flow.account_uuid, flow.extras.browser_session_id)
    {
        let name = accounts_core::http::cookies::cookie_name(
            &state.settings,
            accounts_core::http::SESSION_COOKIE,
        );
        let current = if let Some(token) = jar.get(&name) {
            accounts_core::repo::sessions::lookup(conn, &state.keys.pepper, token).await?
        } else {
            None
        };
        if current
            .as_ref()
            .is_none_or(|session| session.account_uuid != *account_uuid)
        {
            let original = accounts_core::repo::sessions::get(conn, proof_id)
                .await?
                .ok_or_else(|| {
                    ApiError::unauthenticated(
                        "identity_not_verified",
                        "The original sign-in ended. Start again.",
                    )
                })?;
            if original.account_uuid != *account_uuid
                || original.revoked_at.is_some()
                || original.expires_at <= time::OffsetDateTime::now_utc()
            {
                return Err(ApiError::unauthenticated(
                    "identity_not_verified",
                    "The original sign-in ended. Start again.",
                ));
            }
            let (token, replacement) = accounts_core::repo::sessions::create(
                conn,
                &state.keys.pepper,
                account_uuid,
                meta.ip.as_deref(),
                meta.user_agent.as_deref(),
            )
            .await?;
            accounts_core::repo::sessions::revoke(conn, account_uuid, proof_id).await?;
            jar.insert(name, token);
            // Make subsequent recovery point to the active replacement.
            let mut locked = crate::flow::model::lock(conn, flow_id)
                .await?
                .ok_or_else(|| {
                    ApiError::not_found("flow_not_found", "The Accounts sign-in was not found.")
                })?;
            locked.extras.browser_session_id = Some(replacement.id);
            crate::flow::model::save(conn, &locked).await?;
            sqlx::query("update authorization_codes set browser_session_id=$3 where flow_id=$1 and browser_session_id=$2 and consumed_at is null")
                .bind(flow_id).bind(proof_id).bind(replacement.id).execute(&mut *conn).await?;
            changed = true;
        }
    }
    Ok(changed)
}

async fn verified_action(
    State(state): State<AppState>,
    meta: accounts_core::http::ClientMeta,
    headers: HeaderMap,
    Json(input): Json<VerifiedAction>,
) -> ApiResult<Response> {
    if !input.capability.starts_with("sivf_") {
        return Err(ApiError::unauthenticated(
            "invalid_capability",
            "The verified sign-in capability is invalid.",
        ));
    }
    // Only an authenticated backend waits for one of the few permits.
    {
        let mut conn = state.db.acquire().await?;
        let c = client(&mut conn, &input.interface_id).await?;
        verified_secret(&c, &state, &headers, &input.interface_origin)?;
    }
    let _permit = VERIFIED_ACTIONS
        .acquire()
        .await
        .map_err(|_| ApiError::internal("Verified sign-in is unavailable."))?;
    let mut tx = state.db.begin().await?;
    let c = client(&mut tx, &input.interface_id).await?;
    verified_secret(&c, &state, &headers, &input.interface_origin)?;
    let hash = state.keys.pepper.hash(&input.capability);
    let bridge=sqlx::query_as::<_,VerifiedBridge>("select interface_revision,signin_flow_id,sealed_cookies,interface_origin,redirect_uri,state,code_challenge,interface_flow_id,review_snapshot,decision_hash,decision_result,(expires_at>now()) as live from verified_interface_auth_flows where capability_hash=$1 and interface_id=$2 for update")
        .bind(hash).bind(&input.interface_id).fetch_optional(&mut *tx).await?.ok_or_else(||ApiError::unauthenticated("invalid_capability","The verified sign-in capability is invalid."))?;
    if !bridge.live
        || bridge.interface_revision != c.revision
        || bridge.interface_origin != input.interface_origin
        || !c.redirect_uris.contains(&bridge.redirect_uri)
    {
        return Err(ApiError::unauthenticated(
            "invalid_capability",
            "The verified sign-in expired or its Interface configuration changed.",
        ));
    }
    if input.action == "decision" {
        if let Some(saved) = &bridge.decision_result {
            let hash = idempotency::request_hash(&input.payload);
            if bridge.decision_hash.as_ref() != Some(&hash) {
                return Err(ApiError::conflict(
                    "flow_decided",
                    "This sign-in already has a different decision.",
                ));
            }
            let scope = format!("verified-decision:{}", input.interface_id);
            let result =
                idempotency::unseal(&state.keys.keyring, &scope, &input.capability, saved)?;
            tx.commit().await?;
            return Ok(response(result));
        }
    }
    let plain = state.keys.keyring.decrypt_string(&bridge.sealed_cookies)?;
    let mut jar: std::collections::BTreeMap<String, String> = serde_json::from_str(&plain)
        .map_err(|_| ApiError::internal("Could not read verified sign-in state."))?;
    let flow_id = bridge.signin_flow_id.clone();
    let recovered = recover_verified_cookie(&mut tx, &state, &flow_id, &mut jar, &meta).await?;
    if recovered {
        let session_name = accounts_core::http::cookies::cookie_name(
            &state.settings,
            accounts_core::http::SESSION_COOKIE,
        );
        let session_id = if let Some(token) = jar.get(&session_name) {
            accounts_core::repo::sessions::lookup(&mut tx, &state.keys.pepper, token)
                .await?
                .map(|session| session.id)
        } else {
            None
        };
        let sealed = state
            .keys
            .keyring
            .encrypt_str(&serde_json::to_string(&jar)?)?;
        sqlx::query("update verified_interface_auth_flows set sealed_cookies=$2,browser_session_id=$3 where capability_hash=$1")
            .bind(state.keys.pepper.hash(&input.capability)).bind(sealed).bind(session_id).execute(&mut *tx).await?;
        tx.commit().await?;
        let current = crate::flow::handlers::get_flow(
            State(state.clone()),
            meta,
            bridge_headers(&state, &jar)?,
            accounts_core::http::Path(flow_id),
        )
        .await?;
        return Ok(response(json!({"flow":public_flow_view(current.view)?})));
    }
    let probe = crate::flow::model::get(&mut tx, &flow_id)
        .await?
        .ok_or_else(|| {
            ApiError::not_found("flow_not_found", "The Accounts sign-in was not found.")
        })?;
    let advanced = (input.action == "verify"
        && matches!(
            probe.step,
            crate::flow::Step::Signup
                | crate::flow::Step::SelectAccount
                | crate::flow::Step::Complete
        ))
        || (input.action == "signup" && probe.step == crate::flow::Step::Complete)
        || (input.action == "select_account"
            && probe.step == crate::flow::Step::Complete
            && input.payload.get("account_uuid").and_then(Value::as_str)
                == probe.account_uuid.as_deref());
    if advanced {
        tx.commit().await?;
        let current = crate::flow::handlers::get_flow(
            State(state.clone()),
            meta,
            bridge_headers(&state, &jar)?,
            accounts_core::http::Path(flow_id),
        )
        .await?;
        return Ok(response(json!({"flow":public_flow_view(current.view)?})));
    }
    let bound = bridge_headers(&state, &jar)?;
    let core_path = accounts_core::http::Path(flow_id.clone());
    let result = match input.action.as_str() {
        "get" => Some(
            crate::flow::handlers::get_flow(State(state.clone()), meta, bound, core_path).await?,
        ),
        "email" => Some(
            crate::flow::handlers::send_email_code(
                State(state.clone()),
                meta,
                bound,
                core_path,
                Json(parse_payload(input.payload.clone())?),
            )
            .await?,
        ),
        "phone" => Some(
            crate::flow::handlers::send_phone_code(
                State(state.clone()),
                meta,
                bound,
                core_path,
                Json(parse_payload(input.payload.clone())?),
            )
            .await?,
        ),
        "resend" => Some(
            crate::flow::handlers::resend_code(State(state.clone()), meta, bound, core_path)
                .await?,
        ),
        "verify" => Some(
            crate::flow::handlers::verify_code(
                State(state.clone()),
                meta,
                bound,
                core_path,
                Json(parse_payload(input.payload.clone())?),
            )
            .await?,
        ),
        "signup" => Some(
            crate::flow::signup::submit_signup(
                State(state.clone()),
                meta,
                bound,
                core_path,
                Json(parse_payload(input.payload.clone())?),
            )
            .await?,
        ),
        "select_account" => Some(
            crate::flow::handlers::select_account(
                State(state.clone()),
                meta,
                bound,
                core_path,
                Json(parse_payload(input.payload.clone())?),
            )
            .await?,
        ),
        "details_add" => Some(
            crate::flow::details::add_detail(
                State(state.clone()),
                meta,
                bound,
                core_path,
                Json(parse_payload(input.payload.clone())?),
            )
            .await?,
        ),
        "details_verify" => Some(
            crate::flow::details::verify_detail(
                State(state.clone()),
                meta,
                bound,
                core_path,
                Json(parse_payload(input.payload.clone())?),
            )
            .await?,
        ),
        "details_continue" => Some(
            crate::flow::details::continue_details(
                State(state.clone()),
                meta,
                bound,
                core_path,
                Json(parse_payload(input.payload.clone())?),
            )
            .await?,
        ),
        "details_back" => {
            Some(crate::flow::details::back(State(state.clone()), meta, bound, core_path).await?)
        }
        "signin_review" => Some(
            crate::flow::details::review(
                State(state.clone()),
                meta,
                bound,
                core_path,
                Json(parse_payload(input.payload.clone())?),
            )
            .await?,
        ),
        "review" | "decision" => None,
        _ => {
            return Err(ApiError::invalid_request(
                "Unsupported verified sign-in action.",
            ));
        }
    };
    if let Some(flow) = result {
        let view = public_flow_view(flow.view)?;
        merge_bridge_cookies(&mut jar, flow.cookies);
        let sealed = state
            .keys
            .keyring
            .encrypt_str(&serde_json::to_string(&jar)?)?;
        let session_token = jar.get(&accounts_core::http::cookies::cookie_name(
            &state.settings,
            accounts_core::http::SESSION_COOKIE,
        ));
        let session_id = if let Some(token) = session_token {
            accounts_core::repo::sessions::lookup(&mut tx, &state.keys.pepper, token)
                .await?
                .map(|session| session.id)
        } else {
            None
        };
        sqlx::query("update verified_interface_auth_flows set sealed_cookies=$2,browser_session_id=$3 where capability_hash=$1")
            .bind(state.keys.pepper.hash(&input.capability)).bind(sealed).bind(session_id).execute(&mut *tx).await?;
        tx.commit().await?;
        return Ok(response(json!({"flow":view})));
    }
    let session_cookie = jar
        .get(&accounts_core::http::cookies::cookie_name(
            &state.settings,
            accounts_core::http::SESSION_COOKIE,
        ))
        .ok_or_else(|| {
            ApiError::forbidden(
                "identity_not_verified",
                "Complete account verification first.",
            )
        })?;
    let session =
        accounts_core::repo::sessions::lookup(&mut tx, &state.keys.pepper, session_cookie)
            .await?
            .ok_or_else(|| {
                ApiError::unauthenticated("invalid_session", "The verified account session ended.")
            })?;
    let account = active_subject(&mut tx, &session.account_uuid).await?;
    let who = AccountAuth {
        account,
        via: accounts_core::http::AuthVia::Session {
            session_id: session.id,
        },
    };
    if input.action == "review" {
        if let Some(review) = bridge.review_snapshot {
            tx.commit().await?;
            return Ok(response(json!({"review":review})));
        }
        let proved_flow = crate::flow::model::get(&mut tx, &bridge.signin_flow_id)
            .await?
            .ok_or_else(|| {
                ApiError::not_found("flow_not_found", "The Accounts sign-in was not found.")
            })?;
        let approved:bool=sqlx::query_scalar("select exists(select 1 from authorization_codes where flow_id=$1 and app_id=$2 and account_uuid=$3 and browser_session_id=$4 and consumed_at is null and expires_at>now())")
            .bind(&bridge.signin_flow_id).bind(accounts_core::FIRST_PARTY_APP_ID).bind(&session.account_uuid).bind(session.id).fetch_one(&mut *tx).await?;
        if !approved
            || proved_flow.step != crate::flow::Step::Complete
            || proved_flow.account_uuid.as_deref() != Some(&session.account_uuid)
        {
            return Err(ApiError::forbidden(
                "identity_not_verified",
                "Complete the Interface sign-in pages first.",
            ));
        }
        let review = response_json(
            begin_interface(
                state.clone(),
                who,
                Start {
                    interface_id: input.interface_id.clone(),
                    redirect_uri: bridge.redirect_uri,
                    state: bridge.state,
                    code_challenge: bridge.code_challenge,
                    code_challenge_method: "S256".into(),
                    signin_proof: None,
                },
                Some(proved_flow.extras.interface_scopes),
            )
            .await?,
        )
        .await?;
        let review_id = review["flow_id"]
            .as_str()
            .ok_or_else(|| ApiError::internal("The Interface review is invalid."))?;
        sqlx::query("update verified_interface_auth_flows set interface_flow_id=$2,review_snapshot=$3 where capability_hash=$1")
            .bind(state.keys.pepper.hash(&input.capability)).bind(review_id).bind(&review).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(response(json!({"review":review})))
    } else {
        let review_id = bridge.interface_flow_id.ok_or_else(|| {
            ApiError::conflict("review_required", "Read the app review before deciding.")
        })?;
        let decision = parse_payload(input.payload.clone())?;
        let result = response_json(
            decide(State(state.clone()), who, Path(review_id), Json(decision)).await?,
        )
        .await?;
        let scope = format!("verified-decision:{}", input.interface_id);
        let sealed_result =
            idempotency::seal(&state.keys.keyring, &scope, &input.capability, &result)?;
        let empty_jar = state.keys.keyring.encrypt_str("{}")?;
        sqlx::query("update verified_interface_auth_flows set sealed_cookies=$2,decision_hash=$3,decision_result=$4 where capability_hash=$1")
            .bind(state.keys.pepper.hash(&input.capability)).bind(empty_jar).bind(idempotency::request_hash(&input.payload)).bind(sealed_result).execute(&mut *tx).await?;
        accounts_core::repo::sessions::revoke(&mut tx, &session.account_uuid, session.id).await?;
        tx.commit().await?;
        Ok(response(result))
    }
}

#[cfg(test)]
mod tests {
    use super::VERIFIED_ACTIONS;
    use accounts_core::test_support::{Req, TestContext};
    use serde_json::json;

    #[tokio::test]
    async fn unauthenticated_verified_calls_do_not_wait_for_a_permit() {
        let ctx = TestContext::new().await;
        let _busy = VERIFIED_ACTIONS.acquire_many(2).await.expect("permits");
        for (path, body) in [
            (
                "/v1/verified-interface-auth/start",
                json!({"interface_id":"nobody","interface_origin":"https://nobody.example","redirect_uri":"https://nobody.example/callback","state":"s","code_challenge":"c","code_challenge_method":"S256"}),
            ),
            (
                "/v1/verified-interface-auth/action",
                json!({"interface_id":"nobody","interface_origin":"https://nobody.example","capability":"sivf_x","action":"get","payload":{}}),
            ),
        ] {
            let r = tokio::time::timeout(
                std::time::Duration::from_secs(5),
                ctx.call(crate::router(), Req::post(path).json(body)),
            )
            .await
            .expect("answered without waiting for a permit");
            assert_eq!(r.error_code(), Some("interface_not_found"), "{}", r.json);
        }
    }
}
