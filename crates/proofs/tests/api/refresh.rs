//! `POST /v1/proofs/refresh`: rotation, reuse detection, refusals.

use std::sync::Arc;

use accounts_core::test_support::{Req, call};
use serde_json::json;
use tokio::task::JoinSet;

use crate::common::{World, api_time, assert_token_ttl, invalid, proof_id, refresh_token, token};

#[tokio::test]
async fn refresh_rotates_both_tokens() {
    let w = World::new().await;
    let p = w.issue_obo_ttl(600).await;
    let r = w.refresh(&refresh_token(&p)).await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(
        r.headers.get("cache-control").and_then(|v| v.to_str().ok()),
        Some("no-store")
    );
    let n = &r.json;
    assert_eq!(n["proof_id"], p["proof_id"], "same proof");
    assert_eq!(n["kind"], "obo");
    assert_ne!(token(n), token(&p));
    assert_ne!(refresh_token(n), refresh_token(&p));
    assert_token_ttl(n, 600); // keeps the proof's token lifetime
    assert_eq!(
        n["refresh_expires_at"], p["refresh_expires_at"],
        "absolute lifetime"
    );
    assert_eq!(n["receiving_app"], w.briefcase.app_id);
    assert_eq!(n["user"], p["user"]);
    assert_eq!(n["scopes"], p["scopes"]);
    let parsed: silicon_accounts_client::IssuedProof =
        serde_json::from_value(n.clone()).expect("client parses a refresh response");
    assert_eq!(parsed.proof_id, proof_id(&p));

    // Both proof tokens verify (the old one until its own expiry), like access tokens.
    assert_eq!(w.verify_bc(&token(&p)).await["valid"], true);
    assert_eq!(w.verify_bc(&token(n)).await["valid"], true);

    // A different lifetime for this token only.
    let r2 = w
        .call(
            Req::post("/v1/proofs/refresh")
                .basic(&w.dm.app_id, &w.dm_secret)
                .json(json!({"proof_refresh_token": refresh_token(n), "access_ttl_seconds": 90})),
        )
        .await;
    assert_eq!(r2.status, 200, "{}", r2.json);
    assert_token_ttl(&r2.json, 90);
    let r3 = w.refresh(&refresh_token(&r2.json)).await;
    assert_token_ttl(&r3.json, 600); // the proof's default is unchanged

    let last = w
        .text(&format!(
            "select last_refreshed_at::text from proof_families where id = '{}'",
            proof_id(&p)
        ))
        .await;
    assert!(last.is_some());
    let refreshed = w
        .count(&format!(
            "select count(*) from audit_log where action = 'proof.refreshed' and target_id = '{}' \
             and account_uuid is null and actor_kind = 'app'",
            proof_id(&p)
        ))
        .await;
    assert_eq!(
        refreshed, 3,
        "audited, but kept out of the account's history"
    );

    // ATA proofs refresh the same way.
    let a = w
        .ata_as(
            &w.dm,
            &w.dm_secret,
            json!({"receiving_app": w.briefcase.app_id}),
        )
        .await;
    let r = w.refresh(&refresh_token(&a.json)).await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(r.json["kind"], "ata");
    assert_eq!(r.json["receiving_app"], w.briefcase.app_id);
    assert!(r.json.get("receiving_apps").is_none());
    assert_eq!(r.json["user"], serde_json::Value::Null);
    assert_eq!(w.verify_bc(&token(&r.json)).await["valid"], true);
}

#[tokio::test]
async fn reusing_a_refresh_token_revokes_the_proof() {
    let w = World::new().await;
    let p = w.issue_obo().await;
    let first = refresh_token(&p);
    let r = w.refresh(&first).await;
    assert_eq!(r.status, 200);
    let second = refresh_token(&r.json);
    let newest_token = token(&r.json);

    // Replaying the used token: reuse detected → the whole proof is revoked.
    let r = w.refresh(&first).await;
    assert_eq!(r.status, 400, "{}", r.json);
    assert_eq!(r.error_code(), Some("proof_refresh_token_reused"));
    assert_eq!(r.json["error"]["details"]["proof_id"], p["proof_id"]);
    assert!(r.json["error"]["hint"].is_string());
    let reason = w
        .text(&format!(
            "select revoke_reason from proof_families where id = '{}'",
            proof_id(&p)
        ))
        .await;
    assert_eq!(reason.as_deref(), Some("refresh_token_reuse"));

    // Every token of the proof is dead now, including the newest ones.
    assert_eq!(w.verify_bc(&newest_token).await, invalid());
    assert_eq!(w.verify_bc(&token(&p)).await, invalid());
    let r = w.refresh(&second).await;
    assert_eq!(r.status, 410);
    assert_eq!(r.error_code(), Some("proof_revoked"));
    assert_eq!(r.json["error"]["details"]["reason"], "refresh_token_reuse");

    let audited = w
        .count(&format!(
            "select count(*) from audit_log where action = 'proof.refresh_token_reused' and target_id = '{}' \
             and account_uuid = '{}'",
            proof_id(&p),
            w.carbon.uuid
        ))
        .await;
    assert_eq!(audited, 1);
}

