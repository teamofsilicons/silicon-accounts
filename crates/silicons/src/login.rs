//! `POST /v1/silicons/login`: a Silicon signs in with its si:id and STK and gets first-party
//! tokens (`aud = silicon-accounts`, token family origin `silicon_login`).
//!
//! - Unknown si:id and wrong STK get the same 401 `invalid_credentials`, after the same Argon2id
//!   work, so ids can't be probed.
//! - 10 wrong STKs in a row lock sign-in for 1 minute (423 `login_locked`, also during the lock
//!   even with the right STK); a success resets the count. Attempts are counted before the STK
//!   is checked (core's `accounts::begin_stk_attempt`), so a burst of parallel guesses gets no
//!   more than 10 checks either. Argon2id runs on the blocking pool.
//! - The right STK on an account that can't sign in yet says why: 403 `custodian_pending`
//!   (with the request to poll) or `custodian_expired`.
//! - An id whose Silicon is gone says why: 403 `custodian_declined`, `custodian_expired` or
//!   `account_deleted` (that account's STK no longer exists, so nothing is verified).
//! - So does the right STK of a Silicon that ends while its STK is being checked (Argon2 takes
//!   about a second): released because its request expired (the sweep, or a read of the
//!   request), was declined or lost its Carbon, or deleted by its custodian. The account is
//!   re-read under a lock after the check, and the answer is the one an id that was already gone
//!   gets. An STK rotated meanwhile is dead, so that one is `invalid_credentials`.
//! - 60 attempts per minute per IP on top of the per-Silicon lock.
//! - `{"assertion": "<JWT>"}` instead of `id` and `stk` signs in with one of the Silicon's
//!   registered keys (core's `silicon_keys::sign_in`): no STK, no lockout (a signature can't be
//!   guessed), 401 `invalid_assertion` when anything about it is wrong.

use accounts_core::crypto::stk::{StkHasher, normalize as normalize_stk};
use accounts_core::error::{ApiError, ApiResult};
use accounts_core::http::{ClientMeta, Json};
use accounts_core::ids::{AccountId, IdError};
use accounts_core::models::{AccountKind, AccountStatus, Scope, TokenOrigin};
use accounts_core::repo::accounts::StkAttempt;
use accounts_core::repo::audit::{self, SigninRecord};
use accounts_core::repo::{accounts, rate_limit, tokens};
use accounts_core::state::AppState;
use accounts_core::timefmt::format_rfc3339_ms;
use accounts_core::views::TokenResponse;
use axum::extract::State;
use serde::{Deserialize, Serialize};
use sqlx::PgConnection;
use time::OffsetDateTime;

use crate::requests::{self, status};
use crate::{input, lifecycle, views};

/// Consecutive wrong STKs that lock sign-in (core's `accounts::MAX_STK_FAILURES`).
pub const MAX_STK_FAILURES: i32 = accounts::MAX_STK_FAILURES;
/// How long sign-in stays locked after that (core's `accounts::STK_LOCK_SECONDS`).
pub const LOCK_SECONDS: i64 = accounts::STK_LOCK_SECONDS;
/// Label of the token family when the caller sends no `client_label`.
pub const DEFAULT_LABEL: &str = "Silicon sign-in";

/// `POST /v1/silicons/login` body: `{"id", "stk"}`, or `{"assertion"}` (a JWT signed with one of
/// the Silicon's registered keys, see `keys`).
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct LoginBody {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub stk: Option<String>,
    #[serde(default)]
    pub assertion: Option<String>,
    #[serde(default)]
    pub client_label: Option<String>,
}

fn invalid_credentials() -> ApiError {
    ApiError::unauthenticated(
        "invalid_credentials",
        "Sign-in failed: no Silicon has this si:id, or the STK is wrong. Both cases get this same answer, so ids can't be probed.",
    )
    .hint("Check the si:id (use the current one; ids can change) and the STK (stk- followed by the hex characters shown once at creation or rotation). 10 wrong STKs in a row lock sign-in for 1 minute. A lost STK can be replaced by the Silicon's custodian (`silicon-accounts silicon rotate-stk`).")
}

fn login_locked(full_id: &str, seconds: u64) -> ApiError {
    ApiError::locked(
        "login_locked",
        format!(
            "Sign-in to {full_id} is locked for {seconds} more seconds because {MAX_STK_FAILURES} wrong STKs were sent in a row."
        ),
        seconds,
    )
    .hint("Wait until the lock ends (details.retry_after_seconds), then sign in with the correct STK. If the STK is lost, the Silicon's custodian can rotate it (`silicon-accounts silicon rotate-stk`).")
}

