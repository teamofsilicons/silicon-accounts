//! An OBO proof ends with the sign-in it stands on. These tests revoke the sign-in through the
//! core's real paths (an app signing the account out, an STK rotation, a reused sign-in refresh
//! token) and check that the proof is refused at once, listed as revoked with when and why, and
//! stored as revoked (with its `proof.revoked` audit entry) by the sweep, so the account's
//! history keeps it and its tokens are cleaned up later.

use accounts_core::models::Scope;
use accounts_core::repo::tokens::{self, RevokeFilter};
use accounts_core::test_support::Req;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::common::{World, api_time, invalid, proof_id, refresh_token, token};

/// The token family behind an access token.
fn family_of(w: &World, access_token: &str) -> Uuid {
    w.ctx
        .state
        .keys
        .jwt
        .verify_access(access_token, None)
        .expect("access token")
        .family_id()
        .expect("fid")
}

/// `(app listing item, account listing item)` of a proof.
async fn listed(w: &World, id: &str) -> (Value, Value) {
    let r = w
        .call(
            Req::get(&format!("/v1/apps/{}/proofs", w.dm.app_id)).basic(&w.dm.app_id, &w.dm_secret),
        )
        .await;
    assert_eq!(r.status, 200, "{}", r.json);
    let app = r.json["items"]
        .as_array()
        .and_then(|items| items.iter().find(|i| i["proof_id"] == id).cloned())
        .unwrap_or_else(|| panic!("{id} not in the app listing: {}", r.json));
    let fp = w.ctx.first_party_tokens(&w.carbon).await;
    let r = w
        .call(Req::get("/v1/me/proofs").bearer(&fp.access_token))
        .await;
    assert_eq!(r.status, 200, "{}", r.json);
    let mine = r.json["items"]
        .as_array()
        .and_then(|items| items.iter().find(|i| i["proof_id"] == id).cloned())
        .unwrap_or_else(|| panic!("{id} not in the account listing: {}", r.json));
    (app, mine)
}

/// Only the fields about the proof's end (the account listing has no audiences etc.).
fn end_of(item: &Value) -> Value {
    json!({
        "status": item["status"],
        "revoke_reason": item["revoke_reason"],
        "revoked_at": item["revoked_at"],
    })
}

/// `(actor_kind, actor_id, app_id, account_uuid, details)` of an audit entry.
type AuditRow = (
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Value,
);

async fn sweep(w: &World) -> accounts_proofs::store::SweepReport {
    accounts_proofs::store::sweep(&w.ctx.state.db)
        .await
        .expect("sweep")
}

