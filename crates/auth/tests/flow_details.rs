//! The details pages (the app's flow steps: what's shared, required details with an inline
//! code, optional details unticked until ticked), the review page, "continue as", switching
//! account and the prompt values (login, consent, select_account, none).

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

/// The scopes of an account's membership with an app.
async fn granted(ctx: &TestContext, app_id: &str, uuid: &str) -> Vec<String> {
    sqlx::query_scalar(
        "select unnest(granted_scopes) from memberships where app_id = $1 and account_uuid = $2",
    )
    .bind(app_id)
    .bind(uuid)
    .fetch_all(&ctx.state.db)
    .await
    .expect("scopes")
}

fn row(field: &str, mode: &str, shared: bool, missing: bool) -> (String, String, bool, bool) {
    (field.into(), mode.into(), shared, missing)
}

#[tokio::test]
async fn the_default_flow_is_one_page_with_required_and_unticked_optional_details() {
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
    assert_eq!(f["step"], "details");
    let d = &f["details"];
    assert_eq!(d["id"], "details");
    assert_eq!(
        (d["index"].clone(), d["count"].clone()),
        (json!(0), json!(1))
    );
    assert_eq!(d["title"], Value::Null);
    assert_eq!(d["layout"], Value::Null);
    assert_eq!(d["challenge"], Value::Null);
    assert_eq!(
        d["review_next"], false,
        "the default flow has no review page"
    );
    assert_eq!(
        page_fields(&f),
        vec![
            row("email", "required", true, false),
            row("timezone", "optional", false, false),
            // A detail only the scope parameter asks for: optional, on the last page.
            row("dob", "optional", false, false),
        ],
        "optional details start unticked the first time: {d}"
    );
    assert_eq!(
        d["fields"][0]["value"],
        accounts_core::normalize::mask_email(&email_of(&carbon)).as_str(),
        "masked like the code destinations"
    );
    assert_eq!(d["fields"][0]["label"], "Email address");
    assert_eq!(d["fields"][1]["value"], "Asia/Kolkata");
    assert_eq!(d["fields"][1]["previously_granted"], false);

    // Only this page's optional details can be ticked.
    let r = continue_page(&ctx, &mut b, &id, &["phone"]).await;
    assert_eq!(r.status, 422);
    let msg = r.json["error"]["details"]["fields"]["share[0]"]
        .as_str()
        .expect("field error");
    assert!(msg.contains("timezone, dob"), "{msg}");
    let r = continue_page(&ctx, &mut b, &id, &["telepathy"]).await;
    assert_eq!(r.status, 422);

    // Required details may be listed; they are always shared.
    let r = continue_page(&ctx, &mut b, &id, &["timezone", "email"]).await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(r.json["flow"]["step"], "complete");
    let code = code_of(r.json["flow"]["redirect_to"].as_str().expect("to"));
    let grant = redeem(&ctx, &code, &app.app_id).await;
    assert_eq!(grant.scopes, vec!["profile", "email", "timezone", "openid"]);
    assert_eq!(
        granted(&ctx, &app.app_id, &carbon.uuid).await,
        vec!["profile", "email", "timezone"],
        "dob was left unticked"
    );
}

