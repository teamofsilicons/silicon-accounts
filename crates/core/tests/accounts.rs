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

    let deleted = accounts::delete_account(&mut conn, &ctx.state.settings, &c.uuid, &c.uuid, true)
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
    // The hold is not "for its previous owner": a deleted account can never take it back.
    let seen = accounts::id_availability_for(&mut conn, "c:leaving", None, None)
        .await
        .expect("availability");
    assert_eq!(
        (seen.available, seen.reason, seen.reclaimable),
        (false, Some("reserved"), false)
    );
    assert!(
        seen.message
            .starts_with("c:leaving belonged to an account that was deleted; it is held until ")
            && seen.message.ends_with(" and can be taken after that."),
        "{}",
        seen.message
    );
    let other = ctx.carbon().await;
    let err = accounts::change_id(&mut conn, &other.uuid, &carbon_id("leaving"), &other.uuid)
        .await
        .expect_err("held");
    assert_eq!(err.code, "id_reserved");
    assert!(
        err.message
            .contains("belonged to an account that was deleted"),
        "{}",
        err.message
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
    accounts::delete_account(&mut conn, &ctx.state.settings, &c.uuid, &c.uuid, true)
        .await
        .expect("again");
}

#[tokio::test]
async fn releasing_a_silicon_frees_its_id_immediately_and_keeps_its_webhook() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let (s, request_id) = ctx
        .pending_silicon(&carbon.uuid, Some("http://127.0.0.1:8593/si/hooks"))
        .await;
    let handle = s.handle.clone().expect("handle");
    let mut conn = ctx.conn().await;
    // An active Silicon is never released.
    let (active, _) = ctx.silicon(&carbon.uuid).await;
    assert_eq!(
        accounts::release_silicon(&mut conn, &active.uuid, "system")
            .await
            .expect("no-op"),
        None
    );
    // The decline handler's order: decide the request, tell the Silicon, release it.
    sqlx::query(
        "update custodian_requests set status = 'declined', decided_at = now() where id = $1",
    )
    .bind(request_id)
    .execute(&mut *conn)
    .await
    .expect("decline");
    accounts_core::events::silicon_custodian_declined(
        &mut conn,
        &s,
        request_id,
        "c:someone",
        None,
        accounts_core::events::declined_reason::DECLINED,
    )
    .await
    .expect("event")
    .expect("the Silicon has a webhook");
    assert_eq!(
        accounts::release_silicon(&mut conn, &s.uuid, "system")
            .await
            .expect("release"),
        Some(handle.clone())
    );
    let after = accounts::get(&mut conn, &s.uuid)
        .await
        .expect("q")
        .expect("row");
    assert_eq!(after.status, AccountStatus::Deleted);
    assert!(after.handle.is_none() && after.stk_hash.is_none());
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
    // The worker can still deliver the declined event: URL and secret are kept.
    use accounts_core::models::WebhookTargetKind;
    assert_eq!(
        accounts_core::events::current_url(&mut conn, WebhookTargetKind::Silicon, &s.uuid)
            .await
            .expect("url")
            .as_deref(),
        Some("http://127.0.0.1:8593/si/hooks")
    );
    assert_eq!(
        accounts_core::events::current_secret(
            &mut conn,
            &ctx.state.keys.keyring,
            WebhookTargetKind::Silicon,
            &s.uuid
        )
        .await
        .expect("secret")
        .as_deref(),
        Some("whsec_test")
    );
    // The declined request stays declined (release only cancels pending ones).
    let status: String = sqlx::query_scalar("select status from custodian_requests where id = $1")
        .bind(request_id)
        .fetch_one(&mut *conn)
        .await
        .expect("q");
    assert_eq!(status, "declined");
}

