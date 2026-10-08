//! Shared helpers for the oauth integration tests.

use std::time::{Duration, Instant};

use accounts_core::AppState;
use accounts_core::crypto::{pkce, stk};
use accounts_core::models::{Account, Scope};
use accounts_core::repo::tokens::{self, NewAuthCode};
use accounts_core::repo::{accounts, memberships};
use accounts_core::test_support::{Req, Resp, TestContext, call};
use axum::Router;
use jsonwebtoken::{Algorithm, DecodingKey, Validation};
use serde_json::Value;
use sqlx::{Postgres, Transaction};
use tokio::task::JoinHandle;

/// A PKCE verifier and its S256 challenge (checked against Python's hashlib + base64url).
pub const VERIFIER: &str = "dBjftJeZ4CVP-mJ92K9mlQhJq8XmJHkmWkrxPrJCnjE";
pub const CHALLENGE: &str = "xwYgnQQNZ3dlCRWEttF1F16Ja9ycfauonnmumJgYv8M";

pub fn router() -> Router<AppState> {
    accounts_oauth::router()
}

/// The redirect URI `TestContext::app` registers for an app.
pub fn redirect_for(app_id: &str) -> String {
    format!("http://127.0.0.1:8593/{app_id}/callback")
}

/// What the authorization request of a test sign-in looked like.
#[derive(Debug, Clone, Default)]
pub struct Authorize<'a> {
    pub scopes: &'a [Scope],
    pub nonce: Option<&'a str>,
    /// (challenge, method)
    pub pkce: Option<(&'a str, &'a str)>,
    /// Skip recording the membership (the consent step normally does).
    pub no_membership: bool,
    /// When the Carbon authenticated in the browser that completed the flow.
    pub auth_time: Option<time::OffsetDateTime>,
}

/// A finished hosted sign-in of `account` to `app_id`: the membership the consent step records
/// and the authorization code the flow hands back on the redirect.
pub async fn signed_in_code(
    ctx: &TestContext,
    app_id: &str,
    account: &Account,
    a: Authorize<'_>,
) -> String {
    let scopes: Vec<Scope> = if a.scopes.is_empty() {
        vec![Scope::Profile]
    } else {
        a.scopes.to_vec()
    };
    if !a.no_membership {
        ctx.membership(app_id, &account.uuid, &scopes).await;
    }
    let redirect = redirect_for(app_id);
    let mut conn = ctx.conn().await;
    tokens::create_code(
        &mut conn,
        &ctx.state.keys.pepper,
        &NewAuthCode {
            flow_id: "flow-test",
            app_id,
            account_uuid: &account.uuid,
            redirect_uri: &redirect,
            code_challenge: a.pkce.map(|p| p.0),
            code_challenge_method: a.pkce.map(|p| p.1),
            scopes: &scopes,
            nonce: a.nonce,
            browser_session_id: None,
            auth_time: a.auth_time,
        },
    )
    .await
    .expect("create authorization code")
}

/// `POST /v1/oauth/token` with HTTP Basic client authentication and a form body.
pub fn token_req(app_id: &str, secret: &str, form: &[(&str, &str)]) -> Req {
    Req::post("/v1/oauth/token")
        .basic(app_id, secret)
        .form(form)
}

/// `POST /v1/oauth/token` as the first-party public client (`client_id=accounts`, no secret).
pub fn public_token_req(form: &[(&str, &str)]) -> Req {
    let mut pairs = form.to_vec();
    pairs.push(("client_id", "accounts"));
    Req::post("/v1/oauth/token").form(&pairs)
}

/// Exchanges a code with the right `redirect_uri` (and verifier when given).
pub async fn exchange(
    ctx: &TestContext,
    app_id: &str,
    secret: &str,
    code: &str,
    verifier: Option<&str>,
) -> Resp {
    let redirect = redirect_for(app_id);
    let mut form = vec![
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", redirect.as_str()),
    ];
    if let Some(v) = verifier {
        form.push(("code_verifier", v));
    }
    ctx.call(router(), token_req(app_id, secret, &form)).await
}

