//! Webhook events. Emitting writes one `webhook_events` row per (event, target) holding the
//! exact JSON body that will be signed and sent, plus one `pending` `webhook_deliveries` row;
//! the worker delivers (see the constants and [`retry_delay_seconds`]).
//!
//! Body: `{"event_id","type","occurred_at","app_id","silicon","data"}` — `app_id` is the target
//! app for app webhooks, `silicon` the target Silicon's uuid for Silicon webhooks.
//!
//! App events go to every app with a *live* membership (`active` or `imported`) and a configured
//! webhook URL. A disabled app gets its events too: the worker holds their deliveries until the
//! app is re-enabled (or the delivery window ends, after which they can be replayed), so the app
//! never misses a change made while it was disabled. Call these helpers inside the same
//! transaction as the change so events exist exactly when the change commits.

use serde_json::{Value, json};
use sqlx::PgConnection;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::crypto::Keyring;
use crate::error::ApiResult;
use crate::models::{Account, AccountField, AccountKind, WebhookTargetKind};
use crate::repo::{contacts, memberships};
use crate::views::{AccountForApp, AccountSummary, CustodianRef, MeView};

/// Event type names.
pub mod types {
    // App webhooks
    pub const ACCOUNT_ID_CHANGED: &str = "account.id_changed";
    pub const ACCOUNT_UPDATED: &str = "account.updated";
    pub const ACCOUNT_DELETED: &str = "account.deleted";
    pub const MEMBERSHIP_SIGNED_OUT: &str = "membership.signed_out";
    pub const MEMBERSHIP_ACCESS_REMOVED: &str = "membership.access_removed";
    /// App-facing custodian change of a member Silicon.
    pub const SILICON_CUSTODIAN_CHANGED: &str = "silicon.custodian_changed";
    pub const PING: &str = "ping";
    // Silicon webhooks
    pub const SILICON_CREATED: &str = "silicon.created";
    pub const SILICON_CUSTODIAN_ACCEPTED: &str = "silicon.custodian.accepted";
    pub const SILICON_CUSTODIAN_DECLINED: &str = "silicon.custodian.declined";
    pub const SILICON_CUSTODIAN_EXPIRED: &str = "silicon.custodian.expired";
    pub const SILICON_UPDATED: &str = "silicon.updated";
    pub const SILICON_ID_CHANGED: &str = "silicon.id_changed";
    pub const SILICON_STK_ROTATED: &str = "silicon.stk_rotated";
    /// Silicon-facing custodian change (to the Silicon's own webhook).
    pub const SILICON_OWN_CUSTODIAN_CHANGED: &str = "silicon.custodian.changed";
}

/// `membership.signed_out` reasons.
pub mod signout_reason {
    pub const APP_REVOKED: &str = "app_revoked";
    pub const STK_ROTATED: &str = "stk_rotated";
    pub const USER_SIGNED_OUT: &str = "user_signed_out";
    pub const SESSION_REVOKED: &str = "session_revoked";
    pub const REFRESH_TOKEN_REUSE: &str = "refresh_token_reuse";
    /// A used authorization code was presented again: the tokens issued from it were revoked
    /// (RFC 6749 §4.1.2).
    pub const AUTHORIZATION_CODE_REUSE: &str = "authorization_code_reuse";
}

/// `silicon.custodian.declined` reasons.
pub mod declined_reason {
    /// The Carbon declined the request.
    pub const DECLINED: &str = "declined";
    /// The Carbon deleted their account before answering.
    pub const CUSTODIAN_ACCOUNT_DELETED: &str = "custodian_account_deleted";
}

/// Delivery request headers.
pub const HEADER_EVENT_ID: &str = "X-Accounts-Event-Id";
pub const HEADER_EVENT_TYPE: &str = "X-Accounts-Event-Type";
pub const HEADER_DELIVERY_ID: &str = "X-Accounts-Delivery-Id";
pub const HEADER_TIMESTAMP: &str = "X-Accounts-Timestamp";
pub const HEADER_SIGNATURE: &str = "X-Accounts-Signature";
/// Delivery `User-Agent`.
pub const USER_AGENT: &str = "SiliconAccounts-Webhooks/1";
/// A delivery succeeds on a 2xx within this many seconds.
pub const DELIVERY_TIMEOUT_SECONDS: u64 = 10;
/// Deliveries still failing this long after creation become `failed` (replayable).
pub const GIVE_UP_AFTER_HOURS: i64 = 72;

