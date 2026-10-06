//! A Silicon creates its own account:
//!
//! - `POST /v1/silicons` (public, IDEMPOTENT): the account starts `pending_custodian`; the named
//!   Carbon (c:id, or an email that may not have an account yet) gets an email and has 14 days to
//!   accept. The response carries the STK (when generated), the request and its `sarq_` polling
//!   token, and the webhook secret (when a webhook was given) — each shown exactly once.
//! - `GET /v1/silicons/requests/{id}` (`Authorization: Bearer sarq_…`): the request's status, so
//!   a Silicon (or `accounts silicon create --wait`) can wait for the custodian's decision.
//!
//! Limits, per network (client IP):
//! - 10 successful self-creations per hour (the contract number; failed attempts don't use it up);
//! - 60 attempts per hour, failed or not ([`SELF_CREATE_ATTEMPTS_PER_IP`]): every attempt costs
//!   database work and answers questions about ids and custodians, so failing requests (an
//!   unknown custodian, a taken id) can't be sent without limit either.
//!
//! And per named custodian: at most 20 self-created Silicons wait for the same c:id, and at most
//! 20 for the same email address. They are counted per name, not per account, so the limit never
//! tells an anonymous caller which email address belongs to which c:id.

use accounts_core::crypto::{self, Pepper, prefix};
use accounts_core::delivery;
use accounts_core::error::{ApiError, ApiResult, FieldErrors};
use accounts_core::events;
use accounts_core::http::{ClientMeta, IdempotencyKey, Json, Path};
use accounts_core::models::AccountStatus;
use accounts_core::repo::accounts::{self, NewSilicon};
use accounts_core::repo::idempotency;
use accounts_core::repo::rate_limit::{self, Limit};
use accounts_core::state::AppState;
use accounts_core::views::load_me;
use axum::extract::State;
use axum::http::header::AUTHORIZATION;
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::PgConnection;

use crate::common::{ensure_id_free, ensure_rate_room};
use crate::history::Actor;
use crate::idempotent;
use crate::input::{self, CarbonTarget, check};
use crate::notify::{self, Recipient};
use crate::requests::{self, MAX_PENDING_PER_CUSTODIAN, NewRequest, kind};
use crate::views::{self, RequestStatusView};
use crate::{lifecycle, stk};

const SELF_CREATE_WHAT: &str = "Silicon self-creations from this network";

/// Self-creation attempts per network (client IP) per hour, successful or not. Generous for a
/// Silicon retrying with another id; the contract's 10 per hour still caps the creations.
pub const SELF_CREATE_ATTEMPTS_PER_IP: Limit = Limit::new(60, 3600);

/// What the self-create request asks of the named Carbon (used in error messages).
const NAMED_FOR: &str = "be named as a Silicon's custodian";

/// `POST /v1/silicons` body.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SelfCreateBody {
    pub id: String,
    pub display_name: String,
    #[serde(default)]
    pub timezone: Option<String>,
    #[serde(default)]
    pub pfp_url: Option<String>,
    #[serde(default)]
    pub stk: Option<String>,
    /// `c:saket` or `saket@example.com`.
    pub custodian: String,
    #[serde(default)]
    pub webhook_url: Option<String>,
}

/// The request as hashed for Idempotency-Key matching. A chosen STK is replaced by a keyed hash:
/// the stored fingerprint must never let anyone brute-force a short STK offline.
pub fn idempotency_fingerprint<T: Serialize>(body: &T, pepper: &Pepper) -> Value {
    let mut v = serde_json::to_value(body).unwrap_or(Value::Null);
    if let Some(stk) = v.get("stk").and_then(Value::as_str).map(str::to_string) {
        v["stk"] = json!(pepper.hash_hex("idempotency:stk", &stk));
    }
    v
}

/// `POST /v1/silicons`.
pub async fn create(
    State(state): State<AppState>,
    meta: ClientMeta,
    key: Option<IdempotencyKey>,
    Json(body): Json<SelfCreateBody>,
) -> Result<Response, ApiError> {
    let scope = idempotency::scope(
        &format!("ip:{}", meta.ip_or_unknown()),
        "POST",
        "/v1/silicons",
    );
    let fingerprint = idempotency_fingerprint(&body, &state.keys.pepper);
    idempotent::run_secret(&state, key.as_deref(), &scope, &fingerprint, || {
        self_create(&state, &meta, body)
    })
    .await
}

