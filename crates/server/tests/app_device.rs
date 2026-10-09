//! Apps' own command-line and desktop tools: the device authorization grant (RFC 8628) for any
//! app that turns on `device_flow`, and public clients (RFC 8252) for apps that turn on
//! `public_client`. Driven through the whole router.

use accounts_core::crypto::pkce;
use accounts_core::models::{App, Scope};
use accounts_core::repo::tokens::{self, NewAuthCode};
use accounts_core::test_support::{CarbonSpec, Req, Resp, TestContext, call};
use serde_json::{Value, json};

const DEVICE_GRANT: &str = "urn:ietf:params:oauth:grant-type:device_code";

async fn send(ctx: &TestContext, req: Req) -> Resp {
    call(accounts_server::build_router(ctx.state.clone()), req).await
}

async fn configure(ctx: &TestContext, app: &App, secret: &str, patch: Value) {
    let r = send(
        ctx,
        Req::patch(&format!("/v1/apps/{}/signin-config", app.app_id))
            .basic(&app.app_id, secret)
            .json(patch),
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.json);
}

async fn start(ctx: &TestContext, body: Value) -> Resp {
    send(ctx, Req::post("/v1/device/authorize").json(body)).await
}

/// Polls as the public client `client_id` (no secret), past the 5-second interval.
async fn poll(ctx: &TestContext, client_id: &str, device_code: &str) -> Resp {
    ctx.exec("update device_authorizations set last_polled_at = now() - interval '10 seconds'")
        .await;
    send(
        ctx,
        Req::post("/v1/oauth/token").form(&[
            ("grant_type", DEVICE_GRANT),
            ("device_code", device_code),
            ("client_id", client_id),
        ]),
    )
    .await
}

fn site(ctx: &TestContext, req: Req, cookie: &str) -> Req {
    req.session(&ctx.state.settings, cookie)
}