/// Seconds to wait before the next attempt after `attempts` failed attempts:
/// 10 s, 30 s, 1 min, 5 min, 15 min, 30 min, then hourly.
pub fn retry_delay_seconds(attempts: i32) -> i64 {
    match attempts {
        i32::MIN..=1 => 10,
        2 => 30,
        3 => 60,
        4 => 300,
        5 => 900,
        6 => 1800,
        _ => 3600,
    }
}

/// A stored event and its first delivery.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmittedEvent {
    pub event_id: Uuid,
    pub delivery_id: Uuid,
    pub target_kind: WebhookTargetKind,
    /// app_id or Silicon uuid.
    pub target_id: String,
    pub event_type: String,
}

/// The JSON body for an event.
pub fn build_payload(
    event_id: Uuid,
    event_type: &str,
    occurred_at: OffsetDateTime,
    app_id: Option<&str>,
    silicon: Option<&str>,
    data: Value,
) -> Value {
    json!({
        "event_id": event_id.to_string(),
        "type": event_type,
        "occurred_at": crate::timefmt::format_rfc3339_ms(occurred_at),
        "app_id": app_id,
        "silicon": silicon,
        "data": data,
    })
}

#[allow(clippy::too_many_arguments)]
async fn insert_event(
    conn: &mut PgConnection,
    target_kind: WebhookTargetKind,
    target_id: &str,
    account_uuid: Option<&str>,
    url: &str,
    event_type: &str,
    data: Value,
) -> ApiResult<EmittedEvent> {
    let event_id = Uuid::now_v7();
    let delivery_id = Uuid::now_v7();
    let occurred_at = OffsetDateTime::now_utc();
    let (app_id, silicon) = match target_kind {
        WebhookTargetKind::App => (Some(target_id), None),
        WebhookTargetKind::Silicon => (None, Some(target_id)),
    };
    let payload = build_payload(event_id, event_type, occurred_at, app_id, silicon, data);
    sqlx::query(
        "insert into webhook_events (event_id, type, target_kind, target_id, account_uuid, payload, occurred_at) \
         values ($1, $2, $3, $4, $5, $6, $7)",
    )
    .bind(event_id)
    .bind(event_type)
    .bind(target_kind)
    .bind(target_id)
    .bind(account_uuid)
    .bind(&payload)
    .bind(occurred_at)
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        "insert into webhook_deliveries (id, event_id, target_kind, target_id, url, status) values ($1, $2, $3, $4, $5, 'pending')",
    )
    .bind(delivery_id)
    .bind(event_id)
    .bind(target_kind)
    .bind(target_id)
    .bind(url)
    .execute(&mut *conn)
    .await?;
    Ok(EmittedEvent {
        event_id,
        delivery_id,
        target_kind,
        target_id: target_id.to_string(),
        event_type: event_type.to_string(),
    })
}

/// Emits an event to one app (if it has a webhook URL). Does not check memberships.
pub async fn emit_to_app(
    conn: &mut PgConnection,
    app_id: &str,
    event_type: &str,
    account_uuid: Option<&str>,
    data: Value,
) -> ApiResult<Option<EmittedEvent>> {
    let Some((url, _)) = crate::repo::apps::webhook_target(conn, app_id).await? else {
        return Ok(None);
    };
    Ok(Some(
        insert_event(
            conn,
            WebhookTargetKind::App,
            app_id,
            account_uuid,
            &url,
            event_type,
            data,
        )
        .await?,
    ))
}

/// Emits an event to a Silicon's own webhook (if it has one).
pub async fn emit_to_silicon(
    conn: &mut PgConnection,
    silicon_uuid: &str,
    event_type: &str,
    data: Value,
) -> ApiResult<Option<EmittedEvent>> {
    let url: Option<String> =
        sqlx::query_scalar("select webhook_url from accounts where uuid = $1 and kind = 'silicon'")
            .bind(silicon_uuid)
            .fetch_optional(&mut *conn)
            .await?
            .flatten();
    let Some(url) = url else { return Ok(None) };
    Ok(Some(
        insert_event(
            conn,
            WebhookTargetKind::Silicon,
            silicon_uuid,
            Some(silicon_uuid),
            &url,
            event_type,
            data,
        )
        .await?,
    ))
}

