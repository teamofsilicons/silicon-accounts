//! Uploaded profile photos (`photos`): storing uploads, which upload an account may show, and
//! deleting the uploads nobody shows any more.
//!
//! A photo URL on this service is `{PUBLIC_URL}/v1/photos/{photo_id}`, written exactly as
//! `POST /v1/me/photo` returns it (`pfp::photo_ref`; `normalize::validate_pfp_url` refuses other
//! spellings). An account may show:
//! - a photo it uploaded itself;
//! - for a Silicon, a photo its custodian uploaded (set through the custodian's routes), or one
//!   the custodian uploaded for it (`POST /v1/me/silicons/{uuid}/photo`, owned by the Silicon).
//!
//! **Sign-up uploads.** The sign-up page can upload the chosen photo before the account exists
//! (`POST /v1/flows/{id}/signup/photo`): the photo then belongs to the sign-up session
//! (`signup_session_id`, never both owners at once). A session keeps one upload (a new one
//! replaces it); finishing the sign-up moves it to the new account ([`attach_signup_photo`]),
//! and the uploads of sign-ups that expired or were used are swept ([`sweep_signup_photos`]).
//! Callers hold the session's row lock (`for update`) while they upload, check or attach, so a
//! photo that was just checked can't be replaced before it is attached.
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
use crate::photo_upload::UploadedPhoto;

/// Stores an upload owned by `account_uuid` and returns its id. Hold that account's row lock
/// (`repo::accounts::lock`), as pruning does.
pub async fn insert_for_account(
    conn: &mut PgConnection,
    account_uuid: &str,
    upload: &UploadedPhoto,
) -> ApiResult<Uuid> {
    let photo_id = Uuid::now_v7();
    sqlx::query(
        "insert into photos (id, account_uuid, content_type, bytes) values ($1, $2, $3, $4)",
    )
    .bind(photo_id)
    .bind(account_uuid)
    .bind(upload.info.kind.mime())
    .bind(upload.bytes.as_ref())
    .execute(&mut *conn)
    .await?;
    Ok(photo_id)
}

/// Stores the photo chosen on a sign-up page for the sign-up session `session_id` and returns
/// its id. The session's earlier uploads are deleted: a sign-up has one chosen photo. Hold the
/// session's row lock.
pub async fn insert_for_signup(
    conn: &mut PgConnection,
    session_id: Uuid,
    upload: &UploadedPhoto,
) -> ApiResult<Uuid> {
    sqlx::query("delete from photos where signup_session_id = $1")
        .bind(session_id)
        .execute(&mut *conn)
        .await?;
    let photo_id = Uuid::now_v7();
    sqlx::query(
        "insert into photos (id, signup_session_id, content_type, bytes) values ($1, $2, $3, $4)",
    )
    .bind(photo_id)
    .bind(session_id)
    .bind(upload.info.kind.mime())
    .bind(upload.bytes.as_ref())
    .execute(&mut *conn)
    .await?;
    Ok(photo_id)
}

/// The photo uploaded for a sign-up session, if any (the sign-up page's current choice).
pub async fn signup_photo(conn: &mut PgConnection, session_id: Uuid) -> ApiResult<Option<Uuid>> {
    Ok(sqlx::query_scalar(
        "select id from photos where signup_session_id = $1 order by created_at desc, id desc limit 1",
    )
    .bind(session_id)
    .fetch_optional(&mut *conn)
    .await?)
}

/// Checks that a sign-up may use `url` as the new account's photo: any external https URL, or
/// the photo uploaded for this sign-up session. Returns that photo's id (to attach once the
/// account exists), or `None` for an external URL. Hold the session's row lock.
///
/// Error: 422 `validation_failed` with `details.fields.pfp_url` saying exactly why.
pub async fn check_usable_for_signup(
    conn: &mut PgConnection,
    settings: &Settings,
    url: &str,
    session_id: Uuid,
    upload_route: &str,
) -> ApiResult<Option<Uuid>> {
    let problem = match photo_ref(settings, url.trim()) {
        PhotoRef::External => return Ok(None),
        PhotoRef::Inexact(problem) => problem,
        PhotoRef::Exact(photo_id) => {
            let ours: bool = sqlx::query_scalar(
                "select exists (select 1 from photos where id = $1 and signup_session_id = $2)",
            )
            .bind(photo_id)
            .bind(session_id)
            .fetch_one(&mut *conn)
            .await?;
            if ours {
                return Ok(Some(photo_id));
            }
            format!(
                "{} is not the photo uploaded on this sign-up page (it doesn't exist, was replaced by a newer upload, or belongs to an account); upload it with POST {upload_route}, or send null for the default photo",
                url.trim()
            )
        }
    };
    let mut f = FieldErrors::new();
    f.add("pfp_url", problem);
    Err(ApiError::validation(f))
}

/// Moves the sign-up upload `photo_id` to the account the sign-up just created (or finished),
/// so it is that account's own upload from now on, and deletes the session's other uploads.
/// Hold the session's row lock (and checked the photo with [`check_usable_for_signup`]).
pub async fn attach_signup_photo(
    conn: &mut PgConnection,
    session_id: Uuid,
    photo_id: Uuid,
    account_uuid: &str,
) -> ApiResult<()> {
    let moved = sqlx::query(
        "update photos set account_uuid = $3, signup_session_id = null \
         where id = $1 and signup_session_id = $2",
    )
    .bind(photo_id)
    .bind(session_id)
    .bind(account_uuid)
    .execute(&mut *conn)
    .await?
    .rows_affected();
    if moved != 1 {
        return Err(ApiError::internal(format!(
            "the sign-up photo {photo_id} vanished while the sign-up session {session_id} was locked"
        )));
    }
    discard_signup_photos(conn, session_id).await?;
    Ok(())
}

/// Deletes every photo still owned by a sign-up session (it ended, or its photo moved to the
/// account). Returns how many were deleted.
pub async fn discard_signup_photos(conn: &mut PgConnection, session_id: Uuid) -> ApiResult<u64> {
    Ok(
        sqlx::query("delete from photos where signup_session_id = $1")
            .bind(session_id)
            .execute(&mut *conn)
            .await?
            .rows_affected(),
    )
}

/// Deletes the uploads of sign-up sessions that expired or were used (the sign-in sweep).
/// Returns how many were deleted.
pub async fn sweep_signup_photos(pool: &sqlx::PgPool) -> Result<u64, sqlx::Error> {
    Ok(sqlx::query(
        "delete from photos p using signup_sessions s \
         where p.signup_session_id = s.id and (s.expires_at <= now() or s.consumed_at is not null)",
    )
    .execute(pool)
    .await?
    .rows_affected())
}

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

/// The account that uploaded a photo (`None` when there is no such photo, or it still belongs
/// to a sign-up session).
async fn owner(conn: &mut PgConnection, photo_id: Uuid) -> ApiResult<Option<String>> {
    Ok(
        sqlx::query_scalar::<_, Option<String>>("select account_uuid from photos where id = $1")
            .bind(photo_id)
            .fetch_optional(&mut *conn)
            .await?
            .flatten(),
    )
}