#[tokio::test]
async fn signing_out_ends_the_proof_and_the_sweep_stores_it() {
    let w = World::new().await;
    let p = w.issue_obo().await;
    let id = proof_id(&p);
    let fid = w.subject_family();

    // The app signs the account out (what POST /v1/oauth/revoke does).
    let mut conn = w.ctx.conn().await;
    let revoked = tokens::revoke_family(&mut conn, fid, "app_revoked")
        .await
        .expect("revoke the sign-in");
    drop(conn);
    assert!(revoked.is_some());
    let signed_out_at = api_time(
        &w,
        &format!("select revoked_at from token_families where id = '{fid}'"),
    )
    .await;
    assert!(signed_out_at.is_some());

    // Refused at once (checked live), and listed as revoked with when and why.
    assert_eq!(w.verify_bc(&token(&p)).await, invalid());
    let (app, mine) = listed(&w, &id).await;
    let expected = json!({
        "status": "revoked",
        "revoke_reason": "sign_in_revoked",
        "revoked_at": signed_out_at,
    });
    assert_eq!(end_of(&app), expected);
    assert_eq!(end_of(&mine), expected);
    assert_eq!(
        w.text(&format!(
            "select revoked_at::text from proof_families where id = '{id}'"
        ))
        .await,
        None,
        "not stored before the sweep"
    );

    // The sweep stores it: revoked when the sign-in was, by the system, with its audit entry.
    let report = sweep(&w).await;
    assert_eq!(report.sign_in_revocations_recorded, 1, "{report:?}");
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
    let mut conn = w.ctx.conn().await;
    let audit: Vec<AuditRow> = sqlx::query_as(
        "select actor_kind, actor_id, app_id, account_uuid, details from audit_log \
         where action = 'proof.revoked' and target_kind = 'proof' and target_id = $1",
    )
    .bind(&id)
    .fetch_all(&mut *conn)
    .await
    .expect("audit");
    drop(conn);
    assert_eq!(audit.len(), 1, "{audit:?}");
    let (actor_kind, actor_id, app_id, account_uuid, details) = &audit[0];
    assert_eq!(actor_kind, "system");
    assert_eq!(actor_id, &None);
    assert_eq!(app_id.as_deref(), Some(w.dm.app_id.as_str()));
    assert_eq!(
        account_uuid.as_deref(),
        Some(w.carbon.uuid.as_str()),
        "shows in the account's history"
    );
    assert_eq!(
        details,
        &json!({
            "kind": "obo",
            "reason": "sign_in_revoked",
            "via": "sign_in_revoked",
            "audiences": [w.briefcase.app_id],
            "sign_in_revoke_reason": "app_revoked",
            "revoked_at": signed_out_at,
        })
    );

    // Storing it changes nothing the listings say.
    let (app_after, mine_after) = listed(&w, &id).await;
    assert_eq!(app_after, app);
    assert_eq!(mine_after, mine);
    // The account's history reads revoked proofs from proof_families (account crate).
    assert_eq!(
        w.count(&format!(
            "select count(*) from proof_families where account_uuid = '{}' and revoked_at is not null",
            w.carbon.uuid
        ))
        .await,
        1
    );

    // A second sweep stores nothing again.
    let report = sweep(&w).await;
    assert_eq!(report.sign_in_revocations_recorded, 0);
    assert_eq!(
        w.count(&format!(
            "select count(*) from audit_log where action = 'proof.revoked' and target_id = '{id}'"
        ))
        .await,
        1
    );
    // Revoking it again by id is a no-op (it is already revoked).
    let r = w
        .revoke_as(&w.dm, &w.dm_secret, json!({"proof_id": id}))
        .await;
    assert_eq!(r.status, 204);
    assert_eq!(
        w.text(&format!(
            "select revoke_reason from proof_families where id = '{id}'"
        ))
        .await
        .as_deref(),
        Some("sign_in_revoked")
    );

    // 30 days later the sweep deletes its tokens; the proof row stays as history.
    w.ctx
        .exec(&format!(
            "update proof_families set revoked_at = revoked_at - interval '31 days' where id = '{id}'"
        ))
        .await;
    let report = sweep(&w).await;
    assert_eq!(report.dead_family_tokens, 2, "{report:?}");
    assert_eq!(
        w.count(&format!(
            "select count(*) from proof_tokens where family_id = '{id}'"
        ))
        .await,
        0
    );
    assert_eq!(w.count("select count(*) from proof_families").await, 1);

    // Its deleted tokens are answered with the reason they may be unknown.
    let r = w.refresh(&refresh_token(&p)).await;
    assert_eq!(r.status, 400);
    assert_eq!(r.error_code(), Some("invalid_proof_refresh_token"));
    assert!(
        r.json["error"]["message"]
            .as_str()
            .is_some_and(|m| m.contains("revoked or expired more than 30 days ago")),
        "{}",
        r.json
    );
    let r = w
        .revoke_as(&w.dm, &w.dm_secret, json!({"proof_token": token(&p)}))
        .await;
    assert_eq!(r.status, 404);
    assert_eq!(r.error_code(), Some("proof_not_found"));
    assert!(
        r.json["error"]["message"]
            .as_str()
            .is_some_and(|m| m.contains("no longer stored")),
        "{}",
        r.json
    );
    assert!(
        r.json["error"]["hint"]
            .as_str()
            .is_some_and(|h| h.contains("proof_id")),
        "{}",
        r.json
    );
    let r = w
        .revoke_as(
            &w.dm,
            &w.dm_secret,
            json!({"proof_refresh_token": refresh_token(&p)}),
        )
        .await;
    assert_eq!(r.status, 404);
    assert!(
        r.json["error"]["message"]
            .as_str()
            .is_some_and(|m| m.contains("more than 30 days ago")),
        "{}",
        r.json
    );
}

