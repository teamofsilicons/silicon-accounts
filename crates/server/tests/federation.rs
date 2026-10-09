//! Workload identity federation against a mock OIDC issuer on a loopback port (the test-only
//! ACCOUNTS_FEDERATION_ALLOW_LOOPBACK): a custodian trusts the issuer for tokens whose claims
//! match, a CI job exchanges its token at the token endpoint (RFC 8693) for the Silicon's
//! access token, and every refusal: wrong audience, wrong claim, expired, replayed jti, unknown
//! key, removed trust, private-address issuer.

use std::sync::{Arc, Mutex};

use accounts_core::test_support::{Req, Resp, TestContext, call, test_settings};
use axum::routing::get;
use base64::Engine as _;
use jsonwebtoken::{Algorithm, EncodingKey, Header};
use p256::elliptic_curve::sec1::ToEncodedPoint;
use p256::pkcs8::EncodePrivateKey;
use rsa::pkcs8::DecodePrivateKey;
use rsa::traits::PublicKeyParts;
use serde_json::{Value, json};

const EXCHANGE: &str = "urn:ietf:params:oauth:grant-type:token-exchange";
const JWT_TYPE: &str = "urn:ietf:params:oauth:token-type:jwt";
const RSA_PEM: &str = include_str!("fixtures/mock-issuer-rsa.pem");

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn now() -> i64 {
    time::OffsetDateTime::now_utc().unix_timestamp()
}

/// A signing key of the mock issuer and its public JWK.
struct IssuerKey {
    kid: String,
    alg: Algorithm,
    encoding: EncodingKey,
    jwk: Value,
}

fn ec_key(seed: u8, kid: &str) -> IssuerKey {
    let secret = p256::SecretKey::from_slice(&[seed; 32]).expect("p256 key");
    let der = secret.to_pkcs8_der().expect("pkcs8");
    let point = secret.public_key().to_encoded_point(false);
    IssuerKey {
        kid: kid.into(),
        alg: Algorithm::ES256,
        encoding: EncodingKey::from_ec_der(der.as_bytes()),
        jwk: json!({
            "kty": "EC", "crv": "P-256", "kid": kid, "use": "sig", "alg": "ES256",
            "x": b64(point.x().expect("x")), "y": b64(point.y().expect("y")),
        }),
    }
}

fn rsa_key(kid: &str) -> IssuerKey {
    let key = rsa::RsaPrivateKey::from_pkcs8_pem(RSA_PEM).expect("rsa pem");
    let public = key.to_public_key();
    IssuerKey {
        kid: kid.into(),
        alg: Algorithm::RS256,
        encoding: EncodingKey::from_rsa_pem(RSA_PEM.as_bytes()).expect("rsa encoding"),
        jwk: json!({
            "kty": "RSA", "kid": kid, "use": "sig", "alg": "RS256",
            "n": b64(&public.n().to_bytes_be()), "e": b64(&public.e().to_bytes_be()),
        }),
    }
}

/// A mock OIDC issuer: discovery and a JWKS whose keys a test can change.
struct MockIssuer {
    url: String,
    keys: Arc<Mutex<Vec<Value>>>,
    fetches: Arc<Mutex<u32>>,
}

impl MockIssuer {
    async fn start() -> MockIssuer {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let url = format!("http://{}", listener.local_addr().expect("addr"));
        let keys: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
        let fetches = Arc::new(Mutex::new(0u32));
        let (doc_url, jwks_keys, jwks_fetches) = (url.clone(), keys.clone(), fetches.clone());
        let app = axum::Router::new()
            .route(
                "/.well-known/openid-configuration",
                get(move || {
                    let url = doc_url.clone();
                    async move {
                        axum::Json(json!({
                            "issuer": url,
                            "jwks_uri": format!("{url}/jwks"),
                            "response_types_supported": ["id_token"],
                            "subject_types_supported": ["public"],
                            "id_token_signing_alg_values_supported": ["RS256", "ES256"],
                        }))
                    }
                }),
            )
            .route(
                "/jwks",
                get(move || {
                    let keys = jwks_keys.clone();
                    let fetches = jwks_fetches.clone();
                    async move {
                        *fetches.lock().expect("lock") += 1;
                        let keys = keys.lock().expect("lock").clone();
                        axum::Json(json!({ "keys": keys }))
                    }
                }),
            );
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        MockIssuer { url, keys, fetches }
    }

