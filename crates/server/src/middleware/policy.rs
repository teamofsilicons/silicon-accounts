//! Response policy: security headers, CORS and JSON error bodies.
//!
//! Security headers (02-api.md): every response gets `X-Content-Type-Options: nosniff` and
//! `Referrer-Policy: strict-origin-when-cross-origin`, plus `Strict-Transport-Security` when
//! cookies are secure (production). HTML gets the site CSP [`SPA_CSP`] (`frame-ancestors
//! 'none'`) and `X-Frame-Options: DENY` unless the handler set its own policy (the embed page
//! does, and marks its response with [`AllowFraming`]). JSON under `/v1` defaults to
//! `Cache-Control: no-store` (tokens, codes and personal data must never sit in a cache) and a
//! `default-src 'none'` CSP.
//!
//! CORS: `Access-Control-Allow-Origin: *` (and preflights) only for `/v1/apps/{app_id}/public`,
//! `/sdk/*` and `/.well-known/*`. Every other response leaves without CORS headers, even if a
//! handler added some: credentials-bearing endpoints must never be readable cross-origin, and
//! this is the one place that decides it.
//!
//! Errors: a 4xx/5xx whose body is not JSON (axum's 405, a plain-text framework rejection, an
//! empty 404 from the static file server) is rewritten into the API error shape
//! `{"error":{"code","message","hint"}}` — or an RFC 6749 body on the OAuth token, revocation
//! and introspection endpoints ([`super::errors`]) — keeping its headers (`Allow`,
//! `Retry-After`, …).

use accounts_core::{ApiError, AppState, Settings};
use axum::extract::{Request, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};

use crate::middleware::errors;
use crate::middleware::limits::payload_too_large;
use crate::paths;

/// CSP for the account site and every HTML page without a policy of its own.
pub const SPA_CSP: &str = "default-src 'self'; img-src 'self' https: data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'self' https:; base-uri 'none'";

/// CSP for JSON responses (nothing in them may load or be framed).
pub const API_CSP: &str = "default-src 'none'; frame-ancestors 'none'";

/// HSTS when cookies are secure (production): two years, subdomains included.
pub const HSTS: &str = "max-age=63072000; includeSubDomains";

/// Response extension: this HTML page sets its own `frame-ancestors` and may be framed by the
/// origins listed there, so no `X-Frame-Options: DENY` is added.
#[derive(Debug, Clone, Copy)]
pub struct AllowFraming;

/// Applies the response policy around the rest of the stack.
pub async fn response_policy(State(state): State<AppState>, req: Request, next: Next) -> Response {
    let method = req.method().clone();
    let path = req.uri().path().to_owned();
    let public_cors = paths::is_public_cors_path(&path);
    if method == Method::OPTIONS
        && public_cors
        && req
            .headers()
            .contains_key(header::ACCESS_CONTROL_REQUEST_METHOD)
    {
        let mut response = preflight(req.headers());
        finish(&mut response, &state.settings, &path, true);
        return response;
    }
    let response = next.run(req).await;
    let mut response = json_errors(response, &method, &path).await;
    finish(&mut response, &state.settings, &path, public_cors);
    response
}

/// `204` answer to a CORS preflight on a public resource.
fn preflight(request_headers: &HeaderMap) -> Response {
    let mut response = StatusCode::NO_CONTENT.into_response();
    let h = response.headers_mut();
    h.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET, HEAD, OPTIONS"),
    );
    h.insert(
        header::ACCESS_CONTROL_MAX_AGE,
        HeaderValue::from_static("86400"),
    );
    // Echo the requested headers only when they are a plain list of header names.
    if let Some(requested) = request_headers
        .get(header::ACCESS_CONTROL_REQUEST_HEADERS)
        .and_then(|v| v.to_str().ok())
        .filter(|v| {
            v.len() <= 512
                && v.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_, ".contains(&b))
        })
        && let Ok(v) = HeaderValue::from_str(requested)
    {
        h.insert(header::ACCESS_CONTROL_ALLOW_HEADERS, v);
    }
    response
}

fn content_type(headers: &HeaderMap) -> String {
    headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase()
}

fn is_json(headers: &HeaderMap) -> bool {
    let ct = content_type(headers);
    ct == "application/json" || (ct.starts_with("application/") && ct.ends_with("+json"))
}

fn is_html(headers: &HeaderMap) -> bool {
    content_type(headers) == "text/html"
}