#[tokio::test]
async fn every_core_sign_in_revocation_ends_its_proofs() {
    let w = World::new().await;
    let state = &w.ctx.state;

    // A: the sign-in's refresh token is reused at POST /v1/oauth/token (core refresh): the
    // whole sign-in is revoked.
    let reused = w.issue_obo().await;
    tokens::refresh(
        &state.db,
        &state.keys,
        &state.settings,
        &w.subject_refresh,
        &w.dm.app_id,
    )
    .await
    .expect("first sign-in refresh");
    let again = tokens::refresh(
        &state.db,
        &state.keys,
        &state.settings,
        &w.subject_refresh,
        &w.dm.app_id,
    )
    .await;
    assert!(
        matches!(again, Err(tokens::GrantError::Reused { .. })),
        "{again:?}"
    );

    // B: a Silicon's STK is rotated (all of its sign-ins revoked, as the custodian path does).
    let (si, _) = w.ctx.silicon(&w.carbon.uuid).await;
    w.ctx
        .membership(&w.dm.app_id, &si.uuid, &[Scope::Profile])
        .await;
    let si_tokens = w.ctx.tokens_for(&si, &w.dm.app_id, &[Scope::Profile]).await;
    let rotated = w
        .obo(json!({"subject_token": si_tokens.access_token, "receiving_app": w.briefcase.app_id}))
        .await;
    assert_eq!(rotated.status, 201, "{}", rotated.json);
    let mut conn = w.ctx.conn().await;
    let families = tokens::revoke_families(
        &mut conn,
        &RevokeFilter {
            account_uuid: &si.uuid,
            ..Default::default()
        },
        "stk_rotated",
    )
    .await
    .expect("rotate");
    drop(conn);
    assert_eq!(families.len(), 1);

    // C: a proof on a live sign-in (the Carbon signed into dm again) is untouched.
    let live_tokens = w
        .ctx
        .tokens_for(&w.carbon, &w.dm.app_id, &[Scope::Profile])
        .await;
    let live = w
        .obo(
            json!({"subject_token": live_tokens.access_token, "receiving_app": w.briefcase.app_id}),
        )
        .await;
    assert_eq!(live.status, 201, "{}", live.json);

    // D: a proof that expired on its own before its sign-in was revoked stays expired.
    let late_tokens = w
        .ctx
        .tokens_for(&w.carbon, &w.dm.app_id, &[Scope::Profile])
        .await;
    let expired = w
        .obo(
            json!({"subject_token": late_tokens.access_token, "receiving_app": w.briefcase.app_id}),
        )
        .await;
    assert_eq!(expired.status, 201, "{}", expired.json);
    w.ctx
        .exec(&format!(
            "update proof_families set expires_at = now() - interval '1 hour' where id = '{}'",
            proof_id(&expired.json)
        ))
        .await;
    let mut conn = w.ctx.conn().await;
    tokens::revoke_family(
        &mut conn,
        family_of(&w, &late_tokens.access_token),
        "app_revoked",
    )
    .await
    .expect("revoke")
    .expect("was live");
    drop(conn);

    // Refused at once.
    assert_eq!(w.verify_bc(&token(&reused)).await, invalid());
    assert_eq!(w.verify_bc(&token(&rotated.json)).await, invalid());
    assert_eq!(w.verify_bc(&token(&live.json)).await["valid"], true);

    let report = sweep(&w).await;
    assert_eq!(report.sign_in_revocations_recorded, 2, "{report:?}");
    for (proof, account, why) in [
        (&reused, &w.carbon.uuid, "refresh_token_reuse"),
        (&rotated.json, &si.uuid, "stk_rotated"),
    ] {
        let id = proof_id(proof);
        assert_eq!(
            w.text(&format!(
                "select revoked_by || '/' || revoke_reason from proof_families where id = '{id}'"
            ))
            .await
            .as_deref(),
            Some("system/sign_in_revoked"),
            "{why}"
        );
        assert_eq!(
            w.count(&format!(
                "select count(*) from audit_log where action = 'proof.revoked' and target_id = '{id}' \
                 and account_uuid = '{account}' and details->>'sign_in_revoke_reason' = '{why}'"
            ))
            .await,
            1,
            "{why}"
        );
    }
    for untouched in [&live.json, &expired.json] {
        assert_eq!(
            w.text(&format!(
                "select revoked_at::text from proof_families where id = '{}'",
                proof_id(untouched)
            ))
            .await,
            None
        );
    }
    let (app, mine) = listed(&w, &proof_id(&expired.json)).await;
    for item in [&app, &mine] {
        assert_eq!(
            end_of(item),
            json!({"status": "expired", "revoke_reason": null, "revoked_at": null})
        );
    }
    let (app, _) = listed(&w, &proof_id(&live.json)).await;
    assert_eq!(app["status"], "active");
    assert_eq!(w.verify_bc(&token(&live.json)).await["valid"], true);
}

