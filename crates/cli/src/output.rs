//! Printing: results on stdout (plain text or `--json`), everything else on stderr.

use std::io::{IsTerminal, Write};

use serde_json::Value;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

use crate::error::CliError;

/// What a command produced.
#[derive(Debug, Default)]
pub struct Outcome {
    /// Printed with `--json`.
    pub json: Value,
    /// Printed in text mode (stdout).
    pub text: String,
    /// Suggested next commands: (command, why).
    pub next: Vec<(String, String)>,
    /// Exit code (0 unless the command reports a negative result, e.g. invalid proof).
    pub exit: i32,
}

impl Outcome {
    pub fn new(json: Value, text: impl Into<String>) -> Self {
        Self {
            json,
            text: text.into(),
            next: Vec::new(),
            exit: 0,
        }
    }

    pub fn next(mut self, command: impl Into<String>, why: impl Into<String>) -> Self {
        self.next.push((command.into(), why.into()));
        self
    }

    pub fn exit(mut self, code: i32) -> Self {
        self.exit = code;
        self
    }
}

/// Output settings.
#[derive(Debug, Clone, Copy)]
pub struct Output {
    pub json: bool,
    pub quiet: bool,
}

impl Output {
    fn color(&self) -> bool {
        std::io::stderr().is_terminal() && std::env::var_os("NO_COLOR").is_none()
    }

    /// Prints a command's result. False when stdout could not take it (see [`print_stdout`]).
    pub fn outcome(&self, outcome: &Outcome) -> bool {
        if self.json {
            let text =
                serde_json::to_string_pretty(&outcome.json).unwrap_or_else(|_| "null".to_owned());
            return print_stdout(&text);
        }
        if !outcome.text.is_empty() && !print_stdout(outcome.text.trim_end_matches('\n')) {
            return false;
        }
        if !self.quiet && !outcome.next.is_empty() {
            let width = outcome
                .next
                .iter()
                .map(|(c, _)| c.chars().count())
                .max()
                .unwrap_or(0);
            let mut text = String::from("\nNext:\n");
            for (command, why) in &outcome.next {
                text.push_str(&format!("  {command:<width$}  {why}\n"));
            }
            self.stderr(&self.dim(&text));
        }
        true
    }

    /// Prints an error: JSON on stdout with `--json`, else `error:`/`hint:` on stderr.
    pub fn error(&self, error: &CliError) {
        if self.json {
            let text = serde_json::to_string_pretty(&error.to_json()).unwrap_or_default();
            print_stdout(&text);
            return;
        }
        let label = if self.color() {
            "\x1b[1;31merror:\x1b[0m"
        } else {
            "error:"
        };
        let mut text = format!("{label} {}\n", error.message);
        if let Some(hint) = &error.hint {
            let label = if self.color() {
                "\x1b[1mhint:\x1b[0m"
            } else {
                "hint:"
            };
            text.push_str(&format!("{label} {hint}\n"));
        }
        if let Some(fields) = error
            .details
            .as_ref()
            .and_then(|d| d.get("fields"))
            .and_then(Value::as_object)
        {
            for (field, problem) in fields {
                let problem = problem
                    .as_str()
                    .map_or_else(|| problem.to_string(), str::to_owned);
                text.push_str(&format!("  {field}: {problem}\n"));
            }
        }
        if let Some(id) = &error.request_id {
            text.push_str(&format!("request id: {id}\n"));
        }
        self.stderr(&text);
    }

    /// A notice on stderr (suppressed by `-q` and `--json`).
    pub fn notice(&self, text: &str) {
        if !self.quiet && !self.json {
            self.stderr(&format!("{text}\n"));
        }
    }

    /// A warning on stderr (suppressed by `-q`; shown in JSON mode as a JSON line).
    pub fn warn(&self, text: &str) {
        if self.quiet {
            return;
        }
        if self.json {
            self.stderr(&format!("{}\n", serde_json::json!({ "warning": text })));
        } else {
            let label = if self.color() {
                "\x1b[1;33mwarning:\x1b[0m"
            } else {
                "warning:"
            };
            self.stderr(&format!("{label} {text}\n"));
        }
    }

    /// Something the user must see even with `-q` (a device code to type, a prompt).
    /// In JSON mode it is written as one JSON object per line on stderr.
    pub fn essential(&self, text: &str, json: &Value) {
        if self.json {
            self.stderr(&format!("{json}\n"));
        } else {
            self.stderr(&format!("{text}\n"));
        }
    }

