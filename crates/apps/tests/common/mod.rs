//! Shared helpers for the apps integration tests (each test gets its own database).
#![allow(dead_code)]

use std::path::PathBuf;

use accounts_core::models::Account;
use accounts_core::test_support::{Req, Resp, TestContext};
use axum::Router;
use serde_json::Value;

/// The crate's router.
pub fn router() -> Router<accounts_core::AppState> {
    accounts_apps::router()
}

/// The repository root.
pub fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// A testkit file.
pub fn testkit(path: &str) -> PathBuf {
    repo_root().join("testkit").join(path)
}

/// An app owned by a fresh Carbon: (owner, owner's session cookie, app_id, app secret).
pub struct OwnedApp {
    pub owner: Account,
    pub cookie: String,
    pub app_id: String,
    pub secret: String,
}

pub async fn owned_app(ctx: &TestContext, prefix: &str) -> OwnedApp {
    let owner = ctx.carbon().await;
    let cookie = ctx.browser_session(&owner).await;
    let (app, secret) = ctx.app_owned(prefix, Some(&owner.uuid)).await;
    OwnedApp {
        owner,
        cookie,
        app_id: app.app_id,
        secret,
    }
}

/// Sends a request through the apps router.
pub async fn call(ctx: &TestContext, req: Req) -> Resp {
    ctx.call(router(), req).await
}

/// A raw body (CSV) with a content type.
pub fn raw(mut req: Req, content_type: &str, body: impl Into<Vec<u8>>) -> Req {
    req.body = body.into();
    req.header("content-type", content_type)
}

/// Runs every queued import job synchronously.
pub async fn run_jobs(ctx: &TestContext) -> usize {
    accounts_apps::imports::run_pending_jobs(&ctx.state)
        .await
        .unwrap_or_else(|e| panic!("import worker: {e}"))
}

/// All row results of an import job (follows cursors).
pub async fn all_rows(ctx: &TestContext, app_id: &str, secret: &str, job_id: &str) -> Vec<Value> {
    let mut out = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let mut uri = format!("/v1/apps/{app_id}/imports/{job_id}/rows?limit=200");
        if let Some(c) = &cursor {
            uri.push_str(&format!("&cursor={c}"));
        }
        let r = call(ctx, Req::get(&uri).basic(app_id, secret)).await;
        assert_eq!(r.status, 200, "{}", r.json);
        out.extend(r.json["items"].as_array().cloned().unwrap_or_default());
        match r.json["next_cursor"].as_str() {
            Some(c) => cursor = Some(c.to_string()),
            None => break,
        }
    }
    out
}

/// Message codes of a row result.
pub fn codes(row: &Value) -> Vec<String> {
    row["messages"]
        .as_array()
        .map(|m| {
            m.iter()
                .filter_map(|x| x["code"].as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// Seeds testkit/fake-apps.json into the context's database.
pub async fn seed_fake_apps(ctx: &TestContext) -> accounts_apps::SyncReport {
    accounts_apps::seed_fake_apps(&ctx.state, testkit("fake-apps.json"), false)
        .await
        .unwrap_or_else(|e| panic!("seeding fake apps: {e}"))
}

/// The fixed secret of a fake app from testkit/fake-apps.json.
pub fn fake_app_secret(app_id: &str) -> String {
    let doc: Value = serde_json::from_slice(
        &std::fs::read(testkit("fake-apps.json")).unwrap_or_else(|e| panic!("fake-apps.json: {e}")),
    )
    .unwrap_or_else(|e| panic!("fake-apps.json: {e}"));
    doc["apps"]
        .as_array()
        .and_then(|apps| apps.iter().find(|a| a["app_id"] == app_id))
        .and_then(|a| a["secret"].as_str())
        .unwrap_or_else(|| panic!("no fake app {app_id}"))
        .to_string()
}
