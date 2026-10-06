//! OTP: 10 sends per destination per rolling 10 minutes (and 30 per IP), 10 wrong codes →
//! 60 s cooldown, 10-minute expiry, resend semantics.

use accounts_core::models::{OtpChannel, OtpPurpose};
use accounts_core::repo::otp::{self, Expect, NewChallenge};
use accounts_core::test_support::TestContext;

fn challenge<'a>(dest: &'a str, ip: Option<&'a str>) -> NewChallenge<'a> {
    NewChallenge {
        purpose: OtpPurpose::Signin,
        channel: OtpChannel::Email,
        destination: dest,
        account_uuid: None,
        flow_id: Some("flow-1"),
        ip,
    }
}

#[tokio::test]
async fn eleventh_send_within_ten_minutes_is_rate_limited() {
    let ctx = TestContext::new().await;
    let (pepper, settings) = (&ctx.state.keys.pepper, &ctx.state.settings);
    let mut conn = ctx.conn().await;
    for _ in 0..10 {
        otp::send(
            &mut conn,
            pepper,
            settings,
            &challenge("limit@example.test", Some("10.0.0.1")),
        )
        .await
        .expect("send");
    }
    let err = otp::send(
        &mut conn,
        pepper,
        settings,
        &challenge("limit@example.test", Some("10.0.0.1")),
    )
    .await
    .expect_err("11th");
    assert_eq!(err.code, "rate_limited");
    assert_eq!(err.status.as_u16(), 429);
    let retry = err.retry_after.expect("retry after");
    assert!(
        (590..=600).contains(&retry),
        "retry in about 10 minutes, got {retry}"
    );
    assert!(err.message.contains("l***@example.test"), "{}", err.message);

    // The window is rolling: once the oldest send is older than 10 minutes, one more is allowed.
    sqlx::query(
        "update otp_challenges set created_at = now() - interval '11 minutes' \
         where id = (select id from otp_challenges where destination = 'limit@example.test' order by created_at limit 1)",
    )
    .execute(&mut *conn)
    .await
    .expect("time travel");
    otp::send(
        &mut conn,
        pepper,
        settings,
        &challenge("limit@example.test", Some("10.0.0.1")),
    )
    .await
    .expect("allowed again");

    // Other destinations are unaffected.
    otp::send(
        &mut conn,
        pepper,
        settings,
        &challenge("other@example.test", Some("10.0.0.1")),
    )
    .await
    .expect("other");
}

#[tokio::test]
async fn per_ip_limit_is_thirty_per_ten_minutes() {
    let ctx = TestContext::new().await;
    let (pepper, settings) = (&ctx.state.keys.pepper, &ctx.state.settings);
    let mut conn = ctx.conn().await;
    for i in 0..30 {
        otp::send(
            &mut conn,
            pepper,
            settings,
            &challenge(&format!("ip{i}@example.test"), Some("10.9.9.9")),
        )
        .await
        .expect("send");
    }
    let err = otp::send(
        &mut conn,
        pepper,
        settings,
        &challenge("ip31@example.test", Some("10.9.9.9")),
    )
    .await
    .expect_err("ip limit");
    assert_eq!(err.code, "rate_limited");
    otp::send(
        &mut conn,
        pepper,
        settings,
        &challenge("ip31@example.test", Some("10.9.9.8")),
    )
    .await
    .expect("other ip");
}

