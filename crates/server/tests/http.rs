//! The composed service router, driven in-process (tower `oneshot`) against a throwaway
//! database: server endpoints, middleware, static serving, embed CSP and the fallback.

use std::path::Path;
use std::time::Duration;

use accounts_core::Settings;
use accounts_core::config::Environment;
use accounts_core::delivery::{self, NewMessage};
use accounts_core::models::MessageChannel;
use accounts_core::test_support::{Req, Resp, TestContext, call};
use accounts_server::middleware::{self, Policy};
use accounts_server::paths::Timeouts;
use axum::Router;
use axum::routing::get;
use serde_json::{Value, json};

const SPA_MARKER: &str = "<!-- spa index -->";
const EMBED_MARKER: &str = "<!-- embed buttons -->";

fn header<'a>(r: &'a Resp, name: &str) -> Option<&'a str> {
    r.headers.get(name).and_then(|v| v.to_str().ok())
}

async fn send(ctx: &TestContext, req: Req) -> Resp {
    call(accounts_server::build_router(ctx.state.clone()), req).await
}

/// A minimal built site: index, hashed asset, root files, embed page and SDK.
fn write_dist(dir: &Path) {
    let write = |rel: &str, body: &str| {
        let p = dir.join(rel);
        std::fs::create_dir_all(p.parent().expect("parent")).expect("mkdir");
        std::fs::write(p, body).expect("write");
    };
    write(
        "index.html",
        &format!(
            "<!doctype html><html><head><title>Silicon Accounts</title></head><body>{SPA_MARKER}<div id=\"root\"></div></body></html>"
        ),
    );
    write(
        "assets/app-abc123.js",
        &format!("console.log({:?});", "x".repeat(400)),
    );
    write(
        "favicon.svg",
        "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>",
    );
    write(
        "theme-boot.js",
        "document.documentElement.dataset.theme='light';",
    );
    write(
        "embed/v1/buttons.html",
        &format!("<!doctype html><html><body>{EMBED_MARKER}</body></html>"),
    );
    write("sdk/v1.js", "window.SiliconAccounts={version:1};");
    write(".secret", "do not serve");
}

async fn site_ctx() -> (TestContext, tempfile::TempDir) {
    let dir = tempfile::tempdir().expect("tempdir");
    write_dist(dir.path());
    let mut settings = Settings::for_tests();
    settings.web_dist = Some(dir.path().to_path_buf());
    (TestContext::with_settings(settings).await, dir)
}

#[tokio::test]
async fn health_ready_and_meta() {
    let ctx = TestContext::new().await;
    let r = send(&ctx, Req::get("/healthz")).await;
    assert_eq!(r.status, 200);
    assert_eq!(r.body, b"ok");
    assert_eq!(header(&r, "cache-control"), Some("no-store"));
    assert!(header(&r, "x-request-id").is_some());

    let r = send(&ctx, Req::get("/readyz")).await;
    assert_eq!(r.status, 200);
    assert_eq!(r.json, json!({"database": "ok"}));

    let r = send(
        &ctx,
        Req::get("/v1/meta").header("x-request-id", "req-meta-1"),
    )
    .await;
    assert_eq!(r.status, 200);
    assert_eq!(
        header(&r, "x-request-id"),
        Some("req-meta-1"),
        "a sane incoming id is echoed"
    );
    assert_eq!(r.json["name"], "Silicon Accounts");
    assert_eq!(r.json["version"], accounts_core::VERSION);
    assert_eq!(r.json["environment"], "test");
    assert_eq!(r.json["public_url"], "http://localhost:8590");
    assert_eq!(
        r.json["docs_url"],
        "https://developers.teamofsilicons.com/docs/accounts"
    );
    assert_eq!(
        r.json["silicon_apps_url"],
        "https://apps.teamofsilicons.com"
    );
    assert_eq!(
        r.json["developer_url"], "http://localhost:8600",
        "the developer platform (ACCOUNTS_DEVELOPER_URL; local default outside production)"
    );
    assert_eq!(
        r.json["providers"],
        json!({"google": false, "apple": false})
    );
    assert_eq!(r.json["delivery"], "local");
}

#[tokio::test]
async fn readiness_fails_without_a_database() {
    let ctx = TestContext::new().await;
    let state = ctx.state.clone();
    state.db.close().await;
    let r = call(accounts_server::build_router(state), Req::get("/readyz")).await;
    assert_eq!(r.status, 503);
    assert_eq!(r.json["database"], "unavailable");
    assert_eq!(r.json["error"]["code"], "database_unavailable");
}

#[tokio::test]
async fn security_headers_on_api_responses() {
    let ctx = TestContext::new().await;
    let r = send(&ctx, Req::get("/v1/meta")).await;
    assert_eq!(header(&r, "x-content-type-options"), Some("nosniff"));
    assert_eq!(
        header(&r, "referrer-policy"),
        Some("strict-origin-when-cross-origin")
    );
    assert_eq!(header(&r, "cache-control"), Some("no-store"));
    assert_eq!(
        header(&r, "content-security-policy"),
        Some("default-src 'none'; frame-ancestors 'none'")
    );
    assert!(
        header(&r, "strict-transport-security").is_none(),
        "HSTS only with secure cookies"
    );
    assert!(header(&r, "access-control-allow-origin").is_none());

    let mut secure = Settings::for_tests();
    secure.cookie_secure = true;
    let ctx = TestContext::with_settings(secure).await;
    let r = send(&ctx, Req::get("/v1/meta")).await;
    assert_eq!(
        header(&r, "strict-transport-security"),
        Some("max-age=63072000; includeSubDomains")
    );
}

#[tokio::test]
async fn cors_only_for_public_resources() {
    let ctx = TestContext::new().await;
    let (app, _) = ctx.app("cors").await;

    let r = send(
        &ctx,
        Req::get(&format!("/v1/apps/{}/public", app.app_id))
            .header("origin", "https://app.example.com"),
    )
    .await;
    assert_eq!(header(&r, "access-control-allow-origin"), Some("*"));
    assert!(header(&r, "access-control-allow-credentials").is_none());

    let r = send(
        &ctx,
        Req::new(
            axum::http::Method::OPTIONS,
            &format!("/v1/apps/{}/public", app.app_id),
        )
        .header("origin", "https://app.example.com")
        .header("access-control-request-method", "GET")
        .header(
            "access-control-request-headers",
            "content-type, x-accounts-telemetry",
        ),
    )
    .await;
    assert_eq!(r.status, 204);
    assert_eq!(header(&r, "access-control-allow-origin"), Some("*"));
    assert_eq!(
        header(&r, "access-control-allow-methods"),
        Some("GET, HEAD, OPTIONS")
    );
    assert_eq!(
        header(&r, "access-control-allow-headers"),
        Some("content-type, x-accounts-telemetry")
    );

    let r = send(
        &ctx,
        Req::get("/.well-known/jwks.json").header("origin", "https://x.example"),
    )
    .await;
    assert_eq!(header(&r, "access-control-allow-origin"), Some("*"));

    // Everything else: no CORS headers at all, preflights included.
    let r = send(
        &ctx,
        Req::get("/v1/meta").header("origin", "https://evil.example"),
    )
    .await;
    assert!(header(&r, "access-control-allow-origin").is_none());
    let r = send(
        &ctx,
        Req::new(axum::http::Method::OPTIONS, "/v1/me")
            .header("origin", "https://evil.example")
            .header("access-control-request-method", "DELETE"),
    )
    .await;
    assert!(r.status.is_client_error(), "{}", r.status);
    assert!(header(&r, "access-control-allow-origin").is_none());
    assert!(
        r.json["error"]["code"].is_string(),
        "errors are JSON: {:?}",
        r.json
    );
}

