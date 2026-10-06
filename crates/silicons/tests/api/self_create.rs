//! `POST /v1/silicons`: a Silicon creates its own account and names its custodian.

use accounts_core::models::AccountStatus;
use accounts_core::test_support::{CarbonSpec, Req, Resp, TestContext, test_settings};
use serde_json::json;

use crate::common::*;

#[tokio::test]
async fn self_create_by_cid_makes_a_pending_silicon_with_a_request() {
    let ctx = TestContext::new().await;
    let saket = ctx
        .carbon_with(CarbonSpec {
            email: Some("saket@example.test".into()),
            ..Default::default()
        })
        .await;
    let custodian_id = saket.handle.clone().expect("id");
    let id = silicon_id("scout");
    let r = self_create(
        &ctx,
        json!({
            "id": id.to_uppercase().replace("SI:", "si:"),
            "display_name": "  Scout  ",
            "custodian": custodian_id.to_uppercase(),
            "timezone": "asia/kolkata",
            "webhook_url": "http://127.0.0.1:8593/hooks/scout",
        }),
    )
    .await;
    assert_eq!(r.status, 201, "{}", r.json);
    assert_eq!(
        r.headers
            .get("cache-control")
            .map(|v| v.to_str().unwrap_or("")),
        Some("no-store")
    );
    let body = &r.json;

    // The Silicon view: pending, no custodian yet, dob = creation date, normalized fields.
    let silicon = &body["silicon"];
    assert_eq!(silicon["kind"], "silicon");
    assert_eq!(silicon["id"], id);
    assert_eq!(silicon["status"], "pending_custodian");
    assert_eq!(silicon["display_name"], "Scout");
    assert_eq!(silicon["timezone"], "Asia/Kolkata");
    assert_eq!(silicon["custodian"], serde_json::Value::Null);
    assert_eq!(silicon["webhook_url"], "http://127.0.0.1:8593/hooks/scout");
    assert_eq!(
        silicon["dob"],
        accounts_core::timefmt::format_date(time::OffsetDateTime::now_utc().date())
    );
    let uuid = silicon["uuid"].as_str().expect("uuid").to_string();
    assert!(
        silicon["pfp_url"]
            .as_str()
            .expect("pfp")
            .contains(&format!("/pfp/silicon?id={uuid}"))
    );

    // A generated STK, shown once: stk- + 12 lowercase hex.
    let stk = body["stk"].as_str().expect("generated stk");
    assert!(stk.starts_with("stk-") && stk.len() == 16, "{stk}");
    assert!(
        stk[4..]
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
    );

    // The request: pending for 14 days, named by c:id.
    let request = &body["request"];
    assert_eq!(request["status"], "pending");
    assert_eq!(request["kind"], "initial");
    assert_eq!(request["custodian"], custodian_id);
    let expires = ts(&request["expires_at"]);
    let in_14_days = time::OffsetDateTime::now_utc() + time::Duration::days(14);
    assert!((expires - in_14_days).abs() < time::Duration::minutes(1));
    let request_id = request["id"].as_str().expect("request id");
    assert!(
        body["request_token"]
            .as_str()
            .expect("token")
            .starts_with("sarq_")
    );
    assert!(
        body["webhook_secret"]
            .as_str()
            .expect("secret")
            .starts_with("whsec_")
    );

    // Stored state: request addressed by uuid, token stored only as a hash.
    let (status, kind, to_uuid, to_email, _) = request_row(&ctx, request_id).await;
    assert_eq!((status.as_str(), kind.as_str()), ("pending", "initial"));
    assert_eq!(to_uuid.as_deref(), Some(saket.uuid.as_str()));
    assert_eq!(to_email, None);
    let stored: Vec<u8> =
        sqlx::query_scalar("select request_token_hash from custodian_requests where id = $1::uuid")
            .bind(request_id)
            .fetch_one(&ctx.state.db)
            .await
            .expect("hash");
    assert_eq!(
        stored,
        ctx.state
            .keys
            .pepper
            .hash(body["request_token"].as_str().expect("token"))
    );
    let account = account(&ctx, &uuid).await;
    assert_eq!(account.status, AccountStatus::PendingCustodian);
    assert_eq!(account.custodian_uuid, None);
    assert!(
        account
            .stk_hash
            .as_deref()
            .is_some_and(|h| h.starts_with("$argon2id$"))
    );

    // silicon.created reached the Silicon's own webhook.
    let events = silicon_events(&ctx, &uuid).await;
    assert_eq!(events.len(), 1);
    let (event_type, payload) = &events[0];
    assert_eq!(event_type, "silicon.created");
    assert_eq!(payload["silicon"], uuid);
    assert_eq!(payload["data"]["status"], "pending_custodian");
    assert_eq!(payload["data"]["request"]["id"], request_id);
    assert_eq!(payload["data"]["silicon"]["id"], id);
    assert_eq!(
        delivery_urls(&ctx, &uuid, "silicon.created").await,
        vec!["http://127.0.0.1:8593/hooks/scout".to_string()]
    );

    // The custodian was emailed at their primary email, naming the Silicon by its si:id only
    // (never by the display name an anonymous caller chose).
    let mail = ctx.outbox("saket@example.test").await;
    assert_eq!(mail.len(), 1);
    assert_eq!(mail[0].0, "custodian_request");
    assert!(mail[0].1.contains(&id), "{}", mail[0].1);
    assert!(!mail[0].1.contains("Scout"), "{}", mail[0].1);

    // History: the Silicon created itself; the custodian was asked.
    assert!(
        audit_actions(&ctx, &uuid)
            .await
            .contains(&"silicon.self_created".to_string())
    );
    assert!(
        audit_actions(&ctx, &saket.uuid)
            .await
            .contains(&"silicon.custodian.requested".to_string())
    );
    let changed_by: String =
        sqlx::query_scalar("select changed_by from handle_history where account_uuid = $1")
            .bind(&uuid)
            .fetch_one(&ctx.state.db)
            .await
            .expect("history");
    assert_eq!(
        changed_by, uuid,
        "the Silicon is the actor of its own creation"
    );
}

