//! OIDC discovery (`/.well-known/openid-configuration`) and the JWKS (`/.well-known/jwks.json`).
//!
//! The issuer is `ACCOUNTS_PUBLIC_URL`; every endpoint is absolute on it. Access tokens and
//! `id_tokens` are `EdDSA` (Ed25519) JWTs whose `kid` names the key in the JWKS. Both documents are
//! public and may be cached for 5 minutes (CORS `*` comes from the server's middleware).

use accounts_core::AppState;
use accounts_core::models::Scope;
use axum::extract::State;
use axum::response::Response;
use serde_json::{Value, json};

use crate::respond::cacheable;
use crate::token::{DEVICE_CODE_GRANT_TYPE, SLT_GRANT_TYPE};

/// Seconds clients may cache discovery and the JWKS.
const CACHE_SECONDS: u32 = 300;

/// `GET /.well-known/openid-configuration`.
pub(crate) async fn openid_configuration(State(state): State<AppState>) -> Response {
    cacheable(&document(&state), CACHE_SECONDS)
}

/// `GET /.well-known/jwks.json`.
pub(crate) async fn jwks(State(state): State<AppState>) -> Response {
    cacheable(&state.keys.jwt.jwks(), CACHE_SECONDS)
}

/// The discovery document.
fn document(state: &AppState) -> Value {
    let s = &state.settings;
    let client_auth = ["client_secret_basic", "client_secret_post"];
    json!({
        "issuer": s.issuer(),
        "authorization_endpoint": s.url("/authorize"),
        "token_endpoint": s.url("/v1/oauth/token"),
        "userinfo_endpoint": s.url("/v1/userinfo"),
        "jwks_uri": s.url("/.well-known/jwks.json"),
        "revocation_endpoint": s.url("/v1/oauth/revoke"),
        "introspection_endpoint": s.url("/v1/oauth/introspect"),
        "device_authorization_endpoint": s.url("/v1/device/authorize"),
        "service_documentation": s.docs_url,
        "response_types_supported": ["code"],
        "response_modes_supported": ["query"],
        "grant_types_supported": [
            "authorization_code",
            "refresh_token",
            DEVICE_CODE_GRANT_TYPE,
            SLT_GRANT_TYPE,
        ],
        "subject_types_supported": ["public"],
        "id_token_signing_alg_values_supported": ["EdDSA"],
        "scopes_supported": Scope::ALL.iter().map(Scope::as_str).collect::<Vec<_>>(),
        "claims_supported": [
            "iss", "sub", "aud", "exp", "iat", "auth_time", "nonce",
            "name", "picture", "preferred_username",
            "email", "email_verified", "phone_number", "phone_number_verified",
            "zoneinfo", "birthdate",
        ],
        "token_endpoint_auth_methods_supported": client_auth,
        "revocation_endpoint_auth_methods_supported": client_auth,
        "introspection_endpoint_auth_methods_supported": client_auth,
        "code_challenge_methods_supported": ["S256", "plain"],
        "prompt_values_supported": ["none", "login", "consent", "select_account"],
        "claims_parameter_supported": false,
        "request_parameter_supported": false,
        "request_uri_parameter_supported": false,
    })
}