/// A full hosted sign-in of `account` to the app: membership, code, exchange. Returns the token
/// response JSON.
pub async fn sign_in(
    ctx: &TestContext,
    app_id: &str,
    secret: &str,
    account: &Account,
    scopes: &[Scope],
) -> Value {
    let code = signed_in_code(
        ctx,
        app_id,
        account,
        Authorize {
            scopes,
            ..Default::default()
        },
    )
    .await;
    let r = exchange(ctx, app_id, secret, &code, None).await;
    assert_tokens(&r).clone()
}

/// `grant_type=refresh_token` with HTTP Basic.
pub async fn refresh(ctx: &TestContext, app_id: &str, secret: &str, refresh_token: &str) -> Resp {
    ctx.call(
        router(),
        token_req(
            app_id,
            secret,
            &[
                ("grant_type", "refresh_token"),
                ("refresh_token", refresh_token),
            ],
        ),
    )
    .await
}

/// Asserts an RFC 6749 error: status, `error`, a description mentioning `contains`, and the
/// no-store headers.
#[track_caller]
pub fn assert_oauth_error(r: &Resp, status: u16, error: &str, contains: &str) {
    assert_eq!(r.status.as_u16(), status, "unexpected status: {}", r.json);
    assert_eq!(r.json["error"], error, "unexpected error: {}", r.json);
    let description = r.json["error_description"]
        .as_str()
        .unwrap_or_else(|| panic!("no error_description in {}", r.json));
    assert!(
        description.contains(contains),
        "error_description {description:?} should mention {contains:?}"
    );
    assert!(
        description
            .bytes()
            .all(|b| (0x20..=0x7E).contains(&b) && b != b'"' && b != b'\\'),
        "error_description must keep to the RFC 6749 character set: {description:?}"
    );
    assert_eq!(header(r, "cache-control"), "no-store");
    assert_eq!(header(r, "pragma"), "no-cache");
}

/// Asserts a successful token response and returns its JSON.
#[track_caller]
pub fn assert_tokens(r: &Resp) -> &Value {
    assert_eq!(r.status.as_u16(), 200, "expected tokens, got {}", r.json);
    assert_eq!(header(r, "cache-control"), "no-store");
    assert_eq!(header(r, "pragma"), "no-cache");
    assert_eq!(r.json["token_type"], "Bearer");
    assert_eq!(r.json["expires_in"], 1800);
    assert!(
        r.json["access_token"]
            .as_str()
            .is_some_and(|t| t.starts_with("eyJ")),
        "{}",
        r.json
    );
    assert!(
        r.json["refresh_token"]
            .as_str()
            .is_some_and(|t| t.starts_with("sar_")),
        "{}",
        r.json
    );
    &r.json
}

/// A response header as text ("" when absent).
pub fn header<'a>(r: &'a Resp, name: &str) -> &'a str {
    r.headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
}

/// A string field of a JSON value.
#[track_caller]
pub fn s<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key]
        .as_str()
        .unwrap_or_else(|| panic!("{key} missing in {v}"))
}

/// Verifies a JWT using only what a third party has: the published JWKS and the issuer from
/// discovery. Returns the claims.
#[track_caller]
pub fn verify_with_jwks(jwks: &Value, issuer: &str, audience: &str, token: &str) -> Value {
    let header = jsonwebtoken::decode_header(token).expect("JWT header");
    assert_eq!(header.alg, Algorithm::EdDSA);
    let kid = header.kid.expect("kid header");
    let key = jwks["keys"]
        .as_array()
        .expect("keys")
        .iter()
        .find(|k| k["kid"] == kid.as_str())
        .unwrap_or_else(|| panic!("kid {kid} not in the JWKS {jwks}"));
    assert_eq!(key["kty"], "OKP");
    assert_eq!(key["crv"], "Ed25519");
    assert_eq!(key["alg"], "EdDSA");
    let decoding =
        DecodingKey::from_ed_components(key["x"].as_str().expect("x")).expect("JWK decodes");
    let mut validation = Validation::new(Algorithm::EdDSA);
    validation.set_issuer(&[issuer]);
    validation.set_audience(&[audience]);
    validation.set_required_spec_claims(&["exp", "iat", "iss", "sub", "aud"]);
    jsonwebtoken::decode::<Value>(token, &decoding, &validation)
        .unwrap_or_else(|e| panic!("token does not verify with the JWKS: {e}"))
        .claims
}