/// `account.id_changed` to every member app: `{uuid, membership_id, kind, old_id, new_id}`.
pub async fn account_id_changed(
    conn: &mut PgConnection,
    account: &Account,
    old_id: &str,
    new_id: &str,
) -> ApiResult<Vec<EmittedEvent>> {
    let targets = memberships::webhook_targets(conn, &account.uuid).await?;
    let mut out = Vec::with_capacity(targets.len());
    for t in targets {
        let data = json!({
            "uuid": account.uuid, "membership_id": t.membership_id, "kind": account.kind,
            "old_id": old_id, "new_id": new_id,
        });
        out.push(
            insert_event(
                conn,
                WebhookTargetKind::App,
                &t.app_id,
                Some(&account.uuid),
                &t.webhook_url,
                types::ACCOUNT_ID_CHANGED,
                data,
            )
            .await?,
        );
    }
    Ok(out)
}

/// `silicon.id_changed` to the Silicon's own webhook: `{uuid, old_id, new_id}`.
pub async fn silicon_id_changed(
    conn: &mut PgConnection,
    silicon: &Account,
    old_id: &str,
    new_id: &str,
) -> ApiResult<Option<EmittedEvent>> {
    emit_to_silicon(
        conn,
        &silicon.uuid,
        types::SILICON_ID_CHANGED,
        json!({"uuid": silicon.uuid, "old_id": old_id, "new_id": new_id}),
    )
    .await
}

/// Every id-change notification: `account.id_changed` to the account's member apps, plus
/// `silicon.id_changed` to a Silicon's own webhook, or for a Carbon,
/// [`custodian_id_changed`] for the Silicons it is custodian of.
pub async fn notify_id_changed(
    conn: &mut PgConnection,
    account: &Account,
    old_id: &str,
    new_id: &str,
) -> ApiResult<Vec<EmittedEvent>> {
    let mut out = account_id_changed(conn, account, old_id, new_id).await?;
    match account.kind {
        AccountKind::Silicon => {
            out.extend(silicon_id_changed(conn, account, old_id, new_id).await?);
        }
        AccountKind::Carbon => out.extend(custodian_id_changed(conn, &account.uuid).await?),
    }
    Ok(out)
}

/// A Carbon's c:id changed. Apps see a Silicon's custodian as `{uuid, id}` (token responses,
/// lookups, `account.updated`), so each live Silicon this Carbon is custodian of gets its
/// version bumped and `account.updated` with `changed: ["custodian"]` to its member apps (and
/// `silicon.updated` to its own webhook), carrying the custodian's new c:id. Call it after the
/// id change, in the same transaction.
pub async fn custodian_id_changed(
    conn: &mut PgConnection,
    carbon_uuid: &str,
) -> ApiResult<Vec<EmittedEvent>> {
    let silicons: Vec<String> = sqlx::query_scalar(
        "select uuid from accounts where kind = 'silicon' and custodian_uuid = $1 \
         and status <> 'deleted' order by uuid",
    )
    .bind(carbon_uuid)
    .fetch_all(&mut *conn)
    .await?;
    let mut out = Vec::new();
    for uuid in silicons {
        let silicon = crate::repo::accounts::bump_version(conn, &uuid).await?;
        out.extend(notify_profile_updated(conn, &silicon, &[AccountField::Custodian]).await?);
    }
    Ok(out)
}

