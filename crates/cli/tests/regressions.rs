//! Regressions the end-to-end suites found: `login` reusing a session that was revoked
//! elsewhere, a Silicon's webhook deliveries, a reader that closed stdout, argument errors in
//! JSON, report diagnostics, import exit codes and dry runs, and sign-in setup changes that change
//! nothing.

#![allow(clippy::unwrap_used)]

mod support;

use std::process::{Output, Stdio};

use predicates::prelude::*;
use serde_json::{Value, json};
use support::{APP_ID, APP_SECRET, CARBON_EMAIL, Env, Mock, STK, stdout_json};

fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

fn silicon_login(env: &Env, mock: &Mock, stk: &str, extra: &[&str]) -> Output {
    let mut args = vec![
        "--url",
        mock.url.as_str(),
        "login",
        "--silicon",
        "si:scout",
        "--stk-stdin",
        "--json",
    ];
    args.extend_from_slice(extra);
    env.cmd()
        .args(&args)
        .write_stdin(format!("{stk}\n"))
        .output()
        .unwrap()
}

fn carbon_login(env: &Env, mock: &Mock) {
    let base = ["--url", mock.url.as_str(), "login", "--email", CARBON_EMAIL];
    env.cmd().args(base).arg("--json").assert().success();
    env.cmd()
        .args(base)
        .args(["--code", "123456", "--json"])
        .assert()
        .success();
}

#[test]
fn login_checks_a_stored_session_before_reusing_it() {
    let mock = Mock::start();
    let (fresh, with_app, stale) = (Env::new(), Env::new(), Env::new());
    for env in [&fresh, &with_app, &stale] {
        let output = silicon_login(env, &mock, STK, &[]);
        assert!(output.status.success(), "{}", stderr(&output));
    }

    // Alive: reused after the service confirmed it (verified), no second sign-in.
    let logins = mock.count("POST", "/v1/silicons/login");
    let again = silicon_login(&fresh, &mock, STK, &[]);
    assert!(again.status.success(), "{}", stderr(&again));
    let json = stdout_json(&again);
    assert_eq!(json["authenticated"], true);
    assert_eq!(json["verified"], true);
    assert_eq!(json["reused"], true);
    assert_eq!(mock.count("POST", "/v1/silicons/login"), logins);

    // The custodian rotates the STK: every session from before is revoked.
    let rotated = "stk-00112233aabb";
    mock.rotate_stk(rotated);

    // The new STK, where a session from before the rotation is stored: a real sign-in.
    let output = silicon_login(&fresh, &mock, rotated, &[]);
    assert!(output.status.success(), "{}", stderr(&output));
    let json = stdout_json(&output);
    assert_eq!(json["authenticated"], true);
    assert_eq!(json["verified"], true);
    assert!(json.get("reused").is_none(), "{json}");
    assert_eq!(mock.count("POST", "/v1/silicons/login"), logins + 1);
    assert!(stderr(&output).is_empty() || !stderr(&output).contains("Already signed in"));
    let status = stdout_json(
        &fresh
            .cmd()
            .args(["login", "status", "--json"])
            .output()
            .unwrap(),
    );
    assert_eq!(status["authenticated"], true);
    assert_eq!(status["verified"], true);

    // …with --app: signs in and prints the token, not session_ended.
    let output = silicon_login(&with_app, &mock, rotated, &["--app", "remind"]);
    assert!(output.status.success(), "{}", stderr(&output));
    assert_eq!(stdout_json(&output)["slt"], "slt_test_token");

    // The old STK: refused, never "authenticated" on the strength of the dead stored session.
    let output = silicon_login(&stale, &mock, STK, &[]);
    assert_eq!(output.status.code(), Some(3), "{}", stderr(&output));
    assert_eq!(stdout_json(&output)["error"]["code"], "invalid_credentials");
}

