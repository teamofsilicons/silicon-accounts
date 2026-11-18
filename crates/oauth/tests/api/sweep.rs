//! The background sweep of expired grants.

use accounts_core::models::Scope;
use accounts_core::repo::tokens;
use accounts_core::test_support::TestContext;
use accounts_oauth::{PurgedGrants, purge_expired_grants};

use crate::common::*;

#[tokio::test]
async fn only_grants_expired_for_over_a_week_are_purged() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let (app, _) = ctx.app("briefcase").await;
    for _ in 0..3 {
        signed_in_code(&ctx, &app.app_id, &carbon, Authorize::default()).await;
        let mut conn = ctx.conn().await;
        tokens::create_slt(
            &mut conn,
            &ctx.state.keys.pepper,
            &carbon.uuid,
            &app.app_id,
            &[Scope::Profile],
        )
        .await
        .expect("slt");
        tokens::create_device(&mut conn, &ctx.state.keys.pepper, Some("cli"))
            .await
            .expect("device");
    }
    // Of each kind: one live, one expired a day ago (kept), one expired 8 days ago (purged).
    for table in [
        "authorization_codes",
        "short_lived_tokens",
        "device_authorizations",
    ] {
        ctx.exec(&format!(
            "with ranked as (select ctid, row_number() over (order by created_at, ctid) as n from {table}) \
             update {table} t set expires_at = case ranked.n when 2 then now() - interval '1 day' \
                                                            when 3 then now() - interval '8 days' end \
             from ranked where t.ctid = ranked.ctid and ranked.n in (2, 3)"
        ))
        .await;
    }
    let purged = purge_expired_grants(&ctx.state.db).await.expect("purge");
    assert_eq!(
        purged,
        PurgedGrants {
            refresh_recoveries: 0,
            exchange_recoveries: 0,
            authorization_codes: 1,
            short_lived_tokens: 1,
            device_authorizations: 1,
        }
    );
    assert_eq!(purged.total(), 3);
    for table in [
        "authorization_codes",
        "short_lived_tokens",
        "device_authorizations",
    ] {
        let mut conn = ctx.conn().await;
        let left: i64 =
            sqlx::query_scalar(sqlx::AssertSqlSafe(format!("select count(*) from {table}")))
                .fetch_one(&mut *conn)
                .await
                .expect("count");
        assert_eq!(left, 2, "{table}");
    }
    assert_eq!(
        purge_expired_grants(&ctx.state.db)
            .await
            .expect("purge")
            .total(),
        0,
        "nothing left to purge"
    );
}

#[tokio::test]
async fn exchange_receipts_expired_for_over_a_week_are_purged() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let (app, secret) = ctx.app("briefcase").await;
    let redirect = redirect_for(&app.app_id);
    for key in ["kept", "purged"] {
        let code = signed_in_code(&ctx, &app.app_id, &carbon, Authorize::default()).await;
        let form = [
            ("grant_type", "authorization_code"),
            ("code", code.as_str()),
            ("redirect_uri", redirect.as_str()),
        ];
        let r = ctx
            .call(
                router(),
                token_req(&app.app_id, &secret, &form).header("Idempotency-Key", key),
            )
            .await;
        assert_tokens(&r);
    }
    // Each receipt holds a sealed live refresh token: one expired a day ago (kept), one 8 days.
    ctx.exec(
        "update grant_exchange_recoveries set expires_at = now() - interval '1 day'; \
         update grant_exchange_recoveries set expires_at = now() - interval '8 days' \
         where key_hash = (select key_hash from grant_exchange_recoveries limit 1)",
    )
    .await;
    let purged = purge_expired_grants(&ctx.state.db).await.expect("purge");
    assert_eq!(purged.exchange_recoveries, 1);
    let left: i64 = sqlx::query_scalar("select count(*) from grant_exchange_recoveries")
        .fetch_one(&mut *ctx.conn().await)
        .await
        .expect("count");
    assert_eq!(left, 1, "the receipt expired a day ago is kept");
}
