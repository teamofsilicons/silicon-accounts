//! `POST /v1/flows` and `GET /v1/flows/{id}`: validation, the binding cookie, the origin guard,
//! expiry and prompt=none.

mod common;

use accounts_core::test_support::{Req, TestContext};
use common::*;
use serde_json::json;

#[tokio::test]
async fn creates_a_bound_flow_with_the_spec_view() {
    let ctx = TestContext::new().await;
    let (app, _) = ctx.app("briefcase").await;
    let mut b = Browser::new(&ctx);
    let r = start_flow(
        &ctx,
        &mut b,
        &app.app_id,
        json!({"scope": "openid email", "login_hint": "ada@example.test"}),
    )
    .await;
    assert_eq!(r.status, 201, "{}", r.json);
    assert_eq!(r.headers["cache-control"], "no-store");
    let set_cookie = r.headers["set-cookie"].to_str().expect("cookie");
    assert!(set_cookie.starts_with("sa_flow=saf_"), "{set_cookie}");
    assert!(
        set_cookie.contains("HttpOnly")
            && set_cookie.contains("SameSite=Lax")
            && set_cookie.contains("Path=/")
    );
    let f = &r.json["flow"];
    assert_eq!(f["step"], "choose_method");
    assert_eq!(f["app"]["app_id"], app.app_id);
    assert_eq!(f["app"]["first_party"], false);
    assert_eq!(f["app"]["branding"]["light"]["primary"], "#1F5FB8");
    assert_eq!(f["methods"], json!(["email"]));
    assert_eq!(f["signed_in_as"], serde_json::Value::Null);
    assert_eq!(f["challenge"], serde_json::Value::Null);
    assert_eq!(f["redirect_to"], serde_json::Value::Null);
    assert_eq!(f["login_hint"], "ada@example.test");
    let expires = accounts_core::timefmt::parse_rfc3339(f["expires_at"].as_str().expect("expires"))
        .expect("ts");
    let left = expires - time::OffsetDateTime::now_utc();
    assert!(
        left > time::Duration::minutes(59) && left <= time::Duration::minutes(60),
        "{left}"
    );

    // The same browser can read it; another can't.
    let id = id_of(f);
    let r = b.get(&ctx, &format!("/v1/flows/{id}")).await;
    assert_eq!(r.status, 200);
    assert_eq!(r.json["flow"]["id"], id.as_str());
    let mut other = Browser::new(&ctx);
    let r = other.get(&ctx, &format!("/v1/flows/{id}")).await;
    assert_eq!(r.status, 403);
    assert_eq!(r.error_code(), Some("flow_not_bound"));
    assert!(
        r.json["error"]["message"]
            .as_str()
            .expect("msg")
            .contains("no sa_flow cookie")
    );
    other
        .cookies
        .insert("sa_flow".into(), format!("saf_{}", "A".repeat(43)));
    let r = other.get(&ctx, &format!("/v1/flows/{id}")).await;
    assert_eq!(r.error_code(), Some("flow_not_bound"));
    assert!(
        r.json["error"]["message"]
            .as_str()
            .expect("msg")
            .contains("different sign-in")
    );
    let r = b.get(&ctx, "/v1/flows/doesnotexist").await;
    assert_eq!(r.status, 404);
    assert_eq!(r.error_code(), Some("flow_not_found"));
}

#[tokio::test]
async fn several_flows_in_one_browser_stay_bound() {
    let ctx = TestContext::new().await;
    let (a1, _) = ctx.app("one").await;
    let (a2, _) = ctx.app("two").await;
    let mut b = Browser::new(&ctx);
    let f1 = new_flow(&ctx, &mut b, &a1.app_id, json!({})).await;
    let cookie1 = b.cookie("sa_flow").expect("cookie").to_string();
    let f2 = new_flow(&ctx, &mut b, &a2.app_id, json!({})).await;
    assert_eq!(
        b.cookie("sa_flow"),
        Some(cookie1.as_str()),
        "the binding is reused"
    );
    for f in [&f1, &f2] {
        let r = b.get(&ctx, &format!("/v1/flows/{}", id_of(f))).await;
        assert_eq!(r.status, 200, "{}", r.json);
    }
}