/// `account.updated` to member apps that can see at least one changed field:
/// `{uuid, membership_id, changed:[visible fields], account: AccountForApp (their scopes)}`.
pub async fn account_updated(
    conn: &mut PgConnection,
    account: &Account,
    changed: &[AccountField],
) -> ApiResult<Vec<EmittedEvent>> {
    if changed.is_empty() {
        return Ok(Vec::new());
    }
    let targets = memberships::webhook_targets(conn, &account.uuid).await?;
    if targets.is_empty() {
        return Ok(Vec::new());
    }
    let (email, phone) = if account.kind == AccountKind::Carbon {
        (
            contacts::primary_email(conn, &account.uuid).await?,
            contacts::primary_phone(conn, &account.uuid).await?,
        )
    } else {
        (None, None)
    };
    let custodian = custodian_ref(conn, account).await?;
    let mut out = Vec::new();
    for t in targets {
        let scopes = t.scopes();
        let visible: Vec<AccountField> = changed
            .iter()
            .copied()
            .filter(|f| f.required_scope().is_none_or(|s| scopes.contains(&s)))
            .filter(|f| {
                account.kind == AccountKind::Carbon
                    || !matches!(f, AccountField::Email | AccountField::Phone)
            })
            .collect();
        if visible.is_empty() {
            continue;
        }
        let view = AccountForApp::build(
            account,
            &t.app_id,
            &scopes,
            email.clone(),
            phone.clone(),
            custodian.clone(),
        );
        let data = json!({
            "uuid": account.uuid, "membership_id": t.membership_id, "changed": visible, "account": view,
        });
        out.push(
            insert_event(
                conn,
                WebhookTargetKind::App,
                &t.app_id,
                Some(&account.uuid),
                &t.webhook_url,
                types::ACCOUNT_UPDATED,
                data,
            )
            .await?,
        );
    }
    Ok(out)
}

/// `silicon.updated` to the Silicon's own webhook: `{uuid, id, changed, silicon: Me}`.
pub async fn silicon_updated(
    conn: &mut PgConnection,
    silicon: &Account,
    changed: &[AccountField],
) -> ApiResult<Option<EmittedEvent>> {
    if changed.is_empty() {
        return Ok(None);
    }
    let custodian = match &silicon.custodian_uuid {
        Some(c) => crate::repo::accounts::get(conn, c)
            .await?
            .as_ref()
            .map(AccountSummary::from_account),
        None => None,
    };
    let me = MeView::silicon(silicon, custodian);
    emit_to_silicon(
        conn,
        &silicon.uuid,
        types::SILICON_UPDATED,
        json!({
            "uuid": silicon.uuid, "id": silicon.handle, "changed": changed, "silicon": me,
        }),
    )
    .await
}

/// Both profile-change notifications (apps, and the Silicon itself when it is one).
pub async fn notify_profile_updated(
    conn: &mut PgConnection,
    account: &Account,
    changed: &[AccountField],
) -> ApiResult<Vec<EmittedEvent>> {
    let mut out = account_updated(conn, account, changed).await?;
    if account.kind == AccountKind::Silicon {
        out.extend(silicon_updated(conn, account, changed).await?);
    }
    Ok(out)
}

/// `account.deleted` to every member app: `{uuid, membership_id}`.
pub async fn account_deleted(
    conn: &mut PgConnection,
    account_uuid: &str,
) -> ApiResult<Vec<EmittedEvent>> {
    let targets = memberships::webhook_targets(conn, account_uuid).await?;
    let mut out = Vec::with_capacity(targets.len());
    for t in targets {
        let data = json!({"uuid": account_uuid, "membership_id": t.membership_id});
        out.push(
            insert_event(
                conn,
                WebhookTargetKind::App,
                &t.app_id,
                Some(account_uuid),
                &t.webhook_url,
                types::ACCOUNT_DELETED,
                data,
            )
            .await?,
        );
    }
    Ok(out)
}

/// `membership.signed_out` to one app: `{uuid, membership_id, reason}` (see [`signout_reason`]).
pub async fn membership_signed_out(
    conn: &mut PgConnection,
    app_id: &str,
    account_uuid: &str,
    reason: &str,
) -> ApiResult<Option<EmittedEvent>> {
    let data = json!({
        "uuid": account_uuid, "membership_id": crate::ids::membership_id(app_id, account_uuid), "reason": reason,
    });
    emit_to_app(
        conn,
        app_id,
        types::MEMBERSHIP_SIGNED_OUT,
        Some(account_uuid),
        data,
    )
    .await
}

/// `membership.signed_out` once per distinct app of revoked families (e.g. after an STK rotation).
pub async fn signed_out_for_families(
    conn: &mut PgConnection,
    families: &[crate::repo::tokens::TokenFamily],
    reason: &str,
) -> ApiResult<Vec<EmittedEvent>> {
    let mut seen: Vec<(&str, &str)> = Vec::new();
    let mut out = Vec::new();
    for f in families {
        let key = (f.app_id.as_str(), f.account_uuid.as_str());
        if f.app_id == crate::FIRST_PARTY_APP_ID || seen.contains(&key) {
            continue;
        }
        seen.push(key);
        out.extend(membership_signed_out(conn, &f.app_id, &f.account_uuid, reason).await?);
    }
    Ok(out)
}

