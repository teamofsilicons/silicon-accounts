//! CLI errors: precise message + hint + a stable exit code.
//!
//! Exit codes: 0 success, 1 generic failure, 2 invalid input (or an invalid proof /
//! token being checked), 3 authentication required or refused, 4 not found,
//! 5 conflict, 6 rate limited or locked, 130 interrupted.

use std::fmt;
use std::path::Path;

use serde_json::{Value, json};
use silicon_accounts_client::Error as ClientError;

/// Exit code: generic failure.
pub const EXIT_FAILURE: i32 = 1;
/// Exit code: invalid input, or the proof/token being checked is invalid.
pub const EXIT_INVALID: i32 = 2;
/// Exit code: sign-in required, or credentials refused.
pub const EXIT_AUTH: i32 = 3;
/// Exit code: not found.
pub const EXIT_NOT_FOUND: i32 = 4;
/// Exit code: conflict (already exists, taken, version changed).
pub const EXIT_CONFLICT: i32 = 5;
/// Exit code: rate limited or locked; retry later.
pub const EXIT_RATE_LIMITED: i32 = 6;
/// Exit code: interrupted with Ctrl-C.
pub const EXIT_INTERRUPTED: i32 = 130;

/// An error ready to be shown. Boxed so `Result<T, CliError>` stays small.
#[derive(Debug, Clone)]
pub struct CliError(Box<CliErrorBody>);

/// The fields of a [`CliError`] (reachable through `Deref`).
#[derive(Debug, Clone)]
pub struct CliErrorBody {
    pub code: String,
    pub message: String,
    pub hint: Option<String>,
    pub exit: i32,
    pub status: Option<u16>,
    pub request_id: Option<String>,
    pub details: Option<Value>,
    /// The service could not be reached (telemetry is skipped).
    pub transport: bool,
}

pub type CliResult<T> = Result<T, CliError>;

impl std::ops::Deref for CliError {
    type Target = CliErrorBody;

    fn deref(&self) -> &CliErrorBody {
        &self.0
    }
}

impl std::ops::DerefMut for CliError {
    fn deref_mut(&mut self) -> &mut CliErrorBody {
        &mut self.0
    }
}

impl CliError {
    pub fn new(exit: i32, code: &str, message: impl Into<String>, hint: impl Into<String>) -> Self {
        let hint = hint.into();
        Self(Box::new(CliErrorBody {
            code: code.to_owned(),
            message: message.into(),
            hint: (!hint.is_empty()).then_some(hint),
            exit,
            status: None,
            request_id: None,
            details: None,
            transport: false,
        }))
    }

    /// Bad flags, values or files (exit 2).
    pub fn invalid(message: impl Into<String>, hint: impl Into<String>) -> Self {
        Self::new(EXIT_INVALID, "invalid_input", message, hint)
    }

    /// Local file or directory problems (exit 1).
    pub fn io(action: &str, path: &Path, err: &std::io::Error) -> Self {
        let hint = match err.kind() {
            std::io::ErrorKind::PermissionDenied => format!(
                "Check the permissions of {} (the CLI needs to read and write its files there), or choose another home with `accounts config home <dir>`.",
                path.display()
            ),
            std::io::ErrorKind::NotFound => format!("Check that {} exists.", path.display()),
            _ => "Check the path and the disk, then retry.".to_owned(),
        };
        Self::new(
            EXIT_FAILURE,
            "io_error",
            format!("Could not {action} {}: {err}.", path.display()),
            hint,
        )
    }

    pub fn with_details(mut self, details: Value) -> Self {
        self.details = Some(details);
        self
    }

    /// The JSON shape printed with `--json`: the service's error body plus metadata.
    pub fn to_json(&self) -> Value {
        let mut error =
            json!({ "code": self.code, "message": self.message, "exit_code": self.exit });
        if let Some(hint) = &self.hint {
            error["hint"] = json!(hint);
        }
        if let Some(status) = self.status {
            error["status"] = json!(status);
        }
        if let Some(id) = &self.request_id {
            error["request_id"] = json!(id);
        }
        if let Some(details) = &self.details {
            error["details"] = details.clone();
        }
        json!({ "error": error })
    }
}