#[tokio::test]
async fn refresh_refusals_are_precise() {
    let w = World::new().await;
    let p = w.issue_obo().await;

    // Wrong kind of credential.
    let r = w.refresh(&token(&p)).await;
    assert_eq!(r.status, 400);
    assert_eq!(r.error_code(), Some("invalid_proof_refresh_token"));
    assert!(
        r.json["error"]["message"]
            .as_str()
            .is_some_and(|m| m.contains("a proof token"))
    );
    let r = w.refresh(&w.subject_refresh).await;
    assert!(
        r.json["error"]["message"]
            .as_str()
            .is_some_and(|m| m.contains("a refresh token"))
    );
    // The right token behind a label is named as such, never echoed.
    let wrapped = format!("Bearer {}", refresh_token(&p));
    let r = w.refresh(&wrapped).await;
    assert_eq!(r.error_code(), Some("invalid_proof_refresh_token"));
    let message = r.json["error"]["message"].as_str().unwrap_or_default();
    assert!(
        message.contains("a proof refresh token with other text around it"),
        "{message}"
    );
    assert!(!r.json.to_string().contains(&refresh_token(&p)[5..]));

    // Unknown: a typo, another environment, or tokens the sweep deleted (named, so a swept
    // proof isn't mistaken for a typo).
    let r = w.refresh(&format!("sapr_{}", "B".repeat(43))).await;
    assert_eq!(r.status, 400);
    let message = r.json["error"]["message"].as_str().unwrap_or_default();
    assert!(
        message.contains("not known") && message.contains("more than 30 days ago"),
        "{message}"
    );
    assert!(
        r.json["error"]["hint"]
            .as_str()
            .is_some_and(|h| h.contains("issue a new one"))
    );

    // Empty / bad lifetime → 422 before anything is consumed.
    let r = w.refresh("  ").await;
    assert_eq!(r.status, 422);
    let r = w
        .call(
            Req::post("/v1/proofs/refresh")
                .basic(&w.dm.app_id, &w.dm_secret)
                .json(json!({"proof_refresh_token": refresh_token(&p), "access_ttl_seconds": 5})),
        )
        .await;
    assert_eq!(r.status, 422);

    // Another app can't refresh it — and can't trigger reuse detection either.
    let r = w
        .call(
            Req::post("/v1/proofs/refresh")
                .basic(&w.briefcase.app_id, &w.briefcase_secret)
                .json(json!({"proof_refresh_token": refresh_token(&p)})),
        )
        .await;
    assert_eq!(r.status, 403);
    assert_eq!(r.error_code(), Some("not_issuing_app"));
    let ok = w.refresh(&refresh_token(&p)).await;
    assert_eq!(ok.status, 200, "still the issuer's to use: {}", ok.json);
    let r = w
        .call(
            Req::post("/v1/proofs/refresh")
                .basic(&w.briefcase.app_id, &w.briefcase_secret)
                .json(json!({"proof_refresh_token": refresh_token(&p)})),
        )
        .await;
    assert_eq!(r.error_code(), Some("not_issuing_app"));
    assert_eq!(
        w.text(&format!(
            "select revoke_reason from proof_families where id = '{}'",
            proof_id(&p)
        ))
        .await,
        None,
        "a used token presented by another app revokes nothing"
    );

    // Expired proof (time travel).
    let rt = refresh_token(&ok.json);
    w.ctx
        .exec(&format!(
            "update proof_families set expires_at = now() - interval '1 second' where id = '{}'",
            proof_id(&p)
        ))
        .await;
    let r = w.refresh(&rt).await;
    assert_eq!(r.status, 410);
    assert_eq!(r.error_code(), Some("proof_expired"));
}

