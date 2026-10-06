//! An in-process stand-in for Google and Apple: token endpoints and JWKS, as strict as the
//! real ones about what Silicon Accounts sends (client authentication, redirect_uri, PKCE
//! S256 for Google, the ES256 client secret JWT for Apple). The authorize step is played by
//! the test: [`MockOidc::authorize`] reads the authorize URL Silicon Accounts built and issues
//! a code bound to its client, redirect_uri, nonce and PKCE challenge.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use accounts_core::Settings;
use accounts_core::secrecy::SecretString;
use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde_json::{Value, json};

pub const RSA_PRIVATE: &str = include_str!("../fixtures/rsa_test_private.pem");
pub const RSA_N: &str = include_str!("../fixtures/rsa_test_n.txt");
pub const RSA_OTHER_PRIVATE: &str = include_str!("../fixtures/rsa_other_private.pem");
pub const EC_PRIVATE: &str = include_str!("../fixtures/ec_test_private.pem");
pub const EC_PUBLIC: &str = include_str!("../fixtures/ec_test_public.pem");

pub const MANAGED_GOOGLE_ID: &str = "managed-google.apps.googleusercontent.com";
pub const MANAGED_GOOGLE_SECRET: &str = "GOCSPX-managed-secret";
pub const MANAGED_APPLE_ID: &str = "com.teamofsilicons.accounts.test";
pub const MANAGED_APPLE_TEAM: &str = "TEAMMANAGE";
pub const MANAGED_APPLE_KID: &str = "KEYMANAGED";

/// A code issued at "authorize".
#[derive(Debug, Clone)]
pub struct Grant {
    pub provider: String,
    pub client_id: String,
    pub redirect_uri: String,
    pub nonce: Option<String>,
    pub challenge: Option<String>,
    pub identity: Value,
    pub used: bool,
}

#[derive(Debug, Default)]
pub struct Inner {
    /// Google clients: id → secret.
    pub google_clients: HashMap<String, String>,
    /// Apple clients: services id → (team id, key id).
    pub apple_clients: HashMap<String, (String, String)>,
    pub grants: HashMap<String, Grant>,
    /// Every token request: {provider, client_id, auth, status}.
    pub token_requests: Vec<Value>,
    /// The next token request fails with this status and body.
    pub fail_next: Option<(u16, Value)>,
    /// Claims merged into the next id_token (null removes a claim).
    pub tamper_next: Option<Value>,
    /// Sign the next id_token with a key that is not in the JWKS.
    pub wrong_key_next: bool,
    pub seq: u64,
}

pub struct MockOidc {
    pub base: String,
    pub inner: Arc<Mutex<Inner>>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for MockOidc {
    fn drop(&mut self) {
        self.task.abort();
    }
}

type Shared = Arc<Mutex<(String, Arc<Mutex<Inner>>)>>;

impl MockOidc {
    /// Starts the mock on a free port with the managed clients registered.
    pub async fn start() -> MockOidc {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind mock");
        let base = format!("http://{}", listener.local_addr().expect("addr"));
        let inner = Arc::new(Mutex::new(Inner::default()));
        {
            let mut i = inner.lock().expect("lock");
            i.google_clients
                .insert(MANAGED_GOOGLE_ID.into(), MANAGED_GOOGLE_SECRET.into());
            i.apple_clients.insert(
                MANAGED_APPLE_ID.into(),
                (MANAGED_APPLE_TEAM.into(), MANAGED_APPLE_KID.into()),
            );
        }
        let shared: Shared = Arc::new(Mutex::new((base.clone(), inner.clone())));
        let app = Router::new()
            .route("/{provider}/token", post(token))
            .route("/{provider}/jwks", get(jwks))
            .with_state(shared);
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        MockOidc { base, inner, task }
    }

    /// Points settings at this mock with managed Google and Apple credentials.
    pub fn configure(&self, s: &mut Settings) {
        s.google.client_id = Some(MANAGED_GOOGLE_ID.into());
        s.google.client_secret = Some(SecretString::from(MANAGED_GOOGLE_SECRET));
        s.google.auth_url = format!("{}/google/authorize", self.base);
        s.google.token_url = format!("{}/google/token", self.base);
        s.google.jwks_url = format!("{}/google/jwks", self.base);
        s.google.issuers = vec![format!("{}/google", self.base)];
        s.apple.services_id = Some(MANAGED_APPLE_ID.into());
        s.apple.team_id = Some(MANAGED_APPLE_TEAM.into());
        s.apple.key_id = Some(MANAGED_APPLE_KID.into());
        s.apple.private_key = Some(SecretString::from(EC_PRIVATE));
        s.apple.auth_url = format!("{}/apple/authorize", self.base);
        s.apple.token_url = format!("{}/apple/token", self.base);
        s.apple.jwks_url = format!("{}/apple/jwks", self.base);
        s.apple.issuer = format!("{}/apple", self.base);
    }

