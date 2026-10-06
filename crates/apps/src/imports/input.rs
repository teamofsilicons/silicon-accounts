//! The import request: a CSV file (`text/csv`, options as query parameters) or a JSON body
//! (`{"rows":[…],"options":{…}}`) → one stored document per row plus validated options.
//!
//! Whole-request problems are refused before a job exists, each with a precise 4xx: unknown
//! columns (unless `ignore_unknown_columns`), duplicate columns, a CSV without any identifier
//! column, an empty file, more than 100,000 rows, invalid UTF-8 or JSON, unknown or invalid
//! options, and structure past the limits below. Everything about a single row is decided later
//! by the job ([`super::rules`]), so one bad row never blocks the other 99,999.
//!
//! Cost. Parsing is linear in the body and its memory is bounded: the JSON body is streamed
//! (never held as one document), every check uses hash sets, and each row is kept as compact
//! JSON text, so a parsed import takes about as much memory as its body. Limits (all refused
//! with a 422 that names the row and the column): at most [`MAX_COLUMNS`] columns (a CSV header,
//! the keys of one JSON row, the distinct column names of a JSON body), column names of at most
//! [`MAX_COLUMN_NAME_BYTES`] bytes, values of at most [`MAX_CELL_BYTES`] bytes and JSON arrays of
//! at most [`MAX_LIST_ITEMS`] items. These are far above any real export (only 12 columns are
//! import columns, and an account keeps at most 10 emails and 10 phone numbers).
//!
//! Stored row (`import_job_rows.input`): `{"row": {import column: value as received},
//! "ignored"?: [column names], "ignored_count"?: n, "extra_cells"?: n, "missing_cells"?: n,
//! "header_cells"?: n}`. Values of columns that aren't import columns (accepted with
//! `ignore_unknown_columns`) and cells past the end of the CSV header are never stored — only
//! which columns held something — so an import can't park data Silicon Accounts doesn't keep.
//! NUL characters, which Postgres can't store in JSON, become U+FFFD.

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::str::FromStr;

use accounts_core::{ApiError, FieldErrors};
use axum::http::StatusCode;
use serde::de::{self, DeserializeSeed, IgnoredAny, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Number, Value};

/// Most rows one import may carry.
pub const MAX_ROWS: usize = 100_000;
/// Largest import body.
pub const MAX_BYTES: usize = 50 * 1024 * 1024;
/// Most columns: of a CSV header, of one JSON row, and distinct column names in a JSON body.
pub const MAX_COLUMNS: usize = 200;
/// Longest column name, in bytes.
pub const MAX_COLUMN_NAME_BYTES: usize = 200;
/// Largest value of an import column, in bytes (for a JSON array: all its text together).
pub const MAX_CELL_BYTES: usize = 8 * 1024;
/// Most items in one JSON array value (nested values count too).
pub const MAX_LIST_ITEMS: usize = 50;
/// How many names of ignored columns one row keeps for its warning (the rest are counted).
pub const MAX_IGNORED_NAMES_PER_ROW: usize = 5;
/// Most field problems one 422 lists.
const MAX_FIELD_ERRORS: usize = 20;

/// The only columns an import accepts (`name` is an alias of `display_name`).
pub const ALLOWED_COLUMNS: &[&str] = &[
    "external_id",
    "email",
    "emails",
    "phone",
    "phones",
    "display_name",
    "name",
    "username",
    "dob",
    "timezone",
    "pfp_url",
    "email_verified",
];

/// Columns that identify an account.
pub const IDENTIFIER_COLUMNS: &[&str] = &["email", "emails", "phone", "phones"];

/// Import options (`options` in the JSON body, or query parameters for CSV).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImportOptions {
    /// ISO 3166 alpha-2 country for phone numbers written without a country code.
    #[serde(default)]
    pub default_country: Option<String>,
    /// Import anyway when there are unknown columns (each affected row gets a warning).
    #[serde(default)]
    pub ignore_unknown_columns: bool,
    /// Validate and report every row without writing anything.
    #[serde(default)]
    pub dry_run: bool,
    /// For rows matching an account that is already a member: refresh the membership's
    /// imported profile and external_id (never the account's own data).
    #[serde(default)]
    pub update_existing: bool,
}

/// Body format.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Csv,
    Json,
}

impl Format {
    pub fn as_str(&self) -> &'static str {
        match self {
            Format::Csv => "csv",
            Format::Json => "json",
        }
    }
}

/// A validated import request.
#[derive(Debug, Clone)]
pub struct ParsedImport {
    pub format: Format,
    pub options: ImportOptions,
    /// One stored row per input row, as compact JSON text (see the module docs).
    pub rows: Vec<String>,
    /// Unknown columns (only non-empty when `ignore_unknown_columns` is on).
    pub unknown_columns: Vec<String>,
}

/// Options as given by one source (query or body); `None` = not given.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct PartialOptions {
    default_country: Option<Option<String>>,
    ignore_unknown_columns: Option<bool>,
    dry_run: Option<bool>,
    update_existing: Option<bool>,
}

const OPTION_NAMES: &str = "default_country, ignore_unknown_columns, dry_run, update_existing";

/// Normalizes a column name: trimmed, BOM removed, lowercase.
pub fn normalize_column(name: &str) -> String {
    name.trim_start_matches('\u{feff}')
        .trim()
        .to_ascii_lowercase()
}

/// True when `normalized` is an accepted column.
pub fn is_allowed_column(normalized: &str) -> bool {
    ALLOWED_COLUMNS.contains(&normalized)
}

/// The column a normalized name stands for (`name` is `display_name`), when it is one.
pub fn canonical_column(normalized: &str) -> Option<&'static str> {
    match normalized {
        "name" => Some("display_name"),
        other => ALLOWED_COLUMNS.iter().copied().find(|c| *c == other),
    }
}

/// Text Postgres can store in `jsonb` (which refuses NUL): NUL becomes U+FFFD.
pub fn storable(s: &str) -> String {
    if s.contains('\0') {
        s.replace('\0', "\u{FFFD}")
    } else {
        s.to_string()
    }
}

/// A name shown in a message: at most 80 characters.
fn shown(s: &str) -> String {
    let cut: String = s.chars().take(80).collect();
    if cut.len() < s.len() {
        format!("'{cut}…'")
    } else {
        format!("'{cut}'")
    }
}

fn parse_bool(v: &str) -> Option<bool> {
    match v.trim().to_ascii_lowercase().as_str() {
        "true" | "1" | "yes" | "on" => Some(true),
        "false" | "0" | "no" | "off" => Some(false),
        _ => None,
    }
}

fn validate_country(v: &str) -> Result<String, String> {
    let c = v.trim().to_ascii_uppercase();
    if c.len() == 2 && phonenumber::country::Id::from_str(&c).is_ok() {
        Ok(c)
    } else {
        Err(format!(
            "{} is not an ISO 3166 two-letter country code (like US, IN or GB)",
            shown(v.trim())
        ))
    }
}

