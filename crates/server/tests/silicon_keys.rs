//! Silicon key credentials: register Ed25519 keys, sign in with a signed assertion instead of
//! the STK (`POST /v1/silicons/login` and the jwt-bearer grant), and every refusal: replay,
//! expiry, wrong key, revoked key.

use accounts_core::test_support::{Req, Resp, TestContext, call};
use base64::Engine as _;
use ed25519_dalek::{Signer, SigningKey};
use serde_json::{Value, json};

async fn send(ctx: &TestContext, req: Req) -> Resp {
    call(accounts_server::build_router(ctx.state.clone()), req).await
}

fn key(seed: u8) -> SigningKey {
    SigningKey::from_bytes(&[seed; 32])
}

fn public(k: &SigningKey) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(k.verifying_key().to_bytes())
}

fn assertion(k: &SigningKey, header: Value, claims: Value) -> String {
    let e = |v: &Value| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(v.to_string());
    let signed = format!("{}.{}", e(&header), e(&claims));
    let sig = k.sign(signed.as_bytes());
    format!(
        "{signed}.{}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(sig.to_bytes())
    )
}

fn now() -> i64 {
    time::OffsetDateTime::now_utc().unix_timestamp()
}

fn claims(ctx: &TestContext, silicon: &str, jti: &str) -> Value {
    json!({
        "iss": silicon, "sub": silicon, "aud": ctx.state.settings.url("/v1/oauth/token"),
        "iat": now(), "exp": now() + 120, "jti": jti,
    })
}

async fn login(ctx: &TestContext, assertion: &str) -> Resp {
    send(
        ctx,
        Req::post("/v1/silicons/login").json(json!({"assertion": assertion})),
    )
    .await
}

