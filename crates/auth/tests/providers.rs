//! Google and Apple sign-in against an in-process mock of both providers: managed and
//! bring-your-own credentials, PKCE, Apple's form_post (parked, then a same-site GET) and ES256
//! client secret, id_token checks, identity linking, and the rule that only the browser that
//! started a sign-in can deliver its answer (a forwarded Google/Apple link signs nobody in).

mod common;

use accounts_core::Settings;
use accounts_core::test_support::{Req, Resp, TestContext};
use common::mock_oidc::{self, MockOidc};
use common::*;
use serde_json::{Value, json};

async fn setup() -> (TestContext, MockOidc) {
    let mock = MockOidc::start().await;
    let mut s = Settings::for_tests();
    mock.configure(&mut s);
    (TestContext::with_settings(s).await, mock)
}

fn identity(tag: &str) -> Value {
    let sub = format!("{}{}", tag, accounts_core::test_support::rand_suffix());
    json!({"sub": sub, "email": format!("{sub}@example.test"), "email_verified": true})
}

async fn oauth_start(ctx: &TestContext, b: &mut Browser, flow_id: &str, provider: &str) -> Resp {
    b.post(
        ctx,
        &format!("/v1/flows/{flow_id}/oauth/{provider}"),
        json!({}),
    )
    .await
}

/// Google redirects the browser back with a GET: a top-level navigation, so the browser's
/// SameSite=Lax cookies (`sa_flow`) come along.
async fn google_callback(ctx: &TestContext, b: &mut Browser, code: &str, state: &str) -> Resp {
    let qs = serde_urlencoded::to_string([
        ("code", code),
        ("state", state),
        ("scope", "openid email profile"),
    ])
    .expect("qs");
    b.call(
        ctx,
        Req::get(&format!("/v1/oauth/callback/google?{qs}")).header("accept", "text/html"),
    )
    .await
}

/// Apple's cross-site form_post: no cookies, the provider's Origin.
async fn apple_post(ctx: &TestContext, mock: &MockOidc, fields: &[(&str, &str)]) -> Resp {
    ctx.call(
        router(),
        Req::post("/v1/oauth/callback/apple")
            .form(fields)
            .header("origin", &mock.base)
            .header("accept", "text/html"),
    )
    .await
}

/// The same-site path a parked form_post continues at (the 303's Location).
fn continue_path(ctx: &TestContext, r: &Resp) -> String {
    assert_eq!(r.status, 303, "{}", String::from_utf8_lossy(&r.body));
    assert!(
        r.headers.get("set-cookie").is_none(),
        "the callback never sets cookies"
    );
    assert_eq!(r.headers["cache-control"], "no-store");
    let location = r.headers["location"].to_str().expect("location");
    let path = location
        .strip_prefix(&ctx.state.settings.public_url)
        .unwrap_or_else(|| panic!("{location} is not on the site"));
    assert!(
        path.starts_with("/v1/oauth/callback/apple?ticket="),
        "{path}"
    );
    path.to_string()
}

/// Apple's form_post as a browser does it: the cookieless POST parks the answer, then the
/// browser follows the 303 with a GET that carries its cookies.
async fn apple_callback(
    ctx: &TestContext,
    b: &mut Browser,
    mock: &MockOidc,
    fields: &[(&str, &str)],
) -> Resp {
    let r = apple_post(ctx, mock, fields).await;
    let path = continue_path(ctx, &r);
    b.call(ctx, Req::get(&path).header("accept", "text/html"))
        .await
}

fn assert_redirect_to_flow(ctx: &TestContext, r: &Resp, flow_id: &str) {
    assert_eq!(r.status, 302, "{}", String::from_utf8_lossy(&r.body));
    assert_eq!(
        r.headers["location"],
        format!("{}/authorize/flow/{flow_id}", ctx.state.settings.public_url).as_str()
    );
    assert!(
        r.headers.get("set-cookie").is_none(),
        "the callback never sets cookies"
    );
}

