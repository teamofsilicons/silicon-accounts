//! A Carbon's emails and phone numbers: list, add (a 6-digit code is sent; purpose `add_email` /
//! `add_phone`), verify, make primary, remove.
//!
//! Rules (UNDERSTANDING.md): up to 10 of each; every one is verified before it's added; one is
//! always the primary and the primary can't be removed; an email or phone belongs to one account
//! only. A new primary (also the first one added), or a primary that becomes verified, changes
//! what apps see, so `version` bumps and apps holding the email/phone scope get
//! `account.updated`.
//!
//! Adding answers 409 `email_in_use` / `phone_in_use` when another account has the address, so
//! every add attempt is counted before that check ([`CONTACT_ADDS_PER_ACCOUNT`],
//! [`CONTACT_ADDS_PER_IP`]). Otherwise anyone signed in could check, without limit, whether an
//! address has an account.

use accounts_core::delivery;
use accounts_core::events;
use accounts_core::http::{CarbonAuth, ClientMeta, IdempotencyKey, Json, Path};
use accounts_core::models::{AccountField, OtpChannel, OtpPurpose, VerifiedVia};
use accounts_core::normalize;
use accounts_core::repo::contacts::{self, ContactKind};
use accounts_core::repo::rate_limit::{self, Limit};
use accounts_core::repo::{accounts, idempotency, otp};
use accounts_core::{ApiError, ApiResult, AppState, FieldErrors};
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::Response;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::PgConnection;
use uuid::Uuid;

use crate::util::{audit_self, idem_scope, single_page, track, ts};

/// Attempts to add an email or phone number (both kinds together) per account: 20 per 10
/// minutes. Every attempt counts, including those answered 409 or 422.
pub const CONTACT_ADDS_PER_ACCOUNT: Limit = Limit::new(20, 600);

/// Attempts to add an email or phone number per client IP, over all accounts: 30 per 10
/// minutes, the same as the per-IP limit on sending codes.
pub const CONTACT_ADDS_PER_IP: Limit = Limit::new(30, 600);

fn purpose(kind: ContactKind) -> OtpPurpose {
    match kind {
        ContactKind::Email => OtpPurpose::AddEmail,
        ContactKind::Phone => OtpPurpose::AddPhone,
    }
}

fn channel(kind: ContactKind) -> OtpChannel {
    match kind {
        ContactKind::Email => OtpChannel::Email,
        ContactKind::Phone => OtpChannel::Phone,
    }
}

fn field(kind: ContactKind) -> AccountField {
    match kind {
        ContactKind::Email => AccountField::Email,
        ContactKind::Phone => AccountField::Phone,
    }
}

fn route(kind: ContactKind) -> &'static str {
    match kind {
        ContactKind::Email => "/v1/me/emails",
        ContactKind::Phone => "/v1/me/phones",
    }
}

/// The account's emails or phones as `{"items":[…],"next_cursor":null}` (primary first).
async fn list_body(conn: &mut PgConnection, kind: ContactKind, uuid: &str) -> ApiResult<Value> {
    match kind {
        ContactKind::Email => single_page(&contacts::list_emails(conn, uuid).await?),
        ContactKind::Phone => single_page(&contacts::list_phones(conn, uuid).await?),
    }
}

async fn list(state: &AppState, kind: ContactKind, uuid: &str) -> ApiResult<Json<Value>> {
    let mut conn = state.db.acquire().await?;
    Ok(Json(list_body(&mut conn, kind, uuid).await?))
}

/// Normalizes a path value (`/v1/me/emails/{email}`, `/v1/me/phones/{phone}`).
fn normalize_path_value(kind: ContactKind, raw: &str) -> ApiResult<String> {
    Ok(match kind {
        ContactKind::Email => normalize::normalize_email(raw)?,
        ContactKind::Phone => normalize::normalize_phone(raw, None)?,
    })
}

