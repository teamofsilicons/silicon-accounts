//! Emails and phone numbers: add with a code, verify, primary, remove, limits and webhooks.

use accounts_core::events::types;
use accounts_core::models::{Scope, VerifiedVia};
use accounts_core::repo::contacts;
use accounts_core::test_support::{CarbonSpec, Req, TestContext, rand_suffix};
use serde_json::{Value, json};

use crate::common::*;

fn emails_of(r: &Value) -> Vec<(String, bool)> {
    r["items"]
        .as_array()
        .expect("items")
        .iter()
        .map(|e| {
            (
                e["email"].as_str().unwrap_or_default().to_string(),
                e["is_primary"].as_bool().unwrap_or_default(),
            )
        })
        .collect()
}

#[tokio::test]
async fn add_an_email_with_a_code() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let tok = token(&ctx, &carbon).await;
    let new = format!("Second.{}@Example.TEST", rand_suffix());
    let normalized = new.to_lowercase();

    let r = call(
        &ctx,
        Req::post("/v1/me/emails")
            .bearer(&tok)
            .json(json!({ "email": new })),
    )
    .await;
    assert_status(&r, 201);
    assert_eq!(r.json["destination"], normalized);
    assert_eq!(r.json["channel"], "email");
    assert!(r.json["expires_at"].as_str().is_some());
    let challenge = r.json["challenge_id"]
        .as_str()
        .expect("challenge")
        .to_string();
    let sent = ctx.outbox(&normalized).await;
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].0, "otp_add_email");
    let code = latest_code(&ctx, &normalized).await;

    let r = call(
        &ctx,
        Req::post("/v1/me/emails/verify")
            .bearer(&tok)
            .json(json!({ "challenge_id": challenge, "code": code })),
    )
    .await;
    assert_status(&r, 200);
    let list = emails_of(&r.json);
    assert_eq!(list.len(), 2);
    assert!(list.contains(&(normalized.clone(), false)));
    let added = r.json["items"]
        .as_array()
        .and_then(|a| a.iter().find(|e| e["email"] == normalized.as_str()))
        .expect("added email");
    assert_eq!(added["verified_via"], "code");
    assert!(added["verified_at"].as_str().is_some());

    // The code is single use; the same request with an idempotency key replays instead.
    let r = call(
        &ctx,
        Req::post("/v1/me/emails/verify")
            .bearer(&tok)
            .json(json!({ "challenge_id": challenge, "code": code })),
    )
    .await;
    assert_error(&r, 409, "code_already_used");

    let r = call(&ctx, Req::get("/v1/me/emails").bearer(&tok)).await;
    assert_status(&r, 200);
    assert_eq!(emails_of(&r.json).len(), 2);
    assert_eq!(r.json["next_cursor"], Value::Null);
    let audit: i64 = scalar(
        &ctx,
        "select count(*) from audit_log where account_uuid = $1 and action = 'account.email.added'",
        &carbon.uuid,
    )
    .await;
    assert_eq!(audit, 1);
}

