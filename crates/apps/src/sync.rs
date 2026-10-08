//! The Silicon Apps stand-in: apps are created in Silicon Apps, which isn't built yet, so its
//! upsert lives here.
//!
//! - `POST /v1/internal/apps/sync` (`Authorization: Bearer <ACCOUNTS_INTERNAL_TOKEN>`)
//!   `{"apps":[SiliconAppsApp…]}` (a bare array works too) → `{"apps":[SyncedApp…]}`.
//! - [`seed_fake_apps`] — what `accounts-seed --fake-apps testkit/fake-apps.json [--force]`
//!   calls — runs the same upsert for the fake apps file.
//!
//! Upsert rules, per app (all apps in one transaction, validated before anything is written):
//! - a new app is created with its fixed `app_id` and `secret` (stored as a pepper HMAC);
//!   `signin_defaults` (a partial sign-in config, with Bring-your-own secrets the way the PATCH
//!   takes them: `google.client_secret`, `apple.private_key`) becomes version 1 of its sign-in
//!   setup, BYO secrets encrypted outside the document; `webhook_url` + `webhook_secret` (testkit
//!   extras) configure its webhook with exactly that `whsec_…` secret (encrypted);
//! - an existing app keeps its app_id, users and sign-in setup; name, description, logos,
//!   homepage, owner, status and secret follow the payload (the app credential cache is
//!   invalidated when the secret or status changes). Only the seeder's `force` re-applies
//!   `signin_defaults` and the webhook (as a new config version with a redacted history entry);
//! - the owner is found by `owner_uuid` when given (the permanent id), else by `owner_id`
//!   (`c:…`), else by `owner_email` — an active Carbon whose *verified* email it is, which also
//!   covers an owner who changed their c:id since. A missing owner (`owner_id` + `owner_email`)
//!   is created as an active Carbon whose primary email is `owner_email`, verified;
//! - an existing app's owner never changes because of a c:id alone (a released c:id can belong
//!   to someone else 10 days later): that takes `owner_uuid`, or an `owner_email` verified on the
//!   new owner. Otherwise the owner is kept and the report says why (`warnings`).
//!
//! Unknown fields (`_comment`, `version`, `fake_app_server`, `testkit`, …) are ignored.

use std::fmt;
use std::path::Path as FsPath;

use accounts_core::error::FieldErrors;
use accounts_core::http::extract::parse_json;
use accounts_core::ids::{AccountId, validate_app_id};
use accounts_core::models::{
    Account, AccountStatus, App, AppSource, AppStatus, ConfigSecretsPresent, SigninConfig,
    VerifiedVia,
};
use accounts_core::repo::accounts::{self, NewCarbon, NewContact};
use accounts_core::repo::audit;
use accounts_core::secrecy::ExposeSecret;
use accounts_core::{ApiError, ApiResult, AppState, normalize};
use axum::body::Bytes;
use axum::extract::rejection::BytesRejection;
use axum::extract::{DefaultBodyLimit, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::PgConnection;
use time::OffsetDateTime;

use crate::signin_config::{
    Change, SecretChange, diff, ensure_config_row, lock_config_row, secret_change_entry,
    split_patch,
};
use crate::util::{validate_http_url, validate_logo_url};

/// Largest sync body (apps carry inline SVG logos).
const MAX_SYNC_BYTES: usize = 5 * 1024 * 1024;

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/internal/apps", get(export_registry))
        .route(
            "/v1/internal/apps/sync",
            post(sync_handler).layer(DefaultBodyLimit::max(MAX_SYNC_BYTES)),
        )
}

/// An app as Silicon Apps describes it (plus the testkit's webhook extras).
#[derive(Debug, Clone, Deserialize)]
pub struct SiliconAppsApp {
    pub app_id: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub logo_url: Option<String>,
    #[serde(default)]
    pub logo_dark_url: Option<String>,
    #[serde(default)]
    pub homepage_url: Option<String>,
    /// uuid of the owning Carbon (preferred: it never changes).
    #[serde(default)]
    pub owner_uuid: Option<String>,
    /// Complete accepted authorship, mirrored from Silicon Apps. Omission preserves existing authors.
    #[serde(default)]
    pub author_uuids: Option<Vec<String>>,
    /// `c:<handle>` of the owning Carbon.
    #[serde(default)]
    pub owner_id: Option<String>,
    /// Used to create the owner when `owner_id` doesn't exist yet.
    #[serde(default)]
    pub owner_email: Option<String>,
    /// `sa_app_…`; required to create an app, optional afterwards (rotates when different).
    #[serde(default)]
    pub secret: Option<String>,
    /// `active` (default) or `disabled`.
    #[serde(default)]
    pub status: Option<String>,
    /// RFC 3339; used when the app is created.
    #[serde(default)]
    pub created_at: Option<String>,
    /// Partial sign-in config applied when the app is created (or with `force`).
    #[serde(default)]
    pub signin_defaults: Option<Value>,
    /// Testkit extra: the app's webhook URL.
    #[serde(default)]
    pub webhook_url: Option<String>,
    /// Testkit extra: the `whsec_…` signing secret for `webhook_url`.
    #[serde(default)]
    pub webhook_secret: Option<String>,
}

/// Who runs the upsert.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncMode {
    /// `POST /v1/internal/apps/sync`: apps become `silicon_apps` apps.
    SiliconApps,
    /// `accounts-seed`: new apps are `fake` apps; `force` re-applies sign-in defaults and webhooks.
    Seed { force: bool },
}

impl SyncMode {
    fn actor(&self) -> &'static str {
        match self {
            SyncMode::SiliconApps => "silicon_apps",
            SyncMode::Seed { .. } => "system",
        }
    }
    fn force(&self) -> bool {
        matches!(self, SyncMode::Seed { force: true })
    }
}

