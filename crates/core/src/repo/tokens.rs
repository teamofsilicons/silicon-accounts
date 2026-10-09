//! Tokens: sign-in grants ("token families"), refresh rotation with reuse detection, access
//! tokens, OIDC id_tokens, authorization codes (PKCE), short-lived tokens (SLTs) and device
//! authorizations.
//!
//! A token family is one sign-in of one account to one app. It lives 900 days from creation
//! (absolute) and holds a chain of refresh tokens: every refresh marks the presented token used
//! and issues the next generation. Presenting a used refresh token revokes the whole family.
//!
//! Every expiry stored in the database (families, codes, SLTs, device codes) is compared with
//! the database clock (`now()`), so the API nodes' clocks never matter for them. Only an access
//! token's own `exp`/`nbf` are checked with the node's clock (with leeway), as JWTs are.

use sqlx::{Connection, PgConnection, PgPool};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::config::Settings;
use crate::crypto::{Pepper, pkce, prefix, random_token};
use crate::error::{ApiError, ApiResult, OAuthError};
use crate::jwt::{AccessClaims, AccessTokenInput, IdTokenClaims, JwtError};
use crate::models::{
    Account, AccountStatus, Scope, TokenOrigin, scope_strings, scopes_from_strings,
    scopes_to_string,
};
use crate::state::Keys;
use crate::views::{TokenResponse, load_account_for_app};

/// Refresh tokens (token families) live this long from sign-in.
pub const REFRESH_TOKEN_DAYS: i64 = 900;
/// Authorization codes live this long.
pub const AUTH_CODE_TTL_SECONDS: i64 = 120;
/// Short-lived tokens live this long.
pub const SLT_TTL_SECONDS: i64 = 120;
/// Device codes live this long.
pub const DEVICE_CODE_TTL_SECONDS: i64 = 600;
/// Minimum seconds between device-code polls.
pub const DEVICE_POLL_INTERVAL_SECONDS: i64 = 5;

macro_rules! family_columns {
    () => {
        "id, app_id, account_uuid, origin, scopes, browser_session_id, label, created_at, expires_at, last_used_at, \
         revoked_at, revoke_reason, ip, user_agent, auth_time"
    };
}

/// One sign-in grant of an account to an app.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct TokenFamily {
    pub id: Uuid,
    pub app_id: String,
    pub account_uuid: String,
    pub origin: TokenOrigin,
    pub scopes: Vec<String>,
    pub browser_session_id: Option<Uuid>,
    pub label: Option<String>,
    pub created_at: OffsetDateTime,
    pub expires_at: OffsetDateTime,
    pub last_used_at: Option<OffsetDateTime>,
    pub revoked_at: Option<OffsetDateTime>,
    pub revoke_reason: Option<String>,
    pub ip: Option<String>,
    pub user_agent: Option<String>,
    /// When the account actually authenticated for this sign-in (OIDC `auth_time`); `None` =
    /// at `created_at` (every grant except an authorization code authenticates at issuance).
    pub auth_time: Option<OffsetDateTime>,
}

impl TokenFamily {
    /// Not revoked and not past its absolute expiry (judged with this node's clock; the
    /// repository functions use the database clock).
    pub fn is_active(&self) -> bool {
        self.revoked_at.is_none() && self.expires_at > OffsetDateTime::now_utc()
    }

    pub fn scope_list(&self) -> Vec<Scope> {
        scopes_from_strings(&self.scopes)
    }

    /// When the account authenticated for this sign-in: `auth_time`, else `created_at`.
    pub fn authenticated_at(&self) -> OffsetDateTime {
        self.auth_time.unwrap_or(self.created_at)
    }
}

/// A family with its expiry judged by the database clock.
#[derive(sqlx::FromRow)]
struct FamilyRow {
    #[sqlx(flatten)]
    family: TokenFamily,
    expired: bool,
}

/// Why a grant (code, refresh token, SLT, device code) was refused. Converts to [`OAuthError`].
#[derive(Debug, Clone)]
pub enum GrantError {
    /// `invalid_grant` with a precise description.
    Invalid(String),
    /// A used refresh token was presented again; the family is now revoked. Callers may emit
    /// `events::membership_signed_out(app, account, "refresh_token_reuse")`.
    Reused {
        family_id: Uuid,
        app_id: String,
        account_uuid: String,
    },
    /// Device flow: not approved yet.
    AuthorizationPending,
    /// Device flow: polled faster than every 5 s.
    SlowDown,
    /// Device flow: the Carbon denied it.
    AccessDenied(String),
    /// Device flow: the device code expired.
    ExpiredToken(String),
    /// Server-side failure (logged, never shown).
    Internal(String),
}

impl GrantError {
    pub fn to_oauth(&self) -> OAuthError {
        match self {
            GrantError::Invalid(d) => OAuthError::invalid_grant(d.clone()),
            GrantError::Reused { .. } => OAuthError::invalid_grant(
                "This refresh token was already used once. Presenting a used refresh token revokes the whole sign-in \
                 to protect the account, so this sign-in is now revoked; sign in again.",
            ),
            GrantError::AuthorizationPending => OAuthError::authorization_pending(
                "The Carbon hasn't approved this device code yet; keep polling every 5 seconds.",
            ),
            GrantError::SlowDown => OAuthError::slow_down(
                "Polling too fast: wait at least 5 seconds between polls (add 5 seconds to your interval).",
            ),
            GrantError::AccessDenied(d) => OAuthError::access_denied(d.clone()),
            GrantError::ExpiredToken(d) => OAuthError::expired_token(d.clone()),
            GrantError::Internal(m) => OAuthError::server_error(m),
        }
    }
}

impl From<GrantError> for OAuthError {
    fn from(e: GrantError) -> Self {
        e.to_oauth()
    }
}

impl From<sqlx::Error> for GrantError {
    fn from(e: sqlx::Error) -> Self {
        GrantError::Internal(format!("database: {e}"))
    }
}

impl From<ApiError> for GrantError {
    fn from(e: ApiError) -> Self {
        if e.is_server_error() {
            GrantError::Internal(e.message)
        } else {
            GrantError::Invalid(e.message)
        }
    }
}

