//! Multi-step flows: Carbon device and code sign-in, Silicon self-create with a custodian
//! request, custodian create, and an app import.

#![allow(clippy::unwrap_used)]

mod support;

use predicates::prelude::*;
use serde_json::Value;
use support::{APP_ID, APP_SECRET, CARBON_EMAIL, Env, Mock, STK, stdout_json};

#[test]
fn carbon_device_login_prints_the_code_and_signs_in() {
    let mock = Mock::start();
    let env = Env::new();
    let output = env
        .cmd()
        .args([
            "--url",
            &mock.url,
            "login",
            "--no-browser",
            "--label",
            "ci box",
            "--json",
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    // The code is shown on stderr as a JSON line an agent can relay to a Carbon.
    let stderr = String::from_utf8_lossy(&output.stderr);
    let event: Value = stderr
        .lines()
        .find_map(|l| {
            serde_json::from_str::<Value>(l)
                .ok()
                .filter(|v| v["event"] == "device_code")
        })
        .unwrap_or_else(|| panic!("no device_code event in stderr:\n{stderr}"));
    assert_eq!(event["user_code"], "WDJB-MJHT");
    assert_eq!(event["browser_opened"], false);
    let json = stdout_json(&output);
    assert_eq!(json["authenticated"], true);
    assert_eq!(json["kind"], "carbon");
    assert_eq!(json["id"], "c:saket");
    let authorize = mock.requests("POST", "/v1/device/authorize");
    assert!(authorize[0].1.contains("ci box"), "label is sent");
    assert_eq!(
        mock.count("POST", "/v1/oauth/token"),
        2,
        "one pending poll, then tokens"
    );

    // Human mode tells the Carbon what to do.
    let env = Env::new();
    let mock = Mock::start();
    env.cmd()
        .args(["--url", &mock.url, "login", "--no-browser"])
        .assert()
        .success()
        .stderr(predicate::str::contains("WDJB-MJHT"))
        .stderr(predicate::str::contains("http://127.0.0.1/device"))
        .stdout(predicate::str::contains(
            "Signed in as c:saket (Saket), a Carbon.",
        ));
}

#[test]
fn carbon_code_login_works_in_two_non_interactive_steps() {
    let mock = Mock::start();
    let env = Env::new();
    let output = env
        .cmd()
        .args([
            "--url",
            &mock.url,
            "login",
            "--email",
            CARBON_EMAIL,
            "--json",
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let pending = stdout_json(&output);
    assert_eq!(pending["status"], "code_sent");
    assert_eq!(pending["authenticated"], false);
    assert_eq!(pending["destination"], "s***@example.com");
    assert!(pending["next"].as_str().unwrap().contains("--code"));

    // A wrong code: precise error, details kept, invalid input exit code.
    let output = env
        .cmd()
        .args([
            "--url",
            &mock.url,
            "login",
            "--email",
            CARBON_EMAIL,
            "--code",
            "000000",
            "--json",
        ])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    let json = stdout_json(&output);
    assert_eq!(json["error"]["code"], "invalid_code");
    assert_eq!(json["error"]["details"]["remaining_attempts"], 9);

    let output = env
        .cmd()
        .args([
            "--url",
            &mock.url,
            "login",
            "--email",
            CARBON_EMAIL,
            "--code",
            "123456",
            "--json",
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(stdout_json(&output)["id"], "c:saket");
    assert!(
        !env.state_file("login-challenge.json").exists(),
        "the pending challenge is cleared"
    );

    // --code without a pending challenge for that address.
    env.cmd()
        .args([
            "--url",
            &mock.url,
            "login",
            "--email",
            "other@example.com",
            "--code",
            "123456",
            "--force",
        ])
        .assert()
        .code(2)
        .stderr(predicate::str::contains(
            "No sign-in code is waiting for other@example.com",
        ));

    // Unknown address: not found, with the sign-up hint.
    let output = env
        .cmd()
        .args([
            "--url",
            &mock.url,
            "login",
            "--email",
            "nobody@example.com",
            "--force",
            "--json",
        ])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(4));
    assert_eq!(stdout_json(&output)["error"]["code"], "account_not_found");
}

#[test]
fn silicon_self_create_saves_the_request_and_waits_for_the_custodian() {
    let mock = Mock::start_with(2);
    let env = Env::new();
    let output = env
        .cmd()
        .args([
            "--url",
            &mock.url,
            "silicon",
            "create",
            "--id",
            "scout",
            "--custodian",
            "c:saket",
            "--timezone",
            "Europe/Berlin",
            "--json",
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let created = stdout_json(&output);
    assert_eq!(created["stk"], STK);
    assert_eq!(created["request"]["id"], "req-1");
    let request_file = std::path::PathBuf::from(created["request_file"].as_str().unwrap());
    assert!(request_file.exists());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&request_file)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
    let sent = mock.requests("POST", "/v1/silicons");
    let body: Value = serde_json::from_str(&sent[0].1).unwrap();
    assert_eq!(body["id"], "si:scout", "the si: prefix is added");
    assert_eq!(
        body["display_name"], "Scout",
        "display name defaults from the id"
    );
    assert_eq!(body["timezone"], "Europe/Berlin");

    // Later, from the saved request token: still pending…
    let output = env
        .cmd()
        .args(["silicon", "request", "status", "req-1", "--json"])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(stdout_json(&output)["status"], "pending");
    // …then accepted.
    env.cmd()
        .args(["silicon", "request", "status", "req-1", "--wait"])
        .assert()
        .success()
        .stdout(predicate::str::contains("accepted"))
        .stderr(predicate::str::contains(
            "accounts login --silicon si:scout",
        ));
}

#[test]
fn silicon_self_create_with_wait_signs_in_after_acceptance() {
    let mock = Mock::start_with(1);
    let env = Env::new();
    let output = env
        .cmd()
        .args([
            "--url",
            &mock.url,
            "silicon",
            "create",
            "--id",
            "si:scout",
            "--custodian",
            CARBON_EMAIL,
            "--wait",
            "--json",
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    // The STK was announced on stderr before waiting, so an interrupted wait can't lose it.
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("\"silicon_created\"") && stderr.contains(STK),
        "{stderr}"
    );
    let result = stdout_json(&output);
    assert_eq!(result["final_status"], "accepted");
    assert_eq!(result["signed_in"], true);
    env.cmd()
        .args(["whoami", "--json"])
        .assert()
        .success()
        .stdout(predicate::str::contains("\"si:scout\""));
}

#[test]
fn a_signed_in_carbon_creates_a_silicon_as_custodian() {
    let mock = Mock::start();
    let env = Env::new();
    env.cmd()
        .args(["--url", &mock.url, "login", "--email", CARBON_EMAIL])
        .assert()
        .success();
    env.cmd()
        .args(["login", "--email", CARBON_EMAIL, "--code", "123456"])
        .assert()
        .success();

    // Naming someone else as custodian while signed in as a Carbon is refused precisely.
    env.cmd()
        .args([
            "silicon",
            "create",
            "--id",
            "si:scout",
            "--custodian",
            "c:other",
        ])
        .assert()
        .code(2)
        .stderr(predicate::str::contains("--self-create"));

    let output = env
        .cmd()
        .args(["silicon", "create", "--id", "si:scout", "--json"])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let created = stdout_json(&output);
    assert_eq!(created["stk"], STK);
    assert_eq!(created["silicon"]["status"], "active");
    let sent = mock.requests("POST", "/v1/me/silicons");
    assert_eq!(sent[0].0.as_deref(), Some("Bearer at-carbon"));

    env.cmd()
        .args(["silicon", "create", "--id", "si:scout"])
        .assert()
        .success()
        .stdout(predicate::str::contains(
            "STK (shown once, store it now): stk-0123456789ab",
        ));

    // Silicon-only commands explain the mismatch.
    env.cmd()
        .args(["webhook", "test"])
        .assert()
        .code(3)
        .stderr(predicate::str::contains("for Silicon accounts"));
}

#[test]
fn app_import_waits_and_shows_first_errors() {
    let mock = Mock::start();
    let env = Env::new();
    let csv = env.path().join("users.csv");
    std::fs::write(
        &csv,
        "email,name\na@example.com,A\nsaket@example.com,Saket\n,Nobody\n",
    )
    .unwrap();
    let output = env
        .cmd()
        .args([
            "--url",
            &mock.url,
            "app",
            "--app-id",
            APP_ID,
            "--app-secret-stdin",
            "import",
        ])
        .arg(&csv)
        .args(["--default-country", "US", "--wait", "--json"])
        .write_stdin(APP_SECRET)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let job = stdout_json(&output);
    assert_eq!(job["status"], "completed");
    assert_eq!(job["counts"]["created"], 1);
    assert_eq!(
        job["first_errors"][0]["messages"][0]["code"],
        "missing_identifier"
    );
    let uploads = mock.requests("POST", "/v1/apps/briefcase/imports");
    assert!(
        uploads[0].1.starts_with("email,name"),
        "the CSV is sent as-is"
    );

    // Unknown extension without --format is a usage error before any upload.
    let odd = env.path().join("users.xlsx");
    std::fs::write(&odd, "x").unwrap();
    env.cmd()
        .args([
            "--url",
            &mock.url,
            "app",
            "--app-id",
            APP_ID,
            "--app-secret",
            APP_SECRET,
            "import",
        ])
        .arg(&odd)
        .assert()
        .code(2)
        .stderr(predicate::str::contains("--format"));
    assert_eq!(mock.count("POST", "/v1/apps/briefcase/imports"), 1);
}