#[tokio::test]
async fn email_conflicts_limits_and_bad_codes() {
    let ctx = TestContext::new().await;
    let other_email = format!("other-{}@example.test", rand_suffix());
    ctx.carbon_with(CarbonSpec {
        email: Some(other_email.clone()),
        ..Default::default()
    })
    .await;
    let carbon = ctx.carbon().await;
    let tok = token(&ctx, &carbon).await;
    let add = |email: &str| {
        Req::post("/v1/me/emails")
            .bearer(&tok)
            .json(json!({ "email": email }))
    };

    let r = call(&ctx, add(&other_email.to_uppercase())).await;
    assert_error(&r, 409, "email_in_use");
    let mine = contacts::list_emails(&mut *ctx.conn().await, &carbon.uuid)
        .await
        .expect("emails")[0]
        .email
        .clone();
    let r = call(&ctx, add(&mine)).await;
    assert_error(&r, 409, "email_already_added");
    let r = call(&ctx, add("not-an-email")).await;
    assert_error(&r, 422, "invalid_email");
    let r = call(
        &ctx,
        Req::post("/v1/me/emails").bearer(&tok).json(json!({})),
    )
    .await;
    assert_error(&r, 422, "validation_failed");

    // Wrong codes count down; someone else's challenge is not found.
    let fresh = format!("fresh-{}@example.test", rand_suffix());
    let r = call(&ctx, add(&fresh)).await;
    let challenge = r.json["challenge_id"]
        .as_str()
        .expect("challenge")
        .to_string();
    let code = latest_code(&ctx, &fresh).await;
    let wrong = if code == "000000" { "111111" } else { "000000" };
    let verify = |t: &str, c: &str| {
        Req::post("/v1/me/emails/verify")
            .bearer(t)
            .json(json!({ "challenge_id": challenge, "code": c }))
    };
    let r = call(&ctx, verify(&tok, wrong)).await;
    assert_error(&r, 422, "invalid_code");
    assert_eq!(r.json["error"]["details"]["remaining_attempts"], 9);
    let stranger = ctx.carbon().await;
    let r = call(&ctx, verify(&token(&ctx, &stranger).await, &code)).await;
    assert_error(&r, 404, "challenge_not_found");
    // A phone-verify endpoint won't take an email challenge either.
    let r = call(
        &ctx,
        Req::post("/v1/me/phones/verify")
            .bearer(&tok)
            .json(json!({ "challenge_id": challenge, "code": code })),
    )
    .await;
    assert_error(&r, 404, "challenge_not_found");
    let r = call(
        &ctx,
        Req::post("/v1/me/emails/verify")
            .bearer(&tok)
            .json(json!({ "challenge_id": "nope", "code": code })),
    )
    .await;
    assert_error(&r, 422, "validation_failed");
    assert!(
        r.json["error"]["details"]["fields"]["challenge_id"]
            .as_str()
            .is_some()
    );
    ctx.exec("update otp_challenges set expires_at = now() - interval '1 second'")
        .await;
    let r = call(&ctx, verify(&tok, &code)).await;
    assert_error(&r, 410, "code_expired");

    // Ten emails is the most an account can have.
    let mut conn = ctx.conn().await;
    for i in 0..9 {
        contacts::add_verified_email(
            &mut conn,
            &carbon.uuid,
            &format!("extra{i}-{}@example.test", rand_suffix()),
            VerifiedVia::Code,
        )
        .await
        .expect("add");
    }
    drop(conn);
    let r = call(
        &ctx,
        add(&format!("eleventh-{}@example.test", rand_suffix())),
    )
    .await;
    assert_error(&r, 422, "email_limit_reached");
}

#[tokio::test]
async fn sending_codes_to_one_address_is_rate_limited() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let tok = token(&ctx, &carbon).await;
    let email = format!("busy-{}@example.test", rand_suffix());
    for _ in 0..10 {
        let r = call(
            &ctx,
            Req::post("/v1/me/emails")
                .bearer(&tok)
                .json(json!({ "email": email })),
        )
        .await;
        assert_status(&r, 201);
    }
    let r = call(
        &ctx,
        Req::post("/v1/me/emails")
            .bearer(&tok)
            .json(json!({ "email": email })),
    )
    .await;
    assert_error(&r, 429, "rate_limited");
    assert!(r.headers.get("retry-after").is_some());
}

#[tokio::test]
async fn adding_is_idempotent_with_a_key() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let tok = token(&ctx, &carbon).await;
    let email = format!("once-{}@example.test", rand_suffix());
    let req = || {
        Req::post("/v1/me/emails")
            .bearer(&tok)
            .header("idempotency-key", "add-email-1")
            .json(json!({ "email": email }))
    };
    let a = call(&ctx, req()).await;
    let b = call(&ctx, req()).await;
    assert_status(&b, 201);
    assert_eq!(a.json["challenge_id"], b.json["challenge_id"]);
    assert_eq!(ctx.outbox(&email).await.len(), 1, "only one code was sent");
}

