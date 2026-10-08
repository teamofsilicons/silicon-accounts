//! `POST /v1/proofs/user-verification`: issuance, every refusal, idempotency.

use accounts_core::models::Scope;
use accounts_core::test_support::Req;
use serde_json::json;

use crate::common::{World, assert_token_ttl, proof_id, refresh_token, token};

#[tokio::test]
async fn issues_an_user_verification_proof_with_the_contract_shape() {
    let w = World::new().await;
    let r = w.user_verification(w.user_verification_body()).await;
    assert_eq!(r.status, 201, "{}", r.json);
    assert_eq!(
        r.headers.get("cache-control").and_then(|v| v.to_str().ok()),
        Some("no-store")
    );
    let b = &r.json;
    assert_eq!(b["kind"], "user_verification");
    assert!(token(b).starts_with("sap_") && token(b).len() == 4 + 43);
    assert!(refresh_token(b).starts_with("sapr_") && refresh_token(b).len() == 5 + 43);
    assert_eq!(b["issuing_app"], w.dm.app_id);
    assert_eq!(b["receiving_app"], w.briefcase.app_id);
    assert!(b.get("receiving_apps").is_none());
    assert_eq!(b["user"]["uuid"], w.carbon.uuid);
    assert_eq!(b["user"]["id"], w.carbon.id());
    assert_eq!(b["user"]["kind"], "carbon");
    assert_eq!(
        b["user"]["membership_id"],
        format!("{}:{}", w.dm.app_id, w.carbon.uuid)
    );
    assert_eq!(b["scopes"], json!(["files.write"]));
    // Default proof token lifetime: 1800 s. Only the absolute expires_at is sent (a relative
    // expires_in would be stale in a replayed Idempotency-Key response).
    assert!(b.get("expires_in").is_none(), "{b}");
    let expires_at = accounts_core::timefmt::parse_rfc3339(b["expires_at"].as_str().expect("ts"))
        .expect("rfc3339");
    let left = (expires_at - time::OffsetDateTime::now_utc()).whole_seconds();
    assert!((1790..=1801).contains(&left), "{left}");
    assert!(
        b["expires_at"]
            .as_str()
            .is_some_and(|s| s.ends_with('Z') && s.len() == 24),
        "RFC 3339 UTC with milliseconds: {}",
        b["expires_at"]
    );
    let refresh_at =
        accounts_core::timefmt::parse_rfc3339(b["refresh_expires_at"].as_str().expect("ts"))
            .expect("rfc3339");
    let days = (refresh_at - time::OffsetDateTime::now_utc()).whole_days();
    assert!((899..=900).contains(&days), "proofs live 900 days: {days}");
    // Uuid v7 proof id.
    let id = uuid::Uuid::parse_str(&proof_id(b)).expect("uuid");
    assert_eq!(id.get_version_num(), 7);

    // Only hashes are stored.
    let n = w
        .count(&format!(
            "select count(*) from proof_tokens where family_id = '{id}'"
        ))
        .await;
    assert_eq!(n, 2, "one proof token + one proof refresh token");
    let raw = w
        .count(&format!(
            "select count(*) from proof_tokens where token_hash = convert_to('{}', 'UTF8')",
            token(b)
        ))
        .await;
    assert_eq!(raw, 0);

    // The family records the grant it stands on.
    let fam = w
        .text(&format!(
            "select subject_family_id::text from proof_families where id = '{id}'"
        ))
        .await;
    assert_eq!(fam, Some(w.subject_family().to_string()));

    // Audit: proof.issued, about the Carbon (shows in their history), by the app.
    let audit = w
        .count(&format!(
            "select count(*) from audit_log where action = 'proof.issued' and target_kind = 'proof' \
             and target_id = '{id}' and actor_kind = 'app' and actor_id = '{}' and app_id = '{}' \
             and account_uuid = '{}' and details->>'kind' = 'user_verification' and details->>'receiving_app' = '{}'",
            w.dm.app_id, w.dm.app_id, w.carbon.uuid, w.briefcase.app_id
        ))
        .await;
    assert_eq!(audit, 1);

    // The published Rust package parses it.
    let parsed: silicon_accounts_client::IssuedProof =
        serde_json::from_value(b.clone()).expect("client parses IssuedProof");
    assert_eq!(parsed.proof_id, proof_id(b));
    assert_eq!(
        parsed.receiving_app.as_deref(),
        Some(w.briefcase.app_id.as_str())
    );
    assert_eq!(
        parsed.user.as_ref().and_then(|u| u.membership_id.clone()),
        Some(format!("{}:{}", w.dm.app_id, w.carbon.uuid))
    );
    assert!(parsed.expires_at.is_some() && parsed.refresh_expires_at.is_some());
}

