//! `FlowView`: what the hosted pages render (02-api.md and the build spec 06-v2.md), plus
//! `prompt`, `intent` and `method_hint` so the pages can honour them. An app's `login_hint` is
//! never echoed (apps can't hand us a Carbon's email or phone).

use accounts_core::http::ClientMeta;
use accounts_core::models::{Branding, Method, OtpChannel, OtpPurpose, SigninCopy};
use accounts_core::repo::{accounts, otp};
use accounts_core::timefmt::rfc3339_ms;
use accounts_core::views::AccountSummary;
use accounts_core::{ApiError, ApiResult, AppState};
use serde::Serialize;
use sqlx::PgConnection;
use time::{Date, OffsetDateTime};
use uuid::Uuid;

use super::FlowApp;
use super::browser::BrowserAccount;
use super::details::{self, DetailsView, ReviewView};
use super::model::{Flow, FlowError, Intent, Step};
use super::signup;
use crate::util::decrypt_text;

/// The flow as the hosted pages see it.
#[derive(Debug, Clone, Serialize)]
pub struct FlowView {
    pub id: String,
    pub step: Step,
    pub accounts: Vec<serde_json::Value>,
    #[serde(with = "rfc3339_ms")]
    pub expires_at: OffsetDateTime,
    pub app: FlowAppView,
    /// Enabled methods in the app's order.
    pub methods: Vec<Method>,
    /// The account this flow signs in, or the browser's account to offer as "Continue as".
    pub signed_in_as: Option<AccountSummary>,
    /// The sign-in code that was sent (step `verify_code`).
    pub challenge: Option<ChallengeView>,
    /// Prefilled sign-up details (step `signup`).
    pub signup: Option<signup::SignupView>,
    /// The details page on screen (step `details`).
    pub details: Option<DetailsView>,
    /// Everything that will be shared (step `review`).
    pub review: Option<ReviewView>,
    /// Where to send the browser (steps `complete` and `failed`).
    pub redirect_to: Option<String>,
    pub error: Option<FlowError>,
    /// `prompt` as given to /authorize (canonical order), e.g. `select_account`.
    pub prompt: Option<String>,
    /// `intent` as given to /authorize: the sign-in or the sign-up version of the pages.
    pub intent: Intent,
    /// `method` as given to /authorize: the app's own "Continue with …" button. `email`/`phone`
    /// open that method's entry field; `google`/`apple` show the opening page, then go on to
    /// the provider.
    pub method_hint: Option<Method>,
}

/// The app being signed into, with its branding.
#[derive(Debug, Clone, Serialize)]
pub struct FlowAppView {
    pub app_id: String,
    pub name: String,
    pub logo_url: Option<String>,
    pub logo_dark_url: Option<String>,
    pub homepage_url: Option<String>,
    pub branding: Branding,
    pub copy: SigninCopy,
    pub first_party: bool,
}

/// A code that was sent.
#[derive(Debug, Clone, Serialize)]
pub struct ChallengeView {
    pub channel: OtpChannel,
    /// Masked: `s***@gmail.com`, `+91******3210`.
    pub destination: String,
    #[serde(with = "rfc3339_ms")]
    pub expires_at: OffsetDateTime,
    #[serde(with = "rfc3339_ms")]
    pub resend_available_at: OffsetDateTime,
}

impl ChallengeView {
    pub(crate) fn from_challenge(c: &otp::OtpChallenge) -> ChallengeView {
        ChallengeView {
            channel: c.channel,
            destination: c.masked_destination(),
            expires_at: c.expires_at,
            resend_available_at: c.resend_available_at(),
        }
    }
}

/// Request context for building a view.
pub struct ViewContext<'a> {
    pub state: &'a AppState,
    pub meta: &'a ClientMeta,
    /// The browser's signed-in account as of this request (before any sign-in it made).
    pub browser: Option<&'a BrowserAccount>,
}

/// True when the flow may offer the browser's account ("Continue as …").
pub fn offers_browser_account(flow: &Flow, fa: &FlowApp) -> bool {
    fa.config.remember_browser
        && !flow.prompt.login
        && !flow.extras.switched
        && matches!(flow.step, Step::ChooseMethod | Step::VerifyCode)
}

