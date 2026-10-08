//! Small helpers: prompts, stdin, durations, browser, host labels.

use std::io::{BufRead, IsTerminal, Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Duration;

use crate::error::{CliError, CliResult};

/// True when we can ask the person at the keyboard (stdin and stderr are terminals and
/// output is not JSON).
pub fn interactive(json: bool) -> bool {
    !json && std::io::stdin().is_terminal() && std::io::stderr().is_terminal()
}

/// Asks a question on stderr and reads one line from stdin.
pub fn prompt(question: &str) -> CliResult<String> {
    let mut err = std::io::stderr();
    let _ = write!(err, "{question}");
    let _ = err.flush();
    let mut line = String::new();
    std::io::stdin().lock().read_line(&mut line).map_err(|e| {
        CliError::new(
            1,
            "io_error",
            format!("Could not read your answer: {e}."),
            "Retry, or pass the value as a flag.",
        )
    })?;
    Ok(line.trim().to_owned())
}

/// Asks for a secret without echoing it.
pub fn prompt_secret(question: &str) -> CliResult<String> {
    rpassword::prompt_password(question)
        .map(|s| s.trim().to_owned())
        .map_err(|e| {
            CliError::new(
                1,
                "io_error",
                format!("Could not read the secret: {e}."),
                "Pass it on stdin instead (--stk-stdin / --secret-stdin).",
            )
        })
}

/// Reads all of stdin (trimmed), for `--stk-stdin`, `--secret-stdin` and `-` arguments.
pub fn read_stdin(what: &str) -> CliResult<String> {
    if std::io::stdin().is_terminal() {
        return Err(CliError::invalid(
            format!("Expected {what} on stdin, but stdin is a terminal."),
            format!(
                "Pipe it in, e.g. `printf '%s' \"$VALUE\" | silicon-accounts …`, or pass {what} another way."
            ),
        ));
    }
    let mut text = String::new();
    std::io::stdin().read_to_string(&mut text).map_err(|e| {
        CliError::new(
            1,
            "io_error",
            format!("Could not read {what} from stdin: {e}."),
            "Retry.",
        )
    })?;
    let value = text.trim().to_owned();
    if value.is_empty() {
        return Err(CliError::invalid(
            format!("stdin was empty; expected {what}."),
            format!("Pipe {what} into the command."),
        ));
    }
    Ok(value)
}

/// Reads a secret from stdin; when stdin is a terminal, asks for it without echoing.
pub fn read_secret_stdin(what: &str) -> CliResult<String> {
    if std::io::stdin().is_terminal() {
        let value = prompt_secret(&format!("Enter {what}: "))?;
        if value.is_empty() {
            return Err(CliError::invalid(
                format!("No {what} was entered."),
                format!("Type or paste {what}, or pipe it into the command."),
            ));
        }
        return Ok(value);
    }
    read_stdin(what)
}

/// `value`, or stdin when `value` is `-`.
pub fn arg_or_stdin(value: &str, what: &str) -> CliResult<String> {
    if value == "-" {
        read_stdin(what)
    } else {
        Ok(value.trim().to_owned())
    }
}

/// Reads a file (or stdin for `-`).
pub fn read_file_or_stdin(path: &Path, what: &str) -> CliResult<Vec<u8>> {
    if path == Path::new("-") {
        let mut bytes = Vec::new();
        std::io::stdin().read_to_end(&mut bytes).map_err(|e| {
            CliError::new(
                1,
                "io_error",
                format!("Could not read {what} from stdin: {e}."),
                "Retry.",
            )
        })?;
        return Ok(bytes);
    }
    std::fs::read(path).map_err(|e| {
        let mut err = CliError::io(&format!("read {what}"), path, &e);
        if e.kind() == std::io::ErrorKind::NotFound {
            err.exit = crate::error::EXIT_INVALID;
            err.code = "file_not_found".to_owned();
        }
        err
    })
}

/// Parses `90s`, `5m`, `2h`, `14d`, `1w` or a bare number of seconds.
pub fn parse_duration(text: &str) -> Result<Duration, String> {
    let text = text.trim().to_ascii_lowercase();
    let split = text
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(text.len());
    let (number, unit) = text.split_at(split);
    let value: u64 = number
        .parse()
        .map_err(|_| format!("`{text}` is not a duration; use e.g. 90s, 5m, 2h, 14d or 1w"))?;
    let seconds = match unit.trim() {
        "" | "s" | "sec" | "secs" => value,
        "m" | "min" | "mins" => value * 60,
        "h" | "hr" | "hrs" => value * 3600,
        "d" | "day" | "days" => value * 86_400,
        "w" | "week" | "weeks" => value * 7 * 86_400,
        other => {
            return Err(format!(
                "`{other}` is not a duration unit; use s, m, h, d or w"
            ));
        }
    };
    Ok(Duration::from_secs(seconds))
}

/// clap value parser for durations.
pub fn duration_arg(text: &str) -> Result<Duration, String> {
    parse_duration(text)
}

/// Opens a URL in the default browser. Returns false when it could not (or should not).
pub fn open_browser(url: &str) -> bool {
    if std::env::var_os("ACCOUNTS_NO_BROWSER").is_some_and(|v| !v.is_empty() && v != "0") {
        return false;
    }
    let mut command = if cfg!(target_os = "macos") {
        let mut c = Command::new("open");
        c.arg(url);
        c
    } else if cfg!(target_os = "windows") {
        let mut c = Command::new("cmd");
        c.args(["/C", "start", "", url]);
        c
    } else {
        if std::env::var_os("DISPLAY").is_none() && std::env::var_os("WAYLAND_DISPLAY").is_none() {
            return false;
        }
        let mut c = Command::new("xdg-open");
        c.arg(url);
        c
    };
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command.spawn().is_ok()
}

/// This machine's name, for sign-in labels.
pub fn hostname() -> String {
    for var in ["HOSTNAME", "COMPUTERNAME"] {
        if let Ok(value) = std::env::var(var)
            && !value.trim().is_empty()
        {
            return value.trim().to_owned();
        }
    }
    Command::new("hostname")
        .stderr(Stdio::null())
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "unknown host".to_owned())
}