#[tokio::test]
async fn token_lifetime_and_scopes_are_validated() {
    let w = World::new().await;
    let p = w.issue_user_verification_ttl(60).await;
    assert_token_ttl(&p, 60);

    for (ttl, ok) in [
        (59, false),
        (60, true),
        (1800, true),
        (1801, false),
        (-5, false),
    ] {
        let mut body = w.user_verification_body();
        body["access_ttl_seconds"] = json!(ttl);
        let r = w.user_verification(body).await;
        if ok {
            assert_eq!(r.status, 201, "ttl {ttl}: {}", r.json);
        } else {
            assert_eq!(r.status, 422, "ttl {ttl}: {}", r.json);
            assert_eq!(r.error_code(), Some("validation_failed"));
            assert!(
                r.json["error"]["details"]["fields"]["access_ttl_seconds"]
                    .as_str()
                    .is_some_and(|m| m.contains("between 60 and 1800")),
                "{}",
                r.json
            );
        }
    }

    let mut body = w.user_verification_body();
    body["scopes"] = json!(["files.write", "files write", "", "x".repeat(101)]);
    body["access_ttl_seconds"] = json!(5000);
    let r = w.user_verification(body).await;
    assert_eq!(r.status, 422);
    let fields = &r.json["error"]["details"]["fields"];
    assert!(
        fields["scopes[1]"]
            .as_str()
            .is_some_and(|m| m.contains("' '")),
        "{fields}"
    );
    assert!(fields["scopes[2]"].is_string());
    assert!(
        fields["scopes[3]"]
            .as_str()
            .is_some_and(|m| m.contains("101"))
    );
    assert!(
        fields["access_ttl_seconds"].is_string(),
        "all problems reported at once"
    );

    let mut body = w.user_verification_body();
    body["scopes"] = json!((0..21).map(|i| format!("s{i}")).collect::<Vec<_>>());
    let r = w.user_verification(body).await;
    assert_eq!(r.status, 422);
    assert!(
        r.json["error"]["details"]["fields"]["scopes"]
            .as_str()
            .is_some_and(|m| m.contains("at most 20"))
    );

    // Duplicates collapse; 20 distinct scopes of 100 chars are fine.
    let mut body = w.user_verification_body();
    let mut scopes: Vec<String> = (0..20).map(|i| format!("{i:0>100}")).collect();
    scopes.push(scopes[0].clone());
    body["scopes"] = json!(scopes);
    let r = w.user_verification(body).await;
    assert_eq!(r.status, 201, "{}", r.json);
    assert_eq!(r.json["scopes"].as_array().map(Vec::len), Some(20));

    // No scopes at all → [].
    let r = w
        .user_verification(
            json!({"subject_token": w.subject_token, "receiving_app": w.briefcase.app_id}),
        )
        .await;
    assert_eq!(r.status, 201);
    assert_eq!(r.json["scopes"], json!([]));

    // Shape problems are named precisely.
    let r = w
        .user_verification(json!({"receiving_app": w.briefcase.app_id}))
        .await;
    assert_eq!(r.status, 422);
    assert!(r.json["error"]["details"]["fields"]["subject_token"].is_string());
    let r = w
        .user_verification(json!({"subject_token": w.subject_token, "receiving_app": w.briefcase.app_id, "scope": ["x"]}))
        .await;
    assert_eq!(r.status, 422, "unknown fields are refused: {}", r.json);
    assert!(
        r.json["error"]["message"]
            .as_str()
            .is_some_and(|m| m.contains("scope"))
    );
    let r = w
        .user_verification(json!({"subject_token": " ", "receiving_app": "Not An App!"}))
        .await;
    assert_eq!(r.status, 422);
    let fields = &r.json["error"]["details"]["fields"];
    assert!(
        fields["subject_token"].is_string() && fields["receiving_app"].is_string(),
        "{fields}"
    );
}