    fn publish(&self, key: &IssuerKey) {
        self.keys.lock().expect("lock").push(key.jwk.clone());
    }

    fn fetches(&self) -> u32 {
        *self.fetches.lock().expect("lock")
    }

    /// A token like a CI job gets: GitHub-style claims, overridable.
    fn token(&self, key: &IssuerKey, overrides: Value) -> String {
        let mut claims = json!({
            "iss": self.url,
            "aud": "http://localhost:8590",
            "sub": "repo:acme/scout:ref:refs/heads/main",
            "repository": "acme/scout",
            "ref": "refs/heads/main",
            "iat": now(),
            "nbf": now() - 5,
            "exp": now() + 300,
            "jti": format!("jti-{}", uuid::Uuid::new_v4()),
        });
        if let (Some(c), Some(o)) = (claims.as_object_mut(), overrides.as_object()) {
            for (k, v) in o {
                if v.is_null() {
                    c.remove(k);
                } else {
                    c.insert(k.clone(), v.clone());
                }
            }
        }
        let mut header = Header::new(key.alg);
        header.kid = Some(key.kid.clone());
        jsonwebtoken::encode(&header, &claims, &key.encoding).expect("sign")
    }
}

async fn send(ctx: &TestContext, req: Req) -> Resp {
    call(accounts_server::build_router(ctx.state.clone()), req).await
}

async fn context() -> TestContext {
    let mut settings = test_settings();
    settings.federation_allow_loopback = true;
    TestContext::with_settings(settings).await
}

async fn exchange(ctx: &TestContext, silicon: &str, token: &str) -> Resp {
    send(
        ctx,
        Req::post("/v1/oauth/token").form(&[
            ("grant_type", EXCHANGE),
            ("subject_token", token),
            ("subject_token_type", JWT_TYPE),
            ("silicon", silicon),
        ]),
    )
    .await
}

fn description(r: &Resp) -> String {
    r.json["error_description"]
        .as_str()
        .unwrap_or_default()
        .to_string()
}

async fn trust(ctx: &TestContext, token: &str, silicon: &str, body: Value) -> Resp {
    send(
        ctx,
        Req::post(&format!("/v1/silicons/{silicon}/federations"))
            .bearer(token)
            .json(body),
    )
    .await
}

async fn signins(ctx: &TestContext, uuid: &str) -> Vec<(String, String)> {
    sqlx::query_as("select method, outcome from signin_history where account_uuid = $1 order by id")
        .bind(uuid)
        .fetch_all(&ctx.state.db)
        .await
        .expect("history")
}