#[tokio::test]
async fn obo_refresh_stops_when_the_grant_ends() {
    // Subject sign-in revoked.
    let w = World::new().await;
    let p = w.issue_obo().await;
    let id = proof_id(&p);
    let fid = w.subject_family();
    w.ctx
        .exec(&format!(
            "update token_families set revoked_at = now(), revoke_reason = 'user_signed_out' where id = '{fid}'"
        ))
        .await;
    let signed_out_at = api_time(
        &w,
        &format!("select revoked_at from token_families where id = '{fid}'"),
    )
    .await;
    let r = w.refresh(&refresh_token(&p)).await;
    assert_eq!(r.status, 410, "{}", r.json);
    assert_eq!(r.error_code(), Some("proof_revoked"));
    assert_eq!(r.json["error"]["details"]["reason"], "sign_in_revoked");
    assert_eq!(
        r.json["error"]["details"]["revoked_at"],
        json!(signed_out_at)
    );
    assert!(
        r.json["error"]["message"]
            .as_str()
            .is_some_and(|m| m.contains("user_signed_out")),
        "{}",
        r.json
    );
    // A revoked sign-in never comes back, so the refresh stored the proof's end right away:
    // when the sign-in was revoked, by the system, with its audit entry (account history).
    assert_eq!(
        w.text(&format!(
            "select revoked_by || '/' || revoke_reason from proof_families where id = '{id}'"
        ))
        .await
        .as_deref(),
        Some("system/sign_in_revoked")
    );
    assert_eq!(
        api_time(
            &w,
            &format!("select revoked_at from proof_families where id = '{id}'")
        )
        .await,
        signed_out_at
    );
    let audited = format!(
        "select count(*) from audit_log where action = 'proof.revoked' and target_id = '{id}' \
         and account_uuid = '{}' and actor_kind = 'system' and app_id = '{}' \
         and details->>'reason' = 'sign_in_revoked' and details->>'sign_in_revoke_reason' = 'user_signed_out'",
        w.carbon.uuid, w.dm.app_id
    );
    assert_eq!(w.count(&audited).await, 1);
    // Nothing was consumed: the same token gets the same answer, now from the stored row (no
    // reuse revocation, no second audit entry).
    let r = w.refresh(&refresh_token(&p)).await;
    assert_eq!(r.status, 410);
    assert_eq!(r.json["error"]["details"]["reason"], "sign_in_revoked");
    assert_eq!(
        r.json["error"]["details"]["revoked_at"],
        json!(signed_out_at)
    );
    assert!(
        r.json["error"]["message"]
            .as_str()
            .is_some_and(|m| m.contains("sign-in at the issuing app")),
        "{}",
        r.json
    );
    assert_eq!(w.count(&audited).await, 1);

    // Membership removed (simulated: only the membership row; the real removal also revokes
    // the sign-in and stores access_removed). Refused, but not stored: it isn't final.
    let w = World::new().await;
    let p = w.issue_obo().await;
    w.ctx
        .exec(&format!(
            "update memberships set status = 'access_removed', access_removed_at = now() \
             where app_id = '{}' and account_uuid = '{}'",
            w.dm.app_id, w.carbon.uuid
        ))
        .await;
    let r = w.refresh(&refresh_token(&p)).await;
    assert_eq!(r.status, 410);
    assert_eq!(r.json["error"]["details"]["reason"], "membership_inactive");
    assert_eq!(
        w.text(&format!(
            "select revoked_at::text from proof_families where id = '{}'",
            proof_id(&p)
        ))
        .await,
        None
    );

    // Account deleted (directly) → account_inactive.
    let w = World::new().await;
    let p = w.issue_obo().await;
    w.ctx
        .exec(&format!(
            "update accounts set status = 'deleted', deleted_at = now() where uuid = '{}'",
            w.carbon.uuid
        ))
        .await;
    let r = w.refresh(&refresh_token(&p)).await;
    assert_eq!(r.status, 410);
    assert_eq!(r.json["error"]["details"]["reason"], "account_inactive");

    // Subject sign-in expired → proof_expired.
    let w = World::new().await;
    let p = w.issue_obo().await;
    w.ctx
        .exec(&format!(
            "update token_families set expires_at = now() - interval '1 second' where id = '{}'",
            w.subject_family()
        ))
        .await;
    let r = w.refresh(&refresh_token(&p)).await;
    assert_eq!(r.status, 410);
    assert_eq!(r.error_code(), Some("proof_expired"));
    assert_eq!(r.json["error"]["details"]["reason"], "sign_in_expired");
}

#[tokio::test]
async fn an_obo_proof_never_outlives_its_sign_in() {
    let w = World::new().await;
    let fid = w.subject_family();
    // The sign-in ends in 10 minutes: the proof (and its token) end with it.
    w.ctx
        .exec(&format!(
            "update token_families set expires_at = now() + interval '10 minutes' where id = '{fid}'"
        ))
        .await;
    let p = w.issue_obo().await;
    assert_eq!(
        p["refresh_expires_at"], p["expires_at"],
        "capped at the sign-in's expiry"
    );
    assert_token_ttl(&p, 600);
}

