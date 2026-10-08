//! `GET /v1/apps/{app_id}/proofs` and `GET /v1/me/proofs`: shapes, statuses (stored and
//! derived), filters, pagination, access rules. Plus the token sweep.

use accounts_core::test_support::Req;
use serde_json::{Value, json};

use crate::common::{World, proof_id, refresh_token};

fn items(v: &Value) -> Vec<Value> {
    v["items"].as_array().cloned().unwrap_or_default()
}

fn find<'a>(items: &'a [Value], id: &str) -> &'a Value {
    items
        .iter()
        .find(|i| i["proof_id"] == id)
        .unwrap_or_else(|| panic!("{id} not listed"))
}

#[tokio::test]
async fn an_app_lists_what_it_issued() {
    let w = World::new().await;
    let user_verification = w.issue_user_verification().await;
    let app_verification = w
        .app_verification_as(
            &w.dm,
            &w.dm_secret,
            json!({"receiving_app": w.other.app_id, "scopes": ["ping"], "access_ttl_seconds": 120}),
        )
        .await
        .json;
    // Another app's proof never shows up.
    w.app_verification_as(
        &w.other,
        &w.other_secret,
        json!({"receiving_app": w.briefcase.app_id}),
    )
    .await;

    let path = format!("/v1/apps/{}/proofs", w.dm.app_id);
    let r = w
        .call(Req::get(&path).basic(&w.dm.app_id, &w.dm_secret))
        .await;
    assert_eq!(r.status, 200, "{}", r.json);
    let list = items(&r.json);
    assert_eq!(list.len(), 2);
    assert_eq!(r.json["next_cursor"], Value::Null);
    assert_eq!(
        list[0]["proof_id"], app_verification["proof_id"],
        "newest first"
    );

    let o = find(&list, &proof_id(&user_verification));
    assert_eq!(o["kind"], "user_verification");
    assert_eq!(o["receiving_app"], w.briefcase.app_id);
    assert!(
        o.get("audiences").is_none(),
        "listings name the one receiving app"
    );
    assert_eq!(o["user"]["uuid"], w.carbon.uuid);
    assert_eq!(o["user"]["id"], w.carbon.id());
    assert_eq!(o["user"]["kind"], "carbon");
    assert_eq!(o["user"]["status"], "active");
    assert!(o["user"]["display_name"].is_string() && o["user"]["pfp_url"].is_string());
    assert_eq!(o["scopes"], json!(["files.write"]));
    assert_eq!(o["status"], "active");
    assert_eq!(o["revoked_at"], Value::Null);
    assert_eq!(o["revoke_reason"], Value::Null);
    assert_eq!(o["last_refreshed_at"], Value::Null);
    assert_eq!(o["expires_at"], user_verification["refresh_expires_at"]);
    assert_eq!(o["token_expires_at"], user_verification["expires_at"]);
    assert_eq!(o["access_ttl_seconds"], 1800);
    assert!(o["created_at"].as_str().is_some_and(|s| s.ends_with('Z')));

    let a = find(&list, &proof_id(&app_verification));
    assert_eq!(a["kind"], "app_verification");
    assert_eq!(a["user"], Value::Null);
    assert_eq!(a["receiving_app"], w.other.app_id);
    assert!(a.get("audiences").is_none());
    assert_eq!(a["access_ttl_seconds"], 120);

    // The published Rust package parses the page.
    for item in &list {
        let _: silicon_accounts_client::AppProof =
            serde_json::from_value(item.clone()).expect("client parses AppProof");
    }

    // Filters.
    let r = w
        .call(Req::get(&format!("{path}?kind=app_verification")).basic(&w.dm.app_id, &w.dm_secret))
        .await;
    assert_eq!(items(&r.json).len(), 1);
    assert_eq!(items(&r.json)[0]["kind"], "app_verification");
    w.revoke_as(
        &w.dm,
        &w.dm_secret,
        json!({"proof_id": proof_id(&user_verification)}),
    )
    .await;
    let r = w
        .call(Req::get(&format!("{path}?status=revoked")).basic(&w.dm.app_id, &w.dm_secret))
        .await;
    let revoked = items(&r.json);
    assert_eq!(revoked.len(), 1);
    assert_eq!(revoked[0]["proof_id"], user_verification["proof_id"]);
    assert_eq!(revoked[0]["revoke_reason"], "revoked_by_app");
    assert!(revoked[0]["revoked_at"].is_string());
    let r = w
        .call(
            Req::get(&format!("{path}?status=active&kind=user_verification"))
                .basic(&w.dm.app_id, &w.dm_secret),
        )
        .await;
    assert!(items(&r.json).is_empty());

    // Bad filters are named.
    let r = w
        .call(Req::get(&format!("{path}?kind=both")).basic(&w.dm.app_id, &w.dm_secret))
        .await;
    assert_eq!(r.status, 400);
    assert_eq!(r.error_code(), Some("invalid_query"));
    assert!(
        r.json["error"]["message"]
            .as_str()
            .is_some_and(|m| m.contains("kind"))
    );
    let r = w
        .call(Req::get(&format!("{path}?staus=active")).basic(&w.dm.app_id, &w.dm_secret))
        .await;
    assert_eq!(
        r.status, 400,
        "typos in parameter names are refused: {}",
        r.json
    );
    let r = w
        .call(Req::get(&format!("{path}?cursor=garbage")).basic(&w.dm.app_id, &w.dm_secret))
        .await;
    assert_eq!(r.status, 400);
    assert_eq!(r.error_code(), Some("invalid_cursor"));
}

