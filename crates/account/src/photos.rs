//! Profile photos: `POST /v1/me/photo` (raw image body, at most 2 MB), `DELETE /v1/me/photo`
//! (back to the default Iris photo) and the public `GET /v1/photos/{id}`.
//!
//! Uploads nobody shows are deleted: uploading a new photo, switching `pfp_url` away or removing
//! the photo deletes the account's older uploads, so storage stays bounded and removed photos
//! disappear. An upload that another account still shows is kept, because deleting it would
//! leave that account's `pfp_url` pointing at a 404. This happens when a custodian sets a
//! Silicon's photo to one of its own uploads, including after the Silicon is transferred to
//! another Carbon.

use accounts_core::crypto;
use accounts_core::events;
use accounts_core::http::{AccountAuth, ClientMeta, IdempotencyKey, Json, Path};
use accounts_core::pfp;
use accounts_core::repo::accounts::{self, ProfileUpdate};
use accounts_core::repo::idempotency;
use accounts_core::repo::rate_limit::{self, Limit};
use accounts_core::views::{self, MeView};
use accounts_core::{ApiError, ApiResult, AppState, Settings};
use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::http::header::{
    CACHE_CONTROL, CONTENT_LENGTH, CONTENT_SECURITY_POLICY, CONTENT_TYPE, ETAG, IF_NONE_MATCH,
    X_CONTENT_TYPE_OPTIONS,
};
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use futures::StreamExt;
use serde_json::json;
use sqlx::PgConnection;
use uuid::Uuid;

use crate::image::{self, ImageError, ImageInfo, ImageKind};
use crate::util::{audit_self, idem_scope, photo_url_prefix, track};

/// Largest accepted photo body: 2 MB.
pub const MAX_PHOTO_BYTES: usize = 2 * 1024 * 1024;

/// Photo uploads allowed per account per hour.
pub const PHOTO_UPLOADS_PER_HOUR: Limit = Limit::new(20, 3600);

/// `Cache-Control` of served photos: a photo id never changes content.
const PHOTO_CACHE_CONTROL: &str = "public, max-age=31536000, immutable";

fn too_large(bytes: Option<u64>) -> ApiError {
    let size = bytes
        .map(|b| format!("{b} bytes"))
        .unwrap_or_else(|| "more than 2 MB".to_string());
    ApiError::new(
        StatusCode::PAYLOAD_TOO_LARGE,
        "photo_too_large",
        format!(
            "The photo is {size}; profile photos are limited to 2 MB ({MAX_PHOTO_BYTES} bytes)."
        ),
    )
    .hint("Resize or compress the image below 2 MB (512×512 pixels is plenty for a profile photo).")
    .detail("max_bytes", MAX_PHOTO_BYTES as u64)
}

/// The declared image type from Content-Type (415 when missing or not an accepted image type).
fn declared_kind(headers: &HeaderMap) -> ApiResult<ImageKind> {
    let raw = headers
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .unwrap_or("");
    if raw.is_empty() {
        return Err(ApiError::new(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "unsupported_media_type",
            format!(
                "The photo upload has no Content-Type; send the image's raw bytes as the body with Content-Type {}.",
                ImageKind::accepted_list()
            ),
        )
        .hint("For example: curl -X POST --data-binary @me.png -H 'Content-Type: image/png' …/v1/me/photo"));
    }
    ImageKind::from_content_type(raw).ok_or_else(|| {
        let shown = crate::util::clip(raw, 80);
        let hint = if raw.to_ascii_lowercase().starts_with("multipart/") {
            "Send the image's raw bytes as the request body (not a multipart form) with Content-Type image/png, image/jpeg, image/webp or image/gif."
        } else {
            "Convert the image to PNG, JPEG, WebP or GIF and send it with the matching Content-Type."
        };
        ApiError::new(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "unsupported_media_type",
            format!(
                "Content-Type '{shown}' is not accepted for profile photos; use {}.",
                ImageKind::accepted_list()
            ),
        )
        .hint(hint)
    })
}

