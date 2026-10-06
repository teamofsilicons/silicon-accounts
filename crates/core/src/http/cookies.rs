//! Cookies: `sa_session` (browser session), `sa_flow` (hosted sign-in flow binding),
//! `sa_signup` (sign-up session). With ACCOUNTS_COOKIE_SECURE the names get the `__Host-`
//! prefix (Secure, Path=/, no Domain). All are HttpOnly and SameSite=Lax.

use axum::http::header::{COOKIE, SET_COOKIE};
use axum::http::{HeaderMap, HeaderValue};
use cookie::{Cookie, SameSite};

use crate::config::Settings;

/// Browser session cookie base name.
pub const SESSION_COOKIE: &str = "sa_session";
/// Flow-binding cookie base name.
pub const FLOW_COOKIE: &str = "sa_flow";
/// Sign-up session cookie base name.
pub const SIGNUP_COOKIE: &str = "sa_signup";

/// Session cookie lifetime (900 days).
pub const SESSION_MAX_AGE: time::Duration = time::Duration::days(900);
/// Flow cookie lifetime (60 minutes, like the flow).
pub const FLOW_MAX_AGE: time::Duration = time::Duration::minutes(60);
/// Sign-up cookie lifetime (48 hours, like the sign-up session).
pub const SIGNUP_MAX_AGE: time::Duration = time::Duration::hours(48);

/// The real cookie name: `__Host-{base}` when cookies are secure, else `{base}`.
pub fn cookie_name(settings: &Settings, base: &str) -> String {
    if settings.cookie_secure {
        format!("__Host-{base}")
    } else {
        base.to_string()
    }
}

/// Reads a cookie by base name from the request headers.
pub fn read_cookie(headers: &HeaderMap, settings: &Settings, base: &str) -> Option<String> {
    let name = cookie_name(settings, base);
    for header in headers.get_all(COOKIE) {
        let Ok(raw) = header.to_str() else { continue };
        for c in Cookie::split_parse(raw).flatten() {
            if c.name() == name {
                let v = c.value().trim().to_string();
                if !v.is_empty() {
                    return Some(v);
                }
            }
        }
    }
    None
}

/// Builds a cookie with the standard attributes.
pub fn build_cookie(
    settings: &Settings,
    base: &str,
    value: String,
    max_age: time::Duration,
) -> Cookie<'static> {
    Cookie::build((cookie_name(settings, base), value))
        .http_only(true)
        .same_site(SameSite::Lax)
        .path("/")
        .secure(settings.cookie_secure)
        .max_age(max_age)
        .build()
}

/// `sa_session` cookie for a session token.
pub fn session_cookie(settings: &Settings, token: &str) -> Cookie<'static> {
    build_cookie(settings, SESSION_COOKIE, token.to_string(), SESSION_MAX_AGE)
}

/// `sa_flow` cookie for a flow binding token.
pub fn flow_cookie(settings: &Settings, token: &str) -> Cookie<'static> {
    build_cookie(settings, FLOW_COOKIE, token.to_string(), FLOW_MAX_AGE)
}

/// `sa_signup` cookie for a sign-up session token.
pub fn signup_cookie(settings: &Settings, token: &str) -> Cookie<'static> {
    build_cookie(settings, SIGNUP_COOKIE, token.to_string(), SIGNUP_MAX_AGE)
}

/// A cookie that deletes `base` in the browser.
pub fn clear_cookie(settings: &Settings, base: &str) -> Cookie<'static> {
    let mut c = build_cookie(settings, base, String::new(), time::Duration::ZERO);
    c.set_expires(time::OffsetDateTime::UNIX_EPOCH);
    c
}

/// Appends a `Set-Cookie` header.
pub fn append_cookie(headers: &mut HeaderMap, cookie: &Cookie<'_>) {
    if let Ok(v) = HeaderValue::from_str(&cookie.to_string()) {
        headers.append(SET_COOKIE, v);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_and_attributes() {
        let mut s = Settings::for_tests();
        assert_eq!(cookie_name(&s, SESSION_COOKIE), "sa_session");
        let c = session_cookie(&s, "sas_x").to_string();
        assert!(c.starts_with("sa_session=sas_x"));
        assert!(c.contains("HttpOnly") && c.contains("SameSite=Lax") && c.contains("Path=/"));
        assert!(!c.contains("Secure"));
        s.cookie_secure = true;
        let c = session_cookie(&s, "sas_x").to_string();
        assert!(c.starts_with("__Host-sa_session=sas_x") && c.contains("Secure"));
        assert!(
            clear_cookie(&s, FLOW_COOKIE)
                .to_string()
                .contains("Max-Age=0")
        );
    }

    #[test]
    fn reads_cookie_from_headers() {
        let s = Settings::for_tests();
        let mut h = HeaderMap::new();
        h.append(
            COOKIE,
            HeaderValue::from_static("a=1; sa_session=sas_abc; sa_flow=saf_x"),
        );
        assert_eq!(
            read_cookie(&h, &s, SESSION_COOKIE).as_deref(),
            Some("sas_abc")
        );
        assert_eq!(read_cookie(&h, &s, FLOW_COOKIE).as_deref(), Some("saf_x"));
        assert_eq!(read_cookie(&h, &s, SIGNUP_COOKIE), None);
    }
}
