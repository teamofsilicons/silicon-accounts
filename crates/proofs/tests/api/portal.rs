//! Managed-app verification history is first-party, durable and secret-free.
use accounts_core::models::Scope;
use accounts_core::test_support::Req;
use serde_json::{Value, json};

use crate::common::{World, proof_id, refresh_token, token};

async fn managed() -> (World, String) {
    let w = World::new().await;
    sqlx::query("update apps set owner_uuid=$1 where app_id=$2")
        .bind(&w.carbon.uuid)
        .bind(&w.dm.app_id)
        .execute(&w.ctx.state.db)
        .await
        .expect("owner");
    let dev = w
        .ctx
        .tokens_for(&w.carbon, "developer", &[Scope::Profile])
        .await
        .access_token;
    (w, dev)
}

async fn issue(w: &World) -> Value {
    let r = w
        .app_verification_as(
            &w.dm,
            &w.dm_secret,
            json!({"receiving_app":w.briefcase.app_id,"access_ttl_seconds":300,"scopes":["read"]}),
        )
        .await;
    assert_eq!(r.status, 201, "{}", r.json);
    r.json
}

fn items(v: &Value) -> &[Value] {
    v["items"].as_array().expect("items")
}

#[tokio::test]
async fn managed_history_lists_all_retained_states_and_pages_without_cross_app_leaks() {
    let (w, dev) = managed().await;
    let active = issue(&w).await;
    let revoked = issue(&w).await;
    let expired = issue(&w).await;
    w.revoke_as(&w.dm, &w.dm_secret, json!({"proof_id":proof_id(&revoked)}))
        .await;
    sqlx::query("update proof_families set expires_at=now()-interval '31 days' where id=$1::uuid")
        .bind(proof_id(&expired))
        .execute(&w.ctx.state.db)
        .await
        .expect("expire");
    // A currently accepted author has exactly the same management boundary as the owner.
    sqlx::query("insert into app_authors(app_id,account_uuid) values($1,$2)")
        .bind(&w.other.app_id)
        .bind(&w.carbon.uuid)
        .execute(&w.ctx.state.db)
        .await
        .expect("author");
    let authored = w
        .app_verification_as(
            &w.other,
            &w.other_secret,
            json!({"receiving_app":w.briefcase.app_id}),
        )
        .await
        .json;
    let hidden = w
        .app_verification_as(
            &w.briefcase,
            &w.briefcase_secret,
            json!({"receiving_app":w.dm.app_id}),
        )
        .await
        .json;
    let user_verification = w.issue_user_verification().await;
    accounts_proofs::store::sweep(&w.ctx.state.db)
        .await
        .expect("sweep");
    // Stable tie-breaking is required across different apps and the same timestamp.
    w.ctx
        .exec("update proof_families set created_at='2026-01-01T00:00:00Z'")
        .await;
    let mut all = Vec::new();
    let mut cursor = None;
    loop {
        let path = cursor.as_ref().map_or_else(
            || "/v1/me/app-verifications?limit=2".to_owned(),
            |c| format!("/v1/me/app-verifications?limit=2&cursor={c}"),
        );
        let r = w.call(Req::get(&path).bearer(&dev)).await;
        assert_eq!(r.status, 200, "{}", r.json);
        assert_eq!(r.headers["cache-control"], "no-store");
        all.extend_from_slice(items(&r.json));
        cursor = r.json["next_cursor"].as_str().map(str::to_owned);
        if cursor.is_none() {
            break;
        }
    }
    assert_eq!(all.len(), 4);
    assert_eq!(
        all.iter()
            .map(|x| x["proof_id"].as_str().expect("id"))
            .collect::<std::collections::HashSet<_>>()
            .len(),
        4
    );
    assert!(
        !all.iter().any(|x| x["proof_id"] == hidden["proof_id"]
            || x["proof_id"] == user_verification["proof_id"])
    );
    let find = |p: &Value| {
        all.iter()
            .find(|r| r["proof_id"] == p["proof_id"])
            .expect("listed")
    };
    assert_eq!(find(&active)["status"], "active");
    assert_eq!(find(&revoked)["status"], "revoked");
    assert_eq!(find(&expired)["status"], "expired");
    assert!(
        find(&expired)["token_expires_at"].is_null(),
        "swept access expiry stays unavailable"
    );
    assert_eq!(find(&authored)["issuing_app"]["app_id"], w.other.app_id);
    assert_eq!(find(&active)["issuing_app"]["name"], w.dm.name);
    let text = serde_json::to_string(&all).expect("json");
    assert!(
        !text.contains(&token(&active))
            && !text.contains(&refresh_token(&active))
            && !text.contains("token_hash")
    );
    for (status, p) in [
        ("active", &active),
        ("revoked", &revoked),
        ("expired", &expired),
    ] {
        let r = w
            .call(
                Req::get(&format!(
                    "/v1/me/app-verifications?app_id={}&status={status}",
                    w.dm.app_id
                ))
                .bearer(&dev),
            )
            .await;
        assert_eq!(items(&r.json).len(), 1, "{}", r.json);
        assert_eq!(items(&r.json)[0]["proof_id"], p["proof_id"]);
    }
    for query in [
        format!("app_id={}", w.briefcase.app_id),
        "app_id=unknown".into(),
    ] {
        assert_eq!(
            w.call(Req::get(&format!("/v1/me/app-verifications?{query}")).bearer(&dev))
                .await
                .status,
            404
        );
    }
    for query in ["status=missing", "kind=user_verification", "cursor=broken"] {
        assert_eq!(
            w.call(Req::get(&format!("/v1/me/app-verifications?{query}")).bearer(&dev))
                .await
                .status,
            400
        );
    }
    let before = w
        .call(Req::get("/v1/me/app-verifications?limit=1").bearer(&dev))
        .await;
    let page_cursor = before.json["next_cursor"].as_str().expect("next page");
    w.call(
        Req::post("/v1/proofs/refresh")
            .basic(&w.other.app_id, &w.other_secret)
            .json(json!({"proof_refresh_token":refresh_token(&authored)})),
    )
    .await;
    let path = format!(
        "/v1/apps/{}/proofs/{}/history",
        w.other.app_id,
        proof_id(&authored)
    );
    let before = w
        .call(Req::get(&format!("{path}?limit=1")).bearer(&dev))
        .await;
    let history_cursor = before.json["next_cursor"]
        .as_str()
        .expect("history next page");
    sqlx::query("delete from app_authors where app_id=$1 and account_uuid=$2")
        .bind(&w.other.app_id)
        .bind(&w.carbon.uuid)
        .execute(&w.ctx.state.db)
        .await
        .expect("remove author");
    let path = format!(
        "/v1/apps/{}/proofs/{}/history",
        w.other.app_id,
        proof_id(&authored)
    );
    assert_eq!(w.call(Req::get(&path).bearer(&dev)).await.status, 404);
    assert_eq!(
        w.call(Req::get(&format!("{path}?cursor={history_cursor}")).bearer(&dev))
            .await
            .status,
        404
    );
    let remaining = w
        .call(Req::get(&format!("/v1/me/app-verifications?cursor={page_cursor}")).bearer(&dev))
        .await;
    assert!(
        !items(&remaining.json)
            .iter()
            .any(|r| r["proof_id"] == authored["proof_id"])
    );
    let r = w
        .call(Req::get("/v1/me/app-verifications").bearer(&dev))
        .await;
    assert_eq!(
        items(&r.json).len(),
        3,
        "removed author disappears immediately"
    );
}