fn parse_login_id(input: &str) -> ApiResult<AccountId> {
    match AccountId::parse_for_kind(input, AccountKind::Silicon) {
        Ok(id) => Ok(id),
        Err(e @ IdError::WrongKind { .. }) => Err(ApiError::unprocessable("invalid_id", e.to_string())
            .hint("Carbons sign in with `silicon-accounts login` (a code by email or phone, or the browser device flow); this endpoint signs Silicons in with their si:id and STK.")
            .detail("reason", e.reason())),
        Err(e) => Err(accounts::invalid_id_error(&e)),
    }
}

async fn record_attempt(
    conn: &mut PgConnection,
    meta: &ClientMeta,
    account_uuid: Option<&str>,
    outcome: &str,
) -> ApiResult<()> {
    audit::signin(
        conn,
        &SigninRecord {
            account_uuid,
            app_id: Some(accounts_core::FIRST_PARTY_APP_ID),
            method: audit::method::SILICON_STK,
            outcome,
            ip: meta.ip.as_deref(),
            user_agent: meta.user_agent.as_deref(),
        },
    )
    .await
}

/// `POST /v1/silicons/login`.
pub async fn login(
    State(state): State<AppState>,
    meta: ClientMeta,
    Json(body): Json<LoginBody>,
) -> Result<Json<TokenResponse>, ApiError> {
    rate_limit::enforce_pool(
        &state.db,
        &rate_limit::bucket("silicon_login:ip", meta.ip_or_unknown()),
        rate_limit::limits::SILICON_LOGIN_PER_IP,
        "Silicon sign-in attempts from this network",
    )
    .await?;
    if let Some(assertion) = body.assertion.as_deref() {
        if body.id.is_some() || body.stk.is_some() {
            let mut f = accounts_core::FieldErrors::new();
            f.add(
                "assertion",
                "send either an assertion or an id and STK, not both (the assertion names the Silicon)",
            );
            return Err(ApiError::validation(f));
        }
        let response = accounts_core::silicon_keys::sign_in(
            &state,
            &meta,
            assertion,
            input::client_label(body.client_label.as_deref()).as_deref(),
        )
        .await;
        if response.is_err() {
            let mut conn = state.db.acquire().await?;
            audit::signin(
                &mut conn,
                &SigninRecord {
                    account_uuid: None,
                    app_id: Some(accounts_core::FIRST_PARTY_APP_ID),
                    method: "silicon_key",
                    outcome: audit::outcome::FAILED,
                    ip: meta.ip.as_deref(),
                    user_agent: meta.user_agent.as_deref(),
                },
            )
            .await?;
        }
        return response.map(Json);
    }
    let missing = |field: &str| {
        let mut f = accounts_core::FieldErrors::new();
        f.add(
            field,
            "required: sign in with your si:id and STK, or with an assertion signed by your key",
        );
        ApiError::validation(f)
    };
    let id = parse_login_id(body.id.as_deref().ok_or_else(|| missing("id"))?)?;
    let stk = body.stk.as_deref().ok_or_else(|| missing("stk"))?;
    let presented = normalize_stk(stk).map_err(|m| {
        ApiError::unprocessable("invalid_stk", m)
            .hint("Send the STK exactly as it was shown: stk- followed by 8 to 32 hexadecimal characters.")
    })?;
    let full = id.to_string();

    let mut conn = state.db.acquire().await?;
    let found = accounts::by_handle(&mut conn, &full)
        .await?
        .filter(|a| a.kind == AccountKind::Silicon);
    let Some(account) = found else {
        if let Some(gone) = former_silicon_error(&mut conn, &full).await? {
            record_attempt(&mut conn, &meta, None, audit::outcome::FAILED).await?;
            return Err(gone);
        }
        drop(conn);
        state.keys.stk.burn_async().await;
        let mut conn = state.db.acquire().await?;
        record_attempt(&mut conn, &meta, None, audit::outcome::FAILED).await?;
        return Err(invalid_credentials());
    };
    drop(conn);

    // Count the attempt *before* checking the STK (and refuse while locked): checking first and
    // counting afterwards would let a burst of parallel guesses all pass the lock check before
    // any failure is recorded.
    let attempt =
        match accounts::begin_stk_attempt(&state.db, &account.uuid, MAX_STK_FAILURES, LOCK_SECONDS)
            .await?
        {
            StkAttempt::Check { attempt } => attempt,
            StkAttempt::Locked {
                retry_after_seconds,
            } => {
                let mut conn = state.db.acquire().await?;
                record_attempt(
                    &mut conn,
                    &meta,
                    Some(&account.uuid),
                    audit::outcome::FAILED,
                )
                .await?;
                return Err(login_locked(&full, retry_after_seconds));
            }
        };

    let verified_hash = account.stk_hash.clone();
    let correct = match &verified_hash {
        Some(phc) => StkHasher::verify_async(presented, phc.clone()).await,
        None => {
            state.keys.stk.burn_async().await;
            false
        }
    };
    if !correct {
        let mut conn = state.db.acquire().await?;
        record_attempt(
            &mut conn,
            &meta,
            Some(&account.uuid),
            audit::outcome::FAILED,
        )
        .await?;
        drop(conn);
        if accounts::stk_attempt_failed(
            &state.db,
            &account.uuid,
            attempt,
            MAX_STK_FAILURES,
            LOCK_SECONDS,
        )
        .await?
        .is_some()
        {
            tracing::warn!(silicon = %account.uuid, "Silicon sign-in locked after {MAX_STK_FAILURES} wrong STKs in a row");
            return Err(login_locked(&full, LOCK_SECONDS as u64));
        }
        return Err(invalid_credentials());
    }

    let mut tx = state.db.begin().await?;
    // Locks go request first, then account, as everywhere else in this crate.
    let pending_request = if account.status == AccountStatus::PendingCustodian {
        requests::pending_for_silicon(&mut tx, &account.uuid, true).await?
    } else {
        None
    };
    // Re-read under a lock: whatever happened to the Silicon while its STK was being checked wins.
    let Some(account) = accounts::lock(&mut tx, &account.uuid).await? else {
        return Err(ApiError::internal(format!(
            "the Silicon {} disappeared while its STK was being checked",
            account.uuid
        )));
    };
    if account.status == AccountStatus::Deleted {
        // Released (its request expired, was declined or lost its Carbon) or deleted meanwhile.
        // The STK was right, so it is told why, exactly as if the id had been gone already.
        let gone = released_error(&mut tx, &full, &account.uuid, account.deleted_at).await?;
        record_attempt(&mut tx, &meta, Some(&account.uuid), audit::outcome::FAILED).await?;
        tx.commit().await?;
        return Err(gone);
    }
    if account.stk_hash != verified_hash {
        // Rotated meanwhile: the STK that was checked is dead, so it is a wrong STK now.
        record_attempt(&mut tx, &meta, Some(&account.uuid), audit::outcome::FAILED).await?;
        tx.commit().await?;
        return Err(invalid_credentials());
    }
    accounts::clear_stk_failures(&mut tx, &account.uuid).await?;
    match account.status {
        AccountStatus::Active => {}
        AccountStatus::PendingCustodian => {
            let refusal = not_yet_active(
                &mut tx,
                &account.uuid,
                pending_request,
                &full,
                &state.settings.public_url,
            )
            .await?;
            record_attempt(&mut tx, &meta, Some(&account.uuid), audit::outcome::FAILED).await?;
            tx.commit().await?;
            return Err(refusal);
        }
        _ => return Err(invalid_credentials()),
    }
    let label = input::client_label(body.client_label.as_deref())
        .unwrap_or_else(|| DEFAULT_LABEL.to_string());
    let response = tokens::issue_tokens(
        &mut tx,
        &state.keys,
        &state.settings,
        tokens::IssueRequest {
            account: &account,
            app_id: accounts_core::FIRST_PARTY_APP_ID,
            origin: TokenOrigin::SiliconLogin,
            scopes: &[Scope::Profile],
            browser_session_id: None,
            label: Some(&label),
            ip: meta.ip.as_deref(),
            user_agent: meta.user_agent.as_deref(),
            nonce: None,
            auth_time: None,
        },
    )
    .await?;
    record_attempt(&mut tx, &meta, Some(&account.uuid), audit::outcome::SUCCESS).await?;
    tx.commit().await?;
    state.telemetry.record(
        "api",
        "silicon.login",
        "silicon_signed_in",
        serde_json::json!({"labelled": body.client_label.is_some()}),
    );
    Ok(Json(response))
}