impl fmt::Display for CliError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)?;
        if let Some(hint) = &self.hint {
            write!(f, " Hint: {hint}")?;
        }
        Ok(())
    }
}

/// The exit code for a client error.
pub fn exit_code_for(error: &ClientError) -> i32 {
    match error {
        ClientError::Api(api) => match api.status {
            400 | 410 | 413 | 415 | 422 => EXIT_INVALID,
            401 | 403 => EXIT_AUTH,
            404 => EXIT_NOT_FOUND,
            409 => EXIT_CONFLICT,
            423 | 429 => EXIT_RATE_LIMITED,
            _ => EXIT_FAILURE,
        },
        ClientError::OAuth(oauth) => match oauth.error.as_str() {
            "invalid_client"
            | "invalid_grant"
            | "access_denied"
            | "expired_token"
            | "unauthorized_client" => EXIT_AUTH,
            "invalid_request" | "unsupported_grant_type" | "invalid_scope" => EXIT_INVALID,
            "slow_down" => EXIT_RATE_LIMITED,
            _ => EXIT_FAILURE,
        },
        ClientError::InvalidInput { .. }
        | ClientError::PayloadTooLarge { .. }
        | ClientError::Token(_) => EXIT_INVALID,
        _ => EXIT_FAILURE,
    }
}

impl From<ClientError> for CliError {
    fn from(error: ClientError) -> Self {
        let mut details = error.details().cloned();
        if let Some(retry) = error.retry_after() {
            let entry = details.get_or_insert_with(|| json!({}));
            if entry.is_object() && entry.get("retry_after_seconds").is_none() {
                entry["retry_after_seconds"] = json!(retry.as_secs());
            }
        }
        Self(Box::new(CliErrorBody {
            code: error.code().to_owned(),
            message: error.message(),
            hint: error.hint(),
            exit: exit_code_for(&error),
            status: error.status(),
            request_id: error.request_id().map(str::to_owned),
            details,
            transport: error.is_transport(),
        }))
    }
}

impl From<&clap::Error> for CliError {
    /// clap renders an argument error over several lines: the error, the missing or wrong
    /// arguments indented below it, tips, and the usage. All of it goes into the message, hint and
    /// details, so `--json` says exactly which argument is missing or wrong, not just "the
    /// following required arguments were not provided:".
    fn from(error: &clap::Error) -> Self {
        use clap::error::{ContextKind, ContextValue};

        let rendered = error.to_string();
        let mut paragraphs: Vec<Vec<&str>> = Vec::new();
        let mut current: Vec<&str> = Vec::new();
        for line in rendered.lines() {
            if line.trim().is_empty() {
                if !current.is_empty() {
                    paragraphs.push(std::mem::take(&mut current));
                }
            } else {
                current.push(line);
            }
        }
        if !current.is_empty() {
            paragraphs.push(current);
        }
        let mut message = String::new();
        let mut tips: Vec<String> = Vec::new();
        let mut usage: Option<String> = None;
        for (i, paragraph) in paragraphs.iter().enumerate() {
            if i == 0 {
                let lead = paragraph[0].trim().trim_start_matches("error: ");
                let rest: Vec<&str> = paragraph[1..].iter().map(|l| l.trim()).collect();
                message = if rest.is_empty() {
                    lead.to_owned()
                } else if lead.ends_with(':') {
                    format!("{lead} {}", rest.join(", "))
                } else {
                    format!("{lead} {}", rest.join(" "))
                };
                continue;
            }
            let mut in_usage = false;
            for line in paragraph {
                let line = line.trim();
                if let Some(tip) = line.strip_prefix("tip:") {
                    tips.push(tip.trim().to_owned());
                    in_usage = false;
                } else if line.starts_with("Usage:") {
                    usage = Some(line.to_owned());
                    in_usage = true;
                } else if in_usage && let Some(more) = usage.as_mut() {
                    // A long usage wraps onto indented lines of its paragraph.
                    more.push(' ');
                    more.push_str(line);
                }
            }
        }
        if message.is_empty() {
            message = "invalid arguments".to_owned();
        }
        let mut hint: Vec<String> = tips.iter().map(|tip| sentence(tip)).collect();
        if let Some(usage) = &usage {
            hint.push(sentence(usage));
        }
        hint.push("Run the command with --help to see its arguments and examples.".to_owned());

        let mut details = serde_json::Map::new();
        details.insert(
            "kind".into(),
            json!(snake_case(&format!("{:?}", error.kind()))),
        );
        match error.get(ContextKind::InvalidArg) {
            Some(ContextValue::Strings(args)) => {
                details.insert("arguments".into(), json!(args));
            }
            Some(ContextValue::String(arg)) => {
                details.insert("arguments".into(), json!([arg]));
            }
            _ => {}
        }
        if let Some(ContextValue::String(value)) = error.get(ContextKind::InvalidValue) {
            details.insert("value".into(), json!(value));
        }
        if let Some(ContextValue::String(sub)) = error.get(ContextKind::InvalidSubcommand) {
            details.insert("subcommand".into(), json!(sub));
        }
        if let Some(usage) = usage {
            details.insert(
                "usage".into(),
                json!(usage.trim_start_matches("Usage:").trim()),
            );
        }
        Self::new(EXIT_INVALID, "invalid_arguments", message, hint.join(" "))
            .with_details(Value::Object(details))
    }
}

