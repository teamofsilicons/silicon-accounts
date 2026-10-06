//! Browser session endpoints, device approval (the CLI device flow's browser half) and the
//! CLI's headless code sign-in.

mod common;

use accounts_core::models::AccountStatus;
use accounts_core::repo::tokens::{self, GrantError};
use accounts_core::test_support::{CarbonSpec, Req, TestContext};
use common::*;
use serde_json::json;

// ----------------------------------------------------------------------------- session

#[tokio::test]
async fn session_describes_the_signed_in_browser() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let cookie = ctx.browser_session(&carbon).await;
    let r = ctx
        .call(
            router(),
            Req::get("/v1/session").session(&ctx.state.settings, &cookie),
        )
        .await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(r.json["account"]["uuid"], carbon.uuid.as_str());
    assert_eq!(r.json["account"]["id"], carbon.id());
    assert_eq!(r.json["session"]["kind"], "browser");
    assert!(
        r.json["session"]["expires_at"].is_string() && r.json["session"]["created_at"].is_string()
    );
    assert_eq!(r.headers["cache-control"], "no-store");

    let r = ctx.call(router(), Req::get("/v1/session")).await;
    assert_eq!(r.status, 401);
    assert_eq!(r.error_code(), Some("unauthenticated"));

    let token = ctx.first_party_tokens(&carbon).await.access_token;
    let r = ctx
        .call(router(), Req::get("/v1/session").bearer(&token))
        .await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(r.json["session"]["kind"], "token");
    assert!(r.json["session"]["access_token_expires_at"].is_string());
}

#[tokio::test]
async fn signing_out_revokes_the_session_and_clears_cookies() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let cookie = ctx.browser_session(&carbon).await;

    let r = ctx
        .call(
            router(),
            Req::post("/v1/session/signout").header("cookie", &format!("sa_session={cookie}")),
        )
        .await;
    assert_eq!(r.status, 403, "a cookie sign-out needs the site's Origin");
    assert_eq!(r.error_code(), Some("origin_not_allowed"));

    let r = ctx
        .call(
            router(),
            Req::post("/v1/session/signout").session(&ctx.state.settings, &cookie),
        )
        .await;
    assert_eq!(r.status, 204, "{}", r.json);
    let cleared: Vec<String> = r
        .headers
        .get_all("set-cookie")
        .iter()
        .map(|v| v.to_str().expect("h").to_string())
        .collect();
    assert!(
        cleared
            .iter()
            .any(|c| c.starts_with("sa_session=;") && c.contains("Max-Age=0")),
        "{cleared:?}"
    );
    assert!(
        cleared.iter().any(|c| c.starts_with("sa_signup=;")),
        "{cleared:?}"
    );
    let r = ctx
        .call(
            router(),
            Req::get("/v1/session").session(&ctx.state.settings, &cookie),
        )
        .await;
    assert_eq!(r.status, 401);
    assert_eq!(r.error_code(), Some("session_expired"));
    let r = ctx
        .call(
            router(),
            Req::post("/v1/session/signout").session(&ctx.state.settings, &cookie),
        )
        .await;
    assert_eq!(r.status, 401, "already signed out");
    assert!(
        r.headers.get("set-cookie").is_some(),
        "the stale cookie is still cleared"
    );

    let token = ctx.first_party_tokens(&carbon).await.access_token;
    let r = ctx
        .call(router(), Req::post("/v1/session/signout").bearer(&token))
        .await;
    assert_eq!(r.status, 204);
    let r = ctx
        .call(router(), Req::get("/v1/session").bearer(&token))
        .await;
    assert_eq!(r.status, 401);
    assert_eq!(r.error_code(), Some("token_revoked"));
    let n = scalar_i64(
        &ctx,
        "select count(*) from audit_log where account_uuid = $1 and action = 'session.signed_out'",
        &carbon.uuid,
    )
    .await;
    assert_eq!(n, 2);
}

#[tokio::test]
async fn signing_out_ends_a_pending_sign_up_in_that_browser() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let (app, _) = ctx.app("briefcase").await;
    let mut b = Browser::new(&ctx);
    let id = id_of(&new_flow(&ctx, &mut b, &app.app_id, json!({})).await);
    let r = email_and_verify(&ctx, &mut b, &id, &random_email("pending")).await;
    assert_eq!(r.json["flow"]["step"], "signup");
    let cookie = ctx.browser_session(&carbon).await;
    b.cookies.insert("sa_session".into(), cookie);
    let r = b.post(&ctx, "/v1/session/signout", json!({})).await;
    assert_eq!(r.status, 204);
    let live = scalar_i64(
        &ctx,
        "select count(*) from signup_sessions where expires_at > now() and $1 <> ''",
        "x",
    )
    .await;
    assert_eq!(live, 0);
}