#[tokio::test]
async fn google_new_identity_signs_up_with_its_name_and_picture() {
    let (ctx, mock) = setup().await;
    let (app, _) = app_with(
        &ctx,
        "commit",
        json!({"methods": {"email": true, "google": true}}),
    )
    .await;
    let mut b = Browser::new(&ctx);
    let f = new_flow(
        &ctx,
        &mut b,
        &app.app_id,
        json!({"login_hint": "ada@example.test"}),
    )
    .await;
    assert_eq!(f["methods"], json!(["google", "email"]));
    let id = id_of(&f);
    let r = oauth_start(&ctx, &mut b, &id, "google").await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(r.headers["cache-control"], "no-store");
    let url = r.json["authorize_url"].as_str().expect("url").to_string();
    assert!(url.starts_with(&format!("{}/google/authorize?", mock.base)));
    assert_eq!(
        query_param(&url, "client_id").as_deref(),
        Some(mock_oidc::MANAGED_GOOGLE_ID)
    );
    assert_eq!(
        query_param(&url, "redirect_uri").as_deref(),
        Some(format!("{}/v1/oauth/callback/google", ctx.state.settings.public_url).as_str())
    );
    assert_eq!(
        query_param(&url, "scope").as_deref(),
        Some("openid email profile")
    );
    assert_eq!(
        query_param(&url, "code_challenge_method").as_deref(),
        Some("S256")
    );
    assert_eq!(
        query_param(&url, "prompt").as_deref(),
        Some("select_account")
    );
    assert_eq!(
        query_param(&url, "login_hint").as_deref(),
        Some("ada@example.test")
    );
    assert!(
        query_param(&url, "state")
            .expect("state")
            .starts_with(&format!("{id}."))
    );
    assert!(query_param(&url, "nonce").is_some_and(|n| n.len() >= 32));

    let who = json!({"sub": "g-ada-1", "email": "Ada.Lovelace@Example.test", "email_verified": true, "name": "Ada Lovelace", "picture": "https://lh3.googleusercontent.test/ada.png"});
    let (code, state) = mock.authorize(&url, who);
    let r = google_callback(&ctx, &mut b, &code, &state).await;
    assert_redirect_to_flow(&ctx, &r, &id);
    assert_eq!(r.headers["cache-control"], "no-store");

    // The bound browser claims the outcome.
    let r = b.get(&ctx, &format!("/v1/flows/{id}")).await;
    assert_eq!(r.status, 200, "{}", r.json);
    let s = &r.json["flow"]["signup"];
    assert_eq!(r.json["flow"]["step"], "signup");
    assert_eq!(s["provider"], "google");
    assert_eq!(s["display_name"], "Ada Lovelace");
    assert_eq!(s["email"], "ada.lovelace@example.test");
    assert_eq!(
        s["pfp_url"],
        accounts_auth::suggest::default_pfp_preview(&ctx.state.settings).as_str(),
        "the prefilled photo is our default Carbon photo from Iris"
    );
    assert_eq!(
        s["provider_pfp_url"], "https://lh3.googleusercontent.test/ada.png",
        "Google's picture is offered next to it"
    );
    assert!(s["id"].as_str().expect("id").starts_with("c:ada-lovelace"));
    assert!(b.cookie("sa_signup").is_some());

    let r = b
        .post(&ctx, &format!("/v1/flows/{id}/signup"), json!({}))
        .await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(r.json["flow"]["step"], "consent");
    let uuid = r.json["flow"]["signed_in_as"]["uuid"]
        .as_str()
        .expect("uuid")
        .to_string();
    assert_eq!(
        r.json["flow"]["signed_in_as"]["pfp_url"],
        accounts_core::pfp::default_pfp_url(
            &ctx.state.settings.iris_base_url,
            accounts_core::models::AccountKind::Carbon,
            &uuid
        )
        .as_str(),
        "accepting the prefill keeps our default photo"
    );
    let via: String =
        sqlx::query_scalar("select verified_via from account_emails where account_uuid = $1")
            .bind(&uuid)
            .fetch_one(&ctx.state.db)
            .await
            .expect("email");
    assert_eq!(via, "google");
    let (client, subject): (String, String) =
        sqlx::query_as("select client_id, subject from identities where account_uuid = $1")
            .bind(&uuid)
            .fetch_one(&ctx.state.db)
            .await
            .expect("identity");
    assert_eq!(
        (client.as_str(), subject.as_str()),
        (mock_oidc::MANAGED_GOOGLE_ID, "g-ada-1")
    );
    let r = b
        .post(
            &ctx,
            &format!("/v1/flows/{id}/consent"),
            json!({"approve": true}),
        )
        .await;
    assert_eq!(r.json["flow"]["step"], "complete");
    let method: String =
        sqlx::query_scalar("select method from signin_history where account_uuid = $1")
            .bind(&uuid)
            .fetch_one(&ctx.state.db)
            .await
            .expect("history");
    assert_eq!(method, "google");

    // The answer can't be used twice.
    let r = google_callback(&ctx, &mut b, &code, &state).await;
    assert_eq!(r.status, 400);
    let html = String::from_utf8_lossy(&r.body);
    assert!(
        html.contains("data-error=\"invalid_state\"") && html.contains("Powered by"),
        "{html}"
    );
}

#[tokio::test]
async fn known_identities_and_verified_emails_sign_in_existing_accounts() {
    let (ctx, mock) = setup().await;
    let carbon = ctx.carbon().await;
    let email = format!("{}@example.test", carbon.id().trim_start_matches("c:"));
    let (app, _) = app_with(&ctx, "commit", json!({"methods": {"google": true}})).await;
    let sub = format!("g-{}", accounts_core::test_support::rand_suffix());

    for (round, email_claim) in [
        (1, email.clone()),
        (2, "renamed@elsewhere.test".to_string()),
    ] {
        let mut b = Browser::new(&ctx);
        let id = id_of(&new_flow(&ctx, &mut b, &app.app_id, json!({})).await);
        let url = oauth_start(&ctx, &mut b, &id, "google").await.json["authorize_url"]
            .as_str()
            .expect("u")
            .to_string();
        let (code, state) = mock.authorize(
            &url,
            json!({"sub": sub, "email": email_claim, "email_verified": true}),
        );
        assert_redirect_to_flow(
            &ctx,
            &google_callback(&ctx, &mut b, &code, &state).await,
            &id,
        );
        let r = b.get(&ctx, &format!("/v1/flows/{id}")).await;
        assert_eq!(r.status, 200, "{}", r.json);
        assert_eq!(
            r.json["flow"]["signed_in_as"]["uuid"],
            carbon.uuid.as_str(),
            "round {round}"
        );
        assert!(
            b.cookie("sa_session").is_some(),
            "round {round}: signed in when the bound browser claimed it"
        );
        if round == 1 {
            assert_eq!(r.json["flow"]["step"], "consent");
            let linked = scalar_i64(
                &ctx,
                "select count(*) from identities where account_uuid = $1",
                &carbon.uuid,
            )
            .await;
            assert_eq!(linked, 1, "the identity was linked by its verified email");
            b.post(
                &ctx,
                &format!("/v1/flows/{id}/consent"),
                json!({"approve": true}),
            )
            .await;
        } else {
            assert_eq!(
                r.json["flow"]["step"], "complete",
                "a known identity, nothing new to share"
            );
        }
    }
}