#[tokio::test]
async fn app_listing_access_rules() {
    let w = World::new().await;
    let owner = w.ctx.carbon().await;
    let (app, secret) = w.ctx.app_owned("commit", Some(&owner.uuid)).await;
    w.app_verification_as(&app, &secret, json!({"receiving_app": w.briefcase.app_id}))
        .await;
    let path = format!("/v1/apps/{}/proofs", app.app_id);

    let cookie = w.ctx.browser_session(&owner).await;
    let r = w
        .call(Req::get(&path).session(&w.ctx.state.settings, &cookie))
        .await;
    assert_eq!(r.status, 200);
    assert_eq!(items(&r.json).len(), 1);

    let r = w
        .call(Req::get(&path).basic(&w.dm.app_id, &w.dm_secret))
        .await;
    assert_eq!(r.status, 403);
    assert_eq!(r.error_code(), Some("app_mismatch"));
    let stranger = w.ctx.carbon().await;
    let fp = w.ctx.first_party_tokens(&stranger).await;
    let r = w.call(Req::get(&path).bearer(&fp.access_token)).await;
    assert_eq!(r.status, 403);
    assert_eq!(r.error_code(), Some("not_app_owner"));
    let r = w.call(Req::get(&path)).await;
    assert_eq!(r.status, 401);
}

#[tokio::test]
async fn listings_paginate_with_a_stable_cursor() {
    let w = World::new().await;
    let mut issued = Vec::new();
    for _ in 0..5 {
        issued.push(proof_id(&w.issue_user_verification().await));
    }
    issued.reverse(); // newest first
    let base = format!("/v1/apps/{}/proofs?limit=2", w.dm.app_id);
    let mut seen = Vec::new();
    let mut cursor: Option<String> = None;
    for page in 0..3 {
        let path = match &cursor {
            Some(c) => format!("{base}&cursor={c}"),
            None => base.clone(),
        };
        let r = w
            .call(Req::get(&path).basic(&w.dm.app_id, &w.dm_secret))
            .await;
        assert_eq!(r.status, 200, "{}", r.json);
        let page_items = items(&r.json);
        assert_eq!(page_items.len(), if page < 2 { 2 } else { 1 });
        seen.extend(
            page_items
                .iter()
                .map(|i| i["proof_id"].as_str().unwrap_or("").to_string()),
        );
        cursor = r.json["next_cursor"].as_str().map(str::to_string);
    }
    assert_eq!(cursor, None);
    assert_eq!(seen, issued);

    // The status-filtered path paginates the same way (one revoked proof is skipped).
    w.revoke_as(&w.dm, &w.dm_secret, json!({"proof_id": issued[2]}))
        .await;
    let expected: Vec<String> = issued
        .iter()
        .filter(|id| **id != issued[2])
        .cloned()
        .collect();
    let mut seen = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let path = match &cursor {
            Some(c) => format!("{base}&status=active&cursor={c}"),
            None => format!("{base}&status=active"),
        };
        let r = w
            .call(Req::get(&path).basic(&w.dm.app_id, &w.dm_secret))
            .await;
        assert_eq!(r.status, 200, "{}", r.json);
        seen.extend(
            items(&r.json)
                .iter()
                .map(|i| i["proof_id"].as_str().unwrap_or("").to_string()),
        );
        cursor = r.json["next_cursor"].as_str().map(str::to_string);
        if cursor.is_none() {
            break;
        }
    }
    assert_eq!(seen, expected);
    w.ctx
        .exec(&format!(
            "update proof_families set revoked_at = null, revoked_by = null, revoke_reason = null where id = '{}'",
            issued[2]
        ))
        .await;

    // Same for /v1/me/proofs.
    let fp = w.ctx.first_party_tokens(&w.carbon).await;
    let mut seen = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let path = match &cursor {
            Some(c) => format!("/v1/me/proofs?limit=3&cursor={c}"),
            None => "/v1/me/proofs?limit=3".to_string(),
        };
        let r = w.call(Req::get(&path).bearer(&fp.access_token)).await;
        assert_eq!(r.status, 200, "{}", r.json);
        seen.extend(
            items(&r.json)
                .iter()
                .map(|i| i["proof_id"].as_str().unwrap_or("").to_string()),
        );
        cursor = r.json["next_cursor"].as_str().map(str::to_string);
        if cursor.is_none() {
            break;
        }
    }
    assert_eq!(seen, issued);
}

