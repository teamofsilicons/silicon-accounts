//! Accounts: creation and the uuid sequence, id changes with 10-day reservations and reclaim,
//! availability, suggestions, profile updates, deletion and release.

use accounts_core::ids::{AccountId, uuid_for_number};
use accounts_core::models::{AccountField, AccountKind, AccountStatus, VerifiedVia};
use accounts_core::repo::accounts::{self, NewCarbon, NewContact, ProfileUpdate};
use accounts_core::test_support::{CarbonSpec, TestContext};
use time::macros::date;

fn carbon_id(h: &str) -> AccountId {
    AccountId::parse(&format!("c:{h}")).expect("valid id")
}

#[tokio::test]
async fn creation_takes_uuids_from_the_sequence_in_order() {
    let ctx = TestContext::new().await;
    let a = ctx.carbon().await;
    let b = ctx.carbon().await;
    assert_eq!(a.number, 0);
    assert_eq!(a.uuid, uuid_for_number(0));
    assert_eq!(b.number, 1);
    assert_eq!(b.uuid, uuid_for_number(1));
    assert_eq!(a.uuid.len(), 3);
    assert_eq!(a.status, AccountStatus::Active);
    assert_eq!(a.version, 1);
    assert_eq!(
        a.pfp_url,
        format!("https://iris.teamofsilicons.com/pfp/carbon?id={}", a.uuid)
    );

    let mut conn = ctx.conn().await;
    let history: Vec<(Option<String>, Option<String>, Option<String>)> = sqlx::query_as(
        "select old_handle, new_handle, changed_by from handle_history where account_uuid = $1",
    )
    .bind(&a.uuid)
    .fetch_all(&mut *conn)
    .await
    .expect("history");
    assert_eq!(history, vec![(None, a.handle.clone(), Some("test".into()))]);

    let emails = accounts_core::repo::contacts::list_emails(&mut conn, &a.uuid)
        .await
        .expect("emails");
    assert_eq!(emails.len(), 1);
    assert!(emails[0].is_primary && emails[0].verified_at.is_some());
    assert_eq!(emails[0].verified_via, Some(VerifiedVia::Code));
    assert_eq!(
        accounts::by_email(&mut conn, &emails[0].email)
            .await
            .expect("by email")
            .map(|x| x.uuid),
        Some(a.uuid.clone())
    );
    assert_eq!(
        accounts::by_handle(&mut conn, &a.handle.clone().expect("handle").to_uppercase())
            .await
            .expect("by id")
            .map(|x| x.uuid),
        Some(a.uuid)
    );
}

#[tokio::test]
async fn taken_ids_and_used_emails_are_refused_precisely() {
    let ctx = TestContext::new().await;
    let a = ctx
        .carbon_with(CarbonSpec {
            handle: Some("saket".into()),
            email: Some("saket@example.test".into()),
            ..Default::default()
        })
        .await;
    let mut conn = ctx.conn().await;
    let new = |id: &str, email: &str| NewCarbon {
        id: carbon_id(id),
        display_name: "X".into(),
        pfp_url: None,
        dob: date!(2000 - 01 - 01),
        timezone: "UTC".into(),
        status: AccountStatus::Active,
        emails: vec![NewContact {
            value: email.into(),
            verified_via: Some(VerifiedVia::Code),
        }],
        phones: vec![],
        actor: "test".into(),
    };
    let err = accounts::create_carbon(
        &mut conn,
        &ctx.state.settings,
        new("saket", "other@example.test"),
    )
    .await
    .expect_err("taken");
    assert_eq!(err.code, "id_taken");
    assert_eq!(err.status.as_u16(), 409);
    let suggestions = err.details["suggestions"].as_array().expect("suggestions");
    assert_eq!(suggestions.len(), 3);
    assert!(
        suggestions
            .iter()
            .all(|s| s.as_str().is_some_and(|s| s.starts_with("c:saket-"))),
        "{suggestions:?}"
    );

    let err = accounts::create_carbon(
        &mut conn,
        &ctx.state.settings,
        new("someone-else", "saket@example.test"),
    )
    .await
    .expect_err("email");
    assert_eq!(err.code, "email_in_use");
    // The failed attempts did not create anything.
    let count: i64 = sqlx::query_scalar("select count(*) from accounts")
        .fetch_one(&mut *conn)
        .await
        .expect("count");
    assert_eq!(count, 1);

    // A Silicon id can't be used for a Carbon.
    let mut bad = new("x-carbon", "x@example.test");
    bad.id = AccountId::parse("si:x-carbon").expect("id");
    let err = accounts::create_carbon(&mut conn, &ctx.state.settings, bad)
        .await
        .expect_err("kind");
    assert_eq!(err.code, "invalid_id");
    drop(a);
}

