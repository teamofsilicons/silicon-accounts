//! Email and phone codes in the hosted flow: sending, verifying, the 10-try lockout, the
//! 10-per-10-minutes send limit, expiry, resend, domains and apps that take no new accounts.

mod common;

use accounts_core::test_support::{CarbonSpec, Req, TestContext};
use common::*;
use serde_json::json;

#[tokio::test]
async fn existing_account_signs_in_with_an_email_code() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let email = format!("{}@example.test", carbon.id().trim_start_matches("c:"));
    let (app, _) = ctx.app("briefcase").await;
    let mut b = Browser::new(&ctx);
    let f = new_flow(&ctx, &mut b, &app.app_id, json!({"nonce": "n-1"})).await;
    let id = id_of(&f);

    let r = b
        .post(
            &ctx,
            &format!("/v1/flows/{id}/email"),
            json!({"email": email.to_uppercase()}),
        )
        .await;
    assert_eq!(r.status, 200, "{}", r.json);
    let ch = &r.json["flow"]["challenge"];
    assert_eq!(ch["channel"], "email");
    assert!(
        ch["destination"]
            .as_str()
            .expect("dest")
            .contains("***@example.test")
    );
    assert!(ch["expires_at"].is_string() && ch["resend_available_at"].is_string());
    let outbox = ctx.outbox(&email).await;
    assert_eq!(outbox[0].0, "otp_signin");
    assert!(
        outbox[0].1.contains(&app.name),
        "the email names the app: {}",
        outbox[0].1
    );

    let code = last_code(&ctx, &email).await;
    let r = b
        .post(
            &ctx,
            &format!("/v1/flows/{id}/verify"),
            json!({"code": code}),
        )
        .await;
    assert_eq!(r.status, 200, "{}", r.json);
    let f = &r.json["flow"];
    assert_eq!(
        f["step"], "details",
        "first sign-in to the app shows what's shared"
    );
    assert_eq!(f["signed_in_as"]["uuid"], carbon.uuid.as_str());
    assert!(
        b.cookie("sa_session")
            .is_some_and(|c| c.starts_with("sas_"))
    );
    // An app that asks for no details: one what's-shared page showing the profile.
    assert_eq!(f["details"]["id"], "details");
    assert_eq!(f["details"]["fields"], json!([]));
    assert_eq!(
        (f["details"]["index"].clone(), f["details"]["count"].clone()),
        (json!(0), json!(1))
    );

    let r = continue_page(&ctx, &mut b, &id, &[]).await;
    assert_eq!(r.status, 200, "{}", r.json);
    let f = &r.json["flow"];
    assert_eq!(f["step"], "complete");
    let to = f["redirect_to"].as_str().expect("redirect_to");
    assert!(to.starts_with(&redirect_uri(&app.app_id)));
    assert_eq!(query_param(to, "state").as_deref(), Some(APP_STATE));
    let code = code_of(to);
    assert!(code.starts_with("sac_"));
    // The stored redirect is encrypted (it carries a live code).
    let stored: String =
        sqlx::query_scalar("select result_redirect from signin_flows where id = $1")
            .bind(&id)
            .fetch_one(&ctx.state.db)
            .await
            .expect("row");
    assert!(stored.starts_with("enc1:") && !stored.contains(&code));
    // GET after completion is idempotent.
    let again = b.get(&ctx, &format!("/v1/flows/{id}")).await;
    assert_eq!(again.json["flow"]["redirect_to"], f["redirect_to"]);

    let grant = redeem(&ctx, &code, &app.app_id).await;
    assert_eq!(grant.account_uuid, carbon.uuid);
    assert_eq!(grant.scopes, vec!["profile".to_string()]);
    assert_eq!(grant.nonce.as_deref(), Some("n-1"));
    assert!(grant.browser_session_id.is_some());
    let status: String = sqlx::query_scalar(
        "select status from memberships where app_id = $1 and account_uuid = $2",
    )
    .bind(&app.app_id)
    .bind(&carbon.uuid)
    .fetch_one(&ctx.state.db)
    .await
    .expect("membership");
    assert_eq!(status, "active");
    let history: (String, String) = sqlx::query_as(
        "select method, outcome from signin_history where account_uuid = $1 and app_id = $2",
    )
    .bind(&carbon.uuid)
    .bind(&app.app_id)
    .fetch_one(&ctx.state.db)
    .await
    .expect("history");
    assert_eq!(history, ("email".to_string(), "success".to_string()));
}

