//! The what's-shared screen, the requirements step, "continue as", switching account and the
//! prompt values (login, consent, select_account, none).

mod common;

use accounts_core::models::Account;
use accounts_core::test_support::{CarbonSpec, TestContext};
use common::*;
use serde_json::{Value, json};

fn email_of(a: &Account) -> String {
    format!("{}@example.test", a.id().trim_start_matches("c:"))
}

/// Signs `email` in to `app_id` in browser `b` with a code; returns (flow id, flow).
async fn code_sign_in(
    ctx: &TestContext,
    b: &mut Browser,
    app_id: &str,
    email: &str,
    extra: Value,
) -> (String, Value) {
    let id = id_of(&new_flow(ctx, b, app_id, extra).await);
    let r = email_and_verify(ctx, b, &id, email).await;
    assert_eq!(r.status, 200, "{}", r.json);
    (id, r.json["flow"].clone())
}

#[tokio::test]
async fn consent_lists_required_and_optional_details_and_records_the_choice() {
    let ctx = TestContext::new().await;
    let carbon = ctx
        .carbon_with(CarbonSpec {
            timezone: Some("Asia/Kolkata".into()),
            ..Default::default()
        })
        .await;
    let (app, _) = app_with(
        &ctx,
        "briefcase",
        json!({"required_fields": ["email"], "optional_fields": ["timezone"]}),
    )
    .await;
    let mut b = Browser::new(&ctx);
    let (id, f) = code_sign_in(
        &ctx,
        &mut b,
        &app.app_id,
        &email_of(&carbon),
        json!({"scope": "openid dob"}),
    )
    .await;
    assert_eq!(f["step"], "consent");
    let c = &f["consent"];
    let required: Vec<&str> = c["required"]
        .as_array()
        .expect("req")
        .iter()
        .map(|i| i["scope"].as_str().expect("s"))
        .collect();
    assert_eq!(required, vec!["profile", "email"]);
    assert_eq!(
        c["required"][1]["value"],
        accounts_core::normalize::mask_email(&email_of(&carbon)).as_str(),
        "masked like the code destinations"
    );
    assert_eq!(c["required"][1]["label"], "Email address");
    let optional: Vec<(&str, bool)> = c["optional"]
        .as_array()
        .expect("opt")
        .iter()
        .map(|i| {
            (
                i["scope"].as_str().expect("s"),
                i["granted"].as_bool().expect("g"),
            )
        })
        .collect();
    assert_eq!(
        optional,
        vec![("dob", true), ("timezone", false)],
        "asked-for details start ticked"
    );
    assert_eq!(c["optional"][1]["value"], "Asia/Kolkata");

    let r = b
        .post(
            &ctx,
            &format!("/v1/flows/{id}/consent"),
            json!({"approve": true, "optional_scopes": ["phone"]}),
        )
        .await;
    assert_eq!(r.status, 422);
    assert!(
        r.json["error"]["details"]["fields"]["optional_scopes[0]"]
            .as_str()
            .expect("f")
            .contains("dob, timezone")
    );

    let r = b
        .post(
            &ctx,
            &format!("/v1/flows/{id}/consent"),
            json!({"approve": true, "optional_scopes": ["timezone"]}),
        )
        .await;
    assert_eq!(r.status, 200, "{}", r.json);
    let code = code_of(r.json["flow"]["redirect_to"].as_str().expect("to"));
    let grant = redeem(&ctx, &code, &app.app_id).await;
    assert_eq!(grant.scopes, vec!["profile", "email", "timezone", "openid"]);
    let granted: Vec<String> = sqlx::query_scalar(
        "select unnest(granted_scopes) from memberships where app_id = $1 and account_uuid = $2",
    )
    .bind(&app.app_id)
    .bind(&carbon.uuid)
    .fetch_all(&ctx.state.db)
    .await
    .expect("scopes");
    assert_eq!(granted, vec!["profile", "email", "timezone"]);
}

