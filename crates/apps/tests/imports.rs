//! User imports: request validation, job processing rules, dry runs, idempotency, resume.

mod common;

use accounts_core::models::Scope;
use accounts_core::repo::memberships;
use accounts_core::test_support::{CarbonSpec, Req, TestContext};
use common::{all_rows, call, codes, owned_app, raw, run_jobs, testkit};
use serde_json::{Value, json};

fn import_json(app_id: &str, secret: &str, rows: Value, options: Value) -> Req {
    Req::post(&format!("/v1/apps/{app_id}/imports"))
        .basic(app_id, secret)
        .json(json!({"rows": rows, "options": options}))
}

fn import_csv(app_id: &str, secret: &str, query: &str, csv: &str) -> Req {
    raw(
        Req::post(&format!("/v1/apps/{app_id}/imports?{query}")).basic(app_id, secret),
        "text/csv",
        csv.as_bytes().to_vec(),
    )
}

async fn get_job(ctx: &TestContext, app_id: &str, secret: &str, id: &str) -> Value {
    let r = call(
        ctx,
        Req::get(&format!("/v1/apps/{app_id}/imports/{id}")).basic(app_id, secret),
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.json);
    r.json["job"].clone()
}

/// Submits, runs the worker, returns (job, rows).
async fn run_import(
    ctx: &TestContext,
    app_id: &str,
    secret: &str,
    req: Req,
) -> (Value, Vec<Value>) {
    let r = call(ctx, req).await;
    assert_eq!(r.status, 202, "{}", r.json);
    let id = r.json["job"]["id"].as_str().expect("job id").to_string();
    assert_eq!(r.json["job"]["status"], "queued");
    run_jobs(ctx).await;
    let job = get_job(ctx, app_id, secret, &id).await;
    let rows = all_rows(ctx, app_id, secret, &id).await;
    (job, rows)
}

async fn outbound_count(ctx: &TestContext) -> i64 {
    sqlx::query_scalar("select count(*) from outbound_messages")
        .fetch_one(&ctx.state.db)
        .await
        .expect("count")
}

