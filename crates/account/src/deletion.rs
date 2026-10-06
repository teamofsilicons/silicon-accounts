//! `DELETE /v1/me` — a Carbon deletes its own account.
//!
//! Refused while the Carbon is custodian of any Silicon that isn't deleted (a Silicon always has
//! exactly one custodian; transfer it first). Otherwise, in one transaction: status `deleted`,
//! the id reserved for 10 days, emails/phones/identities removed, browser sessions, token
//! families and OBO proofs revoked, pending custodian requests cancelled, the photo back to the
//! default and the uploads no other account shows deleted, and `account.deleted` to every app the
//! account had a live membership with (memberships stay as the apps' history).
//!
//! A second `DELETE /v1/me` that was already in flight (a double click, a client retry) waits for
//! the first one's row lock, finds the account deleted and answers 204 without doing anything,
//! so apps get `account.deleted` once.
//!
//! Silicons that self-created naming this Carbon as their custodian and are still waiting can
//! never be accepted now: they are released like a decline (their id is free again at once) and
//! told on their webhook with `silicon.custodian.declined` (reason `custodian_account_deleted`),
//! with the same payload, release steps and audit entry as the silicons crate's
//! `lifecycle::release_orphan`, which handles the same case when its sweep finds it first.

use accounts_core::events::{self, types};
use accounts_core::http::cookies::{SESSION_COOKIE, append_cookie, clear_cookie};
use accounts_core::http::{AccountAuth, ClientMeta, Json};
use accounts_core::ids::AccountId;
use accounts_core::models::{AccountKind, AccountStatus, ActorKind};
use accounts_core::normalize;
use accounts_core::pfp;
use accounts_core::repo::accounts;
use accounts_core::repo::audit::{self, AuditEntry};
use accounts_core::views::AccountSummary;
use accounts_core::{ApiError, AppState};
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::json;
use sqlx::PgConnection;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::photos::prune_photos;
use crate::util::{audit_self, clip, track, ts};

#[derive(Debug, Deserialize)]
pub(crate) struct DeleteBody {
    #[serde(default)]
    confirm: Option<String>,
}

