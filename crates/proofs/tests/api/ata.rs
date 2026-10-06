//! ATA proofs: `POST /v1/proofs/ata` and the ATA page stand-in `POST /v1/apps/{app_id}/proofs/ata`.

use accounts_core::test_support::Req;
use serde_json::json;

use crate::common::{World, assert_token_ttl, invalid, proof_id, token};

#[tokio::test]
async fn ata_proof_verifies_for_every_audience_and_nobody_else() {
    let w = World::new().await;
    let (remind, remind_secret) = w.ctx.app("remind").await;
    let (waveform, waveform_secret) = w.ctx.app("waveform").await;
    let (commit, commit_secret) = w.ctx.app("commit").await;
    let r = w
        .ata_as(
            &commit,
            &commit_secret,
            json!({
                "audiences": [remind.app_id, waveform.app_id, remind.app_id.to_uppercase()],
                "scopes": ["notifications.send"],
                "access_ttl_seconds": 300
            }),
        )
        .await;
    assert_eq!(r.status, 201, "{}", r.json);
    let b = &r.json;
    assert_eq!(b["kind"], "ata");
    assert_eq!(b["issuing_app"], commit.app_id);
    assert_eq!(
        b["receiving_apps"],
        json!([remind.app_id, waveform.app_id]),
        "deduplicated, order kept"
    );
    assert!(b.get("receiving_app").is_none());
    assert_eq!(b["user"], serde_json::Value::Null);
    assert_token_ttl(b, 300);
    assert_eq!(b["scopes"], json!(["notifications.send"]));
    let parsed: silicon_accounts_client::IssuedProof =
        serde_json::from_value(b.clone()).expect("client parses an ATA IssuedProof");
    assert_eq!(parsed.receiving_apps.len(), 2);
    assert!(parsed.user.is_none());

    let t = token(b);
    for (app, secret) in [(&remind, &remind_secret), (&waveform, &waveform_secret)] {
        let v = w.verify_as(app, secret, &t).await;
        assert_eq!(v.status, 200);
        assert_eq!(v.json["valid"], true, "{}", v.json);
        assert_eq!(v.json["kind"], "ata");
        assert_eq!(v.json["issuing_app"]["app_id"], commit.app_id);
        assert_eq!(v.json["issuing_app"]["name"], commit.name);
        assert_eq!(
            v.json["receiving_app"]["app_id"], app.app_id,
            "the verifier"
        );
        assert_eq!(v.json["receiving_app"]["name"], app.name);
        assert_eq!(v.json["user"], serde_json::Value::Null);
        assert_eq!(v.json["proof_id"], b["proof_id"]);
        assert_eq!(v.json["expires_at"], b["expires_at"]);
    }
    // A non-audience app, and the issuer itself, get exactly the invalid shape.
    let v = w.verify_as(&w.other, &w.other_secret, &t).await;
    assert_eq!(v.json, invalid());
    let v = w.verify_as(&commit, &commit_secret, &t).await;
    assert_eq!(v.json, invalid());

    // Audit (no account: ATA is about apps).
    let n = w
        .count(&format!(
            "select count(*) from audit_log where action = 'proof.issued' and target_id = '{}' \
             and account_uuid is null and details->>'kind' = 'ata'",
            proof_id(b)
        ))
        .await;
    assert_eq!(n, 1);
}

#[tokio::test]
async fn ata_audiences_are_validated() {
    let w = World::new().await;
    let ata = |body| w.ata_as(&w.dm, &w.dm_secret, body);

    let r = ata(json!({"audiences": []})).await;
    assert_eq!(r.status, 422);
    assert!(r.json["error"]["details"]["fields"]["audiences"].is_string());

    let r = ata(json!({})).await;
    assert_eq!(r.status, 422, "audiences is required: {}", r.json);

    let r = ata(json!({"audiences": ["ok-app", "Bad App!"]})).await;
    assert_eq!(r.status, 422);
    assert!(r.json["error"]["details"]["fields"]["audiences[1]"].is_string());

    let many: Vec<String> = (0..21).map(|i| format!("app-{i}")).collect();
    let r = ata(json!({"audiences": many})).await;
    assert_eq!(r.status, 422);
    assert!(
        r.json["error"]["details"]["fields"]["audiences"]
            .as_str()
            .is_some_and(|m| m.contains("at most 20"))
    );

    let r = ata(json!({"audiences": [w.briefcase.app_id, "ghost-one", "ghost-two"]})).await;
    assert_eq!(r.status, 400);
    assert_eq!(r.error_code(), Some("unknown_receiving_app"));
    assert_eq!(
        r.json["error"]["details"]["app_ids"],
        json!(["ghost-one", "ghost-two"])
    );

    let r = ata(json!({"audiences": [w.briefcase.app_id, w.dm.app_id]})).await;
    assert_eq!(r.status, 400);
    assert_eq!(r.error_code(), Some("invalid_receiving_app"));

    let r = ata(json!({"audiences": ["accounts"]})).await;
    assert_eq!(r.status, 400);
    assert_eq!(r.error_code(), Some("invalid_receiving_app"));
    assert_eq!(r.json["error"]["details"]["app_ids"], json!(["accounts"]));

    w.ctx
        .exec(&format!(
            "update apps set status = 'disabled' where app_id = '{}'",
            w.other.app_id
        ))
        .await;
    let r = ata(json!({"audiences": [w.briefcase.app_id, w.other.app_id]})).await;
    assert_eq!(r.status, 403);
    assert_eq!(r.error_code(), Some("receiving_app_disabled"));
    assert_eq!(
        r.json["error"]["details"]["app_ids"],
        json!([w.other.app_id])
    );

    let r = ata(json!({"audiences": [w.briefcase.app_id], "access_ttl_seconds": 30})).await;
    assert_eq!(r.status, 422);

    assert_eq!(w.count("select count(*) from proof_families").await, 0);
}