#[tokio::test]
async fn a_ci_job_signs_a_silicon_in_with_its_own_token() {
    let ctx = context().await;
    let issuer = MockIssuer::start().await;
    let ec = ec_key(7, "ec-1");
    issuer.publish(&ec);
    let custodian = ctx.carbon().await;
    let (silicon, _stk) = ctx.silicon(&custodian.uuid).await;
    let handle = silicon.handle.clone().expect("si:id");
    let custodian_token = ctx.first_party_tokens(&custodian).await.access_token;

    // The custodian trusts the issuer for one repository and branch.
    let r = trust(
        &ctx,
        &custodian_token,
        &handle,
        json!({"issuer": issuer.url, "conditions": {"repository": "acme/scout", "ref": "refs/heads/main"}, "name": "deploys"}),
    )
    .await;
    assert_eq!(r.status, 201, "{}", r.json);
    let federation_id = r.json["id"].as_str().expect("id").to_string();
    assert_eq!(
        r.json["audience"], "http://localhost:8590",
        "the default audience is our URL"
    );
    assert_eq!(r.json["conditions"]["repository"], "acme/scout");
    assert_eq!(r.json["created_by"], custodian.uuid.as_str());
    // The same trust again is a conflict, and the Silicon sees its trusts.
    let again = trust(
        &ctx,
        &custodian_token,
        &handle,
        json!({"issuer": issuer.url, "conditions": {"ref": "refs/heads/main", "repository": "acme/scout"}}),
    )
    .await;
    assert_eq!(again.status, 409, "{}", again.json);
    assert_eq!(again.error_code(), Some("federation_exists"));
    // Its webhook and stream hear about it.
    let added: i64 = sqlx::query_scalar(
        "select count(*) from webhook_events where target_kind = 'silicon' and target_id = $1 and type = 'silicon.federation.added'",
    )
    .bind(&silicon.uuid)
    .fetch_one(&ctx.state.db)
    .await
    .expect("events");
    assert_eq!(added, 1);

    // The job exchanges its token. Its token lives 5 minutes, so the sign-in is one access
    // token long (30 minutes): it never outlives the outside token by more than that.
    let r = exchange(&ctx, &handle, &issuer.token(&ec, json!({}))).await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(
        r.json["issued_token_type"],
        "urn:ietf:params:oauth:token-type:access_token"
    );
    assert_eq!(r.json["token_type"], "Bearer");
    assert_eq!(r.json["expires_in"], 1800);
    assert!(r.json["refresh_token"].is_string(), "{}", r.json);
    let ends = time::OffsetDateTime::parse(
        r.json["refresh_token_expires_at"].as_str().expect("ends"),
        &time::format_description::well_known::Rfc3339,
    )
    .expect("rfc3339")
    .unix_timestamp();
    assert!((ends - (now() + 1800)).abs() <= 5, "{}", r.json);
    assert_eq!(header(&r, "cache-control"), Some("no-store"));
    let access = r.json["access_token"].as_str().expect("token").to_string();
    let me = send(&ctx, Req::get("/v1/me").bearer(&access)).await;
    assert_eq!(me.status, 200, "{}", me.json);
    assert_eq!(me.json["uuid"], silicon.uuid.as_str());
    assert_eq!(
        signins(&ctx, &silicon.uuid).await,
        vec![("federated".to_string(), "success".to_string())]
    );
    let sessions = send(&ctx, Req::get("/v1/me/sessions").bearer(&access)).await;
    let current = sessions.json["items"]
        .as_array()
        .and_then(|items| items.iter().find(|s| s["current"] == true))
        .cloned()
        .expect("current session");
    assert_eq!(current["origin"], "federated");
    let listed = send(
        &ctx,
        Req::get(&format!("/v1/silicons/{handle}/federations")).bearer(&access),
    )
    .await;
    assert!(
        listed.json["items"][0]["last_used_at"].is_string(),
        "{}",
        listed.json
    );

    // A session from an outside token acts as the Silicon, but never adds a way in.
    let r = trust(
        &ctx,
        &access,
        &handle,
        json!({"issuer": issuer.url, "conditions": {"repository": "acme/other"}}),
    )
    .await;
    assert_eq!(r.status, 403, "{}", r.json);
    assert_eq!(r.error_code(), Some("federated_session"));
    let r = send(
        &ctx,
        Req::post(&format!("/v1/silicons/{handle}/keys"))
            .bearer(&access)
            .json(json!({"public_key": b64(&[3u8; 32])})),
    )
    .await;
    assert_eq!(r.status, 403, "{}", r.json);

    // The custodian's allow-list of apps still decides short-lived tokens.
    let (app, _) = ctx.app("remind").await;
    let r = send(
        &ctx,
        Req::put(&format!("/v1/me/silicons/{}/allowed-apps", silicon.uuid))
            .bearer(&custodian_token)
            .json(json!({"allowed_apps": []})),
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.json);
    let r = send(
        &ctx,
        Req::post("/v1/me/short-lived-tokens")
            .bearer(&access)
            .json(json!({"app_id": app.app_id})),
    )
    .await;
    assert_eq!(r.status, 403, "{}", r.json);
    assert_eq!(r.error_code(), Some("app_not_allowed"));

    // Removing the trust ends the sign-in it started and refuses new tokens.
    let r = send(
        &ctx,
        Req::delete(&format!(
            "/v1/silicons/{handle}/federations/{federation_id}"
        ))
        .bearer(&custodian_token),
    )
    .await;
    assert_eq!(r.status, 204, "{}", r.json);
    let me = send(&ctx, Req::get("/v1/me").bearer(&access)).await;
    assert_eq!(me.status, 401, "{}", me.json);
    let r = exchange(&ctx, &handle, &issuer.token(&ec, json!({}))).await;
    assert_eq!(r.status, 400, "{}", r.json);
    assert_eq!(r.json["error"], "invalid_grant");
    assert!(
        description(&r).contains("doesn't trust tokens from"),
        "{}",
        r.json
    );
    let removed: i64 = sqlx::query_scalar(
        "select count(*) from webhook_events where target_kind = 'silicon' and target_id = $1 and type = 'silicon.federation.removed'",
    )
    .bind(&silicon.uuid)
    .fetch_one(&ctx.state.db)
    .await
    .expect("events");
    assert_eq!(removed, 1);
}

