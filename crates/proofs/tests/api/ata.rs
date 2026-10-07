//! ATA proofs (always for exactly one app): `POST /v1/proofs/ata` and the app's ATA page
//! `POST /v1/apps/{app_id}/proofs/ata`.

use accounts_core::test_support::Req;
use serde_json::json;

use crate::common::{World, assert_token_ttl, invalid, proof_id, token};

#[tokio::test]
async fn an_ata_proof_verifies_for_its_one_app_and_nobody_else() {
    let w = World::new().await;
    let (remind, remind_secret) = w.ctx.app("remind").await;
    let (waveform, waveform_secret) = w.ctx.app("waveform").await;
    let (commit, commit_secret) = w.ctx.app("commit").await;
    let r = w
        .ata_as(
            &commit,
            &commit_secret,
            json!({
                "receiving_app": remind.app_id.to_uppercase(),
                "scopes": ["notifications.send"],
                "access_ttl_seconds": 300
            }),
        )
        .await;
    assert_eq!(r.status, 201, "{}", r.json);
    let b = &r.json;
    assert_eq!(b["kind"], "ata");
    assert_eq!(b["issuing_app"], commit.app_id);
    assert_eq!(b["receiving_app"], remind.app_id, "normalized like OBO");
    assert!(b.get("receiving_apps").is_none());
    assert_eq!(b["user"], serde_json::Value::Null);
    assert_token_ttl(b, 300);
    assert_eq!(b["scopes"], json!(["notifications.send"]));
    let parsed: silicon_accounts_client::IssuedProof =
        serde_json::from_value(b.clone()).expect("client parses an ATA IssuedProof");
    assert_eq!(
        parsed.receiving_app.as_deref(),
        Some(remind.app_id.as_str())
    );
    assert!(parsed.user.is_none());

    let t = token(b);
    let v = w.verify_as(&remind, &remind_secret, &t).await;
    assert_eq!(v.status, 200);
    assert_eq!(v.json["valid"], true, "{}", v.json);
    assert_eq!(v.json["kind"], "ata");
    assert_eq!(v.json["issuing_app"]["app_id"], commit.app_id);
    assert_eq!(v.json["issuing_app"]["name"], commit.name);
    assert_eq!(v.json["receiving_app"]["app_id"], remind.app_id);
    assert_eq!(v.json["receiving_app"]["name"], remind.name);
    assert_eq!(v.json["user"], serde_json::Value::Null);
    assert_eq!(v.json["proof_id"], b["proof_id"]);
    assert_eq!(v.json["expires_at"], b["expires_at"]);
    // Another app — even one the issuer also talks to —, an unrelated app and the issuer
    // itself get exactly the invalid shape.
    for (app, secret) in [
        (&waveform, &waveform_secret),
        (&w.other, &w.other_secret),
        (&commit, &commit_secret),
    ] {
        assert_eq!(w.verify_as(app, secret, &t).await.json, invalid());
    }

    // Talking to a second app takes a second proof, which only that app verifies.
    let second = w
        .ata_as(
            &commit,
            &commit_secret,
            json!({"receiving_app": waveform.app_id}),
        )
        .await;
    assert_eq!(second.status, 201, "{}", second.json);
    assert_ne!(second.json["proof_id"], b["proof_id"]);
    let t2 = token(&second.json);
    assert_eq!(
        w.verify_as(&waveform, &waveform_secret, &t2).await.json["valid"],
        true
    );
    assert_eq!(
        w.verify_as(&remind, &remind_secret, &t2).await.json,
        invalid()
    );

    // Audit (no account: ATA is about apps).
    let n = w
        .count(&format!(
            "select count(*) from audit_log where action = 'proof.issued' and target_id = '{}' \
             and account_uuid is null and details->>'kind' = 'ata' and details->>'receiving_app' = '{}'",
            proof_id(b),
            remind.app_id
        ))
        .await;
    assert_eq!(n, 1);
    // Stored as a one-app audience list.
    let stored = w
        .text(&format!(
            "select array_to_string(audiences, ',') from proof_families where id = '{}'",
            proof_id(b)
        ))
        .await;
    assert_eq!(stored, Some(remind.app_id.clone()));
}