async fn self_create(
    state: &AppState,
    meta: &ClientMeta,
    body: SelfCreateBody,
) -> ApiResult<(StatusCode, Value)> {
    let settings = &state.settings;
    let id = input::silicon_id(&body.id)?;
    let mut fields = FieldErrors::new();
    let display_name = check(
        &mut fields,
        "display_name",
        input::display_name(&body.display_name),
    );
    let timezone = check(
        &mut fields,
        "timezone",
        input::timezone(body.timezone.as_deref(), meta.ip_timezone.as_deref()),
    );
    let pfp_url = check(
        &mut fields,
        "pfp_url",
        input::pfp_url(settings, body.pfp_url.as_deref()),
    );
    let chosen_stk = check(&mut fields, "stk", input::chosen_stk(body.stk.as_deref()));
    let webhook_url = check(
        &mut fields,
        "webhook_url",
        input::webhook_url(settings, body.webhook_url.as_deref()),
    );
    let target = check(
        &mut fields,
        "custodian",
        CarbonTarget::parse(&body.custodian),
    );
    fields.into_result()?;
    let (
        Some(display_name),
        Some(timezone),
        Some(pfp_url),
        Some(chosen_stk),
        Some(webhook_url),
        Some(target),
    ) = (
        display_name,
        timezone,
        pfp_url,
        chosen_stk,
        webhook_url,
        target,
    )
    else {
        return Err(ApiError::internal(
            "validated self-create fields are missing",
        ));
    };

    // Every attempt that reaches the database is counted (committed at once, whatever happens
    // next); input errors above cost nothing and are not.
    rate_limit::enforce_pool(
        &state.db,
        &rate_limit::bucket("silicon_self_create_attempts:ip", meta.ip_or_unknown()),
        SELF_CREATE_ATTEMPTS_PER_IP,
        "Silicon self-creation attempts from this network",
    )
    .await
    .map_err(|e| {
        e.hint("Every attempt counts here, failed ones included. Check the id first with GET /v1/ids/available?id=si:<handle> and the custodian's c:id, then retry after details.retry_after_seconds.")
    })?;
    // Cheap checks first, so refused requests never cost an Argon2 hash.
    let bucket = rate_limit::bucket("silicon_self_create:ip", meta.ip_or_unknown());
    let mut conn = state.db.acquire().await?;
    ensure_rate_room(
        &mut conn,
        &bucket,
        rate_limit::limits::SILICON_SELF_CREATE_PER_IP,
        SELF_CREATE_WHAT,
    )
    .await?;
    let recipient = notify::resolve_recipient(&mut conn, target, NAMED_FOR).await?;
    ensure_id_free(&mut conn, &id).await?;
    ensure_custodian_has_room(&mut conn, &recipient, &settings.public_url).await?;
    drop(conn);

    let new_stk = stk::prepare(state, chosen_stk).await?;
    let webhook = match &webhook_url {
        Some(_) => Some(events::new_webhook_secret(&state.keys.keyring)?),
        None => None,
    };
    let request_token = crypto::random_token(prefix::SILICON_REQUEST);

    let mut tx = state.db.begin().await?;
    lock_recipient(&mut tx, &recipient).await?;
    // A Carbon named by c:id must still be there when the request is stored (it could have
    // deleted its account since it was resolved above).
    recipient.lock_named(&mut tx, NAMED_FOR).await?;
    ensure_custodian_has_room(&mut tx, &recipient, &settings.public_url).await?;
    let silicon = accounts::create_silicon(
        &mut tx,
        settings,
        NewSilicon {
            id,
            display_name,
            pfp_url,
            timezone,
            status: AccountStatus::PendingCustodian,
            custodian_uuid: None,
            stk_hash: new_stk.hash.clone(),
            webhook_url: webhook_url.clone(),
            webhook_secret_enc: webhook.as_ref().map(|(_, enc)| enc.clone()),
            actor: "self".into(),
        },
    )
    .await?;
    // The Silicon is the actor of its own creation, but its uuid only exists now.
    sqlx::query(
        "update handle_history set changed_by = $1 where account_uuid = $1 and changed_by = 'self'",
    )
    .bind(&silicon.uuid)
    .execute(&mut *tx)
    .await?;
    let token_hash = state.keys.pepper.hash(&request_token);
    let request = requests::insert(
        &mut tx,
        &NewRequest {
            silicon_uuid: &silicon.uuid,
            kind: kind::INITIAL,
            from_uuid: None,
            to_uuid: recipient.to_uuid(),
            to_email: recipient.to_email(),
            request_token_hash: Some(&token_hash),
        },
    )
    .await?;
    let info = views::request_info(&mut tx, &request).await?;
    notify::silicon_created(&mut tx, &silicon, Some(&info)).await?;
    let mail =
        notify::mail_initial_request(&mut tx, settings, &silicon, &request, &recipient).await?;
    let actor = Actor::account(&silicon.uuid, meta.ip.as_deref());
    actor
        .record(
            &mut tx,
            "silicon.self_created",
            &silicon.uuid,
            &silicon.uuid,
            json!({"id": silicon.handle, "request_id": request.id.to_string(), "custodian": info.custodian,
                   "webhook": webhook_url.is_some(), "stk": if new_stk.generated { "generated" } else { "chosen" }}),
        )
        .await?;
    if let Some(custodian) = recipient.account_uuid() {
        actor
            .record(
                &mut tx,
                "silicon.custodian.requested",
                custodian,
                &silicon.uuid,
                json!({"id": silicon.handle, "request_id": request.id.to_string(), "kind": kind::INITIAL}),
            )
            .await?;
    }
    // Counted only now: failed attempts (taken id, unknown custodian) never use up the limit.
    rate_limit::enforce(
        &mut tx,
        &bucket,
        rate_limit::limits::SILICON_SELF_CREATE_PER_IP,
        SELF_CREATE_WHAT,
    )
    .await?;
    tx.commit().await?;
    if let Some(message_id) = mail {
        delivery::spawn_deliver(state, message_id);
    }
    tracing::info!(silicon = %silicon.uuid, id = ?silicon.handle, request = %request.id, "Silicon created its own account");
    state.telemetry.record(
        "api",
        "silicon.self_create",
        "silicon_self_created",
        json!({"named_by": if recipient.to_email().is_some() { "email" } else { "id" },
               "custodian_has_account": recipient.account.is_some(), "webhook": webhook_url.is_some(),
               "stk_generated": new_stk.generated}),
    );

    let mut conn = state.db.acquire().await?;
    let view = load_me(&mut conn, &silicon).await?;
    Ok((
        StatusCode::CREATED,
        json!({
            "silicon": view,
            "stk": new_stk.reveal(),
            "request": info,
            "request_token": request_token,
            "webhook_secret": webhook.map(|(secret, _)| secret),
        }),
    ))
}

