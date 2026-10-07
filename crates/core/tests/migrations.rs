//! Migrations: idempotent, reported, and they create the first-party app.

use accounts_core::models::{AppSource, AppStatus, Method};
use accounts_core::repo::apps;
use accounts_core::test_support::TestContext;

#[tokio::test]
async fn migrations_are_idempotent_and_seed_the_first_party_app() {
    let ctx = TestContext::new().await;
    let again = accounts_core::db::migrate(&ctx.state.db)
        .await
        .expect("re-run");
    assert!(again.applied_now.is_empty(), "nothing new to apply");
    assert!(
        again
            .already_applied
            .iter()
            .any(|m| m.version == 1 && m.description == "init")
    );

    let mut conn = ctx.conn().await;
    let app = apps::get(&mut conn, "accounts")
        .await
        .expect("q")
        .expect("first-party app");
    assert_eq!(app.source, AppSource::FirstParty);
    assert_eq!(app.status, AppStatus::Active);
    let config = apps::effective_config(&mut conn, &ctx.state.settings, "accounts")
        .await
        .expect("config");
    assert_eq!(
        config.available_methods(&ctx.state.settings),
        vec![Method::Email, Method::Phone]
    );
    assert!(config.redirect_allowed(
        &ctx.state.settings,
        "accounts",
        "http://localhost:8590/apps"
    ));
    assert!(!config.redirect_allowed(&ctx.state.settings, "accounts", "https://evil.test/"));
    accounts_core::db::ping(&ctx.state.db).await.expect("ping");
}

/// Inserts an app (fake source) whose stored sign-in config has this dark palette pair.
async fn app_with_dark(pool: &sqlx::PgPool, app_id: &str, primary: &str, foreground: Option<&str>) {
    sqlx::query(
        "insert into apps (app_id, name, secret_hash, source) values ($1, $1, '\\x00'::bytea, 'fake')",
    )
    .bind(app_id)
    .execute(pool)
    .await
    .expect("app");
    let mut dark = serde_json::json!({"primary": primary});
    if let Some(fg) = foreground {
        dark["primary_foreground"] = serde_json::json!(fg);
    }
    sqlx::query(
        "insert into app_signin_configs (app_id, version, config) values ($1, 4, jsonb_build_object('branding', jsonb_build_object('dark', $2::jsonb)))",
    )
    .bind(app_id)
    .bind(dark)
    .execute(pool)
    .await
    .expect("config");
}

#[tokio::test]
async fn migration_0003_moves_configs_off_the_old_default_dark_palette() {
    let db = accounts_core::test_support::TestDb::empty().await;
    accounts_core::db::MIGRATOR
        .run_to(2, &db.pool)
        .await
        .expect("migrate to 0002");
    // The old default pair (as every PATCH-saved config stored it), the same pair written in
    // lower case without a foreground, and two deliberate choices.
    app_with_dark(&db.pool, "old-default", "#5B8FE0", Some("#FFFDF9")).await;
    app_with_dark(&db.pool, "old-partial", "#5b8fe0", None).await;
    app_with_dark(&db.pool, "own-ink", "#5B8FE0", Some("#0B0B0B")).await;
    app_with_dark(&db.pool, "own-colour", "#E8B04B", Some("#1A1410")).await;
    accounts_core::db::migrate(&db.pool)
        .await
        .expect("apply the rest");

    let row = |app_id: &'static str| {
        let pool = db.pool.clone();
        async move {
            sqlx::query_as::<_, (i64, String, String)>(
                "select version, config #>> '{branding,dark,primary}', updated_by from app_signin_configs where app_id = $1",
            )
            .bind(app_id)
            .fetch_one(&pool)
            .await
            .expect("config row")
        }
    };
    for app_id in ["old-default", "old-partial"] {
        let (version, primary, by) = row(app_id).await;
        assert_eq!(
            (version, primary.as_str(), by.as_str()),
            (5, "#1F5FB8", "system"),
            "{app_id}"
        );
        let (actor, changes): (String, serde_json::Value) = sqlx::query_as(
            "select actor, changes from app_config_history where app_id = $1 and version = 5",
        )
        .bind(app_id)
        .fetch_one(&db.pool)
        .await
        .expect("history entry");
        assert_eq!(actor, "system");
        assert_eq!(
            changes,
            serde_json::json!([{"path": "branding.dark.primary", "before": "#5B8FE0", "after": "#1F5FB8"}])
        );
        let audited: i64 = sqlx::query_scalar(
            "select count(*) from audit_log where app_id = $1 and action = 'app.signin_config.updated' and actor_kind = 'system'",
        )
        .bind(app_id)
        .fetch_one(&db.pool)
        .await
        .expect("audit");
        assert_eq!(audited, 1);
    }
    for (app_id, primary) in [("own-ink", "#5B8FE0"), ("own-colour", "#E8B04B")] {
        assert_eq!(
            row(app_id).await,
            (4, primary.to_string(), "system".to_string())
        );
    }

    // Sign-up photos: a photo belongs to exactly one account or one sign-up session.
    let orphan = sqlx::query(
        "insert into photos (id, content_type, bytes) values (gen_random_uuid(), 'image/png', '\\x00'::bytea)",
    )
    .execute(&db.pool)
    .await;
    assert!(orphan.is_err(), "a photo without an owner is refused");
}

