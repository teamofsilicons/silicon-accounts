//! Test helpers (cargo feature `test-support`). Feature crates enable it in their
//! `[dev-dependencies]`:
//!
//! ```toml
//! silicon-accounts-core = { workspace = true, features = ["test-support"] }
//! ```
//!
//! ```ignore
//! let ctx = accounts_core::test_support::TestContext::new().await;   // fresh database + AppState
//! let carbon = ctx.carbon().await;                                    // an active Carbon with an email
//! let (app, secret) = ctx.app("briefcase").await;                     // an app with credentials
//! let resp = ctx.call(my_router(), Req::post("/v1/x").bearer(&token).json(json!({}))).await;
//! assert_eq!(resp.status, 200);
//! ```
//!
//! Databases are `accounts_test_<random>` on the Postgres at ACCOUNTS_TEST_ADMIN_URL (default
//! `postgres://postgres@127.0.0.1:5444/postgres`); they are dropped when the [`TestDb`] drops.
//! Helpers panic with clear messages: they only run in tests.

use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::http::{HeaderMap, HeaderValue, Method, Request, StatusCode};
use serde_json::Value;
use sqlx::{Connection, PgConnection, PgPool};
use time::macros::date;

use crate::config::Settings;
use crate::crypto::stk::StkHasher;
use crate::crypto::{prefix, random_token};
use crate::delivery::LocalSender;
use crate::ids::AccountId;
use crate::models::{
    Account, AccountKind, AccountStatus, App, MembershipSource, Scope, TokenOrigin, VerifiedVia,
};
use crate::repo::accounts::{NewCarbon, NewContact, NewSilicon};
use crate::state::AppState;
use crate::views::TokenResponse;

/// Admin connection used to create and drop test databases.
pub fn admin_url() -> String {
    std::env::var("ACCOUNTS_TEST_ADMIN_URL")
        .unwrap_or_else(|_| "postgres://postgres@127.0.0.1:5444/postgres".into())
}

/// A throwaway, fully migrated database. Dropped (with FORCE) when this value drops.
pub struct TestDb {
    pub pool: PgPool,
    pub name: String,
    pub url: String,
    admin_url: String,
    dropped: bool,
}

impl TestDb {
    /// Creates `accounts_test_<random>` and runs every migration.
    pub async fn new() -> TestDb {
        let admin = admin_url();
        let name = format!(
            "accounts_test_{}",
            hex::encode(crate::crypto::random_bytes::<6>())
        );
        let mut conn = PgConnection::connect(&admin).await.unwrap_or_else(|e| {
            panic!(
                "test Postgres is not reachable at {admin}: {e}. Start it with scripts/dev-db.sh."
            )
        });
        sqlx::query(sqlx::AssertSqlSafe(format!("create database \"{name}\"")))
            .execute(&mut conn)
            .await
            .unwrap_or_else(|e| panic!("could not create test database {name}: {e}"));
        let _ = conn.close().await;
        let mut url = url::Url::parse(&admin)
            .unwrap_or_else(|e| panic!("ACCOUNTS_TEST_ADMIN_URL is not a URL: {e}"));
        url.set_path(&format!("/{name}"));
        let url = url.to_string();
        let pool = crate::db::connect_url(&url, 8)
            .await
            .unwrap_or_else(|e| panic!("could not connect to {name}: {e}"));
        crate::db::migrate(&pool)
            .await
            .unwrap_or_else(|e| panic!("migrations failed on {name}: {e}"));
        TestDb {
            pool,
            name,
            url,
            admin_url: admin,
            dropped: false,
        }
    }

    /// Closes the pool and drops the database now.
    pub async fn teardown(mut self) {
        self.pool.close().await;
        drop_database(&self.admin_url, &self.name).await;
        self.dropped = true;
    }
}

async fn drop_database(admin: &str, name: &str) {
    if let Ok(mut conn) = PgConnection::connect(admin).await {
        let _ = sqlx::query(sqlx::AssertSqlSafe(format!(
            "drop database if exists \"{name}\" with (force)"
        )))
        .execute(&mut conn)
        .await;
        let _ = conn.close().await;
    }
}