#[tokio::test]
async fn chosen_stk_is_normalized_and_never_echoed() {
    let ctx = TestContext::new().await;
    let saket = ctx.carbon().await;
    let id = silicon_id("chosen");
    let r = self_create(
        &ctx,
        json!({"id": id, "display_name": "Chosen", "custodian": saket.handle, "stk": "ABCDEF0123"}),
    )
    .await;
    assert_eq!(r.status, 201, "{}", r.json);
    assert_eq!(r.json["stk"], serde_json::Value::Null);
    assert_eq!(r.json["webhook_secret"], serde_json::Value::Null);
    // After acceptance the chosen STK (normalized with the stk- prefix) signs in.
    let request_id = r.json["request"]["id"].as_str().expect("id").to_string();
    let t = token(&ctx, &saket).await;
    assert_eq!(accept(&ctx, &t, &request_id).await.status, 204);
    let ok = login(&ctx, &id, "stk-abcdef0123").await;
    assert_eq!(ok.status, 200, "{}", ok.json);
}

#[tokio::test]
async fn custodian_by_email_without_an_account_gets_an_invitation_and_finds_it_after_signing_up() {
    let ctx = TestContext::new().await;
    let email = format!(
        "new-{}@example.test",
        accounts_core::test_support::rand_suffix()
    );
    let r = self_create(
        &ctx,
        json!({"id": silicon_id("invite"), "display_name": "Invite", "custodian": email.to_uppercase()}),
    )
    .await;
    assert_eq!(r.status, 201, "{}", r.json);
    // Masked, never revealing whether an account has the address.
    let masked = r.json["request"]["custodian"].as_str().expect("custodian");
    assert!(masked.contains("***@example.test"), "{masked}");
    let request_id = r.json["request"]["id"].as_str().expect("id").to_string();
    let (_, _, to_uuid, to_email, _) = request_row(&ctx, &request_id).await;
    assert_eq!(to_uuid, None);
    assert_eq!(to_email.as_deref(), Some(email.as_str()));
    let mail = ctx.outbox(&email).await;
    assert_eq!(mail.len(), 1);
    assert_eq!(mail[0].0, "custodian_invite");
    assert!(mail[0].1.contains("sign up"));

    // They sign up later with that email: the request is waiting for them.
    let later = ctx
        .carbon_with(CarbonSpec {
            email: Some(email.clone()),
            ..Default::default()
        })
        .await;
    let t = token(&ctx, &later).await;
    let list = call(&ctx, Req::get("/v1/me/custodian-requests").bearer(&t)).await;
    assert_eq!(list.status, 200, "{}", list.json);
    assert_eq!(list.json["items"][0]["id"], request_id);
    assert_eq!(list.json["items"][0]["to"]["email"], email);
    assert_eq!(accept(&ctx, &t, &request_id).await.status, 204);
    let silicon = account(&ctx, r.json["silicon"]["uuid"].as_str().expect("uuid")).await;
    assert_eq!(silicon.custodian_uuid.as_deref(), Some(later.uuid.as_str()));
    let (status, _, to_uuid, _, decided_by) = request_row(&ctx, &request_id).await;
    assert_eq!(status, "accepted");
    assert_eq!(to_uuid.as_deref(), Some(later.uuid.as_str()));
    assert_eq!(decided_by.as_deref(), Some(later.uuid.as_str()));
}