#[tokio::test]
async fn a_silicon_signs_in_with_its_key_instead_of_its_stk() {
    let ctx = TestContext::new().await;
    let custodian = ctx.carbon().await;
    let (silicon, _stk) = ctx.silicon(&custodian.uuid).await;
    let handle = silicon.handle.clone().expect("si:id");
    let silicon_token = ctx.first_party_tokens(&silicon).await.access_token;
    let custodian_token = ctx.first_party_tokens(&custodian).await.access_token;
    let laptop = key(1);
    let server = key(2);

    // The Silicon adds one key; its custodian adds another (an OpenSSH line works too).
    let r = send(
        &ctx,
        Req::post(&format!("/v1/silicons/{handle}/keys"))
            .bearer(&silicon_token)
            .json(json!({"public_key": public(&laptop), "name": "laptop"})),
    )
    .await;
    assert_eq!(r.status, 201, "{}", r.json);
    let laptop_id = r.json["id"].as_str().expect("id").to_string();
    assert_eq!(r.json["algorithm"], "EdDSA");
    assert_eq!(r.json["name"], "laptop");
    assert!(
        r.json["fingerprint"]
            .as_str()
            .is_some_and(|f| f.starts_with("SHA256:"))
    );
    let mut blob = Vec::new();
    blob.extend_from_slice(&11u32.to_be_bytes());
    blob.extend_from_slice(b"ssh-ed25519");
    blob.extend_from_slice(&32u32.to_be_bytes());
    blob.extend_from_slice(&server.verifying_key().to_bytes());
    let line = format!(
        "ssh-ed25519 {} scout@server",
        base64::engine::general_purpose::STANDARD.encode(&blob)
    );
    let r = send(
        &ctx,
        Req::post(&format!("/v1/silicons/{}/keys", silicon.uuid))
            .bearer(&custodian_token)
            .json(json!({"public_key": line, "name": "build server"})),
    )
    .await;
    assert_eq!(r.status, 201, "{}", r.json);
    let server_id = r.json["id"].as_str().expect("id").to_string();
    assert_eq!(r.json["created_by"], custodian.uuid.as_str());
    let r = send(
        &ctx,
        Req::post(&format!("/v1/silicons/{handle}/keys"))
            .bearer(&silicon_token)
            .json(json!({"public_key": public(&laptop)})),
    )
    .await;
    assert_eq!(r.status, 409);
    assert_eq!(r.error_code(), Some("key_exists"));
    let r = send(
        &ctx,
        Req::get(&format!("/v1/silicons/{handle}/keys")).bearer(&custodian_token),
    )
    .await;
    assert_eq!(
        r.json["items"].as_array().map(Vec::len),
        Some(2),
        "{}",
        r.json
    );

    // Sign in with the laptop key: first-party tokens, recorded as a key sign-in.
    let a = assertion(
        &laptop,
        json!({"alg": "EdDSA", "kid": laptop_id}),
        claims(&ctx, &handle, "jti-1"),
    );
    let r = login(&ctx, &a).await;
    assert_eq!(r.status, 200, "{}", r.json);
    let token = r.json["access_token"].as_str().expect("token").to_string();
    let me = send(&ctx, Req::get("/v1/me").bearer(&token)).await;
    assert_eq!(me.json["uuid"], silicon.uuid.as_str());
    let method: String = sqlx::query_scalar(
        "select method from signin_history where account_uuid = $1 and outcome = 'success' order by id desc limit 1",
    )
    .bind(&silicon.uuid)
    .fetch_one(&ctx.state.db)
    .await
    .expect("signin");
    assert_eq!(method, "silicon_key");

    // The same assertion again: refused (one use).
    let r = login(&ctx, &a).await;
    assert_eq!(r.status, 401, "{}", r.json);
    assert_eq!(r.error_code(), Some("invalid_assertion"));
    assert!(
        r.json["error"]["message"]
            .as_str()
            .is_some_and(|m| m.contains("used before"))
    );

    // By uuid and without a kid (every key is tried), through the token endpoint.
    let a = assertion(
        &server,
        json!({"alg": "EdDSA"}),
        claims(&ctx, &silicon.uuid, "jti-2"),
    );
    let r = send(
        &ctx,
        Req::post("/v1/oauth/token").form(&[
            ("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer"),
            ("assertion", &a),
            ("client_id", "silicon-accounts"),
        ]),
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.json);
    // Another app can't use the grant.
    let (app, secret) = ctx.app("briefcase").await;
    let a = assertion(
        &server,
        json!({"alg": "EdDSA"}),
        claims(&ctx, &handle, "jti-3"),
    );
    let r = send(
        &ctx,
        Req::post("/v1/oauth/token")
            .basic(&app.app_id, &secret)
            .form(&[
                ("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer"),
                ("assertion", &a),
            ]),
    )
    .await;
    assert_eq!(r.json["error"], "unauthorized_client", "{}", r.json);

    // Expired, wrong key, wrong audience, and an id and STK sent with it.
    let mut old = claims(&ctx, &handle, "jti-4");
    old["iat"] = json!(now() - 1000);
    old["exp"] = json!(now() - 700);
    let r = login(&ctx, &assertion(&laptop, json!({"alg": "EdDSA"}), old)).await;
    assert_eq!(r.error_code(), Some("invalid_assertion"));
    assert!(
        r.json["error"]["message"]
            .as_str()
            .is_some_and(|m| m.contains("expired"))
    );
    let r = login(
        &ctx,
        &assertion(
            &key(9),
            json!({"alg": "EdDSA"}),
            claims(&ctx, &handle, "jti-5"),
        ),
    )
    .await;
    assert_eq!(r.status, 401);
    assert_eq!(r.error_code(), Some("invalid_assertion"));
    let mut wrong_aud = claims(&ctx, &handle, "jti-6");
    wrong_aud["aud"] = json!("https://elsewhere.example/v1/oauth/token");
    let r = login(
        &ctx,
        &assertion(&laptop, json!({"alg": "EdDSA"}), wrong_aud),
    )
    .await;
    assert_eq!(r.error_code(), Some("invalid_assertion"));
    let r = send(
        &ctx,
        Req::post("/v1/silicons/login")
            .json(json!({"assertion": "x.y.z", "id": handle, "stk": "stk-0123456789ab"})),
    )
    .await;
    assert_eq!(r.status, 422);

    // Revoking the laptop key stops it and ends the sign-in it started.
    let r = send(
        &ctx,
        Req::delete(&format!("/v1/silicons/{handle}/keys/{laptop_id}")).bearer(&custodian_token),
    )
    .await;
    assert_eq!(r.status, 204, "{}", r.json);
    let me = send(&ctx, Req::get("/v1/me").bearer(&token)).await;
    assert_eq!(me.status, 401, "the key's sign-in ended: {}", me.json);
    let r = login(
        &ctx,
        &assertion(
            &laptop,
            json!({"alg": "EdDSA", "kid": laptop_id}),
            claims(&ctx, &handle, "jti-7"),
        ),
    )
    .await;
    assert_eq!(r.error_code(), Some("invalid_assertion"));
    let r = send(
        &ctx,
        Req::get(&format!("/v1/silicons/{handle}/keys")).bearer(&silicon_token),
    )
    .await;
    let revoked = r.json["items"]
        .as_array()
        .expect("items")
        .iter()
        .find(|k| k["id"] == laptop_id.as_str())
        .expect("laptop");
    assert!(revoked["revoked_at"].is_string());
    assert!(revoked["last_used_at"].is_string());
    let _ = server_id;

    // Nobody else manages them.
    let stranger = ctx.carbon().await;
    let st = ctx.first_party_tokens(&stranger).await.access_token;
    let r = send(
        &ctx,
        Req::get(&format!("/v1/silicons/{handle}/keys")).bearer(&st),
    )
    .await;
    assert_eq!(r.status, 404);
    assert_eq!(r.error_code(), Some("silicon_not_found"));
    let r = send(
        &ctx,
        Req::post(&format!("/v1/silicons/{handle}/keys"))
            .bearer(&silicon_token)
            .json(json!({"public_key": "ssh-rsa AAAAB3NzaC1yc2E"})),
    )
    .await;
    assert_eq!(r.status, 422);
    assert!(r.json["error"]["details"]["fields"]["public_key"].is_string());
}

