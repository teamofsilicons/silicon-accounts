//! Service configuration from `ACCOUNTS_*` environment variables.
//!
//! [`Settings::from_env`] loads `.env` (outside production), reads every variable, applies the
//! development defaults and refuses unsafe production setups. Every problem is reported at once,
//! each naming the variable, what is wrong and how to fix it.
//!
//! Tests never touch the process environment (setting env vars is `unsafe` in edition 2024):
//! use [`Settings::for_tests`] or [`Settings::from_lookup`] with a map.

use std::collections::BTreeMap;
use std::fmt;
use std::net::{SocketAddr, ToSocketAddrs};
use std::path::PathBuf;

use secrecy::{ExposeSecret, SecretString};
use url::Url;

/// DEV ONLY token pepper (base64url 32 bytes). Production refuses to start with it.
pub const DEV_TOKEN_PEPPER: &str = "MpCAPN8YjuX0SqKr_TERF-YQqhWAYWUuiCf01s2yZT0";
/// DEV ONLY AES-256-GCM key, keyring version 1. Production refuses to start with it.
pub const DEV_ENCRYPTION_KEY: &str = "p08VPTPd6SNsaUqyQXvLNZsCJzmEAfDr4dfTTWiubZM";
/// DEV ONLY Ed25519 seed for JWT signing (base64url 32 bytes). Production refuses it.
pub const DEV_JWT_SEED: &str = "yiG8SlUChKbHOf56uYdM_CQCM9PJz9TOyIKU61VcuCU";
/// Key id used with the dev JWT key.
pub const DEV_JWT_KEY_ID: &str = "dev-1";

/// Contract values (UNDERSTANDING.md). Production refuses anything else.
pub const CONTRACT_OTP_TTL_SECONDS: i64 = 600;
pub const CONTRACT_OTP_LOCK_SECONDS: i64 = 60;
pub const CONTRACT_ACCESS_TOKEN_TTL_SECONDS: i64 = 1800;

/// Where the published docs live unless ACCOUNTS_DOCS_URL says otherwise.
pub const DEFAULT_DOCS_URL: &str = "https://developers.teamofsilicons.com/docs/accounts";

/// The developer platform in production unless ACCOUNTS_DEVELOPER_URL says otherwise.
pub const DEFAULT_DEVELOPER_URL: &str = "https://developers.teamofsilicons.com";

/// The developer platform's default outside production: `next dev` in developer/ on port 8600
/// (scripts/dev.sh sets ACCOUNTS_DEVELOPER_URL for stacks on other ports).
pub const DEV_DEVELOPER_URL: &str = "http://localhost:8600";

/// Where the developer platform receives its sign-in result: the only redirect URI of the
/// first-party app `developer`, compared exactly (`{developer_url}{DEVELOPER_CALLBACK_PATH}`).
pub const DEVELOPER_CALLBACK_PATH: &str = "/auth/callback";

/// Every environment variable the service reads (all documented in `.env.example`).
pub const VARIABLES: &[&str] = &[
    "ACCOUNTS_ACCESS_TOKEN_TTL_SECONDS",
    "ACCOUNTS_APPLE_AUTH_URL",
    "ACCOUNTS_APPLE_ISSUER",
    "ACCOUNTS_APPLE_JWKS_URL",
    "ACCOUNTS_APPLE_KEY_ID",
    "ACCOUNTS_APPLE_PRIVATE_KEY",
    "ACCOUNTS_APPLE_SERVICES_ID",
    "ACCOUNTS_APPLE_TEAM_ID",
    "ACCOUNTS_APPLE_TOKEN_URL",
    "ACCOUNTS_BIND_ADDR",
    "ACCOUNTS_COOKIE_SECURE",
    "ACCOUNTS_DATABASE_MAX_CONNECTIONS",
    "ACCOUNTS_DATABASE_URL",
    "ACCOUNTS_DELIVERY",
    "ACCOUNTS_DEVELOPER_URL",
    "ACCOUNTS_DOCS_URL",
    "ACCOUNTS_ENCRYPTION_CURRENT_VERSION",
    "ACCOUNTS_ENCRYPTION_KEYRING",
    "ACCOUNTS_ENVIRONMENT",
    "ACCOUNTS_EXPOSE_DEV_OUTBOX",
    "ACCOUNTS_EXTRA_ALLOWED_ORIGINS",
    "ACCOUNTS_FEDERATION_ALLOW_LOOPBACK",
    "ACCOUNTS_GOOGLE_AUTH_URL",
    "ACCOUNTS_GOOGLE_CLIENT_ID",
    "ACCOUNTS_GOOGLE_CLIENT_SECRET",
    "ACCOUNTS_GOOGLE_ISSUERS",
    "ACCOUNTS_GOOGLE_JWKS_URL",
    "ACCOUNTS_GOOGLE_TOKEN_URL",
    "ACCOUNTS_INTERNAL_TOKEN",
    "ACCOUNTS_IP_TIMEZONE_HEADERS",
    "ACCOUNTS_IRIS_BASE_URL",
    "ACCOUNTS_JWT_KEY_ID",
    "ACCOUNTS_JWT_PRIVATE_KEY",
    "ACCOUNTS_LOG_FILTER",
    "ACCOUNTS_OTP_LOCK_SECONDS",
    "ACCOUNTS_OTP_TTL_SECONDS",
    "ACCOUNTS_POSTMARK_API_URL",
    "ACCOUNTS_POSTMARK_FROM",
    "ACCOUNTS_POSTMARK_SERVER_TOKEN",
    "ACCOUNTS_PUBLIC_URL",
    "ACCOUNTS_REPORT_RECIPIENTS",
    "ACCOUNTS_SILICON_APPS_URL",
    "ACCOUNTS_TELEMETRY_ENABLED",
    "ACCOUNTS_TELEMETRY_TABLE_KEY",
    "ACCOUNTS_TOKEN_PEPPER",
    "ACCOUNTS_TRUST_FORWARDED_FOR",
    "ACCOUNTS_TWILIO_ACCOUNT_SID",
    "ACCOUNTS_TWILIO_API_URL",
    "ACCOUNTS_TWILIO_AUTH_TOKEN",
    "ACCOUNTS_TWILIO_FROM",
    "ACCOUNTS_TWILIO_MESSAGING_SERVICE_SID",
    "ACCOUNTS_WEBHOOK_ALLOW_PRIVATE",
    "ACCOUNTS_WEB_DIST",
    "ACCOUNTS_WORKER_ENABLED",
];

/// Where the service runs. Production enables every safety check.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Environment {
    Development,
    Test,
    Production,
}

impl Environment {
    pub fn as_str(&self) -> &'static str {
        match self {
            Environment::Development => "development",
            Environment::Test => "test",
            Environment::Production => "production",
        }
    }

    pub fn is_production(&self) -> bool {
        matches!(self, Environment::Production)
    }

    fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "development" | "dev" => Some(Environment::Development),
            "test" => Some(Environment::Test),
            "production" | "prod" => Some(Environment::Production),
            _ => None,
        }
    }
}

