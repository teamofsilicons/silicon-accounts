//! The testkit import fixtures (testkit/fixtures/imports) against their expected outcomes
//! (expected.json): a fresh database seeded from testkit/fake-apps.json, each fixture imported
//! once into legacy-crm with default_country=US.

mod common;

use accounts_core::test_support::{CarbonSpec, Req, TestContext};
use common::{all_rows, call, fake_app_secret, raw, run_jobs, seed_fake_apps, testkit};
use serde_json::{Value, json};

const APP: &str = "legacy-crm";

fn expected(file: &str) -> Value {
    let doc: Value = serde_json::from_slice(
        &std::fs::read(testkit("fixtures/imports/expected.json")).expect("expected.json"),
    )
    .expect("json");
    doc["files"]
        .as_array()
        .and_then(|f| f.iter().find(|x| x["file"] == file))
        .cloned()
        .unwrap_or_else(|| panic!("no expectations for {file}"))
}

async fn import_fixture(ctx: &TestContext, file: &str) -> (Value, Vec<Value>) {
    let exp = expected(file);
    let secret = fake_app_secret(APP);
    let bytes = std::fs::read(testkit(&format!("fixtures/imports/{file}"))).expect("fixture");
    let mut options = exp["options"].clone();
    let req = if file.ends_with(".csv") {
        let query: Vec<String> = options
            .as_object()
            .map(|o| {
                o.iter()
                    .map(|(k, v)| {
                        format!(
                            "{k}={}",
                            v.as_str()
                                .map(str::to_string)
                                .unwrap_or_else(|| v.to_string())
                        )
                    })
                    .collect()
            })
            .unwrap_or_default();
        raw(
            Req::post(&format!("/v1/apps/{APP}/imports?{}", query.join("&"))).basic(APP, &secret),
            "text/csv",
            bytes,
        )
    } else {
        let doc: Value = serde_json::from_slice(&bytes).expect("json fixture");
        if let Some(o) = doc.get("options").and_then(Value::as_object) {
            for (k, v) in o {
                options[k] = v.clone();
            }
        }
        Req::post(&format!("/v1/apps/{APP}/imports"))
            .basic(APP, &secret)
            .json(json!({"rows": doc["rows"], "options": options}))
    };
    let r = call(ctx, req).await;
    assert_eq!(r.status, 202, "{file}: {}", r.json);
    let id = r.json["job"]["id"].as_str().expect("job").to_string();
    assert_eq!(run_jobs(ctx).await, 1);
    let r = call(
        ctx,
        Req::get(&format!("/v1/apps/{APP}/imports/{id}")).basic(APP, &secret),
    )
    .await;
    let job = r.json["job"].clone();
    assert_eq!(job["status"], "completed", "{file}: {job}");
    let rows = all_rows(ctx, APP, &secret, &id).await;
    (job, rows)
}

async fn handle_of(ctx: &TestContext, uuid: &str) -> String {
    sqlx::query_scalar("select handle from accounts where uuid = $1")
        .bind(uuid)
        .fetch_one(&ctx.state.db)
        .await
        .expect("handle")
}

/// Checks counts, outcomes, exact ids and the minimum messages of every row.
async fn check(ctx: &TestContext, file: &str, job: &Value, rows: &[Value]) {
    let exp = expected(file);
    for k in ["created", "matched", "updated", "skipped", "error"] {
        assert_eq!(
            job["counts"][k], exp["counts"][k],
            "{file}: count {k}: {job}"
        );
    }
    let exp_rows = exp["rows"].as_array().expect("rows");
    assert_eq!(rows.len(), exp_rows.len(), "{file}: row count");
    for e in exp_rows {
        let n = e["row_number"].as_u64().expect("row_number") as usize;
        let row = &rows[n - 1];
        let ctx_msg = format!("{file} row {n} ({}): {row}", e["case"]);
        assert_eq!(row["row_number"], n as u64, "{ctx_msg}");
        assert_eq!(row["outcome"], e["outcome"], "{ctx_msg}");
        if e["id_exact"] == true {
            assert_eq!(row["id"], e["id"], "{ctx_msg}");
        }
        if e["outcome"] == "created" {
            let id = row["id"]
                .as_str()
                .unwrap_or_else(|| panic!("created without id: {ctx_msg}"));
            assert!(
                accounts_core::ids::AccountId::parse(id).is_ok(),
                "{ctx_msg}"
            );
            let uuid = row["account_uuid"]
                .as_str()
                .unwrap_or_else(|| panic!("no uuid: {ctx_msg}"));
            assert_eq!(handle_of(ctx, uuid).await, id, "{ctx_msg}");
        }
        if let Some(m) = e["matches"].as_str() {
            let uuid = row["account_uuid"]
                .as_str()
                .unwrap_or_else(|| panic!("no uuid: {ctx_msg}"));
            assert_eq!(handle_of(ctx, uuid).await, m, "{ctx_msg}");
        }
        let got = row["messages"].as_array().cloned().unwrap_or_default();
        for want in e["messages"].as_array().cloned().unwrap_or_default() {
            let found = got.iter().any(|g| {
                g["level"] == want["level"]
                    && (want["spec_code"] != true || g["code"] == want["code"])
                    && (want.get("field").is_none() || g["field"] == want["field"])
            });
            assert!(found, "{ctx_msg}: missing {want}");
        }
        for g in &got {
            assert!(
                g["message"].as_str().is_some_and(|m| m.len() > 15),
                "{ctx_msg}: vague message {g}"
            );
        }
        if e["messages"].as_array().is_some_and(Vec::is_empty) {
            assert!(
                got.iter().all(|g| g["level"] != "error"),
                "{ctx_msg}: unexpected error"
            );
        }
    }
}

