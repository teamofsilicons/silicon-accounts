//! The custodian's side (`session(carbon)`), under `/v1/me/silicons`. `{uuid}` also accepts the
//! Silicon's current si:id. Silicons the caller is not custodian of are 404 `silicon_not_found`.
//!
//! | endpoint | does |
//! |---|---|
//! | `GET /v1/me/silicons` | my Silicons (paginated), each with `pending_transfer` |
//! | `POST /v1/me/silicons` (IDEMPOTENT) | create a Silicon with me as custodian (active at once) |
//! | `GET /v1/me/silicons/{uuid}` | one Silicon |
//! | `PATCH /v1/me/silicons/{uuid}` | display name, timezone, photo (`null` = default) |
//! | `POST /v1/me/silicons/{uuid}/id` | change its si:id (old id reserved 10 days) |
//! | `PUT`/`DELETE /v1/me/silicons/{uuid}/webhook` | its webhook (new secret each time) |
//! | `POST /v1/me/silicons/{uuid}/stk` | rotate its STK: old STK dead, every session revoked |
//! | `POST`/`DELETE /v1/me/silicons/{uuid}/transfer` | ask another Carbon to take it over / cancel |
//! | `DELETE /v1/me/silicons/{uuid}` `{"confirm"}` | delete it (as account deletion: also its uploaded photos) |
//!
//! An STK rotation ends every sign-in of the Silicon: its token families (apps are told
//! `membership.signed_out`, reason `stk_rotated`) and browser sessions are revoked under the
//! Silicon's row lock, and `stk_rotated_at` is stamped with the moment the rotation takes effect.
//! Short-lived tokens minted before it are refused by the token endpoint (they are older than
//! `stk_rotated_at`), and one can't be minted while the rotation runs (`common::lock_live_session`).

use accounts_core::delivery;
use accounts_core::error::{ApiError, ApiResult, FieldErrors};
use accounts_core::events::{self, signout_reason};
use accounts_core::http::{CarbonAuth, ClientMeta, IdempotencyKey, Json, PageParams, Path, Query};
use accounts_core::ids::AccountId;
use accounts_core::models::{Account, AccountKind, AccountStatus};
use accounts_core::pfp::default_pfp_url;
use accounts_core::repo::accounts::{self, NewSilicon, ProfileUpdate};
use accounts_core::repo::rate_limit::{self, Limit};
use accounts_core::repo::{idempotency, photos, sessions, tokens};
use accounts_core::state::AppState;
use accounts_core::timefmt::format_rfc3339_ms;
use accounts_core::views::Page;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::common::{
    ensure_id_free, lock_my_silicon, lock_own_account, my_silicon, set_silicon_webhook,
};
use crate::history::{Actor, custody, url_origin};
use crate::input::{self, CarbonTarget, check};
use crate::notify;
use crate::own_webhook::{WebhookBody, webhook_url};
use crate::requests::{self, NewRequest, kind};
use crate::self_create::idempotency_fingerprint;
use crate::views::{self, SiliconItem};
use crate::{lifecycle, stk};

/// Transfer requests a custodian may send per hour: every request emails the receiving Carbon,
/// so cancel-and-resend loops must not turn into a way to flood someone's inbox.
pub const TRANSFERS_PER_CUSTODIAN: Limit = Limit::new(30, 3600);

// ---- list / create / show -------------------------------------------------------------------

/// `GET /v1/me/silicons`.
pub async fn list(
    State(state): State<AppState>,
    me: CarbonAuth,
    Query(page): Query<PageParams>,
) -> Result<Json<Page<SiliconItem>>, ApiError> {
    let limit = page.limit();
    let after: Option<i64> = page.cursor()?;
    let mut conn = state.db.acquire().await?;
    let rows = sqlx::query_as::<_, Account>(concat!(
        "select ",
        accounts_core::account_columns!(),
        " from accounts where custodian_uuid = $1 and kind = 'silicon' and status <> 'deleted' \
          and ($2::bigint is null or number > $2) order by number limit $3"
    ))
    .bind(me.uuid())
    .bind(after)
    .bind(limit + 1)
    .fetch_all(&mut *conn)
    .await?;
    let page = accounts_core::http::paginate(rows, limit, |a| a.number);
    let items = views::silicon_items(&mut conn, &page.items, Some(&me.account)).await?;
    Ok(Json(Page::new(items, page.next_cursor)))
}

