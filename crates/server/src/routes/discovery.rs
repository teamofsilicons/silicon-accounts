//! Discovery documents for Silicons, apps and tools:
//!
//! - `GET /openapi.json`, `GET /v1/openapi.json`: the OpenAPI 3.1 document of the public API
//!   (`crates/server/openapi.json`, checked in and served as is; a test keeps it in step with
//!   the router).
//! - `GET /.well-known/agent.json`: the A2A agent card.
//! - `GET /v1/capabilities[?require=a,b]`: what this deployment supports (API versions, auth
//!   methods, event streaming, subscriptions, webhooks, idempotency, links, limits), and with
//!   `require` whether it supports everything a client needs (200, or 422
//!   `capabilities_missing` naming what is missing).
//!
//! All three are public, cacheable for 5 minutes and readable from any origin.

use accounts_core::http::Query;
use accounts_core::{ApiError, AppState, PRODUCT_NAME, VERSION};
use axum::extract::State;
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::middleware::version;
use crate::routes::events as stream;

/// The OpenAPI document as checked in (pretty-printed).
pub const OPENAPI_JSON: &str = include_str!("../../openapi.json");

/// The document as served: the same JSON without the indentation (about half the bytes).
static OPENAPI_COMPACT: std::sync::LazyLock<String> = std::sync::LazyLock::new(|| {
    serde_json::from_str::<Value>(OPENAPI_JSON)
        .map(|doc| doc.to_string())
        .unwrap_or_else(|_| OPENAPI_JSON.to_string())
});

/// How long discovery documents may be cached.
const CACHE: &str = "public, max-age=300";

fn cached_json(body: Value) -> Response {
    let mut r = axum::Json(body).into_response();
    r.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static(CACHE));
    r
}

/// `GET /openapi.json` and `GET /v1/openapi.json`.
pub async fn openapi() -> Response {
    let mut r = (StatusCode::OK, OPENAPI_COMPACT.as_str()).into_response();
    let h = r.headers_mut();
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static(CACHE));
    r
}

/// One capability: its name, what it is, where it lives (endpoints) and its docs page (relative
/// to the docs URL).
struct Capability {
    name: &'static str,
    description: &'static str,
    endpoints: &'static [&'static str],
    docs: &'static str,
}

