//! SQL for proofs: families (`proof_families`) and their tokens (`proof_tokens`).
//!
//! A proof family is one proof: its kind, issuing app, audiences, the User verification subject and grant,
//! scopes and lifetime. It holds a chain of tokens: proof tokens (`sap_…`, `kind = access`) that
//! receiving apps verify, and proof refresh tokens (`sapr_…`, `kind = refresh`) that the issuing
//! app rotates — the same logic as sign-in token families. Only `HMAC(pepper, token)` is stored.
//!
//! Every expiry is decided with Postgres `now()`, so tests can time-travel by editing rows.
//!
//! A user verification proof stands on the account's sign-in at the issuing app (the token family of its
//! subject token). When that sign-in is revoked anywhere in the service (signed out, STK
//! rotated, sign-in refresh token reused, …) the proof is revoked too: verification and
//! listings check it live, and [`record_sign_in_revoked`] / [`sweep`] store it on the proof
//! (`revoke_reason = sign_in_revoked`, `revoked_at` = when the sign-in was revoked) with a
//! `proof.revoked` audit entry, so the account's history keeps it.

use accounts_core::ApiResult;
use accounts_core::crypto::{Pepper, prefix, random_token};
use accounts_core::models::{AccountKind, AccountStatus, ActorKind, App};
use sqlx::{PgConnection, PgPool};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::model::{
    AUDIT_TARGET, ENDED_PROOF_RETENTION_DAYS, EXPIRED_TOKEN_RETENTION_DAYS, FAMILY_TTL_DAYS,
    ProofKind, SYSTEM_REVOKER, action, revoke_reason,
};

macro_rules! family_columns {
    () => {
        "f.id, f.kind, f.issuing_app, f.audiences, f.account_uuid, f.subject_family_id, f.scopes, \
         f.access_ttl_seconds, f.created_at, f.expires_at, f.last_refreshed_at, f.revoked_at, f.revoked_by, \
         f.revoke_reason"
    };
}

/// Joins that tell whether a user verification proof's grant is still alive (subject sign-in, membership with
/// the issuing app, account). Alias `f` is the family.
macro_rules! grant_joins {
    () => {
        " left join accounts a on a.uuid = f.account_uuid \
          left join memberships m on m.app_id = f.issuing_app and m.account_uuid = f.account_uuid \
          left join token_families tf on tf.id = f.subject_family_id "
    };
}

/// True when a user verification proof's sign-in was revoked before the proof expired on its own (or the
/// sign-in is missing): the proof was revoked then, whether or not that is stored yet. This is
/// exactly what [`record_sign_in_revoked`] and [`sweep`] store (needs `tf` from
/// [`grant_joins`]). A sign-in revoked after the proof had already expired leaves it `expired`.
macro_rules! sign_in_revoked_sql {
    () => {
        "(f.kind = 'user_verification' and (tf.id is null or tf.revoked_at < f.expires_at))"
    };
}

/// When a proof ended because its sign-in was revoked: when the sign-in was revoked, but never
/// before the proof was issued (a sign-in revoked while the proof was being issued).
macro_rules! sign_in_revoked_at_sql {
    () => {
        "greatest(tf.revoked_at, f.created_at)"
    };
}

/// True when a user verification proof's membership with the issuing app or its account is not active
/// (needs [`grant_joins`]). The service's real paths store these ends themselves
/// (`access_removed`, `account_deleted`); anything else is derived live and never made
/// permanent here.
macro_rules! grant_inactive_sql {
    () => {
        "(f.kind = 'user_verification' and (m.status is distinct from 'active' or a.status is distinct from 'active'))"
    };
}

/// `active` | `revoked` | `expired`, as listings report it (needs [`grant_joins`]). Order:
/// revoked (stored, or its sign-in revoked before it expired), past its own lifetime, (User verification)
/// membership or account not active, (User verification) sign-in expired. Storing a sign-in revocation never
/// changes what a listing says.
macro_rules! status_sql {
    () => {
        concat!(
            "(case when f.revoked_at is not null then 'revoked' when ",
            sign_in_revoked_sql!(),
            " then 'revoked' when f.expires_at <= now() then 'expired' when ",
            grant_inactive_sql!(),
            " then 'revoked' when f.kind = 'user_verification' and tf.expires_at <= now() then 'expired' \
               else 'active' end)"
        )
    };
}

/// When it was revoked, or when the grant behind a user verification proof ended (if known); `null` unless
/// the status is `revoked`.
macro_rules! effective_revoked_at_sql {
    () => {
        concat!(
            "(case when f.revoked_at is not null then f.revoked_at when ",
            sign_in_revoked_sql!(),
            " then ",
            sign_in_revoked_at_sql!(),
            " when f.expires_at <= now() then null \
               when f.kind = 'user_verification' and m.status is distinct from 'active' then m.access_removed_at \
               when f.kind = 'user_verification' and a.status is distinct from 'active' then a.deleted_at \
               else null end)"
        )
    };
}

