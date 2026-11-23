//! Signing in with a passkey on the hosted sign-in (Anil, 2026-11-23).
//!
//! Two calls, both bound to the flow like every other method step:
//!
//! - `POST /v1/flows/{id}/passkey/options` → the request options for
//!   `navigator.credentials.get()`. The challenge is kept on the flow (`FlowExtras.passkey_challenge`).
//! - `POST /v1/flows/{id}/passkey` with `{"credential": PublicKeyCredential.toJSON()}` → the flow,
//!   signed in. The authenticator answered with one of the Carbon's passkeys; the account is the
//!   one that passkey was added to. A passkey never signs anyone up: an unknown passkey is 401
//!   `passkey_unknown`.
//!
//! The account rules are the code path's: an inactive or archived account can't sign in, and an
//! app that only takes accounts with an email at its domains checks the account's emails.

use accounts_core::http::{ClientMeta, Json, Path};
use accounts_core::models::{AccountKind, AccountStatus, Method};
use accounts_core::repo::audit::{self, SigninRecord};
use accounts_core::repo::{accounts, passkeys, rate_limit};
use accounts_core::webauthn::{self, AuthenticationResponse, RelyingParty, StoredKey};
use accounts_core::{ApiError, ApiResult, AppState};
use axum::extract::State;
use axum::http::{HeaderMap, Method as HttpMethod};
use serde::Deserialize;
use serde_json::Value;

use super::browser;
use super::handlers::{method_not_enabled, persist_failure, respond};
use super::model::{self, Step};
use super::{FlowApp, FlowResponse, load_bound, next};

/// Passkey sign-ins started from one IP per minute.
const OPTIONS_PER_IP: rate_limit::Limit = rate_limit::Limit::new(60, 60);