#[tokio::test]
async fn primary_changes_reach_apps_with_the_email_scope() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let first = contacts::list_emails(&mut *ctx.conn().await, &carbon.uuid)
        .await
        .expect("emails")[0]
        .email
        .clone();
    let second = format!("second-{}@example.test", rand_suffix());
    contacts::add_verified_email(
        &mut *ctx.conn().await,
        &carbon.uuid,
        &second,
        VerifiedVia::Code,
    )
    .await
    .expect("add");
    let with_email = member_app(&ctx, "mail", &carbon, &[Scope::Profile, Scope::Email]).await;
    let profile_only = member_app(&ctx, "plain", &carbon, &[Scope::Profile]).await;
    let tok = token(&ctx, &carbon).await;

    let r = call(
        &ctx,
        Req::post(&format!("/v1/me/emails/{}/primary", second.to_uppercase())).bearer(&tok),
    )
    .await;
    assert_status(&r, 200);
    assert_eq!(
        emails_of(&r.json)[0],
        (second.clone(), true),
        "primary first"
    );
    let evs = events(&ctx, &with_email, types::ACCOUNT_UPDATED).await;
    assert_eq!(evs.len(), 1);
    assert_eq!(evs[0]["data"]["changed"], json!(["email"]));
    assert_eq!(evs[0]["data"]["account"]["email"], second);
    assert_eq!(evs[0]["data"]["account"]["email_verified"], true);
    assert!(
        events(&ctx, &profile_only, types::ACCOUNT_UPDATED)
            .await
            .is_empty()
    );
    assert_eq!(reload(&ctx, &carbon.uuid).await.version, carbon.version + 1);

    // Already primary: nothing changes.
    let r = call(
        &ctx,
        Req::post(&format!("/v1/me/emails/{second}/primary")).bearer(&tok),
    )
    .await;
    assert_status(&r, 200);
    assert_eq!(
        events(&ctx, &with_email, types::ACCOUNT_UPDATED)
            .await
            .len(),
        1
    );

    let r = call(
        &ctx,
        Req::post("/v1/me/emails/nobody@example.test/primary").bearer(&tok),
    )
    .await;
    assert_error(&r, 404, "email_not_found");

    // The primary can't be removed; any other can.
    let r = call(
        &ctx,
        Req::delete(&format!("/v1/me/emails/{second}")).bearer(&tok),
    )
    .await;
    assert_error(&r, 409, "cannot_remove_primary");
    let r = call(
        &ctx,
        Req::delete(&format!("/v1/me/emails/{first}")).bearer(&tok),
    )
    .await;
    assert_status(&r, 200);
    assert_eq!(emails_of(&r.json), vec![(second.clone(), true)]);
    let r = call(
        &ctx,
        Req::delete(&format!("/v1/me/emails/{first}")).bearer(&tok),
    )
    .await;
    assert_error(&r, 404, "email_not_found");
    let r = call(
        &ctx,
        Req::delete("/v1/me/emails/not%20an%20email").bearer(&tok),
    )
    .await;
    assert_error(&r, 422, "invalid_email");
}

#[tokio::test]
async fn phones_work_the_same_way() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let phone_app = member_app(&ctx, "dm", &carbon, &[Scope::Profile, Scope::Phone]).await;
    let tok = token(&ctx, &carbon).await;

    // A local number with its country.
    let r = call(
        &ctx,
        Req::post("/v1/me/phones")
            .bearer(&tok)
            .json(json!({ "phone": "98765 43210", "country": "in" })),
    )
    .await;
    assert_status(&r, 201);
    assert_eq!(r.json["destination"], "+919876543210");
    assert_eq!(r.json["channel"], "phone");
    let challenge = r.json["challenge_id"]
        .as_str()
        .expect("challenge")
        .to_string();
    let sent = ctx.outbox("+919876543210").await;
    assert_eq!(sent[0].0, "otp_add_phone");
    let code = latest_code(&ctx, "+919876543210").await;
    let r = call(
        &ctx,
        Req::post("/v1/me/phones/verify")
            .bearer(&tok)
            .json(json!({ "challenge_id": challenge, "code": code })),
    )
    .await;
    assert_status(&r, 200);
    assert_eq!(r.json["items"][0]["phone"], "+919876543210");
    assert_eq!(
        r.json["items"][0]["is_primary"], true,
        "the first phone becomes primary"
    );
    // The first phone is a new primary: apps with the phone scope hear about it.
    let evs = events(&ctx, &phone_app, types::ACCOUNT_UPDATED).await;
    assert_eq!(evs.len(), 1);
    assert_eq!(evs[0]["data"]["changed"], json!(["phone"]));
    assert_eq!(evs[0]["data"]["account"]["phone"], "+919876543210");

    let r = call(
        &ctx,
        Req::post("/v1/me/phones")
            .bearer(&tok)
            .json(json!({ "phone": "12345" })),
    )
    .await;
    assert_error(&r, 422, "invalid_phone");
    let r = call(
        &ctx,
        Req::post("/v1/me/phones")
            .bearer(&tok)
            .json(json!({ "phone": "9876543211", "country": "Atlantis" })),
    )
    .await;
    assert_error(&r, 422, "invalid_country");

    contacts::add_verified_phone(&mut *ctx.conn().await, &carbon.uuid, "+919876543211")
        .await
        .expect("second phone");
    let r = call(
        &ctx,
        Req::post("/v1/me/phones/+919876543211/primary").bearer(&tok),
    )
    .await;
    assert_status(&r, 200);
    assert_eq!(r.json["items"][0]["phone"], "+919876543211");
    assert_eq!(
        events(&ctx, &phone_app, types::ACCOUNT_UPDATED).await.len(),
        2
    );
    let r = call(
        &ctx,
        Req::delete("/v1/me/phones/%2B919876543211").bearer(&tok),
    )
    .await;
    assert_error(&r, 409, "cannot_remove_primary");
    let r = call(
        &ctx,
        Req::delete("/v1/me/phones/+919876543210").bearer(&tok),
    )
    .await;
    assert_status(&r, 200);
    assert_eq!(r.json["items"].as_array().map(Vec::len), Some(1));
    let r = call(&ctx, Req::get("/v1/me/phones").bearer(&tok)).await;
    assert_eq!(r.json["items"].as_array().map(Vec::len), Some(1));
    let r = call(&ctx, Req::delete("/v1/me/phones/9876543211").bearer(&tok)).await;
    assert_error(&r, 422, "invalid_phone");
}

