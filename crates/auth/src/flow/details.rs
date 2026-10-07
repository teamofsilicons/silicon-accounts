//! The details pages of the hosted flow: the app's flow steps and the optional review page
//! (UNDERSTANDING.md "What's shared with the app" and "Flows"). They replace the old
//! requirements and consent steps.
//!
//! ```text
//! account known ──▶ details[0] ─continue─▶ details[1] … ─continue─▶ review (flow.review) ─approve─▶ complete
//!                      ▲ back │                                ▲ back │
//!                      └──────┘                                └──────┘
//! any details step or the review ── POST …/review {"approve": false} ──▶ complete, error=access_denied
//! ```
//!
//! **Which steps a Carbon sees.** Every step the first time they sign in to the app (no active
//! membership: never signed in, imported, or access removed) and with `prompt=consent`. After
//! that only a step with something new on it: a required detail the app wasn't granted yet, a
//! required email or phone the account doesn't have (verified) any more, or a detail the
//! `scope` parameter asks for that wasn't granted. A Carbon with nothing new goes straight to
//! complete. The first-party apps (`accounts`, `developer`) never show these pages.
//!
//! **Details.** Required details are always shared; a missing email or phone must be added on
//! the page (`…/details/add` + `…/details/verify`, a 6-digit code) before continuing. Optional
//! details are checkboxes, unticked unless the Carbon ticks them; one they shared with the app
//! before starts ticked, and an email or phone they add on the page starts ticked. Details the
//! `scope` parameter asks for that the app doesn't request are optional details of the last
//! step. The Carbon's answers are kept per detail (each detail is on exactly one step), so going
//! back keeps them.
//!
//! **Grant.** profile + required + ticked optional details (+ openid when asked). An optional
//! detail on a step the Carbon didn't see keeps what they granted before.
//!
//! Every endpoint here acts for the flow's account: it needs the flow's binding cookie, the
//! Origin guard and the browser session of that account.

use accounts_core::delivery;
use accounts_core::http::{ClientMeta, Json, Path};
use accounts_core::models::{
    Account, AccountField, ActorKind, ContactField, FieldMode, Layout, Membership,
    MembershipStatus, OtpChannel, OtpPurpose, Scope, SigninConfig, VerifiedVia, normalize_scopes,
};
use accounts_core::normalize::{mask_email, mask_phone, normalize_email, normalize_phone};
use accounts_core::repo::audit::{self, AuditEntry};
use accounts_core::repo::contacts::{self, ContactKind};
use accounts_core::repo::{accounts, memberships, otp};
use accounts_core::timefmt::format_date;
use accounts_core::views::PrimaryContact;
use accounts_core::{ApiError, ApiResult, AppState, FieldErrors, events};
use axum::extract::State;
use axum::http::{HeaderMap, Method};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::PgConnection;

use super::handlers::CodeBody;
use super::model::{self, Flow, Step};
use super::next::{self, Grant};
use super::view::{self, ChallengeView, ViewContext};
use super::{FlowApp, FlowResponse, browser, load_bound};
use crate::util::telemetry;

// ----------------------------------------------------------------------------- the plan

/// A step of the flow as this sign-in walks it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlanStep {
    pub id: String,
    pub title: Option<String>,
    pub subtitle: Option<String>,
    pub continue_label: Option<String>,
    /// `None` = `branding.layout`.
    pub layout: Option<Layout>,
    /// The details on this page and how the app asks for each.
    pub fields: Vec<(ContactField, FieldMode)>,
}

impl PlanStep {
    fn has(&self, field: ContactField) -> bool {
        self.fields.iter().any(|(f, _)| *f == field)
    }

    fn mode_of(&self, field: ContactField) -> Option<FieldMode> {
        self.fields
            .iter()
            .find(|(f, _)| *f == field)
            .map(|(_, m)| *m)
    }
}

/// The app's flow for this sign-in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    pub steps: Vec<PlanStep>,
    /// Show the review page after the last step.
    pub review: bool,
}

impl Plan {
    /// The app's effective flow (`SigninConfig::effective_flow`), plus the details the `scope`
    /// parameter asks for that the app doesn't request (optional, on the last step).
    pub fn of(flow: &Flow, config: &SigninConfig) -> Plan {
        let effective = config.effective_flow();
        let mut steps: Vec<PlanStep> = effective
            .steps
            .into_iter()
            .map(|s| PlanStep {
                fields: s
                    .fields
                    .iter()
                    .filter_map(|f| config.mode_of(*f).map(|m| (*f, m)))
                    .collect(),
                id: s.id,
                title: s.title,
                subtitle: s.subtitle,
                continue_label: s.continue_label,
                layout: s.layout,
            })
            .collect();
        if let Some(last) = steps.last_mut() {
            for f in asked_in_scope(flow) {
                if config.mode_of(f).is_none() && !last.has(f) {
                    last.fields.push((f, FieldMode::Optional));
                }
            }
        }
        Plan {
            steps,
            review: effective.review,
        }
    }

    fn index_of(&self, id: &str) -> Option<usize> {
        self.steps.iter().position(|s| s.id == id)
    }
}

/// Details (email, phone, dob, timezone) the `scope` parameter asked for.
pub fn asked_in_scope(flow: &Flow) -> Vec<ContactField> {
    flow.requested_scopes
        .iter()
        .filter_map(Scope::contact_field)
        .collect()
}

