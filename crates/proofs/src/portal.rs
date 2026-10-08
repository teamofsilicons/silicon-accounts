//! First-party, managed-app verification history. Families and audit events are durable;
//! raw proof tokens and their hashes are never returned or reconstructed here.

use accounts_core::http::{AccountAuth, Json, PageParams, Path, Query, paginate};
use accounts_core::timefmt::{rfc3339_ms, rfc3339_ms_option};
use accounts_core::views::{AppSummary, Page};
use accounts_core::{ApiError, AppState};
use axum::extract::State;
use axum::http::header::CACHE_CONTROL;
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use time::{Duration, OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

use crate::model::{MAX_ACCESS_TTL_SECONDS, MIN_ACCESS_TTL_SECONDS, ProofStatus};
use crate::store::{self, AppProofFilter};
use crate::views::AppProofItem;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ManagedQuery {
    app_id: Option<String>,
    status: Option<ProofStatus>,
    limit: Option<i64>,
    cursor: Option<String>,
}

#[derive(Serialize)]
struct ManagedVerification {
    #[serde(flatten)]
    proof: AppProofItem,
    issuing_app: AppSummary,
}

fn hidden() -> ApiError {
    ApiError::not_found(
        "verification_not_found",
        "No App verification history is available here for an app you manage.",
    )
}

pub async fn list(
    State(state): State<AppState>,
    who: AccountAuth,
    Query(q): Query<ManagedQuery>,
) -> Result<Response, ApiError> {
    let page = PageParams {
        limit: q.limit,
        cursor: q.cursor,
    };
    let limit = page.limit();
    let after = store::cursor_bounds(page.cursor()?)?;
    let mut conn = state.db.acquire().await?;
    if let Some(app_id) = &q.app_id
        && !store::manages_app(&mut conn, who.uuid(), app_id).await?
    {
        return Err(hidden());
    }
    let rows = store::list_managed(
        &mut conn,
        who.uuid(),
        q.app_id.as_deref(),
        &AppProofFilter {
            status: q.status.as_ref().map(ProofStatus::as_str),
            after,
            fetch: limit + 1,
            ..Default::default()
        },
    )
    .await?;
    let page = paginate(rows, limit, |r| {
        store::cursor_of(r.proof.created_at, r.proof.id)
    });
    let items = page
        .items
        .into_iter()
        .map(|r| ManagedVerification {
            proof: crate::handlers::app_item(r.proof),
            issuing_app: AppSummary {
                app_id: r.issuing_app,
                name: r.issuing_name,
                logo_url: r.issuing_logo,
                logo_dark_url: r.issuing_logo_dark,
                homepage_url: r.issuing_homepage,
            },
        })
        .collect::<Vec<_>>();
    Ok((
        [(CACHE_CONTROL, "no-store")],
        Json(Page::new(items, page.next_cursor)),
    )
        .into_response())
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HistoryQuery {
    limit: Option<i64>,
    cursor: Option<String>,
}

#[derive(sqlx::FromRow)]
struct EventRow {
    id: i64,
    at: OffsetDateTime,
    action: String,
    actor_kind: String,
    actor_id: Option<String>,
    details: Value,
    family_expires_at: OffsetDateTime,
}

#[derive(Serialize)]
struct VerificationEvent {
    event_id: String,
    #[serde(with = "rfc3339_ms")]
    at: OffsetDateTime,
    action: String,
    actor: Value,
    details: Value,
    #[serde(with = "rfc3339_ms_option")]
    token_expires_at: Option<OffsetDateTime>,
    token_expiry_source: Option<&'static str>,
}

/// Issuance and refresh audit rows are written in the same transaction as token minting.
/// Both timestamps use PostgreSQL transaction `now()`. An old event's TTL therefore permits
/// expiry derivation, but never recovery of an old token value, token hash, or token identity.
fn event(row: EventRow) -> VerificationEvent {
    let minted = matches!(row.action.as_str(), "proof.issued" | "proof.refreshed");
    let recorded = minted
        .then(|| {
            row.details
                .get("token_expires_at")?
                .as_str()
                .and_then(|s| OffsetDateTime::parse(s, &Rfc3339).ok())
        })
        .flatten();
    let derived = minted
        .then(|| {
            let ttl = row.details.get("access_ttl_seconds")?.as_i64()?;
            if row.details.get("kind")?.as_str()? != "ata"
                || !(MIN_ACCESS_TTL_SECONDS..=MAX_ACCESS_TTL_SECONDS).contains(&ttl)
            {
                return None;
            }
            Some(
                row.at
                    .checked_add(Duration::seconds(ttl))?
                    .min(row.family_expires_at),
            )
        })
        .flatten();
    let (token_expires_at, token_expiry_source) = match (recorded, derived) {
        (Some(at), _) => (Some(at), Some("recorded")),
        (None, Some(at)) => (Some(at), Some("derived")),
        _ => (None, None),
    };
    let mut details = serde_json::Map::new();
    for key in [
        "kind",
        "issuing_app",
        "receiving_app",
        "audiences",
        "scopes",
        "access_ttl_seconds",
        "expires_at",
        "reason",
        "via",
        "revoked_at",
        "sign_in_revoke_reason",
    ] {
        if let Some(value) = row.details.get(key) {
            details.insert(key.to_owned(), value.clone());
        }
    }
    VerificationEvent {
        event_id: row.id.to_string(),
        at: row.at,
        action: row.action,
        actor: json!({"kind": row.actor_kind, "id": row.actor_id}),
        details: Value::Object(details),
        token_expires_at,
        token_expiry_source,
    }
}

pub async fn history(
    State(state): State<AppState>,
    who: AccountAuth,
    Path((app_id, proof_id)): Path<(String, Uuid)>,
    Query(q): Query<HistoryQuery>,
) -> Result<Response, ApiError> {
    let page = PageParams {
        limit: q.limit,
        cursor: q.cursor,
    };
    let limit = page.limit();
    let cursor: Option<(i64, i64)> = page.cursor()?;
    let after = cursor
        .map(|(micros, id)| {
            OffsetDateTime::from_unix_timestamp_nanos(i128::from(micros) * 1_000)
                .map(|at| (at, id))
                .map_err(|_| {
                    ApiError::bad_request("invalid_cursor", "The history cursor is invalid.")
                })
        })
        .transpose()?;
    let mut conn = state.db.acquire().await?;
    let visible: bool = sqlx::query_scalar(
        "select exists(select 1 from proof_families f join apps a on a.app_id=f.issuing_app \
         where f.id=$1 and f.issuing_app=$2 and f.kind='ata' \
         and (a.owner_uuid=$3 or exists(select 1 from app_authors aa \
         where aa.app_id=a.app_id and aa.account_uuid=$3)))",
    )
    .bind(proof_id)
    .bind(&app_id)
    .bind(who.uuid())
    .fetch_one(&mut *conn)
    .await?;
    if !visible {
        return Err(hidden());
    }
    let rows = sqlx::query_as::<_, EventRow>(
        "select e.id,e.at,e.action,e.actor_kind,e.actor_id,e.details,f.expires_at as family_expires_at \
         from audit_log e join proof_families f on f.id=$1 \
         join apps a on a.app_id=f.issuing_app \
         where e.target_kind='proof' and e.target_id=$1::text and e.app_id=$2 \
         and f.issuing_app=$2 and f.kind='ata' \
         and (a.owner_uuid=$3 or exists(select 1 from app_authors aa \
         where aa.app_id=a.app_id and aa.account_uuid=$3)) \
         and e.action in ('proof.issued','proof.refreshed','proof.revoked','proof.refresh_token_reused') \
         and ($4::timestamptz is null or (e.at,e.id)<($4,$5::bigint)) \
         order by e.at desc,e.id desc limit $6",
    ).bind(proof_id).bind(&app_id).bind(who.uuid()).bind(after.map(|x| x.0))
        .bind(after.map(|x| x.1)).bind(limit+1).fetch_all(&mut *conn).await?;
    let page = paginate(rows, limit, |r| {
        ((r.at.unix_timestamp_nanos() / 1_000) as i64, r.id)
    });
    Ok((
        [(CACHE_CONTROL, "no-store")],
        Json(Page::new(
            page.items.into_iter().map(event).collect::<Vec<_>>(),
            page.next_cursor,
        )),
    )
        .into_response())
}
