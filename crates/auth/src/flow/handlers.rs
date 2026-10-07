//! `GET /v1/flows/{id}` and the method steps: continue as the browser's account, switch
//! account, send an email/phone code, resend it, verify it.

use accounts_core::delivery;
use accounts_core::http::{ClientMeta, Json, Path};
use accounts_core::models::{AccountKind, AccountStatus, Method, OtpChannel, OtpPurpose};
use accounts_core::normalize::{normalize_email, normalize_phone};
use accounts_core::repo::contacts::{self, ContactKind, Holder};
use accounts_core::repo::{accounts, otp};
use accounts_core::{ApiError, ApiResult, AppState};
use axum::extract::State;
use axum::http::{HeaderMap, Method as HttpMethod};
use cookie::Cookie;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::PgConnection;

use super::browser::{self, BrowserAccount};
use super::model::{self, Flow, FlowError, Pending, Step};
use super::signup::{self, NewSignupSession};
use super::view::{self, ViewContext};
use super::{FlowApp, FlowResponse, details, load_bound, next};
use crate::util::telemetry;

/// Builds the response view for a flow.
async fn respond(
    conn: &mut PgConnection,
    state: &AppState,
    meta: &ClientMeta,
    browser: Option<&BrowserAccount>,
    flow: &Flow,
    fa: &FlowApp,
    cookies: Vec<Cookie<'static>>,
) -> ApiResult<FlowResponse> {
    let view = view::build(
        conn,
        &ViewContext {
            state,
            meta,
            browser,
        },
        flow,
        fa,
    )
    .await?;
    Ok(FlowResponse::ok(view, cookies))
}

/// Saves the flow with `error` recorded and back at `choose_method`, commits, and returns the
/// error (the attempt failed, but the flow must remember why and be usable again).
async fn persist_failure(
    mut tx: sqlx::Transaction<'_, sqlx::Postgres>,
    flow: &mut Flow,
    error: ApiError,
) -> ApiResult<FlowResponse> {
    flow.reset_to_choose_method();
    flow.extras.error = Some(FlowError::from_api(&error));
    model::save(&mut tx, flow).await?;
    tx.commit().await?;
    Err(error)
}

/// 403 `method_not_enabled`.
pub fn method_not_enabled(state: &AppState, fa: &FlowApp, method: Method) -> ApiError {
    let methods = fa.config.available_methods(&state.settings);
    ApiError::forbidden(
        "method_not_enabled",
        format!(
            "{} doesn't offer sign-in with {method}; it offers {}.",
            fa.app.name,
            if methods.is_empty() {
                "no methods".to_string()
            } else {
                methods
                    .iter()
                    .map(Method::as_str)
                    .collect::<Vec<_>>()
                    .join(", ")
            }
        ),
    )
    .hint("Use one of the methods in FlowView.methods.")
    .detail(
        "methods",
        methods.iter().map(Method::as_str).collect::<Vec<_>>(),
    )
}

// ----------------------------------------------------------------------------- GET