#[tokio::test]
async fn custodian_by_the_email_of_an_existing_carbon_gets_a_request_email() {
    let ctx = TestContext::new().await;
    let email = format!(
        "known-{}@example.test",
        accounts_core::test_support::rand_suffix()
    );
    let carbon = ctx
        .carbon_with(CarbonSpec {
            email: Some(email.clone()),
            ..Default::default()
        })
        .await;
    let r = self_create(
        &ctx,
        json!({"id": silicon_id("known"), "display_name": "Known", "custodian": email}),
    )
    .await;
    assert_eq!(r.status, 201, "{}", r.json);
    // Same response shape as for an unknown email: nothing reveals the account behind it.
    assert!(
        r.json["request"]["custodian"]
            .as_str()
            .expect("label")
            .contains("***@example.test")
    );
    let mail = ctx.outbox(&email).await;
    assert_eq!(mail[0].0, "custodian_request");
    let t = token(&ctx, &carbon).await;
    let list = call(&ctx, Req::get("/v1/me/custodian-requests").bearer(&t)).await;
    assert_eq!(list.json["items"].as_array().map(Vec::len), Some(1));
}

#[tokio::test]
async fn self_create_validation_errors_are_precise() {
    let ctx = TestContext::new().await;
    let saket = ctx.carbon().await;
    let cid = saket.handle.clone().expect("id");

    let r = self_create(
        &ctx,
        json!({"id": "si:x", "display_name": "X", "custodian": cid}),
    )
    .await;
    assert_eq!(r.status, 422);
    assert_eq!(r.error_code(), Some("invalid_id"));
    assert_eq!(r.json["error"]["details"]["reason"], "invalid");

    let r = self_create(
        &ctx,
        json!({"id": "si:admin", "display_name": "X", "custodian": cid}),
    )
    .await;
    assert_eq!(r.error_code(), Some("invalid_id"));
    assert_eq!(r.json["error"]["details"]["reason"], "reserved_word");

    let r = self_create(
        &ctx,
        json!({"id": "c:scout-x", "display_name": "X", "custodian": cid}),
    )
    .await;
    assert_eq!(r.error_code(), Some("invalid_id"));

    let r = self_create(
        &ctx,
        json!({
            "id": silicon_id("v"), "display_name": " ", "custodian": "si:someone",
            "timezone": "Mars/Olympus", "stk": "stk-xyz", "webhook_url": "ftp://x",
            "pfp_url": "http://insecure.example/x.png",
        }),
    )
    .await;
    assert_eq!(r.status, 422, "{}", r.json);
    assert_eq!(r.error_code(), Some("validation_failed"));
    let fields = &r.json["error"]["details"]["fields"];
    for f in [
        "display_name",
        "custodian",
        "timezone",
        "stk",
        "webhook_url",
        "pfp_url",
    ] {
        assert!(fields[f].is_string(), "missing problem for {f}: {fields}");
    }
    assert!(
        fields["custodian"]
            .as_str()
            .expect("msg")
            .contains("Carbon")
    );

    let r = self_create(
        &ctx,
        json!({"id": silicon_id("v"), "display_name": "X", "custodian": cid, "webhook": "https://x.example"}),
    )
    .await;
    assert_eq!(r.status, 422, "unknown fields are refused: {}", r.json);

    let r = self_create(&ctx, json!({"id": silicon_id("v"), "display_name": "X"})).await;
    assert_eq!(r.status, 422);
    assert!(r.json["error"]["details"]["fields"]["custodian"].is_string());

    let r = self_create(
        &ctx,
        json!({"id": silicon_id("v"), "display_name": "X", "custodian": "c:nobody-here"}),
    )
    .await;
    assert_eq!(r.status, 404);
    assert_eq!(r.error_code(), Some("custodian_not_found"));

    // An imported (unclaimed) Carbon can't be named by id until they finish signing up.
    let unclaimed = ctx
        .carbon_with(CarbonSpec {
            status: Some(AccountStatus::Unclaimed),
            ..Default::default()
        })
        .await;
    let r = self_create(
        &ctx,
        json!({"id": silicon_id("v"), "display_name": "X", "custodian": unclaimed.handle}),
    )
    .await;
    assert_eq!(r.error_code(), Some("custodian_not_found"));

    // Nothing was created by any of these.
    let n: i64 = sqlx::query_scalar("select count(*) from accounts where kind = 'silicon'")
        .fetch_one(&ctx.state.db)
        .await
        .expect("count");
    assert_eq!(n, 0);
}