#[tokio::test]
async fn ata_requests_are_validated() {
    let w = World::new().await;
    let ata = |body| w.ata_as(&w.dm, &w.dm_secret, body);

    // The pre-v2 shape names several apps: refused with its own code, whatever the list.
    for audiences in [
        json!([w.briefcase.app_id, w.other.app_id]),
        json!([w.briefcase.app_id]),
        json!([]),
    ] {
        let r = ata(json!({"audiences": audiences})).await;
        assert_eq!(r.status, 422, "{}", r.json);
        assert_eq!(r.error_code(), Some("ata_single_app"));
        assert_eq!(
            r.json["error"]["message"],
            "An ATA proof is for exactly one app; ask for one proof per app."
        );
        assert!(
            r.json["error"]["hint"]
                .as_str()
                .is_some_and(|h| h.contains("POST /v1/proofs/ata") && h.contains("receiving_app")),
            "{}",
            r.json
        );
    }
    let r = ata(json!({"audiences": [w.briefcase.app_id, w.other.app_id], "receiving_app": w.briefcase.app_id})).await;
    assert_eq!(r.error_code(), Some("ata_single_app"));
    assert_eq!(
        r.json["error"]["details"]["apps"],
        json!([w.briefcase.app_id, w.other.app_id])
    );

    let r = ata(json!({})).await;
    assert_eq!(r.status, 422, "receiving_app is required: {}", r.json);
    assert!(r.json["error"]["details"]["fields"]["receiving_app"].is_string());

    let r = ata(json!({"receiving_app": "Bad App!"})).await;
    assert_eq!(r.status, 422);
    assert!(r.json["error"]["details"]["fields"]["receiving_app"].is_string());

    let r = ata(json!({"receiving_app": [w.briefcase.app_id]})).await;
    assert_eq!(r.status, 422, "one app, as a string: {}", r.json);

    let r = ata(json!({"receiving_app": "ghost-one"})).await;
    assert_eq!(r.status, 400);
    assert_eq!(r.error_code(), Some("unknown_receiving_app"));
    assert_eq!(r.json["error"]["details"]["app_ids"], json!(["ghost-one"]));

    let r = ata(json!({"receiving_app": w.dm.app_id})).await;
    assert_eq!(r.status, 400);
    assert_eq!(r.error_code(), Some("invalid_receiving_app"));

    // Silicon Accounts' own apps never receive proofs.
    for own in ["accounts", "developer"] {
        let r = ata(json!({"receiving_app": own})).await;
        assert_eq!(r.status, 400, "{own}: {}", r.json);
        assert_eq!(r.error_code(), Some("invalid_receiving_app"));
        assert_eq!(r.json["error"]["details"]["app_ids"], json!([own]));
    }

    w.ctx
        .exec(&format!(
            "update apps set status = 'disabled' where app_id = '{}'",
            w.other.app_id
        ))
        .await;
    let r = ata(json!({"receiving_app": w.other.app_id})).await;
    assert_eq!(r.status, 403);
    assert_eq!(r.error_code(), Some("receiving_app_disabled"));
    assert_eq!(
        r.json["error"]["details"]["app_ids"],
        json!([w.other.app_id])
    );

    let r = ata(json!({"receiving_app": w.briefcase.app_id, "access_ttl_seconds": 30})).await;
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
    let body = json!({"receiving_app": w.briefcase.app_id, "scopes": ["ping"]});

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

    // The owner on the app's ATA page at developer.teamofsilicons.com (a developer platform
    // token), where several apps are refused with a hint naming this page's endpoint.
    let dev = w
        .ctx
        .tokens_for(
            &owner,
            "developer",
            &[accounts_core::models::Scope::Profile],
        )
        .await;
    let r = w
        .call(
            Req::post(&path)
                .bearer(&dev.access_token)
                .json(body.clone()),
        )
        .await;
    assert_eq!(r.status, 201, "{}", r.json);
    assert_eq!(r.json["receiving_app"], w.briefcase.app_id);
    let r = w
        .call(
            Req::post(&path)
                .bearer(&dev.access_token)
                .json(json!({"audiences": [w.briefcase.app_id, w.other.app_id]})),
        )
        .await;
    assert_eq!(r.status, 422, "{}", r.json);
    assert_eq!(r.error_code(), Some("ata_single_app"));
    assert!(
        r.json["error"]["hint"]
            .as_str()
            .is_some_and(|h| h.contains(&format!("POST {path}"))),
        "{}",
        r.json
    );
    // The developer platform token can't act for the owner outside the app's routes.
    let r = w
        .call(Req::get("/v1/me/proofs").bearer(&dev.access_token))
        .await;
    assert_eq!(r.status, 401, "{}", r.json);
    assert_eq!(r.error_code(), Some("token_wrong_audience"));
    // Nor can another Carbon's developer token manage this app.
    let dev2 = w
        .ctx
        .tokens_for(
            &stranger,
            "developer",
            &[accounts_core::models::Scope::Profile],
        )
        .await;
    let r = w
        .call(
            Req::post(&path)
                .bearer(&dev2.access_token)
                .json(body.clone()),
        )
        .await;
    assert_eq!(r.status, 403);
    assert_eq!(r.error_code(), Some("not_app_owner"));

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
