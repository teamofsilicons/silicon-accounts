//! `POST /v1/me/photo`, `DELETE /v1/me/photo`, `GET /v1/photos/{id}`.

use accounts_core::events::types;
use accounts_core::models::Scope;
use accounts_core::test_support::{Req, TestContext};
use serde_json::json;

use crate::common::*;

fn photo_path(pfp_url: &str) -> String {
    let i = pfp_url.find("/v1/photos/").expect("a photo url");
    pfp_url[i..].to_string()
}

#[tokio::test]
async fn upload_serve_replace_and_remove() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let app = member_app(&ctx, "photos", &carbon, &[Scope::Profile]).await;
    let tok = token(&ctx, &carbon).await;
    let png = images::png(256, 256);

    let r = call(
        &ctx,
        raw(
            Req::post("/v1/me/photo").bearer(&tok),
            Some("image/png"),
            png.clone(),
        ),
    )
    .await;
    assert_status(&r, 201);
    let url = r.json["pfp_url"].as_str().expect("pfp_url").to_string();
    assert!(
        url.starts_with(&format!("{}/v1/photos/", ctx.state.settings.public_url)),
        "{url}"
    );
    assert_eq!(r.json["me"]["pfp_url"], url);
    assert_eq!(r.json["photo"]["content_type"], "image/png");
    assert_eq!(r.json["photo"]["width"], 256);
    assert_eq!(r.json["photo"]["bytes"], png.len());
    let evs = events(&ctx, &app, types::ACCOUNT_UPDATED).await;
    assert_eq!(evs.len(), 1);
    assert_eq!(evs[0]["data"]["changed"], json!(["pfp_url"]));
    assert_eq!(evs[0]["data"]["account"]["pfp_url"], url);

    // Public, immutable, typed and safe to show anywhere.
    let path = photo_path(&url);
    let r = call(&ctx, Req::get(&path)).await;
    assert_status(&r, 200);
    assert_eq!(r.body, png);
    let header = |name: &str| {
        r.headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string)
    };
    assert_eq!(header("content-type").as_deref(), Some("image/png"));
    assert_eq!(
        header("cache-control").as_deref(),
        Some("public, max-age=31536000, immutable")
    );
    assert_eq!(header("x-content-type-options").as_deref(), Some("nosniff"));
    assert!(header("content-security-policy").is_some_and(|c| c.contains("sandbox")));
    let etag = header("etag").expect("etag");
    let r = call(&ctx, Req::get(&path).header("if-none-match", &etag)).await;
    assert_status(&r, 304);
    assert!(r.body.is_empty());

    // A new photo replaces the old one, which is deleted.
    let jpeg = images::jpeg(640, 480);
    let r = call(
        &ctx,
        raw(
            Req::post("/v1/me/photo").bearer(&tok),
            Some("image/jpeg"),
            jpeg.clone(),
        ),
    )
    .await;
    assert_status(&r, 201);
    let url2 = r.json["pfp_url"].as_str().expect("pfp_url").to_string();
    assert_ne!(url2, url);
    let r = call(&ctx, Req::get(&path)).await;
    assert_error(&r, 404, "photo_not_found");
    let r = call(&ctx, Req::get(&photo_path(&url2))).await;
    assert_eq!(r.body, jpeg);
    assert_eq!(
        r.headers.get("content-type").and_then(|v| v.to_str().ok()),
        Some("image/jpeg")
    );

    // Removing goes back to the default Iris photo and deletes the upload.
    let r = call(&ctx, Req::delete("/v1/me/photo").bearer(&tok)).await;
    assert_status(&r, 200);
    assert_eq!(
        r.json["pfp_url"],
        format!(
            "https://iris.teamofsilicons.com/pfp/carbon?id={}",
            carbon.uuid
        )
    );
    assert_eq!(r.json["uuid"], carbon.uuid, "returns the Me view");
    let r = call(&ctx, Req::get(&photo_path(&url2))).await;
    assert_error(&r, 404, "photo_not_found");
    let stored: i64 = scalar(
        &ctx,
        "select count(*) from photos where account_uuid = $1",
        &carbon.uuid,
    )
    .await;
    assert_eq!(stored, 0);
    assert_eq!(events(&ctx, &app, types::ACCOUNT_UPDATED).await.len(), 3);
    // Removing again is a no-op.
    let r = call(&ctx, Req::delete("/v1/me/photo").bearer(&tok)).await;
    assert_status(&r, 200);
    assert_eq!(events(&ctx, &app, types::ACCOUNT_UPDATED).await.len(), 3);

    let r = call(&ctx, Req::get("/v1/photos/not-a-photo")).await;
    assert_error(&r, 404, "photo_not_found");
}

