//! What the CLI reports in telemetry is what the service forwards as written: Silicon Accounts
//! forwards a command path, an OS or an architecture only when it is in its word lists
//! (crates/server/src/routes/telemetry/lists.rs, included here as it is), and anything else as
//! `other`. Every command of this CLI, and the platform it was built for, must be listed.

#![allow(clippy::unwrap_used)]

#[path = "../../server/src/routes/telemetry/lists.rs"]
#[allow(dead_code)]
mod lists;

mod support;

use support::{Env, stdout_json};

/// `silicon-accounts app webhook set <APP_ID> [URL]` → `app webhook set`.
fn command_path(usage: &str) -> String {
    usage
        .split_whitespace()
        .skip(1)
        .take_while(|w| !w.starts_with('<') && !w.starts_with('['))
        .collect::<Vec<_>>()
        .join(" ")
}

#[test]
fn every_command_path_is_forwarded_as_written() {
    let env = Env::new();
    let output = env.cmd().arg("--json").output().unwrap();
    assert_eq!(output.status.code(), Some(0));
    let tree = stdout_json(&output);
    let paths: Vec<String> = tree["commands"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| command_path(c["command"].as_str().unwrap()))
        .collect();
    assert!(paths.len() > 100, "{paths:?}");
    assert!(paths.iter().any(|p| p == "app webhook set"), "{paths:?}");
    let missing: Vec<&String> = paths
        .iter()
        .filter(|p| !lists::COMMANDS.contains(&p.as_str()))
        .collect();
    assert!(
        missing.is_empty(),
        "command paths missing from crates/server/src/routes/telemetry/lists.rs (COMMANDS), so \
         telemetry would forward them as `other`: {missing:?}"
    );
}

#[test]
fn this_platform_is_forwarded_as_written() {
    assert!(
        lists::OS.contains(&std::env::consts::OS),
        "{}",
        std::env::consts::OS
    );
    assert!(
        lists::ARCH.contains(&std::env::consts::ARCH),
        "{}",
        std::env::consts::ARCH
    );
    assert!(lists::SOURCES.contains(&"cli"));
    assert!(lists::NAMES.contains(&"cli.step") && lists::NAMES.contains(&"cli.command"));
}
