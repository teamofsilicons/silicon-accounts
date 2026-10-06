//! Revocation: `POST /v1/proofs/revoke`, `DELETE /v1/apps/{app_id}/proofs/{id}`,
//! `DELETE /v1/me/proofs/{id}`.

use accounts_core::test_support::Req;
use serde_json::json;

use crate::common::{World, invalid, proof_id, refresh_token, token};

#[tokio::test]
async fn the_issuing_app_revokes_by_id_token_or_refresh_token() {
    let w = World::new().await;
    for by in ["proof_id", "proof_token", "proof_refresh_token"] {
        let p = w.issue_obo().await;
        let value = match by {
            "proof_id" => proof_id(&p),
            "proof_token" => token(&p),
            _ => refresh_token(&p),
        };
        let body =
            serde_json::Value::Object([(by.to_string(), json!(value))].into_iter().collect());
        let r = w.revoke_as(&w.dm, &w.dm_secret, body.clone()).await;
        assert_eq!(r.status, 204, "{by}: {}", r.json);
        assert!(r.body.is_empty());
        assert_eq!(w.verify_bc(&token(&p)).await, invalid(), "{by}");
        let r = w.refresh(&refresh_token(&p)).await;
        assert_eq!(r.error_code(), Some("proof_revoked"), "{by}");
        assert_eq!(r.json["error"]["details"]["reason"], "revoked_by_app");
        let row = w
            .text(&format!(
                "select revoked_by || '/' || revoke_reason from proof_families where id = '{}'",
                proof_id(&p)
            ))
            .await;
        assert_eq!(row, Some(format!("app:{}/revoked_by_app", w.dm.app_id)));
        let audited = w
            .count(&format!(
                "select count(*) from audit_log where action = 'proof.revoked' and target_id = '{}' \
                 and account_uuid = '{}' and details->>'via' = '{by}'",
                proof_id(&p),
                w.carbon.uuid
            ))
            .await;
        assert_eq!(audited, 1, "{by}");

        // Revoking again is a no-op (204, no second audit entry).
        let r = w.revoke_as(&w.dm, &w.dm_secret, body).await;
        assert_eq!(r.status, 204);
        let audited = w
            .count(&format!(
                "select count(*) from audit_log where action = 'proof.revoked' and target_id = '{}'",
                proof_id(&p)
            ))
            .await;
        assert_eq!(audited, 1);
    }
}