#[test]
fn login_where_the_session_was_revoked_elsewhere_starts_a_new_sign_in() {
    let mock = Mock::start();
    let env = Env::new();
    carbon_login(&env, &mock);

    // Still alive: `accounts login` says so without a new sign-in.
    let output = env
        .cmd()
        .args(["login", "--no-browser", "--json"])
        .output()
        .unwrap();
    assert!(output.status.success(), "{}", stderr(&output));
    assert_eq!(stdout_json(&output)["reused"], true);
    assert_eq!(mock.count("POST", "/v1/device/authorize"), 0);

    // Revoked from another terminal: a device code is shown and the new sign-in completes.
    mock.revoke_carbon_session();
    let output = env
        .cmd()
        .args(["login", "--no-browser", "--json"])
        .output()
        .unwrap();
    assert!(output.status.success(), "{}", stderr(&output));
    assert!(
        stderr(&output).contains("\"event\":\"device_code\""),
        "{}",
        stderr(&output)
    );
    let json = stdout_json(&output);
    assert_eq!(json["authenticated"], true);
    assert_eq!(json["verified"], true);
    assert_eq!(mock.count("POST", "/v1/device/authorize"), 1);
    let status = env
        .cmd()
        .args(["login", "status", "--json"])
        .output()
        .unwrap();
    assert_eq!(status.status.code(), Some(0), "{}", stderr(&status));
}