/// `POST /v1/me/silicons` body.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CreateBody {
    pub id: String,
    pub display_name: String,
    #[serde(default)]
    pub timezone: Option<String>,
    #[serde(default)]
    pub pfp_url: Option<String>,
    #[serde(default)]
    pub stk: Option<String>,
    #[serde(default)]
    pub webhook_url: Option<String>,
}

/// `POST /v1/me/silicons`.
pub async fn create(
    State(state): State<AppState>,
    me: CarbonAuth,
    meta: ClientMeta,
    key: Option<IdempotencyKey>,
    Json(body): Json<CreateBody>,
) -> Result<Response, ApiError> {
    let scope = idempotency::scope(&format!("account:{}", me.uuid()), "POST", "/v1/me/silicons");
    let fingerprint = idempotency_fingerprint(&body, &state.keys.pepper);
    // Secret-bearing: core stores the response sealed with the keyring (10-minute replay).
    idempotency::run(&state, key.as_deref(), &scope, &fingerprint, true, || {
        create_silicon(&state, &me, &meta, body)
    })
    .await
}

async fn create_silicon(
    state: &AppState,
    me: &CarbonAuth,
    meta: &ClientMeta,
    body: CreateBody,
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
        input::timezone(body.timezone.as_deref(), Some(me.account.timezone.as_str())),
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
    fields.into_result()?;
    let (Some(display_name), Some(timezone), Some(pfp_url), Some(chosen_stk), Some(webhook_url)) =
        (display_name, timezone, pfp_url, chosen_stk, webhook_url)
    else {
        return Err(ApiError::internal("validated create fields are missing"));
    };

    let mut conn = state.db.acquire().await?;
    ensure_id_free(&mut conn, &id).await?;
    drop(conn);
    let new_stk = stk::prepare(state, chosen_stk).await?;
    let webhook = match &webhook_url {
        Some(_) => Some(events::new_webhook_secret(&state.keys.keyring)?),
        None => None,
    };

    let mut tx = state.db.begin().await?;
    // The custodian must still exist when the Silicon is stored: this serializes with the
    // Carbon's own account deletion (see `common::lock_own_account`).
    let custodian = lock_own_account(&mut tx, &me.account, "create a Silicon").await?;
    // A photo of this service must be one the custodian uploaded (the Silicon has none yet).
    if let Some(url) = &pfp_url {
        photos::check_usable(&mut tx, settings, url, &[me.uuid()], "you").await?;
    }
    let silicon = accounts::create_silicon(
        &mut tx,
        settings,
        NewSilicon {
            id,
            display_name,
            pfp_url,
            timezone,
            status: AccountStatus::Active,
            custodian_uuid: Some(custodian.uuid.clone()),
            stk_hash: new_stk.hash.clone(),
            webhook_url: webhook_url.clone(),
            webhook_secret_enc: webhook.as_ref().map(|(_, enc)| enc.clone()),
            actor: custodian.uuid.clone(),
        },
    )
    .await?;
    crate::history::custodian_change(
        &mut tx,
        &silicon.uuid,
        None,
        me.uuid(),
        custody::CREATED_BY_CUSTODIAN,
        None,
    )
    .await?;
    notify::silicon_created(&mut tx, &silicon, None).await?;
    // Listed in the histories through custodian_history (`created_by_custodian`).
    Actor::account(me.uuid(), meta.ip.as_deref())
        .record_unlisted(
            &mut tx,
            "silicon.created",
            ("silicon", &silicon.uuid),
            None,
            json!({"id": silicon.handle, "custodian": custodian.handle, "webhook": webhook_url.is_some(),
                   "stk": if new_stk.generated { "generated" } else { "chosen" }}),
        )
        .await?;
    tx.commit().await?;
    tracing::info!(silicon = %silicon.uuid, custodian = %me.uuid(), "Carbon created a Silicon");

    let mut conn = state.db.acquire().await?;
    let item = views::silicon_item(&mut conn, &silicon).await?;
    Ok((
        StatusCode::CREATED,
        json!({
            "silicon": item,
            "stk": new_stk.reveal(),
            "webhook_secret": webhook.map(|(secret, _)| secret),
        }),
    ))
}