impl fmt::Display for Environment {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// How OTP codes and other messages leave the service.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeliveryMode {
    /// Never send; store messages in `outbound_messages` with status `local` (dev outbox).
    Local,
    /// Send email through Postmark and SMS through Twilio.
    Providers,
}

impl DeliveryMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            DeliveryMode::Local => "local",
            DeliveryMode::Providers => "providers",
        }
    }
}

/// Postmark (email) settings.
#[derive(Debug, Clone)]
pub struct PostmarkSettings {
    pub server_token: Option<SecretString>,
    pub from: String,
    /// Base URL; the sender POSTs to `{api_url}/email`.
    pub api_url: String,
}

/// Twilio (SMS) settings. `messaging_service_sid` is preferred over `from`.
#[derive(Debug, Clone)]
pub struct TwilioSettings {
    pub account_sid: Option<String>,
    pub auth_token: Option<SecretString>,
    pub messaging_service_sid: Option<String>,
    pub from: Option<String>,
    /// Base URL; the sender POSTs to `{api_url}/2010-04-01/Accounts/{sid}/Messages.json`.
    pub api_url: String,
}

impl TwilioSettings {
    /// True when SMS can actually be sent.
    pub fn configured(&self) -> bool {
        self.account_sid.is_some()
            && self.auth_token.is_some()
            && (self.messaging_service_sid.is_some() || self.from.is_some())
    }
}

/// Managed ("one click") Google sign-in settings.
#[derive(Debug, Clone)]
pub struct GoogleSettings {
    pub client_id: Option<String>,
    pub client_secret: Option<SecretString>,
    pub auth_url: String,
    pub token_url: String,
    pub jwks_url: String,
    /// Accepted `iss` values of Google id_tokens.
    pub issuers: Vec<String>,
}

impl GoogleSettings {
    /// True when managed Google credentials exist (one-click Google can be offered).
    pub fn managed_configured(&self) -> bool {
        self.client_id.is_some() && self.client_secret.is_some()
    }
}

/// Managed ("one click") Sign in with Apple settings.
#[derive(Debug, Clone)]
pub struct AppleSettings {
    pub services_id: Option<String>,
    pub team_id: Option<String>,
    pub key_id: Option<String>,
    /// The `.p8` private key (PEM).
    pub private_key: Option<SecretString>,
    pub auth_url: String,
    pub token_url: String,
    pub jwks_url: String,
    pub issuer: String,
}

impl AppleSettings {
    /// True when managed Apple credentials exist (one-click Apple can be offered).
    pub fn managed_configured(&self) -> bool {
        self.services_id.is_some()
            && self.team_id.is_some()
            && self.key_id.is_some()
            && self.private_key.is_some()
    }
}

/// Every setting of the service. Field docs name the environment variable.
#[derive(Debug, Clone)]
pub struct Settings {
    /// ACCOUNTS_ENVIRONMENT (development | test | production).
    pub environment: Environment,
    /// ACCOUNTS_BIND_ADDR. Default `127.0.0.1:8589`: the account site (Next.js) serves the public
    /// origin and proxies `/v1/*` and `/.well-known/*` to this address.
    pub bind_addr: SocketAddr,
    /// ACCOUNTS_PUBLIC_URL without a trailing slash; also the token issuer.
    pub public_url: String,
    /// Origin (`scheme://host[:port]`) of `public_url`.
    pub public_origin: String,
    /// ACCOUNTS_EXTRA_ALLOWED_ORIGINS, normalized to origins.
    pub extra_allowed_origins: Vec<String>,
    /// ACCOUNTS_DATABASE_URL.
    pub database_url: SecretString,
    /// ACCOUNTS_DATABASE_MAX_CONNECTIONS.
    pub database_max_connections: u32,
    /// ACCOUNTS_WEB_DIST.
    pub web_dist: Option<PathBuf>,
    /// ACCOUNTS_TOKEN_PEPPER (base64url 32 bytes).
    pub token_pepper: SecretString,
    /// ACCOUNTS_ENCRYPTION_KEYRING (JSON version → base64url 32-byte key).
    pub encryption_keyring: SecretString,
    /// ACCOUNTS_ENCRYPTION_CURRENT_VERSION.
    pub encryption_current_version: u8,
    /// ACCOUNTS_JWT_PRIVATE_KEY (PKCS#8 PEM or base64url 32-byte seed).
    pub jwt_private_key: SecretString,
    /// ACCOUNTS_JWT_KEY_ID.
    pub jwt_key_id: String,
    /// ACCOUNTS_COOKIE_SECURE (cookie names get the `__Host-` prefix when true).
    pub cookie_secure: bool,
    /// ACCOUNTS_DELIVERY.
    pub delivery: DeliveryMode,
    /// ACCOUNTS_POSTMARK_*.
    pub postmark: PostmarkSettings,
    /// ACCOUNTS_TWILIO_*.
    pub twilio: TwilioSettings,
    /// ACCOUNTS_EXPOSE_DEV_OUTBOX (never true in production).
    pub expose_dev_outbox: bool,
    /// ACCOUNTS_GOOGLE_*.
    pub google: GoogleSettings,
    /// ACCOUNTS_APPLE_*.
    pub apple: AppleSettings,
    /// ACCOUNTS_IRIS_BASE_URL without a trailing slash.
    pub iris_base_url: String,
    /// ACCOUNTS_IP_TIMEZONE_HEADERS (lowercase header names).
    pub ip_timezone_headers: Vec<String>,
    /// ACCOUNTS_TRUST_FORWARDED_FOR.
    pub trust_forwarded_for: bool,
    /// ACCOUNTS_SILICON_APPS_URL.
    pub silicon_apps_url: String,
    /// ACCOUNTS_DOCS_URL: where the published docs live (`GET /v1/meta` `docs_url`).
    pub docs_url: String,
    /// ACCOUNTS_DEVELOPER_URL without a trailing slash: the developer platform
    /// (`GET /v1/meta` `developer_url`). The first-party app `developer` may only redirect to
    /// `{developer_url}/auth/callback`.
    pub developer_url: String,
    /// Origin (`scheme://host[:port]`) of `developer_url`.
    pub developer_origin: String,
    /// ACCOUNTS_INTERNAL_TOKEN (service token for `/v1/internal/*`).
    pub internal_token: Option<SecretString>,
    /// ACCOUNTS_REPORT_RECIPIENTS.
    pub report_recipients: Vec<String>,
    /// ACCOUNTS_TELEMETRY_ENABLED.
    pub telemetry_enabled: bool,
    /// ACCOUNTS_TELEMETRY_TABLE_KEY (missing = telemetry silently disabled).
    pub telemetry_table_key: Option<SecretString>,
    /// ACCOUNTS_WORKER_ENABLED.
    pub worker_enabled: bool,
    /// ACCOUNTS_WEBHOOK_ALLOW_PRIVATE (allow http and private/loopback webhook targets).
    pub webhook_allow_private: bool,
    /// ACCOUNTS_FEDERATION_ALLOW_LOOPBACK (tests and local runs only): lets a trusted OIDC
    /// issuer live on a loopback address over http, so a mock issuer can stand in for GitHub.
    /// Private, link-local and other addresses stay refused. Never true in production.
    pub federation_allow_loopback: bool,
    /// ACCOUNTS_LOG_FILTER.
    pub log_filter: String,
    /// ACCOUNTS_OTP_TTL_SECONDS (contract: 600).
    pub otp_ttl_seconds: i64,
    /// ACCOUNTS_OTP_LOCK_SECONDS — cooldown after 10 wrong codes (contract: 60; tests may shorten
    /// it outside production).
    pub otp_lock_seconds: i64,
    /// ACCOUNTS_ACCESS_TOKEN_TTL_SECONDS (contract: 1800).
    pub access_token_ttl_seconds: i64,
}