#[tokio::test]
async fn every_feature_router_is_mounted() {
    let ctx = TestContext::new().await;
    let (app, _) = ctx.app("mounted").await;
    let checks = [
        Req::get("/.well-known/openid-configuration"),
        Req::get("/.well-known/jwks.json"),
        Req::get("/v1/ids/available?id=c:someone-new"),
        Req::get(&format!("/v1/apps/{}/public", app.app_id)),
        Req::get("/v1/me"),
        Req::post("/v1/proofs/verify").json(json!({"proof_token": "sap_x"})),
        Req::post("/v1/silicons/login").json(json!({"id": "si:nobody", "stk": "stk-000000000000"})),
        Req::post("/v1/flows")
            .json(json!({"app_id": "no-such-app", "redirect_uri": "https://x.example/cb"})),
    ];
    for req in checks {
        let label = format!("{} {}", req.method, req.uri);
        let r = send(&ctx, req).await;
        assert_ne!(
            r.error_code(),
            Some("route_not_found"),
            "{label} must be served by its feature crate"
        );
        assert!(header(&r, "x-request-id").is_some(), "{label}");
    }
}

#[tokio::test]
async fn unknown_api_routes_are_json_404s() {
    let ctx = TestContext::new().await;
    let r = send(&ctx, Req::get("/v1/does-not-exist")).await;
    assert_eq!(r.status, 404);
    assert_eq!(r.error_code(), Some("route_not_found"));
    assert!(
        r.json["error"]["message"]
            .as_str()
            .is_some_and(|m| m.contains("GET /v1/does-not-exist"))
    );
    assert!(r.json["error"]["hint"].is_string());
    assert!(header(&r, "x-request-id").is_some());

    let r = send(&ctx, Req::post("/.well-known/nope")).await;
    assert_eq!(
        (r.status.as_u16(), r.error_code()),
        (404, Some("route_not_found"))
    );

    // Without ACCOUNTS_WEB_DIST the site isn't served, and the 404 says why.
    let r = send(&ctx, Req::get("/silicons")).await;
    assert_eq!(r.status, 404);
    assert!(
        r.json["error"]["message"]
            .as_str()
            .is_some_and(|m| m.contains("ACCOUNTS_WEB_DIST"))
    );
    let r = send(&ctx, Req::get("/sdk/v1.js")).await;
    assert_eq!(r.status, 404);
    assert!(
        r.json["error"]["hint"]
            .as_str()
            .is_some_and(|m| m.contains("ACCOUNTS_WEB_DIST"))
    );
}

#[tokio::test]
async fn method_not_allowed_is_json() {
    let ctx = TestContext::new().await;
    let r = send(&ctx, Req::delete("/v1/meta")).await;
    assert_eq!(r.status, 405);
    assert_eq!(r.error_code(), Some("method_not_allowed"));
    assert!(header(&r, "allow").is_some_and(|a| a.contains("GET")));
    assert!(r.json["error"]["message"].as_str().is_some_and(|m| {
        m.contains("DELETE is not allowed on /v1/meta") && m.contains("Allow header")
    }));
    assert!(r.json["error"]["hint"].is_string());
}

#[tokio::test]
async fn spa_fallback_static_files_and_api_404() {
    let (ctx, _dir) = site_ctx().await;

    for path in [
        "/",
        "/authorize?app_id=briefcase&state=x",
        "/silicons/a8K",
        "/device",
    ] {
        let r = send(&ctx, Req::get(path)).await;
        assert_eq!(r.status, 200, "{path}");
        assert!(
            String::from_utf8_lossy(&r.body).contains(SPA_MARKER),
            "{path} serves index.html"
        );
        assert_eq!(header(&r, "cache-control"), Some("no-store"), "{path}");
        assert_eq!(header(&r, "content-type"), Some("text/html; charset=utf-8"));
        assert_eq!(
            header(&r, "content-security-policy"),
            Some(accounts_server::middleware::policy::SPA_CSP)
        );
        assert_eq!(header(&r, "x-frame-options"), Some("DENY"));
    }

    let r = send(&ctx, Req::get("/assets/app-abc123.js")).await;
    assert_eq!(r.status, 200);
    assert_eq!(
        header(&r, "cache-control"),
        Some("public, max-age=31536000, immutable")
    );
    assert!(header(&r, "content-type").is_some_and(|c| c.contains("javascript")));

    let r = send(
        &ctx,
        Req::get("/assets/app-abc123.js").header("accept-encoding", "gzip"),
    )
    .await;
    assert_eq!(header(&r, "content-encoding"), Some("gzip"));

    let r = send(&ctx, Req::get("/assets/missing-999.js")).await;
    assert_eq!(r.status, 404, "a missing asset is never the HTML page");
    assert_eq!(header(&r, "cache-control"), Some("no-store"));
    assert_eq!(r.error_code(), Some("not_found"));

    let r = send(&ctx, Req::get("/favicon.svg")).await;
    assert_eq!(r.status, 200);
    assert_eq!(header(&r, "cache-control"), Some("no-cache"));

    let r = send(&ctx, Req::get("/.secret")).await;
    assert!(
        !String::from_utf8_lossy(&r.body).contains("do not serve"),
        "dotfiles are never served"
    );
    let r = send(&ctx, Req::get("/%2esecret")).await;
    assert!(!String::from_utf8_lossy(&r.body).contains("do not serve"));

    let r = send(&ctx, Req::get("/v1/nope")).await;
    assert_eq!(
        (r.status.as_u16(), r.error_code()),
        (404, Some("route_not_found"))
    );
    let r = send(&ctx, Req::get("/embed/v2/other")).await;
    assert_eq!(
        (r.status.as_u16(), r.error_code()),
        (404, Some("route_not_found"))
    );
    let r = send(&ctx, Req::post("/silicons")).await;
    assert_eq!(
        (r.status.as_u16(), r.error_code()),
        (404, Some("route_not_found"))
    );

    let r = send(&ctx, Req::new(axum::http::Method::HEAD, "/")).await;
    assert_eq!(r.status, 200);
    assert!(r.body.is_empty());
}

