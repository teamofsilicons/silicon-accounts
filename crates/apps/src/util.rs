//! Small helpers shared by the route modules.

use accounts_core::ApiError;
use accounts_core::http::{AppActor, AppOrOwner};
use time::OffsetDateTime;

/// `"app:{app_id}"` or `"account:{uuid}"`: who is calling, for idempotency scopes.
pub fn caller_scope(auth: &AppOrOwner) -> String {
    match &auth.actor {
        AppActor::App => format!("app:{}", auth.app.app_id),
        AppActor::Owner(a) => format!("account:{}", a.uuid),
    }
}

/// Microseconds since the Unix epoch: the exact precision Postgres stores, so keyset cursors
/// built from it never skip or repeat rows (millisecond strings would).
pub fn micros(t: OffsetDateTime) -> i64 {
    (t.unix_timestamp_nanos() / 1000) as i64
}

/// Inverse of [`micros`].
pub fn from_micros(us: i64) -> Result<OffsetDateTime, ApiError> {
    OffsetDateTime::from_unix_timestamp_nanos(i128::from(us) * 1000).map_err(|_| {
        ApiError::bad_request("invalid_cursor", "The cursor is not valid for this list.")
            .hint("Pass the next_cursor value from the previous page unchanged, or omit cursor to start over.")
    })
}

/// `%q%` for `ILIKE`, with `%`, `_` and `\` in the search text escaped.
pub fn like_contains(q: &str) -> String {
    let mut out = String::with_capacity(q.len() + 2);
    out.push('%');
    for c in q.chars() {
        if matches!(c, '%' | '_' | '\\') {
            out.push('\\');
        }
        out.push(c);
    }
    out.push('%');
    out
}

/// Parses an optional enum-like query value, naming the parameter and the accepted values.
pub fn parse_choice<T>(
    param: &str,
    value: Option<&str>,
    parse: impl Fn(&str) -> Option<T>,
    expected: &str,
) -> Result<Option<T>, ApiError> {
    match value.map(str::trim).filter(|v| !v.is_empty()) {
        None => Ok(None),
        Some(v) => parse(v).map(Some).ok_or_else(|| {
            ApiError::bad_request(
                "invalid_query",
                format!("The query parameter '{param}' is '{v}', which is not one of {expected}."),
            )
            .hint(format!(
                "Use {param}={} (or leave it out).",
                expected.split(", ").next().unwrap_or("")
            ))
        }),
    }
}

/// Logo URLs: https, or an inline `data:image/...` URI of at most 128 KB (same rule as the
/// branding logos of the sign-in config).
pub fn validate_logo_url(u: &str) -> Result<(), String> {
    if let Some(rest) = u.strip_prefix("data:") {
        let ok_type = [
            "image/png",
            "image/jpeg",
            "image/webp",
            "image/gif",
            "image/svg+xml",
        ]
        .iter()
        .any(|t| rest.starts_with(t));
        if !ok_type {
            return Err("data URIs must be data:image/png, jpeg, webp, gif or svg+xml".into());
        }
        if u.len() > 128 * 1024 {
            return Err(
                "inline data URIs must be at most 128 KB; host the logo and use an https URL"
                    .into(),
            );
        }
        return Ok(());
    }
    accounts_core::normalize::validate_https_url(u).map(|_| ())
}

/// An absolute http(s) URL (homepages may be plain http during development).
pub fn validate_http_url(u: &str) -> Result<(), String> {
    if u.len() > 2048 {
        return Err("the URL is longer than 2048 characters".into());
    }
    let parsed = url::Url::parse(u)
        .map_err(|_| format!("'{u}' is not an absolute URL like https://app.example.com/"))?;
    match parsed.scheme() {
        "https" | "http" if parsed.host_str().is_some() => Ok(()),
        "https" | "http" => Err(format!("'{u}' has no host")),
        s => Err(format!("'{u}' uses the '{s}' scheme; use https")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn like_patterns_escape_wildcards() {
        assert_eq!(like_contains("ada"), "%ada%");
        assert_eq!(like_contains("50%_off\\"), "%50\\%\\_off\\\\%");
    }

    #[test]
    fn micros_round_trip() {
        let t = OffsetDateTime::from_unix_timestamp_nanos(1_759_752_000_123_456_000).expect("time");
        assert_eq!(from_micros(micros(t)).expect("back"), t);
    }

    #[test]
    fn logo_and_homepage_rules() {
        assert!(validate_logo_url("https://cdn.example.com/logo.svg").is_ok());
        assert!(validate_logo_url("data:image/svg+xml;base64,PHN2Zz4=").is_ok());
        assert!(validate_logo_url("data:text/html,<script>").is_err());
        assert!(validate_logo_url("http://cdn.example.com/logo.svg").is_err());
        assert!(validate_http_url("http://127.0.0.1:8593/briefcase/").is_ok());
        assert!(validate_http_url("javascript:alert(1)").is_err());
    }
}