/// What the account has and already granted the app.
#[derive(Debug, Clone)]
pub struct Standing {
    pub account: Account,
    pub email: Option<PrimaryContact>,
    pub phone: Option<PrimaryContact>,
    /// Scopes of the live (active or imported) membership; empty without one.
    pub granted: Vec<Scope>,
    /// The account signed in to the app before and still has it (membership `active`).
    pub active_member: bool,
}

impl Standing {
    pub async fn load(
        conn: &mut PgConnection,
        app_id: &str,
        account: &Account,
    ) -> ApiResult<Standing> {
        let email = contacts::primary(conn, ContactKind::Email, &account.uuid).await?;
        let phone = contacts::primary(conn, ContactKind::Phone, &account.uuid).await?;
        let membership: Option<Membership> = memberships::get(conn, app_id, &account.uuid).await?;
        let granted = match &membership {
            Some(m) if m.is_live() => m.scopes(),
            _ => Vec::new(),
        };
        let active_member = membership
            .as_ref()
            .is_some_and(|m| m.status == MembershipStatus::Active);
        Ok(Standing {
            account: account.clone(),
            email,
            phone,
            granted,
            active_member,
        })
    }

    /// True when the account has the detail: a verified primary email or phone (every account
    /// has a date of birth and a timezone).
    pub fn has(&self, field: ContactField) -> bool {
        match field {
            ContactField::Email => self.email.as_ref().is_some_and(|c| c.verified),
            ContactField::Phone => self.phone.as_ref().is_some_and(|c| c.verified),
            ContactField::Dob | ContactField::Timezone => true,
        }
    }

    /// The value the app would get, masked like code destinations for email and phone.
    pub fn value(&self, field: ContactField) -> Option<String> {
        match field {
            ContactField::Email => self
                .email
                .as_ref()
                .filter(|c| c.verified)
                .map(|c| mask_email(&c.value)),
            ContactField::Phone => self
                .phone
                .as_ref()
                .filter(|c| c.verified)
                .map(|c| mask_phone(&c.value)),
            ContactField::Dob => Some(format_date(self.account.dob)),
            ContactField::Timezone => Some(self.account.timezone.clone()),
        }
    }

    /// True when the account granted the app this detail before.
    pub fn granted(&self, field: ContactField) -> bool {
        self.granted.contains(&field.scope())
    }

    /// `Ada Lovelace (c:ada)`.
    pub fn profile_value(&self) -> String {
        format!("{} ({})", self.account.display_name, self.account.id())
    }
}

/// True when a step has something for the Carbon (see the module docs).
pub fn needs_carbon(step: &PlanStep, standing: &Standing, flow: &Flow) -> bool {
    if flow.prompt.consent || !standing.active_member {
        return true;
    }
    let asked = asked_in_scope(flow);
    step.fields.iter().any(|(f, mode)| match mode {
        FieldMode::Required => !standing.has(*f) || !standing.granted(*f),
        FieldMode::Optional => asked.contains(f) && !standing.granted(*f),
    })
}

/// Indices of the steps this sign-in shows, in flow order: the ones with something for the
/// Carbon, the ones they already continued through and the one on screen (a page stays until
/// the Carbon continues, also once its missing detail was added).
pub fn shown(plan: &Plan, standing: &Standing, flow: &Flow) -> Vec<usize> {
    let progress = &flow.extras.details;
    plan.steps
        .iter()
        .enumerate()
        .filter(|(_, s)| {
            progress.done.contains(&s.id)
                || progress.current.as_deref() == Some(s.id.as_str())
                || needs_carbon(s, standing, flow)
        })
        .map(|(i, _)| i)
        .collect()
}

/// Required email/phone the account doesn't have, by step (first step first).
pub fn missing_required(plan: &Plan, standing: &Standing) -> Vec<(String, ContactField)> {
    plan.steps
        .iter()
        .flat_map(|s| {
            s.fields
                .iter()
                .filter(|(f, m)| *m == FieldMode::Required && !standing.has(*f))
                .map(|(f, _)| (s.id.clone(), *f))
        })
        .collect()
}

/// Required details of the app the account doesn't have (`prompt=none` can't ask for them).
pub fn missing_required_fields(config: &SigninConfig, standing: &Standing) -> Vec<ContactField> {
    config
        .required_fields
        .iter()
        .copied()
        .filter(|f| !standing.has(*f))
        .collect()
}

/// True when this sign-in has a details page for the Carbon (`prompt=none` fails then).
pub fn any_page(plan: &Plan, standing: &Standing, flow: &Flow) -> bool {
    plan.steps.iter().any(|s| needs_carbon(s, standing, flow))
}

/// Scopes granted when the Carbon went through the pages: profile + required + ticked optional
/// details (an optional detail they didn't answer in this flow keeps what they granted before).
pub fn chosen_scopes(plan: &Plan, standing: &Standing, flow: &Flow) -> Vec<Scope> {
    let mut scopes = vec![Scope::Profile];
    for step in &plan.steps {
        for (f, mode) in &step.fields {
            let shared = match mode {
                FieldMode::Required => true,
                FieldMode::Optional => flow
                    .extras
                    .details
                    .choice(*f)
                    .unwrap_or_else(|| standing.granted(*f)),
            };
            if shared {
                scopes.push(f.scope());
            }
        }
    }
    normalize_scopes(scopes)
}