/// `GET /v1/me/silicons/{uuid}`.
pub async fn show(
    State(state): State<AppState>,
    me: CarbonAuth,
    Path(key): Path<String>,
) -> Result<Json<SiliconItem>, ApiError> {
    let mut conn = state.db.acquire().await?;
    let silicon = my_silicon(&mut conn, me.uuid(), &key).await?;
    Ok(Json(views::silicon_item(&mut conn, &silicon).await?))
}

// ---- profile and id -------------------------------------------------------------------------

/// `PATCH /v1/me/silicons/{uuid}` body. `pfp_url: null` resets the photo to the default one.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UpdateBody {
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub timezone: Option<String>,
    #[serde(default, deserialize_with = "input::double_option")]
    pub pfp_url: Option<Option<String>>,
    /// Refused with a precise error: a Silicon's dob is its creation date.
    #[serde(default)]
    pub dob: Option<Value>,
    /// Refused with a precise error: ids change through `POST …/id`.
    #[serde(default)]
    pub id: Option<Value>,
}

/// `PATCH /v1/me/silicons/{uuid}`.
pub async fn update(
    State(state): State<AppState>,
    me: CarbonAuth,
    meta: ClientMeta,
    Path(key): Path<String>,
    Json(body): Json<UpdateBody>,
) -> Result<Json<SiliconItem>, ApiError> {
    let mut tx = state.db.begin().await?;
    let silicon = lock_my_silicon(&mut tx, me.uuid(), &key).await?;
    // A client sending the whole profile back unchanged is fine; a different dob or id is not.
    let same_dob = body.dob.as_ref().is_none_or(|v| {
        v.as_str()
            .and_then(|s| accounts_core::timefmt::parse_date(s).ok())
            == Some(silicon.dob)
    });
    let same_id = body.id.as_ref().is_none_or(|v| {
        v.as_str()
            .and_then(|s| AccountId::parse_for_kind(s, AccountKind::Silicon).ok())
            .map(|id| id.to_string())
            == silicon.handle
    });
    if !same_dob {
        return Err(ApiError::unprocessable(
            "dob_immutable",
            format!(
                "A Silicon's date of birth is the day its account was created ({}) and can't change.",
                accounts_core::timefmt::format_date(silicon.dob)
            ),
        )
        .hint("Leave dob out of the request."));
    }
    let mut fields = FieldErrors::new();
    if !same_id {
        fields.add(
            "id",
            format!(
                "can't be changed with PATCH; use POST /v1/me/silicons/{}/id (it reserves the old id for 10 days and tells apps)",
                silicon.uuid
            ),
        );
    }
    let display_name = match &body.display_name {
        Some(n) => check(&mut fields, "display_name", input::display_name(n)),
        None => None,
    };
    let timezone = match &body.timezone {
        Some(tz) => check(&mut fields, "timezone", input::timezone(Some(tz), None)),
        None => None,
    };
    let pfp_url = match &body.pfp_url {
        None => None,
        Some(None) => Some(default_pfp_url(
            &state.settings.iris_base_url,
            AccountKind::Silicon,
            &silicon.uuid,
        )),
        Some(Some(url)) => check(
            &mut fields,
            "pfp_url",
            input::pfp_url(&state.settings, Some(url)),
        )
        .flatten(),
    };
    fields.into_result()?;
    // Sending back the current photo changes nothing (it may be a former custodian's upload);
    // a new photo of this service must be the custodian's or the Silicon's own upload.
    if let Some(url) = pfp_url.as_deref().filter(|u| *u != silicon.pfp_url) {
        photos::check_usable(
            &mut tx,
            &state.settings,
            url,
            &[me.uuid(), &silicon.uuid],
            &format!("you or {}", silicon.display_id()),
        )
        .await?;
    }
    let (updated, changed) = accounts::update_profile(
        &mut tx,
        &silicon.uuid,
        &ProfileUpdate {
            display_name,
            timezone,
            dob: None,
            pfp_url,
        },
    )
    .await?;
    if !changed.is_empty() {
        events::notify_profile_updated(&mut tx, &updated, &changed).await?;
        Actor::account(me.uuid(), meta.ip.as_deref())
            .record_for(
                &mut tx,
                "silicon.profile.updated",
                &[Some(&updated.uuid), Some(me.uuid())],
                &updated.uuid,
                json!({"changed": changed}),
            )
            .await?;
    }
    tx.commit().await?;
    let mut conn = state.db.acquire().await?;
    Ok(Json(views::silicon_item(&mut conn, &updated).await?))
}

