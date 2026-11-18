//! Registration proves a contact for one new Carbon. It cannot authenticate,
//! restore or edit an existing account, and never returns a session credential.
use crate::{interfaces::registration_client, suggest};
use accounts_core::repo::audit::{self, AuditEntry};
use accounts_core::{
    ApiError, ApiResult, AppState, delivery,
    http::{ClientMeta, IdempotencyKey, Json, Path},
    ids::AccountId,
    models::{AccountKind, AccountStatus, OtpChannel, OtpPurpose, VerifiedVia},
    normalize,
    repo::{
        accounts::{self, NewCarbon, NewContact},
        idempotency, otp, rate_limit,
    },
    timefmt,
    views::AccountSummary,
};
use axum::{
    Router,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/v1/interface-accounts/{interface_id}/registrations",
            post(start),
        )
        .route(
            "/v1/interface-accounts/{interface_id}/registrations/{id}/complete",
            post(complete),
        )
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Start {
    email: Option<String>,
    phone: Option<String>,
    country: Option<String>,
    display_name: Option<String>,
    id: Option<String>,
    timezone: Option<String>,
    dob: Option<String>,
}

#[derive(Deserialize, Serialize)]
struct Profile {
    display_name: String,
    id: String,
    timezone: String,
    dob: String,
}

async fn start(
    State(state): State<AppState>,
    headers: HeaderMap,
    meta: ClientMeta,
    key: IdempotencyKey,
    Path(interface): Path<String>,
    Json(body): Json<Start>,
) -> ApiResult<Response> {
    {
        let mut conn = state.db.acquire().await?;
        registration_client(&mut conn, &interface, &state, &headers).await?;
    }
    let scope = format!("interface-registration:{interface}");
    idempotency::run(&state, Some(key.as_str()), &scope, &body, false, || {
        create_registration(&state, &interface, &headers, &meta, &body)
    })
    .await
}

fn check_domain(
    policy: &accounts_core::models::SigninConfig,
    channel: OtpChannel,
    destination: &str,
) -> ApiResult<()> {
    if !policy.allowed_email_domains.is_empty()
        && (channel != OtpChannel::Email || !policy.email_domain_allowed(destination))
    {
        return Err(ApiError::forbidden(
            "email_domain_not_allowed",
            "Use an email at a domain accepted by this interface.",
        ));
    }
    Ok(())
}