async fn account(ctx: &TestContext, uuid: &str) -> (String, String, String, String, String) {
    let (name, dob, tz, pfp, status): (String, time::Date, String, String, String) =
        sqlx::query_as(
            "select display_name, dob, timezone, pfp_url, status from accounts where uuid = $1",
        )
        .bind(uuid)
        .fetch_one(&ctx.state.db)
        .await
        .expect("account");
    (
        name,
        accounts_core::timefmt::format_date(dob),
        tz,
        pfp,
        status,
    )
}

async fn contacts(ctx: &TestContext, uuid: &str, table: &str) -> Vec<(String, bool)> {
    let col = if table == "account_emails" {
        "email"
    } else {
        "phone"
    };
    sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "select {col}, is_primary from {table} where account_uuid = $1 order by is_primary desc, created_at, {col}"
    )))
    .bind(uuid)
    .fetch_all(&ctx.state.db)
    .await
    .expect("contacts")
}

fn uuid_of(rows: &[Value], n: usize) -> String {
    rows[n - 1]["account_uuid"]
        .as_str()
        .unwrap_or_else(|| panic!("row {n} has no account"))
        .to_string()
}

#[tokio::test]
async fn clean_csv() {
    let ctx = TestContext::new().await;
    seed_fake_apps(&ctx).await;
    let (job, rows) = import_fixture(&ctx, "clean.csv").await;
    check(&ctx, "clean.csv", &job, &rows).await;
    assert_eq!(job["counts"]["warnings"], 0);
    let outbound: i64 = sqlx::query_scalar("select count(*) from outbound_messages")
        .fetch_one(&ctx.state.db)
        .await
        .expect("count");
    assert_eq!(outbound, 0, "imports never send email or SMS");
}

