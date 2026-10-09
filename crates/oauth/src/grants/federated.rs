//! `grant_type=urn:ietf:params:oauth:grant-type:token-exchange` (RFC 8693): a Silicon signs
//! into Silicon Accounts with an outside OpenID Connect token it is trusted for, such as a
//! GitHub Actions or GitLab CI job's token (workload identity federation, see core's
//! `federation`).
//!
//! Parameters: `subject_token` (the outside JWT), `subject_token_type`
//! (`urn:ietf:params:oauth:token-type:jwt` or `…:id_token`), `silicon` (its si:id or uuid),
//! optionally `requested_token_type` (only `…:access_token`) and `client_id=silicon-accounts`
//! (the default). The answer is the usual first-party token response plus `issued_token_type`
//! `…:access_token`; the sign-in ends when the outside token expires (at least 30 minutes, at
//! most 12 hours), and its refresh tokens stop with it.

use accounts_core::federation::{self, ExchangeRequest, TOKEN_TYPE_ID_TOKEN, TOKEN_TYPE_JWT};
use accounts_core::http::ClientMeta;
use accounts_core::repo::tokens::ACCESS_TOKEN_TYPE;
use accounts_core::views::TokenExchangeResponse;
use accounts_core::{AppState, OAuthError};
use axum::http::StatusCode;

use crate::params::opt;
use crate::token::{TOKEN_EXCHANGE_GRANT_TYPE, TokenParams, Trace};

/// Exchanges a trusted outside token for the Silicon's access token.
pub(crate) async fn exchange(
    state: &AppState,
    params: &TokenParams,
    meta: &ClientMeta,
    trace: &mut Trace,
) -> Result<TokenExchangeResponse, OAuthError> {
    if opt(params.actor_token.as_deref()).is_some() {
        return Err(OAuthError::invalid_request(
            "actor_token is not supported: a token exchange here signs the Silicon itself in, nobody acts for it. To act for an account at another app, get a User verification proof (POST /v1/proofs/user-verification).",
        ));
    }
    let subject_token = opt(params.subject_token.as_deref()).ok_or_else(|| {
        OAuthError::invalid_request(format!(
            "subject_token is required for grant_type={TOKEN_EXCHANGE_GRANT_TYPE}: the OIDC token your CI gives the job (on GitHub Actions, from ACTIONS_ID_TOKEN_REQUEST_URL)."
        ))
    })?;
    match opt(params.subject_token_type.as_deref()) {
        Some(TOKEN_TYPE_JWT | TOKEN_TYPE_ID_TOKEN) => {}
        Some(other) if other.ends_with(":access_token") || other.ends_with(":refresh_token") => {
            return Err(OAuthError::invalid_request(format!(
                "subject_token_type '{other}' is not accepted: a token exchange here takes an outside OIDC token ({TOKEN_TYPE_JWT} or {TOKEN_TYPE_ID_TOKEN}). To act for an account at another app, get a User verification proof (POST /v1/proofs/user-verification) with the account's access token."
            )));
        }
        Some(other) => {
            return Err(OAuthError::invalid_request(format!(
                "subject_token_type '{other}' is not accepted; send {TOKEN_TYPE_JWT} or {TOKEN_TYPE_ID_TOKEN}."
            )));
        }
        None => {
            return Err(OAuthError::invalid_request(format!(
                "subject_token_type is required: send {TOKEN_TYPE_JWT} (or {TOKEN_TYPE_ID_TOKEN}) for the OIDC token from your CI."
            )));
        }
    }
    if let Some(requested) = opt(params.requested_token_type.as_deref())
        && requested != ACCESS_TOKEN_TYPE
    {
        return Err(OAuthError::invalid_request(format!(
            "requested_token_type '{requested}' can't be issued: a trusted outside token is exchanged for the Silicon's access token ({ACCESS_TOKEN_TYPE}); leave requested_token_type out or send that."
        )));
    }
    let silicon = opt(params.silicon.as_deref()).ok_or_else(|| {
        OAuthError::invalid_request(
            "silicon is required: the si:id (or uuid) of the Silicon whose trust this token matches, e.g. silicon=si:scout.",
        )
    })?;
    federation::sign_in(
        state,
        meta,
        ExchangeRequest {
            silicon,
            subject_token,
        },
    )
    .await
    .map_err(|e| {
        if e.is_server_error() {
            return OAuthError::server_error(e.message);
        }
        let hint = e
            .hint
            .as_deref()
            .map(|h| format!(" {h}"))
            .unwrap_or_default();
        if e.status == StatusCode::TOO_MANY_REQUESTS {
            trace.retry_after = e.retry_after;
            return OAuthError::new(
                StatusCode::TOO_MANY_REQUESTS,
                "rate_limited",
                format!("{}{hint}", e.message),
            );
        }
        let code = e.code.to_string();
        OAuthError::invalid_grant(format!("{} ({code}){hint}", e.message))
    })
}