async fn create_registration(
    state: &AppState,
    interface: &str,
    headers: &HeaderMap,
    meta: &ClientMeta,
    body: &Start,
) -> ApiResult<(StatusCode, Value)> {
    let (channel, destination) = match (&body.email, &body.phone) {
        (Some(e), None) => (OtpChannel::Email, normalize::normalize_email(e)?),
        (None, Some(p)) => (
            OtpChannel::Phone,
            normalize::normalize_phone(p, body.country.as_deref())?,
        ),
        _ => {
            return Err(ApiError::invalid_request(
                "Supply one email or one phone number.",
            ));
        }
    };
    let mut tx = state.db.begin().await?;
    let policy = registration_client(&mut tx, interface, state, headers).await?;
    check_domain(&policy, channel, &destination)?;
    let email = (channel == OtpChannel::Email).then_some(destination.as_str());
    let default_name = suggest::display_name(None, email, body.phone.as_deref());
    let display_name =
        normalize::validate_display_name(body.display_name.as_deref().unwrap_or(&default_name))
            .map_err(ApiError::invalid_request)?;
    let timezone = normalize::normalize_timezone(body.timezone.as_deref().unwrap_or("UTC"))
        .map_err(ApiError::invalid_request)?;
    let today = timefmt::today_in(&timezone);
    let dob = match &body.dob {
        Some(d) => timefmt::parse_date(d)
            .and_then(|d| normalize::validate_dob(d, today))
            .map_err(ApiError::invalid_request)?,
        None => normalize::default_dob(today),
    };
    let id = match &body.id {
        Some(id) => AccountId::parse_for_kind(id, AccountKind::Carbon)
            .map_err(|e| accounts::invalid_id_error(&e))?,
        None => {
            accounts::suggest_id(
                &mut tx,
                AccountKind::Carbon,
                &suggest::id_seeds(email, &display_name),
            )
            .await?
        }
    };
    if !accounts::id_availability(&mut tx, &id.to_string(), None)
        .await?
        .available
    {
        return Err(ApiError::conflict(
            "id_unavailable",
            "Choose an available CarbonID.",
        ));
    }
    rate_limit::enforce(
        &mut tx,
        &rate_limit::bucket("interface-registration", interface),
        rate_limit::Limit::new(100, 600),
        "registrations started by this interface",
    )
    .await?;
    let profile = Profile {
        display_name,
        id: id.to_string(),
        timezone,
        dob: timefmt::format_date(dob),
    };
    let sent = otp::send(
        &mut tx,
        &state.keys.pepper,
        &state.settings,
        &otp::NewChallenge {
            purpose: OtpPurpose::InterfaceRegistration,
            channel,
            destination: &destination,
            account_uuid: None,
            flow_id: Some(interface),
            ip: meta.ip.as_deref(),
        },
    )
    .await?;
    let message =
        delivery::enqueue_otp(&mut tx, &state.settings, &sent.challenge, &sent.code, None).await?;
    sqlx::query("insert into interface_account_registrations(challenge_id,interface_id,profile) values ($1,$2,$3)")
        .bind(sent.challenge.id).bind(interface).bind(json!(profile)).execute(&mut *tx).await?;
    tx.commit().await?;
    delivery::spawn_deliver(state, message);
    Ok((
        StatusCode::CREATED,
        json!({
            "registration_id": sent.challenge.id, "expires_at": timefmt::format_rfc3339_ms(sent.challenge.expires_at),
            "destination": sent.challenge.masked_destination(),
        }),
    ))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Code {
    code: String,
}

async fn complete(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((interface, id)): Path<(String, Uuid)>,
    key: IdempotencyKey,
    Json(body): Json<Code>,
) -> ApiResult<Response> {
    let mut tx = state.db.begin().await?;
    let policy = registration_client(&mut tx, &interface, &state, &headers).await?;
    let (profile, result, receipt): (Value, Option<Value>, Option<Vec<u8>>) = sqlx::query_as("select profile,result,completion_hash from interface_account_registrations where challenge_id=$1 and interface_id=$2 for update")
        .bind(id).bind(&interface).fetch_optional(&mut *tx).await?
        .ok_or_else(||ApiError::not_found("registration_not_found","Start a registration with this interface."))?;
    let retry_proof =
        state
            .keys
            .pepper
            .hash(&format!("{}:{}:{}", id, key.as_str(), body.code.trim()));
    if let Some(result) = result {
        if receipt
            .as_deref()
            .is_some_and(|hash| accounts_core::crypto::constant_time_eq(hash, &retry_proof))
        {
            return Ok((StatusCode::OK, Json(result)).into_response());
        }
        return Err(ApiError::conflict(
            "registration_complete",
            "This registration has finished. Retry with the original key and code.",
        ));
    }
    let profile: Profile = serde_json::from_value(profile)?;
    let proof = otp::verify_in_transaction(
        &mut tx,
        &state.keys.pepper,
        &state.settings,
        id,
        &body.code,
        &otp::Expect {
            purpose: Some(OtpPurpose::InterfaceRegistration),
            flow_id: Some(&interface),
            account_uuid: None,
        },
        None,
    )
    .await;
    let stored = match proof {
        Ok(challenge) => challenge,
        Err(e) => {
            if e.code == "invalid_code" {
                tx.commit().await?;
            }
            return Err(e);
        }
    };
    check_domain(&policy, stored.channel, &stored.destination)?;
    let contact = NewContact {
        value: stored.destination,
        verified_via: Some(VerifiedVia::Code),
    };
    let (emails, phones) = match stored.channel {
        OtpChannel::Email => (vec![contact], vec![]),
        OtpChannel::Phone => (vec![], vec![contact]),
    };
    let account = accounts::create_carbon(
        &mut tx,
        &state.settings,
        NewCarbon {
            id: AccountId::parse_for_kind(&profile.id, AccountKind::Carbon)
                .map_err(|e| accounts::invalid_id_error(&e))?,
            display_name: profile.display_name,
            timezone: profile.timezone,
            dob: timefmt::parse_date(&profile.dob).map_err(ApiError::invalid_request)?,
            pfp_url: None,
            status: AccountStatus::Active,
            emails,
            phones,
            actor: format!("interface:{interface}"),
        },
    )
    .await?;
    audit::record(
        &mut tx,
        &AuditEntry {
            account_uuid: Some(&account.uuid),
            app_id: Some(accounts_core::PROFILE_APP_ID),
            target_kind: Some("account"),
            target_id: Some(&account.uuid),
            details: json!({"interface_id":interface,"method":stored.channel.as_str()}),
            ..AuditEntry::new(
                accounts_core::models::ActorKind::Account,
                Some(&account.uuid),
                "account.created",
            )
        },
    )
    .await?;
    let result = json!({"account":AccountSummary::from_account(&account)});
    sqlx::query("update interface_account_registrations set result=$2,completion_hash=$3 where challenge_id=$1").bind(id).bind(&result).bind(retry_proof.as_slice()).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(result)).into_response())
}