#[tokio::test]
async fn app_and_redirect_errors_never_offer_a_redirect() {
    let ctx = TestContext::new().await;
    let (app, _) = ctx.app("briefcase").await;
    let mut b = Browser::new(&ctx);

    let r = b
        .post(
            &ctx,
            "/v1/flows",
            json!({"redirect_uri": redirect_uri("x")}),
        )
        .await;
    assert_eq!(r.status, 400);
    assert_eq!(r.error_code(), Some("invalid_request"));

    let r = start_flow(&ctx, &mut b, "no-such-app", json!({})).await;
    assert_eq!(r.status, 400);
    assert_eq!(r.error_code(), Some("unknown_app"));

    let r = start_flow(
        &ctx,
        &mut b,
        &app.app_id,
        json!({"redirect_uri": "https://evil.test/cb"}),
    )
    .await;
    assert_eq!(r.status, 400);
    assert_eq!(r.error_code(), Some("redirect_uri_not_registered"));
    assert!(
        r.json["error"]["details"].get("redirect_to").is_none(),
        "never redirect to an unregistered URI"
    );
    assert!(
        r.json["error"]["message"]
            .as_str()
            .expect("m")
            .contains("https://evil.test/cb")
    );

    // Loopback redirect URIs match on any port, only for the registered host.
    let ok = redirect_uri(&app.app_id).replace(":8593", ":4567");
    let r = start_flow(&ctx, &mut b, &app.app_id, json!({"redirect_uri": ok})).await;
    assert_eq!(r.status, 201, "{}", r.json);
    let other_host = redirect_uri(&app.app_id).replace("127.0.0.1", "localhost");
    let r = start_flow(
        &ctx,
        &mut b,
        &app.app_id,
        json!({"redirect_uri": other_host}),
    )
    .await;
    assert_eq!(r.error_code(), Some("redirect_uri_not_registered"));

    // client_id is an alias; disagreeing values are refused.
    let r = b
        .post(
            &ctx,
            "/v1/flows",
            json!({"client_id": app.app_id, "redirect_uri": redirect_uri(&app.app_id)}),
        )
        .await;
    assert_eq!(r.status, 201, "{}", r.json);
    let r = b.post(&ctx, "/v1/flows", json!({"app_id": app.app_id, "client_id": "other", "redirect_uri": redirect_uri(&app.app_id)})).await;
    assert_eq!(r.error_code(), Some("invalid_request"));

    sqlx::query("update apps set status = 'disabled' where app_id = $1")
        .bind(&app.app_id)
        .execute(&ctx.state.db)
        .await
        .expect("disable");
    let r = start_flow(&ctx, &mut b, &app.app_id, json!({})).await;
    assert_eq!(r.status, 400);
    assert_eq!(r.error_code(), Some("app_disabled"));
}

