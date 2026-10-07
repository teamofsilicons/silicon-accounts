//! Imports can't be turned against Carbons or the server: one address per new account, a
//! member's external_id kept, dry runs that name no accounts, per-app budgets, bounded bodies,
//! values of ignored columns never stored, and jobs that can't crash-loop the worker.

mod common;

use accounts_core::models::{ActorKind, Scope};
use accounts_core::repo::audit;
use accounts_core::test_support::{CarbonSpec, Req, TestContext};
use common::{all_rows, call, codes, owned_app, raw, run_jobs};
use serde_json::{Value, json};

fn import_json(app_id: &str, secret: &str, body: Value) -> Req {
    Req::post(&format!("/v1/apps/{app_id}/imports"))
        .basic(app_id, secret)
        .json(body)
}

async fn run(ctx: &TestContext, app_id: &str, secret: &str, req: Req) -> (Value, Vec<Value>) {
    let r = call(ctx, req).await;
    assert_eq!(r.status, 202, "{}", r.json);
    let id = r.json["job"]["id"].as_str().expect("job").to_string();
    run_jobs(ctx).await;
    let job = call(
        ctx,
        Req::get(&format!("/v1/apps/{app_id}/imports/{id}")).basic(app_id, secret),
    )
    .await
    .json["job"]
        .clone();
    (job, all_rows(ctx, app_id, secret, &id).await)
}

async fn owner_of_email(ctx: &TestContext, email: &str) -> Option<String> {
    sqlx::query_scalar("select account_uuid from account_emails where email = $1")
        .bind(email)
        .fetch_optional(&ctx.state.db)
        .await
        .expect("query")
}

/// The review's account-capture case: a row bundling a stranger's email with one the importer
/// controls must not put both on one claimable account.
#[tokio::test]
async fn a_row_can_never_bind_several_addresses_to_one_new_account() {
    let ctx = TestContext::new().await;
    let a = owned_app(&ctx, "evil").await;
    for (first, second) in [
        ("victim-1@bundle.test", "attacker-1@bundle.test"),
        ("attacker-2@bundle.test", "victim-2@bundle.test"),
    ] {
        let (job, out) = run(
            &ctx,
            &a.app_id,
            &a.secret,
            import_json(
                &a.app_id,
                &a.secret,
                json!({"rows": [{"emails": [first, second], "phone": "+14155550160", "display_name": "Bundle"}]}),
            ),
        )
        .await;
        assert_eq!(job["counts"]["created"], 1, "{job}");
        let uuid = out[0]["account_uuid"].as_str().expect("uuid").to_string();
        assert_eq!(
            owner_of_email(&ctx, first).await.as_deref(),
            Some(uuid.as_str())
        );
        assert_eq!(
            owner_of_email(&ctx, second).await,
            None,
            "the second address is on no account, so proving it can't reach this one"
        );
        let phones: i64 =
            sqlx::query_scalar("select count(*) from account_phones where account_uuid = $1")
                .bind(&uuid)
                .fetch_one(&ctx.state.db)
                .await
                .expect("phones");
        assert_eq!(phones, 0);
        let contacts: i64 = sqlx::query_scalar(
            "select (select count(*) from account_emails where account_uuid = $1) + \
                    (select count(*) from account_phones where account_uuid = $1)",
        )
        .bind(&uuid)
        .fetch_one(&ctx.state.db)
        .await
        .expect("contacts");
        assert_eq!(contacts, 1, "exactly one address, the one its owner proves");
        assert!(codes(&out[0]).contains(&"identifiers_not_attached".to_string()));
        // The suggested id comes from the attached (primary) address.
        let local = first.split('@').next().unwrap_or_default();
        assert!(
            out[0]["id"]
                .as_str()
                .is_some_and(|id| id.starts_with(&format!("c:{local}"))),
            "{}",
            out[0]
        );
        // The app still has every address it gave, in its own imported data.
        let profile: Value = sqlx::query_scalar(
            "select imported_profile from memberships where app_id = $1 and account_uuid = $2",
        )
        .bind(&a.app_id)
        .bind(&uuid)
        .fetch_one(&ctx.state.db)
        .await
        .expect("profile");
        assert_eq!(profile["emails"], json!([first, second]));
        assert_eq!(profile["phones"], json!(["+14155550160"]));
    }
    // A later row with only the unattached address doesn't match the account (the address
    // isn't on it) — it starts a separate unclaimed account its own owner can claim.
    let (_, out) = run(
        &ctx,
        &a.app_id,
        &a.secret,
        import_json(
            &a.app_id,
            &a.secret,
            json!({"rows": [{"email": "attacker-1@bundle.test"}]}),
        ),
    )
    .await;
    assert_eq!(out[0]["outcome"], "created");
    assert_ne!(
        owner_of_email(&ctx, "attacker-1@bundle.test").await,
        owner_of_email(&ctx, "victim-1@bundle.test").await
    );
}