#[tokio::test]
async fn json_import_creates_unclaimed_carbons_and_matches_existing_ones() {
    let ctx = TestContext::new().await;
    let a = owned_app(&ctx, "imp").await;
    let existing = ctx
        .carbon_with(CarbonSpec {
            display_name: Some("Existing Person".into()),
            email: Some("existing@imp.test".into()),
            ..Default::default()
        })
        .await;
    let rows = json!([
        {"external_id": "x-1", "email": "New.Person@Imp.TEST", "emails": ["second@imp.test"], "phone": "+14155550111",
         "name": "New\nPerson", "username": "new_person", "dob": "23/11/1987", "timezone": "asia/kolkata",
         "pfp_url": "https://cdn.imp.test/p.png", "email_verified": true},
        {"external_id": "x-2", "email": "EXISTING@imp.test", "display_name": "Not Their Name", "username": "taken_maybe"},
        {"external_id": "x-3", "display_name": "No Contacts"},
        {"external_id": "x-4", "email": "new.person@imp.test"}
    ]);
    let (job, out) = run_import(
        &ctx,
        &a.app_id,
        &a.secret,
        import_json(&a.app_id, &a.secret, rows, json!({})),
    )
    .await;
    assert_eq!(job["status"], "completed", "{job}");
    assert_eq!(job["format"], "json");
    assert_eq!(job["total_rows"], 4);
    assert_eq!(job["processed_rows"], 4);
    assert_eq!(
        job["counts"],
        json!({"created": 1, "matched": 1, "updated": 0, "skipped": 1, "error": 1, "warnings": 0})
    );
    assert!(job["started_at"].is_string() && job["finished_at"].is_string());
    assert_eq!(job["created_by"], "app");

    assert_eq!(out[0]["outcome"], "created");
    assert_eq!(out[0]["id"], "c:new_person");
    assert_eq!(
        out[0]["input"]["name"], "New\nPerson",
        "input is the row as received"
    );
    let uuid = out[0]["account_uuid"].as_str().expect("uuid").to_string();
    assert_eq!(out[1]["outcome"], "matched");
    assert_eq!(out[1]["account_uuid"], existing.uuid.as_str());
    assert_eq!(out[1]["id"], existing.handle.as_deref().unwrap_or_default());
    assert_eq!(out[2]["outcome"], "error");
    assert_eq!(codes(&out[2]), vec!["missing_identifier"]);
    assert_eq!(out[3]["outcome"], "skipped");
    assert_eq!(codes(&out[3]), vec!["duplicate_in_file"]);
    assert!(
        out[3]["messages"][0]["message"]
            .as_str()
            .is_some_and(|m| m.contains("row 1"))
    );

    // The new account: unclaimed, only its primary email (unverified), cleaned profile.
    let (status, name, dob, tz, pfp, handle): (String, String, time::Date, String, String, String) = sqlx::query_as(
        "select status, display_name, dob, timezone, pfp_url, handle from accounts where uuid = $1",
    )
    .bind(&uuid)
    .fetch_one(&ctx.state.db)
    .await
    .expect("account");
    assert_eq!(status, "unclaimed");
    assert_eq!(name, "New Person");
    assert_eq!(dob, time::macros::date!(1987 - 11 - 23));
    assert_eq!(tz, "Asia/Kolkata");
    assert_eq!(pfp, "https://cdn.imp.test/p.png");
    assert_eq!(handle, "c:new_person");
    let emails: Vec<(String, bool, bool)> = sqlx::query_as(
        "select email, is_primary, verified_at is null from account_emails where account_uuid = $1 order by is_primary desc, email",
    )
    .bind(&uuid)
    .fetch_all(&ctx.state.db)
    .await
    .expect("emails");
    assert_eq!(emails, vec![("new.person@imp.test".into(), true, true)]);
    let phones: i64 =
        sqlx::query_scalar("select count(*) from account_phones where account_uuid = $1")
            .bind(&uuid)
            .fetch_one(&ctx.state.db)
            .await
            .expect("phones");
    assert_eq!(
        phones, 0,
        "only the primary identifier goes on the new account"
    );
    let note = out[0]["messages"]
        .as_array()
        .and_then(|m| m.iter().find(|x| x["code"] == "identifiers_not_attached"))
        .cloned()
        .expect("info message");
    assert_eq!(note["level"], "info");
    assert!(
        note["message"]
            .as_str()
            .is_some_and(|m| m.contains("new.person@imp.test")
                && m.contains("second@imp.test")
                && m.contains("+14155550111")),
        "{note}"
    );
    let changed_by: String =
        sqlx::query_scalar("select changed_by from handle_history where account_uuid = $1")
            .bind(&uuid)
            .fetch_one(&ctx.state.db)
            .await
            .expect("history");
    assert_eq!(changed_by, "import");

    let mut conn = ctx.conn().await;
    let m = memberships::get(&mut conn, &a.app_id, &uuid)
        .await
        .expect("db")
        .expect("membership");
    assert_eq!(m.status.as_str(), "imported");
    assert_eq!(m.source.as_str(), "import");
    assert_eq!(m.external_id.as_deref(), Some("x-1"));
    let profile = m.imported_profile.expect("profile");
    assert_eq!(
        profile["emails"],
        json!(["new.person@imp.test", "second@imp.test"]),
        "the imported profile keeps every address the app gave"
    );
    assert_eq!(profile["phones"], json!(["+14155550111"]));
    assert_eq!(profile["display_name"], "New Person");
    assert_eq!(profile["dob"], "1987-11-23");
    assert_eq!(profile["email_verified"], true);
    let m = memberships::get(&mut conn, &a.app_id, &existing.uuid)
        .await
        .expect("db")
        .expect("membership");
    assert_eq!(m.status.as_str(), "imported");
    assert_eq!(m.external_id.as_deref(), Some("x-2"));
    drop(conn);
    let (name, handle): (String, String) =
        sqlx::query_as("select display_name, handle from accounts where uuid = $1")
            .bind(&existing.uuid)
            .fetch_one(&ctx.state.db)
            .await
            .expect("existing");
    assert_eq!(
        name, "Existing Person",
        "an import never overwrites the account's own data"
    );
    assert_eq!(Some(handle), existing.handle);

    // Never any email or SMS.
    assert_eq!(outbound_count(&ctx).await, 0);

    // The user base shows the imported values.
    let r = call(
        &ctx,
        Req::get(&format!("/v1/apps/{}/users?status=imported", a.app_id))
            .basic(&a.app_id, &a.secret),
    )
    .await;
    assert_eq!(r.json["items"].as_array().map(Vec::len), Some(2));
    let row = r.json["items"]
        .as_array()
        .and_then(|i| i.iter().find(|x| x["uuid"] == uuid.as_str()))
        .cloned()
        .expect("row");
    assert_eq!(row["email"], "new.person@imp.test");
    assert_eq!(row["timezone"], "Asia/Kolkata");

    // Listing jobs.
    let r = call(
        &ctx,
        Req::get(&format!("/v1/apps/{}/imports", a.app_id)).session(&ctx.state.settings, &a.cookie),
    )
    .await;
    assert_eq!(r.status, 200);
    assert_eq!(r.json["items"][0]["id"], job["id"]);
}