/// Everything this deployment supports, by name.
const CAPABILITIES: &[Capability] = &[
    Capability {
        name: "rest_json",
        description: "A REST API over HTTPS: JSON bodies in and out, RFC 3339 timestamps.",
        endpoints: &["/v1/*"],
        docs: "reference/api",
    },
    Capability {
        name: "openapi",
        description: "An OpenAPI 3.1 document of every public endpoint.",
        endpoints: &["GET /openapi.json", "GET /v1/openapi.json"],
        docs: "reference/api",
    },
    Capability {
        name: "structured_errors",
        description: "Every error is {\"error\":{\"code\",\"message\",\"hint\",\"details\"}} with a stable code (RFC 6749 bodies on the OAuth token, revocation and introspection endpoints).",
        endpoints: &[],
        docs: "reference/errors",
    },
    Capability {
        name: "rate_limit_headers",
        description: "Over a limit the answer is 429 rate_limited with Retry-After (seconds) and details.retry_after_seconds.",
        endpoints: &[],
        docs: "reference/limits",
    },
    Capability {
        name: "idempotency_keys",
        description: "Writes accept an Idempotency-Key header: a retry with the same key replays the first answer (Idempotent-Replayed: true) and nothing runs twice.",
        endpoints: &[],
        docs: "reference/api#idempotency",
    },
    Capability {
        name: "pagination",
        description: "Lists are {\"items\",\"next_cursor\"} with ?limit= (1 to 200) and keyset ?cursor=.",
        endpoints: &[],
        docs: "reference/api#pagination",
    },
    Capability {
        name: "version_negotiation",
        description: "Pin the API version with the Accounts-Version request header; every answer says which version served it. Without the header the current version serves the request.",
        endpoints: &["GET /v1/capabilities"],
        docs: "reference/api#versions",
    },
    Capability {
        name: "capability_negotiation",
        description: "GET /v1/capabilities?require=a,b answers 200 when everything is supported, else 422 capabilities_missing naming what is missing.",
        endpoints: &["GET /v1/capabilities"],
        docs: "reference/api/service#get-v1capabilities",
    },
    Capability {
        name: "bearer_tokens",
        description: "First-party access tokens (JWT, 30 minutes) for Carbons and Silicons, no browser needed: a Silicon signs in with its si:id and STK.",
        endpoints: &[
            "POST /v1/silicons/login",
            "POST /v1/cli/login/start",
            "POST /v1/oauth/token",
        ],
        docs: "learn/tokens-and-sessions",
    },
    Capability {
        name: "client_credentials",
        description: "Apps authenticate with HTTP Basic base64(app_id:app_secret).",
        endpoints: &["/v1/apps/{app_id}/*", "/v1/proofs/*"],
        docs: "reference/api#who-can-call-what",
    },
    Capability {
        name: "oauth2",
        description: "OAuth 2.0: authorization code with PKCE S256, refresh tokens with rotation, revocation (RFC 7009) and introspection (RFC 7662).",
        endpoints: &[
            "GET /authorize",
            "POST /v1/oauth/token",
            "POST /v1/oauth/revoke",
            "POST /v1/oauth/introspect",
        ],
        docs: "reference/api/oauth",
    },
    Capability {
        name: "openid_connect",
        description: "OpenID Connect discovery, JWKS, id_tokens and userinfo.",
        endpoints: &[
            "GET /.well-known/openid-configuration",
            "GET /.well-known/jwks.json",
            "GET /v1/userinfo",
        ],
        docs: "reference/api/oauth",
    },
    Capability {
        name: "device_flow",
        description: "The OAuth device authorization grant (RFC 8628) for command-line sign-in.",
        endpoints: &["POST /v1/device/authorize", "POST /v1/oauth/token"],
        docs: "reference/api/oauth",
    },
    Capability {
        name: "short_lived_tokens",
        description: "A signed-in Carbon or Silicon gets a single-use token (2 minutes) to sign into an app without a browser.",
        endpoints: &["POST /v1/me/short-lived-tokens"],
        docs: "reference/api/silicons",
    },
    Capability {
        name: "workload_identity_federation",
        description: "A Silicon signs in from CI with no stored secret: its custodian trusts an outside OIDC issuer (GitHub Actions, GitLab, any https issuer) for tokens whose claims match exactly, and the job exchanges its token for the Silicon's session (RFC 8693 token exchange), which ends when that token expires.",
        endpoints: &[
            "POST /v1/silicons/{id}/federations",
            "GET /v1/silicons/{id}/federations",
            "DELETE /v1/silicons/{id}/federations/{federation_id}",
            "POST /v1/oauth/token",
        ],
        docs: "start/ci-and-cloud",
    },
    Capability {
        name: "identity_tokens",
        description: "A signed-in Silicon gets an RS256 OpenID Connect ID token for an outside audience its custodian allows (AWS STS, Google Cloud workload identity federation, Microsoft Entra federated credentials), so the cloud trusts the Silicon and no cloud key is stored.",
        endpoints: &[
            "POST /v1/me/identity-tokens",
            "GET /v1/silicons/{id}/identity-audiences",
            "PUT /v1/silicons/{id}/identity-audiences",
            "GET /.well-known/jwks.json",
        ],
        docs: "start/ci-and-cloud",
    },
    Capability {
        name: "proofs",
        description: "User verification and App verification proofs: hand an identity from one app to another and verify it.",
        endpoints: &[
            "POST /v1/proofs/user-verification",
            "POST /v1/proofs/app-verification",
            "POST /v1/proofs/verify",
        ],
        docs: "learn/proofs",
    },
    Capability {
        name: "webhooks",
        description: "Signed webhooks to apps (changes to their users) and to Silicons (their own account), retried for 72 hours.",
        endpoints: &["PUT /v1/apps/{app_id}/webhook", "PUT /v1/me/webhook"],
        docs: "learn/webhooks",
    },
    Capability {
        name: "webhook_signatures",
        description: "Every delivery carries X-Accounts-Signature: v1=HMAC-SHA256(secret, \"{timestamp}.{body}\").",
        endpoints: &[],
        docs: "reference/api/webhooks#the-signature",
    },
    Capability {
        name: "webhook_replay",
        description: "List deliveries with every attempt, and replay failed ones.",
        endpoints: &[
            "GET /v1/apps/{app_id}/webhook/deliveries",
            "POST /v1/apps/{app_id}/webhook/replay",
        ],
        docs: "learn/webhooks#replay",
    },
    Capability {
        name: "sse",
        description: "Event streaming with Server-Sent Events: the same events and bodies as webhooks, live, with heartbeats.",
        endpoints: &["GET /v1/events/stream"],
        docs: "learn/webhooks#streaming-events",
    },
    Capability {
        name: "stream_resume",
        description: "Resume a stream where it stopped with Last-Event-ID (or ?after=): nothing is skipped.",
        endpoints: &["GET /v1/events/stream"],
        docs: "learn/webhooks#streaming-events",
    },
    Capability {
        name: "subscriptions",
        description: "Apps create, list, update, pause and delete subscriptions: where updates go (webhook or stream) and which updates they want.",
        endpoints: &[
            "GET /v1/apps/{app_id}/subscriptions",
            "POST /v1/apps/{app_id}/subscriptions",
            "PATCH /v1/apps/{app_id}/subscriptions/{subscription_id}",
            "DELETE /v1/apps/{app_id}/subscriptions/{subscription_id}",
        ],
        docs: "learn/webhooks#subscriptions",
    },
    Capability {
        name: "imports",
        description: "Apps import their existing users from CSV or JSON as jobs with per-row results.",
        endpoints: &["POST /v1/apps/{app_id}/imports"],
        docs: "learn/imports",
    },
    Capability {
        name: "agent_card",
        description: "An A2A agent card describing this service and its skills.",
        endpoints: &["GET /.well-known/agent.json"],
        docs: "reference/api/service",
    },
    Capability {
        name: "mcp",
        description: "A Model Context Protocol server (Streamable HTTP) on the account site.",
        endpoints: &["POST /mcp"],
        docs: "reference/api/service",
    },
    Capability {
        name: "llms_txt",
        description: "Plain-text guides for language models on the account site.",
        endpoints: &["GET /llms.txt", "GET /llms-full.txt"],
        docs: "reference/api/service",
    },
];

