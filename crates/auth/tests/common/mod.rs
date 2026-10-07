//! Shared helpers for the auth integration tests: a cookie-keeping "browser", app setup,
//! flow drivers, an in-process mock of Google and Apple ([`mock_oidc`]) and a provider front
//! that drops kept-alive connections ([`dropping_front`]).
#![allow(dead_code)]

pub mod dropping_front;
pub mod mock_oidc;

use std::collections::BTreeMap;

use accounts_core::AppState;
use accounts_core::crypto::pkce;
use accounts_core::models::App;
use accounts_core::test_support::{Req, Resp, TestContext};
use serde_json::{Value, json};

/// The PKCE verifier every helper flow uses (43+ characters).
pub const VERIFIER: &str = "test-verifier-0123456789-abcdefghijklmnopqrstuvwxyz";
/// The app `state` every helper flow sends.
pub const APP_STATE: &str = "app-state-123";

pub fn router() -> axum::Router<AppState> {
    accounts_auth::router()
}

/// A browser stand-in: keeps cookies set by responses and sends the site's Origin.
#[derive(Debug, Clone, Default)]
pub struct Browser {
    pub cookies: BTreeMap<String, String>,
    pub origin: Option<String>,
}

impl Browser {
    pub fn new(ctx: &TestContext) -> Browser {
        Browser {
            cookies: BTreeMap::new(),
            origin: Some(ctx.state.settings.public_origin.clone()),
        }
    }

    /// Adds this browser's cookies and Origin to a request.
    pub fn apply(&self, mut req: Req) -> Req {
        if !self.cookies.is_empty() {
            let header = self
                .cookies
                .iter()
                .map(|(k, v)| format!("{k}={v}"))
                .collect::<Vec<_>>()
                .join("; ");
            req = req.header("cookie", &header);
        }
        if let Some(o) = &self.origin {
            req = req.header("origin", o);
        }
        req
    }

    /// Stores the cookies a response sets (and forgets the ones it clears).
    pub fn absorb(&mut self, resp: &Resp) {
        for v in resp.headers.get_all("set-cookie") {
            let Ok(s) = v.to_str() else { continue };
            let Ok(c) = cookie::Cookie::parse(s.to_string()) else {
                continue;
            };
            let cleared = c.max_age().is_some_and(|m| m.is_zero()) || c.value().is_empty();
            if cleared {
                self.cookies.remove(c.name());
            } else {
                self.cookies
                    .insert(c.name().to_string(), c.value().to_string());
            }
        }
    }

    pub async fn call(&mut self, ctx: &TestContext, req: Req) -> Resp {
        let resp = ctx.call(router(), self.apply(req)).await;
        self.absorb(&resp);
        resp
    }

    pub async fn get(&mut self, ctx: &TestContext, path: &str) -> Resp {
        self.call(ctx, Req::get(path)).await
    }

    pub async fn post(&mut self, ctx: &TestContext, path: &str, body: Value) -> Resp {
        self.call(ctx, Req::post(path).json(body)).await
    }

    pub fn cookie(&self, name: &str) -> Option<&str> {
        self.cookies.get(name).map(String::as_str)
    }
}

/// The redirect URI the test apps register.
pub fn redirect_uri(app_id: &str) -> String {
    format!("http://127.0.0.1:8593/{app_id}/callback")
}

/// An app whose sign-in config is the default plus `patch` (top-level keys replace).
pub async fn app_with(ctx: &TestContext, prefix: &str, patch: Value) -> (App, String) {
    let (app, secret) = ctx.app(prefix).await;
    set_config(ctx, &app.app_id, patch).await;
    (app, secret)
}

/// Merges `patch` into an app's stored sign-in config (shallow: top-level keys replace).
pub async fn set_config(ctx: &TestContext, app_id: &str, patch: Value) {
    sqlx::query("update app_signin_configs set config = config || $2::jsonb, version = version + 1 where app_id = $1")
        .bind(app_id)
        .bind(patch)
        .execute(&ctx.state.db)
        .await
        .expect("update sign-in config");
}

/// Stores a bring-your-own Google client secret for an app.
pub async fn set_byo_google_secret(ctx: &TestContext, app_id: &str, secret: &str) {
    let enc = ctx.state.keys.keyring.encrypt_str(secret).expect("encrypt");
    sqlx::query("update app_signin_configs set google_client_secret_enc = $2 where app_id = $1")
        .bind(app_id)
        .bind(enc)
        .execute(&ctx.state.db)
        .await
        .expect("store BYO secret");
}

/// Stores a bring-your-own Apple .p8 key for an app.
pub async fn set_byo_apple_key(ctx: &TestContext, app_id: &str, pem: &str) {
    let enc = ctx.state.keys.keyring.encrypt_str(pem).expect("encrypt");
    sqlx::query("update app_signin_configs set apple_private_key_enc = $2 where app_id = $1")
        .bind(app_id)
        .bind(enc)
        .execute(&ctx.state.db)
        .await
        .expect("store BYO key");
}