#[tokio::test]
async fn silicons_have_no_emails_or_phones() {
    let ctx = TestContext::new().await;
    let (silicon, _) = ctx.silicon(&ctx.carbon().await.uuid).await;
    let tok = token(&ctx, &silicon).await;
    for req in [
        Req::get("/v1/me/emails"),
        Req::get("/v1/me/phones"),
        Req::post("/v1/me/emails").json(json!({"email": "si@example.test"})),
    ] {
        let r = call(&ctx, req.bearer(&tok)).await;
        assert_error(&r, 403, "carbon_only");
    }
}

#[tokio::test]
async fn an_imported_unverified_email_is_verified_in_place() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let imported = format!("imported-{}@example.test", rand_suffix());
    sqlx::query(
        "insert into account_emails (email, account_uuid, is_primary, verified_at) values ($1, $2, false, null)",
    )
    .bind(&imported)
    .bind(&carbon.uuid)
    .execute(&ctx.state.db)
    .await
    .expect("unverified email");
    let tok = token(&ctx, &carbon).await;

    // It can't be the primary before it is proven.
    let r = call(
        &ctx,
        Req::post(&format!("/v1/me/emails/{imported}/primary")).bearer(&tok),
    )
    .await;
    assert_error(&r, 409, "email_not_verified");

    let r = call(
        &ctx,
        Req::post("/v1/me/emails")
            .bearer(&tok)
            .json(json!({ "email": imported })),
    )
    .await;
    assert_status(&r, 201);
    let challenge = r.json["challenge_id"]
        .as_str()
        .expect("challenge")
        .to_string();
    let code = latest_code(&ctx, &imported).await;
    let r = call(
        &ctx,
        Req::post("/v1/me/emails/verify")
            .bearer(&tok)
            .json(json!({ "challenge_id": challenge, "code": code })),
    )
    .await;
    assert_status(&r, 200);
    let row = r.json["items"]
        .as_array()
        .and_then(|a| a.iter().find(|e| e["email"] == imported.as_str()))
        .cloned()
        .expect("listed");
    assert!(row["verified_at"].as_str().is_some());
    assert_eq!(
        emails_of(&r.json).len(),
        2,
        "verified in place, not added twice"
    );
    let r = call(
        &ctx,
        Req::post(&format!("/v1/me/emails/{imported}/primary")).bearer(&tok),
    )
    .await;
    assert_status(&r, 200);
}

#[tokio::test]
async fn an_address_claimed_while_the_code_was_in_flight_is_refused() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let racer = ctx.carbon().await;
    let tok = token(&ctx, &carbon).await;
    let contested = format!("contested-{}@example.test", rand_suffix());
    let r = call(
        &ctx,
        Req::post("/v1/me/emails")
            .bearer(&tok)
            .json(json!({ "email": contested })),
    )
    .await;
    let challenge = r.json["challenge_id"]
        .as_str()
        .expect("challenge")
        .to_string();
    let code = latest_code(&ctx, &contested).await;
    contacts::add_verified_email(
        &mut *ctx.conn().await,
        &racer.uuid,
        &contested,
        VerifiedVia::Code,
    )
    .await
    .expect("the other account proves it first");
    let r = call(
        &ctx,
        Req::post("/v1/me/emails/verify")
            .bearer(&tok)
            .json(json!({ "challenge_id": challenge, "code": code })),
    )
    .await;
    assert_error(&r, 409, "email_in_use");
    let r = call(&ctx, Req::get("/v1/me/emails").bearer(&tok)).await;
    assert_eq!(emails_of(&r.json).len(), 1);
}

