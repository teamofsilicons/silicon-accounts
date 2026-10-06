//! The built account site (ACCOUNTS_WEB_DIST, the output of `pnpm -C web build`):
//!
//! - `/assets/*` — content-hashed files: `Cache-Control: public, max-age=31536000, immutable`;
//!   a missing asset is a 404 (never the site's HTML, which would break as a script).
//! - `/embed/v1/buttons?app_id=…` — the sign-in buttons page apps put in an `<iframe>`. Its CSP
//!   carries `frame-ancestors 'self' <the app's allowed_origins>`; an unknown or disabled app,
//!   or one without allowed origins, gets `frame-ancestors 'none'` (the page then shows its
//!   configuration error only when opened directly). `'self'` lets the account site's own
//!   developer pages preview the embed.
//! - `/sdk/v1.js` — the SDK: CORS `*`, `Cache-Control: public, max-age=300`, cross-origin
//!   resource policy so any site can load it.
//! - any other file in the build (favicon, theme boot script) — `Cache-Control: no-cache`.
//! - everything else that isn't an API path — `index.html` with `Cache-Control: no-store`
//!   (the site routes on the client: `/authorize`, `/device`, `/silicons`, …).
//!
//! Text responses are gzip-compressed when the browser accepts it. Dotfiles are never served.

use std::path::{Path, PathBuf};

use accounts_core::http::Query;
use accounts_core::ids::validate_app_id;
use accounts_core::{ApiError, ApiResult, AppState, config, repo};
use axum::Router;
use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use serde::Deserialize;
use tower::{Layer as _, ServiceExt as _};
use tower_http::compression::CompressionLayer;
use tower_http::services::{ServeDir, ServeFile};

use crate::middleware::policy::{AllowFraming, SPA_CSP};
use crate::paths;

/// Cache policy of the hashed build assets.
pub const IMMUTABLE: &str = "public, max-age=31536000, immutable";
/// Cache policy of the SDK (02-api.md: 5 minutes).
pub const SDK_CACHE: &str = "public, max-age=300";
/// Cache policy of the site's HTML.
pub const NO_STORE: &str = "no-store";
/// Cache policy of other un-hashed files: revalidate every time.
pub const REVALIDATE: &str = "no-cache";

/// `/embed/v1/buttons` and `/sdk/v1.js`.
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/embed/v1/buttons", get(embed_buttons))
        .route("/sdk/v1.js", get(sdk_v1))
}

fn require_dist(state: &AppState, what: &str) -> ApiResult<PathBuf> {
    state.settings.web_dist.clone().ok_or_else(|| {
        ApiError::not_found(
            "route_not_found",
            format!(
                "{what} is not served by this server: the account site's files are not configured (ACCOUNTS_WEB_DIST is not set)."
            ),
        )
        .hint("Set ACCOUNTS_WEB_DIST to the built site (`pnpm -C web build` writes web/dist).")
    })
}

fn not_built(relative: &str) -> ApiError {
    ApiError::unavailable(
        "web_not_built",
        format!(
            "The account site build is incomplete: {relative} is missing from ACCOUNTS_WEB_DIST."
        ),
    )
    .hint("Build the site with `pnpm -C web build` and point ACCOUNTS_WEB_DIST at web/dist.")
}

async fn is_file(path: &Path) -> bool {
    tokio::fs::metadata(path).await.is_ok_and(|m| m.is_file())
}

fn set_header(response: &mut Response, name: header::HeaderName, value: &'static str) {
    response
        .headers_mut()
        .insert(name, HeaderValue::from_static(value));
}

fn is_html(response: &Response) -> bool {
    response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.trim_start().to_ascii_lowercase().starts_with("text/html"))
}

fn cacheable(status: StatusCode) -> bool {
    status.is_success() || status == StatusCode::NOT_MODIFIED
}