/// `POST /v1/flows` for `app_id` with the test redirect URI, state, PKCE S256 and a browser
/// timezone; `extra` adds or overrides fields.
pub async fn start_flow(
    ctx: &TestContext,
    browser: &mut Browser,
    app_id: &str,
    extra: Value,
) -> Resp {
    let mut body = json!({
        "app_id": app_id,
        "redirect_uri": if app_id == "accounts" { format!("{}/", ctx.state.settings.public_url) } else { redirect_uri(app_id) },
        "state": APP_STATE,
        "code_challenge": pkce::s256_challenge(VERIFIER),
        "code_challenge_method": "S256",
        "timezone": "Europe/Paris",
    });
    if let (Some(b), Some(e)) = (body.as_object_mut(), extra.as_object()) {
        for (k, v) in e {
            b.insert(k.clone(), v.clone());
        }
    }
    browser.post(ctx, "/v1/flows", body).await
}

/// Starts a flow and asserts it was created; returns the flow JSON.
pub async fn new_flow(
    ctx: &TestContext,
    browser: &mut Browser,
    app_id: &str,
    extra: Value,
) -> Value {
    let r = start_flow(ctx, browser, app_id, extra).await;
    assert_eq!(r.status, 201, "create flow: {}", r.json);
    r.json["flow"].clone()
}

/// The newest 6-digit code sent to `to` (local delivery stores every message).
pub async fn last_code(ctx: &TestContext, to: &str) -> String {
    let outbox = ctx.outbox(to).await;
    let (_, text) = outbox
        .first()
        .unwrap_or_else(|| panic!("no message was sent to {to}"));
    accounts_core::delivery::extract_code(text).unwrap_or_else(|| panic!("no code in {text}"))
}

/// The flow's id.
pub fn id_of(flow: &Value) -> String {
    flow["id"].as_str().expect("flow id").to_string()
}

/// Sends an email code in a flow and verifies it; returns the verify response.
pub async fn email_and_verify(
    ctx: &TestContext,
    browser: &mut Browser,
    flow_id: &str,
    email: &str,
) -> Resp {
    let r = browser
        .post(
            ctx,
            &format!("/v1/flows/{flow_id}/email"),
            json!({"email": email}),
        )
        .await;
    assert_eq!(r.status, 200, "send email code: {}", r.json);
    assert_eq!(r.json["flow"]["step"], "verify_code");
    let code = last_code(ctx, &email.to_lowercase()).await;
    browser
        .post(
            ctx,
            &format!("/v1/flows/{flow_id}/verify"),
            json!({"code": code}),
        )
        .await
}

/// Signs a brand-new Carbon up through `app_id` with an email code, accepting the prefill
/// (with optional overrides); returns the flow JSON after sign-up.
pub async fn email_signup(
    ctx: &TestContext,
    browser: &mut Browser,
    app_id: &str,
    email: &str,
    overrides: Value,
) -> Value {
    let flow = new_flow(ctx, browser, app_id, json!({})).await;
    let id = id_of(&flow);
    let r = email_and_verify(ctx, browser, &id, email).await;
    assert_eq!(r.status, 200, "verify: {}", r.json);
    assert_eq!(r.json["flow"]["step"], "signup", "{}", r.json);
    let r = browser
        .post(ctx, &format!("/v1/flows/{id}/signup"), overrides)
        .await;
    assert_eq!(r.status, 200, "signup: {}", r.json);
    r.json["flow"].clone()
}

/// `POST /v1/flows/{id}/details/continue` with these optional details ticked.
pub async fn continue_page(
    ctx: &TestContext,
    b: &mut Browser,
    flow_id: &str,
    share: &[&str],
) -> Resp {
    b.post(
        ctx,
        &format!("/v1/flows/{flow_id}/details/continue"),
        json!({"share": share}),
    )
    .await
}

/// Continues every details page (ticking the optional details in `share` where a page offers
/// them) and approves the review page; returns the last response (the completed flow, or the
/// first refusal).
pub async fn finish_pages(
    ctx: &TestContext,
    b: &mut Browser,
    flow_id: &str,
    share: &[&str],
) -> Resp {
    let mut r = b.get(ctx, &format!("/v1/flows/{flow_id}")).await;
    for _ in 0..12 {
        if r.status != 200 {
            return r;
        }
        match r.json["flow"]["step"].as_str() {
            Some("details") => {
                let offered: Vec<String> = r.json["flow"]["details"]["fields"]
                    .as_array()
                    .map(|fields| {
                        fields
                            .iter()
                            .filter(|f| f["mode"] == "optional")
                            .filter_map(|f| f["field"].as_str())
                            .filter(|f| share.contains(f))
                            .map(str::to_string)
                            .collect()
                    })
                    .unwrap_or_default();
                let offered: Vec<&str> = offered.iter().map(String::as_str).collect();
                r = continue_page(ctx, b, flow_id, &offered).await;
            }
            Some("review") => {
                r = b
                    .post(
                        ctx,
                        &format!("/v1/flows/{flow_id}/review"),
                        json!({"approve": true}),
                    )
                    .await;
            }
            _ => return r,
        }
    }
    r
}