/// Why it is revoked (the stored reason, or the derived reason of an ended User verification grant); `null`
/// unless the status is `revoked`. The literals are `model::revoke_reason` values (checked by a
/// unit test).
macro_rules! effective_reason_sql {
    () => {
        concat!(
            "(case when f.revoked_at is not null then f.revoke_reason when ",
            sign_in_revoked_sql!(),
            " then 'sign_in_revoked' when f.expires_at <= now() then null \
               when f.kind = 'user_verification' and m.status is distinct from 'active' then 'membership_inactive' \
               when f.kind = 'user_verification' and a.status is distinct from 'active' then 'account_inactive' \
               else null end)"
        )
    };
}

/// Expiry of a family's newest proof token.
macro_rules! token_expires_at_sql {
    () => {
        "(select max(t.expires_at) from proof_tokens t where t.family_id = f.id and t.kind = 'access')"
    };
}

/// A `proof_families` row.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct FamilyRow {
    pub id: Uuid,
    pub kind: String,
    pub issuing_app: String,
    pub audiences: Vec<String>,
    pub account_uuid: Option<String>,
    pub subject_family_id: Option<Uuid>,
    pub scopes: Vec<String>,
    pub access_ttl_seconds: i32,
    pub created_at: OffsetDateTime,
    pub expires_at: OffsetDateTime,
    pub last_refreshed_at: Option<OffsetDateTime>,
    pub revoked_at: Option<OffsetDateTime>,
    pub revoked_by: Option<String>,
    pub revoke_reason: Option<String>,
}

impl FamilyRow {
    /// The kind (`user_verification` unless the row says `app_verification`; the column has a check constraint).
    pub fn kind(&self) -> ProofKind {
        ProofKind::parse(&self.kind).unwrap_or(ProofKind::UserVerification)
    }
}

/// What a new proof is.
#[derive(Debug, Clone)]
pub struct NewProof<'a> {
    pub kind: ProofKind,
    pub issuing_app: &'a str,
    pub audiences: &'a [String],
    /// User verification: (account uuid, the account's token family at the issuing app, its expiry).
    pub subject: Option<(&'a str, Uuid, OffsetDateTime)>,
    pub scopes: &'a [String],
    pub access_ttl_seconds: i64,
}

/// A freshly minted proof token + proof refresh token (plaintext, shown once). `Debug` never
/// prints the tokens.
#[derive(Clone)]
pub struct MintedTokens {
    pub access_token: String,
    pub access_expires_at: OffsetDateTime,
    pub refresh_token: String,
}

impl std::fmt::Debug for MintedTokens {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MintedTokens")
            .field("access_token", &"sap_…(redacted)")
            .field("access_expires_at", &self.access_expires_at)
            .field("refresh_token", &"sapr_…(redacted)")
            .finish()
    }
}

/// Creates a proof family and its first tokens. Call inside a transaction.
///
/// The family lives 900 days, and a user verification family never outlives the sign-in it stands on
/// (`least(now() + 900 days, subject expiry)`).
pub async fn create(
    conn: &mut PgConnection,
    pepper: &Pepper,
    new: &NewProof<'_>,
) -> ApiResult<(FamilyRow, MintedTokens)> {
    let family = sqlx::query_as::<_, FamilyRow>(concat!(
        "insert into proof_families as f (id, kind, issuing_app, audiences, account_uuid, subject_family_id, scopes, \
         access_ttl_seconds, expires_at) \
         values ($1, $2, $3, $4, $5, $6, $7, $8, least(now() + make_interval(days => $9), $10)) returning ",
        family_columns!()
    ))
    .bind(Uuid::now_v7())
    .bind(new.kind.as_str())
    .bind(new.issuing_app)
    .bind(new.audiences)
    .bind(new.subject.map(|s| s.0))
    .bind(new.subject.map(|s| s.1))
    .bind(new.scopes)
    .bind(new.access_ttl_seconds as i32)
    .bind(FAMILY_TTL_DAYS as i32)
    .bind(new.subject.map(|s| s.2))
    .fetch_one(&mut *conn)
    .await?;
    let tokens = mint_tokens(
        conn,
        pepper,
        family.id,
        new.access_ttl_seconds,
        family.expires_at,
    )
    .await?;
    Ok((family, tokens))
}

/// Inserts a new proof token (expiring after `ttl_seconds`, never after the family) and a new
/// proof refresh token for a family.
pub async fn mint_tokens(
    conn: &mut PgConnection,
    pepper: &Pepper,
    family_id: Uuid,
    ttl_seconds: i64,
    family_expires_at: OffsetDateTime,
) -> ApiResult<MintedTokens> {
    let access_token = random_token(prefix::PROOF);
    let refresh_token = random_token(prefix::PROOF_REFRESH);
    let rows: Vec<(String, OffsetDateTime)> = sqlx::query_as(
        "insert into proof_tokens (token_hash, family_id, kind, expires_at) values \
           ($1, $3, 'access', least(now() + make_interval(secs => $4), $5)), \
           ($2, $3, 'refresh', $5) \
         returning kind, expires_at",
    )
    .bind(pepper.hash(&access_token))
    .bind(pepper.hash(&refresh_token))
    .bind(family_id)
    .bind(ttl_seconds as f64)
    .bind(family_expires_at)
    .fetch_all(&mut *conn)
    .await?;
    let (_, access_expires_at) = rows
        .into_iter()
        .find(|(kind, _)| kind == "access")
        .ok_or_else(|| {
            accounts_core::ApiError::internal("proof token insert returned no access row")
        })?;
    Ok(MintedTokens {
        access_token,
        access_expires_at,
        refresh_token,
    })
}

