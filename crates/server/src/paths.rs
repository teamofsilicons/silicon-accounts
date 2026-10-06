//! Path rules shared by the middleware and the fallback: which paths belong to the API, which
//! are public cross-origin resources, and how large / slow each kind of request may be.

use std::time::Duration;

use axum::http::Method;

/// Path prefixes the service owns. Everything else is the account site (single-page app).
pub const API_PREFIXES: [&str; 6] = [
    "/v1",
    "/.well-known",
    "/embed",
    "/sdk",
    "/healthz",
    "/readyz",
];

/// True for `/v1`, `/v1/…`, `/.well-known/…`, `/embed/…`, `/sdk/…`, `/healthz`, `/readyz`.
pub fn is_api_path(path: &str) -> bool {
    API_PREFIXES.iter().any(|prefix| {
        path == *prefix
            || path
                .strip_prefix(prefix)
                .is_some_and(|rest| rest.starts_with('/'))
    })
}

/// True for the hashed build assets (`/assets/…`), which never fall back to the SPA.
pub fn is_asset_path(path: &str) -> bool {
    path.starts_with("/assets/")
}

/// True for liveness / readiness probes (kept out of request logs and telemetry).
pub fn is_health_path(path: &str) -> bool {
    path == "/healthz" || path == "/readyz"
}

/// Resources any origin may read (`Access-Control-Allow-Origin: *`): an app's public sign-in
/// config, the SDK and discovery documents. Everything else sends no CORS headers.
pub fn is_public_cors_path(path: &str) -> bool {
    path.starts_with("/sdk/") || path.starts_with("/.well-known/") || is_app_public_config(path)
}

/// `/v1/apps/{app_id}/public`.
fn is_app_public_config(path: &str) -> bool {
    app_route(path).is_some_and(|(_, tail)| tail == "public")
}

/// The OAuth endpoints that answer errors as RFC 6749 bodies
/// (`{"error":"invalid_request","error_description":"…"}`), because generic OAuth/OIDC
/// libraries read `error` as a string: token, revocation and introspection.
pub const OAUTH_RFC6749_PATHS: [&str; 3] = [
    "/v1/oauth/token",
    "/v1/oauth/revoke",
    "/v1/oauth/introspect",
];

/// True for [`OAUTH_RFC6749_PATHS`]; errors the middleware makes there use the RFC 6749 shape.
pub fn is_oauth_rfc6749_path(path: &str) -> bool {
    OAUTH_RFC6749_PATHS.contains(&path)
}

/// Request classes with their own body limit and time budget.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RouteClass {
    /// Everything else: 64 KB, 30 s.
    Default,
    /// The photo uploads (`POST /v1/me/photo`, `POST /v1/me/silicons/{uuid}/photo`,
    /// `POST /v1/flows/{id}/signup/photo`): 2 MB, 60 s.
    PhotoUpload,
    /// `POST /v1/apps/{app_id}/imports`: 50 MB of rows (+64 KB for the JSON envelope, so the
    /// import handler can answer with its own precise row/byte errors), 5 min.
    Import,
    /// `POST /v1/internal/apps/sync` (Silicon Apps stand-in; apps carry inline logos): 5 MB, 60 s.
    InternalSync,
    /// `PATCH /v1/apps/{app_id}/signin-config`: 512 KB, 30 s. Branding may carry two inline
    /// `data:image` logos of up to 128 KB each (core's rule), which the 64 KB default can't hold.
    SigninConfig,
}

/// Body limits (02-api.md: 64 KB default, 2 MB photo, 50 MB imports).
pub const DEFAULT_BODY_LIMIT: usize = 64 * 1024;
pub const PHOTO_BODY_LIMIT: usize = 2 * 1024 * 1024;
pub const IMPORT_BODY_LIMIT: usize = 50 * 1024 * 1024 + 64 * 1024;
pub const SYNC_BODY_LIMIT: usize = 5 * 1024 * 1024;
pub const SIGNIN_CONFIG_BODY_LIMIT: usize = 512 * 1024;

