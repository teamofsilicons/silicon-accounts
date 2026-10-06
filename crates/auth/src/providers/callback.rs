//! `GET|POST /v1/oauth/callback/{provider}`: where Google (redirect, GET) and Apple
//! (form_post, cross-site POST) send the browser back.
//!
//! 1. The `state` names the flow and proves this is the answer to its pending leg.
//! 2. **Only the browser that started the sign-in may deliver the answer**: the request must
//!    carry the flow's binding cookie (`sa_flow`). A Google redirect is a top-level GET, so it
//!    carries the SameSite=Lax cookie. Apple's form_post is a cross-site POST, which doesn't:
//!    its answer is parked on the leg and the browser is sent (303) to
//!    `GET /v1/oauth/callback/{provider}?ticket=…`, a same-site GET that carries the cookie and
//!    is checked the same way. An answer delivered by any other browser is discarded (the leg
//!    is used up and the flow says why): otherwise a genuine Google or Apple link forwarded to
//!    a victim would sign the sender's browser in as the victim.
//! 3. The leg is consumed (single use), the code is exchanged at the provider's token endpoint
//!    (Google: client secret + PKCE verifier; Apple: ES256 client secret JWT) and the id_token
//!    is verified.
//! 4. The identity is resolved: a known (provider, sub) → its account; else a verified email
//!    of an account → the identity is linked to it; else a new sign-up. The outcome is left on
//!    the flow as [`Pending`] and claimed by the bound browser's next request (normally the
//!    SPA's `GET /v1/flows/{id}`), which sets the session or sign-up cookie.
//! 5. The browser is redirected (302) to `{PUBLIC_URL}/authorize/flow/{flow_id}`; provider
//!    errors end there too, carried on the flow as `error`.

use accounts_core::crypto::{b64url, b64url_decode, constant_time_eq};
use accounts_core::http::{ClientMeta, Path};
use accounts_core::models::{Account, AccountKind, AccountStatus, ActorKind, Provider};
use accounts_core::normalize::{normalize_email, validate_https_url};
use accounts_core::repo::audit::{self, AuditEntry, SigninRecord};
use accounts_core::repo::contacts::{self, ContactKind, Holder};
use accounts_core::repo::{accounts, identities};
use accounts_core::{ApiError, ApiResult, AppState, Settings};
use axum::body::Bytes;
use axum::extract::{RawQuery, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::PgConnection;

use super::id_token::{self, Expectations, ProviderClaims};
use super::start::{flow_id_of_state, provider_state, unknown_provider};
use super::{Credential, ProviderClient, apple, callback_url, endpoints, resolve_client};
use crate::flow::model::{
    self, Flow, FlowError, ParkedAnswer, Pending, PendingSignup, ProviderLeg, Step,
};
use crate::flow::{FlowApp, next};
use crate::util::{decrypt_text, encrypt_text, no_store, telemetry, with_query};

/// What arrives at the callback (query string or form fields).
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct CallbackParams {
    pub code: Option<String>,
    pub state: Option<String>,
    pub error: Option<String>,
    pub error_description: Option<String>,
    /// Apple, first authorization only: `{"name":{"firstName","lastName"},"email"}`.
    pub user: Option<String>,
    /// Ours: the one-time ticket of a parked form_post answer (see [`ParkedAnswer`]).
    pub ticket: Option<String>,
}

/// The provider's answer itself (what a parked form_post keeps).
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(default)]
struct Answer {
    code: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
    user: Option<String>,
}

impl From<CallbackParams> for Answer {
    fn from(p: CallbackParams) -> Answer {
        Answer {
            code: p.code,
            error: p.error,
            error_description: p.error_description,
            user: p.user,
        }
    }
}

/// How the answer arrived.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Via {
    Get,
    Post,
}

/// Where the browser goes next.
#[derive(Debug)]
enum Next {
    /// 302 to the flow page.
    Flow(String),
    /// 303 to this same-site URL (a parked form_post continues there with its cookies).
    Continue(String),
}

/// `GET /v1/oauth/callback/{provider}` (Google's redirect, or a parked form_post coming back).
pub async fn callback_get(
    State(state): State<AppState>,
    meta: ClientMeta,
    headers: HeaderMap,
    Path(provider): Path<String>,
    RawQuery(query): RawQuery,
) -> Response {
    let params = serde_urlencoded::from_str::<CallbackParams>(query.as_deref().unwrap_or(""))
        .unwrap_or_default();
    handle(&state, &meta, &headers, &provider, params, Via::Get).await
}

