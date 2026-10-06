//! Sign-up: the 48-hour sign-up session (`signup_sessions` + the `sa_signup` cookie), the
//! prefilled details page and `POST /v1/flows/{id}/signup`.
//!
//! A sign-up session ties a verified email, phone or provider identity to the browser that
//! proved it, so the right verification goes to the right sign-up (UNDERSTANDING.md). It
//! outlives the 60-minute flow: a new flow in the same browser resumes at the sign-up step
//! for 48 hours without a new code.
//!
//! Finishing an imported account: the session names the `unclaimed` account its proven email
//! or phone belongs to (`claim_account_uuid`). The claim only holds while that account is
//! still unclaimed: the first Carbon to finish it gets it, the import's other (unproven)
//! emails and phones are removed from it, and every other sign-up that pointed at it becomes
//! an ordinary sign-up (it never sees or reaches the finished account).

use accounts_core::http::cookies::{SIGNUP_COOKIE, clear_cookie, read_cookie, signup_cookie};
use accounts_core::http::{ClientMeta, Json, Path};
use accounts_core::ids::AccountId;
use accounts_core::models::{
    Account, AccountField, AccountKind, AccountStatus, ActorKind, Provider, VerifiedVia,
};
use accounts_core::normalize::{
    normalize_timezone, validate_display_name, validate_dob, validate_pfp_url,
};
use accounts_core::repo::accounts::{self, NewCarbon, NewContact, ProfileUpdate};
use accounts_core::repo::audit::{self, AuditEntry};
use accounts_core::repo::contacts::{self, ContactKind};
use accounts_core::repo::identities;
use accounts_core::timefmt::{date, format_rfc3339_ms, parse_date, rfc3339_ms};
use accounts_core::{ApiError, ApiResult, AppState, FieldErrors, events};
use axum::extract::State;
use axum::http::{HeaderMap, Method};
use cookie::Cookie;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::json;
use sqlx::PgConnection;
use time::{Date, OffsetDateTime};
use uuid::Uuid;

use super::browser;
use super::model::{self, Flow, Step};
use super::view::{self, ViewContext};
use super::{FlowApp, FlowResponse, load_bound, next};
use crate::contact;
use crate::suggest;
use crate::util::telemetry;

/// Sign-up sessions last 48 hours (UNDERSTANDING.md "Sign up").
pub const SIGNUP_TTL_HOURS: i64 = 48;

/// A row of `signup_sessions`.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct SignupSession {
    pub id: Uuid,
    pub secret_hash: Vec<u8>,
    /// Proven with a code.
    pub verified_email: Option<String>,
    /// Proven with a code.
    pub verified_phone: Option<String>,
    pub provider: Option<Provider>,
    pub provider_subject: Option<String>,
    pub provider_client_id: Option<String>,
    /// Verified by the provider.
    pub provider_email: Option<String>,
    pub suggested_display_name: Option<String>,
    pub suggested_pfp_url: Option<String>,
    /// The unclaimed (imported) account this sign-up finishes.
    pub claim_account_uuid: Option<String>,
    pub created_at: OffsetDateTime,
    pub expires_at: OffsetDateTime,
    pub consumed_at: Option<OffsetDateTime>,
    pub account_uuid: Option<String>,
    /// `expires_at <= now()` by the database clock.
    pub expired: bool,
}

impl SignupSession {
    /// The proven email (by code or by the provider).
    pub fn email(&self) -> Option<&str> {
        self.verified_email
            .as_deref()
            .or(self.provider_email.as_deref())
    }

    /// Not used yet and not expired.
    pub fn is_live(&self) -> bool {
        self.consumed_at.is_none() && !self.expired
    }

    /// How the Carbon proved who they are: google | apple | email | phone.
    pub fn method(&self) -> &'static str {
        match (&self.provider, &self.verified_email, &self.verified_phone) {
            (Some(p), _, _) => p.as_str(),
            (None, Some(_), _) => "email",
            _ => "phone",
        }
    }

    /// The sign-in method this sign-up came from (an app must have it enabled to resume it).
    pub fn sign_in_method(&self) -> accounts_core::models::Method {
        use accounts_core::models::Method;
        match self.method() {
            "google" => Method::Google,
            "apple" => Method::Apple,
            "email" => Method::Email,
            _ => Method::Phone,
        }
    }
}