#[tokio::test]
async fn ten_wrong_codes_lock_for_a_minute_then_the_code_works() {
    let ctx = TestContext::new().await;
    let (pepper, settings) = (&ctx.state.keys.pepper, &ctx.state.settings);
    let mut conn = ctx.conn().await;
    let created = otp::send(
        &mut conn,
        pepper,
        settings,
        &challenge("lock@example.test", None),
    )
    .await
    .expect("send");
    assert_eq!(created.code.len(), 6);
    let id = created.challenge.id;
    let wrong = if created.code == "000000" {
        "111111"
    } else {
        "000000"
    };
    let expect = Expect {
        flow_id: Some("flow-1"),
        ..Default::default()
    };
    for attempt in 1..=10 {
        let err = otp::verify(&ctx.state.db, pepper, settings, id, wrong, &expect)
            .await
            .expect_err("wrong");
        assert_eq!(err.code, "invalid_code", "attempt {attempt}");
        assert_eq!(err.status.as_u16(), 422);
        assert_eq!(
            err.details["remaining_attempts"],
            10 - attempt,
            "attempt {attempt}"
        );
    }
    let err = otp::verify(&ctx.state.db, pepper, settings, id, &created.code, &expect)
        .await
        .expect_err("locked");
    assert_eq!(err.code, "verification_locked");
    assert_eq!(err.status.as_u16(), 423);
    assert!(err.retry_after.is_some_and(|s| s <= 60));

    // Resending does not bypass the cooldown.
    let resent = otp::send(
        &mut conn,
        pepper,
        settings,
        &challenge("lock@example.test", None),
    )
    .await
    .expect("resend");
    let err = otp::verify(
        &ctx.state.db,
        pepper,
        settings,
        resent.challenge.id,
        &resent.code,
        &expect,
    )
    .await
    .expect_err("still locked");
    assert_eq!(err.code, "verification_locked");
    // The old code was retired by the resend.
    let err = otp::verify(&ctx.state.db, pepper, settings, id, &created.code, &expect)
        .await
        .expect_err("retired");
    assert!(
        err.code == "code_expired" || err.code == "verification_locked",
        "{}",
        err.code
    );

    // After the cooldown the latest code works.
    sqlx::query("update otp_challenges set locked_until = now() - interval '1 second' where destination = 'lock@example.test'")
        .execute(&mut *conn)
        .await
        .expect("time travel");
    let ok = otp::verify(
        &ctx.state.db,
        pepper,
        settings,
        resent.challenge.id,
        &resent.code,
        &expect,
    )
    .await
    .expect("verified");
    assert!(ok.consumed_at.is_some());
    assert_eq!(ok.destination, "lock@example.test");
    let err = otp::verify(
        &ctx.state.db,
        pepper,
        settings,
        resent.challenge.id,
        &resent.code,
        &expect,
    )
    .await
    .expect_err("used");
    assert_eq!(err.code, "code_already_used");
}

#[tokio::test]
async fn codes_expire_and_are_bound_to_their_flow() {
    let ctx = TestContext::new().await;
    let (pepper, settings) = (&ctx.state.keys.pepper, &ctx.state.settings);
    let mut conn = ctx.conn().await;
    let created = otp::send(
        &mut conn,
        pepper,
        settings,
        &challenge("exp@example.test", None),
    )
    .await
    .expect("send");
    let ttl = (created.challenge.expires_at - created.challenge.created_at).whole_seconds();
    assert_eq!(ttl, 600);

    let other_flow = Expect {
        flow_id: Some("flow-2"),
        ..Default::default()
    };
    let err = otp::verify(
        &ctx.state.db,
        pepper,
        settings,
        created.challenge.id,
        &created.code,
        &other_flow,
    )
    .await
    .expect_err("bound");
    assert_eq!(err.code, "challenge_not_found");

    let err = otp::verify(
        &ctx.state.db,
        pepper,
        settings,
        created.challenge.id,
        "12ab",
        &Expect::default(),
    )
    .await
    .expect_err("format");
    assert_eq!(err.code, "invalid_code");

    sqlx::query("update otp_challenges set expires_at = now() - interval '1 second' where id = $1")
        .bind(created.challenge.id)
        .execute(&mut *conn)
        .await
        .expect("time travel");
    let err = otp::verify(
        &ctx.state.db,
        pepper,
        settings,
        created.challenge.id,
        &created.code,
        &Expect::default(),
    )
    .await
    .expect_err("expired");
    assert_eq!(err.code, "code_expired");
    assert_eq!(err.status.as_u16(), 410);
}
