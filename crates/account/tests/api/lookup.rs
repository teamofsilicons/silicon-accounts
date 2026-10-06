//! `GET /v1/ids/available`, `GET /v1/accounts/{uuid}`, `GET /v1/accounts/by-id/{id}`.

use accounts_core::ids::AccountId;
use accounts_core::models::AccountKind;
use accounts_core::repo::accounts;
use accounts_core::test_support::{CarbonSpec, Req, TestContext, rand_suffix};
use serde_json::Value;

use crate::common::*;

fn available(id: &str) -> Req {
    Req::get(&format!("/v1/ids/available?id={}", id.replace(':', "%3A")))
}

#[tokio::test]
async fn id_availability_reports_each_reason() {
    let ctx = TestContext::new().await;
    let handle = format!("taken-{}", rand_suffix());
    let owner = ctx
        .carbon_with(CarbonSpec {
            handle: Some(handle.clone()),
            ..Default::default()
        })
        .await;

    let r = call(&ctx, available(&format!("c:{handle}"))).await;
    assert_status(&r, 200);
    assert_eq!(r.json["available"], false);
    assert_eq!(r.json["reason"], "taken");
    assert_eq!(r.json["id"], format!("c:{handle}"));
    assert_eq!(r.json["reclaimable"], false);
    let suggestions: Vec<String> = r.json["suggestions"]
        .as_array()
        .expect("suggestions")
        .iter()
        .filter_map(|v| v.as_str().map(str::to_string))
        .collect();
    assert_eq!(suggestions.len(), 3, "{}", r.json);
    for s in &suggestions {
        assert!(s.starts_with(&format!("c:{handle}")), "{s}");
        let check = call(&ctx, available(s)).await;
        assert_eq!(check.json["available"], true, "suggested ids are free: {s}");
    }

    // Ids are case-insensitive; the Silicon id with the same handle is a different id.
    let r = call(&ctx, available(&format!("C:{}", handle.to_uppercase()))).await;
    assert_eq!(r.json["reason"], "taken");
    let r = call(&ctx, available(&format!("si:{handle}"))).await;
    assert_eq!(r.json["available"], true);
    assert_eq!(r.json["reason"], Value::Null);
    assert_eq!(r.json["suggestions"], serde_json::json!([]));
    // An invalid handle still gets valid ids built from it; no prefix means no kind to suggest.
    let r = call(&ctx, available("c:John%20Smith!")).await;
    assert_eq!(r.json["reason"], "invalid");
    assert!(
        r.json["suggestions"]
            .as_array()
            .is_some_and(|s| s.iter().any(|v| v == "c:john-smith")),
        "{}",
        r.json
    );
    let r = call(&ctx, available("saket")).await;
    assert_eq!(r.json["suggestions"], serde_json::json!([]));

    let r = call(&ctx, available("c:admin")).await;
    assert_eq!(
        (r.json["available"].clone(), r.json["reason"].clone()),
        (Value::Bool(false), Value::from("reserved_word"))
    );

    for bad in ["saket", "c:ab", "c:has%20space"] {
        let r = call(&ctx, available(bad)).await;
        assert_status(&r, 200);
        assert_eq!(r.json["reason"], "invalid", "{bad}: {}", r.json);
        assert!(r.json["message"].as_str().is_some_and(|m| !m.is_empty()));
    }
    let long = format!("c:{}", "x".repeat(500));
    let r = call(&ctx, available(&long)).await;
    assert_eq!(r.json["reason"], "invalid");
    assert!(
        r.json["message"].as_str().is_some_and(|m| m.len() < 200),
        "long inputs are not echoed back: {}",
        r.json
    );

    let r = call(&ctx, Req::get("/v1/ids/available")).await;
    assert_error(&r, 400, "invalid_query");

    // An old id is reserved for its previous owner, who sees it as reclaimable.
    let mut conn = ctx.conn().await;
    let new_id =
        AccountId::new(AccountKind::Carbon, &format!("moved-{}", rand_suffix())).expect("id");
    accounts::change_id(&mut conn, &owner.uuid, &new_id, &owner.uuid)
        .await
        .expect("change id");
    drop(conn);
    let r = call(&ctx, available(&format!("c:{handle}"))).await;
    assert_eq!(r.json["reason"], "reserved");
    assert_eq!(r.json["available"], false);
    let owner_token = token(&ctx, &owner).await;
    let r = call(&ctx, available(&format!("c:{handle}")).bearer(&owner_token)).await;
    assert_eq!(r.json["available"], true, "{}", r.json);
    assert_eq!(r.json["reclaimable"], true);
    let other = ctx.carbon().await;
    let cookie = ctx.browser_session(&other).await;
    let r = call(
        &ctx,
        available(&format!("c:{handle}")).session(&ctx.state.settings, &cookie),
    )
    .await;
    assert_eq!(r.json["reason"], "reserved");

    // Explicit credentials that don't work are an error, not anonymous access.
    let r = call(&ctx, available("c:whatever").bearer("eyJnot.a.jwt")).await;
    assert_status(&r, 401);
}