#[tokio::test]
async fn revoke_refusals_are_precise() {
    let w = World::new().await;
    let p = w.issue_obo().await;

    // Another app: by id it looks unknown (no existence leak), by token it is named.
    let r = w
        .revoke_as(
            &w.briefcase,
            &w.briefcase_secret,
            json!({"proof_id": proof_id(&p)}),
        )
        .await;
    assert_eq!(r.status, 404);
    assert_eq!(r.error_code(), Some("proof_not_found"));
    let r = w
        .revoke_as(
            &w.briefcase,
            &w.briefcase_secret,
            json!({"proof_token": token(&p)}),
        )
        .await;
    assert_eq!(r.status, 403);
    assert_eq!(r.error_code(), Some("not_issuing_app"));
    assert_eq!(w.verify_bc(&token(&p)).await["valid"], true, "still valid");

    // Unknown / malformed references.
    let r = w
        .revoke_as(
            &w.dm,
            &w.dm_secret,
            json!({"proof_id": uuid::Uuid::now_v7()}),
        )
        .await;
    assert_eq!(r.status, 404);
    let r = w
        .revoke_as(&w.dm, &w.dm_secret, json!({"proof_id": "nope"}))
        .await;
    assert_eq!(r.status, 400);
    assert_eq!(r.error_code(), Some("invalid_proof_id"));
    let message = r.json["error"]["message"].as_str().unwrap_or_default();
    assert!(message.contains("'nope' is not a proof id"), "{message}");
    // A token pasted as an id is never echoed back: alone, or behind a label (the fake apps'
    // own "Proof <token>" scheme, an Authorization header value, a key=value pair).
    let secret_part = token(&p)[4..].to_string();
    for (sent, what) in [
        (token(&p), "a proof token."),
        (
            format!("Bearer {}", token(&p)),
            "a proof token with other text around it",
        ),
        (
            format!("Proof {}", token(&p)),
            "a proof token with other text around it",
        ),
        (
            format!("proof_refresh_token={}", refresh_token(&p)),
            "a proof refresh token with other text around it",
        ),
        (w.subject_token.clone(), "a JWT access token"),
    ] {
        let r = w
            .revoke_as(&w.dm, &w.dm_secret, json!({"proof_id": sent}))
            .await;
        assert_eq!(r.status, 400);
        assert_eq!(r.error_code(), Some("invalid_proof_id"));
        let body = r.json.to_string();
        assert!(!body.contains(&secret_part), "echoed: {body}");
        assert!(!body.contains(&refresh_token(&p)[5..]), "echoed: {body}");
        assert!(!body.contains(&w.subject_token), "echoed: {body}");
        assert!(
            r.json["error"]["message"]
                .as_str()
                .is_some_and(|m| m.contains(what)),
            "{what}: {body}"
        );
    }
    // Something long and not id-shaped is described by its length, not repeated.
    let r = w
        .revoke_as(
            &w.dm,
            &w.dm_secret,
            json!({"proof_id": format!("x{}", secret_part)}),
        )
        .await;
    assert_eq!(r.error_code(), Some("invalid_proof_id"));
    assert!(!r.json.to_string().contains(&secret_part));
    assert!(
        r.json["error"]["message"]
            .as_str()
            .is_some_and(|m| m.contains("44 characters")),
        "{}",
        r.json
    );
    // The same rule for the path parameter of the DELETE routes.
    let r = w
        .call(
            Req::delete(&format!(
                "/v1/apps/{}/proofs/Bearer%20{}",
                w.dm.app_id,
                token(&p)
            ))
            .basic(&w.dm.app_id, &w.dm_secret),
        )
        .await;
    assert_eq!(r.status, 400);
    assert_eq!(r.error_code(), Some("invalid_proof_id"));
    assert!(!r.json.to_string().contains(&secret_part), "{}", r.json);
    let fp = w.ctx.first_party_tokens(&w.carbon).await;
    let r = w
        .call(Req::delete(&format!("/v1/me/proofs/Proof%20{}", token(&p))).bearer(&fp.access_token))
        .await;
    assert_eq!(r.status, 400);
    assert!(!r.json.to_string().contains(&secret_part), "{}", r.json);
    let r = w
        .revoke_as(
            &w.dm,
            &w.dm_secret,
            json!({"proof_token": format!("sap_{}", "C".repeat(43))}),
        )
        .await;
    assert_eq!(r.status, 404);
    // Wrong token kind in a field.
    let r = w
        .revoke_as(
            &w.dm,
            &w.dm_secret,
            json!({"proof_token": refresh_token(&p)}),
        )
        .await;
    assert_eq!(r.status, 422);
    assert!(
        r.json["error"]["details"]["fields"]["proof_token"]
            .as_str()
            .is_some_and(|m| m.contains("proof refresh token"))
    );
    // None or several references.
    let r = w.revoke_as(&w.dm, &w.dm_secret, json!({})).await;
    assert_eq!(r.status, 422);
    let r = w
        .revoke_as(
            &w.dm,
            &w.dm_secret,
            json!({"proof_id": proof_id(&p), "proof_token": token(&p)}),
        )
        .await;
    assert_eq!(r.status, 422);
    assert_eq!(w.verify_bc(&token(&p)).await["valid"], true);
}

