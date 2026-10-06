//! The requirements step: the app requires an email or phone the account doesn't have yet,
//! so the Carbon adds it here with an inline code (UNDERSTANDING.md "What's shared with the
//! app": "they must add it before continuing").
//!
//! A flow never stays stuck here: when nothing is missing any more (the detail was added in
//! another tab or on the account site, or the app stopped requiring it), `GET /v1/flows/{id}`
//! and the send endpoints move it on to consent (or complete it).

use accounts_core::delivery;
use accounts_core::http::{ClientMeta, Json, Path};
use accounts_core::models::{
    AccountField, ActorKind, ContactField, OtpChannel, OtpPurpose, VerifiedVia,
};
use accounts_core::normalize::{normalize_email, normalize_phone};
use accounts_core::repo::audit::{self, AuditEntry};
use accounts_core::repo::contacts::{self, ContactKind};
use accounts_core::repo::{accounts, otp};
use accounts_core::{ApiError, ApiResult, AppState, events};
use axum::extract::State;
use axum::http::{HeaderMap, Method};
use serde_json::json;

use super::handlers::{CodeBody, EmailBody, PhoneBody};
use super::model::{self, Flow, Step};
use super::view::{self, ViewContext};
use super::{FlowApp, FlowResponse, browser, load_bound, next, signup};
use crate::codes;
use crate::util::telemetry;

/// Moves a flow at `requirements` on (consent or complete) when its account no longer misses
/// anything. Returns true when it moved. Nothing happens when the browser is no longer signed
/// in as the flow's account: the step's endpoints say why.
pub async fn advance_if_satisfied(
    conn: &mut sqlx::PgConnection,
    state: &AppState,
    headers: &HeaderMap,
    meta: &ClientMeta,
    flow: &mut Flow,
    fa: &FlowApp,
) -> ApiResult<bool> {
    let account = match browser::require_flow_account(conn, state, headers, flow).await {
        Ok(account) => account,
        Err(e) if e.is_server_error() => return Err(e),
        Err(_) => return Ok(false),
    };
    if !next::missing_requirements(conn, &fa.config, &account)
        .await?
        .is_empty()
    {
        return Ok(false);
    }
    next::advance(conn, state, meta, flow, fa, &account).await?;
    Ok(true)
}

/// `POST /v1/flows/{id}/requirements/email` (flow + session).
pub async fn send_email_requirement(
    State(state): State<AppState>,
    meta: ClientMeta,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<EmailBody>,
) -> ApiResult<FlowResponse> {
    send_requirement(
        &state,
        &meta,
        &headers,
        &id,
        ContactKind::Email,
        &body.email,
        None,
    )
    .await
}

/// `POST /v1/flows/{id}/requirements/phone` (flow + session).
pub async fn send_phone_requirement(
    State(state): State<AppState>,
    meta: ClientMeta,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<PhoneBody>,
) -> ApiResult<FlowResponse> {
    send_requirement(
        &state,
        &meta,
        &headers,
        &id,
        ContactKind::Phone,
        &body.phone,
        body.country.as_deref(),
    )
    .await
}

fn field_of(kind: ContactKind) -> ContactField {
    match kind {
        ContactKind::Email => ContactField::Email,
        ContactKind::Phone => ContactField::Phone,
    }
}