#[tokio::test]
async fn a_redirect_uri_with_a_fragment_is_never_accepted() {
    // RFC 6749 §3.1.2: a redirection URI must not include a fragment. Loopback URIs match on
    // any port, and that comparison must not let a fragment through either: the result would
    // be `…/callback?code=…&state=…#fragment`.
    let ctx = TestContext::new().await;
    let (app, _) = ctx.app("briefcase").await;
    set_config(
        &ctx,
        &app.app_id,
        json!({"redirect_uris": [redirect_uri(&app.app_id), "https://app.example.test/auth/callback"]}),
    )
    .await;
    let mut b = Browser::new(&ctx);
    let registered = redirect_uri(&app.app_id);
    let r = start_flow(
        &ctx,
        &mut b,
        &app.app_id,
        json!({"redirect_uri": registered}),
    )
    .await;
    assert_eq!(r.status, 201, "control: the registered URI: {}", r.json);
    for bad in [
        format!("{registered}#fragment"),
        format!("{registered}#"),
        format!("{registered}?x=1#y"),
        format!("{}#fragment", registered.replace(":8593", ":4567")),
        "https://app.example.test/auth/callback#fragment".to_string(),
    ] {
        let r = start_flow(&ctx, &mut b, &app.app_id, json!({"redirect_uri": bad})).await;
        assert_eq!(r.status, 400, "{bad}: {}", r.json);
        assert_eq!(r.error_code(), Some("redirect_uri_not_registered"), "{bad}");
        assert!(
            r.json["error"]["details"].get("redirect_to").is_none(),
            "{bad}: never redirect to it"
        );
    }
    let r = start_flow(
        &ctx,
        &mut b,
        &app.app_id,
        json!({"redirect_uri": format!("{registered}#fragment")}),
    )
    .await;
    let message = r.json["error"]["message"].as_str().expect("message");
    assert!(
        message.contains("fragment") && message.contains("RFC 6749"),
        "the refusal says why: {message}"
    );
    let flows = scalar_i64(
        &ctx,
        "select count(*) from signin_flows where app_id = $1",
        &app.app_id,
    )
    .await;
    assert_eq!(flows, 1, "only the control flow was created");
}

#[tokio::test]
async fn first_party_redirects_stay_on_the_site() {
    let ctx = TestContext::new().await;
    let mut b = Browser::new(&ctx);
    let public = ctx.state.settings.public_url.clone();
    let r = start_flow(&ctx, &mut b, "accounts", json!({})).await;
    assert_eq!(r.status, 201, "{}", r.json);
    assert_eq!(r.json["flow"]["app"]["first_party"], true);
    assert_eq!(r.json["flow"]["methods"], json!(["email", "phone"]));
    let r = start_flow(
        &ctx,
        &mut b,
        "accounts",
        json!({"redirect_uri": format!("{public}/device?code=WDJB-MJHT")}),
    )
    .await;
    assert_eq!(r.status, 201, "{}", r.json);
    for bad in [
        "https://evil.test/",
        "http://localhost:8590.evil.test/",
        "https://evil.test/http://localhost:8590/",
    ] {
        let r = start_flow(&ctx, &mut b, "accounts", json!({"redirect_uri": bad})).await;
        assert_eq!(r.error_code(), Some("redirect_uri_not_registered"), "{bad}");
    }
}

#[tokio::test]
async fn request_errors_carry_the_error_redirect() {
    let ctx = TestContext::new().await;
    let (app, _) = ctx.app("briefcase").await;
    let mut b = Browser::new(&ctx);
    let cases = [
        (
            json!({"scope": "openid files.read"}),
            "invalid_scope",
            "invalid_scope",
        ),
        (
            json!({"prompt": "sometimes"}),
            "invalid_request",
            "invalid_request",
        ),
        (
            json!({"prompt": "none login"}),
            "invalid_request",
            "invalid_request",
        ),
        (
            json!({"response_type": "token"}),
            "unsupported_response_type",
            "unsupported_response_type",
        ),
        (
            json!({"code_challenge": "short"}),
            "invalid_request",
            "invalid_request",
        ),
        (
            json!({"code_challenge_method": "S512"}),
            "invalid_request",
            "invalid_request",
        ),
        (
            json!({"code_challenge": null, "code_challenge_method": "S256"}),
            "invalid_request",
            "invalid_request",
        ),
        (
            json!({"method": "phone"}),
            "method_not_enabled",
            "invalid_request",
        ),
        (
            json!({"method": "github"}),
            "method_not_enabled",
            "invalid_request",
        ),
    ];
    for (extra, code, oauth_error) in cases {
        let r = start_flow(&ctx, &mut b, &app.app_id, extra.clone()).await;
        assert_eq!(r.status, 400, "{extra}: {}", r.json);
        assert_eq!(r.error_code(), Some(code), "{extra}: {}", r.json);
        let to = r.json["error"]["details"]["redirect_to"]
            .as_str()
            .expect("redirect_to");
        assert!(to.starts_with(&redirect_uri(&app.app_id)), "{to}");
        assert_eq!(query_param(to, "error").as_deref(), Some(oauth_error));
        assert_eq!(query_param(to, "state").as_deref(), Some(APP_STATE));
    }
    let r = start_flow(
        &ctx,
        &mut b,
        &app.app_id,
        json!({"method": "email", "response_type": "code"}),
    )
    .await;
    assert_eq!(r.status, 201, "{}", r.json);
    assert_eq!(r.json["flow"]["method_hint"], "email");
}