#[tokio::test]
async fn apple_form_post_uses_the_es256_secret_and_the_first_login_name() {
    let (ctx, mock) = setup().await;
    let (app, _) = app_with(&ctx, "waveform", json!({"methods": {"apple": true}})).await;
    let mut b = Browser::new(&ctx);
    let id = id_of(&new_flow(&ctx, &mut b, &app.app_id, json!({})).await);
    let url = oauth_start(&ctx, &mut b, &id, "apple").await.json["authorize_url"]
        .as_str()
        .expect("u")
        .to_string();
    assert_eq!(
        query_param(&url, "response_mode").as_deref(),
        Some("form_post")
    );
    assert_eq!(query_param(&url, "scope").as_deref(), Some("name email"));
    assert!(query_param(&url, "code_challenge").is_none());
    assert_eq!(
        query_param(&url, "client_id").as_deref(),
        Some(mock_oidc::MANAGED_APPLE_ID)
    );

    let who = identity("apple-");
    let email = who["email"].as_str().expect("e").to_string();
    let (code, state) = mock.authorize(&url, who);
    let user = json!({"name": {"firstName": "Katherine", "lastName": "Johnson"}, "email": email})
        .to_string();
    let r = apple_callback(
        &ctx,
        &mut b,
        &mock,
        &[("code", &code), ("state", &state), ("user", &user)],
    )
    .await;
    assert_redirect_to_flow(&ctx, &r, &id);
    assert_eq!(
        mock.token_requests().len(),
        1,
        "the ES256 client secret was accepted"
    );

    let r = b.get(&ctx, &format!("/v1/flows/{id}")).await;
    let s = &r.json["flow"]["signup"];
    assert_eq!(s["display_name"], "Katherine Johnson");
    assert_eq!(s["provider"], "apple");
    let r = b
        .post(&ctx, &format!("/v1/flows/{id}/signup"), json!({}))
        .await;
    assert_eq!(r.status, 200, "{}", r.json);
    let uuid = r.json["flow"]["signed_in_as"]["uuid"]
        .as_str()
        .expect("uuid")
        .to_string();
    let via: String =
        sqlx::query_scalar("select verified_via from account_emails where account_uuid = $1")
            .bind(&uuid)
            .fetch_one(&ctx.state.db)
            .await
            .expect("email");
    assert_eq!(via, "apple");
}

#[tokio::test]
async fn bring_your_own_credentials_are_used_for_their_app() {
    let (ctx, mock) = setup().await;
    mock.register_google("acme-notes.apps.googleusercontent.com", "acme-secret");
    mock.register_apple("test.orbit-games.signin", "ORBITTEAM1", "ORBITKEY01");
    let (acme, _) = app_with(
        &ctx,
        "acme-notes",
        json!({"methods": {"google": true}, "google": {"mode": "byo", "client_id": "acme-notes.apps.googleusercontent.com", "prompt": null, "hosted_domain": null}}),
    )
    .await;
    let (orbit, _) = app_with(
        &ctx,
        "orbit-games",
        json!({"methods": {"apple": true}, "apple": {"mode": "byo", "services_id": "test.orbit-games.signin", "team_id": "ORBITTEAM1", "key_id": "ORBITKEY01"}}),
    )
    .await;
    let mut b = Browser::new(&ctx);

    // Without its secret the app's Google can't work.
    let id = id_of(&new_flow(&ctx, &mut b, &acme.app_id, json!({})).await);
    let r = oauth_start(&ctx, &mut b, &id, "google").await;
    assert_eq!(r.status, 503);
    assert_eq!(r.error_code(), Some("provider_not_configured"));
    assert!(
        r.json["error"]["message"]
            .as_str()
            .expect("m")
            .contains("client secret")
    );

    set_byo_google_secret(&ctx, &acme.app_id, "acme-secret").await;
    let url = oauth_start(&ctx, &mut b, &id, "google").await.json["authorize_url"]
        .as_str()
        .expect("u")
        .to_string();
    assert_eq!(
        query_param(&url, "client_id").as_deref(),
        Some("acme-notes.apps.googleusercontent.com")
    );
    assert!(query_param(&url, "prompt").is_none());
    let (code, state) = mock.authorize(&url, identity("acme-"));
    assert_redirect_to_flow(
        &ctx,
        &google_callback(&ctx, &mut b, &code, &state).await,
        &id,
    );
    let r = b.get(&ctx, &format!("/v1/flows/{id}")).await;
    assert_eq!(r.json["flow"]["step"], "signup", "{}", r.json);
    assert_eq!(
        mock.token_requests().last().expect("request")["client_id"],
        "acme-notes.apps.googleusercontent.com"
    );

    set_byo_apple_key(&ctx, &orbit.app_id, mock_oidc::EC_PRIVATE).await;
    let mut b = Browser::new(&ctx);
    let id = id_of(&new_flow(&ctx, &mut b, &orbit.app_id, json!({})).await);
    let url = oauth_start(&ctx, &mut b, &id, "apple").await.json["authorize_url"]
        .as_str()
        .expect("u")
        .to_string();
    assert_eq!(
        query_param(&url, "client_id").as_deref(),
        Some("test.orbit-games.signin")
    );
    let (code, state) = mock.authorize(&url, identity("orbit-"));
    assert_redirect_to_flow(
        &ctx,
        &apple_callback(&ctx, &mut b, &mock, &[("code", &code), ("state", &state)]).await,
        &id,
    );
    let r = b.get(&ctx, &format!("/v1/flows/{id}")).await;
    assert_eq!(r.json["flow"]["step"], "signup", "{}", r.json);
    assert_eq!(
        mock.token_requests().last().expect("request")["client_id"],
        "test.orbit-games.signin"
    );
}

