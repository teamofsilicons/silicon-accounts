//! Discovery: the OpenAPI document (and that it matches the router, both ways), the A2A agent
//! card, capability negotiation, version negotiation, and the 429 / error shape guarantees.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use accounts_core::test_support::{Req, Resp, TestContext, call};
use serde_json::{Value, json};

fn header<'a>(r: &'a Resp, name: &str) -> Option<&'a str> {
    r.headers.get(name).and_then(|v| v.to_str().ok())
}

async fn send(ctx: &TestContext, req: Req) -> Resp {
    call(accounts_server::build_router(ctx.state.clone()), req).await
}

fn spec() -> Value {
    serde_json::from_str(accounts_server::routes::discovery::OPENAPI_JSON).expect("openapi.json")
}

/// `/v1/apps/{app_id}/users/{uuid}` → `/v1/apps/{}/users/{}`.
fn normalize(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    let mut inside = false;
    for c in path.chars() {
        match c {
            '{' => {
                inside = true;
                out.push('{');
            }
            '}' => {
                inside = false;
                out.push('}');
            }
            _ if inside => {}
            _ => out.push(c),
        }
    }
    out
}

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).expect("read_dir").flatten() {
        let p = entry.path();
        if p.is_dir() {
            rust_files(&p, out);
        } else if p.extension().is_some_and(|e| e == "rs") {
            out.push(p);
        }
    }
}

/// Every `(METHOD, normalized path)` the crates register with `.route("…", get(…).post(…))`.
fn router_routes() -> BTreeSet<(String, String)> {
    let crates = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let mut files = Vec::new();
    for krate in std::fs::read_dir(&crates).expect("crates").flatten() {
        let src = krate.path().join("src");
        if src.is_dir() {
            rust_files(&src, &mut files);
        }
    }
    let mut routes = BTreeSet::new();
    for file in files {
        let text = std::fs::read_to_string(&file).expect("read");
        let mut rest = text.as_str();
        while let Some(at) = rest.find(".route(") {
            let after = &rest[at + ".route(".len()..];
            // The call's arguments, up to the matching parenthesis.
            let mut depth = 1usize;
            let mut end = after.len();
            for (i, c) in after.char_indices() {
                match c {
                    '(' => depth += 1,
                    ')' => {
                        depth -= 1;
                        if depth == 0 {
                            end = i;
                            break;
                        }
                    }
                    _ => {}
                }
            }
            let args = &after[..end];
            rest = &after[end..];
            let Some(path) = args
                .trim_start()
                .strip_prefix('"')
                .and_then(|s| s.split_once('"'))
                .map(|(p, _)| p)
            else {
                continue;
            };
            let methods = &args[args.find(',').unwrap_or(0)..];
            for method in ["get", "post", "put", "patch", "delete"] {
                let call = format!("{method}(");
                let found = methods.match_indices(&call).any(|(i, _)| {
                    i == 0
                        || !methods[..i]
                            .chars()
                            .last()
                            .is_some_and(|c| c.is_ascii_alphanumeric() || c == '_')
                });
                if found {
                    routes.insert((method.to_uppercase(), normalize(path)));
                }
            }
        }
    }
    routes
}

fn spec_routes(doc: &Value) -> BTreeSet<(String, String)> {
    let mut out = BTreeSet::new();
    for (path, item) in doc["paths"].as_object().expect("paths") {
        for (method, _) in item.as_object().expect("path item") {
            if ["get", "post", "put", "patch", "delete"].contains(&method.as_str()) {
                out.insert((method.to_uppercase(), normalize(path)));
            }
        }
    }
    out
}

#[test]
fn the_openapi_document_lists_exactly_the_routes_the_router_serves() {
    let router = router_routes();
    assert!(router.len() > 100, "the scan found {} routes", router.len());
    assert!(router.contains(&("GET".into(), "/v1/events/stream".into())));
    let documented = spec_routes(&spec());
    let undocumented: Vec<_> = router.difference(&documented).collect();
    let phantom: Vec<_> = documented.difference(&router).collect();
    assert!(
        undocumented.is_empty() && phantom.is_empty(),
        "routes missing from crates/server/openapi.json: {undocumented:?}\nroutes in openapi.json the router doesn't serve: {phantom:?}"
    );
}

#[test]
fn every_operation_is_complete() {
    let doc = spec();
    assert_eq!(doc["openapi"], "3.1.0");
    let mut ids = BTreeSet::new();
    for (path, item) in doc["paths"].as_object().expect("paths") {
        for (method, op) in item.as_object().expect("item") {
            if !["get", "post", "put", "patch", "delete"].contains(&method.as_str()) {
                continue;
            }
            let id = op["operationId"]
                .as_str()
                .unwrap_or_else(|| panic!("{method} {path}: operationId"));
            assert!(ids.insert(id.to_string()), "duplicate operationId {id}");
            assert!(op["summary"].is_string(), "{method} {path}: summary");
            assert!(
                op["responses"].as_object().is_some_and(|r| !r.is_empty()),
                "{method} {path}: responses"
            );
            assert!(
                op["tags"].as_array().is_some_and(|t| t.len() == 1),
                "{method} {path}: one tag"
            );
        }
    }
    let text = accounts_server::routes::discovery::OPENAPI_JSON;
    assert!(
        !text.contains('\u{2014}') && !text.contains('\u{2013}'),
        "no em or en dashes"
    );
    assert!(doc["components"]["schemas"]["Error"].is_object());
    for scheme in ["bearerAuth", "appBasic", "requestToken"] {
        assert!(
            doc["components"]["securitySchemes"][scheme].is_object(),
            "{scheme}"
        );
    }
}