/// Where the flow goes after its current page.
enum Next {
    /// The next details step (its id).
    Step(String),
    Review,
    /// No page left: complete. `saw_pages` tells whether the Carbon answered any page.
    Complete {
        saw_pages: bool,
    },
}

fn next_page(plan: &Plan, standing: &Standing, flow: &Flow) -> Next {
    let shown = shown(plan, standing, flow);
    let done = &flow.extras.details.done;
    if let Some(i) = shown.iter().find(|i| !done.contains(&plan.steps[**i].id)) {
        return Next::Step(plan.steps[*i].id.clone());
    }
    if shown.is_empty() {
        Next::Complete { saw_pages: false }
    } else if plan.review {
        Next::Review
    } else {
        Next::Complete { saw_pages: true }
    }
}

/// Puts a flow whose account is known on its first details page, or completes it when the
/// Carbon has nothing to see (returning with everything granted, or a first-party app).
pub async fn start(
    conn: &mut PgConnection,
    state: &AppState,
    meta: &ClientMeta,
    flow: &mut Flow,
    fa: &FlowApp,
    account: &Account,
) -> ApiResult<()> {
    flow.extras.details = Default::default();
    if fa.first_party() {
        return next::complete(conn, state, meta, flow, fa, account, Grant::Auto).await;
    }
    let plan = Plan::of(flow, &fa.config);
    let standing = Standing::load(conn, &fa.app.app_id, account).await?;
    go_next(conn, state, meta, flow, fa, &plan, &standing).await
}

/// What [`go_next`] couldn't do: a required detail went missing before completing.
fn requirements_missing(
    flow: &Flow,
    fa: &FlowApp,
    standing: &Standing,
    missing: &[ContactField],
) -> ApiError {
    let names: Vec<&str> = missing.iter().map(ContactField::as_str).collect();
    let first = names.first().copied().unwrap_or("email");
    ApiError::conflict(
        "requirements_missing",
        format!(
            "{} requires {} before continuing, and {} doesn't have {} (verified) yet.",
            fa.app.name,
            names.join(" and "),
            standing.account.display_id(),
            if names.len() == 1 { "it" } else { "them" }
        ),
    )
    .hint(format!(
        "Add it on this page: POST /v1/flows/{}/details/add with {{\"{first}\": …}}, then POST /v1/flows/{}/details/verify with the 6-digit code.",
        flow.id, flow.id
    ))
    .detail("missing", names)
}

/// Moves the flow to its next page, or completes it. When a required detail went missing
/// meanwhile (removed in another tab), the flow goes back to that detail's page and the error
/// says so: the caller saves the flow before returning it.
async fn go_next(
    conn: &mut PgConnection,
    state: &AppState,
    meta: &ClientMeta,
    flow: &mut Flow,
    fa: &FlowApp,
    plan: &Plan,
    standing: &Standing,
) -> ApiResult<()> {
    flow.challenge_id = None;
    match next_page(plan, standing, flow) {
        Next::Step(id) => {
            flow.step = Step::Details;
            flow.extras.details.current = Some(id);
            Ok(())
        }
        Next::Review => {
            flow.step = Step::Review;
            flow.extras.details.current = None;
            Ok(())
        }
        Next::Complete { saw_pages: false } => {
            next::complete(conn, state, meta, flow, fa, &standing.account, Grant::Auto).await
        }
        Next::Complete { saw_pages: true } => {
            finish(conn, state, meta, flow, fa, plan, standing).await
        }
    }
}

/// Completes a flow whose Carbon went through the pages (checking no required detail went
/// missing meanwhile).
async fn finish(
    conn: &mut PgConnection,
    state: &AppState,
    meta: &ClientMeta,
    flow: &mut Flow,
    fa: &FlowApp,
    plan: &Plan,
    standing: &Standing,
) -> ApiResult<()> {
    let missing = missing_required(plan, standing);
    if let Some((step_id, _)) = missing.first() {
        let on_step: Vec<ContactField> = missing
            .iter()
            .filter(|(s, _)| s == step_id)
            .map(|(_, f)| *f)
            .collect();
        flow.step = Step::Details;
        flow.extras.details.done.retain(|d| d != step_id);
        flow.extras.details.current = Some(step_id.clone());
        flow.challenge_id = None;
        return Err(requirements_missing(flow, fa, standing, &on_step));
    }
    let scopes = chosen_scopes(plan, standing, flow);
    next::complete(
        conn,
        state,
        meta,
        flow,
        fa,
        &standing.account,
        Grant::Chosen(scopes),
    )
    .await
}

/// The details step on screen; `None` when the app's flow changed and the page is gone.
fn current_step<'p>(plan: &'p Plan, flow: &Flow) -> Option<&'p PlanStep> {
    let id = flow.extras.details.current.as_deref()?;
    plan.index_of(id).map(|i| &plan.steps[i])
}

