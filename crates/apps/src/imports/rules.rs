//! Per-row rules of an import (pure: no database). A stored row (`{"row": {...}}` as received)
//! becomes a [`Prepared`] row: every value trimmed; emails lowercased, validated and
//! de-duplicated; phones normalized to E.164 (local numbers via `default_country`); display
//! names with control characters (quoted newlines) collapsed to single spaces; the username
//! parsed as a Carbon handle; dob read in the accepted formats; timezone and photo URL checked.
//! Every problem becomes a message with a stable code; invalid optional values are dropped (the
//! account gets the default) and only a row without any usable email or phone (or with an
//! unusable external_id) is an error.
//!
//! Messages are bounded: a row gets at most [`MAX_ITEM_MESSAGES`] messages per kind of invalid
//! list item (then one summary counts the rest), a value quoted in a message is cut to 80
//! characters, and no message is longer than [`MAX_MESSAGE_CHARS`] — one row can't turn into
//! megabytes of messages.
//!
//! Message codes. Named by the spec: `missing_identifier`, `ambiguous_match`,
//! `duplicate_in_file`, `external_id_conflict`, `id_conflict`, `invalid_phone`,
//! `unknown_columns`. Also used: `invalid_email`, `invalid_dob`, `invalid_timezone`,
//! `invalid_pfp_url`, `invalid_username`, `reserved_username`, `extra_fields`, `missing_fields`,
//! `invalid_external_id`, `invalid_value`, `too_many_emails`, `too_many_phones`,
//! `display_name_truncated`, `access_removed`, `import_conflict`, `identifiers_not_attached`,
//! `external_id_differs`.

use std::collections::HashMap;

use accounts_core::ids::{AccountId, IdError};
use accounts_core::models::AccountKind;
use accounts_core::normalize;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use time::Date;

use super::input::{ImportOptions, is_allowed_column, normalize_column};

/// Most emails (and, separately, phones) an account can have.
pub const MAX_CONTACTS: usize = 10;
/// Longest display name.
pub const MAX_DISPLAY_NAME: usize = 100;
/// Longest external id.
pub const MAX_EXTERNAL_ID: usize = 255;
/// Messages one row gets for invalid items of one list (emails, phones) before the rest are
/// counted in a single summary message.
pub const MAX_ITEM_MESSAGES: usize = 5;
/// Longest message text.
pub const MAX_MESSAGE_CHARS: usize = 2000;

/// Stable message codes.
pub mod codes {
    pub const MISSING_IDENTIFIER: &str = "missing_identifier";
    pub const AMBIGUOUS_MATCH: &str = "ambiguous_match";
    pub const DUPLICATE_IN_FILE: &str = "duplicate_in_file";
    pub const EXTERNAL_ID_CONFLICT: &str = "external_id_conflict";
    pub const ID_CONFLICT: &str = "id_conflict";
    pub const INVALID_PHONE: &str = "invalid_phone";
    pub const UNKNOWN_COLUMNS: &str = "unknown_columns";
    pub const INVALID_EMAIL: &str = "invalid_email";
    pub const INVALID_DOB: &str = "invalid_dob";
    pub const INVALID_TIMEZONE: &str = "invalid_timezone";
    pub const INVALID_PFP_URL: &str = "invalid_pfp_url";
    pub const INVALID_USERNAME: &str = "invalid_username";
    pub const RESERVED_USERNAME: &str = "reserved_username";
    pub const EXTRA_FIELDS: &str = "extra_fields";
    pub const MISSING_FIELDS: &str = "missing_fields";
    pub const INVALID_EXTERNAL_ID: &str = "invalid_external_id";
    pub const INVALID_VALUE: &str = "invalid_value";
    pub const TOO_MANY_EMAILS: &str = "too_many_emails";
    pub const TOO_MANY_PHONES: &str = "too_many_phones";
    pub const DISPLAY_NAME_TRUNCATED: &str = "display_name_truncated";
    pub const ACCESS_REMOVED: &str = "access_removed";
    pub const IMPORT_CONFLICT: &str = "import_conflict";
    /// A new account carries only the row's primary email or phone (info).
    pub const IDENTIFIERS_NOT_ATTACHED: &str = "identifiers_not_attached";
    /// A matched member keeps its external_id; the row had another one (warning).
    pub const EXTERNAL_ID_DIFFERS: &str = "external_id_differs";
}

/// Severity of a row message.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Level {
    Error,
    Warning,
    Info,
}

/// One message about a row: `{level, code, message, field?}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RowMessage {
    pub level: Level,
    pub code: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
}