#[tokio::test]
async fn taken_and_reserved_ids_are_refused_before_any_work() {
    let ctx = TestContext::new().await;
    let saket = ctx.carbon().await;
    let first = self_created(&ctx, saket.handle.as_deref().expect("id"), json!({})).await;
    let taken = first["silicon"]["id"].as_str().expect("id").to_string();
    let r = self_create(
        &ctx,
        json!({"id": taken, "display_name": "Again", "custodian": saket.handle}),
    )
    .await;
    assert_eq!(r.status, 409);
    assert_eq!(r.error_code(), Some("id_taken"));
    let suggestions = r.json["error"]["details"]["suggestions"]
        .as_array()
        .expect("suggestions");
    assert!(!suggestions.is_empty());
    assert!(suggestions[0].as_str().expect("s").starts_with("si:"));

    // A Silicon id that was changed is reserved for 10 days for its previous owner.
    let t = token(&ctx, &saket).await;
    let (silicon, _) = ctx.silicon(&saket.uuid).await;
    let old = silicon.handle.clone().expect("id");
    let renamed = call(
        &ctx,
        Req::post(&format!("/v1/me/silicons/{}/id", silicon.uuid))
            .bearer(&t)
            .json(json!({"id": silicon_id("renamed")})),
    )
    .await;
    assert_eq!(renamed.status, 200, "{}", renamed.json);
    let r = self_create(
        &ctx,
        json!({"id": old, "display_name": "Old", "custodian": saket.handle}),
    )
    .await;
    assert_eq!(r.status, 409);
    assert_eq!(r.error_code(), Some("id_reserved"));
    assert!(r.json["error"]["details"]["reserved_until"].is_string());
}