/// The `(field, mode, shared, missing)` rows of the details page in a flow view.
pub fn page_fields(flow: &Value) -> Vec<(String, String, bool, bool)> {
    flow["details"]["fields"]
        .as_array()
        .map(|fields| {
            fields
                .iter()
                .map(|f| {
                    (
                        f["field"].as_str().unwrap_or_default().to_string(),
                        f["mode"].as_str().unwrap_or_default().to_string(),
                        f["shared"].as_bool().unwrap_or_default(),
                        f["missing"].as_bool().unwrap_or_default(),
                    )
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The `code` query parameter of a redirect.
pub fn code_of(redirect_to: &str) -> String {
    query_param(redirect_to, "code").unwrap_or_else(|| panic!("no code in {redirect_to}"))
}

/// A query parameter of a URL.
pub fn query_param(url: &str, name: &str) -> Option<String> {
    let u = url::Url::parse(url).ok()?;
    u.query_pairs()
        .find(|(k, _)| k == name)
        .map(|(_, v)| v.to_string())
}

/// Redeems an authorization code the way the token endpoint does (PKCE with [`VERIFIER`]).
pub async fn redeem(
    ctx: &TestContext,
    code: &str,
    app_id: &str,
) -> accounts_core::repo::tokens::AuthCode {
    accounts_core::repo::tokens::consume_code(
        &ctx.state.db,
        &ctx.state.keys.pepper,
        code,
        app_id,
        Some(&redirect_uri(app_id)),
        Some(VERIFIER),
    )
    .await
    .unwrap_or_else(|e| panic!("redeem code: {:?}", e))
}

/// A random lowercase email at example.test.
pub fn random_email(tag: &str) -> String {
    format!(
        "{tag}-{}@example.test",
        accounts_core::test_support::rand_suffix()
    )
}

/// Runs a scalar SQL query (assertions).
pub async fn scalar_i64(ctx: &TestContext, sql: &'static str, bind: &str) -> i64 {
    sqlx::query_scalar::<_, i64>(sql)
        .bind(bind)
        .fetch_one(&ctx.state.db)
        .await
        .expect("scalar query")
}

/// An account an app import created and nobody finished yet (`unclaimed`): every email and
/// phone unverified, the first of each primary, as `apps` imports do. Returns its uuid.
pub async fn unclaimed_import(ctx: &TestContext, emails: &[&str], phones: &[&str]) -> String {
    use accounts_core::ids::AccountId;
    use accounts_core::models::{AccountKind, AccountStatus};
    use accounts_core::repo::accounts::{NewCarbon, NewContact};
    let contact = |v: &&str| NewContact {
        value: v.to_string(),
        verified_via: None,
    };
    let mut conn = ctx.conn().await;
    accounts_core::repo::accounts::create_carbon(
        &mut conn,
        &ctx.state.settings,
        NewCarbon {
            id: AccountId::parse_for_kind(
                &format!("imp-{}", accounts_core::test_support::rand_suffix()),
                AccountKind::Carbon,
            )
            .expect("id"),
            display_name: "Imported Person".into(),
            pfp_url: None,
            dob: time::macros::date!(1991 - 02 - 03),
            timezone: "America/Chicago".into(),
            status: AccountStatus::Unclaimed,
            emails: emails.iter().map(contact).collect(),
            phones: phones.iter().map(contact).collect(),
            actor: "import".into(),
        },
    )
    .await
    .expect("unclaimed account")
    .uuid
}

/// An unverified email row on an account, as imports left them on accounts claimed before
/// claims removed them (no code ever proved it).
pub async fn unproven_email(ctx: &TestContext, account_uuid: &str, email: &str) {
    sqlx::query(
        "insert into account_emails (email, account_uuid, is_primary) values ($1, $2, false)",
    )
    .bind(email)
    .bind(account_uuid)
    .execute(&ctx.state.db)
    .await
    .expect("unverified email row");
}

/// `(email, verified)` rows of an account, by email.
pub async fn emails_of(ctx: &TestContext, account_uuid: &str) -> Vec<(String, bool)> {
    sqlx::query_as(
        "select email, verified_at is not null from account_emails where account_uuid = $1 order by email",
    )
    .bind(account_uuid)
    .fetch_all(&ctx.state.db)
    .await
    .expect("emails")
}
