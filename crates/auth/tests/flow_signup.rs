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
    let today = accounts_core::timefmt::today_utc();
    assert_eq!(
        s["dob"],
        accounts_core::timefmt::format_date(accounts_core::normalize::default_dob(today))
    );
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

    // Accept the prefill as-is.
    let r = b
        .post(&ctx, &format!("/v1/flows/{id}/signup"), json!({}))
        .await;
    assert_eq!(r.status, 200, "{}", r.json);
    let f = &r.json["flow"];
    assert_eq!(f["step"], "consent");
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

    let r = b
        .post(
            &ctx,
            &format!("/v1/flows/{id}/consent"),
            json!({"approve": true}),
        )
        .await;
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
    let flow = email_signup(&ctx, &mut b, "accounts", &random_email("site"), json!({})).await;
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

    let r = b
        .post(
            &ctx,
            &format!("/v1/flows/{id}/signup"),
            json!({"id": "c:imported-new", "display_name": "Imported Carbon"}),
        )
        .await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(
        r.json["flow"]["step"], "consent",
        "the import was not a consent"
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

    let r = b
        .post(
            &ctx,
            &format!("/v1/flows/{id}/consent"),
            json!({"approve": true}),
        )
        .await;
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
    let r = b
        .post(&ctx, &format!("/v1/flows/{id}/signup"), json!({}))
        .await;
    assert_eq!(r.status, 200, "{}", r.json);
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
