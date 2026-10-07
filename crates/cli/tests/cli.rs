//! `accounts` end to end against a mock of the Silicon Accounts API.

#![allow(clippy::unwrap_used)]

mod support;

use predicates::prelude::*;
use serde_json::{Value, json};
use support::{APP_ID, APP_SECRET, Env, Mock, STK, stdout_json};

#[test]
fn login_status_when_signed_out_is_exit_1_with_json() {
    let env = Env::new();
    let output = env
        .cmd()
        .args(["login", "status", "--json"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(stdout_json(&output), json!({ "authenticated": false }));

    // Human mode says so on stdout and suggests how to sign in.
    env.cmd()
        .args(["login", "status"])
        .assert()
        .code(1)
        .stdout(predicate::str::contains("Not signed in"))
        .stderr(predicate::str::contains("accounts login"));
}

#[test]
fn config_home_must_be_a_directory() {
    let env = Env::new();
    let file = env.path().join("not-a-dir");
    std::fs::write(&file, b"x").unwrap();

    env.cmd()
        .args(["config", "home"])
        .arg(&file)
        .assert()
        .code(2)
        .stderr(predicate::str::contains(format!(
            "not a directory: {}",
            file.display()
        )))
        .stderr(predicate::str::contains("hint:"));

    let output = env
        .cmd()
        .args(["config", "home", "--json"])
        .arg(env.path().join("missing"))
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    let json = stdout_json(&output);
    assert_eq!(json["error"]["code"], "not_a_directory");
    assert!(
        json["error"]["message"]
            .as_str()
            .unwrap()
            .starts_with("not a directory: ")
    );

    // A real directory works, is used by later commands, and can be reset.
    let target = tempfile::tempdir().unwrap();
    env.cmd()
        .args(["config", "home"])
        .arg(target.path())
        .assert()
        .success();
    let output = env
        .cmd()
        .args(["config", "get", "home", "--json"])
        .output()
        .unwrap();
    let json = stdout_json(&output);
    let expected = std::fs::canonicalize(target.path()).unwrap();
    assert_eq!(json["value"], expected.display().to_string());
    assert_eq!(json["source"], "config");
    env.cmd()
        .args(["config", "home", "--reset"])
        .assert()
        .success();
    let json = stdout_json(
        &env.cmd()
            .args(["config", "get", "home", "--json"])
            .output()
            .unwrap(),
    );
    assert_eq!(json["source"], "default");

    // SILICON_HOME pointing at a file is reported the same way by any command.
    env.cmd()
        .env("SILICON_HOME", &file)
        .args(["login", "status"])
        .assert()
        .code(2)
        .stderr(predicate::str::contains("not a directory:"))
        .stderr(predicate::str::contains("SILICON_HOME"));
}

#[test]
fn help_is_a_traversable_tree() {
    let env = Env::new();
    let output = env.cmd().arg("--help").output().unwrap();
    assert!(output.status.success());
    let text = String::from_utf8(output.stdout).unwrap();
    for needle in [
        "Command tree",
        "login status",
        "silicon create",
        "silicon request status <REQUEST_ID>",
        "app proof verify <TOKEN>",
        "app import status <JOB>",
        "config home [DIR]",
        "report <MESSAGE>",
        "Exit codes:",
        "getting-started",
        "https://github.com/teamofsilicons/silicon-accounts",
    ] {
        assert!(text.contains(needle), "root --help lacks `{needle}`");
    }
    for banned in [
        "human",
        "organization",
        "organisation",
        "frontend",
        "backend",
    ] {
        assert!(
            !text.to_lowercase().contains(banned),
            "help uses `{banned}`"
        );
    }

    // Every command in the tree has its own help, and leaf commands with examples show them.
    let tree = stdout_json(&env.cmd().args(["help", "--json"]).output().unwrap());
    let commands = tree["commands"].as_array().unwrap();
    assert!(
        commands.len() > 80,
        "only {} commands in the tree",
        commands.len()
    );
    for entry in commands {
        let command = entry["command"].as_str().unwrap();
        let args: Vec<&str> = command
            .split_whitespace()
            .skip(1)
            .filter(|w| !w.starts_with('<') && !w.starts_with('['))
            .collect();
        let output = env.cmd().args(&args).arg("--help").output().unwrap();
        assert!(output.status.success(), "`{command} --help` failed");
        assert!(
            !entry["about"].as_str().unwrap().is_empty(),
            "`{command}` has no description"
        );
    }
    env.cmd()
        .args(["login", "--help"])
        .assert()
        .success()
        .stdout(predicate::str::contains("Examples:"))
        .stdout(predicate::str::contains("--stk-stdin"));
    env.cmd()
        .args(["help", "silicon", "create"])
        .assert()
        .success()
        .stdout(predicate::str::contains("--custodian"));
    env.cmd()
        .args(["help", "imports"])
        .assert()
        .success()
        .stdout(predicate::str::contains("# Importing"));
    env.cmd()
        .args(["help", "proofs"])
        .assert()
        .success()
        .stdout(predicate::str::contains("accounts docs proofs"));
    env.cmd()
        .args(["docs", "silicons"])
        .assert()
        .success()
        .stdout(predicate::str::contains("custodian"));
    env.cmd()
        .args(["docs", "nope"])
        .assert()
        .code(4)
        .stderr(predicate::str::contains("Topics:"));
    // A group without its subcommand prints its help.
    env.cmd()
        .arg("silicon")
        .assert()
        .code(2)
        .stderr(predicate::str::contains("rotate-stk"));
    env.cmd()
        .arg("--version")
        .assert()
        .success()
        .stdout(predicate::str::contains(env!("CARGO_PKG_VERSION")));
}

#[test]
fn silicon_login_whoami_slt_and_logout() {
    let mock = Mock::start();
    let env = Env::new();

    let output = env
        .cmd()
        .args([
            "--url",
            &mock.url,
            "login",
            "--silicon",
            "si:scout",
            "--stk-stdin",
            "--json",
        ])
        .write_stdin(format!("{STK}\n"))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "login failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let json = stdout_json(&output);
    assert_eq!(json["authenticated"], true);
    assert_eq!(json["kind"], "silicon");
    assert_eq!(json["id"], "si:scout");
    assert_eq!(json["uuid"], "b9Z");

    // The session is stored privately and remembers its URL.
    let session_path = env.state_file("session.json");
    let session: Value = serde_json::from_slice(&std::fs::read(&session_path).unwrap()).unwrap();
    assert_eq!(session["access_token"], "at-1");
    assert_eq!(session["url"], mock.url);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&session_path)
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600, "session.json must be private");
    }

    // Later commands use the session's URL without --url.
    let output = env.cmd().args(["whoami", "--json"]).output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let me = stdout_json(&output);
    assert_eq!(me["uuid"], "b9Z");
    assert_eq!(me["custodian"]["id"], "c:saket");
    env.cmd()
        .arg("whoami")
        .assert()
        .success()
        .stdout(predicate::str::contains("si:scout · Scout (Silicon)"))
        .stdout(predicate::str::contains("c:saket (Saket)"));

    let status = stdout_json(
        &env.cmd()
            .args(["login", "status", "--json"])
            .output()
            .unwrap(),
    );
    assert_eq!(status["authenticated"], true);
    assert_eq!(status["verified"], true);
    assert_eq!(status["id"], "si:scout");

    // Already signed in: --app returns a short-lived token directly, without a new login.
    let logins_before = mock.count("POST", "/v1/silicons/login");
    let output = env
        .cmd()
        .args(["login", "--app", "remind", "--json"])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let slt = stdout_json(&output);
    assert_eq!(slt["slt"], "slt_test_token");
    assert_eq!(slt["app_id"], "remind");
    assert_eq!(mock.count("POST", "/v1/silicons/login"), logins_before);
    // Human mode prints just the token on stdout, so `$(accounts login --app remind)` works.
    env.cmd()
        .args(["login", "--app", "remind", "-q"])
        .assert()
        .success()
        .stdout("slt_test_token\n");

    env.cmd()
        .args(["logout", "--json"])
        .assert()
        .success()
        .stdout(predicate::str::contains("\"signed_out\": true"));
    assert!(!session_path.exists());
    assert_eq!(mock.count("POST", "/v1/oauth/revoke"), 1);
    env.cmd()
        .args(["--url", &mock.url, "login", "status", "--json"])
        .assert()
        .code(1);
}