/// Other names clients use for a capability.
const ALIASES: &[(&str, &str)] = &[
    ("event_streaming", "sse"),
    ("events_stream", "sse"),
    ("server_sent_events", "sse"),
    ("streaming", "sse"),
    ("idempotency", "idempotency_keys"),
    ("a2a", "agent_card"),
    ("webhook", "webhooks"),
    ("subscription", "subscriptions"),
    ("oauth", "oauth2"),
    ("oidc", "openid_connect"),
    ("errors", "structured_errors"),
    ("rate_limits", "rate_limit_headers"),
    ("versioning", "version_negotiation"),
    ("token_exchange", "workload_identity_federation"),
    ("trusted_publishing", "workload_identity_federation"),
    ("oidc_federation", "workload_identity_federation"),
    ("federation", "workload_identity_federation"),
    ("cloud_federation", "identity_tokens"),
    ("id_tokens_for_clouds", "identity_tokens"),
];

/// The capability a requested name means (case and `-` / `_` / `.` insensitive).
fn resolve(name: &str) -> Option<&'static str> {
    let wanted: String = name
        .trim()
        .to_ascii_lowercase()
        .chars()
        .map(|c| {
            if c == '-' || c == '.' || c == ' ' {
                '_'
            } else {
                c
            }
        })
        .collect();
    CAPABILITIES
        .iter()
        .map(|c| c.name)
        .find(|n| *n == wanted)
        .or_else(|| {
            ALIASES
                .iter()
                .find(|(alias, _)| *alias == wanted)
                .map(|(_, n)| *n)
        })
}

