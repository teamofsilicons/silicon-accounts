//! The Silicon Apps stand-in: POST /v1/internal/apps/sync and seed_fake_apps.

mod common;

use accounts_core::Settings;
use accounts_core::secrecy::SecretString;
use accounts_core::test_support::{Req, TestContext};
use common::{call, fake_app_secret, seed_fake_apps, testkit};
use serde_json::{Value, json};

const TOKEN: &str = "internal-token-for-tests-0123456789abcdef";

async fn ctx_with_token() -> TestContext {
    let mut settings = Settings::for_tests();
    settings.internal_token = Some(SecretString::from(TOKEN));
    TestContext::with_settings(settings).await
}

fn sync(body: Value) -> Req {
    Req::post("/v1/internal/apps/sync").bearer(TOKEN).json(body)
}

const SECRET: &str = "sa_app_notes-x_0123456789abcdefghijklmnopqrstuv";

fn notes_app() -> Value {
    json!({
        "app_id": "notes-x", "name": "Notes X", "description": "Notes.",
        "logo_url": "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=", "homepage_url": "https://notes-x.example/",
        "owner_id": "c:notes-dev", "owner_email": "Dev@Notes-X.example", "secret": SECRET, "status": "active",
        "created_at": "2026-09-01T09:00:00.000Z",
        "signin_defaults": {
            "methods": {"email": true, "google": true},
            "google": {"mode": "byo", "client_id": "9-notes.apps.googleusercontent.com", "client_secret": "GOCSPX-notes-secret"},
            "redirect_uris": ["https://notes-x.example/callback"],
            "branding": {"radius": 24}
        },
        "webhook_url": "http://127.0.0.1:8593/notes-x/webhooks",
        "webhook_secret": "whsec_notesxnotesxnotesxnotesx",
        "testkit": {"ignored": true}
    })
}

#[tokio::test]
async fn sync_needs_the_internal_token() {
    let ctx = TestContext::new().await;
    let r = call(&ctx, sync(json!({"apps": [notes_app()]}))).await;
    assert_eq!(r.status, 403);
    assert_eq!(r.error_code(), Some("internal_api_disabled"));

    let ctx = ctx_with_token().await;
    let r = call(
        &ctx,
        Req::post("/v1/internal/apps/sync").json(json!({"apps": [notes_app()]})),
    )
    .await;
    assert_eq!(r.status, 401);
    assert_eq!(r.error_code(), Some("internal_token_required"));
    let r = call(
        &ctx,
        Req::post("/v1/internal/apps/sync")
            .bearer("internal-token-for-tests-WRONG")
            .json(json!({"apps": []})),
    )
    .await;
    assert_eq!(r.status, 401);
    assert_eq!(r.error_code(), Some("invalid_internal_token"));
    let r = call(
        &ctx,
        Req::post("/v1/internal/apps/sync")
            .basic("notes-x", SECRET)
            .json(json!({"apps": []})),
    )
    .await;
    assert_eq!(r.error_code(), Some("internal_token_required"));
}