#[tokio::test]
async fn an_account_sees_its_user_verification_proofs_with_honest_statuses() {
    let w = World::new().await;
    let active = w.issue_user_verification().await;
    let revoked = w.issue_user_verification().await;
    let expired = w.issue_user_verification().await;
    // An app verification proof and another account's User verification proof never show up.
    w.app_verification_as(
        &w.dm,
        &w.dm_secret,
        json!({"receiving_app": w.briefcase.app_id}),
    )
    .await;
    let other_carbon = w.ctx.carbon().await;
    w.ctx
        .membership(
            &w.dm.app_id,
            &other_carbon.uuid,
            &[accounts_core::models::Scope::Profile],
        )
        .await;
    let t = w
        .ctx
        .tokens_for(
            &other_carbon,
            &w.dm.app_id,
            &[accounts_core::models::Scope::Profile],
        )
        .await;
    let r = w
        .user_verification(
            json!({"subject_token": t.access_token, "receiving_app": w.briefcase.app_id}),
        )
        .await;
    assert_eq!(r.status, 201);

    w.revoke_as(&w.dm, &w.dm_secret, json!({"proof_id": proof_id(&revoked)}))
        .await;
    w.ctx
        .exec(&format!(
            "update proof_families set expires_at = now() - interval '1 second' where id = '{}'",
            proof_id(&expired)
        ))
        .await;
    let refreshed = w.refresh(&refresh_token(&active)).await;
    assert_eq!(refreshed.status, 200);

    let cookie = w.ctx.browser_session(&w.carbon).await;
    let r = w
        .call(Req::get("/v1/me/proofs").session(&w.ctx.state.settings, &cookie))
        .await;
    assert_eq!(r.status, 200, "{}", r.json);
    let list = items(&r.json);
    assert_eq!(list.len(), 3, "{}", r.json);
    let a = find(&list, &proof_id(&active));
    assert_eq!(a["status"], "active");
    assert_eq!(a["issuing_app"]["app_id"], w.dm.app_id);
    assert_eq!(a["issuing_app"]["name"], w.dm.name);
    assert_eq!(a["receiving_app"]["app_id"], w.briefcase.app_id);
    assert_eq!(a["receiving_app"]["name"], w.briefcase.name);
    assert_eq!(a["scopes"], json!(["files.write"]));
    assert!(a["last_refreshed_at"].is_string());
    assert_eq!(a["token_expires_at"], refreshed.json["expires_at"]);
    assert_eq!(a["expires_at"], active["refresh_expires_at"]);
    assert_eq!(find(&list, &proof_id(&revoked))["status"], "revoked");
    assert_eq!(
        find(&list, &proof_id(&revoked))["revoke_reason"],
        "revoked_by_app"
    );
    assert_eq!(find(&list, &proof_id(&expired))["status"], "expired");
    for item in &list {
        let parsed: silicon_accounts_client::MyProof =
            serde_json::from_value(item.clone()).expect("client parses MyProof");
        assert!(["active", "revoked", "expired"].contains(&parsed.status.as_str()));
    }

    // Status filter.
    let r = w
        .call(Req::get("/v1/me/proofs?status=active").session(&w.ctx.state.settings, &cookie))
        .await;
    let only = items(&r.json);
    assert_eq!(only.len(), 1);
    assert_eq!(only[0]["proof_id"], active["proof_id"]);

    // The sign-in behind the active one is revoked: it is reported revoked (derived), with when
    // and why, even though nobody revoked the proof row itself.
    w.ctx
        .exec(&format!(
            "update token_families set revoked_at = now(), revoke_reason = 'user_signed_out' where id = '{}'",
            w.subject_family()
        ))
        .await;
    let r = w
        .call(Req::get("/v1/me/proofs?status=revoked").session(&w.ctx.state.settings, &cookie))
        .await;
    let revoked_now = items(&r.json);
    assert_eq!(revoked_now.len(), 2, "{}", r.json);
    let derived = find(&revoked_now, &proof_id(&active));
    assert_eq!(derived["revoke_reason"], "sign_in_revoked");
    assert!(derived["revoked_at"].is_string());
    // The app sees the same.
    let r = w
        .call(
            Req::get(&format!("/v1/apps/{}/proofs?status=active", w.dm.app_id))
                .basic(&w.dm.app_id, &w.dm_secret),
        )
        .await;
    let still_active: Vec<String> = items(&r.json)
        .iter()
        .map(|i| i["proof_id"].as_str().unwrap_or("").to_string())
        .collect();
    assert!(!still_active.contains(&proof_id(&active)));

    // A bad status value is refused; no session → 401.
    let r = w
        .call(Req::get("/v1/me/proofs?status=gone").session(&w.ctx.state.settings, &cookie))
        .await;
    assert_eq!(r.status, 400);
    assert_eq!(r.error_code(), Some("invalid_query"));
    let r = w.call(Req::get("/v1/me/proofs")).await;
    assert_eq!(r.status, 401);
}