/// A re-import without update_existing keeps a member's external_id and says so.
#[tokio::test]
async fn a_member_keeps_its_external_id_unless_update_existing() {
    let ctx = TestContext::new().await;
    let a = owned_app(&ctx, "ext").await;
    let email = "ext@ext.test";
    let ext = |ctx: &TestContext| {
        let app_id = a.app_id.clone();
        let pool = ctx.state.db.clone();
        async move {
            sqlx::query_scalar::<_, Option<String>>(
                "select m.external_id from memberships m join account_emails e on e.account_uuid = m.account_uuid \
                 where m.app_id = $1 and e.email = $2",
            )
            .bind(&app_id)
            .bind(email)
            .fetch_one(&pool)
            .await
            .expect("external id")
        }
    };
    let (_, out) = run(
        &ctx,
        &a.app_id,
        &a.secret,
        import_json(
            &a.app_id,
            &a.secret,
            json!({"rows": [{"email": email, "external_id": "crm-A"}]}),
        ),
    )
    .await;
    assert_eq!(out[0]["outcome"], "created");

    let (_, out) = run(
        &ctx,
        &a.app_id,
        &a.secret,
        import_json(
            &a.app_id,
            &a.secret,
            json!({"rows": [{"email": email, "external_id": "crm-B"}], "options": {"update_existing": false}}),
        ),
    )
    .await;
    assert_eq!(out[0]["outcome"], "matched");
    assert_eq!(codes(&out[0]), vec!["external_id_differs"]);
    let msg = out[0]["messages"][0]["message"]
        .as_str()
        .unwrap_or_default();
    assert!(
        msg.contains("'crm-A'") && msg.contains("'crm-B'") && msg.contains("update_existing"),
        "{msg}"
    );
    assert_eq!(out[0]["messages"][0]["level"], "warning");
    assert_eq!(ext(&ctx).await.as_deref(), Some("crm-A"));

    // The same external_id again: nothing to say.
    let (_, out) = run(
        &ctx,
        &a.app_id,
        &a.secret,
        import_json(
            &a.app_id,
            &a.secret,
            json!({"rows": [{"email": email, "external_id": "crm-A"}]}),
        ),
    )
    .await;
    assert_eq!(out[0]["outcome"], "matched");
    assert!(codes(&out[0]).is_empty(), "{}", out[0]);

    let (_, out) = run(
        &ctx,
        &a.app_id,
        &a.secret,
        import_json(
            &a.app_id,
            &a.secret,
            json!({"rows": [{"email": email, "external_id": "crm-B"}], "options": {"update_existing": true}}),
        ),
    )
    .await;
    assert_eq!(out[0]["outcome"], "updated");
    assert_eq!(ext(&ctx).await.as_deref(), Some("crm-B"));

    // A member without an external_id gets the one the row gives (filling in, not replacing).
    let plain = ctx
        .carbon_with(CarbonSpec {
            email: Some("plain@ext.test".into()),
            ..Default::default()
        })
        .await;
    ctx.membership(&a.app_id, &plain.uuid, &[Scope::Profile])
        .await;
    let (_, out) = run(
        &ctx,
        &a.app_id,
        &a.secret,
        import_json(
            &a.app_id,
            &a.secret,
            json!({"rows": [{"email": "plain@ext.test", "external_id": "crm-P"}]}),
        ),
    )
    .await;
    assert_eq!(out[0]["outcome"], "matched");
    assert!(codes(&out[0]).is_empty(), "{}", out[0]);
    let stored: Option<String> = sqlx::query_scalar(
        "select external_id from memberships where app_id = $1 and account_uuid = $2",
    )
    .bind(&a.app_id)
    .bind(&plain.uuid)
    .fetch_one(&ctx.state.db)
    .await
    .expect("ext");
    assert_eq!(stored.as_deref(), Some("crm-P"));
}