#[tokio::test]
async fn a_flow_walks_its_pages_in_order_and_reviews_before_finishing() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let (app, _) = app_with(
        &ctx,
        "ledgerly",
        json!({
            "methods": {"email": true, "phone": true},
            "required_fields": ["email", "dob"],
            "optional_fields": ["timezone", "phone"],
            "flow": {"steps": [
                {"id": "contact", "fields": ["email", "phone"], "title": "How can we reach you?", "subtitle": null, "continue_label": null, "layout": null},
                {"id": "about-you", "fields": ["dob", "timezone"], "title": null, "subtitle": "For your tax year", "continue_label": "Finish", "layout": "split"}
            ], "review": true}
        }),
    )
    .await;
    let mut b = Browser::new(&ctx);
    let (id, f) = code_sign_in(&ctx, &mut b, &app.app_id, &email_of(&carbon), json!({})).await;
    assert_eq!(f["step"], "details");
    let d = &f["details"];
    assert_eq!(
        (
            d["id"].clone(),
            d["index"].clone(),
            d["count"].clone(),
            d["title"].clone()
        ),
        (
            json!("contact"),
            json!(0),
            json!(2),
            json!("How can we reach you?")
        )
    );
    assert_eq!(d["review_next"], false, "page 1 of 2 continues to page 2");
    assert_eq!(
        page_fields(&f),
        vec![
            row("email", "required", true, false),
            row("phone", "optional", false, true),
        ]
    );
    // An optional email/phone the account doesn't have can't be ticked without adding it.
    let r = continue_page(&ctx, &mut b, &id, &["phone"]).await;
    assert_eq!(r.status, 422);
    assert!(
        r.json["error"]["details"]["fields"]["share[0]"]
            .as_str()
            .is_some_and(|m| m.contains("details/add")),
        "{}",
        r.json
    );
    let r = continue_page(&ctx, &mut b, &id, &[]).await;
    assert_eq!(r.status, 200, "{}", r.json);
    let f = &r.json["flow"];
    let d = &f["details"];
    assert_eq!(
        (d["id"].clone(), d["index"].clone(), d["count"].clone()),
        (json!("about-you"), json!(1), json!(2))
    );
    assert_eq!(
        (
            d["subtitle"].clone(),
            d["continue_label"].clone(),
            d["layout"].clone()
        ),
        (json!("For your tax year"), json!("Finish"), json!("split"))
    );
    assert_eq!(
        d["review_next"], true,
        "the last page of a flow with review opens it"
    );
    assert_eq!(
        page_fields(f),
        vec![
            row("dob", "required", true, false),
            row("timezone", "optional", false, false),
        ]
    );
    let r = continue_page(&ctx, &mut b, &id, &["timezone"]).await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(r.json["flow"]["step"], "review");
    let review: Vec<(String, String, bool)> = r.json["flow"]["review"]["fields"]
        .as_array()
        .expect("review")
        .iter()
        .map(|f| {
            (
                f["field"].as_str().expect("field").to_string(),
                f["mode"].as_str().expect("mode").to_string(),
                f["shared"].as_bool().expect("shared"),
            )
        })
        .collect();
    assert_eq!(
        review,
        vec![
            ("profile".into(), "required".into(), true),
            ("email".into(), "required".into(), true),
            ("dob".into(), "required".into(), true),
            ("timezone".into(), "optional".into(), true),
        ],
        "profile first, then what will be shared"
    );
    assert_eq!(
        r.json["flow"]["review"]["fields"][0]["value"],
        format!("{} ({})", carbon.display_name, carbon.id()).as_str()
    );

    // Back from the review page keeps the answers.
    let r = b
        .post(&ctx, &format!("/v1/flows/{id}/details/back"), json!({}))
        .await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(r.json["flow"]["details"]["id"], "about-you");
    assert_eq!(
        page_fields(&r.json["flow"])[1],
        row("timezone", "optional", true, false),
        "the tick is kept"
    );
    let r = b
        .post(&ctx, &format!("/v1/flows/{id}/details/back"), json!({}))
        .await;
    assert_eq!(r.json["flow"]["details"]["id"], "contact");
    let r = b
        .post(&ctx, &format!("/v1/flows/{id}/details/back"), json!({}))
        .await;
    assert_eq!(r.status, 409);
    assert_eq!(r.error_code(), Some("no_previous_page"));
    // Approving is only for the review page.
    let r = b
        .post(
            &ctx,
            &format!("/v1/flows/{id}/review"),
            json!({"approve": true}),
        )
        .await;
    assert_eq!(r.status, 409);
    assert_eq!(r.error_code(), Some("invalid_step"));

    let r = finish_pages(&ctx, &mut b, &id, &["timezone"]).await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(r.json["flow"]["step"], "complete");
    let grant = redeem(
        &ctx,
        &code_of(r.json["flow"]["redirect_to"].as_str().expect("to")),
        &app.app_id,
    )
    .await;
    assert_eq!(grant.scopes, vec!["profile", "email", "dob", "timezone"]);

    // A returning Carbon who granted everything skips the pages; one asked for more sees
    // only the page with something new.
    let mut fresh = Browser::new(&ctx);
    let (_, f) = code_sign_in(&ctx, &mut fresh, &app.app_id, &email_of(&carbon), json!({})).await;
    assert_eq!(f["step"], "complete", "{f}");
    let mut fresh = Browser::new(&ctx);
    let (id, f) = code_sign_in(
        &ctx,
        &mut fresh,
        &app.app_id,
        &email_of(&carbon),
        json!({"scope": "phone"}),
    )
    .await;
    assert_eq!(f["details"]["id"], "contact", "{f}");
    assert_eq!(f["details"]["count"], 1);
    let r = finish_pages(&ctx, &mut fresh, &id, &[]).await;
    assert_eq!(r.json["flow"]["step"], "complete", "{}", r.json);
    assert_eq!(
        granted(&ctx, &app.app_id, &carbon.uuid).await,
        vec!["profile", "email", "dob", "timezone"],
        "an optional detail on a page the Carbon didn't see keeps its grant"
    );
}