/// `{"id": "si:new"}`.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IdBody {
    pub id: String,
}

/// `POST /v1/me/silicons/{uuid}/id`.
pub async fn change_id(
    State(state): State<AppState>,
    me: CarbonAuth,
    meta: ClientMeta,
    Path(key): Path<String>,
    Json(body): Json<IdBody>,
) -> Result<Json<SiliconItem>, ApiError> {
    let new_id = input::silicon_id(&body.id)?;
    let mut tx = state.db.begin().await?;
    let silicon = lock_my_silicon(&mut tx, me.uuid(), &key).await?;
    let change = accounts::change_id(&mut tx, &silicon.uuid, &new_id, me.uuid()).await?;
    if change.changed {
        events::notify_id_changed(&mut tx, &change.account, &change.old_id, &change.new_id).await?;
        Actor::account(me.uuid(), meta.ip.as_deref())
            .record_for(
                &mut tx,
                "silicon.id.changed",
                &[Some(&silicon.uuid), Some(me.uuid())],
                &silicon.uuid,
                json!({"old_id": change.old_id, "new_id": change.new_id, "reclaimed": change.reclaimed}),
            )
            .await?;
    }
    tx.commit().await?;
    let mut conn = state.db.acquire().await?;
    Ok(Json(views::silicon_item(&mut conn, &change.account).await?))
}

// ---- webhook --------------------------------------------------------------------------------

/// `PUT /v1/me/silicons/{uuid}/webhook`.
pub async fn set_webhook(
    State(state): State<AppState>,
    me: CarbonAuth,
    meta: ClientMeta,
    Path(key): Path<String>,
    Json(body): Json<WebhookBody>,
) -> Result<Json<Value>, ApiError> {
    let url = webhook_url(&state, &body)?;
    let mut tx = state.db.begin().await?;
    let silicon = lock_my_silicon(&mut tx, me.uuid(), &key).await?;
    let secret = set_silicon_webhook(&mut tx, &state, &silicon.uuid, &url).await?;
    Actor::account(me.uuid(), meta.ip.as_deref())
        .record_for(
            &mut tx,
            "silicon.webhook.set",
            &[Some(&silicon.uuid), Some(me.uuid())],
            &silicon.uuid,
            json!({"url_origin": url_origin(&url), "by": "custodian"}),
        )
        .await?;
    tx.commit().await?;
    Ok(Json(json!({"webhook_url": url, "webhook_secret": secret})))
}