#[tokio::test]
async fn deleting_a_custodian_is_refused_and_waiting_silicons_are_released() {
    let ctx = TestContext::new().await;
    let carbon = ctx
        .carbon_with(CarbonSpec {
            handle: Some("named".into()),
            ..Default::default()
        })
        .await;
    let (active, _) = ctx.silicon(&carbon.uuid).await;
    let (waiting, request_id) = ctx
        .pending_silicon(&carbon.uuid, Some("http://127.0.0.1:8593/si/w"))
        .await;
    let waiting_id = waiting.handle.clone().expect("id");
    let mut conn = ctx.conn().await;

    // Still the custodian of an active Silicon: refused, nothing changes.
    let err = accounts::delete_account(
        &mut conn,
        &ctx.state.settings,
        &carbon.uuid,
        &carbon.uuid,
        true,
    )
    .await
    .expect_err("custodian");
    assert_eq!(err.code, "custodian_of_silicons");
    assert_eq!(err.details["silicons"][0]["uuid"], active.uuid.as_str());
    assert_eq!(
        accounts::get(&mut conn, &waiting.uuid)
            .await
            .expect("q")
            .expect("row")
            .status,
        AccountStatus::PendingCustodian
    );

    // Once the Silicon is gone, the deletion goes through and releases the waiting one.
    accounts::delete_account(
        &mut conn,
        &ctx.state.settings,
        &active.uuid,
        &carbon.uuid,
        true,
    )
    .await
    .expect("delete the Silicon");
    let deleted = accounts::delete_account(
        &mut conn,
        &ctx.state.settings,
        &carbon.uuid,
        &carbon.uuid,
        true,
    )
    .await
    .expect("delete");
    assert!(deleted.deleted_now);
    assert_eq!(
        deleted.released_silicons,
        vec![accounts::ReleasedSilicon {
            uuid: waiting.uuid.clone(),
            old_id: Some(waiting_id.clone()),
            request_id,
        }]
    );
    let released = accounts::get(&mut conn, &waiting.uuid)
        .await
        .expect("q")
        .expect("row");
    assert_eq!(released.status, AccountStatus::Deleted);
    assert!(released.handle.is_none());
    assert!(
        accounts::active_reservation(&mut conn, &waiting_id)
            .await
            .expect("q")
            .is_none()
    );
    assert_eq!(
        released.webhook_url.as_deref(),
        Some("http://127.0.0.1:8593/si/w"),
        "the webhook stays so the declined event can be delivered"
    );
    let (status, decided_by): (String, Option<String>) =
        sqlx::query_as("select status, decided_by from custodian_requests where id = $1")
            .bind(request_id)
            .fetch_one(&mut *conn)
            .await
            .expect("q");
    assert_eq!(
        (status.as_str(), decided_by.as_deref()),
        ("cancelled", Some(carbon.uuid.as_str()))
    );
    let payload: serde_json::Value = sqlx::query_scalar(
        "select e.payload from webhook_events e join webhook_deliveries d on d.event_id = e.event_id \
          where e.target_kind = 'silicon' and e.target_id = $1 and e.type = 'silicon.custodian.declined' \
            and d.status = 'pending'",
    )
    .bind(&waiting.uuid)
    .fetch_one(&mut *conn)
    .await
    .expect("declined event with a pending delivery");
    assert_eq!(payload["data"]["reason"], "custodian_account_deleted");
    assert_eq!(payload["data"]["custodian"], "c:named");
    assert_eq!(payload["data"]["id"], waiting_id.as_str());
    assert_eq!(payload["data"]["request_id"], request_id.to_string());
    let closed: i64 = sqlx::query_scalar(
        "select count(*) from audit_log where account_uuid = $1 and action = 'silicon.custodian_request.closed'",
    )
    .bind(&waiting.uuid)
    .fetch_one(&mut *conn)
    .await
    .expect("q");
    assert_eq!(closed, 1);
    // Nothing is left for the silicons crate's 14-day sweep or orphan safety net.
    let pending: i64 = sqlx::query_scalar(
        "select count(*) from custodian_requests where silicon_uuid = $1 and status = 'pending'",
    )
    .bind(&waiting.uuid)
    .fetch_one(&mut *conn)
    .await
    .expect("q");
    assert_eq!(pending, 0);
}

