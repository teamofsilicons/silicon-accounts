//! The stored sign-in flow (`signin_flows`) and the rules every flow endpoint shares: the
//! binding cookie, expiry and which step allows which action.

use accounts_core::crypto::prefix;
use accounts_core::http::cookies::{FLOW_COOKIE, read_cookie};
use accounts_core::models::{
    ContactField, Method, Provider, ProviderMode, Scope, scopes_from_strings,
};
use accounts_core::{ApiError, ApiResult, AppState, Settings};
use axum::http::HeaderMap;
use serde::{Deserialize, Serialize};
use sqlx::PgConnection;
use time::OffsetDateTime;
use uuid::Uuid;

/// A flow lives this long after it is created.
pub const FLOW_TTL_MINUTES: i64 = 60;

/// Where a flow is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    /// Pick a method (or continue as the browser's account).
    ChooseMethod,
    /// A code was sent; type it.
    VerifyCode,
    /// First time with this email/phone/identity (or finishing an imported account).
    Signup,
    /// A page of the app's flow: the details it asks for (what's shared with the app, adding a
    /// missing email or phone, ticking optional details). See `flow::details`.
    Details,
    /// The last page of a flow with `review: true`: everything that will be shared.
    Review,
    /// Done: `redirect_to` carries the code (or `error=access_denied`).
    Complete,
    /// Ended without a sign-in (`prompt=none` couldn't sign in silently).
    Failed,
}

impl Step {
    /// Wire and database spelling.
    pub fn as_str(&self) -> &'static str {
        match self {
            Step::ChooseMethod => "choose_method",
            Step::VerifyCode => "verify_code",
            Step::Signup => "signup",
            Step::Details => "details",
            Step::Review => "review",
            Step::Complete => "complete",
            Step::Failed => "failed",
        }
    }

    /// Parses the database spelling.
    pub fn parse(s: &str) -> Option<Step> {
        Some(match s {
            "choose_method" => Step::ChooseMethod,
            "verify_code" => Step::VerifyCode,
            "signup" => Step::Signup,
            "details" => Step::Details,
            "review" => Step::Review,
            // Flows stored before the details pages replaced these steps continue at the
            // details pages (`GET /v1/flows/{id}` puts them on the right one).
            "requirements" | "consent" => Step::Details,
            "complete" => Step::Complete,
            "failed" => Step::Failed,
            _ => return None,
        })
    }

    /// True for `complete` and `failed`.
    pub fn is_terminal(&self) -> bool {
        matches!(self, Step::Complete | Step::Failed)
    }
}

impl Serialize for Step {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(self.as_str())
    }
}

/// The OIDC `prompt` parameter (space-separated values).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Prompt {
    /// Never show a page: sign in silently with the browser's account or fail.
    pub none: bool,
    /// Ignore the browser's session: the Carbon must sign in again.
    pub login: bool,
    /// Always show the what's-shared screen.
    pub consent: bool,
    /// Always show the "continue as" chooser (it is shown whenever the browser is signed in).
    pub select_account: bool,
}

impl Prompt {
    /// Parses `prompt`. Unknown values and `none` combined with anything are errors.
    pub fn parse(input: Option<&str>) -> Result<Prompt, String> {
        let mut p = Prompt::default();
        let Some(raw) = input else { return Ok(p) };
        for part in raw.split_whitespace() {
            match part {
                "none" => p.none = true,
                "login" => p.login = true,
                "consent" => p.consent = true,
                "select_account" => p.select_account = true,
                other => {
                    return Err(format!(
                        "prompt value '{other}' is not supported; use none, login, consent or select_account (several are separated by spaces)"
                    ));
                }
            }
        }
        if p.none && (p.login || p.consent || p.select_account) {
            return Err(
                "prompt=none can't be combined with other prompt values (OpenID Connect Core 1.0 §3.1.2.1)"
                    .into(),
            );
        }
        Ok(p)
    }

    /// Canonical stored form (`None` when no value was given).
    pub fn to_stored(self) -> Option<String> {
        let mut parts = Vec::new();
        if self.none {
            parts.push("none");
        }
        if self.login {
            parts.push("login");
        }
        if self.consent {
            parts.push("consent");
        }
        if self.select_account {
            parts.push("select_account");
        }
        (!parts.is_empty()).then(|| parts.join(" "))
    }
}

/// Which version of the hosted pages the app asked for (`intent=signin|signup` on
/// `/authorize`). Only the pages change ("Sign in to Briefcase" or "Create your Briefcase
/// account"); the account logic is the same: a first time is a sign-up either way.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Intent {
    #[default]
    Signin,
    Signup,
}

