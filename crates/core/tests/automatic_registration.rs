//! First-party registration covers existing identities and every account insertion path.

use accounts_core::models::{MembershipSource, MembershipStatus};
use accounts_core::repo::memberships;
use accounts_core::test_support::{TestContext, TestDb};

#[tokio::test]
async fn backfill_preserves_accounts_memberships_and_signin_history() {
    let db = TestDb::empty().await;
    accounts_core::db::MIGRATOR
        .run_to(36, &db.pool)
        .await
        .unwrap();
    sqlx::raw_sql(
        r#"
        insert into accounts(uuid,number,kind,handle,status,display_name,pfp_url,dob,timezone,custodian_uuid)
        values ('carbon',1,'carbon','c:existing','active','Carbon','photo','2000-01-01','UTC',null),
               ('silicon',2,'silicon','si:existing','active','Silicon','photo','2000-01-01','UTC','carbon'),
               ('unclaimed',3,'carbon','c:imported','unclaimed','Imported','photo','2000-01-01','UTC',null),
               ('pending',4,'silicon','si:pending','pending_custodian','Pending','photo','2000-01-01','UTC',null),
               ('deleted',5,'silicon',null,'deleted','','','2000-01-01','UTC',null);
        insert into apps(app_id,name,secret_hash,source) values ('other','Other','\x00'::bytea,'fake');
        insert into memberships(app_id,account_uuid,status,source,granted_scopes,first_signed_in_at,last_signed_in_at)
        values ('silicon-accounts','carbon','active','slt','{profile,email}','2026-01-01','2026-02-01');
        insert into memberships(app_id,account_uuid,status,source,access_removed_at)
        values ('other','silicon','access_removed','signin','2026-01-01');
        "#,
    ).execute(&db.pool).await.unwrap();
    let accounts: serde_json::Value =
        sqlx::query_scalar("select jsonb_agg(to_jsonb(a) order by uuid) from accounts a")
            .fetch_one(&db.pool)
            .await
            .unwrap();
    let existing: Vec<serde_json::Value> =
        sqlx::query_scalar("select to_jsonb(m) from memberships m order by app_id, account_uuid")
            .fetch_all(&db.pool)
            .await
            .unwrap();

    let report = accounts_core::db::migrate(&db.pool).await.unwrap();
    assert_eq!(report.applied_now.len(), 1);
    assert_eq!(report.applied_now[0].version, 37);
    let after: serde_json::Value =
        sqlx::query_scalar("select jsonb_agg(to_jsonb(a) order by uuid) from accounts a")
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_eq!(
        accounts, after,
        "registration cannot activate or change an account"
    );
    let preserved: Vec<serde_json::Value> = sqlx::query_scalar(
        "select to_jsonb(m) from memberships m where app_id='other' or account_uuid='carbon' order by app_id, account_uuid",
    ).fetch_all(&db.pool).await.unwrap();
    assert_eq!(existing, preserved);
    let registered: Vec<(String, String, Vec<String>, bool)> = sqlx::query_as(
        "select account_uuid,status,granted_scopes,first_signed_in_at is null and last_signed_in_at is null from memberships where app_id='silicon-accounts' and account_uuid <> 'carbon' order by account_uuid",
    ).fetch_all(&db.pool).await.unwrap();
    assert_eq!(
        registered,
        ["pending", "silicon", "unclaimed"].map(|id| (
            id.to_owned(),
            "active".to_owned(),
            vec!["profile".to_owned()],
            true
        ))
    );
    assert!(
        accounts_core::db::migrate(&db.pool)
            .await
            .unwrap()
            .applied_now
            .is_empty()
    );
    let activity: i64 = sqlx::query_scalar(
        "select (select count(*) from signin_history) + (select count(*) from token_families) + (select count(*) from browser_sessions) + (select count(*) from webhook_events)",
    ).fetch_one(&db.pool).await.unwrap();
    assert_eq!(
        activity, 0,
        "registration does not fabricate logins or notify other apps"
    );
}

#[tokio::test]
async fn account_creation_registers_immediately_and_rolls_back_atomically() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let (silicon, _) = ctx.silicon(&carbon.uuid).await;
    let mut conn = ctx.conn().await;
    for account in [&carbon, &silicon] {
        let m = memberships::get(&mut conn, "silicon-accounts", &account.uuid)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(m.status, MembershipStatus::Active);
        assert_eq!(m.source, MembershipSource::Signin);
        assert_eq!(m.granted_scopes, ["profile"]);
        assert!(m.first_signed_in_at.is_none() && m.last_signed_in_at.is_none());
        assert_eq!(
            m.membership_id,
            format!("silicon-accounts:{}", account.uuid)
        );
    }
    // Bulk imports write directly to the accounts table, bypassing the repository helpers.
    let mut tx = ctx.db.pool.begin().await.unwrap();
    sqlx::raw_sql(
        "insert into accounts(uuid,number,kind,handle,status,display_name,pfp_url,dob,timezone) values \
         ('bulk-carbon',900,'carbon','c:bulk-carbon','unclaimed','Imported','','2000-01-01','UTC'), \
         ('bulk-silicon',901,'silicon','si:bulk-silicon','pending_custodian','Pending','','2000-01-01','UTC'), \
         ('bulk-deleted',902,'silicon',null,'deleted','','','2000-01-01','UTC')",
    ).execute(&mut *tx).await.unwrap();
    let count: i64 = sqlx::query_scalar(
        "select count(*) from memberships where account_uuid like 'bulk-%' and app_id='silicon-accounts'",
    ).fetch_one(&mut *tx).await.unwrap();
    assert_eq!(count, 2);
    tx.rollback().await.unwrap();
    let remaining: i64 =
        sqlx::query_scalar("select count(*) from memberships where account_uuid like 'bulk-%'")
            .fetch_one(&ctx.db.pool)
            .await
            .unwrap();
    assert_eq!(remaining, 0);
    let others: i64 =
        sqlx::query_scalar("select count(*) from memberships where app_id <> 'silicon-accounts'")
            .fetch_one(&ctx.db.pool)
            .await
            .unwrap();
    assert_eq!(others, 0, "registration does not grant another app access");
}
