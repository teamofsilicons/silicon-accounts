//! `POST /v1/me/silicons/{uuid}/photo`: a custodian uploads its Silicon's profile photo.

use accounts_core::models::Scope;
use accounts_core::test_support::{Req, TestContext};
use serde_json::{Value, json};

use crate::common::*;

/// A minimal valid PNG of the given size.
fn png(width: u32, height: u32) -> Vec<u8> {
    let mut v = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    v.extend_from_slice(&13u32.to_be_bytes());
    v.extend_from_slice(b"IHDR");
    v.extend_from_slice(&width.to_be_bytes());
    v.extend_from_slice(&height.to_be_bytes());
    v.extend_from_slice(&[8, 6, 0, 0, 0, 0x1F, 0x15, 0xC4, 0x89]);
    v.extend_from_slice(&[0, 0, 0, 0, b'I', b'E', b'N', b'D', 0xAE, 0x42, 0x60, 0x82]);
    v
}

fn upload(path_key: &str, token: &str, content_type: Option<&str>, body: Vec<u8>) -> Req {
    let mut req = Req::post(&format!("/v1/me/silicons/{path_key}/photo")).bearer(token);
    req.body = body;
    match content_type {
        Some(ct) => req.header("content-type", ct),
        None => req,
    }
}

async fn photo_owner(ctx: &TestContext, pfp_url: &str) -> Option<String> {
    let id = pfp_url.rsplit('/').next().expect("photo id");
    let id = uuid::Uuid::parse_str(id).expect("uuid");
    sqlx::query_scalar::<_, Option<String>>("select account_uuid from photos where id = $1")
        .bind(id)
        .fetch_optional(&ctx.state.db)
        .await
        .expect("photo row")
        .flatten()
}

#[tokio::test]
async fn a_custodian_uploads_its_silicons_photo() {
    let ctx = TestContext::new().await;
    let saket = ctx.carbon().await;
    let t = token(&ctx, &saket).await;
    let (silicon, _) = ctx.silicon(&saket.uuid).await;
    let (app, _) = ctx.app("photo-app").await;
    ctx.set_app_webhook(&app.app_id, "http://127.0.0.1:8593/photo-app/webhooks")
        .await;
    ctx.membership(&app.app_id, &silicon.uuid, &[Scope::Profile])
        .await;
    let r = call(
        &ctx,
        Req::put(&format!("/v1/me/silicons/{}/webhook", silicon.uuid))
            .bearer(&t)
            .json(json!({"url": "http://127.0.0.1:8593/hooks/s"})),
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.json);

    let r = call(
        &ctx,
        upload(&silicon.uuid, &t, Some("image/png"), png(96, 96)),
    )
    .await;
    assert_eq!(r.status, 201, "{}", r.json);
    let url = r.json["pfp_url"].as_str().expect("pfp_url").to_string();
    assert!(
        url.starts_with(&format!("{}/v1/photos/", ctx.state.settings.public_url)),
        "{url}"
    );
    assert_eq!(r.json["photo"]["width"], 96);
    assert_eq!(r.json["photo"]["content_type"], "image/png");
    assert_eq!(r.json["silicon"]["pfp_url"], url.as_str());
    assert_eq!(r.json["silicon"]["uuid"], silicon.uuid.as_str());
    assert_eq!(
        photo_owner(&ctx, &url).await.as_deref(),
        Some(silicon.uuid.as_str()),
        "the photo belongs to the Silicon"
    );
    // Apps that see the Silicon and the Silicon's own webhook hear about it.
    let app_types: Vec<String> = app_events(&ctx, &app.app_id)
        .await
        .into_iter()
        .map(|(t, _)| t)
        .collect();
    assert_eq!(app_types, vec!["account.updated"]);
    let (kind, payload) = silicon_events(&ctx, &silicon.uuid)
        .await
        .pop()
        .expect("silicon event");
    assert_eq!(kind, "silicon.updated");
    assert_eq!(payload["data"]["changed"], json!(["pfp_url"]));

    // By si:id too; a new upload replaces the old one, which nobody shows any more.
    let r = call(
        &ctx,
        upload(
            silicon.handle.as_deref().expect("si:id"),
            &t,
            Some("image/png"),
            png(64, 64),
        ),
    )
    .await;
    assert_eq!(r.status, 201, "{}", r.json);
    let second = r.json["pfp_url"].as_str().expect("pfp_url").to_string();
    assert_ne!(second, url);
    assert_eq!(
        photo_owner(&ctx, &url).await,
        None,
        "the replaced upload is deleted"
    );

    // The upload is the Silicon's own: PATCHing it back is fine, and the audit names the actor.
    let r = call(
        &ctx,
        Req::patch(&format!("/v1/me/silicons/{}", silicon.uuid))
            .bearer(&t)
            .json(json!({"pfp_url": second})),
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.json);
    let audited: i64 = sqlx::query_scalar(
        "select count(*) from audit_log where action = 'silicon.photo.uploaded' and target_kind = 'silicon' and target_id = $1",
    )
    .bind(&silicon.uuid)
    .fetch_one(&ctx.state.db)
    .await
    .expect("audit");
    assert_eq!(
        audited, 4,
        "two uploads, each in the Silicon's and the custodian's history"
    );
}

