//! Latency of `POST /v1/proofs/verify`, measured in-process (router + extractors + the one
//! database query; no HTTP stack): 2,000 sequential verifies, then 2,000 more from 100
//! concurrent callers. Prints p50/p95/p99/max; the asserted bounds are deliberately loose so a
//! busy machine doesn't fail the build, while the printed numbers are the real result
//! (target: < 5 ms server time locally).
//!
//! Run alone for clean numbers:
//! `cargo test -p silicon-accounts-proofs --test perf -- --nocapture`

#[path = "api/common.rs"]
mod common;

use std::time::{Duration, Instant};

use accounts_core::test_support::{Req, call};
use serde_json::json;
use tokio::task::JoinSet;

use common::{World, token};

struct Stats {
    n: usize,
    p50: Duration,
    p95: Duration,
    p99: Duration,
    max: Duration,
    mean: Duration,
}

fn stats(mut v: Vec<Duration>) -> Stats {
    v.sort();
    let n = v.len();
    let at = |q: f64| v[((n as f64 * q).ceil() as usize).clamp(1, n) - 1];
    let total: Duration = v.iter().sum();
    Stats {
        n,
        p50: at(0.50),
        p95: at(0.95),
        p99: at(0.99),
        max: v[n - 1],
        mean: total / n as u32,
    }
}

fn ms(d: Duration) -> String {
    format!("{:.3} ms", d.as_secs_f64() * 1000.0)
}

fn report(label: &str, s: &Stats, wall: Duration) {
    println!(
        "verify latency [{label}]: n={} p50={} p95={} p99={} max={} mean={} wall={} ({:.0} verifies/s)",
        s.n,
        ms(s.p50),
        ms(s.p95),
        ms(s.p99),
        ms(s.max),
        ms(s.mean),
        ms(wall),
        s.n as f64 / wall.as_secs_f64()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn verify_latency_sequential_and_concurrent() {
    let w = World::new().await;
    // A pool sized like production (ACCOUNTS_DATABASE_MAX_CONNECTIONS defaults to 32).
    let pool = accounts_core::db::connect_url(&w.ctx.db.url, 32)
        .await
        .expect("pool");
    let state = accounts_core::test_support::test_state(pool);
    let app = accounts_proofs::router().with_state(state);
    let proof = w.issue_obo().await;
    let t = token(&proof);
    let (bc_id, bc_secret) = (w.briefcase.app_id.clone(), w.briefcase_secret.clone());
    let req = move |t: &str| {
        Req::post("/v1/proofs/verify")
            .basic(&bc_id, &bc_secret)
            .json(json!({ "proof_token": t }))
    };

    // Warm-up: credential cache, statement caches, pool connections.
    for _ in 0..100 {
        let r = call(app.clone(), req(&t)).await;
        assert_eq!(r.json["valid"], true, "{}", r.json);
    }

    let mut seq = Vec::with_capacity(2000);
    let started = Instant::now();
    for _ in 0..2000 {
        let t0 = Instant::now();
        let r = call(app.clone(), req(&t)).await;
        seq.push(t0.elapsed());
        assert_eq!(r.status, 200);
        assert_eq!(r.json["valid"], true);
    }
    let seq_wall = started.elapsed();

    let mut set = JoinSet::new();
    let started = Instant::now();
    for _ in 0..100 {
        let app = app.clone();
        let req = req.clone();
        let t = t.clone();
        set.spawn(async move {
            let mut v = Vec::with_capacity(20);
            for _ in 0..20 {
                let t0 = Instant::now();
                let r = call(app.clone(), req(&t)).await;
                v.push(t0.elapsed());
                assert_eq!(r.json["valid"], true, "{}", r.json);
            }
            v
        });
    }
    let mut conc = Vec::with_capacity(2000);
    while let Some(r) = set.join_next().await {
        conc.extend(r.expect("task"));
    }
    let conc_wall = started.elapsed();

    // Invalid answers take the same path (unknown token: the lookup finds nothing).
    let unknown = format!("sap_{}", "Z".repeat(43));
    let mut miss = Vec::with_capacity(500);
    let started = Instant::now();
    for _ in 0..500 {
        let t0 = Instant::now();
        let r = call(app.clone(), req(&unknown)).await;
        miss.push(t0.elapsed());
        assert_eq!(r.json["valid"], false);
    }

    let miss_wall = started.elapsed();

    let s = stats(seq);
    let c = stats(conc);
    let m = stats(miss);
    report("2000 sequential", &s, seq_wall);
    report("100 concurrent x 20", &c, conc_wall);
    report("500 sequential, unknown token", &m, miss_wall);

    assert!(
        s.p50 < Duration::from_millis(5),
        "sequential p50 {} misses the 5 ms target",
        ms(s.p50)
    );
    assert!(
        s.p95 < Duration::from_millis(25),
        "sequential p95 {} is far off",
        ms(s.p95)
    );
    assert!(
        c.p95 < Duration::from_millis(250),
        "concurrent p95 {} is far off",
        ms(c.p95)
    );
}