/// `GET /v1/flows/{id}` (flow). Also claims a Google/Apple outcome the provider callback left
/// on the flow: this is where the browser session or sign-up cookie is set (see
/// [`model::Pending`]). A flow on a details page that no longer exists (the app changed its
/// flow meanwhile) moves on here ([`details::repair`]).
pub async fn get_flow(
    State(state): State<AppState>,
    meta: ClientMeta,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult<FlowResponse> {
    let mut tx = state.db.begin().await?;
    let mut flow = load_bound(&mut tx, &state, &headers, &HttpMethod::GET, &id, true).await?;
    model::ensure_live(&flow)?;
    let fa = FlowApp::load(&mut tx, &state.settings, &flow.app_id).await?;
    let browser = browser::current(&mut tx, &state, &headers).await?;
    let mut cookies = Vec::new();
    if flow.extras.pending.is_some() && !flow.step.is_terminal() {
        cookies = claim_pending(&mut tx, &state, &headers, &meta, &mut flow, &fa).await?;
        model::save(&mut tx, &flow).await?;
    }
    if flow.step == Step::Signup
        && let Some(session_id) = flow.signup_session_id
    {
        // A sign-up session that ran out (48 h) or was used elsewhere can't continue here.
        let live = signup::get_session(&mut tx, session_id)
            .await?
            .is_some_and(|s| s.is_live());
        if !live {
            flow.reset_to_choose_method();
            flow.extras.error = Some(FlowError::new(
                "signup_expired",
                "The sign-up for this email, phone or provider account is no longer open (it expired after 48 hours, or was already used).",
                "Verify the email or phone (or sign in with Google/Apple) again.",
            ));
            model::save(&mut tx, &flow).await?;
        }
    }
    if flow.step == Step::Details
        && fa.app.is_active()
        && details::repair(&mut tx, &state, &headers, &meta, &mut flow, &fa).await?
    {
        model::save(&mut tx, &flow).await?;
    }
    let response = respond(
        &mut tx,
        &state,
        &meta,
        browser.as_ref(),
        &flow,
        &fa,
        cookies,
    )
    .await?;
    tx.commit().await?;
    Ok(response)
}

/// Attaches a provider outcome to the bound browser: signs it in (existing account) or opens
/// the sign-up session (new identity / imported account).
pub async fn claim_pending(
    conn: &mut PgConnection,
    state: &AppState,
    headers: &HeaderMap,
    meta: &ClientMeta,
    flow: &mut Flow,
    fa: &FlowApp,
) -> ApiResult<Vec<Cookie<'static>>> {
    let Some(pending) = flow.extras.pending.take() else {
        return Ok(Vec::new());
    };
    if let Err(e) = fa.ensure_active() {
        flow.reset_to_choose_method();
        flow.extras.error = Some(FlowError::from_api(&e));
        return Ok(Vec::new());
    }
    match pending {
        Pending::SignIn {
            account_uuid,
            provider,
        } => {
            let account = accounts::get(conn, &account_uuid).await?;
            let Some(account) = account
                .filter(|a| a.kind == AccountKind::Carbon && a.status == AccountStatus::Active)
            else {
                flow.reset_to_choose_method();
                flow.extras.error = Some(FlowError::new(
                    "account_not_active",
                    format!(
                        "The account linked to this {} sign-in can't sign in any more (it was deleted or changed meanwhile).",
                        provider.display_name()
                    ),
                    "Pick a sign-in method again.",
                ));
                return Ok(Vec::new());
            };
            let signed = browser::sign_in(conn, state, headers, meta, &account.uuid).await?;
            flow.extras.browser_session_id = Some(signed.session_id);
            flow.extras.auth_method = Some(provider.as_str().to_string());
            flow.extras.new_account = false;
            next::advance(conn, state, meta, flow, fa, &account).await?;
            Ok(signed.cookie.into_iter().collect())
        }
        Pending::Signup(p) => {
            let (session, cookie) = signup::create_session(
                conn,
                state,
                headers,
                &NewSignupSession {
                    provider: Some(p.provider),
                    provider_subject: Some(p.subject),
                    provider_client_id: Some(p.client_id),
                    provider_email: p.email,
                    suggested_display_name: p.display_name,
                    suggested_pfp_url: p.pfp_url,
                    claim_account_uuid: p.claim_account_uuid,
                    ..Default::default()
                },
            )
            .await?;
            flow.reset_to_choose_method();
            flow.step = Step::Signup;
            flow.signup_session_id = Some(session.id);
            flow.extras.auth_method = Some(p.provider.as_str().to_string());
            Ok(vec![cookie])
        }
    }
}

// ----------------------------------------------------------------------------- continue / switch