#[tokio::test]
async fn id_change_reserves_old_id_for_ten_days_and_owner_can_reclaim() {
    let ctx = TestContext::new().await;
    let alice = ctx
        .carbon_with(CarbonSpec {
            handle: Some("alpha".into()),
            ..Default::default()
        })
        .await;
    let bob = ctx
        .carbon_with(CarbonSpec {
            handle: Some("bob".into()),
            ..Default::default()
        })
        .await;
    let mut conn = ctx.conn().await;

    let change = accounts::change_id(&mut conn, &alice.uuid, &carbon_id("beta"), &alice.uuid)
        .await
        .expect("change");
    assert!(change.changed && !change.reclaimed);
    assert_eq!(
        (change.old_id.as_str(), change.new_id.as_str()),
        ("c:alpha", "c:beta")
    );
    assert_eq!(change.account.version, alice.version + 1);
    let (holder, until) = accounts::active_reservation(&mut conn, "c:alpha")
        .await
        .expect("q")
        .expect("reserved");
    assert_eq!(holder, alice.uuid);
    let days = (until - time::OffsetDateTime::now_utc()).whole_hours();
    assert!(
        (239..=240).contains(&days),
        "reserved for 10 days, got {days} hours"
    );

    // Someone else can't take it, and sees why.
    let err = accounts::change_id(&mut conn, &bob.uuid, &carbon_id("alpha"), &bob.uuid)
        .await
        .expect_err("reserved");
    assert_eq!(err.code, "id_reserved");
    let avail = accounts::id_availability(&mut conn, "c:alpha", Some(&bob.uuid))
        .await
        .expect("availability");
    assert!(!avail.available && !avail.reclaimable);
    assert_eq!(avail.reason, Some("reserved"));
    let anon = accounts::id_availability(&mut conn, "c:alpha", None)
        .await
        .expect("availability");
    assert_eq!(anon.reason, Some("reserved"));

    // The previous owner sees it as reclaimable and takes it back.
    let mine = accounts::id_availability(&mut conn, "c:alpha", Some(&alice.uuid))
        .await
        .expect("availability");
    assert!(mine.available && mine.reclaimable && mine.reason.is_none());
    let back = accounts::change_id(&mut conn, &alice.uuid, &carbon_id("alpha"), &alice.uuid)
        .await
        .expect("reclaim");
    assert!(back.changed && back.reclaimed);
    assert!(
        accounts::active_reservation(&mut conn, "c:alpha")
            .await
            .expect("q")
            .is_none()
    );
    let (holder, _) = accounts::active_reservation(&mut conn, "c:beta")
        .await
        .expect("q")
        .expect("beta reserved now");
    assert_eq!(holder, alice.uuid);

    // Changing to the current id is a no-op.
    let same = accounts::change_id(&mut conn, &alice.uuid, &carbon_id("alpha"), &alice.uuid)
        .await
        .expect("same");
    assert!(!same.changed);

    // Taken ids answer id_taken with suggestions.
    let err = accounts::change_id(&mut conn, &alice.uuid, &carbon_id("bob"), &alice.uuid)
        .await
        .expect_err("taken");
    assert_eq!(err.code, "id_taken");

    // After 10 days the reservation lapses and anyone can take it.
    sqlx::query("update handle_reservations set reserved_until = now() - interval '1 second' where handle = 'c:beta'")
        .execute(&mut *conn)
        .await
        .expect("time travel");
    let taken = accounts::change_id(&mut conn, &bob.uuid, &carbon_id("beta"), &bob.uuid)
        .await
        .expect("free again");
    assert_eq!(taken.new_id, "c:beta");

    let history: i64 =
        sqlx::query_scalar("select count(*) from handle_history where account_uuid = $1")
            .bind(&alice.uuid)
            .fetch_one(&mut *conn)
            .await
            .expect("history");
    assert_eq!(history, 3, "created + 2 changes");

    // c: and si: handles are independent.
    let si = accounts::id_availability(&mut conn, "si:alpha", None)
        .await
        .expect("availability");
    assert!(si.available);
}

#[tokio::test]
async fn availability_reports_invalid_and_reserved_words() {
    let ctx = TestContext::new().await;
    let me = ctx
        .carbon_with(CarbonSpec {
            handle: Some("taken-one".into()),
            ..Default::default()
        })
        .await;
    let mut conn = ctx.conn().await;
    let a = accounts::id_availability(&mut conn, "c:no", None)
        .await
        .expect("q");
    assert_eq!((a.available, a.reason), (false, Some("invalid")));
    assert!(a.message.contains("at least 3"));
    let a = accounts::id_availability(&mut conn, "c:Admin", None)
        .await
        .expect("q");
    assert_eq!((a.available, a.reason), (false, Some("reserved_word")));
    let a = accounts::id_availability(&mut conn, "C:Taken-One", None)
        .await
        .expect("q");
    assert_eq!(
        (a.id.as_str(), a.available, a.reason),
        ("c:taken-one", false, Some("taken"))
    );
    let a = accounts::id_availability(&mut conn, "c:taken-one", Some(&me.uuid))
        .await
        .expect("q");
    assert!(a.message.contains("already your id"));
    let a = accounts::id_availability(&mut conn, "c:fresh-id", None)
        .await
        .expect("q");
    assert!(a.available && a.reason.is_none());

    let s = accounts::suggest_ids(
        &mut conn,
        AccountKind::Carbon,
        &["Taken.One", "Taken One"],
        2,
    )
    .await
    .expect("suggest");
    assert_eq!(
        s.iter().map(|i| i.to_string()).collect::<Vec<_>>(),
        vec!["c:taken-one-2", "c:taken-one-3"]
    );
}

