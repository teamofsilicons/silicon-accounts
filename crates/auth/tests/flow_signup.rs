//! Sign-up in the hosted flow: the prefill, validation, id suggestions, the 48-hour sign-up
//! session and its cookie, resuming in a new flow, the first-party app and finishing an
//! account an app imported.

mod common;

use accounts_core::models::{AccountStatus, Scope};
use accounts_core::test_support::{CarbonSpec, Req, TestContext};
use common::*;
use serde_json::{Value, json};

async fn to_signup(
    ctx: &TestContext,
    b: &mut Browser,
    app_id: &str,
    email: &str,
) -> (String, Value) {
    let id = id_of(&new_flow(ctx, b, app_id, json!({})).await);
    let r = email_and_verify(ctx, b, &id, email).await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(r.json["flow"]["step"], "signup", "{}", r.json);
    (id, r.json["flow"].clone())
}

#[tokio::test]
async fn new_carbons_sign_up_with_everything_prefilled() {
    let ctx = TestContext::new().await;
    let (app, _) = ctx.app("briefcase").await;
    let mut b = Browser::new(&ctx);
    let email = format!(
        "saket.dev+{}@example.test",
        accounts_core::test_support::rand_suffix()
    );
    let (id, f) = to_signup(&ctx, &mut b, &app.app_id, &email).await;
    assert!(b.cookie("sa_signup").is_some_and(|c| c.starts_with("sau_")));
    let s = &f["signup"];
    assert!(
        s["display_name"]
            .as_str()
            .expect("name")
            .starts_with("Saket Dev"),
        "{s}"
    );
    assert!(
        s["id"].as_str().expect("id").starts_with("c:saket-dev"),
        "{s}"
    );
    assert_eq!(
        s["timezone"], "Europe/Paris",
        "browser timezone when no IP header"
    );
    // Exactly 18 years before the Carbon's own today (in the prefilled timezone, not UTC).
    let dob_in = |timezone: &str| {
        accounts_core::timefmt::format_date(accounts_core::normalize::default_dob(
            accounts_core::timefmt::today_in(timezone),
        ))
    };
    assert_eq!(s["dob"], dob_in("Europe/Paris").as_str(), "{s}");
    assert!(
        s["pfp_url"]
            .as_str()
            .expect("pfp")
            .starts_with("https://iris.teamofsilicons.com/pfp/carbon?id=")
    );
    assert_eq!(s["email"], email.as_str());
    assert_eq!(s["finishing_import"], false);
    assert_eq!(s["provider"], Value::Null);
    let expires =
        accounts_core::timefmt::parse_rfc3339(s["expires_at"].as_str().expect("exp")).expect("ts");
    let left = expires - time::OffsetDateTime::now_utc();
    assert!(
        left > time::Duration::hours(47) && left <= time::Duration::hours(48),
        "{left}"
    );

    // The IP timezone header wins over the browser's.
    let r = b
        .call(
            &ctx,
            Req::get(&format!("/v1/flows/{id}"))
                .header("cloudfront-viewer-time-zone", "asia/kolkata"),
        )
        .await;
    assert_eq!(r.json["flow"]["signup"]["timezone"], "Asia/Kolkata");
    assert_eq!(
        r.json["flow"]["signup"]["dob"],
        dob_in("Asia/Kolkata").as_str(),
        "the dob follows the timezone the page prefills"
    );

    // Accept the prefill as-is.
    let r = b
        .post(&ctx, &format!("/v1/flows/{id}/signup"), json!({}))
        .await;
    assert_eq!(r.status, 200, "{}", r.json);
    let f = &r.json["flow"];
    assert_eq!(f["step"], "details");
    assert!(b.cookie("sa_session").is_some(), "the browser is signed in");
    assert!(
        b.cookie("sa_signup").is_none(),
        "the sign-up cookie is cleared"
    );
    let uuid = f["signed_in_as"]["uuid"]
        .as_str()
        .expect("uuid")
        .to_string();
    let mut conn = ctx.conn().await;
    let account = accounts_core::repo::accounts::require(&mut conn, &uuid)
        .await
        .expect("account");
    assert_eq!(account.status, AccountStatus::Active);
    assert_eq!(account.timezone, "Europe/Paris");
    assert_eq!(
        account.pfp_url,
        format!("https://iris.teamofsilicons.com/pfp/carbon?id={uuid}")
    );
    let emails = accounts_core::repo::contacts::list_emails(&mut conn, &uuid)
        .await
        .expect("emails");
    assert_eq!(emails.len(), 1);
    assert!(emails[0].is_primary && emails[0].verified_at.is_some());
    drop(conn);

    let r = continue_page(&ctx, &mut b, &id, &[]).await;
    assert_eq!(r.json["flow"]["step"], "complete");
    let outcome: String =
        sqlx::query_scalar("select outcome from signin_history where account_uuid = $1")
            .bind(&uuid)
            .fetch_one(&ctx.state.db)
            .await
            .expect("history");
    assert_eq!(outcome, "new_account");
}