/// Repairs a flow at `details` whose page no longer exists (the app changed its flow while the
/// Carbon was signing in, or the flow was stored by the previous version at `requirements` or
/// `consent`): moves it to its next page, or completes it. Only for the browser signed in as the
/// flow's account (as every details action is). Returns true when the flow changed.
pub async fn repair(
    conn: &mut PgConnection,
    state: &AppState,
    headers: &HeaderMap,
    meta: &ClientMeta,
    flow: &mut Flow,
    fa: &FlowApp,
) -> ApiResult<bool> {
    if flow.step != Step::Details {
        return Ok(false);
    }
    let account = match browser::require_flow_account(conn, state, headers, flow).await {
        Ok(a) => a,
        Err(e) if e.is_server_error() => return Err(e),
        Err(_) => return Ok(false),
    };
    if fa.first_party() {
        next::complete(conn, state, meta, flow, fa, &account, Grant::Auto).await?;
        return Ok(true);
    }
    let plan = Plan::of(flow, &fa.config);
    if current_step(&plan, flow).is_some() {
        return Ok(false);
    }
    let standing = Standing::load(conn, &fa.app.app_id, &account).await?;
    match go_next(conn, state, meta, flow, fa, &plan, &standing).await {
        Ok(()) => Ok(true),
        // The flow is back on the page of the missing detail: a GET shows it.
        Err(e) if e.code == "requirements_missing" => Ok(true),
        Err(e) => Err(e),
    }
}

// ----------------------------------------------------------------------------- views

/// One detail on a details page.
#[derive(Debug, Clone, Serialize)]
pub struct DetailField {
    pub field: ContactField,
    pub mode: FieldMode,
    pub label: &'static str,
    /// What the app gets (email/phone masked like code destinations); null when missing.
    pub value: Option<String>,
    /// A required (or optional) email or phone the account doesn't have yet: add it on this
    /// page (`…/details/add`).
    pub missing: bool,
    /// The checkbox: always true for required details; for optional ones the Carbon's answer,
    /// else whether they shared it before (unticked the first time).
    pub shared: bool,
    /// The account granted this app the detail before.
    pub previously_granted: bool,
}

/// `FlowView.details` (step `details`).
#[derive(Debug, Clone, Serialize)]
pub struct DetailsView {
    /// Position of this page among the pages this sign-in shows (0-based).
    pub index: usize,
    /// How many pages this sign-in shows.
    pub count: usize,
    pub id: String,
    pub title: Option<String>,
    pub subtitle: Option<String>,
    pub continue_label: Option<String>,
    /// `null` = `branding.layout`.
    pub layout: Option<Layout>,
    pub fields: Vec<DetailField>,
    /// The code sent to add a missing email or phone, if any.
    pub challenge: Option<ChallengeView>,
    /// Continuing from this page opens the review page (the last page of a flow with
    /// `review: true`), so the page can say "Review" rather than "Share and continue".
    pub review_next: bool,
}

/// One row of the review page.
#[derive(Debug, Clone, Serialize)]
pub struct ReviewField {
    /// `profile`, or the detail.
    pub field: &'static str,
    pub mode: FieldMode,
    pub label: &'static str,
    pub value: Option<String>,
    pub shared: bool,
}

/// `FlowView.review` (step `review`): everything that will be shared, profile first.
#[derive(Debug, Clone, Serialize)]
pub struct ReviewView {
    pub fields: Vec<ReviewField>,
}

fn detail_field(
    field: ContactField,
    mode: FieldMode,
    standing: &Standing,
    flow: &Flow,
) -> DetailField {
    let missing = !standing.has(field);
    let previously_granted = standing.granted(field);
    let shared = match mode {
        FieldMode::Required => true,
        FieldMode::Optional => {
            !missing
                && flow
                    .extras
                    .details
                    .choice(field)
                    .unwrap_or(previously_granted)
        }
    };
    DetailField {
        field,
        mode,
        label: field.label(),
        value: standing.value(field),
        missing,
        shared,
        previously_granted,
    }
}

/// Builds `FlowView.details` for a flow at `details`.
pub async fn details_view(
    conn: &mut PgConnection,
    flow: &Flow,
    fa: &FlowApp,
    account: &Account,
) -> ApiResult<Option<DetailsView>> {
    let plan = Plan::of(flow, &fa.config);
    let standing = Standing::load(conn, &fa.app.app_id, account).await?;
    // A page that no longer exists (the app changed its flow meanwhile) shows its next page;
    // the next action, or GET by the Carbon's browser, moves the flow there.
    let index = match flow
        .extras
        .details
        .current
        .as_deref()
        .and_then(|id| plan.index_of(id))
    {
        Some(i) => i,
        None => match next_page(&plan, &standing, flow) {
            Next::Step(id) => plan.index_of(&id).unwrap_or(0),
            _ => return Ok(None),
        },
    };
    let step = &plan.steps[index];
    let mut shown = shown(&plan, &standing, flow);
    if !shown.contains(&index) {
        shown.push(index);
        shown.sort_unstable();
    }
    let position = shown.iter().position(|i| *i == index).unwrap_or(0);
    let review_next = plan.review && position + 1 == shown.len();
    let challenge = match flow.challenge_id {
        Some(id) => view::live_challenge(conn, id, OtpPurpose::Requirement).await?,
        None => None,
    };
    Ok(Some(DetailsView {
        index: position,
        count: shown.len(),
        id: step.id.clone(),
        title: step.title.clone(),
        subtitle: step.subtitle.clone(),
        continue_label: step.continue_label.clone(),
        layout: step.layout,
        fields: step
            .fields
            .iter()
            .map(|(f, m)| detail_field(*f, *m, &standing, flow))
            .collect(),
        challenge,
        review_next,
    }))
}