#[tokio::test]
async fn revoking_after_the_sign_in_ended_keeps_the_first_end() {
    // The proof already ended with its sign-in; a later revoke (the app tidying up after
    // signing the account out, or the account on the site) is a no-op that stores that end.
    let w = World::new().await;
    let p = w.issue_obo().await;
    let id = proof_id(&p);
    let fid = w.subject_family();
    w.ctx
        .exec(&format!(
            "update token_families set revoked_at = now(), revoke_reason = 'app_revoked' where id = '{fid}'"
        ))
        .await;
    let signed_out_at = api_time(
        &w,
        &format!("select revoked_at from token_families where id = '{fid}'"),
    )
    .await;

    let r = w
        .revoke_as(&w.dm, &w.dm_secret, json!({"proof_id": id}))
        .await;
    assert_eq!(r.status, 204, "{}", r.json);
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
    let audits = format!(
        "select count(*) from audit_log where action = 'proof.revoked' and target_id = '{id}'"
    );
    assert_eq!(w.count(&audits).await, 1);
    assert_eq!(
        w.count(&format!("{audits} and actor_kind = 'system'"))
            .await,
        1
    );

    // The account revoking it on the site: also a no-op now.
    let cookie = w.ctx.browser_session(&w.carbon).await;
    let r = w
        .call(Req::delete(&format!("/v1/me/proofs/{id}")).session(&w.ctx.state.settings, &cookie))
        .await;
    assert_eq!(r.status, 204, "{}", r.json);
    assert_eq!(w.count(&audits).await, 1);
    let (app, mine) = listed(&w, &id).await;
    for item in [&app, &mine] {
        assert_eq!(
            end_of(item),
            json!({"status": "revoked", "revoke_reason": "sign_in_revoked", "revoked_at": signed_out_at})
        );
    }
}

#[tokio::test]
async fn a_proof_never_ends_before_it_was_issued() {
    // The sign-in was revoked while the proof was being issued (the subject check and the
    // insert are separate steps): the proof ends at its own creation, never before it.
    let w = World::new().await;
    let p = w.issue_obo().await;
    let id = proof_id(&p);
    w.ctx
        .exec(&format!(
            "update token_families set revoked_at = now() - interval '5 seconds', revoke_reason = 'app_revoked' where id = '{}'",
            w.subject_family()
        ))
        .await;
    let created_at = api_time(
        &w,
        &format!("select created_at from proof_families where id = '{id}'"),
    )
    .await;
    let (app, _) = listed(&w, &id).await;
    assert_eq!(app["revoked_at"], json!(created_at));
    assert_eq!(app["revoke_reason"], "sign_in_revoked");
    assert_eq!(sweep(&w).await.sign_in_revocations_recorded, 1);
    assert_eq!(
        api_time(
            &w,
            &format!("select revoked_at from proof_families where id = '{id}'")
        )
        .await,
        created_at
    );
}