#[tokio::test]
async fn csv_import_rules_and_row_filters() {
    let ctx = TestContext::new().await;
    let a = owned_app(&ctx, "csv").await;
    ctx.carbon_with(CarbonSpec {
        handle: Some("taken".into()),
        ..Default::default()
    })
    .await;
    ctx.exec(
        "insert into handle_reservations (handle, account_uuid, reserved_until) select 'c:held', uuid, now() + interval '5 days' from accounts where handle = 'c:taken'",
    )
    .await;
    let csv = "\u{feff}Email,Phone,Name,Username,DOB,Timezone,pfp_url\r\n\
        one@csv.test,(415) 555-0131,One,taken,1990-01-01,UTC,\r\n\
        two@csv.test,,Two,held,04/05/1990,Mars/Base,http://x.test/a.png\r\n\
        three@csv.test,12345,Three,fresh,,,\r\n\
        four@csv.test,,Four,fresh,,,\r\n\
        five@csv.test,,Five,John Smith!,,,\r\n\
        six@csv.test,,Six,ADMIN,,,\r\n";
    let (job, out) = run_import(
        &ctx,
        &a.app_id,
        &a.secret,
        import_csv(&a.app_id, &a.secret, "default_country=US", csv),
    )
    .await;
    assert_eq!(job["format"], "csv");
    assert_eq!(job["options"]["default_country"], "US");
    assert_eq!(job["counts"]["created"], 6, "{job}");

    assert_eq!(out[0]["id"], "c:taken-2");
    assert_eq!(
        codes(&out[0]),
        vec!["id_conflict", "identifiers_not_attached"]
    );
    let msg = out[0]["messages"][0]["message"]
        .as_str()
        .unwrap_or_default();
    assert!(
        msg.contains("Wanted c:taken, assigned c:taken-2")
            && msg.contains("taken by another account"),
        "{msg}"
    );
    assert_eq!(out[0]["messages"][0]["field"], "username");

    assert_eq!(out[1]["id"], "c:held-2");
    let c = codes(&out[1]);
    assert!(c.contains(&"id_conflict".to_string()) && c.contains(&"invalid_dob".to_string()));
    assert!(
        c.contains(&"invalid_timezone".to_string()) && c.contains(&"invalid_pfp_url".to_string())
    );
    let held = out[1]["messages"]
        .as_array()
        .and_then(|m| m.iter().find(|x| x["code"] == "id_conflict"))
        .cloned()
        .expect("msg");
    assert!(
        held["message"]
            .as_str()
            .is_some_and(|m| m.contains("reserved for its previous owner")),
        "{held}"
    );

    assert_eq!(out[2]["id"], "c:fresh");
    assert_eq!(codes(&out[2]), vec!["invalid_phone"]);
    assert_eq!(out[3]["id"], "c:fresh-2");
    assert!(
        out[3]["messages"][0]["message"]
            .as_str()
            .is_some_and(|m| m.contains("row 3 of this import already took c:fresh"))
    );
    assert_eq!(out[4]["id"], "c:john-smith");
    assert_eq!(codes(&out[4]), vec!["invalid_username"]);
    assert_eq!(out[5]["id"], "c:six");
    assert_eq!(codes(&out[5]), vec!["reserved_username"]);

    // Row filters and pagination.
    let base = format!(
        "/v1/apps/{}/imports/{}/rows",
        a.app_id,
        job["id"].as_str().unwrap_or_default()
    );
    let r = call(
        &ctx,
        Req::get(&format!("{base}?code=id_conflict")).basic(&a.app_id, &a.secret),
    )
    .await;
    let numbers: Vec<i64> = r.json["items"]
        .as_array()
        .expect("items")
        .iter()
        .filter_map(|x| x["row_number"].as_i64())
        .collect();
    assert_eq!(numbers, vec![1, 2, 4]);
    let r = call(
        &ctx,
        Req::get(&format!("{base}?level=warning&limit=2")).basic(&a.app_id, &a.secret),
    )
    .await;
    assert_eq!(r.json["items"].as_array().map(Vec::len), Some(2));
    let cursor = r.json["next_cursor"].as_str().expect("cursor").to_string();
    let r = call(
        &ctx,
        Req::get(&format!("{base}?level=warning&limit=10&cursor={cursor}"))
            .basic(&a.app_id, &a.secret),
    )
    .await;
    assert_eq!(r.json["items"][0]["row_number"], 3);
    let r = call(
        &ctx,
        Req::get(&format!("{base}?outcome=error")).basic(&a.app_id, &a.secret),
    )
    .await;
    assert_eq!(r.json["items"], json!([]));
    let r = call(
        &ctx,
        Req::get(&format!("{base}?outcome=lost")).basic(&a.app_id, &a.secret),
    )
    .await;
    assert_eq!(r.error_code(), Some("invalid_query"));
}

#[tokio::test]
async fn unknown_columns_are_refused_unless_ignored() {
    let ctx = TestContext::new().await;
    let a = owned_app(&ctx, "unk").await;
    let csv = std::fs::read(testkit("fixtures/imports/unknown-columns.csv")).expect("fixture");
    let r = call(
        &ctx,
        raw(
            Req::post(&format!("/v1/apps/{}/imports", a.app_id)).basic(&a.app_id, &a.secret),
            "text/csv",
            csv.clone(),
        ),
    )
    .await;
    assert_eq!(r.status, 422, "{}", r.json);
    assert_eq!(r.error_code(), Some("unknown_columns"));
    assert_eq!(
        r.json["error"]["details"]["unknown_columns"],
        json!(["favorite_color", "plan", "last_login_at"])
    );
    assert!(
        r.json["error"]["details"]["allowed_columns"]
            .as_array()
            .is_some_and(|c| c.contains(&json!("external_id")))
    );
    let jobs: i64 = sqlx::query_scalar("select count(*) from import_jobs")
        .fetch_one(&ctx.state.db)
        .await
        .expect("count");
    assert_eq!(jobs, 0, "nothing imported");

    let (job, out) = run_import(
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
            csv,
        ),
    )
    .await;
    assert_eq!(job["counts"]["created"], 5);
    assert_eq!(job["counts"]["warnings"], 5);
    for row in &out {
        assert_eq!(codes(row), vec!["unknown_columns"]);
    }

    let body: Value = serde_json::from_slice(
        &std::fs::read(testkit("fixtures/imports/unknown-columns.json")).expect("fixture"),
    )
    .expect("json");
    let r = call(
        &ctx,
        import_json(&a.app_id, &a.secret, body["rows"].clone(), json!({})),
    )
    .await;
    assert_eq!(r.error_code(), Some("unknown_columns"));
}