/// `DELETE /v1/me` `{"confirm":"c:saket"}` → 204 (see the module docs).
pub(crate) async fn delete_me(
    State(state): State<AppState>,
    me: AccountAuth,
    meta: ClientMeta,
    Json(body): Json<DeleteBody>,
) -> Result<Response, ApiError> {
    if me.kind() == AccountKind::Silicon {
        let custodian = match &me.account.custodian_uuid {
            Some(c) => {
                let mut conn = state.db.acquire().await?;
                accounts::get(&mut conn, c)
                    .await?
                    .map(|a| a.display_id())
                    .unwrap_or_else(|| "its custodian".to_string())
            }
            None => "its custodian".to_string(),
        };
        return Err(ApiError::forbidden(
            "custodian_required",
            format!(
                "A Silicon can't delete its own account: {} is deleted by its custodian {custodian}.",
                me.account.display_id()
            ),
        )
        .hint(format!(
            "Ask {custodian} to delete it with DELETE /v1/me/silicons/{} (or `accounts silicon delete {}`).",
            me.uuid(),
            me.account.id()
        )));
    }
    let current = me.account.id().to_string();
    let Some(confirm) = body
        .confirm
        .as_deref()
        .map(str::trim)
        .filter(|c| !c.is_empty())
    else {
        return Err(ApiError::unprocessable(
            "confirmation_required",
            format!(
                "Deleting an account can't be undone, so the request must confirm it: send {{\"confirm\":\"{current}\"}} (your current id)."
            ),
        )
        .hint(format!("Send {{\"confirm\":\"{current}\"}} as the JSON body.")));
    };
    let confirmed = AccountId::parse_for_kind(confirm, AccountKind::Carbon)
        .is_ok_and(|id| id.to_string() == current);
    if !confirmed {
        return Err(confirmation_mismatch(confirm, &current));
    }

    let mut tx = state.db.begin().await?;
    // Lock order: the custodian requests addressed to this Carbon first (accepting or expiring
    // a request locks the request before anything else), then the account itself.
    sqlx::query(
        "select id from custodian_requests where status = 'pending' and to_uuid = $1 for update",
    )
    .bind(me.uuid())
    .fetch_all(&mut *tx)
    .await?;
    let locked = accounts::lock(&mut tx, me.uuid()).await?.ok_or_else(|| {
        ApiError::not_found(
            "account_not_found",
            format!("No account has the uuid '{}'.", me.uuid()),
        )
    })?;
    if locked.is_deleted() {
        // Another DELETE /v1/me (a double click, a retry) finished while this one waited for
        // the lock. The account is gone and its apps were told once; there is nothing to do.
        drop(tx);
        return Ok(no_content(&state, &me));
    }
    if locked.handle.as_deref() != Some(current.as_str()) {
        // The id changed after this request was authenticated; the confirmation named the
        // old one.
        return Err(confirmation_mismatch(confirm, &locked.display_id()));
    }
    let silicons = accounts::list_silicons_in_custody(&mut tx, me.uuid()).await?;
    if !silicons.is_empty() {
        let ids: Vec<String> = silicons.iter().map(|s| s.display_id()).collect();
        let summaries: Vec<AccountSummary> =
            silicons.iter().map(AccountSummary::from_account).collect();
        return Err(ApiError::conflict(
            "custodian_of_silicons",
            format!(
                "{current} is the custodian of {} Silicon(s) ({}), and every Silicon must always have a custodian, so the account can't be deleted yet.",
                silicons.len(),
                ids.join(", ")
            ),
        )
        .hint("Transfer each Silicon to another Carbon (POST /v1/me/silicons/{uuid}/transfer, accepted by them) or delete it (DELETE /v1/me/silicons/{uuid}), then delete the account.")
        .detail("silicons", serde_json::to_value(summaries)?));
    }
    let deleted = accounts::delete_account(&mut tx, me.uuid(), me.uuid(), true).await?;
    // Self-created Silicons that were waiting for this Carbon: the deletion just cancelled their
    // requests (decided by this account at this transaction's now()).
    let waiting: Vec<WaitingRequest> = sqlx::query_as(
        "select id, silicon_uuid, to_email, decided_at from custodian_requests \
          where kind = 'initial' and to_uuid = $1 and status = 'cancelled' \
            and decided_by = $1 and decided_at = now() for update",
    )
    .bind(me.uuid())
    .fetch_all(&mut *tx)
    .await?;
    let mut released = Vec::new();
    for request in &waiting {
        if let Some(id) = release_waiting_silicon(&mut tx, request, &current).await? {
            released.push(id);
        }
    }
    events::account_deleted(&mut tx, me.uuid()).await?;
    // Back to the default photo, then delete the uploads nobody shows. An upload that another
    // account still shows (a Silicon this Carbon gave it to before transferring it) stays.
    sqlx::query("update accounts set pfp_url = $2 where uuid = $1")
        .bind(me.uuid())
        .bind(pfp::default_pfp_url(
            &state.settings.iris_base_url,
            me.kind(),
            me.uuid(),
        ))
        .execute(&mut *tx)
        .await?;
    let photos = prune_photos(&mut tx, &state.settings, me.uuid()).await?;
    audit_self(
        &mut tx,
        me.uuid(),
        "account.deleted",
        None,
        json!({
            "old_id": deleted.old_id,
            "revoked_sessions": deleted.revoked_families,
            "revoked_proofs": deleted.revoked_proofs,
            "deleted_photos": photos,
            "released_silicons": released,
        }),
        meta.ip.as_deref(),
    )
    .await?;
    tx.commit().await?;
    track(
        &state,
        "delete",
        "account.deleted",
        json!({
            "revoked_sessions": deleted.revoked_families,
            "revoked_proofs": deleted.revoked_proofs,
            "released_silicons": released.len(),
        }),
    );

    Ok(no_content(&state, &me))
}

