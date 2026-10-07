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
        let err = otp::verify(&ctx.state.db, pepper, settings, id, wrong, &expect, None)
            .await
            .expect_err("wrong");
        assert_eq!(err.code, "invalid_code", "attempt {attempt}");
        assert_eq!(err.status.as_u16(), 422);
        assert_eq!(
            err.details["remaining_attempts"],
            10 - attempt,
            "attempt {attempt}"
        );
        match attempt {
            8 => assert!(
                err.message.contains("; 2 more tries for "),
                "{}",
                err.message
            ),
            9 => assert!(err.message.contains("; 1 more try for "), "{}", err.message),
            _ => {}
        }
    }
    let err = otp::verify(
        &ctx.state.db,
        pepper,
        settings,
        id,
        &created.code,
        &expect,
        None,
    )
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
        None,
    )
    .await
    .expect_err("still locked");
    assert_eq!(err.code, "verification_locked");
    // The old code was retired by the resend.
    let err = otp::verify(
        &ctx.state.db,
        pepper,
        settings,
        id,
        &created.code,
        &expect,
        None,
    )
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
        None,
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
        None,
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
        None,
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
        None,
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
        None,
    )
    .await
    .expect_err("expired");
    assert_eq!(err.code, "code_expired");
    assert_eq!(err.status.as_u16(), 410);
}

/// 30 parallel sends to one address (each from its own flow, as from 30 browser tabs) get
/// exactly 10 codes: sends to a destination are serialized before they are counted.
#[tokio::test]
async fn parallel_sends_to_one_destination_never_pass_the_limit() {
    let ctx = TestContext::new().await;
    let mut tasks = Vec::new();
    for i in 0..30 {
        let state = ctx.state.clone();
        tasks.push(tokio::spawn(async move {
            let mut tx = state.db.begin().await.expect("tx");
            let flow = format!("flow-{i}");
            let r = otp::send(
                &mut tx,
                &state.keys.pepper,
                &state.settings,
                &NewChallenge {
                    purpose: OtpPurpose::Signin,
                    channel: OtpChannel::Phone,
                    destination: "+14155552671",
                    account_uuid: None,
                    flow_id: Some(&flow),
                    ip: Some(&format!("10.1.{i}.1")),
                },
            )
            .await;
            match r {
                Ok(_) => {
                    tx.commit().await.expect("commit");
                    true
                }
                Err(e) => {
                    assert_eq!(e.code, "rate_limited");
                    false
                }
            }
        }));
    }
    let mut accepted = 0;
    for t in tasks {
        if t.await.expect("join") {
            accepted += 1;
        }
    }
    assert_eq!(
        accepted, 10,
        "the contract allows 10 codes per number per 10 minutes"
    );
    let rows: i64 = sqlx::query_scalar(
        "select count(*) from otp_challenges where destination = '+14155552671'",
    )
    .fetch_one(&ctx.state.db)
    .await
    .expect("count");
    assert_eq!(rows, 10);
}

/// Wrong codes count per address: 10 flows sending to one address share one streak of 10, and
/// the 10th wrong code locks every code to the address (also ones sent later).
#[tokio::test]
async fn the_guess_budget_is_per_address_across_flows() {
    let ctx = TestContext::new().await;
    let (pepper, settings) = (&ctx.state.keys.pepper, &ctx.state.settings);
    let mut conn = ctx.conn().await;
    let dest = "budget@example.test";
    let mut codes = Vec::new();
    for i in 0..5 {
        let flow = format!("budget-{i}");
        let created = otp::send(
            &mut conn,
            pepper,
            settings,
            &NewChallenge {
                flow_id: Some(&flow),
                ..challenge(dest, None)
            },
        )
        .await
        .expect("send");
        codes.push((flow, created));
    }
    let wrong = |code: &str| {
        if code == "000000" {
            "111111".to_string()
        } else {
            "000000".to_string()
        }
    };
    // Two wrong guesses on each of the five flows: the 10th (on the last flow) locks.
    let mut last = None;
    for round in 0..2 {
        for (i, (flow, created)) in codes.iter().enumerate() {
            let err = otp::verify(
                &ctx.state.db,
                pepper,
                settings,
                created.challenge.id,
                &wrong(&created.code),
                &Expect {
                    flow_id: Some(flow),
                    ..Default::default()
                },
                None,
            )
            .await
            .expect_err("wrong");
            assert_eq!(err.code, "invalid_code");
            let n = round * 5 + i + 1;
            assert_eq!(
                err.details["remaining_attempts"],
                (10 - n) as i64,
                "guess {n} counts for the address"
            );
            last = Some(err);
        }
    }
    let last = last.expect("ten guesses");
    assert!(last.details.get("locked_until").is_some());
    assert_eq!(last.retry_after, Some(60));
    // Every code to the address is locked now, even the right one on another flow...
    let (flow, created) = &codes[0];
    let err = otp::verify(
        &ctx.state.db,
        pepper,
        settings,
        created.challenge.id,
        &created.code,
        &Expect {
            flow_id: Some(flow),
            ..Default::default()
        },
        None,
    )
    .await
    .expect_err("locked");
    assert_eq!(err.code, "verification_locked");
    // ...and a code sent during the lock too.
    let fresh = otp::send(
        &mut conn,
        pepper,
        settings,
        &NewChallenge {
            flow_id: Some("budget-new"),
            ..challenge(dest, None)
        },
    )
    .await
    .expect("send");
    let err = otp::verify(
        &ctx.state.db,
        pepper,
        settings,
        fresh.challenge.id,
        &fresh.code,
        &Expect {
            flow_id: Some("budget-new"),
            ..Default::default()
        },
        None,
    )
    .await
    .expect_err("locked");
    assert_eq!(err.code, "verification_locked");
    // Other addresses are not affected.
    let other = otp::send(
        &mut conn,
        pepper,
        settings,
        &challenge("free@example.test", None),
    )
    .await
    .expect("send");
    otp::verify(
        &ctx.state.db,
        pepper,
        settings,
        other.challenge.id,
        &other.code,
        &Expect::default(),
        None,
    )
    .await
    .expect("verified");
}