    /// Progress on stderr (text mode only, suppressed by `-q`).
    pub fn progress(&self, text: &str) {
        if !self.quiet && !self.json {
            self.stderr(&format!("{text}\n"));
        }
    }

    fn dim(&self, text: &str) -> String {
        if self.color() {
            format!("\x1b[2m{text}\x1b[0m")
        } else {
            text.to_owned()
        }
    }

    fn stderr(&self, text: &str) {
        let mut err = std::io::stderr().lock();
        let _ = err.write_all(text.as_bytes());
        let _ = err.flush();
    }
}

/// Writes `text` and a newline to stdout, never panicking (`println!` panics when the write
/// fails). A reader that went away (a closed pipe: `silicon-accounts help --json | head -1`, or a
/// consumer that exits early) is not the command's failure: the rest of the output is dropped
/// quietly and the command keeps its own exit code. Any other write error (a full disk, a closed
/// descriptor) is reported on stderr and returns false so the command can exit non-zero.
pub fn print_stdout(text: &str) -> bool {
    let mut out = std::io::stdout().lock();
    let written = out
        .write_all(text.as_bytes())
        .and_then(|()| out.write_all(b"\n"))
        .and_then(|()| out.flush());
    match written {
        Ok(()) => true,
        Err(err) if err.kind() == std::io::ErrorKind::BrokenPipe => true,
        Err(err) => {
            let mut stderr = std::io::stderr().lock();
            let _ = writeln!(
                stderr,
                "error: could not write the result to stdout: {err}.\nhint: Check where stdout goes (a full disk or a closed file), then run the command again."
            );
            false
        }
    }
}

/// `key  value` lines with aligned values; rows with empty values are skipped.
pub fn kv(rows: &[(&str, String)]) -> String {
    let rows: Vec<&(&str, String)> = rows.iter().filter(|(_, v)| !v.is_empty()).collect();
    let width = rows
        .iter()
        .map(|(k, _)| k.chars().count())
        .max()
        .unwrap_or(0);
    let mut out = String::new();
    for (key, value) in rows {
        let mut lines = value.lines();
        out.push_str(&format!("{key:<width$}  {}\n", lines.next().unwrap_or("")));
        for line in lines {
            out.push_str(&format!("{:<width$}  {line}\n", ""));
        }
    }
    out
}

/// An aligned table. Returns `empty` when there are no rows.
pub fn table(headers: &[&str], rows: &[Vec<String>], empty: &str) -> String {
    if rows.is_empty() {
        return format!("{empty}\n");
    }
    let mut widths: Vec<usize> = headers.iter().map(|h| h.chars().count()).collect();
    for row in rows {
        for (i, cell) in row.iter().enumerate() {
            if let Some(w) = widths.get_mut(i) {
                *w = (*w).max(cell.chars().count());
            }
        }
    }
    let render = |cells: Vec<&str>| -> String {
        let last = cells.len().saturating_sub(1);
        let mut line = String::new();
        for (i, cell) in cells.iter().enumerate() {
            if i == last {
                line.push_str(cell);
            } else {
                let pad = widths[i].saturating_sub(cell.chars().count());
                line.push_str(cell);
                line.push_str(&" ".repeat(pad + 2));
            }
        }
        line.trim_end().to_owned() + "\n"
    };
    let mut out = render(headers.to_vec());
    for row in rows {
        out.push_str(&render(row.iter().map(String::as_str).collect()));
    }
    out
}

/// `2026-10-06T12:00:00Z (in 14d)`.
pub fn when(t: Option<OffsetDateTime>) -> String {
    let Some(t) = t else { return String::new() };
    let stamp = t
        .replace_millisecond(0)
        .unwrap_or(t)
        .format(&Rfc3339)
        .unwrap_or_default();
    let delta = (t - OffsetDateTime::now_utc()).whole_seconds();
    let rel = relative(delta.unsigned_abs());
    if delta.abs() < 5 {
        format!("{stamp} (now)")
    } else if delta > 0 {
        format!("{stamp} (in {rel})")
    } else {
        format!("{stamp} ({rel} ago)")
    }
}

