//! A Carbon's passkeys (`passkeys`) and the passkeys being added (`passkey_registrations`).
//! The WebAuthn checks themselves are in `crate::webauthn`.

use sqlx::PgConnection;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};
use crate::webauthn::NewPasskey;

/// How long a passkey being added stays open (the browser's own timeout is the same).
pub const REGISTRATION_TTL_SECONDS: i64 = 300;

/// The most passkeys one account may hold.
pub const MAX_PER_ACCOUNT: i64 = 20;

/// A passkey as the account sees it (and as the server checks it).
#[derive(Debug, Clone, sqlx::FromRow, serde::Serialize)]
pub struct Passkey {
    pub id: Uuid,
    #[serde(skip)]
    pub account_uuid: String,
    #[serde(skip)]
    pub credential_id: Vec<u8>,
    #[serde(skip)]
    pub public_key: Vec<u8>,
    #[serde(skip)]
    pub algorithm: i32,
    #[serde(skip)]
    pub sign_count: i64,
    /// Synced to the Carbon's other devices (iCloud Keychain, Google Password Manager…).
    pub backed_up: bool,
    pub name: String,
    #[serde(with = "crate::timefmt::rfc3339_ms")]
    pub created_at: OffsetDateTime,
    #[serde(with = "crate::timefmt::rfc3339_ms_option")]
    pub last_used_at: Option<OffsetDateTime>,
}

/// The columns a [`Passkey`] reads, for `concat!` (sqlx takes only static SQL).
macro_rules! columns {
    () => {
        "id, account_uuid, credential_id, public_key, algorithm, sign_count, backed_up, name, created_at, last_used_at"
    };
}

/// The account's passkeys, oldest first.
pub async fn list_for_account(
    conn: &mut PgConnection,
    account_uuid: &str,
) -> ApiResult<Vec<Passkey>> {
    Ok(sqlx::query_as::<_, Passkey>(concat!(
        "select ",
        columns!(),
        " from passkeys where account_uuid = $1 order by created_at, id"
    ))
    .bind(account_uuid)
    .fetch_all(&mut *conn)
    .await?)
}

/// How many passkeys the account holds.
pub async fn count_for_account(conn: &mut PgConnection, account_uuid: &str) -> ApiResult<i64> {
    Ok(
        sqlx::query_scalar::<_, i64>("select count(*) from passkeys where account_uuid = $1")
            .bind(account_uuid)
            .fetch_one(&mut *conn)
            .await?,
    )
}

/// The passkey with this credential id, locked for the sign-in that uses it.
pub async fn find_by_credential_for_update(
    conn: &mut PgConnection,
    credential_id: &[u8],
) -> ApiResult<Option<Passkey>> {
    Ok(sqlx::query_as::<_, Passkey>(concat!(
        "select ",
        columns!(),
        " from passkeys where credential_id = $1 for update"
    ))
    .bind(credential_id)
    .fetch_optional(&mut *conn)
    .await?)
}

/// Stores a checked passkey. Error: 409 `passkey_in_use` when the credential is already
/// registered (on this account or another).
pub async fn insert(
    conn: &mut PgConnection,
    account_uuid: &str,
    key: &NewPasskey,
    name: &str,
) -> ApiResult<Passkey> {
    let row = sqlx::query_as::<_, Passkey>(concat!(
        "insert into passkeys (id, account_uuid, credential_id, public_key, algorithm, sign_count, aaguid, \
           backup_eligible, backed_up, transports, name) \
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) \
         on conflict (credential_id) do nothing \
         returning ",
        columns!()
    ))
    .bind(Uuid::now_v7())
    .bind(account_uuid)
    .bind(&key.credential_id)
    .bind(&key.public_key)
    .bind(key.algorithm as i32)
    .bind(i64::from(key.sign_count))
    .bind(&key.aaguid)
    .bind(key.backup_eligible)
    .bind(key.backed_up)
    .bind(&key.transports)
    .bind(name)
    .fetch_optional(&mut *conn)
    .await?;
    row.ok_or_else(|| {
        ApiError::conflict(
            "passkey_in_use",
            "This passkey is already added to an account.",
        )
        .hint("Use it to sign in, or remove it from that account first.")
    })
}