/// A family by id.
pub async fn family(conn: &mut PgConnection, id: Uuid) -> ApiResult<Option<FamilyRow>> {
    Ok(sqlx::query_as::<_, FamilyRow>(concat!(
        "select ",
        family_columns!(),
        " from proof_families f where f.id = $1"
    ))
    .bind(id)
    .fetch_optional(&mut *conn)
    .await?)
}

/// `access` (`sap_…`) or `refresh` (`sapr_…`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenKind {
    Access,
    Refresh,
}

impl TokenKind {
    pub const fn as_str(&self) -> &'static str {
        match self {
            TokenKind::Access => "access",
            TokenKind::Refresh => "refresh",
        }
    }
}

/// The family a token belongs to.
pub async fn family_by_token(
    conn: &mut PgConnection,
    pepper: &Pepper,
    token: &str,
    kind: TokenKind,
) -> ApiResult<Option<FamilyRow>> {
    Ok(sqlx::query_as::<_, FamilyRow>(concat!(
        "select ",
        family_columns!(),
        " from proof_tokens t join proof_families f on f.id = t.family_id \
          where t.token_hash = $1 and t.kind = $2"
    ))
    .bind(pepper.hash(token.trim()))
    .bind(kind.as_str())
    .fetch_optional(&mut *conn)
    .await?)
}

/// Revokes a family. `true` when this call revoked it, `false` when it already was.
pub async fn revoke(
    conn: &mut PgConnection,
    id: Uuid,
    revoked_by: &str,
    reason: &str,
) -> ApiResult<bool> {
    let row: Option<Uuid> = sqlx::query_scalar(
        "update proof_families set revoked_at = now(), revoked_by = $2, revoke_reason = $3 \
         where id = $1 and revoked_at is null returning id",
    )
    .bind(id)
    .bind(revoked_by)
    .bind(reason)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(row.is_some())
}

// ---- sign-in revoked: stored -----------------------------------------------------------------

/// Stores the end of User verification proofs whose sign-in was revoked ([`sign_in_revoked_sql`]) and that
/// nobody revoked yet: `revoked_at` = [`sign_in_revoked_at_sql`], `revoked_by` = `$2`,
/// `revoke_reason` = `$3`, plus one audit entry each (`actor_kind` `$4`, `action` `$5`,
/// `target_kind` `$6`, `details.via` = the reason, `details.sign_in_revoke_reason` = why the
/// sign-in was revoked). One statement, so a proof is never stored without its audit entry.
/// `$1` = most proofs; the macro arguments add a filter and the row lock.
macro_rules! record_sign_in_revoked_sql {
    ($filter:literal, $lock:literal) => {
        concat!(
            "with ended as (select f.id, ",
            sign_in_revoked_at_sql!(),
            " as ended_at, tf.revoke_reason as sign_in_reason \
               from proof_families f left join token_families tf on tf.id = f.subject_family_id \
              where f.revoked_at is null and ",
            sign_in_revoked_sql!(),
            " and ",
            $filter,
            " limit $1 ",
            $lock,
            "), revoked as (update proof_families f \
                  set revoked_at = e.ended_at, revoked_by = $2, revoke_reason = $3 \
                 from ended e where f.id = e.id \
               returning f.id, f.kind, f.issuing_app, f.account_uuid, f.audiences, f.revoked_at, e.sign_in_reason) \
             insert into audit_log (actor_kind, actor_id, action, target_kind, target_id, app_id, account_uuid, details) \
             select $4, null, $5, $6, r.id::text, r.issuing_app, r.account_uuid, \
                    jsonb_build_object('kind', r.kind, 'reason', $3::text, 'via', $3::text, \
                      'audiences', r.audiences, 'sign_in_revoke_reason', r.sign_in_reason, \
                      'revoked_at', to_char(r.revoked_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')) \
               from revoked r"
        )
    };
}

/// [`record_sign_in_revoked_sql`] for the sweep: any proof, skipping rows a request holds
/// (the next sweep gets them).
const RECORD_SIGN_INS_REVOKED: &str =
    record_sign_in_revoked_sql!("true", "for update of f skip locked");

/// [`record_sign_in_revoked_sql`] for one proof (`$7`).
const RECORD_SIGN_IN_REVOKED_ONE: &str =
    record_sign_in_revoked_sql!("f.id = $7", "for update of f");