#[tokio::test]
async fn wrong_codes_count_down_then_lock_for_a_minute() {
    let ctx = TestContext::new().await;
    let (app, _) = ctx.app("briefcase").await;
    let mut b = Browser::new(&ctx);
    let f = new_flow(&ctx, &mut b, &app.app_id, json!({})).await;
    let id = id_of(&f);
    let email = random_email("lock");
    b.post(
        &ctx,
        &format!("/v1/flows/{id}/email"),
        json!({"email": email}),
    )
    .await;
    let right = last_code(&ctx, &email).await;
    let wrong = if right == "000000" {
        "111111"
    } else {
        "000000"
    };
    for remaining in (1..=9).rev() {
        let r = b
            .post(
                &ctx,
                &format!("/v1/flows/{id}/verify"),
                json!({"code": wrong}),
            )
            .await;
        assert_eq!(r.status, 422);
        assert_eq!(r.error_code(), Some("invalid_code"));
        assert_eq!(r.json["error"]["details"]["remaining_attempts"], remaining);
    }
    let r = b
        .post(
            &ctx,
            &format!("/v1/flows/{id}/verify"),
            json!({"code": wrong}),
        )
        .await;
    assert_eq!(r.status, 422);
    assert_eq!(r.json["error"]["details"]["remaining_attempts"], 0);
    assert_eq!(r.headers["retry-after"], "60");
    let r = b
        .post(
            &ctx,
            &format!("/v1/flows/{id}/verify"),
            json!({"code": right}),
        )
        .await;
    assert_eq!(r.status, 423, "even the right code waits out the cooldown");
    assert_eq!(r.error_code(), Some("verification_locked"));
    assert!(r.headers.get("retry-after").is_some());
    assert!(
        r.json["error"]["details"]["retry_after_seconds"]
            .as_u64()
            .is_some_and(|s| (1..=60).contains(&s))
    );
    ctx.exec("update otp_challenges set locked_until = now() - interval '1 second'")
        .await;
    let r = b
        .post(
            &ctx,
            &format!("/v1/flows/{id}/verify"),
            json!({"code": right}),
        )
        .await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(r.json["flow"]["step"], "signup");
    // Not 6 digits: refused without counting.
    let r = b
        .post(
            &ctx,
            &format!("/v1/flows/{id}/verify"),
            json!({"code": "12"}),
        )
        .await;
    assert_eq!(r.status, 409, "the flow moved on to sign-up: {}", r.json);
}

#[tokio::test]
async fn expired_codes_answer_410_and_resend_replaces_the_code() {
    let ctx = TestContext::new().await;
    let (app, _) = ctx.app("briefcase").await;
    let mut b = Browser::new(&ctx);
    let id = id_of(&new_flow(&ctx, &mut b, &app.app_id, json!({})).await);
    let email = random_email("expiry");
    b.post(
        &ctx,
        &format!("/v1/flows/{id}/email"),
        json!({"email": email}),
    )
    .await;
    let first = last_code(&ctx, &email).await;
    let r = b
        .post(&ctx, &format!("/v1/flows/{id}/resend"), json!({}))
        .await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(ctx.outbox(&email).await.len(), 2);
    let second = last_code(&ctx, &email).await;
    if first != second {
        let r = b
            .post(
                &ctx,
                &format!("/v1/flows/{id}/verify"),
                json!({"code": first}),
            )
            .await;
        assert!(
            r.error_code() == Some("invalid_code") || r.error_code() == Some("code_expired"),
            "the replaced code no longer works: {}",
            r.json
        );
    }
    ctx.exec("update otp_challenges set expires_at = now() - interval '1 second'")
        .await;
    let r = b
        .post(
            &ctx,
            &format!("/v1/flows/{id}/verify"),
            json!({"code": second}),
        )
        .await;
    assert_eq!(r.status, 410);
    assert_eq!(r.error_code(), Some("code_expired"));
    // A fresh code works again.
    let r = b
        .post(&ctx, &format!("/v1/flows/{id}/resend"), json!({}))
        .await;
    assert_eq!(r.status, 200);
    let third = last_code(&ctx, &email).await;
    let r = b
        .post(
            &ctx,
            &format!("/v1/flows/{id}/verify"),
            json!({"code": third}),
        )
        .await;
    assert_eq!(r.status, 200, "{}", r.json);
}