/// `DELETE /v1/me/silicons/{uuid}/webhook`.
pub async fn remove_webhook(
    State(state): State<AppState>,
    me: CarbonAuth,
    meta: ClientMeta,
    Path(key): Path<String>,
) -> Result<Response, ApiError> {
    let mut tx = state.db.begin().await?;
    let silicon = lock_my_silicon(&mut tx, me.uuid(), &key).await?;
    if silicon.webhook_url.is_some() {
        accounts::set_silicon_webhook(&mut tx, &silicon.uuid, None, None).await?;
        Actor::account(me.uuid(), meta.ip.as_deref())
            .record_for(
                &mut tx,
                "silicon.webhook.removed",
                &[Some(&silicon.uuid), Some(me.uuid())],
                &silicon.uuid,
                json!({"by": "custodian"}),
            )
            .await?;
    }
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

// ---- STK ------------------------------------------------------------------------------------

/// `{"stk": "…"}` to choose the new STK; `{}` to generate one.
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RotateBody {
    #[serde(default)]
    pub stk: Option<String>,
}

/// `POST /v1/me/silicons/{uuid}/stk` (an Idempotency-Key is honoured, so a retried rotation
/// returns the same generated STK instead of rotating twice).
pub async fn rotate_stk(
    State(state): State<AppState>,
    me: CarbonAuth,
    meta: ClientMeta,
    key: Option<IdempotencyKey>,
    Path(silicon_key): Path<String>,
    Json(body): Json<RotateBody>,
) -> Result<Response, ApiError> {
    let scope = idempotency::scope(
        &format!("account:{}", me.uuid()),
        "POST",
        &format!("/v1/me/silicons/{}/stk", silicon_key.trim()),
    );
    let fingerprint = idempotency_fingerprint(&body, &state.keys.pepper);
    idempotency::run(&state, key.as_deref(), &scope, &fingerprint, true, || {
        rotate(&state, &me, &meta, &silicon_key, body)
    })
    .await
}

async fn rotate(
    state: &AppState,
    me: &CarbonAuth,
    meta: &ClientMeta,
    silicon_key: &str,
    body: RotateBody,
) -> ApiResult<(StatusCode, Value)> {
    let chosen = input::chosen_stk(body.stk.as_deref()).map_err(|problem| {
        let mut fields = FieldErrors::new();
        fields.add("stk", problem);
        ApiError::validation(fields)
    })?;
    // Custody first, so a stranger's request never costs an Argon2 hash.
    let mut conn = state.db.acquire().await?;
    my_silicon(&mut conn, me.uuid(), silicon_key).await?;
    drop(conn);
    let new_stk = stk::prepare(state, chosen).await?;

    let mut tx = state.db.begin().await?;
    let silicon = lock_my_silicon(&mut tx, me.uuid(), silicon_key).await?;
    // Core stamps `stk_rotated_at` with the statement's clock once the row is locked, so every
    // SLT stored before this rotation is older than it (see `accounts::set_stk`).
    let rotated_at = accounts::set_stk(&mut tx, &silicon.uuid, &new_stk.hash).await?;
    let families = tokens::revoke_families(
        &mut tx,
        &tokens::RevokeFilter {
            account_uuid: &silicon.uuid,
            ..Default::default()
        },
        signout_reason::STK_ROTATED,
    )
    .await?;
    events::signed_out_for_families(&mut tx, &families, signout_reason::STK_ROTATED).await?;
    let sessions = sessions::revoke_all(&mut tx, &silicon.uuid, None).await?;
    notify::stk_rotated(&mut tx, &silicon, rotated_at, &me.account).await?;
    Actor::account(me.uuid(), meta.ip.as_deref())
        .record_for(
            &mut tx,
            "silicon.stk.rotated",
            &[Some(&silicon.uuid), Some(me.uuid())],
            &silicon.uuid,
            json!({"stk": if new_stk.generated { "generated" } else { "chosen" },
                   "revoked_token_families": families.len(), "revoked_browser_sessions": sessions}),
        )
        .await?;
    tx.commit().await?;
    tracing::info!(silicon = %silicon.uuid, revoked = families.len(), "Silicon STK rotated");
    Ok((
        StatusCode::OK,
        json!({
            "stk": new_stk.reveal(),
            "rotated_at": format_rfc3339_ms(rotated_at),
            "revoked_sessions": families.len() as u64 + sessions,
        }),
    ))
}

// ---- transfer -------------------------------------------------------------------------------

/// `{"to": "c:x" | "x@example.com"}`.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TransferBody {
    pub to: String,
}