/// Builds `FlowView.review` for a flow at `review`: the profile, then every detail that will
/// be shared, in flow order.
pub async fn review_view(
    conn: &mut PgConnection,
    flow: &Flow,
    fa: &FlowApp,
    account: &Account,
) -> ApiResult<ReviewView> {
    let plan = Plan::of(flow, &fa.config);
    let standing = Standing::load(conn, &fa.app.app_id, account).await?;
    let granted = chosen_scopes(&plan, &standing, flow);
    let mut fields = vec![ReviewField {
        field: Scope::Profile.as_str(),
        mode: FieldMode::Required,
        label: Scope::Profile.label(),
        value: Some(standing.profile_value()),
        shared: true,
    }];
    for step in &plan.steps {
        for (f, mode) in &step.fields {
            if granted.contains(&f.scope()) {
                fields.push(ReviewField {
                    field: f.as_str(),
                    mode: *mode,
                    label: f.label(),
                    value: standing.value(*f),
                    shared: true,
                });
            }
        }
    }
    Ok(ReviewView { fields })
}

// ----------------------------------------------------------------------------- endpoints

/// `POST /v1/flows/{id}/details/add`: `{"email": "…"}` or `{"phone": "…", "country"?: "US"}`.
#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct AddBody {
    pub email: Option<String>,
    pub phone: Option<String>,
    /// ISO 3166 code for a local phone number.
    pub country: Option<String>,
}

/// `POST /v1/flows/{id}/details/continue`: `{"share": ["timezone"]}`.
#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct ContinueBody {
    /// The optional details of this page the Carbon ticked (required ones may be listed too;
    /// they are always shared).
    pub share: Vec<String>,
}

/// `POST /v1/flows/{id}/review`: `{"approve": true}`.
#[derive(Debug, Deserialize, Serialize)]
pub struct ReviewBody {
    pub approve: bool,
}

async fn respond(
    conn: &mut PgConnection,
    state: &AppState,
    meta: &ClientMeta,
    flow: &Flow,
    fa: &FlowApp,
) -> ApiResult<FlowResponse> {
    let view = view::build(
        conn,
        &ViewContext {
            state,
            meta,
            browser: None,
        },
        flow,
        fa,
    )
    .await?;
    Ok(FlowResponse::ok(view, Vec::new()))
}

/// Loads what every details action needs: the row-locked flow at one of `steps`, its active
/// app and the flow's account (still the browser's).
async fn begin(
    tx: &mut PgConnection,
    state: &AppState,
    headers: &HeaderMap,
    id: &str,
    steps: &[Step],
    action: &str,
) -> ApiResult<(Flow, FlowApp, Account)> {
    let flow = load_bound(tx, state, headers, &Method::POST, id, true).await?;
    model::ensure_live(&flow)?;
    model::ensure_step(&flow, steps, action)?;
    let fa = FlowApp::load(tx, &state.settings, &flow.app_id).await?;
    fa.ensure_active()?;
    let account = browser::require_flow_account(tx, state, headers, &flow).await?;
    Ok((flow, fa, account))
}

/// 409 `flow_changed`: the page the request was made on is gone.
fn page_moved(flow: &Flow) -> ApiError {
    ApiError::conflict(
        "flow_changed",
        format!(
            "Sign-in flow '{}' is no longer on that page (the app changed its sign-in flow, or another tab moved it on).",
            flow.id
        ),
    )
    .hint(format!(
        "GET /v1/flows/{} shows the page it is on now.",
        flow.id
    ))
}

fn kind_of(field: ContactField) -> Option<ContactKind> {
    match field {
        ContactField::Email => Some(ContactKind::Email),
        ContactField::Phone => Some(ContactKind::Phone),
        ContactField::Dob | ContactField::Timezone => None,
    }
}

fn field_of(kind: ContactKind) -> ContactField {
    match kind {
        ContactKind::Email => ContactField::Email,
        ContactKind::Phone => ContactField::Phone,
    }
}

fn account_field(kind: ContactKind) -> AccountField {
    match kind {
        ContactKind::Email => AccountField::Email,
        ContactKind::Phone => AccountField::Phone,
    }
}

/// A detail the Carbon added on the page starts ticked when it is optional.
fn tick_if_optional(flow: &mut Flow, step: Option<&PlanStep>, field: ContactField) {
    if step.and_then(|s| s.mode_of(field)) == Some(FieldMode::Optional) {
        flow.extras.details.set_choice(field, true);
    }
}