/// What happened to one app.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SyncedApp {
    pub app_id: String,
    /// `created`, `updated` or `unchanged`.
    pub action: String,
    /// The owner's id, if any.
    pub owner: Option<String>,
    /// True when the owner Carbon was created by this upsert.
    pub owner_created: bool,
    /// `applied` (new app), `reapplied` (force), `kept` or `unchanged` (force, nothing differed).
    pub config: String,
    /// The config version after the upsert.
    pub config_version: i64,
    /// `set`, `removed`, `kept` or `none`.
    pub webhook: String,
    /// App fields changed on an existing app.
    pub changed: Vec<String>,
    /// What the upsert decided differently from what the payload said, and why.
    pub warnings: Vec<String>,
}

/// The upsert result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SyncReport {
    pub apps: Vec<SyncedApp>,
}

impl fmt::Display for SyncReport {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        for a in &self.apps {
            write!(f, "{}: {}", a.app_id, a.action)?;
            if !a.changed.is_empty() {
                write!(f, " ({})", a.changed.join(", "))?;
            }
            if let Some(o) = &a.owner {
                write!(
                    f,
                    "; owner {o}{}",
                    if a.owner_created { " (created)" } else { "" }
                )?;
            }
            write!(
                f,
                "; sign-in setup {} (version {}); webhook {}",
                a.config, a.config_version, a.webhook
            )?;
            for w in &a.warnings {
                write!(f, "\n  warning: {w}")?;
            }
            writeln!(f)?;
        }
        Ok(())
    }
}

/// Why seeding failed.
#[derive(Debug, thiserror::Error)]
pub enum SeedError {
    #[error("could not read the fake apps file {path}: {source}")]
    Read {
        path: String,
        #[source]
        source: std::io::Error,
    },
    #[error("the fake apps file {path} is not valid JSON: {message}")]
    Parse { path: String, message: String },
    #[error("{}", describe_api_error(.0))]
    Rejected(ApiError),
}

fn describe_api_error(e: &ApiError) -> String {
    let mut out = e.message.clone();
    if let Some(Value::Object(fields)) = e.details.get("fields") {
        for (k, v) in fields {
            out.push_str(&format!("\n  {k}: {}", v.as_str().unwrap_or_default()));
        }
    }
    if let Some(h) = &e.hint {
        out.push_str(&format!("\nhint: {h}"));
    }
    out
}

/// Seeds the fake apps from a file shaped like the sync body (`{"apps":[…]}` or a bare array),
/// through the same upsert as `POST /v1/internal/apps/sync`. `force` re-applies every app's
/// `signin_defaults` and webhook even when the app exists.
pub async fn seed_fake_apps(
    state: &AppState,
    path: impl AsRef<FsPath>,
    force: bool,
) -> Result<SyncReport, SeedError> {
    let path = path.as_ref();
    let shown = path.display().to_string();
    let bytes = tokio::fs::read(path).await.map_err(|e| SeedError::Read {
        path: shown.clone(),
        source: e,
    })?;
    let doc: Value = serde_json::from_slice(&bytes).map_err(|e| SeedError::Parse {
        path: shown.clone(),
        message: e.to_string(),
    })?;
    let apps =
        parse_apps_document(&doc).map_err(|f| SeedError::Rejected(ApiError::validation(f)))?;
    sync_apps(state, &apps, SyncMode::Seed { force })
        .await
        .map_err(SeedError::Rejected)
}

/// Reads `{"apps":[…]}` or a bare array of apps; errors carry the path of each problem.
pub fn parse_apps_document(doc: &Value) -> Result<Vec<SiliconAppsApp>, FieldErrors> {
    let mut errors = FieldErrors::new();
    let list = match doc {
        Value::Array(a) => a,
        Value::Object(m) => match m.get("apps") {
            Some(Value::Array(a)) => a,
            Some(_) => {
                errors.add("apps", "must be an array of apps");
                return Err(errors);
            }
            None => {
                errors.add(
                    "apps",
                    "is required: {\"apps\":[{\"app_id\":…,\"name\":…,\"secret\":…}]}",
                );
                return Err(errors);
            }
        },
        _ => {
            errors.add("", "the body must be {\"apps\":[…]} or an array of apps");
            return Err(errors);
        }
    };
    let mut out = Vec::with_capacity(list.len());
    for (i, v) in list.iter().enumerate() {
        match serde_path_to_error::deserialize::<_, SiliconAppsApp>(v.clone()) {
            Ok(a) => out.push(a),
            Err(e) => {
                let path = e.path().to_string();
                let inner = e.inner().to_string();
                let field = match inner
                    .strip_prefix("missing field `")
                    .and_then(|r| r.strip_suffix('`'))
                {
                    Some(f) => format!("apps[{i}].{f}"),
                    None if path == "." || path.is_empty() => format!("apps[{i}]"),
                    None => format!("apps[{i}].{path}"),
                };
                errors.add(field, inner);
            }
        }
    }
    if out.is_empty() && errors.is_empty() {
        errors.add("apps", "is empty; send at least one app");
    }
    errors.into_ok(out)
}

trait IntoOk {
    fn into_ok<T>(self, v: T) -> Result<T, FieldErrors>;
}

impl IntoOk for FieldErrors {
    fn into_ok<T>(self, v: T) -> Result<T, FieldErrors> {
        if self.is_empty() { Ok(v) } else { Err(self) }
    }
}

/// Who a payload names as the owner.
#[derive(Debug, Clone)]
struct OwnerSpec {
    uuid: Option<String>,
    id: Option<AccountId>,
    email: Option<String>,
}

/// An app payload after validation.
#[derive(Debug, Clone)]
struct ValidApp {
    app_id: String,
    name: String,
    description: String,
    logo_url: Option<String>,
    logo_dark_url: Option<String>,
    homepage_url: Option<String>,
    owner: Option<OwnerSpec>,
    author_uuids: Option<Vec<String>>,
    secret: Option<String>,
    status: Option<AppStatus>,
    created_at: Option<OffsetDateTime>,
    config: SigninConfig,
    google_secret: Option<String>,
    apple_key: Option<String>,
    webhook: Option<(String, Option<String>)>,
    index: usize,
}