/// A Carbon the app imported deletes their account; the app's nightly re-import of the same row
/// (same email, same external_id) creates a new account that gets the external_id, while the
/// deleted membership stays history and still shows it. A live member's external_id still
/// conflicts.
#[tokio::test]
async fn a_deleted_accounts_external_id_is_free_again() {
    let ctx = TestContext::new().await;
    let a = owned_app(&ctx, "delx").await;
    let email = "gone@delx.test";
    let carbon = ctx
        .carbon_with(CarbonSpec {
            email: Some(email.into()),
            ..Default::default()
        })
        .await;
    let row = json!({"rows": [{"email": email, "external_id": "crm-9", "display_name": "Gone From The CRM"}]});
    let (_, out) = run(
        &ctx,
        &a.app_id,
        &a.secret,
        import_json(&a.app_id, &a.secret, row.clone()),
    )
    .await;
    assert_eq!(out[0]["outcome"], "matched", "{}", out[0]);
    assert_eq!(out[0]["account_uuid"], carbon.uuid.as_str());
    {
        let mut conn = ctx.conn().await;
        accounts_core::repo::accounts::delete_account(
            &mut conn,
            &ctx.state.settings,
            &carbon.uuid,
            &carbon.uuid,
            true,
        )
        .await
        .expect("delete");
    }

    // A dry run already says so, and writes nothing.
    let mut dry = row.clone();
    dry["options"] = json!({"dry_run": true});
    let (_, out) = run(
        &ctx,
        &a.app_id,
        &a.secret,
        import_json(&a.app_id, &a.secret, dry),
    )
    .await;
    assert_eq!(out[0]["outcome"], "created", "{}", out[0]);
    assert!(
        codes(&out[0]).contains(&"external_id_released".to_string()),
        "{}",
        out[0]
    );
    let held: Option<String> = sqlx::query_scalar(
        "select external_id from memberships where app_id = $1 and account_uuid = $2",
    )
    .bind(&a.app_id)
    .bind(&carbon.uuid)
    .fetch_one(&ctx.state.db)
    .await
    .expect("history");
    assert_eq!(held.as_deref(), Some("crm-9"), "a dry run writes nothing");

    let (job, out) = run(
        &ctx,
        &a.app_id,
        &a.secret,
        import_json(&a.app_id, &a.secret, row.clone()),
    )
    .await;
    assert_eq!(job["counts"]["error"], 0, "{job}");
    assert_eq!(out[0]["outcome"], "created", "{}", out[0]);
    let fresh = out[0]["account_uuid"]
        .as_str()
        .expect("new account")
        .to_string();
    assert_ne!(fresh, carbon.uuid, "the deleted account is never revived");
    let released = out[0]["messages"]
        .as_array()
        .and_then(|m| m.iter().find(|x| x["code"] == "external_id_released"))
        .cloned()
        .expect("external_id_released");
    assert_eq!(released["level"], "info");
    assert_eq!(released["field"], "external_id");
    let text = released["message"].as_str().unwrap_or_default();
    assert!(
        text.contains("'crm-9'") && text.contains("deleted") && !text.contains("another member"),
        "{text}"
    );
    let owners: Vec<(String, Option<String>)> = sqlx::query_as(
        "select account_uuid, external_id from memberships where app_id = $1 order by created_at",
    )
    .bind(&a.app_id)
    .fetch_all(&ctx.state.db)
    .await
    .expect("memberships");
    assert_eq!(
        owners,
        vec![
            (carbon.uuid.clone(), None),
            (fresh.clone(), Some("crm-9".to_string()))
        ]
    );

    // The user base: the deleted membership is history and still shows its external_id; search
    // by it finds both rows.
    let get = |uuid: &str| {
        Req::get(&format!("/v1/apps/{}/users/{uuid}", a.app_id)).basic(&a.app_id, &a.secret)
    };
    let history = call(&ctx, get(&carbon.uuid)).await;
    assert_eq!(history.status, 200, "{}", history.json);
    assert_eq!(history.json["status"], "deleted", "{}", history.json);
    assert_eq!(history.json["external_id"], "crm-9", "{}", history.json);
    let new = call(&ctx, get(&fresh)).await;
    assert_eq!(new.json["status"], "imported", "{}", new.json);
    assert_eq!(new.json["external_id"], "crm-9", "{}", new.json);
    let found = call(
        &ctx,
        Req::get(&format!("/v1/apps/{}/users?q=crm-9", a.app_id)).basic(&a.app_id, &a.secret),
    )
    .await;
    let mut statuses: Vec<String> = found.json["items"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .map(|i| i["status"].as_str().unwrap_or_default().to_string())
                .collect()
        })
        .unwrap_or_default();
    statuses.sort();
    assert_eq!(statuses, vec!["deleted", "imported"], "{}", found.json);

    // The new account holds it now: another row with it is a conflict with a live member.
    let (_, out) = run(
        &ctx,
        &a.app_id,
        &a.secret,
        import_json(
            &a.app_id,
            &a.secret,
            json!({"rows": [{"email": "other@delx.test", "external_id": "crm-9"}]}),
        ),
    )
    .await;
    assert_eq!(out[0]["outcome"], "error", "{}", out[0]);
    assert_eq!(codes(&out[0]), vec!["external_id_conflict"]);
    assert!(
        out[0]["messages"][0]["message"]
            .as_str()
            .is_some_and(|m| m.contains("another member of this app already has it")),
        "{}",
        out[0]
    );
}