/// `grant_type=jwt-bearer` takes the same credential as `POST /v1/silicons/login`, so it counts
/// against the same 60 attempts per minute per address, in the same bucket.
#[tokio::test]
async fn the_jwt_bearer_grant_shares_the_silicon_sign_in_limit() {
    let ctx = TestContext::new().await;
    let custodian = ctx.carbon().await;
    let (silicon, _stk) = ctx.silicon(&custodian.uuid).await;
    let handle = silicon.handle.clone().expect("si:id");
    let silicon_token = ctx.first_party_tokens(&silicon).await.access_token;
    let laptop = key(1);
    let r = send(
        &ctx,
        Req::post(&format!("/v1/silicons/{handle}/keys"))
            .bearer(&silicon_token)
            .json(json!({"public_key": public(&laptop), "name": "laptop"})),
    )
    .await;
    assert_eq!(r.status, 201, "{}", r.json);
    let grant = |jti: &str| {
        let a = assertion(&laptop, json!({"alg": "EdDSA"}), claims(&ctx, &handle, jti));
        Req::post("/v1/oauth/token").form(&[
            ("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer"),
            ("assertion", &a),
            ("client_id", "silicon-accounts"),
        ])
    };

    // This network made 59 attempts this minute: the 60th goes through, the 61st waits.
    ctx.exec(
        "insert into rate_limits (bucket, window_started_at, count) values ('silicon_login:ip:unknown', now(), 59)",
    )
    .await;
    let r = send(&ctx, grant("jti-limit-1")).await;
    assert_eq!(r.status, 200, "{}", r.json);
    let r = send(&ctx, grant("jti-limit-2")).await;
    assert_eq!(r.status, 429, "{}", r.json);
    assert_eq!(r.json["error"], "rate_limited", "{}", r.json);
    assert!(
        r.json["error_description"]
            .as_str()
            .is_some_and(|d| d.contains("Silicon sign-in attempts")),
        "{}",
        r.json
    );
    let retry_after: u64 = r
        .headers
        .get("retry-after")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok())
        .expect("Retry-After");
    assert!((1..=60).contains(&retry_after), "{retry_after}");

    // One bucket for both endpoints: the grant's attempts count at POST /v1/silicons/login.
    let r = login(
        &ctx,
        &assertion(
            &laptop,
            json!({"alg": "EdDSA"}),
            claims(&ctx, &handle, "jti-limit-3"),
        ),
    )
    .await;
    assert_eq!(r.status, 429, "{}", r.json);
    assert_eq!(r.error_code(), Some("rate_limited"));
    // Once the window ends, the refused assertion still works: the limit is checked before it.
    ctx.exec("update rate_limits set count = 0 where bucket = 'silicon_login:ip:unknown'")
        .await;
    let r = send(&ctx, grant("jti-limit-2")).await;
    assert_eq!(r.status, 200, "{}", r.json);
    let count: i32 = sqlx::query_scalar(
        "select count from rate_limits where bucket = 'silicon_login:ip:unknown'",
    )
    .fetch_one(&ctx.state.db)
    .await
    .expect("bucket");
    assert_eq!(count, 1, "the grant counted in the login bucket");
}