fn header<'a>(r: &'a Resp, name: &str) -> Option<&'a str> {
    r.headers.get(name).and_then(|v| v.to_str().ok())
}

#[tokio::test]
async fn every_part_of_the_token_is_checked() {
    let ctx = context().await;
    let issuer = MockIssuer::start().await;
    let ec = ec_key(9, "ec-1");
    let rs = rsa_key("rsa-1");
    issuer.publish(&ec);
    issuer.publish(&rs);
    let custodian = ctx.carbon().await;
    let (silicon, _stk) = ctx.silicon(&custodian.uuid).await;
    let handle = silicon.handle.clone().expect("si:id");
    let silicon_token = ctx.first_party_tokens(&silicon).await.access_token;

    // The Silicon itself may trust an issuer too, with its own audience.
    let r = trust(
        &ctx,
        &silicon_token,
        &silicon.uuid,
        json!({"issuer": format!("{}/", issuer.url), "audience": "https://accounts.teamofsilicons.com", "conditions": {"repository": "acme/scout", "environment": "production"}}),
    )
    .await;
    assert_eq!(r.status, 201, "{}", r.json);
    assert_eq!(
        r.json["issuer"],
        issuer.url.as_str(),
        "stored without the trailing slash"
    );
    let good = json!({"aud": "https://accounts.teamofsilicons.com", "environment": "production"});

    // Good, signed with RS256 like GitHub Actions does.
    let r = exchange(&ctx, &handle, &issuer.token(&rs, good.clone())).await;
    assert_eq!(r.status, 200, "{}", r.json);

    let refused = |r: &Resp, needle: &str| {
        assert_eq!(r.status, 400, "{}", r.json);
        assert_eq!(r.json["error"], "invalid_grant", "{}", r.json);
        assert!(
            description(r).contains(needle),
            "expected '{needle}' in {}",
            r.json
        );
    };
    // Wrong audience.
    let mut wrong_aud = good.clone();
    wrong_aud["aud"] = json!("https://elsewhere.example");
    let r = exchange(&ctx, &handle, &issuer.token(&ec, wrong_aud)).await;
    refused(&r, "aud");
    // Wrong claim value, and a missing one.
    let mut wrong_claim = good.clone();
    wrong_claim["repository"] = json!("mallory/scout");
    let r = exchange(&ctx, &handle, &issuer.token(&ec, wrong_claim)).await;
    refused(&r, "'repository' (the token has 'mallory/scout')");
    let mut missing = good.clone();
    missing["environment"] = Value::Null;
    let r = exchange(&ctx, &handle, &issuer.token(&ec, missing)).await;
    refused(&r, "'environment' (the token has none)");
    // Expired (beyond the 30 seconds of skew).
    let mut expired = good.clone();
    expired["iat"] = json!(now() - 600);
    expired["nbf"] = json!(now() - 600);
    expired["exp"] = json!(now() - 120);
    let r = exchange(&ctx, &handle, &issuer.token(&ec, expired)).await;
    refused(&r, "expired");
    // Issued in the future.
    let mut future = good.clone();
    future["iat"] = json!(now() + 600);
    let r = exchange(&ctx, &handle, &issuer.token(&ec, future)).await;
    refused(&r, "future");
    // Replayed jti.
    let mut once = good.clone();
    once["jti"] = json!("job-42");
    let token = issuer.token(&ec, once);
    let r = exchange(&ctx, &handle, &token).await;
    assert_eq!(r.status, 200, "{}", r.json);
    let r = exchange(&ctx, &handle, &token).await;
    refused(&r, "exchanged before");
    // A token without jti still works (the brief: single use when present).
    let mut no_jti = good.clone();
    no_jti["jti"] = Value::Null;
    let r = exchange(&ctx, &handle, &issuer.token(&ec, no_jti)).await;
    assert_eq!(r.status, 200, "{}", r.json);
    // Unknown key: the keys are fetched again (once the cache is old enough), still unknown.
    let stranger = ec_key(11, "ec-unknown");
    ctx.state.federation.age_cache();
    let before = issuer.fetches();
    let r = exchange(&ctx, &handle, &issuer.token(&stranger, good.clone())).await;
    refused(&r, "doesn't publish");
    assert_eq!(
        issuer.fetches(),
        before + 1,
        "an unknown kid fetches the JWKS again"
    );
    // A rotated key the issuer starts publishing is picked up the same way.
    let rotated = ec_key(12, "ec-2");
    issuer.publish(&rotated);
    ctx.state.federation.age_cache();
    let r = exchange(&ctx, &handle, &issuer.token(&rotated, good.clone())).await;
    assert_eq!(r.status, 200, "{}", r.json);
    // A forged signature (right kid, wrong key).
    let mut forged = ec_key(13, "ec-1");
    forged.kid = "ec-1".into();
    let r = exchange(&ctx, &handle, &issuer.token(&forged, good.clone())).await;
    refused(&r, "signature");
    // An issuer the Silicon doesn't trust: refused before anything is fetched.
    let other = MockIssuer::start().await;
    other.publish(&ec);
    let r = exchange(&ctx, &handle, &other.token(&ec, good.clone())).await;
    refused(&r, "doesn't trust tokens from");
    assert_eq!(other.fetches(), 0);
    // Unsafe algorithms never get that far.
    let hs = jsonwebtoken::encode(
        &Header::new(Algorithm::HS256),
        &json!({"iss": issuer.url, "exp": now() + 60}),
        &EncodingKey::from_secret(b"secret"),
    )
    .expect("hs");
    let r = exchange(&ctx, &handle, &hs).await;
    refused(&r, "alg");

    // Failures from the trusted issuer are in the Silicon's history; forged ones aren't.
    let history = signins(&ctx, &silicon.uuid).await;
    let failed = history.iter().filter(|(_, o)| o == "failed").count();
    let ok = history.iter().filter(|(_, o)| o == "success").count();
    assert_eq!(ok, 4, "{history:?}");
    assert_eq!(
        failed, 4,
        "wrong aud, wrong claim, missing claim, replay: {history:?}"
    );
    assert!(history.iter().all(|(m, _)| m == "federated"));
}

