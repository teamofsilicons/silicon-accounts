//! Durable Silicon account notifications. Ting owns recipients, live sessions and delivery.
use crate::{ApiError, ApiResult};
use serde_json::{Value, json};
use sqlx::PgConnection;
use uuid::Uuid;

pub const APP: &str = "silicon-accounts";
pub const TYPES: &[(&str, &str, &str)] = &[
    (
        "silicon.created",
        "siliconCreated",
        "Your Silicon account was created.",
    ),
    (
        "silicon.custodian.accepted",
        "custodianAccepted",
        "Your custodian accepted the request.",
    ),
    (
        "silicon.custodian.declined",
        "custodianDeclined",
        "Your custodian request was declined.",
    ),
    (
        "silicon.custodian.expired",
        "custodianExpired",
        "Your custodian request expired.",
    ),
    (
        "silicon.updated",
        "siliconUpdated",
        "Your Silicon profile changed.",
    ),
    (
        "silicon.id_changed",
        "siliconIdChanged",
        "Your Silicon ID changed.",
    ),
    (
        "silicon.stk_rotated",
        "stkRotated",
        "Your STK was rotated; sign in again.",
    ),
    (
        "silicon.custodian.changed",
        "custodianChanged",
        "Your Silicon's custodian changed.",
    ),
    (
        "silicon.federation.added",
        "federationAdded",
        "A cloud or CI trust was added.",
    ),
    (
        "silicon.federation.removed",
        "federationRemoved",
        "A cloud or CI trust was removed.",
    ),
    (
        "silicon.identity_audiences.changed",
        "identityAudiencesChanged",
        "Your allowed identity-token audiences changed.",
    ),
];
pub const REQUEST_TYPE: &str = "silicon-accounts.custodianRequestChanged";

pub fn retired() -> ApiError {
    ApiError::gone("silicon_notifications_moved", "Silicon account notifications now use Ting.")
        .hint("Run silicon-accounts notifications enable, sign into Ting as the same Silicon, then run ting listen. For pending custodian requests, attach an anonymous Ting session with the request token.")
}

pub fn validate_session(id: &str) -> ApiResult<()> {
    if id
        .strip_prefix("recv_")
        .is_none_or(|s| s.len() != 32 || !s.bytes().all(|b| b.is_ascii_hexdigit()))
    {
        return Err(ApiError::unprocessable(
            "invalid_ting_session",
            "Use the live recv_… session_id returned by ting listen.",
        ));
    }
    Ok(())
}

/// Called in the same transaction as the account change and its historical event.
pub async fn enqueue(
    conn: &mut PgConnection,
    account: &str,
    event: Uuid,
    kind: &str,
    data: &Value,
) -> ApiResult<()> {
    let Some((_, name, _)) = TYPES.iter().find(|(old, _, _)| *old == kind) else {
        return Ok(());
    };
    let id = Uuid::now_v7();
    let payload = json!({"type":format!("{APP}.{name}"),"for":account,"key":format!("accounts:{event}"),"data":data,"metadata":{}});
    sqlx::query("insert into silicon_tings(id,account_uuid,event_id,payload) values($1,$2,$3,$4)")
        .bind(id)
        .bind(account)
        .bind(event)
        .bind(payload)
        .execute(&mut *conn)
        .await?;
    // Pre-sign-in receivers get only a wake-up hint. Never forward the account snapshot,
    // STK, request token, or custodian contact details into an anonymous session.
    if matches!(
        kind,
        "silicon.created"
            | "silicon.custodian.accepted"
            | "silicon.custodian.declined"
            | "silicon.custodian.expired"
    ) {
        let ids:Vec<Uuid>=sqlx::query_scalar("select r.id from custodian_requests r join silicon_ting_requests t on t.request_id=r.id where r.silicon_uuid=$1 and r.kind='initial'")
            .bind(account).fetch_all(&mut *conn).await?;
        for request in ids {
            enqueue_request(conn, request).await?;
        }
    }
    Ok(())
}

pub async fn enqueue_request(conn: &mut PgConnection, request: Uuid) -> ApiResult<()> {
    let Some((account,session,generation)):Option<(String,String,Uuid)>=sqlx::query_as("select r.silicon_uuid,t.session_id,t.generation from custodian_requests r join silicon_ting_requests t on t.request_id=r.id where r.id=$1")
        .bind(request).fetch_optional(&mut *conn).await? else {return Ok(())};
    let id = Uuid::now_v7();
    let payload = json!({"type":REQUEST_TYPE,"session_id":session,"key":format!("accounts-request:{id}"),"data":{"request_id":request},"metadata":{}});
    sqlx::query("insert into silicon_tings(id,account_uuid,request_id,session_id,generation,payload) values($1,$2,$3,$4,$5,$6)")
        .bind(id).bind(account).bind(request).bind(session).bind(generation).bind(payload).execute(conn).await?;
    Ok(())
}
