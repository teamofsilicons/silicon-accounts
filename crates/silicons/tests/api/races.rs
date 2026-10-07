//! Concurrency: requests of this crate racing the changes that end an account's ability to act
//! (a Carbon deleting its account, a custodian rotating a Silicon's STK). Each test forces one
//! interleaving with held locks and checks that custody stays consistent: no Silicon ever ends
//! up with a deleted custodian, no request stays addressed to a deleted account, and nothing
//! minted from a session survives the rotation that ended it.
//!
//! Account deletion is the account crate's `DELETE /v1/me`; it is reproduced here step by step
//! with its exact locks (see `common::begin_account_deletion`), because that locking protocol is
//! what this crate's locks serialize with.
//!
//! A Silicon signing in with the right STK while its account ends (released because its request
//! expired, was declined or lost its Carbon; deleted; STK rotated) is told exactly why, as an id
//! that was already gone is.

use accounts_core::models::{AccountStatus, Scope};
use accounts_core::repo::{accounts, tokens};
use accounts_core::test_support::{Req, Resp, TestContext};
use serde_json::{Value, json};
use tokio::task::JoinHandle;

use crate::common::*;

/// The advisory lock core takes while claiming an id (held to pause a creation at that point).
async fn hold_id_claim(
    ctx: &TestContext,
    full_id: &str,
) -> sqlx::Transaction<'static, sqlx::Postgres> {
    let mut tx = ctx.state.db.begin().await.expect("begin");
    sqlx::query("select pg_advisory_xact_lock(hashtextextended('handle:' || $1, 0))")
        .bind(full_id)
        .execute(&mut *tx)
        .await
        .expect("advisory lock");
    tx
}

// ---- POST /v1/me/silicons vs DELETE /v1/me ----------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn creating_a_silicon_while_the_custodian_deletes_its_account_is_refused() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let t = token(&ctx, &carbon).await;
    let id = silicon_id("late");

    // The deletion has locked the Carbon; the creation (already authenticated) waits for it.
    let deletion = begin_account_deletion(&ctx.state.db, &carbon.uuid).await;
    let create = spawn_call(
        &ctx,
        Req::post("/v1/me/silicons")
            .bearer(&t)
            .json(json!({"id": id, "display_name": "Late"})),
    );
    wait_for_lock_waiters(&ctx, 1).await;
    finish_account_deletion(deletion, &carbon.uuid)
        .await
        .expect("nothing in custody yet");

    let r = create.await.expect("task");
    assert_eq!(r.status, 401, "{}", r.json);
    assert_eq!(r.error_code(), Some("account_deleted"));
    assert!(
        r.json["error"]["message"]
            .as_str()
            .expect("message")
            .contains("can't create a Silicon; nothing was changed")
    );
    assert_eq!(silicons_of(&ctx, &carbon.uuid).await, Vec::new());
    let taken: bool =
        sqlx::query_scalar("select exists (select 1 from accounts where handle = $1)")
            .bind(&id)
            .fetch_one(&ctx.state.db)
            .await
            .expect("exists");
    assert!(!taken, "the id was not used");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn deleting_an_account_while_it_creates_a_silicon_sees_the_silicon() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let t = token(&ctx, &carbon).await;
    let id = silicon_id("first");

    // The creation holds its share lock on the Carbon and is paused at its id claim.
    let paused = hold_id_claim(&ctx, &id).await;
    let create = spawn_call(
        &ctx,
        Req::post("/v1/me/silicons")
            .bearer(&t)
            .json(json!({"id": id, "display_name": "First"})),
    );
    wait_for_lock_waiters(&ctx, 1).await;
    // The deletion now waits for the creation instead of deleting under it.
    let deletion = spawn_account_deletion(&ctx, &carbon.uuid);
    wait_for_lock_waiters(&ctx, 2).await;
    paused.rollback().await.expect("release");

    let r = create.await.expect("task");
    assert_eq!(r.status, 201, "{}", r.json);
    assert_eq!(
        deletion.await.expect("task"),
        Err("custodian_of_silicons".to_string()),
        "the deletion finds the new Silicon in custody and refuses"
    );
    let silicons = silicons_of(&ctx, &carbon.uuid).await;
    assert_eq!(silicons.len(), 1);
    assert_eq!(silicons[0].1, "active");
    assert_eq!(
        account(&ctx, &carbon.uuid).await.status,
        AccountStatus::Active
    );
}

