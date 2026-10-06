//! Where the account is signed in to Silicon Accounts itself: browser sessions (the account site
//! and hosted pages) and first-party sign-ins (`aud = accounts` token families: the CLI, the
//! package, Silicon logins). Apps' own sign-ins are managed per app at `/v1/me/apps`.

use accounts_core::http::cookies::{SESSION_COOKIE, append_cookie, clear_cookie};
use accounts_core::http::pagination::encode_cursor;
use accounts_core::http::{AccountAuth, ClientMeta, Json, Path, Query};
use accounts_core::repo::{sessions, tokens};
use accounts_core::views::Page;
use accounts_core::{ApiError, ApiResult, AppState, FIRST_PARTY_APP_ID};
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

/// One entry of `GET /v1/me/sessions`.
#[derive(Debug, Serialize)]
pub(crate) struct SessionView {
    id: String,
    /// `browser` (cookie session) or `cli` (first-party sign-in: CLI, package, Silicon login).
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

/// A short description of a browser from its user agent ("Safari on macOS").
pub(crate) fn describe_user_agent(ua: &str) -> Option<String> {
    let u = ua.to_ascii_lowercase();
    if u.is_empty() {
        return None;
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
    } else if u.starts_with("curl/") {
        "curl"
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

fn family_label(origin: Option<&str>) -> &'static str {
    match origin {
        Some("device") => "accounts CLI (approved in the browser)",
        Some("cli_code") => "accounts CLI (email or phone code)",
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
           (select 'cli'::text, f.id, f.label, f.ip, f.user_agent, f.created_at, \
                   coalesce(f.last_used_at, f.created_at), f.expires_at, f.origin \
              from token_families f \
             where f.account_uuid = $1 and f.app_id = $5 and f.revoked_at is null and f.expires_at > now() \
               and (f.created_at, f.id) < ($2, $3) \
             order by f.created_at desc, f.id desc limit $4) \
         ) x order by x.created_at desc, x.id desc limit $4",
    )
    .bind(me.uuid())
    .bind(cursor_at)
    .bind(cursor_id)
    .bind(limit + 1)
    .bind(FIRST_PARTY_APP_ID)
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
                _ => r
                    .label
                    .clone()
                    .or_else(|| Some(family_label(r.origin.as_deref()).to_string())),
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

/// `DELETE /v1/me/sessions/{id}` → 204. Signs that browser or first-party sign-in out (its
/// cookie or refresh token stops working at once). Revoking the session making the request is
/// allowed: that is signing out (the cookie is cleared).
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
            Some(f) if f.account_uuid == me.uuid() && f.app_id == FIRST_PARTY_APP_ID => {
                tokens::revoke_family(
                    &mut tx,
                    id,
                    accounts_core::events::signout_reason::SESSION_REVOKED,
                )
                .await?;
                "cli"
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
        assert_eq!(describe_user_agent("curl/8.4.0").as_deref(), Some("curl"));
        assert_eq!(describe_user_agent(""), None);
    }
}