/// 204, clearing the session cookie when the request came with one.
fn no_content(state: &AppState, me: &AccountAuth) -> Response {
    let mut response = StatusCode::NO_CONTENT.into_response();
    if me.is_cookie() {
        append_cookie(
            response.headers_mut(),
            &clear_cookie(&state.settings, SESSION_COOKIE),
        );
    }
    response
}

fn confirmation_mismatch(confirm: &str, current: &str) -> ApiError {
    ApiError::unprocessable(
        "confirmation_mismatch",
        format!(
            "confirm is '{}', but it must be this account's current id {current}; nothing was deleted.",
            clip(confirm, 40)
        ),
    )
    .hint(format!(
        "Send {{\"confirm\":\"{current}\"}} to delete {current}."
    ))
}

/// An initial custodian request this deletion just cancelled.
#[derive(Debug, sqlx::FromRow)]
struct WaitingRequest {
    id: Uuid,
    silicon_uuid: String,
    to_email: Option<String>,
    decided_at: Option<OffsetDateTime>,
}

/// Releases a self-created Silicon whose named custodian is being deleted, the same way the
/// silicons crate's `lifecycle::release_orphan` does. It tells the Silicon on its webhook
/// (`silicon.custodian.declined`, same payload), then frees its id with no reservation (it
/// never became active). Its webhook URL and secret are kept so that last notification can
/// still be delivered. Returns the released id.
async fn release_waiting_silicon(
    conn: &mut PgConnection,
    request: &WaitingRequest,
    custodian_id: &str,
) -> Result<Option<String>, ApiError> {
    let silicon_uuid = request.silicon_uuid.as_str();
    let Some(silicon) = accounts::lock(conn, silicon_uuid).await? else {
        return Ok(None);
    };
    if silicon.status != AccountStatus::PendingCustodian {
        return Ok(None);
    }
    // The silicons crate labels a custodian named by email with the masked email.
    let custodian = match &request.to_email {
        Some(email) => normalize::mask_email(email),
        None => custodian_id.to_string(),
    };
    let old_id = silicon.handle.clone();
    events::emit_to_silicon(
        conn,
        silicon_uuid,
        types::SILICON_CUSTODIAN_DECLINED,
        json!({
            "uuid": silicon_uuid,
            "id": old_id,
            "request_id": request.id.to_string(),
            "custodian": custodian,
            "decided_at": request.decided_at.map(ts),
            "reason": "custodian_account_deleted",
            "released": true,
        }),
    )
    .await?;
    if let Some(h) = &old_id {
        // Same advisory key as core's id claims, so a concurrent claim of this id waits for us.
        sqlx::query("select pg_advisory_xact_lock(hashtextextended('handle:' || $1, 0))")
            .bind(h)
            .execute(&mut *conn)
            .await?;
    }
    sqlx::query(
        "update accounts set status = 'deleted', handle = null, deleted_at = now(), updated_at = now(), \
         version = version + 1, stk_hash = null, stk_failed_attempts = 0, stk_locked_until = null \
         where uuid = $1",
    )
    .bind(silicon_uuid)
    .execute(&mut *conn)
    .await?;
    if let Some(h) = &old_id {
        audit::handle_history(conn, silicon_uuid, Some(h), None, "system").await?;
    }
    // A waiting Silicon can't sign in, so these find nothing; they make sure of it, as the
    // silicons crate's release does.
    sqlx::query(
        "update token_families set revoked_at = now(), revoke_reason = 'account_released' \
         where account_uuid = $1 and revoked_at is null",
    )
    .bind(silicon_uuid)
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        "update browser_sessions set revoked_at = now() where account_uuid = $1 and revoked_at is null",
    )
    .bind(silicon_uuid)
    .execute(&mut *conn)
    .await?;
    audit::record(
        conn,
        &AuditEntry {
            target_kind: Some("silicon"),
            target_id: Some(silicon_uuid),
            account_uuid: Some(silicon_uuid),
            details: json!({
                "request_id": request.id.to_string(),
                "reason": "custodian_account_deleted",
                "custodian": custodian,
                "released_id": old_id,
            }),
            ..AuditEntry::new(ActorKind::System, None, "silicon.custodian_request.closed")
        },
    )
    .await?;
    Ok(old_id)
}