#[tokio::test]
async fn managed_providers_need_managed_credentials() {
    let ctx = TestContext::new().await; // no ACCOUNTS_GOOGLE_* / ACCOUNTS_APPLE_*
    let (app, _) = app_with(
        &ctx,
        "commit",
        json!({"methods": {"email": true, "google": true, "apple": true}}),
    )
    .await;
    let mut b = Browser::new(&ctx);
    let f = new_flow(&ctx, &mut b, &app.app_id, json!({})).await;
    assert_eq!(
        f["methods"],
        json!(["email"]),
        "buttons that would only fail are hidden"
    );
    for p in ["google", "apple"] {
        let r = oauth_start(&ctx, &mut b, &id_of(&f), p).await;
        assert_eq!(r.status, 503, "{p}");
        assert_eq!(r.error_code(), Some("provider_not_configured"));
    }
    let r = oauth_start(&ctx, &mut b, &id_of(&f), "github").await;
    assert_eq!(r.status, 404);
    assert_eq!(r.error_code(), Some("unknown_provider"));
    let (email_only, _) = ctx.app("remind").await;
    let f = new_flow(&ctx, &mut b, &email_only.app_id, json!({})).await;
    let r = oauth_start(&ctx, &mut b, &id_of(&f), "google").await;
    assert_eq!(r.status, 403);
    assert_eq!(r.error_code(), Some("method_not_enabled"));
}

/// Starts Google sign-in for a fresh flow and returns (browser, flow id, authorize URL).
async fn google_leg(ctx: &TestContext, app_id: &str) -> (Browser, String, String) {
    let mut b = Browser::new(ctx);
    let id = id_of(&new_flow(ctx, &mut b, app_id, json!({})).await);
    let r = oauth_start(ctx, &mut b, &id, "google").await;
    assert_eq!(r.status, 200, "{}", r.json);
    let url = r.json["authorize_url"].as_str().expect("u").to_string();
    (b, id, url)
}

async fn flow_error(ctx: &TestContext, b: &mut Browser, id: &str) -> Value {
    let r = b.get(ctx, &format!("/v1/flows/{id}")).await;
    assert_eq!(r.json["flow"]["step"], "choose_method", "{}", r.json);
    r.json["flow"]["error"].clone()
}

#[tokio::test]
async fn provider_failures_are_carried_on_the_flow() {
    let (ctx, mock) = setup().await;
    let (app, _) = app_with(
        &ctx,
        "commit",
        json!({"methods": {"email": true, "google": true}}),
    )
    .await;

    // Cancelled at Google.
    let (mut b, id, url) = google_leg(&ctx, &app.app_id).await;
    let state = query_param(&url, "state").expect("state");
    let qs = serde_urlencoded::to_string([("error", "access_denied"), ("state", state.as_str())])
        .expect("qs");
    let r = b
        .call(&ctx, Req::get(&format!("/v1/oauth/callback/google?{qs}")))
        .await;
    assert_redirect_to_flow(&ctx, &r, &id);
    assert_eq!(
        flow_error(&ctx, &mut b, &id).await["code"],
        "provider_cancelled"
    );

    // An unverified email.
    let (mut b, id, url) = google_leg(&ctx, &app.app_id).await;
    let mut who = identity("unverified-");
    who["email_verified"] = json!(false);
    let (code, state) = mock.authorize(&url, who);
    google_callback(&ctx, &mut b, &code, &state).await;
    let e = flow_error(&ctx, &mut b, &id).await;
    assert_eq!(e["code"], "email_not_verified");
    assert!(e["message"].as_str().expect("m").contains("not verified"));

    // A replayed id_token (wrong nonce) and a forged one (unknown signer).
    for (tamper, expect) in [("nonce", "nonce"), ("key", "signature")] {
        let (mut b, id, url) = google_leg(&ctx, &app.app_id).await;
        let (code, state) = mock.authorize(&url, identity("tamper-"));
        if tamper == "nonce" {
            mock.lock().tamper_next = Some(json!({"nonce": "someone-elses"}));
        } else {
            mock.lock().wrong_key_next = true;
        }
        google_callback(&ctx, &mut b, &code, &state).await;
        let e = flow_error(&ctx, &mut b, &id).await;
        assert_eq!(e["code"], "provider_token_invalid");
        assert!(e["message"].as_str().expect("m").contains(expect), "{e}");
    }

    // The token endpoint refuses.
    let (mut b, id, url) = google_leg(&ctx, &app.app_id).await;
    let (code, state) = mock.authorize(&url, identity("refused-"));
    mock.lock().fail_next = Some((
        400,
        json!({"error": "invalid_grant", "error_description": "Bad Request"}),
    ));
    google_callback(&ctx, &mut b, &code, &state).await;
    let e = flow_error(&ctx, &mut b, &id).await;
    assert_eq!(e["code"], "provider_error");
    assert!(e["message"].as_str().expect("m").contains("invalid_grant"));

    // After an error the Carbon can simply try again.
    let url = oauth_start(&ctx, &mut b, &id, "google").await.json["authorize_url"]
        .as_str()
        .expect("u")
        .to_string();
    let (code, state) = mock.authorize(&url, identity("retry-"));
    google_callback(&ctx, &mut b, &code, &state).await;
    let r = b.get(&ctx, &format!("/v1/flows/{id}")).await;
    assert_eq!(r.json["flow"]["step"], "signup");
    assert_eq!(r.json["flow"]["error"], Value::Null);
}

