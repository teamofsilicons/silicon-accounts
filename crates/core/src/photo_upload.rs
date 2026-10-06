//! Reading a photo upload: the raw image body every photo endpoint takes
//! (`POST /v1/me/photo`, a custodian's `POST /v1/me/silicons/{uuid}/photo` and the sign-up
//! page's `POST /v1/flows/{id}/signup/photo`).
//!
//! The rules are the same everywhere: the body is the image's raw bytes (no form, no base64)
//! with `Content-Type` image/png, image/jpeg, image/webp or image/gif; at most
//! [`MAX_PHOTO_BYTES`] (2 MB); the bytes must really be that format and at most 8192 pixels per
//! side ([`crate::image`]). Every refusal says exactly what was wrong and how to fix it.
//!
//! Storing the photo and deciding who may show it is `repo::photos`.

use axum::body::{Body, Bytes};
use axum::http::header::{CONTENT_LENGTH, CONTENT_TYPE};
use axum::http::{HeaderMap, StatusCode};
use futures::StreamExt;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};
use crate::image::{self, ImageError, ImageInfo, ImageKind};
use crate::repo::rate_limit::{self, Limit};

/// Largest accepted photo body: 2 MB.
pub const MAX_PHOTO_BYTES: usize = 2 * 1024 * 1024;

/// Photo uploads one account may make per hour: its own (`POST /v1/me/photo`) plus those it
/// makes for its Silicons as their custodian.
pub const UPLOADS_PER_HOUR: Limit = Limit::new(20, 3600);

/// Photo uploads one sign-up session may make per hour (the sign-up page's photo picker).
pub const SIGNUP_UPLOADS_PER_HOUR: Limit = Limit::new(20, 3600);

/// Counts one upload by the account `uploader_uuid` (429 `rate_limited` over
/// [`UPLOADS_PER_HOUR`]).
pub async fn count_account_upload(pool: &sqlx::PgPool, uploader_uuid: &str) -> ApiResult<()> {
    rate_limit::enforce_pool(
        pool,
        &rate_limit::bucket("photo_upload:account", uploader_uuid),
        UPLOADS_PER_HOUR,
        "profile photo uploads for this account",
    )
    .await
}

/// Counts one upload for the sign-up session `session_id` (429 `rate_limited` over
/// [`SIGNUP_UPLOADS_PER_HOUR`]).
pub async fn count_signup_upload(pool: &sqlx::PgPool, session_id: Uuid) -> ApiResult<()> {
    rate_limit::enforce_pool(
        pool,
        &rate_limit::bucket("photo_upload:signup", &session_id.to_string()),
        SIGNUP_UPLOADS_PER_HOUR,
        "profile photo uploads for this sign-up",
    )
    .await
}

/// A checked upload: real image bytes of an accepted format and size.
#[derive(Debug, Clone)]
pub struct UploadedPhoto {
    pub bytes: Bytes,
    pub info: ImageInfo,
}

impl UploadedPhoto {
    /// What identifies the upload for `Idempotency-Key` replays: its type, size and SHA-256.
    pub fn fingerprint(&self) -> Value {
        json!({
            "content_type": self.info.kind.mime(),
            "bytes": self.bytes.len(),
            "sha256": crate::crypto::b64url(&crate::crypto::sha256(&self.bytes)),
        })
    }

    /// `{"id","content_type","bytes","width","height"}` of the stored photo.
    pub fn view(&self, photo_id: Uuid) -> Value {
        json!({
            "id": photo_id.to_string(),
            "content_type": self.info.kind.mime(),
            "bytes": self.bytes.len(),
            "width": self.info.width,
            "height": self.info.height,
        })
    }
}

/// Reads and checks the upload of `route` (named in the hints, e.g. `/v1/me/photo`).
///
/// Errors: 415 `unsupported_media_type`, 413 `photo_too_large`, 422 `empty_photo`,
/// `invalid_image`, `photo_type_mismatch` or `photo_dimensions_too_large`, 400 `invalid_body`.
pub async fn read(headers: &HeaderMap, body: Body, route: &str) -> ApiResult<UploadedPhoto> {
    let declared = declared_kind(headers, route)?;
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
        .hint(format!(
            "For example: curl -X POST --data-binary @me.png -H 'Content-Type: image/png' …{route}"
        )));
    }
    let info = image::inspect(&bytes, declared).map_err(|e| image_error(e, declared))?;
    Ok(UploadedPhoto { bytes, info })
}

/// 413 `photo_too_large`.
pub fn too_large(bytes: Option<u64>) -> ApiError {
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

fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let head: String = s.chars().take(max).collect();
        format!("{head}…")
    }
}

/// The declared image type from Content-Type (415 when missing or not an accepted image type).
fn declared_kind(headers: &HeaderMap, route: &str) -> ApiResult<ImageKind> {
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
        .hint(format!(
            "For example: curl -X POST --data-binary @me.png -H 'Content-Type: image/png' …{route}"
        )));
    }
    ImageKind::from_content_type(raw).ok_or_else(|| {
        let shown = clip(raw, 80);
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
            // The server wraps photo routes' bodies in a 2 MB `Limited` (the same limit as
            // here); overflowing it surfaces as a "length limit exceeded" read error.
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

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn headers(content_type: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert(
            CONTENT_TYPE,
            HeaderValue::from_str(content_type).expect("hv"),
        );
        h
    }

    #[tokio::test]
    async fn reads_a_real_image_and_refuses_the_rest() {
        let png = image::samples::png(64, 48);
        let up = read(
            &headers("image/png"),
            Body::from(png.clone()),
            "/v1/me/photo",
        )
        .await
        .expect("png");
        assert_eq!((up.info.width, up.info.height), (64, 48));
        assert_eq!(up.fingerprint()["bytes"], png.len());
        let id = Uuid::now_v7();
        assert_eq!(up.view(id)["id"], id.to_string());

        let e = read(&HeaderMap::new(), Body::from(png.clone()), "/v1/x")
            .await
            .expect_err("no type");
        assert_eq!(e.code, "unsupported_media_type");
        assert!(e.hint.as_deref().is_some_and(|h| h.contains("/v1/x")));
        let e = read(&headers("image/jpeg"), Body::from(png), "/v1/x")
            .await
            .expect_err("mismatch");
        assert_eq!(e.code, "photo_type_mismatch");
        let e = read(&headers("image/png"), Body::from(Vec::new()), "/v1/x")
            .await
            .expect_err("empty");
        assert_eq!(e.code, "empty_photo");
        let e = read(
            &headers("image/png"),
            Body::from(vec![0u8; MAX_PHOTO_BYTES + 1]),
            "/v1/x",
        )
        .await
        .expect_err("too large");
        assert_eq!(e.code, "photo_too_large");
        let e = read(&headers("image/png"), Body::from("<svg></svg>"), "/v1/x")
            .await
            .expect_err("svg");
        assert!(e.message.contains("SVG"), "{}", e.message);
    }
}