#[tokio::test]
async fn self_create_is_idempotent_and_never_stores_the_chosen_stk_in_clear() {
    let ctx = TestContext::new().await;
    let saket = ctx.carbon().await;
    let body = json!({"id": silicon_id("idem"), "display_name": "Idem", "custodian": saket.handle,
                      "stk": "stk-00112233aabb"});
    let req = || {
        Req::post("/v1/silicons")
            .header("idempotency-key", "self-create-1")
            .json(body.clone())
    };
    let first = call(&ctx, req()).await;
    assert_eq!(first.status, 201, "{}", first.json);
    let again = call(&ctx, req()).await;
    assert_eq!(again.status, 201);
    assert_eq!(
        again
            .headers
            .get("idempotent-replayed")
            .map(|v| v.to_str().unwrap_or("")),
        Some("true")
    );
    assert_eq!(again.json["request_token"], first.json["request_token"]);
    assert_eq!(again.json["silicon"]["uuid"], first.json["silicon"]["uuid"]);
    let n: i64 = sqlx::query_scalar("select count(*) from custodian_requests")
        .fetch_one(&ctx.state.db)
        .await
        .expect("count");
    assert_eq!(n, 1, "a retry never creates a second request");

    // The stored fingerprint is not the plain hash of the body (which would expose the STK).
    let stored: Vec<u8> =
        sqlx::query_scalar("select request_hash from idempotency_keys where key = 'self-create-1'")
            .fetch_one(&ctx.state.db)
            .await
            .expect("key");
    assert_ne!(
        stored,
        accounts_core::repo::idempotency::request_hash(&body)
    );

    // Same key, different body.
    let other = call(
        &ctx,
        Req::post("/v1/silicons")
            .header("idempotency-key", "self-create-1")
            .json(json!({"id": silicon_id("idem2"), "display_name": "Idem", "custodian": saket.handle})),
    )
    .await;
    assert_eq!(other.status, 409);
    assert_eq!(other.error_code(), Some("idempotency_key_reused"));
}

#[tokio::test]
async fn generated_secrets_are_replayed_but_never_stored_in_clear() {
    let ctx = TestContext::new().await;
    let saket = ctx.carbon().await;
    let body = json!({"id": silicon_id("sealed"), "display_name": "Sealed", "custodian": saket.handle,
                      "webhook_url": "http://127.0.0.1:8593/hooks/sealed"});
    let req = || {
        Req::post("/v1/silicons")
            .header("idempotency-key", "self-create-sealed")
            .json(body.clone())
    };
    let first = call(&ctx, req()).await;
    assert_eq!(first.status, 201, "{}", first.json);
    let secrets: Vec<String> = ["stk", "request_token", "webhook_secret"]
        .iter()
        .map(|k| first.json[k].as_str().expect("secret").to_string())
        .collect();

    // What the database keeps is sealed with the keyring: no secret, not even its prefix.
    let stored = stored_idempotent_response(&ctx, "self-create-sealed").await;
    assert!(stored.contains("\"sealed\""), "{stored}");
    for needle in secrets
        .iter()
        .map(String::as_str)
        .chain(["stk-", "sarq_", "whsec_"])
    {
        assert!(
            !stored.contains(needle),
            "{needle} is stored in clear: {stored}"
        );
    }

    // A retry within the replay window gets the very same secrets.
    let again = call(&ctx, req()).await;
    assert_eq!(again.status, 201, "{}", again.json);
    assert_eq!(
        again
            .headers
            .get("idempotent-replayed")
            .map(|v| v.to_str().unwrap_or("")),
        Some("true")
    );
    assert_eq!(again.json, first.json);

    // A stored result that can't be opened is never run again nor shown: precise 409.
    sqlx::query("update idempotency_keys set response = '{\"sealed\": \"AAAA\"}'::jsonb where key = 'self-create-sealed'")
        .execute(&ctx.state.db)
        .await
        .expect("tamper");
    let broken = call(&ctx, req()).await;
    assert_eq!(broken.status, 409, "{}", broken.json);
    assert_eq!(broken.error_code(), Some("idempotency_result_unavailable"));
    assert!(
        broken.json["error"]["hint"]
            .as_str()
            .expect("hint")
            .contains("new Idempotency-Key")
    );
    let n: i64 = sqlx::query_scalar("select count(*) from accounts where kind = 'silicon'")
        .fetch_one(&ctx.state.db)
        .await
        .expect("count");
    assert_eq!(n, 1, "the request never ran twice");
}