#[tokio::test]
async fn refuses_bad_subject_tokens_precisely() {
    let w = World::new().await;
    let body = |t: &str| json!({"subject_token": t, "receiving_app": w.briefcase.app_id});

    // A refresh token instead of the access token.
    let r = w.user_verification(body(&w.subject_refresh)).await;
    assert_eq!(r.status, 400);
    assert_eq!(r.error_code(), Some("invalid_subject_token"));
    assert_eq!(r.json["error"]["details"]["reason"], "not_an_access_token");
    assert!(
        r.json["error"]["message"]
            .as_str()
            .is_some_and(|m| m.contains("a refresh token"))
    );
    assert!(r.json["error"]["hint"].is_string());

    // The access token behind a label (copied from an Authorization header).
    let r = w
        .user_verification(body(&format!("Bearer {}", w.subject_token)))
        .await;
    assert_eq!(r.status, 400);
    assert_eq!(r.json["error"]["details"]["reason"], "not_an_access_token");
    assert!(
        r.json["error"]["message"]
            .as_str()
            .is_some_and(|m| m.contains("a JWT access token with other text around it")),
        "{}",
        r.json
    );
    assert!(!r.json.to_string().contains(&w.subject_token));

    // Garbage JWT.
    let r = w
        .user_verification(body("eyJhbGciOiJFZERTQSJ9.e30.AAAA"))
        .await;
    assert_eq!(r.status, 400);
    assert_eq!(r.json["error"]["details"]["reason"], "invalid");

    // Tampered signature (one character in the middle of the signature segment).
    let sig_at = w.subject_token.rfind('.').expect("jwt") + 10;
    let mut tampered: Vec<char> = w.subject_token.chars().collect();
    tampered[sig_at] = if tampered[sig_at] == 'A' { 'B' } else { 'A' };
    let tampered: String = tampered.into_iter().collect();
    let r = w.user_verification(body(&tampered)).await;
    assert_eq!(r.status, 400, "{}", r.json);
    assert_eq!(r.error_code(), Some("invalid_subject_token"));

    // Expired access token.
    let expired = w.expired_token(&w.carbon, &w.dm.app_id, w.subject_family());
    let r = w.user_verification(body(&expired)).await;
    assert_eq!(r.status, 400);
    assert_eq!(r.json["error"]["details"]["reason"], "expired");
    assert!(
        r.json["error"]["hint"]
            .as_str()
            .is_some_and(|h| h.contains("refresh_token"))
    );

    // A token the Carbon got at another app: dm can't turn it into a proof.
    w.ctx
        .membership(&w.other.app_id, &w.carbon.uuid, &[Scope::Profile])
        .await;
    let foreign = w
        .ctx
        .tokens_for(&w.carbon, &w.other.app_id, &[Scope::Profile])
        .await;
    let r = w.user_verification(body(&foreign.access_token)).await;
    assert_eq!(r.status, 403);
    assert_eq!(r.error_code(), Some("subject_token_wrong_app"));
    assert_eq!(r.json["error"]["details"]["token_app"], w.other.app_id);
    // Also a first-party (accounts) token.
    let first_party = w.ctx.first_party_tokens(&w.carbon).await;
    let r = w.user_verification(body(&first_party.access_token)).await;
    assert_eq!(r.error_code(), Some("subject_token_wrong_app"));

    // The sign-in behind it was revoked.
    let fid = w.subject_family();
    w.ctx
        .exec(&format!(
            "update token_families set revoked_at = now(), revoke_reason = 'user_signed_out' where id = '{fid}'"
        ))
        .await;
    let r = w.user_verification(body(&w.subject_token)).await;
    assert_eq!(r.status, 400);
    assert_eq!(r.json["error"]["details"]["reason"], "revoked");
    assert!(
        r.json["error"]["message"]
            .as_str()
            .is_some_and(|m| m.contains("user_signed_out"))
    );

    // The sign-in expired (time travel).
    w.ctx
        .exec(&format!(
            "update token_families set revoked_at = null, revoke_reason = null, expires_at = now() - interval '1 second' where id = '{fid}'"
        ))
        .await;
    let r = w.user_verification(body(&w.subject_token)).await;
    assert_eq!(r.status, 400);
    assert_eq!(r.json["error"]["details"]["reason"], "expired");
    assert_eq!(
        w.count("select count(*) from proof_families").await,
        0,
        "nothing was issued"
    );
}

