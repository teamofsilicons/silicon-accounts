//! Per-invocation context: resolved home, settings, the client, the stored session (with
//! automatic refresh), app credentials and telemetry.

use std::cell::{Cell, OnceCell, RefCell};
use std::path::PathBuf;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use silicon_accounts_client::{
    AccountKind, AccountsClient, AppClient, DEFAULT_BASE_URL, Me, TelemetryEvent, TokenResponse,
    parse_flag,
};
use time::OffsetDateTime;

use crate::cli::GlobalArgs;
use crate::error::{CliError, CliResult, EXIT_AUTH, EXIT_INVALID};
use crate::home::{self, Home};
use crate::output::Output;

/// Refresh the access token when less than this is left.
const REFRESH_MARGIN: time::Duration = time::Duration::seconds(60);

/// `{home}/.accounts/config.json`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct FileConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub telemetry: Option<bool>,
    /// The app chosen with `silicon-accounts app use`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app: Option<String>,
}

/// `{home}/.accounts/session.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredSession {
    /// The Silicon Accounts URL this session belongs to.
    pub url: String,
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: Option<String>,
    #[serde(with = "time::serde::rfc3339")]
    pub expires_at: OffsetDateTime,
    #[serde(default, with = "time::serde::rfc3339::option")]
    pub refresh_expires_at: Option<OffsetDateTime>,
    pub kind: AccountKind,
    pub account: StoredAccount,
    #[serde(with = "time::serde::rfc3339")]
    pub signed_in_at: OffsetDateTime,
    /// `device`, `email`, `phone` or `silicon_stk`.
    #[serde(default)]
    pub method: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredAccount {
    pub uuid: String,
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub display_name: String,
}

impl StoredSession {
    fn needs_refresh(&self) -> bool {
        self.expires_at - OffsetDateTime::now_utc() < REFRESH_MARGIN
    }

    /// `si:scout` (or the uuid when the id is unknown).
    pub fn who(&self) -> &str {
        if self.account.id.is_empty() {
            &self.account.uuid
        } else {
            &self.account.id
        }
    }
}

/// `{home}/.accounts/apps/<app_id>.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredApp {
    pub app_id: String,
    #[serde(default)]
    pub app_secret: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(with = "time::serde::rfc3339")]
    pub saved_at: OffsetDateTime,
}

/// `{home}/.accounts/requests/<id>.json`: lets `silicon-accounts silicon request status` poll later.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredRequest {
    pub request_id: String,
    pub request_token: String,
    pub silicon_uuid: String,
    pub silicon_id: String,
    pub custodian: String,
    #[serde(default, with = "time::serde::rfc3339::option")]
    pub expires_at: Option<OffsetDateTime>,
    pub url: String,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
}

/// `{home}/.accounts/login-challenge.json`: a code sign-in waiting for its code.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredChallenge {
    pub challenge_id: String,
    /// The email or phone as typed (lowercased).
    pub contact: String,
    pub destination: String,
    #[serde(default, with = "time::serde::rfc3339::option")]
    pub expires_at: Option<OffsetDateTime>,
    pub url: String,
}

/// Where the URL came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UrlSource {
    Flag,
    Env,
    Config,
    Session,
    PendingLogin,
    Default,
}

impl UrlSource {
    pub fn key(self) -> &'static str {
        match self {
            Self::Flag => "flag",
            Self::Env => "env:ACCOUNTS_URL",
            Self::Config => "config",
            Self::Session => "session",
            Self::PendingLogin => "pending_login",
            Self::Default => "default",
        }
    }
}

fn normalize_url(url: &str) -> String {
    url.trim().trim_end_matches('/').to_owned()
}

/// Telemetry buffered during a command and sent once at the end.
#[derive(Debug)]
pub struct Telemetry {
    events: RefCell<Vec<TelemetryEvent>>,
    command: RefCell<String>,
    started: Instant,
}

impl Telemetry {
    fn new() -> Self {
        Self {
            events: RefCell::new(Vec::new()),
            command: RefCell::new(String::new()),
            started: Instant::now(),
        }
    }