#[tokio::test]
async fn deletion_resets_the_photo_prunes_uploads_and_drops_imported_personal_data() {
    let ctx = TestContext::new().await;
    let c = ctx.carbon().await;
    let (app, _) = ctx.app("crm").await;
    let mut conn = ctx.conn().await;
    let photo = uuid::Uuid::now_v7();
    sqlx::query("insert into photos (id, account_uuid, content_type, bytes) values ($1, $2, 'image/png', '\\x00')")
        .bind(photo)
        .bind(&c.uuid)
        .execute(&mut *conn)
        .await
        .expect("photo");
    let url = accounts_core::pfp::photo_url(&ctx.state.settings, photo);
    sqlx::query("update accounts set pfp_url = $2 where uuid = $1")
        .bind(&c.uuid)
        .bind(&url)
        .execute(&mut *conn)
        .await
        .expect("set photo");
    accounts_core::repo::memberships::upsert_imported(
        &mut conn,
        &app.app_id,
        &c.uuid,
        Some("crm-42"),
        Some(&serde_json::json!({"email": "old@corp.test"})),
        false,
    )
    .await
    .expect("import");
    let deleted = accounts::delete_account(&mut conn, &ctx.state.settings, &c.uuid, &c.uuid, true)
        .await
        .expect("delete");
    assert_eq!(deleted.deleted_photos, 1);
    let after = accounts::get(&mut conn, &c.uuid)
        .await
        .expect("q")
        .expect("row");
    assert!(accounts_core::pfp::is_default_pfp(
        &ctx.state.settings.iris_base_url,
        &after.pfp_url
    ));
    let (profile, external): (Option<serde_json::Value>, Option<String>) = sqlx::query_as(
        "select imported_profile, external_id from memberships where app_id = $1 and account_uuid = $2",
    )
    .bind(&app.app_id)
    .bind(&c.uuid)
    .fetch_one(&mut *conn)
    .await
    .expect("membership stays as history");
    // The app's personal data about the Carbon goes; its own key for the user stays, so it can
    // match the deletion to its records.
    assert_eq!((profile, external.as_deref()), (None, Some("crm-42")));
}

#[tokio::test]
async fn create_carbon_refuses_more_than_ten_emails() {
    let ctx = TestContext::new().await;
    let mut conn = ctx.conn().await;
    let emails = (0..11)
        .map(|i| NewContact {
            value: format!("many{i}@example.test"),
            verified_via: Some(VerifiedVia::Code),
        })
        .collect();
    let err = accounts::create_carbon(
        &mut conn,
        &ctx.state.settings,
        NewCarbon {
            id: carbon_id("many-mails"),
            display_name: "Many".into(),
            pfp_url: None,
            dob: date!(2000 - 01 - 01),
            timezone: "UTC".into(),
            status: AccountStatus::Unclaimed,
            emails,
            phones: vec![],
            actor: "import".into(),
        },
    )
    .await
    .expect_err("too many");
    assert_eq!(err.code, "email_limit_reached");
    assert!(err.message.contains("11"), "{}", err.message);
}

#[tokio::test]
async fn ids_change_at_most_five_times_a_day() {
    let ctx = TestContext::new().await;
    let c = ctx.carbon().await;
    let mut conn = ctx.conn().await;
    for i in 0..5 {
        accounts::change_id(
            &mut conn,
            &c.uuid,
            &carbon_id(&format!("hop-{i}-{}", c.uuid.to_lowercase())),
            &c.uuid,
        )
        .await
        .expect("change");
    }
    // The current id again is no change and never counts.
    let current = accounts::get(&mut conn, &c.uuid)
        .await
        .expect("q")
        .expect("row");
    let same = AccountId::parse(current.handle.as_deref().expect("id")).expect("id");
    assert!(
        !accounts::change_id(&mut conn, &c.uuid, &same, &c.uuid)
            .await
            .expect("same")
            .changed
    );
    let err = accounts::change_id(&mut conn, &c.uuid, &carbon_id("hop-six"), &c.uuid)
        .await
        .expect_err("limit");
    assert_eq!(err.code, "rate_limited");
    assert!(err.retry_after.is_some_and(|s| s > 86_000));
    assert!(err.details.get("retry_at").is_some());
    // Changes older than 24 hours leave the window.
    sqlx::query("update handle_history set changed_at = now() - interval '25 hours' where account_uuid = $1")
        .bind(&c.uuid)
        .execute(&mut *conn)
        .await
        .expect("time travel");
    accounts::change_id(&mut conn, &c.uuid, &carbon_id("hop-six"), &c.uuid)
        .await
        .expect("allowed again");
}