async fn set_allowed_origins(ctx: &TestContext, app_id: &str, origins: Value) {
    sqlx::query(
        "update app_signin_configs set config = jsonb_set(config, '{allowed_origins}', $2) where app_id = $1",
    )
    .bind(app_id)
    .bind(origins)
    .execute(&mut *ctx.conn().await)
    .await
    .expect("set allowed_origins");
}

#[tokio::test]
async fn embed_csp_follows_each_apps_allowed_origins() {
    let (ctx, _dir) = site_ctx().await;
    let (with_origins, _) = ctx.app("embed").await;
    set_allowed_origins(
        &ctx,
        &with_origins.app_id,
        json!(["https://app.example.com", "http://127.0.0.1:8593"]),
    )
    .await;
    let (without, _) = ctx.app("plain").await;
    let (disabled, _) = ctx.app("off").await;
    set_allowed_origins(&ctx, &disabled.app_id, json!(["https://off.example.com"])).await;
    sqlx::query("update apps set status = 'disabled' where app_id = $1")
        .bind(&disabled.app_id)
        .execute(&mut *ctx.conn().await)
        .await
        .expect("disable");

    let r = send(
        &ctx,
        Req::get(&format!(
            "/embed/v1/buttons?app_id={}&redirect_uri=https%3A%2F%2Fapp.example.com%2Fcb&state=s1",
            with_origins.app_id
        )),
    )
    .await;
    assert_eq!(r.status, 200);
    assert!(String::from_utf8_lossy(&r.body).contains(EMBED_MARKER));
    let csp = header(&r, "content-security-policy").expect("csp");
    assert!(
        csp.contains("frame-ancestors 'self' https://app.example.com http://127.0.0.1:8593;"),
        "{csp}"
    );
    assert!(csp.starts_with("default-src 'self';"), "{csp}");
    assert!(
        header(&r, "x-frame-options").is_none(),
        "framing is allowed for those origins"
    );
    assert_eq!(header(&r, "cache-control"), Some("no-store"));

    for query in [
        format!("app_id={}", without.app_id),
        format!("app_id={}", disabled.app_id),
        "app_id=no-such-app".to_string(),
        "app_id=Bad%3BId".to_string(),
        String::new(),
    ] {
        let r = send(&ctx, Req::get(&format!("/embed/v1/buttons?{query}"))).await;
        assert_eq!(r.status, 200, "{query}");
        let csp = header(&r, "content-security-policy").expect("csp");
        assert!(csp.contains("frame-ancestors 'none'"), "{query}: {csp}");
        assert_eq!(header(&r, "x-frame-options"), Some("DENY"), "{query}");
    }
}

#[tokio::test]
async fn sdk_is_public_and_cached_for_five_minutes() {
    let (ctx, _dir) = site_ctx().await;
    let r = send(
        &ctx,
        Req::get("/sdk/v1.js").header("origin", "https://app.example.com"),
    )
    .await;
    assert_eq!(r.status, 200);
    assert_eq!(
        String::from_utf8_lossy(&r.body),
        "window.SiliconAccounts={version:1};"
    );
    assert_eq!(header(&r, "access-control-allow-origin"), Some("*"));
    assert_eq!(header(&r, "cache-control"), Some("public, max-age=300"));
    assert_eq!(
        header(&r, "content-type"),
        Some("text/javascript; charset=utf-8")
    );
    assert_eq!(
        header(&r, "cross-origin-resource-policy"),
        Some("cross-origin")
    );
    assert_eq!(header(&r, "x-content-type-options"), Some("nosniff"));
}

async fn report_messages(ctx: &TestContext) -> Vec<(String, String, String, String)> {
    sqlx::query_as(
        "select to_address, coalesce(subject, ''), text_body, status from outbound_messages where purpose = 'report' order by to_address",
    )
    .fetch_all(&mut *ctx.conn().await)
    .await
    .expect("messages")
}

#[tokio::test]
async fn reports_mail_every_recipient() {
    let ctx = TestContext::new().await;
    let pr = "https://github.com/teamofsilicons/silicon-accounts/pull/7";
    let r = send(
        &ctx,
        Req::post("/v1/reports").json(
            json!({"message": "  The device code page loops forever.\nSteps: …  ", "pr_url": pr}),
        ),
    )
    .await;
    assert_eq!(r.status, 201, "{:?}", r.json);
    assert_eq!(r.json["status"], "queued");
    assert_eq!(r.json["recipients"], 3);
    let report_id = r.json["report_id"].as_str().expect("report_id").to_string();

    let sent = report_messages(&ctx).await;
    let to: Vec<&str> = sent.iter().map(|m| m.0.as_str()).collect();
    assert_eq!(
        to,
        vec![
            "bugs@teamofsilicons.com",
            "saketdev12@gmail.com",
            "shubhastro2@gmail.com"
        ]
    );
    for (_, subject, text, status) in &sent {
        assert_eq!(
            subject,
            "[Silicon Accounts bug report] The device code page loops forever."
        );
        assert!(text.contains(&report_id));
        assert!(text.contains(pr));
        assert!(text.contains("an anonymous caller"));
        assert_eq!(status, "local", "local delivery records instead of sending");
    }
    let stored: (String, Option<String>, Option<String>) =
        sqlx::query_as("select message, pr_url, account_uuid from bug_reports where id = $1::uuid")
            .bind(&report_id)
            .fetch_one(&mut *ctx.conn().await)
            .await
            .expect("bug report row");
    assert_eq!(stored.0, "The device code page loops forever.\nSteps: …");
    assert_eq!(stored.1.as_deref(), Some(pr));
    assert!(stored.2.is_none());
}

#[tokio::test]
async fn reports_validate_input_and_rate_limit() {
    let ctx = TestContext::new().await;
    let r = send(
        &ctx,
        Req::post("/v1/reports")
            .json(json!({"message": "x", "pr_url": "http://github.com/a/b/pull/1"})),
    )
    .await;
    assert_eq!(r.status, 422);
    assert_eq!(r.error_code(), Some("validation_failed"));
    assert!(
        r.json["error"]["details"]["fields"]["pr_url"]
            .as_str()
            .is_some_and(|m| m.contains("https"))
    );

    let r = send(
        &ctx,
        Req::post("/v1/reports").json(json!({"message": "   "})),
    )
    .await;
    assert_eq!(r.status, 422);
    assert!(r.json["error"]["details"]["fields"]["message"].is_string());

    let r = send(
        &ctx,
        Req::post("/v1/reports").json(json!({"message": "x".repeat(10_001)})),
    )
    .await;
    assert_eq!(r.status, 422);

    let r = send(
        &ctx,
        Req::post("/v1/reports").json(json!({"message": "hi", "pr": "https://x"})),
    )
    .await;
    assert_eq!(r.status, 422, "unknown fields are named: {:?}", r.json);

    for i in 0..5 {
        let r = send(
            &ctx,
            Req::post("/v1/reports").json(json!({"message": format!("report {i}")})),
        )
        .await;
        assert_eq!(r.status, 201, "report {i}");
    }
    let r = send(
        &ctx,
        Req::post("/v1/reports").json(json!({"message": "one too many"})),
    )
    .await;
    assert_eq!(r.status, 429);
    assert_eq!(r.error_code(), Some("rate_limited"));
    assert!(header(&r, "retry-after").is_some());
    assert_eq!(
        report_messages(&ctx).await.len(),
        15,
        "rejected reports send nothing"
    );
}

