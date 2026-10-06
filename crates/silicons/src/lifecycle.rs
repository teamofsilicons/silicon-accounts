//! What deciding a custodian request does. Every function runs inside the caller's transaction,
//! on a request the caller has row-locked and checked (pending, addressed to the Carbon, not
//! overdue unless expiring). Locks are taken request first, then Silicon, everywhere.
//!
//! | request | accept | decline | expire (sweep) |
//! |---|---|---|---|
//! | initial | Silicon active, custodian = acceptor, history `initial_accepted`, `silicon.custodian.accepted` | `silicon.custodian.declined`, Silicon released | `silicon.custodian.expired`, Silicon released |
//! | transfer | custodian = acceptor, history `transfer`, `silicon.custodian.changed` + apps `silicon.custodian_changed` | nothing changes | nothing changes |
//!
//! "Released" = the Silicon never became active, so it is deleted with its id freed immediately
//! (no 10-day reservation) by core's `accounts::release_silicon`, which keeps its webhook so the
//! `silicon.custodian.declined` / `.expired` event emitted just before can still be delivered.
//! A self-created Silicon whose named Carbon deletes their account before answering is released
//! by that deletion itself (core's `accounts::delete_account`); [`release_orphan`] is the safety
//! net for requests that were cancelled without it (accounts deleted before that existed).

use accounts_core::error::{ApiError, ApiResult};
use accounts_core::events;
use accounts_core::models::{Account, AccountStatus};
use accounts_core::repo::accounts;
use accounts_core::views::AccountSummary;
use serde_json::json;
use sqlx::PgConnection;

use crate::history::{Actor, custody};
use crate::notify;
use crate::requests::{self, CustodianRequest, kind, status};
use crate::views;

fn silicon_missing(request: &CustodianRequest) -> ApiError {
    ApiError::internal(format!(
        "custodian request {} points at a missing Silicon {}",
        request.id, request.silicon_uuid
    ))
}

/// Accepts a pending request as `me` (see the module table).
pub async fn accept(
    conn: &mut PgConnection,
    request: &CustodianRequest,
    me: &Account,
    actor: Actor<'_>,
) -> ApiResult<()> {
    let silicon = accounts::lock(conn, &request.silicon_uuid)
        .await?
        .ok_or_else(|| silicon_missing(request))?;
    if request.is_initial() {
        if silicon.status != AccountStatus::PendingCustodian {
            return Err(ApiError::conflict(
                "silicon_not_pending",
                format!(
                    "{} is {}, so its custodian request can no longer be accepted.",
                    silicon.display_id(),
                    silicon.status
                ),
            ));
        }
        let silicon =
            accounts::set_custodian(conn, &silicon.uuid, &me.uuid, AccountStatus::Active).await?;
        let decided = requests::decide(
            conn,
            request.id,
            status::ACCEPTED,
            Some(&me.uuid),
            Some(&me.uuid),
        )
        .await?;
        crate::history::custodian_change(
            conn,
            &silicon.uuid,
            None,
            &me.uuid,
            custody::INITIAL_ACCEPTED,
            Some(request.id),
        )
        .await?;
        notify::custodian_accepted(conn, &silicon, me, &decided).await?;
        actor
            .record_for(
                conn,
                "silicon.custodian.accepted",
                &[Some(&silicon.uuid), Some(&me.uuid)],
                &silicon.uuid,
                json!({"request_id": request.id.to_string(), "kind": kind::INITIAL, "silicon_id": silicon.handle, "custodian_id": me.handle}),
            )
            .await?;
        tracing::info!(silicon = %silicon.uuid, custodian = %me.uuid, request = %request.id, "custodian accepted a self-created Silicon");
        return Ok(());
    }

    // A transfer.
    if silicon.status != AccountStatus::Active {
        return Err(ApiError::conflict(
            "silicon_not_active",
            format!(
                "{} is {}, so it can't be transferred.",
                silicon.display_id(),
                silicon.status
            ),
        ));
    }
    if silicon.custodian_uuid.as_deref() == Some(me.uuid.as_str()) {
        return Err(ApiError::conflict(
            "already_custodian",
            format!("You are already the custodian of {}.", silicon.display_id()),
        )
        .hint("Decline the request instead; nothing would change."));
    }
    let Some(from_uuid) = request.from_uuid.as_deref() else {
        return Err(ApiError::internal(format!(
            "transfer request {} has no from_uuid",
            request.id
        )));
    };
    if silicon.custodian_uuid.as_deref() != Some(from_uuid) {
        return Err(ApiError::conflict(
            "transfer_stale",
            format!(
                "{} changed custodian after this transfer was requested, so the request no longer applies.",
                silicon.display_id()
            ),
        )
        .hint("Ask the Silicon's current custodian to send a new transfer request."));
    }
    let from = accounts::require(conn, from_uuid).await?;
    let silicon =
        accounts::set_custodian(conn, &silicon.uuid, &me.uuid, AccountStatus::Active).await?;
    requests::decide(
        conn,
        request.id,
        status::ACCEPTED,
        Some(&me.uuid),
        Some(&me.uuid),
    )
    .await?;
    crate::history::custodian_change(
        conn,
        &silicon.uuid,
        Some(from_uuid),
        &me.uuid,
        custody::TRANSFER,
        Some(request.id),
    )
    .await?;
    events::notify_custodian_changed(
        conn,
        &silicon,
        &AccountSummary::from_account(&from),
        &AccountSummary::from_account(me),
    )
    .await?;
    actor
        .record_for(
            conn,
            "silicon.custodian.transfer.accepted",
            &[Some(&silicon.uuid), Some(from_uuid), Some(&me.uuid)],
            &silicon.uuid,
            json!({"request_id": request.id.to_string(), "kind": kind::TRANSFER, "silicon_id": silicon.handle, "from": from.handle, "to": me.handle}),
        )
        .await?;
    tracing::info!(silicon = %silicon.uuid, from = %from_uuid, to = %me.uuid, request = %request.id, "Silicon transferred");
    Ok(())
}