#[tokio::test]
async fn sign_up_details_are_validated_and_ids_suggested() {
    let ctx = TestContext::new().await;
    ctx.carbon_with(CarbonSpec {
        handle: Some("saket".into()),
        ..Default::default()
    })
    .await;
    let (app, _) = ctx.app("briefcase").await;
    let mut b = Browser::new(&ctx);
    let (id, _) = to_signup(&ctx, &mut b, &app.app_id, &random_email("validate")).await;

    let r = b
        .post(
            &ctx,
            &format!("/v1/flows/{id}/signup"),
            json!({"display_name": "  ", "id": "c:no spaces", "timezone": "Mars/Base", "dob": "2999-01-01", "pfp_url": "http://insecure.test/me.png"}),
        )
        .await;
    assert_eq!(r.status, 422, "{}", r.json);
    assert_eq!(r.error_code(), Some("validation_failed"));
    let fields = &r.json["error"]["details"]["fields"];
    for f in ["display_name", "id", "timezone", "dob", "pfp_url"] {
        assert!(fields.get(f).is_some(), "{f} missing from {fields}");
    }
    assert!(fields["id"].as_str().expect("id").contains("a space"));
    let r = b
        .post(
            &ctx,
            &format!("/v1/flows/{id}/signup"),
            json!({"id": "c:admin"}),
        )
        .await;
    assert!(
        r.json["error"]["details"]["fields"]["id"]
            .as_str()
            .expect("id")
            .contains("reserved")
    );
    let r = b
        .post(
            &ctx,
            &format!("/v1/flows/{id}/signup"),
            json!({"id": "si:scout"}),
        )
        .await;
    assert!(
        r.json["error"]["details"]["fields"]["id"]
            .as_str()
            .expect("id")
            .contains("Silicon")
    );

    let r = b
        .post(
            &ctx,
            &format!("/v1/flows/{id}/signup"),
            json!({"id": "c:SAKET"}),
        )
        .await;
    assert_eq!(r.status, 409, "{}", r.json);
    assert_eq!(r.error_code(), Some("id_taken"));
    let suggestions = r.json["error"]["details"]["suggestions"]
        .as_array()
        .expect("suggestions");
    assert_eq!(suggestions.len(), 3);
    assert_eq!(suggestions[0], "c:saket-2");

    // A bare handle works; a chosen https photo is kept.
    let r = b
        .post(&ctx, &format!("/v1/flows/{id}/signup"), json!({"id": "saket-2", "display_name": "Saket", "pfp_url": "https://cdn.example.test/me.png", "dob": "2001-02-03"}))
        .await;
    assert_eq!(r.status, 200, "{}", r.json);
    let summary = &r.json["flow"]["signed_in_as"];
    assert_eq!(summary["id"], "c:saket-2");
    assert_eq!(summary["display_name"], "Saket");
    assert_eq!(summary["pfp_url"], "https://cdn.example.test/me.png");
}

#[tokio::test]
async fn sign_up_sessions_last_48_hours_and_belong_to_their_browser() {
    let ctx = TestContext::new().await;
    let (app, _) = ctx.app("briefcase").await;
    let mut b = Browser::new(&ctx);
    let (id, _) = to_signup(&ctx, &mut b, &app.app_id, &random_email("cookie")).await;

    let mut stolen = b.clone();
    stolen.cookies.remove("sa_signup");
    let r = stolen
        .post(&ctx, &format!("/v1/flows/{id}/signup"), json!({}))
        .await;
    assert_eq!(r.status, 403);
    assert_eq!(r.error_code(), Some("signup_not_bound"));

    ctx.exec("update signup_sessions set expires_at = now() - interval '1 second'")
        .await;
    let mut other_tab = b.clone();
    let r = b
        .post(&ctx, &format!("/v1/flows/{id}/signup"), json!({}))
        .await;
    assert_eq!(r.status, 410);
    assert_eq!(r.error_code(), Some("signup_expired"));
    let r = b.get(&ctx, &format!("/v1/flows/{id}")).await;
    assert_eq!(r.json["flow"]["step"], "choose_method");
    assert_eq!(r.json["flow"]["error"]["code"], "signup_expired");

    // GET alone also notices an expired sign-up and goes back to the methods.
    let (id2, _) = to_signup(&ctx, &mut other_tab, &app.app_id, &random_email("cookie2")).await;
    ctx.exec("update signup_sessions set expires_at = now() - interval '1 second'")
        .await;
    let r = other_tab.get(&ctx, &format!("/v1/flows/{id2}")).await;
    assert_eq!(r.json["flow"]["step"], "choose_method", "{}", r.json);
    assert_eq!(r.json["flow"]["error"]["code"], "signup_expired");
    assert_eq!(r.json["flow"]["signup"], Value::Null);
}

