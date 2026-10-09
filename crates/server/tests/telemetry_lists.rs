//! The word lists client telemetry is forwarded with (`routes::telemetry::lists`) stay complete:
//! every error code the service, the Rust client and the CLI can give, and every step name the
//! CLI reports, is listed, so the CLI's own words are never forwarded as `other`. (The CLI's
//! command paths are checked by the CLI's tests, which can read its command tree.)

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use accounts_server::routes::telemetry::lists;

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

/// The source of every `.rs` file under `crates/<name>/src`, with its path.
fn sources(crate_name: &str) -> Vec<(PathBuf, String)> {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join(crate_name)
        .join("src");
    let mut files = Vec::new();
    rust_files(&dir, &mut files);
    files.sort();
    files
        .into_iter()
        .map(|p| {
            let text = std::fs::read_to_string(&p).expect("source");
            (p, text)
        })
        .collect()
}

/// The string literal at the start of `rest` (after whitespace), if there is one.
fn literal(rest: &str) -> Option<&str> {
    let rest = rest.trim_start().strip_prefix('"')?;
    rest.find('"').map(|end| &rest[..end])
}

/// The first string literal argument of every call that starts with `call`, also when it comes
/// second after a plain path (`ApiError::new(StatusCode::CONFLICT, "id_taken", …)`).
fn first_literals<'a>(text: &'a str, call: &str, out: &mut Vec<&'a str>) {
    for (at, _) in text.match_indices(call) {
        let rest = &text[at + call.len()..];
        if let Some(code) = literal(rest) {
            out.push(code);
            continue;
        }
        let trimmed = rest.trim_start();
        let path_len = trimmed
            .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == ':'))
            .unwrap_or(trimmed.len());
        if path_len > 0
            && let Some(after) = trimmed[path_len..].trim_start().strip_prefix(',')
            && let Some(code) = literal(after)
        {
            out.push(code);
        }
    }
}

/// Every string literal in the body of each `fn code(` in `text`.
fn code_fn_literals<'a>(text: &'a str, out: &mut Vec<&'a str>) {
    for (at, _) in text.match_indices("fn code(") {
        let Some(open) = text[at..].find('{').map(|i| at + i) else {
            continue;
        };
        let mut depth = 0usize;
        let mut end = open;
        for (i, c) in text[open..].char_indices() {
            match c {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        end = open + i;
                        break;
                    }
                }
                _ => {}
            }
        }
        let body = &text[open..end];
        let mut parts = body.split('"');
        parts.next();
        while let (Some(inside), Some(_)) = (parts.next(), parts.next()) {
            out.push(inside);
        }
    }
}

/// `^[a-z][a-z0-9_]*$`: what an error code looks like (other literals are something else).
fn is_code(c: &str) -> bool {
    c.bytes().next().is_some_and(|b| b.is_ascii_lowercase())
        && c.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

const SERVICE_CRATES: &[&str] = &[
    "core", "auth", "oauth", "account", "silicons", "apps", "proofs", "worker", "server",
];

const CONSTRUCTORS: &[&str] = &[
    "ApiError::new(",
    "ApiError::bad_request(",
    "ApiError::unauthenticated(",
    "ApiError::forbidden(",
    "ApiError::not_found(",
    "ApiError::conflict(",
    "ApiError::gone(",
    "ApiError::unprocessable(",
    "ApiError::locked(",
    "ApiError::unavailable(",
    "OAuthError::new(",
    "CliError::new(",
    "Self::new(",
];

/// The error codes written as literals: the service's errors, the Rust client's
/// (`Error::code`) and the CLI's.
fn error_codes_in_the_source() -> BTreeSet<String> {
    let mut found = BTreeSet::new();
    for name in SERVICE_CRATES.iter().chain(&["client", "cli"]) {
        for (path, text) in sources(name) {
            let mut codes = Vec::new();
            for call in CONSTRUCTORS {
                first_literals(&text, call, &mut codes);
            }
            first_literals(&text, ".code = ", &mut codes);
            if *name == "client" && path.ends_with("error.rs") {
                code_fn_literals(&text, &mut codes);
            }
            found.extend(codes.into_iter().filter(|c| is_code(c)).map(str::to_owned));
        }
    }
    found
}

#[test]
fn every_error_code_is_listed() {
    let codes = error_codes_in_the_source();
    assert!(codes.len() > 200, "the scan found only {codes:?}");
    for known in [
        "id_taken",
        "invalid_grant",
        "token_expired",
        "file_not_found",
        "io_error",
    ] {
        assert!(codes.contains(known), "the scan missed {known}");
    }
    let missing: Vec<&String> = codes
        .iter()
        .filter(|c| !lists::ERROR_CODES.contains(&c.as_str()))
        .collect();
    assert!(
        missing.is_empty(),
        "error codes missing from crates/server/src/routes/telemetry/lists.rs (ERROR_CODES), so \
         telemetry would forward them as `other`: {missing:?}"
    );
}

#[test]
fn every_cli_step_is_listed() {
    let mut steps = BTreeSet::new();
    for (_, text) in sources("cli") {
        let mut found = Vec::new();
        first_literals(&text, ".step(", &mut found);
        steps.extend(found.into_iter().map(str::to_owned));
    }
    assert!(steps.contains("login.slt.issued"), "{steps:?}");
    let missing: Vec<&String> = steps
        .iter()
        .filter(|s| !lists::STEPS.contains(&s.as_str()))
        .collect();
    assert!(
        missing.is_empty(),
        "CLI steps missing from crates/server/src/routes/telemetry/lists.rs (STEPS): {missing:?}"
    );
}

#[test]
fn the_lists_are_sorted_words_without_duplicates() {
    for (name, list) in [
        ("STEPS", lists::STEPS),
        ("COMMANDS", lists::COMMANDS),
        ("ERROR_CODES", lists::ERROR_CODES),
    ] {
        let mut sorted = list.to_vec();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted, list, "{name} must be sorted, each word once");
        assert!(!list.contains(&"other"), "{name} can't list `other`");
    }
}