#[tokio::test]
async fn profile_updates_report_changed_fields_and_bump_version() {
    let ctx = TestContext::new().await;
    let c = ctx.carbon().await;
    let mut conn = ctx.conn().await;
    let (updated, changed) = accounts::update_profile(
        &mut conn,
        &c.uuid,
        &ProfileUpdate {
            display_name: Some("Saket".into()),
            timezone: Some("UTC".into()), // unchanged
            dob: Some(date!(1999 - 05 - 05)),
            pfp_url: None,
        },
    )
    .await
    .expect("update");
    assert_eq!(changed, vec![AccountField::DisplayName, AccountField::Dob]);
    assert_eq!(updated.version, c.version + 1);
    assert_eq!(updated.display_name, "Saket");

    let (same, nothing) = accounts::update_profile(
        &mut conn,
        &c.uuid,
        &ProfileUpdate {
            display_name: Some("Saket".into()),
            ..Default::default()
        },
    )
    .await
    .expect("noop");
    assert!(nothing.is_empty());
    assert_eq!(same.version, updated.version);

    let (silicon, _) = ctx.silicon(&c.uuid).await;
    assert_eq!(silicon.dob, time::OffsetDateTime::now_utc().date());
    let err = accounts::update_profile(
        &mut conn,
        &silicon.uuid,
        &ProfileUpdate {
            dob: Some(date!(2000 - 01 - 01)),
            ..Default::default()
        },
    )
    .await
    .expect_err("dob immutable");
    assert_eq!(err.code, "dob_immutable");
    assert_eq!(
        accounts::count_silicons_in_custody(&mut conn, &c.uuid)
            .await
            .expect("count"),
        1
    );
}

#[tokio::test]
async fn deletion_reserves_id_frees_contacts_and_revokes_everything() {
    let ctx = TestContext::new().await;
    let c = ctx
        .carbon_with(CarbonSpec {
            handle: Some("leaving".into()),
            email: Some("leaving@example.test".into()),
            ..Default::default()
        })
        .await;
    let tokens = ctx.first_party_tokens(&c).await;
    let _cookie = ctx.browser_session(&c).await;
    let mut conn = ctx.conn().await;

    let deleted = accounts::delete_account(&mut conn, &c.uuid, &c.uuid, true)
        .await
        .expect("delete");
    assert_eq!(deleted.old_id.as_deref(), Some("c:leaving"));
    assert_eq!(deleted.revoked_families, 1);
    let after = accounts::get(&mut conn, &c.uuid)
        .await
        .expect("q")
        .expect("row stays");
    assert_eq!(after.status, AccountStatus::Deleted);
    assert!(after.handle.is_none() && after.deleted_at.is_some());
    assert!(
        accounts::active_reservation(&mut conn, "c:leaving")
            .await
            .expect("q")
            .is_some()
    );
    let live_sessions: i64 = sqlx::query_scalar(
        "select count(*) from browser_sessions where account_uuid = $1 and revoked_at is null",
    )
    .bind(&c.uuid)
    .fetch_one(&mut *conn)
    .await
    .expect("q");
    assert_eq!(live_sessions, 0);
    let err = accounts_core::repo::tokens::verify_access_token(
        &mut conn,
        &ctx.state.keys,
        &tokens.access_token,
        None,
    )
    .await
    .expect_err("revoked");
    assert_eq!(err.code, "token_revoked");

    // The email is free for a new account; the uuid is never reused.
    let fresh = ctx
        .carbon_with(CarbonSpec {
            email: Some("leaving@example.test".into()),
            ..Default::default()
        })
        .await;
    assert_ne!(fresh.uuid, c.uuid);
    // Idempotent.
    accounts::delete_account(&mut conn, &c.uuid, &c.uuid, true)
        .await
        .expect("again");
}

#[tokio::test]
async fn releasing_a_silicon_frees_its_id_immediately() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let (s, _) = ctx.silicon(&carbon.uuid).await;
    let handle = s.handle.clone().expect("handle");
    let mut conn = ctx.conn().await;
    accounts::release_silicon(&mut conn, &s.uuid, "system")
        .await
        .expect("release");
    assert!(
        accounts::active_reservation(&mut conn, &handle)
            .await
            .expect("q")
            .is_none()
    );
    let avail = accounts::id_availability(&mut conn, &handle, None)
        .await
        .expect("q");
    assert!(avail.available);
}
