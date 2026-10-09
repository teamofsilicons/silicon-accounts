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
    let app = apps::get(&mut conn, "silicon-accounts")
        .await
        .expect("q")
        .expect("first-party app");
    assert_eq!(app.source, AppSource::FirstParty);
    assert_eq!(app.status, AppStatus::Active);
    let config = apps::effective_config(&mut conn, &ctx.state.settings, "silicon-accounts")
        .await
        .expect("config");
    assert_eq!(
        config.available_methods(&ctx.state.settings),
        vec![Method::Email, Method::Phone]
    );
    assert!(config.redirect_allowed(
        &ctx.state.settings,
        "silicon-accounts",
        "http://localhost:8590/apps"
    ));
    assert!(!config.redirect_allowed(
        &ctx.state.settings,
        "silicon-accounts",
        "https://evil.test/"
    ));
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

#[tokio::test]
async fn silicon_apps_id_migration_preserves_credentials_and_relations() {
    let db = accounts_core::test_support::TestDb::empty().await;
    accounts_core::db::MIGRATOR
        .run_to(9, &db.pool)
        .await
        .unwrap();
    sqlx::raw_sql(r#"
        insert into accounts(uuid,number,kind,handle,status,display_name,pfp_url,dob,timezone)
        values('renameowner',999,'carbon','c:renameowner','active','Owner','https://example.test/me.png','2000-01-01','UTC');
        insert into apps select (jsonb_populate_record(null::apps, to_jsonb(a) ||
          '{"app_id":"apps","name":"Silicon Apps","source":"silicon_apps","owner_uuid":"renameowner"}'::jsonb)).*
          from apps a where app_id='accounts';
        insert into app_signin_configs(app_id,config,version) values('apps','{"branding":{"title":"Preserve"}}',7);
        insert into app_config_history(app_id,version,actor,changes) values('apps',7,'renameowner','[]');
        insert into app_authors(app_id,account_uuid) values('apps','renameowner');
        insert into memberships(app_id,account_uuid,status,source) values('apps','renameowner','active','slt');
        insert into token_families(id,app_id,account_uuid,origin,expires_at) values('00000000-0000-0000-0000-000000000001','apps','renameowner','slt',now()+interval '1 day');
        insert into refresh_tokens(token_hash,family_id,generation) values('fixture'::bytea,'00000000-0000-0000-0000-000000000001',0);
        insert into short_lived_tokens(token_hash,account_uuid,app_id,scopes,expires_at) values('slt'::bytea,'renameowner','apps','{profile}',now()+interval '2 minutes');
        insert into proof_families(id,kind,issuing_app,audiences,access_ttl_seconds,expires_at) values(gen_random_uuid(),'ata','apps','{apps,accounts}',120,now()+interval '1 day');
        insert into account_verification_requests(id,account_uuid,context_app_id,reason) values('00000000-0000-0000-0000-000000000002','renameowner','apps','Keep my request');
        insert into outbound_messages(id,channel,to_address,text_body,purpose,status)
            values('00000000-0000-0000-0000-000000000003','email','saket@teamofsilicons.com','Keep my notification','account_verification','sent');
        insert into account_verification_request_notifications(request_id,recipient,message_id)
            values('00000000-0000-0000-0000-000000000002','saket@teamofsilicons.com','00000000-0000-0000-0000-000000000003');
    "#).execute(&db.pool).await.unwrap();
    let before: serde_json::Value =
        sqlx::query_scalar("select to_jsonb(a)-'app_id' from apps a where app_id='apps'")
            .fetch_one(&db.pool)
            .await
            .unwrap();
    accounts_core::db::migrate(&db.pool).await.unwrap();
    let after: serde_json::Value =
        sqlx::query_scalar("select to_jsonb(a)-'app_id' from apps a where app_id='silicon-apps'")
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_eq!(before, after);
    let (id,version,reason,status):(String,i64,String,String)=sqlx::query_as("select m.membership_id,c.version,r.reason,o.status from memberships m join app_signin_configs c using(app_id) join account_verification_requests r on r.context_app_id=m.app_id cross join outbound_messages o where m.app_id='silicon-apps'").fetch_one(&db.pool).await.unwrap();
    assert_eq!(
        (id.as_str(), version, reason.as_str(), status.as_str()),
        ("silicon-apps:renameowner", 7, "Keep my request", "sent")
    );
    let (family,hash,audiences):(String,Vec<u8>,Vec<String>)=sqlx::query_as("select f.app_id,r.token_hash,p.audiences from token_families f join refresh_tokens r on r.family_id=f.id cross join proof_families p").fetch_one(&db.pool).await.unwrap();
    assert_eq!(family, "silicon-apps");
    assert_eq!(hash, b"fixture");
    assert_eq!(audiences, vec!["silicon-apps", "silicon-accounts"]);
    assert!(
        accounts_core::db::migrate(&db.pool)
            .await
            .unwrap()
            .applied_now
            .is_empty()
    );
}

#[tokio::test]
async fn silicon_apps_id_collision_aborts_without_touching_either_app() {
    let db = accounts_core::test_support::TestDb::empty().await;
    accounts_core::db::MIGRATOR
        .run_to(9, &db.pool)
        .await
        .unwrap();
    sqlx::raw_sql("insert into apps(app_id,name,source,secret_hash) values('apps','Silicon Apps','silicon_apps','old'::bytea),('silicon-apps','Someone else','silicon_apps','other'::bytea)").execute(&db.pool).await.unwrap();
    assert!(accounts_core::db::migrate(&db.pool).await.is_err());
    let count: i64 =
        sqlx::query_scalar("select count(*) from apps where app_id in ('apps','silicon-apps')")
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_eq!(count, 2);
}

#[tokio::test]
async fn accounts_rename_preserves_credentials_sessions_and_token_boundaries() {
    use accounts_core::models::Scope;
    use accounts_core::repo::tokens;
    use accounts_core::test_support::{TestDb, test_state};
    let db = TestDb::empty().await;
    accounts_core::db::MIGRATOR
        .run_to(11, &db.pool)
        .await
        .unwrap();
    let ctx = TestContext {
        state: test_state(db.pool.clone()),
        db,
    };
    let carbon = ctx.carbon().await;
    let session = ctx.browser_session(&carbon).await;
    let old = ctx.tokens_for(&carbon, "accounts", &[Scope::Profile]).await;
    let before: serde_json::Value =
        sqlx::query_scalar("select to_jsonb(a)-'app_id' from apps a where app_id='accounts'")
            .fetch_one(&ctx.db.pool)
            .await
            .unwrap();
    let config: serde_json::Value = sqlx::query_scalar(
        "select to_jsonb(c)-'app_id' from app_signin_configs c where app_id='accounts'",
    )
    .fetch_one(&ctx.db.pool)
    .await
    .unwrap();
    accounts_core::db::migrate(&ctx.db.pool).await.unwrap();
    let after: serde_json::Value = sqlx::query_scalar(
        "select to_jsonb(a)-'app_id' from apps a where app_id='silicon-accounts'",
    )
    .fetch_one(&ctx.db.pool)
    .await
    .unwrap();
    let after_config: serde_json::Value = sqlx::query_scalar(
        "select to_jsonb(c)-'app_id' from app_signin_configs c where app_id='silicon-accounts'",
    )
    .fetch_one(&ctx.db.pool)
    .await
    .unwrap();
    assert_eq!(before, after);
    assert_eq!(config, after_config);
    assert!(
        apps::get(&mut *ctx.conn().await, "accounts")
            .await
            .unwrap()
            .is_none()
    );
    let verified = tokens::verify_access_token(
        &mut *ctx.conn().await,
        &ctx.state.keys,
        &old.access_token,
        Some("silicon-accounts"),
    )
    .await
    .unwrap();
    assert_eq!(verified.claims.aud, "silicon-accounts");
    assert_eq!(verified.account.uuid, carbon.uuid);
    assert_eq!(
        verified.claims.mid,
        format!("silicon-accounts:{}", carbon.uuid)
    );
    assert!(
        tokens::verify_access_token(
            &mut *ctx.conn().await,
            &ctx.state.keys,
            &old.access_token,
            Some("developer")
        )
        .await
        .is_err()
    );
    assert_eq!(
        ctx.state
            .keys
            .jwt
            .verify_access_ignoring_expiry(&old.access_token)
            .unwrap()
            .aud,
        "silicon-accounts"
    );
    let new = tokens::refresh(
        &ctx.state.db,
        &ctx.state.keys,
        &ctx.state.settings,
        &old.refresh_token,
        "silicon-accounts",
    )
    .await
    .unwrap();
    assert_eq!(new.refresh_token_expires_at, old.refresh_token_expires_at);
    assert_ne!(new.refresh_token, old.refresh_token);
    assert_eq!(
        ctx.state
            .keys
            .jwt
            .verify_access(&new.access_token, Some("silicon-accounts"))
            .unwrap()
            .aud,
        "silicon-accounts"
    );
    assert!(
        tokens::refresh(
            &ctx.state.db,
            &ctx.state.keys,
            &ctx.state.settings,
            &old.refresh_token,
            "silicon-accounts"
        )
        .await
        .is_err()
    );
    assert!(
        tokens::verify_access_token(
            &mut *ctx.conn().await,
            &ctx.state.keys,
            &old.access_token,
            None
        )
        .await
        .is_err()
    );
    let session_count: i64 = sqlx::query_scalar(
        "select count(*) from browser_sessions where account_uuid=$1 and token_hash=$2",
    )
    .bind(&carbon.uuid)
    .bind(ctx.state.keys.pepper.hash(&session))
    .fetch_one(&ctx.db.pool)
    .await
    .unwrap();
    assert_eq!(session_count, 1);
}

#[tokio::test]
async fn accounts_rename_refuses_to_merge_an_existing_app() {
    let db = accounts_core::test_support::TestDb::empty().await;
    accounts_core::db::MIGRATOR
        .run_to(11, &db.pool)
        .await
        .unwrap();
    sqlx::raw_sql("insert into apps(app_id,name,source,secret_hash) values('silicon-accounts','Someone else','silicon_apps','other'::bytea)").execute(&db.pool).await.unwrap();
    assert!(accounts_core::db::migrate(&db.pool).await.is_err());
    let count: i64 = sqlx::query_scalar(
        "select count(*) from apps where app_id in ('accounts','silicon-accounts')",
    )
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(count, 2);
}

#[tokio::test]
async fn migration_0019_cuts_stored_custodian_changes_to_uuid_and_id_for_apps() {
    let db = accounts_core::test_support::TestDb::empty().await;
    accounts_core::db::MIGRATOR
        .run_to(18, &db.pool)
        .await
        .expect("migrate to 0018");
    let summary = |uuid: &str, id: &str, name: &str| {
        serde_json::json!({
            "uuid": uuid, "kind": "carbon", "id": id, "display_name": name,
            "pfp_url": format!("https://iris.example/pfp/{uuid}"), "status": "active",
        })
    };
    let payload = |kind: &str, app: Option<&str>| {
        serde_json::json!({
            "event_id": "01a11436-d5e4-7794-842d-4efffcc475b0",
            "type": kind,
            "occurred_at": "2026-10-07T02:35:00.452Z",
            "app_id": app,
            "silicon": if app.is_some() { None } else { Some("K1E") },
            "data": {
                "uuid": "K1E", "membership_id": "briefcase:K1E",
                "from": summary("zQo", "c:saket", "Saket"),
                "to": summary("8HV", "c:ada", "Ada Lovelace"),
            },
        })
    };
    let insert = |id: &'static str,
                  kind: &'static str,
                  target_kind: &'static str,
                  target: &'static str,
                  body: serde_json::Value| {
        let pool = db.pool.clone();
        async move {
            sqlx::query(
                "insert into webhook_events (event_id, type, target_kind, target_id, account_uuid, payload) \
                 values ($1::uuid, $2, $3, $4, 'K1E', $5)",
            )
            .bind(id)
            .bind(kind)
            .bind(target_kind)
            .bind(target)
            .bind(body)
            .execute(&pool)
            .await
            .expect("event");
        }
    };
    let app_event = "01a11436-d5e4-7794-842d-4efffcc475b0";
    let own_event = "01a11436-d5e4-7794-842d-4efffcc475b1";
    insert(
        app_event,
        "silicon.custodian_changed",
        "app",
        "briefcase",
        payload("silicon.custodian_changed", Some("briefcase")),
    )
    .await;
    insert(
        own_event,
        "silicon.custodian.changed",
        "silicon",
        "K1E",
        payload("silicon.custodian.changed", None),
    )
    .await;
    accounts_core::db::migrate(&db.pool)
        .await
        .expect("apply the rest");

    let stored = |id: &'static str| {
        let pool = db.pool.clone();
        async move {
            sqlx::query_scalar::<_, serde_json::Value>(
                "select payload from webhook_events where event_id = $1::uuid",
            )
            .bind(id)
            .fetch_one(&pool)
            .await
            .expect("payload")
        }
    };
    let app = stored(app_event).await;
    assert_eq!(
        app["data"]["from"],
        serde_json::json!({"uuid": "zQo", "id": "c:saket"})
    );
    assert_eq!(
        app["data"]["to"],
        serde_json::json!({"uuid": "8HV", "id": "c:ada"})
    );
    assert_eq!(app["data"]["membership_id"], "briefcase:K1E");
    assert_eq!(app["event_id"], app_event);
    // The Silicon's own event keeps the summaries.
    assert_eq!(
        stored(own_event).await,
        payload("silicon.custodian.changed", None)
    );

    // A row written after the migration with the full summaries (an API task still running the
    // code from before it, during a release) is cut down as it is stored; the Silicon's own
    // event isn't touched.
    let late_app_event = "01a11436-d5e4-7794-842d-4efffcc475b2";
    let late_own_event = "01a11436-d5e4-7794-842d-4efffcc475b3";
    insert(
        late_app_event,
        "silicon.custodian_changed",
        "app",
        "remind",
        payload("silicon.custodian_changed", Some("remind")),
    )
    .await;
    insert(
        late_own_event,
        "silicon.custodian.changed",
        "silicon",
        "K1E",
        payload("silicon.custodian.changed", None),
    )
    .await;
    let late = stored(late_app_event).await;
    assert_eq!(
        late["data"]["from"],
        serde_json::json!({"uuid": "zQo", "id": "c:saket"})
    );
    assert_eq!(
        late["data"]["to"],
        serde_json::json!({"uuid": "8HV", "id": "c:ada"})
    );
    assert_eq!(late["app_id"], "remind");
    assert_eq!(
        stored(late_own_event).await,
        payload("silicon.custodian.changed", None)
    );
    // An update that puts a summary back is cut too.
    sqlx::query("update webhook_events set payload = $2 where event_id = $1::uuid")
        .bind(late_app_event)
        .bind(payload("silicon.custodian_changed", Some("remind")))
        .execute(&db.pool)
        .await
        .expect("update");
    assert_eq!(
        stored(late_app_event).await["data"]["to"],
        serde_json::json!({"uuid": "8HV", "id": "c:ada"})
    );
}