/// Sends the code for a new email/phone after checking it can be added.
async fn add(
    state: &AppState,
    me: &CarbonAuth,
    meta: &ClientMeta,
    key: Option<&str>,
    kind: ContactKind,
    value: String,
    request: &impl Serialize,
) -> Result<Response, ApiError> {
    let scope = idem_scope(me.uuid(), "POST", route(kind));
    idempotency::run(&state.db, key, &scope, request, false, || async {
        // Counted on their own connections, before any answer about who has the address: a
        // 409 rolls the transaction below back, but these hits stay counted.
        rate_limit::enforce_pool(
            &state.db,
            &rate_limit::bucket("contact_add:account", me.uuid()),
            CONTACT_ADDS_PER_ACCOUNT,
            "attempts to add an email or phone number to this account",
        )
        .await?;
        if let Some(ip) = meta.ip.as_deref() {
            rate_limit::enforce_pool(
                &state.db,
                &rate_limit::bucket("contact_add:ip", ip),
                CONTACT_ADDS_PER_IP,
                "attempts to add an email or phone number from this network",
            )
            .await?;
        }
        let mut tx = state.db.begin().await?;
        contacts::check_can_add(&mut tx, kind, me.uuid(), &value).await?;
        let created = otp::send(
            &mut tx,
            &state.keys.pepper,
            &state.settings,
            &otp::NewChallenge {
                purpose: purpose(kind),
                channel: channel(kind),
                destination: &value,
                account_uuid: Some(me.uuid()),
                flow_id: None,
                ip: meta.ip.as_deref(),
            },
        )
        .await?;
        let message_id = delivery::enqueue_otp(
            &mut tx,
            &state.settings,
            &created.challenge,
            &created.code,
            None,
        )
        .await?;
        tx.commit().await?;
        delivery::spawn_deliver(state, message_id);
        track(
            state,
            kind.code(),
            "account.contact.code_sent",
            json!({ "channel": kind.code() }),
        );
        let ch = &created.challenge;
        Ok((
            StatusCode::CREATED,
            json!({
                "challenge_id": ch.id.to_string(),
                "channel": ch.channel,
                "destination": ch.destination,
                "expires_at": ts(ch.expires_at),
                "resend_available_at": ts(ch.resend_available_at()),
            }),
        ))
    })
    .await
}

#[derive(Debug, Deserialize, Serialize)]
pub(crate) struct VerifyBody {
    challenge_id: String,
    code: String,
}

/// Checks the code and adds the email/phone; returns the updated list.
async fn verify(
    state: &AppState,
    me: &CarbonAuth,
    meta: &ClientMeta,
    key: Option<&str>,
    kind: ContactKind,
    body: &VerifyBody,
) -> Result<Response, ApiError> {
    let Ok(challenge_id) = Uuid::parse_str(body.challenge_id.trim()) else {
        let mut f = FieldErrors::new();
        f.add(
            "challenge_id",
            format!(
                "'{}' is not a challenge id; use the challenge_id returned by POST {}",
                crate::util::clip(body.challenge_id.trim(), 60),
                route(kind)
            ),
        );
        return Err(ApiError::validation(f));
    };
    let scope = idem_scope(me.uuid(), "POST", &format!("{}/verify", route(kind)));
    idempotency::run(&state.db, key, &scope, body, false, || async {
        // Commits the attempt on its own, so wrong codes count even though this request fails.
        let challenge = otp::verify(
            &state.db,
            &state.keys.pepper,
            &state.settings,
            challenge_id,
            &body.code,
            &otp::Expect {
                purpose: Some(purpose(kind)),
                flow_id: None,
                account_uuid: Some(me.uuid()),
            },
        )
        .await?;
        let mut tx = state.db.begin().await?;
        // Re-checked under the row lock that deletion also takes. A request that authenticated
        // just before `DELETE /v1/me` committed must not attach the address to the deleted
        // account, where nobody could ever use it again.
        let live = accounts::lock(&mut tx, me.uuid())
            .await?
            .filter(|a| !a.is_deleted());
        if live.is_none() {
            return Err(ApiError::conflict(
                "account_deleted",
                format!(
                    "{} was deleted while this request was being handled, so {} was not added to it.",
                    me.account.display_id(),
                    challenge.destination
                ),
            )
            .hint(format!(
                "Nothing was changed. To use {}, sign up again or add it to another account.",
                challenge.destination
            )));
        }
        let outcome = contacts::add_verified(
            &mut tx,
            kind,
            me.uuid(),
            &challenge.destination,
            VerifiedVia::Code,
        )
        .await?;
        // Apps see the primary and whether it is verified, so a new primary and a primary that
        // just got verified (an imported address) are both changes to announce.
        let primary_verified = outcome.was_unverified
            && !outcome.became_primary
            && contacts::primary(&mut tx, kind, me.uuid())
                .await?
                .is_some_and(|p| p.value == challenge.destination);
        let announced = outcome.became_primary || primary_verified;
        if announced {
            let account = accounts::bump_version(&mut tx, me.uuid()).await?;
            events::account_updated(&mut tx, &account, &[field(kind)]).await?;
        }
        audit_self(
            &mut tx,
            me.uuid(),
            match kind {
                ContactKind::Email => "account.email.added",
                ContactKind::Phone => "account.phone.added",
            },
            None,
            json!({ kind.code(): challenge.destination, "primary": outcome.became_primary }),
            meta.ip.as_deref(),
        )
        .await?;
        let body = list_body(&mut tx, kind, me.uuid()).await?;
        tx.commit().await?;
        track(
            state,
            kind.code(),
            "account.contact.added",
            json!({ "channel": kind.code(), "primary": outcome.became_primary }),
        );
        Ok((StatusCode::OK, body))
    })
    .await
}

