//! Upgrade fixtures deliberately use the historical spellings.
use accounts_core::repo::idempotency;
use accounts_core::test_support::{Req, TestContext, TestDb, test_state};
use serde_json::{Value, json};
use uuid::Uuid;

#[tokio::test]
async fn existing_tokens_history_and_encrypted_retries_survive_the_rename() {
    let db = TestDb::empty().await;
    accounts_core::db::MIGRATOR
        .run_to(10, &db.pool)
        .await
        .unwrap();
    let state = test_state(db.pool.clone());
    let ctx = TestContext { db, state };
    let (issuer, secret) = ctx.app("issuer").await;
    let (receiver, receiver_secret) = ctx.app("receiver").await;
    let carbon = ctx.carbon().await;
    ctx.membership(&issuer.app_id, &carbon.uuid, &[]).await;
    ctx.tokens_for(&carbon, &issuer.app_id, &[]).await;
    let grant: Uuid = sqlx::query_scalar("select id from token_families where app_id=$1")
        .bind(&issuer.app_id)
        .fetch_one(&ctx.state.db)
        .await
        .unwrap();
    let mut fixtures = vec![];
    for (old, current) in [("ata", "app_verification"), ("obo", "user_verification")] {
        let id = Uuid::now_v7();
        let access = accounts_core::crypto::random_token("sap_");
        let refresh = accounts_core::crypto::random_token("sapr_");
        sqlx::query("insert into proof_families(id,kind,issuing_app,audiences,account_uuid,subject_family_id,access_ttl_seconds,expires_at) values($1,$2,$3,$4,$5,$6,300,now()+interval '1 day')")
            .bind(id).bind(old).bind(&issuer.app_id).bind(vec![&receiver.app_id])
            .bind(if old=="obo" {Some(&carbon.uuid)} else {None})
            .bind(if old=="obo" {Some(grant)} else {None})
            .execute(&ctx.state.db).await.unwrap();
        for (kind, token) in [("access", &access), ("refresh", &refresh)] {
            sqlx::query("insert into proof_tokens(token_hash,family_id,kind,expires_at) values($1,$2,$3,now()+interval '1 hour')")
                .bind(ctx.state.pepper().hash(token)).bind(id).bind(kind).execute(&ctx.state.db).await.unwrap();
        }
        sqlx::query("insert into audit_log(action,actor_kind,actor_id,app_id,target_kind,target_id,details) values('proof.issued','app',$1,$1,'proof',$2,$3)")
            .bind(&issuer.app_id).bind(id.to_string())
            .bind(json!({"kind":old,"receiving_app":receiver.app_id})).execute(&ctx.state.db).await.unwrap();
        fixtures.push((id, current, access, refresh));
    }
    let original: Value =
        sqlx::query_scalar("select jsonb_agg(to_jsonb(t) order by token_hash) from proof_tokens t")
            .fetch_one(&ctx.state.db)
            .await
            .unwrap();
    let old_scope = format!("app:{} POST /v1/proofs/ata", issuer.app_id);
    let body =
        json!({"kind":"ata","proof_token":fixtures[0].2,"proof_refresh_token":fixtures[0].3});
    let sealed = idempotency::seal(ctx.state.keyring(), &old_scope, "retry", &body).unwrap();
    sqlx::query("insert into idempotency_keys(scope,key,request_hash,status_code,response,expires_at) values($1,'retry','hash'::bytea,201,$2,now()+interval '5 minutes')")
        .bind(&old_scope).bind(sealed).execute(&ctx.state.db).await.unwrap();

    accounts_core::db::migrate(&ctx.state.db).await.unwrap();
    accounts_proofs::migration::migrate_retry_responses(&ctx.state)
        .await
        .unwrap();
    accounts_proofs::migration::migrate_retry_responses(&ctx.state)
        .await
        .unwrap();
    let after: Value =
        sqlx::query_scalar("select jsonb_agg(to_jsonb(t) order by token_hash) from proof_tokens t")
            .fetch_one(&ctx.state.db)
            .await
            .unwrap();
    assert_eq!(original, after);
    let new_scope = format!("app:{} POST /v1/proofs/app-verification", issuer.app_id);
    let stored: Value =
        sqlx::query_scalar("select response from idempotency_keys where scope=$1 and key='retry'")
            .bind(&new_scope)
            .fetch_one(&ctx.state.db)
            .await
            .unwrap();
    let replay = idempotency::unseal(ctx.state.keyring(), &new_scope, "retry", &stored).unwrap();
    assert_eq!(replay["kind"], "app_verification");
    assert_eq!(replay["proof_token"], body["proof_token"]);
    assert!(!stored.to_string().contains(fixtures[0].2.as_str()));
    for (id, kind, access, refresh) in fixtures {
        let result = ctx
            .call(
                accounts_proofs::router(),
                Req::post("/v1/proofs/verify")
                    .basic(&receiver.app_id, &receiver_secret)
                    .json(json!({"proof_token":access})),
            )
            .await;
        assert_eq!(result.status, 200, "{}", result.json);
        assert_eq!(result.json["valid"], true, "{}", result.json);
        assert_eq!(result.json["kind"], kind);
        let history: String =
            sqlx::query_scalar("select details->>'kind' from audit_log where target_id=$1")
                .bind(id.to_string())
                .fetch_one(&ctx.state.db)
                .await
                .unwrap();
        assert_eq!(history, kind);
        let result = ctx
            .call(
                accounts_proofs::router(),
                Req::post("/v1/proofs/refresh")
                    .basic(&issuer.app_id, &secret)
                    .json(json!({"proof_refresh_token":refresh})),
            )
            .await;
        assert_eq!(result.status, 200, "{}", result.json);
        assert_eq!(result.json["kind"], kind);
    }
}