impl From<JwtError> for GrantError {
    fn from(e: JwtError) -> Self {
        GrantError::Internal(format!("jwt: {e}"))
    }
}

/// Input for [`create_family`].
#[derive(Debug, Clone)]
pub struct NewFamily<'a> {
    pub app_id: &'a str,
    pub account_uuid: &'a str,
    pub origin: TokenOrigin,
    pub scopes: &'a [Scope],
    pub browser_session_id: Option<Uuid>,
    /// Shown on the sessions page for first-party sign-ins (e.g. "silicon-accounts CLI on mac").
    pub label: Option<&'a str>,
    pub ip: Option<&'a str>,
    pub user_agent: Option<&'a str>,
    /// When the account authenticated (see [`TokenFamily::auth_time`]); `None` = now.
    pub auth_time: Option<OffsetDateTime>,
}

/// Creates a token family (expires 900 days from now).
pub async fn create_family(conn: &mut PgConnection, new: &NewFamily<'_>) -> ApiResult<TokenFamily> {
    create_family_for(conn, new, None).await
}

/// Creates a token family that expires `lifetime_seconds` from now (database clock), or 900
/// days from now.
async fn create_family_for(
    conn: &mut PgConnection,
    new: &NewFamily<'_>,
    lifetime_seconds: Option<i64>,
) -> ApiResult<TokenFamily> {
    Ok(sqlx::query_as::<_, TokenFamily>(concat!(
        "insert into token_families (id, app_id, account_uuid, origin, scopes, browser_session_id, label, expires_at, ip, user_agent, auth_time) \
         values ($1, $2, $3, $4, $5, $6, $7, \
                 now() + coalesce(make_interval(secs => $12), make_interval(days => $8)), $9, $10, $11) returning ",
        family_columns!()
    ))
    .bind(Uuid::now_v7())
    .bind(new.app_id)
    .bind(new.account_uuid)
    .bind(new.origin)
    .bind(scope_strings(new.scopes))
    .bind(new.browser_session_id)
    .bind(new.label.map(|l| l.chars().take(200).collect::<String>()))
    .bind(REFRESH_TOKEN_DAYS as i32)
    .bind(new.ip)
    .bind(new.user_agent.map(|u| u.chars().take(400).collect::<String>()))
    .bind(new.auth_time)
    .bind(lifetime_seconds.map(|s| s as f64))
    .fetch_one(&mut *conn)
    .await?)
}

/// The `issued_token_type` of an access token (RFC 8693).
pub const ACCESS_TOKEN_TYPE: &str = "urn:ietf:params:oauth:token-type:access_token";

async fn insert_refresh(
    conn: &mut PgConnection,
    pepper: &Pepper,
    family_id: Uuid,
    generation: i32,
) -> ApiResult<String> {
    let token = random_token(prefix::REFRESH);
    sqlx::query(
        "insert into refresh_tokens (token_hash, family_id, generation) values ($1, $2, $3)",
    )
    .bind(pepper.hash(&token))
    .bind(family_id)
    .bind(generation)
    .execute(&mut *conn)
    .await?;
    Ok(token)
}

/// What to issue in [`issue_tokens`].
#[derive(Debug, Clone)]
pub struct IssueRequest<'a> {
    pub account: &'a Account,
    pub app_id: &'a str,
    pub origin: TokenOrigin,
    /// Granted scopes (always include `profile`; `openid` adds an id_token).
    pub scopes: &'a [Scope],
    pub browser_session_id: Option<Uuid>,
    pub label: Option<&'a str>,
    pub ip: Option<&'a str>,
    pub user_agent: Option<&'a str>,
    /// OIDC nonce from the authorization request.
    pub nonce: Option<&'a str>,
    /// When the account actually authenticated, if earlier than now: an authorization code's
    /// [`AuthCode::auth_time`]. Kept on the family for every id_token it issues (OIDC
    /// `auth_time`), also after refreshes. `None` = now.
    pub auth_time: Option<OffsetDateTime>,
}

/// Starts a sign-in: creates the family and returns the full token response (access token,
/// refresh token, id_token when `openid` was granted, and the scoped account view). Record the
/// membership and sign-in history in the caller.
pub async fn issue_tokens(
    conn: &mut PgConnection,
    keys: &Keys,
    settings: &Settings,
    req: IssueRequest<'_>,
) -> ApiResult<TokenResponse> {
    issue_tokens_inner(conn, keys, settings, req, None)
        .await
        .map(|(response, _)| response)
}

/// Like [`issue_tokens`], for a sign-in that ends `lifetime_seconds` from now (database clock)
/// instead of after 900 days: its refresh tokens rotate as usual but stop with it, and so do its
/// access tokens. Used for sign-ins with a trusted outside token, which never outlive that
/// token by more than one access token. Returns the response and the family, so the caller can
/// link the family to what started it.
pub async fn issue_tokens_for(
    conn: &mut PgConnection,
    keys: &Keys,
    settings: &Settings,
    req: IssueRequest<'_>,
    lifetime_seconds: i64,
) -> ApiResult<(TokenResponse, TokenFamily)> {
    issue_tokens_inner(conn, keys, settings, req, Some(lifetime_seconds.max(1))).await
}

async fn issue_tokens_inner(
    conn: &mut PgConnection,
    keys: &Keys,
    settings: &Settings,
    req: IssueRequest<'_>,
    lifetime_seconds: Option<i64>,
) -> ApiResult<(TokenResponse, TokenFamily)> {
    if !req.account.is_active() {
        return Err(ApiError::forbidden(
            "account_not_active",
            format!(
                "{} is {} and can't receive tokens.",
                req.account.display_id(),
                req.account.status
            ),
        ));
    }
    let scopes = crate::models::normalize_scopes(req.scopes.to_vec());
    let family = create_family_for(
        conn,
        &NewFamily {
            app_id: req.app_id,
            account_uuid: &req.account.uuid,
            origin: req.origin,
            scopes: &scopes,
            browser_session_id: req.browser_session_id,
            label: req.label,
            ip: req.ip,
            user_agent: req.user_agent,
            auth_time: req.auth_time,
        },
        lifetime_seconds,
    )
    .await?;
    let refresh_token = insert_refresh(conn, &keys.pepper, family.id, 1).await?;
    let response = build_response(
        conn,
        keys,
        settings,
        req.account,
        &family,
        refresh_token,
        req.nonce,
    )
    .await?;
    Ok((response, family))
}