impl Intent {
    /// Parses `intent` (`signin` or `signup`).
    pub fn parse(s: &str) -> Option<Intent> {
        match s {
            "signin" => Some(Intent::Signin),
            "signup" => Some(Intent::Signup),
            _ => None,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Intent::Signin => "signin",
            Intent::Signup => "signup",
        }
    }
}

/// Where a Carbon is in the app's details pages (`step = details | review`). Each detail is on
/// exactly one step, so the Carbon's answers are kept per detail.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct DetailsProgress {
    /// The id of the details step on screen (`step = details`).
    pub current: Option<String>,
    /// Ids of the steps the Carbon continued through in this flow.
    pub done: Vec<String>,
    /// Optional details the Carbon ticked on a step they continued through.
    pub ticked: Vec<ContactField>,
    /// Optional details the Carbon left unticked on a step they continued through.
    pub unticked: Vec<ContactField>,
}

impl DetailsProgress {
    /// The Carbon's answer for an optional detail, when they gave one in this flow.
    pub fn choice(&self, field: ContactField) -> Option<bool> {
        if self.ticked.contains(&field) {
            Some(true)
        } else if self.unticked.contains(&field) {
            Some(false)
        } else {
            None
        }
    }

    /// Records the Carbon's answer for an optional detail.
    pub fn set_choice(&mut self, field: ContactField, shared: bool) {
        self.ticked.retain(|f| *f != field);
        self.unticked.retain(|f| *f != field);
        if shared {
            self.ticked.push(field);
        } else {
            self.unticked.push(field);
        }
    }
}

/// An error the flow carries (shown by the hosted pages), e.g. after a cancelled Google sign-in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FlowError {
    pub code: String,
    pub message: String,
    pub hint: Option<String>,
}

impl FlowError {
    pub fn new(code: &str, message: impl Into<String>, hint: impl Into<String>) -> FlowError {
        FlowError {
            code: code.to_string(),
            message: message.into(),
            hint: Some(hint.into()),
        }
    }

    /// The flow error for an API error (same code, message and hint).
    pub fn from_api(e: &ApiError) -> FlowError {
        FlowError {
            code: e.code.to_string(),
            message: e.message.clone(),
            hint: e.hint.clone(),
        }
    }
}

/// The Google/Apple leg in progress: what the callback must match.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderLeg {
    pub provider: Provider,
    /// base64url of HMAC(pepper, state): the state itself is never stored.
    pub state_hash: String,
    /// The OIDC nonce the id_token must carry.
    pub nonce: String,
    /// PKCE verifier (Google), keyring-encrypted (`enc1:…`).
    pub pkce_verifier_enc: Option<String>,
    /// Managed or the app's own credentials.
    pub client_mode: ProviderMode,
    /// The client id the authorize request used (the id_token `aud`).
    pub client_id: String,
    /// A form_post answer parked until the browser comes back with its cookies.
    #[serde(default)]
    pub parked: Option<ParkedAnswer>,
}

/// A provider answer that arrived as a cross-site form_post (Apple). Such a POST carries no
/// SameSite=Lax cookies, so it can't show it comes from the browser that started the sign-in.
/// The answer is parked here and the browser is sent (303) to a same-site GET carrying a
/// one-time ticket; that GET carries the cookies and is checked like a Google redirect.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ParkedAnswer {
    /// base64url of HMAC(pepper, ticket): the ticket itself is never stored.
    pub ticket_hash: String,
    /// The provider's fields (code, error, user, …) as JSON, keyring-encrypted (`enc1:…`).
    pub answer_enc: String,
}

/// A provider sign-in that finished at the callback but is not yet attached to the browser.
///
/// The callback only accepts an answer delivered by the browser that started the sign-in: the
/// request must carry the flow's binding cookie (a Google redirect does; an Apple form_post is
/// parked and continues with a same-site GET that does, see [`ParkedAnswer`]). An answer
/// delivered by any other browser is discarded: otherwise a genuine Google or Apple link
/// forwarded to a victim would sign the sender's browser in as the victim. The verified
/// outcome is then recorded on the flow, and the next request with the binding cookie
/// (normally the SPA's `GET /v1/flows/{id}`) claims it, which is when the browser session or
/// the sign-up session cookie is set.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Pending {
    /// Sign in to an existing active Carbon.
    SignIn {
        account_uuid: String,
        provider: Provider,
    },
    /// First time with this identity (or finishing an imported account).
    Signup(PendingSignup),
}