fn query_options(query: Option<&str>) -> Result<PartialOptions, ApiError> {
    let mut out = PartialOptions::default();
    let Some(query) = query else {
        return Ok(out);
    };
    let bad = |message: String| {
        ApiError::bad_request("invalid_query", message).hint(format!(
            "Import options as query parameters are {OPTION_NAMES}, e.g. ?default_country=US&dry_run=true."
        ))
    };
    for (k, v) in url::form_urlencoded::parse(query.as_bytes()) {
        let flag = |v: &str| {
            parse_bool(v).ok_or_else(|| {
                bad(format!(
                    "The query parameter '{k}' is {}; use true or false.",
                    shown(v)
                ))
            })
        };
        match k.as_ref() {
            "default_country" => {
                out.default_country = Some(if v.trim().is_empty() {
                    None
                } else {
                    Some(validate_country(&v).map_err(|m| {
                        bad(format!(
                            "The query parameter 'default_country' is invalid: {m}."
                        ))
                    })?)
                })
            }
            "ignore_unknown_columns" => out.ignore_unknown_columns = Some(flag(&v)?),
            "dry_run" => out.dry_run = Some(flag(&v)?),
            "update_existing" => out.update_existing = Some(flag(&v)?),
            other => {
                return Err(bad(format!(
                    "The query parameter {} is not an import option; the options are {OPTION_NAMES}.",
                    shown(other)
                )));
            }
        }
    }
    Ok(out)
}

fn body_options(v: Option<&Value>, errors: &mut FieldErrors) -> PartialOptions {
    let mut out = PartialOptions::default();
    let Some(v) = v else { return out };
    let map = match v {
        Value::Null => return out,
        Value::Object(m) => m,
        _ => {
            errors.add("options", format!("must be an object with {OPTION_NAMES}"));
            return out;
        }
    };
    for (k, v) in map {
        let path = format!("options.{k}");
        let flag = |v: &Value, errors: &mut FieldErrors| match v {
            Value::Bool(b) => Some(*b),
            Value::Null => None,
            Value::String(s) => match parse_bool(s) {
                Some(b) => Some(b),
                None => {
                    errors.add(path.clone(), "must be true or false");
                    None
                }
            },
            _ => {
                errors.add(path.clone(), "must be true or false");
                None
            }
        };
        match k.as_str() {
            "default_country" => match v {
                Value::Null => out.default_country = Some(None),
                Value::String(s) if s.trim().is_empty() => out.default_country = Some(None),
                Value::String(s) => match validate_country(s) {
                    Ok(c) => out.default_country = Some(Some(c)),
                    Err(m) => errors.add(path.clone(), m),
                },
                _ => errors.add(path.clone(), "must be a two-letter country code like US"),
            },
            "ignore_unknown_columns" => out.ignore_unknown_columns = flag(v, errors),
            "dry_run" => out.dry_run = flag(v, errors),
            "update_existing" => out.update_existing = flag(v, errors),
            _ => errors.add(
                path.clone(),
                format!("unknown option; the options are {OPTION_NAMES}"),
            ),
        }
    }
    out
}

/// Merges query and body options; the same option given twice with different values is refused
/// (a silently ignored `dry_run` would write data the caller only meant to check).
fn merge_options(query: PartialOptions, body: PartialOptions) -> Result<ImportOptions, ApiError> {
    let mut conflicts = FieldErrors::new();
    fn pick<T: PartialEq + Clone + std::fmt::Debug>(
        name: &str,
        q: Option<T>,
        b: Option<T>,
        conflicts: &mut FieldErrors,
    ) -> Option<T> {
        match (q, b) {
            (Some(q), Some(b)) if q != b => {
                conflicts.add(
                    format!("options.{name}"),
                    format!("is {b:?} in the body but {q:?} in the query string; give it once"),
                );
                Some(b)
            }
            (_, Some(b)) => Some(b),
            (q, None) => q,
        }
    }
    let options = ImportOptions {
        default_country: pick(
            "default_country",
            query.default_country,
            body.default_country,
            &mut conflicts,
        )
        .flatten(),
        ignore_unknown_columns: pick(
            "ignore_unknown_columns",
            query.ignore_unknown_columns,
            body.ignore_unknown_columns,
            &mut conflicts,
        )
        .unwrap_or(false),
        dry_run: pick("dry_run", query.dry_run, body.dry_run, &mut conflicts).unwrap_or(false),
        update_existing: pick(
            "update_existing",
            query.update_existing,
            body.update_existing,
            &mut conflicts,
        )
        .unwrap_or(false),
    };
    conflicts.into_result()?;
    Ok(options)
}

fn content_kind(content_type: Option<&str>) -> Option<Format> {
    let ct = content_type?;
    let mime = ct
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if mime == "application/json" || (mime.starts_with("application/") && mime.ends_with("+json")) {
        Some(Format::Json)
    } else if matches!(
        mime.as_str(),
        "text/csv" | "application/csv" | "text/comma-separated-values" | "application/vnd.ms-excel"
    ) {
        Some(Format::Csv)
    } else {
        None
    }
}

/// Parses and validates an import request (CPU-bound and linear in the body: callers on an
/// async runtime run it with `spawn_blocking`).
pub fn parse_request(
    content_type: Option<&str>,
    query: Option<&str>,
    body: &[u8],
) -> Result<ParsedImport, ApiError> {
    let format = content_kind(content_type).ok_or_else(|| {
        ApiError::bad_request(
            "invalid_content_type",
            match content_type {
                Some(ct) => format!("The import body is {}; imports take CSV (text/csv) or JSON (application/json).", shown(ct)),
                None => "The import has no Content-Type; imports take CSV (text/csv) or JSON (application/json).".into(),
            },
        )
        .hint("Send a CSV file with Content-Type: text/csv (options as query parameters), or {\"rows\":[…],\"options\":{…}} with Content-Type: application/json.")
    })?;
    let query_opts = query_options(query)?;
    let (body_opts, rows, unknown) = match format {
        Format::Csv => {
            let (rows, unknown) = parse_csv(body)?;
            (PartialOptions::default(), rows, unknown)
        }
        Format::Json => parse_json_body(body)?,
    };
    let options = merge_options(query_opts, body_opts)?;
    if !unknown.is_empty() && !options.ignore_unknown_columns {
        return Err(ApiError::unprocessable(
            "unknown_columns",
            format!(
                "The import has {} column{} Silicon Accounts doesn't keep: {}. An app's user base only has the columns we give, so nothing was imported.",
                unknown.len(),
                if unknown.len() == 1 { "" } else { "s" },
                unknown.iter().map(|c| shown(c)).collect::<Vec<_>>().join(", ")
            ),
        )
        .hint(format!(
            "Remove or rename those columns (allowed: {}), or send ignore_unknown_columns=true to import the rest and ignore them.",
            ALLOWED_COLUMNS.join(", ")
        ))
        .detail("unknown_columns", unknown)
        .detail("allowed_columns", ALLOWED_COLUMNS.to_vec()));
    }
    Ok(ParsedImport {
        format,
        options,
        rows,
        unknown_columns: unknown,
    })
}

fn too_many_rows(seen: usize) -> ApiError {
    ApiError::unprocessable(
        "too_many_rows",
        format!("The import has more than {MAX_ROWS} rows (stopped counting at {seen}); one import takes at most {MAX_ROWS}."),
    )
    .hint("Split the file into parts of at most 100,000 rows and import them one after another.")
    .detail("max_rows", MAX_ROWS)
}

fn empty_import(what: &str) -> ApiError {
    ApiError::unprocessable("empty_import", format!("The import has no rows: {what}."))
        .hint("Send at least one row: a CSV header line followed by data lines, or {\"rows\":[{\"email\":\"…\"}]}.")
}