#[tokio::test]
async fn dirty_csv() {
    let ctx = TestContext::new().await;
    seed_fake_apps(&ctx).await;
    // Row 40's precondition: another account owns +12025550142.
    ctx.carbon_with(CarbonSpec {
        phone: Some("+12025550142".into()),
        ..Default::default()
    })
    .await;
    let (job, rows) = import_fixture(&ctx, "dirty.csv").await;
    check(&ctx, "dirty.csv", &job, &rows).await;

    // Values the README spells out.
    let (name, _, tz, _, status) = account(&ctx, &uuid_of(&rows, 3)).await;
    assert_eq!(
        (name.as_str(), tz.as_str(), status.as_str()),
        ("Alan Mathison", "Asia/Kolkata", "unclaimed")
    );
    assert_eq!(
        rows[2]["input"]["external_id"], "  crm-003  ",
        "input is as received"
    );
    // A new account carries only the row's primary identifier (its email here); the phone
    // stays in the app's imported data until the Carbon adds and verifies it.
    assert_eq!(
        contacts(&ctx, &uuid_of(&rows, 3), "account_emails").await,
        vec![("alan.mathison@legacy-crm.test".into(), true)]
    );
    assert!(
        contacts(&ctx, &uuid_of(&rows, 3), "account_phones")
            .await
            .is_empty()
    );
    let profile: Value = sqlx::query_scalar(
        "select imported_profile from memberships where app_id = $1 and account_uuid = $2",
    )
    .bind(APP)
    .bind(uuid_of(&rows, 3))
    .fetch_one(&ctx.state.db)
    .await
    .expect("profile");
    assert_eq!(profile["phones"], json!(["+14155550103"]));
    assert!(
        rows[2]["messages"]
            .as_array()
            .is_some_and(|m| m.iter().any(|x| x["code"] == "identifiers_not_attached"))
    );
    assert_eq!(
        contacts(&ctx, &uuid_of(&rows, 2), "account_emails").await,
        vec![("grace.murray@legacy-crm.test".into(), true)]
    );
    assert_eq!(
        contacts(&ctx, &uuid_of(&rows, 11), "account_phones").await,
        vec![("+14155550123".into(), true)]
    );
    assert_eq!(
        contacts(&ctx, &uuid_of(&rows, 12), "account_phones").await,
        vec![("+14155550199".into(), true)]
    );
    assert_eq!(account(&ctx, &uuid_of(&rows, 16)).await.0, "李小龙");
    assert_eq!(account(&ctx, &uuid_of(&rows, 19)).await.1, "2000-02-29");
    for n in [25, 26, 27, 28] {
        assert_eq!(
            account(&ctx, &uuid_of(&rows, n)).await.1,
            "1987-11-23",
            "row {n}"
        );
    }
    assert_eq!(account(&ctx, &uuid_of(&rows, 29)).await.1, "1993-07-07");
    let default_dob = accounts_core::timefmt::format_date(accounts_core::normalize::default_dob(
        accounts_core::timefmt::today_utc(),
    ));
    for n in [20, 21, 22, 23, 24] {
        assert_eq!(
            account(&ctx, &uuid_of(&rows, n)).await.1,
            default_dob,
            "row {n}"
        );
    }
    for n in [30, 31, 32, 34] {
        assert_eq!(account(&ctx, &uuid_of(&rows, n)).await.2, "UTC", "row {n}");
    }
    assert_eq!(account(&ctx, &uuid_of(&rows, 35)).await.0, "Smith, John");
    assert_eq!(account(&ctx, &uuid_of(&rows, 36)).await.0, "Lin Hopper");
    assert_eq!(
        account(&ctx, &uuid_of(&rows, 37)).await.0,
        "Robert \"Bob\" Tables"
    );
    assert_eq!(
        rows[32]["input"]["_extra_cells"], 2,
        "cells without a column are counted, never stored"
    );
    let stored: String = sqlx::query_scalar(
        "select r.input::text from import_job_rows r join import_jobs j on j.id = r.job_id \
         where j.app_id = $1 and r.row_number = 33",
    )
    .bind(APP)
    .fetch_one(&ctx.state.db)
    .await
    .expect("stored row");
    assert!(!stored.contains("extra cell"), "{stored}");
    assert!(
        rows[33]["messages"]
            .as_array()
            .is_some_and(|m| m.iter().any(|x| x["code"] == "missing_fields"))
    );

    // Row 38 matched c:saket, which keeps its own data.
    let saket = uuid_of(&rows, 38);
    let (name, _, _, _, status) = account(&ctx, &saket).await;
    assert_eq!((name.as_str(), status.as_str()), ("Saket", "active"));
    let m: (String, String, Option<String>) =
        sqlx::query_as("select status, source, external_id from memberships where app_id = $1 and account_uuid = $2")
            .bind(APP)
            .bind(&saket)
            .fetch_one(&ctx.state.db)
            .await
            .expect("membership");
    assert_eq!(
        m,
        ("imported".into(), "import".into(), Some("crm-038".into()))
    );

    // Usernames.
    assert_eq!(rows[40]["id"], "c:saket-2");
    let msg = rows[40]["messages"][0]["message"]
        .as_str()
        .unwrap_or_default();
    assert!(
        msg.contains("wanted c:saket, assigned c:saket-2")
            || msg.contains("Wanted c:saket, assigned c:saket-2"),
        "{msg}"
    );
    assert_eq!(rows[41]["id"], "c:shubham-2");
    assert_eq!(rows[42]["id"], "c:john-smith");
    assert_ne!(rows[43]["id"], "c:ab");
    assert!(rows[44]["id"].as_str().is_some_and(|i| i.len() <= 32));
    assert_ne!(rows[45]["id"], "c:admin");
    assert_ne!(rows[46]["id"], "c:support");

    // Several emails and phones: the account gets the primary one, the membership keeps all
    // (deduplicated within the row); http photo → default.
    assert_eq!(
        contacts(&ctx, &uuid_of(&rows, 53), "account_emails").await,
        vec![("multi.primary@legacy-crm.test".into(), true)]
    );
    assert_eq!(
        contacts(&ctx, &uuid_of(&rows, 54), "account_emails").await,
        vec![("multi.phone@legacy-crm.test".into(), true)]
    );
    assert!(
        contacts(&ctx, &uuid_of(&rows, 54), "account_phones")
            .await
            .is_empty()
    );
    let profiles: Vec<Value> = sqlx::query_scalar(
        "select imported_profile from memberships where app_id = $1 and account_uuid = any($2) order by external_id",
    )
    .bind(APP)
    .bind(vec![uuid_of(&rows, 53), uuid_of(&rows, 54)])
    .fetch_all(&ctx.state.db)
    .await
    .expect("profiles");
    assert_eq!(
        profiles[0]["emails"],
        json!([
            "multi.primary@legacy-crm.test",
            "multi.second@legacy-crm.test",
            "multi.third@legacy-crm.test"
        ])
    );
    assert_eq!(
        profiles[1]["phones"],
        json!(["+12125550154", "+12125550155", "+12125550156"])
    );
    assert!(
        account(&ctx, &uuid_of(&rows, 55))
            .await
            .3
            .contains("/pfp/carbon?id=")
    );
    assert_eq!(
        contacts(&ctx, &uuid_of(&rows, 57), "account_emails")
            .await
            .len(),
        1
    );
    assert_eq!(
        contacts(&ctx, &uuid_of(&rows, 59), "account_emails").await,
        vec![("ops+crm@legacy-crm.test".into(), true)]
    );
    assert_eq!(account(&ctx, &uuid_of(&rows, 59)).await.2, "Europe/Berlin");
    let unverified: i64 = sqlx::query_scalar(
        "select count(*) from account_emails e join accounts a on a.uuid = e.account_uuid \
         where a.status = 'unclaimed' and e.verified_at is not null",
    )
    .fetch_one(&ctx.state.db)
    .await
    .expect("count");
    assert_eq!(unverified, 0, "imported emails are never verified");

    // Importing the same file again turns created rows into matched rows.
    let (job, _) = import_fixture(&ctx, "dirty.csv").await;
    assert_eq!(job["counts"]["created"], 0, "{job}");
    assert_eq!(job["counts"]["matched"], 47, "{job}");
}