/// The label sent with sign-ins: `silicon-accounts CLI on <host> (<os>)`.
pub fn client_label(custom: Option<&str>) -> String {
    match custom.map(str::trim).filter(|s| !s.is_empty()) {
        Some(label) => label.chars().take(100).collect(),
        None => format!(
            "silicon-accounts CLI on {} ({})",
            hostname(),
            std::env::consts::OS
        ),
    }
}

/// The system timezone as an IANA name, when it can be determined.
pub fn local_timezone() -> Option<String> {
    let valid = |tz: &str| {
        tz.contains('/')
            && !tz.starts_with('/')
            && tz
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "/_-+".contains(c))
    };
    if let Ok(tz) = std::env::var("TZ") {
        let tz = tz.trim_start_matches(':').to_owned();
        if valid(&tz) {
            return Some(tz);
        }
    }
    let target = std::fs::read_link("/etc/localtime").ok()?;
    let text = target.to_string_lossy().into_owned();
    let tz = text.split("zoneinfo/").nth(1)?.to_owned();
    valid(&tz).then_some(tz)
}

/// A fresh idempotency key for one logical operation.
pub fn idempotency_key() -> String {
    format!("cli-{}", silicon_accounts_client::random_token(18))
}

/// `si:head_of_growth` → `Head of growth`.
pub fn display_name_from_id(id: &str) -> String {
    let handle = id.split_once(':').map_or(id, |(_, h)| h);
    let words: Vec<&str> = handle.split(['_', '-']).filter(|w| !w.is_empty()).collect();
    let mut name = words.join(" ");
    if let Some(first) = name.get(..1) {
        name = first.to_ascii_uppercase() + name.get(1..).unwrap_or("");
    }
    if name.is_empty() {
        handle.to_owned()
    } else {
        name
    }
}

/// Adds the `c:`/`si:` prefix of `kind` to a bare handle; leaves prefixed ids alone.
pub fn with_prefix(id: &str, kind: silicon_accounts_client::AccountKind) -> String {
    let id = id.trim();
    if id.contains(':') {
        id.to_ascii_lowercase()
    } else {
        format!("{}{}", kind.prefix(), id.to_ascii_lowercase())
    }
}

/// Normalizes an STK the way the service does: lowercase, `stk-` prefix added to bare hex.
pub fn normalize_stk(stk: &str) -> CliResult<String> {
    let stk = stk.trim().to_ascii_lowercase();
    let hex = stk.strip_prefix("stk-").unwrap_or(&stk);
    if !(8..=32).contains(&hex.len()) || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(CliError::invalid(
            format!(
                "That STK is not valid: an STK is `stk-` followed by 8 to 32 hexadecimal characters (got {} characters{}).",
                hex.len(),
                if hex.bytes().all(|b| b.is_ascii_hexdigit()) {
                    ""
                } else {
                    ", some not hexadecimal"
                }
            ),
            "Use the STK exactly as it was shown when it was generated (e.g. stk-0123456789ab), or choose 8 to 32 hex characters.",
        ));
    }
    Ok(format!("stk-{hex}"))
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn durations() {
        assert_eq!(parse_duration("90").unwrap(), Duration::from_secs(90));
        assert_eq!(parse_duration("5m").unwrap(), Duration::from_secs(300));
        assert_eq!(
            parse_duration("14d").unwrap(),
            Duration::from_secs(14 * 86_400)
        );
        assert_eq!(
            parse_duration("1w").unwrap(),
            Duration::from_secs(7 * 86_400)
        );
        assert!(parse_duration("soon").is_err());
        assert!(parse_duration("5y").is_err());
    }

    #[test]
    fn names_and_ids() {
        assert_eq!(display_name_from_id("si:head_of_growth"), "Head of growth");
        assert_eq!(display_name_from_id("si:scout"), "Scout");
        assert_eq!(
            with_prefix("Scout", silicon_accounts_client::AccountKind::Silicon),
            "si:scout"
        );
        assert_eq!(
            with_prefix("c:Saket", silicon_accounts_client::AccountKind::Silicon),
            "c:saket"
        );
    }

    #[test]
    fn stks() {
        assert_eq!(
            normalize_stk("STK-0123456789AB").unwrap(),
            "stk-0123456789ab"
        );
        assert_eq!(normalize_stk("deadbeef").unwrap(), "stk-deadbeef");
        assert!(normalize_stk("stk-xyz").is_err());
        assert!(normalize_stk("stk-1234567").is_err());
        assert!(normalize_stk(&format!("stk-{}", "a".repeat(33))).is_err());
    }
}
