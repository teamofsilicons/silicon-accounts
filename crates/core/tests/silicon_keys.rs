//! Silicon key sign-in: a revocation that races a sign-in ends it.

use accounts_core::http::ClientMeta;
use accounts_core::silicon_keys::{self, PublicKey};
use accounts_core::test_support::TestContext;
use base64::Engine as _;
use ed25519_dalek::{Signer, SigningKey};
use serde_json::{Value, json};

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

#[tokio::test]
async fn a_sign_in_that_read_the_key_before_its_revocation_is_refused() {
    let ctx = TestContext::new().await;
    let c = ctx.carbon().await;
    let (s, _) = ctx.silicon(&c.uuid).await;
    let signing = SigningKey::from_bytes(&[9u8; 32]);
    let public = PublicKey(signing.verifying_key().to_bytes());
    let key_id = uuid::Uuid::now_v7();
    sqlx::query(
        "insert into silicon_keys (id, silicon_uuid, name, public_key, fingerprint, created_by) \
         values ($1, $2, 'ci', $3, $4, $5)",
    )
    .bind(key_id)
    .bind(&s.uuid)
    .bind(&public.0[..])
    .bind(public.fingerprint())
    .bind(&c.uuid)
    .execute(&ctx.state.db)
    .await
    .expect("key");
    let now = time::OffsetDateTime::now_utc().unix_timestamp();
    let part = |v: Value| b64(v.to_string().as_bytes());
    let signed = format!(
        "{}.{}",
        part(json!({"alg": "EdDSA", "kid": key_id.to_string()})),
        part(json!({
            "iss": s.uuid, "sub": s.uuid, "aud": ctx.state.settings.url("/v1/oauth/token"),
            "exp": now + 60, "jti": "race",
        }))
    );
    let assertion = format!(
        "{signed}.{}",
        b64(&signing.sign(signed.as_bytes()).to_bytes())
    );

    // The revocation holds the key's row lock, like DELETE /v1/silicons/{id}/keys/{key_id}.
    let mut revoke = ctx.state.db.begin().await.expect("begin");
    sqlx::query("select id from silicon_keys where id = $1 for update")
        .bind(key_id)
        .execute(&mut *revoke)
        .await
        .expect("lock");
    let state = ctx.state.clone();
    let signin = tokio::spawn(async move {
        silicon_keys::sign_in(&state, &ClientMeta::default(), &assertion, None).await
    });
    // The sign-in has read the key as live and now waits on the revocation's lock.
    for _ in 0..500 {
        let waiting: bool = sqlx::query_scalar(
            "select exists(select 1 from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock')",
        )
        .fetch_one(&ctx.state.db)
        .await
        .expect("activity");
        if waiting || signin.is_finished() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    sqlx::query("update silicon_keys set revoked_at = now() where id = $1")
        .bind(key_id)
        .execute(&mut *revoke)
        .await
        .expect("revoke");
    revoke.commit().await.expect("commit");

    let err = signin
        .await
        .expect("join")
        .expect_err("the revoked key signs nothing in");
    assert_eq!(err.code, "invalid_assertion", "{}", err.message);
    let sessions: i64 =
        sqlx::query_scalar("select count(*) from silicon_key_sessions where key_id = $1")
            .bind(key_id)
            .fetch_one(&ctx.state.db)
            .await
            .expect("sessions");
    assert_eq!(sessions, 0, "no sign-in of the revoked key survives");
}
