//! Response shapes of this crate.
//!
//! - [`SiliconItem`]: a Silicon as its custodian sees it — the `Me` Silicon view flattened, plus
//!   `pending_transfer`.
//! - [`RequestView`]: a custodian request as Carbons see it (incoming requests, a new transfer).
//! - [`RequestStatusView`]: a custodian request as the Silicon polling it sees it.
//! - [`RequestInfo`]: the request block of a self-create response.

use accounts_core::error::ApiResult;
use accounts_core::models::Account;
use accounts_core::normalize::mask_email;
use accounts_core::repo::accounts;
use accounts_core::timefmt::{rfc3339_ms, rfc3339_ms_option};
use accounts_core::views::{AccountSummary, MeView, load_me};
use serde::Serialize;
use serde_json::{Value, json};
use sqlx::PgConnection;
use time::OffsetDateTime;

use crate::requests::{self, CustodianRequest, status};

/// A Silicon in its custodian's list: the Silicon `Me` view plus any pending transfer.
#[derive(Debug, Clone, Serialize)]
pub struct SiliconItem {
    #[serde(flatten)]
    pub silicon: MeView,
    pub pending_transfer: Option<PendingTransferView>,
}

/// A transfer waiting for the receiving Carbon.
#[derive(Debug, Clone, Serialize)]
pub struct PendingTransferView {
    pub id: String,
    /// The receiving Carbon: an AccountSummary, or `{"email": …}` when named by email.
    pub to: Value,
    #[serde(with = "rfc3339_ms")]
    pub created_at: OffsetDateTime,
    #[serde(with = "rfc3339_ms")]
    pub expires_at: OffsetDateTime,
}

/// A custodian request as Carbons see it.
#[derive(Debug, Clone, Serialize)]
pub struct RequestView {
    pub id: String,
    /// `initial` (a self-created Silicon asks for a custodian) or `transfer`.
    pub kind: String,
    pub status: String,
    pub silicon: AccountSummary,
    /// The current custodian (transfers); null for initial requests.
    pub from: Option<AccountSummary>,
    /// The Carbon asked: an AccountSummary, or `{"email": …}` when named by email.
    pub to: Value,
    #[serde(with = "rfc3339_ms")]
    pub created_at: OffsetDateTime,
    #[serde(with = "rfc3339_ms")]
    pub expires_at: OffsetDateTime,
    #[serde(with = "rfc3339_ms_option")]
    pub decided_at: Option<OffsetDateTime>,
}

/// The Silicon of a [`RequestStatusView`].
#[derive(Debug, Clone, Serialize)]
pub struct RequestSilicon {
    pub uuid: String,
    /// Null once the Silicon was released (declined or expired).
    pub id: Option<String>,
    pub status: String,
}

/// `GET /v1/silicons/requests/{id}`: the request as the Silicon polling it sees it.
#[derive(Debug, Clone, Serialize)]
pub struct RequestStatusView {
    pub id: String,
    pub kind: String,
    /// `pending`, `accepted`, `declined`, `expired` or `cancelled`.
    pub status: String,
    /// Who was asked: the Carbon's current c:id, or the masked email it was named by.
    pub custodian: String,
    #[serde(with = "rfc3339_ms")]
    pub created_at: OffsetDateTime,
    #[serde(with = "rfc3339_ms")]
    pub expires_at: OffsetDateTime,
    #[serde(with = "rfc3339_ms_option")]
    pub decided_at: Option<OffsetDateTime>,
    pub silicon: RequestSilicon,
}

/// The request block of a self-create response.
#[derive(Debug, Clone, Serialize)]
pub struct RequestInfo {
    pub id: String,
    pub kind: String,
    pub status: String,
    #[serde(with = "rfc3339_ms")]
    pub expires_at: OffsetDateTime,
    /// `c:saket`, or the masked email (`s***@example.com`) the custodian was named by.
    pub custodian: String,
}

/// The `Me` Silicon view plus its pending transfer.
pub async fn silicon_item(conn: &mut PgConnection, silicon: &Account) -> ApiResult<SiliconItem> {
    let mut items = silicon_items(conn, std::slice::from_ref(silicon), None).await?;
    items
        .pop()
        .ok_or_else(|| accounts_core::ApiError::internal("silicon_items returned no item"))
}