/// Records a sign-in with the passkey: its new counter, its backup state and when.
pub async fn record_use(
    conn: &mut PgConnection,
    id: Uuid,
    sign_count: u32,
    backed_up: bool,
) -> ApiResult<()> {
    sqlx::query(
        "update passkeys set sign_count = $2, backed_up = $3, last_used_at = now() where id = $1",
    )
    .bind(id)
    .bind(i64::from(sign_count))
    .bind(backed_up)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

fn not_found(id: Uuid) -> ApiError {
    ApiError::not_found(
        "passkey_not_found",
        format!("No passkey '{id}' is on your account."),
    )
    .hint("List your passkeys with GET /v1/me/passkeys.")
}

/// Renames one of the account's passkeys. Error: 404 `passkey_not_found`.
pub async fn rename(
    conn: &mut PgConnection,
    account_uuid: &str,
    id: Uuid,
    name: &str,
) -> ApiResult<Passkey> {
    sqlx::query_as::<_, Passkey>(concat!(
        "update passkeys set name = $3 where account_uuid = $1 and id = $2 returning ",
        columns!(),
        ""
    ))
    .bind(account_uuid)
    .bind(id)
    .bind(name)
    .fetch_optional(&mut *conn)
    .await?
    .ok_or_else(|| not_found(id))
}

/// The account's passkey with this id, locked. Error: 404 `passkey_not_found`.
pub async fn find_for_account_for_update(
    conn: &mut PgConnection,
    account_uuid: &str,
    id: Uuid,
) -> ApiResult<Passkey> {
    sqlx::query_as::<_, Passkey>(concat!(
        "select ",
        columns!(),
        " from passkeys where account_uuid = $1 and id = $2 for update"
    ))
    .bind(account_uuid)
    .bind(id)
    .fetch_optional(&mut *conn)
    .await?
    .ok_or_else(|| not_found(id))
}

/// Removes one of the account's passkeys. Error: 404 `passkey_not_found`.
pub async fn remove(conn: &mut PgConnection, account_uuid: &str, id: Uuid) -> ApiResult<()> {
    let n = sqlx::query("delete from passkeys where account_uuid = $1 and id = $2")
        .bind(account_uuid)
        .bind(id)
        .execute(&mut *conn)
        .await?
        .rows_affected();
    if n == 0 {
        return Err(not_found(id));
    }
    Ok(())
}

/// Opens a registration: the challenge the browser must sign. Older open registrations of the
/// account are dropped, so only the newest one can finish.
pub async fn open_registration(
    conn: &mut PgConnection,
    account_uuid: &str,
    challenge: &str,
) -> ApiResult<Uuid> {
    sqlx::query("delete from passkey_registrations where account_uuid = $1 or expires_at < now()")
        .bind(account_uuid)
        .execute(&mut *conn)
        .await?;
    let id = Uuid::now_v7();
    sqlx::query(
        "insert into passkey_registrations (id, account_uuid, challenge, expires_at) \
         values ($1, $2, $3, now() + make_interval(secs => $4))",
    )
    .bind(id)
    .bind(account_uuid)
    .bind(challenge)
    .bind(REGISTRATION_TTL_SECONDS as f64)
    .execute(&mut *conn)
    .await?;
    Ok(id)
}

/// Takes the account's open registration (once): its challenge. Error: 409
/// `passkey_registration_expired` when there is none or it ran out.
pub async fn take_registration(conn: &mut PgConnection, account_uuid: &str) -> ApiResult<String> {
    sqlx::query_scalar::<_, String>(
        "delete from passkey_registrations where account_uuid = $1 and expires_at > now() \
         returning challenge",
    )
    .bind(account_uuid)
    .fetch_optional(&mut *conn)
    .await?
    .ok_or_else(|| {
        ApiError::conflict(
            "passkey_registration_expired",
            "Adding this passkey took too long, or it was started somewhere else.",
        )
        .hint("Start again with POST /v1/me/passkeys/options.")
    })
}