impl RowMessage {
    pub fn new(level: Level, code: &str, message: impl Into<String>, field: Option<&str>) -> Self {
        let mut message: String = message.into();
        if message.chars().count() > MAX_MESSAGE_CHARS {
            message = message.chars().take(MAX_MESSAGE_CHARS - 1).collect();
            message.push('…');
        }
        RowMessage {
            level,
            code: code.to_string(),
            message,
            field: field.map(str::to_string),
        }
    }
    pub fn error(code: &str, message: impl Into<String>, field: Option<&str>) -> Self {
        Self::new(Level::Error, code, message, field)
    }
    pub fn warning(code: &str, message: impl Into<String>, field: Option<&str>) -> Self {
        Self::new(Level::Warning, code, message, field)
    }
    pub fn info(code: &str, message: impl Into<String>, field: Option<&str>) -> Self {
        Self::new(Level::Info, code, message, field)
    }
}

/// The desired id of a row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Username {
    /// No username column / empty.
    Missing,
    /// A valid Carbon handle (`saket` or `c:saket`).
    Valid(AccountId),
    /// A reserved word (`admin`).
    Reserved,
    /// Not a handle; `why` explains exactly what is wrong.
    Invalid { why: String },
}

/// A row after the per-row rules.
#[derive(Debug, Clone)]
pub struct Prepared {
    pub external_id: Option<String>,
    /// Valid, normalized, de-duplicated; the first is the primary.
    pub emails: Vec<String>,
    /// E.164, de-duplicated; the first is the primary.
    pub phones: Vec<String>,
    /// Cleaned display name as supplied (None when not supplied).
    pub display_name: Option<String>,
    pub username: Username,
    /// The username as written (trimmed).
    pub username_raw: Option<String>,
    pub dob: Option<Date>,
    pub timezone: Option<String>,
    pub pfp_url: Option<String>,
    pub email_verified: Option<bool>,
    /// Messages so far, in field order.
    pub messages: Vec<RowMessage>,
    /// True when the row can't be imported (an error message was added).
    pub fatal: bool,
}

impl Prepared {
    /// `email:<email>` / `phone:<e164>` keys for duplicate detection.
    pub fn identifier_keys(&self) -> Vec<String> {
        self.emails
            .iter()
            .map(|e| format!("email:{e}"))
            .chain(self.phones.iter().map(|p| format!("phone:{p}")))
            .collect()
    }

    /// The membership's `imported_profile`: the cleaned row, only values the app supplied.
    pub fn profile(&self) -> Value {
        json!({
            "external_id": self.external_id,
            "emails": self.emails,
            "phones": self.phones,
            "display_name": self.display_name,
            "username": self.username_raw,
            "dob": self.dob.map(accounts_core::timefmt::format_date),
            "timezone": self.timezone,
            "pfp_url": self.pfp_url,
            "email_verified": self.email_verified,
        })
    }

    /// The display name a new account gets: as supplied, else from the email, else from the
    /// phone ("Carbon 1234").
    pub fn account_display_name(&self) -> String {
        if let Some(n) = &self.display_name {
            return n.clone();
        }
        if let Some(e) = self.emails.first() {
            return normalize::display_name_from_email(e);
        }
        if let Some(p) = self.phones.first() {
            return normalize::display_name_from_phone(p);
        }
        "Carbon".to_string()
    }

    /// The email or phone a new account carries: the first valid email, else the first valid
    /// phone. Only the Carbon who proves this one can finish the account, so a row can never
    /// bind someone else's address to an account another person claims.
    pub fn primary_identifier(&self) -> Option<&str> {
        self.emails
            .first()
            .or_else(|| self.phones.first())
            .map(String::as_str)
    }

    /// The row's other emails and phones (they stay in the membership's imported profile).
    pub fn other_identifiers(&self) -> Vec<&str> {
        let skip_emails = usize::from(!self.emails.is_empty());
        let skip_phones = usize::from(self.emails.is_empty() && !self.phones.is_empty());
        self.emails
            .iter()
            .skip(skip_emails)
            .chain(self.phones.iter().skip(skip_phones))
            .map(String::as_str)
            .collect()
    }

    /// Seeds for an id suggestion when the username can't be used as is: the username, the
    /// primary email's local part, the display name.
    pub fn suggestion_seeds(&self) -> Vec<String> {
        let mut seeds = Vec::new();
        if let Some(u) = &self.username_raw
            && !matches!(self.username, Username::Valid(_))
        {
            seeds.push(u.clone());
        }
        if let Some(e) = self.emails.first() {
            seeds.push(e.split('@').next().unwrap_or("").to_string());
        }
        seeds.push(self.account_display_name());
        seeds
    }