/// The review's lookup case: a dry run of someone else's email names no account.
#[tokio::test]
async fn a_dry_run_is_not_an_account_lookup() {
    let ctx = TestContext::new().await;
    let a = owned_app(&ctx, "dry").await;
    let target = ctx
        .carbon_with(CarbonSpec {
            email: Some("target@dry.test".into()),
            ..Default::default()
        })
        .await;
    let (job, out) = run(
        &ctx,
        &a.app_id,
        &a.secret,
        import_json(
            &a.app_id,
            &a.secret,
            json!({"rows": [{"email": "target@dry.test"}], "options": {"dry_run": true}}),
        ),
    )
    .await;
    assert_eq!(job["counts"]["matched"], 1);
    assert_eq!(out[0]["outcome"], "matched");
    assert_eq!(out[0]["account_uuid"], Value::Null);
    assert_eq!(out[0]["id"], Value::Null);
    assert!(
        !serde_json::to_string(&out)
            .unwrap_or_default()
            .contains(&target.uuid),
        "{out:?}"
    );
    let members: i64 =
        sqlx::query_scalar("select count(*) from memberships where account_uuid = $1")
            .bind(&target.uuid)
            .fetch_one(&ctx.state.db)
            .await
            .expect("count");
    assert_eq!(members, 0, "a dry run writes nothing");
}