#[tokio::test]
async fn refuses_inactive_memberships_and_accounts() {
    let w = World::new().await;
    // Membership access removed (simulated directly).
    w.ctx
        .exec(&format!(
            "update memberships set status = 'access_removed', access_removed_at = now() \
             where app_id = '{}' and account_uuid = '{}'",
            w.dm.app_id, w.carbon.uuid
        ))
        .await;
    let r = w.user_verification(w.user_verification_body()).await;
    assert_eq!(r.status, 403, "{}", r.json);
    assert_eq!(r.error_code(), Some("membership_inactive"));
    assert_eq!(
        r.json["error"]["details"]["membership_id"],
        format!("{}:{}", w.dm.app_id, w.carbon.uuid)
    );
    assert!(
        r.json["error"]["message"]
            .as_str()
            .is_some_and(|m| m.contains("access_removed"))
    );

    // No membership at all.
    w.ctx
        .exec(&format!(
            "delete from memberships where app_id = '{}' and account_uuid = '{}'",
            w.dm.app_id, w.carbon.uuid
        ))
        .await;
    let r = w.user_verification(w.user_verification_body()).await;
    assert_eq!(r.error_code(), Some("membership_inactive"));
    assert!(
        r.json["error"]["message"]
            .as_str()
            .is_some_and(|m| m.contains("there is no membership"))
    );

    // Account not active.
    w.ctx
        .membership(&w.dm.app_id, &w.carbon.uuid, &[Scope::Profile])
        .await;
    w.ctx
        .exec(&format!(
            "update accounts set status = 'unclaimed' where uuid = '{}'",
            w.carbon.uuid
        ))
        .await;
    let r = w.user_verification(w.user_verification_body()).await;
    assert_eq!(r.status, 403);
    assert_eq!(r.error_code(), Some("account_not_active"));
    assert_eq!(r.json["error"]["details"]["status"], "unclaimed");
}

#[tokio::test]
async fn refuses_bad_receiving_apps() {
    let w = World::new().await;
    let body = |app: &str| json!({"subject_token": w.subject_token, "receiving_app": app});

    let r = w.user_verification(body("no-such-app")).await;
    assert_eq!(r.status, 400);
    assert_eq!(r.error_code(), Some("unknown_receiving_app"));
    assert_eq!(
        r.json["error"]["details"]["app_ids"],
        json!(["no-such-app"])
    );
    assert!(
        r.json["error"]["message"]
            .as_str()
            .is_some_and(|m| m.contains("'no-such-app'"))
    );

    let r = w.user_verification(body(&w.dm.app_id)).await;
    assert_eq!(r.status, 400);
    assert_eq!(r.error_code(), Some("invalid_receiving_app"));
    assert!(
        r.json["error"]["message"]
            .as_str()
            .is_some_and(|m| m.contains("itself"))
    );

    let r = w.user_verification(body("accounts")).await;
    assert_eq!(r.status, 400);
    assert_eq!(r.error_code(), Some("invalid_receiving_app"));

    w.ctx
        .exec(&format!(
            "update apps set status = 'disabled' where app_id = '{}'",
            w.briefcase.app_id
        ))
        .await;
    let r = w.user_verification(body(&w.briefcase.app_id)).await;
    assert_eq!(r.status, 403);
    assert_eq!(r.error_code(), Some("receiving_app_disabled"));

    // App ids are case-insensitive and trimmed on input.
    let r = w
        .user_verification(body(&format!(" {} ", w.other.app_id.to_uppercase())))
        .await;
    assert_eq!(r.status, 201, "{}", r.json);
    assert_eq!(r.json["receiving_app"], w.other.app_id);
}

#[tokio::test]
async fn app_credentials_are_required_and_checked() {
    let w = World::new().await;
    let r = w
        .call(Req::post("/v1/proofs/user-verification").json(w.user_verification_body()))
        .await;
    assert_eq!(r.status, 401);
    assert_eq!(r.error_code(), Some("app_credentials_required"));
    let r = w
        .call(
            Req::post("/v1/proofs/user-verification")
                .basic(&w.dm.app_id, "sa_app_wrong")
                .json(w.user_verification_body()),
        )
        .await;
    assert_eq!(r.status, 401);
    assert_eq!(r.error_code(), Some("invalid_app_credentials"));
    // An account's bearer token is not app auth.
    let fp = w.ctx.first_party_tokens(&w.carbon).await;
    let r = w
        .call(
            Req::post("/v1/proofs/user-verification")
                .bearer(&fp.access_token)
                .json(w.user_verification_body()),
        )
        .await;
    assert_eq!(r.status, 401);
    // A disabled issuing app can't issue.
    w.ctx
        .exec(&format!(
            "update apps set status = 'disabled' where app_id = '{}'",
            w.dm.app_id
        ))
        .await;
    w.ctx.state.app_cache.invalidate(&w.dm.app_id);
    let r = w.user_verification(w.user_verification_body()).await;
    assert_eq!(r.status, 403);
    assert_eq!(r.error_code(), Some("app_disabled"));
    // Wrong content type.
    let r = w
        .call(
            Req::post("/v1/proofs/user-verification")
                .basic(&w.briefcase.app_id, &w.briefcase_secret)
                .form(&[("subject_token", "x"), ("receiving_app", "dm")]),
        )
        .await;
    assert_eq!(r.status, 400, "{}", r.json);
    assert_eq!(r.error_code(), Some("invalid_content_type"));
}

