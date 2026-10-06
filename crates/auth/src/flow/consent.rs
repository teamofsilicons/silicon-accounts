//! The what's-shared screen: `POST /v1/flows/{id}/consent`.

use accounts_core::http::{ClientMeta, Json, Path};
use accounts_core::models::Scope;
use accounts_core::{ApiError, ApiResult, AppState, FieldErrors};
use axum::extract::State;
use axum::http::{HeaderMap, Method};
use serde::{Deserialize, Serialize};

use super::model::{self, Step};
use super::next::{self, Grant};
use super::view::{self, ViewContext};
use super::{FlowApp, FlowResponse, browser, load_bound};

/// `{"approve":true,"optional_scopes":["timezone"]}`.
#[derive(Debug, Deserialize, Serialize)]
pub struct ConsentBody {
    pub approve: bool,
    /// Optional details the Carbon agrees to share (any of FlowView.consent.optional).
    #[serde(default)]
    pub optional_scopes: Vec<String>,
}

/// `POST /v1/flows/{id}/consent` (flow + session).
///
/// Approve: membership (granted = profile + required + chosen optional, + openid when asked),
/// sign-in history and the authorization code; `redirect_to = redirect_uri?code=…&state=…`.
/// Decline: `redirect_to = redirect_uri?error=access_denied&state=…`. A required detail that
/// went missing meanwhile: 409 `requirements_missing` (the flow goes back to requirements).
pub async fn submit_consent(
    State(state): State<AppState>,
    meta: ClientMeta,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<ConsentBody>,
) -> ApiResult<FlowResponse> {
    let mut tx = state.db.begin().await?;
    let mut flow = load_bound(&mut tx, &state, &headers, &Method::POST, &id, true).await?;
    model::ensure_live(&flow)?;
    model::ensure_step(&flow, &[Step::Consent], "record consent")?;
    let fa = FlowApp::load(&mut tx, &state.settings, &flow.app_id).await?;
    fa.ensure_active()?;
    let account = browser::require_flow_account(&mut tx, &state, &headers, &flow).await?;

    if !body.approve {
        next::decline(&mut tx, &state, &meta, &mut flow, &fa, &account).await?;
    } else {
        let missing = next::missing_requirements(&mut tx, &fa.config, &account).await?;
        if !missing.is_empty() {
            let names: Vec<&str> = missing.iter().map(|f| f.as_str()).collect();
            flow.step = Step::Requirements;
            flow.challenge_id = None;
            model::save(&mut tx, &flow).await?;
            tx.commit().await?;
            return Err(ApiError::conflict(
                "requirements_missing",
                format!(
                    "{} requires {} before it can be shared, and {} doesn't have it (verified) any more.",
                    fa.app.name,
                    names.join(" and "),
                    account.display_id()
                ),
            )
            .hint(format!(
                "Add it first: POST /v1/flows/{id}/requirements/{} (the flow is back at the requirements step).",
                names[0]
            ))
            .detail("missing", names));
        }
        let optional = next::optional_scopes(&flow, &fa.config);
        let mut chosen = Vec::new();
        let mut fields = FieldErrors::new();
        for (i, raw) in body.optional_scopes.iter().enumerate() {
            match Scope::parse(raw.trim()) {
                Some(s) if optional.contains(&s) => chosen.push(s),
                _ => fields.add(
                    format!("optional_scopes[{i}]"),
                    format!(
                        "'{raw}' is not an optional detail of {}; the optional details are: {}",
                        fa.app.name,
                        if optional.is_empty() {
                            "none".to_string()
                        } else {
                            optional
                                .iter()
                                .map(Scope::as_str)
                                .collect::<Vec<_>>()
                                .join(", ")
                        }
                    ),
                ),
            }
        }
        fields.into_result()?;
        let mut scopes = vec![Scope::Profile];
        scopes.extend(next::required_scopes(&fa.config));
        scopes.extend(chosen);
        next::complete(
            &mut tx,
            &state,
            &meta,
            &mut flow,
            &fa,
            &account,
            Grant::Consent(scopes),
        )
        .await?;
    }
    model::save(&mut tx, &flow).await?;
    let view = view::build(
        &mut tx,
        &ViewContext {
            state: &state,
            meta: &meta,
            browser: None,
        },
        &flow,
        &fa,
    )
    .await?;
    tx.commit().await?;
    Ok(FlowResponse::ok(view, Vec::new()))
}