async fn build_response(
    conn: &mut PgConnection,
    keys: &Keys,
    settings: &Settings,
    account: &Account,
    family: &TokenFamily,
    refresh_token: String,
    nonce: Option<&str>,
) -> ApiResult<TokenResponse> {
    let scopes = family.scope_list();
    let scope = scopes_to_string(&scopes);
    let (access_token, claims) = keys.jwt.sign_access(&AccessTokenInput {
        account_uuid: &account.uuid,
        app_id: &family.app_id,
        kind: account.kind,
        id: account.id(),
        family_id: family.id,
        scope: &scope,
        ttl_seconds: settings.access_token_ttl_seconds,
    })?;
    let view = load_account_for_app(conn, account, &family.app_id, &scopes).await?;
    let id_token = if scopes.contains(&Scope::Openid) {
        let mut c = IdTokenClaims {
            iss: settings.issuer().to_string(),
            sub: account.uuid.clone(),
            aud: family.app_id.clone(),
            exp: claims.exp,
            iat: claims.iat,
            auth_time: Some(family.authenticated_at().unix_timestamp()),
            nonce: nonce.map(str::to_string),
            name: Some(account.display_name.clone()),
            picture: Some(account.pfp_url.clone()),
            preferred_username: account.handle.clone(),
            ..Default::default()
        };
        if let Some(e) = &view.email {
            c.email = Some(e.clone());
            c.email_verified = view.email_verified;
        }
        if let Some(p) = &view.phone {
            c.phone_number = Some(p.clone());
            c.phone_number_verified = view.phone_verified;
        }
        c.zoneinfo = view.timezone.clone();
        c.birthdate = view.dob.map(crate::timefmt::format_date);
        Some(keys.jwt.sign_id_token(&c)?)
    } else {
        None
    };
    Ok(TokenResponse {
        access_token,
        token_type: "Bearer".into(),
        expires_in: settings.access_token_ttl_seconds,
        refresh_token,
        refresh_token_expires_at: family.expires_at,
        scope,
        id_token,
        membership_id: crate::ids::membership_id(&family.app_id, &account.uuid),
        account: view,
    })
}

/// Rotates a refresh token for `app_id` and returns a new token response.
///
/// Unknown / other app's / revoked / expired tokens → [`GrantError::Invalid`]; a used token →
/// the family is revoked (`refresh_token_reuse`) and [`GrantError::Reused`]. Takes the pool so
/// the revocation commits even though the request fails.
pub async fn refresh(
    pool: &PgPool,
    keys: &Keys,
    settings: &Settings,
    presented: &str,
    app_id: &str,
) -> Result<TokenResponse, GrantError> {
    let presented = presented.trim();
    if !presented.starts_with(prefix::REFRESH) {
        let what = crate::crypto::describe_token(presented)
            .unwrap_or("not a Silicon Accounts refresh token");
        return Err(GrantError::Invalid(format!(
            "refresh_token must be a refresh token (it starts with sar_), but this is {what}."
        )));
    }
    let hash = keys.pepper.hash(presented);
    let mut tx = pool.begin().await?;
    let row: Option<(i32, Option<OffsetDateTime>, Uuid)> =
        sqlx::query_as("select generation, used_at, family_id from refresh_tokens where token_hash = $1 for update")
            .bind(&hash)
            .fetch_optional(&mut *tx)
            .await?;
    let Some((generation, used_at, family_id)) = row else {
        return Err(GrantError::Invalid(
            "The refresh token is not known to Silicon Accounts: it is mistyped, or it belongs to another environment."
                .into(),
        ));
    };
    let FamilyRow { family, expired } = sqlx::query_as::<_, FamilyRow>(concat!(
        "select ",
        family_columns!(),
        ", expires_at <= now() as expired from token_families where id = $1 for update"
    ))
    .bind(family_id)
    .fetch_one(&mut *tx)
    .await?;
    if family.app_id != app_id {
        return Err(GrantError::Invalid(format!(
            "The refresh token was issued to a different app, not to '{app_id}'; an app can only refresh its own tokens."
        )));
    }
    if let Some(at) = family.revoked_at {
        return Err(GrantError::Invalid(format!(
            "The sign-in this refresh token belongs to was revoked at {} ({}); sign in again.",
            crate::timefmt::format_rfc3339_ms(at),
            family.revoke_reason.as_deref().unwrap_or("revoked")
        )));
    }
    if expired {
        return Err(GrantError::Invalid(format!(
            "The refresh token expired at {} (refresh tokens last {REFRESH_TOKEN_DAYS} days from sign-in); sign in again.",
            crate::timefmt::format_rfc3339_ms(family.expires_at)
        )));
    }
    if used_at.is_some() {
        sqlx::query(
            "update token_families set revoked_at = now(), revoke_reason = 'refresh_token_reuse' where id = $1 and revoked_at is null",
        )
        .bind(family.id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        tracing::warn!(family_id = %family.id, app_id = %family.app_id, "refresh token reuse detected; family revoked");
        return Err(GrantError::Reused {
            family_id: family.id,
            app_id: family.app_id,
            account_uuid: family.account_uuid,
        });
    }
    let account = crate::repo::accounts::get(&mut tx, &family.account_uuid)
        .await?
        .ok_or_else(|| {
            GrantError::Invalid("The account of this sign-in no longer exists.".into())
        })?;
    if account.status != AccountStatus::Active {
        return Err(GrantError::Invalid(format!(
            "The account {} is {}, so its tokens can't be refreshed.",
            account.display_id(),
            account.status
        )));
    }
    sqlx::query("update refresh_tokens set used_at = now() where token_hash = $1")
        .bind(&hash)
        .execute(&mut *tx)
        .await?;
    let next = insert_refresh(&mut tx, &keys.pepper, family.id, generation + 1).await?;
    sqlx::query("update token_families set last_used_at = now() where id = $1")
        .bind(family.id)
        .execute(&mut *tx)
        .await?;
    let response = build_response(&mut tx, keys, settings, &account, &family, next, None).await?;
    tx.commit().await?;
    Ok(response)
}

/// The family a refresh token belongs to, with (generation, used_at).
pub async fn family_for_refresh_token(
    conn: &mut PgConnection,
    pepper: &Pepper,
    token: &str,
) -> ApiResult<Option<(TokenFamily, i32, Option<OffsetDateTime>)>> {
    let row: Option<(i32, Option<OffsetDateTime>, Uuid)> = sqlx::query_as(
        "select generation, used_at, family_id from refresh_tokens where token_hash = $1",
    )
    .bind(pepper.hash(token.trim()))
    .fetch_optional(&mut *conn)
    .await?;
    let Some((generation, used_at, family_id)) = row else {
        return Ok(None);
    };
    Ok(find_family(conn, family_id)
        .await?
        .map(|f| (f, generation, used_at)))
}

/// Fetches a family.
pub async fn find_family(conn: &mut PgConnection, id: Uuid) -> ApiResult<Option<TokenFamily>> {
    Ok(sqlx::query_as::<_, TokenFamily>(concat!(
        "select ",
        family_columns!(),
        " from token_families where id = $1"
    ))
    .bind(id)
    .fetch_optional(&mut *conn)
    .await?)
}

/// Revokes one family. Returns it when it was active (so callers can emit
/// `membership.signed_out`), `None` when it was already revoked or doesn't exist.
pub async fn revoke_family(
    conn: &mut PgConnection,
    id: Uuid,
    reason: &str,
) -> ApiResult<Option<TokenFamily>> {
    Ok(sqlx::query_as::<_, TokenFamily>(concat!(
        "update token_families set revoked_at = now(), revoke_reason = $2 where id = $1 and revoked_at is null returning ",
        family_columns!()
    ))
    .bind(id)
    .bind(reason)
    .fetch_optional(&mut *conn)
    .await?)
}

/// Which families [`revoke_families`] revokes.
#[derive(Debug, Clone, Default)]
pub struct RevokeFilter<'a> {
    pub account_uuid: &'a str,
    pub app_id: Option<&'a str>,
    pub origin: Option<TokenOrigin>,
    /// Keep this family (e.g. the caller's own session).
    pub except: Option<Uuid>,
}