/// CORS + security headers.
pub fn finish(response: &mut Response, settings: &Settings, path: &str, public_cors: bool) {
    let allow_framing = response.extensions().get::<AllowFraming>().is_some();
    let h = response.headers_mut();
    if public_cors {
        h.insert(
            header::ACCESS_CONTROL_ALLOW_ORIGIN,
            HeaderValue::from_static("*"),
        );
        h.insert(
            header::ACCESS_CONTROL_EXPOSE_HEADERS,
            HeaderValue::from_static("x-request-id"),
        );
        h.remove(header::ACCESS_CONTROL_ALLOW_CREDENTIALS);
    } else {
        let cors: Vec<HeaderName> = h
            .keys()
            .filter(|k| k.as_str().starts_with("access-control-"))
            .cloned()
            .collect();
        for name in cors {
            h.remove(name);
        }
    }
    h.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    h.entry(header::REFERRER_POLICY)
        .or_insert(HeaderValue::from_static("strict-origin-when-cross-origin"));
    if settings.cookie_secure {
        h.insert(
            header::STRICT_TRANSPORT_SECURITY,
            HeaderValue::from_static(HSTS),
        );
    }
    if is_html(h) {
        h.entry(header::CONTENT_SECURITY_POLICY)
            .or_insert(HeaderValue::from_static(SPA_CSP));
        if !allow_framing {
            h.entry(header::X_FRAME_OPTIONS)
                .or_insert(HeaderValue::from_static("DENY"));
        }
    } else if is_json(h) {
        h.entry(header::CONTENT_SECURITY_POLICY)
            .or_insert(HeaderValue::from_static(API_CSP));
        if path == "/v1" || path.starts_with("/v1/") {
            h.entry(header::CACHE_CONTROL)
                .or_insert(HeaderValue::from_static("no-store"));
        }
    }
}

/// The stable error code for a status without one.
fn code_for(status: StatusCode) -> &'static str {
    match status.as_u16() {
        400 => "invalid_request",
        401 => "unauthenticated",
        403 => "forbidden",
        404 => "not_found",
        405 => "method_not_allowed",
        406 => "not_acceptable",
        408 => "request_timeout",
        409 => "conflict",
        410 => "gone",
        411 => "length_required",
        413 => "payload_too_large",
        414 => "uri_too_long",
        415 => "unsupported_media_type",
        416 => "range_not_satisfiable",
        422 => "validation_failed",
        423 => "locked",
        429 => "rate_limited",
        501 => "not_implemented",
        502 => "bad_gateway",
        503 => "unavailable",
        504 => "gateway_timeout",
        s if s >= 500 => "internal",
        _ => "request_failed",
    }
}

const DOCS_HINT: &str = "Check the method, path and body against the API reference at https://account.teamofsilicons.com/docs.";

/// Rewrites a non-JSON error response into the API error shape.
async fn json_errors(response: Response, method: &Method, path: &str) -> Response {
    let status = response.status();
    if !(status.is_client_error() || status.is_server_error())
        || is_json(response.headers())
        || is_html(response.headers())
    {
        return response;
    }
    let (parts, body) = response.into_parts();
    let text = match axum::body::to_bytes(body, 8 * 1024).await {
        Ok(bytes) => String::from_utf8_lossy(&bytes).trim().to_string(),
        Err(_) => String::new(),
    };
    let allow = parts
        .headers
        .get(header::ALLOW)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let error = match status {
        StatusCode::METHOD_NOT_ALLOWED => {
            // axum adds the `Allow` header after route layers run, so it is usually not
            // visible here; it is on the final response either way.
            let (message, hint) = match allow.as_deref().filter(|a| !a.is_empty()) {
                Some(a) => (
                    format!("{method} is not allowed on {path}; it accepts {a}."),
                    format!("Send the request with one of: {a}."),
                ),
                None => (
                    format!(
                        "{method} is not allowed on {path}; the Allow header of this response lists the methods it accepts."
                    ),
                    "Send the request with one of the methods in the Allow header.".to_string(),
                ),
            };
            ApiError::new(status, "method_not_allowed", message).hint(hint)
        }
        StatusCode::PAYLOAD_TOO_LARGE => payload_too_large(method, path, None),
        StatusCode::NOT_FOUND if paths::is_asset_path(path) => ApiError::not_found(
            "not_found",
            format!("The file {path} does not exist in this build of the account site."),
        )
        .hint("The site was probably updated since this page loaded; reload the page."),
        StatusCode::NOT_FOUND => {
            ApiError::not_found("not_found", format!("Nothing exists at {method} {path}."))
                .hint(DOCS_HINT)
        }
        s if s.is_server_error() => {
            let context = if text.is_empty() {
                format!("{method} {path} answered {s} without a body")
            } else {
                format!("{method} {path} answered {s}: {text}")
            };
            // Logs the original text; the caller only sees the generic message + request id.
            let mut e = ApiError::internal(context);
            e.status = s;
            e.code = code_for(s).into();
            e
        }
        s => {
            let message = if text.is_empty() {
                format!(
                    "{method} {path} was refused: {}.",
                    s.canonical_reason().unwrap_or("the request is invalid")
                )
            } else {
                let mut t: String = text.chars().take(500).collect();
                if !t.ends_with('.') {
                    t.push('.');
                }
                t
            };
            ApiError::new(s, code_for(s), message).hint(DOCS_HINT)
        }
    };
    let mut rebuilt = errors::render(path, error);
    // Keep every original header (all values: e.g. several Set-Cookie) except the body's own.
    for name in parts.headers.keys() {
        if name == header::CONTENT_TYPE
            || name == header::CONTENT_LENGTH
            || name == header::CONTENT_ENCODING
            || rebuilt.headers().contains_key(name)
        {
            continue;
        }
        for value in parts.headers.get_all(name) {
            rebuilt.headers_mut().append(name.clone(), value.clone());
        }
    }
    rebuilt.extensions_mut().extend(parts.extensions);
    rebuilt
}