fn invalid_csv(message: String) -> ApiError {
    ApiError::unprocessable("invalid_csv", message).hint(
        "Save the file as UTF-8 CSV with a header line (Excel: File → Save As → CSV UTF-8), then import it again.",
    )
}

/// Where a row is, for messages: CSV rows by data row and line, JSON rows by position.
#[derive(Debug, Clone, Copy)]
enum RowRef {
    Csv { row: usize, line: u64 },
    Json { row: usize },
}

impl RowRef {
    fn number(self) -> usize {
        match self {
            RowRef::Csv { row, .. } | RowRef::Json { row } => row,
        }
    }
}

impl fmt::Display for RowRef {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RowRef::Csv { row, line } => write!(f, "Row {row} (line {line})"),
            RowRef::Json { row } => write!(f, "Row {row} (rows[{}])", row - 1),
        }
    }
}

fn import_columns_hint() -> String {
    format!(
        "Send only the import columns ({}); other columns can't be imported anyway.",
        ALLOWED_COLUMNS.join(", ")
    )
}

fn too_many_columns(message: String) -> ApiError {
    ApiError::unprocessable("too_many_columns", message)
        .hint(import_columns_hint())
        .detail("max_columns", MAX_COLUMNS)
}

fn column_name_too_long(row: Option<RowRef>, name: &str) -> ApiError {
    let at = match row {
        Some(r) => format!("{r} has a column name"),
        None => "The CSV header has a column name".to_string(),
    };
    let mut e = ApiError::unprocessable(
        "value_too_large",
        format!(
            "{at} of {} bytes ({}); a column name can be at most {MAX_COLUMN_NAME_BYTES} bytes.",
            name.len(),
            shown(name)
        ),
    )
    .hint(import_columns_hint())
    .detail("max_bytes", MAX_COLUMN_NAME_BYTES);
    if let Some(r) = row {
        e = e.detail("row", r.number());
    }
    e
}

fn value_too_large(row: RowRef, column: &str, bytes: Option<usize>) -> ApiError {
    let size = match bytes {
        Some(n) => format!("is {n} bytes"),
        None => format!("is larger than {MAX_CELL_BYTES} bytes"),
    };
    ApiError::unprocessable(
        "value_too_large",
        format!(
            "{row}: the {} value {size}; one value can be at most {MAX_CELL_BYTES} bytes ({} KB).",
            shown(column),
            MAX_CELL_BYTES / 1024
        ),
    )
    .hint("Fix that row: no import column holds that much. Emails and phones are short, and profile photos must be https URLs, not inline data.")
    .detail("row", row.number())
    .detail("column", storable(column))
    .detail("max_bytes", MAX_CELL_BYTES)
}

fn too_many_items(row: RowRef, column: &str) -> ApiError {
    ApiError::unprocessable(
        "too_many_items",
        format!(
            "{row}: the {} value has more than {MAX_LIST_ITEMS} items (nested values count too); an account keeps at most 10 emails and 10 phone numbers.",
            shown(column)
        ),
    )
    .hint("Fix that row: list one person's own emails and phones, one row per person.")
    .detail("row", row.number())
    .detail("column", storable(column))
    .detail("max_items", MAX_LIST_ITEMS)
}

fn duplicate_column_in_row(row: RowRef, column: &str, first: &str, second: &str) -> ApiError {
    ApiError::unprocessable(
        "duplicate_columns",
        format!(
            "{row} has the column {column} twice ({} and {}); column names are case-insensitive and name is the same column as display_name.",
            shown(first),
            shown(second)
        ),
    )
    .hint("Keep one key per field in each row; put extra emails or phones in the emails / phones list.")
    .detail("row", row.number())
    .detail("duplicate_columns", vec![storable(first), storable(second)])
}

/// What a CSV column holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ColumnKind {
    Import,
    Unknown,
    Unnamed,
}

/// The stored document of one row (see the module docs) as compact JSON text.
fn finish_row(
    cells: Map<String, Value>,
    ignored: Vec<Value>,
    ignored_count: usize,
    mut extra: Map<String, Value>,
) -> String {
    extra.insert("row".into(), Value::Object(cells));
    if ignored_count > 0 {
        extra.insert("ignored".into(), Value::Array(ignored));
        extra.insert("ignored_count".into(), Value::from(ignored_count));
    }
    Value::Object(extra).to_string()
}