/// Revokes every active family matching the filter; returns the revoked families.
pub async fn revoke_families(
    conn: &mut PgConnection,
    filter: &RevokeFilter<'_>,
    reason: &str,
) -> ApiResult<Vec<TokenFamily>> {
    Ok(sqlx::query_as::<_, TokenFamily>(concat!(
        "update token_families set revoked_at = now(), revoke_reason = $5 \
         where account_uuid = $1 and revoked_at is null \
           and ($2::text is null or app_id = $2) and ($3::text is null or origin = $3) and ($4::uuid is null or id <> $4) \
         returning ",
        family_columns!()
    ))
    .bind(filter.account_uuid)
    .bind(filter.app_id)
    .bind(filter.origin.map(|o| o.as_str()))
    .bind(filter.except)
    .bind(reason)
    .fetch_all(&mut *conn)
    .await?)
}

/// Families of an account (optionally one app), newest first.
pub async fn list_families(
    conn: &mut PgConnection,
    account_uuid: &str,
    app_id: Option<&str>,
    active_only: bool,
) -> ApiResult<Vec<TokenFamily>> {
    Ok(sqlx::query_as::<_, TokenFamily>(concat!(
        "select ",
        family_columns!(),
        " from token_families where account_uuid = $1 and ($2::text is null or app_id = $2) \
          and (not $3 or (revoked_at is null and expires_at > now())) order by created_at desc"
    ))
    .bind(account_uuid)
    .bind(app_id)
    .bind(active_only)
    .fetch_all(&mut *conn)
    .await?)
}

/// Number of active families of an account at an app (the "active sessions" count).
pub async fn count_active_families(
    conn: &mut PgConnection,
    account_uuid: &str,
    app_id: &str,
) -> ApiResult<i64> {
    Ok(sqlx::query_scalar(
        "select count(*) from token_families where account_uuid = $1 and app_id = $2 and revoked_at is null and expires_at > now()",
    )
    .bind(account_uuid)
    .bind(app_id)
    .fetch_one(&mut *conn)
    .await?)
}

/// A verified access token: its claims, its (active) family and the account.
#[derive(Debug, Clone)]
pub struct VerifiedAccess {
    pub claims: AccessClaims,
    pub family: TokenFamily,
    pub account: Account,
}