// ---- accepting a request named by email vs DELETE /v1/me --------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn accepting_while_the_acceptor_deletes_its_account_is_refused() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let t = token(&ctx, &carbon).await;
    let email: String =
        sqlx::query_scalar("select email from account_emails where account_uuid = $1")
            .bind(&carbon.uuid)
            .fetch_one(&ctx.state.db)
            .await
            .expect("email");
    // Named by email: the deletion doesn't lock this request (it locks requests by uuid only).
    let created = self_created(&ctx, &email, json!({})).await;
    let request_id = created["request"]["id"].as_str().expect("id").to_string();
    let silicon_uuid = created["silicon"]["uuid"]
        .as_str()
        .expect("uuid")
        .to_string();

    let deletion = begin_account_deletion(&ctx.state.db, &carbon.uuid).await;
    let accept = spawn_call(
        &ctx,
        Req::post(&format!("/v1/me/custodian-requests/{request_id}/accept")).bearer(&t),
    );
    wait_for_lock_waiters(&ctx, 1).await;
    finish_account_deletion(deletion, &carbon.uuid)
        .await
        .expect("nothing in custody");

    let r = accept.await.expect("task");
    assert_eq!(r.status, 401, "{}", r.json);
    assert_eq!(r.error_code(), Some("account_deleted"));
    let silicon = account(&ctx, &silicon_uuid).await;
    assert_eq!(silicon.status, AccountStatus::PendingCustodian);
    assert_eq!(
        silicon.custodian_uuid, None,
        "never in a deleted account's custody"
    );
    assert_eq!(request_row(&ctx, &request_id).await.0, "pending");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn deleting_an_account_while_it_accepts_a_request_sees_the_silicon() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let t = token(&ctx, &carbon).await;
    let email: String =
        sqlx::query_scalar("select email from account_emails where account_uuid = $1")
            .bind(&carbon.uuid)
            .fetch_one(&ctx.state.db)
            .await
            .expect("email");
    let created = self_created(&ctx, &email, json!({})).await;
    let request_id = created["request"]["id"].as_str().expect("id").to_string();
    let silicon_uuid = created["silicon"]["uuid"]
        .as_str()
        .expect("uuid")
        .to_string();

    // The acceptance holds its share lock on the Carbon and is paused at the Silicon's row.
    let paused = hold_row_lock(&ctx, &silicon_uuid, "update").await;
    let accept = spawn_call(
        &ctx,
        Req::post(&format!("/v1/me/custodian-requests/{request_id}/accept")).bearer(&t),
    );
    wait_for_lock_waiters(&ctx, 1).await;
    let deletion = spawn_account_deletion(&ctx, &carbon.uuid);
    wait_for_lock_waiters(&ctx, 2).await;
    paused.rollback().await.expect("release");

    let r = accept.await.expect("task");
    assert_eq!(r.status, 204, "{}", r.json);
    assert_eq!(
        deletion.await.expect("task"),
        Err("custodian_of_silicons".to_string())
    );
    let silicon = account(&ctx, &silicon_uuid).await;
    assert_eq!(silicon.status, AccountStatus::Active);
    assert_eq!(
        silicon.custodian_uuid.as_deref(),
        Some(carbon.uuid.as_str())
    );
    assert_eq!(
        account(&ctx, &carbon.uuid).await.status,
        AccountStatus::Active
    );
}