/// Why a pending Silicon (right STK) can't sign in yet, from its row-locked pending request. An
/// overdue request is expired here and now (releasing the Silicon), exactly as the sweep would;
/// so is a request cancelled because the named Carbon deleted their account.
async fn not_yet_active(
    conn: &mut PgConnection,
    silicon_uuid: &str,
    pending_request: Option<requests::CustodianRequest>,
    full: &str,
    site: &str,
) -> ApiResult<ApiError> {
    let Some(request) = pending_request else {
        if let Some(latest) = requests::latest_initial(conn, silicon_uuid).await?
            && lifecycle::release_orphan(conn, &latest).await?
        {
            return Ok(custodian_gone(full));
        }
        return Ok(ApiError::forbidden(
            "custodian_pending",
            format!("{full} can't sign in yet: no Carbon has accepted to be its custodian."),
        )
        .hint("Create the account again naming a custodian (POST /v1/silicons), or ask a Carbon to create it for you (POST /v1/me/silicons)."));
    };
    let label = views::custodian_label(conn, &request).await?;
    if request.is_overdue() {
        lifecycle::expire(conn, &request).await?;
        return Ok(custodian_expired(full, request.expires_at));
    }
    Ok(ApiError::forbidden(
        "custodian_pending",
        format!(
            "Silicon {full} can't sign in yet: its custodian {label} hasn't accepted the request (expires {}).",
            format_rfc3339_ms(request.expires_at)
        ),
    )
    .hint(format!(
        "Wait for {label} to accept on {site}, or poll GET /v1/silicons/requests/{} with the request token (`silicon-accounts silicon request status {} --wait`).",
        request.id,
        request.id
    ))
    .detail("request_id", request.id.to_string())
    .detail("expires_at", format_rfc3339_ms(request.expires_at))
    .detail("custodian", label))
}