#[test]
fn wrong_stk_is_a_precise_auth_error() {
    let mock = Mock::start();
    let env = Env::new();
    let output = env
        .cmd()
        .args([
            "--url",
            &mock.url,
            "login",
            "--silicon",
            "si:scout",
            "--stk-stdin",
            "--json",
        ])
        .write_stdin("stk-ffffffffffff")
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(3));
    let json = stdout_json(&output);
    assert_eq!(json["error"]["code"], "invalid_credentials");
    assert_eq!(json["error"]["status"], 401);
    assert_eq!(json["error"]["request_id"], "req-test-1");
    assert!(json["error"]["hint"].as_str().unwrap().contains("rotate"));

    // A malformed STK never leaves the machine.
    env.cmd()
        .args([
            "--url",
            &mock.url,
            "login",
            "--silicon",
            "si:scout",
            "--stk-stdin",
        ])
        .write_stdin("not-hex")
        .assert()
        .code(2)
        .stderr(predicate::str::contains("error: That STK is not valid"))
        .stderr(predicate::str::contains("hint:"));
    assert_eq!(mock.count("POST", "/v1/silicons/login"), 1);
}

#[test]
fn expiring_sessions_refresh_automatically_and_dead_ones_say_so() {
    let mock = Mock::start();
    let env = Env::new();
    let session = json!({
        "url": mock.url, "access_token": "at-old", "refresh_token": "sar_1",
        "expires_at": "2020-01-01T00:00:00Z", "refresh_expires_at": "2099-01-01T00:00:00Z",
        "kind": "silicon", "account": { "uuid": "b9Z", "id": "si:scout", "display_name": "Scout" },
        "signed_in_at": "2020-01-01T00:00:00Z", "method": "silicon_stk"
    });
    std::fs::create_dir_all(env.path().join(".accounts")).unwrap();
    std::fs::write(
        env.state_file("session.json"),
        serde_json::to_vec(&session).unwrap(),
    )
    .unwrap();

    let output = env.cmd().args(["whoami", "--json"]).output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(mock.count("POST", "/v1/oauth/token"), 1);
    let stored: Value =
        serde_json::from_slice(&std::fs::read(env.state_file("session.json")).unwrap()).unwrap();
    assert_eq!(stored["access_token"], "at-2");
    assert_eq!(stored["refresh_token"], "sar_2");

    // Revoked elsewhere: the refresh token is refused, the session is cleared, the error says why.
    let mut dead = session.clone();
    dead["refresh_token"] = json!("sar_revoked");
    std::fs::write(
        env.state_file("session.json"),
        serde_json::to_vec(&dead).unwrap(),
    )
    .unwrap();
    let output = env.cmd().args(["whoami", "--json"]).output().unwrap();
    assert_eq!(output.status.code(), Some(3));
    let json = stdout_json(&output);
    assert_eq!(json["error"]["code"], "session_ended");
    assert!(
        json["error"]["message"]
            .as_str()
            .unwrap()
            .contains("already used")
    );
    assert!(!env.state_file("session.json").exists());
}