#[tokio::test]
async fn returning_accounts_skip_consent_unless_the_app_asks_for_more() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let email = email_of(&carbon);
    let (app, _) = app_with(&ctx, "commit", json!({"required_fields": ["email"]})).await;
    let mut b = Browser::new(&ctx);
    let (id, _) = code_sign_in(&ctx, &mut b, &app.app_id, &email, json!({})).await;
    b.post(
        &ctx,
        &format!("/v1/flows/{id}/consent"),
        json!({"approve": true}),
    )
    .await;

    let mut fresh = Browser::new(&ctx);
    let (_, f) = code_sign_in(&ctx, &mut fresh, &app.app_id, &email, json!({})).await;
    assert_eq!(f["step"], "complete", "everything was granted before: {f}");
    let grant = redeem(
        &ctx,
        &code_of(f["redirect_to"].as_str().expect("to")),
        &app.app_id,
    )
    .await;
    assert_eq!(grant.scopes, vec!["profile", "email"]);

    let mut fresh = Browser::new(&ctx);
    let (_, f) = code_sign_in(
        &ctx,
        &mut fresh,
        &app.app_id,
        &email,
        json!({"prompt": "consent"}),
    )
    .await;
    assert_eq!(f["step"], "consent", "prompt=consent always shows it");
    assert_eq!(
        f["consent"]["previously_granted"],
        json!(["profile", "email"])
    );

    let mut fresh = Browser::new(&ctx);
    let (_, f) = code_sign_in(
        &ctx,
        &mut fresh,
        &app.app_id,
        &email,
        json!({"scope": "timezone"}),
    )
    .await;
    assert_eq!(f["step"], "consent", "asking for more shows it again");
}

#[tokio::test]
async fn declining_sends_access_denied_back() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let (app, _) = ctx.app("briefcase").await;
    let mut b = Browser::new(&ctx);
    let (id, _) = code_sign_in(&ctx, &mut b, &app.app_id, &email_of(&carbon), json!({})).await;
    let r = b
        .post(
            &ctx,
            &format!("/v1/flows/{id}/consent"),
            json!({"approve": false}),
        )
        .await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(r.json["flow"]["step"], "complete");
    let to = r.json["flow"]["redirect_to"].as_str().expect("to");
    assert_eq!(query_param(to, "error").as_deref(), Some("access_denied"));
    assert_eq!(query_param(to, "state").as_deref(), Some(APP_STATE));
    assert!(query_param(to, "code").is_none());
    let n = scalar_i64(
        &ctx,
        "select count(*) from memberships where account_uuid = $1",
        &carbon.uuid,
    )
    .await;
    assert_eq!(n, 0);
    let outcome: String =
        sqlx::query_scalar("select outcome from signin_history where account_uuid = $1")
            .bind(&carbon.uuid)
            .fetch_one(&ctx.state.db)
            .await
            .expect("history");
    assert_eq!(outcome, "failed");
}

#[tokio::test]
async fn requirements_collect_a_missing_phone_with_an_inline_code() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    ctx.carbon_with(CarbonSpec {
        phone: Some("+14155550100".into()),
        ..Default::default()
    })
    .await;
    let (app, _) = app_with(
        &ctx,
        "dm",
        json!({"methods": {"email": true, "phone": true}, "required_fields": ["phone"]}),
    )
    .await;
    let mut b = Browser::new(&ctx);
    let (id, f) = code_sign_in(&ctx, &mut b, &app.app_id, &email_of(&carbon), json!({})).await;
    assert_eq!(f["step"], "requirements");
    assert_eq!(f["requirements"]["missing"], json!(["phone"]));
    assert_eq!(f["requirements"]["challenge"], Value::Null);

    let r = b
        .post(
            &ctx,
            &format!("/v1/flows/{id}/requirements/verify"),
            json!({"code": "123456"}),
        )
        .await;
    assert_eq!(r.status, 409);
    assert_eq!(r.error_code(), Some("no_code_sent"));
    let r = b
        .post(
            &ctx,
            &format!("/v1/flows/{id}/requirements/email"),
            json!({"email": random_email("x")}),
        )
        .await;
    assert_eq!(r.status, 409);
    assert_eq!(r.error_code(), Some("requirement_not_needed"));
    let r = b
        .post(
            &ctx,
            &format!("/v1/flows/{id}/requirements/phone"),
            json!({"phone": "+14155550100"}),
        )
        .await;
    assert_eq!(r.status, 409);
    assert_eq!(r.error_code(), Some("phone_in_use"));

    let r = b
        .post(
            &ctx,
            &format!("/v1/flows/{id}/requirements/phone"),
            json!({"phone": "(415) 555-0101", "country": "US"}),
        )
        .await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(
        r.json["flow"]["requirements"]["challenge"]["channel"],
        "phone"
    );
    let outbox = ctx.outbox("+14155550101").await;
    assert_eq!(outbox[0].0, "otp_requirement");
    let r = b
        .post(&ctx, &format!("/v1/flows/{id}/resend"), json!({}))
        .await;
    assert_eq!(
        r.status, 200,
        "resend works for the requirement code: {}",
        r.json
    );
    let code = last_code(&ctx, "+14155550101").await;
    let wrong = if code == "000000" { "111111" } else { "000000" };
    let r = b
        .post(
            &ctx,
            &format!("/v1/flows/{id}/requirements/verify"),
            json!({"code": wrong}),
        )
        .await;
    assert_eq!(r.status, 422);
    assert_eq!(r.json["error"]["details"]["remaining_attempts"], 9);
    let r = b
        .post(
            &ctx,
            &format!("/v1/flows/{id}/requirements/verify"),
            json!({"code": code}),
        )
        .await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(r.json["flow"]["step"], "consent");
    assert_eq!(
        r.json["flow"]["consent"]["required"][1]["value"],
        "+14*****0101"
    );
    let mut conn = ctx.conn().await;
    let phones = accounts_core::repo::contacts::list_phones(&mut conn, &carbon.uuid)
        .await
        .expect("phones");
    assert_eq!(phones.len(), 1);
    assert!(phones[0].is_primary && phones[0].verified_at.is_some());
}

