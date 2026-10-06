//! The `custodian_requests` table: a self-created Silicon asking a Carbon to become its custodian
//! (`initial`), or a custodian asking another Carbon to take a Silicon over (`transfer`).
//!
//! A request names its Carbon either by uuid (`to_uuid`, when named by c:id) or by email
//! (`to_email`, whether or not an account has that email yet); it is addressed to every account
//! that has that email verified, so a Carbon who signs up later finds it waiting. A Silicon has at
//! most one pending request (unique index). Requests expire 14 days after creation; the sweep
//! makes that durable, and every read path treats an overdue request as expired right away.

use accounts_core::error::{ApiError, ApiResult};
use accounts_core::repo::is_unique_violation;
use sqlx::PgConnection;
use time::OffsetDateTime;
use uuid::Uuid;

/// A custodian has this many days to accept (UNDERSTANDING: "up to 2 weeks").
pub const REQUEST_TTL_DAYS: i32 = 14;

/// At most this many self-created Silicons may wait for the same custodian at once, counted per
/// name the Silicons used: per c:id, and per email address (see [`pending_initial_load`]).
pub const MAX_PENDING_PER_CUSTODIAN: i64 = 20;

/// `custodian_requests.kind` values.
pub mod kind {
    pub const INITIAL: &str = "initial";
    pub const TRANSFER: &str = "transfer";
}

/// `custodian_requests.status` values.
pub mod status {
    pub const PENDING: &str = "pending";
    pub const ACCEPTED: &str = "accepted";
    pub const DECLINED: &str = "declined";
    pub const EXPIRED: &str = "expired";
    pub const CANCELLED: &str = "cancelled";
}

macro_rules! request_columns {
    () => {
        "id, silicon_uuid, kind, from_uuid, to_uuid, to_email, status, request_token_hash, created_at, \
         expires_at, decided_at, decided_by, (expires_at <= now()) as overdue"
    };
}

/// A row of `custodian_requests`.
#[derive(Clone, sqlx::FromRow)]
pub struct CustodianRequest {
    pub id: Uuid,
    pub silicon_uuid: String,
    /// [`kind::INITIAL`] or [`kind::TRANSFER`].
    pub kind: String,
    /// The custodian giving the Silicon away (transfers).
    pub from_uuid: Option<String>,
    /// The Carbon asked, when named by c:id (and whoever decided an emailed request).
    pub to_uuid: Option<String>,
    /// The email asked, when named by email.
    pub to_email: Option<String>,
    /// See [`status`].
    pub status: String,
    /// HMAC of the `sarq_` polling token (initial requests).
    pub request_token_hash: Option<Vec<u8>>,
    pub created_at: OffsetDateTime,
    pub expires_at: OffsetDateTime,
    pub decided_at: Option<OffsetDateTime>,
    pub decided_by: Option<String>,
    /// `expires_at` has passed (by the database clock).
    pub overdue: bool,
}

impl std::fmt::Debug for CustodianRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // The token hash is left out on purpose.
        f.debug_struct("CustodianRequest")
            .field("id", &self.id)
            .field("silicon_uuid", &self.silicon_uuid)
            .field("kind", &self.kind)
            .field("from_uuid", &self.from_uuid)
            .field("to_uuid", &self.to_uuid)
            .field("to_email", &self.to_email)
            .field("status", &self.status)
            .field("expires_at", &self.expires_at)
            .field("decided_at", &self.decided_at)
            .field("decided_by", &self.decided_by)
            .field("overdue", &self.overdue)
            .finish_non_exhaustive()
    }
}

impl CustodianRequest {
    pub fn is_pending(&self) -> bool {
        self.status == status::PENDING
    }

    pub fn is_initial(&self) -> bool {
        self.kind == kind::INITIAL
    }

    /// Still pending in the table although its 14 days are over (the sweep hasn't run yet).
    pub fn is_overdue(&self) -> bool {
        self.is_pending() && self.overdue
    }
}

/// What [`insert`] stores.
#[derive(Debug, Clone)]
pub struct NewRequest<'a> {
    pub silicon_uuid: &'a str,
    pub kind: &'static str,
    pub from_uuid: Option<&'a str>,
    pub to_uuid: Option<&'a str>,
    pub to_email: Option<&'a str>,
    pub request_token_hash: Option<&'a [u8]>,
}

