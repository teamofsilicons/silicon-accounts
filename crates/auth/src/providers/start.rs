//! `POST /v1/flows/{id}/oauth/{provider}` → `{"authorize_url": "…"}`.

use accounts_core::crypto::{b64url, pkce, random_bytes};
use accounts_core::http::Path;
use accounts_core::models::{Method, Provider};
use accounts_core::{ApiError, ApiResult, AppState};
use axum::Json;
use axum::extract::State;
use axum::http::{HeaderMap, Method as HttpMethod};
use axum::response::{IntoResponse, Response};
use serde_json::json;

use super::{ProviderClient, callback_url, endpoints, resolve_client};
use crate::flow::model::{self, ProviderLeg, Step};
use crate::flow::{FlowApp, load_bound};
use crate::util::{encrypt_text, no_store, telemetry};

/// The `state` sent to the provider: `{flow_id}.{secret}`. The flow id finds the flow at the
/// callback (Apple's form_post carries no cookies); the secret proves the callback answers this
/// leg (only its HMAC is stored).
pub fn provider_state(flow_id: &str) -> String {
    format!("{flow_id}.{}", b64url(&random_bytes::<32>()))
}

/// Splits a provider `state` into (flow id, whole state).
pub fn flow_id_of_state(state: &str) -> Option<&str> {
    let (id, secret) = state.split_once('.')?;
    (model::is_flow_id(id) && secret.len() >= 32).then_some(id)
}

/// 404 `unknown_provider`.
pub fn unknown_provider(raw: &str) -> ApiError {
    ApiError::not_found(
        "unknown_provider",
        format!("'{raw}' is not a sign-in provider; Silicon Accounts supports google and apple."),
    )
    .hint("Use /oauth/google or /oauth/apple.")
}

/// Starts Google or Apple sign-in for a flow (flow-bound).
pub async fn start_provider(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((id, provider)): Path<(String, String)>,
) -> ApiResult<Response> {
    let provider = Provider::parse(&provider).ok_or_else(|| unknown_provider(&provider))?;
    let mut tx = state.db.begin().await?;
    let mut flow = load_bound(&mut tx, &state, &headers, &HttpMethod::POST, &id, true).await?;
    model::ensure_live(&flow)?;
    model::ensure_step(
        &flow,
        &[Step::ChooseMethod, Step::VerifyCode],
        &format!("start {} sign-in", provider.display_name()),
    )?;
    let fa = FlowApp::load(&mut tx, &state.settings, &flow.app_id).await?;
    fa.ensure_active()?;
    let (url, client) = begin_leg(&mut tx, &state, &mut flow, &fa, provider).await?;
    model::save(&mut tx, &flow).await?;
    tx.commit().await?;
    telemetry(
        &state,
        "flow.provider_started",
        Some(0.3),
        json!({"app_id": fa.app.app_id, "provider": provider.as_str(), "mode": client.mode.as_str()}),
    );
    let mut response = Json(json!({ "authorize_url": url })).into_response();
    no_store(response.headers_mut());
    Ok(response)
}

/// Starts the provider leg of `flow` (the caller saves the flow): checks the method is enabled
/// for the app, resolves its client (managed or bring-your-own), builds the provider's
/// authorize URL (state bound to the flow, nonce, PKCE S256 for Google, `form_post` for Apple)
/// and records the leg on the flow. Returns the URL and the client.
///
/// Errors: 403 `method_not_enabled`, 503 `provider_not_configured`.
pub(crate) async fn begin_leg(
    conn: &mut sqlx::PgConnection,
    state: &AppState,
    flow: &mut model::Flow,
    fa: &FlowApp,
    provider: Provider,
) -> ApiResult<(String, ProviderClient)> {
    let method = match provider {
        Provider::Google => Method::Google,
        Provider::Apple => Method::Apple,
    };
    if !fa.config.methods.is_enabled(method) {
        return Err(crate::flow::handlers::method_not_enabled(state, fa, method));
    }
    let client = resolve_client(conn, state, fa, provider).await?;
    let ep = endpoints(&state.settings, provider);
    let state_param = provider_state(&flow.id);
    let nonce = b64url(&random_bytes::<32>());
    let redirect_uri = callback_url(&state.settings, provider);

    let mut url = url::Url::parse(&ep.auth_url).map_err(|e| {
        ApiError::internal(format!(
            "{} authorize URL is not a URL: {e}",
            provider.display_name()
        ))
    })?;
    let mut verifier_enc = None;
    {
        let mut q = url.query_pairs_mut();
        q.append_pair("client_id", &client.client_id);
        q.append_pair("redirect_uri", &redirect_uri);
        q.append_pair("response_type", "code");
        q.append_pair("state", &state_param);
        q.append_pair("nonce", &nonce);
        match provider {
            Provider::Google => {
                let verifier = b64url(&random_bytes::<32>());
                q.append_pair("scope", "openid email profile");
                q.append_pair("code_challenge", &pkce::s256_challenge(&verifier));
                q.append_pair("code_challenge_method", "S256");
                if let Some(p) = &fa.config.google.prompt {
                    q.append_pair("prompt", p);
                }
                if let Some(hd) = &fa.config.google.hosted_domain {
                    q.append_pair("hd", hd);
                }
                if let Some(hint) = &flow.login_hint {
                    q.append_pair("login_hint", hint);
                }
                verifier_enc = Some(encrypt_text(&state.keys.keyring, &verifier)?);
            }
            Provider::Apple => {
                q.append_pair("response_mode", "form_post");
                q.append_pair("scope", "name email");
            }
        }
    }

    flow.reset_to_choose_method();
    flow.extras.error = None;
    flow.extras.provider = Some(ProviderLeg {
        provider,
        state_hash: b64url(&state.keys.pepper.hash(&state_param)),
        nonce,
        pkce_verifier_enc: verifier_enc,
        client_mode: client.mode,
        client_id: client.client_id.clone(),
        parked: None,
    });
    Ok((url.to_string(), client))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_state_round_trip() {
        let s = provider_state("abcDEF123_-xyz");
        assert_eq!(flow_id_of_state(&s), Some("abcDEF123_-xyz"));
        assert_eq!(flow_id_of_state("nodot"), None);
        assert_eq!(flow_id_of_state("a.short"), None);
        assert_eq!(
            flow_id_of_state("../x.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
            None
        );
    }
}