/// Parallel wrong guesses at one address are counted one after another: of 30 at once, 10 are
/// checked and the rest are refused by the lock.
#[tokio::test]
async fn parallel_guesses_at_one_address_get_ten_checks() {
    let ctx = TestContext::new().await;
    let created = {
        let mut conn = ctx.conn().await;
        otp::send(
            &mut conn,
            &ctx.state.keys.pepper,
            &ctx.state.settings,
            &challenge("burst@example.test", None),
        )
        .await
        .expect("send")
    };
    let wrong = if created.code == "000000" {
        "111111"
    } else {
        "000000"
    };
    let mut tasks = Vec::new();
    for _ in 0..30 {
        let state = ctx.state.clone();
        let id = created.challenge.id;
        tasks.push(tokio::spawn(async move {
            otp::verify(
                &state.db,
                &state.keys.pepper,
                &state.settings,
                id,
                wrong,
                &Expect::default(),
                None,
            )
            .await
            .expect_err("wrong")
            .code
        }));
    }
    let mut checked = 0;
    let mut locked = 0;
    for t in tasks {
        match t.await.expect("join").as_ref() {
            "invalid_code" => checked += 1,
            "verification_locked" => locked += 1,
            other => panic!("unexpected {other}"),
        }
    }
    assert_eq!((checked, locked), (10, 20));
}

/// A lock on a sign-in code of an active Carbon's address shows in its sign-in history.
#[tokio::test]
async fn a_sign_in_lock_is_recorded_for_the_owner_of_the_address() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let email: String = sqlx::query_scalar(
        "select email from account_emails where account_uuid = $1 and is_primary",
    )
    .bind(&carbon.uuid)
    .fetch_one(&ctx.state.db)
    .await
    .expect("email");
    let created = {
        let mut conn = ctx.conn().await;
        otp::send(
            &mut conn,
            &ctx.state.keys.pepper,
            &ctx.state.settings,
            &challenge(&email, None),
        )
        .await
        .expect("send")
    };
    let wrong = if created.code == "000000" {
        "111111"
    } else {
        "000000"
    };
    for _ in 0..10 {
        otp::verify(
            &ctx.state.db,
            &ctx.state.keys.pepper,
            &ctx.state.settings,
            created.challenge.id,
            wrong,
            &Expect::default(),
            Some(otp::Attempt {
                app_id: "accounts",
                ip: Some("10.0.0.7"),
                user_agent: None,
            }),
        )
        .await
        .expect_err("wrong");
    }
    let (failed, locks): (i64, i64) = sqlx::query_as(
        "select (select count(*) from signin_history where account_uuid = $1 and outcome = 'failed'), \
                (select count(*) from audit_log where account_uuid = $1 and action = 'signin.locked')",
    )
    .bind(&carbon.uuid)
    .fetch_one(&ctx.state.db)
    .await
    .expect("history");
    assert_eq!((failed, locks), (1, 1));
}

#[test]
fn created_challenges_never_print_their_code() {
    let printed = format!(
        "{:?}",
        otp::CreatedChallenge {
            challenge: otp::OtpChallenge {
                id: uuid::Uuid::nil(),
                purpose: OtpPurpose::Signin,
                channel: OtpChannel::Email,
                destination: "a@example.test".into(),
                code_hash: vec![],
                account_uuid: None,
                flow_id: None,
                failed_streak: 0,
                total_failures: 0,
                locked_until: None,
                created_at: time::OffsetDateTime::UNIX_EPOCH,
                expires_at: time::OffsetDateTime::UNIX_EPOCH,
                consumed_at: None,
            },
            code: "424242".into(),
        }
    );
    assert!(!printed.contains("424242"), "{printed}");
}
