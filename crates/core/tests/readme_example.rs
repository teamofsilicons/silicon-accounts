//! The handler from README.md ("A handler, end to end"), compiled and exercised so the
//! documentation stays true.

use accounts_core::http::{CarbonAuth, ClientMeta, IdempotencyKey, Json};
use accounts_core::ids::AccountId;
use accounts_core::models::Scope;
use accounts_core::repo::{accounts, audit, idempotency};
use accounts_core::test_support::{CarbonSpec, Req, TestContext};
use accounts_core::{ApiError, AppState, events};
use axum::{Router, extract::State, http::StatusCode, response::Response, routing::post};
use serde::{Deserialize, Serialize};

pub fn router() -> Router<AppState> {
    Router::new().route("/v1/me/id", post(change_my_id))
}

#[derive(Deserialize, Serialize)]
struct ChangeId {
    id: String,
}

async fn change_my_id(
    State(state): State<AppState>,
    me: CarbonAuth,
    meta: ClientMeta,
    key: Option<IdempotencyKey>,
    Json(body): Json<ChangeId>,
) -> Result<Response, ApiError> {
    let scope = idempotency::scope(&format!("account:{}", me.uuid()), "POST", "/v1/me/id");
    idempotency::run(&state, key.as_deref(), &scope, &body, false, || async {
        let new_id = AccountId::parse_for_kind(&body.id, me.kind())
            .map_err(|e| accounts::invalid_id_error(&e))?;
        let mut tx = state.db.begin().await?;
        let change = accounts::change_id(&mut tx, me.uuid(), &new_id, me.uuid()).await?;
        if change.changed {
            events::notify_id_changed(&mut tx, &change.account, &change.old_id, &change.new_id)
                .await?;
        }
        audit::record(
            &mut tx,
            &audit::AuditEntry {
                account_uuid: Some(me.uuid()),
                ip: meta.ip.as_deref(),
                ..audit::AuditEntry::new(
                    accounts_core::models::ActorKind::Account,
                    Some(me.uuid()),
                    "account.id.changed",
                )
            },
        )
        .await?;
        tx.commit().await?;
        let view =
            accounts_core::views::load_me(&mut *state.db.acquire().await?, &change.account).await?;
        Ok((StatusCode::OK, serde_json::to_value(view)?))
    })
    .await
}

#[tokio::test]
async fn readme_handler_works() {
    let ctx = TestContext::new().await;
    let me = ctx
        .carbon_with(CarbonSpec {
            handle: Some("first-id".into()),
            ..Default::default()
        })
        .await;
    let (app, _) = ctx.app("member").await;
    ctx.set_app_webhook(&app.app_id, "http://127.0.0.1:8593/m/webhooks")
        .await;
    ctx.membership(&app.app_id, &me.uuid, &[Scope::Profile])
        .await;
    let token = ctx.first_party_tokens(&me).await.access_token;

    let req = || {
        Req::post("/v1/me/id")
            .bearer(&token)
            .header("idempotency-key", "k-1")
            .json(serde_json::json!({"id": "second-id"}))
    };
    let r = ctx.call(router(), req()).await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(r.json["id"], "c:second-id");
    assert_eq!(r.json["emails"].as_array().map(Vec::len), Some(1));
    let replay = ctx.call(router(), req()).await;
    assert_eq!(
        replay
            .headers
            .get("idempotent-replayed")
            .and_then(|v| v.to_str().ok()),
        Some("true")
    );
    assert_eq!(replay.json, r.json);

    let events: i64 =
        sqlx::query_scalar("select count(*) from webhook_events where type = 'account.id_changed'")
            .fetch_one(&ctx.state.db)
            .await
            .expect("count");
    assert_eq!(events, 1, "one event, not two: the retry was replayed");

    let r = ctx
        .call(
            router(),
            Req::post("/v1/me/id")
                .bearer(&token)
                .json(serde_json::json!({"id": "si:nope"})),
        )
        .await;
    assert_eq!(
        (r.status.as_u16(), r.error_code()),
        (422, Some("invalid_id"))
    );
    let other = ctx
        .carbon_with(CarbonSpec {
            handle: Some("taken-id".into()),
            ..Default::default()
        })
        .await;
    let r = ctx
        .call(
            router(),
            Req::post("/v1/me/id")
                .bearer(&token)
                .json(serde_json::json!({"id": "c:taken-id"})),
        )
        .await;
    assert_eq!((r.status.as_u16(), r.error_code()), (409, Some("id_taken")));
    drop(other);
}