/// Inserts a pending request that expires in 14 days. 409 `custodian_request_pending` when
/// the Silicon already has a pending request.
pub async fn insert(conn: &mut PgConnection, new: &NewRequest<'_>) -> ApiResult<CustodianRequest> {
    sqlx::query_as::<_, CustodianRequest>(concat!(
        "insert into custodian_requests (id, silicon_uuid, kind, from_uuid, to_uuid, to_email, status, \
         request_token_hash, expires_at) \
         values ($1, $2, $3, $4, $5, $6, 'pending', $7, now() + make_interval(days => $8)) returning ",
        request_columns!()
    ))
    .bind(Uuid::now_v7())
    .bind(new.silicon_uuid)
    .bind(new.kind)
    .bind(new.from_uuid)
    .bind(new.to_uuid)
    .bind(new.to_email)
    .bind(new.request_token_hash)
    .bind(REQUEST_TTL_DAYS)
    .fetch_one(&mut *conn)
    .await
    .map_err(|e| {
        if is_unique_violation(&e, Some("custodian_requests_one_pending")) {
            ApiError::conflict(
                "custodian_request_pending",
                "This Silicon already has a pending custodian request; a Silicon can have only one at a time.",
            )
            .hint("Cancel the pending transfer first (DELETE /v1/me/silicons/{uuid}/transfer), or wait until it is accepted, declined or expires.")
        } else {
            e.into()
        }
    })
}

/// Fetches a request.
pub async fn get(conn: &mut PgConnection, id: Uuid) -> ApiResult<Option<CustodianRequest>> {
    Ok(sqlx::query_as::<_, CustodianRequest>(concat!(
        "select ",
        request_columns!(),
        " from custodian_requests where id = $1"
    ))
    .bind(id)
    .fetch_optional(&mut *conn)
    .await?)
}

/// Fetches and row-locks a request (inside a transaction).
pub async fn lock(conn: &mut PgConnection, id: Uuid) -> ApiResult<Option<CustodianRequest>> {
    Ok(sqlx::query_as::<_, CustodianRequest>(concat!(
        "select ",
        request_columns!(),
        " from custodian_requests where id = $1 for update"
    ))
    .bind(id)
    .fetch_optional(&mut *conn)
    .await?)
}

/// The pending request of a Silicon, if any (row-locked when `for_update`).
pub async fn pending_for_silicon(
    conn: &mut PgConnection,
    silicon_uuid: &str,
    for_update: bool,
) -> ApiResult<Option<CustodianRequest>> {
    let sql = if for_update {
        concat!(
            "select ",
            request_columns!(),
            " from custodian_requests where silicon_uuid = $1 and status = 'pending' for update"
        )
    } else {
        concat!(
            "select ",
            request_columns!(),
            " from custodian_requests where silicon_uuid = $1 and status = 'pending'"
        )
    };
    Ok(sqlx::query_as::<_, CustodianRequest>(sql)
        .bind(silicon_uuid)
        .fetch_optional(&mut *conn)
        .await?)
}

/// The latest initial request of a Silicon (any status).
pub async fn latest_initial(
    conn: &mut PgConnection,
    silicon_uuid: &str,
) -> ApiResult<Option<CustodianRequest>> {
    Ok(sqlx::query_as::<_, CustodianRequest>(concat!(
        "select ",
        request_columns!(),
        " from custodian_requests where silicon_uuid = $1 and kind = 'initial' order by created_at desc, id desc limit 1"
    ))
    .bind(silicon_uuid)
    .fetch_optional(&mut *conn)
    .await?)
}

/// Pending, not overdue transfers of these Silicons.
pub async fn pending_transfers(
    conn: &mut PgConnection,
    silicon_uuids: &[String],
) -> ApiResult<Vec<CustodianRequest>> {
    if silicon_uuids.is_empty() {
        return Ok(Vec::new());
    }
    Ok(sqlx::query_as::<_, CustodianRequest>(concat!(
        "select ",
        request_columns!(),
        " from custodian_requests where silicon_uuid = any($1) and status = 'pending' and kind = 'transfer' \
          and expires_at > now()"
    ))
    .bind(silicon_uuids)
    .fetch_all(&mut *conn)
    .await?)
}

/// Pending, not overdue requests addressed to a Carbon (by uuid, or by any email verified on
/// their account), newest first, after the `before` id (keyset pagination on the UUIDv7 id).
pub async fn addressed_to(
    conn: &mut PgConnection,
    carbon_uuid: &str,
    before: Option<Uuid>,
    limit: i64,
) -> ApiResult<Vec<CustodianRequest>> {
    Ok(sqlx::query_as::<_, CustodianRequest>(concat!(
        "select ",
        request_columns!(),
        " from custodian_requests r where r.status = 'pending' and r.expires_at > now() \
          and (r.to_uuid = $1 or r.to_email in \
               (select e.email from account_emails e where e.account_uuid = $1 and e.verified_at is not null)) \
          and ($2::uuid is null or r.id < $2) \
          order by r.id desc limit $3"
    ))
    .bind(carbon_uuid)
    .bind(before)
    .bind(limit)
    .fetch_all(&mut *conn)
    .await?)
}