#[tokio::test]
async fn forged_or_foreign_states_are_refused_without_touching_the_flow() {
    let (ctx, mock) = setup().await;
    let (app, _) = app_with(&ctx, "commit", json!({"methods": {"google": true}})).await;
    let r = ctx
        .call(
            router(),
            Req::get("/v1/oauth/callback/google?code=x&state=nonsense")
                .header("accept", "application/json"),
        )
        .await;
    assert_eq!(r.status, 400);
    assert_eq!(r.error_code(), Some("invalid_state"));
    let r = ctx
        .call(router(), Req::get("/v1/oauth/callback/google?code=x"))
        .await;
    assert_eq!(r.status, 400);
    assert!(String::from_utf8_lossy(&r.body).contains("invalid_state"));
    let r = ctx
        .call(
            router(),
            Req::get("/v1/oauth/callback/github?code=x&state=y"),
        )
        .await;
    assert_eq!(r.status, 404);

    let (mut b, id, url) = google_leg(&ctx, &app.app_id).await;
    let forged = format!("{id}.{}", "A".repeat(43));
    let r = ctx
        .call(
            router(),
            Req::get(&format!("/v1/oauth/callback/google?code=x&state={forged}"))
                .header("accept", "application/json"),
        )
        .await;
    assert_eq!(r.error_code(), Some("invalid_state"));
    // An Apple answer can't complete a Google leg.
    let state = query_param(&url, "state").expect("state");
    let r = ctx
        .call(
            router(),
            Req::post("/v1/oauth/callback/apple")
                .form(&[("code", "x"), ("state", &state)])
                .header("accept", "application/json"),
        )
        .await;
    assert_eq!(r.error_code(), Some("invalid_state"));
    // The real answer still works.
    let (code, state) = mock.authorize(&url, identity("real-"));
    assert_redirect_to_flow(
        &ctx,
        &google_callback(&ctx, &mut b, &code, &state).await,
        &id,
    );
    let r = b.get(&ctx, &format!("/v1/flows/{id}")).await;
    assert_eq!(r.json["flow"]["step"], "signup");
}

/// The answer page a browser gets when it delivers someone else's provider answer.
fn assert_answer_refused(r: &Resp) {
    assert_eq!(r.status, 403, "{}", String::from_utf8_lossy(&r.body));
    let html = String::from_utf8_lossy(&r.body);
    assert!(html.contains("data-error=\"flow_not_bound\""), "{html}");
    assert!(
        r.headers.get("set-cookie").is_none(),
        "nothing is set in the browser that delivered it"
    );
}

#[tokio::test]
async fn a_stolen_provider_answer_cannot_sign_in_another_browser() {
    let (ctx, mock) = setup().await;
    let (app, _) = app_with(&ctx, "commit", json!({"methods": {"google": true}})).await;
    // The attacker starts a sign-in and gets Google's answer for their own Google account...
    let (mut attacker, id, url) = google_leg(&ctx, &app.app_id).await;
    let (code, state) = mock.authorize(&url, identity("attacker-"));
    // ...and makes the victim's browser deliver it (login CSRF).
    let mut victim = Browser::new(&ctx);
    let r = google_callback(&ctx, &mut victim, &code, &state).await;
    assert_answer_refused(&r);
    assert!(victim.cookies.is_empty());
    let r = victim.get(&ctx, &format!("/v1/flows/{id}")).await;
    assert_eq!(r.status, 403);
    assert_eq!(r.error_code(), Some("flow_not_bound"));
    assert!(
        mock.token_requests().is_empty(),
        "the code was never exchanged"
    );
    // The answer is used up: it can't be replayed in the browser that started the sign-in.
    assert_eq!(
        flow_error(&ctx, &mut attacker, &id).await["code"],
        "provider_answer_elsewhere"
    );
    let r = google_callback(&ctx, &mut attacker, &code, &state).await;
    assert_eq!(r.status, 400);
    assert!(String::from_utf8_lossy(&r.body).contains("invalid_state"));
}

#[tokio::test]
async fn a_forwarded_google_link_cannot_sign_in_its_sender() {
    let (ctx, mock) = setup().await;
    let victim = ctx.carbon().await;
    let victim_email = format!("{}@example.test", victim.id().trim_start_matches("c:"));
    // The attacker starts a sign-in to the account site itself and a Google leg...
    let mut attacker = Browser::new(&ctx);
    let id = id_of(&new_flow(&ctx, &mut attacker, "accounts", json!({})).await);
    let r = oauth_start(&ctx, &mut attacker, &id, "google").await;
    assert_eq!(r.status, 200, "{}", r.json);
    let url = r.json["authorize_url"].as_str().expect("url").to_string();
    // ...and sends the genuine Google link to the victim, who picks their own Google account.
    let (code, state) = mock.authorize(
        &url,
        json!({"sub": "g-victim-77", "email": victim_email, "email_verified": true, "name": "Victim"}),
    );
    let mut victims_browser = Browser::new(&ctx);
    let r = google_callback(&ctx, &mut victims_browser, &code, &state).await;
    assert_answer_refused(&r);
    assert!(victims_browser.cookies.is_empty());

    // The attacker's browser gets nothing: no session, no sign-up, no identity link.
    let r = attacker.get(&ctx, &format!("/v1/flows/{id}")).await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(r.json["flow"]["step"], "choose_method");
    assert_eq!(r.json["flow"]["signed_in_as"], Value::Null);
    assert_eq!(r.json["flow"]["error"]["code"], "provider_answer_elsewhere");
    assert!(attacker.cookie("sa_session").is_none() && attacker.cookie("sa_signup").is_none());
    let r = attacker.get(&ctx, "/v1/session").await;
    assert_eq!(r.status, 401);
    assert!(
        mock.token_requests().is_empty(),
        "the code was never exchanged"
    );
    let linked = scalar_i64(
        &ctx,
        "select count(*) from identities where account_uuid = $1",
        &victim.uuid,
    )
    .await;
    assert_eq!(linked, 0);
    // Replaying the victim's answer in the attacker's own browser doesn't work either.
    let r = google_callback(&ctx, &mut attacker, &code, &state).await;
    assert_eq!(r.status, 400);
    assert!(String::from_utf8_lossy(&r.body).contains("invalid_state"));
    assert!(attacker.cookie("sa_session").is_none());
}

