//! Identity tokens: a Silicon's OIDC ID tokens for outside services (AWS STS, Google Cloud,
//! Microsoft Entra). The custodian's allow-list of audiences (empty for every Silicon until the
//! custodian adds one), lifetime bounds, the claims, the RS256 key in the JWKS next to the
//! Ed25519 key (both verify), the key being made once and shared, and our own API refusing an
//! identity token as a bearer token.

use accounts_core::test_support::{Req, Resp, TestContext, call};
use jsonwebtoken::{Algorithm, DecodingKey, Validation};
use serde_json::{Value, json};

async fn send(ctx: &TestContext, req: Req) -> Resp {
    call(accounts_server::build_router(ctx.state.clone()), req).await
}

async fn issue(ctx: &TestContext, token: &str, body: Value) -> Resp {
    send(
        ctx,
        Req::post("/v1/me/identity-tokens").bearer(token).json(body),
    )
    .await
}

async fn allow(ctx: &TestContext, token: &str, silicon: &str, audiences: Value) -> Resp {
    send(
        ctx,
        Req::put(&format!("/v1/silicons/{silicon}/identity-audiences"))
            .bearer(token)
            .json(json!({ "audiences": audiences })),
    )
    .await
}

/// Verifies `token` the way an outside service does: only with the published JWKS.
fn verify_with_jwks(jwks: &Value, token: &str, issuer: &str, audience: &str) -> Value {
    let header = jsonwebtoken::decode_header(token).expect("header");
    let kid = header.kid.expect("kid");
    let key = jwks["keys"]
        .as_array()
        .expect("keys")
        .iter()
        .find(|k| k["kid"] == kid.as_str())
        .unwrap_or_else(|| panic!("kid {kid} is not in {jwks}"));
    let jwk: jsonwebtoken::jwk::Jwk = serde_json::from_value(key.clone()).expect("jwk");
    let decoding = DecodingKey::from_jwk(&jwk).expect("decoding key");
    let mut v = Validation::new(header.alg);
    v.set_issuer(&[issuer]);
    v.set_audience(&[audience]);
    v.set_required_spec_claims(&["exp", "iat", "iss", "sub", "aud"]);
    jsonwebtoken::decode::<Value>(token, &decoding, &v)
        .unwrap_or_else(|e| panic!("does not verify with the JWKS: {e}"))
        .claims
}