/// Verifies an access token: signature, issuer, expiry, optional audience, an active family and
/// a non-deleted account. Errors are 401s with precise codes: `invalid_token`,
/// `token_wrong_audience`, `token_revoked`, `account_deleted`.
pub async fn verify_access_token(
    conn: &mut PgConnection,
    keys: &Keys,
    token: &str,
    audience: Option<&str>,
) -> ApiResult<VerifiedAccess> {
    let token = token.trim();
    if !token.starts_with("eyJ") {
        let what = crate::crypto::describe_token(token).unwrap_or("not a Silicon Accounts token");
        return Err(ApiError::unauthenticated(
            "invalid_token",
            format!("The bearer token must be an access token (a JWT starting with eyJ), but this is {what}."),
        )
        .hint("Exchange it at POST /v1/oauth/token for an access token, or sign in again."));
    }
    if crate::identity_tokens::is_identity_token(token) {
        return Err(crate::identity_tokens::not_an_access_token());
    }
    let claims = keys.jwt.verify_access(token, audience).map_err(|e| match e {
        JwtError::WrongAudience { expected, got } => ApiError::unauthenticated(
            "token_wrong_audience",
            format!("This access token was issued to the app '{got}', but this endpoint needs a token issued to '{expected}'."),
        )
        .hint(if expected == crate::FIRST_PARTY_APP_ID {
            "Use a first-party token: sign in with `silicon-accounts login` (Carbons) or `silicon-accounts login --silicon si:<handle> --stk-stdin` (Silicons)."
                .to_string()
        } else {
            format!("Use a token that '{expected}' obtained for itself.")
        }),
        JwtError::Expired => ApiError::unauthenticated(
            "invalid_token",
            "The access token expired (access tokens last 30 minutes).",
        )
        .hint("Refresh it with POST /v1/oauth/token grant_type=refresh_token; the silicon-accounts CLI does this automatically."),
        other => ApiError::unauthenticated("invalid_token", format!("The access token is not valid: {other}."))
            .hint("Sign in again to get a fresh token."),
    })?;
    let family_id = claims.family_id().ok_or_else(|| {
        ApiError::unauthenticated(
            "invalid_token",
            "The access token has no valid family id (fid).",
        )
    })?;
    let FamilyRow { family, expired } = sqlx::query_as::<_, FamilyRow>(concat!(
        "select ",
        family_columns!(),
        ", expires_at <= now() as expired from token_families where id = $1"
    ))
    .bind(family_id)
    .fetch_optional(&mut *conn)
    .await?
    .ok_or_else(|| {
        ApiError::unauthenticated(
            "token_revoked",
            "The sign-in behind this access token no longer exists.",
        )
    })?;
    if family.account_uuid != claims.sub || family.app_id != claims.aud {
        tracing::error!(family_id = %family.id, "access token claims don't match their token family");
        return Err(ApiError::unauthenticated(
            "invalid_token",
            "The access token does not match the sign-in it claims to belong to.",
        )
        .hint("Sign in again."));
    }
    if let Some(at) = family.revoked_at {
        return Err(ApiError::unauthenticated(
            "token_revoked",
            format!(
                "The sign-in behind this access token was revoked at {} ({}).",
                crate::timefmt::format_rfc3339_ms(at),
                family.revoke_reason.as_deref().unwrap_or("revoked")
            ),
        )
        .hint("Sign in again."));
    }
    if expired {
        return Err(ApiError::unauthenticated(
            "token_revoked",
            "The sign-in behind this access token expired.",
        )
        .hint("Sign in again."));
    }
    let account = crate::repo::accounts::get(conn, &claims.sub)
        .await?
        .ok_or_else(|| {
            ApiError::unauthenticated(
                "account_deleted",
                "The account of this access token no longer exists.",
            )
        })?;
    if account.status == AccountStatus::Deleted {
        return Err(ApiError::unauthenticated(
            "account_deleted",
            format!("The account {} was deleted.", account.uuid),
        ));
    }
    Ok(VerifiedAccess {
        claims,
        family,
        account,
    })
}

/// Input for [`create_code`].
#[derive(Debug, Clone)]
pub struct NewAuthCode<'a> {
    pub flow_id: &'a str,
    pub app_id: &'a str,
    pub account_uuid: &'a str,
    pub redirect_uri: &'a str,
    pub code_challenge: Option<&'a str>,
    /// `S256` or `plain` (validate with `crypto::pkce::validate_method`).
    pub code_challenge_method: Option<&'a str>,
    pub scopes: &'a [Scope],
    pub nonce: Option<&'a str>,
    pub browser_session_id: Option<Uuid>,
    /// When the account authenticated in the browser that completed the flow (the browser
    /// session's `authenticated_at`). The token family issued from the code keeps it.
    pub auth_time: Option<OffsetDateTime>,
}

/// A stored authorization code.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct AuthCode {
    pub code_hash: Vec<u8>,
    pub flow_id: String,
    pub app_id: String,
    pub account_uuid: String,
    pub redirect_uri: String,
    pub code_challenge: Option<String>,
    pub code_challenge_method: Option<String>,
    pub scopes: Vec<String>,
    pub nonce: Option<String>,
    pub browser_session_id: Option<Uuid>,
    pub created_at: OffsetDateTime,
    pub expires_at: OffsetDateTime,
    pub consumed_at: Option<OffsetDateTime>,
    /// When the account authenticated (see [`NewAuthCode::auth_time`]); pass it as
    /// [`IssueRequest::auth_time`].
    pub auth_time: Option<OffsetDateTime>,
}

/// Columns of [`AuthCode`], in its field order (for `select`s of other crates).
#[macro_export]
macro_rules! auth_code_columns {
    () => {
        "code_hash, flow_id, app_id, account_uuid, redirect_uri, code_challenge, code_challenge_method, scopes, \
         nonce, browser_session_id, created_at, expires_at, consumed_at, auth_time"
    };
}

impl AuthCode {
    /// Pass as `IssueRequest::label` when issuing tokens for this code, so reusing the code
    /// revokes those tokens (RFC 6749 §4.1.2).
    pub fn family_label(&self) -> String {
        format!(
            "code:{}",
            hex::encode(&self.code_hash[..8.min(self.code_hash.len())])
        )
    }

    pub fn scope_list(&self) -> Vec<Scope> {
        scopes_from_strings(&self.scopes)
    }
}

/// Creates a single-use authorization code (`sac_…`, 120 s).
pub async fn create_code(
    conn: &mut PgConnection,
    pepper: &Pepper,
    new: &NewAuthCode<'_>,
) -> ApiResult<String> {
    let code = random_token(prefix::AUTH_CODE);
    sqlx::query(
        "insert into authorization_codes (code_hash, flow_id, app_id, account_uuid, redirect_uri, code_challenge, \
         code_challenge_method, scopes, nonce, browser_session_id, expires_at, auth_time) \
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now() + make_interval(secs => $11), $12)",
    )
    .bind(pepper.hash(&code))
    .bind(new.flow_id)
    .bind(new.app_id)
    .bind(new.account_uuid)
    .bind(new.redirect_uri)
    .bind(new.code_challenge)
    .bind(new.code_challenge.map(|_| new.code_challenge_method.unwrap_or("S256")))
    .bind(scope_strings(new.scopes))
    .bind(new.nonce)
    .bind(new.browser_session_id)
    .bind(AUTH_CODE_TTL_SECONDS as f64)
    .bind(new.auth_time)
    .execute(&mut *conn)
    .await?;
    Ok(code)
}

