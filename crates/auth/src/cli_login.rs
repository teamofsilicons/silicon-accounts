//! Headless code sign-in for the silicon-accounts CLI (Carbons): `POST /v1/cli/login/start` sends a
//! code to a verified email or phone of an existing active Carbon; `POST /v1/cli/login/verify`
//! returns first-party tokens (aud = silicon-accounts). Only a verified address of an active Carbon
//! signs in (core's `contacts::lookup`); the 10-tries lockout counts every code sent to the
//! address (core's `otp::verify`).

use accounts_core::delivery;
use accounts_core::http::{ClientMeta, Json};
use accounts_core::models::{ActorKind, OtpChannel, OtpPurpose, Scope, TokenOrigin};
use accounts_core::normalize::{normalize_email, normalize_phone};
use accounts_core::repo::audit::{self, AuditEntry, SigninRecord};
use accounts_core::repo::contacts::{self, ContactKind, Holder};
use accounts_core::repo::rate_limit::{self, Limit};
use accounts_core::repo::{otp, tokens};
use accounts_core::timefmt::format_rfc3339_ms;
use accounts_core::{ApiError, ApiResult, AppState, FIRST_PARTY_APP_ID};
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use crate::util::{no_store, telemetry};

/// Lookups a network may make per 10 minutes (sends are also limited by the OTP rules).
pub const CLI_LOGIN_START_PER_IP: Limit = Limit::new(60, 600);

/// `{"email"}` or `{"phone","country"?}`.
#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct StartBody {
    pub email: Option<String>,
    pub phone: Option<String>,
    pub country: Option<String>,
}

fn account_not_found(destination: &str, settings: &accounts_core::Settings) -> ApiError {
    ApiError::not_found(
        "account_not_found",
        format!("No active Carbon account signs in with {destination}."),
    )
    .hint(format!(
        "Sign up (or finish setting up an imported account) at {} first, then run `silicon-accounts login` again.",
        settings.public_url
    ))
}

/// `POST /v1/cli/login/start` (public) → `{"challenge_id","destination","expires_at"}`.
pub async fn start(
    State(state): State<AppState>,
    meta: ClientMeta,
    Json(body): Json<StartBody>,
) -> ApiResult<Response> {
    let email = body
        .email
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let phone = body
        .phone
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let (channel, destination) = match (email, phone) {
        (Some(_), Some(_)) => {
            return Err(ApiError::invalid_request(
                "Send either email or phone, not both: the code goes to one of them.",
            ));
        }
        (Some(e), None) => (OtpChannel::Email, normalize_email(e)?),
        (None, Some(p)) => (
            OtpChannel::Phone,
            normalize_phone(p, body.country.as_deref())?,
        ),
        (None, None) => {
            return Err(ApiError::invalid_request(
                "Send the email or phone number of your Carbon account: {\"email\":\"…\"} or {\"phone\":\"+…\"}.",
            )
            .hint("For a local phone number also send \"country\", e.g. \"IN\"."));
        }
    };
    let mut tx = state.db.begin().await?;
    rate_limit::enforce(
        &mut tx,
        &rate_limit::bucket("cli_login_start:ip", meta.ip_or_unknown()),
        CLI_LOGIN_START_PER_IP,
        "code sign-ins started from this network",
    )
    .await?;
    let kind = match channel {
        OtpChannel::Email => ContactKind::Email,
        OtpChannel::Phone => ContactKind::Phone,
    };
    // Only a verified email/phone of an active Carbon signs in.
    let Holder::Active(account) = contacts::lookup(&mut tx, kind, &destination).await? else {
        // Commit the rate-limit hit: lookups of unknown addresses count too.
        tx.commit().await?;
        return Err(account_not_found(&destination, &state.settings));
    };
    let created = otp::send(
        &mut tx,
        &state.keys.pepper,
        &state.settings,
        &otp::NewChallenge {
            purpose: OtpPurpose::CliLogin,
            channel,
            destination: &destination,
            account_uuid: Some(&account.uuid),
            flow_id: None,
            ip: meta.ip.as_deref(),
        },
    )
    .await?;
    let message_id = delivery::enqueue_otp(
        &mut tx,
        &state.settings,
        &created.challenge,
        &created.code,
        None,
    )
    .await?;
    tx.commit().await?;
    delivery::spawn_deliver(&state, message_id);
    telemetry(
        &state,
        "cli_login.code_sent",
        Some(0.5),
        json!({"channel": channel.as_str()}),
    );
    let mut response = axum::Json(json!({
        "challenge_id": created.challenge.id,
        "destination": created.challenge.masked_destination(),
        "expires_at": format_rfc3339_ms(created.challenge.expires_at),
    }))
    .into_response();
    no_store(response.headers_mut());
    Ok(response)
}