/// `POST /v1/flows/{id}/continue` (flow + session): sign in as the browser's account.
pub async fn continue_as(
    State(state): State<AppState>,
    meta: ClientMeta,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult<FlowResponse> {
    let mut tx = state.db.begin().await?;
    let mut flow = load_bound(&mut tx, &state, &headers, &HttpMethod::POST, &id, true).await?;
    model::ensure_live(&flow)?;
    model::ensure_step(
        &flow,
        &[Step::ChooseMethod, Step::VerifyCode],
        "continue as the browser's account",
    )?;
    let fa = FlowApp::load(&mut tx, &state.settings, &flow.app_id).await?;
    fa.ensure_active()?;
    if !fa.config.remember_browser {
        return Err(ApiError::forbidden(
            "continue_not_allowed",
            format!(
                "{} asks every Carbon to sign in again (remember_browser is off), so the browser's account can't be reused.",
                fa.app.name
            ),
        )
        .hint("Sign in with one of the methods in FlowView.methods."));
    }
    if flow.prompt.login {
        return Err(ApiError::forbidden(
            "reauthentication_required",
            format!(
                "{} asked for a fresh sign-in (prompt=login), so the browser's account can't be reused.",
                fa.app.name
            ),
        )
        .hint("Sign in with one of the methods in FlowView.methods."));
    }
    let Some(current) = browser::current(&mut tx, &state, &headers).await? else {
        return Err(ApiError::unauthenticated(
            "session_required",
            "This browser isn't signed in to Silicon Accounts, so there is no account to continue as.",
        )
        .hint("Sign in with one of the methods in FlowView.methods."));
    };
    if current.account.kind != AccountKind::Carbon {
        return Err(ApiError::forbidden(
            "carbon_only",
            format!(
                "{} is a Silicon; Silicons never use the sign-in pages.",
                current.account.display_id()
            ),
        )
        .hint(
            "A Silicon signs in to apps with a short-lived token: `accounts login --app <app_id>`.",
        ));
    }
    if !current.is_active_carbon() {
        return Err(browser::not_active(&current.account));
    }
    if !next::account_domain_allowed(&mut tx, &fa.config, &current.account).await? {
        return Err(next::domain_not_allowed(&fa, None));
    }
    flow.reset_to_choose_method();
    flow.extras.error = None;
    flow.extras.auth_method = Some(accounts_core::repo::audit::method::SESSION.to_string());
    flow.extras.browser_session_id = Some(current.session_id);
    next::advance(&mut tx, &state, &meta, &mut flow, &fa, &current.account).await?;
    model::save(&mut tx, &flow).await?;
    let response = respond(
        &mut tx,
        &state,
        &meta,
        Some(&current),
        &flow,
        &fa,
        Vec::new(),
    )
    .await?;
    tx.commit().await?;
    telemetry(
        &state,
        "flow.continued",
        Some(0.5),
        json!({"app_id": fa.app.app_id, "next_step": flow.step.as_str()}),
    );
    Ok(response)
}

/// `POST /v1/flows/{id}/switch` (flow): forget the chosen account; back to `choose_method`
/// without offering the browser's account again.
pub async fn switch_account(
    State(state): State<AppState>,
    meta: ClientMeta,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult<FlowResponse> {
    let mut tx = state.db.begin().await?;
    let mut flow = load_bound(&mut tx, &state, &headers, &HttpMethod::POST, &id, true).await?;
    model::ensure_live(&flow)?;
    model::ensure_step(
        &flow,
        &[
            Step::ChooseMethod,
            Step::VerifyCode,
            Step::Signup,
            Step::Details,
            Step::Review,
        ],
        "switch account",
    )?;
    let fa = FlowApp::load(&mut tx, &state.settings, &flow.app_id).await?;
    // "Not you?" on the sign-up step: that sign-up ends here (its verified email, phone or
    // provider account can't be resumed by the next flow in this browser) and the browser
    // forgets it. The cookie is cleared only when it names that sign-up, so a stale tab never
    // ends a newer sign-up of the same browser.
    let mut cookies = Vec::new();
    if flow.step == Step::Signup
        && let Some(session_id) = flow.signup_session_id
    {
        signup::expire_session(&mut tx, session_id).await?;
        accounts_core::repo::photos::discard_signup_photos(&mut tx, session_id).await?;
        let browser_session = signup::from_cookie(&mut tx, &state, &headers).await?;
        if browser_session.is_none_or(|s| s.id == session_id || !s.is_live()) {
            cookies.push(accounts_core::http::cookies::clear_cookie(
                &state.settings,
                accounts_core::http::cookies::SIGNUP_COOKIE,
            ));
        }
    }
    flow.reset_to_choose_method();
    flow.extras.error = None;
    flow.extras.switched = true;
    model::save(&mut tx, &flow).await?;
    let response = respond(&mut tx, &state, &meta, None, &flow, &fa, cookies).await?;
    tx.commit().await?;
    Ok(response)
}

// ----------------------------------------------------------------------------- codes

/// `POST /v1/flows/{id}/email` body.
#[derive(Debug, Deserialize, Serialize)]
pub struct EmailBody {
    pub email: String,
}

/// `POST /v1/flows/{id}/phone` body (`country` = ISO 3166 code for local numbers).
#[derive(Debug, Deserialize, Serialize)]
pub struct PhoneBody {
    pub phone: String,
    #[serde(default)]
    pub country: Option<String>,
}

/// `POST /v1/flows/{id}/email` (flow): sends a 6-digit sign-in code by email.
pub async fn send_email_code(
    State(state): State<AppState>,
    meta: ClientMeta,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<EmailBody>,
) -> ApiResult<FlowResponse> {
    send_signin_code(
        &state,
        &meta,
        &headers,
        &id,
        OtpChannel::Email,
        &body.email,
        None,
    )
    .await
}

/// `POST /v1/flows/{id}/phone` (flow): sends a 6-digit sign-in code by SMS.
pub async fn send_phone_code(
    State(state): State<AppState>,
    meta: ClientMeta,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<PhoneBody>,
) -> ApiResult<FlowResponse> {
    send_signin_code(
        &state,
        &meta,
        &headers,
        &id,
        OtpChannel::Phone,
        &body.phone,
        body.country.as_deref(),
    )
    .await
}

async fn send_signin_code(
    state: &AppState,
    meta: &ClientMeta,
    headers: &HeaderMap,
    id: &str,
    channel: OtpChannel,
    raw: &str,
    country: Option<&str>,
) -> ApiResult<FlowResponse> {
    let mut tx = state.db.begin().await?;
    let mut flow = load_bound(&mut tx, state, headers, &HttpMethod::POST, id, true).await?;
    model::ensure_live(&flow)?;
    model::ensure_step(
        &flow,
        &[Step::ChooseMethod, Step::VerifyCode],
        "send a sign-in code",
    )?;
    let fa = FlowApp::load(&mut tx, &state.settings, &flow.app_id).await?;
    fa.ensure_active()?;
    let method = match channel {
        OtpChannel::Email => Method::Email,
        OtpChannel::Phone => Method::Phone,
    };
    if !fa
        .config
        .available_methods(&state.settings)
        .contains(&method)
    {
        return Err(method_not_enabled(state, &fa, method));
    }
    let destination = match channel {
        OtpChannel::Email => normalize_email(raw)?,
        OtpChannel::Phone => normalize_phone(raw, country)?,
    };
    if channel == OtpChannel::Email && !fa.config.email_domain_allowed(&destination) {
        return Err(next::domain_not_allowed(&fa, Some(&destination)));
    }
    let created = otp::send(
        &mut tx,
        &state.keys.pepper,
        &state.settings,
        &otp::NewChallenge {
            purpose: OtpPurpose::Signin,
            channel,
            destination: &destination,
            account_uuid: None,
            flow_id: Some(&flow.id),
            ip: meta.ip.as_deref(),
        },
    )
    .await?;
    let message_id = delivery::enqueue_otp(
        &mut tx,
        &state.settings,
        &created.challenge,
        &created.code,
        fa.name_for_messages(),
    )
    .await?;
    flow.reset_to_choose_method();
    flow.step = Step::VerifyCode;
    flow.challenge_id = Some(created.challenge.id);
    flow.extras.error = None;
    model::save(&mut tx, &flow).await?;
    let response = respond(&mut tx, state, meta, None, &flow, &fa, Vec::new()).await?;
    tx.commit().await?;
    delivery::spawn_deliver(state, message_id);
    telemetry(
        state,
        "flow.code_sent",
        Some(0.3),
        json!({"app_id": fa.app.app_id, "channel": channel.as_str()}),
    );
    Ok(response)
}

/// `POST /v1/flows/{id}/resend` (flow): a new code to the same destination (the previous one
/// stops working; counts toward the send limit). Works for the sign-in code and for the code
/// adding a missing email or phone on a details page.
pub async fn resend_code(
    State(state): State<AppState>,
    meta: ClientMeta,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult<FlowResponse> {
    let mut tx = state.db.begin().await?;
    let mut flow = load_bound(&mut tx, &state, &headers, &HttpMethod::POST, &id, true).await?;
    model::ensure_live(&flow)?;
    model::ensure_step(&flow, &[Step::VerifyCode, Step::Details], "resend a code")?;
    let Some(challenge_id) = flow.challenge_id else {
        return Err(ApiError::conflict(
            "no_code_sent",
            format!("Sign-in flow '{}' hasn't sent a code yet, so there is nothing to resend.", flow.id),
        )
        .hint(format!(
            "Send a code first: POST /v1/flows/{id}/details/add with {{\"email\": …}} or {{\"phone\": …}}."
        )));
    };
    let fa = FlowApp::load(&mut tx, &state.settings, &flow.app_id).await?;
    fa.ensure_active()?;
    if flow.step == Step::Details {
        browser::require_flow_account(&mut tx, &state, &headers, &flow).await?;
    }
    let previous = otp::get(&mut tx, challenge_id).await?.ok_or_else(|| {
        ApiError::internal(format!(
            "challenge {challenge_id} of flow {} is missing",
            flow.id
        ))
    })?;
    let created = otp::send(
        &mut tx,
        &state.keys.pepper,
        &state.settings,
        &otp::NewChallenge {
            purpose: previous.purpose,
            channel: previous.channel,
            destination: &previous.destination,
            account_uuid: previous.account_uuid.as_deref(),
            flow_id: Some(&flow.id),
            ip: meta.ip.as_deref(),
        },
    )
    .await?;
    let message_id = delivery::enqueue_otp(
        &mut tx,
        &state.settings,
        &created.challenge,
        &created.code,
        fa.name_for_messages(),
    )
    .await?;
    flow.challenge_id = Some(created.challenge.id);
    flow.extras.error = None;
    model::save(&mut tx, &flow).await?;
    let response = respond(&mut tx, &state, &meta, None, &flow, &fa, Vec::new()).await?;
    tx.commit().await?;
    delivery::spawn_deliver(&state, message_id);
    telemetry(
        &state,
        "flow.code_resent",
        Some(0.3),
        json!({"app_id": fa.app.app_id, "channel": previous.channel.as_str(), "purpose": previous.purpose.as_str()}),
    );
    Ok(response)
}

/// `{"code":"123456"}`.
#[derive(Debug, Deserialize, Serialize)]
pub struct CodeBody {
    pub code: String,
}

/// `POST /v1/flows/{id}/verify` (flow): checks the sign-in code.
///
/// Errors from the code: 422 `invalid_code` (`details.remaining_attempts`), 423
/// `verification_locked` (`Retry-After`), 410 `code_expired`, 409 `code_already_used`. The
/// 10-tries lockout counts every code sent to the address, whichever flow sent it
/// ([`codes`]).
/// Outcomes: a verified email/phone of an active account signs the browser in and moves on;
/// an imported (unclaimed) account goes to sign-up prefilled with its data; an unknown
/// email/phone opens a 48-hour sign-up session (403 `signup_not_allowed` when the app takes
/// no new accounts). An unverified row an import left on another account identifies nobody:
/// it is removed and the address counts as unknown ([`contact`]).
pub async fn verify_code(
    State(state): State<AppState>,
    meta: ClientMeta,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<CodeBody>,
) -> ApiResult<FlowResponse> {
    let (challenge_id, app_id) = {
        let mut conn = state.db.acquire().await?;
        let flow = load_bound(&mut conn, &state, &headers, &HttpMethod::POST, &id, false).await?;
        model::ensure_live(&flow)?;
        model::ensure_step(&flow, &[Step::VerifyCode], "verify a sign-in code")?;
        let challenge_id = flow.challenge_id.ok_or_else(|| {
            ApiError::internal(format!(
                "flow {} is at verify_code without a challenge",
                flow.id
            ))
        })?;
        (challenge_id, flow.app_id)
    };
    // Verification persists failures on its own (the lockout must survive this request).
    let challenge = otp::verify(
        &state.db,
        &state.keys.pepper,
        &state.settings,
        challenge_id,
        &body.code,
        &otp::Expect {
            purpose: Some(OtpPurpose::Signin),
            flow_id: Some(&id),
            account_uuid: None,
        },
        Some(otp::Attempt {
            app_id: &app_id,
            ip: meta.ip.as_deref(),
            user_agent: meta.user_agent.as_deref(),
        }),
    )
    .await?;

    let mut tx = state.db.begin().await?;
    let mut flow = model::lock(&mut tx, &id)
        .await?
        .ok_or_else(|| model::flow_not_found(&id))?;
    if flow.step != Step::VerifyCode || flow.challenge_id != Some(challenge_id) {
        return Err(ApiError::conflict(
            "flow_changed",
            format!("Sign-in flow '{id}' changed while the code was being checked (another tab?)."),
        )
        .hint(format!("GET /v1/flows/{id} to see where it is now.")));
    }
    let fa = FlowApp::load(&mut tx, &state.settings, &flow.app_id).await?;
    if let Err(e) = fa.ensure_active() {
        return persist_failure(tx, &mut flow, e).await;
    }
    let destination = challenge.destination.clone();
    let (kind, method) = match challenge.channel {
        OtpChannel::Email => (ContactKind::Email, "email"),
        OtpChannel::Phone => (ContactKind::Phone, "phone"),
    };
    if kind == ContactKind::Email && !fa.config.email_domain_allowed(&destination) {
        let e = next::domain_not_allowed(&fa, Some(&destination));
        return persist_failure(tx, &mut flow, e).await;
    }
    // The code proves the address: only a verified email/phone signs into an account.
    let holder = contacts::after_proof(&mut tx, kind, &destination, meta.ip.as_deref()).await?;
    let browser_before = browser::current(&mut tx, &state, &headers).await?;
    let mut cookies = Vec::new();
    match holder {
        Holder::Active(a) => {
            let signed = browser::sign_in(&mut tx, &state, &headers, &meta, &a.uuid).await?;
            flow.extras.browser_session_id = Some(signed.session_id);
            flow.extras.auth_method = Some(method.to_string());
            flow.extras.new_account = false;
            next::advance(&mut tx, &state, &meta, &mut flow, &fa, &a).await?;
            cookies.extend(signed.cookie);
        }
        Holder::Unclaimed(a) => {
            let (session, cookie) = signup::create_session(
                &mut tx,
                &state,
                &headers,
                &contact_session(kind, &destination, Some(a.uuid.clone())),
            )
            .await?;
            flow.reset_to_choose_method();
            flow.step = Step::Signup;
            flow.signup_session_id = Some(session.id);
            flow.extras.auth_method = Some(method.to_string());
            cookies.push(cookie);
        }
        Holder::Unavailable(a) => {
            let e = ApiError::conflict(
                "account_unavailable",
                format!(
                    "{destination} belongs to an account that can't sign in ({}).",
                    a.status
                ),
            )
            .hint("Sign in with another email or phone.");
            return persist_failure(tx, &mut flow, e).await;
        }
        // `after_proof` removed an unproven row: the address belongs to nobody.
        Holder::Free | Holder::Unproven(_) => {
            if !fa.config.allow_signup && !fa.first_party() {
                let e = next::signup_not_allowed(&fa);
                return persist_failure(tx, &mut flow, e).await;
            }
            let (session, cookie) = signup::create_session(
                &mut tx,
                &state,
                &headers,
                &contact_session(kind, &destination, None),
            )
            .await?;
            flow.reset_to_choose_method();
            flow.step = Step::Signup;
            flow.signup_session_id = Some(session.id);
            flow.extras.auth_method = Some(method.to_string());
            cookies.push(cookie);
        }
    }
    model::save(&mut tx, &flow).await?;
    let response = respond(
        &mut tx,
        &state,
        &meta,
        browser_before.as_ref(),
        &flow,
        &fa,
        cookies,
    )
    .await?;
    tx.commit().await?;
    telemetry(
        &state,
        "flow.code_verified",
        Some(0.5),
        json!({"app_id": fa.app.app_id, "channel": method, "next_step": flow.step.as_str()}),
    );
    Ok(response)
}

fn contact_session(
    kind: ContactKind,
    destination: &str,
    claim_account_uuid: Option<String>,
) -> NewSignupSession {
    match kind {
        ContactKind::Email => NewSignupSession {
            verified_email: Some(destination.to_string()),
            claim_account_uuid,
            ..Default::default()
        },
        ContactKind::Phone => NewSignupSession {
            verified_phone: Some(destination.to_string()),
            claim_account_uuid,
            ..Default::default()
        },
    }
}