/// CSV → stored rows + unknown columns.
fn parse_csv(body: &[u8]) -> Result<(Vec<String>, Vec<String>), ApiError> {
    let body = body.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(body);
    if body.iter().all(u8::is_ascii_whitespace) {
        return Err(empty_import("the CSV body is empty"));
    }
    let mut reader = csv::ReaderBuilder::new()
        .flexible(true)
        .has_headers(true)
        .from_reader(body);
    let headers = reader
        .headers()
        .map_err(|e| invalid_csv(format!("The CSV header line can't be read: {e}.")))?
        .clone();
    if headers.len() > MAX_COLUMNS {
        return Err(too_many_columns(format!(
            "The CSV header has {} columns; an import can have at most {MAX_COLUMNS} (only {} are import columns).",
            headers.len(),
            ALLOWED_COLUMNS.len()
        )));
    }

    // Column names as written (BOM stripped, trimmed); unnamed columns get a placeholder so two
    // of them never collide.
    let mut names: Vec<String> = Vec::with_capacity(headers.len());
    let mut kinds: Vec<ColumnKind> = Vec::with_capacity(headers.len());
    let mut has_identifier = false;
    let mut seen: HashSet<String> = HashSet::with_capacity(headers.len());
    let mut duplicates: Vec<String> = Vec::new();
    for (i, h) in headers.iter().enumerate() {
        let written = h.trim_start_matches('\u{feff}').trim();
        if written.len() > MAX_COLUMN_NAME_BYTES {
            return Err(column_name_too_long(None, written));
        }
        let norm = normalize_column(h);
        if norm.is_empty() {
            names.push(format!("(unnamed column {})", i + 1));
            kinds.push(ColumnKind::Unnamed);
            continue;
        }
        has_identifier |= IDENTIFIER_COLUMNS.contains(&norm.as_str());
        // `name` is display_name under another spelling; both at once would be ambiguous.
        let canonical = canonical_column(&norm);
        if !seen.insert(
            canonical
                .map(str::to_string)
                .unwrap_or_else(|| norm.clone()),
        ) {
            duplicates.push(storable(written));
        }
        names.push(storable(written));
        kinds.push(if canonical.is_some() {
            ColumnKind::Import
        } else {
            ColumnKind::Unknown
        });
    }
    if !duplicates.is_empty() {
        return Err(ApiError::unprocessable(
            "duplicate_columns",
            format!(
                "The CSV header names the same column more than once: {} (names are case-insensitive and `name` is the same column as `display_name`).",
                duplicates.iter().map(|c| shown(c)).collect::<Vec<_>>().join(", ")
            ),
        )
        .hint("Keep one column per field; put extra emails or phones in the emails / phones column, separated by ';'.")
        .detail("duplicate_columns", duplicates));
    }
    if !has_identifier {
        return Err(ApiError::unprocessable(
            "no_identifier_columns",
            format!(
                "The CSV has no email, emails, phone or phones column (its columns are {}), so no row could be matched to an account or create one.",
                names.iter().map(|c| shown(c)).collect::<Vec<_>>().join(", ")
            ),
        )
        .hint("Every imported user needs at least one email or phone number; add an email or phone column."));
    }

    let header_cells = names.len();
    let mut rows: Vec<String> = Vec::new();
    let mut unnamed_with_values = vec![false; header_cells];
    let mut record = csv::StringRecord::new();
    loop {
        match reader.read_record(&mut record) {
            Ok(true) => {}
            Ok(false) => break,
            Err(e) => {
                let at = e
                    .position()
                    .map(|p| format!(" at data row {} (line {})", p.record(), p.line()))
                    .unwrap_or_default();
                return Err(match e.kind() {
                    csv::ErrorKind::Utf8 { .. } => invalid_csv(format!(
                        "The CSV is not valid UTF-8{at}; imports must be UTF-8 text."
                    )),
                    _ => invalid_csv(format!("The CSV can't be read{at}: {e}.")),
                });
            }
        }
        // A line of only whitespace is a blank line, not a row.
        if record.len() == 1
            && record.get(0).is_some_and(|c| c.trim().is_empty())
            && header_cells > 1
        {
            continue;
        }
        if rows.len() >= MAX_ROWS {
            return Err(too_many_rows(rows.len() + 1));
        }
        let at = RowRef::Csv {
            row: rows.len() + 1,
            line: record.position().map(|p| p.line()).unwrap_or(0),
        };
        let mut cells = Map::new();
        let mut ignored: Vec<Value> = Vec::new();
        let mut ignored_count = 0usize;
        for (i, cell) in record.iter().enumerate().take(header_cells) {
            match kinds[i] {
                ColumnKind::Import => {
                    if cell.len() > MAX_CELL_BYTES {
                        return Err(value_too_large(at, &names[i], Some(cell.len())));
                    }
                    cells.insert(names[i].clone(), Value::String(storable(cell)));
                }
                ColumnKind::Unknown | ColumnKind::Unnamed => {
                    if cell.trim().is_empty() {
                        continue;
                    }
                    unnamed_with_values[i] |= kinds[i] == ColumnKind::Unnamed;
                    ignored_count += 1;
                    if ignored.len() < MAX_IGNORED_NAMES_PER_ROW {
                        ignored.push(Value::String(names[i].clone()));
                    }
                }
            }
        }
        let mut shape = Map::new();
        if record.len() > header_cells {
            // Cells without a column: only how many there were is kept, never their values.
            if record
                .iter()
                .skip(header_cells)
                .any(|c| !c.trim().is_empty())
            {
                shape.insert(
                    "extra_cells".into(),
                    Value::from(record.len() - header_cells),
                );
                shape.insert("header_cells".into(), Value::from(header_cells));
            }
        } else if record.len() < header_cells {
            shape.insert(
                "missing_cells".into(),
                Value::from(header_cells - record.len()),
            );
            shape.insert("header_cells".into(), Value::from(header_cells));
        }
        rows.push(finish_row(cells, ignored, ignored_count, shape));
    }
    if rows.is_empty() {
        return Err(empty_import("the CSV has a header line but no data rows"));
    }
    let mut unknown: Vec<String> = Vec::new();
    for (i, kind) in kinds.iter().enumerate() {
        match kind {
            // An unnamed, empty column is a trailing comma, not data.
            ColumnKind::Unnamed if unnamed_with_values[i] => unknown.push(names[i].clone()),
            ColumnKind::Unknown => unknown.push(names[i].clone()),
            _ => {}
        }
    }
    Ok((rows, unknown))
}

// ---------------------------------------------------------------------------------------------
// JSON: a streaming parser over the body (serde visitors), so no row, value or list is ever held
// beyond the limits above.

/// What parsing a JSON import body found.
#[derive(Default)]
struct JsonState {
    /// The problem that stopped parsing (a limit, or the shape of `rows`).
    fatal: Option<ApiError>,
    /// Problems reported together (rows that aren't objects, unknown fields, options).
    errors: FieldErrors,
    /// The body is an object (so a type error is about a value inside it).
    entered: bool,
    seen_rows: bool,
    seen_options: bool,
    options: Option<Value>,
    rows: Vec<String>,
    /// Distinct unknown columns, first spelling, in order of appearance.
    unknown: Vec<String>,
    unknown_normalized: HashSet<String>,
}

impl JsonState {
    /// Records why parsing stops and returns the error that unwinds the deserializer.
    fn stop<E: de::Error>(&mut self, e: ApiError) -> E {
        if self.fatal.is_none() {
            self.fatal = Some(e);
        }
        E::custom("the import was refused")
    }

    fn problem(&mut self, path: impl Into<String>, message: impl Into<String>) {
        if self.errors.len() < MAX_FIELD_ERRORS {
            self.errors.add(path, message);
        }
    }

    fn rows_not_an_array<E: de::Error>(&mut self, found: &str) -> E {
        let mut f = self.errors.clone();
        f.add(
            "rows",
            format!("must be an array of row objects, not {found}"),
        );
        self.stop(ApiError::validation(f))
    }
}

/// Visitor methods for the JSON types a visitor doesn't take; each calls `$wrong(found)`.
macro_rules! other_scalars {
    ($wrong:ident) => {
        fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> {
            self.$wrong("null")
        }
        fn visit_bool<E: de::Error>(self, _: bool) -> Result<Self::Value, E> {
            self.$wrong("true or false")
        }
        fn visit_i64<E: de::Error>(self, _: i64) -> Result<Self::Value, E> {
            self.$wrong("a number")
        }
        fn visit_u64<E: de::Error>(self, _: u64) -> Result<Self::Value, E> {
            self.$wrong("a number")
        }
        fn visit_f64<E: de::Error>(self, _: f64) -> Result<Self::Value, E> {
            self.$wrong("a number")
        }
        fn visit_str<E: de::Error>(self, _: &str) -> Result<Self::Value, E> {
            self.$wrong("a string")
        }
    };
}

/// The body: `{"rows":[…],"options":{…}}`.
struct BodyVisitor<'a>(&'a mut JsonState);

impl<'de> Visitor<'de> for BodyVisitor<'_> {
    type Value = ();

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("a JSON object {\"rows\":[…],\"options\":{…}}")
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<(), A::Error> {
        let st = self.0;
        st.entered = true;
        while let Some(key) = map.next_key::<String>()? {
            match key.as_str() {
                "rows" => {
                    if st.seen_rows {
                        let mut f = FieldErrors::new();
                        f.add("rows", "appears twice in the body; send one rows array");
                        return Err(st.stop(ApiError::validation(f)));
                    }
                    st.seen_rows = true;
                    map.next_value_seed(RowsSeed(&mut *st))?;
                }
                "options" => {
                    if st.seen_options {
                        let mut f = FieldErrors::new();
                        f.add(
                            "options",
                            "appears twice in the body; send one options object",
                        );
                        return Err(st.stop(ApiError::validation(f)));
                    }
                    st.seen_options = true;
                    let mut budget = Budget::new();
                    let value = map.next_value_seed(CellSeed {
                        st: &mut *st,
                        at: CellAt::Options,
                        budget: &mut budget,
                    })?;
                    st.options = Some(value);
                }
                other => {
                    let path: String = other.chars().take(80).collect();
                    st.problem(
                        storable(&path),
                        "unknown field; the body is {\"rows\":[…],\"options\":{…}} (import options go inside options)",
                    );
                    map.next_value::<IgnoredAny>()?;
                }
            }
        }
        Ok(())
    }
}

/// `rows`: the array of row objects.
struct RowsSeed<'a>(&'a mut JsonState);