/// If the sign-in a user verification proof stands on was revoked (before the proof expired) and the proof
/// isn't revoked yet, stores that it was revoked then (`sign_in_revoked`, by `system`, with its
/// `proof.revoked` audit entry). `true` when this call stored it. Call inside the caller's
/// transaction; refresh and revoke call it so the first end of a proof is the one its history
/// keeps.
pub async fn record_sign_in_revoked(conn: &mut PgConnection, id: Uuid) -> ApiResult<bool> {
    let stored = sqlx::query(RECORD_SIGN_IN_REVOKED_ONE)
        .bind(1_i64)
        .bind(SYSTEM_REVOKER)
        .bind(revoke_reason::SIGN_IN_REVOKED)
        .bind(ActorKind::System)
        .bind(action::REVOKED)
        .bind(AUDIT_TARGET)
        .bind(id)
        .execute(&mut *conn)
        .await?
        .rows_affected();
    Ok(stored > 0)
}

/// [`record_sign_in_revoked`] for up to `limit` proofs at once (the sweep).
async fn record_sign_ins_revoked(pool: &PgPool, limit: i64) -> Result<u64, sqlx::Error> {
    Ok(sqlx::query(RECORD_SIGN_INS_REVOKED)
        .bind(limit)
        .bind(SYSTEM_REVOKER)
        .bind(revoke_reason::SIGN_IN_REVOKED)
        .bind(ActorKind::System)
        .bind(action::REVOKED)
        .bind(AUDIT_TARGET)
        .execute(pool)
        .await?
        .rows_affected())
}

// ---- refresh ---------------------------------------------------------------------------------

/// A refresh token row, locked.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct LockedRefreshToken {
    pub family_id: Uuid,
    pub kind: String,
    pub used_at: Option<OffsetDateTime>,
}

/// Locks a token row (`for update`) by its hash.
pub async fn lock_token(
    conn: &mut PgConnection,
    hash: &[u8],
) -> ApiResult<Option<LockedRefreshToken>> {
    Ok(sqlx::query_as::<_, LockedRefreshToken>(
        "select family_id, kind, used_at from proof_tokens where token_hash = $1 for update",
    )
    .bind(hash)
    .fetch_optional(&mut *conn)
    .await?)
}

/// A family locked for refresh, with its expiry judged by the database clock.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct LockedFamily {
    #[sqlx(flatten)]
    pub family: FamilyRow,
    pub expired: bool,
}

/// Locks a family (`for update`).
pub async fn lock_family(conn: &mut PgConnection, id: Uuid) -> ApiResult<Option<LockedFamily>> {
    Ok(sqlx::query_as::<_, LockedFamily>(concat!(
        "select ",
        family_columns!(),
        ", f.expires_at <= now() as expired from proof_families f where f.id = $1 for update"
    ))
    .bind(id)
    .fetch_optional(&mut *conn)
    .await?)
}

/// The state of the grant behind a user verification proof (all `None` for App verification).
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct GrantState {
    pub account_uuid: Option<String>,
    pub account_kind: Option<AccountKind>,
    pub account_handle: Option<String>,
    pub account_status: Option<AccountStatus>,
    pub membership_status: Option<String>,
    pub access_removed_at: Option<OffsetDateTime>,
    pub subject_family_found: bool,
    pub subject_revoked_at: Option<OffsetDateTime>,
    pub subject_revoke_reason: Option<String>,
    pub subject_expires_at: Option<OffsetDateTime>,
    pub subject_expired: bool,
}

impl GrantState {
    /// The sign-in the proof stands on was revoked (or is missing). Unlike the other ends of a
    /// grant this one is final: a revoked sign-in never comes back.
    pub fn sign_in_revoked(&self) -> bool {
        !self.subject_family_found || self.subject_revoked_at.is_some()
    }
}

/// Reads the grant behind a family.
pub async fn grant_state(conn: &mut PgConnection, family_id: Uuid) -> ApiResult<GrantState> {
    Ok(sqlx::query_as::<_, GrantState>(concat!(
        "select a.uuid as account_uuid, a.kind as account_kind, a.handle as account_handle, a.status as account_status, \
                m.status as membership_status, m.access_removed_at, \
                tf.id is not null as subject_family_found, tf.revoked_at as subject_revoked_at, \
                tf.revoke_reason as subject_revoke_reason, tf.expires_at as subject_expires_at, \
                coalesce(tf.expires_at <= now(), false) as subject_expired \
         from proof_families f",
        grant_joins!(),
        "where f.id = $1"
    ))
    .bind(family_id)
    .fetch_one(&mut *conn)
    .await?)
}