/// Serves a request with a file service, gzip-compressing text when the client accepts it.
async fn serve<S>(service: S, req: Request) -> Response
where
    S: tower::Service<Request, Error = std::convert::Infallible> + Clone + Send + 'static,
    S::Future: Send + 'static,
    S::Response: IntoResponse,
{
    let compressed = CompressionLayer::new().layer(tower::service_fn(move |req: Request| {
        let service = service.clone();
        async move {
            let response = service.oneshot(req).await?.into_response();
            Ok::<_, std::convert::Infallible>(response)
        }
    }));
    let mut response = match compressed.oneshot(req).await {
        Ok(response) => response.map(Body::new),
        Err(never) => match never {},
    };
    declare_utf8(&mut response);
    response
}

/// The build is UTF-8: say so on text types that don't name a charset (`text/html` →
/// `text/html; charset=utf-8`), so browsers never guess.
fn declare_utf8(response: &mut Response) {
    let Some(ct) = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
    else {
        return;
    };
    let lower = ct.to_ascii_lowercase();
    let textual = lower.starts_with("text/")
        || lower.starts_with("application/javascript")
        || lower.starts_with("application/json")
        || lower.starts_with("image/svg+xml");
    if textual
        && !lower.contains("charset")
        && let Ok(v) = HeaderValue::from_str(&format!("{ct}; charset=utf-8"))
    {
        response.headers_mut().insert(header::CONTENT_TYPE, v);
    }
}

/// True when the path names a dotfile or dot-directory (also percent-encoded).
fn has_dot_segment(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    lower.contains("/.") || lower.contains("/%2e")
}

/// Serves the account site for a non-API GET/HEAD (see the module docs).
pub async fn serve_site(dist: &Path, req: Request) -> Response {
    let path = req.uri().path().to_owned();
    if paths::is_asset_path(&path) {
        if has_dot_segment(&path) {
            return StatusCode::NOT_FOUND.into_response();
        }
        let mut response = serve(ServeDir::new(dist), req).await;
        let policy = if cacheable(response.status()) {
            IMMUTABLE
        } else {
            NO_STORE
        };
        set_header(&mut response, header::CACHE_CONTROL, policy);
        return response;
    }
    let index = dist.join("index.html");
    let mut response = if has_dot_segment(&path) {
        serve(ServeFile::new(&index), req).await
    } else {
        let site = ServeDir::new(dist)
            .append_index_html_on_directories(false)
            .fallback(ServeFile::new(&index));
        serve(site, req).await
    };
    if response.status() == StatusCode::NOT_FOUND && !is_file(&index).await {
        return not_built("index.html").into_response();
    }
    let policy = if is_html(&response) || !cacheable(response.status()) {
        NO_STORE
    } else {
        REVALIDATE
    };
    set_header(&mut response, header::CACHE_CONTROL, policy);
    response
}

/// Query of `/embed/v1/buttons` (the page itself reads the rest: redirect_uri, state, theme…).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct EmbedQuery {
    pub app_id: Option<String>,
}

/// The origins allowed to frame the embed for `app_id`: the app's `allowed_origins`, reduced
/// to clean `scheme://host[:port]` origins. Empty for a missing, unknown or disabled app.
pub async fn frame_ancestors(state: &AppState, app_id: Option<&str>) -> ApiResult<Vec<String>> {
    let Some(app_id) = app_id
        .map(str::trim)
        .filter(|id| validate_app_id(id).is_ok())
    else {
        return Ok(Vec::new());
    };
    let mut conn = state.db.acquire().await?;
    match repo::apps::get(&mut conn, app_id).await? {
        Some(app) if app.is_active() => {
            let cfg = repo::apps::effective_config(&mut conn, &state.settings, app_id).await?;
            Ok(clean_origins(&cfg.allowed_origins))
        }
        _ => Ok(Vec::new()),
    }
}