#[test]
fn proof_verify_exit_codes() {
    let mock = Mock::start();
    let env = Env::new();
    let base = [
        "--url",
        mock.url.as_str(),
        "app",
        "--app-id",
        APP_ID,
        "--app-secret-stdin",
        "proof",
        "verify",
    ];

    let output = env
        .cmd()
        .args(base)
        .args(["sap_valid", "--json"])
        .write_stdin(APP_SECRET)
        .output()
        .unwrap();
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let json = stdout_json(&output);
    assert_eq!(json["valid"], true);
    assert_eq!(json["issuing_app"]["app_id"], "dm");
    assert_eq!(json["user"]["membership_id"], "dm:a8K");

    let output = env
        .cmd()
        .args(base)
        .args(["sap_expired", "--json"])
        .write_stdin(APP_SECRET)
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    assert_eq!(
        stdout_json(&output),
        json!({ "valid": false, "expires_at": null })
    );

    env.cmd()
        .args(base)
        .arg("sap_valid")
        .write_stdin(APP_SECRET)
        .assert()
        .success()
        .stdout(predicate::str::contains(
            "valid: OBO proof from dm for briefcase",
        ));

    // Wrong app credentials are an auth error (3), not "invalid proof".
    let output = env
        .cmd()
        .args(base)
        .args(["sap_valid", "--json"])
        .write_stdin("sa_app_wrong")
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(3));
    assert_eq!(stdout_json(&output)["error"]["code"], "invalid_client");

    // Env credentials work too.
    env.cmd()
        .env("ACCOUNTS_APP_ID", APP_ID)
        .env("ACCOUNTS_APP_SECRET", APP_SECRET)
        .args(["--url", &mock.url, "app", "proof", "verify", "sap_valid"])
        .assert()
        .success();

    // No app at all: a precise usage error.
    env.cmd()
        .args(["--url", &mock.url, "app", "proof", "verify", "sap_valid"])
        .assert()
        .code(2)
        .stderr(predicate::str::contains("No app selected"));
}