#[tokio::test]
async fn acting_for_the_account_needs_its_browser_session() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let other = ctx.carbon().await;
    let (app, _) = ctx.app("briefcase").await;
    let mut b = Browser::new(&ctx);
    let (id, _) = code_sign_in(&ctx, &mut b, &app.app_id, &email_of(&carbon), json!({})).await;
    let mut signed_out = b.clone();
    signed_out.cookies.remove("sa_session");
    let r = signed_out
        .post(
            &ctx,
            &format!("/v1/flows/{id}/consent"),
            json!({"approve": true}),
        )
        .await;
    assert_eq!(r.status, 401);
    assert_eq!(r.error_code(), Some("session_required"));
    let mut switched = b.clone();
    let cookie = ctx.browser_session(&other).await;
    switched.cookies.insert("sa_session".into(), cookie);
    let r = switched
        .post(
            &ctx,
            &format!("/v1/flows/{id}/consent"),
            json!({"approve": true}),
        )
        .await;
    assert_eq!(r.status, 409);
    assert_eq!(r.error_code(), Some("account_changed"));
    let r = b
        .post(
            &ctx,
            &format!("/v1/flows/{id}/consent"),
            json!({"approve": true}),
        )
        .await;
    assert_eq!(r.status, 200, "{}", r.json);
}

#[tokio::test]
async fn a_requirement_lost_before_consent_sends_the_flow_back() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let (app, _) = app_with(&ctx, "briefcase", json!({"required_fields": ["email"]})).await;
    let mut b = Browser::new(&ctx);
    let (id, f) = code_sign_in(&ctx, &mut b, &app.app_id, &email_of(&carbon), json!({})).await;
    assert_eq!(f["step"], "consent");
    ctx.exec(&format!(
        "update account_emails set verified_at = null where account_uuid = '{}'",
        carbon.uuid
    ))
    .await;
    let r = b
        .post(
            &ctx,
            &format!("/v1/flows/{id}/consent"),
            json!({"approve": true}),
        )
        .await;
    assert_eq!(r.status, 409);
    assert_eq!(r.error_code(), Some("requirements_missing"));
    assert_eq!(r.json["error"]["details"]["missing"], json!(["email"]));
    let r = b.get(&ctx, &format!("/v1/flows/{id}")).await;
    assert_eq!(r.json["flow"]["step"], "requirements");
}