/// Declines a pending request as `me` (see the module table).
pub async fn decline(
    conn: &mut PgConnection,
    request: &CustodianRequest,
    me: &Account,
    actor: Actor<'_>,
) -> ApiResult<()> {
    let decided = requests::decide(
        conn,
        request.id,
        status::DECLINED,
        Some(&me.uuid),
        Some(&me.uuid),
    )
    .await?;
    let mut released_id = None;
    if request.is_initial() {
        let label = views::custodian_label(conn, &decided).await?;
        if let Some(silicon) = accounts::lock(conn, &request.silicon_uuid).await?
            && silicon.status == AccountStatus::PendingCustodian
        {
            // Told before the release, while the Silicon still has its id.
            notify::custodian_declined(conn, &silicon, &decided, &label, "declined").await?;
            released_id = accounts::release_silicon(conn, &silicon.uuid, &me.uuid).await?;
        }
    }
    actor
        .record_for(
            conn,
            "silicon.custodian.declined",
            &[
                Some(&request.silicon_uuid),
                request.from_uuid.as_deref(),
                Some(&me.uuid),
            ],
            &request.silicon_uuid,
            json!({"request_id": request.id.to_string(), "kind": request.kind, "released_id": released_id}),
        )
        .await?;
    tracing::info!(silicon = %request.silicon_uuid, by = %me.uuid, request = %request.id, kind = %request.kind, "custodian request declined");
    Ok(())
}

/// Expires an overdue pending request (the sweep, or a read that found it overdue).
pub async fn expire(conn: &mut PgConnection, request: &CustodianRequest) -> ApiResult<()> {
    let decided = requests::decide(conn, request.id, status::EXPIRED, None, None).await?;
    let mut released_id = None;
    if request.is_initial() {
        let label = views::custodian_label(conn, &decided).await?;
        if let Some(silicon) = accounts::lock(conn, &request.silicon_uuid).await?
            && silicon.status == AccountStatus::PendingCustodian
        {
            notify::custodian_expired(conn, &silicon, &decided, &label).await?;
            released_id = accounts::release_silicon(conn, &silicon.uuid, "system").await?;
        }
    }
    Actor::system()
        .record_for(
            conn,
            "silicon.custodian.expired",
            &[
                Some(&request.silicon_uuid),
                request.from_uuid.as_deref(),
                request.to_uuid.as_deref(),
            ],
            &request.silicon_uuid,
            json!({"request_id": request.id.to_string(), "kind": request.kind, "released_id": released_id}),
        )
        .await?;
    tracing::info!(silicon = %request.silicon_uuid, request = %request.id, kind = %request.kind, "custodian request expired");
    Ok(())
}

/// Releases a self-created Silicon whose initial request was cancelled because the Carbon it
/// named deleted their account: nobody can accept it any more, so it is treated like a decline
/// (`silicon.custodian.declined` with `reason: custodian_account_deleted`, Silicon released).
/// Returns false when there is nothing to do.
pub async fn release_orphan(
    conn: &mut PgConnection,
    request: &CustodianRequest,
) -> ApiResult<bool> {
    if !request.is_initial() || request.status != status::CANCELLED {
        return Ok(false);
    }
    let Some(silicon) = accounts::lock(conn, &request.silicon_uuid).await? else {
        return Ok(false);
    };
    if silicon.status != AccountStatus::PendingCustodian
        || requests::pending_for_silicon(conn, &silicon.uuid, false)
            .await?
            .is_some()
    {
        return Ok(false);
    }
    let label = views::custodian_label(conn, request).await?;
    notify::custodian_declined(conn, &silicon, request, &label, "custodian_account_deleted")
        .await?;
    let released_id = accounts::release_silicon(conn, &silicon.uuid, "system").await?;
    // Same action and details as the account crate's release at deletion time.
    Actor::system()
        .record_for(
            conn,
            "silicon.custodian_request.closed",
            &[Some(&silicon.uuid)],
            &silicon.uuid,
            json!({"request_id": request.id.to_string(), "reason": "custodian_account_deleted",
                   "custodian": label, "released_id": released_id}),
        )
        .await?;
    tracing::info!(silicon = %silicon.uuid, request = %request.id, "released a Silicon whose named custodian deleted their account");
    Ok(true)
}

/// Cancels a pending transfer as its custodian.
pub async fn cancel_transfer(
    conn: &mut PgConnection,
    request: &CustodianRequest,
    me: &Account,
    actor: Actor<'_>,
) -> ApiResult<()> {
    requests::decide(conn, request.id, status::CANCELLED, Some(&me.uuid), None).await?;
    actor
        .record_for(
            conn,
            "silicon.transfer.cancelled",
            &[
                Some(&request.silicon_uuid),
                Some(&me.uuid),
                request.to_uuid.as_deref(),
            ],
            &request.silicon_uuid,
            json!({"request_id": request.id.to_string()}),
        )
        .await?;
    Ok(())
}