/// `POST /v1/oauth/callback/{provider}` (Apple's form_post).
pub async fn callback_post(
    State(state): State<AppState>,
    meta: ClientMeta,
    headers: HeaderMap,
    Path(provider): Path<String>,
    body: Bytes,
) -> Response {
    let params = serde_urlencoded::from_bytes::<CallbackParams>(&body).unwrap_or_default();
    handle(&state, &meta, &headers, &provider, params, Via::Post).await
}

async fn handle(
    state: &AppState,
    meta: &ClientMeta,
    headers: &HeaderMap,
    provider_raw: &str,
    mut params: CallbackParams,
    via: Via,
) -> Response {
    let Some(provider) = Provider::parse(provider_raw) else {
        return error_page(&state.settings, headers, unknown_provider(provider_raw));
    };
    let result = match (params.ticket.take(), via) {
        (Some(ticket), Via::Get) => resume(state, meta, headers, provider, &ticket).await,
        (Some(_), Via::Post) => Err(invalid_state(
            provider,
            "a ticket can only come back with a GET request",
        )),
        (None, via) => receive(state, meta, headers, provider, params, via).await,
    };
    match result {
        Ok(Next::Flow(flow_id)) => redirect_to_flow(&state.settings, &flow_id),
        Ok(Next::Continue(location)) => see_other(&location),
        Err(e) => error_page(&state.settings, headers, e),
    }
}

/// 400 `invalid_state`.
fn invalid_state(provider: Provider, why: &str) -> ApiError {
    ApiError::bad_request(
        "invalid_state",
        format!(
            "This {} answer doesn't belong to a sign-in that is waiting for it: {why}.",
            provider.display_name()
        ),
    )
    .hint("Start the sign-in again from the app (an answer can only be used once, in the browser that started it).")
}

/// A provider answer (`state` + code or error) as the provider delivered it.
async fn receive(
    state: &AppState,
    meta: &ClientMeta,
    headers: &HeaderMap,
    provider: Provider,
    params: CallbackParams,
    via: Via,
) -> ApiResult<Next> {
    let state_param = params
        .state
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| invalid_state(provider, "it has no state parameter"))?
        .to_string();
    let flow_id = flow_id_of_state(&state_param)
        .ok_or_else(|| {
            invalid_state(
                provider,
                "its state parameter was not made by Silicon Accounts",
            )
        })?
        .to_string();

    let mut tx = state.db.begin().await?;
    let mut flow = model::lock(&mut tx, &flow_id)
        .await?
        .ok_or_else(|| invalid_state(provider, "the sign-in no longer exists"))?;
    let mut leg = match &flow.extras.provider {
        Some(leg)
            if leg.provider == provider && hash_matches(state, &leg.state_hash, &state_param) =>
        {
            leg.clone()
        }
        Some(_) => {
            return Err(invalid_state(
                provider,
                "its state doesn't match the sign-in's",
            ));
        }
        None => {
            return Err(invalid_state(
                provider,
                "the answer was already used, or the sign-in moved on",
            ));
        }
    };
    let answer = Answer::from(params);
    if model::check_binding(state, headers, &flow).is_ok() {
        return process(state, meta, tx, flow, leg, answer).await;
    }
    if via == Via::Post {
        if leg.parked.is_some() {
            return Err(invalid_state(
                provider,
                "this answer was already received; the browser continues at the link it was sent to",
            ));
        }
        // A cross-site form_post carries no SameSite=Lax cookies: park the answer and continue
        // with a same-site GET, which carries them.
        let ticket = provider_state(&flow.id);
        leg.parked = Some(ParkedAnswer {
            ticket_hash: b64url(&state.keys.pepper.hash(&ticket)),
            answer_enc: encrypt_text(&state.keys.keyring, &serde_json::to_string(&answer)?)?,
        });
        flow.extras.provider = Some(leg);
        model::save(&mut tx, &flow).await?;
        tx.commit().await?;
        let location = with_query(
            &callback_url(&state.settings, provider),
            &[("ticket", Some(&ticket))],
        );
        return Ok(Next::Continue(location));
    }
    discard(state, tx, flow, provider).await
}