#[test]
fn a_pkce_verifier_may_start_with_a_hyphen() {
    // PKCE verifiers are random base64url: one in 64 starts with "-", and it is still the value.
    let mock = Mock::start();
    let env = Env::new();
    let verifier = "-nVb8kQ2xZ_example-verifier-with-a-leading-hyphen-0123456789";
    let output = env
        .cmd()
        .args([
            "--url",
            mock.url.as_str(),
            "app",
            "--app-id",
            APP_ID,
            "--app-secret-stdin",
            "token",
            "exchange",
            "--code",
            "sac_good",
            "--redirect-uri",
            "http://127.0.0.1:8593/briefcase/callback",
            "--code-verifier",
            verifier,
            "--json",
        ])
        .write_stdin(APP_SECRET)
        .output()
        .unwrap();
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(stdout_json(&output)["refresh_token"].is_string());
    let sent = mock.requests("POST", "/v1/oauth/token");
    assert!(
        sent.iter()
            .any(|(_, body)| body.contains(&format!("code_verifier={verifier}"))),
        "{sent:?}"
    );
}

#[test]
fn id_availability_and_report() {
    let mock = Mock::start();
    let env = Env::new();
    env.cmd()
        .args(["--url", &mock.url, "id", "available", "c:free"])
        .assert()
        .success()
        .stdout(predicate::str::contains("c:free is available"));
    let output = env
        .cmd()
        .args(["--url", &mock.url, "id", "available", "c:taken", "--json"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(5));
    assert_eq!(stdout_json(&output)["reason"], "taken");
    env.cmd()
        .args(["--url", &mock.url, "id", "available", "c:has space"])
        .assert()
        .code(2);

    let output = env
        .cmd()
        .args(["--url", &mock.url, "report", "login --app fails", "--json"])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let json = stdout_json(&output);
    assert_eq!(json["report_id"], "rep-1");
    assert_eq!(json["recipients"], 3);
    env.cmd()
        .args(["--url", &mock.url, "report", "something broke"])
        .assert()
        .success()
        .stdout(predicate::str::contains(
            "You can also open a PR at https://github.com/teamofsilicons/silicon-accounts",
        ));
    env.cmd()
        .args([
            "--url",
            &mock.url,
            "report",
            "fixed it",
            "--pr",
            "http://insecure.example/pr/1",
        ])
        .assert()
        .code(2)
        .stderr(predicate::str::contains("not an https URL"));
}

#[test]
fn telemetry_is_sent_unless_opted_out() {
    let mock = Mock::start();
    let env = Env::new();
    // Opted out (the default for these tests): nothing is sent.
    env.cmd()
        .args(["--url", &mock.url, "id", "available", "c:free"])
        .assert()
        .success();
    assert!(mock.telemetry().is_empty());

    // Opted in: one self-contained event per command, with source, step and progress.
    env.cmd()
        .env("ACCOUNTS_TELEMETRY", "1")
        .args(["--url", &mock.url, "id", "available", "c:free"])
        .assert()
        .success();
    let batches = mock.telemetry();
    assert_eq!(batches.len(), 1);
    let event = &batches[0]["events"][0];
    assert_eq!(event["source"], "cli");
    assert_eq!(event["name"], "cli.command");
    assert_eq!(event["step"], "id available");
    assert_eq!(event["progress"], 1.0);
    assert_eq!(event["data"]["outcome"], "ok");
    assert!(
        !event.to_string().contains("c:free"),
        "telemetry must not carry ids"
    );

    // `accounts config telemetry off` is respected without the env var.
    let env2 = Env::new();
    env2.cmd()
        .env_remove("ACCOUNTS_TELEMETRY")
        .args(["config", "telemetry", "off"])
        .assert()
        .success();
    env2.cmd()
        .env_remove("ACCOUNTS_TELEMETRY")
        .args(["--url", &mock.url, "id", "available", "c:free"])
        .assert()
        .success();
    assert_eq!(mock.telemetry().len(), 1);
}

#[test]
fn bad_arguments_are_usage_errors_also_in_json() {
    let env = Env::new();
    env.cmd()
        .args(["login", "--frobnicate"])
        .assert()
        .code(2)
        .stderr(predicate::str::contains("--frobnicate"));
    let output = env
        .cmd()
        .args(["login", "--frobnicate", "--json"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    assert_eq!(stdout_json(&output)["error"]["code"], "invalid_arguments");
    env.cmd()
        .args(["login", "--stk", "stk-0123456789ab"])
        .assert()
        .code(2)
        .stderr(predicate::str::contains("--silicon"));
}

#[test]
fn app_use_stores_credentials_for_later_commands() {
    let mock = Mock::start();
    let env = Env::new();
    // A wrong secret is rejected and nothing is stored.
    env.cmd()
        .args(["--url", &mock.url, "app", "use", APP_ID, "--secret-stdin"])
        .write_stdin("sa_app_wrong")
        .assert()
        .code(3);
    assert!(!env.state_file("apps/briefcase.json").exists());

    env.cmd()
        .args(["--url", &mock.url, "app", "use", APP_ID, "--secret-stdin"])
        .write_stdin(APP_SECRET)
        .assert()
        .success()
        .stdout(predicate::str::contains(
            "Using briefcase (Briefcase) with its app secret",
        ));
    let stored = env.state_file("apps/briefcase.json");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&stored).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    // Later commands need neither the app id nor the secret.
    env.cmd()
        .args(["--url", &mock.url, "app", "proof", "verify", "sap_valid"])
        .assert()
        .success();
    let output = env
        .cmd()
        .args(["--url", &mock.url, "app", "show", "--json"])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let json = stdout_json(&output);
    assert_eq!(json["config_version"], 4);
    assert!(
        json["acting_as"]
            .as_str()
            .unwrap()
            .contains("app credentials")
    );
    env.cmd()
        .args(["--url", &mock.url, "app", "show"])
        .assert()
        .success()
        .stdout(predicate::str::contains("google, email"))
        .stdout(predicate::str::contains("acting as"));
}

#[test]
fn ata_proofs_are_for_exactly_one_app() {
    let mock = Mock::start();
    let env = Env::new();
    let base = [
        "--url",
        mock.url.as_str(),
        "app",
        "--app-id",
        APP_ID,
        "--app-secret-stdin",
        "proof",
        "ata",
    ];
    let output = env
        .cmd()
        .args(base)
        .args(["--to", "remind", "--scope", "notifications.send", "--json"])
        .write_stdin(APP_SECRET)
        .output()
        .unwrap();
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let json = stdout_json(&output);
    assert_eq!(json["kind"], "ata");
    assert_eq!(json["receiving_app"], "remind");
    assert_eq!(json["issuing_app"], APP_ID);
    assert!(
        json.get("user").is_some_and(Value::is_null),
        "--json keeps the API's \"user\": null: {json}"
    );
    let sent = mock.requests("POST", "/v1/proofs/ata");
    assert_eq!(sent.len(), 1);
    let body: Value = serde_json::from_str(&sent[0].1).unwrap();
    assert_eq!(
        body,
        json!({"receiving_app": "remind", "scopes": ["notifications.send"]})
    );

    // Several apps: refused before anything is sent, with one command per app as the fix.
    for several in ["remind,waveform", "remind waveform"] {
        let output = env
            .cmd()
            .args(base)
            .args(["--to", several, "--json"])
            .write_stdin(APP_SECRET)
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(2), "{several}");
        let json = stdout_json(&output);
        let message = json["error"]["message"].as_str().unwrap();
        assert!(message.contains("exactly one app"), "{message}");
        let hint = json["error"]["hint"].as_str().unwrap();
        assert!(
            hint.contains("accounts app proof ata --to remind")
                && hint.contains("accounts app proof ata --to waveform"),
            "{hint}"
        );
    }
    assert_eq!(mock.count("POST", "/v1/proofs/ata"), 1);

    env.cmd()
        .args(base)
        .args(["--to", "remind"])
        .write_stdin(APP_SECRET)
        .assert()
        .success()
        .stdout(predicate::str::contains(
            "ATA proof p-ata from briefcase for remind",
        ));
}
