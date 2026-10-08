//! The browser half of the CLI device flow: a signed-in Carbon looks at a pending
//! `silicon-accounts login` request and approves or denies it. (`POST /v1/device/authorize` and the
//! polling token grant live in the oauth crate; both share `device_authorizations`.)

use accounts_core::http::{CarbonAuth, ClientMeta, Path};
use accounts_core::models::ActorKind;
use accounts_core::repo::audit::{self, AuditEntry};
use accounts_core::repo::tokens::{self, DeviceAuthorization};
use accounts_core::timefmt::format_rfc3339_ms;
use accounts_core::{ApiResult, AppState};
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};

use crate::util::no_store;

fn view(d: &DeviceAuthorization) -> Value {
    let expired = d.status == "pending" && d.expires_at <= time::OffsetDateTime::now_utc();
    json!({
        "user_code": d.user_code,
        "client_label": d.client_label,
        "created_at": format_rfc3339_ms(d.created_at),
        "expires_at": format_rfc3339_ms(d.expires_at),
        // pending | approved | denied | consumed | expired (a pending code past its 10 minutes)
        "status": if expired { "expired" } else { d.status.as_str() },
    })
}

/// `GET /v1/device/{user_code}` (session, Carbon). 404 `device_code_not_found`.
pub async fn show(
    State(state): State<AppState>,
    _me: CarbonAuth,
    Path(user_code): Path<String>,
) -> ApiResult<Response> {
    let mut conn = state.db.acquire().await?;
    let d = tokens::device_by_user_code(&mut conn, &user_code).await?;
    let mut response = axum::Json(view(&d)).into_response();
    no_store(response.headers_mut());
    Ok(response)
}

/// `POST /v1/device/{user_code}/approve` (session, Carbon): the CLI's next poll receives
/// first-party tokens for this Carbon. 204. Errors: 404 `device_code_not_found`, 410
/// `device_code_expired`, 409 `device_code_used`.
pub async fn approve(
    State(state): State<AppState>,
    meta: ClientMeta,
    me: CarbonAuth,
    Path(user_code): Path<String>,
) -> ApiResult<StatusCode> {
    decide(&state, &meta, &me, &user_code, true).await
}

/// `POST /v1/device/{user_code}/deny` (session, Carbon): the CLI's next poll gets
/// `access_denied`. 204.
pub async fn deny(
    State(state): State<AppState>,
    meta: ClientMeta,
    me: CarbonAuth,
    Path(user_code): Path<String>,
) -> ApiResult<StatusCode> {
    decide(&state, &meta, &me, &user_code, false).await
}

async fn decide(
    state: &AppState,
    meta: &ClientMeta,
    me: &CarbonAuth,
    user_code: &str,
    approve: bool,
) -> ApiResult<StatusCode> {
    let mut tx = state.db.begin().await?;
    let d = tokens::decide_device(&mut tx, user_code, me.uuid(), approve).await?;
    audit::record(
        &mut tx,
        &AuditEntry {
            account_uuid: Some(me.uuid()),
            app_id: Some(accounts_core::FIRST_PARTY_APP_ID),
            target_kind: Some("device"),
            target_id: Some(&d.user_code),
            details: json!({"client_label": d.client_label}),
            ip: meta.ip.as_deref(),
            ..AuditEntry::new(
                ActorKind::Account,
                Some(me.uuid()),
                if approve {
                    "device.approved"
                } else {
                    "device.denied"
                },
            )
        },
    )
    .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}