/// One configuration problem.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigProblem {
    pub var: String,
    pub message: String,
}

/// Every configuration problem found, reported together.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigError {
    pub problems: Vec<ConfigProblem>,
}

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        writeln!(
            f,
            "Silicon Accounts can't start: {} configuration problem(s):",
            self.problems.len()
        )?;
        for p in &self.problems {
            writeln!(f, "  - {}: {}", p.var, p.message)?;
        }
        Ok(())
    }
}

impl std::error::Error for ConfigError {}

struct Reader<'a> {
    lookup: &'a dyn Fn(&str) -> Option<String>,
    problems: Vec<ConfigProblem>,
}

impl Reader<'_> {
    fn raw(&self, var: &str) -> Option<String> {
        (self.lookup)(var)
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
    }

    fn problem(&mut self, var: &str, message: impl Into<String>) {
        self.problems.push(ConfigProblem {
            var: var.to_string(),
            message: message.into(),
        });
    }

    fn string(&self, var: &str, default: &str) -> String {
        self.raw(var).unwrap_or_else(|| default.to_string())
    }

    fn opt(&self, var: &str) -> Option<String> {
        self.raw(var)
    }

    fn secret(&self, var: &str) -> Option<SecretString> {
        self.raw(var).map(SecretString::from)
    }

    fn bool(&mut self, var: &str, default: bool) -> bool {
        match self.raw(var) {
            None => default,
            Some(v) => match v.to_ascii_lowercase().as_str() {
                "true" | "1" | "yes" | "on" => true,
                "false" | "0" | "no" | "off" => false,
                _ => {
                    self.problem(var, format!("'{v}' is not a boolean; use true or false"));
                    default
                }
            },
        }
    }

    fn int(&mut self, var: &str, default: i64, min: i64, max: i64) -> i64 {
        match self.raw(var) {
            None => default,
            Some(v) => match v.parse::<i64>() {
                Ok(n) if (min..=max).contains(&n) => n,
                Ok(n) => {
                    self.problem(
                        var,
                        format!("{n} is out of range; use a whole number from {min} to {max}"),
                    );
                    default
                }
                Err(_) => {
                    self.problem(
                        var,
                        format!("'{v}' is not a whole number; use a number from {min} to {max}"),
                    );
                    default
                }
            },
        }
    }

    fn list(&self, var: &str, default: &str) -> Vec<String> {
        let raw = self.raw(var).unwrap_or_else(|| default.to_string());
        raw.split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect()
    }

    fn http_url(&mut self, var: &str, default: &str) -> String {
        let v = self.string(var, default);
        match Url::parse(&v) {
            Ok(u) if (u.scheme() == "http" || u.scheme() == "https") && u.host_str().is_some() => {
                v.trim_end_matches('/').to_string()
            }
            _ => {
                self.problem(
                    var,
                    format!("'{v}' is not an absolute http(s) URL like https://example.com"),
                );
                default.trim_end_matches('/').to_string()
            }
        }
    }
}

/// Returns `scheme://host[:port]` of an absolute http(s) URL (default ports omitted).
pub fn origin_of(url: &str) -> Option<String> {
    let u = Url::parse(url.trim()).ok()?;
    if u.scheme() != "http" && u.scheme() != "https" {
        return None;
    }
    let origin = u.origin();
    if !origin.is_tuple() {
        return None;
    }
    Some(origin.ascii_serialization())
}

/// Decodes a 32-byte key written as base64url (padding optional; standard base64 also accepted).
pub fn decode_key32(value: &str) -> Result<[u8; 32], String> {
    use base64::Engine as _;
    use base64::engine::general_purpose::{STANDARD, URL_SAFE, URL_SAFE_NO_PAD};
    let v = value.trim();
    let bytes = URL_SAFE_NO_PAD
        .decode(v)
        .or_else(|_| URL_SAFE.decode(v))
        .or_else(|_| STANDARD.decode(v))
        .map_err(|_| "is not base64url; generate one with `openssl rand -base64 32 | tr '+/' '-_' | tr -d '='`".to_string())?;
    <[u8; 32]>::try_from(bytes.as_slice()).map_err(|_| {
        format!(
            "decodes to {} bytes but must be exactly 32; generate one with `openssl rand -base64 32 | tr '+/' '-_' | tr -d '='`",
            bytes.len()
        )
    })
}

/// Parses ACCOUNTS_ENCRYPTION_KEYRING: `{"1":"<base64url 32 bytes>", "2": "..."}`.
pub fn parse_keyring(json: &str) -> Result<BTreeMap<u8, [u8; 32]>, String> {
    let map: BTreeMap<String, String> = serde_json::from_str(json).map_err(|e| {
        format!(
            "is not a JSON object of version → key, like {{\"1\":\"<base64url 32 bytes>\"}} ({e})"
        )
    })?;
    if map.is_empty() {
        return Err("has no keys; add at least {\"1\":\"<base64url 32 bytes>\"}".into());
    }
    let mut out = BTreeMap::new();
    for (version, key) in map {
        let v: u8 = version.parse().ok().filter(|v| *v >= 1).ok_or_else(|| {
            format!("has version '{version}', but versions must be numbers from 1 to 255")
        })?;
        let k = decode_key32(&key).map_err(|e| format!("key version {v} {e}"))?;
        out.insert(v, k);
    }
    Ok(out)
}