/// True when the request is addressed to this Carbon: named by their uuid, or by an email that
/// is verified on their account.
pub async fn is_addressed_to(
    conn: &mut PgConnection,
    request: &CustodianRequest,
    carbon_uuid: &str,
) -> ApiResult<bool> {
    if request.to_uuid.as_deref() == Some(carbon_uuid) {
        return Ok(true);
    }
    let Some(email) = &request.to_email else {
        return Ok(false);
    };
    Ok(sqlx::query_scalar::<_, bool>(
        "select exists (select 1 from account_emails where email = $1 and account_uuid = $2 and verified_at is not null)",
    )
    .bind(email)
    .bind(carbon_uuid)
    .fetch_one(&mut *conn)
    .await?)
}

/// Pending, not overdue initial requests that named this custodian the same way: by the uuid
/// behind a c:id (`to_uuid`), or by this email address (`to_email`). Returns the count and the
/// seconds until the oldest of them expires.
///
/// Deliberately not "every request that reaches this Carbon" (its c:id plus all its verified
/// emails): a limit counted per account would answer 429 for an email exactly when it belongs to
/// a c:id that is already full, telling an anonymous caller which address belongs to whom.
pub async fn pending_initial_load(
    conn: &mut PgConnection,
    to_uuid: Option<&str>,
    to_email: Option<&str>,
) -> ApiResult<(i64, Option<f64>)> {
    Ok(sqlx::query_as::<_, (i64, Option<f64>)>(
        "select count(*), extract(epoch from (min(r.expires_at) - now()))::float8 from custodian_requests r \
         where r.status = 'pending' and r.kind = 'initial' and r.expires_at > now() \
           and (r.to_uuid = $1 or r.to_email = $2)",
    )
    .bind(to_uuid)
    .bind(to_email)
    .fetch_one(&mut *conn)
    .await?)
}

/// Records a decision. `decided_by` is the deciding account (null for the expiry sweep);
/// `recipient_uuid` fills `to_uuid` when the request was addressed by email.
pub async fn decide(
    conn: &mut PgConnection,
    id: Uuid,
    new_status: &str,
    decided_by: Option<&str>,
    recipient_uuid: Option<&str>,
) -> ApiResult<CustodianRequest> {
    Ok(sqlx::query_as::<_, CustodianRequest>(concat!(
        "update custodian_requests set status = $2, decided_at = now(), decided_by = $3, \
         to_uuid = coalesce(to_uuid, $4) where id = $1 returning ",
        request_columns!()
    ))
    .bind(id)
    .bind(new_status)
    .bind(decided_by)
    .bind(recipient_uuid)
    .fetch_one(&mut *conn)
    .await?)
}

/// Ids of pending requests whose 14 days are over, oldest first, row-locked and skipping rows
/// another node is already handling (`for update skip locked`).
pub async fn lock_overdue(conn: &mut PgConnection, limit: i64) -> ApiResult<Vec<CustodianRequest>> {
    Ok(sqlx::query_as::<_, CustodianRequest>(concat!(
        "select ",
        request_columns!(),
        " from custodian_requests where status = 'pending' and expires_at <= now() \
          order by expires_at, id limit $1 for update skip locked"
    ))
    .bind(limit)
    .fetch_all(&mut *conn)
    .await?)
}

/// Initial requests that were cancelled while their self-created Silicon still waits (the named
/// Carbon deleted their account, which cancels requests addressed to them), row-locked with
/// `for update skip locked`. Nobody can accept these any more.
pub async fn lock_orphaned(
    conn: &mut PgConnection,
    limit: i64,
) -> ApiResult<Vec<CustodianRequest>> {
    Ok(sqlx::query_as::<_, CustodianRequest>(concat!(
        "select ",
        request_columns!(),
        " from custodian_requests r where r.kind = 'initial' and r.status = 'cancelled' \
          and exists (select 1 from accounts a where a.uuid = r.silicon_uuid and a.status = 'pending_custodian') \
          and not exists (select 1 from custodian_requests p where p.silicon_uuid = r.silicon_uuid and p.status = 'pending') \
          order by r.decided_at, r.id limit $1 for update skip locked"
    ))
    .bind(limit)
    .fetch_all(&mut *conn)
    .await?)
}
