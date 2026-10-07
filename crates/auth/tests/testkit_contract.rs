//! Contract test against the real testkit mock-oidc (`testkit/src/mock-oidc.ts`), which is
//! strict where Google and Apple are: Google needs state, nonce, PKCE S256 and the openid
//! scope; Apple needs state, nonce, form_post, `name email` and an ES256 client secret JWT
//! (kid = key id, iss = team id, sub = Services ID, aud = the Apple issuer), and sends
//! `email_verified` as the string "true".
//!
//! The mock runs as a child process (`node --import tsx src/start.ts` in `testkit/`, on free
//! ports). When the testkit isn't installed (`pnpm -C testkit install`) or Node is missing, the
//! test says so on stderr and passes without running: the in-process mock in `providers.rs`
//! covers the same logic.

mod common;

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use accounts_core::Settings;
use accounts_core::secrecy::SecretString;
use accounts_core::test_support::{Req, TestContext};
use common::*;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, BufReader};

struct Testkit {
    child: tokio::process::Child,
    oidc: String,
    credentials: Value,
}

impl Drop for Testkit {
    fn drop(&mut self) {
        let _ = self.child.start_kill();
    }
}

fn testkit_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../testkit")
}

async fn start_testkit() -> Option<Testkit> {
    let dir = testkit_dir();
    let tsx = dir.join("node_modules/tsx");
    if !tsx.exists() {
        eprintln!(
            "testkit_contract: skipped — {} is missing (run `pnpm -C testkit install`)",
            tsx.display()
        );
        return None;
    }
    let credentials: Value = serde_json::from_str(
        &std::fs::read_to_string(dir.join("dev-credentials.json")).expect("dev-credentials.json"),
    )
    .expect("credentials JSON");
    // One node process with the tsx loader (the tsx CLI would fork a grandchild that outlives
    // a kill and keeps inherited pipes open).
    let mut child = match tokio::process::Command::new("node")
        .args([
            "--import",
            "tsx",
            "src/start.ts",
            "--oidc-port",
            "0",
            "--messaging-port",
            "0",
            "--fake-apps-port",
            "0",
            // Every port free-picked: a dev stack on the default ports (8591–8594) holds them.
            "--iris-port",
            "0",
            "--quiet",
        ])
        .current_dir(&dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            eprintln!("testkit_contract: skipped — could not start the testkit ({e})");
            return None;
        }
    };
    let stdout = child.stdout.take().expect("stdout");
    let mut lines = BufReader::new(stdout).lines();
    let ready = tokio::time::timeout(Duration::from_secs(60), async {
        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(json) = line.strip_prefix("testkit ready ") {
                return serde_json::from_str::<Value>(json).ok();
            }
        }
        None
    })
    .await
    .ok()
    .flatten();
    let Some(urls) = ready else {
        panic!("the testkit started but never printed its `testkit ready` line");
    };
    // Keep draining stdout so the child never blocks on a full pipe.
    tokio::spawn(async move { while let Ok(Some(_)) = lines.next_line().await {} });
    Some(Testkit {
        child,
        oidc: urls["oidc"].as_str().expect("oidc url").to_string(),
        credentials,
    })
}

fn settings_for(kit: &Testkit) -> Settings {
    let c = &kit.credentials["managed"];
    let oidc = &kit.oidc;
    let mut s = Settings::for_tests();
    s.google.client_id = c["google"]["client_id"].as_str().map(str::to_string);
    s.google.client_secret = c["google"]["client_secret"]
        .as_str()
        .map(SecretString::from);
    s.google.auth_url = format!("{oidc}/google/authorize");
    s.google.token_url = format!("{oidc}/google/token");
    s.google.jwks_url = format!("{oidc}/google/jwks");
    s.google.issuers = vec![format!("{oidc}/google")];
    s.apple.services_id = c["apple"]["services_id"].as_str().map(str::to_string);
    s.apple.team_id = c["apple"]["team_id"].as_str().map(str::to_string);
    s.apple.key_id = c["apple"]["key_id"].as_str().map(str::to_string);
    s.apple.private_key = c["apple"]["private_key_pem"]
        .as_str()
        .map(SecretString::from);
    s.apple.auth_url = format!("{oidc}/apple/authorize");
    s.apple.token_url = format!("{oidc}/apple/token");
    s.apple.jwks_url = format!("{oidc}/apple/jwks");
    s.apple.issuer = format!("{oidc}/apple");
    s
}

fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(20))
        .build()
        .expect("client")
}

fn unescape(s: &str) -> String {
    s.replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

/// The hidden inputs of Apple's form_post page.
fn form_fields(html: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for chunk in html.split("<input type=\"hidden\" name=\"").skip(1) {
        let Some((name, rest)) = chunk.split_once('"') else {
            continue;
        };
        let Some(rest) = rest.strip_prefix(" value=\"") else {
            continue;
        };
        let Some((value, _)) = rest.split_once('"') else {
            continue;
        };
        out.push((unescape(name), unescape(value)));
    }
    out
}

/// Plays the browser at the mock: `_auto` picks (or creates) the identity.
async fn authorize(url: &str, email: &str, name: &str) -> reqwest::Response {
    let mut u = url::Url::parse(url).expect("authorize url");
    u.query_pairs_mut()
        .append_pair("_auto", email)
        .append_pair("_name", name);
    http()
        .get(u.as_str())
        .send()
        .await
        .expect("authorize request")
}

async fn token_requests(kit: &Testkit, provider: &str, client_id: &str) -> Vec<Value> {
    let r: Value = http()
        .get(format!(
            "{}/_requests?provider={provider}&endpoint=token&client_id={client_id}",
            kit.oidc
        ))
        .send()
        .await
        .expect("requests")
        .json()
        .await
        .expect("json");
    r["items"].as_array().cloned().unwrap_or_default()
}

#[tokio::test]
async fn google_and_apple_work_against_the_testkit_mock() {
    let Some(kit) = start_testkit().await else {
        return;
    };
    let ctx = TestContext::with_settings(settings_for(&kit)).await;
    let public = ctx.state.settings.public_url.clone();

    // --- Google (managed): redirect with code + state, PKCE, nonce.
    let (app, _) = app_with(
        &ctx,
        "commit",
        json!({"methods": {"email": true, "google": true}}),
    )
    .await;
    let mut b = Browser::new(&ctx);
    let id = id_of(&new_flow(&ctx, &mut b, &app.app_id, json!({})).await);
    let r = b
        .post(&ctx, &format!("/v1/flows/{id}/oauth/google"), json!({}))
        .await;
    assert_eq!(r.status, 200, "{}", r.json);
    let email = random_email("ada");
    let answer = authorize(
        r.json["authorize_url"].as_str().expect("url"),
        &email,
        "Ada Testkit",
    )
    .await;
    assert_eq!(
        answer.status().as_u16(),
        302,
        "mock-oidc refused the authorize request: {}",
        answer.text().await.unwrap_or_default()
    );
    let location = answer.headers()["location"]
        .to_str()
        .expect("location")
        .to_string();
    let callback = location
        .strip_prefix(&public)
        .unwrap_or_else(|| panic!("callback {location} is not on {public}"));
    assert!(callback.starts_with("/v1/oauth/callback/google?"));
    // The browser that started the sign-in follows Google's redirect (with its cookies).
    let r = b.call(&ctx, Req::get(callback)).await;
    assert_eq!(r.status, 302, "{}", String::from_utf8_lossy(&r.body));
    let r = b.get(&ctx, &format!("/v1/flows/{id}")).await;
    assert_eq!(r.json["flow"]["step"], "signup", "{}", r.json);
    assert_eq!(r.json["flow"]["signup"]["display_name"], "Ada Testkit");
    assert_eq!(r.json["flow"]["signup"]["email"], email.as_str());
    let r = b
        .post(&ctx, &format!("/v1/flows/{id}/signup"), json!({}))
        .await;
    assert_eq!(r.status, 200, "{}", r.json);
    let google_id = kit.credentials["managed"]["google"]["client_id"]
        .as_str()
        .expect("id");
    assert!(!token_requests(&kit, "google", google_id).await.is_empty());

    // --- Apple (managed): form_post, ES256 client secret, first-login name, "true" strings.
    let (app, _) = app_with(&ctx, "waveform", json!({"methods": {"apple": true}})).await;
    let mut b = Browser::new(&ctx);
    let id = id_of(&new_flow(&ctx, &mut b, &app.app_id, json!({})).await);
    let r = b
        .post(&ctx, &format!("/v1/flows/{id}/oauth/apple"), json!({}))
        .await;
    assert_eq!(r.status, 200, "{}", r.json);
    let email = random_email("katherine");
    let answer = authorize(
        r.json["authorize_url"].as_str().expect("url"),
        &email,
        "Katherine Johnson",
    )
    .await;
    assert_eq!(answer.status().as_u16(), 200);
    let html = answer.text().await.expect("html");
    let fields = form_fields(&html);
    assert!(fields.iter().any(|(k, _)| k == "code"), "{html}");
    assert!(
        fields.iter().any(|(k, _)| k == "user"),
        "first authorization carries the name"
    );
    let pairs: Vec<(&str, &str)> = fields
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();
    // Apple's cross-site form_post carries no cookies: the answer is parked and the browser
    // continues with a same-site GET that does.
    let r = ctx
        .call(
            router(),
            Req::post("/v1/oauth/callback/apple")
                .form(&pairs)
                .header("origin", &kit.oidc),
        )
        .await;
    assert_eq!(r.status, 303, "{}", String::from_utf8_lossy(&r.body));
    let location = r.headers["location"]
        .to_str()
        .expect("location")
        .to_string();
    let next = location
        .strip_prefix(&public)
        .unwrap_or_else(|| panic!("{location} is not on {public}"));
    let r = b.call(&ctx, Req::get(next)).await;
    assert_eq!(r.status, 302, "{}", String::from_utf8_lossy(&r.body));
    let r = b.get(&ctx, &format!("/v1/flows/{id}")).await;
    assert_eq!(
        r.json["flow"]["step"], "signup",
        "the mock accepted the ES256 client secret: {}",
        r.json
    );
    assert_eq!(
        r.json["flow"]["signup"]["display_name"],
        "Katherine Johnson"
    );
    assert_eq!(r.json["flow"]["signup"]["provider"], "apple");

    // --- Google bring-your-own (acme-notes' client from dev-credentials.json).
    let byo = &kit.credentials["byo"]["acme-notes"]["google"];
    let byo_id = byo["client_id"].as_str().expect("byo id");
    let (app, _) = app_with(
        &ctx,
        "acme-notes",
        json!({"methods": {"google": true}, "google": {"mode": "byo", "client_id": byo_id, "prompt": "select_account", "hosted_domain": null}}),
    )
    .await;
    set_byo_google_secret(
        &ctx,
        &app.app_id,
        byo["client_secret"].as_str().expect("secret"),
    )
    .await;
    let mut b = Browser::new(&ctx);
    let id = id_of(&new_flow(&ctx, &mut b, &app.app_id, json!({})).await);
    let r = b
        .post(&ctx, &format!("/v1/flows/{id}/oauth/google"), json!({}))
        .await;
    let answer = authorize(
        r.json["authorize_url"].as_str().expect("url"),
        &random_email("acme"),
        "Acme User",
    )
    .await;
    assert_eq!(answer.status().as_u16(), 302);
    let location = answer.headers()["location"]
        .to_str()
        .expect("location")
        .to_string();
    let r = b
        .call(
            &ctx,
            Req::get(location.strip_prefix(&public).expect("public")),
        )
        .await;
    assert_eq!(r.status, 302);
    let r = b.get(&ctx, &format!("/v1/flows/{id}")).await;
    assert_eq!(r.json["flow"]["step"], "signup", "{}", r.json);
    assert!(
        !token_requests(&kit, "google", byo_id).await.is_empty(),
        "the mock saw acme's own client"
    );
}