/// Serializes self-creations naming the same custodian (the same c:id, or the same email
/// address), so the pending limit holds exactly. Keyed like the limit itself: by name.
async fn lock_recipient(conn: &mut PgConnection, recipient: &Recipient) -> ApiResult<()> {
    let key = match (recipient.to_uuid(), recipient.to_email()) {
        (Some(uuid), _) => format!("account:{uuid}"),
        (None, Some(email)) => format!("email:{email}"),
        (None, None) => return Ok(()),
    };
    sqlx::query("select pg_advisory_xact_lock(hashtextextended('custodian_requests:' || $1, 0))")
        .bind(key)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// 429 when 20 self-created Silicons are already waiting for this custodian: for a c:id, the
/// requests naming that c:id; for an email address, the requests naming that address. Counting
/// per name (not per account) keeps the answer from revealing whether an email address and a
/// c:id belong to the same Carbon.
async fn ensure_custodian_has_room(
    conn: &mut PgConnection,
    recipient: &Recipient,
    site: &str,
) -> ApiResult<()> {
    let (pending, first_expiry) =
        requests::pending_initial_load(conn, recipient.to_uuid(), recipient.to_email()).await?;
    if pending < MAX_PENDING_PER_CUSTODIAN {
        return Ok(());
    }
    let retry_after = first_expiry
        .map(|s| s.ceil().max(1.0) as u64)
        .unwrap_or(3600);
    let who = match &recipient.target {
        CarbonTarget::Id(id) => id.to_string(),
        CarbonTarget::Email(e) => e.clone(),
    };
    Err(ApiError::rate_limited(
        format!(
            "{who} already has {pending} self-created Silicons waiting for an answer; at most {MAX_PENDING_PER_CUSTODIAN} can wait for the same custodian (c:id or email address) at a time."
        ),
        retry_after,
    )
    .hint(format!(
        "Ask {who} to accept or decline the waiting requests on {site} (or `accounts custodian requests`), name another custodian, or retry after the oldest request expires in {retry_after} seconds."
    ))
    .detail("pending_requests", pending)
    .detail("limit", MAX_PENDING_PER_CUSTODIAN))
}

/// The `sarq_` token from `Authorization: Bearer …`.
fn request_token(headers: &HeaderMap) -> ApiResult<String> {
    let missing = || {
        ApiError::unauthenticated(
            "request_token_required",
            "Reading a custodian request needs its request token: send Authorization: Bearer sarq_….",
        )
        .hint("The token is the request_token returned by POST /v1/silicons (the CLI keeps it in ~/.accounts/requests/<id>.json).")
    };
    let raw = headers
        .get(AUTHORIZATION)
        .ok_or_else(missing)?
        .to_str()
        .map_err(|_| missing())?
        .trim();
    let (scheme, rest) = raw.split_once(' ').ok_or_else(missing)?;
    let token = rest.trim();
    if !scheme.eq_ignore_ascii_case("bearer") || token.is_empty() {
        return Err(missing());
    }
    if !token.starts_with(prefix::SILICON_REQUEST) {
        let what = crypto::describe_token(token).unwrap_or("not a Silicon Accounts token");
        return Err(ApiError::unauthenticated(
            "invalid_request_token",
            format!(
                "The bearer token must be the custodian request token (it starts with sarq_), but this is {what}."
            ),
        )
        .hint("Use the request_token returned by POST /v1/silicons together with its request id."));
    }
    Ok(token.to_string())
}

/// `GET /v1/silicons/requests/{id}`.
pub async fn request_status(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(raw_id): Path<String>,
) -> Result<Json<RequestStatusView>, ApiError> {
    let token = request_token(&headers)?;
    let not_found = || {
        ApiError::not_found(
            "custodian_request_not_found",
            format!(
                "No custodian request '{}' matches this request token.",
                raw_id.trim()
            ),
        )
        .hint("Use the request id and the request_token from the same POST /v1/silicons response.")
    };
    let id = crate::common::parse_request_id(&raw_id).ok_or_else(not_found)?;
    let mut conn = state.db.acquire().await?;
    let request = requests::get(&mut conn, id).await?.ok_or_else(not_found)?;
    let token_ok = request
        .request_token_hash
        .as_deref()
        .is_some_and(|stored| state.keys.pepper.verify(&token, stored));
    if !token_ok {
        return Err(not_found());
    }
    if request.is_overdue() || request.status == requests::status::CANCELLED {
        // The sweep runs every minute; make an expiry (or the release of a Silicon whose named
        // custodian deleted their account) real right now. The pooled connection is returned
        // first so one request never holds two.
        drop(conn);
        let mut tx = state.db.begin().await?;
        if let Some(locked) = requests::lock(&mut tx, id).await? {
            if locked.is_overdue() {
                lifecycle::expire(&mut tx, &locked).await?;
            } else {
                lifecycle::release_orphan(&mut tx, &locked).await?;
            }
        }
        tx.commit().await?;
        conn = state.db.acquire().await?;
    }
    let request = requests::get(&mut conn, id).await?.ok_or_else(not_found)?;
    Ok(Json(views::request_status_view(&mut conn, &request).await?))
}