fn is_visible_ascii(s: &str) -> bool {
    s.bytes().all(|b| (0x21..=0x7e).contains(&b))
}

fn validate(state: &AppState, apps: &[SiliconAppsApp]) -> Result<Vec<ValidApp>, ApiError> {
    let mut f = FieldErrors::new();
    let mut out = Vec::with_capacity(apps.len());
    let mut seen: Vec<String> = Vec::new();
    for (i, a) in apps.iter().enumerate() {
        let at = |field: &str| format!("apps[{i}].{field}");
        let app_id = a.app_id.trim().to_string();
        if let Err(m) = validate_app_id(&app_id) {
            f.add(at("app_id"), m);
        } else if accounts_core::is_first_party_app_id(&app_id) {
            f.add(
                at("app_id"),
                format!("'{app_id}' is one of Silicon Accounts' own apps and can't be synced"),
            );
        } else if app_id == "apps" {
            f.add(
                at("app_id"),
                "The legacy Silicon Apps ID is reserved; use silicon-apps.",
            );
        } else if seen.contains(&app_id) {
            f.add(
                at("app_id"),
                format!("'{app_id}' appears more than once in this request"),
            );
        }
        seen.push(app_id.clone());

        let name = a.name.trim().to_string();
        if name.is_empty() || name.chars().count() > 100 {
            f.add(at("name"), "must be 1 to 100 characters");
        } else if name.chars().any(char::is_control) {
            f.add(at("name"), "must not contain control characters");
        }
        let description = a.description.as_deref().unwrap_or("").trim().to_string();
        if description.chars().count() > 2000 {
            f.add(at("description"), "must be at most 2000 characters");
        }
        let opt = |v: &Option<String>| {
            v.as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        };
        let logo_url = opt(&a.logo_url);
        let logo_dark_url = opt(&a.logo_dark_url);
        let homepage_url = opt(&a.homepage_url);
        for (field, v) in [("logo_url", &logo_url), ("logo_dark_url", &logo_dark_url)] {
            if let Some(u) = v
                && let Err(m) = validate_logo_url(u)
            {
                f.add(at(field), m);
            }
        }
        if let Some(u) = &homepage_url
            && let Err(m) = validate_http_url(u)
        {
            f.add(at("homepage_url"), m);
        }
        let owner_email = match opt(&a.owner_email) {
            Some(e) => match normalize::normalize_email(&e) {
                Ok(e) => Some(e),
                Err(err) => {
                    f.add(at("owner_email"), err.message);
                    None
                }
            },
            None => None,
        };
        let owner_id = match opt(&a.owner_id) {
            Some(id) => match AccountId::parse(&id) {
                Ok(id) => Some(id),
                Err(e) => {
                    f.add(at("owner_id"), e.to_string());
                    None
                }
            },
            None => None,
        };
        let owner_uuid = match opt(&a.owner_uuid) {
            Some(u)
                if (3..=16).contains(&u.len()) && u.bytes().all(|b| b.is_ascii_alphanumeric()) =>
            {
                Some(u)
            }
            Some(_) => {
                f.add(
                    at("owner_uuid"),
                    "must be an account uuid: 3 to 16 letters and digits, like a8K",
                );
                None
            }
            None => None,
        };
        let named = owner_uuid.is_some() || owner_id.is_some() || owner_email.is_some();
        let owner = named.then_some(OwnerSpec {
            uuid: owner_uuid,
            id: owner_id,
            email: owner_email,
        });
        let secret = opt(&a.secret);
        if let Some(s) = &secret
            && (!s.starts_with(accounts_core::crypto::prefix::APP_SECRET)
                || s.len() < 24
                || s.len() > 200
                || !is_visible_ascii(s))
        {
            f.add(
                at("secret"),
                "must be an app secret: sa_app_ followed by at least 17 visible characters (at most 200 in total)",
            );
        }
        let status = match opt(&a.status) {
            Some(s) => match AppStatus::parse(&s) {
                Some(st) => Some(st),
                None => {
                    f.add(
                        at("status"),
                        format!("'{s}' is not one of {}", AppStatus::expected()),
                    );
                    None
                }
            },
            None => None,
        };
        let created_at = match opt(&a.created_at) {
            Some(s) => match accounts_core::timefmt::parse_rfc3339(&s) {
                Ok(t) => Some(t),
                Err(m) => {
                    f.add(at("created_at"), m);
                    None
                }
            },
            None => None,
        };
        let (config, google_secret, apple_key) = match &a.signin_defaults {
            None | Some(Value::Null) => (SigninConfig::default(), None, None),
            Some(defaults) => match split_patch(defaults, false) {
                Err(errs) => {
                    f.extend_prefixed(&at("signin_defaults"), errs);
                    (SigninConfig::default(), None, None)
                }
                Ok(parts) => {
                    let g = match parts.google_client_secret {
                        SecretChange::Set(s) => Some(s),
                        _ => None,
                    };
                    let k = match parts.apple_private_key {
                        SecretChange::Set(s) => Some(s),
                        _ => None,
                    };
                    let present = ConfigSecretsPresent {
                        google_client_secret: g.is_some(),
                        apple_private_key: k.is_some(),
                    };
                    match SigninConfig::default().apply_patch(&parts.patch, present) {
                        Ok(c) => (c, g, k),
                        Err(errs) => {
                            f.extend_prefixed(&at("signin_defaults"), errs);
                            (SigninConfig::default(), None, None)
                        }
                    }
                }
            },
        };
        let webhook = match opt(&a.webhook_url) {
            Some(u) => match normalize::validate_webhook_url(&state.settings, &u) {
                Ok(url) => {
                    let secret = opt(&a.webhook_secret);
                    if let Some(s) = &secret
                        && (!s.starts_with(accounts_core::crypto::prefix::WEBHOOK_SECRET)
                            || s.len() < 22
                            || s.len() > 200
                            || !is_visible_ascii(s))
                    {
                        f.add(
                            at("webhook_secret"),
                            "must be a webhook signing secret: whsec_ followed by at least 16 visible characters",
                        );
                    }
                    Some((url.to_string(), secret))
                }
                Err(m) => {
                    f.add(at("webhook_url"), m);
                    None
                }
            },
            None => {
                if opt(&a.webhook_secret).is_some() {
                    f.add(at("webhook_secret"), "needs webhook_url");
                }
                None
            }
        };
        out.push(ValidApp {
            app_id,
            name,
            description,
            logo_url,
            logo_dark_url,
            homepage_url,
            owner,
            author_uuids: a.author_uuids.clone(),
            secret,
            status,
            created_at,
            config,
            google_secret,
            apple_key,
            webhook,
            index: i,
        });
    }
    f.into_result()?;
    Ok(out)
}