#[tokio::test]
async fn the_eleventh_code_in_ten_minutes_is_rate_limited() {
    let ctx = TestContext::new().await;
    let (app, _) = ctx.app("briefcase").await;
    let mut b = Browser::new(&ctx);
    let id = id_of(&new_flow(&ctx, &mut b, &app.app_id, json!({})).await);
    let email = random_email("limit");
    let r = b
        .post(
            &ctx,
            &format!("/v1/flows/{id}/email"),
            json!({"email": email}),
        )
        .await;
    assert_eq!(r.status, 200);
    for _ in 0..9 {
        let r = b
            .post(&ctx, &format!("/v1/flows/{id}/resend"), json!({}))
            .await;
        assert_eq!(r.status, 200, "{}", r.json);
    }
    let r = b
        .post(&ctx, &format!("/v1/flows/{id}/resend"), json!({}))
        .await;
    assert_eq!(r.status, 429);
    assert_eq!(r.error_code(), Some("rate_limited"));
    let retry: u64 = r.headers["retry-after"]
        .to_str()
        .expect("h")
        .parse()
        .expect("n");
    assert!((1..=600).contains(&retry));
    assert_eq!(r.json["error"]["details"]["retry_after_seconds"], retry);
    // The limit is per destination: starting over with the same email is limited too.
    let r = b
        .post(
            &ctx,
            &format!("/v1/flows/{id}/email"),
            json!({"email": email}),
        )
        .await;
    assert_eq!(r.status, 429);
    // The window passes.
    ctx.exec("update otp_challenges set created_at = now() - interval '11 minutes'")
        .await;
    let r = b
        .post(&ctx, &format!("/v1/flows/{id}/resend"), json!({}))
        .await;
    assert_eq!(r.status, 200, "{}", r.json);
}

#[tokio::test]
async fn phone_codes_use_e164_and_need_the_method() {
    let ctx = TestContext::new().await;
    let carbon = ctx
        .carbon_with(CarbonSpec {
            phone: Some("+919876543210".into()),
            ..Default::default()
        })
        .await;
    let (closed, _) = ctx.app("emailonly").await;
    let (app, _) = app_with(
        &ctx,
        "dm",
        json!({"methods": {"email": true, "phone": true}}),
    )
    .await;
    let mut b = Browser::new(&ctx);

    let id = id_of(&new_flow(&ctx, &mut b, &closed.app_id, json!({})).await);
    let r = b
        .post(
            &ctx,
            &format!("/v1/flows/{id}/phone"),
            json!({"phone": "+919876543210"}),
        )
        .await;
    assert_eq!(r.status, 403);
    assert_eq!(r.error_code(), Some("method_not_enabled"));
    assert_eq!(r.json["error"]["details"]["methods"], json!(["email"]));

    let f = new_flow(&ctx, &mut b, &app.app_id, json!({})).await;
    assert_eq!(f["methods"], json!(["email", "phone"]));
    let id = id_of(&f);
    let r = b
        .post(
            &ctx,
            &format!("/v1/flows/{id}/phone"),
            json!({"phone": "98765 43210"}),
        )
        .await;
    assert_eq!(r.status, 422);
    assert_eq!(r.error_code(), Some("invalid_phone"));
    let r = b
        .post(
            &ctx,
            &format!("/v1/flows/{id}/phone"),
            json!({"phone": "98765 43210", "country": "IN"}),
        )
        .await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(r.json["flow"]["challenge"]["channel"], "phone");
    assert_eq!(r.json["flow"]["challenge"]["destination"], "+91******3210");
    let outbox = ctx.outbox("+919876543210").await;
    assert!(
        outbox[0].1.contains(&format!("for {}", app.name)),
        "{}",
        outbox[0].1
    );
    let code = last_code(&ctx, "+919876543210").await;
    let r = b
        .post(
            &ctx,
            &format!("/v1/flows/{id}/verify"),
            json!({"code": code}),
        )
        .await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(r.json["flow"]["signed_in_as"]["uuid"], carbon.uuid.as_str());
}