#[tokio::test]
async fn an_apps_cli_signs_a_carbon_in_with_a_code() {
    let ctx = TestContext::new().await;
    let (app, secret) = ctx.app("notes").await;
    configure(
        &ctx,
        &app,
        &secret,
        json!({"device_flow": true, "required_fields": ["email"], "optional_fields": ["timezone"]}),
    )
    .await;
    let carbon = ctx.carbon().await;
    let cookie = ctx.browser_session(&carbon).await;

    // The tool names its app, without a secret, and asks for the optional timezone.
    let r = start(
        &ctx,
        json!({"client_id": app.app_id, "scope": "timezone", "client_label": "Notes CLI on build-box"}),
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.json);
    let device_code = r.json["device_code"]
        .as_str()
        .expect("device_code")
        .to_string();
    let user_code = r.json["user_code"].as_str().expect("user_code").to_string();
    assert_eq!(
        r.json["verification_uri"],
        ctx.state.settings.url("/device").as_str()
    );
    let r = poll(&ctx, &app.app_id, &device_code).await;
    assert_eq!(r.json["error"], "authorization_pending", "{}", r.json);

    // The approval page sees the app and what it will share.
    let r = send(
        &ctx,
        site(&ctx, Req::get(&format!("/v1/device/{user_code}")), &cookie),
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(r.json["first_party"], false);
    assert_eq!(r.json["app_id"], app.app_id.as_str());
    assert_eq!(r.json["app"]["name"], app.name.as_str());
    assert!(r.json["app"]["branding"].is_object());
    assert_eq!(r.json["scopes"], json!(["profile", "email", "timezone"]));
    assert_eq!(r.json["client_label"], "Notes CLI on build-box");

    let r = send(
        &ctx,
        site(
            &ctx,
            Req::post(&format!("/v1/device/{user_code}/approve")),
            &cookie,
        ),
    )
    .await;
    assert_eq!(r.status, 204, "{}", r.json);

    // The tool's next poll gets tokens for the app.
    let r = poll(&ctx, &app.app_id, &device_code).await;
    assert_eq!(r.status, 200, "{}", r.json);
    let access = r.json["access_token"].as_str().expect("access").to_string();
    let refresh = r.json["refresh_token"]
        .as_str()
        .expect("refresh")
        .to_string();
    let scope = r.json["scope"].as_str().expect("scope");
    for s in ["profile", "email", "timezone"] {
        assert!(scope.split(' ').any(|x| x == s), "{scope}");
    }
    let claims = ctx
        .state
        .keys
        .jwt
        .verify_access(&access, Some(&app.app_id))
        .expect("an access token for the app");
    assert_eq!(claims.sub, carbon.uuid);
    let (status, granted): (String, Vec<String>) = sqlx::query_as(
        "select status, granted_scopes from memberships where app_id = $1 and account_uuid = $2",
    )
    .bind(&app.app_id)
    .bind(&carbon.uuid)
    .fetch_one(&ctx.state.db)
    .await
    .expect("membership");
    assert_eq!(status, "active");
    assert!(granted.contains(&"timezone".to_string()), "{granted:?}");
    let method: String = sqlx::query_scalar(
        "select method from signin_history where account_uuid = $1 and app_id = $2",
    )
    .bind(&carbon.uuid)
    .bind(&app.app_id)
    .fetch_one(&ctx.state.db)
    .await
    .expect("signin");
    assert_eq!(method, "device");
    // A code is used once.
    let r = poll(&ctx, &app.app_id, &device_code).await;
    assert_eq!(r.json["error"], "invalid_grant", "{}", r.json);

    // The public tool refreshes with its client_id alone, and may not do what needs a secret.
    let r = send(
        &ctx,
        Req::post("/v1/oauth/token").form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", &refresh),
            ("client_id", &app.app_id),
        ]),
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.json);
    let r = send(
        &ctx,
        Req::post("/v1/oauth/token").form(&[
            ("grant_type", "slt"),
            ("slt", "slt_x"),
            ("client_id", &app.app_id),
        ]),
    )
    .await;
    assert_eq!(r.json["error"], "unauthorized_client", "{}", r.json);
    let r = send(
        &ctx,
        Req::post("/v1/oauth/introspect").form(&[("token", &access), ("client_id", &app.app_id)]),
    )
    .await;
    assert_eq!(r.json["error"], "invalid_client", "{}", r.json);
    // The app's own credentials still work for the device grant too.
    let r = start(&ctx, json!({"client_id": app.app_id})).await;
    let device_code = r.json["device_code"]
        .as_str()
        .expect("device_code")
        .to_string();
    let r = send(
        &ctx,
        Req::post("/v1/oauth/token")
            .basic(&app.app_id, &secret)
            .form(&[("grant_type", DEVICE_GRANT), ("device_code", &device_code)]),
    )
    .await;
    assert_eq!(r.json["error"], "authorization_pending", "{}", r.json);
}