#[tokio::test]
async fn the_browsers_account_is_offered_and_continues_in_one_click() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let (first, _) = ctx.app("commit").await;
    let (second, _) = ctx.app("remind").await;
    let (forgetful, _) = app_with(&ctx, "spacestation", json!({"remember_browser": false})).await;
    let (campus, _) = app_with(
        &ctx,
        "campus",
        json!({"allowed_email_domains": ["university.test"]}),
    )
    .await;
    let mut b = Browser::new(&ctx);
    let (id, _) = code_sign_in(&ctx, &mut b, &first.app_id, &email_of(&carbon), json!({})).await;
    b.post(
        &ctx,
        &format!("/v1/flows/{id}/consent"),
        json!({"approve": true}),
    )
    .await;

    // Another app in the same browser: "Continue as".
    let f = new_flow(&ctx, &mut b, &second.app_id, json!({})).await;
    assert_eq!(f["step"], "choose_method");
    assert_eq!(f["signed_in_as"]["uuid"], carbon.uuid.as_str());
    let r = b
        .post(
            &ctx,
            &format!("/v1/flows/{}/continue", id_of(&f)),
            json!({}),
        )
        .await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(r.json["flow"]["step"], "consent");
    let r = b
        .post(
            &ctx,
            &format!("/v1/flows/{}/consent", id_of(&f)),
            json!({"approve": true}),
        )
        .await;
    assert_eq!(r.json["flow"]["step"], "complete");
    let method: String = sqlx::query_scalar(
        "select method from signin_history where account_uuid = $1 and app_id = $2",
    )
    .bind(&carbon.uuid)
    .bind(&second.app_id)
    .fetch_one(&ctx.state.db)
    .await
    .expect("history");
    assert_eq!(method, "session");

    // select_account shows the chooser too.
    let f = new_flow(
        &ctx,
        &mut b,
        &second.app_id,
        json!({"prompt": "select_account"}),
    )
    .await;
    assert_eq!(f["signed_in_as"]["uuid"], carbon.uuid.as_str());
    assert_eq!(f["prompt"], "select_account");

    // prompt=login ignores the session.
    let f = new_flow(&ctx, &mut b, &second.app_id, json!({"prompt": "login"})).await;
    assert_eq!(f["signed_in_as"], Value::Null);
    let r = b
        .post(
            &ctx,
            &format!("/v1/flows/{}/continue", id_of(&f)),
            json!({}),
        )
        .await;
    assert_eq!(r.status, 403);
    assert_eq!(r.error_code(), Some("reauthentication_required"));

    // remember_browser=false never offers it.
    let f = new_flow(&ctx, &mut b, &forgetful.app_id, json!({})).await;
    assert_eq!(f["signed_in_as"], Value::Null);
    let r = b
        .post(
            &ctx,
            &format!("/v1/flows/{}/continue", id_of(&f)),
            json!({}),
        )
        .await;
    assert_eq!(r.error_code(), Some("continue_not_allowed"));

    // Domain-restricted apps check the account's verified emails.
    let f = new_flow(&ctx, &mut b, &campus.app_id, json!({})).await;
    let r = b
        .post(
            &ctx,
            &format!("/v1/flows/{}/continue", id_of(&f)),
            json!({}),
        )
        .await;
    assert_eq!(r.status, 403);
    assert_eq!(r.error_code(), Some("email_domain_not_allowed"));

    // "Use another account".
    let f = new_flow(&ctx, &mut b, &second.app_id, json!({})).await;
    let r = b
        .post(&ctx, &format!("/v1/flows/{}/switch", id_of(&f)), json!({}))
        .await;
    assert_eq!(r.status, 200);
    assert_eq!(r.json["flow"]["step"], "choose_method");
    assert_eq!(
        r.json["flow"]["signed_in_as"],
        Value::Null,
        "not offered again after switching"
    );

    // No session: nothing to continue as.
    let mut fresh = Browser::new(&ctx);
    let f = new_flow(&ctx, &mut fresh, &second.app_id, json!({})).await;
    let r = fresh
        .post(
            &ctx,
            &format!("/v1/flows/{}/continue", id_of(&f)),
            json!({}),
        )
        .await;
    assert_eq!(r.status, 401);
    assert_eq!(r.error_code(), Some("session_required"));
}

#[tokio::test]
async fn prompt_none_signs_in_silently_or_explains_why_not() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let (app, _) = ctx.app("commit").await;
    let (other, _) = ctx.app("waveform").await;
    let (needs_phone, _) = app_with(&ctx, "dm", json!({"required_fields": ["phone"]})).await;
    let mut b = Browser::new(&ctx);
    let (id, _) = code_sign_in(&ctx, &mut b, &app.app_id, &email_of(&carbon), json!({})).await;
    b.post(
        &ctx,
        &format!("/v1/flows/{id}/consent"),
        json!({"approve": true}),
    )
    .await;

    let f = new_flow(&ctx, &mut b, &app.app_id, json!({"prompt": "none"})).await;
    assert_eq!(f["step"], "complete", "{f}");
    let grant = redeem(
        &ctx,
        &code_of(f["redirect_to"].as_str().expect("to")),
        &app.app_id,
    )
    .await;
    assert_eq!(grant.account_uuid, carbon.uuid);

    let f = new_flow(&ctx, &mut b, &other.app_id, json!({"prompt": "none"})).await;
    assert_eq!(f["step"], "failed");
    assert_eq!(f["error"]["code"], "consent_required");
    assert_eq!(
        query_param(f["redirect_to"].as_str().expect("to"), "error").as_deref(),
        Some("consent_required")
    );

    let f = new_flow(&ctx, &mut b, &needs_phone.app_id, json!({"prompt": "none"})).await;
    assert_eq!(f["error"]["code"], "interaction_required");
}