/// [`silicon_item`] for many Silicons: one query for their pending transfers, and no lookup of
/// the custodian when it is `custodian` (the caller's own list).
pub async fn silicon_items(
    conn: &mut PgConnection,
    silicons: &[Account],
    custodian: Option<&Account>,
) -> ApiResult<Vec<SiliconItem>> {
    let uuids: Vec<String> = silicons.iter().map(|s| s.uuid.clone()).collect();
    let transfers = requests::pending_transfers(conn, &uuids).await?;
    let mut out = Vec::with_capacity(silicons.len());
    for s in silicons {
        let pending_transfer = match transfers.iter().find(|r| r.silicon_uuid == s.uuid) {
            Some(r) => Some(PendingTransferView {
                id: r.id.to_string(),
                to: to_value(conn, r).await?,
                created_at: r.created_at,
                expires_at: r.expires_at,
            }),
            None => None,
        };
        let silicon = match custodian {
            Some(c) if s.custodian_uuid.as_deref() == Some(c.uuid.as_str()) => {
                MeView::silicon(s, Some(AccountSummary::from_account(c)))
            }
            _ => load_me(conn, s).await?,
        };
        out.push(SiliconItem {
            silicon,
            pending_transfer,
        });
    }
    Ok(out)
}

/// The Carbon a request names, for Carbon-facing views.
pub async fn to_value(conn: &mut PgConnection, r: &CustodianRequest) -> ApiResult<Value> {
    if let Some(email) = &r.to_email {
        return Ok(json!({ "email": email }));
    }
    match &r.to_uuid {
        Some(uuid) => Ok(match accounts::get(conn, uuid).await? {
            Some(a) => serde_json::to_value(AccountSummary::from_account(&a))?,
            None => json!({ "uuid": uuid }),
        }),
        None => Ok(Value::Null),
    }
}

/// Who a request asked, for Silicon-facing views: the masked email it was named by, or the
/// Carbon's current id.
pub async fn custodian_label(conn: &mut PgConnection, r: &CustodianRequest) -> ApiResult<String> {
    if let Some(email) = &r.to_email {
        return Ok(mask_email(email));
    }
    match &r.to_uuid {
        Some(uuid) => Ok(match accounts::get(conn, uuid).await? {
            Some(a) => a.display_id(),
            None => uuid.clone(),
        }),
        None => Ok(String::new()),
    }
}

/// The Carbon-facing view of a request.
pub async fn request_view(conn: &mut PgConnection, r: &CustodianRequest) -> ApiResult<RequestView> {
    let silicon = accounts::require(conn, &r.silicon_uuid).await?;
    let from = match &r.from_uuid {
        Some(uuid) => accounts::get(conn, uuid)
            .await?
            .as_ref()
            .map(AccountSummary::from_account),
        None => None,
    };
    Ok(RequestView {
        id: r.id.to_string(),
        kind: r.kind.clone(),
        status: effective_status(r).to_string(),
        silicon: AccountSummary::from_account(&silicon),
        from,
        to: to_value(conn, r).await?,
        created_at: r.created_at,
        expires_at: r.expires_at,
        decided_at: r.decided_at,
    })
}

/// The Silicon-facing view of a request.
pub async fn request_status_view(
    conn: &mut PgConnection,
    r: &CustodianRequest,
) -> ApiResult<RequestStatusView> {
    let silicon = accounts::require(conn, &r.silicon_uuid).await?;
    Ok(RequestStatusView {
        id: r.id.to_string(),
        kind: r.kind.clone(),
        status: effective_status(r).to_string(),
        custodian: custodian_label(conn, r).await?,
        created_at: r.created_at,
        expires_at: r.expires_at,
        decided_at: r.decided_at,
        silicon: RequestSilicon {
            uuid: silicon.uuid.clone(),
            id: silicon.handle.clone(),
            status: silicon.status.to_string(),
        },
    })
}

/// The request block of a self-create response.
pub async fn request_info(conn: &mut PgConnection, r: &CustodianRequest) -> ApiResult<RequestInfo> {
    Ok(RequestInfo {
        id: r.id.to_string(),
        kind: r.kind.clone(),
        status: effective_status(r).to_string(),
        expires_at: r.expires_at,
        custodian: custodian_label(conn, r).await?,
    })
}

/// The status to show: an overdue pending request is reported as expired even before the sweep
/// records it.
pub fn effective_status(r: &CustodianRequest) -> &str {
    if r.is_overdue() {
        status::EXPIRED
    } else {
        r.status.as_str()
    }
}