async fn send_requirement(
    state: &AppState,
    meta: &ClientMeta,
    headers: &HeaderMap,
    id: &str,
    kind: ContactKind,
    raw: &str,
    country: Option<&str>,
) -> ApiResult<FlowResponse> {
    let mut tx = state.db.begin().await?;
    let mut flow = load_bound(&mut tx, state, headers, &Method::POST, id, true).await?;
    model::ensure_live(&flow)?;
    model::ensure_step(&flow, &[Step::Requirements], "add a required detail")?;
    let fa = FlowApp::load(&mut tx, &state.settings, &flow.app_id).await?;
    fa.ensure_active()?;
    let account = browser::require_flow_account(&mut tx, state, headers, &flow).await?;
    let missing = next::missing_requirements(&mut tx, &fa.config, &account).await?;
    if missing.is_empty() {
        // Added meanwhile (another tab, the account site) or no longer required: move on.
        next::advance(&mut tx, state, meta, &mut flow, &fa, &account).await?;
        model::save(&mut tx, &flow).await?;
        let response = respond(&mut tx, state, meta, &flow, &fa).await?;
        tx.commit().await?;
        return Ok(response);
    }
    let field = field_of(kind);
    if !missing.contains(&field) {
        return Err(ApiError::conflict(
            "requirement_not_needed",
            format!(
                "{} doesn't need a {} from {}: it isn't missing.",
                fa.app.name,
                kind.noun(),
                account.display_id()
            ),
        )
        .hint("Add only what FlowView.requirements.missing lists.")
        .detail(
            "missing",
            missing.iter().map(|f| f.as_str()).collect::<Vec<_>>(),
        ));
    }
    let value = match kind {
        ContactKind::Email => normalize_email(raw)?,
        ContactKind::Phone => normalize_phone(raw, country)?,
    };
    if kind == ContactKind::Email && !fa.config.email_domain_allowed(&value) {
        return Err(next::domain_not_allowed(&fa, Some(&value)));
    }
    match contacts::check_can_add(&mut tx, kind, &account.uuid, &value).await {
        Ok(()) => {}
        Err(e) if e.code == format!("{}_already_added", kind.code()) => {
            // Already verified on the account (just not primary): no code needed.
            let primary_changed =
                signup::prove_contact(&mut tx, kind, &account.uuid, &value, VerifiedVia::Code)
                    .await?;
            if primary_changed {
                let updated = accounts::bump_version(&mut tx, &account.uuid).await?;
                events::account_updated(&mut tx, &updated, &[account_field(kind)]).await?;
            }
            let account = accounts::require(&mut tx, &account.uuid).await?;
            next::advance(&mut tx, state, meta, &mut flow, &fa, &account).await?;
            model::save(&mut tx, &flow).await?;
            let response = respond(&mut tx, state, meta, &flow, &fa).await?;
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
    let response = respond(&mut tx, state, meta, &flow, &fa).await?;
    tx.commit().await?;
    delivery::spawn_deliver(state, message_id);
    telemetry(
        state,
        "flow.requirement_code_sent",
        Some(0.8),
        json!({"app_id": fa.app.app_id, "field": field.as_str()}),
    );
    Ok(response)
}

fn account_field(kind: ContactKind) -> AccountField {
    match kind {
        ContactKind::Email => AccountField::Email,
        ContactKind::Phone => AccountField::Phone,
    }
}

/// `POST /v1/flows/{id}/requirements/verify` (flow + session): adds the verified email/phone
/// to the account (primary when it has none) and moves on.
pub async fn verify_requirement(
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
        model::ensure_step(&flow, &[Step::Requirements], "verify a requirement code")?;
        let Some(challenge_id) = flow.challenge_id else {
            return Err(ApiError::conflict(
                "no_code_sent",
                format!("Sign-in flow '{id}' hasn't sent a code for a required detail yet."),
            )
            .hint(format!(
                "Send one first: POST /v1/flows/{id}/requirements/email or /v1/flows/{id}/requirements/phone."
            )));
        };
        let account = browser::require_flow_account(&mut conn, &state, &headers, &flow).await?;
        (challenge_id, account.uuid)
    };
    // The lockout counts every code sent to the address (see `codes`).
    let challenge = codes::verify(
        &state,
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
    if flow.step != Step::Requirements || flow.challenge_id != Some(challenge_id) {
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
    let primary_changed = signup::prove_contact(
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
    let account = accounts::require(&mut tx, &account_uuid).await?;
    next::advance(&mut tx, &state, &meta, &mut flow, &fa, &account).await?;
    model::save(&mut tx, &flow).await?;
    let response = respond(&mut tx, &state, &meta, &flow, &fa).await?;
    tx.commit().await?;
    telemetry(
        &state,
        "flow.requirement_added",
        Some(0.85),
        json!({"app_id": fa.app.app_id, "field": kind.code(), "next_step": flow.step.as_str()}),
    );
    Ok(response)
}

async fn respond(
    conn: &mut sqlx::PgConnection,
    state: &AppState,
    meta: &ClientMeta,
    flow: &model::Flow,
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