macro_rules! signup_select {
    ($where:literal) => {
        concat!(
            "select id, secret_hash, verified_email, verified_phone, provider, provider_subject, provider_client_id, \
             provider_email, suggested_display_name, suggested_pfp_url, claim_account_uuid, created_at, expires_at, \
             consumed_at, account_uuid, (expires_at <= now()) as expired from signup_sessions where ",
            $where
        )
    };
}

/// Fetches a sign-up session.
pub async fn get_session(conn: &mut PgConnection, id: Uuid) -> ApiResult<Option<SignupSession>> {
    Ok(
        sqlx::query_as::<_, SignupSession>(signup_select!("id = $1"))
            .bind(id)
            .fetch_optional(&mut *conn)
            .await?,
    )
}

/// The sign-up session of the browser's `sa_signup` cookie (any state).
pub async fn from_cookie(
    conn: &mut PgConnection,
    state: &AppState,
    headers: &HeaderMap,
) -> ApiResult<Option<SignupSession>> {
    let Some(token) = read_cookie(headers, &state.settings, SIGNUP_COOKIE) else {
        return Ok(None);
    };
    if !token.starts_with(accounts_core::crypto::prefix::SIGNUP) {
        return Ok(None);
    }
    Ok(
        sqlx::query_as::<_, SignupSession>(signup_select!("secret_hash = $1"))
            .bind(state.keys.pepper.hash(&token))
            .fetch_optional(&mut *conn)
            .await?,
    )
}

/// What a new sign-up session proves.
#[derive(Debug, Clone, Default)]
pub struct NewSignupSession {
    pub verified_email: Option<String>,
    pub verified_phone: Option<String>,
    pub provider: Option<Provider>,
    pub provider_subject: Option<String>,
    pub provider_client_id: Option<String>,
    pub provider_email: Option<String>,
    pub suggested_display_name: Option<String>,
    pub suggested_pfp_url: Option<String>,
    pub claim_account_uuid: Option<String>,
}

/// Creates a sign-up session (48 h) and its `sa_signup` cookie. The browser's previous live
/// sign-up session, if any, ends: one browser signs up one account at a time.
pub async fn create_session(
    conn: &mut PgConnection,
    state: &AppState,
    headers: &HeaderMap,
    new: &NewSignupSession,
) -> ApiResult<(SignupSession, Cookie<'static>)> {
    if let Some(previous) = from_cookie(conn, state, headers).await?
        && previous.is_live()
    {
        expire_session(conn, previous.id).await?;
    }
    let token = accounts_core::crypto::random_token(accounts_core::crypto::prefix::SIGNUP);
    let id = Uuid::now_v7();
    sqlx::query(
        "insert into signup_sessions (id, secret_hash, verified_email, verified_phone, provider, provider_subject, \
           provider_client_id, provider_email, suggested_display_name, suggested_pfp_url, claim_account_uuid, expires_at) \
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now() + make_interval(hours => $12))",
    )
    .bind(id)
    .bind(state.keys.pepper.hash(&token))
    .bind(&new.verified_email)
    .bind(&new.verified_phone)
    .bind(new.provider)
    .bind(&new.provider_subject)
    .bind(&new.provider_client_id)
    .bind(&new.provider_email)
    .bind(&new.suggested_display_name)
    .bind(&new.suggested_pfp_url)
    .bind(&new.claim_account_uuid)
    .bind(SIGNUP_TTL_HOURS as i32)
    .execute(&mut *conn)
    .await?;
    let session = get_session(conn, id)
        .await?
        .ok_or_else(|| ApiError::internal("the new sign-up session could not be read back"))?;
    Ok((session, signup_cookie(&state.settings, &token)))
}

