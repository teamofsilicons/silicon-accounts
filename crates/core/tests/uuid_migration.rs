use accounts_core::{
    models::{AccountField, Scope},
    repo::accounts,
    test_support::TestContext,
    uuid_migration,
};
use serde_json::{Value, json};
use uuid::Uuid;

async fn legacy(ctx: &TestContext, id: &str, kind: &str, custodian: Option<&str>, deleted: bool) {
    sqlx::query("insert into accounts(uuid,number,kind,handle,status,display_name,pfp_url,dob,timezone,custodian_uuid) values($1,nextval('account_number_seq'),$2,$3,$4,'Unchanged name','https://example.test/avatar/old',date '2000-01-01','UTC',$5)")
        .bind(id).bind(kind).bind((!deleted).then(||format!("{}:test-{id}",if kind=="carbon"{"c"}else{"si"})))
        .bind(if deleted {"deleted"}else{"active"}).bind(custodian).execute(&ctx.state.db).await.expect("legacy fixture");
}

#[tokio::test]
async fn cutover_is_atomic_repeatable_and_preserves_identity_links_secrets_and_history() {
    let ctx = TestContext::new().await;
    legacy(&ctx, "Ab1", "carbon", None, false).await;
    legacy(&ctx, "Si2", "silicon", Some("Ab1"), false).await;
    legacy(&ctx, "De3", "carbon", None, true).await;
    let already_standard = ctx.carbon().await;
    let (app, _) = ctx.app("uuid").await;
    ctx.set_app_webhook(&app.app_id, "http://127.0.0.1:9999/receive")
        .await;
    for id in ["Ab1", "Si2", "De3", &already_standard.uuid] {
        ctx.membership(&app.app_id, id, &[Scope::Profile]).await;
    }
    let mut conn = ctx.conn().await;
    let old = accounts::get(&mut conn, "Si2")
        .await
        .expect("UUID migration fixture")
        .expect("UUID migration fixture");
    accounts_core::events::account_updated(&mut conn, &old, &[AccountField::DisplayName])
        .await
        .expect("UUID migration fixture");
    accounts_core::events::account_updated(
        &mut conn,
        &already_standard,
        &[AccountField::DisplayName],
    )
    .await
    .expect("UUID migration fixture");
    let historical: Vec<(Uuid, Value)> =
        sqlx::query_as("select event_id,payload from webhook_events where account_uuid='Si2'")
            .fetch_all(&mut *conn)
            .await
            .expect("UUID migration fixture");
    sqlx::query(
        "insert into account_emails(email,account_uuid) values('legacy@example.test','Ab1')",
    )
    .execute(&mut *conn)
    .await
    .expect("UUID migration fixture");
    sqlx::query("insert into identities(provider,subject,client_id,account_uuid) values('google','Ab1','external-client','Ab1')").execute(&mut *conn).await.expect("UUID migration fixture");
    sqlx::query(
        "update accounts set webhook_secret_enc=$1,stk_hash='preserve-stk-hash' where uuid='Si2'",
    )
    .bind(vec![1u8, 2, 3, 4])
    .execute(&mut *conn)
    .await
    .expect("UUID migration fixture");
    sqlx::query("update apps set owner_uuid='Ab1' where app_id=$1")
        .bind(&app.app_id)
        .execute(&mut *conn)
        .await
        .expect("UUID migration fixture");
    sqlx::query("insert into app_authors(app_id,account_uuid) values($1,'Ab1')")
        .bind(&app.app_id)
        .execute(&mut *conn)
        .await
        .expect("UUID migration fixture");
    sqlx::query("insert into audit_log(actor_kind,actor_id,action,target_kind,target_id,account_uuid,details) values('account','Ab1','test','silicon','Si2','Si2',$1)").bind(json!({"uuid":"Si2","custodian":{"uuid":"Ab1"},"message":"Ab1"})).execute(&mut *conn).await.expect("UUID migration fixture");
    sqlx::query("insert into browser_sessions(id,token_hash,account_uuid,expires_at) values(gen_random_uuid(),'\\x01','Ab1',now()+interval '1 day')").execute(&mut *conn).await.expect("UUID migration fixture");
    let family: Uuid=sqlx::query_scalar("insert into token_families(id,app_id,account_uuid,origin,expires_at) values(gen_random_uuid(),$1,'Ab1','device',now()+interval '1 day') returning id").bind(&app.app_id).fetch_one(&mut *conn).await.expect("UUID migration fixture");
    sqlx::query("insert into proof_families(id,kind,issuing_app,audiences,account_uuid,subject_family_id,access_ttl_seconds,expires_at) values(gen_random_uuid(),'user_verification',$1,array[$1],'Ab1',$2,600,now()+interval '1 day')").bind(&app.app_id).bind(family).execute(&mut *conn).await.expect("UUID migration fixture");
    for revoked_by in ["Ab1", "account:Ab1"] {
        sqlx::query("insert into proof_families(id,kind,issuing_app,audiences,account_uuid,subject_family_id,access_ttl_seconds,expires_at,revoked_at,revoked_by) values(gen_random_uuid(),'user_verification',$1,array[$1],'Ab1',$2,600,now()+interval '1 day',now(),$3)").bind(&app.app_id).bind(family).bind(revoked_by).execute(&mut *conn).await.expect("revoked proof migration fixture");
    }
    sqlx::query("insert into idempotency_keys(scope,key,request_hash,status_code,response,expires_at) values('account:Ab1 POST /token','retry','\\x01',200,'{\"sealed\":\"oldJWT\"}',now()+interval '1 day')").execute(&mut *conn).await.expect("UUID migration fixture");
    drop(conn);
    let plan = uuid_migration::prepare(&ctx.state.db)
        .await
        .expect("UUID migration fixture");
    assert_eq!(
        plan.len(),
        3,
        "includes deleted but not existing canonical accounts"
    );
    assert_eq!(
        plan,
        uuid_migration::prepare(&ctx.state.db)
            .await
            .expect("UUID migration fixture")
    );
    let csv = uuid_migration::to_csv(&plan).expect("UUID migration fixture");
    assert_eq!(
        plan,
        uuid_migration::from_csv(&csv).expect("UUID migration fixture")
    );
    let dry = uuid_migration::apply(&ctx.state.db, &plan, false)
        .await
        .expect("UUID migration fixture");
    assert_eq!(dry.mapped_accounts, 3);
    assert!(
        sqlx::query_scalar::<_, bool>("select exists(select 1 from accounts where uuid='Ab1')")
            .fetch_one(&ctx.state.db)
            .await
            .expect("UUID migration fixture")
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "select count(*) from webhook_events where identity_migrated_at is not null"
        )
        .fetch_one(&ctx.state.db)
        .await
        .expect("UUID migration fixture"),
        0
    );
    let mut wrong = plan.clone();
    wrong[0].new_uuid = Uuid::new_v4().to_string();
    assert!(
        uuid_migration::apply(&ctx.state.db, &wrong, true)
            .await
            .is_err()
    );
    let applied = uuid_migration::apply(&ctx.state.db, &plan, true)
        .await
        .expect("UUID migration fixture");
    assert_eq!(applied.mapped_accounts, 3);
    let new = |old: &str| {
        plan.iter()
            .find(|r| r.old_uuid == old)
            .expect("UUID migration fixture")
            .new_uuid
            .as_str()
    };
    let mut conn = ctx.conn().await;
    assert!(
        accounts::get(&mut conn, "Ab1")
            .await
            .expect("UUID migration fixture")
            .is_none(),
        "old subject cannot authenticate"
    );
    let silicon = accounts::get(&mut conn, new("Si2"))
        .await
        .expect("UUID migration fixture")
        .expect("UUID migration fixture");
    assert_eq!(silicon.custodian_uuid.as_deref(), Some(new("Ab1")));
    assert_eq!(silicon.handle.as_deref(), Some("si:test-Si2"));
    assert_eq!(silicon.webhook_secret_enc, Some(vec![1u8, 2, 3, 4]));
    assert_eq!(silicon.stk_hash.as_deref(), Some("preserve-stk-hash"));
    let provider: (String, String) = sqlx::query_as("select subject,account_uuid from identities")
        .fetch_one(&mut *conn)
        .await
        .expect("UUID migration fixture");
    assert_eq!(provider, ("Ab1".into(), new("Ab1").into()));
    let member: String = sqlx::query_scalar(
        "select membership_id from memberships where app_id=$1 and account_uuid=$2",
    )
    .bind(&app.app_id)
    .bind(new("Si2"))
    .fetch_one(&mut *conn)
    .await
    .expect("UUID migration fixture");
    assert_eq!(member, format!("{}:{}", app.app_id, new("Si2")));
    for (event_id, payload) in historical {
        let saved: (Value, bool) = sqlx::query_as(
            "select payload,identity_migrated_at is not null from webhook_events where event_id=$1",
        )
        .bind(event_id)
        .fetch_one(&mut *conn)
        .await
        .expect("UUID migration fixture");
        assert_eq!(saved, (payload, true));
    }
    let unchanged_retired:i64=sqlx::query_scalar("select count(*) from webhook_events where account_uuid=$1 and identity_migrated_at is not null").bind(&already_standard.uuid).fetch_one(&mut *conn).await.expect("UUID migration fixture");
    assert_eq!(
        unchanged_retired, 0,
        "unrelated canonical account feed remains live"
    );
    let audit: (String, String, Value) =
        sqlx::query_as("select actor_id,target_id,details from audit_log where action='test'")
            .fetch_one(&mut *conn)
            .await
            .expect("UUID migration fixture");
    assert_eq!(
        audit,
        (
            new("Ab1").into(),
            new("Si2").into(),
            json!({"uuid":new("Si2"),"custodian":{"uuid":new("Ab1")},"message":"Ab1"})
        )
    );
    assert!(
        sqlx::query_scalar::<_, bool>(
            "select bool_and(revoked_at is not null) from token_families"
        )
        .fetch_one(&mut *conn)
        .await
        .expect("UUID migration fixture")
    );
    assert!(
        sqlx::query_scalar::<_, bool>(
            "select bool_and(revoked_at is not null) from proof_families"
        )
        .fetch_one(&mut *conn)
        .await
        .expect("UUID migration fixture")
    );
    let revokers: Vec<String> = sqlx::query_scalar("select revoked_by from proof_families where revoked_by=$1 or revoked_by=$2 order by revoked_by")
        .bind(new("Ab1"))
        .bind(format!("account:{}", new("Ab1")))
        .fetch_all(&mut *conn)
        .await
        .expect("revoked proof migration fixture");
    let mut expected_revokers = vec![new("Ab1").to_owned(), format!("account:{}", new("Ab1"))];
    expected_revokers.sort();
    assert_eq!(
        revokers, expected_revokers,
        "both historical revoker forms remain linked to their owner"
    );
    let fresh_deleted:i64=sqlx::query_scalar("select count(*) from webhook_events where type='account.deleted' and account_uuid=$1 and identity_migrated_at is null").bind(new("De3")).fetch_one(&mut *conn).await.expect("UUID migration fixture");
    assert_eq!(fresh_deleted, 1);
    assert!(
        sqlx::query(
            "update account_uuid_migration_plan set new_uuid=gen_random_uuid() where old_uuid='Ab1'"
        )
        .execute(&mut *conn)
        .await
        .is_err()
    );
    drop(conn);
    let replay = uuid_migration::apply(&ctx.state.db, &plan, true)
        .await
        .expect("UUID migration fixture");
    assert_eq!(replay.mapped_accounts, 0);
    assert_eq!(replay.already_applied, 3);
}

#[tokio::test]
async fn new_legacy_accounts_and_target_collisions_abort_before_rekeying() {
    let ctx = TestContext::new().await;
    legacy(&ctx, "Ab1", "carbon", None, false).await;
    let plan = uuid_migration::prepare(&ctx.state.db)
        .await
        .expect("UUID migration fixture");
    legacy(&ctx, "De2", "carbon", None, true).await;
    assert!(
        uuid_migration::apply(&ctx.state.db, &plan, true)
            .await
            .is_err()
    );
    let plan = uuid_migration::prepare(&ctx.state.db)
        .await
        .expect("UUID migration fixture");
    legacy(&ctx, &plan[0].new_uuid, "carbon", None, true).await;
    assert!(
        uuid_migration::apply(&ctx.state.db, &plan, true)
            .await
            .is_err()
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "select count(*) from account_uuid_migration_plan where applied_at is not null"
        )
        .fetch_one(&ctx.state.db)
        .await
        .expect("UUID migration fixture"),
        0
    );
}
