//! Webhook events. Emitting writes one `webhook_events` row per (event, target) holding the
//! exact JSON body that will be signed and sent, plus one `pending` `webhook_deliveries` row;
//! the worker delivers (see the constants and [`retry_delay_seconds`]).
//!
//! Body: `{"event_id","type","occurred_at","app_id","silicon","data"}` — `app_id` is the target
//! app for app webhooks, `silicon` the target Silicon's uuid for Silicon webhooks.
//!
//! App events go to every *active subscription* (see `repo::subscriptions`) of every app with a
//! *live* membership (`active` or `imported`): its webhook (while it has a URL) and its event
//! stream. Each subscription gets its own row, filtered by the updates it picked, and only the
//! webhook's rows get a delivery. A disabled app gets its events too: the worker holds their
//! deliveries until the app is re-enabled (or the delivery window ends, after which they can be
//! replayed), so the app never misses a change made while it was disabled.
//!
//! Silicon events are always recorded (the Silicon reads them on `GET /v1/events/stream`, its
//! custodian too); they get a delivery when the Silicon has a webhook URL.
//!
//! Call these helpers inside the same transaction as the change so events exist exactly when the
//! change commits. They return the deliveries they queued.

use serde_json::{Value, json};
use sqlx::PgConnection;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::crypto::Keyring;
use crate::error::ApiResult;
use crate::models::{Account, AccountField, AccountKind, SubscriptionDelivery, WebhookTargetKind};
use crate::repo::memberships::MemberTarget;
use crate::repo::{contacts, memberships, subscriptions};
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
    /// A trust relationship for outside OIDC tokens was added to the Silicon.
    pub const SILICON_FEDERATION_ADDED: &str = "silicon.federation.added";
    /// A trust relationship was removed (the sign-ins it started ended).
    pub const SILICON_FEDERATION_REMOVED: &str = "silicon.federation.removed";
    /// The custodian changed the audiences the Silicon may get identity tokens for.
    pub const SILICON_IDENTITY_AUDIENCES_CHANGED: &str = "silicon.identity_audiences.changed";
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

/// The updates an app can pick for a subscription (the Silicon Apps "Updates from Silicon
/// Accounts" table). A subscription with no list (`null`) receives every update.
pub const APP_UPDATE_CHOICES: &[&str] = &[
    "id_change",
    "display_name_change",
    "pfp_change",
    "timezone_change",
    "email_change",
    "phone_change",
    "custodian_change",
    "access_removed",
    "account_deleted",
];

/// The updates picked for a new subscription when it names none.
pub const DEFAULT_UPDATES: &[&str] = &[
    "id_change",
    "display_name_change",
    "pfp_change",
    "access_removed",
    "account_deleted",
];

/// Every event type an app can receive, in a stable order.
pub const APP_EVENT_TYPES: &[&str] = &[
    types::ACCOUNT_ID_CHANGED,
    types::ACCOUNT_UPDATED,
    types::ACCOUNT_DELETED,
    types::MEMBERSHIP_SIGNED_OUT,
    types::MEMBERSHIP_ACCESS_REMOVED,
    types::SILICON_CUSTODIAN_CHANGED,
    types::PING,
];

/// Every event type a Silicon (and its custodian) can receive.
pub const SILICON_EVENT_TYPES: &[&str] = &[
    types::SILICON_CREATED,
    types::SILICON_CUSTODIAN_ACCEPTED,
    types::SILICON_CUSTODIAN_DECLINED,
    types::SILICON_CUSTODIAN_EXPIRED,
    types::SILICON_UPDATED,
    types::SILICON_ID_CHANGED,
    types::SILICON_STK_ROTATED,
    types::SILICON_OWN_CUSTODIAN_CHANGED,
    types::SILICON_FEDERATION_ADDED,
    types::SILICON_FEDERATION_REMOVED,
    types::SILICON_IDENTITY_AUDIENCES_CHANGED,
    types::PING,
];

