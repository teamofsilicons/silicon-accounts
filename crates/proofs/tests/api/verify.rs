//! `POST /v1/proofs/verify`: exact shapes, audience, expiry, and every cascade.

use accounts_core::models::Scope;
use accounts_core::test_support::Req;
use serde_json::{Value, json};

use crate::common::{World, assert_token_ttl, invalid, proof_id, token};

#[tokio::test]
async fn valid_proofs_have_the_exact_contract_shape() {
    let w = World::new().await;
    let p = w.issue_user_verification().await;
    let r = w
        .verify_as(&w.briefcase, &w.briefcase_secret, &token(&p))
        .await;
    assert_eq!(r.status, 200);
    assert_eq!(
        r.headers.get("cache-control").and_then(|v| v.to_str().ok()),
        Some("no-store")
    );
    let expected = json!({
        "valid": true,
        "proof_id": proof_id(&p),
        "kind": "user_verification",
        "expires_at": p["expires_at"],
        "issuing_app": {"app_id": w.dm.app_id, "name": w.dm.name},
        "receiving_app": {"app_id": w.briefcase.app_id, "name": w.briefcase.name},
        "user": {
            "uuid": w.carbon.uuid,
            "id": w.carbon.id(),
            "kind": "carbon",
            "membership_id": format!("{}:{}", w.dm.app_id, w.carbon.uuid),
        },
        "scopes": ["files.write"],
    });
    assert_eq!(r.json, expected);

    // The published Rust package parses it as a valid proof.
    let parsed: silicon_accounts_client::ValidProof =
        serde_json::from_value(r.json.clone()).expect("client parses ValidProof");
    assert_eq!(parsed.issuing_app.app_id, w.dm.app_id);
    assert_eq!(
        parsed.user.and_then(|u| u.membership_id),
        Some(format!("{}:{}", w.dm.app_id, w.carbon.uuid))
    );

    // The account's id is the current one, not the one at issue time.
    w.ctx
        .exec(&format!(
            "update accounts set handle = 'c:renamed-{}' where uuid = '{}'",
            &w.dm.app_id[3..],
            w.carbon.uuid
        ))
        .await;
    let v = w.verify_bc(&token(&p)).await;
    assert_eq!(v["user"]["id"], format!("c:renamed-{}", &w.dm.app_id[3..]));
}

#[tokio::test]
async fn anything_else_is_exactly_invalid() {
    let w = World::new().await;
    let p = w.issue_user_verification().await;
    let t = token(&p);

    // Wrong audience: an unrelated app, and the issuing app itself.
    let r = w.verify_as(&w.other, &w.other_secret, &t).await;
    assert_eq!(r.status, 200);
    assert_eq!(r.json, invalid());
    let r = w.verify_as(&w.dm, &w.dm_secret, &t).await;
    assert_eq!(r.json, invalid());

    // Unknown tokens, the refresh token, other credentials, garbage — all the same answer.
    let unknown = format!("sap_{}", "A".repeat(43));
    for (bad, hinted) in [
        (unknown.as_str(), false),
        (p["proof_refresh_token"].as_str().expect("rt"), true),
        (w.subject_token.as_str(), true),
        ("", true),
        ("not-a-token", true),
    ] {
        let r = w.verify_as(&w.briefcase, &w.briefcase_secret, bad).await;
        assert_eq!(r.status, 200, "{bad}");
        assert_eq!(r.json, invalid(), "{bad}");
        assert_eq!(
            r.headers.get("x-accounts-hint").is_some(),
            hinted,
            "syntactic hint only for non-proof-token input ({bad})"
        );
    }
    let r = w
        .verify_as(
            &w.briefcase,
            &w.briefcase_secret,
            p["proof_refresh_token"].as_str().expect("rt"),
        )
        .await;
    assert!(
        r.headers
            .get("x-accounts-hint")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|h| h.contains("proof refresh token")),
        "{:?}",
        r.headers
    );

    // Bad requests (not answers): missing field → 422, no credentials → 401.
    let r = w
        .call(
            Req::post("/v1/proofs/verify")
                .basic(&w.briefcase.app_id, &w.briefcase_secret)
                .json(json!({})),
        )
        .await;
    assert_eq!(r.status, 422);
    assert!(r.json["error"]["details"]["fields"]["proof_token"].is_string());
    let r = w
        .call(Req::post("/v1/proofs/verify").json(json!({"proof_token": t})))
        .await;
    assert_eq!(r.status, 401);
    let r = w
        .call(
            Req::post("/v1/proofs/verify")
                .basic(&w.briefcase.app_id, "sa_app_wrong")
                .json(json!({"proof_token": t})),
        )
        .await;
    assert_eq!(r.status, 401);
    assert_eq!(r.error_code(), Some("invalid_app_credentials"));

    // The right token behind a label ("Proof <token>", as the receiving app got it in its
    // Authorization header): still exactly invalid, with a hint about the input only.
    let r = w
        .verify_as(&w.briefcase, &w.briefcase_secret, &format!("Proof {t}"))
        .await;
    assert_eq!(r.json, invalid());
    let hint = r
        .headers
        .get("x-accounts-hint")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string();
    assert!(
        hint.contains("a proof token with other text around it"),
        "{hint}"
    );
    assert!(!hint.contains(&t[4..]), "never echoes the token");

    // Still valid for the real audience after all that.
    assert_eq!(w.verify_bc(&t).await["valid"], true);
}