/// `POST /v1/flows/{id}/details/add` (flow + session): sends a 6-digit code to add a missing
/// email or phone of the page on screen (required or optional). When the account already has
/// it (added in another tab or on the account site), nothing is sent and the page shows it.
///
/// Errors: 422 `validation_failed` (neither or both of email/phone, or an invalid value), 409
/// `detail_not_on_page`, 403 `email_domain_not_allowed`, 409 `email_in_use` / `phone_in_use`,
/// 422 `email_limit_reached` / `phone_limit_reached`, 429 `rate_limited` (10 codes per address per
/// 10 minutes), and the flow errors (`invalid_step`, `session_required`, `account_changed`, …).
pub async fn add_detail(
    State(state): State<AppState>,
    meta: ClientMeta,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<AddBody>,
) -> ApiResult<FlowResponse> {
    let (kind, raw) = match (&body.email, &body.phone) {
        (Some(e), None) => (ContactKind::Email, e.as_str()),
        (None, Some(p)) => (ContactKind::Phone, p.as_str()),
        _ => {
            let mut f = FieldErrors::new();
            f.add(
                "email",
                "send exactly one of {\"email\": \"…\"} or {\"phone\": \"…\", \"country\"?: \"US\"}",
            );
            return Err(ApiError::validation(f));
        }
    };
    let mut tx = state.db.begin().await?;
    let (mut flow, fa, account) = begin(
        &mut tx,
        &state,
        &headers,
        &id,
        &[Step::Details],
        "add a detail",
    )
    .await?;
    let plan = Plan::of(&flow, &fa.config);
    let standing = Standing::load(&mut tx, &fa.app.app_id, &account).await?;
    let Some(step) = current_step(&plan, &flow).cloned() else {
        return Err(page_moved(&flow));
    };
    let field = field_of(kind);
    if !step.has(field) {
        let asks: Vec<&str> = step.fields.iter().map(|(f, _)| f.as_str()).collect();
        return Err(ApiError::conflict(
            "detail_not_on_page",
            format!(
                "The page '{}' of {} doesn't ask for {}; it asks for {}.",
                step.id,
                fa.app.name,
                kind.a_noun(),
                if asks.is_empty() {
                    "no details".to_string()
                } else {
                    asks.join(", ")
                }
            ),
        )
        .hint("Add only a detail of FlowView.details.fields whose missing is true.")
        .detail("fields", asks));
    }
    if standing.has(field) {
        // Added meanwhile (another tab, the account site): nothing to send.
        let response = respond(&mut tx, &state, &meta, &flow, &fa).await?;
        tx.commit().await?;
        return Ok(response);
    }
    let value = match kind {
        ContactKind::Email => normalize_email(raw)?,
        ContactKind::Phone => normalize_phone(raw, body.country.as_deref())?,
    };
    if kind == ContactKind::Email && !fa.config.email_domain_allowed(&value) {
        return Err(next::domain_not_allowed(&fa, Some(&value)));
    }
    match contacts::check_can_add(&mut tx, kind, &account.uuid, &value).await {
        Ok(()) => {}
        Err(e) if e.code == format!("{}_already_added", kind.code()) => {
            // Already verified on the account (just not the primary): no code needed.
            let primary_changed =
                contacts::prove(&mut tx, kind, &account.uuid, &value, VerifiedVia::Code).await?;
            if primary_changed {
                let updated = accounts::bump_version(&mut tx, &account.uuid).await?;
                events::account_updated(&mut tx, &updated, &[account_field(kind)]).await?;
            }
            tick_if_optional(&mut flow, Some(&step), field);
            flow.challenge_id = None;
            flow.extras.error = None;
            model::save(&mut tx, &flow).await?;
            let response = respond(&mut tx, &state, &meta, &flow, &fa).await?;
            tx.commit().await?;
            return Ok(response);
        }
        Err(e) => return Err(e),
    }
    let channel = match kind {
        ContactKind::Email => OtpChannel::Email,
        ContactKind::Phone => OtpChannel::Phone,
    };
    let created = otp::send(
        &mut tx,
        &state.keys.pepper,
        &state.settings,
        &otp::NewChallenge {
            purpose: OtpPurpose::Requirement,
            channel,
            destination: &value,
            account_uuid: Some(&account.uuid),
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
    let response = respond(&mut tx, &state, &meta, &flow, &fa).await?;
    tx.commit().await?;
    delivery::spawn_deliver(&state, message_id);
    telemetry(
        &state,
        "flow.detail_code_sent",
        Some(0.75),
        json!({"app_id": fa.app.app_id, "field": field.as_str(), "step": step.id}),
    );
    Ok(response)
}

/// `POST /v1/flows/{id}/details/verify` (flow + session): checks the code sent by
/// `…/details/add` and adds the email or phone, verified, to the account (its primary when it
/// has none verified). The flow stays on the page, which now shows it (an optional detail
/// added this way starts ticked).
///
/// Errors: 409 `no_code_sent`, 422 `invalid_code` (`details.remaining_attempts`), 423
/// `verification_locked`, 410 `code_expired`, 409 `email_in_use` / `phone_in_use` (another
/// account took it meanwhile), 409 `flow_changed`.
pub async fn verify_detail(
    State(state): State<AppState>,
    meta: ClientMeta,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<CodeBody>,
) -> ApiResult<FlowResponse> {
    let (challenge_id, account_uuid) = {
        let mut conn = state.db.acquire().await?;
        let flow = load_bound(&mut conn, &state, &headers, &Method::POST, &id, false).await?;
        model::ensure_live(&flow)?;
        model::ensure_step(&flow, &[Step::Details], "verify a code for a detail")?;
        let Some(challenge_id) = flow.challenge_id else {
            return Err(ApiError::conflict(
                "no_code_sent",
                format!("Sign-in flow '{id}' hasn't sent a code for a missing detail yet."),
            )
            .hint(format!(
                "Send one first: POST /v1/flows/{id}/details/add with {{\"email\": …}} or {{\"phone\": …}}."
            )));
        };
        let account = browser::require_flow_account(&mut conn, &state, &headers, &flow).await?;
        (challenge_id, account.uuid)
    };
    // The lockout counts every code sent to the address (core's `otp::verify`).
    let challenge = otp::verify(
        &state.db,
        &state.keys.pepper,
        &state.settings,
        challenge_id,
        &body.code,
        &otp::Expect {
            purpose: Some(OtpPurpose::Requirement),
            flow_id: Some(&id),
            account_uuid: Some(&account_uuid),
        },
        None,
    )
    .await?;

    let mut tx = state.db.begin().await?;
    let mut flow = model::lock(&mut tx, &id)
        .await?
        .ok_or_else(|| model::flow_not_found(&id))?;
    if flow.step != Step::Details || flow.challenge_id != Some(challenge_id) {
        return Err(ApiError::conflict(
            "flow_changed",
            format!("Sign-in flow '{id}' changed while the code was being checked (another tab?)."),
        )
        .hint(format!("GET /v1/flows/{id} to see where it is now.")));
    }
    let fa = FlowApp::load(&mut tx, &state.settings, &flow.app_id).await?;
    fa.ensure_active()?;
    let kind = match challenge.channel {
        OtpChannel::Email => ContactKind::Email,
        OtpChannel::Phone => ContactKind::Phone,
    };
    // 409 email_in_use / phone_in_use when another account took it meanwhile.
    let primary_changed = contacts::prove(
        &mut tx,
        kind,
        &account_uuid,
        &challenge.destination,
        VerifiedVia::Code,
    )
    .await?;
    if primary_changed {
        let updated = accounts::bump_version(&mut tx, &account_uuid).await?;
        events::account_updated(&mut tx, &updated, &[account_field(kind)]).await?;
    }
    audit::record(
        &mut tx,
        &AuditEntry {
            account_uuid: Some(&account_uuid),
            app_id: Some(&fa.app.app_id),
            target_kind: Some(kind.code()),
            details: json!({"via": "requirement", "app_id": fa.app.app_id, "kind": kind.code()}),
            ip: meta.ip.as_deref(),
            ..AuditEntry::new(ActorKind::Account, Some(&account_uuid), "contact.added")
        },
    )
    .await?;
    let plan = Plan::of(&flow, &fa.config);
    let step = current_step(&plan, &flow).cloned();
    tick_if_optional(&mut flow, step.as_ref(), field_of(kind));
    flow.challenge_id = None;
    flow.extras.error = None;
    model::save(&mut tx, &flow).await?;
    let response = respond(&mut tx, &state, &meta, &flow, &fa).await?;
    tx.commit().await?;
    telemetry(
        &state,
        "flow.detail_added",
        Some(0.8),
        json!({"app_id": fa.app.app_id, "field": kind.code()}),
    );
    Ok(response)
}

/// `POST /v1/flows/{id}/details/continue` (flow + session): `share` = the optional details of
/// this page the Carbon ticked. Records the answers and moves to the next page, the review
/// page, or completes (the authorization code, as before).
///
/// Errors: 422 `validation_failed` (`details.fields["share[0]"]`: not an optional detail of this
/// page, or a missing email/phone that can't be shared yet), 409 `requirements_missing`
/// (`details.missing`: a required email or phone of this page isn't on the account yet), 409
/// `flow_changed` (the page is gone).
pub async fn continue_details(
    State(state): State<AppState>,
    meta: ClientMeta,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<ContinueBody>,
) -> ApiResult<FlowResponse> {
    let mut tx = state.db.begin().await?;
    let (mut flow, fa, account) = begin(
        &mut tx,
        &state,
        &headers,
        &id,
        &[Step::Details],
        "continue to the next page",
    )
    .await?;
    let plan = Plan::of(&flow, &fa.config);
    let standing = Standing::load(&mut tx, &fa.app.app_id, &account).await?;
    let Some(step) = current_step(&plan, &flow).cloned() else {
        return Err(page_moved(&flow));
    };

    let optional: Vec<ContactField> = step
        .fields
        .iter()
        .filter(|(_, m)| *m == FieldMode::Optional)
        .map(|(f, _)| *f)
        .collect();
    let mut ticked: Vec<ContactField> = Vec::new();
    let mut fields = FieldErrors::new();
    for (i, raw) in body.share.iter().enumerate() {
        let path = format!("share[{i}]");
        let Some(field) = ContactField::parse(raw.trim()) else {
            fields.add(
                path,
                format!(
                    "'{raw}' is not a detail; details are {}",
                    ContactField::expected()
                ),
            );
            continue;
        };
        match step.mode_of(field) {
            Some(FieldMode::Required) => {}
            Some(FieldMode::Optional) if !standing.has(field) => fields.add(
                path,
                format!(
                    "'{field}' can't be shared yet: {} has no verified {} on the account; add it first (POST /v1/flows/{id}/details/add) or leave it unticked",
                    account.display_id(),
                    kind_of(field).map(|k| k.noun()).unwrap_or("value")
                ),
            ),
            Some(FieldMode::Optional) => ticked.push(field),
            None => fields.add(
                path,
                format!(
                    "'{field}' is not on this page ('{}'); its optional details are {}",
                    step.id,
                    if optional.is_empty() {
                        "none".to_string()
                    } else {
                        optional
                            .iter()
                            .map(ContactField::as_str)
                            .collect::<Vec<_>>()
                            .join(", ")
                    }
                ),
            ),
        }
    }
    fields.into_result()?;
    let missing: Vec<ContactField> = step
        .fields
        .iter()
        .filter(|(f, m)| *m == FieldMode::Required && !standing.has(*f))
        .map(|(f, _)| *f)
        .collect();
    if !missing.is_empty() {
        return Err(requirements_missing(&flow, &fa, &standing, &missing));
    }

    for f in &optional {
        flow.extras.details.set_choice(*f, ticked.contains(f));
    }
    if !flow.extras.details.done.contains(&step.id) {
        flow.extras.details.done.push(step.id.clone());
    }
    flow.extras.error = None;
    let outcome = go_next(&mut tx, &state, &meta, &mut flow, &fa, &plan, &standing).await;
    model::save(&mut tx, &flow).await?;
    if let Err(e) = outcome {
        // A required detail of an earlier page went missing: the flow is back on that page.
        tx.commit().await?;
        return Err(e);
    }
    let response = respond(&mut tx, &state, &meta, &flow, &fa).await?;
    tx.commit().await?;
    telemetry(
        &state,
        "flow.details_continued",
        Some(0.85),
        json!({
            "app_id": fa.app.app_id,
            "step": step.id,
            "shared": ticked.iter().map(ContactField::as_str).collect::<Vec<_>>(),
            "next_step": flow.step.as_str(),
        }),
    );
    Ok(response)
}

/// `POST /v1/flows/{id}/details/back` (flow + session): the previous page (from the review
/// page: the last details page). The Carbon's answers are kept.
///
/// Errors: 409 `no_previous_page` on the first page.
pub async fn back(
    State(state): State<AppState>,
    meta: ClientMeta,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult<FlowResponse> {
    let mut tx = state.db.begin().await?;
    let (mut flow, fa, account) = begin(
        &mut tx,
        &state,
        &headers,
        &id,
        &[Step::Details, Step::Review],
        "go back a page",
    )
    .await?;
    let plan = Plan::of(&flow, &fa.config);
    let standing = Standing::load(&mut tx, &fa.app.app_id, &account).await?;
    let shown = shown(&plan, &standing, &flow);
    let position = match flow.step {
        Step::Review => Some(shown.len()),
        _ => flow
            .extras
            .details
            .current
            .as_deref()
            .and_then(|c| plan.index_of(c))
            .and_then(|i| shown.iter().position(|s| *s == i)),
    };
    let previous = match position {
        Some(p) if p > 0 => shown.get(p - 1).map(|i| plan.steps[*i].id.clone()),
        _ => None,
    };
    let Some(previous) = previous else {
        return Err(ApiError::conflict(
            "no_previous_page",
            format!("Sign-in flow '{id}' is on its first page, so there is no page to go back to."),
        )
        .hint(format!(
            "Continue (POST /v1/flows/{id}/details/continue), or cancel with POST /v1/flows/{id}/review {{\"approve\": false}}."
        )));
    };
    flow.extras.details.done.retain(|d| *d != previous);
    flow.extras.details.current = Some(previous);
    flow.step = Step::Details;
    flow.challenge_id = None;
    flow.extras.error = None;
    model::save(&mut tx, &flow).await?;
    let response = respond(&mut tx, &state, &meta, &flow, &fa).await?;
    tx.commit().await?;
    Ok(response)
}

/// `POST /v1/flows/{id}/review` (flow + session): `{"approve": true}` on the review page
/// completes the sign-in (the authorization code, as before); `{"approve": false}` on the
/// review page or any details page cancels it: `redirect_to = redirect_uri?error=access_denied`.
///
/// Errors: 409 `invalid_step` (approving before the review page), 409 `requirements_missing`
/// (a required detail went missing meanwhile: the flow goes back to its page).
pub async fn review(
    State(state): State<AppState>,
    meta: ClientMeta,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<ReviewBody>,
) -> ApiResult<FlowResponse> {
    let mut tx = state.db.begin().await?;
    let allowed: &[Step] = if body.approve {
        &[Step::Review]
    } else {
        &[Step::Details, Step::Review]
    };
    let action = if body.approve {
        "approve sharing"
    } else {
        "cancel the sign-in"
    };
    let (mut flow, fa, account) = begin(&mut tx, &state, &headers, &id, allowed, action).await?;
    if !body.approve {
        next::decline(&mut tx, &state, &meta, &mut flow, &fa, &account).await?;
    } else {
        let plan = Plan::of(&flow, &fa.config);
        let standing = Standing::load(&mut tx, &fa.app.app_id, &account).await?;
        let outcome = finish(&mut tx, &state, &meta, &mut flow, &fa, &plan, &standing).await;
        if let Err(e) = outcome {
            model::save(&mut tx, &flow).await?;
            tx.commit().await?;
            return Err(e);
        }
    }
    model::save(&mut tx, &flow).await?;
    let response = respond(&mut tx, &state, &meta, &flow, &fa).await?;
    tx.commit().await?;
    telemetry(
        &state,
        "flow.reviewed",
        Some(1.0),
        json!({"app_id": fa.app.app_id, "approve": body.approve}),
    );
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plan_steps_know_their_details() {
        let s = PlanStep {
            id: "x".into(),
            title: None,
            subtitle: None,
            continue_label: None,
            layout: None,
            fields: vec![
                (ContactField::Email, FieldMode::Optional),
                (ContactField::Phone, FieldMode::Required),
            ],
        };
        assert!(s.has(ContactField::Email) && !s.has(ContactField::Dob));
        assert_eq!(s.mode_of(ContactField::Phone), Some(FieldMode::Required));
        assert_eq!(s.mode_of(ContactField::Timezone), None);
        assert_eq!(kind_of(ContactField::Dob), None);
        assert_eq!(field_of(ContactKind::Phone), ContactField::Phone);
    }
}