/// The event types an update brings. `account.updated` carries the profile changes (each its
/// own update, listed in `changed`); a custodian's new c:id reaches apps as `account.updated`
/// with `changed: ["custodian"]`.
pub fn update_event_types(choice: &str) -> &'static [&'static str] {
    match choice {
        "id_change" => &[types::ACCOUNT_ID_CHANGED],
        "display_name_change"
        | "pfp_change"
        | "timezone_change"
        | "email_change"
        | "phone_change" => &[types::ACCOUNT_UPDATED],
        "custodian_change" => &[types::ACCOUNT_UPDATED, types::SILICON_CUSTODIAN_CHANGED],
        "access_removed" => &[
            types::MEMBERSHIP_SIGNED_OUT,
            types::MEMBERSHIP_ACCESS_REMOVED,
        ],
        "account_deleted" => &[types::ACCOUNT_DELETED],
        _ => &[],
    }
}

/// The event types a subscription with these updates receives (`None` = every update), in
/// [`APP_EVENT_TYPES`] order. `ping` (a test) always arrives.
pub fn event_types_for_updates(updates: Option<&[String]>) -> Vec<&'static str> {
    APP_EVENT_TYPES
        .iter()
        .copied()
        .filter(|t| {
            *t == types::PING
                || updates
                    .is_none_or(|items| items.iter().any(|u| update_event_types(u).contains(t)))
        })
        .collect()
}

/// The update an app event belongs to (`None` for `ping`, which every subscription gets, and
/// for `account.updated`, which is decided per changed field).
fn event_update(event_type: &str) -> Option<&'static str> {
    match event_type {
        types::ACCOUNT_ID_CHANGED => Some("id_change"),
        types::ACCOUNT_DELETED => Some("account_deleted"),
        types::MEMBERSHIP_SIGNED_OUT | types::MEMBERSHIP_ACCESS_REMOVED => Some("access_removed"),
        types::SILICON_CUSTODIAN_CHANGED => Some("custodian_change"),
        _ => None,
    }
}

fn update_choice(field: &AccountField) -> &str {
    match field {
        AccountField::DisplayName => "display_name_change",
        AccountField::PfpUrl => "pfp_change",
        AccountField::Timezone => "timezone_change",
        AccountField::Email => "email_change",
        AccountField::Phone => "phone_change",
        AccountField::Custodian => "custodian_change",
        _ => "other",
    }
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

/// Where one event row goes: the receiver, the subscription it was recorded for (apps), and
/// the URL a delivery is queued to (none for a stream, or a Silicon without a webhook).
struct Destination<'a> {
    target_kind: WebhookTargetKind,
    target_id: &'a str,
    subscription_id: Option<Uuid>,
    delivery_url: Option<&'a str>,
}

impl<'a> Destination<'a> {
    fn member(t: &'a MemberTarget) -> Self {
        Destination {
            target_kind: WebhookTargetKind::App,
            target_id: &t.app_id,
            subscription_id: Some(t.subscription_id),
            delivery_url: match t.delivery {
                SubscriptionDelivery::Webhook => t.webhook_url.as_deref(),
                SubscriptionDelivery::Stream => None,
            },
        }
    }
}

/// Writes one event row and, with a delivery URL, its pending delivery (returned).
async fn record_event(
    conn: &mut PgConnection,
    to: Destination<'_>,
    account_uuid: Option<&str>,
    event_type: &str,
    data: Value,
) -> ApiResult<Option<EmittedEvent>> {
    Ok(
        record_event_with_id(conn, to, account_uuid, event_type, data)
            .await?
            .1,
    )
}

/// [`record_event`], also returning the event id.
async fn record_event_with_id(
    conn: &mut PgConnection,
    to: Destination<'_>,
    account_uuid: Option<&str>,
    event_type: &str,
    data: Value,
) -> ApiResult<(Uuid, Option<EmittedEvent>)> {
    let event_id = Uuid::now_v7();
    let occurred_at = OffsetDateTime::now_utc();
    let (app_id, silicon) = match to.target_kind {
        WebhookTargetKind::App => (Some(to.target_id), None),
        WebhookTargetKind::Silicon => (None, Some(to.target_id)),
    };
    let payload = build_payload(event_id, event_type, occurred_at, app_id, silicon, data);
    sqlx::query(
        "insert into webhook_events (event_id, type, target_kind, target_id, account_uuid, payload, occurred_at, subscription_id) \
         values ($1, $2, $3, $4, $5, $6, $7, $8)",
    )
    .bind(event_id)
    .bind(event_type)
    .bind(to.target_kind)
    .bind(to.target_id)
    .bind(account_uuid)
    .bind(&payload)
    .bind(occurred_at)
    .bind(to.subscription_id)
    .execute(&mut *conn)
    .await?;
    let Some(url) = to.delivery_url else {
        return Ok((event_id, None));
    };
    let delivery_id = Uuid::now_v7();
    sqlx::query(
        "insert into webhook_deliveries (id, event_id, target_kind, target_id, url, status) values ($1, $2, $3, $4, $5, 'pending')",
    )
    .bind(delivery_id)
    .bind(event_id)
    .bind(to.target_kind)
    .bind(to.target_id)
    .bind(url)
    .execute(&mut *conn)
    .await?;
    Ok((
        event_id,
        Some(EmittedEvent {
            event_id,
            delivery_id,
            target_kind: to.target_kind,
            target_id: to.target_id.to_string(),
            event_type: event_type.to_string(),
        }),
    ))
}