/// A parked form_post answer, back with the browser's cookies.
async fn resume(
    state: &AppState,
    meta: &ClientMeta,
    headers: &HeaderMap,
    provider: Provider,
    ticket: &str,
) -> ApiResult<Next> {
    let ticket = ticket.trim();
    let flow_id = flow_id_of_state(ticket)
        .ok_or_else(|| invalid_state(provider, "its ticket was not made by Silicon Accounts"))?
        .to_string();
    let mut tx = state.db.begin().await?;
    let flow = model::lock(&mut tx, &flow_id)
        .await?
        .ok_or_else(|| invalid_state(provider, "the sign-in no longer exists"))?;
    let (leg, parked) = match &flow.extras.provider {
        Some(leg) if leg.provider == provider => match &leg.parked {
            Some(p) if hash_matches(state, &p.ticket_hash, ticket) => (leg.clone(), p.clone()),
            _ => {
                return Err(invalid_state(
                    provider,
                    "its ticket doesn't match the answer waiting for this sign-in",
                ));
            }
        },
        _ => {
            return Err(invalid_state(
                provider,
                "the answer was already used, or the sign-in moved on",
            ));
        }
    };
    if model::check_binding(state, headers, &flow).is_err() {
        return discard(state, tx, flow, provider).await;
    }
    let answer: Answer =
        serde_json::from_str(&decrypt_text(&state.keys.keyring, &parked.answer_enc)?)?;
    process(state, meta, tx, flow, leg, answer).await
}

/// The answer reached a browser that didn't start the sign-in. It is thrown away: the leg is
/// used up (so the same answer can't be replayed in the browser that started it) and the flow
/// says why.
async fn discard(
    state: &AppState,
    mut tx: sqlx::Transaction<'static, sqlx::Postgres>,
    mut flow: Flow,
    provider: Provider,
) -> ApiResult<Next> {
    let name = provider.display_name();
    flow.extras.provider = None;
    if !flow.expired && matches!(flow.step, Step::ChooseMethod | Step::VerifyCode) {
        flow.extras.error = Some(FlowError::new(
            "provider_answer_elsewhere",
            format!(
                "The {name} answer for this sign-in arrived in a different browser, so it was discarded."
            ),
            format!("Pick a sign-in method again and finish {name} sign-in in this browser."),
        ));
    }
    model::save(&mut tx, &flow).await?;
    tx.commit().await?;
    tracing::warn!(
        flow_id = %flow.id,
        provider = provider.as_str(),
        "a provider answer arrived without the flow's binding cookie; discarded"
    );
    telemetry(
        state,
        "flow.provider_unbound",
        Some(0.4),
        json!({"app_id": flow.app_id, "provider": provider.as_str()}),
    );
    Err(ApiError::forbidden(
        "flow_not_bound",
        format!(
            "This {name} answer belongs to a sign-in that was started in another browser, so it can't be used here."
        ),
    )
    .hint(format!(
        "Start the sign-in again from the app in this browser. A {name} sign-in link only works in the browser that opened it, so don't use one someone sent you."
    )))
}

