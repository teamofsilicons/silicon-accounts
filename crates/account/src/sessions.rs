//! Where the account is signed in to Silicon Accounts itself: browser sessions (the account site
//! and hosted pages), first-party sign-ins (`aud = silicon-accounts` token families: the CLI, the
//! package, Silicon logins) and sign-ins to the developer platform (`aud = developer` token
//! families: developers.teamofsilicons.com). Apps' own sign-ins are managed per app at
//! `/v1/me/apps`.

use accounts_core::http::cookies::{SESSION_COOKIE, append_cookie, clear_cookie};
use accounts_core::http::pagination::encode_cursor;
use accounts_core::http::{AccountAuth, ClientMeta, Json, Path, Query};
use accounts_core::repo::{sessions, tokens};
use accounts_core::views::Page;
use accounts_core::{ApiError, ApiResult, AppState, DEVELOPER_APP_ID, FIRST_PARTY_APP_ID};
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use serde_json::json;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::util::{END_OF_TIME, audit_self, clip, from_micros, to_micros, track};

#[derive(Debug, Deserialize)]
pub(crate) struct ListQuery {
    limit: Option<i64>,
    cursor: Option<String>,
}

#[derive(Debug, sqlx::FromRow)]
struct Row {
    kind: String,
    id: Uuid,
    label: Option<String>,
    ip: Option<String>,
    user_agent: Option<String>,
    created_at: OffsetDateTime,
    last_seen_at: OffsetDateTime,
    expires_at: OffsetDateTime,
    origin: Option<String>,
}

/// The first-party apps whose token families are sessions of Silicon Accounts itself.
const SESSION_APPS: [&str; 2] = [FIRST_PARTY_APP_ID, DEVELOPER_APP_ID];

/// One entry of `GET /v1/me/sessions`.
#[derive(Debug, Serialize)]
pub(crate) struct SessionView {
    id: String,
    /// `browser` (cookie session), `cli` (first-party sign-in: CLI, package, Silicon login) or
    /// `developer` (a sign-in to the developer platform, developers.teamofsilicons.com).
    kind: String,
    label: Option<String>,
    /// For `cli` sessions: how they signed in (`device`, `cli_code`, `silicon_login`,
    /// `authorization_code`).
    origin: Option<String>,
    ip: Option<String>,
    user_agent: Option<String>,
    #[serde(with = "accounts_core::timefmt::rfc3339_ms")]
    created_at: OffsetDateTime,
    #[serde(with = "accounts_core::timefmt::rfc3339_ms")]
    last_seen_at: OffsetDateTime,
    #[serde(with = "accounts_core::timefmt::rfc3339_ms")]
    expires_at: OffsetDateTime,
    /// True for the session making this request.
    current: bool,
}

/// The product token of the silicon-accounts CLI's user agent (`accounts-cli/<v> silicon-accounts-client/<v>`).
const CLI_PRODUCT: &str = "accounts-cli";
/// The product token the Rust package adds to every user agent, after the program's own when it
/// names one (`<program> silicon-accounts-client/<v>`).
const PACKAGE_PRODUCT: &str = "silicon-accounts-client";

/// One `name/version` product token of a user agent.
struct Product<'a> {
    name: &'a str,
    version: Option<&'a str>,
}

impl Product<'_> {
    /// "curl 8.4.0", clipped so a made-up user agent can't flood the page.
    fn describe(&self) -> String {
        match self.version {
            Some(v) => format!("{} {}", clip(self.name, 40), clip(v, 24)),
            None => clip(self.name, 40),
        }
    }
}

/// RFC 9110 `token` characters.
fn is_token(s: &str) -> bool {
    !s.is_empty()
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b))
}

/// The product tokens of a user agent, in order, skipping (comments) and anything that isn't a
/// token.
fn products(ua: &str) -> Vec<Product<'_>> {
    let mut out = Vec::new();
    let mut depth = 0usize;
    for word in ua.split_whitespace() {
        let opens = word.matches('(').count();
        let closes = word.matches(')').count();
        let inside = depth > 0 || opens > 0;
        depth = (depth + opens).saturating_sub(closes);
        if inside {
            continue;
        }
        let (name, version) = match word.split_once('/') {
            Some((name, version)) => (name, Some(version)),
            None => (word, None),
        };
        if is_token(name) && version.is_none_or(is_token) {
            out.push(Product { name, version });
        }
    }
    out
}