#[tokio::test]
async fn a_forwarded_apple_link_cannot_sign_in_its_sender() {
    let (ctx, mock) = setup().await;
    let (app, _) = app_with(&ctx, "waveform", json!({"methods": {"apple": true}})).await;
    let mut attacker = Browser::new(&ctx);
    let id = id_of(&new_flow(&ctx, &mut attacker, &app.app_id, json!({})).await);
    let url = oauth_start(&ctx, &mut attacker, &id, "apple").await.json["authorize_url"]
        .as_str()
        .expect("u")
        .to_string();
    let (code, state) = mock.authorize(&url, identity("apple-victim-"));
    // Apple posts the victim's answer from the victim's browser: parked, then the victim's
    // browser follows the 303 with its own cookies, which don't match.
    let r = apple_post(&ctx, &mock, &[("code", &code), ("state", &state)]).await;
    let path = continue_path(&ctx, &r);
    let mut victims_browser = Browser::new(&ctx);
    let _ = new_flow(&ctx, &mut victims_browser, &app.app_id, json!({})).await;
    let r = victims_browser
        .call(&ctx, Req::get(&path).header("accept", "text/html"))
        .await;
    assert_answer_refused(&r);
    assert!(victims_browser.cookie("sa_session").is_none());
    assert!(
        mock.token_requests().is_empty(),
        "the code was never exchanged"
    );
    // The ticket and the answer are used up for the browser that started it too.
    let r = attacker
        .call(&ctx, Req::get(&path).header("accept", "application/json"))
        .await;
    assert_eq!(r.status, 400);
    assert_eq!(r.error_code(), Some("invalid_state"));
    let r = apple_post(&ctx, &mock, &[("code", &code), ("state", &state)]).await;
    assert_eq!(r.status, 400);
    let r = attacker.get(&ctx, &format!("/v1/flows/{id}")).await;
    assert_eq!(r.json["flow"]["step"], "choose_method");
    assert_eq!(r.json["flow"]["error"]["code"], "provider_answer_elsewhere");
    assert!(attacker.cookie("sa_session").is_none() && attacker.cookie("sa_signup").is_none());
}

#[tokio::test]
async fn parked_form_post_answers_need_their_ticket_once() {
    let (ctx, mock) = setup().await;
    let (app, _) = app_with(&ctx, "waveform", json!({"methods": {"apple": true}})).await;
    let mut b = Browser::new(&ctx);
    let id = id_of(&new_flow(&ctx, &mut b, &app.app_id, json!({})).await);
    let url = oauth_start(&ctx, &mut b, &id, "apple").await.json["authorize_url"]
        .as_str()
        .expect("u")
        .to_string();
    let (code, state) = mock.authorize(&url, identity("ticket-"));
    let r = apple_post(&ctx, &mock, &[("code", &code), ("state", &state)]).await;
    let path = continue_path(&ctx, &r);
    // A second delivery of the same answer is refused while the first one waits.
    let r = apple_post(&ctx, &mock, &[("code", &code), ("state", &state)]).await;
    assert_eq!(r.status, 400);
    // A forged ticket for the flow is refused and leaves the parked answer alone.
    let forged = format!("/v1/oauth/callback/apple?ticket={id}.{}", "B".repeat(43));
    let r = b
        .call(&ctx, Req::get(&forged).header("accept", "application/json"))
        .await;
    assert_eq!(r.error_code(), Some("invalid_state"));
    // A ticket only comes back with GET.
    let r = ctx
        .call(
            router(),
            Req::post("/v1/oauth/callback/apple")
                .form(&[("ticket", path.split("ticket=").nth(1).expect("ticket"))])
                .header("accept", "application/json"),
        )
        .await;
    assert_eq!(r.error_code(), Some("invalid_state"));
    // The right browser with the right ticket continues, once.
    let r = b.call(&ctx, Req::get(&path)).await;
    assert_redirect_to_flow(&ctx, &r, &id);
    let r = b.get(&ctx, &format!("/v1/flows/{id}")).await;
    assert_eq!(r.json["flow"]["step"], "signup", "{}", r.json);
    let r = b
        .call(&ctx, Req::get(&path).header("accept", "application/json"))
        .await;
    assert_eq!(r.status, 400);
    assert_eq!(r.error_code(), Some("invalid_state"));
    // The parked answer never sat in the flow row in clear.
    let stored: String = sqlx::query_scalar(
        "select coalesce(provider_state::text, '') from signin_flows where id = $1",
    )
    .bind(&id)
    .fetch_one(&ctx.state.db)
    .await
    .expect("row");
    assert!(!stored.contains(&code));
}

#[tokio::test]
async fn a_same_site_form_post_with_its_cookies_is_taken_directly() {
    let (ctx, mock) = setup().await;
    let (app, _) = app_with(&ctx, "waveform", json!({"methods": {"apple": true}})).await;
    let mut b = Browser::new(&ctx);
    let id = id_of(&new_flow(&ctx, &mut b, &app.app_id, json!({})).await);
    let url = oauth_start(&ctx, &mut b, &id, "apple").await.json["authorize_url"]
        .as_str()
        .expect("u")
        .to_string();
    let (code, state) = mock.authorize(&url, identity("samesite-"));
    let r = b
        .call(
            &ctx,
            Req::post("/v1/oauth/callback/apple")
                .form(&[("code", code.as_str()), ("state", state.as_str())])
                .header("accept", "text/html"),
        )
        .await;
    assert_redirect_to_flow(&ctx, &r, &id);
    let r = b.get(&ctx, &format!("/v1/flows/{id}")).await;
    assert_eq!(r.json["flow"]["step"], "signup", "{}", r.json);
}

