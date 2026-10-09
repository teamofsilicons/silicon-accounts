//! A Silicon in CI: `login --federated` with a token from a variable, GitHub Actions'
//! `--github-actions`, the stored session (it ends with the outside token; how to sign in
//! again), and
//! `token identity` printing the JWT alone on stdout.

#![allow(clippy::unwrap_used)]

mod support;

use serde_json::Value;
use support::{Env, Mock, stdout_json};

#[test]
fn a_ci_job_signs_in_with_its_token_from_a_variable() {
    let mock = Mock::start();
    let env = Env::new();
    let output = env
        .cmd()
        .env("SILICON_ID_TOKEN", "eyJ.ci.ok")
        .args([
            "--url",
            &mock.url,
            "login",
            "--silicon",
            "si:scout",
            "--federated",
            "env:SILICON_ID_TOKEN",
            "--json",
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let json = stdout_json(&output);
    assert_eq!(json["authenticated"], true);
    assert_eq!(json["id"], "si:scout");
    let session: Value =
        serde_json::from_slice(&std::fs::read(env.state_file("session.json")).unwrap()).unwrap();
    assert_eq!(session["method"], "federated");
    // The sign-in ends with the outside token; the refresh token stops with it.
    assert_eq!(session["refresh_expires_at"], "2026-10-09T01:00:00Z");
    assert_eq!(session["federation"]["silicon"], "si:scout");
    assert_eq!(session["federation"]["source"], "env:SILICON_ID_TOKEN");
    assert!(
        !session.to_string().contains("eyJ.ci.ok"),
        "the outside token itself is never stored"
    );
    let form = &mock.requests("POST", "/v1/oauth/token")[0].1;
    assert!(form.contains("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Atoken-exchange"));
    assert!(form.contains("client_id=silicon-accounts"));

    // An identity token prints alone on stdout, ready for $(...).
    let output = env
        .cmd()
        .args([
            "token",
            "identity",
            "--audience",
            "sts.amazonaws.com",
            "--ttl",
            "900",
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        String::from_utf8_lossy(&output.stdout).trim(),
        "eyJ.identity.sig"
    );
    let body = &mock.requests("POST", "/v1/me/identity-tokens")[0].1;
    let body: Value = serde_json::from_str(body).unwrap();
    assert_eq!(body["audience"], "sts.amazonaws.com");
    assert_eq!(body["ttl_seconds"], 900);
    // Out of range is refused before anything is sent.
    let output = env
        .cmd()
        .args([
            "token",
            "identity",
            "--audience",
            "sts.amazonaws.com",
            "--ttl",
            "5000",
        ])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
}

#[test]
fn github_actions_gets_the_token_for_the_service_audience() {
    let mock = Mock::start();
    let env = Env::new();
    let output = env
        .cmd()
        .env(
            "ACTIONS_ID_TOKEN_REQUEST_URL",
            format!("{}/github-oidc?api-version=2.0", mock.url),
        )
        .env("ACTIONS_ID_TOKEN_REQUEST_TOKEN", "gh-request-token")
        .args([
            "--url",
            &mock.url,
            "login",
            "--silicon",
            "si:scout",
            "--federated",
            "--github-actions",
            "--json",
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let queries = mock.queries("GET", "/github-oidc");
    assert_eq!(queries.len(), 1);
    assert!(
        queries[0].contains("audience=http%3A%2F%2Faccounts.test"),
        "asks for the service's public URL: {queries:?}"
    );
    let session: Value =
        serde_json::from_slice(&std::fs::read(env.state_file("session.json")).unwrap()).unwrap();
    assert_eq!(session["federation"]["source"], "github-actions");
    assert_eq!(session["federation"]["audience"], "http://accounts.test");

    // Outside GitHub Actions the flag says what's missing.
    let env = Env::new();
    let output = env
        .cmd()
        .args([
            "--url",
            &mock.url,
            "login",
            "--silicon",
            "si:scout",
            "--github-actions",
            "--audience",
            "https://accounts.teamofsilicons.com",
        ])
        .output()
        .unwrap();
    assert!(!output.status.success());
    let err = String::from_utf8_lossy(&output.stderr);
    assert!(err.contains("id-token: write"), "{err}");
}

#[test]
fn a_token_no_trust_accepts_is_refused_with_the_reason() {
    let mock = Mock::start();
    let env = Env::new();
    let output = env
        .cmd()
        .env("SILICON_ID_TOKEN", "eyJ.ci.other")
        .args([
            "--url",
            &mock.url,
            "login",
            "--silicon",
            "si:scout",
            "--federated",
            "env:SILICON_ID_TOKEN",
        ])
        .output()
        .unwrap();
    assert!(!output.status.success());
    let err = String::from_utf8_lossy(&output.stderr);
    assert!(err.contains("repository"), "{err}");
    // --federated needs a Silicon.
    let output = env
        .cmd()
        .args(["--url", &mock.url, "login", "--federated", "env:X"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
}