/// Makes a verified email/phone the primary; returns the updated list.
async fn make_primary(
    state: &AppState,
    me: &CarbonAuth,
    meta: &ClientMeta,
    kind: ContactKind,
    raw: &str,
) -> ApiResult<Json<Value>> {
    let value = normalize_path_value(kind, raw)?;
    let mut tx = state.db.begin().await?;
    let changed = contacts::set_primary(&mut tx, kind, me.uuid(), &value).await?;
    if changed {
        let account = accounts::bump_version(&mut tx, me.uuid()).await?;
        events::account_updated(&mut tx, &account, &[field(kind)]).await?;
        audit_self(
            &mut tx,
            me.uuid(),
            match kind {
                ContactKind::Email => "account.email.primary_changed",
                ContactKind::Phone => "account.phone.primary_changed",
            },
            None,
            json!({ kind.code(): value }),
            meta.ip.as_deref(),
        )
        .await?;
    }
    let body = list_body(&mut tx, kind, me.uuid()).await?;
    tx.commit().await?;
    if changed {
        track(
            state,
            kind.code(),
            "account.contact.primary_changed",
            json!({ "channel": kind.code() }),
        );
    }
    Ok(Json(body))
}

/// Removes a non-primary email/phone; returns the updated list.
async fn remove(
    state: &AppState,
    me: &CarbonAuth,
    meta: &ClientMeta,
    kind: ContactKind,
    raw: &str,
) -> ApiResult<Json<Value>> {
    let value = normalize_path_value(kind, raw)?;
    let mut tx = state.db.begin().await?;
    contacts::remove(&mut tx, kind, me.uuid(), &value).await?;
    audit_self(
        &mut tx,
        me.uuid(),
        match kind {
            ContactKind::Email => "account.email.removed",
            ContactKind::Phone => "account.phone.removed",
        },
        None,
        json!({ kind.code(): value }),
        meta.ip.as_deref(),
    )
    .await?;
    let body = list_body(&mut tx, kind, me.uuid()).await?;
    tx.commit().await?;
    track(
        state,
        kind.code(),
        "account.contact.removed",
        json!({ "channel": kind.code() }),
    );
    Ok(Json(body))
}

// ---- emails ----------------------------------------------------------------------------

/// `GET /v1/me/emails` → `{"items":[{"email","is_primary","verified_at","verified_via","created_at"}],"next_cursor":null}`.
pub(crate) async fn list_emails(
    State(state): State<AppState>,
    me: CarbonAuth,
) -> ApiResult<Json<Value>> {
    list(&state, ContactKind::Email, me.uuid()).await
}

#[derive(Debug, Deserialize, Serialize)]
pub(crate) struct AddEmailBody {
    email: String,
}