/// Validates and upserts apps in one transaction (see the module docs).
pub async fn sync_apps(
    state: &AppState,
    apps: &[SiliconAppsApp],
    mode: SyncMode,
) -> ApiResult<SyncReport> {
    let valid = validate(state, apps)?;
    let mut tx = state.db.begin().await?;
    let mut report = Vec::with_capacity(valid.len());
    let mut invalidate: Vec<String> = Vec::new();
    for app in &valid {
        let (synced, credentials_changed) = upsert_app(&mut tx, state, app, mode).await?;
        if credentials_changed {
            invalidate.push(app.app_id.clone());
        }
        if let Some(authors) = &app.author_uuids {
            if authors.is_empty() || authors.len() > 1000 {
                return Err(ApiError::unprocessable(
                    "invalid_authors",
                    "An app must have 1 to 1000 accepted authors.",
                ));
            }
            for uuid in authors {
                if accounts::get(&mut tx, uuid)
                    .await?
                    .filter(can_own)
                    .is_none()
                {
                    return Err(ApiError::unprocessable(
                        "author_not_found",
                        format!("No active Carbon or Silicon has uuid '{uuid}'."),
                    ));
                }
            }
            let owner: Option<String> =
                sqlx::query_scalar("select owner_uuid from apps where app_id = $1")
                    .bind(&app.app_id)
                    .fetch_one(&mut *tx)
                    .await?;
            if owner.as_ref().is_some_and(|uuid| !authors.contains(uuid)) {
                return Err(ApiError::unprocessable(
                    "owner_not_author",
                    "owner_uuid must be in author_uuids; transfer the legacy owner when they leave.",
                ));
            }
            sqlx::query(
                "delete from app_authors where app_id = $1 and not(account_uuid = any($2))",
            )
            .bind(&app.app_id)
            .bind(authors)
            .execute(&mut *tx)
            .await?;
            for uuid in authors {
                sqlx::query("insert into app_authors(app_id,account_uuid) values($1,$2) on conflict do nothing")
                    .bind(&app.app_id).bind(uuid).execute(&mut *tx).await?;
            }
        } else {
            sqlx::query("insert into app_authors(app_id,account_uuid) select app_id,owner_uuid from apps where app_id=$1 and owner_uuid is not null on conflict do nothing")
                .bind(&app.app_id).execute(&mut *tx).await?;
        }
        report.push(synced);
    }
    tx.commit().await?;
    for app_id in invalidate {
        state.app_cache.invalidate(&app_id);
    }
    Ok(SyncReport { apps: report })
}

fn title_case_handle(handle: &str) -> String {
    let words: Vec<String> = handle
        .split(['-', '_'])
        .filter(|w| !w.is_empty())
        .map(|w| {
            let mut c = w.chars();
            match c.next() {
                Some(first) => first.to_uppercase().collect::<String>() + c.as_str(),
                None => String::new(),
            }
        })
        .collect();
    if words.is_empty() {
        "Carbon".into()
    } else {
        words.join(" ")
    }
}

/// The owner an upsert settles on.
#[derive(Debug, Clone)]
struct ResolvedOwner {
    uuid: String,
    /// The owner's current c:id.
    id: Option<String>,
    created: bool,
}

impl ResolvedOwner {
    fn of(account: &Account) -> ResolvedOwner {
        ResolvedOwner {
            uuid: account.uuid.clone(),
            id: account.handle.clone(),
            created: false,
        }
    }
}

fn can_own(account: &Account) -> bool {
    account.status == AccountStatus::Active
}

/// The active Carbon whose *verified* email is `email` (an unverified imported address proves
/// nothing about who someone is).
async fn verified_owner_of(conn: &mut PgConnection, email: &str) -> ApiResult<Option<Account>> {
    let uuid: Option<String> = sqlx::query_scalar(
        "select e.account_uuid from account_emails e join accounts a on a.uuid = e.account_uuid \
         where e.email = $1 and e.verified_at is not null and a.kind = 'carbon' and a.status = 'active'",
    )
    .bind(email)
    .fetch_optional(&mut *conn)
    .await?;
    match uuid {
        Some(u) => accounts::get(conn, &u).await,
        None => Ok(None),
    }
}