impl Drop for TestDb {
    fn drop(&mut self) {
        if self.dropped {
            return;
        }
        let (admin, name) = (self.admin_url.clone(), self.name.clone());
        // Drop runs inside a tokio runtime; use a separate thread with its own runtime.
        let handle = std::thread::spawn(move || {
            if let Ok(rt) = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                rt.block_on(drop_database(&admin, &name));
            }
        });
        let _ = handle.join();
    }
}

/// Settings used by tests (see `Settings::for_tests`).
pub fn test_settings() -> Settings {
    Settings::for_tests()
}

/// An AppState over `pool` with test settings, local delivery and fast STK hashing.
pub fn test_state(pool: PgPool) -> AppState {
    test_state_with(pool, test_settings())
}

/// Like [`test_state`] with custom settings.
pub fn test_state_with(pool: PgPool, settings: Settings) -> AppState {
    AppState::new(settings, pool)
        .unwrap_or_else(|e| panic!("test AppState: {e}"))
        .with_sender(Arc::new(LocalSender))
        .with_stk_hasher(StkHasher::FAST_FOR_TESTS)
}

/// A random suffix for unique handles, emails and app ids.
pub fn rand_suffix() -> String {
    hex::encode(crate::crypto::random_bytes::<4>())
}

/// A test database plus state and factories.
pub struct TestContext {
    pub db: TestDb,
    pub state: AppState,
}

/// A Carbon to create with [`TestContext::carbon_with`].
#[derive(Debug, Clone, Default)]
pub struct CarbonSpec {
    pub handle: Option<String>,
    pub display_name: Option<String>,
    /// `None` = a random `t-<rand>@example.test`; `Some("")` = no email.
    pub email: Option<String>,
    pub phone: Option<String>,
    pub timezone: Option<String>,
    pub status: Option<AccountStatus>,
}

/// A small request builder for [`TestContext::call`].
#[derive(Debug, Clone)]
pub struct Req {
    pub method: Method,
    pub uri: String,
    pub headers: HeaderMap,
    pub body: Vec<u8>,
}

impl Req {
    pub fn new(method: Method, uri: &str) -> Req {
        Req {
            method,
            uri: uri.to_string(),
            headers: HeaderMap::new(),
            body: Vec::new(),
        }
    }
    pub fn get(uri: &str) -> Req {
        Req::new(Method::GET, uri)
    }
    pub fn post(uri: &str) -> Req {
        Req::new(Method::POST, uri)
    }
    pub fn put(uri: &str) -> Req {
        Req::new(Method::PUT, uri)
    }
    pub fn patch(uri: &str) -> Req {
        Req::new(Method::PATCH, uri)
    }
    pub fn delete(uri: &str) -> Req {
        Req::new(Method::DELETE, uri)
    }
    /// Sets a header.
    pub fn header(mut self, name: &'static str, value: &str) -> Req {
        if let Ok(v) = HeaderValue::from_str(value) {
            self.headers.insert(name, v);
        }
        self
    }
    /// `Authorization: Bearer …`.
    pub fn bearer(self, token: &str) -> Req {
        self.header("authorization", &format!("Bearer {token}"))
    }
    /// `Authorization: Basic base64(id:secret)`.
    pub fn basic(self, id: &str, secret: &str) -> Req {
        use base64::Engine as _;
        let enc = base64::engine::general_purpose::STANDARD.encode(format!("{id}:{secret}"));
        self.header("authorization", &format!("Basic {enc}"))
    }
    /// The session cookie plus the site Origin (passes the CSRF guard).
    pub fn session(self, settings: &Settings, token: &str) -> Req {
        let name =
            crate::http::cookies::cookie_name(settings, crate::http::cookies::SESSION_COOKIE);
        self.header("cookie", &format!("{name}={token}"))
            .header("origin", &settings.public_origin)
    }
    /// A JSON body.
    pub fn json(mut self, body: Value) -> Req {
        self.body = body.to_string().into_bytes();
        self.header("content-type", "application/json")
    }
    /// A form body.
    pub fn form(mut self, pairs: &[(&str, &str)]) -> Req {
        self.body = serde_urlencoded::to_string(pairs)
            .unwrap_or_default()
            .into_bytes();
        self.header("content-type", "application/x-www-form-urlencoded")
    }
}

