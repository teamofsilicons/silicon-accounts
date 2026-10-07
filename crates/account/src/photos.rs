//! Profile photos: `POST /v1/me/photo` (raw image body, at most 2 MB), `DELETE /v1/me/photo`
//! (back to the default Iris photo) and the public `GET /v1/photos/{id}`.
//!
//! Uploads nobody shows are deleted (core's `repo::photos::prune`): uploading a new photo,
//! switching `pfp_url` away or removing the photo deletes the account's older uploads, so storage
//! stays bounded and removed photos disappear. An upload that another account still shows is
//! kept, because deleting it would leave that account's `pfp_url` pointing at a 404. This
//! happens when a custodian sets a Silicon's photo to one of its own uploads, including after the
//! Silicon is transferred to another Carbon.

use accounts_core::events;
use accounts_core::http::{AccountAuth, ClientMeta, IdempotencyKey, Json, Path};
use accounts_core::pfp;
use accounts_core::photo_upload;
use accounts_core::repo::accounts::{self, ProfileUpdate};
use accounts_core::repo::rate_limit::Limit;
use accounts_core::repo::{idempotency, photos};
use accounts_core::views::{self, MeView};
use accounts_core::{ApiError, ApiResult, AppState};
use axum::body::Body;
use axum::extract::State;
use axum::http::header::{
    CACHE_CONTROL, CONTENT_SECURITY_POLICY, CONTENT_TYPE, ETAG, IF_NONE_MATCH,
    X_CONTENT_TYPE_OPTIONS,
};
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::json;
use uuid::Uuid;

use crate::util::{audit_self, idem_scope, track};

/// Largest accepted photo body: 2 MB (core's `photo_upload` rules, shared by every photo
/// upload).
pub const MAX_PHOTO_BYTES: usize = photo_upload::MAX_PHOTO_BYTES;

/// Photo uploads allowed per account per hour (also counts the uploads a custodian makes for
/// its Silicons).
pub const PHOTO_UPLOADS_PER_HOUR: Limit = photo_upload::UPLOADS_PER_HOUR;

/// `Cache-Control` of served photos: a photo id never changes content.
const PHOTO_CACHE_CONTROL: &str = "public, max-age=31536000, immutable";

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
    let upload = photo_upload::read(&headers, body, "/v1/me/photo").await?;
    let info = upload.info;
    let fingerprint = upload.fingerprint();
    let scope = idem_scope(me.uuid(), "POST", "/v1/me/photo");
    idempotency::run(
        &state,
        key.as_deref(),
        &scope,
        &fingerprint,
        false,
        || async {
            photo_upload::count_account_upload(&state.db, me.uuid()).await?;
            let mut tx = state.db.begin().await?;
            // One upload at a time per account, so pruning never races another upload.
            accounts::lock(&mut tx, me.uuid()).await?;
            let photo_id = photos::insert_for_account(&mut tx, me.uuid(), &upload).await?;
            let pfp_url = pfp::photo_url(&state.settings, photo_id);
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
            photos::prune(&mut tx, &state.settings, me.uuid()).await?;
            audit_self(
                &mut tx,
                me.uuid(),
                "account.photo.uploaded",
                None,
                json!({
                    "photo_id": photo_id.to_string(), "content_type": info.kind.mime(),
                    "bytes": upload.bytes.len(), "width": info.width, "height": info.height,
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
                    "kind": me.kind(), "content_type": info.kind.mime(), "bytes": upload.bytes.len(),
                    "width": info.width, "height": info.height,
                }),
            );
            let mut conn = state.db.acquire().await?;
            let me_view = views::load_me(&mut conn, &account).await?;
            Ok((
                StatusCode::CREATED,
                json!({
                    "pfp_url": pfp_url,
                    "photo": upload.view(photo_id),
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
    let deleted = photos::prune(&mut tx, &state.settings, me.uuid()).await?;
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
    .hint("Read the current pfp_url again: GET /v1/me for your own account; an app reads its user's from GET /v1/apps/{app_id}/users/{uuid} or the account.updated webhook.")
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
