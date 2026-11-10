use accounts_core::{
    AppState, events,
    models::AccountField,
    test_support::{Req, TestContext},
};
use accounts_worker::tings;
use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, StatusCode},
    routing::post,
};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

#[derive(Clone)]
struct Receiver {
    state: AppState,
    bodies: Arc<Mutex<Vec<Value>>>,
    fail: Arc<Mutex<Option<&'static str>>>,
}
async fn receive(
    State(rx): State<Receiver>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> (StatusCode, Json<Value>) {
    let token = headers["authorization"]
        .to_str()
        .unwrap()
        .strip_prefix("Bearer ")
        .unwrap();
    let verified = accounts_proofs::store::verify_lookup(
        &rx.state.db,
        &rx.state.keys.pepper.hash(token),
        "ting",
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(verified.invalid_reason(), None);
    assert_eq!(verified.issuing_app_id, "silicon-accounts");
    let scope = if body.get("schema").is_some() {
        "types.manage"
    } else if body.get("app_id").is_some() {
        "subscriptions.register"
    } else {
        "tings.send"
    };
    assert_eq!(verified.scopes, vec![scope]);
    if scope == "subscriptions.register" {
        assert_eq!(verified.account_uuid.as_deref(), body["for"].as_str());
    }
    rx.bodies.lock().unwrap().push(body.clone());
    if let Some(code) = rx.fail.lock().unwrap().take() {
        return (StatusCode::CONFLICT, Json(json!({"error":{"code":code}})));
    }
    (
        StatusCode::OK,
        Json(
            json!({"id":"msg_test","status":"accepted","key":body["key"],"active":true,"app_id":body["app_id"],"for":body["for"]}),
        ),
    )
}
async fn fixture() -> (TestContext, Receiver, tokio::task::JoinHandle<()>) {
    let mut ctx = TestContext::new().await;
    sqlx::query(
        "insert into apps(app_id,name,status,source,secret_hash) values('ting','Ting','active','fake',decode('00','hex'))",
    )
    .execute(&ctx.state.db)
    .await
    .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    Arc::make_mut(&mut ctx.state.settings).ting_url =
        format!("http://{}", listener.local_addr().unwrap());
    let rx = Receiver {
        state: ctx.state.clone(),
        bodies: Arc::default(),
        fail: Arc::default(),
    };
    let router = Router::new()
        .route("/v1/tings", post(receive))
        .route("/v1/subscriptions", post(receive))
        .route("/v1/apps/silicon-accounts/types", post(receive))
        .with_state(rx.clone());
    let handle = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    (ctx, rx, handle)
}
async fn status(ctx: &TestContext, id: uuid::Uuid) -> String {
    sqlx::query_scalar("select status from silicon_tings where id=$1")
        .bind(id)
        .fetch_one(&ctx.state.db)
        .await
        .unwrap()
}

#[tokio::test]
async fn account_delivery_is_transactional_scoped_and_retries_exact_bytes() {
    let (ctx, rx, server) = fixture().await;
    let carbon = ctx.carbon().await;
    let (silicon, _) = ctx.silicon(&carbon.uuid).await;
    tings::ensure_catalog(&ctx.state).await.unwrap();
    assert_eq!(rx.bodies.lock().unwrap().len(), 12);
    assert!(
        rx.bodies
            .lock()
            .unwrap()
            .iter()
            .all(|v| v["type"].as_str().unwrap().matches('.').count() == 1)
    );
    let mut tx = ctx.state.db.begin().await.unwrap();
    events::notify_profile_updated(&mut tx, &silicon, &[AccountField::DisplayName])
        .await
        .unwrap();
    tx.rollback().await.unwrap();
    assert!(tings::claim(&ctx.state, 10).await.unwrap().is_empty());
    let mut tx = ctx.state.db.begin().await.unwrap();
    events::notify_profile_updated(&mut tx, &silicon, &[AccountField::DisplayName])
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let old: i64 =
        sqlx::query_scalar("select count(*) from webhook_deliveries where target_kind='silicon'")
            .fetch_one(&ctx.state.db)
            .await
            .unwrap();
    assert_eq!(old, 0);
    let row = tings::claim(&ctx.state, 1).await.unwrap().remove(0);
    assert_eq!(row.payload["for"], silicon.uuid);
    assert!(row.payload.get("session_id").is_none());
    assert!(
        tings::claim(&ctx.state, 10).await.unwrap().is_empty(),
        "claims are exclusive"
    );
    *rx.fail.lock().unwrap() = Some("recipient_not_registered");
    tings::deliver(&ctx.state, &row).await.unwrap();
    assert_eq!(status(&ctx, row.id).await, "pending");
    sqlx::query("update silicon_tings set next_attempt_at=now() where id=$1")
        .bind(row.id)
        .execute(&ctx.state.db)
        .await
        .unwrap();
    let retry = tings::claim(&ctx.state, 1).await.unwrap().remove(0);
    assert_eq!(retry.payload, row.payload);
    tings::deliver(&ctx.state, &retry).await.unwrap();
    assert_eq!(status(&ctx, row.id).await, "accepted");
    let bodies = rx.bodies.lock().unwrap();
    assert_eq!(bodies[bodies.len() - 1], bodies[bodies.len() - 2]);
    drop(bodies);
    server.abort();
}

#[tokio::test]
async fn request_hints_are_minimal_rebinding_needs_its_token_and_dead_sessions_never_broadcast() {
    let (ctx, rx, server) = fixture().await;
    let carbon = ctx.carbon().await;
    let first = "recv_11111111111111111111111111111111";
    let second = "recv_22222222222222222222222222222222";
    let created=ctx.call(accounts_silicons::router(),Req::post("/v1/silicons").json(json!({"id":"si:ting-test","display_name":"Private name","custodian":carbon.handle,"ting_session_id":first}))).await;
    assert_eq!(created.status, 201, "{}", created.json);
    let id = created.json["request"]["id"].as_str().unwrap();
    let token = created.json["request_token"].as_str().unwrap();
    let path = format!("/v1/silicons/requests/{id}/ting-session");
    let old = tings::claim(&ctx.state, 10).await.unwrap();
    assert_eq!(old.len(), 1, "pending identity is not sent as an account");
    assert_eq!(old[0].payload["data"], json!({"request_id":id}));
    assert!(old[0].payload.get("for").is_none());
    let denied = ctx
        .call(
            accounts_silicons::router(),
            Req::put(&path)
                .bearer("sarq_wrong")
                .json(json!({"session_id":second})),
        )
        .await;
    assert_eq!(denied.status, 404);
    let rebound = ctx
        .call(
            accounts_silicons::router(),
            Req::put(&path)
                .bearer(token)
                .json(json!({"session_id":second})),
        )
        .await;
    assert_eq!(rebound.status, 200, "{}", rebound.json);
    let before = rx.bodies.lock().unwrap().len();
    tings::deliver(&ctx.state, &old[0]).await.unwrap();
    assert_eq!(
        rx.bodies.lock().unwrap().len(),
        before,
        "old in-flight claim cannot send after rebind"
    );
    let latest = tings::claim(&ctx.state, 10).await.unwrap();
    assert_eq!(latest.len(), 1);
    assert_eq!(latest[0].payload["session_id"], second);
    *rx.fail.lock().unwrap() = Some("session_gone");
    tings::deliver(&ctx.state, &latest[0]).await.unwrap();
    assert_eq!(status(&ctx, latest[0].id).await, "cancelled");
    assert!(tings::claim(&ctx.state, 10).await.unwrap().is_empty());
    let again = ctx
        .call(
            accounts_silicons::router(),
            Req::put(&path)
                .bearer(token)
                .json(json!({"session_id":second})),
        )
        .await;
    assert_eq!(again.status, 200);
    let n: i64 = sqlx::query_scalar("select count(*) from silicon_tings where session_id=$1")
        .bind(second)
        .fetch_one(&ctx.state.db)
        .await
        .unwrap();
    assert_eq!(n, 1, "same binding retry doesn't duplicate hints");
    let custodian = ctx.first_party_tokens(&carbon).await;
    let accepted = ctx
        .call(
            accounts_silicons::router(),
            Req::post(&format!("/v1/me/custodian-requests/{id}/accept"))
                .bearer(&custodian.access_token),
        )
        .await;
    assert_eq!(accepted.status, 204, "{}", accepted.json);
    let rows = tings::claim(&ctx.state, 10).await.unwrap();
    assert!(rows.iter().any(|r| r.session_id.is_none()));
    assert!(rows.iter().any(|r| r.session_id.as_deref() == Some(second)));
    server.abort();
}

#[tokio::test]
async fn explicit_enrollment_uses_the_silicons_live_first_party_grant_without_a_membership() {
    let (ctx, rx, server) = fixture().await;
    let carbon = ctx.carbon().await;
    let (silicon, _) = ctx.silicon(&carbon.uuid).await;
    let tokens = ctx.first_party_tokens(&silicon).await;
    let memberships: i64 = sqlx::query_scalar(
        "select count(*) from memberships where account_uuid=$1 and app_id='silicon-accounts'",
    )
    .bind(&silicon.uuid)
    .fetch_one(&ctx.state.db)
    .await
    .unwrap();
    assert_eq!(memberships, 0);
    let enabled = ctx
        .call(
            accounts_silicons::router(),
            Req::post("/v1/me/notifications/ting").bearer(&tokens.access_token),
        )
        .await;
    assert_eq!(enabled.status, 200, "{}", enabled.json);
    assert_eq!(
        rx.bodies.lock().unwrap().last().unwrap(),
        &json!({"app_id":"silicon-accounts","for":silicon.uuid})
    );
    sqlx::query("update token_families set revoked_at=now() where account_uuid=$1")
        .bind(&silicon.uuid)
        .execute(&ctx.state.db)
        .await
        .unwrap();
    let family: uuid::Uuid = sqlx::query_scalar(
        "select id from proof_families where kind='user_verification' and account_uuid=$1",
    )
    .bind(&silicon.uuid)
    .fetch_one(&ctx.state.db)
    .await
    .unwrap();
    let hash: Vec<u8> = sqlx::query_scalar(
        "select token_hash from proof_tokens where family_id=$1 and kind='access'",
    )
    .bind(family)
    .fetch_one(&ctx.state.db)
    .await
    .unwrap();
    let check = accounts_proofs::store::verify_lookup(&ctx.state.db, &hash, "ting")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(check.invalid_reason(), Some("grant_ended"));
    let denied = ctx
        .call(
            accounts_silicons::router(),
            Req::post("/v1/me/notifications/ting").bearer(&tokens.access_token),
        )
        .await;
    assert_eq!(denied.status, 401);
    assert_eq!(rx.bodies.lock().unwrap().len(), 1);
    for path in ["/v1/me/webhook", "/v1/me/webhook/deliveries"] {
        let r = ctx.call(accounts_silicons::router(), Req::get(path)).await;
        if path.ends_with("deliveries") {
            assert_eq!(r.status, 410)
        }
    }
    server.abort();
}

#[tokio::test]
async fn migration_transfers_only_pending_silicon_callbacks_and_preserves_apps() {
    let (ctx, _, server) = fixture().await;
    let carbon = ctx.carbon().await;
    let (silicon, _) = ctx.silicon(&carbon.uuid).await;
    let (app, _) = ctx.app("migration").await;
    ctx.set_app_webhook(&app.app_id, "http://127.0.0.1:8593/app")
        .await;
    let mut conn = ctx.conn().await;
    let app_event = events::ping_app(&mut conn, &app.app_id)
        .await
        .unwrap()
        .unwrap();
    for status in ["pending", "delivered"] {
        events::notify_profile_updated(&mut conn, &silicon, &[AccountField::DisplayName])
            .await
            .unwrap();
        let event: uuid::Uuid = sqlx::query_scalar("select event_id from silicon_tings where account_uuid=$1 order by created_at desc,id desc limit 1")
            .bind(&silicon.uuid).fetch_one(&mut *conn).await.unwrap();
        sqlx::query("insert into webhook_deliveries(id,event_id,target_kind,target_id,url,status) values($1,$2,'silicon',$3,'http://127.0.0.1:8593/legacy',$4)")
            .bind(uuid::Uuid::new_v4()).bind(event).bind(&silicon.uuid).bind(status).execute(&mut *conn).await.unwrap();
    }
    sqlx::query("update accounts set webhook_url='http://127.0.0.1:8593/legacy',webhook_secret_enc=decode('00','hex') where uuid=$1")
        .bind(&silicon.uuid).execute(&mut *conn).await.unwrap();
    // Recreate the pre-migration state in this isolated test database.
    sqlx::raw_sql("drop table silicon_tings; drop table silicon_ting_requests;")
        .execute(&mut *conn)
        .await
        .unwrap();
    sqlx::raw_sql(include_str!("../../../migrations/0036_silicon_tings.sql"))
        .execute(&mut *conn)
        .await
        .unwrap();
    let migrated: Vec<Value> = sqlx::query_scalar("select payload from silicon_tings")
        .fetch_all(&mut *conn)
        .await
        .unwrap();
    assert_eq!(
        migrated.len(),
        1,
        "already delivered callbacks aren't resent"
    );
    let payload = &migrated[0];
    assert_eq!(payload["type"], "silicon-accounts.siliconUpdated");
    assert_eq!(payload["for"], silicon.uuid);
    assert_eq!(
        payload["key"],
        format!("accounts:{}", payload["data"]["event_id"].as_str().unwrap())
    );
    let old_pending: i64 = sqlx::query_scalar(
        "select count(*) from webhook_deliveries where target_kind='silicon' and status='pending'",
    )
    .fetch_one(&mut *conn)
    .await
    .unwrap();
    assert_eq!(old_pending, 0);
    let cleared: bool = sqlx::query_scalar(
        "select webhook_url is null and webhook_secret_enc is null from accounts where uuid=$1",
    )
    .bind(&silicon.uuid)
    .fetch_one(&mut *conn)
    .await
    .unwrap();
    assert!(cleared);
    let app_status: String =
        sqlx::query_scalar("select status from webhook_deliveries where id=$1")
            .bind(app_event.delivery_id)
            .fetch_one(&mut *conn)
            .await
            .unwrap();
    assert_eq!(app_status, "pending");
    server.abort();
}

#[tokio::test]
async fn uncertain_attempts_expire_before_deduplication_keys_and_deleted_accounts_never_send() {
    let (ctx, rx, server) = fixture().await;
    let carbon = ctx.carbon().await;
    let (silicon, _) = ctx.silicon(&carbon.uuid).await;
    events::notify_profile_updated(
        &mut *ctx.conn().await,
        &silicon,
        &[AccountField::DisplayName],
    )
    .await
    .unwrap();
    let first = tings::claim(&ctx.state, 1).await.unwrap().remove(0);
    // A lease expires after an uncertain send. A second worker owns the retry.
    sqlx::query("update silicon_tings set lease_until=now()-interval '1 second',retry_deadline=now()+interval '1 day' where id=$1")
        .bind(first.id).execute(&ctx.state.db).await.unwrap();
    let second = tings::claim(&ctx.state, 1).await.unwrap().remove(0);
    tings::deliver(&ctx.state, &first).await.unwrap();
    assert!(rx.bodies.lock().unwrap().is_empty(), "old lease is fenced");
    *rx.fail.lock().unwrap() = Some("recipient_not_registered");
    tings::deliver(&ctx.state, &second).await.unwrap();
    let still_bounded: bool =
        sqlx::query_scalar("select retry_deadline is not null from silicon_tings where id=$1")
            .bind(first.id)
            .fetch_one(&ctx.state.db)
            .await
            .unwrap();
    assert!(
        still_bounded,
        "a later rejection cannot erase an earlier uncertain attempt"
    );
    sqlx::query("update silicon_tings set retry_deadline=now()-interval '1 second' where id=$1")
        .bind(first.id)
        .execute(&ctx.state.db)
        .await
        .unwrap();
    assert!(tings::claim(&ctx.state, 1).await.unwrap().is_empty());
    assert_eq!(status(&ctx, first.id).await, "failed");
    events::notify_profile_updated(
        &mut *ctx.conn().await,
        &silicon,
        &[AccountField::DisplayName],
    )
    .await
    .unwrap();
    let doomed = tings::claim(&ctx.state, 1).await.unwrap().remove(0);
    sqlx::query("update accounts set status='deleted' where uuid=$1")
        .bind(&silicon.uuid)
        .execute(&ctx.state.db)
        .await
        .unwrap();
    let before = rx.bodies.lock().unwrap().len();
    tings::deliver(&ctx.state, &doomed).await.unwrap();
    assert_eq!(rx.bodies.lock().unwrap().len(), before);
    sqlx::query("update silicon_tings set lease_until=now()-interval '1 second' where id=$1")
        .bind(doomed.id)
        .execute(&ctx.state.db)
        .await
        .unwrap();
    assert!(tings::claim(&ctx.state, 1).await.unwrap().is_empty());
    assert_eq!(status(&ctx, doomed.id).await, "cancelled");
    server.abort();
}