#[tokio::test]
async fn dry_run_reports_without_writing() {
    let ctx = TestContext::new().await;
    let a = owned_app(&ctx, "dry").await;
    let existing = ctx
        .carbon_with(CarbonSpec {
            email: Some("known@dry.test".into()),
            ..Default::default()
        })
        .await;
    let csv = "email,username,external_id\nfirst@dry.test,dry_one,d-1\nsecond@dry.test,dry_one,d-2\nknown@dry.test,,d-3\nthird@dry.test,,d-1\n";
    let accounts_before: i64 = sqlx::query_scalar("select count(*) from accounts")
        .fetch_one(&ctx.state.db)
        .await
        .expect("n");

    let (job, out) = run_import(
        &ctx,
        &a.app_id,
        &a.secret,
        import_csv(&a.app_id, &a.secret, "dry_run=true", csv),
    )
    .await;
    assert_eq!(job["dry_run"], true);
    assert_eq!(
        job["counts"],
        json!({"created": 2, "matched": 1, "updated": 0, "skipped": 0, "error": 1, "warnings": 1})
    );
    assert_eq!(out[0]["id"], "c:dry_one");
    assert_eq!(out[0]["account_uuid"], Value::Null, "nothing was created");
    assert_eq!(
        out[1]["id"], "c:dry_one-2",
        "ids are planned as in a real run"
    );
    assert_eq!(out[2]["outcome"], "matched");
    assert_eq!(
        (&out[2]["account_uuid"], &out[2]["id"]),
        (&Value::Null, &Value::Null),
        "a dry run never names the account an email belongs to"
    );
    assert_eq!(out[3]["outcome"], "error");
    assert_eq!(codes(&out[3]), vec!["external_id_conflict"]);
    let accounts_after: i64 = sqlx::query_scalar("select count(*) from accounts")
        .fetch_one(&ctx.state.db)
        .await
        .expect("n");
    assert_eq!(accounts_before, accounts_after);
    let members: i64 = sqlx::query_scalar("select count(*) from memberships where app_id = $1")
        .bind(&a.app_id)
        .fetch_one(&ctx.state.db)
        .await
        .expect("n");
    assert_eq!(members, 0);

    // The real run creates them with the same decisions.
    let (job, out) = run_import(
        &ctx,
        &a.app_id,
        &a.secret,
        import_csv(&a.app_id, &a.secret, "", csv),
    )
    .await;
    assert_eq!(job["counts"]["created"], 2);
    assert_eq!(out[1]["id"], "c:dry_one-2");
    assert!(out[0]["account_uuid"].is_string());
    assert_eq!(
        out[2]["account_uuid"],
        existing.uuid.as_str(),
        "a real import links the row (and the Carbon sees the membership)"
    );
}

#[tokio::test]
async fn reimports_match_and_update_existing_refreshes_profiles() {
    let ctx = TestContext::new().await;
    let a = owned_app(&ctx, "re").await;
    let rows = json!([{"email": "re1@re.test", "display_name": "Re One", "external_id": "r-1"},
                      {"phone": "+14155550177", "display_name": "Re Two", "external_id": "r-2"}]);
    let (job, out) = run_import(
        &ctx,
        &a.app_id,
        &a.secret,
        import_json(&a.app_id, &a.secret, rows.clone(), json!({})),
    )
    .await;
    assert_eq!(job["counts"]["created"], 2);
    let uuid = out[0]["account_uuid"].as_str().expect("uuid").to_string();

    let (job, out) = run_import(
        &ctx,
        &a.app_id,
        &a.secret,
        import_json(&a.app_id, &a.secret, rows, json!({})),
    )
    .await;
    assert_eq!(job["counts"]["matched"], 2, "{job}");
    assert_eq!(out[0]["account_uuid"], uuid.as_str());

    let changed = json!([{"email": "re1@re.test", "display_name": "Re One Renamed", "external_id": "r-1", "timezone": "Europe/Paris"}]);
    let (job, _) = run_import(
        &ctx,
        &a.app_id,
        &a.secret,
        import_json(&a.app_id, &a.secret, changed.clone(), json!({})),
    )
    .await;
    assert_eq!(job["counts"]["matched"], 1);
    let profile: Value = sqlx::query_scalar(
        "select imported_profile from memberships where app_id = $1 and account_uuid = $2",
    )
    .bind(&a.app_id)
    .bind(&uuid)
    .fetch_one(&ctx.state.db)
    .await
    .expect("profile");
    assert_eq!(
        profile["display_name"], "Re One",
        "without update_existing the profile stays"
    );

    let (job, _) = run_import(
        &ctx,
        &a.app_id,
        &a.secret,
        import_json(
            &a.app_id,
            &a.secret,
            changed,
            json!({"update_existing": true}),
        ),
    )
    .await;
    assert_eq!(job["counts"]["updated"], 1, "{job}");
    let profile: Value = sqlx::query_scalar(
        "select imported_profile from memberships where app_id = $1 and account_uuid = $2",
    )
    .bind(&a.app_id)
    .bind(&uuid)
    .fetch_one(&ctx.state.db)
    .await
    .expect("profile");
    assert_eq!(profile["display_name"], "Re One Renamed");
    assert_eq!(profile["timezone"], "Europe/Paris");
    let (name, tz): (String, String) =
        sqlx::query_as("select display_name, timezone from accounts where uuid = $1")
            .bind(&uuid)
            .fetch_one(&ctx.state.db)
            .await
            .expect("account");
    assert_eq!(
        (name.as_str(), tz.as_str()),
        ("Re One", "UTC"),
        "the account's own data never changes"
    );
}

