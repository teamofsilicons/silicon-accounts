//! Connecting Google or Apple to a signed-in Carbon from the account site
//! (`POST /v1/me/identities/{provider}`): the provider's verified email is added without a
//! code, the provider account is connected, and every refusal leaves the account unchanged.

mod common;

use accounts_core::Settings;
use accounts_core::models::{Account, Scope};
use accounts_core::test_support::{CarbonSpec, Req, Resp, TestContext};
use common::mock_oidc::MockOidc;
use common::*;
use serde_json::{Value, json};

async fn setup() -> (TestContext, MockOidc) {
    let mock = MockOidc::start().await;
    let mut s = Settings::for_tests();
    mock.configure(&mut s);
    (TestContext::with_settings(s).await, mock)
}

/// A browser signed in as `account` on the account site.
async fn signed_in(ctx: &TestContext, account: &Account) -> Browser {
    let mut b = Browser::new(ctx);
    b.cookies
        .insert("sa_session".into(), ctx.browser_session(account).await);
    b
}

async fn start(ctx: &TestContext, b: &mut Browser, provider: &str, body: Value) -> Resp {
    b.post(ctx, &format!("/v1/me/identities/{provider}"), body)
        .await
}

fn google_identity(tag: &str, email: &str) -> Value {
    let sub = format!("{tag}-{}", accounts_core::test_support::rand_suffix());
    json!({"sub": sub, "email": email, "email_verified": true, "name": "Linked Person"})
}

async fn google_back(ctx: &TestContext, b: &mut Browser, code: &str, state: &str) -> Resp {
    let qs = serde_urlencoded::to_string([("code", code), ("state", state)]).expect("qs");
    b.call(
        ctx,
        Req::get(&format!("/v1/oauth/callback/google?{qs}")).header("accept", "text/html"),
    )
    .await
}

fn location(r: &Resp) -> String {
    assert_eq!(r.status, 302, "{}", String::from_utf8_lossy(&r.body));
    r.headers["location"]
        .to_str()
        .expect("location")
        .to_string()
}

async fn emails(ctx: &TestContext, uuid: &str) -> Vec<(String, bool, Option<String>)> {
    sqlx::query_as(
        "select email, is_primary, verified_via from account_emails where account_uuid = $1 order by email",
    )
    .bind(uuid)
    .fetch_all(&ctx.state.db)
    .await
    .expect("emails")
}

async fn identity_owner(ctx: &TestContext, subject: &str) -> Option<String> {
    sqlx::query_scalar("select account_uuid from identities where subject = $1")
        .bind(subject)
        .fetch_optional(&ctx.state.db)
        .await
        .expect("identity")
}

#[tokio::test]
async fn connecting_google_adds_its_verified_email_without_a_code() {
    let (ctx, mock) = setup().await;
    let carbon = ctx.carbon().await;
    let mut b = signed_in(&ctx, &carbon).await;

    let r = start(&ctx, &mut b, "google", json!({})).await;
    assert_eq!(r.status, 201, "{}", r.json);
    assert_eq!(r.headers["cache-control"], "no-store");
    assert_eq!(r.json["provider"], "google");
    assert!(
        b.cookie("sa_flow").is_some(),
        "the answer is bound to this browser"
    );
    let flow_id = r.json["flow_id"].as_str().expect("flow").to_string();
    let url = r.json["authorize_url"].as_str().expect("url").to_string();
    assert!(url.starts_with(&format!("{}/google/authorize?", mock.base)));

    let google_email = format!(
        "linked-{}@gmail.example.test",
        accounts_core::test_support::rand_suffix()
    );
    let who = google_identity("g-link", &google_email);
    let sub = who["sub"].as_str().expect("sub").to_string();
    let (code, state) = mock.authorize(&url, who);
    let r = google_back(&ctx, &mut b, &code, &state).await;
    assert_eq!(
        location(&r),
        format!(
            "{}/sign-in-methods?linked=google&email_added=true",
            ctx.state.settings.public_url
        )
    );
    assert!(r.headers.get("set-cookie").is_none(), "nobody is signed in");
    assert_eq!(
        identity_owner(&ctx, &sub).await.as_deref(),
        Some(carbon.uuid.as_str())
    );
    let list = emails(&ctx, &carbon.uuid).await;
    assert!(
        list.contains(&(google_email.clone(), false, Some("google".into()))),
        "the Google email is added, verified by Google, not primary: {list:?}"
    );
    // The flow is finished and says where it went.
    let r = b.get(&ctx, &format!("/v1/flows/{flow_id}")).await;
    assert_eq!(r.json["flow"]["step"], "complete");
    assert!(
        r.json["flow"]["redirect_to"]
            .as_str()
            .is_some_and(|u| u.ends_with("?linked=google&email_added=true"))
    );
    let audited: i64 = sqlx::query_scalar(
        "select count(*) from audit_log where account_uuid = $1 and action in ('identity.linked', 'account.email.added')",
    )
    .bind(&carbon.uuid)
    .fetch_one(&ctx.state.db)
    .await
    .expect("audit");
    assert_eq!(audited, 2);

    // Google now signs this Carbon in.
    let (app, _) = app_with(
        &ctx,
        "lnk",
        json!({"methods": {"email": true, "google": true}}),
    )
    .await;
    let mut fresh = Browser::new(&ctx);
    let id = id_of(&new_flow(&ctx, &mut fresh, &app.app_id, json!({})).await);
    let r = fresh
        .post(&ctx, &format!("/v1/flows/{id}/oauth/google"), json!({}))
        .await;
    let url = r.json["authorize_url"].as_str().expect("url").to_string();
    let (code, state) = mock.authorize(
        &url,
        json!({"sub": sub, "email": google_email, "email_verified": true}),
    );
    let r = google_back(&ctx, &mut fresh, &code, &state).await;
    assert_eq!(r.status, 302);
    let r = fresh.get(&ctx, &format!("/v1/flows/{id}")).await;
    assert_eq!(
        r.json["flow"]["signed_in_as"]["uuid"],
        carbon.uuid.as_str(),
        "{}",
        r.json
    );

    // Connecting it again is fine (nothing new to add).
    let r = start(&ctx, &mut b, "google", json!({"return_to": "/settings"})).await;
    let url = r.json["authorize_url"].as_str().expect("url").to_string();
    let (code, state) = mock.authorize(
        &url,
        json!({"sub": sub, "email": google_email, "email_verified": true}),
    );
    let r = google_back(&ctx, &mut b, &code, &state).await;
    assert_eq!(
        location(&r),
        format!(
            "{}/settings?linked=google&email_added=false",
            ctx.state.settings.public_url
        )
    );
}

