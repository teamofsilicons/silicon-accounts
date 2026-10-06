//! Uploaded profile photos (`photos`): which upload an account may show, and deleting the
//! uploads nobody shows any more.
//!
//! A photo URL on this service is `{PUBLIC_URL}/v1/photos/{photo_id}`, written exactly as
//! `POST /v1/me/photo` returns it (`pfp::photo_ref`; `normalize::validate_pfp_url` refuses other
//! spellings). An account may show:
//! - a photo it uploaded itself;
//! - for a Silicon, a photo its custodian uploaded (set through the custodian's routes).
//!
//! **Locks.** Pruning deletes an upload only while no account that isn't deleted has it as its
//! `pfp_url`. Every caller that prunes or deletes an account's uploads holds that uploader's
//! account row lock (`for update`) first, and [`check_usable`] share-locks the uploader's row
//! before it confirms the photo exists. So a photo that was just checked can't be pruned before
//! the change that shows it commits: the prune waits, then sees the new `pfp_url`.

use sqlx::PgConnection;
use uuid::Uuid;

use crate::config::Settings;
use crate::error::{ApiError, ApiResult, FieldErrors};
use crate::pfp::{PhotoRef, photo_ref, photo_url_prefix};

/// Deletes the account's uploaded photos that no account shows any more. An upload stays while
/// any account that isn't deleted has it as its `pfp_url`: the uploader itself, or a Silicon
/// whose custodian gave it that photo, even after the Silicon was transferred. Deleted accounts
/// don't keep photos alive. Returns how many photos were deleted.
///
/// Hold the uploader's account row lock (`repo::accounts::lock`) when calling it.
pub async fn prune(
    conn: &mut PgConnection,
    settings: &Settings,
    account_uuid: &str,
) -> ApiResult<u64> {
    // `a.pfp_url = <url>` is a plain equality, served by the hash index on accounts.pfp_url.
    Ok(sqlx::query(
        "delete from photos p where p.account_uuid = $1 and not exists ( \
           select 1 from accounts a where a.pfp_url = ($2 || p.id::text) and a.status <> 'deleted')",
    )
    .bind(account_uuid)
    .bind(photo_url_prefix(settings))
    .execute(&mut *conn)
    .await?
    .rows_affected())
}

/// Checks that an account may show `url` as its photo: any external https URL, or a photo of
/// this service that one of `uploaders` (account uuids) uploaded. `who` names the uploaders in
/// the message ("you", "you or si:scout"). Run it inside the transaction that sets the
/// `pfp_url`: the uploader's account row is share-locked until that transaction ends, so the
/// photo can't be pruned in between (see the module docs).
///
/// Error: 422 `validation_failed` with `details.fields.pfp_url` saying exactly why.
pub async fn check_usable(
    conn: &mut PgConnection,
    settings: &Settings,
    url: &str,
    uploaders: &[&str],
    who: &str,
) -> ApiResult<()> {
    let problem = match photo_ref(settings, url.trim()) {
        PhotoRef::External => return Ok(()),
        PhotoRef::Inexact(problem) => problem,
        PhotoRef::Exact(photo_id) => match owner(conn, photo_id).await? {
            Some(uploader) if uploaders.contains(&uploader.as_str()) => {
                // Hold the uploader still, then make sure the photo survived until now.
                sqlx::query("select 1 from accounts where uuid = $1 for share")
                    .bind(&uploader)
                    .execute(&mut *conn)
                    .await?;
                if owner(conn, photo_id).await?.as_deref() == Some(uploader.as_str()) {
                    return Ok(());
                }
                format!(
                    "{} was just replaced or removed by its uploader; upload a photo with POST /v1/me/photo",
                    url.trim()
                )
            }
            _ => format!(
                "{} is not a photo {who} uploaded (it doesn't exist, was replaced, or belongs to another account); upload one with POST /v1/me/photo",
                url.trim()
            ),
        },
    };
    let mut f = FieldErrors::new();
    f.add("pfp_url", problem);
    Err(ApiError::validation(f))
}

async fn owner(conn: &mut PgConnection, photo_id: Uuid) -> ApiResult<Option<String>> {
    Ok(
        sqlx::query_scalar("select account_uuid from photos where id = $1")
            .bind(photo_id)
            .fetch_optional(&mut *conn)
            .await?,
    )
}