#[tokio::test]
async fn returning_carbons_see_what_they_shared_ticked_and_can_untick_it() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let email = email_of(&carbon);
    let (app, _) = app_with(
        &ctx,
        "commit",
        json!({"required_fields": ["email"], "optional_fields": ["timezone"]}),
    )
    .await;
    let mut b = Browser::new(&ctx);
    let (id, _) = code_sign_in(&ctx, &mut b, &app.app_id, &email, json!({})).await;
    continue_page(&ctx, &mut b, &id, &["timezone"]).await;
    assert_eq!(
        granted(&ctx, &app.app_id, &carbon.uuid).await,
        vec!["profile", "email", "timezone"]
    );

    let mut fresh = Browser::new(&ctx);
    let (_, f) = code_sign_in(&ctx, &mut fresh, &app.app_id, &email, json!({})).await;
    assert_eq!(f["step"], "complete", "everything was granted before: {f}");
    let grant = redeem(
        &ctx,
        &code_of(f["redirect_to"].as_str().expect("to")),
        &app.app_id,
    )
    .await;
    assert_eq!(grant.scopes, vec!["profile", "email", "timezone"]);

    // prompt=consent shows the page again, with what was shared ticked.
    let mut fresh = Browser::new(&ctx);
    let (id, f) = code_sign_in(
        &ctx,
        &mut fresh,
        &app.app_id,
        &email,
        json!({"prompt": "consent"}),
    )
    .await;
    assert_eq!(f["step"], "details", "prompt=consent always shows it");
    assert_eq!(
        page_fields(&f),
        vec![
            row("email", "required", true, false),
            row("timezone", "optional", true, false),
        ]
    );
    assert_eq!(f["details"]["fields"][1]["previously_granted"], true);
    // Unticking stops sharing it.
    let r = continue_page(&ctx, &mut fresh, &id, &[]).await;
    assert_eq!(r.json["flow"]["step"], "complete", "{}", r.json);
    assert_eq!(
        granted(&ctx, &app.app_id, &carbon.uuid).await,
        vec!["profile", "email"]
    );

    // Asking for more (scope) shows the page again.
    let mut fresh = Browser::new(&ctx);
    let (_, f) = code_sign_in(
        &ctx,
        &mut fresh,
        &app.app_id,
        &email,
        json!({"scope": "timezone"}),
    )
    .await;
    assert_eq!(f["step"], "details", "asking for more shows it again");
}

#[tokio::test]
async fn cancelling_sends_access_denied_back() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let (app, _) = ctx.app("briefcase").await;
    let mut b = Browser::new(&ctx);
    let (id, _) = code_sign_in(&ctx, &mut b, &app.app_id, &email_of(&carbon), json!({})).await;
    let r = b
        .post(
            &ctx,
            &format!("/v1/flows/{id}/review"),
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
async fn a_missing_required_phone_is_added_on_its_page_with_a_code() {
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
    assert_eq!(f["step"], "details");
    assert_eq!(page_fields(&f), vec![row("phone", "required", true, true)]);
    assert_eq!(f["details"]["fields"][0]["value"], Value::Null);

    let r = continue_page(&ctx, &mut b, &id, &[]).await;
    assert_eq!(r.status, 409);
    assert_eq!(r.error_code(), Some("requirements_missing"));
    assert_eq!(r.json["error"]["details"]["missing"], json!(["phone"]));
    let r = b
        .post(
            &ctx,
            &format!("/v1/flows/{id}/details/verify"),
            json!({"code": "123456"}),
        )
        .await;
    assert_eq!(r.status, 409);
    assert_eq!(r.error_code(), Some("no_code_sent"));
    let r = b
        .post(
            &ctx,
            &format!("/v1/flows/{id}/details/add"),
            json!({"email": random_email("x")}),
        )
        .await;
    assert_eq!(r.status, 409);
    assert_eq!(r.error_code(), Some("detail_not_on_page"));
    let r = b
        .post(&ctx, &format!("/v1/flows/{id}/details/add"), json!({}))
        .await;
    assert_eq!(r.status, 422, "{}", r.json);
    let r = b
        .post(
            &ctx,
            &format!("/v1/flows/{id}/details/add"),
            json!({"phone": "+14155550100"}),
        )
        .await;
    assert_eq!(r.status, 409);
    assert_eq!(r.error_code(), Some("phone_in_use"));

    let r = b
        .post(
            &ctx,
            &format!("/v1/flows/{id}/details/add"),
            json!({"phone": "(415) 555-0101", "country": "US"}),
        )
        .await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(r.json["flow"]["details"]["challenge"]["channel"], "phone");
    let outbox = ctx.outbox("+14155550101").await;
    assert_eq!(outbox[0].0, "otp_requirement");
    let r = b
        .post(&ctx, &format!("/v1/flows/{id}/resend"), json!({}))
        .await;
    assert_eq!(
        r.status, 200,
        "resend works for the details code: {}",
        r.json
    );
    let code = last_code(&ctx, "+14155550101").await;
    let wrong = if code == "000000" { "111111" } else { "000000" };
    let r = b
        .post(
            &ctx,
            &format!("/v1/flows/{id}/details/verify"),
            json!({"code": wrong}),
        )
        .await;
    assert_eq!(r.status, 422);
    assert_eq!(r.json["error"]["details"]["remaining_attempts"], 9);
    let r = b
        .post(
            &ctx,
            &format!("/v1/flows/{id}/details/verify"),
            json!({"code": code}),
        )
        .await;
    assert_eq!(r.status, 200, "{}", r.json);
    let f = &r.json["flow"];
    assert_eq!(
        f["step"], "details",
        "the page stays until the Carbon continues"
    );
    assert_eq!(page_fields(f), vec![row("phone", "required", true, false)]);
    assert_eq!(f["details"]["fields"][0]["value"], "+14*****0101");
    assert_eq!(f["details"]["challenge"], Value::Null);
    let mut conn = ctx.conn().await;
    let phones = accounts_core::repo::contacts::list_phones(&mut conn, &carbon.uuid)
        .await
        .expect("phones");
    assert_eq!(phones.len(), 1);
    assert!(phones[0].is_primary && phones[0].verified_at.is_some());
    drop(conn);
    // The activity names the number and the app ("Phone number +1… added while signing in to …"),
    // as the account site's own adds do.
    let added: Value = sqlx::query_scalar(
        "select details from audit_log where account_uuid = $1 and action = 'contact.added'",
    )
    .bind(&carbon.uuid)
    .fetch_one(&ctx.state.db)
    .await
    .expect("contact.added");
    assert_eq!(
        added,
        json!({"via": "requirement", "app_id": app.app_id, "kind": "phone", "phone": "+14155550101"})
    );
    let r = continue_page(&ctx, &mut b, &id, &[]).await;
    assert_eq!(r.json["flow"]["step"], "complete", "{}", r.json);
    assert_eq!(
        granted(&ctx, &app.app_id, &carbon.uuid).await,
        vec!["profile", "phone"]
    );
}

/// Adding a missing email or phone on a details page answers 409 when another account has it,
/// so every attempt counts toward the account site's add limits (one shared budget): 20 per
/// account per 10 minutes, then 429, also when every answer was 409.
#[tokio::test]
async fn adding_a_detail_counts_toward_the_account_sites_add_limits() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let taken = "+14155550177";
    ctx.carbon_with(CarbonSpec {
        phone: Some(taken.into()),
        ..Default::default()
    })
    .await;
    let (app, _) = app_with(
        &ctx,
        "legacy",
        json!({"required_fields": ["email"], "optional_fields": ["phone"]}),
    )
    .await;
    let mut b = Browser::new(&ctx);
    let (id, f) = code_sign_in(&ctx, &mut b, &app.app_id, &email_of(&carbon), json!({})).await;
    assert_eq!(f["step"], "details");
    for i in 0..20 {
        let r = b
            .post(
                &ctx,
                &format!("/v1/flows/{id}/details/add"),
                json!({"phone": taken}),
            )
            .await;
        assert_eq!(
            r.error_code(),
            Some("phone_in_use"),
            "attempt {i}: {}",
            r.json
        );
    }
    let r = b
        .post(
            &ctx,
            &format!("/v1/flows/{id}/details/add"),
            json!({"phone": taken}),
        )
        .await;
    assert_eq!(r.status, 429, "{}", r.json);
    assert_eq!(r.error_code(), Some("rate_limited"));
    assert!(r.headers.get("retry-after").is_some());
    let counted: i32 = sqlx::query_scalar("select count from rate_limits where bucket = $1")
        .bind(format!("contact_add:account:{}", carbon.uuid))
        .fetch_one(&ctx.state.db)
        .await
        .expect("the account site's bucket");
    assert!(counted > 20, "{counted}");
}