#[tokio::test]
async fn matching_rules_ambiguity_external_ids_and_removed_access() {
    let ctx = TestContext::new().await;
    let a = owned_app(&ctx, "mr").await;
    let by_email = ctx
        .carbon_with(CarbonSpec {
            email: Some("one@mr.test".into()),
            ..Default::default()
        })
        .await;
    let by_phone = ctx
        .carbon_with(CarbonSpec {
            email: Some("two@mr.test".into()),
            phone: Some("+14155550188".into()),
            ..Default::default()
        })
        .await;
    let member = ctx
        .carbon_with(CarbonSpec {
            email: Some("member@mr.test".into()),
            ..Default::default()
        })
        .await;
    let gone = ctx
        .carbon_with(CarbonSpec {
            email: Some("gone@mr.test".into()),
            ..Default::default()
        })
        .await;
    ctx.membership(&a.app_id, &member.uuid, &[Scope::Profile])
        .await;
    ctx.membership(&a.app_id, &gone.uuid, &[Scope::Profile])
        .await;
    {
        let mut conn = ctx.conn().await;
        memberships::upsert_imported(
            &mut conn,
            &a.app_id,
            &member.uuid,
            Some("taken-ext"),
            None,
            false,
        )
        .await
        .expect("ext");
        memberships::remove_access(&mut conn, &a.app_id, &gone.uuid, &gone.uuid)
            .await
            .expect("removed");
    }
    let rows = json!([
        {"email": "one@mr.test", "phone": "+14155550188"},
        {"email": "new@mr.test", "external_id": "taken-ext"},
        {"email": "member@mr.test", "external_id": "taken-ext"},
        {"email": "gone@mr.test"},
        {"email": "TWO@mr.test", "external_id": "e-2"},
        {"phone": "(415) 555-0188"}
    ]);
    let (job, out) = run_import(
        &ctx,
        &a.app_id,
        &a.secret,
        import_json(&a.app_id, &a.secret, rows, json!({"default_country": "US"})),
    )
    .await;
    assert_eq!(job["status"], "completed");
    assert_eq!(out[0]["outcome"], "error");
    assert_eq!(codes(&out[0]), vec!["ambiguous_match"]);
    let msg = out[0]["messages"][0]["message"]
        .as_str()
        .unwrap_or_default();
    assert!(
        msg.contains("one@mr.test") && msg.contains("+14155550188"),
        "{msg}"
    );
    assert!(
        !msg.contains(by_email.handle.as_deref().unwrap_or("?")),
        "never names the accounts: {msg}"
    );
    assert_eq!(out[1]["outcome"], "error");
    assert_eq!(codes(&out[1]), vec!["external_id_conflict"]);
    assert_eq!(out[1]["messages"][0]["field"], "external_id");
    assert_eq!(
        out[2]["outcome"], "matched",
        "the member already owns that external_id: {}",
        out[2]
    );
    assert_eq!(out[3]["outcome"], "skipped");
    assert_eq!(codes(&out[3]), vec!["access_removed"]);
    // Row 1 failed, so it claimed no account: TWO@ matches by_phone's account normally…
    assert_eq!(out[4]["outcome"], "matched");
    assert_eq!(out[4]["account_uuid"], by_phone.uuid.as_str());
    // …but row 6's phone (local format) is the one row 1 already had.
    assert_eq!(out[5]["outcome"], "skipped");
    assert_eq!(codes(&out[5]), vec!["duplicate_in_file"]);
    assert!(
        out[5]["messages"][0]["message"]
            .as_str()
            .is_some_and(|m| m.contains("+14155550188") && m.contains("row 1"))
    );
    let status: String = sqlx::query_scalar(
        "select status from memberships where app_id = $1 and account_uuid = $2",
    )
    .bind(&a.app_id)
    .bind(&gone.uuid)
    .fetch_one(&ctx.state.db)
    .await
    .expect("status");
    assert_eq!(
        status, "access_removed",
        "an import never adds back an app the Carbon removed"
    );
    let status: String = sqlx::query_scalar(
        "select status from memberships where app_id = $1 and account_uuid = $2",
    )
    .bind(&a.app_id)
    .bind(&member.uuid)
    .fetch_one(&ctx.state.db)
    .await
    .expect("status");
    assert_eq!(status, "active", "active members stay active");
}

