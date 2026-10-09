//! The browser half of the device flow: a signed-in Carbon looks at a pending device sign-in
//! (the silicon-accounts CLI's, or an app's own command-line tool's) and approves or denies it.
//! (`POST /v1/device/authorize` and the polling token grant live in the oauth crate; both share
//! `device_authorizations`.)
//!
//! For an app's tool the answer says which app is asking (`app`: its name, logos and branding,
//! so the approval page can look like the app's sign-in) and what it will see (`scopes`).
//! Approving checks the app's rules first: it must still be active with `device_flow` on, the
//! Carbon must have a verified email at its `allowed_email_domains` (403
//! `email_domain_not_allowed`) and every detail it requires (409 `requirements_missing`).
//!
//! Looking codes up is rate limited per Carbon ([`DEVICE_LOOKUPS_PER_ACCOUNT`]), so a signed-in
//! account can't sweep user codes.

use accounts_core::http::{CarbonAuth, ClientMeta, Path};
use accounts_core::models::{ActorKind, scope_strings};
use accounts_core::repo::apps;
use accounts_core::repo::audit::{self, AuditEntry};
use accounts_core::repo::rate_limit::{self, Limit};
use accounts_core::repo::tokens::{self, DeviceAuthorization};
use accounts_core::timefmt::format_rfc3339_ms;
use accounts_core::{ApiError, ApiResult, AppState};
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};
use sqlx::PgConnection;

use crate::util::no_store;

/// Device codes one Carbon may look at, approve or deny per 10 minutes.
pub const DEVICE_LOOKUPS_PER_ACCOUNT: Limit = Limit::new(60, 600);

async fn view(
    conn: &mut PgConnection,
    state: &AppState,
    d: &DeviceAuthorization,
) -> ApiResult<Value> {
    let expired = d.status == "pending" && d.expires_at <= time::OffsetDateTime::now_utc();
    let mut out = json!({
        "user_code": d.user_code,
        "client_label": d.client_label,
        "created_at": format_rfc3339_ms(d.created_at),
        "expires_at": format_rfc3339_ms(d.expires_at),
        // pending | approved | denied | consumed | expired (a pending code past its 10 minutes)
        "status": if expired { "expired" } else { d.status.as_str() },
        "app_id": d.app_id,
        "first_party": d.first_party(),
        "scopes": scope_strings(&d.scope_list()),
        "app": Value::Null,
    });
    if !d.first_party()
        && let Some(app) = apps::get(conn, &d.app_id).await?
    {
        let config = apps::effective_config(conn, &state.settings, &d.app_id).await?;
        out["app"] = json!({
            "app_id": app.app_id,
            "name": app.name,
            "description": app.description,
            "logo_url": app.logo_url,
            "logo_dark_url": app.logo_dark_url,
            "homepage_url": app.homepage_url,
            "branding": config.branding,
            "copy": config.copy,
        });
    }
    Ok(out)
}

async fn count_lookup(state: &AppState, me: &CarbonAuth) -> ApiResult<()> {
    rate_limit::enforce_pool(
        &state.db,
        &rate_limit::bucket("device_lookup:account", me.uuid()),
        DEVICE_LOOKUPS_PER_ACCOUNT,
        "device codes looked up by this account",
    )
    .await
}

/// `GET /v1/device/{user_code}` (session, Carbon). 404 `device_code_not_found`.
pub async fn show(
    State(state): State<AppState>,
    me: CarbonAuth,
    Path(user_code): Path<String>,
) -> ApiResult<Response> {
    count_lookup(&state, &me).await?;
    let mut conn = state.db.acquire().await?;
    let d = tokens::device_by_user_code(&mut conn, &user_code).await?;
    let mut response = axum::Json(view(&mut conn, &state, &d).await?).into_response();
    no_store(response.headers_mut());
    Ok(response)
}

/// `POST /v1/device/{user_code}/approve` (session, Carbon): the tool's next poll receives
/// tokens for this Carbon (first-party tokens for the silicon-accounts CLI; tokens for the app
/// for an app's tool). 204. Errors: 404 `device_code_not_found`, 410 `device_code_expired`, 409
/// `device_code_used`, and for an app: 403 `app_disabled`, 403 `device_flow_off`, 403
/// `email_domain_not_allowed`, 409 `requirements_missing`.
pub async fn approve(
    State(state): State<AppState>,
    meta: ClientMeta,
    me: CarbonAuth,
    Path(user_code): Path<String>,
) -> ApiResult<StatusCode> {
    decide(&state, &meta, &me, &user_code, true).await
}

/// `POST /v1/device/{user_code}/deny` (session, Carbon): the tool's next poll gets
/// `access_denied`. 204.
pub async fn deny(
    State(state): State<AppState>,
    meta: ClientMeta,
    me: CarbonAuth,
    Path(user_code): Path<String>,
) -> ApiResult<StatusCode> {
    decide(&state, &meta, &me, &user_code, false).await
}

/// The app's rules for an approval: active, `device_flow` still on, and the Carbon admitted.
async fn admit(
    conn: &mut PgConnection,
    state: &AppState,
    me: &CarbonAuth,
    d: &DeviceAuthorization,
) -> ApiResult<()> {
    let app = apps::get(conn, &d.app_id)
        .await?
        .ok_or_else(|| apps::unknown_app(&d.app_id))?;
    if !app.is_active() {
        return Err(ApiError::forbidden(
            "app_disabled",
            format!("{} is disabled, so it can't sign anyone in.", app.name),
        ));
    }
    let config = apps::effective_config(conn, &state.settings, &d.app_id).await?;
    if !config.device_flow {
        return Err(ApiError::forbidden(
            "device_flow_off",
            format!(
                "{} turned off device sign-ins after this code was made, so it can't be approved.",
                app.name
            ),
        )
        .hint("Sign in to the app another way, for example through its sign-in page."));
    }
    accounts_core::access::carbon_may_sign_in(conn, &config, &me.account, &app.name).await
}

async fn decide(
    state: &AppState,
    meta: &ClientMeta,
    me: &CarbonAuth,
    user_code: &str,
    approve: bool,
) -> ApiResult<StatusCode> {
    count_lookup(state, me).await?;
    let mut tx = state.db.begin().await?;
    if approve {
        let pending = tokens::device_by_user_code(&mut tx, user_code).await?;
        if !pending.first_party() && pending.status == "pending" {
            admit(&mut tx, state, me, &pending).await?;
        }
    }
    let d = tokens::decide_device(&mut tx, user_code, me.uuid(), approve).await?;
    audit::record(
        &mut tx,
        &AuditEntry {
            account_uuid: Some(me.uuid()),
            app_id: Some(&d.app_id),
            target_kind: Some("device"),
            target_id: Some(&d.user_code),
            details: json!({"client_label": d.client_label, "scopes": d.scopes}),
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
