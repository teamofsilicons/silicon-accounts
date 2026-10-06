//! `FlowView`: what the hosted pages render (02-api.md), plus `prompt`, `login_hint` and
//! `method_hint` so the SPA can honour them.

use accounts_core::http::ClientMeta;
use accounts_core::models::{
    Account, Branding, ContactField, Method, OtpChannel, OtpPurpose, Scope, SigninCopy,
};
use accounts_core::repo::contacts::{self, ContactKind};
use accounts_core::repo::{accounts, memberships, otp};
use accounts_core::timefmt::{format_date, rfc3339_ms};
use accounts_core::views::AccountSummary;
use accounts_core::{ApiResult, AppState};
use serde::Serialize;
use sqlx::PgConnection;
use time::{Date, OffsetDateTime};
use uuid::Uuid;

use super::FlowApp;
use super::browser::BrowserAccount;
use super::model::{Flow, FlowError, Step};
use super::{next, signup};
use crate::util::decrypt_text;

/// The flow as the hosted pages see it.
#[derive(Debug, Clone, Serialize)]
pub struct FlowView {
    pub id: String,
    pub step: Step,
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
    /// Details the app needs that the account lacks (step `requirements`).
    pub requirements: Option<RequirementsView>,
    /// What's shared with the app (step `consent`).
    pub consent: Option<ConsentView>,
    /// Where to send the browser (steps `complete` and `failed`).
    pub redirect_to: Option<String>,
    pub error: Option<FlowError>,
    /// `prompt` as given to /authorize (canonical order), e.g. `select_account`.
    pub prompt: Option<String>,
    /// `login_hint` as given to /authorize (prefill the email or phone field).
    pub login_hint: Option<String>,
    /// `method` as given to /authorize (jump straight to that method).
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
    fn from_challenge(c: &otp::OtpChallenge) -> ChallengeView {
        ChallengeView {
            channel: c.channel,
            destination: c.masked_destination(),
            expires_at: c.expires_at,
            resend_available_at: c.resend_available_at(),
        }
    }
}

/// The requirements step.
#[derive(Debug, Clone, Serialize)]
pub struct RequirementsView {
    pub missing: Vec<ContactField>,
    /// The code sent to the detail being added, if any.
    pub challenge: Option<ChallengeView>,
}

/// A required row of the what's-shared screen (always shared).
#[derive(Debug, Clone, Serialize)]
pub struct ConsentItem {
    pub scope: Scope,
    pub label: &'static str,
    /// The value that will be shared (null when the account doesn't have it).
    pub value: Option<String>,
}

/// An optional row of the what's-shared screen.
#[derive(Debug, Clone, Serialize)]
pub struct ConsentOptional {
    pub scope: Scope,
    pub label: &'static str,
    pub value: Option<String>,
    /// The toggle's initial state: granted before, or asked for in the `scope` parameter.
    pub granted: bool,
}

/// The what's-shared screen.
#[derive(Debug, Clone, Serialize)]
pub struct ConsentView {
    pub required: Vec<ConsentItem>,
    pub optional: Vec<ConsentOptional>,
    /// What the account granted this app before (empty the first time).
    pub previously_granted: Vec<Scope>,
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

    let requirements = match (flow.step, &account) {
        (Step::Requirements, Some(a)) => {
            let missing = next::missing_requirements(conn, &fa.config, a).await?;
            let challenge = match flow.challenge_id {
                Some(id) => live_challenge(conn, id, OtpPurpose::Requirement).await?,
                None => None,
            };
            Some(RequirementsView { missing, challenge })
        }
        _ => None,
    };

    let consent = match (flow.step, &account) {
        (Step::Consent, Some(a)) => Some(consent_view(conn, flow, fa, a).await?),
        _ => None,
    };

    let redirect_to = match (&flow.result_redirect, flow.step.is_terminal()) {
        (Some(stored), true) => Some(decrypt_text(&state.keys.keyring, stored)?),
        _ => None,
    };

    let branding = fa.config.branding.clone();
    Ok(FlowView {
        id: flow.id.clone(),
        step: flow.step,
        expires_at: flow.expires_at,
        app: FlowAppView {
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
            branding,
            copy: fa.config.copy.clone(),
            first_party: fa.first_party(),
        },
        methods: fa.config.available_methods(&state.settings),
        signed_in_as,
        challenge,
        signup,
        requirements,
        consent,
        redirect_to,
        error: flow.extras.error.clone(),
        prompt: flow.prompt.to_stored(),
        login_hint: flow.login_hint.clone(),
        method_hint: flow.method_hint,
    })
}

/// A challenge that can still be answered (not consumed, not retired by a resend).
async fn live_challenge(
    conn: &mut PgConnection,
    id: Uuid,
    purpose: OtpPurpose,
) -> ApiResult<Option<ChallengeView>> {
    Ok(otp::get(conn, id)
        .await?
        .filter(|c| c.purpose == purpose && c.consumed_at.is_none())
        .map(|c| ChallengeView::from_challenge(&c)))
}

/// Builds the what's-shared screen for an account.
pub async fn consent_view(
    conn: &mut PgConnection,
    flow: &Flow,
    fa: &FlowApp,
    account: &Account,
) -> ApiResult<ConsentView> {
    // Masked like the code destinations (02-api.md shows "s***@gmail.com" on this screen).
    let email = contacts::primary(conn, ContactKind::Email, &account.uuid)
        .await?
        .filter(|c| c.verified)
        .map(|c| accounts_core::normalize::mask_email(&c.value));
    let phone = contacts::primary(conn, ContactKind::Phone, &account.uuid)
        .await?
        .filter(|c| c.verified)
        .map(|c| accounts_core::normalize::mask_phone(&c.value));
    let value_of = |s: Scope| -> Option<String> {
        match s {
            Scope::Profile => Some(format!("{} ({})", account.display_name, account.id())),
            Scope::Email => email.clone(),
            Scope::Phone => phone.clone(),
            Scope::Dob => Some(format_date(account.dob)),
            Scope::Timezone => Some(account.timezone.clone()),
            Scope::Openid | Scope::OfflineAccess => None,
        }
    };
    let previously_granted: Vec<Scope> =
        match memberships::get(conn, &fa.app.app_id, &account.uuid).await? {
            Some(m) if m.is_live() => m.scopes(),
            _ => Vec::new(),
        };
    let requested = next::requested_contact_scopes(flow);
    let required = std::iter::once(Scope::Profile)
        .chain(next::required_scopes(&fa.config))
        .map(|s| ConsentItem {
            scope: s,
            label: s.label(),
            value: value_of(s),
        })
        .collect();
    let optional = next::optional_scopes(flow, &fa.config)
        .into_iter()
        .map(|s| ConsentOptional {
            scope: s,
            label: s.label(),
            value: value_of(s),
            granted: previously_granted.contains(&s) || requested.contains(&s),
        })
        .collect();
    Ok(ConsentView {
        required,
        optional,
        previously_granted,
    })
}

/// Today's date (UTC) — the sign-up dob suggestion is based on it.
pub fn today() -> Date {
    accounts_core::timefmt::today_utc()
}