#[tokio::test]
async fn idempotent_refresh_replays_instead_of_tripping_reuse_detection() {
    let w = World::new().await;
    let p = w.issue_obo().await;
    let send = || {
        Req::post("/v1/proofs/refresh")
            .basic(&w.dm.app_id, &w.dm_secret)
            .header("idempotency-key", "refresh-1")
            .json(json!({"proof_refresh_token": refresh_token(&p)}))
    };
    let a = w.call(send()).await;
    assert_eq!(a.status, 200, "{}", a.json);
    let b = w.call(send()).await;
    assert_eq!(b.status, 200, "{}", b.json);
    assert_eq!(b.json, a.json);
    assert_eq!(
        b.headers
            .get("idempotent-replayed")
            .and_then(|v| v.to_str().ok()),
        Some("true")
    );
    assert_eq!(
        w.verify_bc(&token(&a.json)).await["valid"],
        true,
        "not revoked"
    );
}

#[tokio::test]
async fn a_revoked_sign_in_ends_the_proof_before_reuse_detection() {
    // The sign-in ended first, so that is the proof's end, even when the token presented
    // afterwards is a used one.
    let w = World::new().await;
    let p = w.issue_obo().await;
    let first = refresh_token(&p);
    let r = w.refresh(&first).await;
    assert_eq!(r.status, 200, "{}", r.json);
    w.ctx
        .exec(&format!(
            "update token_families set revoked_at = now(), revoke_reason = 'app_revoked' where id = '{}'",
            w.subject_family()
        ))
        .await;
    let r = w.refresh(&first).await;
    assert_eq!(r.status, 410, "{}", r.json);
    assert_eq!(r.error_code(), Some("proof_revoked"));
    assert_eq!(r.json["error"]["details"]["reason"], "sign_in_revoked");
    assert_eq!(
        w.text(&format!(
            "select revoke_reason from proof_families where id = '{}'",
            proof_id(&p)
        ))
        .await
        .as_deref(),
        Some("sign_in_revoked")
    );
    assert_eq!(
        w.count(&format!(
            "select count(*) from audit_log where action = 'proof.refresh_token_reused' and target_id = '{}'",
            proof_id(&p)
        ))
        .await,
        0
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn concurrent_refreshes_of_one_token_rotate_it_once() {
    // N requests present the same refresh token at the same moment (a retry storm, or a
    // stolen token raced against the app). The token row lock serializes them: exactly one
    // rotates it, the next one is a reuse and revokes the proof, the rest find it revoked.
    const N: usize = 6;
    let w = World::new().await;
    let p = w.issue_obo().await;
    let rt = refresh_token(&p);
    let router = accounts_proofs::router().with_state(w.ctx.state.clone());
    let start = Arc::new(tokio::sync::Barrier::new(N));
    let mut set = JoinSet::new();
    for _ in 0..N {
        let router = router.clone();
        let start = start.clone();
        let req = Req::post("/v1/proofs/refresh")
            .basic(&w.dm.app_id, &w.dm_secret)
            .json(json!({"proof_refresh_token": rt}));
        set.spawn(async move {
            start.wait().await;
            call(router, req).await
        });
    }
    let mut outcomes = Vec::new();
    let mut minted = Vec::new();
    while let Some(r) = set.join_next().await {
        let r = r.expect("task");
        if r.status == 200 {
            minted.push(token(&r.json));
        }
        outcomes.push((r.status.as_u16(), r.error_code().map(str::to_string)));
    }
    outcomes.sort();
    let code = |c: &str| {
        outcomes
            .iter()
            .filter(|(_, e)| e.as_deref() == Some(c))
            .count()
    };
    assert_eq!(minted.len(), 1, "one rotation, never two: {outcomes:?}");
    assert_eq!(code("proof_refresh_token_reused"), 1, "{outcomes:?}");
    assert_eq!(code("proof_revoked"), N - 2, "{outcomes:?}");
    assert_eq!(
        w.text(&format!(
            "select revoke_reason from proof_families where id = '{}'",
            proof_id(&p)
        ))
        .await
        .as_deref(),
        Some("refresh_token_reuse")
    );
    assert_eq!(
        w.count(&format!(
            "select count(*) from proof_tokens where family_id = '{}'",
            proof_id(&p)
        ))
        .await,
        4,
        "the first pair plus exactly one rotated pair"
    );
    // The token the winner got dies with the proof.
    assert_eq!(w.verify_bc(&minted[0]).await, invalid());
}