/// Parses each entry as an origin; anything that isn't one is dropped, so nothing but
/// `scheme://host[:port]` can reach the CSP header.
pub fn clean_origins(list: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for entry in list {
        if let Some(origin) = config::origin_of(entry)
            && !origin.contains([' ', ';', ',', '\'', '"'])
            && !out.contains(&origin)
        {
            out.push(origin);
        }
    }
    out
}

/// The embed page's CSP: the site policy with `frame-ancestors` set for the app.
pub fn embed_csp(ancestors: &[String]) -> String {
    if ancestors.is_empty() {
        return SPA_CSP.to_string();
    }
    SPA_CSP.replace(
        "frame-ancestors 'none'",
        &format!("frame-ancestors 'self' {}", ancestors.join(" ")),
    )
}

/// `GET /embed/v1/buttons?app_id=…`.
pub async fn embed_buttons(
    State(state): State<AppState>,
    Query(q): Query<EmbedQuery>,
) -> Result<Response, ApiError> {
    let dist = require_dist(&state, "/embed/v1/buttons")?;
    let ancestors = frame_ancestors(&state, q.app_id.as_deref()).await?;
    let html = tokio::fs::read(dist.join("embed/v1/buttons.html"))
        .await
        .map_err(|_| not_built("embed/v1/buttons.html"))?;
    let csp = HeaderValue::from_str(&embed_csp(&ancestors))
        .map_err(|e| ApiError::internal(format!("embed CSP header: {e}")))?;
    let mut response = (StatusCode::OK, html).into_response();
    set_header(
        &mut response,
        header::CONTENT_TYPE,
        "text/html; charset=utf-8",
    );
    set_header(&mut response, header::CACHE_CONTROL, NO_STORE);
    response
        .headers_mut()
        .insert(header::CONTENT_SECURITY_POLICY, csp);
    if !ancestors.is_empty() {
        response.extensions_mut().insert(AllowFraming);
    }
    Ok(response)
}

/// `GET /sdk/v1.js`.
pub async fn sdk_v1(State(state): State<AppState>, req: Request) -> Result<Response, ApiError> {
    let dist = require_dist(&state, "/sdk/v1.js")?;
    let file = dist.join("sdk/v1.js");
    if !is_file(&file).await {
        return Err(not_built("sdk/v1.js"));
    }
    let mut response = serve(ServeFile::new(&file), req).await;
    if cacheable(response.status()) {
        set_header(&mut response, header::CACHE_CONTROL, SDK_CACHE);
        set_header(
            &mut response,
            header::CONTENT_TYPE,
            "text/javascript; charset=utf-8",
        );
    }
    set_header(
        &mut response,
        header::HeaderName::from_static("cross-origin-resource-policy"),
        "cross-origin",
    );
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origins_are_reduced_to_clean_origins() {
        let list = vec![
            "https://app.example.com".to_string(),
            "https://App.Example.com/".to_string(),
            "http://127.0.0.1:8593".to_string(),
            "https://evil.example; script-src *".to_string(),
            "javascript:alert(1)".to_string(),
            "not a url".to_string(),
        ];
        assert_eq!(
            clean_origins(&list),
            vec!["https://app.example.com", "http://127.0.0.1:8593"]
        );
    }

    #[test]
    fn embed_csp_replaces_only_frame_ancestors() {
        assert_eq!(embed_csp(&[]), SPA_CSP);
        let csp = embed_csp(&["https://a.example".into(), "http://127.0.0.1:8593".into()]);
        assert!(csp.contains("frame-ancestors 'self' https://a.example http://127.0.0.1:8593;"));
        assert!(!csp.contains("frame-ancestors 'none'"));
        assert!(csp.starts_with("default-src 'self';"));
    }

    #[test]
    fn dot_segments() {
        assert!(has_dot_segment("/.git/config"));
        assert!(has_dot_segment("/x/%2Eenv"));
        assert!(!has_dot_segment("/assets/app-1.js"));
    }
}