/// Reads the body, stopping as soon as it passes [`MAX_PHOTO_BYTES`].
async fn read_limited(body: Body) -> ApiResult<Bytes> {
    let mut stream = body.into_data_stream();
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| {
            // The server wraps this route's body in a 2 MB `Limited` (the same limit as here);
            // overflowing it surfaces as a "length limit exceeded" read error.
            if e.to_string().to_ascii_lowercase().contains("length limit") {
                too_large(None)
            } else {
                ApiError::bad_request(
                    "invalid_body",
                    format!("The photo body could not be read: {e}."),
                )
                .hint("Send the image's raw bytes as the request body.")
            }
        })?;
        if buf.len() + chunk.len() > MAX_PHOTO_BYTES {
            return Err(too_large(None));
        }
        buf.extend_from_slice(&chunk);
    }
    Ok(Bytes::from(buf))
}

fn image_error(e: ImageError, declared: ImageKind) -> ApiError {
    match e {
        ImageError::Unrecognized { looks_like } => ApiError::unprocessable(
            "invalid_image",
            match looks_like {
                Some(what) => format!(
                    "The body is not a PNG, JPEG, WebP or GIF image: it looks like {what}. Content-Type said {}.",
                    declared.mime()
                ),
                None => format!(
                    "The body is not a PNG, JPEG, WebP or GIF image (its first bytes match none of them). Content-Type said {}.",
                    declared.mime()
                ),
            },
        )
        .hint("Upload the image file's raw bytes as the body, unchanged (no base64, no form encoding)."),
        ImageError::Mismatch { declared, actual } => ApiError::unprocessable(
            "photo_type_mismatch",
            format!(
                "The body is a {} image, but Content-Type says {}.",
                actual.name(),
                declared.mime()
            ),
        )
        .hint(format!("Send it with Content-Type: {}.", actual.mime()))
        .detail("detected_content_type", actual.mime()),
        ImageError::Corrupt { kind, why } => ApiError::unprocessable(
            "invalid_image",
            format!("The {} image is damaged or incomplete: {why}.", kind.name()),
        )
        .hint("Re-export the image and upload the complete file."),
        ImageError::TooLarge {
            kind,
            width,
            height,
        } => ApiError::unprocessable(
            "photo_dimensions_too_large",
            format!(
                "The {} image is {width}×{height} pixels; profile photos can be at most {max}×{max} pixels and {mp} megapixels.",
                kind.name(),
                max = image::MAX_DIMENSION,
                mp = image::MAX_PIXELS / 1_000_000
            ),
        )
        .hint("Resize it; 512×512 pixels is plenty for a profile photo.")
        .detail("width", width)
        .detail("height", height),
    }
}

