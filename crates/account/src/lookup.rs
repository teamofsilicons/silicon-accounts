//! Public lookups: id availability, account by uuid, account by current id.

use accounts_core::http::{AccountAuth, ClientMeta, Json, Path, Query};
use accounts_core::ids::{self, AccountId};
use accounts_core::models::{Account, AccountKind, AccountStatus};
use accounts_core::repo::accounts::{self, IdAvailability};
use accounts_core::repo::rate_limit::{self, Limit};
use accounts_core::views::{AccountSummary, CustodianRef};
use accounts_core::{ApiError, ApiResult, AppState};
use axum::extract::State;
use serde::{Deserialize, Serialize};
use sqlx::PgConnection;

use crate::caller::Caller;
use crate::util::{clip, ts};

/// The longest input worth parsing as an id (`si:` + 30-character handle, with some slack for
/// spaces); longer inputs are reported invalid without echoing them back.
const MAX_ID_INPUT: usize = 64;

/// `GET /v1/accounts/{uuid}` and `GET /v1/accounts/by-id/{id}` together: 600 lookups per minute
/// per app, or per signed-in account. uuids come from a sequence, so without a limit one caller
/// could walk every account.
pub const LOOKUPS_PER_MINUTE: Limit = Limit::new(600, 60);

/// Counts one lookup for the caller (429 `rate_limited` over [`LOOKUPS_PER_MINUTE`]).
async fn count_lookup(state: &AppState, caller: &Caller) -> ApiResult<()> {
    let (bucket, what) = match caller {
        Caller::App(app) => (
            rate_limit::bucket("account_lookup:app", &app.app_id),
            "account lookups by this app",
        ),
        Caller::Account(auth) => (
            rate_limit::bucket("account_lookup:account", auth.uuid()),
            "account lookups by this account",
        ),
    };
    rate_limit::enforce_pool(&state.db, &bucket, LOOKUPS_PER_MINUTE, what).await
}

#[derive(Debug, Deserialize)]
pub(crate) struct AvailableQuery {
    id: Option<String>,
    /// Answer for a Silicon the caller is custodian of (its uuid or si:id): an id reserved for
    /// that Silicon (one of its recent ids) is `available: true, reclaimable: true`.
    #[serde(rename = "for")]
    for_account: Option<String>,
}

/// The account an availability answer is for, and how messages name it (`None` = "you").
struct Requester {
    uuid: String,
    label: Option<String>,
}

/// Whose point of view `?for=` asks for: the caller itself (its uuid or id), or a Silicon the
/// caller is custodian of. Anything else is 404 `silicon_not_found` (other Carbons' Silicons
/// are not revealed); without a session it is 401.
async fn requester_for(
    conn: &mut PgConnection,
    auth: Option<&AccountAuth>,
    target: &str,
) -> ApiResult<Requester> {
    let Some(auth) = auth else {
        return Err(ApiError::unauthenticated(
            "unauthenticated",
            format!(
                "?for={} asks whether an id is free for one of your Silicons, which needs you signed in as its custodian.",
                clip(target, 40)
            ),
        )
        .hint("Send the session cookie or an Authorization: Bearer access token, or leave out ?for= to check the id for anyone."));
    };
    let lower = target.to_lowercase();
    if target == auth.uuid() || auth.account.handle.as_deref() == Some(lower.as_str()) {
        return Ok(Requester {
            uuid: auth.uuid().to_string(),
            label: None,
        });
    }
    let found = if target.contains(':') {
        accounts::by_handle(conn, &lower).await?
    } else {
        accounts::get(conn, target).await?
    };
    match found {
        Some(a)
            if a.kind == AccountKind::Silicon
                && a.status != AccountStatus::Deleted
                && a.custodian_uuid.as_deref() == Some(auth.uuid()) =>
        {
            Ok(Requester {
                label: Some(a.display_id()),
                uuid: a.uuid,
            })
        }
        _ => Err(ApiError::not_found(
            "silicon_not_found",
            format!("You are not the custodian of a Silicon '{}'.", clip(target, 40)),
        )
        .hint("Pass the uuid or si:id of a Silicon you are custodian of (GET /v1/me/silicons), or leave out ?for= to check the id for yourself.")
        .detail("silicon", clip(target, 40))),
    }
}

/// The `GET /v1/ids/available` body: core's [`IdAvailability`] plus `suggestions`, up to three
/// available ids close to the one asked for (empty when it is available, or when the input has
/// no `c:`/`si:` prefix to tell which kind of id to suggest).
#[derive(Debug, Serialize)]
pub(crate) struct AvailabilityView {
    #[serde(flatten)]
    availability: IdAvailability,
    suggestions: Vec<String>,
}