/// A verified provider identity waiting for sign-up.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PendingSignup {
    pub provider: Provider,
    pub subject: String,
    pub client_id: String,
    /// The provider-verified email, normalized.
    pub email: Option<String>,
    pub display_name: Option<String>,
    pub pfp_url: Option<String>,
    /// An unclaimed (imported) account with this email that the Carbon is finishing.
    pub claim_account_uuid: Option<String>,
}

/// A flow that connects a Google or Apple account to a signed-in Carbon (the account site's
/// "Connect Google", `POST /v1/me/identities/{provider}`) instead of signing anyone in. The
/// provider's verified email is added to the account without a code (UNDERSTANDING.md: an email
/// added via Google or Apple needs no extra verification).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LinkIntent {
    /// The Carbon that asked; the browser must still be signed in as it when the answer comes.
    pub account_uuid: String,
    /// Where the browser goes afterwards (on the public origin), with `linked=` or `link_error=`.
    pub return_to: String,
}

/// Flow state that has no column of its own; stored as JSON in `signin_flows.provider_state`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct FlowExtras {
    /// The browser's `Intl` timezone sent at flow creation (sign-up suggestion fallback).
    pub browser_timezone: Option<String>,
    /// The Google/Apple leg in progress.
    pub provider: Option<ProviderLeg>,
    /// A provider outcome waiting to be claimed by the bound browser.
    pub pending: Option<Pending>,
    /// What went wrong last (cleared by the next action).
    pub error: Option<FlowError>,
    /// How the account authenticated in this flow: email | phone | google | apple | session.
    pub auth_method: Option<String>,
    /// The account was created (or an imported one claimed) in this flow.
    pub new_account: bool,
    /// The Carbon chose "use another account": don't offer the browser's account again.
    pub switched: bool,
    /// The browser session the flow signed in with (recorded on the authorization code).
    pub browser_session_id: Option<Uuid>,
    /// Set when this flow connects a provider to a signed-in Carbon (see [`LinkIntent`]).
    pub link: Option<LinkIntent>,
    /// `intent` as given to /authorize (default `signin`).
    pub intent: Intent,
    /// The details pages (`step = details | review`).
    pub details: DetailsProgress,
}

#[derive(Debug, Clone, sqlx::FromRow)]
struct FlowRow {
    id: String,
    binding_hash: Vec<u8>,
    app_id: String,
    redirect_uri: String,
    state: Option<String>,
    code_challenge: Option<String>,
    code_challenge_method: Option<String>,
    nonce: Option<String>,
    requested_scopes: Vec<String>,
    prompt: Option<String>,
    method_hint: Option<String>,
    step: String,
    account_uuid: Option<String>,
    signup_session_id: Option<Uuid>,
    challenge_id: Option<Uuid>,
    provider_state: Option<serde_json::Value>,
    result_redirect: Option<String>,
    created_at: OffsetDateTime,
    expires_at: OffsetDateTime,
    completed_at: Option<OffsetDateTime>,
    expired: bool,
}

/// A sign-in flow with typed fields.
#[derive(Debug, Clone)]
pub struct Flow {
    pub id: String,
    pub binding_hash: Vec<u8>,
    pub app_id: String,
    pub redirect_uri: String,
    pub state: Option<String>,
    pub code_challenge: Option<String>,
    pub code_challenge_method: Option<String>,
    pub nonce: Option<String>,
    /// Scopes from the `scope` parameter (always includes `profile`).
    pub requested_scopes: Vec<Scope>,
    pub prompt: Prompt,
    /// `method` as given to /authorize: the app's own "Continue with Google" (or email, phone,
    /// Apple) button, so the hosted page goes straight to that method.
    pub method_hint: Option<Method>,
    pub step: Step,
    pub account_uuid: Option<String>,
    pub signup_session_id: Option<Uuid>,
    /// The live code challenge: the sign-in code at `verify_code`, the code adding a missing
    /// email or phone at `details`.
    pub challenge_id: Option<Uuid>,
    pub extras: FlowExtras,
    /// The final redirect (keyring-encrypted; it carries the authorization code).
    pub result_redirect: Option<String>,
    pub created_at: OffsetDateTime,
    pub expires_at: OffsetDateTime,
    pub completed_at: Option<OffsetDateTime>,
    /// `expires_at <= now()` by the database clock when the row was read.
    pub expired: bool,
}