#[tokio::test]
async fn origin_guard_protects_flow_mutations() {
    let ctx = TestContext::new().await;
    let (app, _) = ctx.app("briefcase").await;
    let mut b = Browser::new(&ctx);
    b.origin = None;
    let r = start_flow(&ctx, &mut b, &app.app_id, json!({})).await;
    assert_eq!(r.status, 403);
    assert_eq!(r.error_code(), Some("origin_not_allowed"));
    b.origin = Some("https://evil.test".into());
    let r = start_flow(&ctx, &mut b, &app.app_id, json!({})).await;
    assert_eq!(r.error_code(), Some("origin_not_allowed"));

    b.origin = Some(ctx.state.settings.public_origin.clone());
    let f = new_flow(&ctx, &mut b, &app.app_id, json!({})).await;
    let id = id_of(&f);
    b.origin = Some("https://evil.test".into());
    let r = b
        .post(
            &ctx,
            &format!("/v1/flows/{id}/email"),
            json!({"email": "a@example.test"}),
        )
        .await;
    assert_eq!(r.status, 403);
    assert_eq!(r.error_code(), Some("origin_not_allowed"));
    // Reads are not mutations.
    let r = b.get(&ctx, &format!("/v1/flows/{id}")).await;
    assert_eq!(r.status, 200);
}

#[tokio::test]
async fn expired_flows_answer_410() {
    let ctx = TestContext::new().await;
    let (app, _) = ctx.app("briefcase").await;
    let mut b = Browser::new(&ctx);
    let f = new_flow(&ctx, &mut b, &app.app_id, json!({})).await;
    let id = id_of(&f);
    ctx.exec(&format!(
        "update signin_flows set expires_at = now() - interval '1 second' where id = '{id}'"
    ))
    .await;
    let r = b.get(&ctx, &format!("/v1/flows/{id}")).await;
    assert_eq!(r.status, 410);
    assert_eq!(r.error_code(), Some("flow_expired"));
    let r = b
        .post(
            &ctx,
            &format!("/v1/flows/{id}/email"),
            json!({"email": "a@example.test"}),
        )
        .await;
    assert_eq!(r.error_code(), Some("flow_expired"));
}

#[tokio::test]
async fn prompt_none_without_a_session_fails_with_login_required() {
    let ctx = TestContext::new().await;
    let (app, _) = ctx.app("briefcase").await;
    let mut b = Browser::new(&ctx);
    let f = new_flow(&ctx, &mut b, &app.app_id, json!({"prompt": "none"})).await;
    assert_eq!(f["step"], "failed");
    assert_eq!(f["error"]["code"], "login_required");
    let to = f["redirect_to"].as_str().expect("redirect");
    assert!(to.starts_with(&redirect_uri(&app.app_id)));
    assert_eq!(query_param(to, "error").as_deref(), Some("login_required"));
    assert_eq!(query_param(to, "state").as_deref(), Some(APP_STATE));
    // Terminal: GET returns the same redirect; actions are refused.
    let r = b.get(&ctx, &format!("/v1/flows/{}", id_of(&f))).await;
    assert_eq!(r.json["flow"]["redirect_to"], f["redirect_to"]);
    let r = b
        .post(
            &ctx,
            &format!("/v1/flows/{}/email", id_of(&f)),
            json!({"email": "a@example.test"}),
        )
        .await;
    assert_eq!(r.status, 409);
    assert_eq!(r.error_code(), Some("flow_failed"));
}