#[tokio::test]
async fn proofs_expire_with_their_token_lifetime() {
    let w = World::new().await;
    let p = w.issue_user_verification_ttl(60).await;
    assert_token_ttl(&p, 60);
    let t = token(&p);
    let v = w.verify_bc(&t).await;
    assert_eq!(v["valid"], true);
    let exp =
        accounts_core::timefmt::parse_rfc3339(v["expires_at"].as_str().expect("ts")).expect("ts");
    let left = (exp - time::OffsetDateTime::now_utc()).whole_seconds();
    assert!((50..=61).contains(&left), "{left}");

    // Time travel: the 60 s are up.
    w.ctx
        .exec(&format!(
            "update proof_tokens set expires_at = now() - interval '1 millisecond' \
             where family_id = '{}' and kind = 'access'",
            proof_id(&p)
        ))
        .await;
    assert_eq!(w.verify_bc(&t).await, invalid());

    // The proof itself is still alive: refreshing gives a working token.
    let r = w
        .refresh(p["proof_refresh_token"].as_str().expect("rt"))
        .await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_token_ttl(&r.json, 60); // the proof keeps its token lifetime
    assert_eq!(w.verify_bc(&token(&r.json)).await["valid"], true);

    // The proof's own lifetime ends (900 days) → every token is invalid.
    w.ctx
        .exec(&format!(
            "update proof_families set expires_at = now() - interval '1 second' where id = '{}'",
            proof_id(&p)
        ))
        .await;
    assert_eq!(w.verify_bc(&token(&r.json)).await, invalid());
}

/// Issues a proof, applies `sql` (with `{dm}`, `{uuid}`, `{fid}`, `{bc}` placeholders), and
/// returns the verification body.
async fn after(w: &World, sql: &str) -> (Value, Value) {
    let p = w.issue_user_verification().await;
    assert_eq!(w.verify_bc(&token(&p)).await["valid"], true);
    let sql = sql
        .replace("{dm}", &w.dm.app_id)
        .replace("{bc}", &w.briefcase.app_id)
        .replace("{uuid}", &w.carbon.uuid)
        .replace("{fid}", &w.subject_family().to_string());
    w.ctx.exec(&sql).await;
    let v = w.verify_bc(&token(&p)).await;
    (p, v)
}

#[tokio::test]
async fn cascade_when_the_account_removes_the_issuing_apps_access() {
    // Simulated directly on the membership (no proof row is touched).
    let w = World::new().await;
    let (p, v) = after(
        &w,
        "update memberships set status = 'access_removed', access_removed_at = now() \
         where app_id = '{dm}' and account_uuid = '{uuid}'",
    )
    .await;
    assert_eq!(v, invalid());
    let stored = w
        .text(&format!(
            "select revoked_at::text from proof_families where id = '{}'",
            proof_id(&p)
        ))
        .await;
    assert_eq!(stored, None, "verify checks the membership live");

    // Only the membership was flipped here (the real removal also revokes the sign-in and the
    // proof; see the next test), so flipping it back makes the grant whole again.
    w.ctx
        .exec(&format!(
            "update memberships set status = 'active', access_removed_at = null \
             where app_id = '{}' and account_uuid = '{}'",
            w.dm.app_id, w.carbon.uuid
        ))
        .await;
    assert_eq!(w.verify_bc(&token(&p)).await["valid"], true);
}