#[tokio::test]
async fn apple_connects_through_its_form_post() {
    let (ctx, mock) = setup().await;
    let carbon = ctx.carbon().await;
    let mut b = signed_in(&ctx, &carbon).await;
    let r = start(&ctx, &mut b, "apple", json!({})).await;
    assert_eq!(r.status, 201, "{}", r.json);
    let url = r.json["authorize_url"].as_str().expect("url").to_string();
    let email = format!(
        "{}@privaterelay.appleid.example.test",
        accounts_core::test_support::rand_suffix()
    );
    let (code, state) = mock.authorize(
        &url,
        json!({"sub": "apple-link-1", "email": email, "email_verified": "true"}),
    );
    // Apple's cross-site POST has no cookies: parked, then the same-site GET finishes it.
    let r = ctx
        .call(
            router(),
            Req::post("/v1/oauth/callback/apple")
                .form(&[("code", code.as_str()), ("state", state.as_str())])
                .header("origin", &mock.base)
                .header("accept", "text/html"),
        )
        .await;
    assert_eq!(r.status, 303, "{}", String::from_utf8_lossy(&r.body));
    let next = r.headers["location"]
        .to_str()
        .expect("location")
        .to_string();
    let path = next
        .strip_prefix(&ctx.state.settings.public_url)
        .expect("same site")
        .to_string();
    let r = b
        .call(&ctx, Req::get(&path).header("accept", "text/html"))
        .await;
    assert!(
        location(&r).ends_with("/sign-in-methods?linked=apple&email_added=true"),
        "{}",
        location(&r)
    );
    assert_eq!(
        identity_owner(&ctx, "apple-link-1").await.as_deref(),
        Some(carbon.uuid.as_str())
    );
    assert!(
        emails(&ctx, &carbon.uuid)
            .await
            .iter()
            .any(|(e, _, via)| e == &email && via.as_deref() == Some("apple"))
    );
}