    pub fn set_command(&self, path: &str) {
        *self.command.borrow_mut() = path.to_owned();
    }

    /// Records a step of a multi-step flow (`login.device.code_shown`, progress 0.3…).
    pub fn step(&self, step: &str, progress: f64, data: Value) {
        let mut events = self.events.borrow_mut();
        if events.len() < 40 {
            events.push(TelemetryEvent {
                source: "cli".to_owned(),
                step: step.to_owned(),
                name: "cli.step".to_owned(),
                progress: Some(progress.clamp(0.0, 1.0)),
                data: with_context(data, &self.command.borrow()),
            });
        }
    }
}

fn with_context(mut data: Value, command: &str) -> Value {
    if !data.is_object() {
        data = json!({});
    }
    data["command"] = json!(command);
    data["cli_version"] = json!(env!("CARGO_PKG_VERSION"));
    data["os"] = json!(std::env::consts::OS);
    data["arch"] = json!(std::env::consts::ARCH);
    data
}

/// Everything a command needs.
pub struct Ctx {
    pub out: Output,
    pub global: GlobalArgs,
    pub telemetry: Telemetry,
    home: OnceCell<Home>,
    config: OnceCell<FileConfig>,
    url: OnceCell<(String, UrlSource)>,
    client: OnceCell<AccountsClient>,
    network_used: Cell<bool>,
}

impl Ctx {
    pub fn new(global: GlobalArgs) -> Self {
        Self {
            out: Output {
                json: global.json,
                quiet: global.quiet,
            },
            global,
            telemetry: Telemetry::new(),
            home: OnceCell::new(),
            config: OnceCell::new(),
            url: OnceCell::new(),
            client: OnceCell::new(),
            network_used: Cell::new(false),
        }
    }

    // ---- home and settings --------------------------------------------------------------

    pub fn home(&self) -> CliResult<&Home> {
        if let Some(home) = self.home.get() {
            return Ok(home);
        }
        let home = home::resolve(self.global.home.as_deref())?;
        Ok(self.home.get_or_init(|| home))
    }

    pub fn config(&self) -> CliResult<&FileConfig> {
        if let Some(config) = self.config.get() {
            return Ok(config);
        }
        let path = self.home()?.file("config.json");
        let config = home::read_json::<FileConfig>(&path)?.unwrap_or_default();
        Ok(self.config.get_or_init(|| config))
    }

    pub fn save_config(&self, config: &FileConfig) -> CliResult<PathBuf> {
        let path = self.home()?.file("config.json");
        home::write_json(&path, config)?;
        Ok(path)
    }

    /// The URL and where it came from: --url > ACCOUNTS_URL > config.json > the stored
    /// session's URL > a pending code sign-in's URL > the default. Resolved once per command: a
    /// session that ends while the command runs (and is deleted) must not move the command, or
    /// the sign-in that replaces it, to another URL.
    pub fn url(&self) -> CliResult<(String, UrlSource)> {
        if let Some(resolved) = self.url.get() {
            return Ok(resolved.clone());
        }
        let resolved = self.resolve_url()?;
        Ok(self.url.get_or_init(|| resolved).clone())
    }

    fn resolve_url(&self) -> CliResult<(String, UrlSource)> {
        if let Some(url) = self.global.url.as_deref().filter(|u| !u.trim().is_empty()) {
            return Ok((normalize_url(url), UrlSource::Flag));
        }
        if let Some(url) = std::env::var("ACCOUNTS_URL")
            .ok()
            .filter(|u| !u.trim().is_empty())
        {
            return Ok((normalize_url(&url), UrlSource::Env));
        }
        if let Some(url) = self
            .config()?
            .url
            .as_deref()
            .filter(|u| !u.trim().is_empty())
        {
            return Ok((normalize_url(url), UrlSource::Config));
        }
        if let Some(session) = self.load_session()? {
            return Ok((normalize_url(&session.url), UrlSource::Session));
        }
        // A code sign-in started with --url continues at that URL.
        let pending: Option<StoredChallenge> =
            home::read_json(&self.home()?.file("login-challenge.json"))?;
        if let Some(pending) = pending {
            return Ok((normalize_url(&pending.url), UrlSource::PendingLogin));
        }
        Ok((DEFAULT_BASE_URL.to_owned(), UrlSource::Default))
    }