/// `POST /v1/me/emails` `{"email"}` → 201 `{"challenge_id","channel","destination","expires_at",
/// "resend_available_at"}`. 409 `email_in_use` / `email_already_added`, 422
/// `email_limit_reached` (10), 429 when too many codes went to that address or too many add
/// attempts came from this account or network.
pub(crate) async fn add_email(
    State(state): State<AppState>,
    me: CarbonAuth,
    meta: ClientMeta,
    key: Option<IdempotencyKey>,
    Json(body): Json<AddEmailBody>,
) -> Result<Response, ApiError> {
    let email = normalize::normalize_email(&body.email)?;
    add(
        &state,
        &me,
        &meta,
        key.as_deref(),
        ContactKind::Email,
        email,
        &body,
    )
    .await
}

/// `POST /v1/me/emails/verify` `{"challenge_id","code"}` → the updated email list.
pub(crate) async fn verify_email(
    State(state): State<AppState>,
    me: CarbonAuth,
    meta: ClientMeta,
    key: Option<IdempotencyKey>,
    Json(body): Json<VerifyBody>,
) -> Result<Response, ApiError> {
    verify(
        &state,
        &me,
        &meta,
        key.as_deref(),
        ContactKind::Email,
        &body,
    )
    .await
}

/// `POST /v1/me/emails/{email}/primary` → the updated email list.
pub(crate) async fn make_email_primary(
    State(state): State<AppState>,
    me: CarbonAuth,
    meta: ClientMeta,
    Path(email): Path<String>,
) -> ApiResult<Json<Value>> {
    make_primary(&state, &me, &meta, ContactKind::Email, &email).await
}

/// `DELETE /v1/me/emails/{email}` → the updated email list (409 `cannot_remove_primary`).
pub(crate) async fn remove_email(
    State(state): State<AppState>,
    me: CarbonAuth,
    meta: ClientMeta,
    Path(email): Path<String>,
) -> ApiResult<Json<Value>> {
    remove(&state, &me, &meta, ContactKind::Email, &email).await
}

// ---- phones ----------------------------------------------------------------------------

/// `GET /v1/me/phones` → `{"items":[{"phone","is_primary","verified_at","verified_via","created_at"}],"next_cursor":null}`.
pub(crate) async fn list_phones(
    State(state): State<AppState>,
    me: CarbonAuth,
) -> ApiResult<Json<Value>> {
    list(&state, ContactKind::Phone, me.uuid()).await
}

#[derive(Debug, Deserialize, Serialize)]
pub(crate) struct AddPhoneBody {
    phone: String,
    #[serde(default)]
    country: Option<String>,
}

/// `POST /v1/me/phones` `{"phone","country"?}` → 201 challenge (see [`add_email`]).
pub(crate) async fn add_phone(
    State(state): State<AppState>,
    me: CarbonAuth,
    meta: ClientMeta,
    key: Option<IdempotencyKey>,
    Json(body): Json<AddPhoneBody>,
) -> Result<Response, ApiError> {
    let phone = normalize::normalize_phone(&body.phone, body.country.as_deref())?;
    add(
        &state,
        &me,
        &meta,
        key.as_deref(),
        ContactKind::Phone,
        phone,
        &body,
    )
    .await
}

/// `POST /v1/me/phones/verify` `{"challenge_id","code"}` → the updated phone list.
pub(crate) async fn verify_phone(
    State(state): State<AppState>,
    me: CarbonAuth,
    meta: ClientMeta,
    key: Option<IdempotencyKey>,
    Json(body): Json<VerifyBody>,
) -> Result<Response, ApiError> {
    verify(
        &state,
        &me,
        &meta,
        key.as_deref(),
        ContactKind::Phone,
        &body,
    )
    .await
}

/// `POST /v1/me/phones/{phone}/primary` → the updated phone list.
pub(crate) async fn make_phone_primary(
    State(state): State<AppState>,
    me: CarbonAuth,
    meta: ClientMeta,
    Path(phone): Path<String>,
) -> ApiResult<Json<Value>> {
    make_primary(&state, &me, &meta, ContactKind::Phone, &phone).await
}

/// `DELETE /v1/me/phones/{phone}` → the updated phone list (409 `cannot_remove_primary`).
pub(crate) async fn remove_phone(
    State(state): State<AppState>,
    me: CarbonAuth,
    meta: ClientMeta,
    Path(phone): Path<String>,
) -> ApiResult<Json<Value>> {
    remove(&state, &me, &meta, ContactKind::Phone, &phone).await
}