/// The kind and handle part of an input that is not (or can't be) taken as-is.
fn suggestion_seed(input: &str) -> Option<(AccountKind, String)> {
    let lower = input.trim().to_lowercase();
    if let Some(rest) = lower.strip_prefix("c:") {
        Some((AccountKind::Carbon, rest.to_string()))
    } else {
        lower
            .strip_prefix("si:")
            .map(|rest| (AccountKind::Silicon, rest.to_string()))
    }
}

/// `GET /v1/ids/available?id=c:saket` — public, 120 requests per minute per IP. With a session,
/// an id reserved for the caller (one of its recent ids) is `available: true, reclaimable: true`.
/// A custodian adds `&for=<the Silicon's uuid or si:id>` to ask the same for one of its Silicons
/// (whose reserved ids it may take back for it).
pub(crate) async fn id_available(
    State(state): State<AppState>,
    meta: ClientMeta,
    auth: Option<AccountAuth>,
    Query(q): Query<AvailableQuery>,
) -> ApiResult<Json<AvailabilityView>> {
    rate_limit::enforce_pool(
        &state.db,
        &rate_limit::bucket("ids_available:ip", meta.ip_or_unknown()),
        rate_limit::limits::IDS_AVAILABLE_PER_IP,
        "id availability checks from this network",
    )
    .await?;
    let Some(input) = q.id else {
        return Err(ApiError::bad_request(
            "invalid_query",
            "The query parameter 'id' is required: GET /v1/ids/available?id=c:saket (a Carbon id) or ?id=si:scout (a Silicon id).",
        )
        .hint("Pass the full id including its c: or si: prefix."));
    };
    if input.chars().count() > MAX_ID_INPUT {
        return Ok(Json(AvailabilityView {
            availability: IdAvailability {
                id: clip(input.trim(), 40),
                available: false,
                reason: Some("invalid"),
                message: format!(
                    "The id is {} characters long; an id is a c: or si: prefix plus a handle of 3 to 30 characters.",
                    input.chars().count()
                ),
                reclaimable: false,
            },
            suggestions: Vec::new(),
        }));
    }
    let mut conn = state.db.acquire().await?;
    let requester = match q
        .for_account
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
    {
        None => auth.as_ref().map(|a| Requester {
            uuid: a.uuid().to_string(),
            label: None,
        }),
        Some(target) => Some(requester_for(&mut conn, auth.as_ref(), target).await?),
    };
    let availability = accounts::id_availability_for(
        &mut conn,
        &input,
        requester.as_ref().map(|r| r.uuid.as_str()),
        requester.as_ref().and_then(|r| r.label.as_deref()),
    )
    .await?;
    let suggestions = match (availability.available, suggestion_seed(&input)) {
        (false, Some((kind, seed))) if !seed.trim().is_empty() => {
            accounts::suggest_ids(&mut conn, kind, &[seed.as_str()], 3)
                .await?
                .iter()
                .map(ToString::to_string)
                .collect()
        }
        _ => Vec::new(),
    };
    Ok(Json(AvailabilityView {
        availability,
        suggestions,
    }))
}

/// The answer of both lookups, by who asks.
#[derive(Debug, Serialize)]
#[serde(untagged)]
pub(crate) enum LookupView {
    /// A signed-in Carbon or Silicon.
    Account(AccountLookup),
    /// An app.
    App(AppLookup),
}

/// What a signed-in Carbon or Silicon sees: AccountSummary plus, for Silicons, the custodian's
/// (`null` while a self-created Silicon waits for its custodian to accept).
#[derive(Debug, Serialize)]
pub(crate) struct AccountLookup {
    #[serde(flatten)]
    summary: AccountSummary,
    #[serde(skip_serializing_if = "Option::is_none")]
    custodian: Option<Option<AccountSummary>>,
}

/// What an app sees: the account's public identity, `{"uuid","kind","id","status"}`, plus for
/// Silicons the custodian as `{"uuid","id"}` (`null` while a self-created Silicon waits for its
/// custodian to accept), the way apps see a custodian everywhere.
///
/// Never the display name or photo. Those are details an account shares with an app by signing
/// in to it, and it can take them back by removing the app's access, so an app reads them from
/// its user base (`GET /v1/apps/{app_id}/users/{uuid}`), which follows that: an account that
/// removed the app's access shows none of its data there, whatever it changes afterwards. A
/// lookup that answered them to any app would undo that with one call.
#[derive(Debug, Serialize)]
pub(crate) struct AppLookup {
    uuid: String,
    kind: AccountKind,
    id: Option<String>,
    status: AccountStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    custodian: Option<Option<CustodianRef>>,
}