// ----------------------------------------------------------------------------- device

#[tokio::test]
async fn carbons_approve_or_deny_cli_device_sign_ins() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let cookie = ctx.browser_session(&carbon).await;
    let start = {
        let mut conn = ctx.conn().await;
        tokens::create_device(
            &mut conn,
            &ctx.state.keys.pepper,
            Some("accounts CLI on build-box"),
        )
        .await
        .expect("device")
    };
    let path = format!(
        "/v1/device/{}",
        start.user_code.to_lowercase().replace('-', "")
    );
    let r = ctx
        .call(
            router(),
            Req::get(&path).session(&ctx.state.settings, &cookie),
        )
        .await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(r.json["user_code"], start.user_code.as_str());
    assert_eq!(r.json["client_label"], "accounts CLI on build-box");
    assert_eq!(r.json["status"], "pending");

    let r = ctx
        .call(
            router(),
            Req::get("/v1/device/WDJB-MJHT").session(&ctx.state.settings, &cookie),
        )
        .await;
    assert_eq!(r.status, 404);
    assert_eq!(r.error_code(), Some("device_code_not_found"));
    let r = ctx.call(router(), Req::get(&path)).await;
    assert_eq!(r.status, 401);
    let (silicon, _) = ctx.silicon(&carbon.uuid).await;
    let silicon_token = ctx.first_party_tokens(&silicon).await.access_token;
    let r = ctx
        .call(router(), Req::get(&path).bearer(&silicon_token))
        .await;
    assert_eq!(r.status, 403);
    assert_eq!(r.error_code(), Some("carbon_only"));

    let approve = format!("/v1/device/{}/approve", start.user_code);
    let r = ctx
        .call(
            router(),
            Req::post(&approve).header("cookie", &format!("sa_session={cookie}")),
        )
        .await;
    assert_eq!(r.status, 403, "cookie POST without Origin");
    assert_eq!(r.error_code(), Some("origin_not_allowed"));
    let r = ctx
        .call(
            router(),
            Req::post(&approve).session(&ctx.state.settings, &cookie),
        )
        .await;
    assert_eq!(r.status, 204, "{}", r.json);
    let r = ctx
        .call(
            router(),
            Req::get(&path).session(&ctx.state.settings, &cookie),
        )
        .await;
    assert_eq!(r.json["status"], "approved");
    let r = ctx
        .call(
            router(),
            Req::post(&approve).session(&ctx.state.settings, &cookie),
        )
        .await;
    assert_eq!(r.status, 409);
    assert_eq!(r.error_code(), Some("device_code_used"));
    let polled = tokens::poll_device(&ctx.state.db, &ctx.state.keys.pepper, &start.device_code)
        .await
        .expect("approved");
    assert_eq!(polled.account_uuid.as_deref(), Some(carbon.uuid.as_str()));
    let n = scalar_i64(
        &ctx,
        "select count(*) from audit_log where account_uuid = $1 and action = 'device.approved'",
        &carbon.uuid,
    )
    .await;
    assert_eq!(n, 1);

    // Deny, with a bearer token this time.
    let token = ctx.first_party_tokens(&carbon).await.access_token;
    let denied = {
        let mut conn = ctx.conn().await;
        tokens::create_device(&mut conn, &ctx.state.keys.pepper, None)
            .await
            .expect("device")
    };
    let r = ctx
        .call(
            router(),
            Req::post(&format!("/v1/device/{}/deny", denied.user_code)).bearer(&token),
        )
        .await;
    assert_eq!(r.status, 204);
    let polled =
        tokens::poll_device(&ctx.state.db, &ctx.state.keys.pepper, &denied.device_code).await;
    assert!(matches!(polled, Err(GrantError::AccessDenied(_))));

    // Expired codes can't be approved.
    let late = {
        let mut conn = ctx.conn().await;
        tokens::create_device(&mut conn, &ctx.state.keys.pepper, None)
            .await
            .expect("device")
    };
    ctx.exec(&format!("update device_authorizations set expires_at = now() - interval '1 second' where user_code = '{}'", late.user_code)).await;
    let r = ctx
        .call(
            router(),
            Req::get(&format!("/v1/device/{}", late.user_code)).bearer(&token),
        )
        .await;
    assert_eq!(r.json["status"], "expired");
    let r = ctx
        .call(
            router(),
            Req::post(&format!("/v1/device/{}/approve", late.user_code)).bearer(&token),
        )
        .await;
    assert_eq!(r.status, 410);
    assert_eq!(r.error_code(), Some("device_code_expired"));
}

// ----------------------------------------------------------------------------- CLI code sign-in