/// Deletes the account's uploaded photos that no account shows any more. An upload stays while
/// any account that isn't deleted has it as its `pfp_url`: the uploader itself, or a Silicon
/// whose custodian gave it that photo, even after the Silicon was transferred to another Carbon.
/// Deleted accounts don't keep photos alive. Returns how many photos were deleted.
///
/// Callers hold the uploader's account row lock (`accounts::lock`). Every handler in this crate
/// that changes an account's `pfp_url` or deletes its photos takes that lock first, so a photo
/// that `PATCH /v1/me` has just checked can't be pruned before the change commits.
pub(crate) async fn prune_photos(
    conn: &mut PgConnection,
    settings: &Settings,
    account_uuid: &str,
) -> ApiResult<u64> {
    // `a.pfp_url = <url>` is a plain equality, so an index on accounts.pfp_url can serve it.
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

/// `POST /v1/me/photo` — the body is the raw image (Content-Type image/png, image/jpeg,
/// image/webp or image/gif; at most 2 MB). The bytes must really be that format; dimensions
/// are capped (see [`image`]). Sets the account's `pfp_url` to
/// `{PUBLIC_URL}/v1/photos/{photo_id}` and notifies apps (`account.updated`, field pfp_url).
/// 201 `{"pfp_url","photo":{…},"me":Me}`. Accepts `Idempotency-Key`.
pub(crate) async fn upload(
    State(state): State<AppState>,
    me: AccountAuth,
    meta: ClientMeta,
    key: Option<IdempotencyKey>,
    headers: HeaderMap,
    body: Body,
) -> Result<Response, ApiError> {
    let declared = declared_kind(&headers)?;
    let content_length = headers
        .get(CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse::<u64>().ok());
    if let Some(len) = content_length
        && len > MAX_PHOTO_BYTES as u64
    {
        return Err(too_large(Some(len)));
    }
    let bytes = read_limited(body).await?;
    if bytes.is_empty() {
        return Err(ApiError::unprocessable(
            "empty_photo",
            "The photo body is empty; send the image's raw bytes as the request body.",
        )
        .hint("For example: curl -X POST --data-binary @me.png -H 'Content-Type: image/png' …/v1/me/photo"));
    }
    let info: ImageInfo = image::inspect(&bytes, declared).map_err(|e| image_error(e, declared))?;
    let fingerprint = json!({
        "content_type": info.kind.mime(),
        "bytes": bytes.len(),
        "sha256": crypto::b64url(&crypto::sha256(&bytes)),
    });
    let scope = idem_scope(me.uuid(), "POST", "/v1/me/photo");
    idempotency::run(
        &state.db,
        key.as_deref(),
        &scope,
        &fingerprint,
        false,
        || async {
            rate_limit::enforce_pool(
                &state.db,
                &rate_limit::bucket("photo_upload:account", me.uuid()),
                PHOTO_UPLOADS_PER_HOUR,
                "profile photo uploads for this account",
            )
            .await?;
            let photo_id = Uuid::now_v7();
            let pfp_url = format!("{}{photo_id}", photo_url_prefix(&state.settings));
            let mut tx = state.db.begin().await?;
            // One upload at a time per account, so pruning never races another upload.
            accounts::lock(&mut tx, me.uuid()).await?;
            sqlx::query(
                "insert into photos (id, account_uuid, content_type, bytes) values ($1, $2, $3, $4)",
            )
            .bind(photo_id)
            .bind(me.uuid())
            .bind(info.kind.mime())
            .bind(bytes.as_ref())
            .execute(&mut *tx)
            .await?;
            let (account, changed) = accounts::update_profile(
                &mut tx,
                me.uuid(),
                &ProfileUpdate {
                    pfp_url: Some(pfp_url.clone()),
                    ..Default::default()
                },
            )
            .await?;
            events::notify_profile_updated(&mut tx, &account, &changed).await?;
            prune_photos(&mut tx, &state.settings, me.uuid()).await?;
            audit_self(
                &mut tx,
                me.uuid(),
                "account.photo.uploaded",
                None,
                json!({
                    "photo_id": photo_id.to_string(), "content_type": info.kind.mime(),
                    "bytes": bytes.len(), "width": info.width, "height": info.height,
                }),
                meta.ip.as_deref(),
            )
            .await?;
            tx.commit().await?;
            track(
                &state,
                "photo",
                "account.photo.uploaded",
                json!({
                    "kind": me.kind(), "content_type": info.kind.mime(), "bytes": bytes.len(),
                    "width": info.width, "height": info.height,
                }),
            );
            let mut conn = state.db.acquire().await?;
            let me_view = views::load_me(&mut conn, &account).await?;
            Ok((
                StatusCode::CREATED,
                json!({
                    "pfp_url": pfp_url,
                    "photo": {
                        "id": photo_id.to_string(),
                        "content_type": info.kind.mime(),
                        "bytes": bytes.len(),
                        "width": info.width,
                        "height": info.height,
                    },
                    "me": serde_json::to_value(me_view)?,
                }),
            ))
        },
    )
    .await
}

/// `DELETE /v1/me/photo` — back to the default Iris photo; uploaded photos are deleted.
/// Returns Me.
pub(crate) async fn remove(
    State(state): State<AppState>,
    me: AccountAuth,
    meta: ClientMeta,
) -> ApiResult<Json<MeView>> {
    let default_url = pfp::default_pfp_url(&state.settings.iris_base_url, me.kind(), me.uuid());
    let mut tx = state.db.begin().await?;
    accounts::lock(&mut tx, me.uuid()).await?;
    let (account, changed) = accounts::update_profile(
        &mut tx,
        me.uuid(),
        &ProfileUpdate {
            pfp_url: Some(default_url),
            ..Default::default()
        },
    )
    .await?;
    events::notify_profile_updated(&mut tx, &account, &changed).await?;
    let deleted = prune_photos(&mut tx, &state.settings, me.uuid()).await?;
    if !changed.is_empty() || deleted > 0 {
        audit_self(
            &mut tx,
            me.uuid(),
            "account.photo.removed",
            None,
            json!({ "deleted_photos": deleted }),
            meta.ip.as_deref(),
        )
        .await?;
    }
    tx.commit().await?;
    if !changed.is_empty() || deleted > 0 {
        track(
            &state,
            "photo",
            "account.photo.removed",
            json!({ "kind": me.kind(), "deleted_photos": deleted }),
        );
    }
    let mut conn = state.db.acquire().await?;
    Ok(Json(views::load_me(&mut conn, &account).await?))
}

fn photo_not_found(id: &str) -> ApiError {
    ApiError::not_found(
        "photo_not_found",
        format!(
            "No photo '{}' exists: it was never uploaded, or it was replaced or removed by its account.",
            crate::util::clip(id, 60)
        ),
    )
    .hint("Fetch the account again (GET /v1/accounts/{uuid} or the account.updated webhook) for its current pfp_url.")
}

/// `GET /v1/photos/{id}` — public. Serves the stored bytes with their type, immutable caching,
/// an `ETag` (answers `If-None-Match` with 304) and headers that keep browsers from treating the
/// bytes as anything but an image. A revalidation (304) only checks that the photo still
/// exists; the bytes (up to 2 MB) are read from the database only for a 200.
pub(crate) async fn serve(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let Ok(photo_id) = Uuid::parse_str(id.trim()) else {
        return Err(photo_not_found(&id));
    };
    let etag = format!("\"{photo_id}\"");
    let matches_etag = headers
        .get(IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.split(',').any(|t| t.trim() == etag || t.trim() == "*"));
    let mut response = if matches_etag {
        // A photo id never changes content, so the client's copy is current if the photo
        // still exists. This query only touches the primary key, never the stored bytes.
        let exists: bool = sqlx::query_scalar("select exists (select 1 from photos where id = $1)")
            .bind(photo_id)
            .fetch_one(&state.db)
            .await?;
        if !exists {
            return Err(photo_not_found(&id));
        }
        StatusCode::NOT_MODIFIED.into_response()
    } else {
        let row: Option<(String, Vec<u8>)> =
            sqlx::query_as("select content_type, bytes from photos where id = $1")
                .bind(photo_id)
                .fetch_optional(&state.db)
                .await?;
        let Some((content_type, bytes)) = row else {
            return Err(photo_not_found(&id));
        };
        let mut r = (StatusCode::OK, bytes).into_response();
        if let Ok(v) = HeaderValue::from_str(&content_type) {
            r.headers_mut().insert(CONTENT_TYPE, v);
        }
        r
    };
    let h = response.headers_mut();
    if let Ok(v) = HeaderValue::from_str(&etag) {
        h.insert(ETAG, v);
    }
    h.insert(CACHE_CONTROL, HeaderValue::from_static(PHOTO_CACHE_CONTROL));
    h.insert(X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    h.insert(
        CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("default-src 'none'; sandbox"),
    );
    h.insert(
        HeaderName::from_static("cross-origin-resource-policy"),
        HeaderValue::from_static("cross-origin"),
    );
    Ok(response)
}
