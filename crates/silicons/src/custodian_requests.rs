//! Requests addressed to the signed-in Carbon (`session(carbon)`): a self-created Silicon asking
//! them to be its custodian, or a custodian asking them to take a Silicon over. A request is
//! addressed to a Carbon when it names their uuid, or an email verified on their account (so a
//! Carbon named by email before they signed up finds it waiting).
//!
//! - `GET /v1/me/custodian-requests` → pending requests, newest first (paginated)
//! - `POST /v1/me/custodian-requests/{id}/accept` → 204
//! - `POST /v1/me/custodian-requests/{id}/decline` → 204
//!
//! The effects of each decision are in [`crate::lifecycle`].

use accounts_core::error::{ApiError, ApiResult};
use accounts_core::http::{CarbonAuth, ClientMeta, Json, PageParams, Path, Query, paginate};
use accounts_core::state::AppState;
use accounts_core::timefmt::format_rfc3339_ms;
use accounts_core::views::Page;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};

use crate::common::{lock_own_account, parse_request_id, request_not_found};
use crate::history::Actor;
use crate::lifecycle;
use crate::requests;
use crate::views::{self, RequestView};

/// `GET /v1/me/custodian-requests`.
pub async fn list(
    State(state): State<AppState>,
    me: CarbonAuth,
    Query(page): Query<PageParams>,
) -> Result<Json<Page<RequestView>>, ApiError> {
    let limit = page.limit();
    let before = match page.cursor::<String>()? {
        Some(c) => Some(parse_request_id(&c).ok_or_else(|| {
            ApiError::bad_request("invalid_cursor", "The cursor is not valid for this list.")
                .hint("Pass the next_cursor value from the previous page unchanged, or omit cursor to start over.")
        })?),
        None => None,
    };
    let mut conn = state.db.acquire().await?;
    let rows = requests::addressed_to(&mut conn, me.uuid(), before, limit + 1).await?;
    let page = paginate(rows, limit, |r| r.id.to_string());
    let mut items = Vec::with_capacity(page.items.len());
    for r in &page.items {
        items.push(views::request_view(&mut conn, r).await?);
    }
    Ok(Json(Page::new(items, page.next_cursor)))
}

/// 410 `custodian_request_expired`.
fn expired(request: &requests::CustodianRequest) -> ApiError {
    ApiError::gone(
        "custodian_request_expired",
        format!(
            "This custodian request expired at {}: requests must be answered within 14 days.",
            format_rfc3339_ms(request.expires_at)
        ),
    )
    .hint(if request.is_initial() {
        "The Silicon was released; it can create its account again and name you once more."
    } else {
        "Nothing changed; its custodian can send a new transfer request."
    })
    .detail("expired_at", format_rfc3339_ms(request.expires_at))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Decision {
    Accept,
    Decline,
}

/// `POST /v1/me/custodian-requests/{id}/accept`.
pub async fn accept(
    State(state): State<AppState>,
    me: CarbonAuth,
    meta: ClientMeta,
    Path(raw_id): Path<String>,
) -> Result<Response, ApiError> {
    decide(&state, &me, &meta, &raw_id, Decision::Accept).await
}

/// `POST /v1/me/custodian-requests/{id}/decline`.
pub async fn decline(
    State(state): State<AppState>,
    me: CarbonAuth,
    meta: ClientMeta,
    Path(raw_id): Path<String>,
) -> Result<Response, ApiError> {
    decide(&state, &me, &meta, &raw_id, Decision::Decline).await
}

async fn decide(
    state: &AppState,
    me: &CarbonAuth,
    meta: &ClientMeta,
    raw_id: &str,
    decision: Decision,
) -> ApiResult<Response> {
    let id = parse_request_id(raw_id).ok_or_else(|| request_not_found(raw_id))?;
    let mut tx = state.db.begin().await?;
    // Locks: the request, then my own account, then (in `lifecycle`) the Silicon. Locking my
    // account serializes the decision with my own account deletion, which locks it before it
    // checks custody and removes my emails (see `common::lock_own_account`): a request named by
    // one of my emails is not among the requests the deletion locks, so without this an
    // acceptance could make a just-deleted account the custodian.
    let doing = match decision {
        Decision::Accept => "accept a custodian request",
        Decision::Decline => "decline a custodian request",
    };
    let request = requests::lock(&mut tx, id)
        .await?
        .ok_or_else(|| request_not_found(raw_id))?;
    let me_now = lock_own_account(&mut tx, &me.account, doing).await?;
    // Checked under the lock, so an email removed by a deletion that committed first no longer
    // counts.
    if !requests::is_addressed_to(&mut tx, &request, me.uuid()).await? {
        return Err(request_not_found(raw_id));
    }
    if request.status == requests::status::EXPIRED {
        return Err(expired(&request));
    }
    if !request.is_pending() {
        return Err(ApiError::conflict(
            "custodian_request_not_pending",
            format!(
                "This custodian request was already {}{}; only pending requests can be accepted or declined.",
                request.status,
                request
                    .decided_at
                    .map(|t| format!(" at {}", format_rfc3339_ms(t)))
                    .unwrap_or_default()
            ),
        )
        .hint("List the requests still waiting for you with GET /v1/me/custodian-requests.")
        .detail("status", request.status.clone()));
    }
    if request.is_overdue() {
        lifecycle::expire(&mut tx, &request).await?;
        tx.commit().await?;
        return Err(expired(&request));
    }
    let actor = Actor::account(me.uuid(), meta.ip.as_deref());
    match decision {
        Decision::Accept => lifecycle::accept(&mut tx, &request, &me_now, actor).await?,
        Decision::Decline => lifecycle::decline(&mut tx, &request, &me_now, actor).await?,
    }
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}