impl<'de> DeserializeSeed<'de> for RowsSeed<'_> {
    type Value = ();
    fn deserialize<D: de::Deserializer<'de>>(self, d: D) -> Result<(), D::Error> {
        d.deserialize_any(self)
    }
}

impl RowsSeed<'_> {
    fn wrong<E: de::Error>(self, found: &str) -> Result<(), E> {
        Err(self.0.rows_not_an_array(found))
    }
}

impl<'de> Visitor<'de> for RowsSeed<'_> {
    type Value = ();

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("an array of row objects")
    }

    other_scalars!(wrong);

    fn visit_map<A: MapAccess<'de>>(self, _: A) -> Result<(), A::Error> {
        Err(self.0.rows_not_an_array("an object"))
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<(), A::Error> {
        let st = self.0;
        let mut index = 0usize;
        loop {
            if index == MAX_ROWS {
                return match seq.next_element::<IgnoredAny>()? {
                    Some(_) => Err(st.stop(too_many_rows(MAX_ROWS + 1))),
                    None => Ok(()),
                };
            }
            match seq.next_element_seed(RowSeed {
                st: &mut *st,
                index,
            })? {
                Some(()) => index += 1,
                None => return Ok(()),
            }
        }
    }
}

/// One row object.
struct RowSeed<'a> {
    st: &'a mut JsonState,
    index: usize,
}

impl<'de> DeserializeSeed<'de> for RowSeed<'_> {
    type Value = ();
    fn deserialize<D: de::Deserializer<'de>>(self, d: D) -> Result<(), D::Error> {
        d.deserialize_any(self)
    }
}

impl RowSeed<'_> {
    /// A row that isn't an object: reported with the others, parsing goes on.
    fn wrong<E: de::Error>(self, _found: &str) -> Result<(), E> {
        self.st.problem(
            format!("rows[{}]", self.index),
            "must be an object of column → value",
        );
        Ok(())
    }
}

impl<'de> Visitor<'de> for RowSeed<'_> {
    type Value = ();

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("a row object")
    }

    other_scalars!(wrong);

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<(), A::Error> {
        while seq.next_element::<IgnoredAny>()?.is_some() {}
        self.wrong("an array")
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<(), A::Error> {
        let RowSeed { st, index } = self;
        let at = RowRef::Json { row: index + 1 };
        let mut cells = Map::new();
        let mut columns: HashMap<&'static str, String> = HashMap::new();
        let mut ignored: Vec<Value> = Vec::new();
        let mut ignored_count = 0usize;
        let mut keys = 0usize;
        while let Some(key) = map.next_key_seed(KeySeed { st: &mut *st, at })? {
            keys += 1;
            if keys > MAX_COLUMNS {
                return Err(st.stop(too_many_columns(format!(
                    "{at} has more than {MAX_COLUMNS} columns; a row can have at most {MAX_COLUMNS} (only {} are import columns).",
                    ALLOWED_COLUMNS.len()
                ))));
            }
            let normalized = normalize_column(&key);
            match canonical_column(&normalized) {
                Some(column) => {
                    if let Some(first) = columns.get(column) {
                        return Err(st.stop(duplicate_column_in_row(at, column, first, &key)));
                    }
                    let mut budget = Budget::new();
                    let value = map.next_value_seed(CellSeed {
                        st: &mut *st,
                        at: CellAt::Row {
                            row: at,
                            column: &key,
                        },
                        budget: &mut budget,
                    })?;
                    cells.insert(storable(&key), value);
                    columns.insert(column, key);
                }
                None => {
                    if st.unknown_normalized.insert(normalized) {
                        if st.unknown_normalized.len() > MAX_COLUMNS {
                            return Err(st.stop(too_many_columns(format!(
                                "The rows use more than {MAX_COLUMNS} different columns; an import can have at most {MAX_COLUMNS} (only {} are import columns).",
                                ALLOWED_COLUMNS.len()
                            ))));
                        }
                        st.unknown.push(storable(key.trim()));
                    }
                    // Only whether it held something is kept, never the value.
                    if !map.next_value_seed(BlankSeed)? {
                        ignored_count += 1;
                        if ignored.len() < MAX_IGNORED_NAMES_PER_ROW {
                            ignored.push(Value::String(storable(key.trim())));
                        }
                    }
                }
            }
        }
        st.rows
            .push(finish_row(cells, ignored, ignored_count, Map::new()));
        Ok(())
    }
}

/// A column name, refused past [`MAX_COLUMN_NAME_BYTES`] before it is copied.
struct KeySeed<'a> {
    st: &'a mut JsonState,
    at: RowRef,
}

impl<'de> DeserializeSeed<'de> for KeySeed<'_> {
    type Value = String;
    fn deserialize<D: de::Deserializer<'de>>(self, d: D) -> Result<String, D::Error> {
        d.deserialize_str(self)
    }
}

impl<'de> Visitor<'de> for KeySeed<'_> {
    type Value = String;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("a column name")
    }

    fn visit_str<E: de::Error>(self, s: &str) -> Result<String, E> {
        if s.len() > MAX_COLUMN_NAME_BYTES {
            return Err(self.st.stop(column_name_too_long(Some(self.at), s)));
        }
        Ok(s.to_string())
    }
}

/// What one value may still use.
struct Budget {
    items: usize,
    bytes: usize,
}

impl Budget {
    fn new() -> Self {
        Budget {
            items: MAX_LIST_ITEMS,
            bytes: MAX_CELL_BYTES,
        }
    }
}

/// Where a value is, for messages.
#[derive(Clone, Copy)]
enum CellAt<'k> {
    Options,
    Row { row: RowRef, column: &'k str },
}

impl CellAt<'_> {
    fn too_large(self) -> ApiError {
        match self {
            CellAt::Options => ApiError::unprocessable(
                "value_too_large",
                format!("The options object is larger than {MAX_CELL_BYTES} bytes; it only holds {OPTION_NAMES}."),
            )
            .hint("Send options like {\"default_country\":\"US\",\"dry_run\":true}."),
            CellAt::Row { row, column } => value_too_large(row, column, None),
        }
    }

    fn too_many(self) -> ApiError {
        match self {
            CellAt::Options => ApiError::unprocessable(
                "too_many_items",
                format!("The options object has more than {MAX_LIST_ITEMS} values; it only holds {OPTION_NAMES}."),
            )
            .hint("Send options like {\"default_country\":\"US\",\"dry_run\":true}."),
            CellAt::Row { row, column } => too_many_items(row, column),
        }
    }
}

/// A value of an import column (or the options object), kept as received within a [`Budget`].
struct CellSeed<'a, 'k> {
    st: &'a mut JsonState,
    at: CellAt<'k>,
    budget: &'a mut Budget,
}

impl<'de> DeserializeSeed<'de> for CellSeed<'_, '_> {
    type Value = Value;
    fn deserialize<D: de::Deserializer<'de>>(self, d: D) -> Result<Value, D::Error> {
        d.deserialize_any(self)
    }
}

impl CellSeed<'_, '_> {
    fn text<E: de::Error>(self, s: &str) -> Result<Value, E> {
        if s.len() > self.budget.bytes {
            return Err(self.st.stop(self.at.too_large()));
        }
        self.budget.bytes -= s.len();
        Ok(Value::String(storable(s)))
    }