#[tokio::test]
async fn a_custodian_checks_ids_for_its_silicon() {
    let ctx = TestContext::new().await;
    let custodian = ctx.carbon().await;
    let (silicon, _) = ctx.silicon(&custodian.uuid).await;
    let old_id = silicon.handle.clone().expect("si:id");
    let mut conn = ctx.conn().await;
    let new_id =
        AccountId::new(AccountKind::Silicon, &format!("renamed-{}", rand_suffix())).expect("id");
    accounts::change_id(&mut conn, &silicon.uuid, &new_id, &custodian.uuid)
        .await
        .expect("change id");
    drop(conn);
    let tok = token(&ctx, &custodian).await;
    let for_silicon = |id: &str, target: &str| {
        Req::get(&format!(
            "/v1/ids/available?id={}&for={}",
            id.replace(':', "%3A"),
            target.replace(':', "%3A")
        ))
    };

    // As the custodian itself the old id is someone else's reservation…
    let r = call(&ctx, available(&old_id).bearer(&tok)).await;
    assert_eq!(r.json["reason"], "reserved", "{}", r.json);
    // …but for the Silicon (by uuid or by its current si:id) it can be taken back.
    for target in [silicon.uuid.clone(), new_id.to_string()] {
        let r = call(&ctx, for_silicon(&old_id, &target).bearer(&tok)).await;
        assert_status(&r, 200);
        assert_eq!(r.json["available"], true, "{target}: {}", r.json);
        assert_eq!(r.json["reclaimable"], true);
        let message = r.json["message"].as_str().expect("message");
        assert!(
            message.contains(&format!("was an id of {new_id}"))
                && message.contains("take it back for it"),
            "{message}"
        );
    }
    // Its current id is its own.
    let r = call(
        &ctx,
        for_silicon(&new_id.to_string(), &silicon.uuid).bearer(&tok),
    )
    .await;
    assert_eq!(r.json["reason"], "taken");
    assert_eq!(
        r.json["message"],
        format!("{new_id} is already the id of {new_id}.")
    );
    // The caller's own uuid is allowed (same as leaving for= out).
    let r = call(&ctx, for_silicon(&old_id, &custodian.uuid).bearer(&tok)).await;
    assert_eq!(r.json["reason"], "reserved");

    // Another Carbon can't ask for someone else's Silicon, and nobody can without a session.
    let stranger = ctx.carbon().await;
    let r = call(
        &ctx,
        for_silicon(&old_id, &silicon.uuid).bearer(&token(&ctx, &stranger).await),
    )
    .await;
    assert_error(&r, 404, "silicon_not_found");
    let r = call(&ctx, for_silicon(&old_id, &silicon.uuid)).await;
    assert_error(&r, 401, "unauthenticated");
    // A blank for= is the same as leaving it out.
    let r = call(
        &ctx,
        Req::get(&format!(
            "/v1/ids/available?id={}&for=",
            old_id.replace(':', "%3A")
        )),
    )
    .await;
    assert_eq!(r.json["reason"], "reserved");
}

#[tokio::test]
async fn id_availability_is_rate_limited_per_ip() {
    let ctx = TestContext::new().await;
    ctx.exec(
        "insert into rate_limits (bucket, window_started_at, count) values ('ids_available:ip:unknown', now(), 120)",
    )
    .await;
    let r = call(&ctx, available("c:someone")).await;
    assert_error(&r, 429, "rate_limited");
    assert!(r.headers.get("retry-after").is_some());
    assert!(
        r.json["error"]["details"]["retry_after_seconds"]
            .as_u64()
            .is_some()
    );
}