#[tokio::test]
async fn request_level_errors_are_precise() {
    let ctx = TestContext::new().await;
    let a = owned_app(&ctx, "req").await;
    let other = owned_app(&ctx, "req-o").await;
    let url = format!("/v1/apps/{}/imports", a.app_id);
    let send = |ct: &str, body: &str| {
        raw(
            Req::post(&url).basic(&a.app_id, &a.secret),
            ct,
            body.as_bytes().to_vec(),
        )
    };

    for (req, status, code) in [
        (
            send("text/plain", "email\na@x.test\n"),
            400,
            "invalid_content_type",
        ),
        (send("text/csv", ""), 422, "empty_import"),
        (send("text/csv", "email\n"), 422, "empty_import"),
        (
            send("text/csv", "name,username\nA,a\n"),
            422,
            "no_identifier_columns",
        ),
        (
            send("text/csv", "email,EMAIL\na@x.test,b@x.test\n"),
            422,
            "duplicate_columns",
        ),
        (
            send("application/json", "{\"rows\": 5}"),
            422,
            "validation_failed",
        ),
        (
            send("application/json", "{\"rows\": [], \"options\": {}}"),
            422,
            "empty_import",
        ),
        (send("application/json", "[1,2]"), 422, "validation_failed"),
        (send("application/json", "{nope"), 400, "invalid_json"),
        (
            raw(
                Req::post(&format!("{url}?dryrun=true")).basic(&a.app_id, &a.secret),
                "text/csv",
                b"email\na@x.test\n".to_vec(),
            ),
            400,
            "invalid_query",
        ),
        (
            raw(
                Req::post(&format!("{url}?default_country=XX")).basic(&a.app_id, &a.secret),
                "text/csv",
                b"email\na@x.test\n".to_vec(),
            ),
            400,
            "invalid_query",
        ),
        (
            raw(
                Req::post(&url).basic(&other.app_id, &other.secret),
                "text/csv",
                b"email\na@x.test\n".to_vec(),
            ),
            403,
            "app_mismatch",
        ),
        (
            raw(Req::post(&url), "text/csv", b"email\na@x.test\n".to_vec()),
            401,
            "unauthenticated",
        ),
    ] {
        let r = call(&ctx, req).await;
        assert_eq!(
            (r.status.as_u16(), r.error_code()),
            (status, Some(code)),
            "{}",
            r.json
        );
        assert!(
            r.json["error"]["message"]
                .as_str()
                .is_some_and(|m| m.len() > 20)
        );
    }
    let too_many: Vec<Value> = (0..100_001)
        .map(|i| json!({"email": format!("u{i}@x.test")}))
        .collect();
    let r = call(
        &ctx,
        import_json(&a.app_id, &a.secret, Value::Array(too_many), json!({})),
    )
    .await;
    assert_eq!(r.error_code(), Some("too_many_rows"));
    assert_eq!(r.json["error"]["details"]["max_rows"], 100_000);

    // The owner can import; jobs are private to their app.
    let r = call(
        &ctx,
        raw(
            Req::post(&url).session(&ctx.state.settings, &a.cookie),
            "text/csv",
            b"email\nowner@x.test\n".to_vec(),
        ),
    )
    .await;
    assert_eq!(r.status, 202, "{}", r.json);
    assert_eq!(r.json["job"]["created_by"], a.owner.uuid.as_str());
    let id = r.json["job"]["id"].as_str().expect("id").to_string();
    let r = call(
        &ctx,
        Req::get(&format!("/v1/apps/{}/imports/{id}", other.app_id))
            .basic(&other.app_id, &other.secret),
    )
    .await;
    assert_eq!(r.status, 404);
    assert_eq!(r.error_code(), Some("import_not_found"));
    let r = call(
        &ctx,
        Req::get(&format!("/v1/apps/{}/imports/not-a-uuid/rows", a.app_id))
            .basic(&a.app_id, &a.secret),
    )
    .await;
    assert_eq!(r.error_code(), Some("import_not_found"));
}

#[tokio::test]
async fn idempotent_resubmission_returns_the_same_job() {
    let ctx = TestContext::new().await;
    let a = owned_app(&ctx, "idi").await;
    let csv = "email\nidem@x.test\n";
    let first = call(
        &ctx,
        import_csv(&a.app_id, &a.secret, "", csv).header("idempotency-key", "imp-1"),
    )
    .await;
    assert_eq!(first.status, 202);
    let again = call(
        &ctx,
        import_csv(&a.app_id, &a.secret, "", csv).header("idempotency-key", "imp-1"),
    )
    .await;
    assert_eq!(again.status, 202);
    assert_eq!(again.headers["idempotent-replayed"], "true");
    assert_eq!(again.json["job"]["id"], first.json["job"]["id"]);
    let jobs: i64 = sqlx::query_scalar("select count(*) from import_jobs")
        .fetch_one(&ctx.state.db)
        .await
        .expect("n");
    assert_eq!(jobs, 1);
    let other = call(
        &ctx,
        import_csv(&a.app_id, &a.secret, "dry_run=true", csv).header("idempotency-key", "imp-1"),
    )
    .await;
    assert_eq!(other.status, 409);
    assert_eq!(other.error_code(), Some("idempotency_key_reused"));
}