#[tokio::test]
async fn immutable_events_survive_token_sweep_and_keep_generation_expiry_honest() {
    let (w, dev) = managed().await;
    let create_path = format!("/v1/apps/{}/proofs/app-verification", w.dm.app_id);
    let create_body = json!({"receiving_app":w.briefcase.app_id,"access_ttl_seconds":300});
    let p = w
        .call(
            Req::post(&create_path)
                .bearer(&dev)
                .header("idempotency-key", "portal-history-issue")
                .json(create_body.clone()),
        )
        .await
        .json;
    let replay = w
        .call(
            Req::post(&create_path)
                .bearer(&dev)
                .header("idempotency-key", "portal-history-issue")
                .json(create_body),
        )
        .await
        .json;
    assert_eq!(p, replay, "idempotent retry keeps one issuance event");
    let refreshed = w.refresh(&refresh_token(&p)).await.json;
    w.revoke_as(&w.dm, &w.dm_secret, json!({"proof_id":proof_id(&p)}))
        .await;
    let path = format!("/v1/apps/{}/proofs/{}/history", w.dm.app_id, proof_id(&p));
    let mut history = Vec::new();
    let mut cursor = None;
    loop {
        let url = cursor.as_ref().map_or_else(
            || format!("{path}?limit=1"),
            |c| format!("{path}?limit=1&cursor={c}"),
        );
        let r = w.call(Req::get(&url).bearer(&dev)).await;
        assert_eq!(r.status, 200, "{}", r.json);
        assert_eq!(r.headers["cache-control"], "no-store");
        history.extend_from_slice(items(&r.json));
        cursor = r.json["next_cursor"].as_str().map(str::to_owned);
        if cursor.is_none() {
            break;
        }
    }
    assert_eq!(
        history
            .iter()
            .map(|v| v["action"].as_str().expect("action"))
            .collect::<Vec<_>>(),
        vec!["proof.revoked", "proof.refreshed", "proof.issued"]
    );
    assert_eq!(history[1]["token_expires_at"], refreshed["expires_at"]);
    assert_eq!(history[2]["token_expires_at"], p["expires_at"]);
    assert_eq!(history[1]["token_expiry_source"], "recorded");
    assert_eq!(history[2]["actor"]["id"], w.carbon.uuid);
    assert_eq!(history[2]["actor"]["kind"], "account");
    assert!(history[0]["token_expires_at"].is_null());
    // Historical audit rows lack explicit expiry. Derived values use the transaction's
    // timestamp and TTL, not an invented token ID or the family's most recent token.
    sqlx::query("update audit_log set details=details-'token_expires_at' where target_id=$1")
        .bind(proof_id(&p))
        .execute(&w.ctx.state.db)
        .await
        .expect("legacy audit");
    sqlx::query("delete from proof_tokens where family_id=$1::uuid")
        .bind(proof_id(&p))
        .execute(&w.ctx.state.db)
        .await
        .expect("swept tokens");
    let r = w.call(Req::get(&path).bearer(&dev)).await;
    assert_eq!(items(&r.json).len(), 3);
    assert_eq!(items(&r.json)[1]["token_expiry_source"], "derived");
    assert_eq!(
        items(&r.json)[1]["token_expires_at"],
        refreshed["expires_at"]
    );
    assert_eq!(items(&r.json)[2]["token_expires_at"], p["expires_at"]);
    sqlx::query("update audit_log set details=(details-'access_ttl_seconds')||$2::jsonb where target_id=$1")
        .bind(proof_id(&p)).bind(json!({"proof_token":token(&p),"proof_refresh_token":refresh_token(&p),"token_hash":"secret-hash","arbitrary":{"secret":"private"}}))
        .execute(&w.ctx.state.db).await.expect("malformed historical row");
    let r = w.call(Req::get(&path).bearer(&dev)).await;
    for item in items(&r.json) {
        assert!(item["token_expires_at"].is_null());
        assert!(item["token_expiry_source"].is_null());
    }
    let serialized = r.json.to_string();
    for secret in [
        token(&p),
        refresh_token(&p),
        "secret-hash".into(),
        "arbitrary".into(),
    ] {
        assert!(!serialized.contains(&secret));
    }
    let malformed = w
        .call(Req::get(&format!("{path}?cursor=broken")).bearer(&dev))
        .await;
    assert_eq!(malformed.status, 400);
}