/// Columns the import ignores never reach the database; NUL characters are stored safely.
#[tokio::test]
async fn ignored_values_are_never_stored_and_nul_is_safe() {
    let ctx = TestContext::new().await;
    let a = owned_app(&ctx, "ign").await;
    let csv = "email,display_name,password_hash,notes\nign@ign.test,Ada\u{0}Lovelace,$2b$12$secret,private note\n";
    let (job, out) = run(
        &ctx,
        &a.app_id,
        &a.secret,
        raw(
            Req::post(&format!(
                "/v1/apps/{}/imports?ignore_unknown_columns=true",
                a.app_id
            ))
            .basic(&a.app_id, &a.secret),
            "text/csv",
            csv.as_bytes().to_vec(),
        ),
    )
    .await;
    assert_eq!(job["status"], "completed", "{job}");
    assert_eq!(out[0]["outcome"], "created");
    assert_eq!(
        out[0]["input"]["_ignored_columns"],
        json!(["password_hash", "notes"])
    );
    assert!(out[0]["input"].get("password_hash").is_none(), "{}", out[0]);
    let stored: Vec<String> = sqlx::query_scalar("select input::text from import_job_rows")
        .fetch_all(&ctx.state.db)
        .await
        .expect("rows");
    assert!(
        stored
            .iter()
            .all(|s| !s.contains("secret") && !s.contains("private note")),
        "{stored:?}"
    );
    let name: String = sqlx::query_scalar("select display_name from accounts where uuid = $1")
        .bind(out[0]["account_uuid"].as_str().unwrap_or_default())
        .fetch_one(&ctx.state.db)
        .await
        .expect("name");
    assert_eq!(name, "Ada\u{FFFD}Lovelace");
}

/// 60 requests per app per hour (refused before the body is read once used up).
#[tokio::test]
async fn submissions_per_app_are_limited() {
    let ctx = TestContext::new().await;
    let a = owned_app(&ctx, "subs").await;
    let other = owned_app(&ctx, "subs-o").await;
    ctx.exec(&format!(
        "insert into rate_limits (bucket, window_started_at, count) values ('import_submissions:app:{}', now(), 59)",
        a.app_id
    ))
    .await;
    let req = |app: &common::OwnedApp| {
        raw(
            Req::post(&format!("/v1/apps/{}/imports", app.app_id)).basic(&app.app_id, &app.secret),
            "text/csv",
            b"email\nsubs@subs.test\n".to_vec(),
        )
    };
    assert_eq!(call(&ctx, req(&a)).await.status, 202, "the 60th is fine");
    let r = call(&ctx, req(&a)).await;
    assert_eq!(r.status, 429, "{}", r.json);
    assert_eq!(r.error_code(), Some("rate_limited"));
    assert!(r.headers.contains_key("retry-after"));
    assert!(
        r.json["error"]["message"]
            .as_str()
            .is_some_and(|m| m.contains("60 per hour") && m.contains(&a.app_id)),
        "{}",
        r.json
    );
    assert_eq!(r.json["error"]["details"]["limit"], 60);
    // A retry of an import that went through still gets its job back (Idempotency-Key)…
    ctx.exec(&format!(
        "update rate_limits set count = 58 where bucket = 'import_submissions:app:{}'",
        a.app_id
    ))
    .await;
    let first = call(&ctx, req(&a).header("idempotency-key", "imp-limit")).await;
    assert_eq!(first.status, 202, "{}", first.json);
    let full = call(&ctx, req(&a)).await;
    assert_eq!(full.status, 202, "the 60th: {}", full.json);
    let again = call(&ctx, req(&a).header("idempotency-key", "imp-limit")).await;
    assert_eq!(again.status, 202, "{}", again.json);
    assert_eq!(again.headers["idempotent-replayed"], "true");
    assert_eq!(again.json["job"]["id"], first.json["job"]["id"]);
    // …while new work with a key is still counted and refused.
    let other_key = call(&ctx, req(&a).header("idempotency-key", "imp-new")).await;
    assert_eq!(other_key.status, 429, "{}", other_key.json);
    // Other apps have their own budget.
    assert_eq!(call(&ctx, req(&other)).await.status, 202);
    // The window passes.
    ctx.exec("update rate_limits set window_started_at = now() - interval '2 hours'")
        .await;
    assert_eq!(call(&ctx, req(&a)).await.status, 202);
}