/// The bound answer: consume the leg, exchange the code, resolve the identity.
async fn process(
    state: &AppState,
    meta: &ClientMeta,
    mut tx: sqlx::Transaction<'static, sqlx::Postgres>,
    mut flow: Flow,
    leg: ProviderLeg,
    answer: Answer,
) -> ApiResult<Next> {
    let provider = leg.provider;
    let name = provider.display_name();
    let flow_id = flow.id.clone();

    // 1. Consume the leg.
    flow.extras.provider = None;
    let usable = !flow.expired && matches!(flow.step, Step::ChooseMethod | Step::VerifyCode);
    let early_error = if !usable {
        None
    } else if let Some(err) = answer.error.as_deref() {
        Some(provider_answer_error(
            provider,
            err,
            answer.error_description.as_deref(),
        ))
    } else if answer.code.as_deref().is_none_or(|c| c.trim().is_empty()) {
        Some(FlowError::new(
            "provider_error",
            format!("{name} sent the browser back without an authorization code."),
            "Try again, or use another sign-in method.",
        ))
    } else {
        None
    };
    if let Some(e) = &early_error {
        flow.extras.error = Some(e.clone());
    }
    model::save(&mut tx, &flow).await?;
    tx.commit().await?;
    if !usable || early_error.is_some() {
        if let Some(e) = &early_error {
            telemetry(
                state,
                "flow.provider_failed",
                Some(0.4),
                json!({"app_id": flow.app_id, "provider": provider.as_str(), "error": e.code}),
            );
        }
        return Ok(Next::Flow(flow_id));
    }
    let code = answer.code.clone().unwrap_or_default();

    // 2. Exchange the code and verify the id_token (no database locks held meanwhile).
    let outcome = exchange_and_verify(state, &flow.app_id, provider, &leg, code.trim()).await;
    let (fa, client, claims) = match outcome {
        Ok(v) => v,
        Err(e) => {
            record_error(state, &flow_id, provider, e).await?;
            return Ok(Next::Flow(flow_id));
        }
    };

    // 3. Resolve the identity and leave the outcome on the flow.
    let mut tx = state.db.begin().await?;
    let Some(mut flow) = model::lock(&mut tx, &flow_id).await? else {
        return Ok(Next::Flow(flow_id));
    };
    if flow.extras.provider.is_some() || !matches!(flow.step, Step::ChooseMethod | Step::VerifyCode)
    {
        // A newer attempt started (or the flow moved on) while we talked to the provider.
        return Ok(Next::Flow(flow_id));
    }
    let apple_name = answer.user.as_deref().and_then(apple_user_name);
    match resolve_identity(&mut tx, meta, &fa, &client, &claims, apple_name).await? {
        Ok(pending) => {
            flow.reset_to_choose_method();
            flow.extras.error = None;
            flow.extras.pending = Some(pending);
        }
        Err(e) => {
            flow.reset_to_choose_method();
            flow.extras.error = Some(e);
        }
    }
    model::save(&mut tx, &flow).await?;
    tx.commit().await?;
    telemetry(
        state,
        "flow.provider_returned",
        Some(0.5),
        json!({
            "app_id": flow.app_id,
            "provider": provider.as_str(),
            "mode": client.mode.as_str(),
            "outcome": match &flow.extras.pending {
                Some(Pending::SignIn { .. }) => "sign_in",
                Some(Pending::Signup(p)) if p.claim_account_uuid.is_some() => "finish_import",
                Some(Pending::Signup(_)) => "signup",
                None => flow.extras.error.as_ref().map(|e| e.code.as_str()).unwrap_or("error"),
            },
        }),
    );
    Ok(Next::Flow(flow_id))
}

/// Compares a presented secret (state or ticket) with its stored HMAC.
fn hash_matches(state: &AppState, stored_b64: &str, presented: &str) -> bool {
    match b64url_decode(stored_b64) {
        Ok(stored) => constant_time_eq(&state.keys.pepper.hash(presented), &stored),
        Err(_) => false,
    }
}

fn provider_answer_error(provider: Provider, error: &str, description: Option<&str>) -> FlowError {
    let name = provider.display_name();
    match error {
        "access_denied" | "user_cancelled_authorize" => FlowError::new(
            "provider_cancelled",
            format!("{name} sign-in was cancelled."),
            "Pick a sign-in method again.",
        ),
        other => {
            let detail = description
                .map(|d| format!(": {}", d.chars().take(300).collect::<String>()))
                .unwrap_or_default();
            FlowError::new(
                "provider_error",
                format!(
                    "{name} answered with the error '{}'{detail}.",
                    other.chars().take(100).collect::<String>()
                ),
                "Try again, or use another sign-in method.",
            )
        }
    }
}

/// Records a failure on the flow (if it is still waiting at a method step).
async fn record_error(
    state: &AppState,
    flow_id: &str,
    provider: Provider,
    error: FlowError,
) -> ApiResult<()> {
    let mut tx = state.db.begin().await?;
    if let Some(mut flow) = model::lock(&mut tx, flow_id).await?
        && flow.extras.provider.is_none()
        && matches!(flow.step, Step::ChooseMethod | Step::VerifyCode)
    {
        telemetry(
            state,
            "flow.provider_failed",
            Some(0.4),
            json!({"app_id": flow.app_id, "provider": provider.as_str(), "error": error.code}),
        );
        tracing::info!(flow_id, provider = provider.as_str(), code = %error.code, "provider sign-in failed");
        flow.reset_to_choose_method();
        flow.extras.error = Some(error);
        model::save(&mut tx, &flow).await?;
    }
    tx.commit().await?;
    Ok(())
}