#[tokio::test]
async fn a_new_flow_resumes_a_verified_sign_up_in_the_same_browser() {
    let ctx = TestContext::new().await;
    let (app, _) = ctx.app("briefcase").await;
    let (closed, _) = app_with(&ctx, "closed", json!({"allow_signup": false})).await;
    let mut b = Browser::new(&ctx);
    let email = random_email("resume");
    let (id, _) = to_signup(&ctx, &mut b, &app.app_id, &email).await;
    // The first flow runs out (60 minutes); the sign-up session (48 hours) doesn't.
    ctx.exec(&format!(
        "update signin_flows set expires_at = now() - interval '1 second' where id = '{id}'"
    ))
    .await;

    let f = new_flow(&ctx, &mut b, &closed.app_id, json!({})).await;
    assert_eq!(
        f["step"], "choose_method",
        "an app that takes no new accounts doesn't resume it"
    );
    let f = new_flow(&ctx, &mut b, &app.app_id, json!({})).await;
    assert_eq!(f["step"], "signup", "{f}");
    assert_eq!(f["signup"]["email"], email.as_str());
    let r = b
        .post(&ctx, &format!("/v1/flows/{}/signup", id_of(&f)), json!({}))
        .await;
    assert_eq!(r.status, 200, "{}", r.json);
    // Used: it doesn't resume again.
    let f = new_flow(
        &ctx,
        &mut Browser {
            cookies: b.cookies.clone(),
            origin: b.origin.clone(),
        },
        &app.app_id,
        json!({}),
    )
    .await;
    assert_eq!(f["step"], "choose_method");
}

#[tokio::test]
async fn the_first_party_app_completes_without_consent_or_membership() {
    let ctx = TestContext::new().await;
    let mut b = Browser::new(&ctx);
    let flow = email_signup(
        &ctx,
        &mut b,
        "silicon-accounts",
        &random_email("site"),
        json!({}),
    )
    .await;
    assert_eq!(flow["step"], "complete", "{flow}");
    let to = flow["redirect_to"].as_str().expect("redirect");
    assert!(
        to.starts_with(&format!("{}/?", ctx.state.settings.public_url)),
        "{to}"
    );
    assert_eq!(query_param(to, "state").as_deref(), Some(APP_STATE));
    let uuid = flow["signed_in_as"]["uuid"].as_str().expect("uuid");
    let n = scalar_i64(
        &ctx,
        "select count(*) from memberships where account_uuid = $1",
        uuid,
    )
    .await;
    assert_eq!(
        n, 0,
        "the account site is not an app the account signed into"
    );
    // The browser is signed in for the site.
    let r = b.get(&ctx, "/v1/session").await;
    assert_eq!(r.status, 200);
    assert_eq!(r.json["account"]["uuid"], uuid);
}

#[tokio::test]
async fn imported_accounts_finish_setup_with_their_imported_data() {
    let ctx = TestContext::new().await;
    let email = random_email("imported");
    let (app, _) = ctx.app("legacy").await;
    let whsec = ctx
        .set_app_webhook(&app.app_id, "http://127.0.0.1:8593/legacy/webhooks")
        .await;
    assert!(whsec.starts_with("whsec_"));
    let imported = ctx
        .carbon_with(CarbonSpec {
            handle: Some("imported-user".into()),
            display_name: Some("Imported User".into()),
            email: Some(email.clone()),
            timezone: Some("America/New_York".into()),
            status: Some(AccountStatus::Unclaimed),
            ..Default::default()
        })
        .await;
    {
        let mut conn = ctx.conn().await;
        accounts_core::repo::memberships::upsert_imported(
            &mut conn,
            &app.app_id,
            &imported.uuid,
            Some("crm-1"),
            None,
            false,
        )
        .await
        .expect("imported membership");
    }
    let mut b = Browser::new(&ctx);
    let (id, f) = to_signup(&ctx, &mut b, &app.app_id, &email).await;
    let s = &f["signup"];
    assert_eq!(s["finishing_import"], true);
    assert_eq!(s["id"], "c:imported-user");
    assert_eq!(s["display_name"], "Imported User");
    assert_eq!(s["timezone"], "America/New_York");
    assert_eq!(
        s["imported_by"],
        json!({"app_id": app.app_id, "name": app.name}),
        "the page can say which app added the Carbon: {s}"
    );

    let r = b
        .post(
            &ctx,
            &format!("/v1/flows/{id}/signup"),
            json!({"id": "c:imported-new", "display_name": "Imported Carbon"}),
        )
        .await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(
        r.json["flow"]["step"], "details",
        "the import was not a consent: the what's-shared page is shown"
    );
    let mut conn = ctx.conn().await;
    let account = accounts_core::repo::accounts::require(&mut conn, &imported.uuid)
        .await
        .expect("account");
    assert_eq!(account.status, AccountStatus::Active);
    assert_eq!(account.id(), "c:imported-new");
    assert_eq!(account.display_name, "Imported Carbon");
    let emails = accounts_core::repo::contacts::list_emails(&mut conn, &imported.uuid)
        .await
        .expect("emails");
    assert!(
        emails[0].verified_at.is_some(),
        "the proven email is verified now"
    );
    let reserved = accounts_core::repo::accounts::active_reservation(&mut conn, "c:imported-user")
        .await
        .expect("res");
    assert_eq!(reserved.map(|r| r.0), Some(imported.uuid.clone()));
    let membership = accounts_core::repo::memberships::get(&mut conn, &app.app_id, &imported.uuid)
        .await
        .expect("m")
        .expect("m");
    assert_eq!(
        membership.status.as_str(),
        "imported",
        "stays imported until the account signs in to the app"
    );
    drop(conn);
    let types: Vec<String> = sqlx::query_scalar(
        "select type from webhook_events where target_id = $1 order by occurred_at",
    )
    .bind(&app.app_id)
    .fetch_all(&ctx.state.db)
    .await
    .expect("events");
    assert!(
        types.contains(&"account.id_changed".to_string()),
        "{types:?}"
    );
    assert!(types.contains(&"account.updated".to_string()), "{types:?}");

    let r = continue_page(&ctx, &mut b, &id, &[]).await;
    assert_eq!(r.json["flow"]["step"], "complete");
    let mut conn = ctx.conn().await;
    let membership = accounts_core::repo::memberships::get(&mut conn, &app.app_id, &imported.uuid)
        .await
        .expect("m")
        .expect("m");
    assert_eq!(membership.status.as_str(), "active");
    assert_eq!(membership.external_id.as_deref(), Some("crm-1"));
    assert_eq!(membership.scopes(), vec![Scope::Profile]);
}