#[tokio::test]
async fn in_use_answers_use_up_the_add_budget() {
    let ctx = TestContext::new().await;
    let victim_email = format!("victim-{}@example.test", rand_suffix());
    ctx.carbon_with(CarbonSpec {
        email: Some(victim_email.clone()),
        phone: Some("+12025550199".into()),
        ..Default::default()
    })
    .await;
    let prober = ctx.carbon().await;
    let tok = token(&ctx, &prober).await;
    let add_email = |email: &str| {
        Req::post("/v1/me/emails")
            .bearer(&tok)
            .json(json!({ "email": email }))
    };
    for _ in 0..20 {
        let r = call(&ctx, add_email(&victim_email)).await;
        assert_error(&r, 409, "email_in_use");
    }
    // The 409s used up the budget: phones share it, and so do addresses nobody has.
    let r = call(
        &ctx,
        Req::post("/v1/me/phones")
            .bearer(&tok)
            .json(json!({ "phone": "+12025550199" })),
    )
    .await;
    assert_error(&r, 429, "rate_limited");
    assert!(r.headers.get("retry-after").is_some());
    assert!(
        r.json["error"]["message"]
            .as_str()
            .is_some_and(|m| m.contains("to this account") && m.contains("20 per 10 minutes")),
        "{}",
        r.json
    );
    let fresh = format!("fresh-{}@example.test", rand_suffix());
    let r = call(&ctx, add_email(&fresh)).await;
    assert_error(&r, 429, "rate_limited");
    assert!(ctx.outbox(&fresh).await.is_empty(), "no code was sent");

    // Other accounts have their own budget.
    let other = ctx.carbon().await;
    let r = call(
        &ctx,
        Req::post("/v1/me/emails")
            .bearer(&token(&ctx, &other).await)
            .json(json!({ "email": fresh })),
    )
    .await;
    assert_status(&r, 201);

    // Once the 10-minute window has passed the account can add again.
    ctx.exec(&format!(
        "update rate_limits set window_started_at = now() - interval '11 minutes' where bucket = 'contact_add:account:{}'",
        prober.uuid
    ))
    .await;
    let r = call(
        &ctx,
        add_email(&format!("later-{}@example.test", rand_suffix())),
    )
    .await;
    assert_status(&r, 201);
}

#[tokio::test]
async fn add_attempts_are_limited_per_network() {
    let mut settings = accounts_core::Settings::for_tests();
    settings.trust_forwarded_for = true;
    let ctx = TestContext::with_settings(settings).await;
    let victim_email = format!("victim-{}@example.test", rand_suffix());
    ctx.carbon_with(CarbonSpec {
        email: Some(victim_email.clone()),
        ..Default::default()
    })
    .await;
    let first = token(&ctx, &ctx.carbon().await).await;
    let second = token(&ctx, &ctx.carbon().await).await;
    let third = token(&ctx, &ctx.carbon().await).await;
    let add = |tok: &str, email: &str, ip: &str| {
        Req::post("/v1/me/emails")
            .bearer(tok)
            .header("x-forwarded-for", ip)
            .json(json!({ "email": email }))
    };
    // 30 attempts from one network over two accounts (each under its own limit of 20).
    for i in 0..30 {
        let tok = if i % 2 == 0 { &first } else { &second };
        let r = call(&ctx, add(tok, &victim_email, "203.0.113.50")).await;
        assert_error(&r, 409, "email_in_use");
    }
    let fresh = format!("fresh-{}@example.test", rand_suffix());
    let r = call(&ctx, add(&third, &fresh, "203.0.113.50")).await;
    assert_error(&r, 429, "rate_limited");
    assert!(
        r.json["error"]["message"]
            .as_str()
            .is_some_and(|m| m.contains("from this network")),
        "{}",
        r.json
    );
    // Another network is not affected.
    let r = call(&ctx, add(&third, &fresh, "198.51.100.7")).await;
    assert_status(&r, 201);
}