    /// Telemetry on/off and why: ACCOUNTS_TELEMETRY > config.json > on.
    pub fn telemetry_setting(&self) -> (bool, &'static str) {
        if let Ok(value) = std::env::var("ACCOUNTS_TELEMETRY")
            && let Some(flag) = parse_flag(&value)
        {
            return (flag, "env:ACCOUNTS_TELEMETRY");
        }
        match self.config().ok().and_then(|c| c.telemetry) {
            Some(flag) => (flag, "config"),
            None => (true, "default"),
        }
    }

    pub fn client(&self) -> CliResult<&AccountsClient> {
        if let Some(client) = self.client.get() {
            self.network_used.set(true);
            return Ok(client);
        }
        let (url, _) = self.url()?;
        let mut builder = AccountsClient::builder()
            .base_url(&url)
            .user_agent(format!(
                "silicon-accounts-cli/{}",
                env!("CARGO_PKG_VERSION")
            ))
            .telemetry(self.telemetry_setting().0);
        if let Ok(value) = std::env::var("ACCOUNTS_ALLOW_INSECURE_HTTP") {
            builder = builder.allow_insecure_http(parse_flag(&value).unwrap_or(false));
        }
        if let Ok(value) = std::env::var("ACCOUNTS_TIMEOUT_SECONDS") {
            let seconds: u64 = value.trim().parse().map_err(|_| {
                CliError::invalid(
                    format!("ACCOUNTS_TIMEOUT_SECONDS is `{value}`, which is not a whole number of seconds."),
                    "Set it to a number such as 30, or unset it.",
                )
            })?;
            builder = builder.timeout(Duration::from_secs(seconds.max(1)));
        }
        let client = builder.build()?;
        self.network_used.set(true);
        Ok(self.client.get_or_init(|| client))
    }

    // ---- session ------------------------------------------------------------------------

    pub fn session_path(&self) -> CliResult<PathBuf> {
        Ok(self.home()?.file("session.json"))
    }

    pub fn load_session(&self) -> CliResult<Option<StoredSession>> {
        home::read_json(&self.session_path()?)
    }

    pub fn save_session(&self, session: &StoredSession) -> CliResult<()> {
        home::write_json(&self.session_path()?, session)
    }

    pub fn clear_session(&self) -> CliResult<bool> {
        home::remove_file(&self.session_path()?)
    }

    /// The stored session for the current URL, if any (no network).
    pub fn current_session(&self) -> CliResult<Option<StoredSession>> {
        let Some(session) = self.load_session()? else {
            return Ok(None);
        };
        let (url, _) = self.url()?;
        Ok((normalize_url(&session.url) == url).then_some(session))
    }

    /// The signed-in session, refreshed when it is about to expire.
    pub async fn session(&self) -> CliResult<StoredSession> {
        let (url, _) = self.url()?;
        let Some(session) = self.load_session()? else {
            return Err(not_signed_in(&url));
        };
        if normalize_url(&session.url) != url {
            return Err(CliError::new(
                EXIT_AUTH,
                "not_signed_in",
                format!(
                    "You are signed in to {} as {}, but this command targets {url}.",
                    session.url,
                    session.who()
                ),
                format!(
                    "Sign in there with `silicon-accounts login --url {url}`, or drop --url / ACCOUNTS_URL to use {}.",
                    session.url
                ),
            ));
        }
        if session.needs_refresh() {
            return self.refresh_session(&session).await;
        }
        Ok(session)
    }

    /// The signed-in session, which must be of `kind`.
    pub async fn session_of(&self, kind: AccountKind, what: &str) -> CliResult<StoredSession> {
        let session = self.session().await?;
        if session.kind != kind {
            let hint = match kind {
                AccountKind::Carbon => {
                    "Sign in as a Carbon with `silicon-accounts login` (Silicons don't have this)."
                }
                AccountKind::Silicon => {
                    "Sign in as the Silicon with `silicon-accounts login --silicon si:… --stk-stdin`."
                }
            };
            return Err(CliError::new(
                EXIT_AUTH,
                "wrong_account_kind",
                format!(
                    "{what} is for {} accounts, but you are signed in as {} {}.",
                    kind.title(),
                    session.kind.title(),
                    session.who()
                ),
                hint,
            ));
        }
        Ok(session)
    }