#[tokio::test]
async fn imported_accounts_can_finish_in_apps_that_take_no_new_accounts() {
    let ctx = TestContext::new().await;
    let email = random_email("crm");
    let (app, _) = app_with(&ctx, "legacy", json!({"allow_signup": false})).await;
    ctx.carbon_with(CarbonSpec {
        email: Some(email.clone()),
        status: Some(AccountStatus::Unclaimed),
        ..Default::default()
    })
    .await;
    let mut b = Browser::new(&ctx);
    let (id, f) = to_signup(&ctx, &mut b, &app.app_id, &email).await;
    assert_eq!(f["signup"]["finishing_import"], true);
    assert!(
        f["signup"]["imported_by"].is_null(),
        "no app's import is on record for this account: {}",
        f["signup"]
    );
    let r = b
        .post(&ctx, &format!("/v1/flows/{id}/signup"), json!({}))
        .await;
    assert_eq!(r.status, 200, "{}", r.json);
}

#[tokio::test]
async fn finishing_an_import_in_another_app_names_the_app_that_imported_it() {
    let ctx = TestContext::new().await;
    let email = random_email("elsewhere");
    let (crm, _) = ctx.app("legacy").await;
    let (other, _) = ctx.app("briefcase").await;
    let imported = ctx
        .carbon_with(CarbonSpec {
            email: Some(email.clone()),
            status: Some(AccountStatus::Unclaimed),
            ..Default::default()
        })
        .await;
    {
        let mut conn = ctx.conn().await;
        accounts_core::repo::memberships::upsert_imported(
            &mut conn,
            &crm.app_id,
            &imported.uuid,
            Some("crm-9"),
            None,
            false,
        )
        .await
        .expect("imported membership");
    }
    // The Carbon first signs into another app with the imported email: that finishes the account
    // the CRM imported, and the view names the CRM, not the app being signed into.
    let mut b = Browser::new(&ctx);
    let (id, f) = to_signup(&ctx, &mut b, &other.app_id, &email).await;
    assert_eq!(f["signup"]["finishing_import"], true);
    assert_eq!(f["app"]["app_id"], other.app_id.as_str());
    let crm_named = json!({"app_id": crm.app_id, "name": crm.name});
    assert_eq!(f["signup"]["imported_by"], crm_named, "{}", f["signup"]);

    // A later import of the same person by the other app only matched the account: the CRM's
    // import (the earliest) is still the one that added them.
    {
        let mut conn = ctx.conn().await;
        sqlx::query("update memberships set created_at = now() - interval '1 day' where app_id = $1 and account_uuid = $2")
            .bind(&crm.app_id)
            .bind(&imported.uuid)
            .execute(&mut *conn)
            .await
            .expect("backdate the CRM's import");
        accounts_core::repo::memberships::upsert_imported(
            &mut conn,
            &other.app_id,
            &imported.uuid,
            Some("bc-9"),
            None,
            false,
        )
        .await
        .expect("second import");
    }
    let r = b.get(&ctx, &format!("/v1/flows/{id}")).await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(
        r.json["flow"]["signup"]["imported_by"], crm_named,
        "{}",
        r.json
    );

    let r = b
        .post(&ctx, &format!("/v1/flows/{id}/signup"), json!({}))
        .await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(
        r.json["flow"]["signed_in_as"]["uuid"],
        imported.uuid.as_str()
    );
}

// ------------------------------------------------- imports can't plant addresses on accounts