impl Settings {
    /// Built-in defaults for an environment (development defaults include the DEV ONLY secrets).
    pub fn defaults(environment: Environment) -> Settings {
        let prod = environment.is_production();
        Settings {
            environment,
            bind_addr: SocketAddr::from(([127, 0, 0, 1], 8589)),
            public_url: "http://localhost:8590".into(),
            public_origin: "http://localhost:8590".into(),
            extra_allowed_origins: Vec::new(),
            database_url: SecretString::from("postgres://postgres@127.0.0.1:5444/silicon_accounts"),
            database_max_connections: 32,
            web_dist: None,
            token_pepper: SecretString::from(DEV_TOKEN_PEPPER),
            encryption_keyring: SecretString::from(format!("{{\"1\":\"{DEV_ENCRYPTION_KEY}\"}}")),
            encryption_current_version: 1,
            jwt_private_key: SecretString::from(DEV_JWT_SEED),
            jwt_key_id: DEV_JWT_KEY_ID.into(),
            cookie_secure: prod,
            delivery: DeliveryMode::Local,
            postmark: PostmarkSettings {
                server_token: None,
                from: "accounts@teamofsilicons.com".into(),
                api_url: "https://api.postmarkapp.com".into(),
            },
            twilio: TwilioSettings {
                account_sid: None,
                auth_token: None,
                messaging_service_sid: None,
                from: None,
                api_url: "https://api.twilio.com".into(),
            },
            expose_dev_outbox: false,
            google: GoogleSettings {
                client_id: None,
                client_secret: None,
                auth_url: "https://accounts.google.com/o/oauth2/v2/auth".into(),
                token_url: "https://oauth2.googleapis.com/token".into(),
                jwks_url: "https://www.googleapis.com/oauth2/v3/certs".into(),
                issuers: vec![
                    "https://accounts.google.com".into(),
                    "accounts.google.com".into(),
                ],
            },
            apple: AppleSettings {
                services_id: None,
                team_id: None,
                key_id: None,
                private_key: None,
                auth_url: "https://appleid.apple.com/auth/authorize".into(),
                token_url: "https://appleid.apple.com/auth/token".into(),
                jwks_url: "https://appleid.apple.com/auth/keys".into(),
                issuer: "https://appleid.apple.com".into(),
            },
            iris_base_url: "https://iris.teamofsilicons.com".into(),
            ip_timezone_headers: vec![
                "cloudfront-viewer-time-zone".into(),
                "x-vercel-ip-timezone".into(),
            ],
            trust_forwarded_for: false,
            silicon_apps_url: "https://apps.teamofsilicons.com".into(),
            docs_url: DEFAULT_DOCS_URL.into(),
            developer_url: if prod {
                DEFAULT_DEVELOPER_URL
            } else {
                DEV_DEVELOPER_URL
            }
            .into(),
            developer_origin: if prod {
                DEFAULT_DEVELOPER_URL
            } else {
                DEV_DEVELOPER_URL
            }
            .into(),
            internal_token: None,
            report_recipients: vec![
                "saketdev12@gmail.com".into(),
                "shubhastro2@gmail.com".into(),
                "bugs@teamofsilicons.com".into(),
            ],
            telemetry_enabled: true,
            telemetry_table_key: None,
            worker_enabled: true,
            webhook_allow_private: !prod,
            federation_allow_loopback: false,
            log_filter: "info,accounts=debug".into(),
            otp_ttl_seconds: CONTRACT_OTP_TTL_SECONDS,
            otp_lock_seconds: CONTRACT_OTP_LOCK_SECONDS,
            access_token_ttl_seconds: CONTRACT_ACCESS_TOKEN_TTL_SECONDS,
        }
    }

    /// Settings for tests: environment `test`, local delivery, dev keys, dev outbox exposed,
    /// worker disabled, telemetry off. Override fields as needed.
    pub fn for_tests() -> Settings {
        let mut s = Settings::defaults(Environment::Test);
        s.expose_dev_outbox = true;
        s.worker_enabled = false;
        s.telemetry_enabled = false;
        s.log_filter = "warn".into();
        s
    }

    /// Reads the process environment. Loads `.env` (current directory or a parent) first unless
    /// the process environment already says ACCOUNTS_ENVIRONMENT=production.
    pub fn from_env() -> Result<Settings, ConfigError> {
        let env_says_production = std::env::var("ACCOUNTS_ENVIRONMENT")
            .ok()
            .and_then(|v| Environment::parse(&v))
            .is_some_and(|e| e.is_production());
        if !env_says_production {
            // A missing .env is normal; a malformed one is reported by the variables it breaks.
            let _ = dotenvy::dotenv();
        }
        Settings::from_lookup(|k| std::env::var(k).ok())
    }

