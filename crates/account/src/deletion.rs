//! `DELETE /v1/me` — a Carbon deletes its own account.
//!
//! The deletion itself is core's `accounts::delete_account`, in one transaction: refused while the
//! Carbon is custodian of any Silicon that isn't deleted (409 `custodian_of_silicons`: a Silicon
//! always has exactly one custodian; transfer it first); otherwise status `deleted`, the id
//! reserved for 10 days, emails/phones/identities removed, browser sessions, token families and
//! OBO proofs revoked, pending custodian requests cancelled, the photo back to the default and the
//! uploads no other account shows deleted, the apps' imported data about the account dropped, and
//! `account.deleted` to every app the account had a live membership with (memberships stay as
//! the apps' history).
//!
//! A second `DELETE /v1/me` that was already in flight (a double click, a client retry) waits for
//! the first one's row lock, finds the account deleted and answers 204 without doing anything,
//! so apps get `account.deleted` once.
//!
//! Silicons that self-created naming this Carbon as their custodian and are still waiting can
//! never be accepted now: core releases them like a decline (their id is free again at once) and
//! tells them on their webhook with `silicon.custodian.declined` (reason
//! `custodian_account_deleted`), the same payload the silicons crate sends.

use accounts_core::http::cookies::{SESSION_COOKIE, append_cookie, clear_cookie};
use accounts_core::http::{AccountAuth, ClientMeta, Json};
use accounts_core::ids::AccountId;
use accounts_core::models::AccountKind;
use accounts_core::repo::accounts;
use accounts_core::{ApiError, AppState};
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::json;

use crate::util::{audit_self, clip, track};

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
    // a request locks the request before anything else), then the account itself — the order
    // core's `delete_account` takes them in too.
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
    // 409 `custodian_of_silicons` (details.silicons) while it still has Silicons in custody.
    let deleted =
        accounts::delete_account(&mut tx, &state.settings, me.uuid(), me.uuid(), true).await?;
    let released: Vec<Option<String>> = deleted
        .released_silicons
        .iter()
        .map(|s| s.old_id.clone())
        .collect();
    audit_self(
        &mut tx,
        me.uuid(),
        "account.deleted",
        None,
        json!({
            "old_id": deleted.old_id,
            "revoked_sessions": deleted.revoked_families,
            "revoked_proofs": deleted.revoked_proofs,
            "deleted_photos": deleted.deleted_photos,
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