#[tokio::test]
async fn an_optional_email_added_on_the_page_starts_ticked() {
    let ctx = TestContext::new().await;
    let phone = "+14155550142";
    let carbon = ctx
        .carbon_with(CarbonSpec {
            phone: Some(phone.into()),
            email: Some(String::new()),
            ..Default::default()
        })
        .await;
    let (app, _) = app_with(
        &ctx,
        "dm",
        json!({"methods": {"email": true, "phone": true}, "required_fields": ["phone"], "optional_fields": ["email"]}),
    )
    .await;
    let mut b = Browser::new(&ctx);
    let id = id_of(&new_flow(&ctx, &mut b, &app.app_id, json!({})).await);
    let r = b
        .post(
            &ctx,
            &format!("/v1/flows/{id}/phone"),
            json!({"phone": phone}),
        )
        .await;
    assert_eq!(r.status, 200, "{}", r.json);
    let code = last_code(&ctx, phone).await;
    let r = b
        .post(
            &ctx,
            &format!("/v1/flows/{id}/verify"),
            json!({"code": code}),
        )
        .await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(
        page_fields(&r.json["flow"]),
        vec![
            row("phone", "required", true, false),
            row("email", "optional", false, true),
        ]
    );
    let email = random_email("added");
    let r = b
        .post(
            &ctx,
            &format!("/v1/flows/{id}/details/add"),
            json!({"email": email}),
        )
        .await;
    assert_eq!(r.status, 200, "{}", r.json);
    let code = last_code(&ctx, &email).await;
    let r = b
        .post(
            &ctx,
            &format!("/v1/flows/{id}/details/verify"),
            json!({"code": code}),
        )
        .await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(
        page_fields(&r.json["flow"])[1],
        row("email", "optional", true, false),
        "the Carbon added it to share it"
    );
    let r = continue_page(&ctx, &mut b, &id, &["email"]).await;
    assert_eq!(r.json["flow"]["step"], "complete", "{}", r.json);
    assert_eq!(
        granted(&ctx, &app.app_id, &carbon.uuid).await,
        vec!["profile", "email", "phone"]
    );
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
    let r = continue_page(&ctx, &mut signed_out, &id, &[]).await;
    assert_eq!(r.status, 401);
    assert_eq!(r.error_code(), Some("session_required"));
    let mut switched = b.clone();
    let cookie = ctx.browser_session(&other).await;
    switched.cookies.insert("sa_session".into(), cookie);
    let r = continue_page(&ctx, &mut switched, &id, &[]).await;
    assert_eq!(r.status, 409);
    assert_eq!(r.error_code(), Some("account_changed"));
    let r = continue_page(&ctx, &mut b, &id, &[]).await;
    assert_eq!(r.status, 200, "{}", r.json);
}