/// `{"challenge_id","code","client_label"?}`.
#[derive(Debug, Deserialize, Serialize)]
pub struct VerifyBody {
    pub challenge_id: String,
    pub code: String,
    #[serde(default)]
    pub client_label: Option<String>,
}

/// `POST /v1/cli/login/verify` (public) → token response (aud = silicon-accounts, origin cli_code).
/// Errors: 422 `invalid_code` (`details.remaining_attempts`), 423 `verification_locked`,
/// 410 `code_expired`, 409 `code_already_used`, 404 `challenge_not_found`, 404
/// `account_not_found` (the address no longer signs in to that account).
pub async fn verify(
    State(state): State<AppState>,
    meta: ClientMeta,
    Json(body): Json<VerifyBody>,
) -> ApiResult<Response> {
    let challenge_id = Uuid::parse_str(body.challenge_id.trim()).map_err(|_| {
        ApiError::invalid_request(format!(
            "challenge_id '{}' is not the id /v1/cli/login/start returned (a UUID).",
            body.challenge_id.chars().take(64).collect::<String>()
        ))
        .hint("Pass the challenge_id from the start response unchanged.")
    })?;
    let challenge = otp::verify(
        &state.db,
        &state.keys.pepper,
        &state.settings,
        challenge_id,
        &body.code,
        &otp::Expect {
            purpose: Some(OtpPurpose::CliLogin),
            ..Default::default()
        },
        Some(otp::Attempt {
            app_id: FIRST_PARTY_APP_ID,
            ip: meta.ip.as_deref(),
            user_agent: meta.user_agent.as_deref(),
        }),
    )
    .await?;
    let account_uuid = challenge
        .account_uuid
        .clone()
        .ok_or_else(|| ApiError::internal("a cli_login challenge without an account"))?;
    let kind = match challenge.channel {
        OtpChannel::Email => ContactKind::Email,
        OtpChannel::Phone => ContactKind::Phone,
    };
    let mut tx = state.db.begin().await?;
    // The address must still be a verified email/phone of that active Carbon (it may have been
    // removed, or the account deleted, since the code was sent).
    let account = match contacts::lookup(&mut tx, kind, &challenge.destination).await? {
        Holder::Active(a) if a.uuid == account_uuid => a,
        _ => {
            return Err(ApiError::not_found(
                "account_not_found",
                format!(
                    "{} no longer signs in to the account the code was sent for (it was removed from the account, or the account can't sign in any more).",
                    challenge.masked_destination()
                ),
            )
            .hint("Run `silicon-accounts login` again with an email or phone that is on your account."));
        }
    };
    let label = body
        .client_label
        .as_deref()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .unwrap_or("silicon-accounts CLI");
    let tokens = tokens::issue_tokens(
        &mut tx,
        &state.keys,
        &state.settings,
        tokens::IssueRequest {
            account: &account,
            app_id: FIRST_PARTY_APP_ID,
            origin: TokenOrigin::CliCode,
            scopes: &[Scope::Profile],
            browser_session_id: None,
            label: Some(label),
            ip: meta.ip.as_deref(),
            user_agent: meta.user_agent.as_deref(),
            nonce: None,
            auth_time: None,
        },
    )
    .await?;
    audit::signin(
        &mut tx,
        &SigninRecord {
            account_uuid: Some(&account.uuid),
            app_id: Some(FIRST_PARTY_APP_ID),
            method: match kind {
                ContactKind::Email => audit::method::EMAIL,
                ContactKind::Phone => audit::method::PHONE,
            },
            outcome: audit::outcome::SUCCESS,
            ip: meta.ip.as_deref(),
            user_agent: meta.user_agent.as_deref(),
        },
    )
    .await?;
    audit::record(
        &mut tx,
        &AuditEntry {
            account_uuid: Some(&account.uuid),
            app_id: Some(FIRST_PARTY_APP_ID),
            target_kind: Some("session"),
            details: json!({"kind": "cli", "label": label, "via": kind.code()}),
            ip: meta.ip.as_deref(),
            ..AuditEntry::new(ActorKind::Account, Some(&account.uuid), "session.created")
        },
    )
    .await?;
    tx.commit().await?;
    telemetry(
        &state,
        "cli_login.completed",
        Some(1.0),
        json!({"channel": kind.code()}),
    );
    let mut response = axum::Json(tokens).into_response();
    no_store(response.headers_mut());
    Ok(response)
}