// ---- naming a Carbon by c:id vs DELETE /v1/me -------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn naming_a_carbon_that_is_deleting_its_account_is_refused() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let cid = carbon.handle.clone().expect("id");
    let id = silicon_id("orphan");

    let deletion = begin_account_deletion(&ctx.state.db, &carbon.uuid).await;
    let create = spawn_call(
        &ctx,
        Req::post("/v1/silicons")
            .json(json!({"id": id, "display_name": "Orphan", "custodian": cid})),
    );
    wait_for_lock_waiters(&ctx, 1).await;
    finish_account_deletion(deletion, &carbon.uuid)
        .await
        .expect("deleted");

    let r = create.await.expect("task");
    assert_eq!(r.status, 404, "{}", r.json);
    assert_eq!(r.error_code(), Some("custodian_not_found"));
    let n: i64 = sqlx::query_scalar("select count(*) from custodian_requests")
        .fetch_one(&ctx.state.db)
        .await
        .expect("count");
    assert_eq!(n, 0, "no request addressed to a deleted account");
    let taken: bool =
        sqlx::query_scalar("select exists (select 1 from accounts where handle = $1)")
            .bind(&id)
            .fetch_one(&ctx.state.db)
            .await
            .expect("exists");
    assert!(!taken);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_request_stored_before_the_named_carbon_deletes_its_account_is_cancelled_by_it() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let cid = carbon.handle.clone().expect("id");
    let id = silicon_id("waits");

    // The self-creation holds its share lock on the named Carbon, paused at its id claim.
    let paused = hold_id_claim(&ctx, &id).await;
    let create = spawn_call(
        &ctx,
        Req::post("/v1/silicons")
            .json(json!({"id": id, "display_name": "Waits", "custodian": cid})),
    );
    wait_for_lock_waiters(&ctx, 1).await;
    let deletion = spawn_account_deletion(&ctx, &carbon.uuid);
    wait_for_lock_waiters(&ctx, 2).await;
    paused.rollback().await.expect("release");

    let r = create.await.expect("task");
    assert_eq!(r.status, 201, "{}", r.json);
    // The deletion ran after the request was stored, so it cancelled it (and the account crate
    // releases the waiting Silicon); nothing stays pending for a deleted account.
    assert_eq!(deletion.await.expect("task"), Ok(()));
    let request_id = r.json["request"]["id"].as_str().expect("id");
    assert_eq!(request_row(&ctx, request_id).await.0, "cancelled");
}

// ---- transfers vs the receiver's DELETE /v1/me ------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_transfer_to_a_carbon_that_is_deleting_its_account_is_refused() {
    let ctx = TestContext::new().await;
    let owner = ctx.carbon().await;
    let t = token(&ctx, &owner).await;
    let receiver = ctx.carbon().await;
    let (silicon, _) = ctx.silicon(&owner.uuid).await;

    let deletion = begin_account_deletion(&ctx.state.db, &receiver.uuid).await;
    let transfer = spawn_call(
        &ctx,
        Req::post(&format!("/v1/me/silicons/{}/transfer", silicon.uuid))
            .bearer(&t)
            .json(json!({"to": receiver.handle})),
    );
    wait_for_lock_waiters(&ctx, 1).await;
    finish_account_deletion(deletion, &receiver.uuid)
        .await
        .expect("deleted");

    let r = transfer.await.expect("task");
    assert_eq!(r.status, 404, "{}", r.json);
    assert_eq!(r.error_code(), Some("custodian_not_found"));
    let n: i64 =
        sqlx::query_scalar("select count(*) from custodian_requests where silicon_uuid = $1")
            .bind(&silicon.uuid)
            .fetch_one(&ctx.state.db)
            .await
            .expect("count");
    assert_eq!(n, 0, "no transfer waits for a deleted account");
}