/// A short description of the client behind a user agent, as sign-in history and the session
/// list name it:
///
/// | user agent | described as |
/// |---|---|
/// | a browser's (`Mozilla/5.0 (Macintosh; …) … Version/17.0 Safari/605.1.15`) | `Safari on macOS` |
/// | the silicon-accounts CLI's (`accounts-cli/0.1.0 silicon-accounts-client/0.1.0`) | `silicon-accounts CLI 0.1.0` |
/// | the Rust package's (`silicon-accounts-client/0.1.0`) | `Silicon Accounts Rust package 0.1.0` |
/// | a program using the package (`dm/2.0 silicon-accounts-client/0.1.0`) | `dm 2.0 (Silicon Accounts Rust package 0.1.0)` |
/// | any other program's (`curl/8.4.0`, `python-requests/2.31.0`) | its product: `curl 8.4.0` |
/// | nothing readable | `An unknown client` |
///
/// Only a user agent that presents itself as a browser (`Mozilla/…`, `Opera/…`) is called one;
/// such a browser this doesn't know is `A browser` (with its system when that is known).
pub(crate) fn describe_user_agent(ua: &str) -> Option<String> {
    let ua = ua.trim();
    if ua.is_empty() {
        return None;
    }
    let products = products(ua);
    let find = |name: &str| {
        products
            .iter()
            .position(|p| p.name.eq_ignore_ascii_case(name))
    };
    let named = |what: &str, p: &Product<'_>| match p.version {
        Some(v) => format!("{what} {}", clip(v, 24)),
        None => what.to_string(),
    };
    if let Some(i) = find(CLI_PRODUCT) {
        return Some(named("silicon-accounts CLI", &products[i]));
    }
    if let Some(i) = find(PACKAGE_PRODUCT) {
        let package = named("Silicon Accounts Rust package", &products[i]);
        return Some(match products[..i].first() {
            Some(program) => format!("{} ({package})", program.describe()),
            None => package,
        });
    }
    let u = ua.to_ascii_lowercase();
    if !(u.starts_with("mozilla/") || u.starts_with("opera/")) {
        return Some(
            products
                .first()
                .map(Product::describe)
                .unwrap_or_else(|| "An unknown client".to_string()),
        );
    }
    let browser = if u.contains("edg/") {
        "Edge"
    } else if u.contains("opr/") || u.contains("opera") {
        "Opera"
    } else if u.contains("firefox/") {
        "Firefox"
    } else if u.contains("chrome/") || u.contains("crios/") {
        "Chrome"
    } else if u.contains("safari/") {
        "Safari"
    } else {
        "A browser"
    };
    let os = if u.contains("iphone") || u.contains("ipad") {
        Some("iOS")
    } else if u.contains("android") {
        Some("Android")
    } else if u.contains("mac os x") || u.contains("macintosh") {
        Some("macOS")
    } else if u.contains("windows") {
        Some("Windows")
    } else if u.contains("cros") {
        Some("ChromeOS")
    } else if u.contains("linux") {
        Some("Linux")
    } else {
        None
    };
    Some(match os {
        Some(os) => format!("{browser} on {os}"),
        None => browser.to_string(),
    })
}

/// How a sign-in to the developer platform is named, in the session list and in history.
pub(crate) const DEVELOPER_SITE: &str = "Silicon Developer (developers.teamofsilicons.com)";

fn family_label(kind: &str, origin: Option<&str>) -> &'static str {
    if kind == "developer" {
        return DEVELOPER_SITE;
    }
    match origin {
        Some("device") => "silicon-accounts CLI (approved in the browser)",
        Some("cli_code") => "silicon-accounts CLI (email or phone code)",
        Some("silicon_login") => "Silicon sign-in with its STK",
        Some("authorization_code") => "Silicon Accounts sign-in",
        _ => "First-party sign-in",
    }
}