async fn lookup_view(
    conn: &mut PgConnection,
    caller: &Caller,
    account: &Account,
) -> ApiResult<LookupView> {
    let custodian = match (account.kind, &account.custodian_uuid) {
        (AccountKind::Carbon, _) => None,
        (AccountKind::Silicon, Some(c)) => Some(accounts::get(conn, c).await?),
        (AccountKind::Silicon, None) => Some(None),
    };
    Ok(match caller {
        Caller::Account(_) => LookupView::Account(AccountLookup {
            summary: AccountSummary::from_account(account),
            custodian: custodian.map(|c| c.as_ref().map(AccountSummary::from_account)),
        }),
        Caller::App(_) => LookupView::App(AppLookup {
            uuid: account.uuid.clone(),
            kind: account.kind,
            id: account.handle.clone(),
            status: account.status,
            custodian: custodian.map(|c| {
                c.map(|c| CustodianRef {
                    uuid: c.uuid,
                    id: c.handle,
                })
            }),
        }),
    })
}

/// `GET /v1/accounts/{uuid}` — app or session (see [`LOOKUPS_PER_MINUTE`]); see [`LookupView`]
/// for what each sees. 404 for unknown and deleted accounts.
pub(crate) async fn by_uuid(
    State(state): State<AppState>,
    caller: Caller,
    Path(uuid): Path<String>,
) -> ApiResult<Json<LookupView>> {
    count_lookup(&state, &caller).await?;
    let uuid = uuid.trim();
    if !ids::is_account_uuid(uuid) {
        let shown = clip(uuid, 40);
        if AccountId::parse(uuid).is_ok() {
            return Err(ApiError::bad_request(
                "invalid_uuid",
                format!("'{shown}' is an id, not a uuid: this route takes the permanent uuid of an account."),
            )
            .hint(format!(
                "Look ids up with GET /v1/accounts/by-id/{}.",
                uuid.to_lowercase()
            )));
        }
        return Err(ApiError::bad_request(
            "invalid_uuid",
            format!("'{shown}' is not an account uuid: use a canonical UUID such as 550e8400-e29b-41d4-a716-446655440000."),
        )
        .hint("uuids are case-sensitive; copy them exactly (for example from membership ids, which are {app_id}:{uuid})."));
    }
    let mut conn = state.db.acquire().await?;
    let account = accounts::get(&mut conn, uuid).await?.ok_or_else(|| {
        ApiError::not_found(
            "account_not_found",
            format!("No account has the uuid '{uuid}'."),
        )
        .hint("uuids are case-sensitive; check the value, or look the account up by its id with GET /v1/accounts/by-id/{id}.")
    })?;
    if account.status == AccountStatus::Deleted {
        return Err(ApiError::not_found(
            "account_deleted",
            format!(
                "The account {uuid} was deleted{}.",
                account
                    .deleted_at
                    .map(|t| format!(" at {}", ts(t)))
                    .unwrap_or_default()
            ),
        )
        .hint("Deleted accounts can't be looked up; remove it from your records (apps also got an account.deleted webhook)."));
    }
    tracing::debug!(caller = %caller.describe(), uuid, "account lookup");
    Ok(Json(lookup_view(&mut conn, &caller, &account).await?))
}

/// `GET /v1/accounts/by-id/{id}` — app or session (see [`LOOKUPS_PER_MINUTE`]); the same answer
/// as by uuid. Only current ids resolve.
pub(crate) async fn by_id(
    State(state): State<AppState>,
    caller: Caller,
    Path(raw): Path<String>,
) -> ApiResult<Json<LookupView>> {
    count_lookup(&state, &caller).await?;
    let shown = clip(raw.trim(), 40);
    let id = AccountId::parse(&raw).map_err(|e| {
        let message = if raw.chars().count() > MAX_ID_INPUT {
            format!(
                "'{shown}' is not an id: ids are c: or si: plus a handle of 3 to 30 characters."
            )
        } else {
            e.to_string()
        };
        ApiError::bad_request("invalid_id", message)
            .hint(e.hint())
            .detail("reason", e.reason())
    })?;
    let full = id.to_string();
    let mut conn = state.db.acquire().await?;
    let Some(account) = accounts::by_handle(&mut conn, &full).await? else {
        let reserved = accounts::active_reservation(&mut conn, &full).await?;
        let hint = match reserved {
            Some((_, until)) => format!(
                "{full} was some account's id until recently and is reserved for it until {}; ids change, so store and look up accounts by uuid.",
                ts(until)
            ),
            None => "Check the spelling; ids change, so store and look up accounts by uuid (GET /v1/accounts/{uuid}).".to_string(),
        };
        return Err(ApiError::not_found(
            "account_not_found",
            format!("No account currently has the id {full}."),
        )
        .hint(hint));
    };
    tracing::debug!(caller = %caller.describe(), id = %full, "account lookup by id");
    Ok(Json(lookup_view(&mut conn, &caller, &account).await?))
}
