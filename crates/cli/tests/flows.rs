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

/// A file over the 50 MB import limit gets the precise refusal (exit 2, payload_too_large,
/// the limit and how to split) and is never uploaded. Uploading it anyway raced with the
/// service's early 413: through the site's proxy the CLI got a reset connection or an
/// HTTP 500 instead of the refusal.
#[test]
fn app_import_refuses_files_over_50_mb_before_sending_anything() {
    const LIMIT: u64 = 50 * 1024 * 1024;
    let mock = Mock::start();
    let env = Env::new();
    let import = |file: &std::path::Path, extra: &[&str]| {
        let mut cmd = env.cmd();
        cmd.args([
            "--url",
            &mock.url,
            "app",
            "--app-id",
            APP_ID,
            "--app-secret",
            APP_SECRET,
            "import",
        ])
        .arg(file)
        .args(extra);
        cmd
    };

    // A 51 MB CSV, refused from its size on disk.
    let big = env.path().join("big.csv");
    std::fs::write(&big, b"email,display_name\n").unwrap();
    std::fs::OpenOptions::new()
        .write(true)
        .open(&big)
        .unwrap()
        .set_len(51 * 1024 * 1024)
        .unwrap();
    let output = import(&big, &["--dry-run", "--json"]).output().unwrap();
    assert_eq!(
        output.status.code(),
        Some(2),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let error = stdout_json(&output)["error"].clone();
    assert_eq!(error["code"], "payload_too_large", "{error}");
    assert_eq!(error["exit_code"], 2);
    let message = error["message"].as_str().unwrap();
    assert!(
        message.starts_with("The import is over the 50 MB limit: ")
            && message.contains("big.csv is 53477376 bytes (51.0 MB), and one import accepts at most 52428800 bytes, so it was not uploaded."),
        "{message}"
    );
    assert!(
        error["hint"]
            .as_str()
            .unwrap()
            .contains("files of at most 50 MB and 100,000 rows each"),
        "{error}"
    );
    assert_eq!(error["details"]["size_bytes"], 51 * 1024 * 1024);
    assert_eq!(error["details"]["limit_bytes"], LIMIT);
    assert!(error.get("status").is_none(), "nothing was sent: {error}");

    // Text mode: the error and the hint on stderr, nothing on stdout.
    let output = import(&big, &[]).output().unwrap();
    assert_eq!(output.status.code(), Some(2));
    assert!(output.stdout.is_empty());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("error: The import is over the 50 MB limit: ")
            && stderr.contains("hint: Split it into files of at most 50 MB and 100,000 rows each"),
        "{stderr}"
    );

    // From stdin: refused as soon as more than 50 MB came in.
    let mut piped = b"email,display_name\n".to_vec();
    piped.resize(usize::try_from(LIMIT).unwrap() + 4096, b'a');
    let output = import(std::path::Path::new("-"), &["--json"])
        .write_stdin(piped)
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    let error = stdout_json(&output)["error"].clone();
    assert_eq!(error["code"], "payload_too_large", "{error}");
    assert!(
        error["message"]
            .as_str()
            .unwrap()
            .contains("the CSV on stdin carries more than the 52428800 bytes one import accepts"),
        "{error}"
    );

    // JSON is re-encoded before it is sent, so the encoded body is what counts: 51 rows of
    // 1 MB each, refused by the client package.
    let rows: Vec<Value> = (0..51)
        .map(|i| {
            serde_json::json!({ "email": format!("u{i}@example.com"), "display_name": "x".repeat(1024 * 1024) })
        })
        .collect();
    let json_file = env.path().join("big.json");
    std::fs::write(&json_file, serde_json::to_vec(&rows).unwrap()).unwrap();
    let output = import(&json_file, &["--json"]).output().unwrap();
    assert_eq!(
        output.status.code(),
        Some(2),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let error = stdout_json(&output)["error"].clone();
    assert_eq!(error["code"], "payload_too_large", "{error}");
    assert!(
        error["message"]
            .as_str()
            .unwrap()
            .starts_with("The import is over the 50 MB limit: its JSON body (51 rows) is "),
        "{error}"
    );
    assert_eq!(error["details"]["limit_bytes"], LIMIT);
    assert!(error["details"]["size_bytes"].as_u64().unwrap() > LIMIT);

    assert_eq!(
        mock.count("POST", "/v1/apps/briefcase/imports"),
        0,
        "no import was uploaded"
    );
}

#[test]
fn a_custodian_checks_an_id_for_its_silicon() {
    let mock = Mock::start();
    let env = Env::new();
    // Not signed in: the CLI says what is needed before calling anything.
    let output = env
        .cmd()
        .args([
            "--url",
            &mock.url,
            "id",
            "available",
            "si:old",
            "--for",
            "si:scout",
            "--json",
        ])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(3), "auth required");

    env.cmd()
        .args(["--url", &mock.url, "login", "--email", CARBON_EMAIL])
        .assert()
        .success();
    env.cmd()
        .args([
            "--url",
            &mock.url,
            "login",
            "--email",
            CARBON_EMAIL,
            "--code",
            "123456",
        ])
        .assert()
        .success();
    let output = env
        .cmd()
        .args([
            "--url",
            &mock.url,
            "id",
            "available",
            "si:old",
            "--for",
            "si:scout",
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
    assert_eq!(json["available"], true);
    assert_eq!(json["reclaimable"], true);
    env.cmd()
        .args([
            "--url",
            &mock.url,
            "id",
            "available",
            "si:old",
            "--for",
            "si:scout",
        ])
        .assert()
        .success()
        .stdout(predicate::str::contains(
            "accounts silicon id si:scout si:old",
        ));
    // Someone else's Silicon: not found (exit 4).
    env.cmd()
        .args([
            "--url",
            &mock.url,
            "id",
            "available",
            "si:old",
            "--for",
            "si:other",
        ])
        .assert()
        .code(4)
        .stderr(
            predicate::str::contains("silicon_not_found")
                .or(predicate::str::contains("not the custodian")),
        );
}