/// `GET /v1/me/sessions?limit&cursor` → `{"items":[SessionView…],"next_cursor"}`, newest first.
pub(crate) async fn list(
    State(state): State<AppState>,
    me: AccountAuth,
    Query(q): Query<ListQuery>,
) -> ApiResult<Json<Page<SessionView>>> {
    let limit = q.limit.unwrap_or(50).clamp(1, 200);
    let params = accounts_core::http::PageParams {
        limit: Some(limit),
        cursor: q.cursor.clone(),
    };
    let (cursor_at, cursor_id) = match params.cursor::<(i64, Uuid)>()? {
        Some((micros, id)) => (from_micros(micros)?, id),
        None => (END_OF_TIME, Uuid::max()),
    };
    let rows: Vec<Row> = sqlx::query_as(
        "select x.kind, x.id, x.label, x.ip, x.user_agent, x.created_at, x.last_seen_at, x.expires_at, x.origin from ( \
           (select 'browser'::text as kind, s.id, null::text as label, s.ip, s.user_agent, s.created_at, \
                   s.last_seen_at, s.expires_at, null::text as origin \
              from browser_sessions s \
             where s.account_uuid = $1 and s.revoked_at is null and s.expires_at > now() \
               and (s.created_at, s.id) < ($2, $3) \
             order by s.created_at desc, s.id desc limit $4) \
           union all \
           (select case when f.app_id = $6 then 'developer' else 'cli' end::text, f.id, f.label, f.ip, \
                   f.user_agent, f.created_at, coalesce(f.last_used_at, f.created_at), f.expires_at, f.origin \
              from token_families f \
             where f.account_uuid = $1 and f.app_id = any($5) and f.revoked_at is null and f.expires_at > now() \
               and (f.created_at, f.id) < ($2, $3) \
             order by f.created_at desc, f.id desc limit $4) \
         ) x order by x.created_at desc, x.id desc limit $4",
    )
    .bind(me.uuid())
    .bind(cursor_at)
    .bind(cursor_id)
    .bind(limit + 1)
    .bind(&SESSION_APPS[..])
    .bind(DEVELOPER_APP_ID)
    .fetch_all(&state.db)
    .await?;
    let current_session = me.session_id();
    let current_family = me.family_id();
    let mut items: Vec<SessionView> = rows
        .into_iter()
        .map(|r| {
            let current = match r.kind.as_str() {
                "browser" => current_session == Some(r.id),
                _ => current_family == Some(r.id),
            };
            let label = match r.kind.as_str() {
                "browser" => r.user_agent.as_deref().and_then(describe_user_agent),
                // A developer-platform sign-in is always named as such. A family made by the
                // authorization_code grant stores an internal `code:<hash>` marker as its
                // label (code-reuse revocation), which is not a name to show.
                "developer" => Some(family_label("developer", r.origin.as_deref()).to_string()),
                kind => r
                    .label
                    .clone()
                    .filter(|l| !l.starts_with("code:"))
                    .or_else(|| Some(family_label(kind, r.origin.as_deref()).to_string())),
            };
            SessionView {
                id: r.id.to_string(),
                kind: r.kind,
                label,
                origin: r.origin,
                ip: r.ip,
                user_agent: r.user_agent,
                created_at: r.created_at,
                last_seen_at: r.last_seen_at,
                expires_at: r.expires_at,
                current,
            }
        })
        .collect();
    let next_cursor = if items.len() as i64 > limit {
        items.truncate(limit as usize);
        items.last().map(|s| {
            encode_cursor(&(
                to_micros(s.created_at),
                Uuid::parse_str(&s.id).unwrap_or_default(),
            ))
        })
    } else {
        None
    };
    Ok(Json(Page::new(items, next_cursor)))
}

fn session_not_found(id: &str) -> ApiError {
    ApiError::not_found(
        "session_not_found",
        format!("No session '{}' belongs to your account.", clip(id, 60)),
    )
    .hint("List your sessions with GET /v1/me/sessions and use an id from there.")
}