#[tokio::test]
async fn requests_are_checked_before_any_token_is() {
    let ctx = context().await;
    let custodian = ctx.carbon().await;
    let (silicon, _stk) = ctx.silicon(&custodian.uuid).await;
    let handle = silicon.handle.clone().expect("si:id");
    let form = |pairs: &[(&str, &str)]| Req::post("/v1/oauth/token").form(pairs);
    let r = send(
        &ctx,
        form(&[
            ("grant_type", EXCHANGE),
            ("subject_token_type", JWT_TYPE),
            ("silicon", &handle),
        ]),
    )
    .await;
    assert_eq!(r.status, 400);
    assert!(
        description(&r).contains("subject_token is required"),
        "{}",
        r.json
    );
    let r = send(
        &ctx,
        form(&[
            ("grant_type", EXCHANGE),
            ("subject_token", "a.b.c"),
            ("silicon", &handle),
        ]),
    )
    .await;
    assert!(
        description(&r).contains("subject_token_type is required"),
        "{}",
        r.json
    );
    let r = send(
        &ctx,
        form(&[
            ("grant_type", EXCHANGE),
            ("subject_token", "a.b.c"),
            (
                "subject_token_type",
                "urn:ietf:params:oauth:token-type:access_token",
            ),
            ("silicon", &handle),
        ]),
    )
    .await;
    assert!(
        description(&r).contains("User verification proof"),
        "{}",
        r.json
    );
    let r = send(
        &ctx,
        form(&[
            ("grant_type", EXCHANGE),
            ("subject_token", "a.b.c"),
            ("subject_token_type", JWT_TYPE),
        ]),
    )
    .await;
    assert!(
        description(&r).contains("silicon is required"),
        "{}",
        r.json
    );
    // Only the first-party client exchanges.
    let (app, secret) = ctx.app("briefcase").await;
    let r = send(
        &ctx,
        form(&[
            ("grant_type", EXCHANGE),
            ("subject_token", "a.b.c"),
            ("subject_token_type", JWT_TYPE),
            ("silicon", &handle),
        ])
        .basic(&app.app_id, &secret),
    )
    .await;
    assert_eq!(r.status, 400, "{}", r.json);
    assert_eq!(r.json["error"], "unauthorized_client");
    // Discovery advertises the grant and both signing algorithms.
    let d = send(&ctx, Req::get("/.well-known/openid-configuration")).await;
    assert!(
        d.json["grant_types_supported"]
            .as_array()
            .is_some_and(|g| g.iter().any(|v| v == EXCHANGE))
    );
    assert_eq!(
        d.json["id_token_signing_alg_values_supported"],
        json!(["EdDSA", "RS256"])
    );
}