/// Finds or creates the owner the payload names (see the module docs). `current` is the
/// existing app's owner; `warnings` collects what was decided differently from the payload.
async fn resolve_owner(
    conn: &mut PgConnection,
    state: &AppState,
    app: &ValidApp,
    actor: &str,
    current: Option<&str>,
    warnings: &mut Vec<String>,
) -> ApiResult<Option<ResolvedOwner>> {
    let Some(spec) = &app.owner else {
        return Ok(None);
    };
    let at = |field: &str| format!("apps[{}].{field}", app.index);

    // The uuid never changes, so it decides.
    if let Some(uuid) = &spec.uuid {
        let account = accounts::get(conn, uuid)
            .await?
            .filter(can_own)
            .ok_or_else(|| {
                ApiError::unprocessable(
                    "owner_not_found",
                    format!(
                        "{}: no active Carbon or Silicon account has the uuid '{uuid}', so it can't own the app.",
                        at("owner_uuid")
                    ),
                )
                .hint("uuids are case-sensitive: send the owner's uuid exactly, or leave owner_uuid out and send owner_id + owner_email.")
            })?;
        if let Some(id) = &spec.id
            && account.handle.as_deref() != Some(id.as_full().as_str())
        {
            warnings.push(format!(
                "owner_id {id} is not the current id of owner_uuid {uuid} ({}); the uuid decided.",
                account.display_id()
            ));
        }
        return Ok(Some(ResolvedOwner::of(&account)));
    }

    let by_email = match &spec.email {
        Some(e) => verified_owner_of(conn, e).await?,
        None => None,
    };

    if let Some(id) = &spec.id
        && let Some(account) = accounts::by_handle(conn, &id.as_full()).await?
    {
        if let (Some(e), Some(other)) = (&spec.email, &by_email)
            && other.uuid != account.uuid
        {
            return Err(ApiError::conflict(
                "owner_email_conflict",
                format!(
                    "{}: {e} is the verified email of {}, not of the owner {id}.",
                    at("owner_email"),
                    other.display_id()
                ),
            )
            .hint(
                "Send the email the owner actually has, send owner_uuid, or leave owner_email out.",
            ));
        }
        if !can_own(&account) {
            return Err(ApiError::conflict(
                "owner_unavailable",
                format!(
                    "{}: {id} is an account with status {}, and only an active Carbon can own an app.",
                    at("owner_id"),
                    account.status
                ),
            )
            .hint("Name an active Carbon as the owner (an imported account becomes active once its Carbon finishes signing up)."));
        }
        // A c:id alone never moves an existing app to another account: after a rename the old
        // c:id is free again in 10 days, and whoever takes it is not the owner.
        if let Some(cur) = current
            && cur != account.uuid
            && by_email.is_none()
        {
            let kept = accounts::get(conn, cur).await?;
            let kept_id = kept.as_ref().and_then(|a| a.handle.clone());
            warnings.push(format!(
                "owner_id {id} now belongs to another account than the app's owner ({}); the owner was kept. Send owner_uuid, or an owner_email verified on the new owner, to change it.",
                kept_id.clone().unwrap_or_else(|| format!("uuid {cur}"))
            ));
            return Ok(Some(ResolvedOwner {
                uuid: cur.to_string(),
                id: kept_id,
                created: false,
            }));
        }
        return Ok(Some(ResolvedOwner::of(&account)));
    }

    // The verified email of an existing Carbon: the owner, also after a change of c:id.
    if let Some(account) = by_email {
        if let Some(id) = &spec.id {
            warnings.push(format!(
                "owner_id {id} doesn't exist; owner_email is the verified email of {}, which is the owner (c:ids can change: send owner_uuid to be exact).",
                account.display_id()
            ));
        }
        return Ok(Some(ResolvedOwner::of(&account)));
    }

    // Nobody yet: create the owner.
    let (Some(id), Some(email)) = (&spec.id, &spec.email) else {
        return Err(match (&spec.id, &spec.email) {
            (Some(id), _) => ApiError::unprocessable(
                "owner_not_found",
                format!(
                    "{}: the owner {id} doesn't exist, and no owner_email was given to create it.",
                    at("owner_id")
                ),
            )
            .hint("Send owner_email so Silicon Accounts can create the owner's Carbon account."),
            (None, Some(email)) => ApiError::unprocessable(
                "owner_not_found",
                format!(
                    "{}: no active Carbon has the verified email {email}, and no owner_id was given to create one.",
                    at("owner_email")
                ),
            )
            .hint("Send owner_id (the owner's c:id) too, so Silicon Accounts can create the owner's Carbon account."),
            (None, None) => ApiError::internal("owner spec without uuid, id or email"),
        });
    };
    if let Some(other) = accounts::by_email(conn, email).await? {
        return Err(ApiError::conflict(
            "owner_email_conflict",
            format!(
                "{}: {email} is already on {} (unverified, or not an active Carbon), so a new owner {id} can't be created with it.",
                at("owner_email"),
                other.display_id()
            ),
        )
        .hint("Give the new owner another email, or send that account's owner_uuid once it is active."));
    }
    let full = id.to_string();
    let created = accounts::create_carbon(
        conn,
        &state.settings,
        NewCarbon {
            id: id.clone(),
            display_name: title_case_handle(id.handle()),
            pfp_url: None,
            dob: normalize::default_dob(accounts_core::timefmt::today_utc()),
            timezone: "UTC".into(),
            status: AccountStatus::Active,
            emails: vec![NewContact {
                value: email.clone(),
                verified_via: Some(VerifiedVia::Code),
            }],
            phones: Vec::new(),
            actor: actor.to_string(),
        },
    )
    .await
    .map_err(|e| ApiError {
        message: format!(
            "{}: creating the owner {full} failed: {}",
            at("owner_id"),
            e.message
        ),
        ..e
    })?;
    Ok(Some(ResolvedOwner {
        uuid: created.uuid,
        id: Some(full),
        created: true,
    }))
}

fn encrypt_opt(state: &AppState, v: &Option<String>) -> ApiResult<Option<Vec<u8>>> {
    Ok(match v {
        Some(s) => Some(state.keys.keyring.encrypt_str(s)?),
        None => None,
    })
}