#[tokio::test]
async fn timezone_defaults_to_the_network_then_utc() {
    let ctx = TestContext::new().await;
    let saket = ctx.carbon().await;
    let r = call(
        &ctx,
        Req::post("/v1/silicons")
            .header("cloudfront-viewer-time-zone", "Europe/Berlin")
            .json(json!({"id": silicon_id("tz"), "display_name": "Tz", "custodian": saket.handle})),
    )
    .await;
    assert_eq!(r.status, 201, "{}", r.json);
    assert_eq!(r.json["silicon"]["timezone"], "Europe/Berlin");
    let r = self_create(
        &ctx,
        json!({"id": silicon_id("utc"), "display_name": "Utc", "custodian": saket.handle}),
    )
    .await;
    assert_eq!(r.json["silicon"]["timezone"], "UTC");
}

#[tokio::test]
async fn ten_self_creations_per_hour_per_ip_and_failures_do_not_count() {
    let mut settings = test_settings();
    settings.trust_forwarded_for = true;
    let ctx = TestContext::with_settings(settings).await;
    let saket = ctx.carbon().await;
    let from = |ip: &str, body: serde_json::Value| {
        Req::post("/v1/silicons")
            .header("x-forwarded-for", ip)
            .json(body)
    };
    // Failed attempts don't use up the limit.
    for _ in 0..3 {
        let r = call(
            &ctx,
            from(
                "203.0.113.9",
                json!({"id": silicon_id("f"), "display_name": "F", "custodian": "c:missing-one"}),
            ),
        )
        .await;
        assert_eq!(r.status, 404);
    }
    for i in 0..10 {
        let r = call(
            &ctx,
            from(
                "203.0.113.9",
                json!({"id": silicon_id("ok"), "display_name": "Ok", "custodian": saket.handle}),
            ),
        )
        .await;
        assert_eq!(r.status, 201, "creation {i}: {}", r.json);
    }
    let r = call(
        &ctx,
        from(
            "203.0.113.9",
            json!({"id": silicon_id("over"), "display_name": "Over", "custodian": saket.handle}),
        ),
    )
    .await;
    assert_eq!(r.status, 429, "{}", r.json);
    assert_eq!(r.error_code(), Some("rate_limited"));
    assert!(r.headers.get("retry-after").is_some());
    assert!(
        r.json["error"]["details"]["retry_after_seconds"]
            .as_u64()
            .expect("secs")
            > 0
    );
    // Another network is unaffected.
    let r = call(
        &ctx,
        from(
            "198.51.100.4",
            json!({"id": silicon_id("other"), "display_name": "Other", "custodian": saket.handle}),
        ),
    )
    .await;
    assert_eq!(r.status, 201, "{}", r.json);
}

/// A self-create from its own network (so the per-IP limits stay out of the way).
async fn self_create_from(ctx: &TestContext, ip: &str, custodian: &str) -> Resp {
    call(
        ctx,
        Req::post("/v1/silicons")
            .header("x-forwarded-for", ip)
            .json(json!({"id": silicon_id("q"), "display_name": "Q", "custodian": custodian})),
    )
    .await
}