    pub fn register_google(&self, client_id: &str, secret: &str) {
        self.lock()
            .google_clients
            .insert(client_id.into(), secret.into());
    }

    pub fn register_apple(&self, services_id: &str, team_id: &str, key_id: &str) {
        self.lock()
            .apple_clients
            .insert(services_id.into(), (team_id.into(), key_id.into()));
    }

    pub fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().expect("mock lock")
    }

    /// Plays the provider's authorize page: checks what Silicon Accounts sent, issues a code
    /// for `identity` and returns (code, state). Panics with a precise message on a bad URL.
    pub fn authorize(&self, authorize_url: &str, identity: Value) -> (String, String) {
        let u = url::Url::parse(authorize_url).expect("authorize URL");
        let q: HashMap<String, String> = u
            .query_pairs()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        let provider = if u.path().starts_with("/google") {
            "google"
        } else {
            "apple"
        };
        let client_id = q.get("client_id").expect("client_id").clone();
        assert_eq!(q.get("response_type").map(String::as_str), Some("code"));
        assert!(q.contains_key("state"), "state is required");
        assert!(q.contains_key("nonce"), "nonce is required");
        if provider == "google" {
            assert!(
                self.lock().google_clients.contains_key(&client_id),
                "unknown Google client {client_id}"
            );
            assert!(
                q.get("scope")
                    .is_some_and(|s| s.split(' ').any(|p| p == "openid"))
            );
            assert_eq!(
                q.get("code_challenge_method").map(String::as_str),
                Some("S256")
            );
            assert!(q.contains_key("code_challenge"));
        } else {
            assert!(
                self.lock().apple_clients.contains_key(&client_id),
                "unknown Apple client {client_id}"
            );
            assert_eq!(
                q.get("response_mode").map(String::as_str),
                Some("form_post")
            );
            assert_eq!(q.get("scope").map(String::as_str), Some("name email"));
        }
        let mut inner = self.lock();
        inner.seq += 1;
        let code = format!("4/mock-{provider}-{}", inner.seq);
        inner.grants.insert(
            code.clone(),
            Grant {
                provider: provider.into(),
                client_id,
                redirect_uri: q.get("redirect_uri").cloned().unwrap_or_default(),
                nonce: q.get("nonce").cloned(),
                challenge: q.get("code_challenge").cloned(),
                identity,
                used: false,
            },
        );
        (code, q.get("state").cloned().unwrap_or_default())
    }

    pub fn token_requests(&self) -> Vec<Value> {
        self.lock().token_requests.clone()
    }
}

fn oauth_error(status: StatusCode, error: &str, description: &str) -> Response {
    (
        status,
        axum::Json(json!({"error": error, "error_description": description})),
    )
        .into_response()
}

async fn jwks(Path(_provider): Path<String>) -> Response {
    axum::Json(json!({"keys": [
        {"kty": "RSA", "kid": "mock-rsa", "alg": "RS256", "use": "sig", "n": RSA_N.trim(), "e": "AQAB"}
    ]}))
    .into_response()
}