#[tokio::test]
async fn finishing_an_import_drops_the_addresses_nobody_proved() {
    let ctx = TestContext::new().await;
    let (app, _) = ctx.app("legacy").await;
    let whsec = ctx
        .set_app_webhook(&app.app_id, "http://127.0.0.1:8593/legacy/webhooks")
        .await;
    assert!(whsec.starts_with("whsec_"));
    let attacker = random_email("attacker");
    let victim = random_email("victim");
    // An app owner imports one row listing their own address and someone else's.
    let uuid = unclaimed_import(&ctx, &[&victim, &attacker], &["+14155550188"]).await;
    // The attacker finishes the account with their address.
    let mut a = Browser::new(&ctx);
    let (id, f) = to_signup(&ctx, &mut a, &app.app_id, &attacker).await;
    assert_eq!(f["signup"]["finishing_import"], true);
    let r = a
        .post(&ctx, &format!("/v1/flows/{id}/signup"), json!({}))
        .await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(r.json["flow"]["signed_in_as"]["uuid"], uuid.as_str());
    assert_eq!(
        emails_of(&ctx, &uuid).await,
        vec![(attacker.clone(), true)],
        "only the proven address stays"
    );
    let phones = scalar_i64(
        &ctx,
        "select count(*) from account_phones where account_uuid = $1",
        &uuid,
    )
    .await;
    assert_eq!(phones, 0, "the unproven phone is gone too");
    let primary: String = sqlx::query_scalar(
        "select email from account_emails where account_uuid = $1 and is_primary",
    )
    .bind(&uuid)
    .fetch_one(&ctx.state.db)
    .await
    .expect("primary");
    assert_eq!(primary, attacker, "the proven address is the primary");

    // The victim later signs in elsewhere with their own address: a sign-up of their own.
    let (other, _) = ctx.app("other").await;
    let mut v = Browser::new(&ctx);
    let (vid, f) = to_signup(&ctx, &mut v, &other.app_id, &victim).await;
    assert_eq!(f["signed_in_as"], Value::Null);
    assert_eq!(f["signup"]["finishing_import"], false);
    assert_eq!(f["signup"]["email"], victim.as_str());
    assert!(v.cookie("sa_session").is_none());
    let r = v
        .post(&ctx, &format!("/v1/flows/{vid}/signup"), json!({}))
        .await;
    assert_eq!(r.status, 200, "{}", r.json);
    let new_uuid = r.json["flow"]["signed_in_as"]["uuid"]
        .as_str()
        .expect("uuid");
    assert_ne!(new_uuid, uuid, "the victim got their own account");
    assert_eq!(emails_of(&ctx, new_uuid).await, vec![(victim, true)]);
}

#[tokio::test]
async fn an_unproven_address_on_an_account_is_not_a_way_in() {
    let ctx = TestContext::new().await;
    let (app, _) = ctx.app("briefcase").await;
    let holder = ctx.carbon().await;
    let stranger = random_email("stranger");
    unproven_email(&ctx, &holder.uuid, &stranger).await;
    let mut b = Browser::new(&ctx);
    let (id, f) = to_signup(&ctx, &mut b, &app.app_id, &stranger).await;
    assert_eq!(
        f["signed_in_as"],
        Value::Null,
        "proving the address doesn't sign into the account that listed it"
    );
    assert!(b.cookie("sa_session").is_none());
    assert_eq!(
        emails_of(&ctx, &holder.uuid).await.len(),
        1,
        "the unproven row was removed from that account"
    );
    let removed = scalar_i64(
        &ctx,
        "select count(*) from audit_log where account_uuid = $1 and action = 'contact.unverified_removed'",
        &holder.uuid,
    )
    .await;
    assert_eq!(removed, 1);
    let r = b
        .post(&ctx, &format!("/v1/flows/{id}/signup"), json!({}))
        .await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_ne!(r.json["flow"]["signed_in_as"]["uuid"], holder.uuid.as_str());
}

#[tokio::test]
async fn a_second_claimer_never_sees_or_reaches_the_finished_account() {
    let ctx = TestContext::new().await;
    let (app, _) = ctx.app("legacy").await;
    let one = random_email("one");
    let two = random_email("two");
    let uuid = unclaimed_import(&ctx, &[&one, &two], &[]).await;
    // Two people each prove one address of the same imported account.
    let mut b1 = Browser::new(&ctx);
    let (id1, f1) = to_signup(&ctx, &mut b1, &app.app_id, &one).await;
    assert_eq!(f1["signup"]["finishing_import"], true);
    let mut b2 = Browser::new(&ctx);
    let (id2, f2) = to_signup(&ctx, &mut b2, &app.app_id, &two).await;
    assert_eq!(f2["signup"]["finishing_import"], true);
    // The first one finishes it with their own details.
    let r = b1
        .post(
            &ctx,
            &format!("/v1/flows/{id1}/signup"),
            json!({"display_name": "Person One", "dob": "1990-05-05", "timezone": "Asia/Kolkata", "id": "c:person-one-x"}),
        )
        .await;
    assert_eq!(r.status, 200, "{}", r.json);
    // The second sees an ordinary sign-up: nothing of the finished account.
    let r = b2.get(&ctx, &format!("/v1/flows/{id2}")).await;
    let s = &r.json["flow"]["signup"];
    assert_eq!(r.json["flow"]["step"], "signup", "{}", r.json);
    assert_eq!(s["finishing_import"], false);
    assert_ne!(s["display_name"], "Person One");
    assert_ne!(s["id"], "c:person-one-x");
    assert_ne!(s["timezone"], "Asia/Kolkata");
    assert_ne!(s["dob"], "1990-05-05");
    assert_eq!(s["email"], two.as_str());
    // ...and finishing it creates their own account with their proven address.
    let r = b2
        .post(&ctx, &format!("/v1/flows/{id2}/signup"), json!({}))
        .await;
    assert_eq!(r.status, 200, "{}", r.json);
    let second = r.json["flow"]["signed_in_as"]["uuid"]
        .as_str()
        .expect("uuid")
        .to_string();
    assert_ne!(second, uuid);
    assert_eq!(emails_of(&ctx, &second).await, vec![(two.clone(), true)]);
    assert_eq!(emails_of(&ctx, &uuid).await, vec![(one, true)]);
    // Signing in with the second address later reaches the second account only.
    let mut b3 = Browser::new(&ctx);
    let id3 = id_of(&new_flow(&ctx, &mut b3, &app.app_id, json!({})).await);
    let r = email_and_verify(&ctx, &mut b3, &id3, &two).await;
    assert_eq!(r.json["flow"]["signed_in_as"]["uuid"], second.as_str());
}