    fn item<E: de::Error>(&mut self) -> Result<(), E> {
        if self.budget.items == 0 {
            return Err(self.st.stop(self.at.too_many()));
        }
        self.budget.items -= 1;
        Ok(())
    }
}

impl<'de> Visitor<'de> for CellSeed<'_, '_> {
    type Value = Value;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("a value")
    }

    fn visit_unit<E: de::Error>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }
    fn visit_bool<E: de::Error>(self, b: bool) -> Result<Value, E> {
        Ok(Value::Bool(b))
    }
    fn visit_i64<E: de::Error>(self, n: i64) -> Result<Value, E> {
        Ok(Value::Number(n.into()))
    }
    fn visit_u64<E: de::Error>(self, n: u64) -> Result<Value, E> {
        Ok(Value::Number(n.into()))
    }
    fn visit_f64<E: de::Error>(self, n: f64) -> Result<Value, E> {
        Ok(Number::from_f64(n).map_or(Value::Null, Value::Number))
    }
    fn visit_str<E: de::Error>(self, s: &str) -> Result<Value, E> {
        self.text(s)
    }

    fn visit_seq<A: SeqAccess<'de>>(mut self, mut seq: A) -> Result<Value, A::Error> {
        let mut items = Vec::new();
        loop {
            let next = seq.next_element_seed(CellSeed {
                st: &mut *self.st,
                at: self.at,
                budget: &mut *self.budget,
            })?;
            let Some(v) = next else { break };
            self.item()?;
            items.push(v);
        }
        Ok(Value::Array(items))
    }

    fn visit_map<A: MapAccess<'de>>(mut self, mut map: A) -> Result<Value, A::Error> {
        let mut object = Map::new();
        while let Some(key) = map.next_key::<String>()? {
            if key.len() > self.budget.bytes {
                return Err(self.st.stop(self.at.too_large()));
            }
            self.budget.bytes -= key.len();
            let value = map.next_value_seed(CellSeed {
                st: &mut *self.st,
                at: self.at,
                budget: &mut *self.budget,
            })?;
            self.item()?;
            object.insert(storable(&key), value);
        }
        Ok(Value::Object(object))
    }
}

/// Whether a value of an ignored column is blank (null, blank text, a list of blanks), read
/// without keeping it.
struct BlankSeed;

impl<'de> DeserializeSeed<'de> for BlankSeed {
    type Value = bool;
    fn deserialize<D: de::Deserializer<'de>>(self, d: D) -> Result<bool, D::Error> {
        d.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for BlankSeed {
    type Value = bool;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("a value")
    }

