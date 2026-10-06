//! Browser sessions (the `sa_session` cookie of the account site and hosted pages).

use sqlx::PgConnection;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::crypto::{Pepper, prefix, random_token};
use crate::error::{ApiError, ApiResult};

/// Browser sessions (and their cookie) last this long.
pub const SESSION_DAYS: i64 = 900;

macro_rules! session_columns {
    () => {
        "id, account_uuid, created_at, last_seen_at, expires_at, revoked_at, ip, user_agent"
    };
}

/// A browser session (the token itself is never stored).
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct BrowserSession {
    pub id: Uuid,
    pub account_uuid: String,
    pub created_at: OffsetDateTime,
    pub last_seen_at: OffsetDateTime,
    pub expires_at: OffsetDateTime,
    pub revoked_at: Option<OffsetDateTime>,
    pub ip: Option<String>,
    pub user_agent: Option<String>,
}

/// Creates a session; returns the cookie value (`sas_…`) and the row.
pub async fn create(
    conn: &mut PgConnection,
    pepper: &Pepper,
    account_uuid: &str,
    ip: Option<&str>,
    user_agent: Option<&str>,
) -> ApiResult<(String, BrowserSession)> {
    let token = random_token(prefix::SESSION);
    let session = sqlx::query_as::<_, BrowserSession>(concat!(
        "insert into browser_sessions (id, token_hash, account_uuid, expires_at, ip, user_agent) \
         values ($1, $2, $3, now() + make_interval(days => $4), $5, $6) returning ",
        session_columns!()
    ))
    .bind(Uuid::now_v7())
    .bind(pepper.hash(&token))
    .bind(account_uuid)
    .bind(SESSION_DAYS as i32)
    .bind(ip)
    .bind(user_agent.map(|u| u.chars().take(400).collect::<String>()))
    .fetch_one(&mut *conn)
    .await?;
    Ok((token, session))
}

/// The live session for a cookie value (not revoked, not expired, account not deleted).
pub async fn lookup(
    conn: &mut PgConnection,
    pepper: &Pepper,
    token: &str,
) -> ApiResult<Option<BrowserSession>> {
    if !token.starts_with(prefix::SESSION) {
        return Ok(None);
    }
    Ok(sqlx::query_as::<_, BrowserSession>(concat!(
        "select ",
        session_columns!(),
        " from browser_sessions s where token_hash = $1 and revoked_at is null and expires_at > now() \
          and exists (select 1 from accounts a where a.uuid = s.account_uuid and a.status <> 'deleted')"
    ))
    .bind(pepper.hash(token))
    .fetch_optional(&mut *conn)
    .await?)
}

/// Fetches a session by id (any state).
pub async fn get(conn: &mut PgConnection, id: Uuid) -> ApiResult<Option<BrowserSession>> {
    Ok(sqlx::query_as::<_, BrowserSession>(concat!(
        "select ",
        session_columns!(),
        " from browser_sessions where id = $1"
    ))
    .bind(id)
    .fetch_optional(&mut *conn)
    .await?)
}

/// Updates `last_seen_at` at most every 5 minutes (keeps writes cheap).
pub async fn touch(conn: &mut PgConnection, id: Uuid) -> ApiResult<()> {
    sqlx::query("update browser_sessions set last_seen_at = now() where id = $1 and last_seen_at < now() - interval '5 minutes'")
        .bind(id)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// Revokes one session of an account. Error: 404 `session_not_found`.
pub async fn revoke(conn: &mut PgConnection, account_uuid: &str, id: Uuid) -> ApiResult<()> {
    let n = sqlx::query("update browser_sessions set revoked_at = coalesce(revoked_at, now()) where id = $1 and account_uuid = $2")
        .bind(id)
        .bind(account_uuid)
        .execute(&mut *conn)
        .await?
        .rows_affected();
    if n == 0 {
        return Err(ApiError::not_found(
            "session_not_found",
            format!("No session '{id}' belongs to your account."),
        )
        .hint("List your sessions to see their ids."));
    }
    Ok(())
}

/// Revokes every live session of an account except `except`. Returns how many.
pub async fn revoke_all(
    conn: &mut PgConnection,
    account_uuid: &str,
    except: Option<Uuid>,
) -> ApiResult<u64> {
    Ok(sqlx::query(
        "update browser_sessions set revoked_at = now() where account_uuid = $1 and revoked_at is null \
         and ($2::uuid is null or id <> $2)",
    )
    .bind(account_uuid)
    .bind(except)
    .execute(&mut *conn)
    .await?
    .rows_affected())
}

/// Live sessions of an account, most recently seen first.
pub async fn list_active(
    conn: &mut PgConnection,
    account_uuid: &str,
) -> ApiResult<Vec<BrowserSession>> {
    Ok(sqlx::query_as::<_, BrowserSession>(concat!(
        "select ",
        session_columns!(),
        " from browser_sessions where account_uuid = $1 and revoked_at is null and expires_at > now() \
          order by last_seen_at desc"
    ))
    .bind(account_uuid)
    .fetch_all(&mut *conn)
    .await?)
}