#[tokio::test]
async fn the_provider_picture_is_offered_not_imposed() {
    let (ctx, mock) = setup().await;
    let (app, _) = app_with(&ctx, "commit", json!({"methods": {"google": true}})).await;
    let (mut b, id, url) = google_leg(&ctx, &app.app_id).await;
    let picture = "https://lh3.googleusercontent.test/grace.png";
    let mut who = identity("grace-");
    who["picture"] = json!(picture);
    let (code, state) = mock.authorize(&url, who);
    google_callback(&ctx, &mut b, &code, &state).await;
    let r = b.get(&ctx, &format!("/v1/flows/{id}")).await;
    assert_eq!(r.json["flow"]["signup"]["provider_pfp_url"], picture);
    let r = b
        .post(
            &ctx,
            &format!("/v1/flows/{id}/signup"),
            json!({"pfp_url": picture}),
        )
        .await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(
        r.json["flow"]["signed_in_as"]["pfp_url"], picture,
        "the Carbon picked Google's picture"
    );
}

#[tokio::test]
async fn refused_provider_answers_show_in_the_accounts_sign_in_history() {
    let (ctx, mock) = setup().await;
    let (open, _) = app_with(&ctx, "commit", json!({"methods": {"google": true}})).await;
    let (campus, _) = app_with(
        &ctx,
        "campus",
        json!({"methods": {"google": true}, "google": {"mode": "managed", "client_id": null, "prompt": null, "hosted_domain": "university.test"}}),
    )
    .await;
    // Ada signs up with Google, which links her Google identity.
    let who = json!({"sub": "g-ada-history", "email": "ada-history@example.test", "email_verified": true});
    let (mut b, id, url) = google_leg(&ctx, &open.app_id).await;
    let (code, state) = mock.authorize(&url, who.clone());
    google_callback(&ctx, &mut b, &code, &state).await;
    b.get(&ctx, &format!("/v1/flows/{id}")).await;
    let r = b
        .post(&ctx, &format!("/v1/flows/{id}/signup"), json!({}))
        .await;
    assert_eq!(r.status, 200, "{}", r.json);
    let uuid = r.json["flow"]["signed_in_as"]["uuid"]
        .as_str()
        .expect("uuid")
        .to_string();
    // The campus app only takes its Workspace accounts: her personal Google is refused.
    let (mut b, id, url) = google_leg(&ctx, &campus.app_id).await;
    let (code, state) = mock.authorize(&url, who);
    google_callback(&ctx, &mut b, &code, &state).await;
    assert_eq!(
        flow_error(&ctx, &mut b, &id).await["code"],
        "hosted_domain_mismatch"
    );
    let (method, outcome): (String, String) = sqlx::query_as(
        "select method, outcome from signin_history where account_uuid = $1 and app_id = $2",
    )
    .bind(&uuid)
    .bind(&campus.app_id)
    .fetch_one(&ctx.state.db)
    .await
    .expect("history");
    assert_eq!((method.as_str(), outcome.as_str()), ("google", "failed"));
    let refused = scalar_i64(
        &ctx,
        "select count(*) from audit_log where account_uuid = $1 and action = 'signin.refused'",
        &uuid,
    )
    .await;
    assert_eq!(refused, 1);
    // A Google account never used here, whose verified email is a Carbon's, counts for that
    // Carbon too.
    let carbon = ctx.carbon().await;
    let email = format!("{}@example.test", carbon.id().trim_start_matches("c:"));
    let (mut b, id, url) = google_leg(&ctx, &campus.app_id).await;
    let (code, state) = mock.authorize(
        &url,
        json!({"sub": "g-new-sub", "email": email, "email_verified": true}),
    );
    google_callback(&ctx, &mut b, &code, &state).await;
    assert_eq!(
        flow_error(&ctx, &mut b, &id).await["code"],
        "hosted_domain_mismatch"
    );
    let failed = scalar_i64(
        &ctx,
        "select count(*) from signin_history where account_uuid = $1 and outcome = 'failed'",
        &carbon.uuid,
    )
    .await;
    assert_eq!(failed, 1);
    // An unverified provider email is attributed to nobody.
    let other = ctx.carbon().await;
    let other_email = format!("{}@example.test", other.id().trim_start_matches("c:"));
    let (mut b, id, url) = google_leg(&ctx, &open.app_id).await;
    let (code, state) = mock.authorize(
        &url,
        json!({"sub": "g-unverified", "email": other_email, "email_verified": false}),
    );
    google_callback(&ctx, &mut b, &code, &state).await;
    assert_eq!(
        flow_error(&ctx, &mut b, &id).await["code"],
        "email_not_verified"
    );
    let failed = scalar_i64(
        &ctx,
        "select count(*) from signin_history where account_uuid = $1",
        &other.uuid,
    )
    .await;
    assert_eq!(failed, 0);
}

#[tokio::test]
async fn an_unproven_imported_email_never_links_a_google_identity() {
    let (ctx, mock) = setup().await;
    let (app, _) = app_with(
        &ctx,
        "commit",
        json!({"methods": {"email": true, "google": true}}),
    )
    .await;
    // An active account with an address nobody proved (as imports left them before claims
    // removed them).
    let holder = ctx.carbon().await;
    let stranger = random_email("stranger");
    sqlx::query(
        "insert into account_emails (email, account_uuid, is_primary) values ($1, $2, false)",
    )
    .bind(&stranger)
    .bind(&holder.uuid)
    .execute(&ctx.state.db)
    .await
    .expect("leftover");
    let (mut b, id, url) = google_leg(&ctx, &app.app_id).await;
    let (code, state) = mock.authorize(
        &url,
        json!({"sub": "g-stranger-1", "email": stranger, "email_verified": true}),
    );
    google_callback(&ctx, &mut b, &code, &state).await;
    let r = b.get(&ctx, &format!("/v1/flows/{id}")).await;
    assert_eq!(
        r.json["flow"]["step"], "signup",
        "a new sign-up, not the account that listed the address: {}",
        r.json
    );
    assert_eq!(r.json["flow"]["signup"]["finishing_import"], false);
    assert!(b.cookie("sa_session").is_none());
    let linked = scalar_i64(
        &ctx,
        "select count(*) from identities where account_uuid = $1",
        &holder.uuid,
    )
    .await;
    assert_eq!(linked, 0);
    let left = scalar_i64(
        &ctx,
        "select count(*) from account_emails where email = $1",
        &stranger,
    )
    .await;
    assert_eq!(
        left, 0,
        "the unproven row was removed from the other account"
    );
}