    /// Builds settings from any variable lookup (tests pass a map).
    pub fn from_lookup(lookup: impl Fn(&str) -> Option<String>) -> Result<Settings, ConfigError> {
        let mut r = Reader {
            lookup: &lookup,
            problems: Vec::new(),
        };

        let environment = match r.raw("ACCOUNTS_ENVIRONMENT") {
            None => Environment::Development,
            Some(v) => match Environment::parse(&v) {
                Some(e) => e,
                None => {
                    r.problem(
                        "ACCOUNTS_ENVIRONMENT",
                        format!("'{v}' is not one of development, test, production"),
                    );
                    Environment::Development
                }
            },
        };
        let prod = environment.is_production();
        let mut s = Settings::defaults(environment);

        if let Some(v) = r.raw("ACCOUNTS_BIND_ADDR") {
            match v
                .parse::<SocketAddr>()
                .ok()
                .or_else(|| v.to_socket_addrs().ok().and_then(|mut a| a.next()))
            {
                Some(addr) => s.bind_addr = addr,
                None => r.problem(
                    "ACCOUNTS_BIND_ADDR",
                    format!("'{v}' is not a host:port address like 127.0.0.1:8589"),
                ),
            }
        }

        s.public_url = r.http_url("ACCOUNTS_PUBLIC_URL", "http://localhost:8590");
        s.public_origin = origin_of(&s.public_url).unwrap_or_else(|| s.public_url.clone());

        let mut extras = Vec::new();
        for o in r.list("ACCOUNTS_EXTRA_ALLOWED_ORIGINS", "") {
            match origin_of(&o) {
                Some(origin) => extras.push(origin),
                None => r.problem(
                    "ACCOUNTS_EXTRA_ALLOWED_ORIGINS",
                    format!("'{o}' is not an http(s) origin like http://localhost:5190"),
                ),
            }
        }
        s.extra_allowed_origins = extras;

        if let Some(v) = r.secret("ACCOUNTS_DATABASE_URL") {
            s.database_url = v;
        }
        s.database_max_connections = r.int("ACCOUNTS_DATABASE_MAX_CONNECTIONS", 32, 1, 1000) as u32;
        s.web_dist = r.opt("ACCOUNTS_WEB_DIST").map(PathBuf::from);

        // Secrets: dev defaults outside production; required (and never the dev values) in production.
        let pepper_given = r.raw("ACCOUNTS_TOKEN_PEPPER").is_some();
        match r.secret("ACCOUNTS_TOKEN_PEPPER") {
            Some(v) => s.token_pepper = v,
            None if prod => r.problem(
                "ACCOUNTS_TOKEN_PEPPER",
                "is required in production (base64url 32 bytes); generate one with `openssl rand -base64 32 | tr '+/' '-_' | tr -d '='`",
            ),
            None => {}
        }
        // Compared as decoded bytes: padded base64url and standard base64 spell the same key.
        match decode_key32(s.token_pepper.expose_secret()) {
            Err(e) => r.problem("ACCOUNTS_TOKEN_PEPPER", e),
            Ok(pepper)
                if prod
                    && pepper_given
                    && decode_key32(DEV_TOKEN_PEPPER).is_ok_and(|dev| dev == pepper) =>
            {
                r.problem(
                    "ACCOUNTS_TOKEN_PEPPER",
                    "is the DEV ONLY value from .env.example; generate a new secret for production",
                )
            }
            Ok(_) => {}
        }

        let keyring_given = r.raw("ACCOUNTS_ENCRYPTION_KEYRING").is_some();
        match r.secret("ACCOUNTS_ENCRYPTION_KEYRING") {
            Some(v) => s.encryption_keyring = v,
            None if prod => r.problem(
                "ACCOUNTS_ENCRYPTION_KEYRING",
                "is required in production, e.g. {\"1\":\"<base64url 32 bytes>\"}",
            ),
            None => {}
        }
        s.encryption_current_version =
            r.int("ACCOUNTS_ENCRYPTION_CURRENT_VERSION", 1, 1, 255) as u8;
        match parse_keyring(s.encryption_keyring.expose_secret()) {
            Ok(ring) => {
                if !ring.contains_key(&s.encryption_current_version) {
                    r.problem(
                        "ACCOUNTS_ENCRYPTION_CURRENT_VERSION",
                        format!(
                            "is {} but ACCOUNTS_ENCRYPTION_KEYRING has no key with that version (it has {})",
                            s.encryption_current_version,
                            ring.keys().map(|k| k.to_string()).collect::<Vec<_>>().join(", ")
                        ),
                    );
                }
                if prod
                    && keyring_given
                    && let Ok(dev) = decode_key32(DEV_ENCRYPTION_KEY)
                    && ring.values().any(|k| *k == dev)
                {
                    r.problem(
                        "ACCOUNTS_ENCRYPTION_KEYRING",
                        "contains the DEV ONLY key from .env.example; generate new keys for production",
                    );
                }
            }
            Err(e) => r.problem("ACCOUNTS_ENCRYPTION_KEYRING", e),
        }

        let jwt_given = r.raw("ACCOUNTS_JWT_PRIVATE_KEY").is_some();
        match r.secret("ACCOUNTS_JWT_PRIVATE_KEY") {
            Some(v) => s.jwt_private_key = v,
            None if prod => r.problem(
                "ACCOUNTS_JWT_PRIVATE_KEY",
                "is required in production: an Ed25519 private key as PKCS#8 PEM (`openssl genpkey -algorithm ed25519`) or a base64url 32-byte seed",
            ),
            None => {}
        }
        match crate::jwt::parse_private_key(s.jwt_private_key.expose_secret()) {
            Ok(key) => {
                if prod
                    && jwt_given
                    && let Ok(dev) = crate::jwt::parse_private_key(DEV_JWT_SEED)
                    && key.to_bytes() == dev.to_bytes()
                {
                    r.problem(
                        "ACCOUNTS_JWT_PRIVATE_KEY",
                        "is the DEV ONLY key from .env.example; generate a new key for production",
                    );
                }
            }
            Err(e) => r.problem("ACCOUNTS_JWT_PRIVATE_KEY", e),
        }
        s.jwt_key_id = r.string("ACCOUNTS_JWT_KEY_ID", DEV_JWT_KEY_ID);
        if s.jwt_key_id.len() > 64
            || !s
                .jwt_key_id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
        {
            r.problem(
                "ACCOUNTS_JWT_KEY_ID",
                "must be 1-64 characters of A-Z, a-z, 0-9, '-', '_' or '.'",
            );
        }

        s.cookie_secure = r.bool("ACCOUNTS_COOKIE_SECURE", prod);

        s.delivery = match r.raw("ACCOUNTS_DELIVERY") {
            None => DeliveryMode::Local,
            Some(v) => match v.to_ascii_lowercase().as_str() {
                "local" => DeliveryMode::Local,
                "providers" => DeliveryMode::Providers,
                _ => {
                    r.problem(
                        "ACCOUNTS_DELIVERY",
                        format!("'{v}' is not one of local, providers"),
                    );
                    DeliveryMode::Local
                }
            },
        };
        s.postmark.server_token = r.secret("ACCOUNTS_POSTMARK_SERVER_TOKEN");
        s.postmark.from = r.string("ACCOUNTS_POSTMARK_FROM", "accounts@teamofsilicons.com");
        s.postmark.api_url = r.http_url("ACCOUNTS_POSTMARK_API_URL", "https://api.postmarkapp.com");
        s.twilio.account_sid = r.opt("ACCOUNTS_TWILIO_ACCOUNT_SID");
        s.twilio.auth_token = r.secret("ACCOUNTS_TWILIO_AUTH_TOKEN");
        s.twilio.messaging_service_sid = r.opt("ACCOUNTS_TWILIO_MESSAGING_SERVICE_SID");
        s.twilio.from = r.opt("ACCOUNTS_TWILIO_FROM");
        s.twilio.api_url = r.http_url("ACCOUNTS_TWILIO_API_URL", "https://api.twilio.com");

        s.expose_dev_outbox = r.bool("ACCOUNTS_EXPOSE_DEV_OUTBOX", false);

        s.google.client_id = r.opt("ACCOUNTS_GOOGLE_CLIENT_ID");
        s.google.client_secret = r.secret("ACCOUNTS_GOOGLE_CLIENT_SECRET");
        s.google.auth_url = r.http_url(
            "ACCOUNTS_GOOGLE_AUTH_URL",
            "https://accounts.google.com/o/oauth2/v2/auth",
        );
        s.google.token_url = r.http_url(
            "ACCOUNTS_GOOGLE_TOKEN_URL",
            "https://oauth2.googleapis.com/token",
        );
        s.google.jwks_url = r.http_url(
            "ACCOUNTS_GOOGLE_JWKS_URL",
            "https://www.googleapis.com/oauth2/v3/certs",
        );
        s.google.issuers = r.list(
            "ACCOUNTS_GOOGLE_ISSUERS",
            "https://accounts.google.com,accounts.google.com",
        );
        if s.google.client_id.is_some() != s.google.client_secret.is_some() {
            r.problem(
                "ACCOUNTS_GOOGLE_CLIENT_SECRET",
                "managed Google needs both ACCOUNTS_GOOGLE_CLIENT_ID and ACCOUNTS_GOOGLE_CLIENT_SECRET (set both or neither)",
            );
        }

        s.apple.services_id = r.opt("ACCOUNTS_APPLE_SERVICES_ID");
        s.apple.team_id = r.opt("ACCOUNTS_APPLE_TEAM_ID");
        s.apple.key_id = r.opt("ACCOUNTS_APPLE_KEY_ID");
        s.apple.private_key = r
            .raw("ACCOUNTS_APPLE_PRIVATE_KEY")
            .map(|v| SecretString::from(v.replace("\\n", "\n")));
        s.apple.auth_url = r.http_url(
            "ACCOUNTS_APPLE_AUTH_URL",
            "https://appleid.apple.com/auth/authorize",
        );
        s.apple.token_url = r.http_url(
            "ACCOUNTS_APPLE_TOKEN_URL",
            "https://appleid.apple.com/auth/token",
        );
        s.apple.jwks_url = r.http_url(
            "ACCOUNTS_APPLE_JWKS_URL",
            "https://appleid.apple.com/auth/keys",
        );
        s.apple.issuer = r.string("ACCOUNTS_APPLE_ISSUER", "https://appleid.apple.com");
        let apple_parts = [
            s.apple.services_id.is_some(),
            s.apple.team_id.is_some(),
            s.apple.key_id.is_some(),
            s.apple.private_key.is_some(),
        ];
        if apple_parts.iter().any(|p| *p) && !apple_parts.iter().all(|p| *p) {
            r.problem(
                "ACCOUNTS_APPLE_SERVICES_ID",
                "managed Apple needs all four of ACCOUNTS_APPLE_SERVICES_ID, _TEAM_ID, _KEY_ID and _PRIVATE_KEY (set all or none)",
            );
        }

        s.iris_base_url = r.http_url("ACCOUNTS_IRIS_BASE_URL", "https://iris.teamofsilicons.com");
        s.ip_timezone_headers = r
            .list(
                "ACCOUNTS_IP_TIMEZONE_HEADERS",
                "cloudfront-viewer-time-zone,x-vercel-ip-timezone",
            )
            .into_iter()
            .map(|h| h.to_ascii_lowercase())
            .collect();
        s.trust_forwarded_for = r.bool("ACCOUNTS_TRUST_FORWARDED_FOR", false);
        s.silicon_apps_url = r.http_url(
            "ACCOUNTS_SILICON_APPS_URL",
            "https://apps.teamofsilicons.com",
        );
        s.docs_url = r.http_url("ACCOUNTS_DOCS_URL", DEFAULT_DOCS_URL);
        let developer_default = if prod {
            DEFAULT_DEVELOPER_URL
        } else {
            DEV_DEVELOPER_URL
        };
        s.developer_url = r.http_url("ACCOUNTS_DEVELOPER_URL", developer_default);
        s.developer_origin = origin_of(&s.developer_url).unwrap_or_else(|| s.developer_url.clone());
        s.internal_token = r.secret("ACCOUNTS_INTERNAL_TOKEN");
        if let Some(t) = &s.internal_token
            && t.expose_secret().len() < 32
        {
            r.problem(
                "ACCOUNTS_INTERNAL_TOKEN",
                "must be at least 32 characters so it can't be guessed",
            );
        }
        s.report_recipients = r.list(
            "ACCOUNTS_REPORT_RECIPIENTS",
            "saketdev12@gmail.com,shubhastro2@gmail.com,bugs@teamofsilicons.com",
        );
        for rcpt in s.report_recipients.clone() {
            if crate::normalize::normalize_email(&rcpt).is_err() {
                r.problem(
                    "ACCOUNTS_REPORT_RECIPIENTS",
                    format!("'{rcpt}' is not a valid email address"),
                );
            }
        }
        s.telemetry_enabled = r.bool("ACCOUNTS_TELEMETRY_ENABLED", true);
        s.telemetry_table_key = r.secret("ACCOUNTS_TELEMETRY_TABLE_KEY");
        s.worker_enabled = r.bool("ACCOUNTS_WORKER_ENABLED", true);
        s.webhook_allow_private = r.bool("ACCOUNTS_WEBHOOK_ALLOW_PRIVATE", !prod);
        s.federation_allow_loopback = r.bool("ACCOUNTS_FEDERATION_ALLOW_LOOPBACK", false);
        s.log_filter = r.string("ACCOUNTS_LOG_FILTER", "info,accounts=debug");
        s.otp_ttl_seconds = r.int(
            "ACCOUNTS_OTP_TTL_SECONDS",
            CONTRACT_OTP_TTL_SECONDS,
            30,
            86_400,
        );
        s.otp_lock_seconds = r.int(
            "ACCOUNTS_OTP_LOCK_SECONDS",
            CONTRACT_OTP_LOCK_SECONDS,
            1,
            3_600,
        );
        s.access_token_ttl_seconds = r.int(
            "ACCOUNTS_ACCESS_TOKEN_TTL_SECONDS",
            CONTRACT_ACCESS_TOKEN_TTL_SECONDS,
            60,
            86_400,
        );

        if prod {
            if s.delivery == DeliveryMode::Local {
                r.problem(
                    "ACCOUNTS_DELIVERY",
                    "is 'local' (codes are never sent); production must use ACCOUNTS_DELIVERY=providers",
                );
            }
            if s.delivery == DeliveryMode::Providers && s.postmark.server_token.is_none() {
                r.problem(
                    "ACCOUNTS_POSTMARK_SERVER_TOKEN",
                    "is required in production: email codes are sent through Postmark",
                );
            }
            if s.expose_dev_outbox {
                r.problem(
                    "ACCOUNTS_EXPOSE_DEV_OUTBOX",
                    "must be false in production: it would expose sign-in codes",
                );
            }
            if s.webhook_allow_private {
                r.problem(
                    "ACCOUNTS_WEBHOOK_ALLOW_PRIVATE",
                    "must be false in production: it turns off the SSRF guard, so anyone who can set a webhook URL could make the service call private, loopback and cloud-metadata addresses",
                );
            }
            if s.federation_allow_loopback {
                r.problem(
                    "ACCOUNTS_FEDERATION_ALLOW_LOOPBACK",
                    "must be false in production: it lets a trusted OIDC issuer live on a loopback address over http, which only a test's mock issuer needs",
                );
            }
            if !s.public_url.starts_with("https://") {
                r.problem(
                    "ACCOUNTS_PUBLIC_URL",
                    format!(
                        "is '{}' but production must be served over https",
                        s.public_url
                    ),
                );
            }
            if !s.developer_url.starts_with("https://") {
                r.problem(
                    "ACCOUNTS_DEVELOPER_URL",
                    format!(
                        "is '{}' but production must send developer sign-ins to an https site (its tokens travel on that redirect)",
                        s.developer_url
                    ),
                );
            }
            if !s.cookie_secure {
                r.problem(
                    "ACCOUNTS_COOKIE_SECURE",
                    "must be true in production so session cookies never travel over http",
                );
            }
            if s.otp_ttl_seconds != CONTRACT_OTP_TTL_SECONDS {
                r.problem(
                    "ACCOUNTS_OTP_TTL_SECONDS",
                    format!("must be the contract value {CONTRACT_OTP_TTL_SECONDS} in production"),
                );
            }
            if s.otp_lock_seconds != CONTRACT_OTP_LOCK_SECONDS {
                r.problem(
                    "ACCOUNTS_OTP_LOCK_SECONDS",
                    format!("must be the contract value {CONTRACT_OTP_LOCK_SECONDS} in production"),
                );
            }
            if s.access_token_ttl_seconds != CONTRACT_ACCESS_TOKEN_TTL_SECONDS {
                r.problem(
                    "ACCOUNTS_ACCESS_TOKEN_TTL_SECONDS",
                    format!("must be the contract value {CONTRACT_ACCESS_TOKEN_TTL_SECONDS} in production"),
                );
            }
        }

        if r.problems.is_empty() {
            Ok(s)
        } else {
            Err(ConfigError {
                problems: r.problems,
            })
        }
    }