#[tokio::test]
async fn at_most_twenty_pending_requests_per_named_custodian() {
    let mut settings = test_settings();
    settings.trust_forwarded_for = true;
    let ctx = TestContext::with_settings(settings).await;
    let email = format!(
        "busy-{}@example.test",
        accounts_core::test_support::rand_suffix()
    );
    let busy = ctx
        .carbon_with(CarbonSpec {
            email: Some(email.clone()),
            ..Default::default()
        })
        .await;
    let cid = busy.handle.clone().expect("id");
    for i in 0..20 {
        let r = self_create_from(&ctx, &format!("10.0.{i}.1"), &cid).await;
        assert_eq!(r.status, 201, "request {i}: {}", r.json);
    }
    let r = self_create_from(&ctx, "10.1.0.1", &cid).await;
    assert_eq!(r.status, 429, "{}", r.json);
    assert_eq!(r.error_code(), Some("rate_limited"));
    assert_eq!(r.json["error"]["details"]["pending_requests"], 20);
    assert_eq!(r.json["error"]["details"]["limit"], 20);
    assert!(
        r.json["error"]["message"]
            .as_str()
            .expect("message")
            .starts_with(&format!("{cid} already has 20"))
    );
    let retry = r.json["error"]["details"]["retry_after_seconds"]
        .as_u64()
        .expect("retry");
    assert!(
        retry > 13 * 24 * 3600,
        "until the oldest request expires: {retry}"
    );

    // The limit counts per name: naming the same Carbon by its email address is answered exactly
    // like naming an address nobody has, so it never reveals that the address belongs to that
    // c:id.
    let by_email = self_create_from(&ctx, "10.2.0.1", &email).await;
    assert_eq!(by_email.status, 201, "{}", by_email.json);
    let unrelated = self_create_from(&ctx, "10.2.0.2", "nobody-has-this@example.test").await;
    assert_eq!(unrelated.status, 201, "{}", unrelated.json);

    // An email address is capped the same way.
    for i in 1..20 {
        let r = self_create_from(&ctx, &format!("10.3.{i}.1"), &email).await;
        assert_eq!(r.status, 201, "email request {i}: {}", r.json);
    }
    let r = self_create_from(&ctx, "10.4.0.1", &email.to_uppercase()).await;
    assert_eq!(r.status, 429, "{}", r.json);
    assert_eq!(r.json["error"]["details"]["pending_requests"], 20);
    assert!(
        r.json["error"]["message"]
            .as_str()
            .expect("message")
            .starts_with(&format!("{email} already has 20"))
    );

    // Answering one frees a slot.
    let t = token(&ctx, &busy).await;
    let waiting: Vec<String> = sqlx::query_scalar(
        "select id::text from custodian_requests where to_uuid = $1 and status = 'pending' order by id limit 1",
    )
    .bind(&busy.uuid)
    .fetch_all(&ctx.state.db)
    .await
    .expect("requests");
    assert_eq!(decline(&ctx, &t, &waiting[0]).await.status, 204);
    let r = self_create_from(&ctx, "10.1.0.2", &cid).await;
    assert_eq!(r.status, 201, "{}", r.json);
}