/// Drops the claim of a sign-up session on an imported account (it becomes an ordinary
/// sign-up of its proven email, phone or provider identity).
async fn void_claim(conn: &mut PgConnection, id: Uuid) -> ApiResult<()> {
    sqlx::query("update signup_sessions set claim_account_uuid = null where id = $1")
        .bind(id)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// Ends a sign-up session now (it can no longer be used).
pub async fn expire_session(conn: &mut PgConnection, id: Uuid) -> ApiResult<()> {
    sqlx::query("update signup_sessions set expires_at = least(expires_at, now()) where id = $1 and consumed_at is null")
        .bind(id)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

async fn consume_session(conn: &mut PgConnection, id: Uuid, account_uuid: &str) -> ApiResult<()> {
    sqlx::query("update signup_sessions set consumed_at = now(), account_uuid = $2 where id = $1")
        .bind(id)
        .bind(account_uuid)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// The flow's sign-up session, which must belong to this browser (`sa_signup`), be unused and
/// not expired.
///
/// Errors: 403 `signup_not_bound`, 409 `signup_already_completed`, 410 `signup_expired`.
pub async fn bound_session(
    conn: &mut PgConnection,
    state: &AppState,
    headers: &HeaderMap,
    flow: &Flow,
) -> ApiResult<SignupSession> {
    let id = flow.signup_session_id.ok_or_else(|| {
        ApiError::internal(format!(
            "flow {} is at signup without a sign-up session",
            flow.id
        ))
    })?;
    let session = get_session(conn, id).await?.ok_or_else(|| {
        ApiError::internal(format!(
            "sign-up session {id} of flow {} is missing",
            flow.id
        ))
    })?;
    let cookie = read_cookie(headers, &state.settings, SIGNUP_COOKIE);
    let bound = cookie
        .as_deref()
        .is_some_and(|t| state.keys.pepper.verify(t, &session.secret_hash));
    if !bound {
        let why = if cookie.is_some() {
            "this request carries the sa_signup cookie of a different sign-up"
        } else {
            "this request carries no sa_signup cookie"
        };
        return Err(ApiError::forbidden(
            "signup_not_bound",
            format!("This sign-up belongs to the browser that verified the email, phone or provider account, but {why}."),
        )
        .hint("Continue in the browser where you verified, or verify the email or phone again here."));
    }
    if session.consumed_at.is_some() {
        return Err(ApiError::conflict(
            "signup_already_completed",
            "This sign-up was already used to set up an account.",
        )
        .hint(format!(
            "Sign in instead: call POST /v1/flows/{}/switch and use the same email, phone or provider.",
            flow.id
        )));
    }
    if session.expired {
        return Err(signup_expired(&session));
    }
    Ok(session)
}

fn signup_expired(session: &SignupSession) -> ApiError {
    ApiError::gone(
        "signup_expired",
        format!(
            "The sign-up session expired at {}: a verified email, phone or provider account stays ready for sign-up for {SIGNUP_TTL_HOURS} hours.",
            format_rfc3339_ms(session.expires_at)
        ),
    )
    .hint("Verify the email or phone (or sign in with Google/Apple) again to start a new sign-up.")
}

// ----------------------------------------------------------------------------- prefill

/// The sign-up step of `FlowView`.
#[derive(Debug, Clone, Serialize)]
pub struct SignupView {
    pub display_name: String,
    pub id: String,
    pub timezone: String,
    #[serde(with = "date")]
    pub dob: Date,
    /// Our default Carbon photo from Iris (UNDERSTANDING.md), or the imported account's photo
    /// when finishing an import.
    pub pfp_url: Option<String>,
    /// The Google picture of the provider account, which the page may offer as an alternative
    /// (send it as `pfp_url` to use it).
    pub provider_pfp_url: Option<String>,
    pub email: Option<String>,
    pub phone: Option<String>,
    pub provider: Option<Provider>,
    /// True when this finishes an account an app imported.
    pub finishing_import: bool,
    #[serde(with = "rfc3339_ms")]
    pub expires_at: OffsetDateTime,
}

/// The imported account a sign-up session finishes, while it is still unclaimed. (Once
/// someone finished it, it is theirs: its data is never shown to another sign-up.)
async fn claimable(conn: &mut PgConnection, session: &SignupSession) -> ApiResult<Option<Account>> {
    let Some(uuid) = &session.claim_account_uuid else {
        return Ok(None);
    };
    Ok(accounts::get(conn, uuid)
        .await?
        .filter(|a| a.kind == AccountKind::Carbon && a.status == AccountStatus::Unclaimed))
}

/// Everything the sign-up page shows, already filled in.
pub async fn prefill(
    conn: &mut PgConnection,
    state: &AppState,
    meta: &ClientMeta,
    flow: &Flow,
    session: &SignupSession,
) -> ApiResult<SignupView> {
    if let Some(a) = claimable(conn, session).await? {
        // Finishing an imported account: the app's imported data is the prefill.
        return Ok(SignupView {
            display_name: a.display_name.clone(),
            id: a.id().to_string(),
            timezone: a.timezone.clone(),
            dob: a.dob,
            pfp_url: Some(a.pfp_url.clone()),
            provider_pfp_url: session.suggested_pfp_url.clone(),
            email: session.email().map(str::to_string),
            phone: session.verified_phone.clone(),
            provider: session.provider,
            finishing_import: true,
            expires_at: session.expires_at,
        });
    }
    let display_name = suggest::display_name(
        session.suggested_display_name.as_deref(),
        session.email(),
        session.verified_phone.as_deref(),
    );
    let seeds = suggest::id_seeds(session.email(), &display_name);
    let id = accounts::suggest_id(conn, AccountKind::Carbon, &seeds).await?;
    Ok(SignupView {
        id: id.to_string(),
        timezone: suggest::timezone(
            meta.ip_timezone.as_deref(),
            flow.extras.browser_timezone.as_deref(),
        ),
        dob: suggest::dob(view::today()),
        // UNDERSTANDING.md: "`pfp` - our default Carbon profile photo from Iris". The
        // provider's picture is only offered (and stored only when the Carbon picks it).
        pfp_url: Some(suggest::default_pfp_preview(&state.settings)),
        provider_pfp_url: session.suggested_pfp_url.clone(),
        email: session.email().map(str::to_string),
        phone: session.verified_phone.clone(),
        provider: session.provider,
        finishing_import: false,
        expires_at: session.expires_at,
        display_name,
    })
}

// ----------------------------------------------------------------------------- submit

/// `POST /v1/flows/{id}/signup`. Every field is optional: what is left out keeps the prefill.
#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct SignupBody {
    pub display_name: Option<String>,
    pub id: Option<String>,
    pub timezone: Option<String>,
    pub dob: Option<String>,
    /// Absent: keep the prefilled photo; `null`: our default photo; a URL: that photo.
    #[serde(
        deserialize_with = "double_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub pfp_url: Option<Option<String>>,
}

fn double_option<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Option<String>>, D::Error> {
    Option::<String>::deserialize(d).map(Some)
}

/// Validated sign-up details.
struct SignupDetails {
    display_name: String,
    id: AccountId,
    timezone: String,
    dob: Date,
    /// `None` = our default photo.
    pfp_url: Option<String>,
}

fn validate_details(
    state: &AppState,
    body: &SignupBody,
    prefill: &SignupView,
) -> ApiResult<SignupDetails> {
    let mut fields = FieldErrors::new();
    let display_name = match validate_display_name(
        body.display_name
            .as_deref()
            .unwrap_or(&prefill.display_name),
    ) {
        Ok(n) => n,
        Err(m) => {
            fields.add("display_name", m);
            String::new()
        }
    };
    let id = match AccountId::parse_for_kind(
        body.id.as_deref().unwrap_or(&prefill.id),
        AccountKind::Carbon,
    ) {
        Ok(id) => Some(id),
        Err(e) => {
            fields.add("id", format!("{e} {}", e.hint()));
            None
        }
    };
    let timezone = match normalize_timezone(body.timezone.as_deref().unwrap_or(&prefill.timezone)) {
        Ok(t) => t,
        Err(m) => {
            fields.add("timezone", m);
            String::new()
        }
    };
    let dob = match &body.dob {
        None => Some(prefill.dob),
        Some(raw) => match parse_date(raw).and_then(|d| validate_dob(d, view::today())) {
            Ok(d) => Some(d),
            Err(m) => {
                fields.add("dob", m);
                None
            }
        },
    };
    let pfp_choice: Option<String> = match &body.pfp_url {
        None => prefill.pfp_url.clone(),
        Some(choice) => choice.clone(),
    };
    let pfp_url = match pfp_choice
        .map(|u| u.trim().to_string())
        .filter(|u| !u.is_empty())
    {
        None => None,
        Some(u) if accounts_core::pfp::is_default_pfp(&state.settings.iris_base_url, &u) => None,
        Some(u) => match validate_pfp_url(&state.settings, &u) {
            Ok(v) => Some(v),
            Err(m) => {
                fields.add("pfp_url", m);
                None
            }
        },
    };
    fields.into_result()?;
    match (id, dob) {
        (Some(id), Some(dob)) => Ok(SignupDetails {
            display_name,
            id,
            timezone,
            dob,
            pfp_url,
        }),
        _ => Err(ApiError::internal(
            "sign-up validation passed without an id or dob",
        )),
    }
}

/// `POST /v1/flows/{id}/signup` (flow + sign-up cookie).
pub async fn submit_signup(
    State(state): State<AppState>,
    meta: ClientMeta,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<SignupBody>,
) -> ApiResult<FlowResponse> {
    let mut tx = state.db.begin().await?;
    let mut flow = load_bound(&mut tx, &state, &headers, &Method::POST, &id, true).await?;
    model::ensure_live(&flow)?;
    model::ensure_step(&flow, &[Step::Signup], "complete sign-up")?;
    let fa = FlowApp::load(&mut tx, &state.settings, &flow.app_id).await?;
    fa.ensure_active()?;
    let mut session = match bound_session(&mut tx, &state, &headers, &flow).await {
        Ok(s) => s,
        Err(e) if e.code == "signup_expired" => {
            // Nothing to sign up any more: back to the methods, with the reason.
            flow.reset_to_choose_method();
            flow.extras.error = Some(model::FlowError::from_api(&e));
            model::save(&mut tx, &flow).await?;
            tx.commit().await?;
            return Err(e);
        }
        Err(e) => return Err(e),
    };
    // Settle the claim on an imported account under its row lock: when someone else finished
    // it meanwhile, this is an ordinary sign-up now.
    let claimed = match session.claim_account_uuid.clone() {
        Some(uuid) => match accounts::lock(&mut tx, &uuid).await? {
            Some(a) if a.kind == AccountKind::Carbon && a.status == AccountStatus::Unclaimed => {
                Some(a)
            }
            _ => {
                void_claim(&mut tx, session.id).await?;
                session.claim_account_uuid = None;
                None
            }
        },
        None => None,
    };
    if claimed.is_none() && !fa.config.allow_signup && !fa.first_party() {
        // Nothing here this app accepts (it closed sign-ups, or the import this sign-up was
        // finishing was finished by someone else): back to the methods, with the reason.
        let e = next::signup_not_allowed(&fa);
        flow.reset_to_choose_method();
        flow.extras.error = Some(model::FlowError::from_api(&e));
        model::save(&mut tx, &flow).await?;
        tx.commit().await?;
        return Err(e);
    }
    let prefill = prefill(&mut tx, &state, &meta, &flow, &session).await?;
    let details = validate_details(&state, &body, &prefill)?;

    let account = match claimed {
        Some(current) => {
            finish_import(&mut tx, &state, &meta, &fa, &session, current, details).await?
        }
        None => create_account(&mut tx, &state, &meta, &fa, &session, details).await?,
    };

    consume_session(&mut tx, session.id, &account.uuid).await?;
    let signed = browser::sign_in(&mut tx, &state, &headers, &meta, &account.uuid).await?;
    flow.extras.browser_session_id = Some(signed.session_id);
    flow.extras.auth_method = Some(session.method().to_string());
    flow.extras.new_account = true;
    next::advance(&mut tx, &state, &meta, &mut flow, &fa, &account).await?;
    model::save(&mut tx, &flow).await?;
    let view = view::build(
        &mut tx,
        &ViewContext {
            state: &state,
            meta: &meta,
            browser: None,
        },
        &flow,
        &fa,
    )
    .await?;
    tx.commit().await?;
    telemetry(
        &state,
        "flow.signup_completed",
        Some(0.7),
        json!({
            "app_id": fa.app.app_id,
            "method": session.method(),
            "finishing_import": session.claim_account_uuid.is_some(),
            "next_step": flow.step.as_str(),
        }),
    );
    let mut cookies: Vec<Cookie<'static>> = signed.cookie.into_iter().collect();
    cookies.push(clear_cookie(&state.settings, SIGNUP_COOKIE));
    Ok(FlowResponse::ok(view, cookies))
}

/// A brand-new Carbon.
async fn create_account(
    conn: &mut PgConnection,
    state: &AppState,
    meta: &ClientMeta,
    fa: &FlowApp,
    session: &SignupSession,
    details: SignupDetails,
) -> ApiResult<Account> {
    if !fa.config.allow_signup && !fa.first_party() {
        return Err(next::signup_not_allowed(fa));
    }
    // This sign-up proved its email/phone: an unverified row an import left on another account
    // identifies nobody and is removed (otherwise the new account couldn't have the address).
    if let Some(e) = session.email() {
        contact::after_proof(conn, ContactKind::Email, e, meta.ip.as_deref()).await?;
    }
    if let Some(p) = &session.verified_phone {
        contact::after_proof(conn, ContactKind::Phone, p, meta.ip.as_deref()).await?;
    }
    let mut emails = Vec::new();
    if let Some(e) = &session.verified_email {
        emails.push(NewContact {
            value: e.clone(),
            verified_via: Some(VerifiedVia::Code),
        });
    } else if let (Some(e), Some(p)) = (&session.provider_email, session.provider) {
        emails.push(NewContact {
            value: e.clone(),
            verified_via: Some(p.verified_via()),
        });
    }
    let phones: Vec<NewContact> = session
        .verified_phone
        .iter()
        .map(|p| NewContact {
            value: p.clone(),
            verified_via: Some(VerifiedVia::Code),
        })
        .collect();
    let account = accounts::create_carbon(
        conn,
        &state.settings,
        NewCarbon {
            id: details.id,
            display_name: details.display_name,
            pfp_url: details.pfp_url,
            dob: details.dob,
            timezone: details.timezone,
            status: AccountStatus::Active,
            emails,
            phones,
            actor: "signup".into(),
        },
    )
    .await?;
    link_provider_identity(conn, session, &account).await?;
    audit::record(
        conn,
        &AuditEntry {
            account_uuid: Some(&account.uuid),
            app_id: Some(&fa.app.app_id),
            target_kind: Some("account"),
            target_id: Some(&account.uuid),
            details: json!({"method": session.method(), "app_id": fa.app.app_id}),
            ip: meta.ip.as_deref(),
            ..AuditEntry::new(ActorKind::Account, Some(&account.uuid), "account.created")
        },
    )
    .await?;
    Ok(account)
}

/// Finishes an unclaimed account an app imported (`current`, row-locked and still
/// unclaimed): same uuid, the Carbon's chosen details, the proven email/phone verified (and
/// primary when the old primary wasn't), status active. The import's other emails and phones
/// were never proven by this Carbon, so they are removed (the app keeps its copy in
/// `memberships.imported_profile`), and other sign-ups pointing at the account become
/// ordinary sign-ups. Member apps hear about the id and profile changes through webhooks.
async fn finish_import(
    conn: &mut PgConnection,
    state: &AppState,
    meta: &ClientMeta,
    fa: &FlowApp,
    session: &SignupSession,
    current: Account,
    details: SignupDetails,
) -> ApiResult<Account> {
    let uuid = current.uuid.as_str();
    if current.handle.as_deref() != Some(details.id.to_string().as_str()) {
        let change = accounts::change_id(conn, uuid, &details.id, uuid).await?;
        if change.changed {
            events::notify_id_changed(conn, &change.account, &change.old_id, &change.new_id)
                .await?;
        }
    }
    let pfp_url = details.pfp_url.unwrap_or_else(|| {
        accounts_core::pfp::default_pfp_url(
            &state.settings.iris_base_url,
            AccountKind::Carbon,
            uuid,
        )
    });
    let (_, changed) = accounts::update_profile(
        conn,
        uuid,
        &ProfileUpdate {
            display_name: Some(details.display_name),
            timezone: Some(details.timezone),
            dob: Some(details.dob),
            pfp_url: Some(pfp_url),
        },
    )
    .await?;

    // The email/phone proven in this sign-up becomes verified (and primary if needed).
    let mut contact_changed: Vec<AccountField> = Vec::new();
    if let Some(email) = session.email() {
        let via = match (&session.verified_email, session.provider) {
            (Some(_), _) | (None, None) => VerifiedVia::Code,
            (None, Some(p)) => p.verified_via(),
        };
        if prove_contact(conn, ContactKind::Email, uuid, email, via).await? {
            contact_changed.push(AccountField::Email);
        }
    }
    if let Some(phone) = &session.verified_phone
        && prove_contact(conn, ContactKind::Phone, uuid, phone, VerifiedVia::Code).await?
    {
        contact_changed.push(AccountField::Phone);
    }
    // What the import listed and this Carbon didn't prove can't stay: an unproven address
    // must never sign anyone into this account.
    for field in contact::drop_unverified(conn, uuid).await? {
        if !contact_changed.contains(&field) {
            contact_changed.push(field);
        }
    }
    // Other sign-ups that were about to finish this account are ordinary sign-ups now.
    sqlx::query(
        "update signup_sessions set claim_account_uuid = null \
         where claim_account_uuid = $1 and id <> $2 and consumed_at is null",
    )
    .bind(uuid)
    .bind(session.id)
    .execute(&mut *conn)
    .await?;
    link_provider_identity(conn, session, &current).await?;
    let mut account = accounts::set_status(conn, uuid, AccountStatus::Active).await?;
    if !contact_changed.is_empty() {
        account = accounts::bump_version(conn, uuid).await?;
    }
    let mut all_changed = changed;
    all_changed.extend(contact_changed);
    if !all_changed.is_empty() {
        events::notify_profile_updated(conn, &account, &all_changed).await?;
    }
    audit::record(
        conn,
        &AuditEntry {
            account_uuid: Some(uuid),
            app_id: Some(&fa.app.app_id),
            target_kind: Some("account"),
            target_id: Some(uuid),
            details: json!({"method": session.method(), "app_id": fa.app.app_id}),
            ip: meta.ip.as_deref(),
            ..AuditEntry::new(ActorKind::Account, Some(uuid), "account.claimed")
        },
    )
    .await?;
    Ok(account)
}

/// Marks a proven email/phone verified on the account (adding it when it isn't there yet) and
/// makes it primary when the current primary of that kind isn't verified. Returns true when
/// the primary changed (apps with the matching scope must hear about it).
pub async fn prove_contact(
    conn: &mut PgConnection,
    kind: ContactKind,
    account_uuid: &str,
    value: &str,
    via: VerifiedVia,
) -> ApiResult<bool> {
    let before = contacts::primary(conn, kind, account_uuid).await?;
    let on_account = contacts::owner(conn, kind, value)
        .await?
        .is_some_and(|(owner, _)| owner == account_uuid);
    if on_account {
        contacts::mark_verified(conn, kind, account_uuid, value, via).await?;
    } else {
        contacts::add_verified(conn, kind, account_uuid, value, via).await?;
    }
    if !before.as_ref().is_some_and(|p| p.verified) {
        contacts::set_primary(conn, kind, account_uuid, value).await?;
    }
    let after = contacts::primary(conn, kind, account_uuid).await?;
    Ok(before.map(|p| (p.value, p.verified)) != after.map(|p| (p.value, p.verified)))
}

async fn link_provider_identity(
    conn: &mut PgConnection,
    session: &SignupSession,
    account: &Account,
) -> ApiResult<()> {
    if let (Some(provider), Some(subject), Some(client_id)) = (
        session.provider,
        &session.provider_subject,
        &session.provider_client_id,
    ) {
        identities::link(
            conn,
            provider,
            subject,
            client_id,
            &account.uuid,
            session.provider_email.as_deref(),
        )
        .await?;
    }
    Ok(())
}

/// True when a live sign-up session in this browser may continue in a new flow of `fa`:
/// sign-up allowed (or finishing an import), its method enabled, its email domain accepted.
pub fn may_resume(
    session: &SignupSession,
    fa: &FlowApp,
    settings: &accounts_core::Settings,
) -> bool {
    let allowed =
        session.claim_account_uuid.is_some() || fa.config.allow_signup || fa.first_party();
    let method_ok = fa
        .config
        .available_methods(settings)
        .contains(&session.sign_in_method());
    let domain_ok = session
        .email()
        .is_none_or(|e| fa.config.email_domain_allowed(e));
    allowed && method_ok && domain_ok && session.is_live()
}