/// `POST /v1/flows/{id}/passkey/options` → `PublicKeyCredentialRequestOptionsJSON`.
pub async fn options(
    State(state): State<AppState>,
    meta: ClientMeta,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let mut tx = state.db.begin().await?;
    let mut flow = load_bound(&mut tx, &state, &headers, &HttpMethod::POST, &id, true).await?;
    model::ensure_live(&flow)?;
    model::ensure_step(
        &flow,
        &[Step::ChooseMethod, Step::VerifyCode],
        "sign in with a passkey",
    )?;
    let fa = FlowApp::load_for_flow(&mut tx, &state.settings, &flow).await?;
    fa.ensure_active()?;
    if !fa
        .config
        .available_methods(&state.settings)
        .contains(&Method::Passkey)
    {
        return Err(method_not_enabled(&state, &fa, Method::Passkey));
    }
    if let Some(ip) = meta.ip.as_deref() {
        rate_limit::enforce(
            &mut tx,
            &rate_limit::bucket("passkey_signin:ip", ip),
            OPTIONS_PER_IP,
            "passkey sign-ins from this address",
        )
        .await?;
    }
    let challenge = webauthn::new_challenge();
    flow.extras.passkey_challenge = Some(challenge.clone());
    model::save(&mut tx, &flow).await?;
    tx.commit().await?;
    let rp = RelyingParty::from_settings(&state.settings);
    Ok(Json(webauthn::request_options(&rp, &challenge)))
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PasskeyBody {
    credential: Value,
}

fn not_recognised() -> ApiError {
    ApiError::unauthenticated(
        "passkey_unknown",
        "This passkey isn't on any Silicon Accounts account, or it was removed.",
    )
    .hint("Sign in another way, then add a passkey under Security on the account site.")
}

/// `POST /v1/flows/{id}/passkey` with `{"credential"}` → the flow, signed in.
pub async fn sign_in(
    State(state): State<AppState>,
    meta: ClientMeta,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<PasskeyBody>,
) -> ApiResult<FlowResponse> {
    let response: AuthenticationResponse =
        serde_json::from_value(body.credential).map_err(|_| {
            ApiError::bad_request(
                "passkey_invalid",
                "`credential` isn't a passkey answer: send PublicKeyCredential.toJSON() from navigator.credentials.get().",
            )
        })?;
    let credential_id = response.credential_id().map_err(|_| not_recognised())?;

    let mut tx = state.db.begin().await?;
    let mut flow = load_bound(&mut tx, &state, &headers, &HttpMethod::POST, &id, true).await?;
    model::ensure_live(&flow)?;
    model::ensure_step(
        &flow,
        &[Step::ChooseMethod, Step::VerifyCode],
        "sign in with a passkey",
    )?;
    let fa = FlowApp::load_for_flow(&mut tx, &state.settings, &flow).await?;
    if let Err(e) = fa.ensure_active() {
        return persist_failure(tx, &mut flow, e).await;
    }
    if !fa
        .config
        .available_methods(&state.settings)
        .contains(&Method::Passkey)
    {
        let e = method_not_enabled(&state, &fa, Method::Passkey);
        return persist_failure(tx, &mut flow, e).await;
    }
    // The challenge is used once, whatever happens next.
    let Some(challenge) = flow.extras.passkey_challenge.take() else {
        let e = ApiError::conflict(
            "passkey_challenge_missing",
            "This passkey answer isn't for the current sign-in (it was already used, or never asked for).",
        )
        .hint(format!("Start again with POST /v1/flows/{id}/passkey/options."));
        return persist_failure(tx, &mut flow, e).await;
    };

    let Some(key) = passkeys::find_by_credential_for_update(&mut tx, &credential_id).await? else {
        return persist_failure(tx, &mut flow, not_recognised()).await;
    };
    let rp = RelyingParty::from_settings(&state.settings);
    let stored = StoredKey {
        public_key: &key.public_key,
        algorithm: i64::from(key.algorithm),
        sign_count: u32::try_from(key.sign_count).unwrap_or(u32::MAX),
    };
    let verified = match webauthn::verify_authentication(&rp, &challenge, &response, &stored) {
        Ok(v) => v,
        Err(error) => {
            tracing::info!(%error, passkey = %key.id, "passkey sign-in refused");
            audit::signin(
                &mut tx,
                &SigninRecord {
                    account_uuid: Some(&key.account_uuid),
                    app_id: Some(&fa.app.app_id),
                    method: audit::method::PASSKEY,
                    outcome: audit::outcome::FAILED,
                    ip: meta.ip.as_deref(),
                    user_agent: meta.user_agent.as_deref(),
                },
            )
            .await?;
            let e = ApiError::unauthenticated(
                "passkey_invalid",
                "This passkey couldn't be checked, so it didn't sign you in.",
            )
            .hint("Try again, or sign in another way.");
            return persist_failure(tx, &mut flow, e).await;
        }
    };

    let account = accounts::get(&mut tx, &key.account_uuid)
        .await?
        .ok_or_else(not_recognised)?;
    if account.kind != AccountKind::Carbon || account.status != AccountStatus::Active {
        let e = ApiError::conflict(
            "account_unavailable",
            format!(
                "This passkey belongs to an account that can't sign in ({}).",
                account.status
            ),
        )
        .hint("Sign in with the account's email or phone number instead.");
        return persist_failure(tx, &mut flow, e).await;
    }
    if !next::account_domain_allowed(&mut tx, &fa.config, &account).await? {
        let e = next::domain_not_allowed(&fa, None);
        next::record_refusal(
            &mut tx,
            &meta,
            &fa,
            &account,
            audit::method::PASSKEY,
            &e.code,
        )
        .await?;
        return persist_failure(tx, &mut flow, e).await;
    }
    passkeys::record_use(&mut tx, key.id, verified.sign_count, verified.backed_up).await?;

    let browser_before = browser::current(&mut tx, &state, &headers).await?;
    let signed = browser::sign_in(
        &mut tx,
        &state,
        &headers,
        &meta,
        &account.uuid,
        flow.extras.link_request_id.is_some(),
    )
    .await?;
    flow.extras.browser_session_id = Some(signed.session_id);
    flow.extras.auth_method = Some(audit::method::PASSKEY.to_string());
    flow.extras.new_account = false;
    flow.extras.error = None;
    next::advance(&mut tx, &state, &meta, &mut flow, &fa, &account).await?;
    model::save(&mut tx, &flow).await?;
    let response = respond(
        &mut tx,
        &state,
        &meta,
        browser_before.as_ref(),
        &flow,
        &fa,
        signed.cookies,
    )
    .await?;
    tx.commit().await?;
    Ok(response)
}
