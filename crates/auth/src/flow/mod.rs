//! The hosted sign-in flow (`/v1/flows/*`), driven by the SPA at `/authorize`.
//!
//! ```text
//! choose_method ──email/phone──▶ verify_code ──┐
//!       │  └──google/apple (callback)──────────┼──▶ signup (new / finishing an import)
//!       └──continue as the browser's account ──┤        │
//!                                              ▼        ▼
//!                              details (one page per flow step) ──▶ review ──▶ complete
//!                                                                  (flow.review)  (code, or
//!                                                                                 access_denied)
//! prompt=none that can't sign in silently ───────────────────────────────────▶ failed (error redirect)
//! ```
//!
//! Every endpoint except `POST /v1/flows` needs the flow's binding cookie (`sa_flow`) and,
//! for POSTs, an allowed `Origin` (CSRF guard). Steps that act for the signed-in account
//! (details, review) also need the browser session of the flow's account.

pub mod browser;
pub mod create;
pub mod details;
pub mod handlers;
pub mod model;
pub mod next;
pub mod signup;
pub mod view;

use accounts_core::http::check_origin;
use accounts_core::http::cookies::append_cookie;
use accounts_core::models::{App, SigninConfig};
use accounts_core::repo::apps;
use accounts_core::{ApiResult, AppState, Settings};
use axum::http::{HeaderMap, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use cookie::Cookie;
use serde_json::json;
use sqlx::PgConnection;

pub use model::{Flow, Step};
pub use view::FlowView;

/// The app a flow signs into, with its effective sign-in configuration.
#[derive(Debug, Clone)]
pub struct FlowApp {
    pub app: App,
    pub config: SigninConfig,
    pub interface_id: Option<String>,
}

impl FlowApp {
    /// Loads the app (any status) and its effective configuration.
    pub async fn load(
        conn: &mut PgConnection,
        settings: &Settings,
        app_id: &str,
    ) -> ApiResult<FlowApp> {
        let app = apps::get(conn, app_id)
            .await?
            .ok_or_else(|| apps::unknown_app(app_id))?;
        let config = apps::effective_config(conn, settings, app_id).await?;
        Ok(FlowApp {
            app,
            config,
            interface_id: None,
        })
    }

    /// Load the ordinary Accounts identity while enforcing this Interface's
    /// configured methods and copy throughout its hosted sign-in.
    pub async fn load_for_flow(
        conn: &mut PgConnection,
        settings: &Settings,
        flow: &Flow,
    ) -> ApiResult<FlowApp> {
        let mut fa = Self::load(conn, settings, &flow.app_id).await?;
        if let Some(id) = &flow.extras.interface_id {
            fa.apply_interface(conn, id).await?;
        }
        Ok(fa)
    }

    pub async fn apply_interface(
        &mut self,
        conn: &mut PgConnection,
        interface_id: &str,
    ) -> ApiResult<()> {
        if self.app.app_id != accounts_core::FIRST_PARTY_APP_ID {
            return Err(accounts_core::ApiError::invalid_request(
                "Interface appearance requires an Accounts sign-in.",
            ));
        }
        let config: Option<serde_json::Value> = sqlx::query_scalar(
            "select signin_config from interface_auth_clients where interface_id=$1 and active",
        )
        .bind(interface_id)
        .fetch_optional(conn)
        .await?;
        let config = config.ok_or_else(|| {
            accounts_core::ApiError::forbidden(
                "interface_disabled",
                "This interface is no longer accepting sign-ins.",
            )
        })?;
        let mut patch = serde_json::Map::new();
        for key in [
            "methods",
            "method_order",
            "copy",
            "required_fields",
            "optional_fields",
            "flow",
            "allow_signup",
            "remember_browser",
            "allowed_email_domains",
        ] {
            if let Some(value) = config.get(key) {
                patch.insert(key.into(), value.clone());
            }
        }
        self.interface_id = Some(interface_id.to_owned());
        self.config = self
            .config
            .apply_patch(
                &serde_json::Value::Object(patch),
                accounts_core::models::signin_config::ConfigSecretsPresent::default(),
            )
            .map_err(accounts_core::ApiError::validation)?;
        Ok(())
    }

    /// The Accounts app itself bypasses app policies; an Interface does not.
    pub fn bypass_account_policies(&self) -> bool {
        self.first_party() && self.interface_id.is_none()
    }

    /// An Interface can provide its own details/review pages without becoming an app.
    pub fn custom_interface_details(&self) -> bool {
        self.interface_id.is_some()
            && (!self.config.required_fields.is_empty()
                || !self.config.optional_fields.is_empty()
                || self.config.flow.is_some())
    }

    /// A first-party app (`silicon-accounts`, `developer`): no details pages, no membership.
    pub fn first_party(&self) -> bool {
        self.app.is_first_party()
    }

    /// 403 `app_disabled` when the app was disabled since the flow started.
    pub fn ensure_active(&self) -> ApiResult<()> {
        if self.app.is_active() {
            Ok(())
        } else {
            Err(apps::app_disabled(&self.app))
        }
    }

    /// The app name for messages ("Use it to sign in to Briefcase"); none for the first party.
    pub fn name_for_messages(&self) -> Option<&str> {
        (!self.first_party()).then_some(self.app.name.as_str())
    }
}

/// Loads a flow for an endpoint: Origin guard for POSTs, the flow (row-locked when `conn` is
/// a transaction and `lock` is true) and the binding cookie.
pub async fn load_bound(
    conn: &mut PgConnection,
    state: &AppState,
    headers: &HeaderMap,
    method: &Method,
    id: &str,
    lock: bool,
) -> ApiResult<Flow> {
    check_origin(&state.settings, headers, method)?;
    let flow = if lock {
        model::lock(conn, id).await?
    } else {
        model::get(conn, id).await?
    }
    .ok_or_else(|| model::flow_not_found(id))?;
    model::check_binding(state, headers, &flow)?;
    Ok(flow)
}

/// `{"flow": FlowView}` plus any cookies to set; never cached.
#[derive(Debug)]
pub struct FlowResponse {
    pub status: StatusCode,
    pub view: FlowView,
    pub cookies: Vec<Cookie<'static>>,
}

impl FlowResponse {
    pub fn ok(view: FlowView, cookies: Vec<Cookie<'static>>) -> FlowResponse {
        FlowResponse {
            status: StatusCode::OK,
            view,
            cookies,
        }
    }
}

impl IntoResponse for FlowResponse {
    fn into_response(self) -> Response {
        let mut response = (self.status, axum::Json(json!({ "flow": self.view }))).into_response();
        for c in &self.cookies {
            append_cookie(response.headers_mut(), c);
        }
        crate::util::no_store(response.headers_mut());
        response
    }
}