async fn exchange_and_verify(
    state: &AppState,
    app_id: &str,
    provider: Provider,
    leg: &ProviderLeg,
    code: &str,
) -> Result<(FlowApp, ProviderClient, ProviderClaims), FlowError> {
    let name = provider.display_name();
    let to_flow = |e: ApiError| FlowError::from_api(&e);
    let (fa, client) = {
        let mut conn = state.db.acquire().await.map_err(|e| to_flow(e.into()))?;
        let fa = FlowApp::load(&mut conn, &state.settings, app_id)
            .await
            .map_err(to_flow)?;
        fa.ensure_active().map_err(to_flow)?;
        let method = match provider {
            Provider::Google => accounts_core::models::Method::Google,
            Provider::Apple => accounts_core::models::Method::Apple,
        };
        if !fa.config.methods.is_enabled(method) {
            return Err(to_flow(crate::flow::handlers::method_not_enabled(
                state, &fa, method,
            )));
        }
        let client = resolve_client(&mut conn, state, &fa, provider)
            .await
            .map_err(to_flow)?;
        (fa, client)
    };
    if client.client_id != leg.client_id {
        return Err(FlowError::new(
            "provider_config_changed",
            format!(
                "{}'s {name} setup changed while this sign-in was in progress.",
                fa.app.name
            ),
            "Start the sign-in again.",
        ));
    }
    let id_token = exchange_code(state, &client, leg, code).await?;
    let ep = endpoints(&state.settings, provider);
    let claims = id_token::verify(
        &state.http,
        &ep.jwks_url,
        &id_token,
        &Expectations {
            issuers: &ep.issuers,
            audience: &client.client_id,
            nonce: &leg.nonce,
        },
    )
    .await
    .map_err(|e| {
        tracing::warn!(provider = provider.as_str(), error = %e, "provider id_token refused");
        FlowError::new(
            "provider_token_invalid",
            format!("{name}'s answer couldn't be trusted: {e}."),
            "Try again; if it keeps failing, use another sign-in method.",
        )
    })?;
    Ok((fa, client, claims))
}

/// Exchanges the authorization code; returns the id_token.
async fn exchange_code(
    state: &AppState,
    client: &ProviderClient,
    leg: &ProviderLeg,
    code: &str,
) -> Result<String, FlowError> {
    let provider = client.provider;
    let name = provider.display_name();
    let ep = endpoints(&state.settings, provider);
    let mut form: Vec<(&str, String)> = vec![
        ("grant_type", "authorization_code".into()),
        ("code", code.to_string()),
        ("redirect_uri", callback_url(&state.settings, provider)),
        ("client_id", client.client_id.clone()),
    ];
    match &client.credential {
        Credential::GoogleSecret(secret) => {
            form.push(("client_secret", secret.clone()));
            if let Some(enc) = &leg.pkce_verifier_enc {
                let verifier =
                    decrypt_text(&state.keys.keyring, enc).map_err(|e| FlowError::from_api(&e))?;
                form.push(("code_verifier", verifier));
            }
        }
        Credential::AppleKey {
            team_id,
            key_id,
            private_key_pem,
        } => {
            let jwt = apple::client_secret(&apple::ClientSecretInput {
                team_id,
                key_id,
                services_id: &client.client_id,
                private_key_pem,
                audience: &state.settings.apple.issuer,
                now: time::OffsetDateTime::now_utc().unix_timestamp(),
            })
            .map_err(|m| {
                tracing::error!(error = %m, "Apple client secret could not be made");
                FlowError::new(
                    "provider_not_configured",
                    format!("Sign in with Apple is misconfigured: {m}."),
                    "Use another sign-in method; the app's owner (or the operator, for managed Apple) must fix the Apple key.",
                )
            })?;
            form.push(("client_secret", jwt));
        }
    }
    let unavailable = |why: String| {
        FlowError::new(
            "provider_unavailable",
            format!("Silicon Accounts couldn't reach {name} to finish signing in ({why})."),
            "Try again in a moment, or use another sign-in method.",
        )
    };
    let response = state
        .http
        .post(&ep.token_url)
        .header(header::ACCEPT, "application/json")
        .form(&form)
        .send()
        .await
        .map_err(|e| {
            let mut m = e.to_string();
            if let Some(i) = m.find(" for url (") {
                m.truncate(i);
            }
            unavailable(m)
        })?;
    let status = response.status();
    let body: Value = response.json().await.map_err(|_| {
        unavailable(format!(
            "its token endpoint answered HTTP {status} without JSON"
        ))
    })?;
    if !status.is_success() {
        let error = body["error"].as_str().unwrap_or("unknown_error");
        let description = body["error_description"].as_str().unwrap_or("");
        tracing::warn!(
            provider = provider.as_str(),
            status = status.as_u16(),
            error,
            "provider token exchange refused"
        );
        return Err(FlowError::new(
            "provider_error",
            format!(
                "{name} refused to exchange the sign-in code: {error}{}{}.",
                if description.is_empty() { "" } else { " — " },
                description.chars().take(300).collect::<String>()
            ),
            "Try again, or use another sign-in method.",
        ));
    }
    body["id_token"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| {
            FlowError::new(
                "provider_error",
                format!("{name}'s token response has no id_token."),
                "Try again, or use another sign-in method.",
            )
        })
}

