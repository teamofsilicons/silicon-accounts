//! Emails and phones: the 10 limit, primary rules, conflicts and verification of imported rows.

use accounts_core::models::{AccountStatus, VerifiedVia};
use accounts_core::repo::contacts::{self, ContactKind};
use accounts_core::test_support::{CarbonSpec, TestContext};

#[tokio::test]
async fn up_to_ten_emails_with_one_primary() {
    let ctx = TestContext::new().await;
    let c = ctx
        .carbon_with(CarbonSpec {
            email: Some("first@example.test".into()),
            ..Default::default()
        })
        .await;
    let mut conn = ctx.conn().await;
    for i in 2..=10 {
        let out = contacts::add_verified_email(
            &mut conn,
            &c.uuid,
            &format!("e{i}@example.test"),
            VerifiedVia::Code,
        )
        .await
        .expect("add");
        assert!(!out.became_primary);
    }
    let err = contacts::check_can_add(&mut conn, ContactKind::Email, &c.uuid, "e11@example.test")
        .await
        .expect_err("limit");
    assert_eq!(err.code, "email_limit_reached");
    assert_eq!(err.status.as_u16(), 422);
    let err =
        contacts::add_verified_email(&mut conn, &c.uuid, "e11@example.test", VerifiedVia::Code)
            .await
            .expect_err("limit");
    assert_eq!(err.code, "email_limit_reached");

    let list = contacts::list_emails(&mut conn, &c.uuid)
        .await
        .expect("list");
    assert_eq!(list.len(), 10);
    assert_eq!(list.iter().filter(|e| e.is_primary).count(), 1);
    assert_eq!(list[0].email, "first@example.test");

    // Primary can't be removed; others can.
    let err = contacts::remove_email(&mut conn, &c.uuid, "first@example.test")
        .await
        .expect_err("primary");
    assert_eq!(err.code, "cannot_remove_primary");
    contacts::remove_email(&mut conn, &c.uuid, "e10@example.test")
        .await
        .expect("remove");
    let err = contacts::remove_email(&mut conn, &c.uuid, "e10@example.test")
        .await
        .expect_err("gone");
    assert_eq!(err.code, "email_not_found");

    // Switch primary, then the old primary can go.
    assert!(
        contacts::set_primary_email(&mut conn, &c.uuid, "e2@example.test")
            .await
            .expect("primary")
    );
    assert!(
        !contacts::set_primary_email(&mut conn, &c.uuid, "e2@example.test")
            .await
            .expect("already")
    );
    contacts::remove_email(&mut conn, &c.uuid, "first@example.test")
        .await
        .expect("remove old primary");
    let p = contacts::primary_email(&mut conn, &c.uuid)
        .await
        .expect("q")
        .expect("primary");
    assert_eq!(p.value, "e2@example.test");
    assert!(p.verified);
}

#[tokio::test]
async fn an_email_belongs_to_one_account_only() {
    let ctx = TestContext::new().await;
    let a = ctx
        .carbon_with(CarbonSpec {
            email: Some("a@example.test".into()),
            ..Default::default()
        })
        .await;
    let b = ctx.carbon().await;
    let mut conn = ctx.conn().await;
    let err = contacts::check_can_add(&mut conn, ContactKind::Email, &b.uuid, "a@example.test")
        .await
        .expect_err("in use");
    assert_eq!(err.code, "email_in_use");
    assert_eq!(err.status.as_u16(), 409);
    let err =
        contacts::add_verified_email(&mut conn, &b.uuid, "a@example.test", VerifiedVia::Google)
            .await
            .expect_err("in use");
    assert_eq!(err.code, "email_in_use");
    let err = contacts::check_can_add(&mut conn, ContactKind::Email, &a.uuid, "a@example.test")
        .await
        .expect_err("already");
    assert_eq!(err.code, "email_already_added");
}

#[tokio::test]
async fn phones_follow_the_same_rules() {
    let ctx = TestContext::new().await;
    let c = ctx
        .carbon_with(CarbonSpec {
            email: Some(String::new()),
            ..Default::default()
        })
        .await;
    let mut conn = ctx.conn().await;
    let out = contacts::add_verified_phone(&mut conn, &c.uuid, "+919876543210")
        .await
        .expect("first phone");
    assert!(out.became_primary, "the first phone becomes primary");
    contacts::add_verified_phone(&mut conn, &c.uuid, "+14155552671")
        .await
        .expect("second");
    let err = contacts::remove_phone(&mut conn, &c.uuid, "+919876543210")
        .await
        .expect_err("primary");
    assert_eq!(err.code, "cannot_remove_primary");
    let other = ctx.carbon().await;
    let err = contacts::add_verified_phone(&mut conn, &other.uuid, "+14155552671")
        .await
        .expect_err("in use");
    assert_eq!(err.code, "phone_in_use");
    let p = contacts::primary_phone(&mut conn, &c.uuid)
        .await
        .expect("q")
        .expect("primary");
    assert_eq!(p.value, "+919876543210");
}

#[tokio::test]
async fn imported_unverified_emails_get_verified_when_proven() {
    let ctx = TestContext::new().await;
    let c = ctx
        .carbon_with(CarbonSpec {
            email: Some("imported@example.test".into()),
            status: Some(AccountStatus::Unclaimed),
            ..Default::default()
        })
        .await;
    let mut conn = ctx.conn().await;
    let list = contacts::list_emails(&mut conn, &c.uuid)
        .await
        .expect("list");
    assert!(list[0].verified_at.is_none());
    let err = contacts::set_primary(&mut conn, ContactKind::Email, &c.uuid, "other@example.test")
        .await
        .expect_err("nf");
    assert_eq!(err.code, "email_not_found");
    contacts::check_can_add(
        &mut conn,
        ContactKind::Email,
        &c.uuid,
        "imported@example.test",
    )
    .await
    .expect("unverified passes");
    let out = contacts::add_verified_email(
        &mut conn,
        &c.uuid,
        "imported@example.test",
        VerifiedVia::Code,
    )
    .await
    .expect("verify");
    assert!(out.was_unverified);
    let list = contacts::list_emails(&mut conn, &c.uuid)
        .await
        .expect("list");
    assert!(list[0].verified_at.is_some() && list[0].is_primary);
}