    /// Rotates the refresh token under a file lock so concurrent CLI processes never
    /// present the same refresh token twice (that would revoke the whole session).
    pub async fn refresh_session(&self, current: &StoredSession) -> CliResult<StoredSession> {
        let state_dir = self.home()?.state_dir();
        let _lock = home::lock(&state_dir, "session")?;
        // Re-read under the lock: another process may have refreshed, signed out, or signed
        // in as someone else meanwhile.
        let Some(latest) = self.load_session()? else {
            return Err(not_signed_in(&current.url));
        };
        if latest.account.uuid != current.account.uuid || latest.url != current.url {
            return Err(CliError::new(
                EXIT_AUTH,
                "session_changed",
                format!(
                    "The stored session changed while this command ran: this home is now signed in as {} at {}.",
                    latest.who(),
                    latest.url
                ),
                "Run the command again.",
            ));
        }
        if latest.refresh_token != current.refresh_token && !latest.needs_refresh() {
            // Another process refreshed while we waited for the lock.
            return Ok(latest);
        }
        let current = &latest;
        let Some(refresh_token) = current.refresh_token.clone() else {
            return Err(session_ended(
                current,
                "the stored session has no refresh token",
            ));
        };
        let client = self.client()?;
        match client.refresh_first_party(&refresh_token).await {
            Ok(tokens) => {
                let mut session = current.clone();
                session.access_token = tokens.access_token.expose().to_owned();
                if let Some(new_refresh) = &tokens.refresh_token {
                    session.refresh_token = Some(new_refresh.expose().to_owned());
                }
                session.expires_at = tokens.access_expires_at(OffsetDateTime::now_utc());
                if tokens.refresh_token_expires_at.is_some() {
                    session.refresh_expires_at = tokens.refresh_token_expires_at;
                }
                if let Some(account) = &tokens.account {
                    session.account.id.clone_from(&account.id);
                    session
                        .account
                        .display_name
                        .clone_from(&account.display_name);
                }
                self.save_session(&session)?;
                self.telemetry.step("session.refreshed", 1.0, json!({}));
                Ok(session)
            }
            Err(err) if err.is_unauthenticated() => {
                if let Some(latest) = self.load_session()?
                    && latest.refresh_token.as_deref() == Some(refresh_token.as_str())
                {
                    self.clear_session()?;
                }
                Err(session_ended(current, &err.message()))
            }
            Err(err) => Err(err.into()),
        }
    }

    /// Stores a fresh sign-in.
    pub fn store_tokens(
        &self,
        tokens: &TokenResponse,
        me: Option<&Me>,
        method: &str,
    ) -> CliResult<StoredSession> {
        let (url, _) = self.url()?;
        let now = OffsetDateTime::now_utc();
        let (kind, account) = match (me, &tokens.account) {
            (Some(me), _) => (
                me.kind,
                StoredAccount {
                    uuid: me.uuid.clone(),
                    id: me.id.clone(),
                    display_name: me.display_name.clone(),
                },
            ),
            (None, Some(a)) => (
                a.kind,
                StoredAccount {
                    uuid: a.uuid.clone(),
                    id: a.id.clone(),
                    display_name: a.display_name.clone(),
                },
            ),
            (None, None) => {
                return Err(CliError::new(
                    1,
                    "unexpected_response",
                    "The sign-in succeeded but neither the token response nor GET /v1/me said which account it is.",
                    "Retry; if it persists, report it with `silicon-accounts report`.",
                ));
            }
        };
        let session = StoredSession {
            url,
            access_token: tokens.access_token.expose().to_owned(),
            refresh_token: tokens.refresh_token.as_ref().map(|t| t.expose().to_owned()),
            expires_at: tokens.access_expires_at(now),
            refresh_expires_at: tokens.refresh_token_expires_at,
            kind,
            account,
            signed_in_at: now,
            method: method.to_owned(),
        };
        let _lock = home::lock(&self.home()?.state_dir(), "session")?;
        self.save_session(&session)?;
        Ok(session)
    }