/// Time budgets per class (whole request, including reading the body).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Timeouts {
    pub default: Duration,
    pub upload: Duration,
    pub import: Duration,
}

impl Timeouts {
    /// Production budgets: 30 s, 60 s for photos and app sync, 5 min for imports (50 MB uploads).
    pub const STANDARD: Timeouts = Timeouts {
        default: Duration::from_secs(30),
        upload: Duration::from_secs(60),
        import: Duration::from_secs(300),
    };
}

/// Splits `/v1/apps/{x}/{tail}` into `(x, tail)`.
fn app_route(path: &str) -> Option<(&str, &str)> {
    one_segment_route(path, "/v1/apps/")
}

/// Splits `{prefix}{x}/{tail}` into `(x, tail)` for a non-empty single segment `x`.
fn one_segment_route<'a>(path: &'a str, prefix: &str) -> Option<(&'a str, &'a str)> {
    let rest = path.strip_prefix(prefix)?;
    let (id, tail) = rest.split_once('/')?;
    (!id.is_empty()).then_some((id, tail))
}

/// True for the photo upload routes other than `/v1/me/photo`: a custodian's
/// `/v1/me/silicons/{uuid}/photo` and the sign-up page's `/v1/flows/{id}/signup/photo`.
fn is_scoped_photo_upload(path: &str) -> bool {
    one_segment_route(path, "/v1/me/silicons/").is_some_and(|(_, tail)| tail == "photo")
        || one_segment_route(path, "/v1/flows/").is_some_and(|(_, tail)| tail == "signup/photo")
}

impl RouteClass {
    /// The class of a request.
    pub fn of(method: &Method, path: &str) -> RouteClass {
        if *method == Method::PATCH {
            return if app_route(path).is_some_and(|(_, tail)| tail == "signin-config") {
                RouteClass::SigninConfig
            } else {
                RouteClass::Default
            };
        }
        if *method != Method::POST {
            return RouteClass::Default;
        }
        match path {
            "/v1/me/photo" => RouteClass::PhotoUpload,
            _ if is_scoped_photo_upload(path) => RouteClass::PhotoUpload,
            "/v1/internal/apps/sync" => RouteClass::InternalSync,
            _ if app_route(path).is_some_and(|(_, tail)| tail == "imports") => RouteClass::Import,
            _ => RouteClass::Default,
        }
    }

    /// Largest accepted body in bytes.
    pub fn body_limit(self) -> usize {
        match self {
            RouteClass::Default => DEFAULT_BODY_LIMIT,
            RouteClass::PhotoUpload => PHOTO_BODY_LIMIT,
            RouteClass::Import => IMPORT_BODY_LIMIT,
            RouteClass::InternalSync => SYNC_BODY_LIMIT,
            RouteClass::SigninConfig => SIGNIN_CONFIG_BODY_LIMIT,
        }
    }

    /// The limit as people say it.
    pub fn limit_label(self) -> String {
        match self {
            RouteClass::Import => "50 MB".to_string(),
            other => human_bytes(other.body_limit()),
        }
    }

    /// Time budget.
    pub fn timeout(self, t: &Timeouts) -> Duration {
        match self {
            RouteClass::Default | RouteClass::SigninConfig => t.default,
            RouteClass::PhotoUpload | RouteClass::InternalSync => t.upload,
            RouteClass::Import => t.import,
        }
    }
}