/// 2,000,000 rows per app per 24 hours, dry runs included; a refused import costs nothing.
#[tokio::test]
async fn rows_per_app_per_day_are_limited() {
    let ctx = TestContext::new().await;
    let a = owned_app(&ctx, "rows").await;
    let bucket = format!("import_rows:app:{}", a.app_id);
    ctx.exec(&format!(
        "insert into rate_limits (bucket, window_started_at, count) values ('{bucket}', now(), 1999999)"
    ))
    .await;
    let two = json!({"rows": [{"email": "r1@rows.test"}, {"email": "r2@rows.test"}], "options": {"dry_run": true}});
    let r = call(&ctx, import_json(&a.app_id, &a.secret, two.clone())).await;
    assert_eq!(r.status, 429, "{}", r.json);
    assert_eq!(r.json["error"]["details"]["remaining_rows"], 1);
    assert_eq!(r.json["error"]["details"]["import_rows"], 2);
    assert_eq!(r.json["error"]["details"]["limit_rows"], 2_000_000);
    assert!(r.headers.contains_key("retry-after"));
    let jobs: i64 = sqlx::query_scalar("select count(*) from import_jobs")
        .fetch_one(&ctx.state.db)
        .await
        .expect("jobs");
    assert_eq!(jobs, 0);
    let used: i32 = sqlx::query_scalar("select count from rate_limits where bucket = $1")
        .bind(&bucket)
        .fetch_one(&ctx.state.db)
        .await
        .expect("used");
    assert_eq!(used, 1_999_999, "a refused import takes nothing");
    // One row still fits (a dry run counts).
    let one = json!({"rows": [{"email": "r1@rows.test"}], "options": {"dry_run": true}});
    assert_eq!(
        call(&ctx, import_json(&a.app_id, &a.secret, one))
            .await
            .status,
        202
    );
    let used: i32 = sqlx::query_scalar("select count from rate_limits where bucket = $1")
        .bind(&bucket)
        .fetch_one(&ctx.state.db)
        .await
        .expect("used");
    assert_eq!(used, 2_000_000);
    // A new day.
    ctx.exec(&format!(
        "update rate_limits set window_started_at = now() - interval '25 hours' where bucket = '{bucket}'"
    ))
    .await;
    assert_eq!(
        call(&ctx, import_json(&a.app_id, &a.secret, two))
            .await
            .status,
        202
    );
    let used: i32 = sqlx::query_scalar("select count from rate_limits where bucket = $1")
        .bind(&bucket)
        .fetch_one(&ctx.state.db)
        .await
        .expect("used");
    assert_eq!(used, 2);
}

/// Bodies over 50 MB get a precise 413, whether or not they fit the read buffer's headroom.
#[tokio::test]
async fn bodies_over_fifty_megabytes_are_refused() {
    let ctx = TestContext::new().await;
    let a = owned_app(&ctx, "big").await;
    for extra in [1usize, 128 * 1024] {
        let mut body = b"email\n".to_vec();
        body.resize(accounts_apps::imports::MAX_BYTES + extra, b'a');
        let r = call(
            &ctx,
            raw(
                Req::post(&format!("/v1/apps/{}/imports", a.app_id)).basic(&a.app_id, &a.secret),
                "text/csv",
                body,
            ),
        )
        .await;
        assert_eq!(r.status, 413, "{extra}: {}", r.json);
        assert_eq!(r.error_code(), Some("payload_too_large"));
    }
}