/// Redeems an authorization code for `app_id`. Checks single use, expiry, app, exact
/// `redirect_uri`, and PKCE: a `code_verifier` is required when the flow had a challenge, and
/// refused when it had none (RFC 9700 §2.1.1: otherwise a client relying on PKCE could be fed a
/// code an attacker obtained without one). Any failed attempt burns the code; a reused code also
/// revokes the tokens issued from it. Takes the pool so that sticks.
///
/// The consumption commits before the caller issues tokens, so a concurrent reuse can miss the
/// tokens the winner issues afterwards. The token endpoint (the oauth crate) therefore consumes
/// and issues in one transaction under the code's row lock instead; use this only where that
/// doesn't matter (tests, tools).
pub async fn consume_code(
    pool: &PgPool,
    pepper: &Pepper,
    code: &str,
    app_id: &str,
    redirect_uri: Option<&str>,
    code_verifier: Option<&str>,
) -> Result<AuthCode, GrantError> {
    let code = code.trim();
    if !code.starts_with(prefix::AUTH_CODE) {
        let what = crate::crypto::describe_token(code)
            .unwrap_or("not a Silicon Accounts authorization code");
        return Err(GrantError::Invalid(format!(
            "code must be an authorization code (it starts with sac_), but this is {what}."
        )));
    }
    let mut tx = pool.begin().await?;
    let row = sqlx::query_as::<_, CodeRow>(concat!(
        "select ",
        auth_code_columns!(),
        ", expires_at <= now() as expired from authorization_codes where code_hash = $1 for update"
    ))
    .bind(pepper.hash(code))
    .fetch_optional(&mut *tx)
    .await?;
    let Some(CodeRow {
        code: auth,
        expired,
    }) = row
    else {
        return Err(GrantError::Invalid(
            "The authorization code is not known: it is mistyped or was never issued.".into(),
        ));
    };
    if auth.consumed_at.is_some() {
        sqlx::query(
            "update token_families set revoked_at = now(), revoke_reason = 'authorization_code_reuse' \
             where label = $1 and app_id = $2 and account_uuid = $3 and revoked_at is null",
        )
        .bind(auth.family_label())
        .bind(&auth.app_id)
        .bind(&auth.account_uuid)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        return Err(GrantError::Invalid(
            "The authorization code was already used. Codes are single-use; tokens issued from it were revoked as a precaution."
                .into(),
        ));
    }
    let failure = if expired {
        Some(format!(
            "The authorization code expired at {} (codes are valid for {AUTH_CODE_TTL_SECONDS} seconds); start the sign-in again.",
            crate::timefmt::format_rfc3339_ms(auth.expires_at)
        ))
    } else if auth.app_id != app_id {
        Some(format!(
            "The authorization code was issued to a different app, not to '{app_id}'."
        ))
    } else if redirect_uri.map(str::trim) != Some(auth.redirect_uri.as_str()) {
        Some(match redirect_uri {
            None => format!(
                "redirect_uri is required and must equal the one used at /authorize ({}).",
                auth.redirect_uri
            ),
            Some(r) => format!(
                "redirect_uri '{r}' does not match the redirect_uri used at /authorize ({}).",
                auth.redirect_uri
            ),
        })
    } else if let Some(challenge) = &auth.code_challenge {
        match code_verifier {
            None => Some("code_verifier is required because the authorization request sent a code_challenge (PKCE).".into()),
            Some(v) => {
                if pkce::verify(auth.code_challenge_method.as_deref(), v.trim(), challenge) {
                    None
                } else {
                    Some(format!(
                        "PKCE verification failed: the code_verifier does not match the code_challenge ({} method).",
                        auth.code_challenge_method.as_deref().unwrap_or("S256")
                    ))
                }
            }
        }
    } else if code_verifier.is_some() {
        Some(
            "code_verifier was sent, but the authorization request had no code_challenge. It is refused to prevent PKCE downgrade attacks (RFC 9700 section 2.1.1): send code_challenge with code_challenge_method=S256 to /authorize, or omit code_verifier."
                .to_string(),
        )
    } else {
        None
    };
    sqlx::query("update authorization_codes set consumed_at = now() where code_hash = $1")
        .bind(&auth.code_hash)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    match failure {
        Some(msg) => Err(GrantError::Invalid(msg)),
        None => Ok(auth),
    }
}

/// An authorization code with its expiry judged by the database clock.
#[derive(sqlx::FromRow)]
struct CodeRow {
    #[sqlx(flatten)]
    code: AuthCode,
    expired: bool,
}

/// A stored short-lived token.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct ShortLivedToken {
    pub token_hash: Vec<u8>,
    pub account_uuid: String,
    pub app_id: String,
    pub scopes: Vec<String>,
    pub created_at: OffsetDateTime,
    pub expires_at: OffsetDateTime,
    pub consumed_at: Option<OffsetDateTime>,
}

impl ShortLivedToken {
    pub fn scope_list(&self) -> Vec<Scope> {
        scopes_from_strings(&self.scopes)
    }
}

/// Creates a single-use SLT (`slt_…`, 120 s) bound to `app_id`. Returns the token and expiry.
pub async fn create_slt(
    conn: &mut PgConnection,
    pepper: &Pepper,
    account_uuid: &str,
    app_id: &str,
    scopes: &[Scope],
) -> ApiResult<(String, OffsetDateTime)> {
    let token = random_token(prefix::SLT);
    let expires_at: OffsetDateTime = sqlx::query_scalar(
        "insert into short_lived_tokens (token_hash, account_uuid, app_id, scopes, expires_at) \
         values ($1, $2, $3, $4, now() + make_interval(secs => $5)) returning expires_at",
    )
    .bind(pepper.hash(&token))
    .bind(account_uuid)
    .bind(app_id)
    .bind(scope_strings(&crate::models::normalize_scopes(
        scopes.to_vec(),
    )))
    .bind(SLT_TTL_SECONDS as f64)
    .fetch_one(&mut *conn)
    .await?;
    Ok((token, expires_at))
}