/// Fills a path template with values that parse (the request is refused later, by auth or
/// lookup, never by routing).
fn concrete(path: &str) -> String {
    let mut out = String::new();
    let mut rest = path;
    while let Some(start) = rest.find('{') {
        out.push_str(&rest[..start]);
        let end = rest[start..].find('}').expect("closing brace") + start;
        let name = &rest[start + 1..end];
        out.push_str(match name {
            "provider" => "google",
            "app_id" => "briefcase",
            "user_code" => "ABCD-EFGH",
            "email" => "ada@example.com",
            "phone" => "+15555550100",
            _ => "0199aaaa-0000-7000-8000-000000000000",
        });
        rest = &rest[end + 1..];
    }
    out.push_str(rest);
    out
}

#[tokio::test]
async fn every_documented_operation_reaches_a_handler() {
    let ctx = TestContext::new().await;
    let doc = spec();
    for (path, item) in doc["paths"].as_object().expect("paths") {
        for (method, _) in item.as_object().expect("item") {
            let m = match method.as_str() {
                "get" => axum::http::Method::GET,
                "post" => axum::http::Method::POST,
                "put" => axum::http::Method::PUT,
                "patch" => axum::http::Method::PATCH,
                "delete" => axum::http::Method::DELETE,
                _ => continue,
            };
            // The legacy static files only exist with ACCOUNTS_WEB_DIST; the stream would
            // never end (it needs credentials, so it answers 401 here anyway).
            if path == "/embed/v1/buttons" || path == "/sdk/v1.js" {
                continue;
            }
            let uri = concrete(path);
            let r = send(&ctx, Req::new(m.clone(), &uri).json(json!({}))).await;
            assert_ne!(
                r.error_code(),
                Some("route_not_found"),
                "{method} {path} is not routed"
            );
            assert_ne!(r.status, 405, "{method} {path}: method not allowed");
        }
    }
}

#[tokio::test]
async fn openapi_is_served_on_both_paths_to_any_origin() {
    let ctx = TestContext::new().await;
    for path in ["/openapi.json", "/v1/openapi.json"] {
        let r = send(
            &ctx,
            Req::get(path).header("origin", "https://elsewhere.example"),
        )
        .await;
        assert_eq!(r.status, 200, "{path}");
        assert_eq!(header(&r, "content-type"), Some("application/json"));
        assert_eq!(header(&r, "access-control-allow-origin"), Some("*"));
        assert_eq!(header(&r, "cache-control"), Some("public, max-age=300"));
        assert_eq!(header(&r, "accounts-version"), Some("2026-10-01"));
        assert_eq!(r.json["openapi"], "3.1.0");
    }
}

#[tokio::test]
async fn the_agent_card_describes_the_service() {
    let ctx = TestContext::new().await;
    let r = send(&ctx, Req::get("/.well-known/agent.json")).await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(header(&r, "access-control-allow-origin"), Some("*"));
    let card = &r.json;
    let public = &ctx.state.settings.public_url;
    assert_eq!(card["name"], "Silicon Accounts");
    assert_eq!(card["url"], public.as_str());
    assert_eq!(card["provider"]["organization"], "Team of Silicons");
    assert_eq!(card["capabilities"]["streaming"], true);
    assert_eq!(card["capabilities"]["pushNotifications"], true);
    assert_eq!(card["links"]["openapi"], format!("{public}/openapi.json"));
    assert_eq!(card["links"]["mcp"], format!("{public}/mcp"));
    assert_eq!(card["links"]["llms_txt"], format!("{public}/llms.txt"));
    assert_eq!(
        card["documentationUrl"],
        ctx.state.settings.docs_url.as_str()
    );
    let skills: Vec<&str> = card["skills"]
        .as_array()
        .expect("skills")
        .iter()
        .filter_map(|s| s["id"].as_str())
        .collect();
    assert_eq!(
        skills,
        vec![
            "create-silicon-account",
            "sign-into-app",
            "verify-proof",
            "manage-app-sign-in",
            "subscribe-account-events"
        ]
    );
    let text = String::from_utf8(r.body).expect("utf8");
    assert!(!text.contains('\u{2014}') && !text.contains('\u{2013}'));
}