/// The webhook columns for an app payload: url + encrypted secret (a new random secret when
/// only the URL is given).
fn webhook_columns(
    state: &AppState,
    app: &ValidApp,
) -> ApiResult<(Option<String>, Option<Vec<u8>>)> {
    match &app.webhook {
        None => Ok((None, None)),
        Some((url, Some(secret))) => Ok((
            Some(url.clone()),
            Some(state.keys.keyring.encrypt_str(secret)?),
        )),
        Some((url, None)) => {
            let (_, enc) = accounts_core::events::new_webhook_secret(&state.keys.keyring)?;
            Ok((Some(url.clone()), Some(enc)))
        }
    }
}

/// Upserts one app. Returns the report line and whether its credentials (secret/status)
/// changed.
async fn upsert_app(
    conn: &mut PgConnection,
    state: &AppState,
    app: &ValidApp,
    mode: SyncMode,
) -> ApiResult<(SyncedApp, bool)> {
    let actor = mode.actor();
    let existing = sqlx::query_as::<_, App>(concat!(
        "select ",
        accounts_core::app_columns!(),
        " from apps where app_id = $1 for update"
    ))
    .bind(&app.app_id)
    .fetch_optional(&mut *conn)
    .await?;
    let mut warnings: Vec<String> = Vec::new();
    let current_owner = existing.as_ref().and_then(|a| a.owner_uuid.clone());
    let owner = resolve_owner(
        conn,
        state,
        app,
        actor,
        current_owner.as_deref(),
        &mut warnings,
    )
    .await?;
    let owner_uuid = owner.as_ref().map(|o| o.uuid.clone());
    let owner_id = owner.as_ref().and_then(|o| o.id.clone());
    let owner_created = owner.as_ref().is_some_and(|o| o.created);
    let (audit_kind, audit_actor) = match mode {
        SyncMode::SiliconApps => (accounts_core::models::ActorKind::Internal, "silicon_apps"),
        SyncMode::Seed { .. } => (accounts_core::models::ActorKind::System, "accounts-seed"),
    };

    let Some(current) = existing else {
        let Some(secret) = &app.secret else {
            let mut f = FieldErrors::new();
            f.add(
                format!("apps[{}].secret", app.index),
                format!(
                    "is required to create the app '{}' (it doesn't exist yet)",
                    app.app_id
                ),
            );
            return Err(ApiError::validation(f));
        };
        let source = match mode {
            SyncMode::SiliconApps => AppSource::SiliconApps,
            SyncMode::Seed { .. } => AppSource::Fake,
        };
        sqlx::query(
            "insert into apps (app_id, name, description, logo_url, logo_dark_url, homepage_url, owner_uuid, \
             secret_hash, status, source, created_at, updated_at) \
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, coalesce($11, now()), now())",
        )
        .bind(&app.app_id)
        .bind(&app.name)
        .bind(&app.description)
        .bind(&app.logo_url)
        .bind(&app.logo_dark_url)
        .bind(&app.homepage_url)
        .bind(&owner_uuid)
        .bind(state.keys.pepper.hash(secret))
        .bind(app.status.unwrap_or(AppStatus::Active))
        .bind(source)
        .bind(app.created_at)
        .execute(&mut *conn)
        .await?;
        let (webhook_url, webhook_enc) = webhook_columns(state, app)?;
        sqlx::query(
            "insert into app_signin_configs (app_id, version, config, google_client_secret_enc, apple_private_key_enc, \
             webhook_url, webhook_secret_enc, updated_by) values ($1, 1, $2, $3, $4, $5, $6, $7)",
        )
        .bind(&app.app_id)
        .bind(serde_json::to_value(&app.config)?)
        .bind(encrypt_opt(state, &app.google_secret)?)
        .bind(encrypt_opt(state, &app.apple_key)?)
        .bind(&webhook_url)
        .bind(&webhook_enc)
        .bind(actor)
        .execute(&mut *conn)
        .await?;
        let origin = match mode {
            SyncMode::SiliconApps => "app created by Silicon Apps; signin_defaults applied",
            SyncMode::Seed { .. } => {
                "fake app seeded from the fake apps file; signin_defaults applied"
            }
        };
        sqlx::query("insert into app_config_history (app_id, version, actor, changes) values ($1, 1, $2, $3)")
            .bind(&app.app_id)
            .bind(actor)
            .bind(json!([{"path": "", "before": null, "after": origin}]))
            .execute(&mut *conn)
            .await?;
        audit::record(
            conn,
            &audit::AuditEntry {
                target_kind: Some("app"),
                target_id: Some(&app.app_id),
                app_id: Some(&app.app_id),
                details: json!({"source": source, "owner": owner_id, "owner_created": owner_created}),
                ..audit::AuditEntry::new(audit_kind, Some(audit_actor), "app.created")
            },
        )
        .await?;
        return Ok((
            SyncedApp {
                app_id: app.app_id.clone(),
                action: "created".into(),
                owner: owner_id,
                owner_created,
                config: "applied".into(),
                config_version: 1,
                webhook: if webhook_url.is_some() { "set" } else { "none" }.into(),
                changed: Vec::new(),
                warnings,
            },
            false,
        ));
    };

    // Existing app: identity follows the payload; the sign-in setup stays (unless forced).
    let mut changed: Vec<String> = Vec::new();
    let mut credentials_changed = false;
    if current.name != app.name {
        changed.push("name".into());
    }
    if current.description != app.description {
        changed.push("description".into());
    }
    if current.logo_url != app.logo_url {
        changed.push("logo_url".into());
    }
    if current.logo_dark_url != app.logo_dark_url {
        changed.push("logo_dark_url".into());
    }
    if current.homepage_url != app.homepage_url {
        changed.push("homepage_url".into());
    }
    let new_owner = if app.owner.is_some() {
        owner_uuid.clone()
    } else {
        current.owner_uuid.clone()
    };
    if new_owner != current.owner_uuid {
        changed.push("owner".into());
    }
    let new_status = app.status.unwrap_or(current.status);
    if new_status != current.status {
        changed.push("status".into());
        credentials_changed = true;
    }
    let new_hash = match &app.secret {
        Some(s) => {
            let h = state.keys.pepper.hash(s);
            if !accounts_core::crypto::constant_time_eq(&h, &current.secret_hash) {
                changed.push("secret".into());
                credentials_changed = true;
            }
            h
        }
        None => current.secret_hash.clone(),
    };
    let new_source = match mode {
        // When Silicon Apps takes over a fake app, it keeps its app_id and its users.
        SyncMode::SiliconApps if current.source != AppSource::SiliconApps => {
            changed.push("source".into());
            AppSource::SiliconApps
        }
        _ => current.source,
    };
    if !changed.is_empty() {
        sqlx::query(
            "update apps set name = $2, description = $3, logo_url = $4, logo_dark_url = $5, homepage_url = $6, \
             owner_uuid = $7, status = $8, secret_hash = $9, source = $10, updated_at = now() where app_id = $1",
        )
        .bind(&app.app_id)
        .bind(&app.name)
        .bind(&app.description)
        .bind(&app.logo_url)
        .bind(&app.logo_dark_url)
        .bind(&app.homepage_url)
        .bind(&new_owner)
        .bind(new_status)
        .bind(&new_hash)
        .bind(new_source)
        .execute(&mut *conn)
        .await?;
    }

    let had_row: bool =
        sqlx::query_scalar("select exists (select 1 from app_signin_configs where app_id = $1)")
            .bind(&app.app_id)
            .fetch_one(&mut *conn)
            .await?;
    let (config, config_version, webhook) = if mode.force() || !had_row {
        reapply_config(conn, state, app, actor, had_row).await?
    } else {
        let (version, has_webhook): (i64, bool) = sqlx::query_as(
            "select version, webhook_url is not null from app_signin_configs where app_id = $1",
        )
        .bind(&app.app_id)
        .fetch_one(&mut *conn)
        .await?;
        let webhook = if has_webhook { "kept" } else { "none" };
        ("kept".to_string(), version, webhook.to_string())
    };
    let config_changed = matches!(config.as_str(), "reapplied" | "applied")
        || matches!(webhook.as_str(), "set" | "removed");
    if !changed.is_empty() || config_changed {
        audit::record(
            conn,
            &audit::AuditEntry {
                target_kind: Some("app"),
                target_id: Some(&app.app_id),
                app_id: Some(&app.app_id),
                details: json!({"changed": changed, "config": config, "owner_created": owner_created}),
                ..audit::AuditEntry::new(audit_kind, Some(audit_actor), "app.synced")
            },
        )
        .await?;
    }
    Ok((
        SyncedApp {
            app_id: app.app_id.clone(),
            action: if changed.is_empty() && !config_changed {
                "unchanged"
            } else {
                "updated"
            }
            .into(),
            owner: if app.owner.is_some() {
                owner_id
            } else {
                match &current.owner_uuid {
                    Some(u) => accounts::get(conn, u).await?.and_then(|a| a.handle),
                    None => None,
                }
            },
            owner_created,
            config,
            config_version,
            webhook,
            changed,
            warnings,
        },
        credentials_changed,
    ))
}