/// Redeems an SLT for `app_id` (single use, 120 s, bound to the app).
pub async fn consume_slt(
    pool: &PgPool,
    pepper: &Pepper,
    slt: &str,
    app_id: &str,
) -> Result<ShortLivedToken, GrantError> {
    let slt = slt.trim();
    if !slt.starts_with(prefix::SLT) {
        let what = crate::crypto::describe_token(slt)
            .unwrap_or("not a Silicon Accounts short-lived token");
        return Err(GrantError::Invalid(format!(
            "slt must be a short-lived token (it starts with slt_), but this is {what}."
        )));
    }
    let mut tx = pool.begin().await?;
    let row: Option<(ShortLivedToken, bool)> = sqlx::query_as::<_, SltRow>(
        "select token_hash, account_uuid, app_id, scopes, created_at, expires_at, consumed_at, \
                expires_at <= now() as expired from short_lived_tokens \
         where token_hash = $1 for update",
    )
    .bind(pepper.hash(slt))
    .fetch_optional(&mut *tx)
    .await?
    .map(|r| (r.token, r.expired));
    let Some((t, expired)) = row else {
        return Err(GrantError::Invalid(
            "The short-lived token is not known: it is mistyped or was never issued.".into(),
        ));
    };
    if t.consumed_at.is_some() {
        return Err(GrantError::Invalid(
            "The short-lived token was already used; each one works once. Get a new one.".into(),
        ));
    }
    let failure = if expired {
        Some(format!(
            "The short-lived token expired at {} (they last {SLT_TTL_SECONDS} seconds); get a new one with `silicon-accounts login --app {}`.",
            crate::timefmt::format_rfc3339_ms(t.expires_at),
            t.app_id
        ))
    } else if t.app_id != app_id {
        Some(format!(
            "The short-lived token was issued for the app '{}', not for '{app_id}'; get one for '{app_id}' with `silicon-accounts login --app {app_id}`.",
            t.app_id
        ))
    } else {
        None
    };
    sqlx::query("update short_lived_tokens set consumed_at = now() where token_hash = $1")
        .bind(&t.token_hash)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    match failure {
        Some(m) => Err(GrantError::Invalid(m)),
        None => Ok(t),
    }
}

/// A short-lived token with its expiry judged by the database clock.
#[derive(sqlx::FromRow)]
struct SltRow {
    #[sqlx(flatten)]
    token: ShortLivedToken,
    expired: bool,
}

/// A device authorization (CLI device flow).
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct DeviceAuthorization {
    pub device_code_hash: Vec<u8>,
    pub user_code: String,
    pub app_id: String,
    /// `pending` | `approved` | `denied` | `consumed`.
    pub status: String,
    pub account_uuid: Option<String>,
    pub client_label: Option<String>,
    pub created_at: OffsetDateTime,
    pub expires_at: OffsetDateTime,
    pub approved_at: Option<OffsetDateTime>,
    pub last_polled_at: Option<OffsetDateTime>,
    /// What an app's tool asked to share (`None` for the silicon-accounts CLI: `profile`).
    pub scopes: Option<Vec<String>>,
}

impl DeviceAuthorization {
    /// True for a sign-in of Silicon Accounts' own CLI.
    pub fn first_party(&self) -> bool {
        crate::is_first_party_app_id(&self.app_id)
    }

    /// The scopes the approving Carbon shares.
    pub fn scope_list(&self) -> Vec<crate::models::Scope> {
        match &self.scopes {
            Some(s) => crate::models::scopes_from_strings(s),
            None => vec![crate::models::Scope::Profile],
        }
    }
}

/// Result of [`create_device`]. `Debug` hides the device code (a bearer credential).
#[derive(Clone)]
pub struct DeviceStart {
    pub device_code: String,
    pub user_code: String,
    pub expires_at: OffsetDateTime,
    pub interval: i64,
}

impl std::fmt::Debug for DeviceStart {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DeviceStart")
            .field("device_code", &"[redacted]")
            .field("user_code", &self.user_code)
            .field("expires_at", &self.expires_at)
            .field("interval", &self.interval)
            .finish()
    }
}

/// A device authorization with its expiry judged by the database clock.
#[derive(sqlx::FromRow)]
struct DeviceRow {
    #[sqlx(flatten)]
    device: DeviceAuthorization,
    expired: bool,
    /// Milliseconds since the previous poll (database clock), if any.
    since_last_poll_ms: Option<f64>,
}

macro_rules! device_columns {
    () => {
        "device_code_hash, user_code, app_id, status, account_uuid, client_label, created_at, expires_at, approved_at, last_polled_at, scopes"
    };
}

/// Starts a device authorization for the first-party app (600 s, poll every 5 s).
pub async fn create_device(
    conn: &mut PgConnection,
    pepper: &Pepper,
    client_label: Option<&str>,
) -> ApiResult<DeviceStart> {
    create_app_device(conn, pepper, crate::FIRST_PARTY_APP_ID, client_label, None).await
}

/// Starts a device authorization for `app_id` (600 s, poll every 5 s) asking for `scopes`
/// (`None` for the first-party CLI).
pub async fn create_app_device(
    conn: &mut PgConnection,
    pepper: &Pepper,
    app_id: &str,
    client_label: Option<&str>,
    scopes: Option<&[crate::models::Scope]>,
) -> ApiResult<DeviceStart> {
    let scopes: Option<Vec<String>> = scopes.map(crate::models::scope_strings);
    let device_code = random_token(prefix::DEVICE_CODE);
    let label = client_label
        .map(|l| l.trim().chars().take(100).collect::<String>())
        .filter(|l| !l.is_empty());
    for _ in 0..8 {
        let user_code = crate::crypto::generate_user_code();
        let res: Result<OffsetDateTime, sqlx::Error> = sqlx::query_scalar(
            "insert into device_authorizations (device_code_hash, user_code, app_id, status, client_label, expires_at, scopes) \
             values ($1, $2, $5, 'pending', $3, now() + make_interval(secs => $4), $6) returning expires_at",
        )
        .bind(pepper.hash(&device_code))
        .bind(&user_code)
        .bind(&label)
        .bind(DEVICE_CODE_TTL_SECONDS as f64)
        .bind(app_id)
        .bind(&scopes)
        .fetch_one(&mut *conn)
        .await;
        match res {
            Ok(expires_at) => {
                return Ok(DeviceStart {
                    device_code,
                    user_code,
                    expires_at,
                    interval: DEVICE_POLL_INTERVAL_SECONDS,
                });
            }
            Err(e)
                if crate::repo::is_unique_violation(
                    &e,
                    Some("device_authorizations_user_code_key"),
                ) =>
            {
                continue;
            }
            Err(e) => return Err(e.into()),
        }
    }
    Err(ApiError::internal(
        "could not allocate a unique device user code",
    ))
}