/// Most names one `require` may carry.
const MAX_REQUIRED: usize = 50;

#[derive(Debug, Default, Deserialize)]
pub struct CapabilitiesQuery {
    /// Comma-separated capability names.
    pub require: Option<String>,
}

fn links(state: &AppState) -> Value {
    let public = &state.settings.public_url;
    json!({
        "openapi": format!("{public}/openapi.json"),
        "agent_card": format!("{public}/.well-known/agent.json"),
        "mcp": format!("{public}/mcp"),
        "llms_txt": format!("{public}/llms.txt"),
        "llms_full_txt": format!("{public}/llms-full.txt"),
        "docs": state.settings.docs_url,
        "openid_configuration": format!("{public}/.well-known/openid-configuration"),
        "events_stream": format!("{public}/v1/events/stream"),
    })
}

/// `GET /v1/capabilities`.
pub async fn capabilities(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<CapabilitiesQuery>,
) -> Result<Response, ApiError> {
    let served = version::negotiate(&headers)?;
    let docs = state.settings.docs_url.trim_end_matches('/').to_string();
    let mut caps = Map::new();
    for c in CAPABILITIES {
        caps.insert(
            c.name.to_string(),
            json!({
                "supported": true,
                "description": c.description,
                "endpoints": c.endpoints,
                "docs": format!("{docs}/{}", c.docs),
            }),
        );
    }
    let available: Vec<&str> = CAPABILITIES.iter().map(|c| c.name).collect();
    let mut body = json!({
        "service": PRODUCT_NAME,
        "version": VERSION,
        "api_version": served,
        "api_versions": version::SUPPORTED,
        "version_header": "Accounts-Version",
        "public_url": state.settings.public_url,
        "capabilities": caps,
        "auth_methods": [
            {"name": "bearer_access_token", "description": "Authorization: Bearer <access token> issued to silicon-accounts (30 minutes). A Silicon gets one from POST /v1/silicons/login with its si:id and STK; a Carbon from the CLI code sign-in or the device flow.", "header": "Authorization"},
            {"name": "app_client_credentials", "description": "Authorization: Basic base64(app_id:app_secret), for apps.", "header": "Authorization"},
            {"name": "stk", "description": "A Silicon's STK, exchanged once for a bearer token at POST /v1/silicons/login; never sent on other requests."},
            {"name": "request_token", "description": "Authorization: Bearer sarq_..., the token a self-created Silicon got from POST /v1/silicons, for its request status and its event stream while it waits for its custodian.", "header": "Authorization"},
            {"name": "oauth2_authorization_code", "description": "Hosted sign-in for apps: authorization code with PKCE S256 at /authorize and POST /v1/oauth/token."},
            {"name": "federated_token", "description": "A Silicon trusted for an outside OIDC issuer (a CI job's token from GitHub Actions or GitLab) exchanges that token at POST /v1/oauth/token (grant_type urn:ietf:params:oauth:grant-type:token-exchange) for the Silicon's tokens; the sign-in ends when the outside token expires (at least 30 minutes, at most 12 hours). No stored secret."},
            {"name": "session_cookie", "description": "The account site's session cookie (browsers only)."}
        ],
        "limits": {
            "page_size_max": 200,
            "body_default_bytes": crate::paths::DEFAULT_BODY_LIMIT,
            "idempotency_key_max_chars": 200,
            "idempotency_retention_seconds": 86400,
            "access_token_seconds": state.settings.access_token_ttl_seconds,
            "streams_per_caller": stream::MAX_STREAMS_PER_CALLER,
            "stream_heartbeat_seconds": stream::Timing::STANDARD.heartbeat.as_secs(),
            "stream_max_seconds": stream::Timing::STANDARD.max_duration.as_secs(),
            "webhook_timeout_seconds": accounts_core::events::DELIVERY_TIMEOUT_SECONDS,
            "webhook_retry_hours": accounts_core::events::GIVE_UP_AFTER_HOURS,
        },
        "links": links(&state),
    });
    if let Some(raw) = q.require.as_deref() {
        let requested: Vec<&str> = raw
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .collect();
        if requested.is_empty()
            || requested.len() > MAX_REQUIRED
            || requested.iter().any(|r| r.len() > 64)
        {
            return Err(ApiError::bad_request(
                "invalid_query",
                format!(
                    "The query parameter 'require' must list 1 to {MAX_REQUIRED} capability names separated by commas, each at most 64 characters."
                ),
            )
            .hint("For example ?require=sse,subscriptions,webhooks. Leave it out to list every capability."));
        }
        let mut supported: Vec<&str> = Vec::new();
        let mut missing: Vec<&str> = Vec::new();
        for name in &requested {
            match resolve(name) {
                Some(n) => {
                    if !supported.contains(&n) {
                        supported.push(n);
                    }
                }
                None => {
                    if !missing.contains(name) {
                        missing.push(name);
                    }
                }
            }
        }
        if !missing.is_empty() {
            return Err(ApiError::unprocessable(
                "capabilities_missing",
                format!(
                    "Silicon Accounts does not support {}: {}.",
                    if missing.len() == 1 { "this capability" } else { "these capabilities" },
                    missing.join(", ")
                ),
            )
            .hint("Check the names against details.available (GET /v1/capabilities lists each with its docs), or go without the missing ones.")
            .detail("missing", missing)
            .detail("supported", supported)
            .detail("available", available));
        }
        body["require"] = json!({
            "requested": requested,
            "satisfied": true,
            "supported": supported,
            "missing": [],
        });
    }
    Ok(cached_json(body))
}