#[tokio::test]
async fn a_claim_that_lost_the_race_becomes_an_ordinary_sign_up() {
    let ctx = TestContext::new().await;
    let (closed, _) = app_with(&ctx, "legacy", json!({"allow_signup": false})).await;
    let one = random_email("one");
    let two = random_email("two");
    let uuid = unclaimed_import(&ctx, &[&one, &two], &[]).await;
    let mut b2 = Browser::new(&ctx);
    let (id2, _) = to_signup(&ctx, &mut b2, &closed.app_id, &two).await;
    // Meanwhile someone else finishes the account in another app.
    let (open, _) = ctx.app("other").await;
    let mut b1 = Browser::new(&ctx);
    let (id1, _) = to_signup(&ctx, &mut b1, &open.app_id, &one).await;
    let r = b1
        .post(&ctx, &format!("/v1/flows/{id1}/signup"), json!({}))
        .await;
    assert_eq!(r.status, 200, "{}", r.json);
    // A sign-up written concurrently with the finish can still name the account: it must
    // be settled when it is used.
    sqlx::query("update signup_sessions set claim_account_uuid = $1 where verified_email = $2")
        .bind(&uuid)
        .bind(&two)
        .execute(&ctx.state.db)
        .await
        .expect("stale claim");
    let r = b2.get(&ctx, &format!("/v1/flows/{id2}")).await;
    assert_eq!(r.json["flow"]["signup"]["finishing_import"], false);
    assert_ne!(
        r.json["flow"]["signup"]["id"],
        r.json["flow"]["signed_in_as"]["id"]
    );
    // The app that takes no new accounts can't take this one either, and says why without
    // pointing at the finished account.
    let r = b2
        .post(&ctx, &format!("/v1/flows/{id2}/signup"), json!({}))
        .await;
    assert_eq!(r.status, 403, "{}", r.json);
    assert_eq!(r.error_code(), Some("signup_not_allowed"));
    assert!(!r.json.to_string().contains(&uuid));
    let claim: Option<String> = sqlx::query_scalar(
        "select claim_account_uuid from signup_sessions where verified_email = $1",
    )
    .bind(&two)
    .fetch_one(&ctx.state.db)
    .await
    .expect("session");
    assert_eq!(claim, None, "the stale claim was dropped");
    let r = b2.get(&ctx, &format!("/v1/flows/{id2}")).await;
    assert_eq!(r.json["flow"]["step"], "choose_method");
    assert_eq!(r.json["flow"]["error"]["code"], "signup_not_allowed");
}

/// A minimal valid PNG of the given size.
fn png(width: u32, height: u32) -> Vec<u8> {
    let mut v = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    v.extend_from_slice(&13u32.to_be_bytes());
    v.extend_from_slice(b"IHDR");
    v.extend_from_slice(&width.to_be_bytes());
    v.extend_from_slice(&height.to_be_bytes());
    v.extend_from_slice(&[8, 6, 0, 0, 0, 0x1F, 0x15, 0xC4, 0x89]);
    v.extend_from_slice(&[0, 0, 0, 0, b'I', b'E', b'N', b'D', 0xAE, 0x42, 0x60, 0x82]);
    v
}

fn photo_upload(flow_id: &str, body: Vec<u8>) -> Req {
    let mut req =
        Req::post(&format!("/v1/flows/{flow_id}/signup/photo")).header("content-type", "image/png");
    req.body = body;
    req
}

/// (account_uuid, signup_session_id is set) of the photo behind a photo URL, if it exists.
async fn photo_row(ctx: &TestContext, url: &str) -> Option<(Option<String>, bool)> {
    let id = uuid::Uuid::parse_str(url.rsplit('/').next().expect("id")).expect("uuid");
    sqlx::query_as::<_, (Option<String>, bool)>(
        "select account_uuid, signup_session_id is not null from photos where id = $1",
    )
    .bind(id)
    .fetch_optional(&ctx.state.db)
    .await
    .expect("photo row")
}