/// Inserts an app (fake source) whose stored sign-in config has this dark palette.
async fn app_with_dark_palette(pool: &sqlx::PgPool, app_id: &str, dark: serde_json::Value) {
    sqlx::query(
        "insert into apps (app_id, name, secret_hash, source) values ($1, $1, '\\x00'::bytea, 'fake')",
    )
    .bind(app_id)
    .execute(pool)
    .await
    .expect("app");
    sqlx::query(
        "insert into app_signin_configs (app_id, version, config) values ($1, 7, jsonb_build_object('branding', jsonb_build_object('dark', $2::jsonb)))",
    )
    .bind(app_id)
    .bind(dark)
    .execute(pool)
    .await
    .expect("config");
}

#[tokio::test]
async fn migration_0004_moves_the_old_dark_error_colour_off_the_default_card() {
    let db = accounts_core::test_support::TestDb::empty().await;
    accounts_core::db::MIGRATOR
        .run_to(3, &db.pool)
        .await
        .expect("migrate to 0003");
    // The old default (as a PATCH-saved config stores the whole palette), the same colour in lower
    // case on a config that leaves the surface to the default, and two deliberate choices.
    app_with_dark_palette(
        &db.pool,
        "old-danger",
        serde_json::json!({"surface": "#353432", "danger": "#F97066"}),
    )
    .await;
    app_with_dark_palette(
        &db.pool,
        "old-danger-partial",
        serde_json::json!({"danger": "#f97066"}),
    )
    .await;
    app_with_dark_palette(
        &db.pool,
        "own-surface",
        serde_json::json!({"surface": "#211D18", "danger": "#F97066"}),
    )
    .await;
    app_with_dark_palette(
        &db.pool,
        "own-danger",
        serde_json::json!({"surface": "#353432", "danger": "#FF6B6B"}),
    )
    .await;
    accounts_core::db::migrate(&db.pool)
        .await
        .expect("apply the rest");

    let row = |app_id: &'static str| {
        let pool = db.pool.clone();
        async move {
            sqlx::query_as::<_, (i64, String)>(
                "select version, config #>> '{branding,dark,danger}' from app_signin_configs where app_id = $1",
            )
            .bind(app_id)
            .fetch_one(&pool)
            .await
            .expect("config row")
        }
    };
    for app_id in ["old-danger", "old-danger-partial"] {
        assert_eq!(row(app_id).await, (8, "#FF8A80".to_string()), "{app_id}");
        let (actor, changes): (String, serde_json::Value) = sqlx::query_as(
            "select actor, changes from app_config_history where app_id = $1 and version = 8",
        )
        .bind(app_id)
        .fetch_one(&db.pool)
        .await
        .expect("history entry");
        assert_eq!(actor, "system");
        assert_eq!(
            changes,
            serde_json::json!([{"path": "branding.dark.danger", "before": "#F97066", "after": "#FF8A80"}])
        );
        let audited: i64 = sqlx::query_scalar(
            "select count(*) from audit_log where app_id = $1 and action = 'app.signin_config.updated' and actor_kind = 'system'",
        )
        .bind(app_id)
        .fetch_one(&db.pool)
        .await
        .expect("audit");
        assert_eq!(audited, 1);
    }
    assert_eq!(row("own-surface").await, (7, "#F97066".to_string()));
    assert_eq!(row("own-danger").await, (7, "#FF6B6B".to_string()));
}