#[tokio::test]
async fn lookup_by_uuid_with_app_or_session() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let (silicon, _) = ctx.silicon(&carbon.uuid).await;
    let (app, secret) = ctx.app("lookup").await;
    let path = format!("/v1/accounts/{}", carbon.uuid);

    let r = call(&ctx, Req::get(&path).basic(&app.app_id, &secret)).await;
    assert_status(&r, 200);
    assert_eq!(r.json["uuid"], carbon.uuid);
    assert_eq!(r.json["kind"], "carbon");
    assert_eq!(r.json["id"], carbon.handle.clone().expect("id"));
    assert_eq!(r.json["status"], "active");
    assert!(r.json["pfp_url"].as_str().is_some());
    assert!(
        r.json.get("custodian").is_none(),
        "Carbons have no custodian"
    );
    assert!(
        r.json.get("email").is_none(),
        "lookups never expose contacts"
    );

    let r = call(
        &ctx,
        Req::get(&format!("/v1/accounts/{}", silicon.uuid)).basic(&app.app_id, &secret),
    )
    .await;
    assert_status(&r, 200);
    assert_eq!(r.json["kind"], "silicon");
    assert_eq!(r.json["custodian"]["uuid"], carbon.uuid);
    assert_eq!(
        r.json["custodian"]["id"],
        carbon.handle.clone().expect("id")
    );

    let pending = pending_silicon(&ctx).await;
    let r = call(
        &ctx,
        Req::get(&format!("/v1/accounts/{}", pending.uuid)).basic(&app.app_id, &secret),
    )
    .await;
    assert_eq!(r.json["status"], "pending_custodian");
    assert!(
        r.json
            .as_object()
            .expect("object")
            .contains_key("custodian")
    );
    assert_eq!(r.json["custodian"], Value::Null);

    let tok = token(&ctx, &silicon).await;
    let r = call(&ctx, Req::get(&path).bearer(&tok)).await;
    assert_status(&r, 200);
    let cookie = ctx.browser_session(&carbon).await;
    let r = call(&ctx, Req::get(&path).session(&ctx.state.settings, &cookie)).await;
    assert_status(&r, 200);

    let r = call(&ctx, Req::get(&path)).await;
    assert_error(&r, 401, "unauthenticated");
    let r = call(&ctx, Req::get(&path).basic(&app.app_id, "sa_app_wrong")).await;
    assert_error(&r, 401, "invalid_app_credentials");
    // An app's own access token is not a first-party session.
    let app_token = ctx
        .tokens_for(
            &carbon,
            &app.app_id,
            &[accounts_core::models::Scope::Profile],
        )
        .await
        .access_token;
    let r = call(&ctx, Req::get(&path).bearer(&app_token)).await;
    assert_error(&r, 401, "token_wrong_audience");

    let r = call(
        &ctx,
        Req::get("/v1/accounts/zzzzzzzz").basic(&app.app_id, &secret),
    )
    .await;
    assert_error(&r, 404, "account_not_found");
    let r = call(
        &ctx,
        Req::get("/v1/accounts/c:saket").basic(&app.app_id, &secret),
    )
    .await;
    assert_error(&r, 400, "invalid_uuid");
    assert!(
        r.json["error"]["hint"]
            .as_str()
            .is_some_and(|h| h.contains("/v1/accounts/by-id/c:saket"))
    );
    let r = call(
        &ctx,
        Req::get("/v1/accounts/no*pe").basic(&app.app_id, &secret),
    )
    .await;
    assert_error(&r, 400, "invalid_uuid");

    let gone = ctx.carbon().await;
    let mut conn = ctx.conn().await;
    accounts::delete_account(&mut conn, &ctx.state.settings, &gone.uuid, &gone.uuid, true)
        .await
        .expect("delete");
    drop(conn);
    let r = call(
        &ctx,
        Req::get(&format!("/v1/accounts/{}", gone.uuid)).basic(&app.app_id, &secret),
    )
    .await;
    assert_error(&r, 404, "account_deleted");
}