#[tokio::test]
async fn not_you_at_the_sign_up_step_ends_that_sign_up() {
    let ctx = TestContext::new().await;
    let (app, _) = ctx.app("briefcase").await;
    let mut b = Browser::new(&ctx);
    // A browser where someone is signed in keeps that session; only the sign-up ends.
    let someone = ctx.carbon().await;
    b.cookies
        .insert("sa_session".into(), ctx.browser_session(&someone).await);
    let email = random_email("notyou");
    let (id, _) = to_signup(&ctx, &mut b, &app.app_id, &email).await;
    let old_cookie = b.cookie("sa_signup").expect("sign-up cookie").to_string();

    let r = b
        .post(&ctx, &format!("/v1/flows/{id}/switch"), json!({}))
        .await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(r.json["flow"]["step"], "choose_method");
    assert!(
        b.cookie("sa_signup").is_none(),
        "the sign-up cookie is cleared"
    );
    assert!(b.cookie("sa_session").is_some(), "nobody is signed out");
    let ended: bool = sqlx::query_scalar(
        "select expires_at <= now() from signup_sessions where verified_email = $1",
    )
    .bind(&email)
    .fetch_one(&ctx.state.db)
    .await
    .expect("session");
    assert!(ended, "the sign-up session expired");

    // Even with the old cookie back, no new flow resumes it.
    let mut replay = b.clone();
    replay.cookies.insert("sa_signup".into(), old_cookie);
    let f = new_flow(&ctx, &mut replay, &app.app_id, json!({})).await;
    assert_eq!(f["step"], "choose_method", "{f}");
}

#[tokio::test]
async fn not_you_in_a_stale_tab_leaves_the_newer_sign_up_alone() {
    let ctx = TestContext::new().await;
    let (app, _) = ctx.app("briefcase").await;
    let mut b = Browser::new(&ctx);
    let (stale, _) = to_signup(&ctx, &mut b, &app.app_id, &random_email("stale")).await;
    // A second tab resumes that sign-up, says "Not you?" and verifies another address: the
    // browser's live sign-up is now that one, while the first tab still shows the old step.
    let f = new_flow(&ctx, &mut b, &app.app_id, json!({})).await;
    assert_eq!(f["step"], "signup", "{f}");
    let fresh = id_of(&f);
    let r = b
        .post(&ctx, &format!("/v1/flows/{fresh}/switch"), json!({}))
        .await;
    assert_eq!(r.status, 200, "{}", r.json);
    let r = email_and_verify(&ctx, &mut b, &fresh, &random_email("fresh")).await;
    assert_eq!(r.json["flow"]["step"], "signup", "{}", r.json);
    let r = b
        .post(&ctx, &format!("/v1/flows/{stale}/switch"), json!({}))
        .await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert!(
        b.cookie("sa_signup").is_some(),
        "the newer sign-up's cookie stays"
    );
    let r = b
        .post(&ctx, &format!("/v1/flows/{fresh}/signup"), json!({}))
        .await;
    assert_eq!(r.status, 200, "{}", r.json);
}

#[tokio::test]
async fn the_sign_up_page_uploads_the_photo_before_the_account_exists() {
    let ctx = TestContext::new().await;
    let (app, _) = ctx.app("briefcase").await;
    let mut b = Browser::new(&ctx);
    let (id, _) = to_signup(&ctx, &mut b, &app.app_id, &random_email("photo")).await;

    let r = b.call(&ctx, photo_upload(&id, png(128, 128))).await;
    assert_eq!(r.status, 201, "{}", r.json);
    assert_eq!(r.headers["cache-control"], "no-store");
    let first = r.json["pfp_url"].as_str().expect("pfp_url").to_string();
    assert!(
        first.starts_with(&format!("{}/v1/photos/", ctx.state.settings.public_url)),
        "{first}"
    );
    assert_eq!(r.json["photo"]["width"], 128);
    assert_eq!(photo_row(&ctx, &first).await, Some((None, true)));
    // It is the sign-up's photo now (a reload shows it).
    let r = b.get(&ctx, &format!("/v1/flows/{id}")).await;
    assert_eq!(r.json["flow"]["signup"]["pfp_url"], first.as_str());

    // A new upload replaces it.
    let r = b.call(&ctx, photo_upload(&id, png(64, 64))).await;
    assert_eq!(r.status, 201, "{}", r.json);
    let second = r.json["pfp_url"].as_str().expect("pfp_url").to_string();
    assert_eq!(
        photo_row(&ctx, &first).await,
        None,
        "the first upload is gone"
    );
    let r = b
        .post(
            &ctx,
            &format!("/v1/flows/{id}/signup"),
            json!({"pfp_url": first}),
        )
        .await;
    assert_eq!(r.status, 422, "{}", r.json);
    assert!(
        r.json["error"]["details"]["fields"]["pfp_url"]
            .as_str()
            .is_some_and(|m| m.contains("not the photo uploaded on this sign-up page")),
        "{}",
        r.json
    );

    // Another sign-up's upload is not this one's.
    let mut other = Browser::new(&ctx);
    let (other_id, _) = to_signup(&ctx, &mut other, &app.app_id, &random_email("other")).await;
    let r = other.call(&ctx, photo_upload(&other_id, png(32, 32))).await;
    let theirs = r.json["pfp_url"].as_str().expect("pfp_url").to_string();
    let r = b
        .post(
            &ctx,
            &format!("/v1/flows/{id}/signup"),
            json!({"pfp_url": theirs}),
        )
        .await;
    assert_eq!(r.status, 422, "{}", r.json);

    // The upload belongs to the browser that verified: no sign-up cookie, no upload.
    let mut stolen = b.clone();
    stolen.cookies.remove("sa_signup");
    let r = stolen.call(&ctx, photo_upload(&id, png(8, 8))).await;
    assert_eq!(r.error_code(), Some("signup_not_bound"));
    let r = b
        .call(
            &ctx,
            Req::post(&format!("/v1/flows/{id}/signup/photo"))
                .header("content-type", "image/svg+xml"),
        )
        .await;
    assert_eq!(r.status, 415);

    // Accepting the prefill keeps the upload: it becomes the new account's own photo.
    let r = b
        .post(&ctx, &format!("/v1/flows/{id}/signup"), json!({}))
        .await;
    assert_eq!(r.status, 200, "{}", r.json);
    let uuid = r.json["flow"]["signed_in_as"]["uuid"]
        .as_str()
        .expect("uuid")
        .to_string();
    assert_eq!(r.json["flow"]["signed_in_as"]["pfp_url"], second.as_str());
    assert_eq!(photo_row(&ctx, &second).await, Some((Some(uuid), false)));

    // The sign-up is over, and so is its photo upload.
    let r = b.call(&ctx, photo_upload(&id, png(8, 8))).await;
    assert_eq!(r.status, 409, "{}", r.json);
}