impl FlowRow {
    fn into_flow(self) -> ApiResult<Flow> {
        let step = Step::parse(&self.step).ok_or_else(|| {
            ApiError::internal(format!(
                "sign-in flow {} has an unknown step '{}'",
                self.id, self.step
            ))
        })?;
        let extras = match self.provider_state {
            Some(v) => serde_json::from_value(v).unwrap_or_else(|e| {
                tracing::error!(flow_id = %self.id, error = %e, "unreadable flow state; using defaults");
                FlowExtras::default()
            }),
            None => FlowExtras::default(),
        };
        Ok(Flow {
            id: self.id,
            binding_hash: self.binding_hash,
            app_id: self.app_id,
            redirect_uri: self.redirect_uri,
            state: self.state,
            code_challenge: self.code_challenge,
            code_challenge_method: self.code_challenge_method,
            nonce: self.nonce,
            requested_scopes: scopes_from_strings(&self.requested_scopes),
            // Stored values were validated at creation.
            prompt: Prompt::parse(self.prompt.as_deref()).unwrap_or_default(),
            method_hint: self.method_hint.as_deref().and_then(Method::parse),
            step,
            account_uuid: self.account_uuid,
            signup_session_id: self.signup_session_id,
            challenge_id: self.challenge_id,
            extras,
            result_redirect: self.result_redirect,
            created_at: self.created_at,
            expires_at: self.expires_at,
            completed_at: self.completed_at,
            expired: self.expired,
        })
    }
}

macro_rules! flow_select {
    ($suffix:literal) => {
        concat!(
            "select id, binding_hash, app_id, redirect_uri, state, code_challenge, code_challenge_method, nonce, \
             requested_scopes, prompt, method_hint, step, account_uuid, signup_session_id, challenge_id, \
             provider_state, result_redirect, created_at, expires_at, completed_at, (expires_at <= now()) as expired \
             from signin_flows where id = $1",
            $suffix
        )
    };
}

/// True when `id` looks like a flow id (base64url, at most 64 characters).
pub fn is_flow_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Fetches a flow.
pub async fn get(conn: &mut PgConnection, id: &str) -> ApiResult<Option<Flow>> {
    if !is_flow_id(id) {
        return Ok(None);
    }
    sqlx::query_as::<_, FlowRow>(flow_select!(""))
        .bind(id)
        .fetch_optional(&mut *conn)
        .await?
        .map(FlowRow::into_flow)
        .transpose()
}

/// Fetches and row-locks a flow (inside a transaction).
pub async fn lock(conn: &mut PgConnection, id: &str) -> ApiResult<Option<Flow>> {
    if !is_flow_id(id) {
        return Ok(None);
    }
    sqlx::query_as::<_, FlowRow>(flow_select!(" for update"))
        .bind(id)
        .fetch_optional(&mut *conn)
        .await?
        .map(FlowRow::into_flow)
        .transpose()
}

/// Input for [`insert`].
pub struct NewFlow<'a> {
    pub id: &'a str,
    pub binding_hash: &'a [u8],
    pub app_id: &'a str,
    pub redirect_uri: &'a str,
    pub state: Option<&'a str>,
    pub code_challenge: Option<&'a str>,
    pub code_challenge_method: Option<&'a str>,
    pub nonce: Option<&'a str>,
    pub requested_scopes: &'a [Scope],
    pub prompt: Prompt,
    pub method_hint: Option<Method>,
}

/// Creates a flow at `choose_method` (expires in 60 minutes). An app's `login_hint` is never
/// stored: apps can't hand Silicon Accounts a Carbon's email or phone (UNDERSTANDING.md).
pub async fn insert(conn: &mut PgConnection, new: &NewFlow<'_>) -> ApiResult<Flow> {
    sqlx::query(
        "insert into signin_flows (id, binding_hash, app_id, redirect_uri, state, code_challenge, code_challenge_method, \
           nonce, requested_scopes, prompt, method_hint, step, expires_at) \
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'choose_method', now() + make_interval(mins => $12))",
    )
    .bind(new.id)
    .bind(new.binding_hash)
    .bind(new.app_id)
    .bind(new.redirect_uri)
    .bind(new.state)
    .bind(new.code_challenge)
    .bind(new.code_challenge_method)
    .bind(new.nonce)
    .bind(accounts_core::models::scope_strings(new.requested_scopes))
    .bind(new.prompt.to_stored())
    .bind(new.method_hint.map(|m| m.as_str()))
    .bind(FLOW_TTL_MINUTES as i32)
    .execute(&mut *conn)
    .await?;
    lock(conn, new.id)
        .await?
        .ok_or_else(|| ApiError::internal("the new sign-in flow could not be read back"))
}