#[tokio::test]
async fn cascade_through_the_core_remove_access_path() {
    let w = World::new().await;
    let p = w.issue_user_verification().await;
    let mut conn = w.ctx.conn().await;
    let removed = accounts_core::repo::memberships::remove_access(
        &mut conn,
        &w.dm.app_id,
        &w.carbon.uuid,
        &w.carbon.uuid,
    )
    .await
    .expect("remove access");
    drop(conn);
    assert_eq!(removed.revoked_proofs, 1);
    assert_eq!(w.verify_bc(&token(&p)).await, invalid());
    // Even after signing in again, the old proof stays dead (its sign-in was revoked).
    w.ctx
        .membership(&w.dm.app_id, &w.carbon.uuid, &[Scope::Profile])
        .await;
    assert_eq!(w.verify_bc(&token(&p)).await, invalid());
}

#[tokio::test]
async fn cascade_when_the_subject_sign_in_is_revoked_or_expires() {
    let w = World::new().await;
    let (_, v) = after(
        &w,
        "update token_families set revoked_at = now(), revoke_reason = 'stk_rotated' where id = '{fid}'",
    )
    .await;
    assert_eq!(v, invalid());

    let w = World::new().await;
    let (_, v) = after(
        &w,
        "update token_families set expires_at = now() - interval '1 second' where id = '{fid}'",
    )
    .await;
    assert_eq!(v, invalid());
}

#[tokio::test]
async fn cascade_when_the_account_is_deleted_or_inactive() {
    let w = World::new().await;
    let (_, v) = after(
        &w,
        "update accounts set status = 'deleted', deleted_at = now() where uuid = '{uuid}'",
    )
    .await;
    assert_eq!(v, invalid());

    // Through the real deletion path too.
    let w = World::new().await;
    let p = w.issue_user_verification().await;
    let mut conn = w.ctx.conn().await;
    let deleted = accounts_core::repo::accounts::delete_account(
        &mut conn,
        &accounts_core::Settings::for_tests(),
        &w.carbon.uuid,
        "test",
        true,
    )
    .await
    .expect("delete");
    drop(conn);
    assert_eq!(deleted.revoked_proofs, 1);
    assert_eq!(w.verify_bc(&token(&p)).await, invalid());
}

#[tokio::test]
async fn cascade_when_the_issuing_app_is_disabled_and_back() {
    let w = World::new().await;
    let (p, v) = after(
        &w,
        "update apps set status = 'disabled' where app_id = '{dm}'",
    )
    .await;
    assert_eq!(v, invalid());
    w.ctx
        .exec(&format!(
            "update apps set status = 'active' where app_id = '{}'",
            w.dm.app_id
        ))
        .await;
    assert_eq!(
        w.verify_bc(&token(&p)).await["valid"],
        true,
        "a re-enabled app's proofs verify again"
    );
}

#[tokio::test]
async fn revoked_proofs_are_invalid() {
    let w = World::new().await;
    let (_, v) = after(&w, "update proof_families set revoked_at = now()").await;
    assert_eq!(v, invalid());
}

#[tokio::test]
async fn app_verification_proofs_ignore_account_state() {
    let w = World::new().await;
    let r = w
        .app_verification_as(
            &w.dm,
            &w.dm_secret,
            json!({"receiving_app": w.briefcase.app_id}),
        )
        .await;
    assert_eq!(r.status, 201);
    // Nothing about accounts matters to an app verification proof.
    w.ctx
        .exec(&format!(
            "update memberships set status = 'access_removed' where account_uuid = '{}'",
            w.carbon.uuid
        ))
        .await;
    assert_eq!(w.verify_bc(&token(&r.json)).await["valid"], true);
    // But the issuing app's status does.
    w.ctx
        .exec(&format!(
            "update apps set status = 'disabled' where app_id = '{}'",
            w.dm.app_id
        ))
        .await;
    assert_eq!(w.verify_bc(&token(&r.json)).await, invalid());
}