#[tokio::test]
async fn sign_up_photos_go_when_the_sign_up_ends_without_them() {
    let ctx = TestContext::new().await;
    let (app, _) = ctx.app("briefcase").await;

    // Choosing the default photo (null) discards the upload at sign-up.
    let mut b = Browser::new(&ctx);
    let (id, _) = to_signup(&ctx, &mut b, &app.app_id, &random_email("nullpfp")).await;
    let r = b.call(&ctx, photo_upload(&id, png(16, 16))).await;
    let url = r.json["pfp_url"].as_str().expect("pfp_url").to_string();
    let r = b
        .post(
            &ctx,
            &format!("/v1/flows/{id}/signup"),
            json!({"pfp_url": null}),
        )
        .await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert!(
        r.json["flow"]["signed_in_as"]["pfp_url"]
            .as_str()
            .is_some_and(|u| u.starts_with("https://iris.teamofsilicons.com/pfp/carbon?id=")),
        "{}",
        r.json
    );
    assert_eq!(photo_row(&ctx, &url).await, None);

    // A sign-up that runs out: the sweep deletes its upload.
    let mut b = Browser::new(&ctx);
    let (id, _) = to_signup(&ctx, &mut b, &app.app_id, &random_email("expire")).await;
    let r = b.call(&ctx, photo_upload(&id, png(16, 16))).await;
    let url = r.json["pfp_url"].as_str().expect("pfp_url").to_string();
    let report = accounts_auth::sweep::run_once(&ctx.state.db)
        .await
        .expect("sweep");
    assert_eq!(report.signup_photos, 0, "a live sign-up keeps its photo");
    ctx.exec("update signup_sessions set expires_at = now() - interval '1 second'")
        .await;
    let report = accounts_auth::sweep::run_once(&ctx.state.db)
        .await
        .expect("sweep");
    assert_eq!(report.signup_photos, 1);
    assert_eq!(photo_row(&ctx, &url).await, None);
}

#[tokio::test]
async fn finishing_an_import_keeps_the_photo_chosen_at_sign_up() {
    let ctx = TestContext::new().await;
    let email = random_email("crm-photo");
    let (app, _) = app_with(&ctx, "legacy", json!({"allow_signup": false})).await;
    let imported = ctx
        .carbon_with(CarbonSpec {
            email: Some(email.clone()),
            status: Some(AccountStatus::Unclaimed),
            ..Default::default()
        })
        .await;
    let mut b = Browser::new(&ctx);
    let (id, f) = to_signup(&ctx, &mut b, &app.app_id, &email).await;
    assert_eq!(f["signup"]["finishing_import"], true);
    assert_eq!(f["signup"]["pfp_url"], imported.pfp_url.as_str());
    let r = b.call(&ctx, photo_upload(&id, png(40, 40))).await;
    assert_eq!(r.status, 201, "{}", r.json);
    let url = r.json["pfp_url"].as_str().expect("pfp_url").to_string();
    // The upload replaces the imported photo as the prefill, and is kept on finishing.
    let r = b.get(&ctx, &format!("/v1/flows/{id}")).await;
    assert_eq!(r.json["flow"]["signup"]["pfp_url"], url.as_str());
    let r = b
        .post(&ctx, &format!("/v1/flows/{id}/signup"), json!({}))
        .await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(
        r.json["flow"]["signed_in_as"]["uuid"],
        imported.uuid.as_str()
    );
    assert_eq!(r.json["flow"]["signed_in_as"]["pfp_url"], url.as_str());
    assert_eq!(
        photo_row(&ctx, &url).await,
        Some((Some(imported.uuid.clone()), false)),
        "the photo is now the finished account's own upload"
    );
}