#[tokio::test]
async fn issuance_is_idempotent() {
    let w = World::new().await;
    let send = |key: &str, body: serde_json::Value| {
        Req::post("/v1/proofs/user-verification")
            .basic(&w.dm.app_id, &w.dm_secret)
            .header("idempotency-key", key)
            .json(body)
    };
    let first = w.call(send("k-1", w.user_verification_body())).await;
    assert_eq!(first.status, 201);
    assert!(first.headers.get("idempotent-replayed").is_none());
    let again = w.call(send("k-1", w.user_verification_body())).await;
    assert_eq!(again.status, 201);
    assert_eq!(
        again
            .headers
            .get("idempotent-replayed")
            .and_then(|v| v.to_str().ok()),
        Some("true")
    );
    assert_eq!(again.json, first.json, "same proof, same tokens");
    assert_eq!(w.count("select count(*) from proof_families").await, 1);
    assert_eq!(
        w.count("select count(*) from audit_log where action = 'proof.issued'")
            .await,
        1,
        "the retry did not issue twice"
    );

    // Same key, different body → 409.
    let mut other = w.user_verification_body();
    other["scopes"] = json!(["files.read"]);
    let r = w.call(send("k-1", other.clone())).await;
    assert_eq!(r.status, 409);
    assert_eq!(r.error_code(), Some("idempotency_key_reused"));

    // A new key issues a new proof.
    let r = w.call(send("k-2", other)).await;
    assert_eq!(r.status, 201);
    assert_ne!(proof_id(&r.json), proof_id(&first.json));

    // Keys are scoped per app and endpoint: another app may use the same key string.
    let r = w
        .call(
            Req::post("/v1/proofs/app-verification")
                .basic(&w.other.app_id, &w.other_secret)
                .header("idempotency-key", "k-1")
                .json(json!({"receiving_app": w.briefcase.app_id})),
        )
        .await;
    assert_eq!(r.status, 201, "{}", r.json);
    assert!(r.headers.get("idempotent-replayed").is_none());

    // Failures are not stored: a retry after fixing the cause succeeds with the same key.
    w.ctx
        .exec(&format!(
            "update apps set status = 'disabled' where app_id = '{}'",
            w.briefcase.app_id
        ))
        .await;
    let r = w.call(send("k-3", w.user_verification_body())).await;
    assert_eq!(r.error_code(), Some("receiving_app_disabled"));
    w.ctx
        .exec(&format!(
            "update apps set status = 'active' where app_id = '{}'",
            w.briefcase.app_id
        ))
        .await;
    let r = w.call(send("k-3", w.user_verification_body())).await;
    assert_eq!(r.status, 201, "{}", r.json);
}

#[tokio::test]
async fn silicons_can_be_represented_too() {
    let w = World::new().await;
    let (si, _stk) = w.ctx.silicon(&w.carbon.uuid).await;
    w.ctx
        .membership(&w.dm.app_id, &si.uuid, &[Scope::Profile])
        .await;
    let t = w.ctx.tokens_for(&si, &w.dm.app_id, &[Scope::Profile]).await;
    let r = w
        .user_verification(
            json!({"subject_token": t.access_token, "receiving_app": w.briefcase.app_id}),
        )
        .await;
    assert_eq!(r.status, 201, "{}", r.json);
    assert_eq!(r.json["user"]["kind"], "silicon");
    assert_eq!(r.json["user"]["id"], si.id());
    let v = w.verify_bc(&token(&r.json)).await;
    assert_eq!(v["valid"], true);
    assert_eq!(v["user"]["kind"], "silicon");
    assert_eq!(v["user"]["uuid"], si.uuid);
}