// ---- short-lived tokens vs STK rotation -------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_short_lived_token_is_not_minted_from_a_session_a_rotation_just_ended() {
    let ctx = TestContext::new().await;
    let custodian = ctx.carbon().await;
    let (silicon, _) = ctx.silicon(&custodian.uuid).await;
    let st = token(&ctx, &silicon).await;
    let (app, _) = ctx.app("remind").await;

    // A rotation holds the Silicon's row; the request (authenticated just before) waits for it.
    let mut rotation = hold_row_lock(&ctx, &silicon.uuid, "update").await;
    let slt = spawn_call(
        &ctx,
        Req::post("/v1/me/short-lived-tokens")
            .bearer(&st)
            .json(json!({"app_id": app.app_id})),
    );
    wait_for_lock_waiters(&ctx, 1).await;
    sqlx::query(
        "update token_families set revoked_at = now(), revoke_reason = 'stk_rotated' \
         where account_uuid = $1 and revoked_at is null",
    )
    .bind(&silicon.uuid)
    .execute(&mut *rotation)
    .await
    .expect("revoke");
    rotation.commit().await.expect("commit");

    let r = slt.await.expect("task");
    assert_eq!(r.status, 401, "{}", r.json);
    assert_eq!(r.error_code(), Some("token_revoked"));
    assert!(
        r.json["error"]["message"]
            .as_str()
            .expect("message")
            .contains("(stk_rotated)")
    );
    let n: i64 =
        sqlx::query_scalar("select count(*) from short_lived_tokens where account_uuid = $1")
            .bind(&silicon.uuid)
            .fetch_one(&ctx.state.db)
            .await
            .expect("count");
    assert_eq!(n, 0, "nothing was minted");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_rotation_is_stamped_when_it_takes_effect_so_older_tokens_are_refused() {
    let ctx = TestContext::new().await;
    let custodian = ctx.carbon().await;
    let ct = token(&ctx, &custodian).await;
    let (silicon, _) = ctx.silicon(&custodian.uuid).await;
    let st = token(&ctx, &silicon).await;
    let (app, _) = ctx.app("remind").await;
    ctx.membership(&app.app_id, &silicon.uuid, &[Scope::Profile])
        .await;

    // An SLT minted the normal way before the rotation.
    let before = call(
        &ctx,
        Req::post("/v1/me/short-lived-tokens")
            .bearer(&st)
            .json(json!({"app_id": app.app_id})),
    )
    .await;
    assert_eq!(before.status, 201, "{}", before.json);

    // Another request holds a share lock on the Silicon (as an SLT being minted does) while the
    // rotation starts and waits for it; that request stores its SLT only after the rotation's
    // transaction began.
    let mut minting = hold_row_lock(&ctx, &silicon.uuid, "share").await;
    let rotate = spawn_call(
        &ctx,
        Req::post(&format!("/v1/me/silicons/{}/stk", silicon.uuid))
            .bearer(&ct)
            .json(json!({})),
    );
    wait_for_lock_waiters(&ctx, 1).await;
    sqlx::query(
        "insert into short_lived_tokens (token_hash, account_uuid, app_id, scopes, created_at, expires_at) \
         values ($1, $2, $3, '{profile}', clock_timestamp(), clock_timestamp() + interval '120 seconds')",
    )
    .bind(ctx.state.keys.pepper.hash("slt_minted_during_the_rotation"))
    .bind(&silicon.uuid)
    .bind(&app.app_id)
    .execute(&mut *minting)
    .await
    .expect("slt");
    minting.commit().await.expect("commit");

    let r = rotate.await.expect("task");
    assert_eq!(r.status, 200, "{}", r.json);
    let rotated_at = ts(&r.json["rotated_at"]);
    let stored = account(&ctx, &silicon.uuid)
        .await
        .stk_rotated_at
        .expect("stamped");
    assert_eq!(
        accounts_core::timefmt::format_rfc3339_ms(stored),
        r.json["rotated_at"].as_str().expect("rotated_at")
    );
    // The token endpoint refuses an SLT whose created_at is not later than stk_rotated_at: both
    // SLTs are older than the rotation, including the one stored after its transaction began.
    let created: Vec<time::OffsetDateTime> =
        sqlx::query_scalar("select created_at from short_lived_tokens where account_uuid = $1")
            .bind(&silicon.uuid)
            .fetch_all(&ctx.state.db)
            .await
            .expect("slts");
    assert_eq!(created.len(), 2);
    for at in created {
        assert!(
            at < stored,
            "SLT created {at} is not older than the rotation {stored}"
        );
    }
    assert!(rotated_at <= stored + time::Duration::milliseconds(1));
    // And every sign-in of the Silicon ended with it.
    let live: i64 = sqlx::query_scalar(
        "select count(*) from token_families where account_uuid = $1 and revoked_at is null",
    )
    .bind(&silicon.uuid)
    .fetch_one(&ctx.state.db)
    .await
    .expect("families");
    assert_eq!(live, 0);
    // The SLT minted before still exists unspent; redeeming it is refused by the token endpoint
    // (oauth crate) because it is older than the rotation. Core's redemption step alone (no
    // rotation check) would still accept it, which is why the stamp's order matters.
    let slt = before.json["slt"].as_str().expect("slt");
    let row = tokens::consume_slt(&ctx.state.db, &ctx.state.keys.pepper, slt, &app.app_id)
        .await
        .expect("unspent");
    assert!(row.created_at < stored);
}

// ---- POST /v1/silicons/login vs the end of its Silicon ----------------------------------------
//
// A sign-in reads the account (id → uuid, status, STK hash), counts the attempt on the Silicon's
// row, checks the STK (Argon2: about a second in production, up to 3 s under load) and only then
// re-reads the row under a lock. Holding the Silicon's row pauses it at the count, after it read
// the account; whatever ends the Silicon then commits before that locked re-read. The right STK
// must still be told why it can't sign in (403), never that it is wrong (401).