/// `DELETE /v1/me/sessions/{id}` → 204. Signs that browser, first-party or developer-platform
/// sign-in out (its cookie or refresh token stops working at once). Revoking the session making
/// the request is allowed: that is signing out (the cookie is cleared).
pub(crate) async fn revoke(
    State(state): State<AppState>,
    me: AccountAuth,
    meta: ClientMeta,
    Path(raw): Path<String>,
) -> Result<Response, ApiError> {
    let Ok(id) = Uuid::parse_str(raw.trim()) else {
        return Err(session_not_found(&raw));
    };
    let mut tx = state.db.begin().await?;
    let browser = sessions::get(&mut tx, id)
        .await?
        .filter(|s| s.account_uuid == me.uuid());
    let kind = if browser.is_some() {
        sessions::revoke(&mut tx, me.uuid(), id).await?;
        "browser"
    } else {
        match tokens::find_family(&mut tx, id).await? {
            Some(f) if f.account_uuid == me.uuid() && SESSION_APPS.contains(&f.app_id.as_str()) => {
                tokens::revoke_family(
                    &mut tx,
                    id,
                    accounts_core::events::signout_reason::SESSION_REVOKED,
                )
                .await?;
                if f.app_id == DEVELOPER_APP_ID {
                    "developer"
                } else {
                    "cli"
                }
            }
            _ => return Err(session_not_found(&raw)),
        }
    };
    audit_self(
        &mut tx,
        me.uuid(),
        "account.session.revoked",
        None,
        json!({ "session_id": id.to_string(), "kind": kind }),
        meta.ip.as_deref(),
    )
    .await?;
    tx.commit().await?;
    track(
        &state,
        "sessions",
        "account.session.revoked",
        json!({ "kind": kind, "own": me.session_id() == Some(id) || me.family_id() == Some(id) }),
    );
    let mut response = StatusCode::NO_CONTENT.into_response();
    if me.session_id() == Some(id) {
        append_cookie(
            response.headers_mut(),
            &clear_cookie(&state.settings, SESSION_COOKIE),
        );
    }
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::describe_user_agent;

    #[test]
    fn user_agents() {
        assert_eq!(
            describe_user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15").as_deref(),
            Some("Safari on macOS")
        );
        assert_eq!(
            describe_user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36 Edg/120.0").as_deref(),
            Some("Edge on Windows")
        );
        assert_eq!(
            describe_user_agent(
                "Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0"
            )
            .as_deref(),
            Some("Firefox on Linux")
        );
        assert_eq!(
            describe_user_agent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0 Mobile/15E148 Safari/604.1").as_deref(),
            Some("Chrome on iOS")
        );
        assert_eq!(describe_user_agent(""), None);
        assert_eq!(describe_user_agent("   "), None);
    }

    /// The silicon-accounts CLI and the Rust package sign in too, and they are not browsers: their
    /// sign-ins once read "from 127.0.0.1 · A browser" in the account's history.
    #[test]
    fn the_cli_and_the_package_are_named_not_called_browsers() {
        assert_eq!(
            describe_user_agent("accounts-cli/0.1.0 silicon-accounts-client/0.1.0").as_deref(),
            Some("silicon-accounts CLI 0.1.0")
        );
        assert_eq!(
            describe_user_agent("accounts-cli/2.3.4").as_deref(),
            Some("silicon-accounts CLI 2.3.4")
        );
        assert_eq!(
            describe_user_agent("silicon-accounts-client/0.1.0").as_deref(),
            Some("Silicon Accounts Rust package 0.1.0")
        );
        assert_eq!(
            describe_user_agent("dm/2.0 silicon-accounts-client/0.1.0").as_deref(),
            Some("dm 2.0 (Silicon Accounts Rust package 0.1.0)")
        );
        assert_eq!(
            describe_user_agent("scout (+https://scout.example) silicon-accounts-client/0.1.0")
                .as_deref(),
            Some("scout (Silicon Accounts Rust package 0.1.0)")
        );
    }

    #[test]
    fn other_programs_are_named_by_their_product() {
        assert_eq!(
            describe_user_agent("curl/8.4.0").as_deref(),
            Some("curl 8.4.0")
        );
        assert_eq!(
            describe_user_agent("python-requests/2.31.0").as_deref(),
            Some("python-requests 2.31.0")
        );
        assert_eq!(describe_user_agent("node").as_deref(), Some("node"));
        assert_eq!(
            describe_user_agent("Go-http-client/1.1").as_deref(),
            Some("Go-http-client 1.1")
        );
        // Comments are skipped; something with no product at all is unknown, not a browser.
        assert_eq!(
            describe_user_agent("Dalvik/2.1.0 (Linux; U; Android 13; Pixel 7)").as_deref(),
            Some("Dalvik 2.1.0")
        );
        assert_eq!(
            describe_user_agent("(compatible; nothing)").as_deref(),
            Some("An unknown client")
        );
        assert_eq!(
            describe_user_agent("<script>/1").as_deref(),
            Some("An unknown client")
        );
        // A made-up product can't flood the page.
        let long = format!("{}/{}", "x".repeat(300), "9".repeat(300));
        let said = describe_user_agent(&long).expect("described");
        assert!(said.chars().count() <= 70, "{said}");
        for ua in [
            "accounts-cli/0.1.0 silicon-accounts-client/0.1.0",
            "silicon-accounts-client/0.1.0",
            "curl/8.4.0",
            "node",
            "(compatible; nothing)",
        ] {
            assert!(
                !describe_user_agent(ua)
                    .unwrap_or_default()
                    .contains("browser"),
                "{ua}"
            );
        }
    }

    #[test]
    fn a_browser_this_does_not_know_is_still_a_browser() {
        assert_eq!(
            describe_user_agent("Mozilla/5.0 (X11; Linux x86_64) SomeEngine/1.0").as_deref(),
            Some("A browser on Linux")
        );
        assert_eq!(
            describe_user_agent("Opera/9.80 (Windows NT 6.1) Presto/2.12.388 Version/12.16")
                .as_deref(),
            Some("Opera on Windows")
        );
    }
}
