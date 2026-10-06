//! Response helpers.

use accounts_core::OAuthError;
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Serialize;

/// JSON that must never be stored by a cache: tokens, token metadata and account data
/// (`Cache-Control: no-store` and `Pragma: no-cache`, RFC 6749 §5.1).
pub(crate) fn no_store<T: Serialize>(status: StatusCode, body: &T) -> Response {
    let mut response = (status, axum::Json(body)).into_response();
    let headers = response.headers_mut();
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(header::PRAGMA, HeaderValue::from_static("no-cache"));
    response
}

/// A public JSON document clients may cache briefly (discovery, JWKS).
pub(crate) fn cacheable<T: Serialize>(body: &T, max_age_seconds: u32) -> Response {
    let mut response = axum::Json(body).into_response();
    if let Ok(v) = HeaderValue::from_str(&format!("public, max-age={max_age_seconds}")) {
        response.headers_mut().insert(header::CACHE_CONTROL, v);
    }
    response
}

/// Renders an RFC 6749 error whose `error_description` keeps to the characters RFC 6749 §5.2
/// allows (printable ASCII without `"` and `\`).
pub(crate) fn oauth_error(mut e: OAuthError) -> Response {
    e.description = rfc6749_text(&e.description);
    e.into_response()
}

/// Maps text onto printable ASCII without `"` and `\` (RFC 6749 §5.2 / RFC 6750 §3), keeping
/// it readable: quotes become `'`, dashes `-`, `…` `...`, `§` `section `, other characters `?`.
pub(crate) fn rfc6749_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '"' | '\u{2018}' | '\u{2019}' | '\u{201C}' | '\u{201D}' => out.push('\''),
            '\\' => out.push('/'),
            '\u{2026}' => out.push_str("..."),
            '\u{2013}' | '\u{2014}' | '\u{2212}' => out.push('-'),
            '\u{00A7}' => out.push_str("section "),
            '\u{2192}' => out.push_str("->"),
            ' ' => out.push(' '),
            c if c.is_ascii_graphic() => out.push(c),
            c if c.is_whitespace() => out.push(' '),
            _ => out.push('?'),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn descriptions_keep_to_the_rfc_character_set() {
        let s = rfc6749_text("Use \"sar_…\" — see §6\\x\n→ ok é");
        assert_eq!(s, "Use 'sar_...' - see section 6/x -> ok ?");
        assert!(
            s.bytes()
                .all(|b| (0x20..=0x7E).contains(&b) && b != b'"' && b != b'\\')
        );
    }
}