/// The proof's item in both listings: `(app listing, account listing)`.
async fn both_listings(w: &World, cookie: &str, id: &str) -> (Value, Value) {
    let r = w
        .call(
            Req::get(&format!("/v1/apps/{}/proofs", w.dm.app_id)).basic(&w.dm.app_id, &w.dm_secret),
        )
        .await;
    assert_eq!(r.status, 200, "{}", r.json);
    let app = find(&items(&r.json), id).clone();
    let r = w
        .call(Req::get("/v1/me/proofs").session(&w.ctx.state.settings, cookie))
        .await;
    assert_eq!(r.status, 200, "{}", r.json);
    let mine = find(&items(&r.json), id).clone();
    (app, mine)
}

fn end_of(item: &Value) -> Value {
    json!({"status": item["status"], "revoke_reason": item["revoke_reason"], "revoked_at": item["revoked_at"]})
}

#[tokio::test]
async fn membership_and_account_ends_are_derived_live() {
    // Only the membership or the account row changes here (no proof row is touched, and the
    // sign-in stays live): listings derive the end, with when and why, and the sweep doesn't
    // make it permanent (the real paths store access_removed / account_deleted themselves).
    let w = World::new().await;
    let p = w.issue_user_verification().await;
    let id = proof_id(&p);
    let cookie = w.ctx.browser_session(&w.carbon).await;

    // Membership no longer active → membership_inactive, at access_removed_at.
    w.ctx
        .exec(&format!(
            "update memberships set status = 'access_removed', access_removed_at = now() - interval '2 minutes' \
             where app_id = '{}' and account_uuid = '{}'",
            w.dm.app_id, w.carbon.uuid
        ))
        .await;
    let removed_at = crate::common::api_time(
        &w,
        &format!(
            "select access_removed_at from memberships where app_id = '{}' and account_uuid = '{}'",
            w.dm.app_id, w.carbon.uuid
        ),
    )
    .await;
    assert!(removed_at.is_some());
    let (app, mine) = both_listings(&w, &cookie, &id).await;
    let expected = json!({"status": "revoked", "revoke_reason": "membership_inactive", "revoked_at": removed_at});
    assert_eq!(end_of(&app), expected);
    assert_eq!(end_of(&mine), expected);
    let r = w
        .call(
            Req::get(&format!("/v1/apps/{}/proofs?status=revoked", w.dm.app_id))
                .basic(&w.dm.app_id, &w.dm_secret),
        )
        .await;
    assert_eq!(items(&r.json).len(), 1);
    let report = accounts_proofs::store::sweep(&w.ctx.state.db)
        .await
        .expect("sweep");
    assert_eq!(report.sign_in_revocations_recorded, 0);

    // Back to active: the proof is active again (nothing was stored).
    w.ctx
        .exec(&format!(
            "update memberships set status = 'active', access_removed_at = null \
             where app_id = '{}' and account_uuid = '{}'",
            w.dm.app_id, w.carbon.uuid
        ))
        .await;
    let (app, mine) = both_listings(&w, &cookie, &id).await;
    let active = json!({"status": "active", "revoke_reason": null, "revoked_at": null});
    assert_eq!(end_of(&app), active);
    assert_eq!(end_of(&mine), active);

    // The account not active (unclaimed, so it can still list) → account_inactive, no time.
    w.ctx
        .exec(&format!(
            "update accounts set status = 'unclaimed' where uuid = '{}'",
            w.carbon.uuid
        ))
        .await;
    let (app, mine) = both_listings(&w, &cookie, &id).await;
    let expected =
        json!({"status": "revoked", "revoke_reason": "account_inactive", "revoked_at": null});
    assert_eq!(end_of(&app), expected);
    assert_eq!(end_of(&mine), expected);
    assert_eq!(app["user"]["status"], "unclaimed");

    // Deleted (simulated directly) → account_inactive at deleted_at (app listing; a deleted
    // account can't list anything itself).
    w.ctx
        .exec(&format!(
            "update accounts set status = 'deleted', deleted_at = now() - interval '1 minute' where uuid = '{}'",
            w.carbon.uuid
        ))
        .await;
    let deleted_at = crate::common::api_time(
        &w,
        &format!(
            "select deleted_at from accounts where uuid = '{}'",
            w.carbon.uuid
        ),
    )
    .await;
    let r = w
        .call(
            Req::get(&format!("/v1/apps/{}/proofs", w.dm.app_id)).basic(&w.dm.app_id, &w.dm_secret),
        )
        .await;
    assert_eq!(
        end_of(find(&items(&r.json), &id)),
        json!({"status": "revoked", "revoke_reason": "account_inactive", "revoked_at": deleted_at})
    );
    let report = accounts_proofs::store::sweep(&w.ctx.state.db)
        .await
        .expect("sweep");
    assert_eq!(report.sign_in_revocations_recorded, 0);
    assert_eq!(
        w.text(&format!(
            "select revoked_at::text from proof_families where id = '{id}'"
        ))
        .await,
        None
    );
}