/// `GET /.well-known/agent.json`: the A2A agent card.
pub async fn agent_card(State(state): State<AppState>) -> Response {
    let public = state.settings.public_url.clone();
    let docs = state.settings.docs_url.clone();
    cached_json(json!({
        "protocolVersion": "0.3.0",
        "name": PRODUCT_NAME,
        "description": "Accounts for Carbons and Silicons. A Silicon makes its own account, signs into apps without a browser with a short-lived token, proves who it is to other apps, and hears about changes to its account as they happen. Apps get sign-in, verification proofs, webhooks and an event stream. Talk to it through its REST API (links.openapi) or its MCP server (links.mcp).",
        "url": public,
        "provider": {
            "organization": "Team of Silicons",
            "url": "https://teamofsilicons.com"
        },
        "version": VERSION,
        "documentationUrl": docs,
        "capabilities": {
            "streaming": true,
            "pushNotifications": true,
            "stateTransitionHistory": false
        },
        "securitySchemes": {
            "bearer": {
                "type": "http",
                "scheme": "bearer",
                "bearerFormat": "JWT",
                "description": "An access token issued to silicon-accounts. A Silicon gets one with POST /v1/silicons/login (si:id and STK)."
            },
            "app": {
                "type": "http",
                "scheme": "basic",
                "description": "An app's credentials: base64(app_id:app_secret)."
            }
        },
        "security": [{"bearer": []}, {"app": []}],
        "defaultInputModes": ["application/json"],
        "defaultOutputModes": ["application/json", "text/event-stream"],
        "skills": [
            {
                "id": "create-silicon-account",
                "name": "Create a Silicon account",
                "description": "A Silicon creates its own account (POST /v1/silicons) and names a Carbon as its custodian, or a Carbon creates one for it (POST /v1/me/silicons). The answer carries the STK, shown once.",
                "tags": ["accounts", "silicons", "signup"],
                "examples": ["Create an account for me as si:scout with c:saket as my custodian."]
            },
            {
                "id": "sign-into-app",
                "name": "Sign a Silicon into an app",
                "description": "A signed-in Silicon or Carbon gets a single-use, two-minute token for an app (POST /v1/me/short-lived-tokens); the app exchanges it for tokens of its own. No browser needed.",
                "tags": ["sign-in", "tokens", "handoff"],
                "examples": ["Sign me into briefcase."]
            },
            {
                "id": "ci-and-cloud",
                "name": "Run a Silicon in CI and the cloud",
                "description": "A CI job signs in as a Silicon with its own OIDC token (POST /v1/oauth/token, token exchange) once the custodian trusts the repository (POST /v1/silicons/{id}/federations), and the Silicon gets OIDC identity tokens for AWS, Google Cloud and Microsoft Entra (POST /v1/me/identity-tokens). No stored secret anywhere.",
                "tags": ["ci", "federation", "oidc", "cloud"],
                "examples": ["Let GitHub Actions in acme/scout sign in as si:scout.", "Give me a token for sts.amazonaws.com."]
            },
            {
                "id": "verify-proof",
                "name": "Verify a proof",
                "description": "An app checks a User verification or App verification proof another app handed it (POST /v1/proofs/verify), so an identity moves safely from one service to another.",
                "tags": ["proofs", "verification", "handoff"],
                "examples": ["Is this proof from dm valid for my app?"]
            },
            {
                "id": "manage-app-sign-in",
                "name": "Manage app sign-in",
                "description": "An app or its authors set up sign-in methods, branding, redirect URLs and the details asked for (PATCH /v1/apps/{app_id}/signin-config), and read their users.",
                "tags": ["apps", "oauth", "configuration"],
                "examples": ["Turn on email sign-in for my app and ask for a timezone."]
            },
            {
                "id": "subscribe-account-events",
                "name": "Subscribe to account events",
                "description": "Pick which account updates to receive and where: a signed webhook or the Server-Sent Events stream (POST /v1/apps/{app_id}/subscriptions, GET /v1/events/stream). A Silicon streams its own events, like its custodian's decision.",
                "tags": ["events", "webhooks", "sse", "subscriptions"],
                "examples": ["Tell me as soon as my custodian accepts.", "Send my app id and photo changes to my stream."]
            }
        ],
        "links": {
            "openapi": format!("{public}/openapi.json"),
            "capabilities": format!("{public}/v1/capabilities"),
            "llms_txt": format!("{public}/llms.txt"),
            "docs": docs,
            "mcp": format!("{public}/mcp"),
            "events_stream": format!("{public}/v1/events/stream")
        }
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_resolve_with_aliases() {
        assert_eq!(resolve("sse"), Some("sse"));
        assert_eq!(resolve(" SSE "), Some("sse"));
        assert_eq!(resolve("event-streaming"), Some("sse"));
        assert_eq!(resolve("idempotency"), Some("idempotency_keys"));
        assert_eq!(resolve("graphql"), None);
        let mut names: Vec<&str> = CAPABILITIES.iter().map(|c| c.name).collect();
        let n = names.len();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), n, "capability names are unique");
        for (alias, target) in ALIASES {
            assert!(names.contains(target), "{alias} -> {target}");
            assert!(!names.contains(alias), "{alias} is not also a name");
        }
    }

    #[test]
    fn the_openapi_document_is_json() {
        let doc: Value = serde_json::from_str(OPENAPI_JSON).expect("openapi.json parses");
        assert_eq!(doc["openapi"], "3.1.0");
    }
}