    // ---- apps ---------------------------------------------------------------------------

    /// Resolves which app and which credentials `silicon-accounts app …` uses: --app-id >
    /// ACCOUNTS_APP_ID > `silicon-accounts app use`; secret from --app-secret / --app-secret-stdin >
    /// ACCOUNTS_APP_SECRET > the stored apps/<app_id>.json.
    pub fn app_selection(
        &self,
        app_id: Option<&str>,
        app_secret: Option<&str>,
        secret_stdin: bool,
    ) -> CliResult<AppSelection> {
        let env = |name: &str| {
            std::env::var(name)
                .ok()
                .map(|v| v.trim().to_owned())
                .filter(|v| !v.is_empty())
        };
        let (app_id, id_source) = if let Some(id) = app_id {
            (id.trim().to_owned(), "--app-id")
        } else if let Some(id) = env("ACCOUNTS_APP_ID") {
            (id, "ACCOUNTS_APP_ID")
        } else if let Some(id) = self.config()?.app.clone() {
            (id, "silicon-accounts app use")
        } else {
            return Err(CliError::invalid(
                "No app selected for this command.",
                "Pass --app-id <app_id>, set ACCOUNTS_APP_ID, or run `silicon-accounts app use <app_id> --secret-stdin` once.",
            ));
        };
        let secret = if let Some(secret) = app_secret {
            Some((secret.trim().to_owned(), "--app-secret"))
        } else if secret_stdin {
            Some((
                crate::util::read_secret_stdin("the app secret")?,
                "--app-secret-stdin",
            ))
        } else if let Some(secret) = env("ACCOUNTS_APP_SECRET") {
            Some((secret, "ACCOUNTS_APP_SECRET"))
        } else {
            self.load_app(&app_id)?
                .and_then(|stored| stored.app_secret)
                .map(|secret| (secret, "stored by silicon-accounts app use"))
        };
        Ok(AppSelection {
            app_id,
            id_source,
            secret: secret.as_ref().map(|(s, _)| s.clone()),
            secret_source: secret.map(|(_, src)| src),
        })
    }

    /// An app client: with the app's secret when known, else as its owner.
    pub async fn app_client(&self, selection: &AppSelection) -> CliResult<AppClient<'_>> {
        let client = self.client()?;
        if let Some(secret) = &selection.secret {
            return Ok(client.as_app(selection.app_id.clone(), secret.clone()));
        }
        let (url, _) = self.url()?;
        match self.load_session()? {
            Some(session)
                if normalize_url(&session.url) == url && session.kind == AccountKind::Carbon =>
            {
                let session = self.session().await?;
                Ok(client
                    .with_token(session.access_token)
                    .app(selection.app_id.clone()))
            }
            _ => Err(CliError::new(
                EXIT_AUTH,
                "app_credentials_required",
                format!(
                    "No app secret for {} and you are not signed in as a Carbon, so there is no way to act for this app.",
                    selection.app_id
                ),
                format!(
                    "Pass the secret (--app-secret-stdin or ACCOUNTS_APP_SECRET), store it with `silicon-accounts app use {} --secret-stdin`, or sign in as the app's owner with `silicon-accounts login`.",
                    selection.app_id
                ),
            )),
        }
    }

    pub fn app_path(&self, app_id: &str) -> CliResult<PathBuf> {
        if app_id.is_empty()
            || app_id.len() > 40
            || !app_id
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
        {
            return Err(CliError::invalid(
                format!(
                    "`{app_id}` is not an app id: app ids are lowercase letters, digits, dashes and underscores (e.g. briefcase or my_app)."
                ),
                "Check the app id in Silicon Apps or with `silicon-accounts app list`.",
            ));
        }
        Ok(self
            .home()?
            .state_dir()
            .join("apps")
            .join(format!("{app_id}.json")))
    }

    pub fn load_app(&self, app_id: &str) -> CliResult<Option<StoredApp>> {
        home::read_json(&self.app_path(app_id)?)
    }

    // ---- telemetry ----------------------------------------------------------------------

    /// Sends the buffered steps plus a final `cli.command` event. Never fails the command
    /// and waits at most 1.5 s.
    pub async fn flush_telemetry(&self, exit: i32, error: Option<&CliError>) {
        if !self.network_used.get()
            || !self.telemetry_setting().0
            || error.is_some_and(|e| e.transport)
        {
            return;
        }
        let Some(client) = self.client.get() else {
            return;
        };
        let command = self.telemetry.command.borrow().clone();
        let mut events = self.telemetry.events.borrow().clone();
        let kind = self.load_session().ok().flatten().map(|s| s.kind.as_str());
        events.push(TelemetryEvent {
            source: "cli".to_owned(),
            step: command.clone(),
            name: "cli.command".to_owned(),
            progress: Some(1.0),
            data: with_context(
                json!({
                    "outcome": if exit == 0 { "ok" } else { "error" },
                    "exit_code": exit,
                    "error_code": error.map(|e| e.code.clone()),
                    "duration_ms": u64::try_from(self.telemetry.started.elapsed().as_millis()).unwrap_or(u64::MAX),
                    "json": self.global.json,
                    "account_kind": kind,
                }),
                &command,
            ),
        });
        let _ =
            tokio::time::timeout(Duration::from_millis(1500), client.send_telemetry(&events)).await;
    }
}