    fn visit_unit<E: de::Error>(self) -> Result<bool, E> {
        Ok(true)
    }
    fn visit_bool<E: de::Error>(self, _: bool) -> Result<bool, E> {
        Ok(false)
    }
    fn visit_i64<E: de::Error>(self, _: i64) -> Result<bool, E> {
        Ok(false)
    }
    fn visit_u64<E: de::Error>(self, _: u64) -> Result<bool, E> {
        Ok(false)
    }
    fn visit_f64<E: de::Error>(self, _: f64) -> Result<bool, E> {
        Ok(false)
    }
    fn visit_str<E: de::Error>(self, s: &str) -> Result<bool, E> {
        Ok(s.trim().is_empty())
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<bool, A::Error> {
        let mut blank = true;
        while let Some(b) = seq.next_element_seed(BlankSeed)? {
            blank &= b;
        }
        Ok(blank)
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<bool, A::Error> {
        while map.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
        Ok(false)
    }
}

/// JSON body → options, stored rows, unknown columns.
fn parse_json_body(body: &[u8]) -> Result<(PartialOptions, Vec<String>, Vec<String>), ApiError> {
    if body.iter().all(u8::is_ascii_whitespace) {
        return Err(empty_import("the JSON body is empty"));
    }
    let mut st = JsonState::default();
    let mut de = serde_json::Deserializer::from_slice(body);
    let parsed =
        de::Deserializer::deserialize_any(&mut de, BodyVisitor(&mut st)).and_then(|()| de.end());
    if let Err(e) = parsed {
        if let Some(refused) = st.fatal.take() {
            return Err(refused);
        }
        use serde_json::error::Category;
        return Err(match e.classify() {
            // A type error before the body was an object: the body itself is the wrong type.
            Category::Data if !st.entered => {
                let mut f = FieldErrors::new();
                f.add(
                    "",
                    "the body must be a JSON object {\"rows\":[…],\"options\":{…}}",
                );
                ApiError::validation(f)
            }
            _ => ApiError::bad_request(
                "invalid_json",
                format!("The import body is not valid JSON: {e}."),
            )
            .hint("Send {\"rows\":[{\"email\":\"…\"}],\"options\":{…}} as UTF-8 JSON, or a CSV file with Content-Type: text/csv."),
        });
    }
    let mut errors = std::mem::take(&mut st.errors);
    let options = body_options(st.options.as_ref(), &mut errors);
    if !st.seen_rows {
        errors.add(
            "rows",
            "is required: an array of row objects like {\"email\":\"…\"}",
        );
    }
    errors.into_result()?;
    if st.rows.is_empty() {
        return Err(empty_import("rows is an empty array"));
    }
    Ok((options, st.rows, st.unknown))
}

/// 413 for a body over the import limit.
pub fn payload_too_large() -> ApiError {
    ApiError::new(
        StatusCode::PAYLOAD_TOO_LARGE,
        "payload_too_large",
        format!(
            "The import body is larger than {} MB.",
            MAX_BYTES / (1024 * 1024)
        ),
    )
    .hint("Split the file into smaller parts (at most 50 MB and 100,000 rows each).")
    .detail("max_bytes", MAX_BYTES)
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use serde_json::json;

    use super::*;

    fn csv(body: &str) -> Result<ParsedImport, ApiError> {
        parse_request(Some("text/csv"), None, body.as_bytes())
    }

    fn row(p: &ParsedImport, i: usize) -> Value {
        serde_json::from_str(&p.rows[i]).expect("stored rows are JSON")
    }

    /// Debug builds are slow; the point is "milliseconds, not minutes".
    const FAST: Duration = Duration::from_secs(3);

    #[test]
    fn csv_with_bom_crlf_quotes_and_ragged_rows() {
        let body = "\u{feff}external_id,Email,display_name\r\n1,a@x.test,\"Smith, John\"\r\n2,b@x.test,\"Lin\nHopper\"\r\n3,c@x.test,x,extra\r\n4,d@x.test\r\n\r\n";
        let p = csv(body).expect("parses");
        assert_eq!(p.rows.len(), 4);
        assert_eq!(row(&p, 0)["row"]["external_id"], "1");
        assert_eq!(row(&p, 0)["row"]["Email"], "a@x.test");
        assert_eq!(row(&p, 0)["row"]["display_name"], "Smith, John");
        assert_eq!(row(&p, 1)["row"]["display_name"], "Lin\nHopper");
        // Cells past the header: only how many, never their values.
        assert_eq!(row(&p, 2)["extra_cells"], 1);
        assert_eq!(row(&p, 2)["header_cells"], 3);
        assert!(!p.rows[2].contains("extra\""), "{}", p.rows[2]);
        assert_eq!(row(&p, 3)["missing_cells"], 1);
        assert!(p.unknown_columns.is_empty());
    }

    #[test]
    fn unknown_columns_are_refused_unless_ignored_and_never_stored() {
        let body = "email,favorite_color,plan\na@x.test,teal,pro\nb@x.test,,\n";
        let e = csv(body).expect_err("unknown");
        assert_eq!(e.code, "unknown_columns");
        assert_eq!(
            e.details["unknown_columns"],
            json!(["favorite_color", "plan"])
        );
        assert!(
            e.details["allowed_columns"]
                .as_array()
                .is_some_and(|a| a.len() == ALLOWED_COLUMNS.len())
        );
        let p = parse_request(
            Some("text/csv"),
            Some("ignore_unknown_columns=true"),
            body.as_bytes(),
        )
        .expect("ignored");
        assert_eq!(p.unknown_columns, vec!["favorite_color", "plan"]);
        assert_eq!(
            row(&p, 0),
            json!({"row": {"email": "a@x.test"}, "ignored": ["favorite_color", "plan"], "ignored_count": 2})
        );
        assert_eq!(row(&p, 1), json!({"row": {"email": "b@x.test"}}));
        assert!(!p.rows[0].contains("teal") && !p.rows[0].contains("pro\""));
        // A trailing comma (unnamed, empty column) is not an unknown column.
        assert!(csv("email,\na@x.test,\n").is_ok());
        assert_eq!(
            csv("email,\na@x.test,surprise\n")
                .expect_err("unnamed")
                .code,
            "unknown_columns"
        );

        let json_body = br#"{"rows":[{"email":"a@x.test","plan":"pro","Notes":["secret"],"blank":" "}],"options":{"ignore_unknown_columns":true}}"#;
        let p = parse_request(Some("application/json"), None, json_body).expect("json");
        assert_eq!(p.unknown_columns, vec!["plan", "Notes", "blank"]);
        assert_eq!(
            row(&p, 0),
            json!({"row": {"email": "a@x.test"}, "ignored": ["plan", "Notes"], "ignored_count": 2})
        );
    }

    #[test]
    fn structural_errors() {
        assert_eq!(csv("").expect_err("empty").code, "empty_import");
        assert_eq!(csv("email\n").expect_err("no rows").code, "empty_import");
        assert_eq!(
            csv("display_name\nx\n").expect_err("no id").code,
            "no_identifier_columns"
        );
        assert_eq!(
            csv("email,Email\na,b\n").expect_err("dup").code,
            "duplicate_columns"
        );
        assert_eq!(
            csv("email,name,display_name\na,b,c\n")
                .expect_err("alias dup")
                .code,
            "duplicate_columns"
        );
        let bad =
            parse_request(Some("text/csv"), None, b"email\n\xff\xfe@x.test\n").expect_err("utf8");
        assert_eq!(bad.code, "invalid_csv");
        assert_eq!(
            parse_request(Some("text/plain"), None, b"email\na@x.test\n")
                .expect_err("ct")
                .code,
            "invalid_content_type"
        );
        let mut big = String::from("email\n");
        for i in 0..=MAX_ROWS {
            big.push_str(&format!("u{i}@x.test\n"));
        }
        assert_eq!(csv(&big).expect_err("too many").code, "too_many_rows");
        let mut big = String::from("{\"rows\":[");
        for i in 0..=MAX_ROWS {
            if i > 0 {
                big.push(',');
            }
            big.push_str("{\"email\":\"u@x.test\"}");
        }
        big.push_str("]}");
        let e = parse_request(Some("application/json"), None, big.as_bytes()).expect_err("rows");
        assert_eq!(e.code, "too_many_rows");
    }

    #[test]
    fn nul_characters_become_replacement_characters() {
        let p = csv("email,display_name\na@x.test,Ada\u{0}Lovelace\n").expect("parses");
        assert_eq!(row(&p, 0)["row"]["display_name"], "Ada\u{FFFD}Lovelace");
        let p = parse_request(
            Some("application/json"),
            None,
            br#"{"rows":[{"email":"a@x.test","name\u0000":"x","display_name":"A\u0000B"}],"options":{"ignore_unknown_columns":true}}"#,
        )
        .expect("json");
        assert_eq!(row(&p, 0)["row"]["display_name"], "A\u{FFFD}B");
        assert!(!p.rows[0].contains("\\u0000"), "{}", p.rows[0]);
        assert!(p.unknown_columns.iter().all(|c| !c.contains('\0')));
    }

    #[test]
    fn options_from_query_and_body() {
        let p = parse_request(
            Some("text/csv"),
            Some("default_country=us&dry_run=1&update_existing=false"),
            b"email\na@x.test\n",
        )
        .expect("ok");
        assert_eq!(
            p.options,
            ImportOptions {
                default_country: Some("US".into()),
                ignore_unknown_columns: false,
                dry_run: true,
                update_existing: false
            }
        );
        let e = parse_request(Some("text/csv"), Some("dryrun=true"), b"email\na@x.test\n")
            .expect_err("typo");
        assert_eq!(e.code, "invalid_query");
        assert!(e.message.contains("dryrun"));
        let e = parse_request(
            Some("text/csv"),
            Some("default_country=Narnia"),
            b"email\na@x.test\n",
        )
        .expect_err("country");
        assert!(e.message.contains("Narnia"));

        let body = br#"{"rows":[{"Email":"a@x.test","name":"A"}],"options":{"default_country":"in","dry_run":true}}"#;
        let p = parse_request(Some("application/json"), None, body).expect("json");
        assert_eq!(p.format, Format::Json);
        assert_eq!(p.options.default_country.as_deref(), Some("IN"));
        assert!(p.options.dry_run);
        assert_eq!(row(&p, 0)["row"]["Email"], "a@x.test");

        let e = parse_request(
            Some("application/json"),
            None,
            br#"{"rows":[{"email":"a@x.test"}],"dry_run":true}"#,
        )
        .expect_err("misplaced option");
        assert_eq!(
            e.details["fields"]["dry_run"]
                .as_str()
                .map(|s| s.contains("inside options")),
            Some(true)
        );
        let e = parse_request(
            Some("application/json"),
            None,
            br#"{"rows":[{"email":"a@x.test"}],"options":{"dry":true}}"#,
        )
        .expect_err("unknown option");
        assert!(e.details["fields"]["options.dry"].is_string());
        let e = parse_request(
            Some("application/json"),
            Some("dry_run=false"),
            br#"{"rows":[{"email":"a@x.test"}],"options":{"dry_run":true}}"#,
        )
        .expect_err("conflict");
        assert!(e.details["fields"]["options.dry_run"].is_string());
        let e = parse_request(
            Some("application/json"),
            None,
            br#"{"rows":[1, {"email":"a@x.test"}, [2]]}"#,
        )
        .expect_err("row type");
        assert!(e.details["fields"]["rows[0]"].is_string());
        assert!(e.details["fields"]["rows[2]"].is_string());
        let e = parse_request(
            Some("application/json"),
            None,
            br#"{"rows":[{"email":"a@x.test","plan":"pro"}]}"#,
        )
        .expect_err("unknown");
        assert_eq!(e.code, "unknown_columns");
        assert_eq!(
            parse_request(Some("application/json"), None, br#"{"rows":[]}"#)
                .expect_err("empty")
                .code,
            "empty_import"
        );
        assert_eq!(
            parse_request(Some("application/json"), None, b"{nope")
                .expect_err("syntax")
                .code,
            "invalid_json"
        );
        assert_eq!(
            parse_request(Some("application/json"), None, b"[1,2]")
                .expect_err("array body")
                .code,
            "validation_failed"
        );
        let e = parse_request(Some("application/json"), None, br#"{"rows": 5}"#)
            .expect_err("rows type");
        assert!(e.details["fields"]["rows"].is_string());
        let e = parse_request(Some("application/json"), None, br#"{"options": {}}"#)
            .expect_err("rows missing");
        assert!(e.details["fields"]["rows"].is_string());
    }

    #[test]
    fn json_rows_keep_values_as_received_within_limits() {
        let body = br#"{"rows":[{"emails":["a@x.test",2,null,{"n":1}],"email":{"nested":true},"dob":19900101}]}"#;
        let p = parse_request(Some("application/json"), None, body).expect("json");
        assert_eq!(
            row(&p, 0)["row"],
            json!({"emails": ["a@x.test", 2, null, {"n": 1}], "email": {"nested": true}, "dob": 19900101})
        );

        // A list longer than the limit names the row and the column.
        let items: Vec<String> = (0..=MAX_LIST_ITEMS).map(|_| "1".to_string()).collect();
        let body = format!(
            "{{\"rows\":[{{\"email\":\"a@x.test\"}},{{\"emails\":[{}]}}]}}",
            items.join(",")
        );
        let e = parse_request(Some("application/json"), None, body.as_bytes()).expect_err("items");
        assert_eq!(e.code, "too_many_items");
        assert_eq!(e.details["row"], 2);
        assert_eq!(e.details["column"], "emails");
        assert!(e.message.contains("Row 2 (rows[1])"), "{}", e.message);

        // A value larger than the limit (as text or spread over a list).
        let long = "x".repeat(MAX_CELL_BYTES + 1);
        let body = format!("{{\"rows\":[{{\"email\":\"a@x.test\",\"display_name\":\"{long}\"}}]}}");
        let e = parse_request(Some("application/json"), None, body.as_bytes()).expect_err("big");
        assert_eq!(e.code, "value_too_large");
        assert_eq!(e.details["column"], "display_name");
        let chunk = "y".repeat(MAX_CELL_BYTES / 4);
        let body = format!(
            "{{\"rows\":[{{\"emails\":[\"{chunk}\",\"{chunk}\",\"{chunk}\",\"{chunk}\",\"{chunk}\"]}}]}}"
        );
        let e = parse_request(Some("application/json"), None, body.as_bytes()).expect_err("sum");
        assert_eq!(e.code, "value_too_large");
        let csv_body = format!("email,display_name\na@x.test,{long}\n");
        let e = csv(&csv_body).expect_err("csv cell");
        assert_eq!(e.code, "value_too_large");
        assert_eq!(e.details["row"], 1);
        assert!(e.message.contains("Row 1 (line 2)"), "{}", e.message);
        // Values of ignored columns aren't kept, so they aren't limited either.
        let body = format!(
            "{{\"rows\":[{{\"email\":\"a@x.test\",\"notes\":\"{long}\"}}],\"options\":{{\"ignore_unknown_columns\":true}}}}"
        );
        let p = parse_request(Some("application/json"), None, body.as_bytes()).expect("ignored");
        assert!(p.rows[0].len() < 200, "{}", p.rows[0]);

        // The same column twice in one row is ambiguous.
        let e = parse_request(
            Some("application/json"),
            None,
            br#"{"rows":[{"email":"a@x.test","Email ":"b@x.test"}]}"#,
        )
        .expect_err("dup");
        assert_eq!(e.code, "duplicate_columns");
        let e = parse_request(
            Some("application/json"),
            None,
            br#"{"rows":[{"email":"a@x.test","name":"A","display_name":"B"}]}"#,
        )
        .expect_err("alias dup");
        assert_eq!(e.code, "duplicate_columns");
    }

    #[test]
    fn a_huge_csv_header_is_refused_in_linear_time() {
        let mut header: String = (0..100_000).map(|i| format!("c{i},")).collect();
        header.push_str("email\n");
        let body = format!("{header}{}a@x.test\n", ",".repeat(100_000));
        let t = Instant::now();
        let e = parse_request(
            Some("text/csv"),
            Some("ignore_unknown_columns=true"),
            body.as_bytes(),
        )
        .expect_err("too many");
        assert_eq!(e.code, "too_many_columns");
        assert_eq!(e.details["max_columns"], MAX_COLUMNS);
        assert!(t.elapsed() < FAST, "took {:?}", t.elapsed());

        // At the limit, every check is a hash lookup.
        let mut header: String = (0..MAX_COLUMNS - 1).map(|i| format!("c{i},")).collect();
        header.push_str("email\n");
        let mut body = header;
        for i in 0..2_000 {
            body.push_str(&",".repeat(MAX_COLUMNS - 1));
            body.push_str(&format!("u{i}@x.test\n"));
        }
        let t = Instant::now();
        let p = parse_request(
            Some("text/csv"),
            Some("ignore_unknown_columns=true"),
            body.as_bytes(),
        )
        .expect("at the limit");
        assert_eq!(p.unknown_columns.len(), MAX_COLUMNS - 1);
        assert!(t.elapsed() < FAST, "took {:?}", t.elapsed());

        let long = "n".repeat(MAX_COLUMN_NAME_BYTES + 1);
        let e = csv(&format!("email,{long}\na@x.test,1\n")).expect_err("long name");
        assert_eq!(e.code, "value_too_large");
    }

    #[test]
    fn many_distinct_json_keys_are_refused_in_linear_time() {
        // 100,000 rows that each bring a new unknown column.
        let mut body = String::from("{\"rows\":[");
        for i in 0..100_000 {
            if i > 0 {
                body.push(',');
            }
            body.push_str(&format!("{{\"email\":\"u{i}@x.test\",\"x{i}\":\"1\"}}"));
        }
        body.push_str("],\"options\":{\"ignore_unknown_columns\":true}}");
        let t = Instant::now();
        let e = parse_request(Some("application/json"), None, body.as_bytes()).expect_err("cols");
        assert_eq!(e.code, "too_many_columns");
        assert!(t.elapsed() < FAST, "took {:?}", t.elapsed());

        // One row with 100,000 keys.
        let mut body = String::from("{\"rows\":[{\"email\":\"a@x.test\"");
        for i in 0..100_000 {
            body.push_str(&format!(",\"k{i}\":1"));
        }
        body.push_str("}]}");
        let t = Instant::now();
        let e = parse_request(Some("application/json"), None, body.as_bytes()).expect_err("keys");
        assert_eq!(e.code, "too_many_columns");
        assert!(e.message.contains("Row 1"), "{}", e.message);
        assert!(t.elapsed() < FAST, "took {:?}", t.elapsed());
    }

    #[test]
    fn a_list_of_millions_of_items_is_refused_without_holding_it() {
        // The body the review used to drive 1.6 GB of memory: one row, millions of tiny items.
        let n = 2_000_000usize;
        let mut body = String::with_capacity(n * 2 + 64);
        body.push_str("{\"rows\":[{\"email\":\"a@x.test\",\"emails\":[");
        for i in 0..n {
            if i > 0 {
                body.push(',');
            }
            body.push('1');
        }
        body.push_str("]}]}");
        let t = Instant::now();
        let e = parse_request(Some("application/json"), None, body.as_bytes()).expect_err("items");
        assert_eq!(e.code, "too_many_items");
        assert!(t.elapsed() < FAST, "took {:?}", t.elapsed());
    }
}