    /// Token issuer (`iss`): the public URL.
    pub fn issuer(&self) -> &str {
        &self.public_url
    }

    /// Absolute URL on the public origin, e.g. `settings.url("/v1/photos/x")`.
    pub fn url(&self, path: &str) -> String {
        if path.starts_with('/') {
            format!("{}{}", self.public_url, path)
        } else {
            format!("{}/{}", self.public_url, path)
        }
    }

    /// The public origin plus ACCOUNTS_EXTRA_ALLOWED_ORIGINS.
    pub fn allowed_origins(&self) -> impl Iterator<Item = &str> {
        std::iter::once(self.public_origin.as_str())
            .chain(self.extra_allowed_origins.iter().map(String::as_str))
    }

    /// The only redirect URI of the first-party app `developer`:
    /// `{ACCOUNTS_DEVELOPER_URL}/auth/callback`.
    pub fn developer_callback_url(&self) -> String {
        format!("{}{DEVELOPER_CALLBACK_PATH}", self.developer_url)
    }

    /// True when `uri` is exactly the developer platform's callback (the redirect rule of the
    /// first-party app `developer`; surrounding whitespace is ignored, nothing else is).
    pub fn developer_redirect_allowed(&self, uri: &str) -> bool {
        uri.trim() == self.developer_callback_url()
    }