    fn fail(&mut self, msg: RowMessage) {
        self.fatal = true;
        self.messages.push(msg);
    }
}

fn is_blank(v: &Value) -> bool {
    match v {
        Value::Null => true,
        Value::String(s) => s.trim().is_empty(),
        Value::Array(a) => a.iter().all(is_blank),
        _ => false,
    }
}

/// A scalar cell as trimmed text (`None` when blank); `Err` for objects/arrays.
fn scalar(v: &Value) -> Result<Option<String>, ()> {
    match v {
        Value::Null => Ok(None),
        Value::String(s) => {
            let t = s.trim();
            Ok((!t.is_empty()).then(|| t.to_string()))
        }
        Value::Number(n) => Ok(Some(n.to_string())),
        Value::Bool(b) => Ok(Some(b.to_string())),
        _ => Err(()),
    }
}

/// A list cell: a JSON array of scalars, or text separated by `;`.
fn list(v: &Value) -> Result<Vec<String>, ()> {
    match v {
        Value::Array(items) => {
            let mut out = Vec::new();
            for i in items {
                if let Some(s) = scalar(i)? {
                    out.extend(split_list(&s));
                }
            }
            Ok(out)
        }
        other => Ok(scalar(other)?.map(|s| split_list(&s)).unwrap_or_default()),
    }
}

fn split_list(s: &str) -> Vec<String> {
    s.split(';')
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(str::to_string)
        .collect()
}

fn parse_flag(s: &str) -> Option<bool> {
    match s.trim().to_ascii_lowercase().as_str() {
        "true" | "1" | "yes" | "y" => Some(true),
        "false" | "0" | "no" | "n" => Some(false),
        _ => None,
    }
}

/// Collapses runs of whitespace and control characters (a quoted newline in a CSV cell) into
/// one space and trims.
pub fn clean_display_name(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut pending_space = false;
    for c in raw.chars() {
        if c.is_whitespace() || c.is_control() {
            pending_space = true;
            continue;
        }
        if pending_space && !out.is_empty() {
            out.push(' ');
        }
        pending_space = false;
        out.push(c);
    }
    out
}

/// A value quoted in a message: at most 80 characters.
pub(crate) fn quote(s: &str) -> String {
    let shown: String = s.chars().take(80).collect();
    if shown.len() < s.len() {
        format!("'{shown}…'")
    } else {
        format!("'{shown}'")
    }
}

fn strip_period(s: &str) -> &str {
    s.trim_end_matches('.')
}

/// Core's validators quote the value they reject in full; a long value is cut to 80 characters
/// so one cell can't produce a huge message.
fn shorten(message: &str, raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.chars().count() <= 80 {
        return message.to_string();
    }
    for candidate in [trimmed, raw] {
        let quoted = format!("'{candidate}'");
        if message.contains(&quoted) {
            return message.replacen(&quoted, &quote(trimmed), 1);
        }
    }
    message.to_string()
}