/// Re-applies `signin_defaults` (on top of the default config) and the webhook to an existing
/// app: a new version with a redacted history entry when anything differs.
async fn reapply_config(
    conn: &mut PgConnection,
    state: &AppState,
    app: &ValidApp,
    actor: &str,
    had_row: bool,
) -> ApiResult<(String, i64, String)> {
    ensure_config_row(conn, &app.app_id).await?;
    let row = lock_config_row(conn, &app.app_id).await?;
    let before = serde_json::to_value(SigninConfig::from_stored(&row.config))?;
    let after = serde_json::to_value(&app.config)?;
    let mut changes: Vec<Change> = Vec::new();
    diff(&before, &after, "", &mut changes);
    let stored_google = row
        .google_client_secret_enc
        .as_deref()
        .and_then(|b| state.keys.keyring.decrypt_string(b).ok());
    let stored_apple = row
        .apple_private_key_enc
        .as_deref()
        .and_then(|b| state.keys.keyring.decrypt_string(b).ok());
    let google_change = match &app.google_secret {
        Some(s) => SecretChange::Set(s.clone()),
        None => SecretChange::Remove,
    };
    let apple_change = match &app.apple_key {
        Some(s) => SecretChange::Set(s.clone()),
        None => SecretChange::Remove,
    };
    changes.extend(secret_change_entry(
        "google.client_secret",
        stored_google.as_deref(),
        &google_change,
    ));
    changes.extend(secret_change_entry(
        "apple.private_key",
        stored_apple.as_deref(),
        &apple_change,
    ));

    // Webhook: the payload's URL and secret (none = removed).
    let stored_secret = row
        .webhook_secret_enc
        .as_deref()
        .and_then(|b| state.keys.keyring.decrypt_string(b).ok());
    let webhook_same = match &app.webhook {
        None => row.webhook_url.is_none(),
        Some((url, secret)) => {
            row.webhook_url.as_deref() == Some(url.as_str())
                && (secret.is_none() || stored_secret.as_deref() == secret.as_deref())
        }
    };
    let webhook = if webhook_same {
        if row.webhook_url.is_some() {
            "kept"
        } else {
            "none"
        }
    } else if app.webhook.is_some() {
        "set"
    } else {
        "removed"
    };
    if !webhook_same {
        let (url, enc) = webhook_columns(state, app)?;
        sqlx::query(
            "update app_signin_configs set webhook_url = $2, webhook_secret_enc = $3, updated_at = now() where app_id = $1",
        )
        .bind(&app.app_id)
        .bind(&url)
        .bind(&enc)
        .execute(&mut *conn)
        .await?;
    }

    if changes.is_empty() {
        let label = if had_row { "unchanged" } else { "applied" };
        return Ok((label.into(), row.version, webhook.into()));
    }
    let version: i64 = sqlx::query_scalar(
        "update app_signin_configs set config = $2, version = version + 1, google_client_secret_enc = $3, \
         apple_private_key_enc = $4, updated_at = now(), updated_by = $5 where app_id = $1 returning version",
    )
    .bind(&app.app_id)
    .bind(&after)
    .bind(encrypt_opt(state, &app.google_secret)?)
    .bind(encrypt_opt(state, &app.apple_key)?)
    .bind(actor)
    .fetch_one(&mut *conn)
    .await?;
    sqlx::query(
        "insert into app_config_history (app_id, version, actor, changes) values ($1, $2, $3, $4)",
    )
    .bind(&app.app_id)
    .bind(version)
    .bind(actor)
    .bind(serde_json::to_value(&changes)?)
    .execute(&mut *conn)
    .await?;
    Ok((
        if had_row { "reapplied" } else { "applied" }.into(),
        version,
        webhook.into(),
    ))
}