#[tokio::test]
async fn a_requirement_lost_before_approving_sends_the_flow_back_to_its_page() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let (app, _) = app_with(
        &ctx,
        "briefcase",
        json!({"required_fields": ["email"], "optional_fields": ["timezone"], "flow": {"steps": [
            {"id": "contact", "fields": ["email"]}, {"id": "about", "fields": ["timezone"]}
        ], "review": true}}),
    )
    .await;
    let mut b = Browser::new(&ctx);
    let (id, f) = code_sign_in(&ctx, &mut b, &app.app_id, &email_of(&carbon), json!({})).await;
    assert_eq!(f["details"]["id"], "contact");
    continue_page(&ctx, &mut b, &id, &[]).await;
    let r = continue_page(&ctx, &mut b, &id, &[]).await;
    assert_eq!(r.json["flow"]["step"], "review", "{}", r.json);
    ctx.exec(&format!(
        "update account_emails set verified_at = null where account_uuid = '{}'",
        carbon.uuid
    ))
    .await;
    let r = b
        .post(
            &ctx,
            &format!("/v1/flows/{id}/review"),
            json!({"approve": true}),
        )
        .await;
    assert_eq!(r.status, 409);
    assert_eq!(r.error_code(), Some("requirements_missing"));
    assert_eq!(r.json["error"]["details"]["missing"], json!(["email"]));
    let r = b.get(&ctx, &format!("/v1/flows/{id}")).await;
    assert_eq!(r.json["flow"]["step"], "details");
    assert_eq!(r.json["flow"]["details"]["id"], "contact");
    assert_eq!(
        page_fields(&r.json["flow"]),
        vec![row("email", "required", true, true)]
    );
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
    continue_page(&ctx, &mut b, &id, &[]).await;

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
    assert_eq!(r.json["flow"]["step"], "details");
    let r = continue_page(&ctx, &mut b, &id_of(&f), &[]).await;
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

    // "Use another account" works on the details page too.
    let f = new_flow(&ctx, &mut b, &campus.app_id, json!({})).await;
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
    let f = new_flow(&ctx, &mut b, &forgetful.app_id, json!({})).await;
    let fid = id_of(&f);
    let r = email_and_verify(&ctx, &mut b, &fid, &email_of(&carbon)).await;
    assert_eq!(r.json["flow"]["step"], "details");
    let r = b
        .post(&ctx, &format!("/v1/flows/{fid}/switch"), json!({}))
        .await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(r.json["flow"]["step"], "choose_method");
    assert_eq!(r.json["flow"]["details"], Value::Null);

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
    continue_page(&ctx, &mut b, &id, &[]).await;

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

    // An app that asks every Carbon to sign in again: login_required, and the description says
    // why (a Carbon IS signed in to this browser).
    let (forgetful, _) = app_with(&ctx, "spacestation", json!({"remember_browser": false})).await;
    let f = new_flow(&ctx, &mut b, &forgetful.app_id, json!({"prompt": "none"})).await;
    assert_eq!(f["step"], "failed");
    assert_eq!(f["error"]["code"], "login_required");
    let to = f["redirect_to"].as_str().expect("to");
    let description = query_param(to, "error_description").expect("description");
    assert!(
        description.contains("remember_browser is off") && !description.contains("No Carbon"),
        "{description}"
    );
    assert_eq!(query_param(to, "error").as_deref(), Some("login_required"));

    // Nobody signed in at all: that's what it says.
    let mut nobody = Browser::new(&ctx);
    let f = new_flow(&ctx, &mut nobody, &app.app_id, json!({"prompt": "none"})).await;
    assert_eq!(f["error"]["code"], "login_required");
    assert!(
        f["error"]["message"]
            .as_str()
            .expect("message")
            .starts_with("No Carbon is signed in"),
        "{f}"
    );
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
    // prompt=none says it's a Silicon, not that nobody is signed in.
    let f = new_flow(&ctx, &mut b, &app.app_id, json!({"prompt": "none"})).await;
    assert_eq!(f["error"]["code"], "login_required");
    assert!(
        f["error"]["message"]
            .as_str()
            .expect("message")
            .contains("a Silicon"),
        "{f}"
    );
}