/// `user` (Apple, first authorization) → "First Last".
pub fn apple_user_name(raw: &str) -> Option<String> {
    let v: Value = serde_json::from_str(raw).ok()?;
    let first = v["name"]["firstName"]
        .as_str()
        .unwrap_or("")
        .trim()
        .to_string();
    let last = v["name"]["lastName"]
        .as_str()
        .unwrap_or("")
        .trim()
        .to_string();
    let full = [first, last]
        .into_iter()
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    accounts_core::normalize::validate_display_name(&full).ok()
}

/// The account a refused (but provider-verified) answer was for: the account its identity is
/// linked to, else the active Carbon whose verified email it is.
async fn attributed(
    conn: &mut PgConnection,
    known: Option<&Account>,
    verified_email: Option<&str>,
) -> ApiResult<Option<Account>> {
    if let Some(a) = known {
        return Ok(Some(a.clone()));
    }
    let Some(e) = verified_email else {
        return Ok(None);
    };
    Ok(match contacts::lookup(conn, ContactKind::Email, e).await? {
        Holder::Active(a) => Some(a),
        _ => None,
    })
}

/// Records a refused provider answer in the sign-in history of the account it was for (when
/// that is an active Carbon), then returns the refusal for the flow.
async fn refuse(
    conn: &mut PgConnection,
    meta: &ClientMeta,
    fa: &FlowApp,
    provider: Provider,
    known: Option<&Account>,
    error: FlowError,
) -> ApiResult<Result<Pending, FlowError>> {
    if let Some(a) =
        known.filter(|a| a.kind == AccountKind::Carbon && a.status == AccountStatus::Active)
    {
        audit::signin(
            conn,
            &SigninRecord {
                account_uuid: Some(&a.uuid),
                app_id: Some(&fa.app.app_id),
                method: provider.as_str(),
                outcome: audit::outcome::FAILED,
                ip: meta.ip.as_deref(),
                user_agent: meta.user_agent.as_deref(),
            },
        )
        .await?;
        audit::record(
            conn,
            &AuditEntry {
                account_uuid: Some(&a.uuid),
                app_id: Some(&fa.app.app_id),
                target_kind: Some("identity"),
                details: json!({"provider": provider.as_str(), "reason": error.code}),
                ip: meta.ip.as_deref(),
                ..AuditEntry::new(ActorKind::System, None, "signin.refused")
            },
        )
        .await?;
    }
    Ok(Err(error))
}