/// `POST /v1/me/silicons/{uuid}/transfer` → 201 `{"request": RequestView}`.
pub async fn transfer(
    State(state): State<AppState>,
    me: CarbonAuth,
    meta: ClientMeta,
    Path(key): Path<String>,
    Json(body): Json<TransferBody>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let target = CarbonTarget::parse(&body.to).map_err(|problem| {
        let mut fields = FieldErrors::new();
        fields.add("to", problem);
        ApiError::validation(fields)
    })?;
    let mut conn = state.db.acquire().await?;
    let silicon = my_silicon(&mut conn, me.uuid(), &key).await?;
    let recipient = notify::resolve_recipient(&mut conn, target, "receive a Silicon").await?;
    if recipient.is_carbon(&mut conn, &me.account).await? {
        return Err(ApiError::unprocessable(
            "transfer_to_self",
            format!(
                "You are already the custodian of {}; a transfer must go to another Carbon.",
                silicon.display_id()
            ),
        )
        .hint("Pass the c:id or email of the Carbon who should become its custodian."));
    }
    drop(conn);

    let mut tx = state.db.begin().await?;
    // Request first, then Silicon, then the receiving Carbon: the order every decision path uses.
    let pending = requests::pending_for_silicon(&mut tx, &silicon.uuid, true).await?;
    let silicon = lock_my_silicon(&mut tx, me.uuid(), &silicon.uuid).await?;
    recipient.lock_named(&mut tx, "receive a Silicon").await?;
    if let Some(pending) = pending {
        if pending.is_overdue() {
            // Its 14 days are over; the sweep just hasn't recorded it yet.
            lifecycle::expire(&mut tx, &pending).await?;
        } else {
            let to = views::to_value(&mut tx, &pending).await?;
            return Err(ApiError::conflict(
                "transfer_pending",
                format!(
                    "{} already has a pending transfer (request {}, expires {}); a Silicon can have one at a time.",
                    silicon.display_id(),
                    pending.id,
                    format_rfc3339_ms(pending.expires_at)
                ),
            )
            .hint(format!(
                "Cancel it first with DELETE /v1/me/silicons/{}/transfer (`accounts silicon cancel-transfer {}`), then send the new one.",
                silicon.uuid,
                silicon.display_id()
            ))
            .detail("request_id", pending.id.to_string())
            .detail("to", to));
        }
    }
    let request = requests::insert(
        &mut tx,
        &NewRequest {
            silicon_uuid: &silicon.uuid,
            kind: kind::TRANSFER,
            from_uuid: Some(me.uuid()),
            to_uuid: recipient.to_uuid(),
            to_email: recipient.to_email(),
            request_token_hash: None,
        },
    )
    .await?;
    let mail = notify::mail_transfer_request(
        &mut tx,
        &state.settings,
        &silicon,
        &me.account,
        &request,
        &recipient,
    )
    .await?;
    Actor::account(me.uuid(), meta.ip.as_deref())
        .record_for(
            &mut tx,
            "silicon.transfer.requested",
            &[Some(&silicon.uuid), Some(me.uuid()), recipient.account_uuid()],
            &silicon.uuid,
            json!({"request_id": request.id.to_string(), "to": recipient.to_uuid().map(str::to_string)
                   .or_else(|| recipient.to_email().map(str::to_string))}),
        )
        .await?;
    rate_limit::enforce(
        &mut tx,
        &rate_limit::bucket("silicon_transfer:account", me.uuid()),
        TRANSFERS_PER_CUSTODIAN,
        "transfer requests from your account",
    )
    .await?;
    let view = views::request_view(&mut tx, &request).await?;
    tx.commit().await?;
    if let Some(message_id) = mail {
        delivery::spawn_deliver(&state, message_id);
    }
    Ok((StatusCode::CREATED, Json(json!({ "request": view }))))
}