#[tokio::test]
async fn failed_self_creation_attempts_are_limited_per_network() {
    let mut settings = test_settings();
    settings.trust_forwarded_for = true;
    let ctx = TestContext::with_settings(settings).await;
    let saket = ctx.carbon().await;
    let from = |ip: &str, body: serde_json::Value| {
        Req::post("/v1/silicons")
            .header("x-forwarded-for", ip)
            .json(body)
    };
    // Input errors are refused before any database work and are not counted.
    for _ in 0..5 {
        let r = call(
            &ctx,
            from(
                "203.0.113.7",
                json!({"id": "si:x", "display_name": "X", "custodian": saket.handle}),
            ),
        )
        .await;
        assert_eq!(r.status, 422);
    }
    // Every attempt that reaches the database counts, failed ones included.
    let limit = accounts_silicons::SELF_CREATE_ATTEMPTS_PER_IP.max;
    assert_eq!(limit, 60);
    for i in 0..limit {
        let r = call(
            &ctx,
            from(
                "203.0.113.7",
                json!({"id": silicon_id("p"), "display_name": "P", "custodian": format!("c:nobody-{i}")}),
            ),
        )
        .await;
        assert_eq!(r.status, 404, "attempt {i}: {}", r.json);
    }
    let r = call(
        &ctx,
        from(
            "203.0.113.7",
            json!({"id": silicon_id("p"), "display_name": "P", "custodian": "c:nobody-else"}),
        ),
    )
    .await;
    assert_eq!(r.status, 429, "{}", r.json);
    assert_eq!(r.error_code(), Some("rate_limited"));
    assert!(r.headers.get("retry-after").is_some());
    let message = r.json["error"]["message"].as_str().expect("message");
    assert!(
        message.contains("Silicon self-creation attempts from this network")
            && message.contains("60 per hour"),
        "{message}"
    );
    assert!(
        r.json["error"]["hint"]
            .as_str()
            .expect("hint")
            .contains("failed ones included")
    );
    // A valid request from that network waits too; another network doesn't.
    let r = call(
        &ctx,
        from(
            "203.0.113.7",
            json!({"id": silicon_id("ok"), "display_name": "Ok", "custodian": saket.handle}),
        ),
    )
    .await;
    assert_eq!(r.status, 429, "{}", r.json);
    let r = call(
        &ctx,
        from(
            "198.51.100.8",
            json!({"id": silicon_id("ok"), "display_name": "Ok", "custodian": saket.handle}),
        ),
    )
    .await;
    assert_eq!(r.status, 201, "{}", r.json);
}

#[tokio::test]
async fn custodian_emails_never_carry_the_self_chosen_display_name() {
    let ctx = TestContext::new().await;
    let saket = ctx
        .carbon_with(CarbonSpec {
            email: Some(format!(
                "named-{}@example.test",
                accounts_core::test_support::rand_suffix()
            )),
            ..Default::default()
        })
        .await;
    let primary: String =
        sqlx::query_scalar("select email from account_emails where account_uuid = $1")
            .bind(&saket.uuid)
            .fetch_one(&ctx.state.db)
            .await
            .expect("email");
    let stranger = format!(
        "stranger-{}@example.test",
        accounts_core::test_support::rand_suffix()
    );
    let lure = "Claim your prize at https://evil.example/claim";
    let by_id = self_created(
        &ctx,
        saket.handle.as_deref().expect("id"),
        json!({"display_name": lure}),
    )
    .await;
    let by_email = self_created(&ctx, &stranger, json!({"display_name": lure})).await;
    for (to, created, purpose) in [
        (&primary, &by_id, "custodian_request"),
        (&stranger, &by_email, "custodian_invite"),
    ] {
        let (got_purpose, subject, text, html): (String, String, String, String) = sqlx::query_as(
            "select purpose, subject, text_body, html_body from outbound_messages where to_address = $1",
        )
        .bind(to)
        .fetch_one(&ctx.state.db)
        .await
        .expect("message");
        assert_eq!(got_purpose, purpose);
        let silicon_id = created["silicon"]["id"].as_str().expect("id");
        for part in [&subject, &text, &html] {
            assert!(!part.contains("evil.example"), "{part}");
            assert!(!part.contains("Claim your prize"), "{part}");
        }
        assert!(
            subject.contains(silicon_id) && text.contains(silicon_id) && html.contains(silicon_id)
        );
    }
    // The display name itself is kept: it is the Silicon's, shown on the account site.
    assert_eq!(by_id["silicon"]["display_name"], lure);
}
