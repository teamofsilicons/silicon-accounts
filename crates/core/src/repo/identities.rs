//! Linked Google/Apple identities.

use sqlx::PgConnection;

use crate::error::{ApiError, ApiResult};
use crate::models::{Identity, Provider};

/// Finds the identity for `(provider, subject)`.
pub async fn find(
    conn: &mut PgConnection,
    provider: Provider,
    subject: &str,
) -> ApiResult<Option<Identity>> {
    Ok(sqlx::query_as::<_, Identity>(
        "select provider, subject, client_id, account_uuid, email, created_at, last_used_at from identities \
         where provider = $1 and subject = $2",
    )
    .bind(provider)
    .bind(subject)
    .fetch_optional(&mut *conn)
    .await?)
}

/// Links an identity to an account (or refreshes it when it is already linked to the same
/// account). Error: 409 `identity_in_use` when it belongs to another account.
pub async fn link(
    conn: &mut PgConnection,
    provider: Provider,
    subject: &str,
    client_id: &str,
    account_uuid: &str,
    email: Option<&str>,
) -> ApiResult<Identity> {
    let row = sqlx::query_as::<_, Identity>(
        "insert into identities (provider, subject, client_id, account_uuid, email, last_used_at) \
         values ($1, $2, $3, $4, $5, now()) \
         on conflict (provider, subject) do update set client_id = excluded.client_id, \
           email = coalesce(excluded.email, identities.email), last_used_at = now() \
         where identities.account_uuid = excluded.account_uuid \
         returning provider, subject, client_id, account_uuid, email, created_at, last_used_at",
    )
    .bind(provider)
    .bind(subject)
    .bind(client_id)
    .bind(account_uuid)
    .bind(email)
    .fetch_optional(&mut *conn)
    .await?;
    row.ok_or_else(|| {
        ApiError::conflict(
            "identity_in_use",
            format!(
                "This {} account is already connected to another Silicon Accounts account.",
                provider.display_name()
            ),
        )
        .hint(format!(
            "Sign in with {} to use that account, or disconnect it there first.",
            provider.display_name()
        ))
    })
}

/// Records a sign-in with an identity.
pub async fn touch(conn: &mut PgConnection, provider: Provider, subject: &str) -> ApiResult<()> {
    sqlx::query("update identities set last_used_at = now() where provider = $1 and subject = $2")
        .bind(provider)
        .bind(subject)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// Identities of an account, oldest first.
pub async fn list_for_account(
    conn: &mut PgConnection,
    account_uuid: &str,
) -> ApiResult<Vec<Identity>> {
    Ok(sqlx::query_as::<_, Identity>(
        "select provider, subject, client_id, account_uuid, email, created_at, last_used_at from identities \
         where account_uuid = $1 order by created_at, provider, subject",
    )
    .bind(account_uuid)
    .fetch_all(&mut *conn)
    .await?)
}

/// Disconnects an identity from the account. Error: 404 `identity_not_found`.
pub async fn remove(
    conn: &mut PgConnection,
    account_uuid: &str,
    provider: Provider,
    subject: &str,
) -> ApiResult<()> {
    let n = sqlx::query(
        "delete from identities where account_uuid = $1 and provider = $2 and subject = $3",
    )
    .bind(account_uuid)
    .bind(provider)
    .bind(subject)
    .execute(&mut *conn)
    .await?
    .rows_affected();
    if n == 0 {
        return Err(ApiError::not_found(
            "identity_not_found",
            format!(
                "No {} identity '{subject}' is connected to your account.",
                provider.display_name()
            ),
        )
        .hint("List your identities to see what is connected."));
    }
    Ok(())
}