/// `DELETE /v1/me/silicons/{uuid}/transfer`.
pub async fn cancel_transfer(
    State(state): State<AppState>,
    me: CarbonAuth,
    meta: ClientMeta,
    Path(key): Path<String>,
) -> Result<Response, ApiError> {
    let mut tx = state.db.begin().await?;
    let silicon = my_silicon(&mut tx, me.uuid(), &key).await?;
    // Request first, then Silicon: the order every decision path uses.
    let pending = requests::pending_for_silicon(&mut tx, &silicon.uuid, true).await?;
    let silicon = lock_my_silicon(&mut tx, me.uuid(), &silicon.uuid).await?;
    let not_found = |extra: String| {
        ApiError::not_found(
            "transfer_not_found",
            format!("{} has no pending transfer{extra}.", silicon.display_id()),
        )
        .hint("See its state with GET /v1/me/silicons/{uuid} (pending_transfer).")
    };
    let Some(request) = pending.filter(|r| r.kind == kind::TRANSFER) else {
        return Err(not_found(String::new()));
    };
    if request.is_overdue() {
        lifecycle::expire(&mut tx, &request).await?;
        tx.commit().await?;
        return Err(not_found(format!(
            " (the last one expired at {})",
            format_rfc3339_ms(request.expires_at)
        )));
    }
    lifecycle::cancel_transfer(
        &mut tx,
        &request,
        &me.account,
        Actor::account(me.uuid(), meta.ip.as_deref()),
    )
    .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

// ---- delete ---------------------------------------------------------------------------------

/// `{"confirm": "si:scout"}` — the Silicon's current id.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeleteBody {
    pub confirm: String,
}

/// `DELETE /v1/me/silicons/{uuid}`.
pub async fn delete(
    State(state): State<AppState>,
    me: CarbonAuth,
    meta: ClientMeta,
    Path(key): Path<String>,
    Json(body): Json<DeleteBody>,
) -> Result<Response, ApiError> {
    let mut tx = state.db.begin().await?;
    let silicon = my_silicon(&mut tx, me.uuid(), &key).await?;
    // Request first, then Silicon (deletion cancels a pending transfer).
    requests::pending_for_silicon(&mut tx, &silicon.uuid, true).await?;
    let silicon = lock_my_silicon(&mut tx, me.uuid(), &silicon.uuid).await?;
    let current = silicon.display_id();
    let confirmed = AccountId::parse_for_kind(&body.confirm, AccountKind::Silicon)
        .map(|id| silicon.handle.as_deref() == Some(id.to_string().as_str()))
        .unwrap_or(false);
    if !confirmed {
        return Err(ApiError::unprocessable(
            "confirmation_mismatch",
            format!(
                "confirm must be the Silicon's current id {current}, but it is '{}'.",
                body.confirm.trim()
            ),
        )
        .hint(format!(
            "Send {{\"confirm\": \"{current}\"}} to delete it; deleting can't be undone."
        )));
    }
    // Core does all of it, as for a Carbon's own deletion: sign-ins and proofs revoked, the
    // photo back to the default and its uploads deleted, apps told `account.deleted`.
    let deleted =
        accounts::delete_account(&mut tx, &state.settings, &silicon.uuid, me.uuid(), true).await?;
    let deleted_photos = deleted.deleted_photos;
    Actor::account(me.uuid(), meta.ip.as_deref())
        .record_for(
            &mut tx,
            "silicon.deleted",
            &[Some(&silicon.uuid), Some(me.uuid())],
            &silicon.uuid,
            json!({"id": deleted.old_id, "revoked_token_families": deleted.revoked_families,
                   "revoked_proofs": deleted.revoked_proofs, "deleted_photos": deleted_photos}),
        )
        .await?;
    tx.commit().await?;
    tracing::info!(silicon = %silicon.uuid, custodian = %me.uuid(), "custodian deleted a Silicon");
    Ok(StatusCode::NO_CONTENT.into_response())
}