#[tokio::test]
async fn signed_in_reports_are_idempotent_and_audited() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let token = ctx.first_party_tokens(&carbon).await.access_token;
    let body = json!({"message": "Rotating an STK twice in a row fails."});
    let first = send(
        &ctx,
        Req::post("/v1/reports")
            .bearer(&token)
            .header("idempotency-key", "report-key-1")
            .json(body.clone()),
    )
    .await;
    assert_eq!(first.status, 201);
    let replay = send(
        &ctx,
        Req::post("/v1/reports")
            .bearer(&token)
            .header("idempotency-key", "report-key-1")
            .json(body),
    )
    .await;
    assert_eq!(replay.status, 201);
    assert_eq!(header(&replay, "idempotent-replayed"), Some("true"));
    assert_eq!(replay.json["report_id"], first.json["report_id"]);
    let sent = report_messages(&ctx).await;
    assert_eq!(sent.len(), 3, "a replay sends nothing again");
    assert!(
        sent[0].2.contains(carbon.id()),
        "the email names the reporter"
    );

    let reused = send(
        &ctx,
        Req::post("/v1/reports")
            .bearer(&token)
            .header("idempotency-key", "report-key-1")
            .json(json!({"message": "a different report"})),
    )
    .await;
    assert_eq!(reused.status, 409);
    assert_eq!(reused.error_code(), Some("idempotency_key_reused"));

    let audited: i64 = sqlx::query_scalar(
        "select count(*) from audit_log where action = 'report.submitted' and account_uuid = $1",
    )
    .bind(&carbon.uuid)
    .fetch_one(&mut *ctx.conn().await)
    .await
    .expect("audit");
    assert_eq!(audited, 1);
}

#[tokio::test]
async fn telemetry_accepts_cli_events_and_rejects_bad_ones() {
    let ctx = TestContext::new().await;
    let batch = json!({"events": [
        {"source": "cli", "step": "accounts login status", "name": "cli.command", "progress": 1.0,
         "data": {"outcome": "ok", "exit_code": 0}},
        {"source": "cli", "step": "login.device.approved", "name": "cli.step", "progress": 0.9, "data": {}},
        {"source": "cli", "step": "login.code.sent", "name": "cli.step"}
    ]});
    let r = send(&ctx, Req::post("/v1/telemetry/events").json(batch.clone())).await;
    assert_eq!(r.status, 202, "{:?}", r.json);
    assert_eq!(r.json, json!({"accepted": 3, "forwarded": false}));

    let r = send(
        &ctx,
        Req::post("/v1/telemetry/events")
            .header("x-accounts-telemetry", "off")
            .json(batch),
    )
    .await;
    assert_eq!(r.status, 202);
    assert_eq!(r.json["forwarded"], false);

    let r = send(
        &ctx,
        Req::post("/v1/telemetry/events").json(json!({"events": [
            {"source": "cli", "step": "x", "name": "Bad Name"}
        ]})),
    )
    .await;
    assert_eq!(r.status, 422);
    assert!(r.json["error"]["details"]["fields"]["events[0].name"].is_string());

    let many: Vec<Value> = (0..51)
        .map(|_| json!({"source": "cli", "step": "x", "name": "cli.step"}))
        .collect();
    let r = send(
        &ctx,
        Req::post("/v1/telemetry/events").json(json!({"events": many})),
    )
    .await;
    assert_eq!(r.status, 422);
    assert!(r.json["error"]["details"]["fields"]["events"].is_string());

    let r = send(&ctx, Req::post("/v1/telemetry/events").json(json!({}))).await;
    assert_eq!(r.status, 422, "events is required");
}

/// Names of the captured telemetry events (and empties the sink).
fn drain(sink: &accounts_core::telemetry::CapturedEvents) -> Vec<String> {
    let mut events = sink.lock().expect("sink");
    let names = events
        .iter()
        .map(|e| e["event"].as_str().unwrap_or_default().to_string())
        .collect();
    events.clear();
    names
}

#[tokio::test]
async fn telemetry_opt_out_covers_every_event_of_the_request() {
    let mut ctx = TestContext::new().await;
    let (telemetry, sink) = accounts_core::telemetry::Telemetry::capturing();
    ctx.state.telemetry = telemetry;
    let carbon = ctx.carbon().await;
    let token = ctx.first_party_tokens(&carbon).await.access_token;
    let rename = |name: &str| {
        Req::patch("/v1/me")
            .bearer(&token)
            .json(json!({"display_name": name}))
    };

    // Opted in: the request event and the event the handler records.
    let r = send(&ctx, rename("Telemetry One")).await;
    assert_eq!(r.status, 200, "{}", r.json);
    let events = drain(&sink);
    assert!(
        events.contains(&"http.request".to_string())
            && events.contains(&"account.profile.updated".to_string()),
        "{events:?}"
    );

    // X-Accounts-Telemetry: off drops both.
    let r = send(
        &ctx,
        rename("Telemetry Two").header("x-accounts-telemetry", "off"),
    )
    .await;
    assert_eq!(r.status, 200);
    assert_eq!(drain(&sink), Vec::<String>::new());

    // So does the account site's cookie, even next to a Bearer token.
    let r = send(
        &ctx,
        rename("Telemetry Three").header("cookie", "sa_telemetry=off"),
    )
    .await;
    assert_eq!(r.status, 200);
    assert_eq!(drain(&sink), Vec::<String>::new());

    // Client events are not forwarded for an opted-out caller either.
    let batch = json!({"events": [{"source": "web", "step": "settings", "name": "web.step"}]});
    let r = send(
        &ctx,
        Req::post("/v1/telemetry/events")
            .header("cookie", "sa_telemetry=off")
            .json(batch.clone()),
    )
    .await;
    assert_eq!(r.status, 202);
    assert_eq!(r.json["forwarded"], false);
    assert_eq!(drain(&sink), Vec::<String>::new());
    let r = send(&ctx, Req::post("/v1/telemetry/events").json(batch)).await;
    assert_eq!(r.json["forwarded"], true);
    assert!(drain(&sink).contains(&"web.step".to_string()));

    // Background work (outside any request) is the service's own and keeps reporting.
    ctx.state
        .telemetry
        .record("worker", "test", "worker.event", json!({}));
    assert_eq!(drain(&sink), vec!["worker.event".to_string()]);
}