fn custodian_gone(full: &str) -> ApiError {
    ApiError::forbidden(
        "custodian_declined",
        format!(
            "{full} can't sign in: the Carbon it named as custodian deleted their account before accepting, so the account was never activated and the id was released."
        ),
    )
    .hint("Create the account again with POST /v1/silicons (`silicon-accounts silicon create`), naming a Carbon who will accept.")
}

fn custodian_expired(full: &str, expired_at: OffsetDateTime) -> ApiError {
    ApiError::forbidden(
        "custodian_expired",
        format!(
            "{full} can't sign in: its custodian didn't accept within 14 days (the request expired at {}), so the account was never activated and the id was released.",
            format_rfc3339_ms(expired_at)
        ),
    )
    .hint("Create the account again with POST /v1/silicons (`silicon-accounts silicon create`), naming a Carbon who will accept.")
}

/// The account that last held an id (from `handle_history`).
#[derive(sqlx::FromRow)]
struct FormerHolder {
    account_uuid: String,
    /// Set when the id was changed to another one (not released).
    new_handle: Option<String>,
    kind: AccountKind,
    status: AccountStatus,
    deleted_at: Option<OffsetDateTime>,
}

/// When `full` names no current account, explains what happened to the Silicon that last had it
/// (declined, expired, deleted), if any. Renamed ids and ids that never existed get `None`.
async fn former_silicon_error(conn: &mut PgConnection, full: &str) -> ApiResult<Option<ApiError>> {
    let holder = sqlx::query_as::<_, FormerHolder>(
        "select h.account_uuid, h.new_handle, a.kind, a.status, a.deleted_at from handle_history h \
         join accounts a on a.uuid = h.account_uuid where h.old_handle = $1 \
         order by h.changed_at desc, h.id desc limit 1",
    )
    .bind(full)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(holder) = holder else {
        return Ok(None);
    };
    if holder.new_handle.is_some()
        || holder.kind != AccountKind::Silicon
        || holder.status != AccountStatus::Deleted
    {
        return Ok(None);
    }
    released_error(conn, full, &holder.account_uuid, holder.deleted_at)
        .await
        .map(Some)
}

/// Why the deleted Silicon `silicon_uuid`, last known as `full`, can't sign in, from its latest
/// initial custodian request: 403 `custodian_declined` (declined, or the Carbon it named deleted
/// their account), `custodian_expired`, else `account_deleted`.
async fn released_error(
    conn: &mut PgConnection,
    full: &str,
    silicon_uuid: &str,
    deleted_at: Option<OffsetDateTime>,
) -> ApiResult<ApiError> {
    let initial = requests::latest_initial(conn, silicon_uuid).await?;
    Ok(match initial {
        Some(r) if r.status == status::DECLINED => ApiError::forbidden(
            "custodian_declined",
            format!(
                "{full} can't sign in: the Carbon it named as custodian declined{}, so the account was never activated and the id was released.",
                r.decided_at
                    .map(|t| format!(" on {}", format_rfc3339_ms(t)))
                    .unwrap_or_default()
            ),
        )
        .hint("Create the account again with POST /v1/silicons (`silicon-accounts silicon create`), naming a Carbon who will accept."),
        Some(r) if r.status == status::EXPIRED => custodian_expired(full, r.expires_at),
        Some(r) if r.status == status::CANCELLED => custodian_gone(full),
        _ => ApiError::forbidden(
            "account_deleted",
            format!(
                "{full} belonged to a Silicon account that was deleted{}; deleted accounts can't sign in.",
                deleted_at
                    .map(|t| format!(" on {}", format_rfc3339_ms(t)))
                    .unwrap_or_default()
            ),
        )
        .hint("Ask its former custodian, or create a new Silicon account."),
    })
}