/// Writes the mutable part of a flow back.
pub async fn save(conn: &mut PgConnection, flow: &Flow) -> ApiResult<()> {
    let extras = serde_json::to_value(&flow.extras)?;
    sqlx::query(
        "update signin_flows set step = $2, account_uuid = $3, signup_session_id = $4, challenge_id = $5, \
           provider_state = $6, result_redirect = $7, completed_at = $8 where id = $1",
    )
    .bind(&flow.id)
    .bind(flow.step.as_str())
    .bind(&flow.account_uuid)
    .bind(flow.signup_session_id)
    .bind(flow.challenge_id)
    .bind(extras)
    .bind(&flow.result_redirect)
    .bind(flow.completed_at)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

impl Flow {
    /// Forgets everything about the account chosen so far (back to `choose_method`).
    pub fn reset_to_choose_method(&mut self) {
        self.step = Step::ChooseMethod;
        self.account_uuid = None;
        self.signup_session_id = None;
        self.challenge_id = None;
        self.extras.provider = None;
        self.extras.pending = None;
        self.extras.auth_method = None;
        self.extras.new_account = false;
        self.extras.browser_session_id = None;
        self.extras.details = DetailsProgress::default();
    }

    /// True when the `scope` parameter asked for OpenID Connect.
    pub fn wants_openid(&self) -> bool {
        self.requested_scopes.contains(&Scope::Openid)
    }
}

// ----------------------------------------------------------------------------- binding

/// The `sa_flow` cookie value, when it is well formed.
pub fn binding_cookie(headers: &HeaderMap, settings: &Settings) -> Option<String> {
    read_cookie(headers, settings, FLOW_COOKIE).filter(|v| {
        v.starts_with(prefix::FLOW) && v.len() <= 128 && v.bytes().all(|b| b.is_ascii_graphic())
    })
}

/// 404 `flow_not_found`.
pub fn flow_not_found(id: &str) -> ApiError {
    ApiError::not_found(
        "flow_not_found",
        format!(
            "No sign-in flow '{id}' exists (it never existed, or it expired and was cleaned up)."
        ),
    )
    .hint("Start the sign-in again from the app.")
}

/// 403 `flow_not_bound`.
pub fn flow_not_bound(id: &str, cookie_present: bool) -> ApiError {
    let why = if cookie_present {
        "this browser's sa_flow cookie belongs to a different sign-in"
    } else {
        "this request carries no sa_flow cookie"
    };
    ApiError::forbidden(
        "flow_not_bound",
        format!("Sign-in flow '{id}' belongs to the browser that started it, but {why}."),
    )
    .hint("Continue in the browser (tab) where the sign-in started, or start the sign-in again from the app. Clients must keep cookies (credentials: 'include').")
}

/// Checks that the request carries the flow's binding cookie.
pub fn check_binding(state: &AppState, headers: &HeaderMap, flow: &Flow) -> ApiResult<()> {
    match binding_cookie(headers, &state.settings) {
        Some(token) if state.keys.pepper.verify(&token, &flow.binding_hash) => Ok(()),
        Some(_) => Err(flow_not_bound(&flow.id, true)),
        None => Err(flow_not_bound(&flow.id, false)),
    }
}

/// 410 `flow_expired` for an unfinished flow past its 60 minutes.
pub fn ensure_live(flow: &Flow) -> ApiResult<()> {
    if flow.expired && !flow.step.is_terminal() {
        return Err(ApiError::gone(
            "flow_expired",
            format!(
                "Sign-in flow '{}' expired at {}; flows last {FLOW_TTL_MINUTES} minutes.",
                flow.id,
                accounts_core::timefmt::format_rfc3339_ms(flow.expires_at)
            ),
        )
        .hint("Start the sign-in again from the app. A verified email or phone stays ready for sign-up for 48 hours, so no new code is needed for that."));
    }
    Ok(())
}

/// Checks that the flow is at one of `allowed` (409 `invalid_step`, or `flow_completed` /
/// `flow_failed` once it ended).
pub fn ensure_step(flow: &Flow, allowed: &[Step], action: &str) -> ApiResult<()> {
    if allowed.contains(&flow.step) {
        return Ok(());
    }
    let allowed_list = allowed
        .iter()
        .map(Step::as_str)
        .collect::<Vec<_>>()
        .join(" or ");
    match flow.step {
        Step::Complete => Err(ApiError::conflict(
            "flow_completed",
            format!("Sign-in flow '{}' is already complete, so it can't {action}.", flow.id),
        )
        .hint(format!("GET /v1/flows/{} returns redirect_to: send the browser there.", flow.id))
        .detail("step", flow.step.as_str())),
        Step::Failed => Err(ApiError::conflict(
            "flow_failed",
            format!("Sign-in flow '{}' already ended without a sign-in, so it can't {action}.", flow.id),
        )
        .hint("Start the sign-in again from the app.")
        .detail("step", flow.step.as_str())),
        step => Err(ApiError::conflict(
            "invalid_step",
            format!(
                "Sign-in flow '{}' is at the {} step; it can only {action} at the {allowed_list} step.",
                flow.id,
                step.as_str()
            ),
        )
        .hint(format!("GET /v1/flows/{} shows the current step and what it needs.", flow.id))
        .detail("step", step.as_str())
        .detail("allowed_steps", allowed.iter().map(Step::as_str).collect::<Vec<_>>())),
    }
}

/// A fresh flow id: 16 random bytes, base64url.
pub fn new_flow_id() -> String {
    accounts_core::crypto::b64url(&accounts_core::crypto::random_bytes::<16>())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompt_parsing() {
        assert_eq!(Prompt::parse(None), Ok(Prompt::default()));
        let p = Prompt::parse(Some("login  consent")).expect("valid");
        assert!(p.login && p.consent && !p.none);
        assert_eq!(p.to_stored().as_deref(), Some("login consent"));
        assert!(
            Prompt::parse(Some("none login"))
                .expect_err("none + login")
                .contains("can't be combined")
        );
        assert!(
            Prompt::parse(Some("sometimes"))
                .expect_err("unknown")
                .contains("'sometimes'")
        );
        assert_eq!(Prompt::parse(Some("")).expect("empty").to_stored(), None);
    }

    #[test]
    fn steps_round_trip() {
        for s in [
            Step::ChooseMethod,
            Step::VerifyCode,
            Step::Signup,
            Step::Details,
            Step::Review,
            Step::Complete,
            Step::Failed,
        ] {
            assert_eq!(Step::parse(s.as_str()), Some(s));
        }
        assert!(Step::Complete.is_terminal() && !Step::Review.is_terminal());
        // Flows stored by the previous version continue at the details pages.
        assert_eq!(Step::parse("consent"), Some(Step::Details));
        assert_eq!(Step::parse("requirements"), Some(Step::Details));
    }

    #[test]
    fn flow_ids() {
        let id = new_flow_id();
        assert_eq!(id.len(), 22);
        assert!(is_flow_id(&id));
        assert!(!is_flow_id("../etc"));
        assert!(!is_flow_id(""));
    }

    #[test]
    fn extras_round_trip_and_tolerate_missing_fields() {
        let mut e = FlowExtras {
            browser_timezone: Some("Asia/Kolkata".into()),
            ..Default::default()
        };
        e.pending = Some(Pending::SignIn {
            account_uuid: "a8K".into(),
            provider: Provider::Google,
        });
        let v = serde_json::to_value(&e).expect("json");
        assert_eq!(v["pending"]["kind"], "sign_in");
        let back: FlowExtras = serde_json::from_value(v).expect("parse");
        assert_eq!(back, e);
        let partial: FlowExtras =
            serde_json::from_value(serde_json::json!({"switched": true})).expect("partial");
        assert!(partial.switched && partial.provider.is_none());
        assert_eq!(partial.intent, Intent::Signin);
        assert_eq!(partial.details, DetailsProgress::default());
    }

    #[test]
    fn details_choices_and_intents() {
        let mut d = DetailsProgress::default();
        assert_eq!(d.choice(ContactField::Timezone), None);
        d.set_choice(ContactField::Timezone, true);
        d.set_choice(ContactField::Email, false);
        assert_eq!(d.choice(ContactField::Timezone), Some(true));
        d.set_choice(ContactField::Timezone, false);
        assert_eq!(d.choice(ContactField::Timezone), Some(false));
        assert_eq!(d.ticked, Vec::<ContactField>::new());
        let v = serde_json::to_value(&d).expect("json");
        assert_eq!(v["unticked"], serde_json::json!(["email", "timezone"]));
        assert_eq!(Intent::parse("signup"), Some(Intent::Signup));
        assert_eq!(Intent::parse("register"), None);
        assert_eq!(
            serde_json::to_value(Intent::Signin).expect("json"),
            serde_json::json!("signin")
        );
    }
}