async fn enqueue(ctx: &TestContext, to: &str, purpose: &str, text: &str) {
    let mut conn = ctx.conn().await;
    delivery::enqueue(
        &mut conn,
        &ctx.state.settings,
        &NewMessage {
            channel: MessageChannel::Email,
            to: to.into(),
            subject: Some("subject".into()),
            text_body: text.into(),
            html_body: None,
            purpose: purpose.into(),
        },
    )
    .await
    .expect("enqueue");
}

#[tokio::test]
async fn dev_outbox_lists_messages_with_codes_when_enabled() {
    let ctx = TestContext::new().await;
    assert!(ctx.state.settings.dev_outbox_enabled());
    enqueue(
        &ctx,
        "Carbon@Example.test",
        "otp_signin",
        "Your Silicon Accounts verification code is 042424. It expires in 10 minutes.",
    )
    .await;
    enqueue(
        &ctx,
        "carbon@example.test",
        "custodian_request",
        "Accept 123456 requests?",
    )
    .await;
    enqueue(&ctx, "other@example.test", "otp_add_email", "Code 777777").await;

    let r = send(&ctx, Req::get("/v1/dev/outbox?to=carbon%40example.test")).await;
    assert_eq!(r.status, 200, "{:?}", r.json);
    let items = r.json["items"].as_array().expect("items");
    assert_eq!(items.len(), 2, "filtered by address, case-insensitively");
    assert_eq!(items[0]["purpose"], "custodian_request", "newest first");
    assert_eq!(
        items[0]["code"],
        Value::Null,
        "codes are parsed from OTP messages only"
    );
    assert_eq!(items[1]["purpose"], "otp_signin");
    assert_eq!(items[1]["code"], "042424");
    assert_eq!(items[1]["channel"], "email");
    assert_eq!(items[1]["status"], "local");
    assert!(
        items[1]["created_at"]
            .as_str()
            .is_some_and(|t| t.ends_with('Z'))
    );
    assert_eq!(r.json["next_cursor"], Value::Null);

    let r = send(&ctx, Req::get("/v1/dev/outbox?purpose=otp_add_email")).await;
    assert_eq!(r.json["items"].as_array().map(Vec::len), Some(1));
    assert_eq!(r.json["items"][0]["code"], "777777");
    let r = send(&ctx, Req::get("/v1/dev/outbox?limit=1")).await;
    assert_eq!(r.json["items"].as_array().map(Vec::len), Some(1));
    let r = send(&ctx, Req::get("/v1/dev/outbox?limit=lots")).await;
    assert_eq!(
        (r.status.as_u16(), r.error_code()),
        (400, Some("invalid_query"))
    );
}

#[tokio::test]
async fn dev_outbox_is_gated() {
    let mut off = Settings::for_tests();
    off.expose_dev_outbox = false;
    let ctx = TestContext::with_settings(off).await;
    let r = send(&ctx, Req::get("/v1/dev/outbox")).await;
    assert_eq!(
        (r.status.as_u16(), r.error_code()),
        (404, Some("dev_outbox_disabled"))
    );
    assert!(
        r.json["error"]["hint"]
            .as_str()
            .is_some_and(|h| h.contains("ACCOUNTS_EXPOSE_DEV_OUTBOX"))
    );

    let mut prod = Settings::for_tests();
    prod.environment = Environment::Production;
    prod.expose_dev_outbox = true;
    let ctx = TestContext::with_settings(prod).await;
    let r = send(&ctx, Req::get("/v1/dev/outbox")).await;
    assert_eq!(
        (r.status.as_u16(), r.error_code()),
        (404, Some("route_not_found")),
        "production answers like a route that does not exist"
    );
}

#[tokio::test]
async fn body_limits_per_route() {
    let ctx = TestContext::new().await;
    let big = json!({"message": "x".repeat(70 * 1024)}).to_string();

    // Declared Content-Length over the limit: refused before the handler runs.
    let mut req = Req::post("/v1/reports").header("content-type", "application/json");
    req.body = big.clone().into_bytes();
    let req = req.header("content-length", &big.len().to_string());
    let r = send(&ctx, req).await;
    assert_eq!(r.status, 413);
    assert_eq!(r.error_code(), Some("payload_too_large"));
    assert!(
        r.json["error"]["message"]
            .as_str()
            .is_some_and(|m| m.contains("POST /v1/reports accepts at most 64 KB"))
    );
    assert_eq!(r.json["error"]["details"]["limit_bytes"], 65_536);

    // No Content-Length (streamed): the body stream itself is capped.
    let mut req = Req::post("/v1/reports").header("content-type", "application/json");
    req.body = big.into_bytes();
    let r = send(&ctx, req).await;
    assert_eq!(r.status, 413);
    assert_eq!(r.error_code(), Some("payload_too_large"));

    // The photo route takes 2 MB: 1 MB passes the limit (and then needs a session)...
    let mut req = Req::post("/v1/me/photo").header("content-type", "image/png");
    req.body = vec![0u8; 1024 * 1024];
    let req = req.header("content-length", &(1024 * 1024).to_string());
    let r = send(&ctx, req).await;
    assert_ne!(r.status, 413);
    // ...3 MB does not.
    let mut req = Req::post("/v1/me/photo").header("content-type", "image/png");
    req.body = vec![0u8; 3 * 1024 * 1024];
    let req = req.header("content-length", &(3 * 1024 * 1024).to_string());
    let r = send(&ctx, req).await;
    assert_eq!(r.status, 413);
    assert!(
        r.json["error"]["message"]
            .as_str()
            .is_some_and(|m| m.contains("at most 2 MB"))
    );
}

/// A valid 100×100 PNG padded past the 64 KB default body limit (the image check only reads
/// the header chunks).
fn big_png() -> Vec<u8> {
    let mut v = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    v.extend_from_slice(&13u32.to_be_bytes());
    v.extend_from_slice(b"IHDR");
    v.extend_from_slice(&100u32.to_be_bytes());
    v.extend_from_slice(&100u32.to_be_bytes());
    v.extend_from_slice(&[8, 6, 0, 0, 0, 0x1F, 0x15, 0xC4, 0x89]);
    v.extend_from_slice(&[0, 0, 0, 0, b'I', b'E', b'N', b'D', 0xAE, 0x42, 0x60, 0x82]);
    v.resize(100 * 1024, 0);
    v
}