#[tokio::test]
async fn allowed_email_domains_are_enforced() {
    let ctx = TestContext::new().await;
    let (app, _) = app_with(
        &ctx,
        "campus",
        json!({"allowed_email_domains": ["university.test"]}),
    )
    .await;
    let mut b = Browser::new(&ctx);
    let id = id_of(&new_flow(&ctx, &mut b, &app.app_id, json!({})).await);
    let r = b
        .post(
            &ctx,
            &format!("/v1/flows/{id}/email"),
            json!({"email": "ada@gmail.test"}),
        )
        .await;
    assert_eq!(r.status, 403);
    assert_eq!(r.error_code(), Some("email_domain_not_allowed"));
    assert_eq!(
        r.json["error"]["details"]["allowed_domains"],
        json!(["university.test"])
    );
    assert!(
        ctx.outbox("ada@gmail.test").await.is_empty(),
        "no code is wasted"
    );
    let r = email_and_verify(&ctx, &mut b, &id, "ada@university.test").await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(r.json["flow"]["step"], "signup");
}

#[tokio::test]
async fn closed_apps_refuse_new_accounts_but_not_existing_ones() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let existing = format!("{}@example.test", carbon.id().trim_start_matches("c:"));
    let (app, _) = app_with(&ctx, "legacy", json!({"allow_signup": false})).await;
    let mut b = Browser::new(&ctx);
    let id = id_of(&new_flow(&ctx, &mut b, &app.app_id, json!({})).await);
    let r = email_and_verify(&ctx, &mut b, &id, &random_email("newcomer")).await;
    assert_eq!(r.status, 403);
    assert_eq!(r.error_code(), Some("signup_not_allowed"));
    let r = b.get(&ctx, &format!("/v1/flows/{id}")).await;
    assert_eq!(r.json["flow"]["step"], "choose_method");
    assert_eq!(r.json["flow"]["error"]["code"], "signup_not_allowed");

    let r = email_and_verify(&ctx, &mut b, &id, &existing).await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(r.json["flow"]["step"], "details");
    assert_eq!(r.json["flow"]["error"], serde_json::Value::Null);
}

#[tokio::test]
async fn steps_are_enforced() {
    let ctx = TestContext::new().await;
    let (app, _) = ctx.app("briefcase").await;
    let mut b = Browser::new(&ctx);
    let id = id_of(&new_flow(&ctx, &mut b, &app.app_id, json!({})).await);
    let r = b
        .post(
            &ctx,
            &format!("/v1/flows/{id}/verify"),
            json!({"code": "123456"}),
        )
        .await;
    assert_eq!(r.status, 409);
    assert_eq!(r.error_code(), Some("invalid_step"));
    assert_eq!(r.json["error"]["details"]["step"], "choose_method");
    assert_eq!(
        r.json["error"]["details"]["allowed_steps"],
        json!(["verify_code"])
    );
    let r = b
        .post(&ctx, &format!("/v1/flows/{id}/resend"), json!({}))
        .await;
    assert_eq!(r.error_code(), Some("invalid_step"));
    for (path, body) in [
        ("review", json!({"approve": true})),
        ("review", json!({"approve": false})),
        ("details/continue", json!({"share": []})),
        ("details/back", json!({})),
        ("details/add", json!({"email": "x@example.test"})),
        ("details/verify", json!({"code": "123456"})),
        ("signup", json!({})),
    ] {
        let r = b.post(&ctx, &format!("/v1/flows/{id}/{path}"), body).await;
        assert_eq!(r.error_code(), Some("invalid_step"), "{path}: {}", r.json);
    }
    // The old steps' endpoints are gone.
    for path in ["consent", "requirements/email"] {
        let r = b
            .post(
                &ctx,
                &format!("/v1/flows/{id}/{path}"),
                json!({"approve": true}),
            )
            .await;
        assert_eq!(r.status, 404, "{path}: {}", r.json);
    }
}

/// A 6-digit code that isn't any of `codes`.
fn a_wrong_code(codes: &[String]) -> String {
    (0..1_000_000)
        .map(|n| format!("{n:06}"))
        .find(|c| !codes.contains(c))
        .expect("a wrong code")
}