#[tokio::test]
async fn bodies_are_validated_precisely() {
    let ctx = TestContext::new().await;
    let (app, _) = ctx.app("briefcase").await;
    let mut b = Browser::new(&ctx);
    let f = new_flow(&ctx, &mut b, &app.app_id, json!({})).await;
    let id = id_of(&f);
    let r = b
        .post(&ctx, &format!("/v1/flows/{id}/email"), json!({}))
        .await;
    assert_eq!(r.status, 422);
    assert_eq!(r.error_code(), Some("validation_failed"));
    assert!(
        r.json["error"]["details"]["fields"].get("email").is_some(),
        "{}",
        r.json
    );
    let r = b
        .post(
            &ctx,
            &format!("/v1/flows/{id}/email"),
            json!({"email": "not-an-email"}),
        )
        .await;
    assert_eq!(r.status, 422);
    assert_eq!(r.error_code(), Some("invalid_email"));
    let r = b
        .call(
            &ctx,
            Req::post(&format!("/v1/flows/{id}/email")).header("content-type", "application/json"),
        )
        .await;
    assert_eq!(r.status, 422, "empty body = {{}}: {}", r.json);
}

#[tokio::test]
async fn secure_cookie_mode_uses_host_prefixed_cookies() {
    let mut settings = accounts_core::Settings::for_tests();
    settings.cookie_secure = true;
    let ctx = TestContext::with_settings(settings).await;
    let (app, _) = ctx.app("briefcase").await;
    let mut b = Browser::new(&ctx);
    let r = start_flow(&ctx, &mut b, &app.app_id, json!({})).await;
    assert_eq!(r.status, 201, "{}", r.json);
    let set_cookie = r.headers["set-cookie"].to_str().expect("cookie");
    assert!(
        set_cookie.starts_with("__Host-sa_flow=saf_") && set_cookie.contains("Secure"),
        "{set_cookie}"
    );
    let id = id_of(&r.json["flow"]);
    let r = email_and_verify(&ctx, &mut b, &id, &random_email("secure")).await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert!(b.cookie("__Host-sa_signup").is_some(), "{:?}", b.cookies);
    let r = b
        .post(&ctx, &format!("/v1/flows/{id}/signup"), json!({}))
        .await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert!(b.cookie("__Host-sa_session").is_some(), "{:?}", b.cookies);
}

#[tokio::test]
async fn state_and_nonce_come_back_exactly_as_sent() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let email = format!("{}@example.test", carbon.id().trim_start_matches("c:"));
    let (app, _) = ctx.app("briefcase").await;
    let mut b = Browser::new(&ctx);
    let f = new_flow(
        &ctx,
        &mut b,
        &app.app_id,
        json!({"state": " s1 ", "nonce": " n 1 "}),
    )
    .await;
    let id = id_of(&f);
    let r = email_and_verify(&ctx, &mut b, &id, &email).await;
    assert_eq!(r.status, 200, "{}", r.json);
    let r = b
        .post(
            &ctx,
            &format!("/v1/flows/{id}/consent"),
            json!({"approve": true}),
        )
        .await;
    let to = r.json["flow"]["redirect_to"]
        .as_str()
        .expect("redirect_to")
        .to_string();
    assert_eq!(query_param(&to, "state").as_deref(), Some(" s1 "));
    let grant = redeem(&ctx, &code_of(&to), &app.app_id).await;
    assert_eq!(grant.nonce.as_deref(), Some(" n 1 "));
    // Control characters can't be echoed safely: refused, with the error redirect.
    for field in ["state", "nonce"] {
        let r = start_flow(&ctx, &mut b, &app.app_id, json!({field: "a\u{0}b"})).await;
        assert_eq!(r.status, 400, "{field}: {}", r.json);
        assert_eq!(r.error_code(), Some("invalid_request"));
        assert!(
            r.json["error"]["message"]
                .as_str()
                .expect("message")
                .contains("control characters"),
            "{}",
            r.json
        );
        assert!(r.json["error"]["details"]["redirect_to"].is_string());
    }
}