#[tokio::test]
async fn sync_creates_apps_with_owners_secrets_and_webhooks() {
    let ctx = ctx_with_token().await;
    let r = call(
        &ctx,
        sync(json!({"_comment": "x", "version": 1, "apps": [notes_app()]})),
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(
        r.json["apps"][0],
        json!({"app_id": "notes-x", "action": "created", "owner": "c:notes-dev", "owner_created": true,
               "config": "applied", "config_version": 1, "webhook": "set", "changed": [], "warnings": []})
    );

    // The owner exists, active, with the verified email.
    let (status, email, verified): (String, String, bool) = sqlx::query_as(
        "select a.status, e.email, e.verified_at is not null from accounts a join account_emails e on e.account_uuid = a.uuid \
         where a.handle = 'c:notes-dev' and e.is_primary",
    )
    .fetch_one(&ctx.state.db)
    .await
    .expect("owner");
    assert_eq!(
        (status.as_str(), email.as_str(), verified),
        ("active", "dev@notes-x.example", true)
    );

    // The app works with its secret; BYO secret encrypted; webhook uses the given secret.
    let d = call(&ctx, Req::get("/v1/apps/notes-x").basic("notes-x", SECRET)).await;
    assert_eq!(d.status, 200, "{}", d.json);
    assert_eq!(d.json["source"], "silicon_apps");
    assert_eq!(d.json["created_at"], "2026-09-01T09:00:00.000Z");
    assert_eq!(d.json["owner"]["id"], "c:notes-dev");
    assert_eq!(d.json["config_version"], 1);
    assert_eq!(d.json["signin_config"]["google"]["client_secret_set"], true);
    assert_eq!(d.json["signin_config"]["branding"]["radius"], 24);
    assert_eq!(
        d.json["webhook"]["url"],
        "http://127.0.0.1:8593/notes-x/webhooks"
    );
    let (config, wh): (Value, Vec<u8>) = sqlx::query_as(
        "select config, webhook_secret_enc from app_signin_configs where app_id = 'notes-x'",
    )
    .fetch_one(&ctx.state.db)
    .await
    .expect("config");
    assert!(!config.to_string().contains("GOCSPX"));
    assert_eq!(
        ctx.state.keys.keyring.decrypt_string(&wh).expect("decrypt"),
        "whsec_notesxnotesxnotesxnotesx"
    );

    // Re-sync: identity follows, the sign-in setup stays, a new secret replaces the old one
    // at once (the credential cache is invalidated).
    let mut changed = notes_app();
    changed["name"] = json!("Notes X Pro");
    changed["secret"] = json!("sa_app_notes-x_NEWSECRET0123456789abcdefgh");
    changed["signin_defaults"]["branding"]["radius"] = json!(2);
    let r = call(&ctx, sync(json!([changed]))).await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(r.json["apps"][0]["action"], "updated");
    assert_eq!(r.json["apps"][0]["changed"], json!(["name", "secret"]));
    assert_eq!(r.json["apps"][0]["config"], "kept");
    let r = call(&ctx, Req::get("/v1/apps/notes-x").basic("notes-x", SECRET)).await;
    assert_eq!(r.status, 401, "the old secret stopped working immediately");
    let r = call(
        &ctx,
        Req::get("/v1/apps/notes-x").basic("notes-x", "sa_app_notes-x_NEWSECRET0123456789abcdefgh"),
    )
    .await;
    assert_eq!(r.json["name"], "Notes X Pro");
    assert_eq!(
        r.json["signin_config"]["branding"]["radius"], 24,
        "config kept"
    );
    assert_eq!(r.json["config_version"], 1);

    // Disabling through sync takes effect at once too.
    let mut disabled = changed.clone();
    disabled["status"] = json!("disabled");
    assert_eq!(
        call(&ctx, sync(json!({"apps": [disabled]}))).await.status,
        200
    );
    let r = call(
        &ctx,
        Req::get("/v1/apps/notes-x").basic("notes-x", "sa_app_notes-x_NEWSECRET0123456789abcdefgh"),
    )
    .await;
    assert_eq!(r.error_code(), Some("app_disabled"));
    let r = call(&ctx, sync(json!({"apps": [disabled]}))).await;
    assert_eq!(r.json["apps"][0]["action"], "unchanged");
}

#[tokio::test]
async fn sync_validates_everything_before_writing() {
    let ctx = ctx_with_token().await;
    let mut bad_branding = notes_app();
    bad_branding["signin_defaults"]["branding"] = json!({"light": {"primary": "pink"}});
    let mut no_secret = notes_app();
    no_secret["app_id"] = json!("other-x");
    no_secret.as_object_mut().map(|o| o.remove("secret"));
    let r = call(
        &ctx,
        sync(json!({"apps": [bad_branding, {"app_id": "Bad Id", "name": "x"}, {"app_id": "accounts", "name": "x"}, {"app_id": "developer", "name": "x"}]})),
    )
    .await;
    assert_eq!(r.status, 422, "{}", r.json);
    let fields = &r.json["error"]["details"]["fields"];
    assert!(
        fields["apps[0].signin_defaults.branding.light.primary"].is_string(),
        "{fields}"
    );
    assert!(fields["apps[1].app_id"].is_string(), "{fields}");
    for i in [2, 3] {
        assert!(
            fields[format!("apps[{i}].app_id")]
                .as_str()
                .is_some_and(|m| m.contains("own apps")),
            "{fields}"
        );
    }
    let count: i64 = sqlx::query_scalar("select count(*) from apps where source <> 'first_party'")
        .fetch_one(&ctx.state.db)
        .await
        .expect("count");
    assert_eq!(count, 0, "nothing was written");

    // A new app needs its secret; the whole request rolls back.
    let r = call(&ctx, sync(json!({"apps": [notes_app(), no_secret]}))).await;
    assert_eq!(r.status, 422, "{}", r.json);
    assert!(r.json["error"]["details"]["fields"]["apps[1].secret"].is_string());
    let count: i64 = sqlx::query_scalar("select count(*) from apps where app_id = 'notes-x'")
        .fetch_one(&ctx.state.db)
        .await
        .expect("count");
    assert_eq!(count, 0, "atomic");

    // owner_id and owner_email naming two different accounts.
    let a = ctx
        .carbon_with(accounts_core::test_support::CarbonSpec {
            handle: Some("notes-dev".into()),
            ..Default::default()
        })
        .await;
    let b = ctx
        .carbon_with(accounts_core::test_support::CarbonSpec {
            email: Some("dev@notes-x.example".into()),
            ..Default::default()
        })
        .await;
    let r = call(&ctx, sync(json!({"apps": [notes_app()]}))).await;
    assert_eq!(r.status, 409, "{}", r.json);
    assert_eq!(r.error_code(), Some("owner_email_conflict"));
    assert!(
        r.json["error"]["message"]
            .as_str()
            .is_some_and(|m| m.contains(b.handle.as_deref().unwrap_or("?"))),
        "{}",
        r.json
    );
    // An owner_uuid that isn't an active Carbon.
    let mut by_uuid = notes_app();
    by_uuid["owner_uuid"] = json!("zzzzzz");
    let r = call(&ctx, sync(json!({"apps": [by_uuid]}))).await;
    assert_eq!(r.status, 422, "{}", r.json);
    assert_eq!(r.error_code(), Some("owner_not_found"));
    let mut bad_uuid = notes_app();
    bad_uuid["owner_uuid"] = json!("not a uuid!");
    let r = call(&ctx, sync(json!({"apps": [bad_uuid]}))).await;
    assert!(r.json["error"]["details"]["fields"]["apps[0].owner_uuid"].is_string());
    // The uuid decides (owner_id is only a label then).
    let mut by_uuid = notes_app();
    by_uuid["owner_uuid"] = json!(b.uuid);
    let r = call(&ctx, sync(json!({"apps": [by_uuid]}))).await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(
        r.json["apps"][0]["owner"],
        b.handle.as_deref().unwrap_or("?")
    );
    assert!(
        r.json["apps"][0]["warnings"][0]
            .as_str()
            .is_some_and(|w| w.contains("the uuid decided")),
        "{}",
        r.json
    );
    let owner: Option<String> =
        sqlx::query_scalar("select owner_uuid from apps where app_id = 'notes-x'")
            .fetch_one(&ctx.state.db)
            .await
            .expect("owner");
    assert_eq!(owner.as_deref(), Some(b.uuid.as_str()));
    let _ = a;
}

#[tokio::test]
async fn an_owner_who_changed_their_id_stays_the_owner() {
    use accounts_core::ids::AccountId;
    use accounts_core::repo::accounts;

    let ctx = ctx_with_token().await;
    let first = seed_fake_apps(&ctx).await;
    let saket = first
        .apps
        .iter()
        .find(|a| a.app_id == "briefcase")
        .expect("briefcase")
        .clone();
    assert_eq!(saket.owner.as_deref(), Some("c:saket"));
    let saket_uuid: String =
        sqlx::query_scalar("select uuid from accounts where handle = 'c:saket'")
            .fetch_one(&ctx.state.db)
            .await
            .expect("saket");

    // c:saket renames: the seed file (owner_id c:saket + owner_email) still seeds cleanly, and
    // the verified email keeps the same Carbon as the owner.
    {
        let mut conn = ctx.conn().await;
        accounts::change_id(
            &mut conn,
            &saket_uuid,
            &AccountId::parse("c:saket-renamed").expect("id"),
            &saket_uuid,
        )
        .await
        .expect("rename");
    }
    let again = seed_fake_apps(&ctx).await;
    let b = again
        .apps
        .iter()
        .find(|a| a.app_id == "briefcase")
        .expect("briefcase");
    assert_eq!(b.action, "unchanged", "{again}");
    assert_eq!(b.owner.as_deref(), Some("c:saket-renamed"));
    assert!(
        b.warnings
            .iter()
            .any(|w| w.contains("c:saket doesn't exist")),
        "{again}"
    );

    // 10 days later someone else takes c:saket. A sync naming the owner by c:id alone must not
    // hand them the app.
    ctx.exec("delete from handle_reservations where handle = 'c:saket'")
        .await;
    let squatter = ctx
        .carbon_with(accounts_core::test_support::CarbonSpec {
            handle: Some("saket".into()),
            ..Default::default()
        })
        .await;
    let doc: Value =
        serde_json::from_slice(&std::fs::read(testkit("fake-apps.json")).expect("file"))
            .expect("json");
    let mut briefcase = doc["apps"]
        .as_array()
        .and_then(|a| a.iter().find(|x| x["app_id"] == "briefcase"))
        .cloned()
        .expect("briefcase");
    briefcase.as_object_mut().map(|o| o.remove("owner_email"));
    let r = call(&ctx, sync(json!({"apps": [briefcase.clone()]}))).await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(r.json["apps"][0]["owner"], "c:saket-renamed");
    assert!(
        r.json["apps"][0]["warnings"][0].as_str().is_some_and(|w| w
            .contains("now belongs to another account")
            && w.contains("owner_uuid")),
        "{}",
        r.json
    );
    let owner: Option<String> =
        sqlx::query_scalar("select owner_uuid from apps where app_id = 'briefcase'")
            .fetch_one(&ctx.state.db)
            .await
            .expect("owner");
    assert_eq!(owner.as_deref(), Some(saket_uuid.as_str()));
    let r = call(
        &ctx,
        Req::get("/v1/apps/briefcase")
            .session(&ctx.state.settings, &ctx.browser_session(&squatter).await),
    )
    .await;
    assert_eq!(
        r.status, 403,
        "the new c:saket can't manage the app: {}",
        r.json
    );

    // Silicon Apps moves the app on purpose: by uuid.
    briefcase["owner_uuid"] = json!(squatter.uuid);
    let r = call(&ctx, sync(json!({"apps": [briefcase]}))).await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(r.json["apps"][0]["owner"], "c:saket");
    assert_eq!(r.json["apps"][0]["changed"], json!(["owner"]));
    let owner: Option<String> =
        sqlx::query_scalar("select owner_uuid from apps where app_id = 'briefcase'")
            .fetch_one(&ctx.state.db)
            .await
            .expect("owner");
    assert_eq!(owner.as_deref(), Some(squatter.uuid.as_str()));
}

#[tokio::test]
async fn seeding_the_testkit_fake_apps() {
    let ctx = TestContext::new().await;
    let report = seed_fake_apps(&ctx).await;
    assert_eq!(report.apps.len(), 15);
    assert!(
        report.apps.iter().all(|a| a.action == "created"),
        "{report}"
    );
    let saket = report
        .apps
        .iter()
        .find(|a| a.app_id == "briefcase")
        .expect("briefcase");
    assert_eq!(saket.owner.as_deref(), Some("c:saket"));
    assert!(saket.owner_created);
    assert!(report.to_string().contains("briefcase: created"));

    // Every fixed secret works; BYO secrets are encrypted and masked.
    for app in &report.apps {
        let secret = fake_app_secret(&app.app_id);
        let r = call(
            &ctx,
            Req::get(&format!("/v1/apps/{}", app.app_id)).basic(&app.app_id, &secret),
        )
        .await;
        assert_eq!(r.status, 200, "{}: {}", app.app_id, r.json);
        assert_eq!(r.json["source"], "fake");
    }
    let acme = call(
        &ctx,
        Req::get("/v1/apps/acme-notes").basic("acme-notes", &fake_app_secret("acme-notes")),
    )
    .await;
    assert_eq!(acme.json["signin_config"]["google"]["mode"], "byo");
    assert_eq!(
        acme.json["signin_config"]["google"]["client_secret_set"],
        true
    );
    assert_eq!(acme.json["signin_config"]["branding"]["layout"], "split");
    let orbit = call(
        &ctx,
        Req::get("/v1/apps/orbit-games").basic("orbit-games", &fake_app_secret("orbit-games")),
    )
    .await;
    assert_eq!(
        orbit.json["signin_config"]["apple"]["private_key_set"],
        true
    );
    let configs: Vec<Value> = sqlx::query_scalar("select config from app_signin_configs")
        .fetch_all(&ctx.state.db)
        .await
        .expect("configs");
    assert!(
        configs
            .iter()
            .all(|c| !c.to_string().contains("GOCSPX") && !c.to_string().contains("PRIVATE KEY"))
    );
    let space = call(
        &ctx,
        Req::get("/v1/apps/spacestation").basic("spacestation", &fake_app_secret("spacestation")),
    )
    .await;
    assert_eq!(space.json["webhook"]["url"], Value::Null);
    let doc: Value =
        serde_json::from_slice(&std::fs::read(testkit("fake-apps.json")).expect("file"))
            .expect("json");
    let briefcase_whsec = doc["apps"][0]["webhook_secret"].as_str().expect("whsec");
    let enc: Vec<u8> = sqlx::query_scalar(
        "select webhook_secret_enc from app_signin_configs where app_id = 'briefcase'",
    )
    .fetch_one(&ctx.state.db)
    .await
    .expect("enc");
    assert_eq!(
        ctx.state
            .keys
            .keyring
            .decrypt_string(&enc)
            .expect("decrypt"),
        briefcase_whsec
    );
    let owners: i64 = sqlx::query_scalar(
        "select count(*) from accounts where handle in ('c:saket','c:shubham','c:acme-dev','c:crm-dev','c:quill-dev','c:orbit-dev') and status = 'active'",
    )
    .fetch_one(&ctx.state.db)
    .await
    .expect("owners");
    assert_eq!(owners, 6);

    // A second seed keeps everything (including changes made since); --force re-applies.
    let briefcase_secret = fake_app_secret("briefcase");
    let r = call(
        &ctx,
        Req::patch("/v1/apps/briefcase/signin-config")
            .basic("briefcase", &briefcase_secret)
            .json(json!({"branding": {"radius": 3}})),
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.json);
    let again = seed_fake_apps(&ctx).await;
    assert!(
        again
            .apps
            .iter()
            .all(|a| a.action == "unchanged" && a.config == "kept"),
        "{again}"
    );
    let r = call(
        &ctx,
        Req::get("/v1/apps/briefcase").basic("briefcase", &briefcase_secret),
    )
    .await;
    assert_eq!(r.json["signin_config"]["branding"]["radius"], 3);
    let forced = accounts_apps::seed_fake_apps(&ctx.state, testkit("fake-apps.json"), true)
        .await
        .expect("force");
    let b = forced
        .apps
        .iter()
        .find(|a| a.app_id == "briefcase")
        .expect("briefcase");
    assert_eq!(
        (b.config.as_str(), b.config_version, b.action.as_str()),
        ("reapplied", 3, "updated")
    );
    let d = forced.apps.iter().find(|a| a.app_id == "dm").expect("dm");
    assert_eq!(d.config, "unchanged");
    let r = call(
        &ctx,
        Req::get("/v1/apps/briefcase").basic("briefcase", &briefcase_secret),
    )
    .await;
    assert_eq!(r.json["signin_config"]["branding"]["radius"], 18);
    let h = call(
        &ctx,
        Req::get("/v1/apps/briefcase/signin-config/history").basic("briefcase", &briefcase_secret),
    )
    .await;
    assert_eq!(h.json["items"][0]["actor"], "system");
    assert_eq!(
        h.json["items"][0]["changes"],
        json!([{"path": "branding.radius", "before": 3, "after": 18}])
    );

    // Errors say exactly what is wrong.
    let e = accounts_apps::seed_fake_apps(&ctx.state, testkit("does-not-exist.json"), false)
        .await
        .expect_err("missing");
    assert!(
        e.to_string().contains("could not read the fake apps file"),
        "{e}"
    );
    let bad = std::env::temp_dir().join(format!("bad-fake-apps-{}.json", std::process::id()));
    std::fs::write(
        &bad,
        b"{\"apps\": [{\"app_id\": \"x y\", \"name\": \"X\", \"secret\": \"sa_app_x\"}]}",
    )
    .expect("write");
    let e = accounts_apps::seed_fake_apps(&ctx.state, &bad, false)
        .await
        .expect_err("invalid");
    let text = e.to_string();
    assert!(
        text.contains("apps[0].app_id") && text.contains("apps[0].secret"),
        "{text}"
    );
    let _ = std::fs::remove_file(&bad);
}