#[tokio::test]
async fn large_imports_span_chunks_and_a_stopped_job_resumes() {
    let ctx = TestContext::new().await;
    let a = owned_app(&ctx, "big").await;
    let rows: Vec<Value> = (0..1200)
        .map(|i| json!({"email": format!("bulk{i}@big.test"), "username": format!("bulk_{i}"), "external_id": format!("b-{i}")}))
        .collect();
    let (job, out) = run_import(
        &ctx,
        &a.app_id,
        &a.secret,
        import_json(&a.app_id, &a.secret, Value::Array(rows), json!({})),
    )
    .await;
    assert_eq!(job["counts"]["created"], 1200, "{job}");
    assert_eq!(out.len(), 1200);
    assert_eq!(out[1199]["id"], "c:bulk_1199");

    // A job a dead worker left `running` (rows 1-3 done) is resumed from row 4.
    let r = call(
        &ctx,
        import_json(
            &a.app_id,
            &a.secret,
            json!([
                {"email": "r1@big.test"}, {"email": "r2@big.test"}, {"email": "r3@big.test"},
                {"email": "r1@big.test"}, {"email": "r5@big.test", "username": "resumed"}
            ]),
            json!({}),
        ),
    )
    .await;
    let id = r.json["job"]["id"].as_str().expect("id").to_string();
    ctx.exec(&format!(
        "update import_jobs set status = 'running', started_at = now(), processed_rows = 3, \
         counts = '{{\"skipped\": 3}}' where id = '{id}'; \
         update import_job_rows set outcome = 'skipped', messages = '[{{\"level\":\"info\",\"code\":\"duplicate_in_file\",\"message\":\"test\"}}]' \
         where job_id = '{id}' and row_number <= 3"
    ))
    .await;
    assert_eq!(run_jobs(&ctx).await, 1);
    let job = get_job(&ctx, &a.app_id, &a.secret, &id).await;
    assert_eq!(job["status"], "completed");
    assert_eq!(job["processed_rows"], 5);
    assert_eq!(job["counts"]["skipped"], 4, "{job}");
    assert_eq!(job["counts"]["created"], 1);
    let out = all_rows(&ctx, &a.app_id, &a.secret, &id).await;
    assert_eq!(
        out[3]["outcome"], "skipped",
        "row 4 repeats row 1, which the stopped worker had seen"
    );
    assert_eq!(out[4]["id"], "c:resumed");
}

#[tokio::test]
async fn concurrent_imports_never_duplicate_accounts() {
    let ctx = TestContext::new().await;
    let a = owned_app(&ctx, "con-a").await;
    let b = owned_app(&ctx, "con-b").await;
    let rows: Vec<Value> = (0..1500)
        .map(|i| json!({"email": format!("same{i}@con.test")}))
        .collect();
    for app in [&a, &b] {
        let r = call(
            &ctx,
            import_json(
                &app.app_id,
                &app.secret,
                Value::Array(rows.clone()),
                json!({}),
            ),
        )
        .await;
        assert_eq!(r.status, 202);
    }
    let s1 = ctx.state.clone();
    let s2 = ctx.state.clone();
    let (r1, r2) = tokio::join!(
        tokio::spawn(async move { accounts_apps::imports::run_pending_jobs(&s1).await }),
        tokio::spawn(async move { accounts_apps::imports::run_pending_jobs(&s2).await }),
    );
    let done = r1.expect("join").expect("worker") + r2.expect("join").expect("worker");
    assert_eq!(done, 2);
    let accounts: i64 =
        sqlx::query_scalar("select count(*) from account_emails where email like '%@con.test'")
            .fetch_one(&ctx.state.db)
            .await
            .expect("n");
    assert_eq!(accounts, 1500, "one account per email");
    for app in [&a, &b] {
        let members: i64 = sqlx::query_scalar("select count(*) from memberships where app_id = $1")
            .bind(&app.app_id)
            .fetch_one(&ctx.state.db)
            .await
            .expect("n");
        assert_eq!(members, 1500, "every row is in both user bases");
    }
    let totals: Vec<(i64, i64, i64)> = sqlx::query_as(
        "select (counts->>'created')::bigint, (counts->>'matched')::bigint, (counts->>'error')::bigint from import_jobs",
    )
    .fetch_all(&ctx.state.db)
    .await
    .expect("counts");
    let created: i64 = totals.iter().map(|t| t.0).sum();
    let matched: i64 = totals.iter().map(|t| t.1).sum();
    assert_eq!(created + matched, 3000, "{totals:?}");
    assert_eq!(created, 1500, "{totals:?}");
    assert!(totals.iter().all(|t| t.2 == 0), "{totals:?}");
}