/// Marks a refresh token used.
pub async fn mark_used(conn: &mut PgConnection, hash: &[u8]) -> ApiResult<()> {
    sqlx::query("update proof_tokens set used_at = now() where token_hash = $1")
        .bind(hash)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// Records a refresh on the family.
pub async fn touch_refreshed(conn: &mut PgConnection, id: Uuid) -> ApiResult<OffsetDateTime> {
    Ok(sqlx::query_scalar(
        "update proof_families set last_refreshed_at = now() where id = $1 returning last_refreshed_at",
    )
    .bind(id)
    .fetch_one(&mut *conn)
    .await?)
}

// ---- verify ----------------------------------------------------------------------------------

/// Everything `POST /v1/proofs/verify` needs, from one indexed lookup
/// (`proof_tokens` PK → `proof_families` PK → `apps` PK, plus `silicon-accounts`, `memberships` and
/// `token_families` PKs for User verification).
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct VerifyRow {
    pub proof_id: Uuid,
    pub kind: String,
    pub scopes: Vec<String>,
    pub token_expires_at: OffsetDateTime,
    pub issuing_app_id: String,
    pub issuing_app_name: String,
    pub account_uuid: Option<String>,
    pub account_handle: Option<String>,
    pub account_kind: Option<AccountKind>,
    pub token_expired: bool,
    pub family_revoked: bool,
    pub family_expired: bool,
    pub issuer_inactive: bool,
    pub not_audience: bool,
    pub grant_ended: bool,
}

impl VerifyRow {
    /// `None` when valid, else why not (for logs only; callers never see it).
    pub fn invalid_reason(&self) -> Option<&'static str> {
        if self.not_audience {
            Some("not_an_audience")
        } else if self.family_revoked {
            Some("revoked")
        } else if self.token_expired {
            Some("token_expired")
        } else if self.family_expired {
            Some("proof_expired")
        } else if self.issuer_inactive {
            Some("issuing_app_disabled")
        } else if self.grant_ended {
            Some("grant_ended")
        } else {
            None
        }
    }

    pub fn kind(&self) -> ProofKind {
        ProofKind::parse(&self.kind).unwrap_or(ProofKind::UserVerification)
    }
}

/// The single verify query. `token_hash` = HMAC of the presented `sap_…` token; `verifier` =
/// the authenticated app asking.
pub async fn verify_lookup(
    pool: &PgPool,
    token_hash: &[u8],
    verifier: &str,
) -> ApiResult<Option<VerifyRow>> {
    Ok(sqlx::query_as::<_, VerifyRow>(concat!(
        "select f.id as proof_id, f.kind, f.scopes, t.expires_at as token_expires_at, \
                ia.app_id as issuing_app_id, ia.name as issuing_app_name, \
                f.account_uuid, a.handle as account_handle, a.kind as account_kind, \
                t.expires_at <= now() as token_expired, \
                f.revoked_at is not null as family_revoked, \
                f.expires_at <= now() as family_expired, \
                ia.status <> 'active' as issuer_inactive, \
                coalesce(not ($2 = any(f.audiences)), true) as not_audience, \
                (f.kind = 'user_verification' and not coalesce(tf.id is not null and tf.revoked_at is null \
                    and tf.expires_at > now() and m.status = 'active' and a.status = 'active', false)) as grant_ended \
         from proof_tokens t \
         join proof_families f on f.id = t.family_id \
         join apps ia on ia.app_id = f.issuing_app",
        grant_joins!(),
        "where t.token_hash = $1 and t.kind = 'access'"
    ))
    .bind(token_hash)
    .bind(verifier)
    .fetch_optional(pool)
    .await?)
}

// ---- listings --------------------------------------------------------------------------------

/// Keyset cursor: (created_at as unix microseconds, proof id).
pub type Cursor = (i64, String);

/// Encodes the keyset cursor of a row.
pub fn cursor_of(created_at: OffsetDateTime, id: Uuid) -> Cursor {
    (
        (created_at.unix_timestamp_nanos() / 1_000) as i64,
        id.to_string(),
    )
}

/// Decodes a keyset cursor into bind values (400 `invalid_cursor` when malformed).
pub fn cursor_bounds(cursor: Option<Cursor>) -> ApiResult<(Option<OffsetDateTime>, Option<Uuid>)> {
    let Some((micros, id)) = cursor else {
        return Ok((None, None));
    };
    let invalid = || {
        accounts_core::ApiError::bad_request("invalid_cursor", "The cursor is not valid for this list.")
            .hint("Pass the next_cursor value from the previous page unchanged, or omit cursor to start over.")
    };
    let at =
        OffsetDateTime::from_unix_timestamp_nanos(micros as i128 * 1_000).map_err(|_| invalid())?;
    let id = Uuid::parse_str(&id).map_err(|_| invalid())?;
    Ok((Some(at), Some(id)))
}

/// A row of an app's proof listing.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct AppProofRow {
    pub id: Uuid,
    pub kind: String,
    pub audiences: Vec<String>,
    pub scopes: Vec<String>,
    pub access_ttl_seconds: i32,
    pub created_at: OffsetDateTime,
    pub expires_at: OffsetDateTime,
    pub last_refreshed_at: Option<OffsetDateTime>,
    pub status: String,
    pub revoked_at: Option<OffsetDateTime>,
    pub revoke_reason: Option<String>,
    pub token_expires_at: Option<OffsetDateTime>,
    pub account_uuid: Option<String>,
    pub account_kind: Option<AccountKind>,
    pub account_handle: Option<String>,
    pub account_display_name: Option<String>,
    pub account_pfp_url: Option<String>,
    pub account_status: Option<AccountStatus>,
}