/// Known identity → its account; verified email of an account → link; else sign-up.
/// `Ok(Err(..))` = a refusal to show on the flow.
async fn resolve_identity(
    conn: &mut PgConnection,
    meta: &ClientMeta,
    fa: &FlowApp,
    client: &ProviderClient,
    claims: &ProviderClaims,
    apple_name: Option<String>,
) -> ApiResult<Result<Pending, FlowError>> {
    let provider = client.provider;
    let name = provider.display_name();
    // The account this identity is already linked to (its refusals go to its history).
    let identity = identities::find(conn, provider, &claims.sub).await?;
    let known: Option<Account> = match &identity {
        Some(i) => accounts::get(conn, &i.account_uuid).await?,
        None => None,
    };
    let email = match claims
        .email
        .as_deref()
        .map(str::trim)
        .filter(|e| !e.is_empty())
    {
        None => None,
        Some(raw) => match normalize_email(raw) {
            Ok(e) => Some(e),
            Err(err) => {
                let e = FlowError::new(
                    "provider_email_invalid",
                    format!(
                        "{name} returned an email address Silicon Accounts can't use: {}",
                        err.message
                    ),
                    "Use another sign-in method.",
                );
                return refuse(conn, meta, fa, provider, known.as_ref(), e).await;
            }
        },
    };
    if let Some(e) = &email
        && claims.email_verified != Some(true)
    {
        let e = FlowError::new(
            "email_not_verified",
            format!("{name} says {e} is not verified, so it can't be used to sign in."),
            format!("Verify the address with {name} first, or use another sign-in method."),
        );
        return refuse(conn, meta, fa, provider, known.as_ref(), e).await;
    }
    if provider == Provider::Google
        && let Some(hd) = &fa.config.google.hosted_domain
        && claims.hd.as_deref() != Some(hd.as_str())
    {
        let e = FlowError::new(
            "hosted_domain_mismatch",
            format!(
                "{} only accepts Google Workspace accounts of {hd}; this Google account is {}.",
                fa.app.name,
                match &claims.hd {
                    Some(other) => format!("in {other}"),
                    None => "a personal account".to_string(),
                }
            ),
            format!("Sign in with your {hd} Google account."),
        );
        let owner = attributed(conn, known.as_ref(), email.as_deref()).await?;
        return refuse(conn, meta, fa, provider, owner.as_ref(), e).await;
    }
    if !fa.config.allowed_email_domains.is_empty()
        && !email
            .as_deref()
            .is_some_and(|e| fa.config.email_domain_allowed(e))
    {
        let e = FlowError::from_api(&next::domain_not_allowed(fa, email.as_deref()));
        let owner = attributed(conn, known.as_ref(), email.as_deref()).await?;
        return refuse(conn, meta, fa, provider, owner.as_ref(), e).await;
    }
    let display_name = match provider {
        Provider::Apple => apple_name.or_else(|| claims.full_name()),
        Provider::Google => claims.full_name(),
    };
    let picture = claims
        .picture
        .as_deref()
        .and_then(|p| validate_https_url(p).ok())
        .map(|u| u.to_string());
    let signup = |claim: Option<String>| {
        Pending::Signup(PendingSignup {
            provider,
            subject: claims.sub.clone(),
            client_id: client.client_id.clone(),
            email: email.clone(),
            display_name: display_name.clone(),
            pfp_url: picture.clone(),
            claim_account_uuid: claim,
        })
    };
    let refuse_inactive = |status: AccountStatus| {
        FlowError::new(
            "account_not_active",
            format!("The account of this {name} sign-in is {status} and can't sign in."),
            "Use another sign-in method.",
        )
    };

    // A known identity signs its account in.
    if identity.is_some() {
        let Some(a) = known else {
            return Ok(Err(refuse_inactive(AccountStatus::Deleted)));
        };
        return Ok(match (a.kind, a.status) {
            (AccountKind::Carbon, AccountStatus::Active) => {
                identities::link(
                    conn,
                    provider,
                    &claims.sub,
                    &client.client_id,
                    &a.uuid,
                    email.as_deref(),
                )
                .await?;
                Ok(Pending::SignIn {
                    account_uuid: a.uuid,
                    provider,
                })
            }
            (AccountKind::Carbon, AccountStatus::Unclaimed) => Ok(signup(Some(a.uuid))),
            (_, status) => Err(refuse_inactive(status)),
        });
    }

    // A verified email of an account: that account, now linked to the identity. (The provider
    // proved the address, so an unverified leftover elsewhere is removed: it identifies nobody.)
    if let Some(e) = &email {
        match contacts::after_proof(conn, ContactKind::Email, e, meta.ip.as_deref()).await? {
            Holder::Active(a) => {
                match identities::link(
                    conn,
                    provider,
                    &claims.sub,
                    &client.client_id,
                    &a.uuid,
                    Some(e),
                )
                .await
                {
                    Ok(_) => {}
                    Err(err) if !err.is_server_error() => {
                        return Ok(Err(FlowError::from_api(&err)));
                    }
                    Err(err) => return Err(err),
                }
                audit::record(
                    conn,
                    &AuditEntry {
                        account_uuid: Some(&a.uuid),
                        app_id: Some(&fa.app.app_id),
                        target_kind: Some("identity"),
                        target_id: Some(&claims.sub),
                        details: json!({"provider": provider.as_str(), "linked_by": "verified_email"}),
                        ip: meta.ip.as_deref(),
                        ..AuditEntry::new(ActorKind::Account, Some(&a.uuid), "identity.linked")
                    },
                )
                .await?;
                return Ok(Ok(Pending::SignIn {
                    account_uuid: a.uuid,
                    provider,
                }));
            }
            Holder::Unclaimed(a) => return Ok(Ok(signup(Some(a.uuid)))),
            Holder::Unavailable(a) => return Ok(Err(refuse_inactive(a.status))),
            // Nobody proved an unproven row; `after_proof` already removed it.
            Holder::Free | Holder::Unproven(_) => {}
        }
    }

    if !fa.config.allow_signup && !fa.first_party() {
        return Ok(Err(FlowError::from_api(&next::signup_not_allowed(fa))));
    }
    Ok(Ok(signup(None)))
}