#[tokio::test]
async fn only_live_first_party_managers_can_read_portal_history() {
    let (w, dev) = managed().await;
    let p = issue(&w).await;
    let history = format!("/v1/apps/{}/proofs/{}/history", w.dm.app_id, proof_id(&p));
    let stranger = w.ctx.carbon().await;
    let stranger_dev = w
        .ctx
        .tokens_for(&stranger, "developer", &[Scope::Profile])
        .await
        .access_token;
    let (apps, _) = w.ctx.app("apps").await;
    sqlx::query("insert into apps(app_id,name,secret_hash,status,source) select 'silicon-apps',name,secret_hash,status,source from apps where app_id=$1")
        .bind(&apps.app_id).execute(&w.ctx.state.db).await.expect("canonical Apps fixture");
    w.ctx
        .membership("silicon-apps", &w.carbon.uuid, &[Scope::Profile])
        .await;
    let apps_token = w
        .ctx
        .tokens_for(&w.carbon, "silicon-apps", &[Scope::Profile])
        .await
        .access_token;
    let cookie = w.ctx.browser_session(&w.carbon).await;
    let fp = w.ctx.first_party_tokens(&w.carbon).await.access_token;
    for path in ["/v1/me/app-verifications", history.as_str()] {
        for req in [
            Req::get(path),
            Req::get(path).basic(&w.dm.app_id, &w.dm_secret),
            Req::get(path).basic(&w.briefcase.app_id, &w.briefcase_secret),
            Req::get(path).bearer(&w.subject_token),
            Req::get(path).bearer(&apps_token),
        ] {
            assert_eq!(w.call(req).await.status, 401, "{path}");
        }
        for req in [
            Req::get(path).bearer(&fp),
            Req::get(path).bearer(&dev),
            Req::get(path).session(&w.ctx.state.settings, &cookie),
        ] {
            let r = w.call(req).await;
            assert_eq!(r.status, 200, "{}", r.json);
        }
    }
    assert_eq!(
        w.call(Req::get(&history).bearer(&stranger_dev))
            .await
            .status,
        404
    );
    assert!(
        items(
            &w.call(Req::get("/v1/me/app-verifications").bearer(&stranger_dev))
                .await
                .json
        )
        .is_empty()
    );
    let user_verification = w.issue_user_verification().await;
    assert_eq!(
        w.call(
            Req::get(&format!(
                "/v1/apps/{}/proofs/{}/history",
                w.dm.app_id,
                proof_id(&user_verification)
            ))
            .bearer(&dev)
        )
        .await
        .status,
        404
    );
    // Basic/app-scoped access to the original per-app proof route stays compatible.
    let original = format!("/v1/apps/{}/proofs", w.dm.app_id);
    assert_eq!(
        w.call(Req::get(&original).basic(&w.dm.app_id, &w.dm_secret))
            .await
            .status,
        200
    );
    assert_eq!(
        w.call(Req::get(&original).bearer(&apps_token)).await.status,
        200
    );
    sqlx::query(
        "update token_families set revoked_at=now() where app_id='developer' and account_uuid=$1",
    )
    .bind(&w.carbon.uuid)
    .execute(&w.ctx.state.db)
    .await
    .expect("revoke developer session");
    for path in ["/v1/me/app-verifications", history.as_str()] {
        let r = w.call(Req::get(path).bearer(&dev)).await;
        assert_eq!(r.status, 401);
        assert_eq!(r.error_code(), Some("token_revoked"));
    }
}