#[tokio::test]
async fn refusals_leave_the_account_unchanged() {
    let (ctx, mock) = setup().await;
    let carbon = ctx.carbon().await;
    let other = ctx.carbon().await;
    let other_email = emails(&ctx, &other.uuid).await[0].0.clone();
    let before = emails(&ctx, &carbon.uuid).await;
    let site = ctx.state.settings.public_url.clone();

    let attempt = |who: Value| {
        let ctx = &ctx;
        let mock = &mock;
        let carbon = carbon.clone();
        async move {
            let mut b = signed_in(ctx, &carbon).await;
            let r = start(ctx, &mut b, "google", json!({})).await;
            assert_eq!(r.status, 201, "{}", r.json);
            let flow_id = r.json["flow_id"].as_str().expect("flow").to_string();
            let url = r.json["authorize_url"].as_str().expect("url").to_string();
            let (code, state) = mock.authorize(&url, who);
            let r = google_back(ctx, &mut b, &code, &state).await;
            let to = location(&r);
            let flow = b.get(ctx, &format!("/v1/flows/{flow_id}")).await.json["flow"].clone();
            (to, flow, flow_id)
        }
    };

    // The Google email is another account's.
    let (to, flow, flow_id) =
        attempt(json!({"sub": "g-taken-email", "email": other_email, "email_verified": true}))
            .await;
    assert_eq!(
        to,
        format!("{site}/sign-in-methods?link_error=email_in_use&provider=google&flow={flow_id}")
    );
    assert_eq!(flow["step"], "complete");
    assert_eq!(flow["error"]["code"], "email_in_use");
    assert!(
        flow["error"]["message"]
            .as_str()
            .is_some_and(|m| m.contains(&other_email))
    );
    assert_eq!(
        identity_owner(&ctx, "g-taken-email").await,
        None,
        "nothing was connected"
    );

    // The Google account is connected to someone else.
    sqlx::query(
        "insert into identities (provider, subject, client_id, account_uuid) values ('google', 'g-taken-id', 'x', $1)",
    )
    .bind(&other.uuid)
    .execute(&ctx.state.db)
    .await
    .expect("identity");
    let (to, _, _) = attempt(
        json!({"sub": "g-taken-id", "email": "fresh-1@example.test", "email_verified": true}),
    )
    .await;
    assert!(to.contains("link_error=identity_in_use"), "{to}");
    assert_eq!(
        identity_owner(&ctx, "g-taken-id").await.as_deref(),
        Some(other.uuid.as_str())
    );

    // An address the provider didn't verify.
    let (to, _, _) = attempt(
        json!({"sub": "g-unverified", "email": "fresh-2@example.test", "email_verified": false}),
    )
    .await;
    assert!(to.contains("link_error=email_not_verified"), "{to}");

    assert_eq!(
        emails(&ctx, &carbon.uuid).await,
        before,
        "no email was added"
    );
    assert_eq!(identity_owner(&ctx, "g-unverified").await, None);

    // Cancelled at Google.
    let mut b = signed_in(&ctx, &carbon).await;
    let r = start(&ctx, &mut b, "google", json!({})).await;
    let url = r.json["authorize_url"].as_str().expect("url").to_string();
    let state = query_param(&url, "state").expect("state");
    let qs = serde_urlencoded::to_string([("error", "access_denied"), ("state", state.as_str())])
        .expect("qs");
    let r = b
        .call(
            &ctx,
            Req::get(&format!("/v1/oauth/callback/google?{qs}")).header("accept", "text/html"),
        )
        .await;
    assert!(
        location(&r).contains("link_error=provider_cancelled"),
        "{}",
        location(&r)
    );

    // The browser signed out (or switched accounts) before Google answered.
    let mut b = signed_in(&ctx, &carbon).await;
    let r = start(&ctx, &mut b, "google", json!({})).await;
    let url = r.json["authorize_url"].as_str().expect("url").to_string();
    b.cookies.remove("sa_session");
    let (code, state) = mock.authorize(
        &url,
        json!({"sub": "g-late", "email": "fresh-3@example.test", "email_verified": true}),
    );
    let r = google_back(&ctx, &mut b, &code, &state).await;
    assert!(
        location(&r).contains("link_error=session_changed"),
        "{}",
        location(&r)
    );
    assert_eq!(identity_owner(&ctx, "g-late").await, None);

    // A connection that ran out (60 minutes) goes back to the account site too.
    let mut b = signed_in(&ctx, &carbon).await;
    let r = start(&ctx, &mut b, "google", json!({})).await;
    let url = r.json["authorize_url"].as_str().expect("url").to_string();
    let flow_id = r.json["flow_id"].as_str().expect("flow").to_string();
    ctx.exec(&format!(
        "update signin_flows set expires_at = now() - interval '1 second' where id = '{flow_id}'"
    ))
    .await;
    let (code, state) = mock.authorize(
        &url,
        json!({"sub": "g-slow", "email": "fresh-5@example.test", "email_verified": true}),
    );
    let r = google_back(&ctx, &mut b, &code, &state).await;
    assert!(
        location(&r).contains("link_error=flow_expired"),
        "{}",
        location(&r)
    );
    assert_eq!(identity_owner(&ctx, "g-slow").await, None);

    // Another browser can't deliver the answer.
    let mut b = signed_in(&ctx, &carbon).await;
    let r = start(&ctx, &mut b, "google", json!({})).await;
    let url = r.json["authorize_url"].as_str().expect("url").to_string();
    let (code, state) = mock.authorize(
        &url,
        json!({"sub": "g-elsewhere", "email": "fresh-4@example.test", "email_verified": true}),
    );
    let mut stranger = signed_in(&ctx, &other).await;
    let r = google_back(&ctx, &mut stranger, &code, &state).await;
    assert_eq!(r.status, 403, "{}", String::from_utf8_lossy(&r.body));
    assert_eq!(identity_owner(&ctx, "g-elsewhere").await, None);
}