/// `2026-10-06T12:00:00Z`.
pub fn stamp(t: Option<OffsetDateTime>) -> String {
    t.map(|t| {
        t.replace_millisecond(0)
            .unwrap_or(t)
            .format(&Rfc3339)
            .unwrap_or_default()
    })
    .unwrap_or_default()
}

/// `42s`, `3m`, `2h 5m`, `14d`, `13d 5h`: rounded to the nearest unit shown, so a token valid for
/// 120 s that is a moment old reads `2m` (not `1m`), and a 14-day request reads `14d` (not `13d`).
pub fn relative(seconds: u64) -> String {
    match seconds {
        s if s < 60 => format!("{s}s"),
        // 59.5 minutes and more read as an hour.
        s if s < 3570 => format!("{}m", ((s + 30) / 60).max(1)),
        s if s < 86_370 => {
            let minutes = (s + 30) / 60;
            let (h, m) = (minutes / 60, minutes % 60);
            if m == 0 {
                format!("{h}h")
            } else {
                format!("{h}h {m}m")
            }
        }
        s => {
            let hours = (s + 1800) / 3600;
            let (d, h) = (hours / 24, hours % 24);
            if h == 0 {
                format!("{d}d")
            } else {
                format!("{d}d {h}h")
            }
        }
    }
}

/// JSON value of an RFC 3339 timestamp (or null).
pub fn json_time(t: Option<OffsetDateTime>) -> Value {
    t.map_or(Value::Null, |t| Value::String(rfc3339_ms(t)))
}

/// A timestamp the way the API writes them: RFC 3339 in UTC with exactly three fractional digits
/// (`2026-10-06T12:00:00.000Z`), so the CLI's `--json` never differs from the service's own answers.
pub fn rfc3339_ms(t: OffsetDateTime) -> String {
    let t = t.to_offset(time::UtcOffset::UTC);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        t.year(),
        u8::from(t.month()),
        t.day(),
        t.hour(),
        t.minute(),
        t.second(),
        t.millisecond()
    )
}

/// Serializes any value for `--json` output.
pub fn to_json<T: serde::Serialize>(value: &T) -> Value {
    serde_json::to_value(value).unwrap_or(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tables_align() {
        let text = table(
            &["ID", "NAME"],
            &[
                vec!["si:a".into(), "A".into()],
                vec!["si:long".into(), "B".into()],
            ],
            "none",
        );
        assert_eq!(text, "ID       NAME\nsi:a     A\nsi:long  B\n");
        assert_eq!(table(&["ID"], &[], "(none)"), "(none)\n");
    }

    #[test]
    fn kv_aligns_and_skips_empty() {
        let text = kv(&[
            ("id", "c:saket".into()),
            ("timezone", "UTC".into()),
            ("empty", String::new()),
        ]);
        assert_eq!(text, "id        c:saket\ntimezone  UTC\n");
    }

    #[test]
    fn json_times_match_the_api() {
        use time::macros::datetime;
        // Microseconds and another offset come out as the API writes them: UTC, milliseconds.
        assert_eq!(
            json_time(Some(datetime!(2026-10-06 21:17:33.925326 +05:30))),
            Value::String("2026-10-06T15:47:33.925Z".into())
        );
        assert_eq!(
            json_time(Some(datetime!(2029-03-24 20:47:33 UTC))),
            Value::String("2029-03-24T20:47:33.000Z".into())
        );
        assert_eq!(json_time(None), Value::Null);
    }

    #[test]
    fn relative_times() {
        assert_eq!(relative(42), "42s");
        assert_eq!(relative(600), "10m");
        assert_eq!(relative(7200), "2h");
        assert_eq!(relative(7500), "2h 5m");
        assert_eq!(relative(14 * 86_400), "14d");
        // A moment after it was issued, the time left still reads as what was issued.
        assert_eq!(relative(119), "2m");
        assert_eq!(relative(90), "2m");
        assert_eq!(relative(89), "1m");
        assert_eq!(relative(3599), "1h");
        assert_eq!(relative(2 * 3600 - 1), "2h");
        assert_eq!(relative(14 * 86_400 - 1), "14d");
        assert_eq!(relative(14 * 86_400 - 5 * 60), "14d");
        assert_eq!(relative(13 * 86_400 + 5 * 3600), "13d 5h");
        assert_eq!(relative(86_399), "1d");
        assert_eq!(relative(86_400 + 3600), "1d 1h");
    }
}