#[tokio::test]
async fn every_accepted_format_uploads() {
    let ctx = TestContext::new().await;
    let (silicon, _) = ctx.silicon(&ctx.carbon().await.uuid).await;
    let tok = token(&ctx, &silicon).await;
    for (ct, bytes, w) in [
        ("image/png", images::png(10, 12), 10),
        ("image/jpeg", images::jpeg(30, 20), 30),
        ("image/jpg", images::jpeg(31, 20), 31),
        ("image/gif", images::gif(16, 16), 16),
        ("image/webp", images::webp(300, 200), 300),
    ] {
        let r = call(
            &ctx,
            raw(Req::post("/v1/me/photo").bearer(&tok), Some(ct), bytes),
        )
        .await;
        assert_status(&r, 201);
        assert_eq!(r.json["photo"]["width"], w, "{ct}");
        assert_eq!(r.json["me"]["kind"], "silicon");
    }
}

#[tokio::test]
async fn uploads_are_checked_byte_by_byte() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let tok = token(&ctx, &carbon).await;
    let post =
        |ct: Option<&str>, body: Vec<u8>| raw(Req::post("/v1/me/photo").bearer(&tok), ct, body);

    let r = call(&ctx, post(None, images::png(1, 1))).await;
    assert_error(&r, 415, "unsupported_media_type");
    let r = call(&ctx, post(Some("image/svg+xml"), b"<svg/>".to_vec())).await;
    assert_error(&r, 415, "unsupported_media_type");
    let r = call(
        &ctx,
        post(Some("multipart/form-data; boundary=x"), b"--x".to_vec()),
    )
    .await;
    assert_error(&r, 415, "unsupported_media_type");
    assert!(
        r.json["error"]["hint"]
            .as_str()
            .is_some_and(|h| h.contains("not a multipart form"))
    );

    let r = call(
        &ctx,
        post(
            Some("image/png"),
            b"<svg xmlns=\"http://www.w3.org/2000/svg\"><script/></svg>".to_vec(),
        ),
    )
    .await;
    assert_error(&r, 422, "invalid_image");
    assert!(
        r.json["error"]["message"]
            .as_str()
            .is_some_and(|m| m.contains("SVG"))
    );

    let r = call(&ctx, post(Some("image/png"), images::jpeg(10, 10))).await;
    assert_error(&r, 422, "photo_type_mismatch");
    assert_eq!(
        r.json["error"]["details"]["detected_content_type"],
        "image/jpeg"
    );

    let r = call(
        &ctx,
        post(Some("image/png"), images::png(10, 10)[..20].to_vec()),
    )
    .await;
    assert_error(&r, 422, "invalid_image");
    let r = call(&ctx, post(Some("image/png"), Vec::new())).await;
    assert_error(&r, 422, "empty_photo");
    let r = call(&ctx, post(Some("image/png"), images::png(30_000, 30_000))).await;
    assert_error(&r, 422, "photo_dimensions_too_large");

    let mut big = images::png(100, 100);
    big.resize(2 * 1024 * 1024 + 1, 0);
    let r = call(&ctx, post(Some("image/png"), big.clone())).await;
    assert_error(&r, 413, "photo_too_large");
    let r = call(
        &ctx,
        post(Some("image/png"), big).header("content-length", &(2 * 1024 * 1024 + 1).to_string()),
    )
    .await;
    assert_error(&r, 413, "photo_too_large");
    // Exactly 2 MB is fine.
    let mut max = images::png(100, 100);
    max.resize(2 * 1024 * 1024, 0);
    let r = call(&ctx, post(Some("image/png"), max)).await;
    assert_status(&r, 201);

    let r = call(
        &ctx,
        raw(
            Req::post("/v1/me/photo"),
            Some("image/png"),
            images::png(1, 1),
        ),
    )
    .await;
    assert_error(&r, 401, "unauthenticated");
    let stored: i64 = scalar(
        &ctx,
        "select count(*) from photos where account_uuid = $1",
        &carbon.uuid,
    )
    .await;
    assert_eq!(stored, 1, "only the accepted upload was stored");
}