    /// True when `origin` (an Origin header value) is the site or an extra allowed origin.
    pub fn is_allowed_origin(&self, origin: &str) -> bool {
        let o = origin.trim().trim_end_matches('/');
        self.allowed_origins().any(|a| a.eq_ignore_ascii_case(o))
    }

    /// True when outbound email can be sent (Postmark configured and delivery = providers).
    pub fn email_delivery_configured(&self) -> bool {
        self.delivery == DeliveryMode::Local || self.postmark.server_token.is_some()
    }

    /// True when SMS can be sent (Twilio configured, or local delivery that never sends).
    pub fn sms_delivery_configured(&self) -> bool {
        self.delivery == DeliveryMode::Local || self.twilio.configured()
    }

    /// True when the dev outbox endpoint may be served.
    pub fn dev_outbox_enabled(&self) -> bool {
        self.expose_dev_outbox && !self.environment.is_production()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn lookup(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        move |k| map.get(k).cloned()
    }

    #[test]
    fn development_defaults_work_out_of_the_box() {
        let s = Settings::from_lookup(lookup(&[])).expect("defaults are valid");
        assert_eq!(s.environment, Environment::Development);
        // The API listens on 8589 behind the account site, which serves the public 8590.
        assert_eq!(s.bind_addr, SocketAddr::from(([127, 0, 0, 1], 8589)));
        assert_eq!(
            s.docs_url,
            "https://developers.teamofsilicons.com/docs/accounts"
        );
        assert_eq!(s.developer_url, "http://localhost:8600");
        assert_eq!(
            s.developer_callback_url(),
            "http://localhost:8600/auth/callback"
        );
        assert_eq!(s.public_url, "http://localhost:8590");
        assert_eq!(s.public_origin, "http://localhost:8590");
        assert!(!s.cookie_secure);
        assert!(s.webhook_allow_private);
        assert_eq!(s.delivery, DeliveryMode::Local);
        assert_eq!(s.report_recipients.len(), 3);
        assert!(s.is_allowed_origin("http://localhost:8590"));
        assert!(!s.is_allowed_origin("http://localhost:5190"));
    }

    #[test]
    fn parses_values_and_reports_every_problem() {
        let s = Settings::from_lookup(lookup(&[
            ("ACCOUNTS_PUBLIC_URL", "https://account.example.test/"),
            (
                "ACCOUNTS_EXTRA_ALLOWED_ORIGINS",
                "http://localhost:5190, http://127.0.0.1:5190/",
            ),
            ("ACCOUNTS_DELIVERY", "providers"),
            ("ACCOUNTS_IP_TIMEZONE_HEADERS", "X-Test-TZ"),
            ("ACCOUNTS_DOCS_URL", "https://docs.example.test/accounts/"),
            ("ACCOUNTS_DEVELOPER_URL", "http://localhost:8600/"),
        ]))
        .expect("valid");
        assert_eq!(s.docs_url, "https://docs.example.test/accounts");
        assert_eq!(s.developer_url, "http://localhost:8600");
        assert_eq!(s.developer_origin, "http://localhost:8600");
        assert!(s.developer_redirect_allowed("http://localhost:8600/auth/callback"));
        assert!(s.developer_redirect_allowed(" http://localhost:8600/auth/callback "));
        assert!(!s.developer_redirect_allowed("http://localhost:8600/auth/callback?x=1"));
        assert!(!s.developer_redirect_allowed("http://localhost:8601/auth/callback"));
        assert!(!s.developer_redirect_allowed("http://localhost:8600/"));
        assert!(
            !s.is_allowed_origin("http://localhost:8600"),
            "the developer platform is a server-side client: it never needs the cookie CSRF allowance"
        );
        assert_eq!(s.public_url, "https://account.example.test");
        assert_eq!(
            s.extra_allowed_origins,
            vec!["http://localhost:5190", "http://127.0.0.1:5190"]
        );
        assert!(s.is_allowed_origin("http://localhost:5190"));
        assert_eq!(s.ip_timezone_headers, vec!["x-test-tz"]);

        let err = Settings::from_lookup(lookup(&[
            ("ACCOUNTS_COOKIE_SECURE", "maybe"),
            ("ACCOUNTS_BIND_ADDR", "nope"),
            ("ACCOUNTS_TOKEN_PEPPER", "short"),
        ]))
        .expect_err("invalid");
        let vars: Vec<_> = err.problems.iter().map(|p| p.var.as_str()).collect();
        assert!(vars.contains(&"ACCOUNTS_COOKIE_SECURE"));
        assert!(vars.contains(&"ACCOUNTS_BIND_ADDR"));
        assert!(vars.contains(&"ACCOUNTS_TOKEN_PEPPER"));
        assert!(err.to_string().contains("ACCOUNTS_BIND_ADDR"));
    }

    #[test]
    fn production_refuses_dev_secrets_and_local_delivery() {
        let err = Settings::from_lookup(lookup(&[
            ("ACCOUNTS_ENVIRONMENT", "production"),
            ("ACCOUNTS_TOKEN_PEPPER", DEV_TOKEN_PEPPER),
            (
                "ACCOUNTS_ENCRYPTION_KEYRING",
                &format!("{{\"1\":\"{DEV_ENCRYPTION_KEY}\"}}"),
            ),
            ("ACCOUNTS_JWT_PRIVATE_KEY", DEV_JWT_SEED),
            ("ACCOUNTS_EXPOSE_DEV_OUTBOX", "true"),
            ("ACCOUNTS_WEBHOOK_ALLOW_PRIVATE", "true"),
            ("ACCOUNTS_DEVELOPER_URL", "http://localhost:8600"),
        ]))
        .expect_err("must refuse");
        let vars: Vec<_> = err.problems.iter().map(|p| p.var.as_str()).collect();
        for v in [
            "ACCOUNTS_TOKEN_PEPPER",
            "ACCOUNTS_ENCRYPTION_KEYRING",
            "ACCOUNTS_JWT_PRIVATE_KEY",
            "ACCOUNTS_DELIVERY",
            "ACCOUNTS_EXPOSE_DEV_OUTBOX",
            "ACCOUNTS_PUBLIC_URL",
            "ACCOUNTS_WEBHOOK_ALLOW_PRIVATE",
            "ACCOUNTS_DEVELOPER_URL",
        ] {
            assert!(vars.contains(&v), "expected a problem for {v}: {err}");
        }

        let missing = Settings::from_lookup(lookup(&[("ACCOUNTS_ENVIRONMENT", "production")]))
            .expect_err("refuse");
        let vars: Vec<_> = missing.problems.iter().map(|p| p.var.as_str()).collect();
        assert!(vars.contains(&"ACCOUNTS_TOKEN_PEPPER"));
        assert!(vars.contains(&"ACCOUNTS_ENCRYPTION_KEYRING"));
        assert!(vars.contains(&"ACCOUNTS_JWT_PRIVATE_KEY"));
    }

    #[test]
    fn production_refuses_every_spelling_of_the_dev_pepper() {
        let padded = format!("{DEV_TOKEN_PEPPER}=");
        let standard = padded.replace('-', "+").replace('_', "/");
        assert_ne!(standard, padded, "the dev pepper has - or _ to respell");
        for spelling in [
            padded.as_str(),
            standard.as_str(),
            &format!(" {DEV_TOKEN_PEPPER} "),
        ] {
            assert_eq!(
                decode_key32(spelling).ok(),
                decode_key32(DEV_TOKEN_PEPPER).ok(),
                "{spelling} is the same key"
            );
            let err = Settings::from_lookup(lookup(&[
                ("ACCOUNTS_ENVIRONMENT", "production"),
                ("ACCOUNTS_TOKEN_PEPPER", spelling),
            ]))
            .expect_err("must refuse");
            assert!(
                err.problems
                    .iter()
                    .any(|p| p.var == "ACCOUNTS_TOKEN_PEPPER" && p.message.contains("DEV ONLY")),
                "{spelling}: {err}"
            );
        }
    }

    #[test]
    fn production_accepts_real_secrets() {
        let s = Settings::from_lookup(lookup(&[
            ("ACCOUNTS_ENVIRONMENT", "production"),
            ("ACCOUNTS_PUBLIC_URL", "https://accounts.teamofsilicons.com"),
            (
                "ACCOUNTS_TOKEN_PEPPER",
                "ZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXp7fH1-f4CBgoM",
            ),
            (
                "ACCOUNTS_ENCRYPTION_KEYRING",
                "{\"2\":\"yMnKy8zNzs_Q0dLT1NXW19jZ2tvc3d7f4OHi4-Tl5uc\"}",
            ),
            ("ACCOUNTS_ENCRYPTION_CURRENT_VERSION", "2"),
            (
                "ACCOUNTS_JWT_PRIVATE_KEY",
                "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
            ),
            ("ACCOUNTS_DELIVERY", "providers"),
            ("ACCOUNTS_POSTMARK_SERVER_TOKEN", "pm-token"),
        ]))
        .expect("valid production settings");
        assert_eq!(s.developer_url, "https://developers.teamofsilicons.com");
        assert!(s.cookie_secure);
        assert!(!s.webhook_allow_private);
        assert_eq!(s.encryption_current_version, 2);
    }

    #[test]
    fn production_refuses_loopback_federation_issuers() {
        let err = Settings::from_lookup(lookup(&[
            ("ACCOUNTS_ENVIRONMENT", "production"),
            ("ACCOUNTS_PUBLIC_URL", "https://accounts.teamofsilicons.com"),
            (
                "ACCOUNTS_TOKEN_PEPPER",
                "ZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXp7fH1-f4CBgoM",
            ),
            (
                "ACCOUNTS_ENCRYPTION_KEYRING",
                "{\"2\":\"yMnKy8zNzs_Q0dLT1NXW19jZ2tvc3d7f4OHi4-Tl5uc\"}",
            ),
            ("ACCOUNTS_ENCRYPTION_CURRENT_VERSION", "2"),
            (
                "ACCOUNTS_JWT_PRIVATE_KEY",
                "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
            ),
            ("ACCOUNTS_DELIVERY", "providers"),
            ("ACCOUNTS_POSTMARK_SERVER_TOKEN", "pm-token"),
            ("ACCOUNTS_FEDERATION_ALLOW_LOOPBACK", "true"),
        ]))
        .expect_err("must refuse");
        let vars: Vec<_> = err.problems.iter().map(|p| p.var.as_str()).collect();
        assert_eq!(vars, vec!["ACCOUNTS_FEDERATION_ALLOW_LOOPBACK"], "{err}");
        assert!(!Settings::for_tests().federation_allow_loopback);
    }

    #[test]
    fn keyring_and_key_parsing_messages_are_precise() {
        assert!(parse_keyring("{}").expect_err("empty").contains("no keys"));
        assert!(
            parse_keyring("{\"0\":\"x\"}")
                .expect_err("version 0")
                .contains("versions must be numbers")
        );
        assert!(
            decode_key32("AAEC")
                .expect_err("short")
                .contains("exactly 32")
        );
        assert!(decode_key32(DEV_TOKEN_PEPPER).is_ok());
    }

    #[test]
    fn env_example_is_valid_and_complete() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.env.example");
        let mut map = HashMap::new();
        for item in dotenvy::from_path_iter(&path).expect("read .env.example") {
            let (k, v) = item.expect("valid .env.example line");
            map.insert(k, v);
        }
        for var in VARIABLES {
            assert!(map.contains_key(*var), "{var} is missing from .env.example");
        }
        for key in map.keys() {
            assert!(
                VARIABLES.contains(&key.as_str()),
                "{key} in .env.example is not a known variable"
            );
        }
        let s = Settings::from_lookup(|k| map.get(k).cloned()).expect(".env.example parses");
        assert_eq!(s.environment, Environment::Development);
        assert_eq!(s.token_pepper.expose_secret(), DEV_TOKEN_PEPPER);
        assert_eq!(s.extra_allowed_origins, vec!["http://127.0.0.1:8590"]);
        assert_eq!(s.bind_addr.port(), 8589);
        assert!(s.dev_outbox_enabled());
    }
}