/// Filters of an app's proof listing.
#[derive(Debug, Clone, Default)]
pub struct AppProofFilter<'a> {
    pub kind: Option<&'a str>,
    pub status: Option<&'a str>,
    pub after: (Option<OffsetDateTime>, Option<Uuid>),
    /// Rows to fetch (page size + 1).
    pub fetch: i64,
}

/// Select list of an app's proof listing (alias `f` = the families, plus [`grant_joins`]).
macro_rules! app_list_select {
    () => {
        concat!(
            "select f.id, f.kind, f.audiences, f.scopes, f.access_ttl_seconds, f.created_at, f.expires_at, \
                    f.last_refreshed_at, ",
            status_sql!(),
            " as status, ",
            effective_revoked_at_sql!(),
            " as revoked_at, ",
            effective_reason_sql!(),
            " as revoke_reason, ",
            token_expires_at_sql!(),
            " as token_expires_at, \
                    a.uuid as account_uuid, a.kind as account_kind, a.handle as account_handle, \
                    a.display_name as account_display_name, a.pfp_url as account_pfp_url, \
                    a.status as account_status "
        )
    };
}

/// Without a status filter: take the page from the `(issuing_app, created_at desc)` index first
/// (materialized, so the limit applies before any join), then join the grant state of just
/// that page. $1 app, $2 kind, $3/$4 cursor, $5 rows.
const APP_LIST_PAGE_FIRST: &str = concat!(
    "with f as materialized (select * from proof_families f \
       where f.issuing_app = $1 and ($2::text is null or f.kind = $2) \
         and ($3::timestamptz is null or (f.created_at, f.id) < ($3, $4::uuid)) \
       order by f.created_at desc, f.id desc limit $5) ",
    app_list_select!(),
    "from f",
    grant_joins!(),
    "order by f.created_at desc, f.id desc"
);

/// With a status filter the grant state decides membership in the page, so it is computed
/// before the limit. $1 app, $2 kind, $3/$4 cursor, $5 status, $6 rows.
const APP_LIST_BY_STATUS: &str = concat!(
    app_list_select!(),
    "from proof_families f",
    grant_joins!(),
    "where f.issuing_app = $1 and ($2::text is null or f.kind = $2) \
       and ($3::timestamptz is null or (f.created_at, f.id) < ($3, $4::uuid)) \
       and ",
    status_sql!(),
    " = $5 \
     order by f.created_at desc, f.id desc limit $6"
);

/// Proofs issued by an app, newest first.
pub async fn list_for_app(
    conn: &mut PgConnection,
    app_id: &str,
    filter: &AppProofFilter<'_>,
) -> ApiResult<Vec<AppProofRow>> {
    let query = match filter.status {
        None => sqlx::query_as::<_, AppProofRow>(APP_LIST_PAGE_FIRST)
            .bind(app_id)
            .bind(filter.kind)
            .bind(filter.after.0)
            .bind(filter.after.1)
            .bind(filter.fetch),
        Some(status) => sqlx::query_as::<_, AppProofRow>(APP_LIST_BY_STATUS)
            .bind(app_id)
            .bind(filter.kind)
            .bind(filter.after.0)
            .bind(filter.after.1)
            .bind(status)
            .bind(filter.fetch),
    };
    Ok(query.fetch_all(&mut *conn).await?)
}

/// A centrally listed verification, with the current public identity of its issuing app.
#[derive(Debug, sqlx::FromRow)]
pub struct ManagedProofRow {
    #[sqlx(flatten)]
    pub proof: AppProofRow,
    pub issuing_app: String,
    pub issuing_name: String,
    pub issuing_logo: Option<String>,
    pub issuing_logo_dark: Option<String>,
    pub issuing_homepage: Option<String>,
}

/// The same current owner-or-accepted-author boundary as `AppOrOwner`.
pub async fn manages_app(
    conn: &mut PgConnection,
    account_uuid: &str,
    app_id: &str,
) -> ApiResult<bool> {
    Ok(sqlx::query_scalar(
        "select exists(select 1 from apps a where a.app_id=$2 and \
         (a.owner_uuid=$1 or exists(select 1 from app_authors aa \
          where aa.app_id=a.app_id and aa.account_uuid=$1)))",
    )
    .bind(account_uuid)
    .bind(app_id)
    .fetch_one(conn)
    .await?)
}