#[tokio::test]
async fn device_sign_ins_follow_the_apps_rules() {
    let ctx = TestContext::new().await;
    let (off, off_secret) = ctx.app("plain").await;
    // Off by default: the app's tool can't start one, and its credentials can't poll one.
    let r = start(&ctx, json!({"client_id": off.app_id})).await;
    assert_eq!(r.status, 400, "{}", r.json);
    assert_eq!(r.error_code(), Some("unauthorized_client"));
    assert!(
        r.json["error"]["hint"]
            .as_str()
            .is_some_and(|h| h.contains("device_flow"))
    );
    let r = send(
        &ctx,
        Req::post("/v1/oauth/token").form(&[
            ("grant_type", DEVICE_GRANT),
            ("device_code", "sad_x"),
            ("client_id", &off.app_id),
        ]),
    )
    .await;
    assert_eq!(
        r.json["error"], "invalid_client",
        "no secret, no public client: {}",
        r.json
    );
    let r = send(
        &ctx,
        Req::post("/v1/device/authorize")
            .basic(&off.app_id, "sa_app_wrong")
            .json(json!({})),
    )
    .await;
    assert_eq!(r.status, 401, "{}", r.json);
    let _ = off_secret;

    let (campus, campus_secret) = ctx.app("campus").await;
    configure(
        &ctx,
        &campus,
        &campus_secret,
        json!({"device_flow": true, "allowed_email_domains": ["university.test"], "optional_fields": ["timezone"]}),
    )
    .await;
    let r = start(&ctx, json!({"client_id": campus.app_id, "scope": "phone"})).await;
    assert_eq!(r.status, 400);
    assert_eq!(
        r.error_code(),
        Some("invalid_scope"),
        "phone isn't asked for"
    );

    // A Carbon whose email is at another domain can't approve.
    let outsider = ctx.carbon().await;
    let cookie = ctx.browser_session(&outsider).await;
    let r = start(&ctx, json!({"client_id": campus.app_id})).await;
    let user_code = r.json["user_code"].as_str().expect("code").to_string();
    let device_code = r.json["device_code"].as_str().expect("device").to_string();
    let r = send(
        &ctx,
        site(
            &ctx,
            Req::post(&format!("/v1/device/{user_code}/approve")),
            &cookie,
        ),
    )
    .await;
    assert_eq!(r.status, 403, "{}", r.json);
    assert_eq!(r.error_code(), Some("email_domain_not_allowed"));
    let r = poll(&ctx, &campus.app_id, &device_code).await;
    assert_eq!(
        r.json["error"], "authorization_pending",
        "still waiting: {}",
        r.json
    );

    // A phone-only Carbon has no email at the domains either.
    let phone_only = ctx
        .carbon_with(CarbonSpec {
            email: Some(String::new()),
            phone: Some("+14155550177".into()),
            ..Default::default()
        })
        .await;
    let phone_cookie = ctx.browser_session(&phone_only).await;
    let r = send(
        &ctx,
        site(
            &ctx,
            Req::post(&format!("/v1/device/{user_code}/approve")),
            &phone_cookie,
        ),
    )
    .await;
    assert_eq!(
        r.error_code(),
        Some("email_domain_not_allowed"),
        "{}",
        r.json
    );

    // Another app's tool can't take the code, and it stays usable for its own app.
    let (other, other_secret) = ctx.app("other").await;
    configure(&ctx, &other, &other_secret, json!({"device_flow": true})).await;
    let student = ctx
        .carbon_with(CarbonSpec {
            email: Some(format!(
                "s{}@university.test",
                accounts_core::test_support::rand_suffix()
            )),
            ..Default::default()
        })
        .await;
    let student_cookie = ctx.browser_session(&student).await;
    let r = send(
        &ctx,
        site(
            &ctx,
            Req::post(&format!("/v1/device/{user_code}/approve")),
            &student_cookie,
        ),
    )
    .await;
    assert_eq!(r.status, 204, "{}", r.json);
    let r = poll(&ctx, &other.app_id, &device_code).await;
    assert_eq!(r.json["error"], "invalid_grant", "{}", r.json);
    let r = poll(&ctx, &campus.app_id, &device_code).await;
    assert_eq!(r.status, 200, "{}", r.json);

    // A required phone the Carbon doesn't have.
    configure(
        &ctx,
        &campus,
        &campus_secret,
        json!({"required_fields": ["phone"]}),
    )
    .await;
    let r = start(&ctx, json!({"client_id": campus.app_id})).await;
    let user_code = r.json["user_code"].as_str().expect("code").to_string();
    let r = send(
        &ctx,
        site(
            &ctx,
            Req::post(&format!("/v1/device/{user_code}/approve")),
            &student_cookie,
        ),
    )
    .await;
    assert_eq!(r.status, 409, "{}", r.json);
    assert_eq!(r.error_code(), Some("requirements_missing"));
    assert_eq!(r.json["error"]["details"]["missing"], json!(["phone"]));

    // Denied: the tool hears so.
    let r = start(&ctx, json!({"client_id": other.app_id})).await;
    let user_code = r.json["user_code"].as_str().expect("code").to_string();
    let device_code = r.json["device_code"].as_str().expect("device").to_string();
    let r = send(
        &ctx,
        site(
            &ctx,
            Req::post(&format!("/v1/device/{user_code}/deny")),
            &student_cookie,
        ),
    )
    .await;
    assert_eq!(r.status, 204);
    let r = poll(&ctx, &other.app_id, &device_code).await;
    assert_eq!(r.json["error"], "access_denied", "{}", r.json);

    // Turning device_flow off stops approvals of codes made before.
    let r = start(&ctx, json!({"client_id": other.app_id})).await;
    let user_code = r.json["user_code"].as_str().expect("code").to_string();
    configure(&ctx, &other, &other_secret, json!({"device_flow": false})).await;
    let r = send(
        &ctx,
        site(
            &ctx,
            Req::post(&format!("/v1/device/{user_code}/approve")),
            &student_cookie,
        ),
    )
    .await;
    assert_eq!(r.error_code(), Some("device_flow_off"), "{}", r.json);
}