/// Builds the view of a flow.
pub async fn build(
    conn: &mut PgConnection,
    ctx: &ViewContext<'_>,
    flow: &Flow,
    fa: &FlowApp,
) -> ApiResult<FlowView> {
    let state = ctx.state;
    let account = match &flow.account_uuid {
        Some(uuid) => accounts::get(conn, uuid).await?,
        None => None,
    };
    let signed_in_as = match &account {
        Some(a) => Some(AccountSummary::from_account(a)),
        None if offers_browser_account(flow, fa) => ctx
            .browser
            .filter(|b| b.is_active_carbon())
            .map(|b| AccountSummary::from_account(&b.account)),
        None => None,
    };

    let challenge = match (flow.step, flow.challenge_id) {
        (Step::VerifyCode, Some(id)) => live_challenge(conn, id, OtpPurpose::Signin).await?,
        _ => None,
    };

    let signup = match (flow.step, flow.signup_session_id) {
        (Step::Signup, Some(id)) => match signup::get_session(conn, id).await? {
            Some(session) => Some(signup::prefill(conn, state, ctx.meta, flow, &session).await?),
            None => None,
        },
        _ => None,
    };

    let details = match (flow.step, &account) {
        (Step::Details, Some(a)) => details::details_view(conn, flow, fa, a).await?,
        _ => None,
    };

    let review = match (flow.step, &account) {
        (Step::Review, Some(a)) => Some(details::review_view(conn, flow, fa, a).await?),
        _ => None,
    };

    let redirect_to = match (&flow.result_redirect, flow.step.is_terminal()) {
        (Some(stored), true) => Some(decrypt_text(&state.keys.keyring, stored)?),
        _ => None,
    };

    let choices = if flow.step == Step::SelectAccount {
        match flow.extras.authenticated_account_uuid.as_deref() {
            Some(uuid) => accounts_core::repo::organizations::linked_accounts(
                conn,
                uuid,
                Some(&fa.app.app_id),
            )
            .await?["accounts"]
                .as_array()
                .cloned()
                .unwrap_or_default(),
            None => vec![],
        }
    } else {
        vec![]
    };
    let mut branding = fa.config.branding.clone();
    let mut app_view = FlowAppView {
        app_id: fa.app.app_id.clone(),
        name: fa.app.name.clone(),
        logo_url: branding
            .logo_url
            .clone()
            .or_else(|| fa.app.logo_url.clone()),
        logo_dark_url: branding
            .logo_dark_url
            .clone()
            .or_else(|| fa.app.logo_dark_url.clone()),
        homepage_url: fa.app.homepage_url.clone(),
        branding: branding.clone(),
        copy: fa.config.copy.clone(),
        first_party: fa.first_party(),
    };
    if let Some(interface_id) = &flow.extras.interface_id {
        let row: Option<(String, Option<String>, serde_json::Value)> = sqlx::query_as("select name,logo_url,branding from interface_auth_clients where interface_id=$1 and active")
            .bind(interface_id).fetch_optional(&mut *conn).await?;
        let (name, logo_url, appearance) = row.ok_or_else(|| {
            ApiError::forbidden(
                "interface_disabled",
                "This interface is no longer accepting sign-ins.",
            )
        })?;
        branding = accounts_core::models::SigninConfig::from_stored(
            &serde_json::json!({"branding":appearance}),
        )
        .branding;
        app_view = FlowAppView {
            app_id: format!("interface:{interface_id}"),
            name,
            logo_url: branding.logo_url.clone().or(logo_url),
            logo_dark_url: branding.logo_dark_url.clone(),
            homepage_url: None,
            branding,
            copy: fa.config.copy.clone(),
            first_party: false,
        };
    }
    Ok(FlowView {
        id: flow.id.clone(),
        step: flow.step,
        accounts: choices,
        expires_at: flow.expires_at,
        app: app_view,
        methods: fa.config.available_methods(&state.settings),
        signed_in_as,
        challenge,
        signup,
        details,
        review,
        redirect_to,
        error: flow.extras.error.clone(),
        prompt: flow.prompt.to_stored(),
        intent: flow.extras.intent,
        method_hint: flow.method_hint,
    })
}

/// A challenge that can still be answered (not consumed, not retired by a resend).
pub(crate) async fn live_challenge(
    conn: &mut PgConnection,
    id: Uuid,
    purpose: OtpPurpose,
) -> ApiResult<Option<ChallengeView>> {
    Ok(otp::get(conn, id)
        .await?
        .filter(|c| c.purpose == purpose && c.consumed_at.is_none())
        .map(|c| ChallengeView::from_challenge(&c)))
}

/// Today's date (UTC) — the sign-up dob suggestion is based on it.
pub fn today() -> Date {
    accounts_core::timefmt::today_utc()
}