#[tokio::test]
async fn trusts_are_validated_and_private_issuers_refused() {
    let ctx = context().await;
    let custodian = ctx.carbon().await;
    let (silicon, _stk) = ctx.silicon(&custodian.uuid).await;
    let handle = silicon.handle.clone().expect("si:id");
    let token = ctx.first_party_tokens(&custodian).await.access_token;
    let check = |r: &Resp, field: &str, needle: &str| {
        assert_eq!(r.status, 422, "{}", r.json);
        let fields = &r.json["error"]["details"]["fields"];
        let text = fields[field].as_str().unwrap_or_default();
        assert!(
            text.contains(needle),
            "{field}: expected '{needle}' in {}",
            r.json
        );
    };
    // A whole issuer is never trusted, and GitHub needs a repository (or owner) condition.
    let r = trust(
        &ctx,
        &token,
        &handle,
        json!({"issuer": "https://token.actions.githubusercontent.com", "conditions": {}}),
    )
    .await;
    check(&r, "conditions", "at least one condition");
    let r = trust(&ctx, &token, &handle, json!({"issuer": "https://token.actions.githubusercontent.com", "conditions": {"ref": "refs/heads/main"}})).await;
    check(&r, "conditions", "repository");
    let r = trust(
        &ctx,
        &token,
        &handle,
        json!({"issuer": "https://gitlab.com", "conditions": {"ref": "main"}}),
    )
    .await;
    check(&r, "conditions", "project_path");
    // Private, link-local and plain-http issuers are refused, even with the test flag (it only
    // lets loopback through).
    for issuer in [
        "https://10.0.0.8",
        "http://169.254.169.254",
        "https://192.168.1.10/oidc",
        "http://ci.example.com",
    ] {
        let r = trust(
            &ctx,
            &token,
            &handle,
            json!({"issuer": issuer, "conditions": {"repository": "acme/scout"}}),
        )
        .await;
        assert_eq!(r.status, 422, "{issuer}: {}", r.json);
    }
    // Without the flag, loopback is refused like any private address.
    let strict = TestContext::new().await;
    let custodian2 = strict.carbon().await;
    let (silicon2, _) = strict.silicon(&custodian2.uuid).await;
    let issuer = MockIssuer::start().await;
    let token2 = strict.first_party_tokens(&custodian2).await.access_token;
    let r = send(
        &strict,
        Req::post(&format!("/v1/silicons/{}/federations", silicon2.uuid))
            .bearer(&token2)
            .json(json!({"issuer": issuer.url, "conditions": {"repository": "acme/scout"}})),
    )
    .await;
    assert_eq!(r.status, 422, "{}", r.json);
    // A trust whose issuer resolves to a private address (it was stored directly) is refused
    // at exchange time before anything is fetched.
    sqlx::query(
        "insert into silicon_federations (id, silicon_uuid, name, issuer, audience, conditions, created_by) \
         values ($1, $2, 'private', 'https://10.1.2.3', 'http://localhost:8590', '{\"repository\": \"acme/scout\"}', $3)",
    )
    .bind(uuid::Uuid::now_v7())
    .bind(&silicon.uuid)
    .bind(&custodian.uuid)
    .execute(&ctx.state.db)
    .await
    .expect("insert");
    let ec = ec_key(5, "k");
    let e = |v: &Value| b64(v.to_string().as_bytes());
    let unsigned = format!(
        "{}.{}.{}",
        e(&json!({"alg": "ES256", "kid": "k"})),
        e(&json!({"iss": "https://10.1.2.3", "exp": now() + 60})),
        b64(b"sig")
    );
    let _ = ec;
    let r = exchange(&ctx, &handle, &unsigned).await;
    assert_eq!(r.status, 400, "{}", r.json);
    assert!(
        description(&r).contains("private or reserved"),
        "{}",
        r.json
    );
    // An unreachable issuer can't be trusted.
    let r = trust(
        &ctx,
        &token,
        &handle,
        json!({"issuer": "http://127.0.0.1:9", "conditions": {"repository": "acme/scout"}}),
    )
    .await;
    assert_eq!(r.status, 422, "{}", r.json);
    assert_eq!(r.error_code(), Some("issuer_unreachable"));
    // Someone else's Silicon is not found.
    let stranger = ctx.carbon().await;
    let stranger_token = ctx.first_party_tokens(&stranger).await.access_token;
    let r = send(
        &ctx,
        Req::get(&format!("/v1/silicons/{handle}/federations")).bearer(&stranger_token),
    )
    .await;
    assert_eq!(r.status, 404, "{}", r.json);
}