/// A response from [`TestContext::call`].
#[derive(Debug, Clone)]
pub struct Resp {
    pub status: StatusCode,
    pub headers: HeaderMap,
    pub body: Vec<u8>,
    /// The body parsed as JSON (`Value::Null` when it isn't JSON).
    pub json: Value,
}

impl Resp {
    /// `error.code` of an API error body.
    pub fn error_code(&self) -> Option<&str> {
        self.json["error"]["code"]
            .as_str()
            .or_else(|| self.json["error"].as_str())
    }
}

/// Sends one request through a router (in-process, no network).
pub async fn call(router: Router, req: Req) -> Resp {
    use tower::ServiceExt as _;
    let mut builder = Request::builder().method(req.method).uri(req.uri);
    for (k, v) in &req.headers {
        builder = builder.header(k, v);
    }
    let request = builder
        .body(Body::from(req.body))
        .unwrap_or_else(|e| panic!("bad test request: {e}"));
    let response = router.oneshot(request).await.unwrap_or_else(|e| match e {});
    let status = response.status();
    let headers = response.headers().clone();
    let body = axum::body::to_bytes(response.into_body(), 64 * 1024 * 1024)
        .await
        .unwrap_or_else(|e| panic!("reading response body: {e}"))
        .to_vec();
    let json = serde_json::from_slice(&body).unwrap_or(Value::Null);
    Resp {
        status,
        headers,
        body,
        json,
    }
}

impl TestContext {
    /// A fresh database and test state.
    pub async fn new() -> TestContext {
        let db = TestDb::new().await;
        let state = test_state(db.pool.clone());
        TestContext { db, state }
    }

    /// Like [`TestContext::new`] with custom settings.
    pub async fn with_settings(settings: Settings) -> TestContext {
        let db = TestDb::new().await;
        let state = test_state_with(db.pool.clone(), settings);
        TestContext { db, state }
    }

    /// A pooled connection.
    pub async fn conn(&self) -> sqlx::pool::PoolConnection<sqlx::Postgres> {
        self.state
            .db
            .acquire()
            .await
            .unwrap_or_else(|e| panic!("acquire: {e}"))
    }

    /// Sends a request through `router` with this context's state applied.
    pub async fn call(&self, router: Router<AppState>, req: Req) -> Resp {
        call(router.with_state(self.state.clone()), req).await
    }

    /// An active Carbon with a random handle and a verified primary email.
    pub async fn carbon(&self) -> Account {
        self.carbon_with(CarbonSpec::default()).await
    }

    /// A Carbon from a spec.
    pub async fn carbon_with(&self, spec: CarbonSpec) -> Account {
        let suffix = rand_suffix();
        let handle = spec.handle.unwrap_or_else(|| format!("t-{suffix}"));
        let id = AccountId::parse_for_kind(&handle, AccountKind::Carbon)
            .unwrap_or_else(|e| panic!("bad test handle: {e}"));
        let email = match spec.email {
            None => Some(format!("t-{suffix}@example.test")),
            Some(e) if e.is_empty() => None,
            Some(e) => Some(e),
        };
        let status = spec.status.unwrap_or(AccountStatus::Active);
        let via = if status == AccountStatus::Unclaimed {
            None
        } else {
            Some(VerifiedVia::Code)
        };
        let mut conn = self.conn().await;
        crate::repo::accounts::create_carbon(
            &mut conn,
            &self.state.settings,
            NewCarbon {
                id,
                display_name: spec.display_name.unwrap_or_else(|| "Test Carbon".into()),
                pfp_url: None,
                dob: date!(2000 - 01 - 01),
                timezone: spec.timezone.unwrap_or_else(|| "UTC".into()),
                status,
                emails: email
                    .into_iter()
                    .map(|value| NewContact {
                        value,
                        verified_via: via,
                    })
                    .collect(),
                phones: spec
                    .phone
                    .into_iter()
                    .map(|value| NewContact {
                        value,
                        verified_via: via,
                    })
                    .collect(),
                actor: "test".into(),
            },
        )
        .await
        .unwrap_or_else(|e| panic!("create test Carbon: {e}"))
    }