/// The `(field, new)` pairs of a details page.
fn new_marks(flow: &Value) -> Vec<(String, bool)> {
    flow["details"]["fields"]
        .as_array()
        .expect("fields")
        .iter()
        .map(|f| {
            (
                f["field"].as_str().expect("field").to_string(),
                f["new"].as_bool().expect("new"),
            )
        })
        .collect()
}

/// "Continue as" in a browser signed in as the Carbon; returns the flow after it.
async fn continue_as(ctx: &TestContext, b: &mut Browser, app_id: &str) -> (String, Value) {
    let id = id_of(&new_flow(ctx, b, app_id, json!({})).await);
    let r = b
        .post(ctx, &format!("/v1/flows/{id}/continue"), json!({}))
        .await;
    assert_eq!(r.status, 200, "{}", r.json);
    (id, r.json["flow"].clone())
}

/// UNDERSTANDING.md: the what's-shared screen shows "again whenever the app asks for more". An
/// optional detail the app adds later is offered to returning Carbons (unticked, marked new);
/// one they left unticked before stays quiet and isn't new; a newly required one is the only
/// new detail on its page.
#[tokio::test]
async fn returning_carbons_are_offered_what_the_app_asks_for_since() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let (app, _) = app_with(
        &ctx,
        "briefcase",
        json!({"required_fields": ["email"], "optional_fields": ["timezone"]}),
    )
    .await;
    let mut b = Browser::new(&ctx);
    let (id, f) = code_sign_in(&ctx, &mut b, &app.app_id, &email_of(&carbon), json!({})).await;
    assert_eq!(f["step"], "details");
    assert_eq!(
        new_marks(&f),
        vec![("email".into(), false), ("timezone".into(), false)],
        "nothing is 'new' on a Carbon's first page"
    );
    // The timezone is left unticked.
    let r = continue_page(&ctx, &mut b, &id, &[]).await;
    assert_eq!(r.json["flow"]["step"], "complete", "{}", r.json);
    let (_, f) = continue_as(&ctx, &mut b, &app.app_id).await;
    assert_eq!(f["step"], "complete", "nothing new: straight back");

    // The app adds an optional phone: offered, unticked and new; the timezone isn't new.
    set_config(
        &ctx,
        &app.app_id,
        json!({"optional_fields": ["timezone", "phone"]}),
    )
    .await;
    let (id, f) = continue_as(&ctx, &mut b, &app.app_id).await;
    assert_eq!(f["step"], "details", "the app asks for more: {f}");
    assert_eq!(
        page_fields(&f),
        vec![
            row("email", "required", true, false),
            row("timezone", "optional", false, false),
            row("phone", "optional", false, true),
        ]
    );
    assert_eq!(
        new_marks(&f),
        vec![
            ("email".into(), false),
            ("timezone".into(), false),
            ("phone".into(), true)
        ]
    );
    let r = continue_page(&ctx, &mut b, &id, &[]).await;
    assert_eq!(r.json["flow"]["step"], "complete", "{}", r.json);
    // Declined before: quiet. prompt=none works again too.
    let (_, f) = continue_as(&ctx, &mut b, &app.app_id).await;
    assert_eq!(f["step"], "complete", "{f}");
    let f = new_flow(&ctx, &mut b, &app.app_id, json!({"prompt": "none"})).await;
    assert_eq!(f["step"], "complete", "{f}");

    // A newly required date of birth: the only new detail on the page.
    set_config(
        &ctx,
        &app.app_id,
        json!({"required_fields": ["email", "dob"]}),
    )
    .await;
    let f = new_flow(&ctx, &mut b, &app.app_id, json!({"prompt": "none"})).await;
    assert_eq!(f["error"]["code"], "consent_required");
    let (_, f) = continue_as(&ctx, &mut b, &app.app_id).await;
    assert_eq!(f["step"], "details");
    let marks = new_marks(&f);
    assert!(
        marks.contains(&("dob".into(), true))
            && marks
                .iter()
                .filter(|(field, _)| field != "dob")
                .all(|(_, new)| !new),
        "{marks:?}"
    );
}

/// An active membership made by exchanging a short-lived token (`accounts login --app …`): the
/// Carbon never saw the app's pages.
async fn slt_membership(ctx: &TestContext, app_id: &str, uuid: &str) {
    use accounts_core::models::{MembershipSource, Scope};
    use accounts_core::repo::memberships::{self, GrantMode};
    let mut conn = ctx.conn().await;
    memberships::upsert_signin(
        &mut conn,
        app_id,
        uuid,
        MembershipSource::Slt,
        &[Scope::Profile, Scope::Email],
        GrantMode::Union,
    )
    .await
    .expect("slt membership");
}