#[tokio::test]
async fn verifying_an_imported_primary_tells_the_apps() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    // An imported account: its primary email isn't verified yet.
    let primary: String = sqlx::query_scalar(
        "update account_emails set verified_at = null, verified_via = null \
         where account_uuid = $1 and is_primary returning email",
    )
    .bind(&carbon.uuid)
    .fetch_one(&ctx.state.db)
    .await
    .expect("unverified primary");
    let extra = format!("extra-{}@example.test", rand_suffix());
    sqlx::query(
        "insert into account_emails (email, account_uuid, is_primary, verified_at) values ($1, $2, false, null)",
    )
    .bind(&extra)
    .bind(&carbon.uuid)
    .execute(&ctx.state.db)
    .await
    .expect("unverified extra email");
    let with_email = member_app(&ctx, "mail", &carbon, &[Scope::Profile, Scope::Email]).await;
    let profile_only = member_app(&ctx, "plain", &carbon, &[Scope::Profile]).await;
    let tok = token(&ctx, &carbon).await;
    let verify = |email: String| {
        let ctx = &ctx;
        let tok = tok.clone();
        async move {
            let r = call(
                ctx,
                Req::post("/v1/me/emails")
                    .bearer(&tok)
                    .json(json!({ "email": email })),
            )
            .await;
            assert_status(&r, 201);
            let challenge = r.json["challenge_id"]
                .as_str()
                .expect("challenge")
                .to_string();
            let code = latest_code(ctx, &email).await;
            call(
                ctx,
                Req::post("/v1/me/emails/verify")
                    .bearer(&tok)
                    .json(json!({ "challenge_id": challenge, "code": code })),
            )
            .await
        }
    };

    // A non-primary imported email getting verified changes nothing apps can see.
    let r = verify(extra.clone()).await;
    assert_status(&r, 200);
    assert!(
        events(&ctx, &with_email, types::ACCOUNT_UPDATED)
            .await
            .is_empty()
    );
    assert_eq!(reload(&ctx, &carbon.uuid).await.version, carbon.version);

    // The primary getting verified flips email_verified for apps with the email scope.
    let r = verify(primary.clone()).await;
    assert_status(&r, 200);
    let evs = events(&ctx, &with_email, types::ACCOUNT_UPDATED).await;
    assert_eq!(evs.len(), 1);
    assert_eq!(evs[0]["data"]["changed"], json!(["email"]));
    assert_eq!(evs[0]["data"]["account"]["email"], primary);
    assert_eq!(evs[0]["data"]["account"]["email_verified"], true);
    assert!(
        events(&ctx, &profile_only, types::ACCOUNT_UPDATED)
            .await
            .is_empty()
    );
    assert_eq!(reload(&ctx, &carbon.uuid).await.version, carbon.version + 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_code_verified_while_the_account_is_deleted_adds_nothing() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let tok = token(&ctx, &carbon).await;
    let late = format!("late-{}@example.test", rand_suffix());
    let r = call(
        &ctx,
        Req::post("/v1/me/emails")
            .bearer(&tok)
            .json(json!({ "email": late })),
    )
    .await;
    assert_status(&r, 201);
    let challenge = r.json["challenge_id"]
        .as_str()
        .expect("challenge")
        .to_string();
    let code = latest_code(&ctx, &late).await;

    // The verify request authenticates, then waits for the account row, which a deletion holds.
    let mut deletion = ctx.state.db.begin().await.expect("begin");
    sqlx::query("select 1 from accounts where uuid = $1 for update")
        .bind(&carbon.uuid)
        .execute(&mut *deletion)
        .await
        .expect("lock");
    let verify = call(
        &ctx,
        Req::post("/v1/me/emails/verify")
            .bearer(&tok)
            .json(json!({ "challenge_id": challenge, "code": code })),
    );
    let delete = async {
        wait_for_lock_waiters(&ctx, 1).await;
        accounts_core::repo::accounts::delete_account(
            &mut deletion,
            &ctx.state.settings,
            &carbon.uuid,
            &carbon.uuid,
            true,
        )
        .await
        .expect("delete");
        deletion.commit().await.expect("commit");
    };
    let (r, ()) = tokio::join!(verify, delete);
    assert_error(&r, 409, "account_deleted");
    assert!(
        r.json["error"]["message"]
            .as_str()
            .is_some_and(|m| m.contains(&late)),
        "{}",
        r.json
    );
    let owner: Option<String> =
        sqlx::query_scalar("select account_uuid from account_emails where email = $1")
            .bind(&late)
            .fetch_optional(&ctx.state.db)
            .await
            .expect("owner");
    assert_eq!(owner, None, "the address is free for anyone");
}
