//! Connecting Google or Apple to a signed-in Carbon (the account site's "Connect Google"):
//! `POST /v1/me/identities/{provider}` → `201 {"authorize_url","flow_id","provider","expires_at"}`.
//!
//! The browser navigates to `authorize_url`. The provider sends it back to the usual callback
//! (`/v1/oauth/callback/{provider}`), which, for this flow, doesn't sign anyone in: it connects
//! the provider account to the Carbon that asked and adds the provider's verified email to it
//! without a code (UNDERSTANDING.md: an email added via Google or Apple needs no extra
//! verification), then redirects to `return_to` with `?linked={provider}&email_added=true|false`,
//! or `?link_error={code}&provider={provider}&flow={flow_id}` (the flow, `GET /v1/flows/{id}`,
//! carries the precise message and hint).
//!
//! Browser only: the request authenticates with the session cookie (and the CSRF Origin guard),
//! and the answer is accepted only from the same browser (the flow's `sa_flow` binding cookie)
//! while it is still signed in as the same Carbon. Refusals: the provider account is connected
//! to another account (`identity_in_use`), its email belongs to another account
//! (`email_in_use`), the account has 10 emails (`email_limit_reached`), the address isn't
//! verified by the provider (`email_not_verified`), the browser's session changed
//! (`session_changed`).

use accounts_core::crypto::{prefix, random_token};
use accounts_core::http::cookies::flow_cookie;
use accounts_core::http::{AuthVia, CarbonAuth, Path};
use accounts_core::models::{Method, Provider, Scope};
use accounts_core::repo::rate_limit::{self, Limit};
use accounts_core::timefmt::format_rfc3339_ms;
use accounts_core::{ApiError, ApiResult, AppState, FIRST_PARTY_APP_ID, FieldErrors, Settings};
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::json;

use crate::flow::FlowApp;
use crate::flow::model::{self, LinkIntent, NewFlow, Prompt};
use crate::providers::start::{begin_leg, unknown_provider};
use crate::util::{no_store, telemetry};

/// Connections a Carbon may start per hour (each one opens a provider sign-in).
pub const LINKS_PER_ACCOUNT: Limit = Limit::new(30, 3600);

/// Where the browser returns when the request names no `return_to`.
pub const DEFAULT_RETURN_PATH: &str = "/sign-in-methods";

/// `POST /v1/me/identities/{provider}` body (optional).
#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct LinkBody {
    /// A path on the account site (`/sign-in-methods`) or a URL on its origin.
    pub return_to: Option<String>,
}

/// The body is optional: empty, or a JSON object.
fn parse_body(raw: &[u8]) -> ApiResult<LinkBody> {
    if raw.iter().all(u8::is_ascii_whitespace) {
        return Ok(LinkBody::default());
    }
    serde_json::from_slice(raw).map_err(|e| {
        ApiError::bad_request(
            "invalid_json",
            format!(
                "The body must be a JSON object like {{\"return_to\":\"{DEFAULT_RETURN_PATH}\"}} (or empty): {e}."
            ),
        )
        .hint("Send {} or leave the body out to come back to the sign-in methods page.")
    })
}

/// The absolute URL to come back to: a path on the public origin, or a URL whose origin is the
/// public origin (or an extra allowed origin). 422 otherwise.
fn return_url(settings: &Settings, raw: Option<&str>) -> ApiResult<String> {
    let raw = raw.map(str::trim).filter(|r| !r.is_empty());
    let candidate = match raw {
        None => settings.url(DEFAULT_RETURN_PATH),
        Some(r) if r.starts_with('/') && !r.starts_with("//") && !r.contains('\\') => {
            settings.url(r)
        }
        Some(r) => r.to_string(),
    };
    let ok = candidate.len() <= 2048
        && !candidate.chars().any(char::is_control)
        && accounts_core::models::first_party_redirect_allowed(settings, &candidate);
    if ok {
        return Ok(candidate);
    }
    let mut f = FieldErrors::new();
    f.add(
        "return_to",
        format!(
            "must be a path on the account site (like {DEFAULT_RETURN_PATH}) or a URL on {}, without a #fragment",
            settings.public_origin
        ),
    );
    Err(ApiError::validation(f))
}

