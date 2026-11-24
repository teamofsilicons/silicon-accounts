//! A Carbon's passkeys: list, add, rename, remove (Anil, 2026-11-23). Signing in with one is in
//! the hosted flow (crates/auth). The WebAuthn checks are in `accounts_core::webauthn`.
//!
//! Adding a passkey is a browser ceremony on the account site, so it needs the account site's
//! session and a recent sign-in (`PASSKEY_REAUTH_MINUTES`): someone holding a stolen session
//! cookie can't quietly add a passkey of their own and keep a way in.

use accounts_core::http::{AuthVia, CarbonAuth, ClientMeta, Json, Path};
use accounts_core::repo::{accounts, passkeys, rate_limit, sessions};
use accounts_core::views::PasskeyView;
use accounts_core::webauthn::{self, RegistrationResponse, RelyingParty, UserEntity};
use accounts_core::{ApiError, ApiResult, AppState};
use axum::extract::State;
use axum::http::StatusCode;
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::PgConnection;
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

use crate::util::{audit_self, clip, single_page};

/// How recent the browser's sign-in must be to add a passkey.
pub const PASSKEY_REAUTH_MINUTES: i64 = 30;

/// Passkey ceremonies started by one account per hour.
const REGISTRATIONS_PER_ACCOUNT: rate_limit::Limit = rate_limit::Limit {
    max: 30,
    window_seconds: 3600,
};

/// `GET /v1/me/passkeys` → `{"items":[{"id","name","backed_up","created_at","last_used_at"}],
/// "next_cursor":null}`, oldest first.
pub(crate) async fn list(State(state): State<AppState>, me: CarbonAuth) -> ApiResult<Json<Value>> {
    let mut conn = state.db.acquire().await?;
    let rows = passkeys::list_for_account(&mut conn, me.uuid()).await?;
    let views: Vec<PasskeyView> = rows.iter().map(PasskeyView::from).collect();
    Ok(Json(single_page(&views)?))
}

/// The account site's session with a sign-in no older than `PASSKEY_REAUTH_MINUTES`.
async fn require_recent_session(conn: &mut PgConnection, me: &CarbonAuth) -> ApiResult<()> {
    let AuthVia::Session { session_id } = me.via else {
        return Err(ApiError::bad_request(
            "browser_session_required",
            "A passkey is added in a browser, on the account site: this request used an access token.",
        )
        .hint("Open Security on the account site and choose Add a Passkey."));
    };
    let at = sessions::authenticated_at(conn, session_id).await?;
    let fresh = at.is_some_and(|at| {
        OffsetDateTime::now_utc() - at <= Duration::minutes(PASSKEY_REAUTH_MINUTES)
    });
    if !fresh {
        return Err(ApiError::forbidden(
            "reauthentication_required",
            format!(
                "Adding a passkey needs a sign-in from the last {PASSKEY_REAUTH_MINUTES} minutes."
            ),
        )
        .hint("Sign in again on the account site (prompt=login), then add the passkey."));
    }
    Ok(())
}