/// Every retained App verification family issued by apps this account currently manages.
/// Authorization is part of the page query, including when the caller supplies a cursor.
pub async fn list_managed(
    conn: &mut PgConnection,
    account_uuid: &str,
    app_id: Option<&str>,
    filter: &AppProofFilter<'_>,
) -> ApiResult<Vec<ManagedProofRow>> {
    Ok(sqlx::query_as::<_, ManagedProofRow>(concat!(
        "with f as materialized (select f.* from proof_families f join apps issuer \
         on issuer.app_id=f.issuing_app where f.kind='app_verification' \
         and (issuer.owner_uuid=$1 or exists(select 1 from app_authors aa \
           where aa.app_id=issuer.app_id and aa.account_uuid=$1)) \
         and ($2::text is null or f.issuing_app=$2) \
         and ($3::timestamptz is null or (f.created_at,f.id)<($3,$4::uuid)) \
         and ($5::text is null or (case when f.revoked_at is not null then 'revoked' \
           when f.expires_at<=now() then 'expired' else 'active' end)=$5) \
         order by f.created_at desc,f.id desc limit $6) ",
        app_list_select!(),
        ", issuer.app_id as issuing_app, issuer.name as issuing_name, \
         issuer.logo_url as issuing_logo, issuer.logo_dark_url as issuing_logo_dark, \
         issuer.homepage_url as issuing_homepage from f \
         join apps issuer on issuer.app_id=f.issuing_app ",
        grant_joins!(),
        "order by f.created_at desc,f.id desc"
    ))
    .bind(account_uuid)
    .bind(app_id)
    .bind(filter.after.0)
    .bind(filter.after.1)
    .bind(filter.status)
    .bind(filter.fetch)
    .fetch_all(conn)
    .await?)
}

/// A row of an account's User verification proof listing.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct MyProofRow {
    pub id: Uuid,
    pub scopes: Vec<String>,
    pub created_at: OffsetDateTime,
    pub expires_at: OffsetDateTime,
    pub last_refreshed_at: Option<OffsetDateTime>,
    pub status: String,
    pub revoked_at: Option<OffsetDateTime>,
    pub revoke_reason: Option<String>,
    pub token_expires_at: Option<OffsetDateTime>,
    pub issuing_app_id: String,
    pub issuing_app_name: String,
    pub issuing_logo_url: Option<String>,
    pub issuing_logo_dark_url: Option<String>,
    pub issuing_homepage_url: Option<String>,
    pub receiving_app_id: Option<String>,
    pub receiving_app_name: Option<String>,
    pub receiving_logo_url: Option<String>,
    pub receiving_logo_dark_url: Option<String>,
    pub receiving_homepage_url: Option<String>,
}

/// Select list + joins of an account's User verification proof listing (alias `f` = the families).
macro_rules! my_list_select_from {
    ($source:literal) => {
        concat!(
            "select f.id, f.scopes, f.created_at, f.expires_at, f.last_refreshed_at, ",
            status_sql!(),
            " as status, ",
            effective_revoked_at_sql!(),
            " as revoked_at, ",
            effective_reason_sql!(),
            " as revoke_reason, ",
            token_expires_at_sql!(),
            " as token_expires_at, \
                    ia.app_id as issuing_app_id, ia.name as issuing_app_name, ia.logo_url as issuing_logo_url, \
                    ia.logo_dark_url as issuing_logo_dark_url, ia.homepage_url as issuing_homepage_url, \
                    f.audiences[1] as receiving_app_id, ra.name as receiving_app_name, \
                    ra.logo_url as receiving_logo_url, ra.logo_dark_url as receiving_logo_dark_url, \
                    ra.homepage_url as receiving_homepage_url \
             from ",
            $source,
            " join apps ia on ia.app_id = f.issuing_app \
              left join apps ra on ra.app_id = f.audiences[1]",
            grant_joins!()
        )
    };
}

/// Page first (see [`APP_LIST_PAGE_FIRST`]). $1 account, $2/$3 cursor, $4 rows.
const MY_LIST_PAGE_FIRST: &str = concat!(
    "with f as materialized (select * from proof_families f \
       where f.account_uuid = $1 and f.kind = 'user_verification' \
         and ($2::timestamptz is null or (f.created_at, f.id) < ($2, $3::uuid)) \
       order by f.created_at desc, f.id desc limit $4) ",
    my_list_select_from!("f"),
    "order by f.created_at desc, f.id desc"
);

/// Status first (see [`APP_LIST_BY_STATUS`]). $1 account, $2/$3 cursor, $4 status, $5 rows.
const MY_LIST_BY_STATUS: &str = concat!(
    my_list_select_from!("proof_families f"),
    "where f.account_uuid = $1 and f.kind = 'user_verification' \
       and ($2::timestamptz is null or (f.created_at, f.id) < ($2, $3::uuid)) \
       and ",
    status_sql!(),
    " = $4 \
     order by f.created_at desc, f.id desc limit $5"
);

/// User verification proofs issued on an account's behalf, newest first.
pub async fn list_for_account(
    conn: &mut PgConnection,
    account_uuid: &str,
    status: Option<&str>,
    after: (Option<OffsetDateTime>, Option<Uuid>),
    fetch: i64,
) -> ApiResult<Vec<MyProofRow>> {
    let query = match status {
        None => sqlx::query_as::<_, MyProofRow>(MY_LIST_PAGE_FIRST)
            .bind(account_uuid)
            .bind(after.0)
            .bind(after.1)
            .bind(fetch),
        Some(status) => sqlx::query_as::<_, MyProofRow>(MY_LIST_BY_STATUS)
            .bind(account_uuid)
            .bind(after.0)
            .bind(after.1)
            .bind(status)
            .bind(fetch),
    };
    Ok(query.fetch_all(&mut *conn).await?)
}