/// `membership.access_removed` to one app: `{uuid, membership_id}`.
pub async fn membership_access_removed(
    conn: &mut PgConnection,
    app_id: &str,
    account_uuid: &str,
) -> ApiResult<Option<EmittedEvent>> {
    let data = json!({"uuid": account_uuid, "membership_id": crate::ids::membership_id(app_id, account_uuid)});
    emit_to_app(
        conn,
        app_id,
        types::MEMBERSHIP_ACCESS_REMOVED,
        Some(account_uuid),
        data,
    )
    .await
}

/// `silicon.custodian_changed` to every member app of the Silicon:
/// `{uuid, membership_id, from: AccountSummary, to: AccountSummary}`.
pub async fn silicon_custodian_changed(
    conn: &mut PgConnection,
    silicon: &Account,
    from: &AccountSummary,
    to: &AccountSummary,
) -> ApiResult<Vec<EmittedEvent>> {
    let targets = memberships::webhook_targets(conn, &silicon.uuid).await?;
    let mut out = Vec::with_capacity(targets.len());
    for t in targets {
        let data =
            json!({"uuid": silicon.uuid, "membership_id": t.membership_id, "from": from, "to": to});
        out.push(
            insert_event(
                conn,
                WebhookTargetKind::App,
                &t.app_id,
                Some(&silicon.uuid),
                &t.webhook_url,
                types::SILICON_CUSTODIAN_CHANGED,
                data,
            )
            .await?,
        );
    }
    Ok(out)
}

/// A transfer completed: `silicon.custodian_changed` to member apps and
/// `silicon.custodian.changed` (`{uuid, id, from, to}`) to the Silicon.
pub async fn notify_custodian_changed(
    conn: &mut PgConnection,
    silicon: &Account,
    from: &AccountSummary,
    to: &AccountSummary,
) -> ApiResult<Vec<EmittedEvent>> {
    let mut out = silicon_custodian_changed(conn, silicon, from, to).await?;
    out.extend(
        emit_to_silicon(
            conn,
            &silicon.uuid,
            types::SILICON_OWN_CUSTODIAN_CHANGED,
            json!({
                "uuid": silicon.uuid, "id": silicon.handle, "from": from, "to": to,
            }),
        )
        .await?,
    );
    Ok(out)
}

/// `silicon.custodian.declined` to a self-created Silicon's own webhook: `{uuid, id, request_id,
/// custodian, decided_at, reason, released: true}`. `custodian` labels the Carbon it asked (its
/// c:id, or the masked email it was named by); `reason` is a [`declined_reason`]. Emit it before
/// the Silicon is released (`repo::accounts::release_silicon`), while it still has its id; the
/// release keeps the webhook so the worker can deliver this.
pub async fn silicon_custodian_declined(
    conn: &mut PgConnection,
    silicon: &Account,
    request_id: Uuid,
    custodian_label: &str,
    decided_at: Option<OffsetDateTime>,
    reason: &str,
) -> ApiResult<Option<EmittedEvent>> {
    emit_to_silicon(
        conn,
        &silicon.uuid,
        types::SILICON_CUSTODIAN_DECLINED,
        json!({
            "uuid": silicon.uuid, "id": silicon.handle, "request_id": request_id.to_string(),
            "custodian": custodian_label,
            "decided_at": decided_at.map(crate::timefmt::format_rfc3339_ms),
            "reason": reason,
            "released": true,
        }),
    )
    .await
}

/// `silicon.custodian.expired` to a self-created Silicon's own webhook: `{uuid, id, request_id,
/// custodian, expired_at, released: true}` (nobody accepted within 14 days). Emit it before the
/// release, like [`silicon_custodian_declined`].
pub async fn silicon_custodian_expired(
    conn: &mut PgConnection,
    silicon: &Account,
    request_id: Uuid,
    custodian_label: &str,
    expired_at: OffsetDateTime,
) -> ApiResult<Option<EmittedEvent>> {
    emit_to_silicon(
        conn,
        &silicon.uuid,
        types::SILICON_CUSTODIAN_EXPIRED,
        json!({
            "uuid": silicon.uuid, "id": silicon.handle, "request_id": request_id.to_string(),
            "custodian": custodian_label,
            "expired_at": crate::timefmt::format_rfc3339_ms(expired_at),
            "released": true,
        }),
    )
    .await
}