#[tokio::test]
async fn cli_code_sign_in_returns_first_party_tokens() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let email = format!("{}@example.test", carbon.id().trim_start_matches("c:"));
    let r = ctx
        .call(
            router(),
            Req::post("/v1/cli/login/start").json(json!({"email": email.to_uppercase()})),
        )
        .await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert!(
        r.json["destination"]
            .as_str()
            .expect("d")
            .ends_with("***@example.test")
    );
    assert!(r.json["expires_at"].is_string());
    let challenge_id = r.json["challenge_id"].as_str().expect("id").to_string();
    assert_eq!(ctx.outbox(&email).await[0].0, "otp_cli_login");
    let code = last_code(&ctx, &email).await;
    let wrong = if code == "000000" { "111111" } else { "000000" };

    let r = ctx
        .call(
            router(),
            Req::post("/v1/cli/login/verify")
                .json(json!({"challenge_id": challenge_id, "code": wrong})),
        )
        .await;
    assert_eq!(r.status, 422);
    assert_eq!(r.error_code(), Some("invalid_code"));
    assert_eq!(r.json["error"]["details"]["remaining_attempts"], 9);

    let r = ctx
        .call(
            router(),
            Req::post("/v1/cli/login/verify").json(json!({"challenge_id": challenge_id, "code": code, "client_label": "accounts CLI on mac"})),
        )
        .await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(r.headers["cache-control"], "no-store");
    assert_eq!(r.json["token_type"], "Bearer");
    assert_eq!(r.json["expires_in"], 1800);
    assert_eq!(
        r.json["membership_id"],
        format!("accounts:{}", carbon.uuid).as_str()
    );
    let claims = ctx
        .state
        .keys
        .jwt
        .verify_access(
            r.json["access_token"].as_str().expect("at"),
            Some("accounts"),
        )
        .expect("a first-party access token");
    assert_eq!(claims.sub, carbon.uuid);
    let (origin, label): (String, String) =
        sqlx::query_as("select origin, label from token_families where account_uuid = $1")
            .bind(&carbon.uuid)
            .fetch_one(&ctx.state.db)
            .await
            .expect("family");
    assert_eq!(
        (origin.as_str(), label.as_str()),
        ("cli_code", "accounts CLI on mac")
    );

    let r = ctx
        .call(
            router(),
            Req::post("/v1/cli/login/verify")
                .json(json!({"challenge_id": challenge_id, "code": code})),
        )
        .await;
    assert_eq!(r.status, 409);
    assert_eq!(r.error_code(), Some("code_already_used"));
}

#[tokio::test]
async fn cli_code_sign_in_is_only_for_existing_active_carbons() {
    let ctx = TestContext::new().await;
    let unclaimed_email = random_email("unclaimed");
    ctx.carbon_with(CarbonSpec {
        email: Some(unclaimed_email.clone()),
        status: Some(AccountStatus::Unclaimed),
        ..Default::default()
    })
    .await;
    for email in [random_email("nobody"), unclaimed_email] {
        let r = ctx
            .call(
                router(),
                Req::post("/v1/cli/login/start").json(json!({"email": email})),
            )
            .await;
        assert_eq!(r.status, 404, "{}", r.json);
        assert_eq!(r.error_code(), Some("account_not_found"));
        assert!(
            r.json["error"]["hint"]
                .as_str()
                .expect("hint")
                .contains(&ctx.state.settings.public_url)
        );
        assert!(ctx.outbox(&email).await.is_empty());
    }
    let r = ctx
        .call(
            router(),
            Req::post("/v1/cli/login/start")
                .json(json!({"email": "a@b.test", "phone": "+14155550100"})),
        )
        .await;
    assert_eq!(r.status, 400);
    let r = ctx
        .call(router(), Req::post("/v1/cli/login/start").json(json!({})))
        .await;
    assert_eq!(r.status, 400);
    let r = ctx
        .call(
            router(),
            Req::post("/v1/cli/login/verify")
                .json(json!({"challenge_id": "nope", "code": "123456"})),
        )
        .await;
    assert_eq!(r.status, 400);
    assert_eq!(r.error_code(), Some("invalid_request"));
}

#[tokio::test]
async fn cli_code_sign_in_by_phone_and_its_send_limit() {
    let ctx = TestContext::new().await;
    let carbon = ctx
        .carbon_with(CarbonSpec {
            phone: Some("+919876543210".into()),
            ..Default::default()
        })
        .await;
    for _ in 0..10 {
        let r = ctx
            .call(
                router(),
                Req::post("/v1/cli/login/start")
                    .json(json!({"phone": "98765 43210", "country": "IN"})),
            )
            .await;
        assert_eq!(r.status, 200, "{}", r.json);
        assert_eq!(r.json["destination"], "+91******3210");
    }
    let r = ctx
        .call(
            router(),
            Req::post("/v1/cli/login/start").json(json!({"phone": "+919876543210"})),
        )
        .await;
    assert_eq!(r.status, 429);
    assert_eq!(r.error_code(), Some("rate_limited"));
    assert!(r.headers.get("retry-after").is_some());
    let _ = carbon;
}