#[tokio::test]
async fn photo_uploads_follow_the_photo_rules_and_custody() {
    let ctx = TestContext::new().await;
    let saket = ctx.carbon().await;
    let t = token(&ctx, &saket).await;
    let (silicon, stk) = ctx.silicon(&saket.uuid).await;

    let r = call(&ctx, upload(&silicon.uuid, &t, None, png(8, 8))).await;
    assert_eq!(r.status, 415, "{}", r.json);
    assert_eq!(r.error_code(), Some("unsupported_media_type"));
    let r = call(
        &ctx,
        upload(&silicon.uuid, &t, Some("image/jpeg"), png(8, 8)),
    )
    .await;
    assert_eq!(r.error_code(), Some("photo_type_mismatch"));
    let r = call(
        &ctx,
        upload(&silicon.uuid, &t, Some("image/png"), b"<svg/>".to_vec()),
    )
    .await;
    assert_eq!(r.error_code(), Some("invalid_image"));
    let r = call(
        &ctx,
        upload(&silicon.uuid, &t, Some("image/png"), png(9000, 10)),
    )
    .await;
    assert_eq!(r.error_code(), Some("photo_dimensions_too_large"));

    // Somebody else's Silicon is not found; the Silicon itself is not a Carbon.
    let stranger = ctx.carbon().await;
    let r = call(
        &ctx,
        upload(
            &silicon.uuid,
            &token(&ctx, &stranger).await,
            Some("image/png"),
            png(8, 8),
        ),
    )
    .await;
    assert_eq!(r.status, 404);
    assert_eq!(r.error_code(), Some("silicon_not_found"));
    let login = login(&ctx, silicon.handle.as_deref().expect("si:id"), &stk).await;
    let silicon_token = login.json["access_token"]
        .as_str()
        .expect("token")
        .to_string();
    let r = call(
        &ctx,
        upload(&silicon.uuid, &silicon_token, Some("image/png"), png(8, 8)),
    )
    .await;
    assert_eq!(r.status, 403, "{}", r.json);

    // A retry with the same Idempotency-Key gets the same photo back.
    let keyed = || {
        upload(&silicon.uuid, &t, Some("image/png"), png(12, 12)).header("idempotency-key", "ph-1")
    };
    let first = call(&ctx, keyed()).await;
    assert_eq!(first.status, 201, "{}", first.json);
    let again = call(&ctx, keyed()).await;
    assert_eq!(again.status, 201);
    assert_eq!(again.json["pfp_url"], first.json["pfp_url"]);
    assert_eq!(
        again
            .headers
            .get("idempotent-replayed")
            .and_then(|v| v.to_str().ok()),
        Some("true")
    );
    // The same key with another image is a conflict, not a second upload.
    let other = call(
        &ctx,
        upload(&silicon.uuid, &t, Some("image/png"), png(13, 13)).header("idempotency-key", "ph-1"),
    )
    .await;
    assert_eq!(other.error_code(), Some("idempotency_key_reused"));

    // 20 uploads per hour count against the custodian.
    ctx.exec(&format!(
        "insert into rate_limits (bucket, window_started_at, count) values ('photo_upload:account:{}', now(), 20) \
         on conflict (bucket) do update set count = 20, window_started_at = now()",
        saket.uuid
    ))
    .await;
    let r = call(
        &ctx,
        upload(&silicon.uuid, &t, Some("image/png"), png(8, 8)),
    )
    .await;
    assert_eq!(r.status, 429, "{}", r.json);
    assert_eq!(r.json["error"]["code"], Value::from("rate_limited"));
}