/// A membership made without the pages (a short-lived token from the CLI or a Silicon) never
/// showed the Carbon what the app gets: their first sign-in on the hosted pages shows every page,
/// and so does the first one after the app's access was removed.
#[tokio::test]
async fn the_first_hosted_sign_in_after_a_short_lived_token_shows_the_pages() {
    use accounts_core::models::ActorKind;
    use accounts_core::repo::audit::{self, AuditEntry};
    use accounts_core::repo::memberships;

    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let email = email_of(&carbon);
    let (app, _) = app_with(
        &ctx,
        "briefcase",
        json!({"required_fields": ["email"], "optional_fields": ["timezone"]}),
    )
    .await;
    slt_membership(&ctx, &app.app_id, &carbon.uuid).await;

    let mut b = Browser::new(&ctx);
    let (id, f) = code_sign_in(&ctx, &mut b, &app.app_id, &email, json!({})).await;
    assert_eq!(f["step"], "details", "what's shared is shown once: {f}");
    assert_eq!(
        page_fields(&f),
        vec![
            row("email", "required", true, false),
            row("timezone", "optional", false, false),
        ]
    );
    assert!(new_marks(&f).iter().all(|(_, new)| !new));
    let r = continue_page(&ctx, &mut b, &id, &["timezone"]).await;
    assert_eq!(r.json["flow"]["step"], "complete", "{}", r.json);
    let answer: Value = sqlx::query_scalar(
        "select details from audit_log where account_uuid = $1 and action = 'consent.granted'",
    )
    .bind(&carbon.uuid)
    .fetch_one(&ctx.state.db)
    .await
    .expect("the answer is recorded");
    assert_eq!(answer["offered"], json!(["email", "timezone"]));
    assert_eq!(answer["shared"], json!(["email", "timezone"]));
    let (_, f) = continue_as(&ctx, &mut b, &app.app_id).await;
    assert_eq!(f["step"], "complete", "then the normal rule: {f}");

    // The Carbon removes the app's access (the account site), then a token brings it back.
    {
        let mut conn = ctx.conn().await;
        memberships::remove_access(&mut conn, &app.app_id, &carbon.uuid, &carbon.uuid)
            .await
            .expect("remove access");
        audit::record(
            &mut conn,
            &AuditEntry {
                account_uuid: Some(&carbon.uuid),
                app_id: Some(&app.app_id),
                details: json!({}),
                ..AuditEntry::new(
                    ActorKind::Account,
                    Some(&carbon.uuid),
                    "membership.access_removed",
                )
            },
        )
        .await
        .expect("audit");
    }
    slt_membership(&ctx, &app.app_id, &carbon.uuid).await;
    let (_, f) = continue_as(&ctx, &mut b, &app.app_id).await;
    assert_eq!(
        f["step"], "details",
        "answers before the removal don't count: {f}"
    );
}

#[tokio::test]
async fn a_detail_added_elsewhere_shows_on_waiting_pages() {
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
    assert_eq!(page_fields(&f1), vec![row("phone", "required", true, true)]);
    // Two more tabs of the same app reach the page.
    let mut waiting = Vec::new();
    for _ in 0..2 {
        let id = id_of(&new_flow(&ctx, &mut b, &app.app_id, json!({})).await);
        let r = b
            .post(&ctx, &format!("/v1/flows/{id}/continue"), json!({}))
            .await;
        assert_eq!(r.json["flow"]["step"], "details", "{}", r.json);
        waiting.push(id);
    }
    // Tab 1 adds the phone.
    let r = b
        .post(
            &ctx,
            &format!("/v1/flows/{id1}/details/add"),
            json!({"phone": "+14155550177"}),
        )
        .await;
    assert_eq!(r.status, 200, "{}", r.json);
    let code = last_code(&ctx, "+14155550177").await;
    let r = b
        .post(
            &ctx,
            &format!("/v1/flows/{id1}/details/verify"),
            json!({"code": code}),
        )
        .await;
    assert_eq!(
        page_fields(&r.json["flow"]),
        vec![row("phone", "required", true, false)]
    );
    // Tab 2 shows it when it looks again, and continues.
    let r = b.get(&ctx, &format!("/v1/flows/{}", waiting[0])).await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(
        page_fields(&r.json["flow"]),
        vec![row("phone", "required", true, false)]
    );
    let r = continue_page(&ctx, &mut b, &waiting[0], &[]).await;
    assert_eq!(r.json["flow"]["step"], "complete", "{}", r.json);
    // Tab 3, still showing the old page, sends a phone: nothing is missing, so no code is
    // sent and the page shows the phone.
    let r = b
        .post(
            &ctx,
            &format!("/v1/flows/{}/details/add", waiting[1]),
            json!({"phone": "+14155550178"}),
        )
        .await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(r.json["flow"]["details"]["challenge"], Value::Null);
    assert!(
        ctx.outbox("+14155550178").await.is_empty(),
        "no code was sent"
    );
}