#[tokio::test]
async fn a_silicons_session_is_never_offered_or_continued() {
    let ctx = TestContext::new().await;
    let custodian = ctx.carbon().await;
    let (silicon, _) = ctx.silicon(&custodian.uuid).await;
    let (app, _) = ctx.app("remind").await;
    let mut b = Browser::new(&ctx);
    b.cookies
        .insert("sa_session".into(), ctx.browser_session(&silicon).await);
    let f = new_flow(&ctx, &mut b, &app.app_id, json!({})).await;
    assert_eq!(f["signed_in_as"], Value::Null);
    let r = b
        .post(
            &ctx,
            &format!("/v1/flows/{}/continue", id_of(&f)),
            json!({}),
        )
        .await;
    assert_eq!(r.status, 403);
    assert_eq!(r.error_code(), Some("carbon_only"));
    assert!(
        r.json["error"]["hint"]
            .as_str()
            .expect("hint")
            .contains("accounts login --app")
    );
}

#[tokio::test]
async fn a_requirement_met_elsewhere_moves_waiting_flows_on() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let (app, _) = app_with(
        &ctx,
        "dm",
        json!({"methods": {"email": true, "phone": true}, "required_fields": ["phone"]}),
    )
    .await;
    let mut b = Browser::new(&ctx);
    let (id1, f1) = code_sign_in(&ctx, &mut b, &app.app_id, &email_of(&carbon), json!({})).await;
    assert_eq!(f1["step"], "requirements");
    // Two more tabs of the same app reach the requirements step.
    let mut waiting = Vec::new();
    for _ in 0..2 {
        let id = id_of(&new_flow(&ctx, &mut b, &app.app_id, json!({})).await);
        let r = b
            .post(&ctx, &format!("/v1/flows/{id}/continue"), json!({}))
            .await;
        assert_eq!(r.json["flow"]["step"], "requirements", "{}", r.json);
        waiting.push(id);
    }
    // Tab 1 adds the phone.
    let r = b
        .post(
            &ctx,
            &format!("/v1/flows/{id1}/requirements/phone"),
            json!({"phone": "+14155550177"}),
        )
        .await;
    assert_eq!(r.status, 200, "{}", r.json);
    let code = last_code(&ctx, "+14155550177").await;
    let r = b
        .post(
            &ctx,
            &format!("/v1/flows/{id1}/requirements/verify"),
            json!({"code": code}),
        )
        .await;
    assert_eq!(r.json["flow"]["step"], "consent", "{}", r.json);
    // Tab 2 moves on by itself when it looks again.
    let r = b.get(&ctx, &format!("/v1/flows/{}", waiting[0])).await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(r.json["flow"]["step"], "consent", "{}", r.json);
    assert_eq!(r.json["flow"]["requirements"], Value::Null);
    let r = b
        .post(
            &ctx,
            &format!("/v1/flows/{}/consent", waiting[0]),
            json!({"approve": true}),
        )
        .await;
    assert_eq!(r.json["flow"]["step"], "complete", "{}", r.json);
    // Tab 3, still showing the old page, sends a phone: nothing is missing, so it moves on
    // (the consent above covers it now, so it completes).
    let r = b
        .post(
            &ctx,
            &format!("/v1/flows/{}/requirements/phone", waiting[1]),
            json!({"phone": "+14155550178"}),
        )
        .await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(r.json["flow"]["step"], "complete", "{}", r.json);
    assert!(
        ctx.outbox("+14155550178").await.is_empty(),
        "no code was sent"
    );
}

#[tokio::test]
async fn an_app_that_stops_requiring_a_detail_releases_waiting_flows() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let (app, _) = app_with(
        &ctx,
        "dm",
        json!({"methods": {"email": true, "phone": true}, "required_fields": ["phone"]}),
    )
    .await;
    let mut b = Browser::new(&ctx);
    let (id, f) = code_sign_in(&ctx, &mut b, &app.app_id, &email_of(&carbon), json!({})).await;
    assert_eq!(f["step"], "requirements");
    set_config(&ctx, &app.app_id, json!({"required_fields": []})).await;
    // Only the browser signed in as the flow's account moves it on.
    let mut signed_out = b.clone();
    signed_out.cookies.remove("sa_session");
    let r = signed_out.get(&ctx, &format!("/v1/flows/{id}")).await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(r.json["flow"]["step"], "requirements");
    let r = b.get(&ctx, &format!("/v1/flows/{id}")).await;
    assert_eq!(r.json["flow"]["step"], "consent", "{}", r.json);
}