/// Structure past the limits is refused before a job exists, naming the row and the column.
#[tokio::test]
async fn oversized_rows_are_refused_with_their_position() {
    let ctx = TestContext::new().await;
    let a = owned_app(&ctx, "lim").await;
    let items: Vec<u32> = (0..10_000).collect();
    let r = call(
        &ctx,
        import_json(
            &a.app_id,
            &a.secret,
            json!({"rows": [{"email": "ok@lim.test"}, {"email": "x@lim.test", "emails": items}]}),
        ),
    )
    .await;
    assert_eq!(r.status, 422, "{}", r.json);
    assert_eq!(r.error_code(), Some("too_many_items"));
    assert_eq!(r.json["error"]["details"]["row"], 2);
    assert_eq!(r.json["error"]["details"]["column"], "emails");
    let mut header: Vec<String> = (0..300).map(|i| format!("col{i}")).collect();
    header.push("email".into());
    let r = call(
        &ctx,
        raw(
            Req::post(&format!(
                "/v1/apps/{}/imports?ignore_unknown_columns=true",
                a.app_id
            ))
            .basic(&a.app_id, &a.secret),
            "text/csv",
            format!("{}\n{}a@lim.test\n", header.join(","), ",".repeat(300)).into_bytes(),
        ),
    )
    .await;
    assert_eq!(r.error_code(), Some("too_many_columns"), "{}", r.json);
    let jobs: i64 = sqlx::query_scalar("select count(*) from import_jobs")
        .fetch_one(&ctx.state.db)
        .await
        .expect("jobs");
    assert_eq!(jobs, 0);
}

async fn record_resume(ctx: &TestContext, app_id: &str, job_id: &str) {
    let mut conn = ctx.conn().await;
    audit::record(
        &mut conn,
        &audit::AuditEntry {
            target_kind: Some("import_job"),
            target_id: Some(job_id),
            app_id: Some(app_id),
            ..audit::AuditEntry::new(ActorKind::System, None, "app.import.resumed")
        },
    )
    .await
    .expect("audit");
}

/// A job a stopped worker left running is resumed at most twice, then failed: a job that
/// keeps taking its process down can't crash-loop the server.
#[tokio::test]
async fn a_job_that_keeps_stopping_its_worker_is_failed() {
    let ctx = TestContext::new().await;
    let a = owned_app(&ctx, "loop").await;
    let mut jobs = Vec::new();
    for i in 0..2 {
        let r = call(
            &ctx,
            import_json(
                &a.app_id,
                &a.secret,
                json!({"rows": [{"email": format!("loop{i}@loop.test")}]}),
            ),
        )
        .await;
        assert_eq!(r.status, 202, "{}", r.json);
        jobs.push(r.json["job"]["id"].as_str().expect("id").to_string());
    }
    ctx.exec("update import_jobs set status = 'running', started_at = now()")
        .await;
    // Job 0 already resumed twice (its worker died each time); job 1 once.
    record_resume(&ctx, &a.app_id, &jobs[0]).await;
    record_resume(&ctx, &a.app_id, &jobs[0]).await;
    record_resume(&ctx, &a.app_id, &jobs[1]).await;
    assert_eq!(run_jobs(&ctx).await, 2);

    let job = |id: &str| {
        let pool = ctx.state.db.clone();
        let id = id.to_string();
        async move {
            sqlx::query_as::<_, (String, Option<String>)>(
                "select status, error from import_jobs where id = $1::uuid",
            )
            .bind(id)
            .fetch_one(&pool)
            .await
            .expect("job")
        }
    };
    let (status, error) = job(&jobs[0]).await;
    assert_eq!(status, "failed");
    assert!(
        error
            .as_deref()
            .is_some_and(|e| e.contains("more than twice")),
        "{error:?}"
    );
    assert_eq!(
        owner_of_email(&ctx, "loop0@loop.test").await,
        None,
        "not processed"
    );
    let (status, _) = job(&jobs[1]).await;
    assert_eq!(status, "completed");
    assert!(owner_of_email(&ctx, "loop1@loop.test").await.is_some());
    let resumes: i64 = sqlx::query_scalar(
        "select count(*) from audit_log where action = 'app.import.resumed' and target_id = $1",
    )
    .bind(&jobs[1])
    .fetch_one(&ctx.state.db)
    .await
    .expect("count");
    assert_eq!(resumes, 2, "each resume is recorded before it runs");
}