/// Sanity check that the constants above agree with core.
pub fn pkce_constants_agree() -> bool {
    pkce::s256_challenge(VERIFIER) == CHALLENGE
}

/// One SQL scalar.
pub async fn scalar<T>(ctx: &TestContext, sql: &'static str, bind: &str) -> T
where
    T: for<'r> sqlx::Decode<'r, sqlx::Postgres> + sqlx::Type<sqlx::Postgres> + Send + Unpin,
{
    let mut conn = ctx.conn().await;
    sqlx::query_scalar::<_, T>(sql)
        .bind(bind)
        .fetch_one(&mut *conn)
        .await
        .unwrap_or_else(|e| panic!("{sql}: {e}"))
}

/// Live (unrevoked) token families of an account.
pub async fn live_families(ctx: &TestContext, account_uuid: &str) -> i64 {
    scalar(
        ctx,
        "select count(*) from token_families where account_uuid = $1 and revoked_at is null",
        account_uuid,
    )
    .await
}

/// Waits until at least `n` sessions of this test's database are blocked on a lock (a request
/// waiting for a concurrent change to commit). Panics after 10 s.
pub async fn wait_for_lock_waiters(ctx: &TestContext, n: i64) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let waiting: i64 = {
            let mut conn = ctx.conn().await;
            sqlx::query_scalar(
                "select count(*) from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'",
            )
            .fetch_one(&mut *conn)
            .await
            .expect("read pg_stat_activity")
        };
        if waiting >= n {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "no request was waiting for a row lock after 10 s"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// What `DELETE /v1/me/apps/{app_id}` does (account crate): lock the membership, then remove
/// the access (membership, the app's token families, its User verification proofs). The transaction is left
/// open so a test can run something while the removal is in flight.
pub async fn begin_access_removal(
    state: &AppState,
    app_id: &str,
    account_uuid: &str,
) -> Transaction<'static, Postgres> {
    let mut tx = state.db.begin().await.expect("begin the removal");
    sqlx::query(
        "select status from memberships where app_id = $1 and account_uuid = $2 for update",
    )
    .bind(app_id)
    .bind(account_uuid)
    .execute(&mut *tx)
    .await
    .expect("lock the membership");
    memberships::remove_access(&mut tx, app_id, account_uuid, account_uuid)
        .await
        .expect("remove access");
    tx
}

/// What `POST /v1/me/silicons/{uuid}/stk` does (silicons crate): lock the Silicon, set a new
/// STK, revoke every sign-in of the Silicon. The transaction is left open.
pub async fn begin_stk_rotation(
    state: &AppState,
    silicon_uuid: &str,
) -> Transaction<'static, Postgres> {
    let hash = state
        .keys
        .stk
        .hash(&stk::generate())
        .expect("hash the new STK");
    let mut tx = state.db.begin().await.expect("begin the rotation");
    accounts::lock(&mut tx, silicon_uuid)
        .await
        .expect("lock the Silicon")
        .expect("the Silicon exists");
    accounts::set_stk(&mut tx, silicon_uuid, &hash)
        .await
        .expect("set the STK");
    tokens::revoke_families(
        &mut tx,
        &tokens::RevokeFilter {
            account_uuid: silicon_uuid,
            ..Default::default()
        },
        "stk_rotated",
    )
    .await
    .expect("revoke the Silicon's sign-ins");
    tx
}

/// Sends a token request from its own task (to race it against something else).
pub fn spawn_token_request(ctx: &TestContext, req: Req) -> JoinHandle<Resp> {
    let router = router().with_state(ctx.state.clone());
    tokio::spawn(async move { call(router, req).await })
}

/// Webhook events of a type stored for an app: their `data` objects, oldest first.
pub async fn app_events(ctx: &TestContext, app_id: &str, event_type: &str) -> Vec<Value> {
    let mut conn = ctx.conn().await;
    sqlx::query_scalar::<_, Value>(
        "select payload->'data' from webhook_events where target_kind = 'app' and target_id = $1 and type = $2 order by occurred_at",
    )
    .bind(app_id)
    .bind(event_type)
    .fetch_all(&mut *conn)
    .await
    .expect("webhook events")
}