#[tokio::test]
async fn parallel_stk_guesses_get_at_most_ten_checks() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let (s, _) = ctx.silicon(&carbon.uuid).await;
    let mut tasks = Vec::new();
    for _ in 0..25 {
        let pool = ctx.state.db.clone();
        let uuid = s.uuid.clone();
        tasks.push(tokio::spawn(async move {
            accounts::begin_stk_attempt(
                &pool,
                &uuid,
                accounts::MAX_STK_FAILURES,
                accounts::STK_LOCK_SECONDS,
            )
            .await
            .expect("attempt")
        }));
    }
    let mut checks = Vec::new();
    for t in tasks {
        if let accounts::StkAttempt::Check { attempt } = t.await.expect("join") {
            checks.push(attempt);
        }
    }
    checks.sort_unstable();
    assert_eq!(
        checks,
        (1..=10).collect::<Vec<i32>>(),
        "ten checks, then locked"
    );
    match accounts::begin_stk_attempt(&ctx.state.db, &s.uuid, 10, 60)
        .await
        .expect("attempt")
    {
        accounts::StkAttempt::Locked {
            retry_after_seconds,
        } => assert!((1..=60).contains(&retry_after_seconds)),
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn the_tenth_wrong_stk_locks_and_a_right_one_resets() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let (s, _) = ctx.silicon(&carbon.uuid).await;
    let pool = &ctx.state.db;
    for n in 1..=9 {
        let accounts::StkAttempt::Check { attempt } =
            accounts::begin_stk_attempt(pool, &s.uuid, 10, 60)
                .await
                .expect("a")
        else {
            panic!("locked early at {n}");
        };
        assert_eq!(attempt, n);
        assert!(
            accounts::stk_attempt_failed(pool, &s.uuid, attempt, 10, 60)
                .await
                .expect("f")
                .is_none()
        );
    }
    // A right STK resets the run.
    let mut conn = ctx.conn().await;
    accounts::clear_stk_failures(&mut conn, &s.uuid)
        .await
        .expect("clear");
    for n in 1..=10 {
        let accounts::StkAttempt::Check { attempt } =
            accounts::begin_stk_attempt(pool, &s.uuid, 10, 60)
                .await
                .expect("a")
        else {
            panic!("locked early at {n}");
        };
        let locked = accounts::stk_attempt_failed(pool, &s.uuid, attempt, 10, 60)
            .await
            .expect("f");
        assert_eq!(locked.is_some(), n == 10, "attempt {n}");
    }
    assert!(matches!(
        accounts::begin_stk_attempt(pool, &s.uuid, 10, 60)
            .await
            .expect("a"),
        accounts::StkAttempt::Locked { .. }
    ));
}

#[tokio::test]
async fn stk_rotation_is_stamped_with_the_statement_clock() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let (s, _) = ctx.silicon(&carbon.uuid).await;
    let mut tx = ctx.state.db.begin().await.expect("tx");
    let started: time::OffsetDateTime = sqlx::query_scalar("select now()")
        .fetch_one(&mut *tx)
        .await
        .expect("now");
    tokio::time::sleep(std::time::Duration::from_millis(30)).await;
    let rotated = accounts::set_stk(&mut tx, &s.uuid, "phc")
        .await
        .expect("rotate");
    tx.commit().await.expect("commit");
    assert!(
        rotated - started >= time::Duration::milliseconds(25),
        "stk_rotated_at {rotated} must be taken when the row is locked, not at the transaction start {started}"
    );
}