    /// An active Silicon in `custodian_uuid`'s custody; returns it and its STK.
    pub async fn silicon(&self, custodian_uuid: &str) -> (Account, String) {
        let stk = crate::crypto::stk::generate();
        let hash = self
            .state
            .keys
            .stk
            .hash(&stk)
            .unwrap_or_else(|e| panic!("hash STK: {e}"));
        let id = AccountId::new(AccountKind::Silicon, &format!("s-{}", rand_suffix()))
            .unwrap_or_else(|e| panic!("{e}"));
        let mut conn = self.conn().await;
        let account = crate::repo::accounts::create_silicon(
            &mut conn,
            &self.state.settings,
            NewSilicon {
                id,
                display_name: "Test Silicon".into(),
                pfp_url: None,
                timezone: "UTC".into(),
                status: AccountStatus::Active,
                custodian_uuid: Some(custodian_uuid.to_string()),
                stk_hash: hash,
                webhook_url: None,
                webhook_secret_enc: None,
                actor: custodian_uuid.to_string(),
            },
        )
        .await
        .unwrap_or_else(|e| panic!("create test Silicon: {e}"));
        (account, stk)
    }

    /// A self-created Silicon waiting for the Carbon `custodian_uuid` to accept it (status
    /// `pending_custodian`, a pending `initial` custodian request addressed to the Carbon's uuid,
    /// 14 days), with an optional own webhook (secret `whsec_test`). Returns the Silicon and the
    /// request id.
    pub async fn pending_silicon(
        &self,
        custodian_uuid: &str,
        webhook_url: Option<&str>,
    ) -> (Account, uuid::Uuid) {
        let hash = self
            .state
            .keys
            .stk
            .hash(&crate::crypto::stk::generate())
            .unwrap_or_else(|e| panic!("hash STK: {e}"));
        let id = AccountId::new(AccountKind::Silicon, &format!("p-{}", rand_suffix()))
            .unwrap_or_else(|e| panic!("{e}"));
        let secret = webhook_url.map(|_| {
            self.state
                .keys
                .keyring
                .encrypt_str("whsec_test")
                .unwrap_or_else(|e| panic!("encrypt: {e}"))
        });
        let mut conn = self.conn().await;
        let account = crate::repo::accounts::create_silicon(
            &mut conn,
            &self.state.settings,
            NewSilicon {
                id,
                display_name: "Waiting Silicon".into(),
                pfp_url: None,
                timezone: "UTC".into(),
                status: AccountStatus::PendingCustodian,
                custodian_uuid: None,
                stk_hash: hash,
                webhook_url: webhook_url.map(str::to_string),
                webhook_secret_enc: secret,
                actor: "self".into(),
            },
        )
        .await
        .unwrap_or_else(|e| panic!("create pending Silicon: {e}"));
        let request_id = uuid::Uuid::now_v7();
        sqlx::query(
            "insert into custodian_requests (id, silicon_uuid, kind, to_uuid, status, expires_at) \
             values ($1, $2, 'initial', $3, 'pending', now() + interval '14 days')",
        )
        .bind(request_id)
        .bind(&account.uuid)
        .bind(custodian_uuid)
        .execute(&mut *conn)
        .await
        .unwrap_or_else(|e| panic!("custodian request: {e}"));
        (account, request_id)
    }

    /// An active app `<prefix>-<rand>` with a default sign-in config (email); returns it and its
    /// secret.
    pub async fn app(&self, prefix_: &str) -> (App, String) {
        self.app_owned(prefix_, None).await
    }