#[tokio::test]
async fn cli_code_sign_in_needs_a_verified_address_of_the_account() {
    let ctx = TestContext::new().await;
    // An address an import listed on an account that someone else finished never signs in.
    let (app, _) = ctx.app("legacy").await;
    let victim = random_email("victim");
    let attacker = random_email("attacker");
    let uuid = unclaimed_import(&ctx, &[&victim, &attacker], &[]).await;
    let mut v = Browser::new(&ctx);
    let id = id_of(&new_flow(&ctx, &mut v, &app.app_id, json!({})).await);
    let r = email_and_verify(&ctx, &mut v, &id, &victim).await;
    assert_eq!(r.json["flow"]["step"], "signup", "{}", r.json);
    let r = v
        .post(&ctx, &format!("/v1/flows/{id}/signup"), json!({}))
        .await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(emails_of(&ctx, &uuid).await, vec![(victim, true)]);
    let r = ctx
        .call(
            router(),
            Req::post("/v1/cli/login/start").json(json!({"email": attacker})),
        )
        .await;
    assert_eq!(r.status, 404, "{}", r.json);
    assert_eq!(r.error_code(), Some("account_not_found"));
    assert!(ctx.outbox(&attacker).await.is_empty());

    // An unverified row on an active account (as left before claims removed them).
    let holder = ctx.carbon().await;
    let stranger = random_email("stranger");
    unproven_email(&ctx, &holder.uuid, &stranger).await;
    let r = ctx
        .call(
            router(),
            Req::post("/v1/cli/login/start").json(json!({"email": stranger})),
        )
        .await;
    assert_eq!(r.status, 404, "{}", r.json);
    assert!(ctx.outbox(&stranger).await.is_empty());

    // An address removed from the account between the code and its use.
    let second = random_email("second");
    {
        let mut conn = ctx.conn().await;
        accounts_core::repo::contacts::add_verified_email(
            &mut conn,
            &holder.uuid,
            &second,
            accounts_core::models::VerifiedVia::Code,
        )
        .await
        .expect("second email");
    }
    let r = ctx
        .call(
            router(),
            Req::post("/v1/cli/login/start").json(json!({"email": second})),
        )
        .await;
    assert_eq!(r.status, 200, "{}", r.json);
    let challenge_id = r.json["challenge_id"].as_str().expect("id").to_string();
    let code = last_code(&ctx, &second).await;
    ctx.exec(&format!(
        "delete from account_emails where email = '{second}'"
    ))
    .await;
    let r = ctx
        .call(
            router(),
            Req::post("/v1/cli/login/verify")
                .json(json!({"challenge_id": challenge_id, "code": code})),
        )
        .await;
    assert_eq!(r.status, 404, "{}", r.json);
    assert_eq!(r.error_code(), Some("account_not_found"));
    let families = scalar_i64(
        &ctx,
        "select count(*) from token_families where account_uuid = $1",
        &holder.uuid,
    )
    .await;
    assert_eq!(families, 0, "no tokens were issued");
}

#[tokio::test]
async fn a_cli_code_lockout_shows_in_the_accounts_sign_in_history() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let email = format!("{}@example.test", carbon.id().trim_start_matches("c:"));
    let r = ctx
        .call(
            router(),
            Req::post("/v1/cli/login/start").json(json!({"email": email})),
        )
        .await;
    let challenge_id = r.json["challenge_id"].as_str().expect("id").to_string();
    let code = last_code(&ctx, &email).await;
    let wrong = if code == "000000" { "111111" } else { "000000" };
    for remaining in (0..=9).rev() {
        let r = ctx
            .call(
                router(),
                Req::post("/v1/cli/login/verify")
                    .json(json!({"challenge_id": challenge_id, "code": wrong})),
            )
            .await;
        assert_eq!(r.status, 422, "{}", r.json);
        assert_eq!(r.json["error"]["details"]["remaining_attempts"], remaining);
    }
    let r = ctx
        .call(
            router(),
            Req::post("/v1/cli/login/verify")
                .json(json!({"challenge_id": challenge_id, "code": code})),
        )
        .await;
    assert_eq!(r.status, 423, "{}", r.json);
    let (app_id, method, outcome): (String, String, String) = sqlx::query_as(
        "select app_id, method, outcome from signin_history where account_uuid = $1",
    )
    .bind(&carbon.uuid)
    .fetch_one(&ctx.state.db)
    .await
    .expect("history");
    assert_eq!(
        (app_id.as_str(), method.as_str(), outcome.as_str()),
        ("accounts", "email", "failed")
    );
}