/// `a similar subcommand exists: 'delivery'` → `A similar subcommand exists: 'delivery'.`
fn sentence(text: &str) -> String {
    let mut chars = text.trim().chars();
    let mut out: String = match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    };
    if !out.ends_with('.') {
        out.push('.');
    }
    out
}

/// `MissingRequiredArgument` → `missing_required_argument`.
fn snake_case(name: &str) -> String {
    let mut out = String::new();
    for c in name.chars() {
        if c.is_uppercase() && !out.is_empty() {
            out.push('_');
        }
        out.push(c.to_ascii_lowercase());
    }
    out
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use clap::{Arg, Command};

    use super::*;

    fn command() -> Command {
        Command::new("accounts")
            .subcommand(
                Command::new("app_verification")
                    .arg(
                        Arg::new("to")
                            .long("to")
                            .value_name("APP_ID")
                            .required(true),
                    )
                    .arg(
                        Arg::new("scope")
                            .long("scope")
                            .value_name("SCOPE")
                            .required(true),
                    ),
            )
            .subcommand(Command::new("webhook").subcommand(Command::new("delivery")))
    }

    #[test]
    fn json_argument_errors_name_the_missing_argument() {
        let err = command()
            .try_get_matches_from(["accounts", "app_verification", "--scope", "x"])
            .unwrap_err();
        let cli = CliError::from(&err);
        assert_eq!(cli.code, "invalid_arguments");
        assert_eq!(cli.exit, EXIT_INVALID);
        assert_eq!(
            cli.message,
            "the following required arguments were not provided: --to <APP_ID>"
        );
        let hint = cli.hint.clone().unwrap_or_default();
        assert!(
            hint.contains("Usage: accounts app_verification --to <APP_ID>"),
            "{hint}"
        );
        let details = cli.details.clone().unwrap_or_default();
        assert_eq!(details["arguments"], json!(["--to <APP_ID>"]));
        assert_eq!(details["kind"], "missing_required_argument");

        // Several missing arguments are all named.
        let err = command()
            .try_get_matches_from(["accounts", "app_verification"])
            .unwrap_err();
        let cli = CliError::from(&err);
        assert_eq!(
            cli.message,
            "the following required arguments were not provided: --to <APP_ID>, --scope <SCOPE>"
        );

        // An unknown subcommand keeps its tip.
        let err = command()
            .try_get_matches_from(["accounts", "webhook", "deliveries"])
            .unwrap_err();
        let cli = CliError::from(&err);
        assert_eq!(cli.message, "unrecognized subcommand 'deliveries'");
        let hint = cli.hint.clone().unwrap_or_default();
        assert!(hint.contains("'delivery'"), "{hint}");
        assert_eq!(
            cli.details.clone().unwrap_or_default()["subcommand"],
            "deliveries"
        );
    }
}