/// `POST /v1/me/identities/{provider}` (Carbon, browser session): starts connecting Google or
/// Apple to the signed-in Carbon. Sets the `sa_flow` binding cookie (the answer is only
/// accepted in this browser) and returns the provider's authorize URL to navigate to.
pub async fn start_link(
    State(state): State<AppState>,
    me: CarbonAuth,
    headers: HeaderMap,
    Path(provider): Path<String>,
    body: Bytes,
) -> ApiResult<Response> {
    let provider = Provider::parse(&provider).ok_or_else(|| unknown_provider(&provider))?;
    let name = provider.display_name();
    if !matches!(me.via, AuthVia::Session { .. }) {
        return Err(ApiError::bad_request(
            "browser_session_required",
            format!(
                "Connecting {name} happens in a browser: the provider sends that browser back, signed in as you. This request used an access token, not the account site's session."
            ),
        )
        .hint(format!(
            "Open the account site's sign-in methods page and choose Connect {name}."
        )));
    }
    let body = parse_body(&body)?;
    let return_to = return_url(&state.settings, body.return_to.as_deref())?;
    let mut tx = state.db.begin().await?;
    rate_limit::enforce(
        &mut tx,
        &rate_limit::bucket("identity_link:account", me.uuid()),
        LINKS_PER_ACCOUNT,
        "provider connections started by this account",
    )
    .await?;
    let fa = FlowApp::load(&mut tx, &state.settings, FIRST_PARTY_APP_ID).await?;
    let method = match provider {
        Provider::Google => Method::Google,
        Provider::Apple => Method::Apple,
    };
    // Reuse the browser's flow cookie so other open sign-ins stay bound to it.
    let binding = model::binding_cookie(&headers, &state.settings)
        .filter(|t| t.len() == prefix::FLOW.len() + 43)
        .unwrap_or_else(|| random_token(prefix::FLOW));
    let id = model::new_flow_id();
    let mut flow = model::insert(
        &mut tx,
        &NewFlow {
            id: &id,
            binding_hash: &state.keys.pepper.hash(&binding),
            app_id: FIRST_PARTY_APP_ID,
            redirect_uri: &return_to,
            state: None,
            code_challenge: None,
            code_challenge_method: None,
            nonce: None,
            requested_scopes: &[Scope::Profile],
            prompt: Prompt::default(),
            method_hint: Some(method),
        },
    )
    .await?;
    flow.extras.link = Some(LinkIntent {
        account_uuid: me.uuid().to_string(),
        return_to: return_to.clone(),
    });
    let (authorize_url, client) = begin_leg(&mut tx, &state, &mut flow, &fa, provider).await?;
    model::save(&mut tx, &flow).await?;
    tx.commit().await?;
    telemetry(
        &state,
        "identity.link_started",
        Some(0.2),
        json!({"provider": provider.as_str(), "mode": client.mode.as_str()}),
    );
    let mut response = (
        StatusCode::CREATED,
        axum::Json(json!({
            "authorize_url": authorize_url,
            "flow_id": flow.id,
            "provider": provider.as_str(),
            "expires_at": format_rfc3339_ms(flow.expires_at),
        })),
    )
        .into_response();
    accounts_core::http::cookies::append_cookie(
        response.headers_mut(),
        &flow_cookie(&state.settings, &binding),
    );
    no_store(response.headers_mut());
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn return_to_stays_on_the_site() {
        let settings = Settings::for_tests();
        let site = |p: &str| format!("{}{p}", settings.public_url);
        assert_eq!(
            return_url(&settings, None).expect("default"),
            site("/sign-in-methods")
        );
        assert_eq!(
            return_url(&settings, Some(" /settings?tab=1 ")).expect("path"),
            site("/settings?tab=1")
        );
        assert_eq!(
            return_url(&settings, Some(&site("/sign-in-methods"))).expect("url"),
            site("/sign-in-methods")
        );
        for bad in [
            "//evil.example/x",
            "/\\evil.example",
            "https://evil.example/",
            "javascript:alert(1)",
            "/x#frag",
        ] {
            let e = return_url(&settings, Some(bad)).expect_err(bad);
            assert_eq!(e.code, "validation_failed", "{bad}");
        }
    }
}