/// One app's active subscriptions as event destinations: (subscription id, delivery, updates,
/// webhook URL), the webhook first.
#[derive(sqlx::FromRow)]
struct AppTarget {
    subscription_id: Uuid,
    delivery: SubscriptionDelivery,
    updates: Option<Value>,
    webhook_url: Option<String>,
}

impl AppTarget {
    fn wants(&self, event_type: &str) -> bool {
        event_update(event_type).is_none_or(|choice| {
            subscriptions::wants(
                subscriptions::updates_from_json(self.updates.as_ref()).as_deref(),
                choice,
            )
        })
    }

    fn destination<'a>(&'a self, app_id: &'a str) -> Destination<'a> {
        Destination {
            target_kind: WebhookTargetKind::App,
            target_id: app_id,
            subscription_id: Some(self.subscription_id),
            delivery_url: match self.delivery {
                SubscriptionDelivery::Webhook => self.webhook_url.as_deref(),
                SubscriptionDelivery::Stream => None,
            },
        }
    }
}

async fn app_targets(conn: &mut PgConnection, app_id: &str) -> ApiResult<Vec<AppTarget>> {
    Ok(sqlx::query_as(
        "select s.id as subscription_id, s.delivery, s.updates, c.webhook_url \
         from app_event_subscriptions s left join app_signin_configs c on c.app_id = s.app_id \
         where s.app_id = $1 and s.status = 'active' \
           and (s.delivery = 'stream' or c.webhook_url is not null) \
         order by s.delivery desc",
    )
    .bind(app_id)
    .fetch_all(&mut *conn)
    .await?)
}

/// Emits an event to one app: a row for each of its active subscriptions that wants it, and a
/// delivery for its webhook. Does not check memberships. Returns the webhook delivery.
pub async fn emit_to_app(
    conn: &mut PgConnection,
    app_id: &str,
    event_type: &str,
    account_uuid: Option<&str>,
    data: Value,
) -> ApiResult<Option<EmittedEvent>> {
    let mut queued = None;
    for t in app_targets(conn, app_id).await? {
        if !t.wants(event_type) {
            continue;
        }
        let emitted = record_event(
            conn,
            t.destination(app_id),
            account_uuid,
            event_type,
            data.clone(),
        )
        .await?;
        queued = queued.or(emitted);
    }
    Ok(queued)
}

/// Emits a `ping` to one subscription of an app, whatever its status (a test the app asked
/// for): `(event_id, delivery)`, the delivery when it is the webhook.
pub async fn ping_subscription(
    conn: &mut PgConnection,
    subscription: &subscriptions::Subscription,
) -> ApiResult<(Uuid, Option<EmittedEvent>)> {
    let url = match subscription.delivery {
        SubscriptionDelivery::Webhook => {
            crate::repo::apps::webhook_target(conn, &subscription.app_id)
                .await?
                .map(|(u, _)| u)
        }
        SubscriptionDelivery::Stream => None,
    };
    record_event_with_id(
        conn,
        Destination {
            target_kind: WebhookTargetKind::App,
            target_id: &subscription.app_id,
            subscription_id: Some(subscription.id),
            delivery_url: url.as_deref(),
        },
        None,
        types::PING,
        json!({}),
    )
    .await
}