async fn token(
    State(shared): State<Shared>,
    Path(provider): Path<String>,
    body: Bytes,
) -> Response {
    let (base, inner) = {
        let s = shared.lock().expect("lock");
        (s.0.clone(), s.1.clone())
    };
    let form: HashMap<String, String> = serde_urlencoded::from_bytes(&body).unwrap_or_default();
    let mut inner = inner.lock().expect("lock");
    let client_id = form.get("client_id").cloned().unwrap_or_default();
    inner
        .token_requests
        .push(json!({"provider": provider, "client_id": client_id}));
    if let Some((status, body)) = inner.fail_next.take() {
        return (
            StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_REQUEST),
            axum::Json(body),
        )
            .into_response();
    }
    if form.get("grant_type").map(String::as_str) != Some("authorization_code") {
        return oauth_error(
            StatusCode::BAD_REQUEST,
            "unsupported_grant_type",
            "grant_type must be authorization_code",
        );
    }
    // Client authentication.
    if provider == "google" {
        match (
            inner.google_clients.get(&client_id),
            form.get("client_secret"),
        ) {
            (Some(expected), Some(got)) if expected == got => {}
            _ => {
                return oauth_error(
                    StatusCode::UNAUTHORIZED,
                    "invalid_client",
                    "client_secret is wrong or missing",
                );
            }
        }
    } else {
        let Some((team, kid)) = inner.apple_clients.get(&client_id).cloned() else {
            return oauth_error(
                StatusCode::BAD_REQUEST,
                "invalid_client",
                "unknown services id",
            );
        };
        let Some(secret) = form.get("client_secret") else {
            return oauth_error(
                StatusCode::BAD_REQUEST,
                "invalid_client",
                "client_secret is missing",
            );
        };
        let header = match jsonwebtoken::decode_header(secret) {
            Ok(h) => h,
            Err(_) => {
                return oauth_error(
                    StatusCode::BAD_REQUEST,
                    "invalid_client",
                    "client_secret is not a JWT",
                );
            }
        };
        if header.alg != Algorithm::ES256 || header.kid.as_deref() != Some(kid.as_str()) {
            return oauth_error(
                StatusCode::BAD_REQUEST,
                "invalid_client",
                "client_secret must be ES256 with the registered kid",
            );
        }
        let mut v = Validation::new(Algorithm::ES256);
        v.set_audience(&[format!("{base}/apple")]);
        v.set_issuer(&[team]);
        v.sub = Some(client_id.clone());
        v.set_required_spec_claims(&["exp", "iss", "aud", "sub"]);
        let key = DecodingKey::from_ec_pem(EC_PUBLIC.as_bytes()).expect("ec public");
        if let Err(e) = jsonwebtoken::decode::<Value>(secret, &key, &v) {
            return oauth_error(
                StatusCode::BAD_REQUEST,
                "invalid_client",
                &format!("client_secret refused: {e}"),
            );
        }
    }
    // The code.
    let code = form.get("code").cloned().unwrap_or_default();
    let Some(grant) = inner.grants.get_mut(&code) else {
        return oauth_error(StatusCode::BAD_REQUEST, "invalid_grant", "unknown code");
    };
    if grant.used || grant.provider != provider || grant.client_id != client_id {
        return oauth_error(
            StatusCode::BAD_REQUEST,
            "invalid_grant",
            "code already used or issued to another client",
        );
    }
    if form.get("redirect_uri") != Some(&grant.redirect_uri) {
        return oauth_error(
            StatusCode::BAD_REQUEST,
            "invalid_grant",
            "redirect_uri mismatch",
        );
    }
    if let Some(challenge) = &grant.challenge {
        let ok = form
            .get("code_verifier")
            .is_some_and(|v| accounts_core::crypto::pkce::s256_challenge(v) == *challenge);
        if !ok {
            return oauth_error(
                StatusCode::BAD_REQUEST,
                "invalid_grant",
                "PKCE verification failed",
            );
        }
    }
    grant.used = true;
    let grant = grant.clone();
    let now = jsonwebtoken::get_current_timestamp() as i64;
    let id = &grant.identity;
    let mut claims = json!({
        "iss": format!("{base}/{provider}"),
        "aud": grant.client_id,
        "sub": id["sub"],
        "iat": now,
        "exp": now + 600,
    });
    if let Some(n) = &grant.nonce {
        claims["nonce"] = json!(n);
    }
    if let Some(e) = id.get("email") {
        claims["email"] = e.clone();
        let verified = id
            .get("email_verified")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        claims["email_verified"] = if provider == "apple" {
            json!(verified.to_string())
        } else {
            json!(verified)
        };
    }
    if provider == "google" {
        for k in ["name", "given_name", "family_name", "picture", "hd"] {
            if let Some(v) = id.get(k) {
                claims[k] = v.clone();
            }
        }
    }
    if let Some(over) = inner.tamper_next.take()
        && let (Some(c), Some(o)) = (claims.as_object_mut(), over.as_object())
    {
        for (k, v) in o {
            if v.is_null() {
                c.remove(k);
            } else {
                c.insert(k.clone(), v.clone());
            }
        }
    }
    let pem = if std::mem::take(&mut inner.wrong_key_next) {
        RSA_OTHER_PRIVATE
    } else {
        RSA_PRIVATE
    };
    let mut h = Header::new(Algorithm::RS256);
    h.kid = Some("mock-rsa".into());
    let id_token = jsonwebtoken::encode(
        &h,
        &claims,
        &EncodingKey::from_rsa_pem(pem.as_bytes()).expect("rsa"),
    )
    .expect("sign id_token");
    axum::Json(json!({"access_token": "mock-access", "token_type": "Bearer", "expires_in": 3600, "id_token": id_token}))
        .into_response()
}