#[tokio::test]
async fn the_ata_page_works_for_the_app_and_its_owner() {
    let w = World::new().await;
    let owner = w.ctx.carbon().await;
    let stranger = w.ctx.carbon().await;
    let (commit, commit_secret) = w.ctx.app_owned("commit", Some(&owner.uuid)).await;
    let path = format!("/v1/apps/{}/proofs/ata", commit.app_id);
    let body = json!({"audiences": [w.briefcase.app_id], "scopes": ["ping"]});

    // The owner, with the account site's session cookie.
    let cookie = w.ctx.browser_session(&owner).await;
    let r = w
        .call(
            Req::post(&path)
                .session(&w.ctx.state.settings, &cookie)
                .json(body.clone()),
        )
        .await;
    assert_eq!(r.status, 201, "{}", r.json);
    assert_eq!(r.json["issuing_app"], commit.app_id);
    let by_owner = proof_id(&r.json);
    let v = w.verify_bc(&token(&r.json)).await;
    assert_eq!(v["valid"], true);
    assert_eq!(v["issuing_app"]["app_id"], commit.app_id);
    let actor = w
        .text(&format!(
            "select actor_kind || ':' || actor_id from audit_log where action = 'proof.issued' and target_id = '{by_owner}'"
        ))
        .await;
    assert_eq!(actor, Some(format!("account:{}", owner.uuid)));

    // The owner with a first-party bearer token (CLI).
    let fp = w.ctx.first_party_tokens(&owner).await;
    let r = w
        .call(Req::post(&path).bearer(&fp.access_token).json(body.clone()))
        .await;
    assert_eq!(r.status, 201, "{}", r.json);

    // The app itself.
    let r = w
        .call(
            Req::post(&path)
                .basic(&commit.app_id, &commit_secret)
                .json(body.clone()),
        )
        .await;
    assert_eq!(r.status, 201, "{}", r.json);

    // Another Carbon → 403 not_app_owner; another app's credentials → 403 app_mismatch.
    let cookie2 = w.ctx.browser_session(&stranger).await;
    let r = w
        .call(
            Req::post(&path)
                .session(&w.ctx.state.settings, &cookie2)
                .json(body.clone()),
        )
        .await;
    assert_eq!(r.status, 403);
    assert_eq!(r.error_code(), Some("not_app_owner"));
    let r = w
        .call(
            Req::post(&path)
                .basic(&w.dm.app_id, &w.dm_secret)
                .json(body.clone()),
        )
        .await;
    assert_eq!(r.status, 403);
    assert_eq!(r.error_code(), Some("app_mismatch"));
    // Cookie-authenticated POST without the site's Origin → CSRF guard.
    let r = w
        .call(
            Req::post(&path)
                .header("cookie", &format!("sa_session={cookie}"))
                .json(body.clone()),
        )
        .await;
    assert_eq!(r.status, 403);
    assert_eq!(r.error_code(), Some("origin_not_allowed"));

    // Idempotent per caller.
    let send = || {
        Req::post(&path)
            .session(&w.ctx.state.settings, &cookie)
            .header("idempotency-key", "ata-page-1")
            .json(body.clone())
    };
    let a = w.call(send()).await;
    let b = w.call(send()).await;
    assert_eq!(a.status, 201);
    assert_eq!(b.json, a.json);
    assert_eq!(
        b.headers
            .get("idempotent-replayed")
            .and_then(|v| v.to_str().ok()),
        Some("true")
    );

    // A disabled app can't issue from its page.
    w.ctx
        .exec(&format!(
            "update apps set status = 'disabled' where app_id = '{}'",
            commit.app_id
        ))
        .await;
    let r = w
        .call(
            Req::post(&path)
                .session(&w.ctx.state.settings, &cookie)
                .json(body.clone()),
        )
        .await;
    assert_eq!(r.status, 403);
    assert_eq!(r.error_code(), Some("app_disabled"));

    // Unknown app.
    let r = w
        .call(
            Req::post("/v1/apps/no-such-app/proofs/ata")
                .session(&w.ctx.state.settings, &cookie)
                .json(body),
        )
        .await;
    assert_eq!(r.status, 404);
    assert_eq!(r.error_code(), Some("unknown_app"));
}