#[tokio::test]
async fn pages_follow_the_apps_flow_when_it_changes_mid_sign_in() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let (app, _) = app_with(
        &ctx,
        "dm",
        json!({"methods": {"email": true, "phone": true}, "required_fields": ["email"], "optional_fields": ["timezone"],
               "flow": {"steps": [{"id": "contact", "fields": ["email"]}, {"id": "zone", "fields": ["timezone"]}], "review": false}}),
    )
    .await;
    let mut b = Browser::new(&ctx);
    let (id, f) = code_sign_in(&ctx, &mut b, &app.app_id, &email_of(&carbon), json!({})).await;
    assert_eq!(f["details"]["id"], "contact");
    // The app drops its flow: the page "contact" is gone; the Carbon's browser moves on.
    set_config(&ctx, &app.app_id, json!({"flow": null})).await;
    let mut signed_out = b.clone();
    signed_out.cookies.remove("sa_session");
    let r = signed_out.get(&ctx, &format!("/v1/flows/{id}")).await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(
        r.json["flow"]["details"]["id"], "details",
        "the view shows the page the flow will be on"
    );
    let r = continue_page(&ctx, &mut b, &id, &[]).await;
    assert_eq!(r.status, 409, "the page the request was made on is gone");
    assert_eq!(r.error_code(), Some("flow_changed"));
    let r = b.get(&ctx, &format!("/v1/flows/{id}")).await;
    assert_eq!(r.json["flow"]["details"]["id"], "details", "{}", r.json);
    assert_eq!(
        page_fields(&r.json["flow"]),
        vec![
            row("email", "required", true, false),
            row("timezone", "optional", false, false)
        ]
    );
    let r = continue_page(&ctx, &mut b, &id, &[]).await;
    assert_eq!(r.json["flow"]["step"], "complete", "{}", r.json);

    // A flow stored at the old consent step continues on the pages.
    let id = id_of(&new_flow(&ctx, &mut b, &app.app_id, json!({"prompt": "consent"})).await);
    let r = b
        .post(&ctx, &format!("/v1/flows/{id}/continue"), json!({}))
        .await;
    assert_eq!(r.json["flow"]["step"], "details", "{}", r.json);
    sqlx::query("update signin_flows set step = 'consent', provider_state = provider_state - 'details' where id = $1")
        .bind(&id)
        .execute(&ctx.state.db)
        .await
        .expect("legacy step");
    let r = b.get(&ctx, &format!("/v1/flows/{id}")).await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(r.json["flow"]["step"], "details");
    assert_eq!(r.json["flow"]["details"]["id"], "details");
}

/// The authorization code carries when the Carbon actually authenticated (OIDC `auth_time`): the
/// browser session's last proof of identity. Continue-as keeps the earlier time; signing in
/// again with a code in the same browser (the session is reused) moves it to now.
#[tokio::test]
async fn codes_carry_when_the_carbon_actually_authenticated() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let (first, _) = ctx.app("commit").await;
    let (second, _) = ctx.app("remind").await;
    let mut b = Browser::new(&ctx);
    let (id, _) = code_sign_in(&ctx, &mut b, &first.app_id, &email_of(&carbon), json!({})).await;
    let r = continue_page(&ctx, &mut b, &id, &[]).await;
    let code = redeem(
        &ctx,
        &code_of(r.json["flow"]["redirect_to"].as_str().expect("redirect")),
        &first.app_id,
    )
    .await;
    let session_id = code.browser_session_id.expect("the flow's browser session");
    let authenticated: time::OffsetDateTime =
        sqlx::query_scalar("select authenticated_at from browser_sessions where id = $1")
            .bind(session_id)
            .fetch_one(&ctx.state.db)
            .await
            .expect("session");
    assert_eq!(code.auth_time, Some(authenticated));

    // Two hours later the browser continues as the Carbon at another app: no new proof, so
    // the code says when the Carbon last authenticated.
    sqlx::query(
        "update browser_sessions set authenticated_at = authenticated_at - interval '2 hours' where id = $1",
    )
    .bind(session_id)
    .execute(&ctx.state.db)
    .await
    .expect("time travel");
    let f = new_flow(&ctx, &mut b, &second.app_id, json!({})).await;
    b.post(
        &ctx,
        &format!("/v1/flows/{}/continue", id_of(&f)),
        json!({}),
    )
    .await;
    let r = continue_page(&ctx, &mut b, &id_of(&f), &[]).await;
    let code = redeem(
        &ctx,
        &code_of(r.json["flow"]["redirect_to"].as_str().expect("redirect")),
        &second.app_id,
    )
    .await;
    let earlier = authenticated - time::Duration::hours(2);
    assert_eq!(code.auth_time, Some(earlier));

    // A new code sign-in in the same browser keeps the session but records the new proof.
    let (id, f) = code_sign_in(&ctx, &mut b, &second.app_id, &email_of(&carbon), json!({})).await;
    assert_eq!(f["step"], "complete", "{f}");
    let code = redeem(
        &ctx,
        &code_of(f["redirect_to"].as_str().expect("redirect")),
        &second.app_id,
    )
    .await;
    assert_eq!(
        code.browser_session_id,
        Some(session_id),
        "same session {id}"
    );
    let now = time::OffsetDateTime::now_utc();
    let at = code.auth_time.expect("auth_time");
    assert!(
        at > earlier + time::Duration::hours(1) && (now - at).abs() < time::Duration::minutes(5),
        "auth_time {at} must be the new sign-in"
    );
}