#[tokio::test]
async fn the_lockout_counts_every_code_sent_to_the_address() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let email = format!("{}@example.test", carbon.id().trim_start_matches("c:"));
    let (app, _) = ctx.app("briefcase").await;
    let mut b = Browser::new(&ctx);
    // Five flows each send a code to the same address.
    let mut flows = Vec::new();
    for _ in 0..5 {
        let id = id_of(&new_flow(&ctx, &mut b, &app.app_id, json!({})).await);
        let r = b
            .post(
                &ctx,
                &format!("/v1/flows/{id}/email"),
                json!({"email": email}),
            )
            .await;
        assert_eq!(r.status, 200, "{}", r.json);
        flows.push(id);
    }
    let sent: Vec<String> = ctx
        .outbox(&email)
        .await
        .iter()
        .filter_map(|(_, t)| accounts_core::delivery::extract_code(t))
        .collect();
    let wrong = a_wrong_code(&sent);
    // Two wrong codes per flow: one streak for the address, counting down across flows.
    let mut expected = 9;
    for (i, id) in flows.iter().enumerate() {
        for j in 0..2 {
            let r = b
                .post(
                    &ctx,
                    &format!("/v1/flows/{id}/verify"),
                    json!({"code": wrong}),
                )
                .await;
            assert_eq!(r.status, 422, "{}", r.json);
            assert_eq!(r.error_code(), Some("invalid_code"));
            let remaining = &r.json["error"]["details"]["remaining_attempts"];
            if i == 4 && j == 1 {
                assert_eq!(remaining, 0, "the 10th wrong code for the address locks it");
                assert_eq!(r.headers["retry-after"], "60");
                assert!(r.json["error"]["details"]["locked_until"].is_string());
            } else {
                assert_eq!(remaining, expected, "flow {i}, try {j}: {}", r.json);
                expected -= 1;
            }
        }
    }
    // Now every code to the address waits out the cooldown: the right one, in any flow, in a
    // new flow, and in the CLI.
    let right = last_code(&ctx, &email).await;
    let r = b
        .post(
            &ctx,
            &format!("/v1/flows/{}/verify", flows[4]),
            json!({"code": right}),
        )
        .await;
    assert_eq!(r.status, 423, "{}", r.json);
    assert_eq!(r.error_code(), Some("verification_locked"));
    let fresh = id_of(&new_flow(&ctx, &mut b, &app.app_id, json!({})).await);
    let r = b
        .post(
            &ctx,
            &format!("/v1/flows/{fresh}/email"),
            json!({"email": email}),
        )
        .await;
    assert_eq!(r.status, 200, "sending is still allowed: {}", r.json);
    let fresh_code = last_code(&ctx, &email).await;
    let r = b
        .post(
            &ctx,
            &format!("/v1/flows/{fresh}/verify"),
            json!({"code": fresh_code}),
        )
        .await;
    assert_eq!(r.status, 423, "{}", r.json);
    assert!(r.headers.get("retry-after").is_some());
    let r = ctx
        .call(
            router(),
            Req::post("/v1/cli/login/start").json(json!({"email": email})),
        )
        .await;
    assert_eq!(r.status, 200, "{}", r.json);
    let cli_challenge = r.json["challenge_id"].as_str().expect("id").to_string();
    let cli_code = last_code(&ctx, &email).await;
    let r = ctx
        .call(
            router(),
            Req::post("/v1/cli/login/verify")
                .json(json!({"challenge_id": cli_challenge, "code": cli_code})),
        )
        .await;
    assert_eq!(r.status, 423, "{}", r.json);
    // The account's history shows the attempt that locked its address.
    let (method, outcome): (String, String) = sqlx::query_as(
        "select method, outcome from signin_history where account_uuid = $1 and app_id = $2",
    )
    .bind(&carbon.uuid)
    .bind(&app.app_id)
    .fetch_one(&ctx.state.db)
    .await
    .expect("history");
    assert_eq!((method.as_str(), outcome.as_str()), ("email", "failed"));
    let locks = scalar_i64(
        &ctx,
        "select count(*) from audit_log where account_uuid = $1 and action = 'signin.locked'",
        &carbon.uuid,
    )
    .await;
    assert_eq!(locks, 1);
    // After the cooldown the newest code works.
    ctx.exec("update otp_challenges set locked_until = now() - interval '1 second'")
        .await;
    let r = ctx
        .call(
            router(),
            Req::post("/v1/cli/login/verify")
                .json(json!({"challenge_id": cli_challenge, "code": cli_code})),
        )
        .await;
    assert_eq!(r.status, 200, "{}", r.json);
}