/// Spawns `POST /v1/silicons/login`.
fn spawn_login(ctx: &TestContext, id: &str, stk: &str) -> JoinHandle<Resp> {
    spawn_call(
        ctx,
        Req::post("/v1/silicons/login").json(json!({"id": id, "stk": stk})),
    )
}

/// Signs in with the right STK while `change` (spawned) ends the Silicon: the sign-in has read
/// the account and waits behind a lock on the Silicon's row; `change` queues behind it, holding
/// the Silicon's custodian request (so the sign-in's locked re-read comes after it commits).
async fn sign_in_racing<T: Send + 'static>(
    ctx: &TestContext,
    silicon_uuid: &str,
    id: &str,
    stk: &str,
    change: impl FnOnce() -> JoinHandle<T>,
) -> (Resp, T) {
    let held = hold_row_lock(ctx, silicon_uuid, "update").await;
    let login = spawn_login(ctx, id, stk);
    wait_for_lock_waiters(ctx, 1).await;
    let change = change();
    wait_for_lock_waiters(ctx, 2).await;
    held.rollback().await.expect("release");
    (
        login.await.expect("sign-in task"),
        change.await.expect("change task"),
    )
}

/// (uuid, si:id, STK) of a `POST /v1/silicons` answer.
fn self_created_parts(created: &Value) -> (String, String, String) {
    let s = |v: &Value| v.as_str().expect("string").to_string();
    (
        s(&created["silicon"]["uuid"]),
        s(&created["silicon"]["id"]),
        s(&created["stk"]),
    )
}