#[tokio::test]
async fn a_silicon_gets_identity_tokens_only_for_audiences_its_custodian_allows() {
    let ctx = TestContext::new().await;
    let custodian = ctx.carbon().await;
    let (silicon, _stk) = ctx.silicon(&custodian.uuid).await;
    let handle = silicon.handle.clone().expect("si:id");
    let silicon_token = ctx.first_party_tokens(&silicon).await.access_token;
    let custodian_token = ctx.first_party_tokens(&custodian).await.access_token;

    // Nothing is allowed until the custodian says so.
    let r = send(
        &ctx,
        Req::get(&format!("/v1/silicons/{handle}/identity-audiences")).bearer(&silicon_token),
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(r.json["audiences"], json!([]));
    let r = issue(
        &ctx,
        &silicon_token,
        json!({"audience": "sts.amazonaws.com"}),
    )
    .await;
    assert_eq!(r.status, 403, "{}", r.json);
    assert_eq!(r.error_code(), Some("audience_not_allowed"));

    // Only the custodian sets the list, and only outside-looking audiences.
    let r = allow(&ctx, &silicon_token, &handle, json!(["sts.amazonaws.com"])).await;
    assert_eq!(r.status, 403, "{}", r.json);
    assert_eq!(r.error_code(), Some("custodian_only"));
    let r = allow(&ctx, &custodian_token, &handle, json!(["briefcase"])).await;
    assert_eq!(r.status, 422, "{}", r.json);
    let ours = ctx.state.settings.issuer().to_string();
    let r = allow(&ctx, &custodian_token, &handle, json!([ours])).await;
    assert_eq!(r.status, 422, "{}", r.json);
    let gcp = "https://iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/silicons/providers/accounts";
    let r = allow(
        &ctx,
        &custodian_token,
        &handle,
        json!([
            "sts.amazonaws.com",
            gcp,
            "api://AzureADTokenExchange",
            "sts.amazonaws.com"
        ]),
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(
        r.json["audiences"],
        json!(["sts.amazonaws.com", gcp, "api://AzureADTokenExchange"])
    );
    let changed: i64 = sqlx::query_scalar(
        "select count(*) from webhook_events where target_kind = 'silicon' and target_id = $1 and type = 'silicon.identity_audiences.changed'",
    )
    .bind(&silicon.uuid)
    .fetch_one(&ctx.state.db)
    .await
    .expect("events");
    assert_eq!(changed, 1);

    // Lifetimes: 60 to 3600 seconds, 300 by default.
    for ttl in [59, 3601, 0, -5] {
        let r = issue(
            &ctx,
            &silicon_token,
            json!({"audience": "sts.amazonaws.com", "ttl_seconds": ttl}),
        )
        .await;
        assert_eq!(r.status, 422, "{ttl}: {}", r.json);
    }
    let r = issue(
        &ctx,
        &silicon_token,
        json!({"audience": "sts.amazonaws.com"}),
    )
    .await;
    assert_eq!(r.status, 201, "{}", r.json);
    assert_eq!(r.json["expires_in"], 300);
    let token = r.json["identity_token"]
        .as_str()
        .expect("token")
        .to_string();

    // The claims.
    let jwks = send(&ctx, Req::get("/.well-known/jwks.json")).await.json;
    let issuer = ctx.state.settings.issuer().to_string();
    let claims = verify_with_jwks(&jwks, &token, &issuer, "sts.amazonaws.com");
    assert_eq!(claims["iss"], issuer.as_str());
    assert_eq!(claims["sub"], silicon.uuid.as_str());
    assert_eq!(claims["aud"], "sts.amazonaws.com");
    assert_eq!(claims["kind"], "silicon");
    assert_eq!(claims["si_id"], handle.as_str());
    assert_eq!(claims["custodian"], custodian.uuid.as_str());
    assert_eq!(claims["token_use"], "identity");
    assert!(claims["jti"].as_str().is_some_and(|j| !j.is_empty()));
    let (iat, exp) = (
        claims["iat"].as_i64().expect("iat"),
        claims["exp"].as_i64().expect("exp"),
    );
    assert_eq!(exp - iat, 300);
    let header = jsonwebtoken::decode_header(&token).expect("header");
    assert_eq!(header.alg, Algorithm::RS256);
    assert_eq!(header.typ.as_deref(), Some("JWT"));
    assert_eq!(header.kid.as_deref(), r.json["kid"].as_str());

    // The longest lifetime, for another allowed audience.
    let r = issue(
        &ctx,
        &silicon_token,
        json!({"audience": "api://AzureADTokenExchange", "ttl_seconds": 3600}),
    )
    .await;
    assert_eq!(r.status, 201, "{}", r.json);
    let azure = r.json["identity_token"].as_str().expect("token");
    let claims = verify_with_jwks(&jwks, azure, &issuer, "api://AzureADTokenExchange");
    assert_eq!(
        claims["exp"].as_i64().expect("exp") - claims["iat"].as_i64().expect("iat"),
        3600
    );

    // Every issue is in the Silicon's and the custodian's history, never the token.
    let rows: Vec<(String, Value)> = sqlx::query_as(
        "select account_uuid, details from audit_log where action = 'silicon.identity_token.issued' order by id",
    )
    .fetch_all(&ctx.state.db)
    .await
    .expect("audit");
    assert_eq!(rows.len(), 4, "two tokens, two histories each: {rows:?}");
    assert!(rows.iter().any(|(a, _)| a == &custodian.uuid));
    assert!(rows.iter().any(|(a, _)| a == &silicon.uuid));
    assert!(rows.iter().all(|(_, d)| !d.to_string().contains(&token)));

    // Removing an audience stops new tokens for it.
    let r = allow(
        &ctx,
        &custodian_token,
        &handle,
        json!(["sts.amazonaws.com"]),
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.json);
    let r = issue(
        &ctx,
        &silicon_token,
        json!({"audience": "api://AzureADTokenExchange"}),
    )
    .await;
    assert_eq!(r.status, 403, "{}", r.json);

    // Carbons have no identity tokens.
    let r = issue(
        &ctx,
        &custodian_token,
        json!({"audience": "sts.amazonaws.com"}),
    )
    .await;
    assert_eq!(r.status, 403, "{}", r.json);
    assert_eq!(r.error_code(), Some("silicon_only"));
}

#[tokio::test]
async fn our_own_api_never_takes_an_identity_token() {
    let ctx = TestContext::new().await;
    let custodian = ctx.carbon().await;
    let (silicon, _stk) = ctx.silicon(&custodian.uuid).await;
    let silicon_token = ctx.first_party_tokens(&silicon).await.access_token;
    let custodian_token = ctx.first_party_tokens(&custodian).await.access_token;
    let r = allow(
        &ctx,
        &custodian_token,
        &silicon.uuid,
        json!(["sts.amazonaws.com"]),
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.json);
    let r = issue(
        &ctx,
        &silicon_token,
        json!({"audience": "sts.amazonaws.com"}),
    )
    .await;
    let token = r.json["identity_token"]
        .as_str()
        .expect("token")
        .to_string();

    let me = send(&ctx, Req::get("/v1/me").bearer(&token)).await;
    assert_eq!(me.status, 401, "{}", me.json);
    assert_eq!(me.error_code(), Some("identity_token_not_accepted"));
    let info = send(&ctx, Req::get("/v1/userinfo").bearer(&token)).await;
    assert_eq!(info.status, 401, "{}", info.json);
    let r = send(
        &ctx,
        Req::post("/v1/me/short-lived-tokens")
            .bearer(&token)
            .json(json!({"app_id": "briefcase"})),
    )
    .await;
    assert_eq!(r.status, 401, "{}", r.json);
    let (app, secret) = ctx.app("briefcase").await;
    let introspected = send(
        &ctx,
        Req::post("/v1/oauth/introspect")
            .basic(&app.app_id, &secret)
            .form(&[("token", token.as_str())]),
    )
    .await;
    assert_eq!(introspected.status, 200, "{}", introspected.json);
    assert_eq!(introspected.json["active"], false);
    // Nor does the core verifier accept it, whatever the audience.
    assert!(ctx.state.keys.jwt.verify_access(&token, None).is_err());
}

#[tokio::test]
async fn the_jwks_publishes_both_keys_and_both_verify() {
    let ctx = TestContext::new().await;
    let r = send(&ctx, Req::get("/.well-known/jwks.json")).await;
    assert_eq!(r.status, 200, "{}", r.json);
    let keys = r.json["keys"].as_array().expect("keys");
    assert_eq!(keys.len(), 2, "{}", r.json);
    assert_eq!(keys[0]["alg"], "EdDSA");
    assert_eq!(keys[1]["alg"], "RS256");
    assert_eq!(keys[1]["kty"], "RSA");
    assert_eq!(keys[1]["use"], "sig");
    assert!(keys[1].get("d").is_none(), "never the private key");
    assert_ne!(keys[0]["kid"], keys[1]["kid"]);

    // An access token (EdDSA) verifies with the first key, an identity token (RS256) with the
    // second, each found by its kid.
    let custodian = ctx.carbon().await;
    let (silicon, _) = ctx.silicon(&custodian.uuid).await;
    let access = ctx.first_party_tokens(&silicon).await.access_token;
    let issuer = ctx.state.settings.issuer().to_string();
    let claims = verify_with_jwks(&r.json, &access, &issuer, "silicon-accounts");
    assert_eq!(claims["sub"], silicon.uuid.as_str());
    let custodian_token = ctx.first_party_tokens(&custodian).await.access_token;
    allow(
        &ctx,
        &custodian_token,
        &silicon.uuid,
        json!(["sts.amazonaws.com"]),
    )
    .await;
    let id = issue(&ctx, &access, json!({"audience": "sts.amazonaws.com"})).await;
    let id = id.json["identity_token"].as_str().expect("token");
    assert_eq!(
        jsonwebtoken::decode_header(id).expect("h").kid.as_deref(),
        keys[1]["kid"].as_str()
    );
    verify_with_jwks(&r.json, id, &issuer, "sts.amazonaws.com");

    // The key is stored once, sealed, and another API node over the same database loads the
    // same key instead of making a new one.
    let stored: Vec<(String, String, Vec<u8>)> =
        sqlx::query_as("select kid, algorithm, private_key_enc from signing_keys")
            .fetch_all(&ctx.state.db)
            .await
            .expect("keys");
    assert_eq!(stored.len(), 1);
    assert_eq!(stored[0].1, "RS256");
    assert!(!String::from_utf8_lossy(&stored[0].2).contains("PRIVATE KEY"));
    let other = accounts_core::test_support::test_state(ctx.state.db.clone());
    let again = send_with(&other, Req::get("/.well-known/jwks.json")).await;
    assert_eq!(again.json["keys"][1]["kid"], keys[1]["kid"]);

    // Discovery says what cloud providers read: issuer, jwks_uri, RS256.
    let d = send(&ctx, Req::get("/.well-known/openid-configuration")).await;
    assert_eq!(d.json["issuer"], issuer.as_str());
    assert_eq!(
        d.json["jwks_uri"],
        format!("{issuer}/.well-known/jwks.json")
    );
    assert!(
        d.json["id_token_signing_alg_values_supported"]
            .as_array()
            .is_some_and(|a| a.iter().any(|v| v == "RS256"))
    );
    assert_eq!(d.json["subject_types_supported"], json!(["public"]));
    assert!(d.json["response_types_supported"].is_array());
}

async fn send_with(state: &accounts_core::AppState, req: Req) -> Resp {
    call(accounts_server::build_router(state.clone()), req).await
}