/// Checks `Authorization: Bearer <ACCOUNTS_INTERNAL_TOKEN>` in constant time.
pub(crate) fn authorize_internal(state: &AppState, headers: &HeaderMap) -> ApiResult<()> {
    let Some(expected) = &state.settings.internal_token else {
        return Err(ApiError::forbidden(
            "internal_api_disabled",
            "The internal API is off on this Silicon Accounts server: ACCOUNTS_INTERNAL_TOKEN is not set.",
        )
        .hint("Set ACCOUNTS_INTERNAL_TOKEN (32+ characters) on the server and send it as Authorization: Bearer <token>."));
    };
    let presented = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .and_then(|v| {
            let (scheme, rest) = v.split_once(' ')?;
            scheme.eq_ignore_ascii_case("bearer").then(|| rest.trim())
        })
        .filter(|t| !t.is_empty());
    let Some(presented) = presented else {
        return Err(ApiError::unauthenticated(
            "internal_token_required",
            "This internal endpoint is for Silicon Apps: send Authorization: Bearer <ACCOUNTS_INTERNAL_TOKEN>.",
        )
        .hint("Apps and accounts can't call /v1/internal/*; it is the service-to-service API of Silicon Apps."));
    };
    // Hash both so the comparison is constant-time regardless of length.
    let a = accounts_core::crypto::sha256(presented.as_bytes());
    let b = accounts_core::crypto::sha256(expected.expose_secret().as_bytes());
    if !accounts_core::crypto::constant_time_eq(&a, &b) {
        return Err(ApiError::unauthenticated(
            "invalid_internal_token",
            "The internal token sent in Authorization is wrong.",
        )
        .hint(
            "Use the ACCOUNTS_INTERNAL_TOKEN value configured on this Silicon Accounts server.",
        ));
    }
    Ok(())
}

async fn export_registry(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Response> {
    authorize_internal(&state, &headers)?;
    let rows: Vec<Value> = sqlx::query_scalar(
        "select jsonb_build_object('app_id',a.app_id,'name',a.name,'description',a.description,         'logo_url',a.logo_url,'homepage_url',a.homepage_url,'owner_uuid',a.owner_uuid,         'source',a.source,'created_at',a.created_at,'authors',coalesce((select jsonb_agg(         jsonb_build_object('uuid',ac.uuid,'id',ac.handle,'display_name',ac.display_name,'joined_at',au.joined_at))         from app_authors au join accounts ac on ac.uuid=au.account_uuid where au.app_id=a.app_id),'[]'::jsonb))         from apps a where a.app_id not in ('silicon-accounts','developer') order by a.app_id"
    ).fetch_all(&state.db).await?;
    Ok(Json(json!({"apps":rows})).into_response())
}

async fn sync_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> ApiResult<Response> {
    authorize_internal(&state, &headers)?;
    let body = body.map_err(|r| {
        if r.status() == StatusCode::PAYLOAD_TOO_LARGE {
            ApiError::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                "payload_too_large",
                "The sync body is larger than 5 MB.",
            )
            .hint("Sync fewer apps per request.")
        } else {
            ApiError::bad_request(
                "invalid_body",
                format!("The request body could not be read: {}.", r.body_text()),
            )
        }
    })?;
    let doc: Value = parse_json(&body)?;
    let apps = parse_apps_document(&doc).map_err(ApiError::validation)?;
    let report = sync_apps(&state, &apps, SyncMode::SiliconApps).await?;
    Ok((StatusCode::OK, Json(report)).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn documents_and_bare_arrays_parse() {
        let one = json!({"app_id": "x-app", "name": "X", "secret": "sa_app_x_123456789012345678", "testkit": {"a": 1}});
        let apps =
            parse_apps_document(&json!({"_comment": "hi", "version": 1, "apps": [one.clone()]}))
                .expect("object");
        assert_eq!(apps[0].app_id, "x-app");
        assert_eq!(parse_apps_document(&json!([one])).expect("array").len(), 1);
        let err = parse_apps_document(&json!({"apps": [{"name": "no id"}]})).expect_err("missing");
        assert!(err.get("apps[0].app_id").is_some(), "{err:?}");
        let err =
            parse_apps_document(&json!({"apps": [{"app_id": 5, "name": "x"}]})).expect_err("type");
        assert!(err.get("apps[0].app_id").is_some(), "{err:?}");
        assert!(parse_apps_document(&json!({"apps": []})).is_err());
        assert!(parse_apps_document(&json!("nope")).is_err());
    }

    #[test]
    fn owner_display_names_come_from_handles() {
        assert_eq!(title_case_handle("acme-dev"), "Acme Dev");
        assert_eq!(title_case_handle("saket"), "Saket");
        assert_eq!(title_case_handle("crm_dev"), "Crm Dev");
    }
}