#[tokio::test]
async fn a_sign_in_lasts_as_long_as_the_outside_token_and_refreshes_within_it() {
    let ctx = context().await;
    let issuer = MockIssuer::start().await;
    let ec = ec_key(21, "ec-1");
    issuer.publish(&ec);
    let custodian = ctx.carbon().await;
    let (silicon, _stk) = ctx.silicon(&custodian.uuid).await;
    let handle = silicon.handle.clone().expect("si:id");
    let custodian_token = ctx.first_party_tokens(&custodian).await.access_token;
    let r = trust(
        &ctx,
        &custodian_token,
        &handle,
        json!({"issuer": issuer.url, "conditions": {"project_path": "acme/scout"}}),
    )
    .await;
    assert_eq!(r.status, 201, "{}", r.json);
    let ends = |r: &Resp| {
        time::OffsetDateTime::parse(
            r.json["refresh_token_expires_at"].as_str().expect("ends"),
            &time::format_description::well_known::Rfc3339,
        )
        .expect("rfc3339")
        .unix_timestamp()
    };

    // A GitLab-style token that lives as long as a 2-hour job: so does the sign-in.
    let r = exchange(
        &ctx,
        &handle,
        &issuer.token(
            &ec,
            json!({"project_path": "acme/scout", "exp": now() + 7200}),
        ),
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert!((ends(&r) - (now() + 7200)).abs() <= 5, "{}", r.json);
    // Its refresh token rotates like any other, within the same end.
    let refresh = r.json["refresh_token"]
        .as_str()
        .expect("refresh")
        .to_string();
    let refreshed = send(
        &ctx,
        Req::post("/v1/oauth/token").form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", &refresh),
            ("client_id", "silicon-accounts"),
        ]),
    )
    .await;
    assert_eq!(refreshed.status, 200, "{}", refreshed.json);
    assert_eq!(
        refreshed.json["refresh_token_expires_at"],
        r.json["refresh_token_expires_at"]
    );

    // Never longer than 12 hours, whatever the outside token says.
    let r = exchange(
        &ctx,
        &handle,
        &issuer.token(
            &ec,
            json!({"project_path": "acme/scout", "exp": now() + 30 * 86_400}),
        ),
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert!((ends(&r) - (now() + 12 * 3600)).abs() <= 5, "{}", r.json);

    // Once the sign-in ends, its tokens stop: the job exchanges a fresh token instead.
    let access = r.json["access_token"].as_str().expect("access").to_string();
    sqlx::query(
        "update token_families set expires_at = now() - interval '1 second' where account_uuid = $1 and origin = 'federated'",
    )
    .bind(&silicon.uuid)
    .execute(&ctx.state.db)
    .await
    .expect("time travel");
    let me = send(&ctx, Req::get("/v1/me").bearer(&access)).await;
    assert_eq!(me.status, 401, "{}", me.json);
}