#[tokio::test]
async fn silicon_photos_and_their_history_through_the_whole_service() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let token = ctx.first_party_tokens(&carbon).await.access_token;
    let id = format!("si:shot-{}", accounts_core::test_support::rand_suffix());
    let r = send(
        &ctx,
        Req::post("/v1/me/silicons")
            .bearer(&token)
            .json(json!({"id": id, "display_name": "Shot"})),
    )
    .await;
    assert_eq!(r.status, 201, "{}", r.json);
    let uuid = r.json["silicon"]["uuid"]
        .as_str()
        .expect("uuid")
        .to_string();

    // A 100 KB photo: the custodian's photo route takes 2 MB like POST /v1/me/photo.
    let mut req = Req::post(&format!("/v1/me/silicons/{uuid}/photo"))
        .bearer(&token)
        .header("content-type", "image/png");
    req.body = big_png();
    let r = send(&ctx, req).await;
    assert_eq!(r.status, 201, "{}", r.json);
    let pfp_url = r.json["pfp_url"].as_str().expect("pfp_url").to_string();
    let path = &pfp_url[pfp_url.find("/v1/photos/").expect("photo path")..];
    let r = send(&ctx, Req::get(path)).await;
    assert_eq!(r.status, 200);
    assert_eq!(r.body.len(), 100 * 1024);

    // The sign-up page's photo route takes 2 MB too (this flow doesn't exist, so the answer is
    // the flow's error, not the body limit).
    let mut req =
        Req::post("/v1/flows/no-such-flow/signup/photo").header("content-type", "image/png");
    req.body = big_png();
    let r = send(&ctx, req).await;
    assert_ne!(r.status, 413, "{}", r.json);

    // Everything the custodian did to the Silicon names it in the custodian's history.
    let r = send(
        &ctx,
        Req::post(&format!("/v1/me/silicons/{uuid}/stk"))
            .bearer(&token)
            .json(json!({})),
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.json);
    let r = send(
        &ctx,
        Req::put(&format!("/v1/me/silicons/{uuid}/webhook"))
            .bearer(&token)
            .json(json!({"url": "https://hooks.example.test/shot"})),
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.json);
    let r = send(
        &ctx,
        Req::get("/v1/me/history?kind=security").bearer(&token),
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.json);
    let items = r.json["items"].as_array().expect("items").clone();
    let titles: Vec<&str> = items.iter().filter_map(|i| i["title"].as_str()).collect();
    for expected in [
        format!("STK of {id} rotated"),
        format!("New profile photo for {id}"),
        format!("Webhook of {id} set"),
    ] {
        assert!(
            titles.contains(&expected.as_str()),
            "{expected}: {titles:?}"
        );
    }
    let webhook = items
        .iter()
        .find(|i| i["meta"]["action"] == "silicon.webhook.set")
        .expect("webhook entry");
    assert_eq!(webhook["detail"], "Events go to https://hooks.example.test");
    for item in &items {
        assert_eq!(item["meta"]["silicon"]["uuid"], uuid.as_str(), "{item}");
        assert_eq!(item["meta"]["silicon"]["id"], id.as_str());
        assert_eq!(item["meta"]["silicon"]["kind"], "silicon");
    }
}

async fn panics() -> &'static str {
    panic!("handler exploded on purpose")
}

async fn sleeps() -> &'static str {
    tokio::time::sleep(Duration::from_secs(5)).await;
    "late"
}

/// A handler that fails the way framework rejections do: plain text, extra headers.
async fn plain_text_error() -> axum::response::Response {
    use axum::response::IntoResponse as _;
    (
        axum::http::StatusCode::BAD_REQUEST,
        axum::response::AppendHeaders([
            (axum::http::header::SET_COOKIE, "a=1; Path=/"),
            (axum::http::header::SET_COOKIE, "b=2; Path=/"),
            (axum::http::header::RETRY_AFTER, "7"),
        ]),
        "Failed to parse the request body as JSON: expected value at line 1 column 1",
    )
        .into_response()
}

#[tokio::test]
async fn plain_text_errors_are_rewritten_as_json_keeping_headers() {
    let ctx = TestContext::new().await;
    let router: Router = middleware::apply(
        Router::new().route("/v1/test/plain", get(plain_text_error)),
        &ctx.state,
        Policy::default(),
    )
    .with_state(ctx.state.clone());
    let r = call(router, Req::get("/v1/test/plain")).await;
    assert_eq!(r.status, 400);
    assert_eq!(r.error_code(), Some("invalid_request"));
    assert_eq!(
        r.json["error"]["message"],
        "Failed to parse the request body as JSON: expected value at line 1 column 1."
    );
    assert!(r.json["error"]["hint"].is_string());
    let cookies: Vec<&str> = r
        .headers
        .get_all("set-cookie")
        .iter()
        .filter_map(|v| v.to_str().ok())
        .collect();
    assert_eq!(cookies, vec!["a=1; Path=/", "b=2; Path=/"]);
    assert_eq!(header(&r, "retry-after"), Some("7"));
    assert!(header(&r, "content-type").is_some_and(|c| c.starts_with("application/json")));
    assert_eq!(header(&r, "cache-control"), Some("no-store"));
}

#[tokio::test]
async fn panics_and_timeouts_become_json_errors() {
    let ctx = TestContext::new().await;
    let policy = Policy {
        timeouts: Timeouts {
            default: Duration::from_millis(200),
            upload: Duration::from_millis(200),
            import: Duration::from_millis(200),
        },
    };
    let router: Router = middleware::apply(
        Router::new()
            .route("/v1/test/panic", get(panics))
            .route("/v1/test/slow", get(sleeps)),
        &ctx.state,
        policy,
    )
    .with_state(ctx.state.clone());

    let r = call(router.clone(), Req::get("/v1/test/panic")).await;
    assert_eq!(r.status, 500);
    assert_eq!(r.error_code(), Some("internal"));
    let id = header(&r, "x-request-id").expect("request id").to_string();
    assert_eq!(r.json["error"]["details"]["request_id"], id.as_str());
    assert!(
        !r.body.windows(8).any(|w| w == b"exploded"),
        "the panic message is never sent"
    );
    assert_eq!(header(&r, "x-content-type-options"), Some("nosniff"));

    let r = call(router, Req::get("/v1/test/slow")).await;
    assert_eq!(r.status, 503);
    assert_eq!(r.error_code(), Some("request_timeout"));
    assert_eq!(r.json["error"]["details"]["timeout_seconds"], 0);
}

#[tokio::test]
async fn background_tasks_start_and_stop() {
    let ctx = TestContext::new().await;
    let tasks = accounts_server::spawn_background(&ctx.state);
    assert!(tasks.len() >= 3, "at least the worker's three loops");
    tokio::time::timeout(
        Duration::from_secs(20),
        tasks.shutdown(Duration::from_secs(10)),
    )
    .await
    .expect("background tasks stop promptly");
    assert!(accounts_server::BackgroundTasks::none().is_empty());
}

/// An RFC 6749 error body: exactly `error` (a string) and `error_description`.
fn assert_rfc6749(r: &Resp, status: u16, error: &str) -> String {
    assert_eq!(r.status, status, "{:?}", r.json);
    assert_eq!(r.json["error"], error, "{:?}", r.json);
    let keys: Vec<&String> = r.json.as_object().expect("object").keys().collect();
    assert_eq!(keys.len(), 2, "only error + error_description: {keys:?}");
    assert_eq!(header(r, "cache-control"), Some("no-store"));
    assert!(header(r, "x-request-id").is_some());
    r.json["error_description"]
        .as_str()
        .expect("error_description")
        .to_string()
}