#[tokio::test]
async fn dirty_csv_without_the_row_40_precondition() {
    let ctx = TestContext::new().await;
    seed_fake_apps(&ctx).await;
    let (job, rows) = import_fixture(&ctx, "dirty.csv").await;
    assert_eq!(job["counts"]["matched"], 2, "{job}");
    assert_eq!(job["counts"]["error"], 8, "{job}");
    assert_eq!(rows[39]["outcome"], "matched");
    assert_eq!(
        handle_of(&ctx, rows[39]["account_uuid"].as_str().expect("uuid")).await,
        "c:quill-dev"
    );
}

#[tokio::test]
async fn dirty_json() {
    let ctx = TestContext::new().await;
    seed_fake_apps(&ctx).await;
    let (job, rows) = import_fixture(&ctx, "dirty.json").await;
    check(&ctx, "dirty.json", &job, &rows).await;
    assert_eq!(
        contacts(&ctx, &uuid_of(&rows, 2), "account_emails").await,
        vec![("json.multi1@legacy-crm.test".into(), true)]
    );
    assert_eq!(
        contacts(&ctx, &uuid_of(&rows, 4), "account_phones").await,
        vec![("+14155550144".into(), true)]
    );
    assert_eq!(account(&ctx, &uuid_of(&rows, 5)).await.2, "Asia/Tokyo");
    assert_eq!(
        account(&ctx, &uuid_of(&rows, 8)).await.0,
        "Siobhán Ní Bhriain"
    );
    assert_eq!(
        account(&ctx, &uuid_of(&rows, 13)).await.3,
        "https://images.legacy-crm.test/avatars/13.png"
    );
    assert_eq!(handle_of(&ctx, &uuid_of(&rows, 11)).await, "c:shubham");
}

#[tokio::test]
async fn unknown_columns_fixtures_with_ignore() {
    for file in ["unknown-columns.csv", "unknown-columns.json"] {
        let ctx = TestContext::new().await;
        seed_fake_apps(&ctx).await;
        let (job, rows) = import_fixture(&ctx, file).await;
        check(&ctx, file, &job, &rows).await;
        assert_eq!(job["counts"]["warnings"], 5, "{file}");
    }
}