#[tokio::test]
async fn hosted_and_cli_codes_share_one_streak_that_a_right_code_ends() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let email = format!("{}@example.test", carbon.id().trim_start_matches("c:"));
    let (app, _) = ctx.app("briefcase").await;
    let mut b = Browser::new(&ctx);
    let id = id_of(&new_flow(&ctx, &mut b, &app.app_id, json!({})).await);
    b.post(
        &ctx,
        &format!("/v1/flows/{id}/email"),
        json!({"email": email}),
    )
    .await;
    let flow_code = last_code(&ctx, &email).await;
    let r = ctx
        .call(
            router(),
            Req::post("/v1/cli/login/start").json(json!({"email": email})),
        )
        .await;
    let cli_challenge = r.json["challenge_id"].as_str().expect("id").to_string();
    let cli_code = last_code(&ctx, &email).await;
    let wrong = a_wrong_code(&[flow_code.clone(), cli_code.clone()]);
    for remaining in [9, 8, 7] {
        let r = b
            .post(
                &ctx,
                &format!("/v1/flows/{id}/verify"),
                json!({"code": wrong}),
            )
            .await;
        assert_eq!(r.json["error"]["details"]["remaining_attempts"], remaining);
    }
    let r = ctx
        .call(
            router(),
            Req::post("/v1/cli/login/verify")
                .json(json!({"challenge_id": cli_challenge, "code": wrong})),
        )
        .await;
    assert_eq!(
        r.json["error"]["details"]["remaining_attempts"], 6,
        "the CLI code continues the address's streak: {}",
        r.json
    );
    let r = ctx
        .call(
            router(),
            Req::post("/v1/cli/login/verify")
                .json(json!({"challenge_id": cli_challenge, "code": cli_code})),
        )
        .await;
    assert_eq!(r.status, 200, "{}", r.json);
    let r = b
        .post(
            &ctx,
            &format!("/v1/flows/{id}/verify"),
            json!({"code": wrong}),
        )
        .await;
    assert_eq!(
        r.json["error"]["details"]["remaining_attempts"], 9,
        "a right code ended the streak"
    );
    let r = b
        .post(
            &ctx,
            &format!("/v1/flows/{id}/verify"),
            json!({"code": flow_code}),
        )
        .await;
    assert_eq!(r.status, 200, "{}", r.json);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_burst_of_parallel_guesses_is_still_counted_per_address() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let email = format!("{}@example.test", carbon.id().trim_start_matches("c:"));
    let (app, _) = ctx.app("briefcase").await;
    let mut b = Browser::new(&ctx);
    let mut flows = Vec::new();
    for _ in 0..5 {
        let id = id_of(&new_flow(&ctx, &mut b, &app.app_id, json!({})).await);
        b.post(
            &ctx,
            &format!("/v1/flows/{id}/email"),
            json!({"email": email}),
        )
        .await;
        flows.push(id);
    }
    let sent: Vec<String> = ctx
        .outbox(&email)
        .await
        .iter()
        .filter_map(|(_, t)| accounts_core::delivery::extract_code(t))
        .collect();
    let wrong = a_wrong_code(&sent);
    // 60 wrong guesses at once, spread over the five flows.
    let mut burst = tokio::task::JoinSet::new();
    for i in 0..60 {
        let req = b.apply(
            Req::post(&format!("/v1/flows/{}/verify", flows[i % 5])).json(json!({"code": wrong})),
        );
        let router = accounts_auth::router().with_state(ctx.state.clone());
        burst.spawn(accounts_core::test_support::call(router, req));
    }
    let (mut checked, mut locked, mut last) = (0, 0, 0);
    while let Some(r) = burst.join_next().await {
        let r = r.expect("task");
        match r.status.as_u16() {
            422 => {
                checked += 1;
                if r.json["error"]["details"]["remaining_attempts"] == 0 {
                    last += 1;
                }
            }
            423 => locked += 1,
            s => panic!("unexpected {s}: {}", r.json),
        }
    }
    assert_eq!(
        checked, 10,
        "exactly 10 guesses were checked for the address"
    );
    assert_eq!(last, 1, "one of them started the cooldown");
    assert_eq!(locked, 50);
}