#[tokio::test]
async fn uploads_are_idempotent_and_rate_limited() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let tok = token(&ctx, &carbon).await;
    let req = || {
        raw(
            Req::post("/v1/me/photo")
                .bearer(&tok)
                .header("idempotency-key", "photo-1"),
            Some("image/gif"),
            images::gif(4, 4),
        )
    };
    let a = call(&ctx, req()).await;
    assert_status(&a, 201);
    let b = call(&ctx, req()).await;
    assert_status(&b, 201);
    assert_eq!(a.json["pfp_url"], b.json["pfp_url"]);
    assert_eq!(
        b.headers
            .get("idempotent-replayed")
            .and_then(|v| v.to_str().ok()),
        Some("true")
    );
    let stored: i64 = scalar(
        &ctx,
        "select count(*) from photos where account_uuid = $1",
        &carbon.uuid,
    )
    .await;
    assert_eq!(stored, 1);

    ctx.exec(&format!(
        "insert into rate_limits (bucket, window_started_at, count) values ('photo_upload:account:{}', now(), 20) \
         on conflict (bucket) do update set count = 20, window_started_at = now()",
        carbon.uuid
    ))
    .await;
    let r = call(
        &ctx,
        raw(
            Req::post("/v1/me/photo").bearer(&tok),
            Some("image/gif"),
            images::gif(5, 5),
        ),
    )
    .await;
    assert_error(&r, 429, "rate_limited");
}

#[tokio::test]
async fn a_photo_a_custodied_silicon_still_shows_is_kept() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let (silicon, _) = ctx.silicon(&carbon.uuid).await;
    let tok = token(&ctx, &carbon).await;
    let first = call(
        &ctx,
        raw(
            Req::post("/v1/me/photo").bearer(&tok),
            Some("image/png"),
            images::png(2, 2),
        ),
    )
    .await;
    let first_url = first.json["pfp_url"].as_str().expect("url").to_string();
    sqlx::query("update accounts set pfp_url = $2 where uuid = $1")
        .bind(&silicon.uuid)
        .bind(&first_url)
        .execute(&ctx.state.db)
        .await
        .expect("silicon uses the custodian's upload");
    let second = call(
        &ctx,
        raw(
            Req::post("/v1/me/photo").bearer(&tok),
            Some("image/png"),
            images::png(3, 3),
        ),
    )
    .await;
    assert_status(&second, 201);
    let r = call(&ctx, Req::get(&photo_path(&first_url))).await;
    assert_status(&r, 200);
}

#[tokio::test]
async fn a_server_body_limit_reads_as_photo_too_large() {
    // The server wraps this route's body in a 2 MB `Limited` (tower-http's limit uses the same
    // wrapper); a chunked body that overflows it must still read as photo_too_large.
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let tok = token(&ctx, &carbon).await;
    let limited = router().layer(tower_http::limit::RequestBodyLimitLayer::new(
        accounts_account::MAX_PHOTO_BYTES,
    ));
    let mut big = images::png(64, 64);
    big.resize(accounts_account::MAX_PHOTO_BYTES + 10, 0);
    let r = ctx
        .call(
            limited,
            raw(
                Req::post("/v1/me/photo").bearer(&tok),
                Some("image/png"),
                big,
            ),
        )
        .await;
    assert_error(&r, 413, "photo_too_large");
}