/// `POST /v1/me/passkeys/options` (Carbon, account site session, recent sign-in) → the
/// `PublicKeyCredentialCreationOptionsJSON` to pass to `navigator.credentials.create()`. Opens a
/// registration for five minutes; a newer one replaces it.
pub(crate) async fn options(
    State(state): State<AppState>,
    me: CarbonAuth,
) -> ApiResult<Json<Value>> {
    let mut tx = state.db.begin().await?;
    require_recent_session(&mut tx, &me).await?;
    rate_limit::enforce(
        &mut tx,
        &rate_limit::bucket("passkey_registration:account", me.uuid()),
        REGISTRATIONS_PER_ACCOUNT,
        "passkeys started by this account",
    )
    .await?;
    accounts::lock(&mut tx, me.uuid()).await?;
    let existing = passkeys::list_for_account(&mut tx, me.uuid()).await?;
    if existing.len() as i64 >= passkeys::MAX_PER_ACCOUNT {
        return Err(ApiError::conflict(
            "passkey_limit",
            format!(
                "An account can have {} passkeys; remove one before adding another.",
                passkeys::MAX_PER_ACCOUNT
            ),
        )
        .hint("Remove a passkey you no longer use with DELETE /v1/me/passkeys/{id}."));
    }
    let primary_email: Option<String> = sqlx::query_scalar(
        "select email from account_emails where account_uuid = $1 and is_primary",
    )
    .bind(me.uuid())
    .fetch_optional(&mut *tx)
    .await?;
    let handle = me.account.display_id();
    let challenge = webauthn::new_challenge();
    passkeys::open_registration(&mut tx, me.uuid(), &challenge).await?;
    let rp = RelyingParty::from_settings(&state.settings);
    let exclude: Vec<Vec<u8>> = existing.into_iter().map(|p| p.credential_id).collect();
    let options = webauthn::creation_options(
        &rp,
        &UserEntity {
            id: me.uuid().as_bytes(),
            name: primary_email.as_deref().unwrap_or(&handle),
            display_name: &me.account.display_name,
        },
        &challenge,
        &exclude,
    );
    tx.commit().await?;
    Ok(Json(options))
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct AddBody {
    credential: Value,
    #[serde(default)]
    name: Option<String>,
}

fn passkey_name(raw: Option<&str>) -> ApiResult<String> {
    let name = raw
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .unwrap_or("Passkey");
    if name.chars().count() > 64 || name.chars().any(char::is_control) {
        return Err(ApiError::bad_request(
            "invalid_passkey_name",
            format!(
                "'{}' can't name a passkey: up to 64 characters, no line breaks.",
                clip(name, 40)
            ),
        )
        .hint(
            "Name it after the device or password manager that keeps it, e.g. 'iCloud Keychain'.",
        ));
    }
    Ok(name.to_string())
}

fn credential_refused(error: webauthn::WebauthnError) -> ApiError {
    tracing::info!(%error, "passkey refused");
    ApiError::bad_request(
        "passkey_invalid",
        "This passkey couldn't be checked, so it wasn't added.",
    )
    .hint("Try again from Add a Passkey; if it keeps failing, use another device or password manager.")
}

/// `POST /v1/me/passkeys` with `{"credential": <PublicKeyCredential.toJSON()>, "name"?}` →
/// 201 with the passkey. Finishes the registration opened by `/options`.
pub(crate) async fn add(
    State(state): State<AppState>,
    me: CarbonAuth,
    meta: ClientMeta,
    Json(body): Json<AddBody>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let name = passkey_name(body.name.as_deref())?;
    let response: RegistrationResponse = serde_json::from_value(body.credential).map_err(|_| {
        ApiError::bad_request(
            "passkey_invalid",
            "`credential` isn't a passkey: send PublicKeyCredential.toJSON() from navigator.credentials.create().",
        )
    })?;
    let mut tx = state.db.begin().await?;
    require_recent_session(&mut tx, &me).await?;
    accounts::lock(&mut tx, me.uuid()).await?;
    let challenge = passkeys::take_registration(&mut tx, me.uuid()).await?;
    let rp = RelyingParty::from_settings(&state.settings);
    let key = match webauthn::verify_registration(&rp, &challenge, &response) {
        Ok(key) => key,
        Err(error) => {
            // The registration stays used up: a refused credential can't be retried against it.
            tx.commit().await?;
            return Err(credential_refused(error));
        }
    };
    let row = passkeys::insert(&mut tx, me.uuid(), &key, &name).await?;
    audit_self(
        &mut tx,
        me.uuid(),
        "account.passkey.added",
        None,
        json!({ "passkey_id": row.id, "name": row.name, "backed_up": row.backed_up }),
        meta.ip.as_deref(),
    )
    .await?;
    tx.commit().await?;
    Ok((
        StatusCode::CREATED,
        Json(serde_json::to_value(PasskeyView::from(&row))?),
    ))
}

fn passkey_id(raw: &str) -> ApiResult<Uuid> {
    Uuid::parse_str(raw.trim()).map_err(|_| {
        ApiError::not_found(
            "passkey_not_found",
            format!("No passkey '{}' is on your account.", clip(raw.trim(), 40)),
        )
        .hint("List your passkeys with GET /v1/me/passkeys.")
    })
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RenameBody {
    name: String,
}

/// `PATCH /v1/me/passkeys/{id}` with `{"name"}` → the passkey.
pub(crate) async fn rename(
    State(state): State<AppState>,
    me: CarbonAuth,
    meta: ClientMeta,
    Path(id): Path<String>,
    Json(body): Json<RenameBody>,
) -> ApiResult<Json<Value>> {
    let id = passkey_id(&id)?;
    let name = passkey_name(Some(&body.name))?;
    let mut tx = state.db.begin().await?;
    let row = passkeys::rename(&mut tx, me.uuid(), id, &name).await?;
    audit_self(
        &mut tx,
        me.uuid(),
        "account.passkey.renamed",
        None,
        json!({ "passkey_id": row.id, "name": row.name }),
        meta.ip.as_deref(),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(serde_json::to_value(PasskeyView::from(&row))?))
}

/// `DELETE /v1/me/passkeys/{id}` → 204. Refused (409 `last_sign_in_method`) when it is the only
/// way left to sign in to the account.
pub(crate) async fn remove(
    State(state): State<AppState>,
    me: CarbonAuth,
    meta: ClientMeta,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let id = passkey_id(&id)?;
    let mut tx = state.db.begin().await?;
    // Lock the account so two removals can't both pass the "another way to sign in" check.
    accounts::lock(&mut tx, me.uuid()).await?;
    let row = passkeys::find_for_account_for_update(&mut tx, me.uuid(), id).await?;
    let others: i64 = sqlx::query_scalar(
        "select (select count(*) from account_emails where account_uuid = $1) \
              + (select count(*) from account_phones where account_uuid = $1) \
              + (select count(*) from identities where account_uuid = $1) \
              + (select count(*) from passkeys where account_uuid = $1 and id <> $2)",
    )
    .bind(me.uuid())
    .bind(id)
    .fetch_one(&mut *tx)
    .await?;
    if others == 0 {
        return Err(ApiError::conflict(
            "last_sign_in_method",
            format!(
                "This passkey is the only way to sign in to {}.",
                me.account.display_id()
            ),
        )
        .hint("Add an email (POST /v1/me/emails) or a phone number (POST /v1/me/phones) first, then remove it."));
    }
    passkeys::remove(&mut tx, me.uuid(), id).await?;
    audit_self(
        &mut tx,
        me.uuid(),
        "account.passkey.removed",
        None,
        json!({ "passkey_id": row.id, "name": row.name }),
        meta.ip.as_deref(),
    )
    .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}