/// A sign-up that commits between the import's checks and its insert (same email, same id) is
/// caught by the bulk write and the chunk is redone row by row with fresh checks.
#[tokio::test]
async fn a_racing_signup_is_resolved_row_by_row() {
    use accounts_core::ids::AccountId;
    use accounts_core::models::{AccountStatus, VerifiedVia};
    use accounts_core::repo::accounts::{self, NewCarbon, NewContact};

    let ctx = TestContext::new().await;
    let a = owned_app(&ctx, "race").await;
    let r = call(
        &ctx,
        import_json(
            &a.app_id,
            &a.secret,
            json!([
                {"email": "race@race.test", "display_name": "Racer"},
                {"email": "other@race.test", "username": "racer-id"}
            ]),
            json!({}),
        ),
    )
    .await;
    assert_eq!(r.status, 202);
    let id = r.json["job"]["id"].as_str().expect("id").to_string();

    // A sign-up in flight: it holds the id lock and the email row until it commits.
    let mut signup = ctx.state.db.begin().await.expect("tx");
    let racer = accounts::create_carbon(
        &mut signup,
        &ctx.state.settings,
        NewCarbon {
            id: AccountId::parse("c:racer-id").expect("id"),
            display_name: "Real Racer".into(),
            pfp_url: None,
            dob: time::macros::date!(1990 - 01 - 01),
            timezone: "UTC".into(),
            status: AccountStatus::Active,
            emails: vec![NewContact {
                value: "race@race.test".into(),
                verified_via: Some(VerifiedVia::Code),
            }],
            phones: Vec::new(),
            actor: "test".into(),
        },
    )
    .await
    .expect("signup");

    let state = ctx.state.clone();
    let worker =
        tokio::spawn(async move { accounts_apps::imports::run_pending_jobs(&state).await });
    // Wait until the import is blocked behind the sign-up, then let the sign-up commit.
    let mut blocked = false;
    for _ in 0..500 {
        let waiting: i64 = sqlx::query_scalar(
            "select count(*) from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'",
        )
        .fetch_one(&ctx.state.db)
        .await
        .expect("activity");
        if waiting > 0 {
            blocked = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    assert!(blocked, "the import never waited for the sign-up");
    signup.commit().await.expect("commit");
    assert_eq!(worker.await.expect("join").expect("worker"), 1);

    let job = get_job(&ctx, &a.app_id, &a.secret, &id).await;
    assert_eq!(job["status"], "completed", "{job}");
    let out = all_rows(&ctx, &a.app_id, &a.secret, &id).await;
    assert_eq!(out[0]["outcome"], "matched", "{}", out[0]);
    assert_eq!(out[0]["account_uuid"], racer.uuid.as_str());
    assert_eq!(out[1]["outcome"], "created");
    assert_eq!(out[1]["id"], "c:racer-id-2");
    assert_eq!(codes(&out[1]), vec!["id_conflict"]);
    let owners: i64 =
        sqlx::query_scalar("select count(*) from account_emails where email = 'race@race.test'")
            .fetch_one(&ctx.state.db)
            .await
            .expect("count");
    assert_eq!(owners, 1);
}

/// An import can't point an account at a photo uploaded to Silicon Accounts (that would keep
/// someone else's removed photo alive), and never links a row through an address nobody proved.
#[tokio::test]
async fn imports_refuse_this_services_photos_and_unproven_addresses() {
    let ctx = TestContext::new().await;
    let a = owned_app(&ctx, "pics").await;
    let holder = ctx.carbon().await;
    // A row left unverified on an active account (what claims before migration 0002 could leave).
    sqlx::query(
        "insert into account_emails (email, account_uuid, is_primary) values ('left@pics.test', $1, false)",
    )
    .bind(&holder.uuid)
    .execute(&ctx.state.db)
    .await
    .expect("leftover");
    let photo = format!(
        "{}0190f0f0-0000-7000-8000-000000000001",
        accounts_core::pfp::photo_url_prefix(&ctx.state.settings)
    );
    let rows = json!([
        {"external_id": "p-1", "email": "pic@pics.test", "pfp_url": photo},
        {"external_id": "p-2", "email": "left@pics.test"}
    ]);
    let (_, out) = run_import(
        &ctx,
        &a.app_id,
        &a.secret,
        import_json(&a.app_id, &a.secret, rows, json!({})),
    )
    .await;
    assert_eq!(out[0]["outcome"], "created", "{}", out[0]);
    assert!(
        codes(&out[0]).contains(&"invalid_pfp_url".to_string()),
        "{}",
        out[0]
    );
    let uuid = out[0]["account_uuid"].as_str().expect("uuid");
    let pfp: String = sqlx::query_scalar("select pfp_url from accounts where uuid = $1")
        .bind(uuid)
        .fetch_one(&ctx.state.db)
        .await
        .expect("pfp");
    assert!(
        accounts_core::pfp::is_default_pfp(&ctx.state.settings.iris_base_url, &pfp),
        "{pfp}"
    );
    // The unproven address identifies nobody, so the row is never matched to its holder.
    assert_ne!(out[1]["outcome"], "matched", "{}", out[1]);
    let linked: i64 = sqlx::query_scalar(
        "select count(*) from memberships where app_id = $1 and account_uuid = $2",
    )
    .bind(&a.app_id)
    .bind(&holder.uuid)
    .fetch_one(&ctx.state.db)
    .await
    .expect("count");
    assert_eq!(linked, 0);
}