#[tokio::test]
async fn a_photo_a_transferred_silicon_shows_is_kept() {
    let ctx = TestContext::new().await;
    let first = ctx.carbon().await;
    let second = ctx.carbon().await;
    let (silicon, _) = ctx.silicon(&first.uuid).await;
    let tok = token(&ctx, &first).await;
    let r = call(
        &ctx,
        raw(
            Req::post("/v1/me/photo").bearer(&tok),
            Some("image/png"),
            images::png(4, 4),
        ),
    )
    .await;
    let given = r.json["pfp_url"].as_str().expect("url").to_string();
    sqlx::query("update accounts set pfp_url = $2 where uuid = $1")
        .bind(&silicon.uuid)
        .bind(&given)
        .execute(&ctx.state.db)
        .await
        .expect("the custodian gives the Silicon its photo");
    // The Silicon moves to another custodian, then its first custodian removes their photo.
    sqlx::query("update accounts set custodian_uuid = $2 where uuid = $1")
        .bind(&silicon.uuid)
        .bind(&second.uuid)
        .execute(&ctx.state.db)
        .await
        .expect("transfer");
    let r = call(&ctx, Req::delete("/v1/me/photo").bearer(&tok)).await;
    assert_status(&r, 200);
    let r = call(&ctx, Req::get(&photo_path(&given))).await;
    assert_status(&r, 200);
    assert_eq!(reload(&ctx, &silicon.uuid).await.pfp_url, given);

    // Once nobody shows it, the uploader's next photo change deletes it.
    sqlx::query("update accounts set pfp_url = 'https://cdn.example.com/s.png' where uuid = $1")
        .bind(&silicon.uuid)
        .execute(&ctx.state.db)
        .await
        .expect("the Silicon changes its photo");
    let r = call(
        &ctx,
        raw(
            Req::post("/v1/me/photo").bearer(&tok),
            Some("image/png"),
            images::png(5, 5),
        ),
    )
    .await;
    assert_status(&r, 201);
    let r = call(&ctx, Req::get(&photo_path(&given))).await;
    assert_error(&r, 404, "photo_not_found");
    // A deleted account's pfp_url keeps nothing alive either.
    let current = r_url(&ctx, &first.uuid).await;
    let (gone, _) = ctx.silicon(&first.uuid).await;
    sqlx::query(
        "update accounts set pfp_url = $2, status = 'deleted', handle = null where uuid = $1",
    )
    .bind(&gone.uuid)
    .bind(&current)
    .execute(&ctx.state.db)
    .await
    .expect("a deleted Silicon that showed it");
    let r = call(&ctx, Req::delete("/v1/me/photo").bearer(&tok)).await;
    assert_status(&r, 200);
    let r = call(&ctx, Req::get(&photo_path(&current))).await;
    assert_error(&r, 404, "photo_not_found");
}

async fn r_url(ctx: &TestContext, uuid: &str) -> String {
    reload(ctx, uuid).await.pfp_url
}

#[tokio::test]
async fn revalidation_answers_without_the_bytes() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let tok = token(&ctx, &carbon).await;
    let r = call(
        &ctx,
        raw(
            Req::post("/v1/me/photo").bearer(&tok),
            Some("image/png"),
            images::png(7, 7),
        ),
    )
    .await;
    let url = r.json["pfp_url"].as_str().expect("url").to_string();
    let path = photo_path(&url);
    let etag = call(&ctx, Req::get(&path)).await.headers["etag"]
        .to_str()
        .expect("etag")
        .to_string();
    for tag in [etag.clone(), "*".to_string(), format!("\"x\", {etag}")] {
        let r = call(&ctx, Req::get(&path).header("if-none-match", &tag)).await;
        assert_status(&r, 304);
        assert!(r.body.is_empty());
        assert_eq!(r.headers["etag"].to_str().ok(), Some(etag.as_str()));
        assert_eq!(
            r.headers["cache-control"].to_str().ok(),
            Some("public, max-age=31536000, immutable")
        );
    }
    // Another tag gets the bytes.
    let r = call(&ctx, Req::get(&path).header("if-none-match", "\"other\"")).await;
    assert_status(&r, 200);
    assert_eq!(r.body, images::png(7, 7));
    // A removed photo is gone even for a client that still has it cached.
    assert_status(
        &call(&ctx, Req::delete("/v1/me/photo").bearer(&tok)).await,
        200,
    );
    let r = call(&ctx, Req::get(&path).header("if-none-match", &etag)).await;
    assert_error(&r, 404, "photo_not_found");
}