#[tokio::test]
async fn a_silicon_sees_its_proofs_too() {
    let w = World::new().await;
    let (si, _) = w.ctx.silicon(&w.carbon.uuid).await;
    w.ctx
        .membership(
            &w.dm.app_id,
            &si.uuid,
            &[accounts_core::models::Scope::Profile],
        )
        .await;
    let t = w
        .ctx
        .tokens_for(&si, &w.dm.app_id, &[accounts_core::models::Scope::Profile])
        .await;
    let p = w
        .user_verification(
            json!({"subject_token": t.access_token, "receiving_app": w.briefcase.app_id}),
        )
        .await;
    assert_eq!(p.status, 201);
    let fp = w.ctx.first_party_tokens(&si).await;
    let r = w
        .call(Req::get("/v1/me/proofs").bearer(&fp.access_token))
        .await;
    assert_eq!(r.status, 200);
    assert_eq!(items(&r.json).len(), 1);
    let r = w
        .call(Req::delete(&format!("/v1/me/proofs/{}", proof_id(&p.json))).bearer(&fp.access_token))
        .await;
    assert_eq!(r.status, 204);
}

#[tokio::test]
async fn the_sweep_deletes_only_dead_tokens() {
    let w = World::new().await;
    let live = w.issue_user_verification().await;
    let old_token = w.issue_user_verification().await;
    let dead = w.issue_user_verification().await;
    w.ctx
        .exec(&format!(
            "update proof_tokens set expires_at = now() - interval '2 days' \
             where family_id = '{}' and kind = 'access'",
            proof_id(&old_token)
        ))
        .await;
    w.ctx
        .exec(&format!(
            "update proof_families set revoked_at = now() - interval '31 days' where id = '{}'",
            proof_id(&dead)
        ))
        .await;
    let report = accounts_proofs::store::sweep(&w.ctx.state.db)
        .await
        .expect("sweep");
    assert_eq!(
        report,
        accounts_proofs::store::SweepReport {
            sign_in_revocations_recorded: 0,
            expired_access_tokens: 1,
            dead_family_tokens: 2,
        }
    );
    let left = |id: String| {
        let w = &w;
        async move {
            w.count(&format!(
                "select count(*) from proof_tokens where family_id = '{id}'"
            ))
            .await
        }
    };
    assert_eq!(left(proof_id(&live)).await, 2);
    assert_eq!(
        left(proof_id(&old_token)).await,
        1,
        "the refresh token stays"
    );
    assert_eq!(left(proof_id(&dead)).await, 0);
    assert_eq!(
        w.count("select count(*) from proof_families").await,
        3,
        "families stay as history"
    );
    // The surviving refresh token of the swept proof still works.
    let r = w.refresh(&refresh_token(&old_token)).await;
    assert_eq!(r.status, 200, "{}", r.json);
}