/// Which app `silicon-accounts app` acts for.
#[derive(Debug, Clone)]
pub struct AppSelection {
    pub app_id: String,
    pub id_source: &'static str,
    pub secret: Option<String>,
    pub secret_source: Option<&'static str>,
}

pub fn not_signed_in(url: &str) -> CliError {
    CliError::new(
        EXIT_AUTH,
        "not_signed_in",
        format!("You are not signed in to {url}."),
        "Carbons: run `silicon-accounts login`. Silicons: run `silicon-accounts login --silicon si:<id> --stk-stdin` (or set ACCOUNTS_SILICON and ACCOUNTS_STK).",
    )
}

fn session_ended(session: &StoredSession, why: &str) -> CliError {
    CliError::new(
        EXIT_AUTH,
        "session_ended",
        format!("Your session as {} has ended: {why}", session.who()),
        "It was signed out elsewhere, revoked, or (for a Silicon) the STK was rotated. Sign in again with `silicon-accounts login`.",
    )
}

/// Validates a value given for `silicon-accounts config set url`.
pub fn validate_url(url: &str) -> CliResult<String> {
    let url = normalize_url(url);
    let allow_http = std::env::var("ACCOUNTS_ALLOW_INSECURE_HTTP")
        .ok()
        .and_then(|v| parse_flag(&v))
        .unwrap_or(false);
    AccountsClient::builder()
        .base_url(&url)
        .allow_insecure_http(allow_http)
        .build()
        .map_err(|e| {
            CliError::new(
                EXIT_INVALID,
                "invalid_url",
                e.message(),
                e.hint().unwrap_or_default(),
            )
        })?;
    Ok(url)
}

/// Runs an account call with the stored session and evaluates to `CliResult<T>`. On a
/// 401 the session is refreshed once and the call retried; if the refresh is refused the
/// session is cleared and the error says to sign in again.
#[macro_export]
macro_rules! with_session {
    ($ctx:expr, |$s:ident| $body:expr) => {
        async {
            let ctx: &$crate::ctx::Ctx = &$ctx;
            let stored = ctx.session().await?;
            let first = {
                let $s = ctx.client()?.with_token(stored.access_token.clone());
                $body.await
            };
            let result: $crate::error::CliResult<_> = match first {
                Err(err) if err.status() == Some(401) => {
                    let stored = ctx.refresh_session(&stored).await?;
                    let $s = ctx.client()?.with_token(stored.access_token.clone());
                    $body.await.map_err($crate::error::CliError::from)
                }
                other => other.map_err($crate::error::CliError::from),
            };
            result
        }
        .await
    };
}