#[tokio::test]
async fn a_phone_only_carbon_gets_a_primary_email_and_apps_hear_about_it() {
    let (ctx, mock) = setup().await;
    let carbon = ctx
        .carbon_with(CarbonSpec {
            email: Some(String::new()),
            phone: Some(format!(
                "+1202555{:04}",
                u32::from_str_radix(&accounts_core::test_support::rand_suffix()[..4], 16)
                    .expect("hex")
                    % 10_000
            )),
            ..Default::default()
        })
        .await;
    let (app, _) = ctx.app("mailer").await;
    ctx.set_app_webhook(&app.app_id, "http://127.0.0.1:8593/mailer/webhooks")
        .await;
    ctx.membership(&app.app_id, &carbon.uuid, &[Scope::Profile, Scope::Email])
        .await;
    let mut b = signed_in(&ctx, &carbon).await;
    let r = start(&ctx, &mut b, "google", json!({})).await;
    let url = r.json["authorize_url"].as_str().expect("url").to_string();
    let email = format!(
        "first-{}@example.test",
        accounts_core::test_support::rand_suffix()
    );
    let (code, state) = mock.authorize(
        &url,
        json!({"sub": "g-first-email", "email": email, "email_verified": true}),
    );
    let r = google_back(&ctx, &mut b, &code, &state).await;
    assert!(location(&r).ends_with("?linked=google&email_added=true"));
    assert_eq!(
        emails(&ctx, &carbon.uuid).await,
        vec![(email.clone(), true, Some("google".into()))],
        "the first email is the primary"
    );
    let changed: Vec<Value> = sqlx::query_scalar(
        "select payload->'data'->'changed' from webhook_events where target_kind = 'app' and target_id = $1 and type = 'account.updated'",
    )
    .bind(&app.app_id)
    .fetch_all(&ctx.state.db)
    .await
    .expect("events");
    assert_eq!(changed, vec![json!(["email"])]);
}

#[tokio::test]
async fn the_request_is_checked() {
    let (ctx, _mock) = setup().await;
    let carbon = ctx.carbon().await;
    let mut b = signed_in(&ctx, &carbon).await;
    let r = start(&ctx, &mut b, "github", json!({})).await;
    assert_eq!(r.status, 404);
    assert_eq!(r.error_code(), Some("unknown_provider"));
    let r = start(
        &ctx,
        &mut b,
        "google",
        json!({"return_to": "https://evil.example/"}),
    )
    .await;
    assert_eq!(r.status, 422, "{}", r.json);
    assert!(r.json["error"]["details"]["fields"]["return_to"].is_string());
    let r = start(&ctx, &mut b, "google", json!({"nope": 1})).await;
    assert_eq!(r.status, 400, "{}", r.json);
    // An empty body is fine.
    let r = b.call(&ctx, Req::post("/v1/me/identities/google")).await;
    assert_eq!(r.status, 201, "{}", r.json);

    // Browser only: an access token can't start it.
    let token = ctx.first_party_tokens(&carbon).await.access_token;
    let r = ctx
        .call(
            router(),
            Req::post("/v1/me/identities/google")
                .bearer(&token)
                .json(json!({})),
        )
        .await;
    assert_eq!(r.status, 400, "{}", r.json);
    assert_eq!(r.error_code(), Some("browser_session_required"));
    // The CSRF guard applies (a foreign Origin).
    let mut foreign = b.clone();
    foreign.origin = Some("https://evil.example".into());
    let r = foreign
        .post(&ctx, "/v1/me/identities/google", json!({}))
        .await;
    assert_eq!(r.status, 403);
    assert_eq!(r.error_code(), Some("origin_not_allowed"));
    // Nobody signed in.
    let mut anon = Browser::new(&ctx);
    let r = anon.post(&ctx, "/v1/me/identities/google", json!({})).await;
    assert_eq!(r.status, 401);

    // Without managed Google credentials there is nothing to connect with.
    let plain = TestContext::new().await;
    let carbon = plain.carbon().await;
    let mut b = signed_in(&plain, &carbon).await;
    let r = start(&plain, &mut b, "google", json!({})).await;
    assert_eq!(r.status, 403, "{}", r.json);
    assert_eq!(r.error_code(), Some("method_not_enabled"));
}