#[tokio::test]
async fn finishing_an_import_drops_the_addresses_nobody_proved() {
    use accounts_core::repo::contacts::{self, ContactKind, Holder};
    let ctx = TestContext::new().await;
    let mut conn = ctx.conn().await;
    let unclaimed = accounts::create_carbon(
        &mut conn,
        &ctx.state.settings,
        NewCarbon {
            id: carbon_id("imported-one"),
            display_name: "Imported".into(),
            pfp_url: None,
            dob: date!(2000 - 01 - 01),
            timezone: "UTC".into(),
            status: AccountStatus::Unclaimed,
            emails: vec![
                NewContact {
                    value: "victim@corp.test".into(),
                    verified_via: None,
                },
                NewContact {
                    value: "claimer@corp.test".into(),
                    verified_via: None,
                },
            ],
            phones: vec![NewContact {
                value: "+14155552671".into(),
                verified_via: None,
            }],
            actor: "import".into(),
        },
    )
    .await
    .expect("import");
    // Before the claim, every listed address leads to the unfinished import.
    assert!(matches!(
        contacts::lookup(&mut conn, ContactKind::Email, "victim@corp.test")
            .await
            .expect("q"),
        Holder::Unclaimed(_)
    ));
    let done = accounts::finish_claim(
        &mut conn,
        &unclaimed.uuid,
        &[(ContactKind::Email, "claimer@corp.test", VerifiedVia::Code)],
    )
    .await
    .expect("claim");
    assert_eq!(done.account.status, AccountStatus::Active);
    assert_eq!(done.account.version, unclaimed.version + 1);
    assert!(done.changed.contains(&AccountField::Email));
    assert!(done.changed.contains(&AccountField::Phone));
    let emails = contacts::list_emails(&mut conn, &unclaimed.uuid)
        .await
        .expect("q");
    assert_eq!(emails.len(), 1);
    assert_eq!(emails[0].email, "claimer@corp.test");
    assert!(emails[0].is_primary && emails[0].verified_at.is_some());
    assert!(
        contacts::list_phones(&mut conn, &unclaimed.uuid)
            .await
            .expect("q")
            .is_empty()
    );
    // The unproven addresses identify nobody now, and the real owners can use them.
    assert!(matches!(
        contacts::lookup(&mut conn, ContactKind::Email, "victim@corp.test")
            .await
            .expect("q"),
        Holder::Free
    ));
    let other = ctx.carbon().await;
    contacts::check_can_add(
        &mut conn,
        ContactKind::Email,
        &other.uuid,
        "victim@corp.test",
    )
    .await
    .expect("free for its owner");
    // Claiming twice is refused.
    let err = accounts::finish_claim(&mut conn, &unclaimed.uuid, &[])
        .await
        .expect_err("already active");
    assert_eq!(err.code, "account_not_unclaimed");
}

/// A Silicon that names the Carbon while the Carbon's deletion waits for its row lock (the
/// self-creation share-locks the Carbon before storing its request) is released by that
/// deletion too, not left waiting on a cancelled request.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_silicon_naming_the_carbon_during_its_deletion_is_released() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let other = ctx.carbon().await;
    let (late, request_id) = ctx.pending_silicon(&other.uuid, None).await;

    // The self-creation: holds the Carbon's row (share) while it stores the request.
    let mut creation = ctx.state.db.begin().await.expect("begin");
    sqlx::query("select uuid from accounts where uuid = $1 for share")
        .bind(&carbon.uuid)
        .execute(&mut *creation)
        .await
        .expect("share lock");
    sqlx::query("update custodian_requests set to_uuid = $2 where id = $1")
        .bind(request_id)
        .bind(&carbon.uuid)
        .execute(&mut *creation)
        .await
        .expect("name the Carbon");

    // The deletion starts meanwhile and waits for the Carbon's row.
    let (state, uuid) = (ctx.state.clone(), carbon.uuid.clone());
    let deletion = tokio::spawn(async move {
        let mut conn = state.db.acquire().await.expect("conn");
        accounts::delete_account(&mut conn, &state.settings, &uuid, &uuid, true).await
    });
    let mut waited = false;
    for _ in 0..200 {
        let waiting: i64 = sqlx::query_scalar(
            "select count(*) from pg_locks l join pg_stat_activity a on a.pid = l.pid \
             where not l.granted and a.datname = current_database()",
        )
        .fetch_one(&ctx.state.db)
        .await
        .expect("locks");
        if waiting > 0 {
            waited = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert!(waited, "the deletion waits for the Carbon's row");
    creation.commit().await.expect("commit the creation");

    let deleted = deletion.await.expect("join").expect("delete");
    assert_eq!(
        deleted
            .released_silicons
            .iter()
            .map(|s| s.uuid.as_str())
            .collect::<Vec<_>>(),
        vec![late.uuid.as_str()]
    );
    let mut conn = ctx.conn().await;
    let released = accounts::get(&mut conn, &late.uuid)
        .await
        .expect("q")
        .expect("row");
    assert_eq!(released.status, AccountStatus::Deleted);
}