fn redirect_to_flow(settings: &Settings, flow_id: &str) -> Response {
    let location = settings.url(&format!("/authorize/flow/{flow_id}"));
    let mut response = StatusCode::FOUND.into_response();
    if let Ok(v) = HeaderValue::from_str(&location) {
        response.headers_mut().insert(header::LOCATION, v);
    }
    no_store(response.headers_mut());
    response
}

/// 303 to a same-site URL: the browser follows it with a GET, which carries its SameSite=Lax
/// cookies even when the request before it was a cross-site POST.
fn see_other(location: &str) -> Response {
    let mut response = StatusCode::SEE_OTHER.into_response();
    if let Ok(v) = HeaderValue::from_str(location) {
        response.headers_mut().insert(header::LOCATION, v);
    }
    no_store(response.headers_mut());
    response
}

fn wants_json(headers: &HeaderMap) -> bool {
    let accept = headers
        .get(header::ACCEPT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    accept.contains("application/json") && !accept.contains("text/html")
}

fn escape(s: &str) -> String {
    accounts_core::delivery::templates::escape_html(s)
}

/// A callback that can't be tied to a flow: an HTML page for browsers (JSON when asked).
fn error_page(settings: &Settings, headers: &HeaderMap, error: ApiError) -> Response {
    if wants_json(headers) {
        return error.into_response();
    }
    let status = error.status;
    let hint = error.hint.clone().unwrap_or_default();
    let html = format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">\
         <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\
         <title>Sign-in can't continue · Silicon Accounts</title></head>\
         <body style=\"margin:0;padding:24px;background:#FFFDF9;color:#353432;font-family:system-ui,-apple-system,Segoe UI,Helvetica,Arial,sans-serif\">\
         <main id=\"callback-error\" data-error=\"{code}\" style=\"max-width:480px;margin:10vh auto\">\
         <h1 style=\"font-weight:500;font-size:24px\">This sign-in can't continue</h1>\
         <p>{message}</p><p style=\"color:#6F6B66\">{hint}</p>\
         <p><a href=\"{site}\" style=\"color:#1F5FB8\">Go to Silicon Accounts</a></p></main>\
         <footer style=\"text-align:center;font-size:13px;color:#6F6B66\">Powered by \
         <a href=\"{product}\" style=\"color:#1F5FB8\">Silicon Accounts</a></footer></body></html>",
        code = escape(&error.code),
        message = escape(&error.message),
        hint = escape(&hint),
        site = escape(&settings.public_url),
        product = accounts_core::PRODUCT_SITE,
    );
    let mut response = (status, html).into_response();
    let h = response.headers_mut();
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/html; charset=utf-8"),
    );
    no_store(h);
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn apple_first_login_name() {
        assert_eq!(
            apple_user_name(
                r#"{"name":{"firstName":"Katherine","lastName":"Johnson"},"email":"k@x.test"}"#
            )
            .as_deref(),
            Some("Katherine Johnson")
        );
        assert_eq!(
            apple_user_name(r#"{"name":{"firstName":"Kat"}}"#).as_deref(),
            Some("Kat")
        );
        assert_eq!(apple_user_name(r#"{"email":"k@x.test"}"#), None);
        assert_eq!(apple_user_name("not json"), None);
    }

    #[test]
    fn provider_errors_are_explained() {
        let e = provider_answer_error(Provider::Apple, "user_cancelled_authorize", None);
        assert_eq!(e.code, "provider_cancelled");
        let e = provider_answer_error(Provider::Google, "server_error", Some("try later"));
        assert_eq!(e.code, "provider_error");
        assert!(e.message.contains("server_error") && e.message.contains("try later"));
    }

    #[test]
    fn parked_answers_round_trip_without_the_ticket() {
        let a = Answer::from(CallbackParams {
            code: Some("c".into()),
            user: Some("{}".into()),
            ticket: Some("t".into()),
            ..Default::default()
        });
        let json = serde_json::to_string(&a).expect("json");
        assert!(!json.contains("ticket"));
        let back: Answer = serde_json::from_str(&json).expect("parse");
        assert_eq!(back.code.as_deref(), Some("c"));
        assert_eq!(back.user.as_deref(), Some("{}"));
    }
}