/// Finds a device authorization by its user code (any spacing/case). 404 `device_code_not_found`.
pub async fn device_by_user_code(
    conn: &mut PgConnection,
    user_code: &str,
) -> ApiResult<DeviceAuthorization> {
    let code = crate::crypto::normalize_user_code(user_code).ok_or_else(|| {
        ApiError::not_found(
            "device_code_not_found",
            format!("'{user_code}' is not a device code; codes look like WDJB-MJHT."),
        )
        .hint("Copy the code exactly as the CLI printed it.")
    })?;
    sqlx::query_as::<_, DeviceAuthorization>(concat!(
        "select ",
        device_columns!(),
        " from device_authorizations where user_code = $1"
    ))
    .bind(&code)
    .fetch_optional(&mut *conn)
    .await?
    .ok_or_else(|| {
        ApiError::not_found(
            "device_code_not_found",
            format!("No device sign-in is waiting for the code {code}."),
        )
        .hint(
            "Check the code the CLI printed, or run `silicon-accounts login` again for a new one.",
        )
    })
}

/// Approves (`approve = true`) or denies a pending device authorization as `account_uuid`.
/// The code's row is locked first, so of concurrent decisions exactly one wins and the others
/// get 409 `device_code_used`.
/// Errors: 404 `device_code_not_found`, 410 `device_code_expired`, 409 `device_code_used`.
pub async fn decide_device(
    conn: &mut PgConnection,
    user_code: &str,
    account_uuid: &str,
    approve: bool,
) -> ApiResult<DeviceAuthorization> {
    let mut tx = conn.begin().await?;
    let found = device_by_user_code(&mut tx, user_code).await?;
    let DeviceRow {
        device: current,
        expired,
        ..
    } = sqlx::query_as::<_, DeviceRow>(concat!(
        "select ",
        device_columns!(),
        ", expires_at <= now() as expired, null::float8 as since_last_poll_ms \
         from device_authorizations where user_code = $1 for update"
    ))
    .bind(&found.user_code)
    .fetch_one(&mut *tx)
    .await?;
    if expired {
        // End the transaction now: a dropped one would keep the row lock until the caller's
        // connection is used again.
        tx.rollback().await?;
        return Err(ApiError::gone(
            "device_code_expired",
            format!(
                "The device code {} expired; device codes last {} minutes.",
                current.user_code,
                DEVICE_CODE_TTL_SECONDS / 60
            ),
        )
        .hint("Run `silicon-accounts login` again for a new code."));
    }
    if current.status != "pending" {
        tx.rollback().await?;
        return Err(ApiError::conflict(
            "device_code_used",
            format!(
                "The device code {} was already {}.",
                current.user_code, current.status
            ),
        )
        .hint("Run `silicon-accounts login` again if you need a new sign-in."));
    }
    let updated = sqlx::query_as::<_, DeviceAuthorization>(concat!(
        "update device_authorizations set status = $2, account_uuid = $3, approved_at = case when $2 = 'approved' then now() else null end \
         where user_code = $1 and status = 'pending' returning ",
        device_columns!()
    ))
    .bind(&current.user_code)
    .bind(if approve { "approved" } else { "denied" })
    .bind(account_uuid)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(updated)
}

/// Polls a device code of the first-party CLI; see [`poll_app_device`].
pub async fn poll_device(
    pool: &PgPool,
    pepper: &Pepper,
    device_code: &str,
) -> Result<DeviceAuthorization, GrantError> {
    poll_app_device(pool, pepper, device_code, crate::FIRST_PARTY_APP_ID).await
}

/// Polls a device code on behalf of `app_id`. Approved → marks it consumed and returns it
/// (issue tokens for `account_uuid` with origin `device`). Otherwise `AuthorizationPending`,
/// `SlowDown` (polled within 5 s), `AccessDenied`, `ExpiredToken` or `Invalid` (also for a code
/// started by another app, which stays untouched).
pub async fn poll_app_device(
    pool: &PgPool,
    pepper: &Pepper,
    device_code: &str,
    app_id: &str,
) -> Result<DeviceAuthorization, GrantError> {
    let device_code = device_code.trim();
    let mut tx = pool.begin().await?;
    let row = sqlx::query_as::<_, DeviceRow>(concat!(
        "select ",
        device_columns!(),
        ", expires_at <= now() as expired, \
           extract(epoch from (now() - last_polled_at))::float8 * 1000 as since_last_poll_ms \
         from device_authorizations where device_code_hash = $1 for update"
    ))
    .bind(pepper.hash(device_code))
    .fetch_optional(&mut *tx)
    .await?;
    let Some(DeviceRow {
        device: d,
        expired,
        since_last_poll_ms,
    }) = row
    else {
        return Err(GrantError::Invalid(
            "The device_code is not known: it is mistyped or was never issued.".into(),
        ));
    };
    if d.app_id != app_id {
        return Err(GrantError::Invalid(format!(
            "The device_code was started for another app, not for '{app_id}'; poll with the client_id that started it."
        )));
    }
    if expired && d.status != "consumed" {
        return Err(GrantError::ExpiredToken(format!(
            "The device code expired at {}; start the sign-in again for a new code.",
            crate::timefmt::format_rfc3339_ms(d.expires_at)
        )));
    }
    match d.status.as_str() {
        "denied" => Err(GrantError::AccessDenied(
            "The Carbon denied this device sign-in.".into(),
        )),
        "consumed" => Err(GrantError::Invalid(
            "The device code was already exchanged for tokens.".into(),
        )),
        "approved" => {
            let consumed = sqlx::query_as::<_, DeviceAuthorization>(concat!(
                "update device_authorizations set status = 'consumed', last_polled_at = now() where device_code_hash = $1 returning ",
                device_columns!()
            ))
            .bind(&d.device_code_hash)
            .fetch_one(&mut *tx)
            .await?;
            tx.commit().await?;
            Ok(consumed)
        }
        _ => {
            let too_fast = since_last_poll_ms
                .is_some_and(|ms| ms < (DEVICE_POLL_INTERVAL_SECONDS * 1000 - 250) as f64);
            sqlx::query("update device_authorizations set last_polled_at = now() where device_code_hash = $1")
                .bind(&d.device_code_hash)
                .execute(&mut *tx)
                .await?;
            tx.commit().await?;
            if too_fast {
                Err(GrantError::SlowDown)
            } else {
                Err(GrantError::AuthorizationPending)
            }
        }
    }
}
