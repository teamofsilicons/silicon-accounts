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
    fn from(error: &clap::Error) -> Self {
        let rendered = error.to_string();
        let first = rendered
            .lines()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("invalid arguments")
            .trim_start_matches("error: ")
            .to_owned();
        Self::new(
            EXIT_INVALID,
            "invalid_arguments",
            first,
            "Run the command with --help to see its arguments and examples.",
        )
    }
}