#[test]
fn a_silicon_and_its_custodian_see_and_replay_its_webhook_deliveries() {
    let mock = Mock::start();
    let silicon = Env::new();
    assert!(silicon_login(&silicon, &mock, STK, &[]).status.success());

    // The tree has the commands.
    silicon
        .cmd()
        .args(["webhook", "--help"])
        .assert()
        .success()
        .stdout(predicate::str::contains("deliveries"))
        .stdout(predicate::str::contains("delivery"))
        .stdout(predicate::str::contains("replay"));

    let output = silicon
        .cmd()
        .args(["webhook", "deliveries", "--status", "failed", "--json"])
        .output()
        .unwrap();
    assert!(output.status.success(), "{}", stderr(&output));
    let page = stdout_json(&output);
    assert_eq!(page["items"][0]["id"], "d-1");
    assert_eq!(page["items"][0]["status"], "failed");
    // Timestamps and nulls come out as the API wrote them.
    assert_eq!(page["items"][0]["created_at"], "2026-10-03T12:00:00.000Z");
    assert_eq!(page["items"][0]["next_attempt_at"], Value::Null);
    assert_eq!(
        mock.queries("GET", "/v1/me/webhook/deliveries"),
        vec!["status=failed".to_owned()]
    );
    silicon
        .cmd()
        .args(["webhook", "deliveries"])
        .assert()
        .success()
        .stdout(predicate::str::contains("d-1"))
        .stdout(predicate::str::contains("silicon.updated"));

    silicon
        .cmd()
        .args(["webhook", "delivery", "d-1"])
        .assert()
        .success()
        .stdout(predicate::str::contains("HTTP 503"))
        .stdout(predicate::str::contains("\"type\": \"silicon.updated\""));

    // Replay every failed one: what is left and what is never replayed is said.
    let output = silicon
        .cmd()
        .args(["webhook", "replay", "--failed", "--json"])
        .output()
        .unwrap();
    assert!(output.status.success(), "{}", stderr(&output));
    let result = stdout_json(&output);
    assert_eq!(result["replayed"], json!(["d-1"]));
    assert_eq!(result["remaining"], 3);
    let sent: Value =
        serde_json::from_str(&mock.requests("POST", "/v1/me/webhook/replay")[0].1).unwrap();
    assert_eq!(sent, json!({ "status": "failed" }));
    silicon
        .cmd()
        .args(["webhook", "replay", "d-1", "d-pending"])
        .assert()
        .success()
        .stdout(predicate::str::contains("re-queued 1 deliveries"))
        .stdout(predicate::str::contains("1 already_pending"))
        .stdout(predicate::str::contains("test pings are never replayed"));
    // No ids and no --failed: a precise usage error naming what is missing.
    let output = silicon
        .cmd()
        .args(["webhook", "replay", "--json"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    let message = stdout_json(&output)["error"]["message"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(message.contains("<IDS>"), "{message}");

    // The custodian, for the Silicon.
    let custodian = Env::new();
    carbon_login(&custodian, &mock);
    let output = custodian
        .cmd()
        .args(["silicon", "webhook", "deliveries", "si:scout", "--json"])
        .output()
        .unwrap();
    assert!(output.status.success(), "{}", stderr(&output));
    let page = stdout_json(&output);
    assert_eq!(page["items"][0]["id"], "d-1");
    assert_eq!(page["next_cursor"], "c-2");
    custodian
        .cmd()
        .args(["silicon", "webhook", "delivery", "si:scout", "d-1"])
        .assert()
        .success()
        .stdout(predicate::str::contains("delivery"));
    let output = custodian
        .cmd()
        .args([
            "silicon",
            "webhook",
            "replay",
            "si:scout",
            "--failed",
            "--since",
            "2026-10-01T00:00:00Z",
            "--json",
        ])
        .output()
        .unwrap();
    assert!(output.status.success(), "{}", stderr(&output));
    let sent: Value =
        serde_json::from_str(&mock.requests("POST", "/v1/me/silicons/b9Z/webhook/replay")[0].1)
            .unwrap();
    assert_eq!(
        sent,
        json!({ "status": "failed", "since": "2026-10-01T00:00:00Z" })
    );
}

#[test]
fn a_reader_that_closed_stdout_never_makes_the_cli_panic() {
    let mock = Mock::start();
    let signed_in = Env::new();
    assert!(silicon_login(&signed_in, &mock, STK, &[]).status.success());
    let signed_out = Env::new();
    let cases: Vec<(&Env, Vec<&str>, i32)> = vec![
        (&signed_out, vec![], 0),
        (&signed_out, vec!["--json"], 0),
        (&signed_out, vec!["help", "--json"], 0),
        (&signed_out, vec!["docs", "silicons"], 0),
        (&signed_out, vec!["frobnicate", "--json"], 2),
        (&signed_out, vec!["whoami", "--json"], 3),
        (&signed_out, vec!["login", "status", "--json"], 1),
        (&signed_out, vec!["login", "status"], 1),
        (&signed_in, vec!["whoami"], 0),
        (&signed_in, vec!["login", "status", "--json"], 0),
        (&signed_in, vec!["login", "--app", "remind", "--json"], 0),
    ];
    for (env, args, code) in cases {
        // The reading end is closed before the CLI starts: its first write fails with EPIPE.
        let (reader, writer) = std::io::pipe().unwrap();
        drop(reader);
        let output = env
            .std_cmd()
            .args(&args)
            .stdout(writer)
            .stderr(Stdio::piped())
            .output()
            .unwrap();
        assert_eq!(
            output.status.code(),
            Some(code),
            "accounts {args:?}: {}",
            stderr(&output)
        );
        assert!(
            !stderr(&output).contains("panicked"),
            "accounts {args:?}: {}",
            stderr(&output)
        );
    }
}

#[test]
fn json_argument_errors_name_the_missing_argument() {
    let env = Env::new();
    let output = env
        .cmd()
        .args(["silicon", "create", "--json"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    let error = stdout_json(&output)["error"].clone();
    assert_eq!(error["code"], "invalid_arguments");
    assert_eq!(
        error["message"],
        "the following required arguments were not provided: --id <SI_ID>"
    );
    assert_eq!(error["details"]["arguments"], json!(["--id <SI_ID>"]));
    assert!(
        error["hint"]
            .as_str()
            .unwrap()
            .contains("Usage: accounts silicon create --id <SI_ID>"),
        "{error}"
    );

    let output = env
        .cmd()
        .args([
            "app",
            "proof",
            "app-verification",
            "--app-id",
            APP_ID,
            "--app-secret-stdin",
            "--json",
        ])
        .write_stdin(format!("{APP_SECRET}\n"))
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    let message = stdout_json(&output)["error"]["message"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(message.contains("--to <APP_ID>"), "{message}");
}

#[test]
fn report_diagnostics_never_make_a_message_too_long() {
    let mock = Mock::start();
    let env = Env::new();
    let typed = format!("edge {}", "e".repeat(9985));
    assert_eq!(typed.chars().count(), 9990);
    let output = env
        .cmd()
        .args(["--url", &mock.url, "report", "-", "--json"])
        .write_stdin(typed.clone())
        .output()
        .unwrap();
    assert!(output.status.success(), "{}", stderr(&output));
    assert_eq!(stdout_json(&output)["diagnostics_included"], false);
    let sent: Value = serde_json::from_str(&mock.requests("POST", "/v1/reports")[0].1).unwrap();
    assert_eq!(sent["message"], typed.as_str());

    // A short one carries them.
    let output = env
        .cmd()
        .args(["--url", &mock.url, "report", "login is slow", "--json"])
        .output()
        .unwrap();
    assert!(output.status.success(), "{}", stderr(&output));
    assert_eq!(stdout_json(&output)["diagnostics_included"], true);
    let sent: Value = serde_json::from_str(&mock.requests("POST", "/v1/reports")[1].1).unwrap();
    assert!(
        sent["message"]
            .as_str()
            .unwrap()
            .contains("\n\n--\naccounts CLI "),
        "{sent}"
    );

    // Over the limit as typed: refused before sending, with the typed length.
    let output = env
        .cmd()
        .args(["--url", &mock.url, "report", "-", "--json"])
        .write_stdin(format!("{typed}{}", "o".repeat(11)))
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    let message = stdout_json(&output)["error"]["message"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(
        message.contains("10000") && message.contains("10001"),
        "{message}"
    );
    assert_eq!(mock.count("POST", "/v1/reports"), 2);
}

#[test]
fn import_status_exits_1_for_a_failed_job_and_says_when_it_was_a_dry_run() {
    let mock = Mock::start();
    let env = Env::new();
    let app = [
        "--url",
        mock.url.as_str(),
        "app",
        "--app-id",
        APP_ID,
        "--app-secret",
        APP_SECRET,
    ];
    for wait in [true, false] {
        let mut args = app.to_vec();
        args.extend(["import", "status", "job-failed", "--json"]);
        if wait {
            args.push("--wait");
        }
        let output = env.cmd().args(&args).output().unwrap();
        assert_eq!(output.status.code(), Some(1), "{}", stderr(&output));
        assert_eq!(stdout_json(&output)["status"], "failed");
    }
    let mut args = app.to_vec();
    args.extend(["import", "status", "job-1", "--wait"]);
    env.cmd()
        .args(&args)
        .assert()
        .success()
        .stdout(predicate::str::contains(
            "Import job-1: completed (3/3 rows).\n",
        ))
        .stdout(predicate::str::contains("created "));

    let mut args = app.to_vec();
    args.extend(["import", "status", "job-dry"]);
    env.cmd()
        .args(&args)
        .assert()
        .success()
        .stdout(predicate::str::contains(
            "Import job-dry: completed (3/3 rows) as a dry run: nothing was written",
        ))
        .stdout(predicate::str::contains("would create"))
        .stderr(predicate::str::contains("without --dry-run"));
}

#[test]
fn a_sign_in_setup_change_that_changes_nothing_says_so() {
    let mock = Mock::start();
    let env = Env::new();
    let app = [
        "--url",
        mock.url.as_str(),
        "app",
        "--app-id",
        APP_ID,
        "--app-secret",
        APP_SECRET,
    ];
    let same = r#"{"redirect_uris":["http://127.0.0.1:8593/briefcase/callback"]}"#;
    let mut args = app.to_vec();
    args.extend(["config", "set", "-"]);
    env.cmd()
        .args(&args)
        .write_stdin(same)
        .assert()
        .success()
        .stdout(predicate::str::contains(
            "No change: briefcase already has these settings (the sign-in setup is still version 4).",
        ));
    let mut json_args = args.clone();
    json_args.push("--json");
    let output = env
        .cmd()
        .args(&json_args)
        .write_stdin(same)
        .output()
        .unwrap();
    assert_eq!(stdout_json(&output)["changed"], false);

    // A real change names the paths that changed, from the history.
    env.cmd()
        .args(&args)
        .write_stdin(
            r#"{"redirect_uris":["https://briefcase.example/callback"],"methods":{"email":true}}"#,
        )
        .assert()
        .success()
        .stdout(predicate::str::contains(
            "Updated briefcase (redirect_uris); the sign-in setup is now version 5.",
        ));

    // The history shows the owner's id, not the uuid.
    let mut args = app.to_vec();
    args.extend(["config", "history"]);
    env.cmd()
        .args(&args)
        .assert()
        .success()
        .stdout(predicate::str::contains("c:saket"))
        .stdout(predicate::str::contains("a8K").not());
}

#[test]
fn help_points_at_a_docs_topic_that_is_not_a_command() {
    let env = Env::new();
    env.cmd()
        .args(["help", "--help"])
        .assert()
        .success()
        .stdout(predicate::str::contains("accounts help imports"));
    env.cmd()
        .args(["help", "imports"])
        .assert()
        .success()
        .stdout(predicate::str::contains("# Imports").or(predicate::str::contains("import")));
    env.cmd()
        .args(["app", "users", "--help"])
        .assert()
        .success()
        .stdout(predicate::str::contains("imported or deleted"));
    env.cmd()
        .args(["app", "import", "rows", "--help"])
        .assert()
        .success()
        .stdout(predicate::str::contains("--level"))
        .stdout(predicate::str::contains("--code"));
}