/// `ping` to an app (`{}`), for the webhook test button.
pub async fn ping_app(conn: &mut PgConnection, app_id: &str) -> ApiResult<Option<EmittedEvent>> {
    emit_to_app(conn, app_id, types::PING, None, json!({})).await
}

/// `ping` to a Silicon's own webhook.
pub async fn ping_silicon(
    conn: &mut PgConnection,
    silicon_uuid: &str,
) -> ApiResult<Option<EmittedEvent>> {
    emit_to_silicon(conn, silicon_uuid, types::PING, json!({})).await
}

async fn custodian_ref(
    conn: &mut PgConnection,
    account: &Account,
) -> ApiResult<Option<CustodianRef>> {
    match (&account.kind, &account.custodian_uuid) {
        (AccountKind::Silicon, Some(c)) => {
            let id = crate::repo::accounts::get(conn, c)
                .await?
                .and_then(|a| a.handle);
            Ok(Some(CustodianRef {
                uuid: c.clone(),
                id,
            }))
        }
        _ => Ok(None),
    }
}

/// The current webhook URL of a target (deliveries and replays go to the current URL).
pub async fn current_url(
    conn: &mut PgConnection,
    target_kind: WebhookTargetKind,
    target_id: &str,
) -> ApiResult<Option<String>> {
    Ok(match target_kind {
        WebhookTargetKind::App => crate::repo::apps::webhook_target(conn, target_id)
            .await?
            .map(|(u, _)| u),
        WebhookTargetKind::Silicon => {
            sqlx::query_scalar("select webhook_url from accounts where uuid = $1")
                .bind(target_id)
                .fetch_optional(&mut *conn)
                .await?
                .flatten()
        }
    })
}

/// The current signing secret of a target (decrypted), used to sign deliveries.
pub async fn current_secret(
    conn: &mut PgConnection,
    keyring: &Keyring,
    target_kind: WebhookTargetKind,
    target_id: &str,
) -> ApiResult<Option<String>> {
    let enc: Option<Vec<u8>> = match target_kind {
        WebhookTargetKind::App => crate::repo::apps::webhook_target(conn, target_id)
            .await?
            .and_then(|(_, s)| s),
        WebhookTargetKind::Silicon => {
            sqlx::query_scalar("select webhook_secret_enc from accounts where uuid = $1")
                .bind(target_id)
                .fetch_optional(&mut *conn)
                .await?
                .flatten()
        }
    };
    match enc {
        Some(bytes) => Ok(Some(keyring.decrypt_string(&bytes)?)),
        None => Ok(None),
    }
}

/// Generates a webhook signing secret (`whsec_…`) and its keyring ciphertext.
pub fn new_webhook_secret(keyring: &Keyring) -> ApiResult<(String, Vec<u8>)> {
    let secret = crate::crypto::random_token(crate::crypto::prefix::WEBHOOK_SECRET);
    let enc = keyring.encrypt_str(&secret)?;
    Ok((secret, enc))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn payload_shape() {
        let id = Uuid::now_v7();
        let p = build_payload(
            id,
            types::PING,
            time::macros::datetime!(2026-10-06 12:00 UTC),
            Some("briefcase"),
            None,
            json!({}),
        );
        assert_eq!(p["event_id"], id.to_string());
        assert_eq!(p["type"], "ping");
        assert_eq!(p["occurred_at"], "2026-10-06T12:00:00.000Z");
        assert_eq!(p["app_id"], "briefcase");
        assert_eq!(p["silicon"], Value::Null);
        assert_eq!(p["data"], json!({}));
    }

    #[test]
    fn retry_schedule() {
        let s: Vec<i64> = (1..=9).map(retry_delay_seconds).collect();
        assert_eq!(s, vec![10, 30, 60, 300, 900, 1800, 3600, 3600, 3600]);
    }
}