fn plural(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

/// Applies the per-row rules to a stored row.
pub fn prepare(stored: &Value, options: &ImportOptions, today: Date) -> Prepared {
    let mut p = Prepared {
        external_id: None,
        emails: Vec::new(),
        phones: Vec::new(),
        display_name: None,
        username: Username::Missing,
        username_raw: None,
        dob: None,
        timezone: None,
        pfp_url: None,
        email_verified: None,
        messages: Vec::new(),
        fatal: false,
    };
    let empty = serde_json::Map::new();
    let row = stored
        .get("row")
        .and_then(Value::as_object)
        .unwrap_or(&empty);

    // Columns by normalized name; on duplicates the first non-blank value wins.
    let mut cols: HashMap<String, &Value> = HashMap::new();
    let mut unknown: Vec<String> = Vec::new();
    for (k, v) in row {
        let n = normalize_column(k);
        if !is_allowed_column(&n) {
            if !is_blank(v) {
                unknown.push(k.trim().to_string());
            }
            continue;
        }
        let keep_existing = cols.get(&n).is_some_and(|e| !is_blank(e));
        if !keep_existing {
            cols.insert(n, v);
        }
    }
    // The parser keeps only the names of ignored columns that held something (`ignored`, at
    // most a few, and `ignored_count`); rows stored by older versions kept the values in `row`.
    for name in stored
        .get("ignored")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        if !unknown.iter().any(|u| u == name) {
            unknown.push(name.to_string());
        }
    }
    let unknown_count = stored
        .get("ignored_count")
        .and_then(Value::as_u64)
        .map_or(0, |n| n as usize)
        .max(unknown.len());
    if unknown_count > 0 {
        let shown: Vec<String> = unknown.iter().take(5).map(|u| quote(u)).collect();
        let more = unknown_count.saturating_sub(shown.len());
        p.messages.push(RowMessage::warning(
            codes::UNKNOWN_COLUMNS,
            format!(
                "Ignored the value{} in {}{}: not import columns (ignore_unknown_columns is on).",
                if unknown_count == 1 { "" } else { "s" },
                shown.join(", "),
                if more > 0 {
                    format!(" and {}", plural(more, "more column", "more columns"))
                } else {
                    String::new()
                }
            ),
            None,
        ));
    }
    // Cells past the end of the CSV header: a count (older rows kept the cells themselves).
    let extra = match stored.get("extra_cells") {
        Some(Value::Array(cells)) if cells.iter().any(|c| !is_blank(c)) => cells.len(),
        Some(Value::Number(n)) => n.as_u64().map_or(0, |n| n as usize),
        _ => 0,
    };
    if extra > 0 {
        let header = stored
            .get("header_cells")
            .and_then(Value::as_u64)
            .map_or(row.len(), |n| n as usize);
        p.messages.push(RowMessage::warning(
            codes::EXTRA_FIELDS,
            format!(
                "This row has {} cells but the header has {header} columns; the {} without a column {} ignored.",
                header + extra,
                plural(extra, "extra cell", "extra cells"),
                if extra == 1 { "was" } else { "were" },
            ),
            None,
        ));
    }
    if let Some(missing) = stored.get("missing_cells").and_then(Value::as_u64)
        && missing > 0
    {
        let header = stored
            .get("header_cells")
            .and_then(Value::as_u64)
            .unwrap_or(row.len() as u64 + missing);
        p.messages.push(RowMessage::warning(
            codes::MISSING_FIELDS,
            format!(
                "This row has {} cells but the header has {header} columns; the missing trailing cells were read as empty.",
                header - missing
            ),
            None,
        ));
    }

    let text = |p: &mut Prepared, name: &str| -> Option<String> {
        let v = cols.get(name)?;
        match scalar(v) {
            Ok(s) => s,
            Err(()) => {
                p.messages.push(RowMessage::warning(
                    codes::INVALID_VALUE,
                    format!(
                        "The {name} value must be text, not a list or an object; it was ignored."
                    ),
                    Some(name),
                ));
                None
            }
        }
    };

    // external_id
    if let Some(ext) = text(&mut p, "external_id") {
        if ext.chars().count() > MAX_EXTERNAL_ID {
            p.fail(RowMessage::error(
                codes::INVALID_EXTERNAL_ID,
                format!(
                    "The external_id is {} characters; it must be at most {MAX_EXTERNAL_ID}, so this row can't be linked to your record.",
                    ext.chars().count()
                ),
                Some("external_id"),
            ));
        } else if ext.chars().any(char::is_control) {
            p.fail(RowMessage::error(
                codes::INVALID_EXTERNAL_ID,
                "The external_id contains control characters (like newlines or tabs), so this row can't be linked to your record.",
                Some("external_id"),
            ));
        } else {
            p.external_id = Some(ext);
        }
    }

    // emails: `email` first, then `emails`
    let mut raw_emails: Vec<(String, &'static str)> = Vec::new();
    if let Some(e) = text(&mut p, "email") {
        raw_emails.push((e, "email"));
    }
    if let Some(v) = cols.get("emails") {
        match list(v) {
            Ok(items) => raw_emails.extend(items.into_iter().map(|e| (e, "emails"))),
            Err(()) => p.messages.push(RowMessage::warning(
                codes::INVALID_VALUE,
                "emails must be a list of emails or text separated by ';'; it was ignored.",
                Some("emails"),
            )),
        }
    }
    let mut dropped_emails = 0;
    let mut invalid_emails = 0usize;
    for (raw, field) in raw_emails {
        match normalize::normalize_email(&raw) {
            Ok(e) => {
                if p.emails.contains(&e) {
                    continue;
                }
                if p.emails.len() >= MAX_CONTACTS {
                    dropped_emails += 1;
                    continue;
                }
                p.emails.push(e);
            }
            Err(err) => {
                invalid_emails += 1;
                if invalid_emails <= MAX_ITEM_MESSAGES {
                    p.messages.push(RowMessage::warning(
                        codes::INVALID_EMAIL,
                        format!("{} It was left out.", shorten(&err.message, &raw)),
                        Some(field),
                    ));
                }
            }
        }
    }
    if invalid_emails > MAX_ITEM_MESSAGES {
        p.messages.push(RowMessage::warning(
            codes::INVALID_EMAIL,
            format!(
                "…and {} were left out too.",
                plural(
                    invalid_emails - MAX_ITEM_MESSAGES,
                    "more invalid email",
                    "more invalid emails"
                )
            ),
            Some("emails"),
        ));
    }
    if dropped_emails > 0 {
        p.messages.push(RowMessage::warning(
            codes::TOO_MANY_EMAILS,
            format!("An account can have at most {MAX_CONTACTS} emails; the last {dropped_emails} were left out."),
            Some("emails"),
        ));
    }

    // phones: `phone` first, then `phones`
    let mut raw_phones: Vec<(String, &'static str)> = Vec::new();
    if let Some(ph) = text(&mut p, "phone") {
        raw_phones.push((ph, "phone"));
    }
    if let Some(v) = cols.get("phones") {
        match list(v) {
            Ok(items) => raw_phones.extend(items.into_iter().map(|ph| (ph, "phones"))),
            Err(()) => p.messages.push(RowMessage::warning(
                codes::INVALID_VALUE,
                "phones must be a list of phone numbers or text separated by ';'; it was ignored.",
                Some("phones"),
            )),
        }
    }
    let mut dropped_phones = 0;
    let mut invalid_phones = 0usize;
    for (raw, field) in raw_phones {
        match normalize::normalize_phone(&raw, options.default_country.as_deref()) {
            Ok(ph) => {
                if p.phones.contains(&ph) {
                    continue;
                }
                if p.phones.len() >= MAX_CONTACTS {
                    dropped_phones += 1;
                    continue;
                }
                p.phones.push(ph);
            }
            Err(err) => {
                invalid_phones += 1;
                if invalid_phones > MAX_ITEM_MESSAGES {
                    continue;
                }
                let country = match options.default_country.as_deref() {
                    Some(c) if !raw.trim_start().starts_with('+') => {
                        format!(" (read with default_country {c})")
                    }
                    _ => String::new(),
                };
                p.messages.push(RowMessage::warning(
                    codes::INVALID_PHONE,
                    format!(
                        "{}{country}. It was left out.",
                        strip_period(&shorten(&err.message, &raw))
                    ),
                    Some(field),
                ))
            }
        }
    }
    if invalid_phones > MAX_ITEM_MESSAGES {
        p.messages.push(RowMessage::warning(
            codes::INVALID_PHONE,
            format!(
                "…and {} were left out too.",
                plural(
                    invalid_phones - MAX_ITEM_MESSAGES,
                    "more invalid phone number",
                    "more invalid phone numbers"
                )
            ),
            Some("phones"),
        ));
    }
    if dropped_phones > 0 {
        p.messages.push(RowMessage::warning(
            codes::TOO_MANY_PHONES,
            format!("An account can have at most {MAX_CONTACTS} phone numbers; the last {dropped_phones} were left out."),
            Some("phones"),
        ));
    }

    // display_name (alias name)
    let display = text(&mut p, "display_name").or_else(|| text(&mut p, "name"));
    if let Some(raw) = display {
        let cleaned = clean_display_name(&raw);
        if cleaned.chars().count() > MAX_DISPLAY_NAME {
            let cut: String = cleaned.chars().take(MAX_DISPLAY_NAME).collect();
            let cut = cut.trim_end().to_string();
            p.messages.push(RowMessage::warning(
                codes::DISPLAY_NAME_TRUNCATED,
                format!(
                    "The display name is {} characters; it was cut to the first {MAX_DISPLAY_NAME}.",
                    cleaned.chars().count()
                ),
                Some("display_name"),
            ));
            p.display_name = Some(cut);
        } else if !cleaned.is_empty() {
            p.display_name = Some(cleaned);
        }
    }

    // username
    if let Some(raw) = text(&mut p, "username") {
        p.username = match AccountId::parse_for_kind(&raw, AccountKind::Carbon) {
            Ok(id) => Username::Valid(id),
            Err(IdError::ReservedWord { .. }) => Username::Reserved,
            Err(e) => Username::Invalid { why: e.to_string() },
        };
        p.username_raw = Some(raw);
    }

    // dob
    if let Some(raw) = text(&mut p, "dob") {
        let parsed =
            normalize::parse_date_flexible(&raw).and_then(|d| normalize::validate_dob(d, today));
        match parsed {
            Ok(d) => p.dob = Some(d),
            Err(why) => p.messages.push(RowMessage::warning(
                codes::INVALID_DOB,
                format!(
                    "{}. It was left out; a new account gets the default date of birth ({}).",
                    strip_period(&shorten(&why, &raw)),
                    accounts_core::timefmt::format_date(normalize::default_dob(today))
                ),
                Some("dob"),
            )),
        }
    }

    // timezone
    if let Some(raw) = text(&mut p, "timezone") {
        match normalize::normalize_timezone(&raw) {
            Ok(tz) => p.timezone = Some(tz),
            Err(why) => p.messages.push(RowMessage::warning(
                codes::INVALID_TIMEZONE,
                format!(
                    "{} It was left out; a new account gets UTC.",
                    shorten(&why, &raw).trim_end()
                ),
                Some("timezone"),
            )),
        }
    }

    // pfp_url
    if let Some(raw) = text(&mut p, "pfp_url") {
        match normalize::validate_https_url(&raw) {
            Ok(_) => p.pfp_url = Some(raw),
            Err(why) => p.messages.push(RowMessage::warning(
                codes::INVALID_PFP_URL,
                format!(
                    "The pfp_url is not usable: {}. Profile photos must be https URLs; a new account gets the default Carbon photo.",
                    strip_period(&shorten(&why, &raw))
                ),
                Some("pfp_url"),
            )),
        }
    }

    // email_verified (informational only; imported emails are never trusted as verified)
    if let Some(v) = cols.get("email_verified") {
        match v {
            Value::Bool(b) => p.email_verified = Some(*b),
            other => match scalar(other) {
                Ok(None) => {}
                Ok(Some(s)) => match parse_flag(&s) {
                    Some(b) => p.email_verified = Some(b),
                    None => p.messages.push(RowMessage::warning(
                        codes::INVALID_VALUE,
                        format!(
                            "email_verified is {}; use true or false. It was ignored.",
                            quote(&s)
                        ),
                        Some("email_verified"),
                    )),
                },
                Err(()) => p.messages.push(RowMessage::warning(
                    codes::INVALID_VALUE,
                    "email_verified must be true or false; it was ignored.",
                    Some("email_verified"),
                )),
            },
        }
    }

    if !p.fatal && p.emails.is_empty() && p.phones.is_empty() {
        let had_any = p
            .messages
            .iter()
            .any(|m| m.code == codes::INVALID_EMAIL || m.code == codes::INVALID_PHONE);
        p.fail(RowMessage::error(
            codes::MISSING_IDENTIFIER,
            if had_any {
                "The row has no valid email or phone number left (see the warnings above), so it can't be matched to an account or create one."
            } else {
                "The row has no email or phone number, so it can't be matched to an account or create one."
            },
            None,
        ));
    }
    p
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::macros::date;

    const TODAY: Date = date!(2026 - 10 - 06);

    fn us() -> ImportOptions {
        ImportOptions {
            default_country: Some("US".into()),
            ..ImportOptions::default()
        }
    }

    fn prep(row: Value) -> Prepared {
        prepare(&json!({"row": row}), &us(), TODAY)
    }

    fn codes_of(p: &Prepared) -> Vec<(Level, String, Option<String>)> {
        p.messages
            .iter()
            .map(|m| (m.level, m.code.clone(), m.field.clone()))
            .collect()
    }

    #[test]
    fn trims_normalizes_and_dedupes() {
        let p = prep(json!({
            "external_id": "  crm-003 ", "email": "  Alan@Legacy-CRM.TEST ", "emails": "alan@legacy-crm.test; second@legacy-crm.test",
            "phone": " +1 415 555 0103 ", "phones": ["(212) 555-0156", 2125550156_i64],
            "display_name": "  Alan \t Mathison ", "username": " alan_m ", "dob": " 1991-06-23 ",
            "timezone": " asia/kolkata ", "pfp_url": "https://cdn.example.com/a.png", "email_verified": "TRUE"
        }));
        assert!(!p.fatal, "{:?}", p.messages);
        assert!(p.messages.is_empty(), "{:?}", p.messages);
        assert_eq!(p.external_id.as_deref(), Some("crm-003"));
        assert_eq!(
            p.emails,
            vec!["alan@legacy-crm.test", "second@legacy-crm.test"]
        );
        assert_eq!(p.phones, vec!["+14155550103", "+12125550156"]);
        assert_eq!(p.display_name.as_deref(), Some("Alan Mathison"));
        assert_eq!(
            p.username,
            Username::Valid(AccountId::parse("c:alan_m").expect("id"))
        );
        assert_eq!(p.dob, Some(date!(1991 - 06 - 23)));
        assert_eq!(p.timezone.as_deref(), Some("Asia/Kolkata"));
        assert_eq!(p.email_verified, Some(true));
        assert_eq!(
            p.identifier_keys(),
            vec![
                "email:alan@legacy-crm.test",
                "email:second@legacy-crm.test",
                "phone:+14155550103",
                "phone:+12125550156"
            ]
        );
        assert_eq!(p.profile()["dob"], "1991-06-23");
    }

    #[test]
    fn invalid_values_become_warnings_and_defaults() {
        let p = prep(json!({
            "email": "john smith@x.test", "phone": "+1 (555) abc", "emails": "ok@x.test",
            "dob": "04/05/1990", "timezone": "GMT+5:30", "pfp_url": "http://x.test/a.png",
            "username": "John Smith!"
        }));
        assert!(!p.fatal);
        assert_eq!(
            codes_of(&p),
            vec![
                (Level::Warning, "invalid_email".into(), Some("email".into())),
                (Level::Warning, "invalid_phone".into(), Some("phone".into())),
                (Level::Warning, "invalid_dob".into(), Some("dob".into())),
                (
                    Level::Warning,
                    "invalid_timezone".into(),
                    Some("timezone".into())
                ),
                (
                    Level::Warning,
                    "invalid_pfp_url".into(),
                    Some("pfp_url".into())
                ),
            ]
        );
        assert!(
            p.messages[2].message.contains("ambiguous"),
            "{}",
            p.messages[2].message
        );
        assert!(
            p.messages[2].message.contains("2008-10-06"),
            "{}",
            p.messages[2].message
        );
        assert!(matches!(p.username, Username::Invalid { .. }));
        assert_eq!(p.dob, None);
        assert_eq!(p.timezone, None);
        assert_eq!(p.pfp_url, None);
        assert_eq!(p.emails, vec!["ok@x.test"]);
    }

    #[test]
    fn rows_without_identifiers_fail() {
        let p = prep(json!({"email": "foo@@bar.test", "display_name": "Double At"}));
        assert!(p.fatal);
        assert_eq!(
            codes_of(&p),
            vec![
                (Level::Warning, "invalid_email".into(), Some("email".into())),
                (Level::Error, "missing_identifier".into(), None)
            ]
        );
        let p = prep(json!({"phone": "020 7946 0018"}));
        assert!(p.fatal);
        assert!(
            p.messages[0].message.contains("default_country US"),
            "{}",
            p.messages[0].message
        );
        let p = prepare(&json!({"row": {}}), &us(), TODAY);
        assert!(p.fatal);
        assert_eq!(p.messages.len(), 1);
    }

    #[test]
    fn display_names_and_usernames() {
        assert_eq!(clean_display_name("Lin\nHopper"), "Lin Hopper");
        assert_eq!(clean_display_name("  a \r\n\t b  "), "a b");
        let p = prep(json!({"email": "a@x.test", "name": "Zoë Saldaña", "username": "SUPPORT"}));
        assert_eq!(p.display_name.as_deref(), Some("Zoë Saldaña"));
        assert_eq!(p.username, Username::Reserved);
        assert_eq!(p.suggestion_seeds(), vec!["SUPPORT", "a", "Zoë Saldaña"]);
        let p = prep(json!({"email": "a@x.test", "username": "c:Shubham"}));
        assert_eq!(
            p.username,
            Username::Valid(AccountId::parse("c:shubham").expect("id"))
        );
        let p = prep(json!({"email": "a@x.test", "username": "si:scout"}));
        assert!(matches!(p.username, Username::Invalid { ref why, .. } if why.contains("Silicon")));
        let p = prep(json!({"phone": "+14155550101"}));
        assert_eq!(p.account_display_name(), "Carbon 0101");
        let long = "x".repeat(150);
        let p = prep(json!({"email": "a@x.test", "display_name": long}));
        assert_eq!(
            p.display_name.as_ref().map(|d| d.chars().count()),
            Some(100)
        );
        assert_eq!(p.messages[0].code, "display_name_truncated");
    }

    #[test]
    fn row_shape_warnings() {
        let stored = json!({"row": {"email": "a@x.test", "plan": "pro", "favorite_color": ""}, "extra_cells": ["x", ""]});
        let p = prepare(&stored, &us(), TODAY);
        assert_eq!(p.messages[0].code, "unknown_columns");
        assert!(
            p.messages[0].message.contains("'plan'")
                && !p.messages[0].message.contains("favorite_color")
        );
        assert_eq!(p.messages[1].code, "extra_fields");
        let stored = json!({"row": {"email": "a@x.test"}, "missing_cells": 3, "header_cells": 4});
        let p = prepare(&stored, &us(), TODAY);
        assert_eq!(p.messages[0].code, "missing_fields");
        assert!(
            p.messages[0].message.contains("1 cells"),
            "{}",
            p.messages[0].message
        );
    }

    #[test]
    fn contact_limits_and_external_ids() {
        let emails: Vec<String> = (0..12).map(|i| format!("u{i}@x.test")).collect();
        let p = prep(json!({"emails": emails}));
        assert_eq!(p.emails.len(), 10);
        assert_eq!(p.messages[0].code, "too_many_emails");
        let p = prep(json!({"email": "a@x.test", "external_id": "x".repeat(300)}));
        assert!(p.fatal);
        assert_eq!(p.messages[0].code, "invalid_external_id");
        let p = prep(json!({"email": "a@x.test", "external_id": 42}));
        assert_eq!(p.external_id.as_deref(), Some("42"));
        let p = prep(json!({"email": {"nested": true}, "phone": "+14155550101"}));
        assert_eq!(p.messages[0].code, "invalid_value");
        assert!(!p.fatal);
    }

    #[test]
    fn messages_are_bounded_per_row() {
        // Thousands of invalid items: five messages, then one summary.
        let junk: Vec<Value> = (0..4_000).map(|i| json!(i)).collect();
        let p = prep(json!({"email": "a@x.test", "emails": junk, "phones": "1;2;3;4;5;6;7"}));
        let emails: Vec<&RowMessage> = p
            .messages
            .iter()
            .filter(|m| m.code == "invalid_email")
            .collect();
        assert_eq!(emails.len(), MAX_ITEM_MESSAGES + 1);
        assert!(
            emails[MAX_ITEM_MESSAGES]
                .message
                .contains("3995 more invalid emails"),
            "{}",
            emails[MAX_ITEM_MESSAGES].message
        );
        let phones = p
            .messages
            .iter()
            .filter(|m| m.code == "invalid_phone")
            .count();
        assert_eq!(phones, MAX_ITEM_MESSAGES + 1);
        assert_eq!(p.emails, vec!["a@x.test"]);

        // A long rejected value is quoted in 80 characters, not in full.
        let long = format!("{}@", "x".repeat(5_000));
        let p =
            prep(json!({"email": long, "phone": "+14155550101", "timezone": "z".repeat(3_000)}));
        for m in &p.messages {
            assert!(m.message.len() < 400, "{}", m.message);
        }
        assert!(
            p.messages[0].message.contains('…'),
            "{}",
            p.messages[0].message
        );
        // And no message is ever longer than the cap.
        let m = RowMessage::warning("x", "y".repeat(10_000), None);
        assert_eq!(m.message.chars().count(), MAX_MESSAGE_CHARS);
    }

    #[test]
    fn stored_rows_with_ignored_columns_and_extra_cells() {
        let stored = json!({"row": {"email": "a@x.test"}, "ignored": ["plan", "notes"], "ignored_count": 9,
                            "extra_cells": 2, "header_cells": 4});
        let p = prepare(&stored, &us(), TODAY);
        assert_eq!(p.messages[0].code, "unknown_columns");
        assert!(
            p.messages[0]
                .message
                .contains("'plan', 'notes' and 7 more columns"),
            "{}",
            p.messages[0].message
        );
        assert_eq!(p.messages[1].code, "extra_fields");
        assert!(
            p.messages[1]
                .message
                .contains("6 cells but the header has 4 columns; the 2 extra cells"),
            "{}",
            p.messages[1].message
        );
    }

    #[test]
    fn the_primary_identifier_is_the_first_email_else_the_first_phone() {
        let p = prep(json!({"phone": "+14155550101", "emails": "b@x.test;c@x.test"}));
        assert_eq!(p.primary_identifier(), Some("b@x.test"));
        assert_eq!(p.other_identifiers(), vec!["c@x.test", "+14155550101"]);
        let p = prep(json!({"phones": ["+14155550101", "+14155550102"]}));
        assert_eq!(p.primary_identifier(), Some("+14155550101"));
        assert_eq!(p.other_identifiers(), vec!["+14155550102"]);
        let p = prep(json!({"email": "a@x.test"}));
        assert!(p.other_identifiers().is_empty());
    }
}