#[tokio::test]
async fn the_app_page_revokes_for_the_app_or_its_owner() {
    let w = World::new().await;
    let owner = w.ctx.carbon().await;
    w.ctx
        .exec(&format!(
            "update apps set owner_uuid = '{}' where app_id = '{}'",
            owner.uuid, w.dm.app_id
        ))
        .await;
    let cookie = w.ctx.browser_session(&owner).await;

    let p1 = w.issue_obo().await;
    let r = w
        .call(
            Req::delete(&format!(
                "/v1/apps/{}/proofs/{}",
                w.dm.app_id,
                proof_id(&p1)
            ))
            .session(&w.ctx.state.settings, &cookie),
        )
        .await;
    assert_eq!(r.status, 204, "{}", r.json);
    assert_eq!(w.verify_bc(&token(&p1)).await, invalid());
    let row = w
        .text(&format!(
            "select revoked_by || '/' || revoke_reason from proof_families where id = '{}'",
            proof_id(&p1)
        ))
        .await;
    assert_eq!(row, Some(format!("{}/revoked_by_owner", owner.uuid)));

    let p2 = w.issue_obo().await;
    let r = w
        .call(
            Req::delete(&format!(
                "/v1/apps/{}/proofs/{}",
                w.dm.app_id,
                proof_id(&p2)
            ))
            .basic(&w.dm.app_id, &w.dm_secret),
        )
        .await;
    assert_eq!(r.status, 204);
    assert_eq!(w.verify_bc(&token(&p2)).await, invalid());

    // A proof of another app through this app's page → 404; another app's credentials → 403.
    let a = w
        .ata_as(
            &w.other,
            &w.other_secret,
            json!({"audiences": [w.briefcase.app_id]}),
        )
        .await;
    let r = w
        .call(
            Req::delete(&format!(
                "/v1/apps/{}/proofs/{}",
                w.dm.app_id,
                proof_id(&a.json)
            ))
            .basic(&w.dm.app_id, &w.dm_secret),
        )
        .await;
    assert_eq!(r.status, 404);
    let r = w
        .call(
            Req::delete(&format!(
                "/v1/apps/{}/proofs/{}",
                w.dm.app_id,
                proof_id(&p2)
            ))
            .basic(&w.other.app_id, &w.other_secret),
        )
        .await;
    assert_eq!(r.status, 403);
    assert_eq!(r.error_code(), Some("app_mismatch"));
    let r = w
        .call(
            Req::delete(&format!("/v1/apps/{}/proofs/not-a-uuid", w.dm.app_id))
                .basic(&w.dm.app_id, &w.dm_secret),
        )
        .await;
    assert_eq!(r.status, 400);
    assert_eq!(r.error_code(), Some("invalid_proof_id"));
}

#[tokio::test]
async fn an_account_revokes_proofs_issued_on_its_behalf() {
    let w = World::new().await;
    let p = w.issue_obo().await;
    let cookie = w.ctx.browser_session(&w.carbon).await;

    // Someone else can't (404, no existence leak), and an ATA proof is never "mine".
    let stranger = w.ctx.carbon().await;
    let fp = w.ctx.first_party_tokens(&stranger).await;
    let r = w
        .call(Req::delete(&format!("/v1/me/proofs/{}", proof_id(&p))).bearer(&fp.access_token))
        .await;
    assert_eq!(r.status, 404);
    assert_eq!(r.error_code(), Some("proof_not_found"));
    let ata = w
        .ata_as(
            &w.dm,
            &w.dm_secret,
            json!({"audiences": [w.briefcase.app_id]}),
        )
        .await;
    assert_eq!(ata.status, 201);
    let r = w
        .call(
            Req::delete(&format!("/v1/me/proofs/{}", proof_id(&ata.json)))
                .session(&w.ctx.state.settings, &cookie),
        )
        .await;
    assert_eq!(r.status, 404, "{}", r.json);
    assert_eq!(r.error_code(), Some("proof_not_found"));
    assert_eq!(
        w.verify_bc(&token(&ata.json)).await["valid"],
        true,
        "untouched"
    );

    // Cookie without the site's Origin → CSRF guard.
    let r = w
        .call(
            Req::delete(&format!("/v1/me/proofs/{}", proof_id(&p)))
                .header("cookie", &format!("sa_session={cookie}")),
        )
        .await;
    assert_eq!(r.status, 403);
    assert_eq!(r.error_code(), Some("origin_not_allowed"));

    let r = w
        .call(
            Req::delete(&format!("/v1/me/proofs/{}", proof_id(&p)))
                .session(&w.ctx.state.settings, &cookie),
        )
        .await;
    assert_eq!(r.status, 204, "{}", r.json);
    assert_eq!(w.verify_bc(&token(&p)).await, invalid());
    let row = w
        .text(&format!(
            "select revoked_by || '/' || revoke_reason from proof_families where id = '{}'",
            proof_id(&p)
        ))
        .await;
    assert_eq!(row, Some(format!("{}/revoked_by_account", w.carbon.uuid)));
    let actor = w
        .text(&format!(
            "select actor_kind || ':' || actor_id from audit_log where action = 'proof.revoked' and target_id = '{}'",
            proof_id(&p)
        ))
        .await;
    assert_eq!(actor, Some(format!("account:{}", w.carbon.uuid)));

    // Idempotent; bearer (CLI) works too.
    let mine = w.ctx.first_party_tokens(&w.carbon).await;
    let r = w
        .call(Req::delete(&format!("/v1/me/proofs/{}", proof_id(&p))).bearer(&mine.access_token))
        .await;
    assert_eq!(r.status, 204);

    // Unauthenticated.
    let r = w
        .call(Req::delete(&format!("/v1/me/proofs/{}", proof_id(&p))))
        .await;
    assert_eq!(r.status, 401);
}