#[tokio::test]
async fn oauth_endpoints_answer_middleware_errors_in_rfc6749_form() {
    let ctx = TestContext::new().await;
    let big_form = format!(
        "grant_type=refresh_token&refresh_token={}",
        "x".repeat(70 * 1024)
    );

    // Declared Content-Length over 64 KB: refused by the limit layer, in RFC 6749 form.
    let mut req =
        Req::post("/v1/oauth/token").header("content-type", "application/x-www-form-urlencoded");
    req.body = big_form.clone().into_bytes();
    let req = req.header("content-length", &big_form.len().to_string());
    let r = send(&ctx, req).await;
    let description = assert_rfc6749(&r, 413, "invalid_request");
    assert!(
        description.contains("POST /v1/oauth/token accepts at most 64 KB"),
        "{description}"
    );

    // Streamed (no Content-Length): the token handler meets the capped stream; same shape.
    let mut req =
        Req::post("/v1/oauth/token").header("content-type", "application/x-www-form-urlencoded");
    req.body = big_form.into_bytes();
    assert_rfc6749(&send(&ctx, req).await, 413, "invalid_request");

    // Wrong method on each RFC 6749 endpoint.
    for path in [
        "/v1/oauth/token",
        "/v1/oauth/revoke",
        "/v1/oauth/introspect",
    ] {
        let r = send(&ctx, Req::get(path)).await;
        let description = assert_rfc6749(&r, 405, "invalid_request");
        assert!(
            description.contains(&format!("GET is not allowed on {path}")),
            "{description}"
        );
        assert!(
            header(&r, "allow").is_some_and(|a| a.contains("POST")),
            "{path}"
        );
    }

    // Other OAuth-family endpoints keep the API error object.
    let r = send(&ctx, Req::delete("/v1/userinfo")).await;
    assert_eq!(r.status, 405);
    assert_eq!(r.json["error"]["code"], "method_not_allowed");
    let r = send(&ctx, Req::get("/v1/oauth/token/")).await;
    assert_eq!(r.json["error"]["code"], "route_not_found");
}

async fn post_plain_text_error() -> axum::response::Response {
    plain_text_error().await
}

#[tokio::test]
async fn oauth_endpoints_get_rfc6749_panics_timeouts_and_rewrites() {
    let ctx = TestContext::new().await;
    let policy = Policy {
        timeouts: Timeouts {
            default: Duration::from_millis(200),
            upload: Duration::from_millis(200),
            import: Duration::from_millis(200),
        },
    };
    let router: Router = middleware::apply(
        Router::new()
            .route("/v1/oauth/token", axum::routing::post(panics))
            .route("/v1/oauth/introspect", axum::routing::post(sleeps))
            .route(
                "/v1/oauth/revoke",
                axum::routing::post(post_plain_text_error),
            ),
        &ctx.state,
        policy,
    )
    .with_state(ctx.state.clone());

    let r = call(router.clone(), Req::post("/v1/oauth/token")).await;
    let description = assert_rfc6749(&r, 500, "server_error");
    let id = header(&r, "x-request-id").expect("request id");
    assert!(
        description.contains(&format!("request id {id}")),
        "{description}"
    );
    assert!(
        !r.body.windows(8).any(|w| w == b"exploded"),
        "the panic message is never sent"
    );

    let r = call(router.clone(), Req::post("/v1/oauth/introspect")).await;
    let description = assert_rfc6749(&r, 503, "temporarily_unavailable");
    assert!(
        description.contains("did not finish POST /v1/oauth/introspect"),
        "{description}"
    );

    let r = call(router, Req::post("/v1/oauth/revoke")).await;
    let description = assert_rfc6749(&r, 400, "invalid_request");
    assert!(
        description.starts_with(
            "Failed to parse the request body as JSON: expected value at line 1 column 1."
        ),
        "{description}"
    );
    let cookies: Vec<&str> = r
        .headers
        .get_all("set-cookie")
        .iter()
        .filter_map(|v| v.to_str().ok())
        .collect();
    assert_eq!(
        cookies,
        vec!["a=1; Path=/", "b=2; Path=/"],
        "headers are kept"
    );
    assert_eq!(header(&r, "retry-after"), Some("7"));
}

/// A JSON body of exactly `size` bytes: `{"<key>": "xxxx…"}` merged into `fields`.
fn padded_json(mut fields: Value, pad_key: &str, size: usize) -> Vec<u8> {
    fields[pad_key] = json!("");
    let base = fields.to_string().len();
    fields[pad_key] = json!("x".repeat(size.saturating_sub(base)));
    let body = fields.to_string().into_bytes();
    assert_eq!(body.len(), size.max(base));
    body
}