#[tokio::test]
async fn lookup_by_current_id_only() {
    let ctx = TestContext::new().await;
    let handle = format!("byid-{}", rand_suffix());
    let carbon = ctx
        .carbon_with(CarbonSpec {
            handle: Some(handle.clone()),
            ..Default::default()
        })
        .await;
    let (app, secret) = ctx.app("byid").await;

    for path in [
        format!("/v1/accounts/by-id/c:{handle}"),
        format!("/v1/accounts/by-id/c%3A{handle}"),
        format!("/v1/accounts/by-id/C:{}", handle.to_uppercase()),
    ] {
        let r = call(&ctx, Req::get(&path).basic(&app.app_id, &secret)).await;
        assert_status(&r, 200);
        assert_eq!(r.json["uuid"], carbon.uuid, "{path}");
    }

    let r = call(
        &ctx,
        Req::get("/v1/accounts/by-id/c:nobody-has-this").basic(&app.app_id, &secret),
    )
    .await;
    assert_error(&r, 404, "account_not_found");
    let r = call(
        &ctx,
        Req::get(&format!("/v1/accounts/by-id/{handle}")).basic(&app.app_id, &secret),
    )
    .await;
    assert_error(&r, 400, "invalid_id");

    // After an id change the old id no longer resolves, and the hint says why.
    let mut conn = ctx.conn().await;
    let new_id =
        AccountId::new(AccountKind::Carbon, &format!("new-{}", rand_suffix())).expect("id");
    accounts::change_id(&mut conn, &carbon.uuid, &new_id, &carbon.uuid)
        .await
        .expect("change");
    drop(conn);
    let r = call(
        &ctx,
        Req::get(&format!("/v1/accounts/by-id/c:{handle}")).basic(&app.app_id, &secret),
    )
    .await;
    assert_error(&r, 404, "account_not_found");
    assert!(
        r.json["error"]["hint"]
            .as_str()
            .is_some_and(|h| h.contains("reserved")),
        "{}",
        r.json
    );
    let r = call(
        &ctx,
        Req::get(&format!("/v1/accounts/by-id/{new_id}")).basic(&app.app_id, &secret),
    )
    .await;
    assert_eq!(r.json["uuid"], carbon.uuid);
}

#[tokio::test]
async fn lookups_are_rate_limited_per_caller() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let other = ctx.carbon().await;
    let (app, secret) = ctx.app("walker").await;
    let by_uuid = format!("/v1/accounts/{}", other.uuid);
    let by_id = format!("/v1/accounts/by-id/{}", other.handle.clone().expect("id"));
    let tok = token(&ctx, &carbon).await;

    // Each lookup counts for its caller.
    assert_status(&call(&ctx, Req::get(&by_uuid).bearer(&tok)).await, 200);
    assert_status(
        &call(&ctx, Req::get(&by_id).basic(&app.app_id, &secret)).await,
        200,
    );
    let count = |bucket: String| {
        let ctx = &ctx;
        async move {
            sqlx::query_scalar::<_, i32>("select count from rate_limits where bucket = $1")
                .bind(bucket)
                .fetch_one(&ctx.state.db)
                .await
                .expect("bucket")
        }
    };
    assert_eq!(
        count(format!("account_lookup:account:{}", carbon.uuid)).await,
        1
    );
    assert_eq!(count(format!("account_lookup:app:{}", app.app_id)).await, 1);

    // At 600 in the current minute, both routes answer 429 for that caller only.
    ctx.exec(&format!(
        "update rate_limits set count = 600 where bucket in ('account_lookup:account:{}', 'account_lookup:app:{}')",
        carbon.uuid, app.app_id
    ))
    .await;
    for req in [
        Req::get(&by_uuid).bearer(&tok),
        Req::get(&by_id).bearer(&tok),
        Req::get(&by_uuid).basic(&app.app_id, &secret),
        Req::get(&by_id).basic(&app.app_id, &secret),
    ] {
        let r = call(&ctx, req).await;
        assert_error(&r, 429, "rate_limited");
        assert!(r.headers.get("retry-after").is_some());
        assert!(
            r.json["error"]["message"]
                .as_str()
                .is_some_and(|m| m.contains("account lookups") && m.contains("600 per minute")),
            "{}",
            r.json
        );
    }
    let r = call(
        &ctx,
        Req::get(&format!("/v1/accounts/{}", carbon.uuid)).bearer(&token(&ctx, &other).await),
    )
    .await;
    assert_status(&r, 200);
}
