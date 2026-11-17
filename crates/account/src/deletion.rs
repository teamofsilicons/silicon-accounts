//! `DELETE /v1/me` — a Carbon deletes its own account.
//!
//! The account is archived first (core's `accounts::archive_account`), in one transaction:
//! refused while the Carbon is custodian of any Silicon that isn't deleted (409
//! `custodian_of_silicons`: a Silicon always has exactly one custodian; transfer it first);
//! otherwise status `archived`, browser sessions and token families revoked, and an email to its
//! primary email saying when it will be deleted. Its id, emails, phones, Google/Apple links and
//! memberships stay, and apps are told nothing yet. Signing in again with an email or phone code
//! within 10 days restores it (the hosted flow's `verify`); otherwise this crate's minute sweep
//! ([`delete_archived_accounts`]) runs core's `accounts::delete_account`: status `deleted`, the
//! id released at the end of the recovery period, emails/phones/identities removed, User verification proofs revoked,
//! pending custodian requests cancelled, the photo back to the default and the uploads no other
//! account shows deleted, the apps' imported data about the account dropped, and
//! `account.deleted` to every app the account had a live membership with (memberships stay as
//! the apps' history).
//!
//! A second `DELETE /v1/me` that was already in flight (a double click, a client retry) waits for
//! the first one's row lock, finds the account archived and answers 204 without doing anything,
//! so the email goes out once.
//!
//! Silicons that self-created naming this Carbon as their custodian and are still waiting when
//! the sweep deletes it can never be accepted: core releases them like a decline (their id is
//! free again at once) and tells them on their webhook with `silicon.custodian.declined` (reason
//! `custodian_account_deleted`), the same payload the silicons crate sends.

use accounts_core::delivery;
use accounts_core::http::browser_profiles::BrowserProfiles;
use accounts_core::http::cookies::append_cookie;
use accounts_core::http::{AccountAuth, ClientMeta, Json};
use accounts_core::ids::AccountId;
use accounts_core::models::{AccountKind, AccountStatus, ActorKind};
use accounts_core::repo::accounts;
use accounts_core::repo::audit;
use accounts_core::{ApiError, ApiResult, AppState};
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::json;

use crate::util::{audit_self, clip};

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
    headers: HeaderMap,
    Json(body): Json<DeleteBody>,
) -> Result<Response, ApiError> {
    {
        let mut conn = state.db.acquire().await?;
        if accounts_core::repo::organizations::org_id(&mut conn, me.uuid())
            .await?
            .is_some()
        {
            return Err(ApiError::forbidden(
                "organization_account_managed",
                "Leave your organization in Silicon Organizations to close this work account. The last owner must appoint another owner first.",
            ));
        }
    }
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
            "Ask {custodian} to delete it with DELETE /v1/me/silicons/{} (or `silicon-accounts silicon delete {}`).",
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
                "Deleting an account signs it out everywhere and erases it after 10 days, so the request must confirm it: send {{\"confirm\":\"{current}\"}} (your current id)."
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
    let mut response = StatusCode::NO_CONTENT.into_response();
    if me.is_cookie() {
        let profiles = BrowserProfiles::load(&mut tx, &state, &headers).await?;
        for cookie in profiles.sign_out(&mut tx, &state, me.uuid()).await? {
            append_cookie(response.headers_mut(), &cookie);
        }
    }
    if matches!(
        locked.status,
        AccountStatus::Archived | AccountStatus::Deleted
    ) {
        // Another DELETE /v1/me (a double click, a retry) finished while this one waited for
        // the lock. The account is archived and was emailed once; there is nothing to do.
        tx.commit().await?;
        return Ok(response);
    }
    if locked.handle.as_deref() != Some(current.as_str()) {
        // The id changed after this request was authenticated; the confirmation named the
        // old one.
        return Err(confirmation_mismatch(confirm, &locked.display_id()));
    }
    // 409 `custodian_of_silicons` (details.silicons) while it still has Silicons in custody.
    let archived = accounts::archive_account(&mut tx, &state.settings, &locked).await?;
    audit_self(
        &mut tx,
        me.uuid(),
        "account.archived",
        None,
        json!({
            "delete_after": accounts_core::timefmt::format_rfc3339_ms(archived.delete_after),
            "revoked_sessions": archived.revoked_families,
        }),
        meta.ip.as_deref(),
    )
    .await?;
    tx.commit().await?;
    if let Some(id) = archived.message_id {
        delivery::spawn_deliver(&state, id);
    }

    Ok(response)
}

/// Deletes for real every Carbon archived over `ARCHIVE_DAYS` ago that didn't sign in again
/// (core's `accounts::delete_account`, actor `system`). Returns how many were deleted. One
/// account failing is logged and retried next run; the others still go.
pub async fn delete_archived_accounts(state: &AppState) -> ApiResult<u64> {
    let due: Vec<String> = sqlx::query_scalar(
        "select uuid from accounts where status = 'archived' \
         and archived_at <= now() - make_interval(days => $1) order by archived_at",
    )
    .bind(accounts::ARCHIVE_DAYS as i32)
    .fetch_all(&state.db)
    .await?;
    let mut deleted = 0;
    for uuid in due {
        match delete_archived(state, &uuid).await {
            Ok(true) => deleted += 1,
            Ok(false) => {}
            Err(e) => {
                tracing::warn!(account = %uuid, error = %e, "deleting an archived account failed")
            }
        }
    }
    Ok(deleted)
}

/// False when the account signed in again (or was deleted) since it was listed.
async fn delete_archived(state: &AppState, uuid: &str) -> ApiResult<bool> {
    let mut tx = state.db.begin().await?;
    // delete_account's lock order: the requests addressed to the account, then the account.
    sqlx::query(
        "select id from custodian_requests where status = 'pending' and to_uuid = $1 order by id for update",
    )
    .bind(uuid)
    .fetch_all(&mut *tx)
    .await?;
    let due: Option<bool> = sqlx::query_scalar(
        "select status = 'archived' and archived_at <= now() - make_interval(days => $2) \
         from accounts where uuid = $1 for update",
    )
    .bind(uuid)
    .bind(accounts::ARCHIVE_DAYS as i32)
    .fetch_optional(&mut *tx)
    .await?;
    if due != Some(true) {
        return Ok(false);
    }
    let deleted = accounts::delete_account(&mut tx, &state.settings, uuid, "system", false).await?;
    let released: Vec<Option<String>> = deleted
        .released_silicons
        .iter()
        .map(|s| s.old_id.clone())
        .collect();
    audit::record(
        &mut tx,
        &audit::AuditEntry {
            target_kind: Some("account"),
            target_id: Some(uuid),
            account_uuid: Some(uuid),
            details: json!({
                "old_id": deleted.old_id,
                "revoked_sessions": deleted.revoked_families,
                "revoked_proofs": deleted.revoked_proofs,
                "deleted_photos": deleted.deleted_photos,
                "released_silicons": released,
            }),
            ..audit::AuditEntry::new(ActorKind::System, None, "account.deleted")
        },
    )
    .await?;
    tx.commit().await?;
    Ok(true)
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