#[tokio::test]
async fn body_limit_classes_hold_through_the_full_router() {
    let mut settings = Settings::for_tests();
    settings.internal_token = Some(accounts_core::secrecy::SecretString::from(
        "internal-token-for-the-body-limit-test",
    ));
    let ctx = TestContext::with_settings(settings).await;
    let (app, secret) = ctx.app("limits").await;
    let config_path = format!("/v1/apps/{}/signin-config", app.app_id);
    let imports_path = format!("/v1/apps/{}/imports", app.app_id);
    let invalid_patch = json!({"branding": {"light": {"primary": "not-a-colour"}}, "copy": {}});

    // Sign-in config: 512 KB. 300 KB (two inline logos' worth) reaches the handler, declared
    // or streamed; it answers 422 for the bad colour, never 413.
    for declared in [true, false] {
        let mut req = Req::patch(&config_path)
            .basic(&app.app_id, &secret)
            .header("content-type", "application/json");
        req.body = padded_json(invalid_patch.clone(), "padding", 300 * 1024);
        let req = if declared {
            let len = req.body.len().to_string();
            req.header("content-length", &len)
        } else {
            req
        };
        let r = send(&ctx, req).await;
        assert_eq!(r.status, 422, "declared={declared}: {:?}", r.json);
    }
    // 600 KB: refused, naming the 512 KB limit when declared.
    let mut req = Req::patch(&config_path)
        .basic(&app.app_id, &secret)
        .header("content-type", "application/json");
    req.body = padded_json(invalid_patch.clone(), "padding", 600 * 1024);
    let streamed = req.clone();
    let len = req.body.len().to_string();
    let r = send(&ctx, req.header("content-length", &len)).await;
    assert_eq!(r.status, 413);
    assert!(
        r.json["error"]["message"]
            .as_str()
            .is_some_and(|m| m.contains("accepts at most 512 KB")),
        "{:?}",
        r.json
    );
    let r = send(&ctx, streamed).await;
    assert_eq!(
        (r.status.as_u16(), r.error_code()),
        (413, Some("payload_too_large"))
    );

    // Internal sync: 5 MB. 6 MB declared is refused naming 5 MB; 3 MB streamed is read.
    let r = send(
        &ctx,
        Req::post("/v1/internal/apps/sync")
            .bearer("internal-token-for-the-body-limit-test")
            .header("content-type", "application/json")
            .header("content-length", &(6 * 1024 * 1024).to_string()),
    )
    .await;
    assert_eq!(r.status, 413);
    assert!(
        r.json["error"]["message"]
            .as_str()
            .is_some_and(|m| m.contains("accepts at most 5 MB")),
        "{:?}",
        r.json
    );
    let mut req = Req::post("/v1/internal/apps/sync")
        .bearer("internal-token-for-the-body-limit-test")
        .header("content-type", "application/json");
    req.body = padded_json(json!({"apps": []}), "padding", 3 * 1024 * 1024);
    let r = send(&ctx, req).await;
    // The handler parsed the whole 3 MB document before judging its contents.
    assert_eq!(r.status, 422, "{:?}", r.json);
    assert!(
        r.json["error"]["details"]["fields"]["apps"].is_string(),
        "a 3 MB sync is read and validated: {:?}",
        r.json
    );

    // Imports: 50 MB. 51 MB declared is refused naming 50 MB; 3 MB streamed (more than any
    // other class allows) reaches the import parser, which names the unknown column.
    let r = send(
        &ctx,
        Req::post(&imports_path)
            .basic(&app.app_id, &secret)
            .header("content-type", "application/json")
            .header("content-length", &(51 * 1024 * 1024).to_string()),
    )
    .await;
    assert_eq!(r.status, 413);
    assert!(
        r.json["error"]["message"]
            .as_str()
            .is_some_and(|m| m.contains("accepts at most 50 MB")),
        "{:?}",
        r.json
    );
    let mut req = Req::post(&imports_path)
        .basic(&app.app_id, &secret)
        .header("content-type", "application/json");
    let filler = "x".repeat(3 * 1024 * 1024);
    req.body = json!({"rows": [{"email": "big@example.test", "favourite_colour": filler}]})
        .to_string()
        .into_bytes();
    let r = send(&ctx, req).await;
    assert_ne!(r.status, 413, "{:?}", r.json);
    assert!(r.status.is_client_error(), "{:?}", r.json);
    assert!(
        r.json.to_string().contains("favourite_colour"),
        "the import handler read the whole body: {:?}",
        r.json
    );
}

#[derive(serde::Deserialize)]
struct SleepQuery {
    ms: u64,
}

async fn sleep_for(axum::extract::Query(q): axum::extract::Query<SleepQuery>) -> &'static str {
    tokio::time::sleep(Duration::from_millis(q.ms)).await;
    "done"
}

#[tokio::test]
async fn time_budgets_follow_the_route_class() {
    let ctx = TestContext::new().await;
    let policy = Policy {
        timeouts: Timeouts {
            default: Duration::from_millis(150),
            upload: Duration::from_millis(1500),
            import: Duration::from_millis(3000),
        },
    };
    let router: Router = middleware::apply(
        Router::new()
            .route("/v1/test/default", get(sleep_for))
            .route("/v1/me/photo", axum::routing::post(sleep_for))
            .route("/v1/internal/apps/sync", axum::routing::post(sleep_for))
            .route(
                "/v1/apps/{app_id}/signin-config",
                axum::routing::patch(sleep_for),
            )
            .route("/v1/apps/{app_id}/imports", axum::routing::post(sleep_for)),
        &ctx.state,
        policy,
    )
    .with_state(ctx.state.clone());
    let status = |req: Req| {
        let router = router.clone();
        async move { call(router, req).await.status.as_u16() }
    };
    let (default, config, photo_ok, photo_late, sync_ok, import_ok) = tokio::join!(
        status(Req::get("/v1/test/default?ms=500")),
        status(Req::patch("/v1/apps/x/signin-config?ms=500")),
        status(Req::post("/v1/me/photo?ms=500")),
        status(Req::post("/v1/me/photo?ms=2200")),
        status(Req::post("/v1/internal/apps/sync?ms=500")),
        status(Req::post("/v1/apps/x/imports?ms=2200")),
    );
    assert_eq!(default, 503, "default budget");
    assert_eq!(config, 503, "sign-in config uses the default budget");
    assert_eq!(photo_ok, 200, "photos get the upload budget");
    assert_eq!(photo_late, 503, "and no more");
    assert_eq!(sync_ok, 200, "app sync gets the upload budget");
    assert_eq!(import_ok, 200, "imports get the import budget");
}

/// With ACCOUNTS_DELIVERY=providers a code message is stored with the code redacted; the dev
/// outbox opens its sealed copy, so it still shows the code once the message is sent.
#[tokio::test]
async fn dev_outbox_shows_sealed_codes_after_sending() {
    use accounts_core::config::DeliveryMode;
    use accounts_core::models::{OtpChannel, OtpPurpose};
    use accounts_core::repo::otp::{self, NewChallenge};

    let mut settings = Settings::for_tests();
    settings.delivery = DeliveryMode::Providers;
    let ctx = TestContext::with_settings(settings).await;
    assert!(ctx.state.settings.dev_outbox_enabled());
    let (id, code) = {
        let mut conn = ctx.conn().await;
        let created = otp::send(
            &mut conn,
            &ctx.state.keys.pepper,
            &ctx.state.settings,
            &NewChallenge {
                purpose: OtpPurpose::Signin,
                channel: OtpChannel::Email,
                destination: "sealed@example.test",
                account_uuid: None,
                flow_id: Some("flow-1"),
                ip: None,
            },
        )
        .await
        .expect("challenge");
        let id = delivery::enqueue_otp(
            &mut conn,
            &ctx.state.settings,
            &created.challenge,
            &created.code,
            None,
        )
        .await
        .expect("enqueue");
        (id, created.code)
    };
    assert!(matches!(
        delivery::deliver_now(&ctx.state, id)
            .await
            .expect("deliver"),
        delivery::DeliveryOutcome::Sent { .. }
    ));
    let (text, subject): (String, Option<String>) =
        sqlx::query_as("select text_body, subject from outbound_messages where id = $1")
            .bind(id)
            .fetch_one(&mut *ctx.conn().await)
            .await
            .expect("row");
    assert!(!text.contains(&code) && !subject.unwrap_or_default().contains(&code));

    let r = send(&ctx, Req::get("/v1/dev/outbox?to=sealed%40example.test")).await;
    assert_eq!(r.status, 200, "{:?}", r.json);
    let item = &r.json["items"][0];
    assert_eq!(item["status"], "sent");
    assert_eq!(item["code"], code.as_str());
    assert!(
        item["text_body"]
            .as_str()
            .is_some_and(|t| t.contains(&code))
    );
    assert!(
        item["subject"]
            .as_str()
            .is_some_and(|t| t.starts_with(&code))
    );
}