/// Records an event for a Silicon (it reads it on the event stream) and queues a delivery to its
/// own webhook when it has one (returned).
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
    record_event(
        conn,
        Destination {
            target_kind: WebhookTargetKind::Silicon,
            target_id: silicon_uuid,
            subscription_id: None,
            delivery_url: url.as_deref(),
        },
        Some(silicon_uuid),
        event_type,
        data,
    )
    .await
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
        if !t.wants("id_change") {
            continue;
        }
        let data = json!({
            "uuid": account.uuid, "membership_id": t.membership_id, "kind": account.kind,
            "old_id": old_id, "new_id": new_id,
        });
        out.extend(
            record_event(
                conn,
                Destination::member(&t),
                Some(&account.uuid),
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
        let selected = t.updates();
        let scopes = t.scopes();
        let visible: Vec<AccountField> = changed
            .iter()
            .copied()
            .filter(|f| {
                selected
                    .as_ref()
                    .is_none_or(|items| items.iter().any(|item| item == update_choice(f)))
            })
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
        out.extend(
            record_event(
                conn,
                Destination::member(&t),
                Some(&account.uuid),
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
        if !t.wants("account_deleted") {
            continue;
        }
        let data = json!({"uuid": account_uuid, "membership_id": t.membership_id});
        out.extend(
            record_event(
                conn,
                Destination::member(&t),
                Some(account_uuid),
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
        if !t.wants("custodian_change") {
            continue;
        }
        let data =
            json!({"uuid": silicon.uuid, "membership_id": t.membership_id, "from": from, "to": to});
        out.extend(
            record_event(
                conn,
                Destination::member(&t),
                Some(&silicon.uuid),
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

/// `ping` to an app's webhook (`{}`), for the webhook test button (paused or not). `None` when
/// the app has no webhook URL.
pub async fn ping_app(conn: &mut PgConnection, app_id: &str) -> ApiResult<Option<EmittedEvent>> {
    if crate::repo::apps::webhook_target(conn, app_id)
        .await?
        .is_none()
    {
        return Ok(None);
    }
    match subscriptions::by_delivery(conn, app_id, SubscriptionDelivery::Webhook).await? {
        Some(webhook) => Ok(ping_subscription(conn, &webhook).await?.1),
        None => Err(crate::ApiError::internal(format!(
            "the app '{app_id}' has a webhook URL but no webhook subscription"
        ))),
    }
}

/// `ping` to a Silicon's own webhook. `None` (and nothing recorded) when it has no webhook URL.
pub async fn ping_silicon(
    conn: &mut PgConnection,
    silicon_uuid: &str,
) -> ApiResult<Option<EmittedEvent>> {
    let url: Option<String> =
        sqlx::query_scalar("select webhook_url from accounts where uuid = $1 and kind = 'silicon'")
            .bind(silicon_uuid)
            .fetch_optional(&mut *conn)
            .await?
            .flatten();
    if url.is_none() {
        return Ok(None);
    }
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
    fn updates_map_onto_event_types() {
        assert_eq!(event_types_for_updates(None), APP_EVENT_TYPES.to_vec());
        let defaults: Vec<String> = DEFAULT_UPDATES.iter().map(|s| s.to_string()).collect();
        assert_eq!(
            event_types_for_updates(Some(&defaults)),
            vec![
                "account.id_changed",
                "account.updated",
                "account.deleted",
                "membership.signed_out",
                "membership.access_removed",
                "ping"
            ]
        );
        assert_eq!(event_types_for_updates(Some(&[])), vec!["ping"]);
        assert_eq!(
            event_types_for_updates(Some(&["custodian_change".to_string()])),
            vec!["account.updated", "silicon.custodian_changed", "ping"]
        );
        for choice in APP_UPDATE_CHOICES {
            assert!(!update_event_types(choice).is_empty(), "{choice}");
        }
        assert_eq!(event_update(types::PING), None);
        assert_eq!(
            event_update(types::MEMBERSHIP_SIGNED_OUT),
            Some("access_removed")
        );
        for field in AccountField::ALL {
            let choice = update_choice(field);
            assert!(
                choice == "other" || APP_UPDATE_CHOICES.contains(&choice),
                "{field:?}"
            );
        }
    }

    #[test]
    fn retry_schedule() {
        let s: Vec<i64> = (1..=9).map(retry_delay_seconds).collect();
        assert_eq!(s, vec![10, 30, 60, 300, 900, 1800, 3600, 3600, 3600]);
    }
}