// ---- receiving apps --------------------------------------------------------------------------

/// The apps among `app_ids` that exist.
pub async fn apps_by_id(conn: &mut PgConnection, app_ids: &[String]) -> ApiResult<Vec<App>> {
    Ok(sqlx::query_as::<_, App>(concat!(
        "select ",
        accounts_core::app_columns!(),
        " from apps where app_id = any($1)"
    ))
    .bind(app_ids)
    .fetch_all(&mut *conn)
    .await?)
}

// ---- maintenance -----------------------------------------------------------------------------

/// What [`sweep`] stored and deleted.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SweepReport {
    /// User verification proofs whose sign-in had been revoked, now stored as revoked (`sign_in_revoked`).
    pub sign_in_revocations_recorded: u64,
    /// Proof tokens that expired more than a day ago.
    pub expired_access_tokens: u64,
    /// Tokens of proofs that were revoked or ended more than 30 days ago.
    pub dead_family_tokens: u64,
}

/// Rows per statement, so a sweep never holds long locks.
const SWEEP_BATCH: i64 = 5_000;
/// Statements per step and sweep: bounds one sweep's work (the next sweep continues).
const SWEEP_MAX_BATCHES: usize = 200;

/// Deletes proof tokens that expired more than a day ago (`$2` days), at most `$1`.
const DELETE_EXPIRED_TOKENS: &str = "delete from proof_tokens where token_hash in \
    (select token_hash from proof_tokens \
      where kind = 'access' and expires_at < now() - make_interval(days => $2) limit $1)";

/// Deletes every token of proofs that were revoked or expired more than 30 days ago (`$2`
/// days), at most `$1`.
const DELETE_DEAD_PROOF_TOKENS: &str = "delete from proof_tokens where token_hash in \
    (select t.token_hash from proof_tokens t join proof_families f on f.id = t.family_id \
      where f.revoked_at < now() - make_interval(days => $2) \
         or f.expires_at < now() - make_interval(days => $2) limit $1)";

/// The hourly maintenance:
///
/// 1. stores the end of User verification proofs whose sign-in was revoked ([`record_sign_in_revoked`]), so
///    the account's history shows them revoked and step 3 can delete their tokens;
/// 2. deletes proof tokens that expired more than a day ago;
/// 3. deletes every token of proofs revoked or expired more than 30 days ago.
///
/// Proof rows stay forever as history. Proof refresh tokens of live proofs are kept even when
/// used: they are what reuse detection recognizes.
pub async fn sweep(pool: &PgPool) -> Result<SweepReport, sqlx::Error> {
    let mut report = SweepReport::default();
    for _ in 0..SWEEP_MAX_BATCHES {
        let n = record_sign_ins_revoked(pool, SWEEP_BATCH).await?;
        report.sign_in_revocations_recorded += n;
        if n < SWEEP_BATCH as u64 {
            break;
        }
    }
    for _ in 0..SWEEP_MAX_BATCHES {
        let n = sqlx::query(DELETE_EXPIRED_TOKENS)
            .bind(SWEEP_BATCH)
            .bind(EXPIRED_TOKEN_RETENTION_DAYS)
            .execute(pool)
            .await?
            .rows_affected();
        report.expired_access_tokens += n;
        if n < SWEEP_BATCH as u64 {
            break;
        }
    }
    for _ in 0..SWEEP_MAX_BATCHES {
        let n = sqlx::query(DELETE_DEAD_PROOF_TOKENS)
            .bind(SWEEP_BATCH)
            .bind(ENDED_PROOF_RETENTION_DAYS)
            .execute(pool)
            .await?
            .rows_affected();
        report.dead_family_tokens += n;
        if n < SWEEP_BATCH as u64 {
            break;
        }
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The reason literals in the listing SQL are the `model::revoke_reason` values.
    #[test]
    fn listing_sql_uses_the_model_reasons() {
        for sql in [
            APP_LIST_PAGE_FIRST,
            APP_LIST_BY_STATUS,
            MY_LIST_PAGE_FIRST,
            MY_LIST_BY_STATUS,
        ] {
            for reason in [
                revoke_reason::SIGN_IN_REVOKED,
                revoke_reason::MEMBERSHIP_INACTIVE,
                revoke_reason::ACCOUNT_INACTIVE,
            ] {
                assert!(sql.contains(&format!("'{reason}'")), "{reason}");
            }
        }
        for sql in [RECORD_SIGN_INS_REVOKED, RECORD_SIGN_IN_REVOKED_ONE] {
            assert!(sql.contains(sign_in_revoked_sql!()));
            assert!(sql.contains(sign_in_revoked_at_sql!()));
        }
        assert!(RECORD_SIGN_INS_REVOKED.contains("skip locked"));
        assert!(RECORD_SIGN_IN_REVOKED_ONE.contains("f.id = $7"));
    }
}