/// `65536` → "64 KB", `2097152` → "2 MB".
pub fn human_bytes(n: usize) -> String {
    const KB: usize = 1024;
    const MB: usize = 1024 * 1024;
    if n >= MB && n.is_multiple_of(MB) {
        format!("{} MB", n / MB)
    } else if n >= KB && n.is_multiple_of(KB) {
        format!("{} KB", n / KB)
    } else {
        format!("{n} bytes")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn api_paths() {
        for p in [
            "/v1",
            "/v1/meta",
            "/.well-known/jwks.json",
            "/embed/v1/buttons",
            "/sdk/v1.js",
            "/healthz",
            "/readyz",
        ] {
            assert!(is_api_path(p), "{p}");
        }
        for p in [
            "/",
            "/v1x",
            "/authorize",
            "/device",
            "/assets/app.js",
            "/healthzz",
            "/sdkx",
        ] {
            assert!(!is_api_path(p), "{p}");
        }
    }

    #[test]
    fn public_cors_paths() {
        assert!(is_public_cors_path("/v1/apps/briefcase/public"));
        assert!(is_public_cors_path("/sdk/v1.js"));
        assert!(is_public_cors_path("/.well-known/openid-configuration"));
        assert!(!is_public_cors_path("/v1/apps/briefcase"));
        assert!(!is_public_cors_path("/v1/apps//public"));
        assert!(!is_public_cors_path("/v1/apps/briefcase/public/x"));
        assert!(!is_public_cors_path("/v1/me"));
        assert!(!is_public_cors_path("/embed/v1/buttons"));
    }

    #[test]
    fn oauth_rfc6749_paths() {
        for p in [
            "/v1/oauth/token",
            "/v1/oauth/revoke",
            "/v1/oauth/introspect",
        ] {
            assert!(is_oauth_rfc6749_path(p), "{p}");
        }
        for p in [
            "/v1/oauth/token/",
            "/v1/oauth/callback/google",
            "/v1/userinfo",
            "/v1/device/authorize",
            "/v1/oauth",
        ] {
            assert!(!is_oauth_rfc6749_path(p), "{p}");
        }
    }

    #[test]
    fn route_classes_and_limits() {
        assert_eq!(
            RouteClass::of(&Method::POST, "/v1/me/photo"),
            RouteClass::PhotoUpload
        );
        assert_eq!(
            RouteClass::of(&Method::DELETE, "/v1/me/photo"),
            RouteClass::Default
        );
        for p in [
            "/v1/me/silicons/a8K/photo",
            "/v1/me/silicons/si:scout/photo",
            "/v1/flows/0199aaaa-0000-7000-8000-000000000000/signup/photo",
        ] {
            assert_eq!(
                RouteClass::of(&Method::POST, p),
                RouteClass::PhotoUpload,
                "{p}"
            );
            assert_eq!(
                RouteClass::of(&Method::POST, p).body_limit(),
                2 * 1024 * 1024
            );
        }
        for p in [
            "/v1/me/silicons//photo",
            "/v1/me/silicons/a8K/photo/x",
            "/v1/flows/x/signup",
            "/v1/flows/x/photo",
        ] {
            assert_eq!(RouteClass::of(&Method::POST, p), RouteClass::Default, "{p}");
        }
        assert_eq!(
            RouteClass::of(&Method::POST, "/v1/apps/legacy-crm/imports"),
            RouteClass::Import
        );
        assert_eq!(
            RouteClass::of(&Method::POST, "/v1/apps/legacy-crm/imports/x"),
            RouteClass::Default
        );
        assert_eq!(
            RouteClass::of(&Method::GET, "/v1/apps/x/imports"),
            RouteClass::Default
        );
        assert_eq!(
            RouteClass::of(&Method::POST, "/v1/internal/apps/sync"),
            RouteClass::InternalSync
        );
        assert_eq!(RouteClass::Default.body_limit(), 65_536);
        assert_eq!(RouteClass::PhotoUpload.body_limit(), 2_097_152);
        assert_eq!(RouteClass::Import.body_limit(), 52_428_800 + 65_536);
        assert_eq!(RouteClass::Import.limit_label(), "50 MB");
        assert_eq!(
            RouteClass::of(&Method::PATCH, "/v1/apps/briefcase/signin-config"),
            RouteClass::SigninConfig
        );
        assert_eq!(
            RouteClass::of(&Method::PATCH, "/v1/me"),
            RouteClass::Default
        );
        assert_eq!(RouteClass::SigninConfig.limit_label(), "512 KB");
        assert_eq!(RouteClass::InternalSync.limit_label(), "5 MB");
        assert_eq!(human_bytes(65_536), "64 KB");
        assert_eq!(human_bytes(52_428_800), "50 MB");
        assert_eq!(human_bytes(1000), "1000 bytes");
    }
}