/// The Silicon's sign-in attempts (outcomes) and its live token families.
async fn sign_in_record(ctx: &TestContext, uuid: &str) -> (Vec<String>, i64) {
    let outcomes: Vec<String> = sqlx::query_scalar(
        "select outcome from signin_history where account_uuid = $1 and method = 'silicon_stk' order by id",
    )
    .bind(uuid)
    .fetch_all(&ctx.state.db)
    .await
    .expect("signin history");
    let live: i64 = sqlx::query_scalar(
        "select count(*) from token_families where account_uuid = $1 and revoked_at is null",
    )
    .bind(uuid)
    .fetch_one(&ctx.state.db)
    .await
    .expect("families");
    (outcomes, live)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_sign_in_whose_request_expires_while_its_stk_is_checked_says_custodian_expired() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let created = self_created(&ctx, carbon.handle.as_deref().expect("id"), json!({})).await;
    let (uuid, id, stk) = self_created_parts(&created);
    let request_id = created["request"]["id"].as_str().expect("request id");
    let request_token = created["request_token"].as_str().expect("request token");
    make_overdue(&ctx, request_id).await;

    // The Silicon polls its overdue request (as the minute sweep would expire it): the read
    // expires it and releases the Silicon while the sign-in is being checked.
    let (signed, read) = sign_in_racing(&ctx, &uuid, &id, &stk, || {
        spawn_call(
            &ctx,
            Req::get(&format!("/v1/silicons/requests/{request_id}")).bearer(request_token),
        )
    })
    .await;
    assert_eq!(read.status, 200, "{}", read.json);
    assert_eq!(read.json["status"], "expired");
    assert_eq!(read.json["silicon"]["status"], "deleted");
    assert_eq!(signed.status, 403, "{}", signed.json);
    assert_eq!(signed.error_code(), Some("custodian_expired"));
    let message = signed.json["error"]["message"].as_str().expect("message");
    assert!(
        message.contains(&id) && message.contains("didn't accept within 14 days"),
        "{message}"
    );
    // Exactly what the same STK hears once the id is gone.
    let again = login(&ctx, &id, &stk).await;
    assert_eq!(again.error_code(), Some("custodian_expired"));
    assert_eq!(
        sign_in_record(&ctx, &uuid).await,
        (vec!["failed".to_string()], 0),
        "the attempt is in the Silicon's history and nothing was issued"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_sign_in_whose_custodian_declines_while_its_stk_is_checked_says_custodian_declined() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let t = token(&ctx, &carbon).await;
    let created = self_created(&ctx, carbon.handle.as_deref().expect("id"), json!({})).await;
    let (uuid, id, stk) = self_created_parts(&created);
    let request_id = created["request"]["id"].as_str().expect("request id");

    let (signed, declined) = sign_in_racing(&ctx, &uuid, &id, &stk, || {
        spawn_call(
            &ctx,
            Req::post(&format!("/v1/me/custodian-requests/{request_id}/decline")).bearer(&t),
        )
    })
    .await;
    assert_eq!(declined.status, 204, "{}", declined.json);
    assert_eq!(signed.status, 403, "{}", signed.json);
    assert_eq!(signed.error_code(), Some("custodian_declined"));
    let message = signed.json["error"]["message"].as_str().expect("message");
    assert!(message.contains("declined on "), "{message}");
    assert_eq!(account(&ctx, &uuid).await.status, AccountStatus::Deleted);
    assert_eq!(sign_in_record(&ctx, &uuid).await.1, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_sign_in_whose_named_carbon_deletes_their_account_meanwhile_says_why() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let created = self_created(&ctx, carbon.handle.as_deref().expect("id"), json!({})).await;
    let (uuid, id, stk) = self_created_parts(&created);

    // The deletion locks the requests addressed to the Carbon first, then releases the Silicon.
    let (signed, deleted) = sign_in_racing(&ctx, &uuid, &id, &stk, || {
        spawn_account_deletion(&ctx, &carbon.uuid)
    })
    .await;
    assert_eq!(deleted, Ok(()));
    assert_eq!(signed.status, 403, "{}", signed.json);
    assert_eq!(signed.error_code(), Some("custodian_declined"));
    let message = signed.json["error"]["message"].as_str().expect("message");
    assert!(message.contains("deleted their account"), "{message}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_sign_in_whose_silicon_is_deleted_meanwhile_says_account_deleted() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let (silicon, stk) = ctx.silicon(&carbon.uuid).await;
    let id = silicon.handle.clone().expect("id");

    // The custodian's deletion (core's delete_account, as DELETE /v1/me/silicons/{uuid} runs it)
    // holds the Silicon's row while the sign-in waits to count its attempt.
    let mut deletion = hold_row_lock(&ctx, &silicon.uuid, "update").await;
    let signing_in = spawn_login(&ctx, &id, &stk);
    wait_for_lock_waiters(&ctx, 1).await;
    accounts::delete_account(
        &mut deletion,
        &ctx.state.settings,
        &silicon.uuid,
        &carbon.uuid,
        true,
    )
    .await
    .expect("delete");
    deletion.commit().await.expect("commit");

    let r = signing_in.await.expect("task");
    assert_eq!(r.status, 403, "{}", r.json);
    assert_eq!(r.error_code(), Some("account_deleted"));
    assert_eq!(
        sign_in_record(&ctx, &silicon.uuid).await,
        (vec!["failed".to_string()], 0)
    );
    assert_eq!(
        login(&ctx, &id, &stk).await.error_code(),
        Some("account_deleted")
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_sign_in_whose_stk_is_rotated_meanwhile_is_refused_as_a_wrong_stk() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let (silicon, stk) = ctx.silicon(&carbon.uuid).await;
    let id = silicon.handle.clone().expect("id");

    // A rotation (core's set_stk, as POST /v1/me/silicons/{uuid}/stk runs it) commits while the
    // sign-in waits: the STK it checked is dead by the time it would be accepted.
    let mut rotation = hold_row_lock(&ctx, &silicon.uuid, "update").await;
    let signing_in = spawn_login(&ctx, &id, &stk);
    wait_for_lock_waiters(&ctx, 1).await;
    let new_stk = accounts_core::crypto::stk::generate();
    let hash = ctx.state.keys.stk.hash(&new_stk).expect("hash");
    accounts::set_stk(&mut rotation, &silicon.uuid, &hash)
        .await
        .expect("rotate");
    rotation.commit().await.expect("commit");

    let r = signing_in.await.expect("task");
    assert_eq!(r.status, 401, "{}", r.json);
    assert_eq!(r.error_code(), Some("invalid_credentials"));
    assert_eq!(
        sign_in_record(&ctx, &silicon.uuid).await,
        (vec!["failed".to_string()], 0),
        "nothing issued from the old STK"
    );
    assert_eq!(login(&ctx, &id, &new_stk).await.status, 200);
}