    /// Like [`TestContext::app`] with an owner.
    pub async fn app_owned(&self, prefix_: &str, owner_uuid: Option<&str>) -> (App, String) {
        let app_id = format!("{prefix_}-{}", rand_suffix());
        let secret = random_token(prefix::APP_SECRET);
        let mut conn = self.conn().await;
        let app = sqlx::query_as::<_, App>(concat!(
            "insert into apps (app_id, name, owner_uuid, secret_hash, status, source) values ($1, $2, $3, $4, 'active', 'fake') returning ",
            crate::app_columns!()
        ))
        .bind(&app_id)
        .bind(format!("Test app {prefix_}"))
        .bind(owner_uuid)
        .bind(self.state.keys.pepper.hash(&secret))
        .fetch_one(&mut *conn)
        .await
        .unwrap_or_else(|e| panic!("create test app: {e}"));
        let config = serde_json::json!({"redirect_uris": [format!("http://127.0.0.1:8593/{app_id}/callback")]});
        sqlx::query("insert into app_signin_configs (app_id, config) values ($1, $2)")
            .bind(&app_id)
            .bind(config)
            .execute(&mut *conn)
            .await
            .unwrap_or_else(|e| panic!("create test app config: {e}"));
        (app, secret)
    }

    /// Sets an app's webhook URL and returns the new signing secret.
    pub async fn set_app_webhook(&self, app_id: &str, url: &str) -> String {
        let (secret, enc) = crate::events::new_webhook_secret(&self.state.keys.keyring)
            .unwrap_or_else(|e| panic!("{e}"));
        let mut conn = self.conn().await;
        sqlx::query("update app_signin_configs set webhook_url = $2, webhook_secret_enc = $3 where app_id = $1")
            .bind(app_id)
            .bind(url)
            .bind(enc)
            .execute(&mut *conn)
            .await
            .unwrap_or_else(|e| panic!("set webhook: {e}"));
        secret
    }

    /// Records an active membership (as after a sign-in) with `scopes`.
    pub async fn membership(
        &self,
        app_id: &str,
        account_uuid: &str,
        scopes: &[Scope],
    ) -> crate::models::Membership {
        let mut conn = self.conn().await;
        crate::repo::memberships::upsert_signin(
            &mut conn,
            app_id,
            account_uuid,
            MembershipSource::Signin,
            scopes,
            crate::repo::memberships::GrantMode::Replace,
        )
        .await
        .unwrap_or_else(|e| panic!("membership: {e}"))
    }

    /// First-party tokens (aud = accounts) for an account, as after `accounts login`.
    pub async fn first_party_tokens(&self, account: &Account) -> TokenResponse {
        self.tokens_for(account, crate::FIRST_PARTY_APP_ID, &[Scope::Profile])
            .await
    }

    /// Tokens for an account at an app (no membership is recorded).
    pub async fn tokens_for(
        &self,
        account: &Account,
        app_id: &str,
        scopes: &[Scope],
    ) -> TokenResponse {
        let mut conn = self.conn().await;
        crate::repo::tokens::issue_tokens(
            &mut conn,
            &self.state.keys,
            &self.state.settings,
            crate::repo::tokens::IssueRequest {
                account,
                app_id,
                origin: TokenOrigin::CliCode,
                scopes,
                browser_session_id: None,
                label: Some("test"),
                ip: None,
                user_agent: None,
                nonce: None,
                auth_time: None,
            },
        )
        .await
        .unwrap_or_else(|e| panic!("issue tokens: {e}"))
    }

    /// A browser session for an account; returns the cookie value (use [`Req::session`]).
    pub async fn browser_session(&self, account: &Account) -> String {
        let mut conn = self.conn().await;
        crate::repo::sessions::create(
            &mut conn,
            &self.state.keys.pepper,
            &account.uuid,
            Some("127.0.0.1"),
            Some("test"),
        )
        .await
        .unwrap_or_else(|e| panic!("session: {e}"))
        .0
    }

    /// Messages in the outbox for an address, newest first: (purpose, text_body).
    pub async fn outbox(&self, to: &str) -> Vec<(String, String)> {
        let mut conn = self.conn().await;
        sqlx::query_as("select purpose, text_body from outbound_messages where to_address = $1 order by created_at desc")
            .bind(to)
            .fetch_all(&mut *conn)
            .await
            .unwrap_or_else(|e| panic!("outbox: {e}"))
    }

    /// Runs SQL (time travel, fixtures).
    pub async fn exec(&self, sql: &str) {
        let mut conn = self.conn().await;
        sqlx::raw_sql(sqlx::AssertSqlSafe(sql.to_string()))
            .execute(&mut *conn)
            .await
            .unwrap_or_else(|e| panic!("exec {sql}: {e}"));
    }
}