#[tokio::test]
async fn capabilities_answer_queries_and_negotiate_versions() {
    let ctx = TestContext::new().await;
    let r = send(&ctx, Req::get("/v1/capabilities")).await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(header(&r, "accounts-version"), Some("2026-10-01"));
    assert_eq!(r.json["api_version"], "2026-10-01");
    assert_eq!(r.json["api_versions"], json!(["2026-10-01"]));
    assert_eq!(r.json["version_header"], "Accounts-Version");
    for name in [
        "sse",
        "subscriptions",
        "webhooks",
        "idempotency_keys",
        "version_negotiation",
        "openapi",
        "agent_card",
        "mcp",
    ] {
        assert_eq!(r.json["capabilities"][name]["supported"], true, "{name}");
        assert!(
            r.json["capabilities"][name]["docs"]
                .as_str()
                .is_some_and(|d| d.starts_with("https://")),
            "{name}"
        );
    }
    assert_eq!(r.json["limits"]["streams_per_caller"], 5);
    assert!(r.json.get("require").is_none());

    let r = send(
        &ctx,
        Req::get("/v1/capabilities?require=sse,Subscriptions,event-streaming,idempotency")
            .header("accounts-version", "2026-10-01"),
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(header(&r, "accounts-version"), Some("2026-10-01"));
    assert_eq!(r.json["require"]["satisfied"], true);
    assert_eq!(
        r.json["require"]["supported"],
        json!(["sse", "subscriptions", "idempotency_keys"])
    );
    assert_eq!(r.json["require"]["missing"], json!([]));

    let r = send(&ctx, Req::get("/v1/capabilities?require=sse,graphql,soap")).await;
    assert_eq!(r.status, 422, "{}", r.json);
    assert_eq!(r.error_code(), Some("capabilities_missing"));
    let e = &r.json["error"];
    assert!(e["message"].as_str().is_some_and(|m| m.contains("graphql")));
    assert!(e["hint"].is_string());
    assert_eq!(e["details"]["missing"], json!(["graphql", "soap"]));
    assert_eq!(e["details"]["supported"], json!(["sse"]));
    assert!(
        e["details"]["available"]
            .as_array()
            .is_some_and(|a| a.len() > 20)
    );

    let r = send(&ctx, Req::get("/v1/capabilities?require=,,")).await;
    assert_eq!(r.status, 400);
    assert_eq!(r.error_code(), Some("invalid_query"));

    // An unknown version is refused everywhere with the supported list, before anything runs.
    for path in ["/v1/capabilities", "/v1/meta", "/v1/me", "/openapi.json"] {
        let r = send(
            &ctx,
            Req::get(path).header("accounts-version", "2025-01-01"),
        )
        .await;
        assert_eq!(r.status, 400, "{path}");
        assert_eq!(r.error_code(), Some("unsupported_version"), "{path}");
        assert_eq!(
            r.json["error"]["details"]["supported"],
            json!(["2026-10-01"])
        );
        assert_eq!(r.json["error"]["details"]["requested"], "2025-01-01");
        assert!(
            r.json["error"]["hint"]
                .as_str()
                .is_some_and(|h| h.contains("2026-10-01"))
        );
        assert_eq!(header(&r, "accounts-version"), Some("2026-10-01"));
    }
    // The OAuth endpoints answer it in their RFC 6749 shape.
    let r = send(
        &ctx,
        Req::post("/v1/oauth/token")
            .header("accounts-version", "1999-01-01")
            .form(&[("grant_type", "refresh_token")]),
    )
    .await;
    assert_eq!(r.status, 400);
    assert_eq!(r.json["error"], "invalid_request");
    assert!(
        r.json["error_description"]
            .as_str()
            .is_some_and(|d| d.contains("2026-10-01"))
    );

    // Clients that never heard of versions keep working, and every API answer names one.
    let r = send(&ctx, Req::get("/v1/meta")).await;
    assert_eq!(r.status, 200);
    assert_eq!(header(&r, "accounts-version"), Some("2026-10-01"));
    assert!(header(&r, "vary").is_some_and(|v| v.contains("Accounts-Version")));
}

#[tokio::test]
async fn rate_limits_answer_429_with_retry_after_and_the_error_shape() {
    let ctx = TestContext::new().await;
    // POST /v1/reports allows 5 an hour per address.
    let mut last = None;
    for i in 0..7 {
        let r = send(
            &ctx,
            Req::post("/v1/reports").json(json!({"message": format!("report {i}")})),
        )
        .await;
        last = Some(r);
    }
    let r = last.expect("answer");
    assert_eq!(r.status, 429, "{}", r.json);
    let retry: u64 = header(&r, "retry-after")
        .expect("Retry-After")
        .parse()
        .expect("seconds");
    assert!(retry >= 1);
    assert_eq!(r.error_code(), Some("rate_limited"));
    assert!(r.json["error"]["message"].is_string());
    assert!(r.json["error"]["hint"].is_string());
    assert_eq!(r.json["error"]["details"]["retry_after_seconds"], retry);
}
