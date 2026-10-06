//! Throughput of a 100,000-row import (the contract maximum). Ignored by default because it
//! takes a while in debug builds; run it with:
//!
//! ```sh
//! CARGO_TARGET_DIR=target/apps cargo test -p silicon-accounts-apps --test imports_big -- --ignored --nocapture
//! ```
//!
//! It uses testkit/fixtures/imports/big.csv when present (`pnpm -C testkit gen:big`), else an
//! equivalent file generated here (20% of rows with a phone number).

mod common;

use std::fmt::Write as _;
use std::time::Instant;

use accounts_core::test_support::{Req, TestContext};
use common::{call, owned_app, raw, run_jobs, testkit};

const ROWS: usize = 100_000;

fn big_csv() -> Vec<u8> {
    if let Ok(bytes) = std::fs::read(testkit("fixtures/imports/big.csv")) {
        return bytes;
    }
    let zones = [
        "UTC",
        "Europe/London",
        "America/Chicago",
        "Asia/Kolkata",
        "Australia/Sydney",
    ];
    let areas = [
        "201", "212", "305", "312", "415", "512", "617", "702", "808", "917",
    ];
    let mut out = String::from("external_id,email,phone,display_name,username,dob,timezone\n");
    let mut phones = 0usize;
    for i in 1..=ROWS {
        let phone = if i % 5 == 0 {
            phones += 1;
            format!(
                "+1{}555{:04}",
                areas[phones % areas.len()],
                2000 + phones / areas.len()
            )
        } else {
            String::new()
        };
        let _ = writeln!(
            out,
            "bulk-{i:06},carbon{i:06}.bulk@bulk.example.test,{phone},Carbon {i},bulk-{i:06},19{:02}-0{}-1{},{}",
            50 + i % 50,
            1 + i % 9,
            i % 10,
            zones[i % zones.len()]
        );
    }
    out.into_bytes()
}

#[tokio::test]
#[ignore = "100k-row throughput run; use --ignored --nocapture"]
async fn import_100k_rows_throughput() {
    let ctx = TestContext::new().await;
    let a = owned_app(&ctx, "bulk").await;
    let csv = big_csv();
    let bytes = csv.len();

    let started = Instant::now();
    let r = call(
        &ctx,
        raw(
            Req::post(&format!("/v1/apps/{}/imports?default_country=US", a.app_id))
                .basic(&a.app_id, &a.secret),
            "text/csv",
            csv,
        ),
    )
    .await;
    let request_ms = started.elapsed().as_millis();
    assert_eq!(r.status, 202, "{}", r.json);
    assert_eq!(r.json["job"]["total_rows"], ROWS);
    let id = r.json["job"]["id"].as_str().expect("job").to_string();

    let processing = Instant::now();
    assert_eq!(run_jobs(&ctx).await, 1);
    let processing_ms = processing.elapsed().as_millis().max(1);

    let r = call(
        &ctx,
        Req::get(&format!("/v1/apps/{}/imports/{id}", a.app_id)).basic(&a.app_id, &a.secret),
    )
    .await;
    let job = &r.json["job"];
    assert_eq!(job["status"], "completed", "{job}");
    assert_eq!(job["counts"]["created"], ROWS, "{job}");
    assert_eq!(job["counts"]["error"], 0, "{job}");
    let members: i64 = sqlx::query_scalar("select count(*) from memberships where app_id = $1")
        .bind(&a.app_id)
        .fetch_one(&ctx.state.db)
        .await
        .expect("count");
    assert_eq!(members, ROWS as i64);

    let total_ms = started.elapsed().as_millis().max(1);
    println!(
        "100k import ({:.1} MB CSV, {} build): request (parse + queue) {request_ms} ms; processing {processing_ms} ms = {:.0} rows/s; end to end {total_ms} ms = {:.0} rows/s",
        bytes as f64 / 1_048_576.0,
        if cfg!(debug_assertions) {
            "debug"
        } else {
            "release"
        },
        ROWS as f64 * 1000.0 / processing_ms as f64,
        ROWS as f64 * 1000.0 / total_ms as f64,
    );
}