#[tokio::test]
async fn public_clients_redeem_codes_only_with_pkce() {
    let ctx = TestContext::new().await;
    let (app, secret) = ctx.app("desk").await;
    let carbon = ctx.carbon().await;
    ctx.membership(&app.app_id, &carbon.uuid, &[Scope::Profile])
        .await;
    let redirect = format!("http://127.0.0.1:8593/{}/callback", app.app_id);
    let code = |challenge: Option<String>| {
        let ctx = &ctx;
        let app_id = app.app_id.clone();
        let account = carbon.uuid.clone();
        let redirect = redirect.clone();
        async move {
            let mut conn = ctx.conn().await;
            tokens::create_code(
                &mut conn,
                &ctx.state.keys.pepper,
                &NewAuthCode {
                    flow_id: "flow-test",
                    app_id: &app_id,
                    account_uuid: &account,
                    redirect_uri: &redirect,
                    code_challenge: challenge.as_deref(),
                    code_challenge_method: challenge.as_ref().map(|_| "S256"),
                    scopes: &[Scope::Profile],
                    nonce: None,
                    browser_session_id: None,
                    auth_time: None,
                },
            )
            .await
            .expect("code")
        }
    };
    let verifier = "a-verifier-that-is-long-enough-for-pkce-0123456789";
    let exchange = |code: String, verifier: Option<&'static str>| {
        let mut form = vec![
            ("grant_type".to_string(), "authorization_code".to_string()),
            ("code".to_string(), code),
            ("redirect_uri".to_string(), redirect.clone()),
            ("client_id".to_string(), app.app_id.clone()),
        ];
        if let Some(v) = verifier {
            form.push(("code_verifier".into(), v.into()));
        }
        let pairs: Vec<(&str, &str)> = form.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
        Req::post("/v1/oauth/token").form(&pairs)
    };

    // Without public_client the secret is required.
    let c = code(Some(pkce::s256_challenge(verifier))).await;
    let r = send(&ctx, exchange(c, Some(verifier))).await;
    assert_eq!(r.json["error"], "invalid_client", "{}", r.json);

    configure(&ctx, &app, &secret, json!({"public_client": true})).await;
    let c = code(Some(pkce::s256_challenge(verifier))).await;
    let r = send(&ctx, exchange(c, Some(verifier))).await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert!(r.json["refresh_token"].is_string());
    // A code without PKCE is refused to a public client (and used up).
    let c = code(None).await;
    let r = send(&ctx, exchange(c, None)).await;
    assert_eq!(r.json["error"], "invalid_grant", "{}", r.json);
    assert!(
        r.json["error_description"]
            .as_str()
            .is_some_and(|d| d.contains("PKCE")),
        "{}",
        r.json
    );
    // Device codes stay off unless device_flow is on.
    let r = start(&ctx, json!({"client_id": app.app_id})).await;
    assert_eq!(r.error_code(), Some("unauthorized_client"));

    // Loopback redirect URIs take any port (RFC 8252 section 7.3).
    let config = {
        let mut conn = ctx.conn().await;
        accounts_core::repo::apps::effective_config(&mut conn, &ctx.state.settings, &app.app_id)
            .await
            .expect("config")
    };
    assert!(config.public_client);
    assert!(config.redirect_allowed(
        &ctx.state.settings,
        &app.app_id,
        &format!("http://127.0.0.1:53682/{}/callback", app.app_id)
    ));
}