#[tokio::test]
async fn app_rules_apply_to_provider_identities() {
    let (ctx, mock) = setup().await;
    let (campus, _) = app_with(
        &ctx,
        "campus",
        json!({"methods": {"google": true}, "allowed_email_domains": ["university.test"], "google": {"mode": "managed", "client_id": null, "prompt": "select_account", "hosted_domain": "university.test"}}),
    )
    .await;
    let (closed, _) = app_with(
        &ctx,
        "legacy",
        json!({"methods": {"google": true}, "allow_signup": false}),
    )
    .await;

    let (mut b, id, url) = google_leg(&ctx, &campus.app_id).await;
    assert_eq!(query_param(&url, "hd").as_deref(), Some("university.test"));
    let (code, state) = mock.authorize(
        &url,
        json!({"sub": "g-campus-1", "email": "grace@university.test", "email_verified": true}),
    );
    google_callback(&ctx, &mut b, &code, &state).await;
    assert_eq!(
        flow_error(&ctx, &mut b, &id).await["code"],
        "hosted_domain_mismatch"
    );

    let (mut b, id, url) = google_leg(&ctx, &campus.app_id).await;
    let (code, state) = mock.authorize(&url, json!({"sub": "g-campus-2", "email": "grace@gmail.test", "email_verified": true, "hd": "university.test"}));
    google_callback(&ctx, &mut b, &code, &state).await;
    assert_eq!(
        flow_error(&ctx, &mut b, &id).await["code"],
        "email_domain_not_allowed"
    );

    let (mut b, id, url) = google_leg(&ctx, &campus.app_id).await;
    let (code, state) = mock.authorize(&url, json!({"sub": "g-campus-3", "email": "grace@university.test", "email_verified": true, "hd": "university.test"}));
    google_callback(&ctx, &mut b, &code, &state).await;
    let r = b.get(&ctx, &format!("/v1/flows/{id}")).await;
    assert_eq!(r.json["flow"]["step"], "signup", "{}", r.json);

    let (mut b, id, url) = google_leg(&ctx, &closed.app_id).await;
    let (code, state) = mock.authorize(&url, identity("closed-"));
    google_callback(&ctx, &mut b, &code, &state).await;
    assert_eq!(
        flow_error(&ctx, &mut b, &id).await["code"],
        "signup_not_allowed"
    );
}

#[tokio::test]
async fn switching_the_provider_off_mid_sign_in_is_respected() {
    let (ctx, mock) = setup().await;
    let (app, _) = app_with(
        &ctx,
        "commit",
        json!({"methods": {"email": true, "google": true}}),
    )
    .await;
    let (mut b, id, url) = google_leg(&ctx, &app.app_id).await;
    let (code, state) = mock.authorize(&url, identity("midway-"));
    set_config(
        &ctx,
        &app.app_id,
        json!({"methods": {"email": true, "google": false}}),
    )
    .await;
    assert_redirect_to_flow(
        &ctx,
        &google_callback(&ctx, &mut b, &code, &state).await,
        &id,
    );
    assert_eq!(
        flow_error(&ctx, &mut b, &id).await["code"],
        "method_not_enabled"
    );
    assert!(
        mock.token_requests().is_empty(),
        "the code was never exchanged"
    );
}

#[tokio::test]
async fn google_never_reaches_an_import_someone_else_finished() {
    let (ctx, mock) = setup().await;
    let (app, _) = app_with(
        &ctx,
        "commit",
        json!({"methods": {"email": true, "google": true}}),
    )
    .await;
    let attacker = random_email("attacker");
    let victim = random_email("victim");
    let uuid = unclaimed_import(&ctx, &[&attacker, &victim], &[]).await;
    // The attacker finishes the imported account with their own address...
    let mut a = Browser::new(&ctx);
    let id = id_of(&new_flow(&ctx, &mut a, &app.app_id, json!({})).await);
    let r = email_and_verify(&ctx, &mut a, &id, &attacker).await;
    assert_eq!(r.json["flow"]["signup"]["finishing_import"], true);
    let r = a
        .post(&ctx, &format!("/v1/flows/{id}/signup"), json!({}))
        .await;
    assert_eq!(r.status, 200, "{}", r.json);
    // ...and the victim's later Google sign-in with their own address is a sign-up of their own.
    let (mut v, id, url) = google_leg(&ctx, &app.app_id).await;
    let (code, state) = mock.authorize(
        &url,
        json!({"sub": "g-victim-1", "email": victim, "email_verified": true, "name": "Victim"}),
    );
    google_callback(&ctx, &mut v, &code, &state).await;
    let r = v.get(&ctx, &format!("/v1/flows/{id}")).await;
    assert_eq!(r.json["flow"]["step"], "signup", "{}", r.json);
    assert_eq!(r.json["flow"]["signup"]["finishing_import"], false);
    assert_eq!(r.json["flow"]["signed_in_as"], Value::Null);
    assert!(v.cookie("sa_session").is_none());
    let linked = scalar_i64(
        &ctx,
        "select count(*) from identities where account_uuid = $1",
        &uuid,
    )
    .await;
    assert_eq!(
        linked, 0,
        "the victim's Google was never linked to that account"
    );
}
