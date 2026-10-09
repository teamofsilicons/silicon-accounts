//! Workload identity federation (trusted publishing): a Silicon signs in with an OpenID Connect
//! token from an outside issuer it is trusted for, such as a GitHub Actions or GitLab CI job,
//! so the job holds no stored secret.
//!
//! **Trusts.** The Silicon or its custodian registers trust relationships
//! (`silicon_federations`): an `issuer` (an https OpenID Connect issuer with discovery), the
//! `audience` the token must carry (default: our public URL) and `conditions`, claims the token
//! must carry with exactly these values. A trust always has at least one condition, so a whole
//! issuer is never trusted; for GitHub and GitLab one condition must name the repository, the
//! project or their owner, so a trust never covers every repository on the platform.
//!
//! **The exchange** (`POST /v1/oauth/token`, RFC 8693 token exchange, see [`sign_in`]): the
//! token's issuer must be one the Silicon trusts; its signature is checked against the issuer's
//! JWKS (found through discovery, cached for [`JWKS_CACHE_SECONDS`] and fetched again when a
//! token names an unknown `kid`, at most every [`JWKS_REFETCH_SECONDS`]); `exp`, `nbf` and
//! `iat` with [`LEEWAY_SECONDS`] of clock skew; the audience and every condition of one trust;
//! and a `jti` works once. The sign-in is a first-party session with origin `federated`,
//! recorded with method `federated`, that ends when the outside token expires: at least one
//! access token (30 minutes) later and at most [`MAX_SESSION_SECONDS`] later, with refresh tokens
//! rotating as usual inside that window. Removing the trust ends it.
//!
//! **Signing into apps from it.** A short-lived token the sign-in mints (`POST
//! /v1/me/short-lived-tokens`) records the sign-in's end and trust ([`session_bound`]); the app
//! sign-in it starts ends no later than this one (its token family expires at the same moment
//! at the latest), is refused once the trust is removed, and is linked to the trust in
//! `silicon_federation_sessions`, so removing the trust ends it as well.
//!
//! **Fetching** discovery and keys goes through its own HTTP client: https only, no proxy, no
//! redirects, 5 s to connect and 10 s in all, at most [`MAX_DOCUMENT_BYTES`] per document, and
//! a DNS resolver that refuses any host with an address that isn't public (private, loopback,
//! link-local, cloud metadata). Because the connector uses exactly the addresses it returns,
//! DNS rebinding can't slip between the check and the request. ACCOUNTS_FEDERATION_ALLOW_LOOPBACK
//! (tests and local runs, refused in production) also lets an issuer live on a loopback address
//! over http, for a mock issuer; private and link-local addresses stay refused even then.

use std::collections::{BTreeMap, HashMap};
use std::net::IpAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine as _;
use jsonwebtoken::{Algorithm, DecodingKey, Validation};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use sqlx::PgConnection;
use time::OffsetDateTime;
use url::Url;
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};
use crate::http::{AccountAuth, AuthVia, ClientMeta};
use crate::models::{Account, AccountKind, AccountStatus, Scope, TokenOrigin};
use crate::normalize::is_public_ip;
use crate::repo::audit::{self, SigninRecord};
use crate::repo::{accounts, rate_limit, tokens};
use crate::state::AppState;
use crate::timefmt::format_rfc3339_ms;
use crate::views::TokenExchangeResponse;

/// GitHub Actions' issuer.
pub const GITHUB_ACTIONS_ISSUER: &str = "https://token.actions.githubusercontent.com";
/// GitLab.com's issuer (self-managed GitLab uses its own URL).
pub const GITLAB_ISSUER: &str = "https://gitlab.com";
/// `subject_token_type` values the exchange accepts.
pub const TOKEN_TYPE_JWT: &str = "urn:ietf:params:oauth:token-type:jwt";
pub const TOKEN_TYPE_ID_TOKEN: &str = "urn:ietf:params:oauth:token-type:id_token";
/// The token-exchange grant (RFC 8693).
pub const TOKEN_EXCHANGE_GRANT_TYPE: &str = "urn:ietf:params:oauth:grant-type:token-exchange";

/// Live trusts one Silicon may have.
pub const MAX_FEDERATIONS_PER_SILICON: i64 = 20;
/// Conditions one trust may have.
pub const MAX_CONDITIONS: usize = 10;
/// Longest claim name and value of a condition.
pub const MAX_CLAIM_NAME_CHARS: usize = 100;
pub const MAX_CLAIM_VALUE_CHARS: usize = 500;
/// Longest issuer and audience.
pub const MAX_ISSUER_CHARS: usize = 300;
pub const MAX_AUDIENCE_CHARS: usize = 400;
/// Longest trust name.
pub const MAX_NAME_CHARS: usize = 100;
/// Clock skew allowed on `exp`, `nbf` and `iat`.
pub const LEEWAY_SECONDS: i64 = 30;
/// Largest outside token accepted.
pub const MAX_TOKEN_BYTES: usize = 16 * 1024;
/// Largest discovery document or JWKS read.
pub const MAX_DOCUMENT_BYTES: usize = 256 * 1024;
/// How long an issuer's keys are kept.
pub const JWKS_CACHE_SECONDS: u64 = 600;
/// A token naming an unknown key makes us fetch the keys again, at most this often per issuer.
pub const JWKS_REFETCH_SECONDS: u64 = 30;
/// The longest a sign-in from an outside token lasts, however long that token lives.
pub const MAX_SESSION_SECONDS: i64 = 12 * 3600;
/// Exchanges per minute from one address.
pub const EXCHANGES_PER_IP: rate_limit::Limit = rate_limit::Limit::new(60, 60);
/// Algorithms an outside token may be signed with (never `none` or a shared-secret HMAC).
pub const ALGORITHMS: &[&str] = &[
    "RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "EdDSA",
];
/// Claims that can't be conditions: the issuer and audience have their own fields, and the
/// times and token id change with every token.
pub const RESERVED_CLAIMS: &[&str] = &["iss", "aud", "exp", "nbf", "iat", "jti"];

/// The claims of which a GitHub Actions trust must name at least one.
pub const GITHUB_SCOPING_CLAIMS: &[&str] = &[
    "sub",
    "repository",
    "repository_id",
    "repository_owner",
    "repository_owner_id",
    "job_workflow_ref",
];
/// The claims of which a GitLab trust must name at least one.
pub const GITLAB_SCOPING_CLAIMS: &[&str] = &[
    "sub",
    "project_path",
    "project_id",
    "namespace_path",
    "namespace_id",
];

// ---- trusts ---------------------------------------------------------------------------------

/// One trust relationship.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct Federation {
    pub id: Uuid,
    pub silicon_uuid: String,
    pub name: String,
    pub issuer: String,
    pub audience: String,
    pub conditions: sqlx::types::Json<BTreeMap<String, String>>,
    pub created_by: String,
    pub created_at: OffsetDateTime,
    pub last_used_at: Option<OffsetDateTime>,
    pub revoked_at: Option<OffsetDateTime>,
}

/// The columns of [`Federation`].
pub const FEDERATION_COLUMNS: &str = "id, silicon_uuid, name, issuer, audience, conditions, created_by, created_at, last_used_at, revoked_at";

impl Federation {
    /// The trust as the API shows it.
    pub fn view(&self) -> Value {
        json!({
            "id": self.id,
            "name": self.name,
            "issuer": self.issuer,
            "audience": self.audience,
            "conditions": self.conditions.0,
            "created_by": self.created_by,
            "created_at": format_rfc3339_ms(self.created_at),
            "last_used_at": self.last_used_at.map(format_rfc3339_ms),
            "revoked_at": self.revoked_at.map(format_rfc3339_ms),
        })
    }
}

/// A trust to register, as sent.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NewFederation {
    pub issuer: String,
    #[serde(default)]
    pub audience: Option<String>,
    #[serde(default)]
    pub conditions: BTreeMap<String, Value>,
    #[serde(default)]
    pub name: Option<String>,
}

/// A trust that passed [`validate`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidFederation {
    pub issuer: String,
    pub audience: String,
    pub conditions: BTreeMap<String, String>,
    pub name: String,
}

/// The issuer without a trailing `/` (tokens and discovery documents are compared this way).
pub fn normalize_issuer(issuer: &str) -> String {
    issuer.trim().trim_end_matches('/').to_string()
}

/// The audience a trust has when none is given: this deployment's public URL
/// (`https://accounts.teamofsilicons.com` in production).
pub fn default_audience(settings: &crate::Settings) -> String {
    settings.issuer().trim_end_matches('/').to_string()
}

/// A readable default name for a trust of `issuer`.
fn default_name(issuer: &str) -> String {
    match issuer {
        GITHUB_ACTIONS_ISSUER => "GitHub Actions".into(),
        GITLAB_ISSUER => "GitLab CI".into(),
        other => Url::parse(other)
            .ok()
            .and_then(|u| u.host_str().map(str::to_string))
            .unwrap_or_else(|| "OIDC issuer".into()),
    }
}

/// Checks a trust to register, every problem at once (field paths for a 422).
pub fn validate(
    input: &NewFederation,
    settings: &crate::Settings,
) -> Result<ValidFederation, crate::FieldErrors> {
    let mut f = crate::FieldErrors::new();
    let issuer = normalize_issuer(&input.issuer);
    if let Err(why) = check_url(&issuer, settings.federation_allow_loopback, "issuer") {
        f.add("issuer", why);
    } else if issuer.chars().count() > MAX_ISSUER_CHARS {
        f.add("issuer", format!("at most {MAX_ISSUER_CHARS} characters"));
    }
    let audience = input
        .audience
        .as_deref()
        .map(str::trim)
        .filter(|a| !a.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| default_audience(settings));
    if audience.chars().count() > MAX_AUDIENCE_CHARS {
        f.add(
            "audience",
            format!("at most {MAX_AUDIENCE_CHARS} characters"),
        );
    } else if !audience.bytes().all(|b| b.is_ascii_graphic()) {
        f.add(
            "audience",
            "printable ASCII without spaces (the exact aud value your CI asks for)",
        );
    }
    let mut conditions = BTreeMap::new();
    if input.conditions.is_empty() {
        f.add(
            "conditions",
            "at least one condition is required, such as {\"repository\": \"owner/repo\"}: without one every token of the issuer would sign the Silicon in",
        );
    }
    if input.conditions.len() > MAX_CONDITIONS {
        f.add(
            "conditions",
            format!(
                "at most {MAX_CONDITIONS} conditions, got {}",
                input.conditions.len()
            ),
        );
    }
    for (name, value) in &input.conditions {
        let path = format!("conditions.{name}");
        let claim = name.trim();
        if claim.is_empty()
            || claim.chars().count() > MAX_CLAIM_NAME_CHARS
            || !claim
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | ':' | '/'))
        {
            f.add(
                &path,
                format!(
                    "a claim name is 1 to {MAX_CLAIM_NAME_CHARS} characters of a-z, A-Z, 0-9, '_', '-', '.', ':' and '/'"
                ),
            );
            continue;
        }
        if RESERVED_CLAIMS.contains(&claim) {
            f.add(
                &path,
                format!(
                    "'{claim}' can't be a condition: the issuer and audience have their own fields, and exp, nbf, iat and jti change with every token"
                ),
            );
            continue;
        }
        let value = match value {
            Value::String(s) => s.clone(),
            Value::Bool(b) => b.to_string(),
            Value::Number(n) => n.to_string(),
            _ => {
                f.add(
                    &path,
                    "a condition's value is one string (the claim must equal it exactly)",
                );
                continue;
            }
        };
        if value.is_empty() || value.chars().count() > MAX_CLAIM_VALUE_CHARS {
            f.add(
                &path,
                format!("a condition's value is 1 to {MAX_CLAIM_VALUE_CHARS} characters"),
            );
            continue;
        }
        if value.contains('*') && value.trim_matches('*').is_empty() {
            f.add(
                &path,
                "a condition matches exactly; '*' is not a wildcard, so it would match nothing",
            );
            continue;
        }
        conditions.insert(claim.to_string(), value);
    }
    let scoping = match issuer.as_str() {
        GITHUB_ACTIONS_ISSUER => Some(("GitHub Actions", GITHUB_SCOPING_CLAIMS)),
        GITLAB_ISSUER => Some(("GitLab", GITLAB_SCOPING_CLAIMS)),
        _ => None,
    };
    if let Some((platform, claims)) = scoping
        && !conditions.is_empty()
        && !conditions.keys().any(|k| claims.contains(&k.as_str()))
    {
        f.add(
            "conditions",
            format!(
                "every {platform} job can get a token from this issuer, so one condition must name the repository, the project or their owner: one of {}",
                claims.join(", ")
            ),
        );
    }
    let name: String = input
        .name
        .as_deref()
        .map(|n| {
            n.split(|c: char| c.is_whitespace() || c.is_control())
                .filter(|p| !p.is_empty())
                .collect::<Vec<_>>()
                .join(" ")
        })
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| default_name(&issuer));
    if name.chars().count() > MAX_NAME_CHARS {
        f.add("name", format!("at most {MAX_NAME_CHARS} characters"));
    }
    if !f.is_empty() {
        return Err(f);
    }
    Ok(ValidFederation {
        issuer,
        audience,
        conditions,
        name,
    })
}

// ---- URLs and addresses ---------------------------------------------------------------------

fn is_loopback_name(host: &str) -> bool {
    let h = host.trim_end_matches('.').to_ascii_lowercase();
    h == "localhost" || h.ends_with(".localhost")
}

/// Checks an issuer or JWKS URL before anything is fetched: https (or, with `allow_loopback`,
/// http to a loopback host), no credentials, query or fragment, and no host that is plainly
/// local; a literal IP must be public. Host names are checked again after DNS resolution.
pub fn check_url(raw: &str, allow_loopback: bool, what: &str) -> Result<Url, String> {
    let u = Url::parse(raw)
        .map_err(|_| format!("'{raw}' is not an absolute URL like {GITHUB_ACTIONS_ISSUER}"))?;
    if !u.username().is_empty() || u.password().is_some() {
        return Err(format!("the {what} '{raw}' must not contain credentials"));
    }
    if u.query().is_some() || u.fragment().is_some() {
        return Err(format!(
            "the {what} '{raw}' must not have a query or #fragment"
        ));
    }
    let Some(host) = u.host() else {
        return Err(format!("the {what} '{raw}' has no host"));
    };
    let loopback = match &host {
        url::Host::Domain(d) => is_loopback_name(d),
        url::Host::Ipv4(ip) => ip.is_loopback(),
        url::Host::Ipv6(ip) => ip.is_loopback(),
    };
    if allow_loopback && loopback {
        return match u.scheme() {
            "https" | "http" => Ok(u),
            _ => Err(format!("the {what} '{raw}' must use https")),
        };
    }
    if u.scheme() != "https" {
        return Err(format!(
            "the {what} '{raw}' must use https: we only trust issuers whose keys come over TLS"
        ));
    }
    let refuse = || {
        format!(
            "the {what} '{raw}' points at a local, private or reserved address; a trusted issuer must be a public https server"
        )
    };
    match host {
        url::Host::Domain(d) => {
            let d = d.trim_end_matches('.').to_ascii_lowercase();
            if is_loopback_name(&d)
                || d.ends_with(".internal")
                || d.ends_with(".local")
                || !d.contains('.')
            {
                return Err(refuse());
            }
        }
        url::Host::Ipv4(ip) => {
            if !is_public_ip(IpAddr::V4(ip)) {
                return Err(refuse());
            }
        }
        url::Host::Ipv6(ip) => {
            if !is_public_ip(IpAddr::V6(ip)) {
                return Err(refuse());
            }
        }
    }
    Ok(u)
}

/// Whether the federation client may connect to `ip`.
fn allowed_ip(ip: IpAddr, allow_loopback: bool) -> bool {
    is_public_ip(ip) || (allow_loopback && ip.is_loopback())
}

/// A host whose addresses aren't all allowed.
#[derive(Debug)]
struct RefusedHost {
    host: String,
    ip: Option<IpAddr>,
}

impl std::fmt::Display for RefusedHost {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.ip {
            Some(ip) => write!(
                f,
                "the issuer host '{}' resolves to {ip}, which is not a public address",
                self.host
            ),
            None => write!(f, "the issuer host '{}' doesn't resolve", self.host),
        }
    }
}

impl std::error::Error for RefusedHost {}

/// DNS for the federation client: every address of a host must be public (or loopback when
/// allowed), and the connector then uses exactly these addresses.
#[derive(Debug, Clone, Copy)]
struct GuardedResolver {
    allow_loopback: bool,
}

impl reqwest::dns::Resolve for GuardedResolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let host = name.as_str().to_string();
        let allow_loopback = self.allow_loopback;
        Box::pin(async move {
            let bare = host
                .trim_start_matches('[')
                .trim_end_matches(']')
                .to_string();
            let addrs: Vec<std::net::SocketAddr> = tokio::net::lookup_host((bare.as_str(), 0))
                .await
                .map(Iterator::collect)
                .unwrap_or_default();
            if addrs.is_empty() {
                return Err(Box::new(RefusedHost { host, ip: None })
                    as Box<dyn std::error::Error + Send + Sync>);
            }
            if let Some(bad) = addrs.iter().find(|a| !allowed_ip(a.ip(), allow_loopback)) {
                return Err(Box::new(RefusedHost {
                    host,
                    ip: Some(bad.ip()),
                })
                    as Box<dyn std::error::Error + Send + Sync>);
            }
            Ok(Box::new(addrs.into_iter()) as reqwest::dns::Addrs)
        })
    }
}

// ---- the issuer cache -----------------------------------------------------------------------

#[derive(Debug, Clone)]
struct CachedIssuer {
    jwks_uri: String,
    keys: Vec<Value>,
    fetched_at: Instant,
}

/// The federation HTTP client and the cache of issuers' keys (one per API node).
#[derive(Clone)]
pub struct FederationClient {
    http: reqwest::Client,
    allow_loopback: bool,
    issuers: Arc<Mutex<HashMap<String, CachedIssuer>>>,
}

impl std::fmt::Debug for FederationClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FederationClient")
            .field("allow_loopback", &self.allow_loopback)
            .finish_non_exhaustive()
    }
}

/// Why an issuer's keys couldn't be read (shown to the caller).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FetchError(pub String);

impl FederationClient {
    /// A client for the settings' loopback rule.
    pub fn new(allow_loopback: bool) -> Result<FederationClient, String> {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .connect_timeout(Duration::from_secs(5))
            .redirect(reqwest::redirect::Policy::none())
            // A proxy would resolve the host itself and bypass the address checks.
            .no_proxy()
            .user_agent(format!("SiliconAccounts-Federation/{}", crate::VERSION))
            .dns_resolver(GuardedResolver { allow_loopback })
            .build()
            .map_err(|e| e.to_string())?;
        Ok(FederationClient {
            http,
            allow_loopback,
            issuers: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    fn cached(&self, issuer: &str) -> Option<CachedIssuer> {
        self.issuers
            .lock()
            .ok()
            .and_then(|m| m.get(issuer).cloned())
    }

    fn store(&self, issuer: &str, entry: CachedIssuer) {
        if let Ok(mut m) = self.issuers.lock() {
            if m.len() > 1000 {
                m.clear();
            }
            m.insert(issuer.to_string(), entry);
        }
    }

    /// Makes every cached issuer old enough that a token naming an unknown key fetches its keys
    /// again (tests: the refetch is otherwise held back for [`JWKS_REFETCH_SECONDS`]).
    pub fn age_cache(&self) {
        if let Ok(mut m) = self.issuers.lock() {
            for entry in m.values_mut() {
                if let Some(old) =
                    Instant::now().checked_sub(Duration::from_secs(JWKS_REFETCH_SECONDS + 1))
                {
                    entry.fetched_at = old;
                }
            }
        }
    }

    /// Forgets every cached issuer (tests).
    pub fn clear(&self) {
        if let Ok(mut m) = self.issuers.lock() {
            m.clear();
        }
    }

    async fn get_json(&self, url: &Url, what: &str) -> Result<Value, FetchError> {
        let response = self
            .http
            .get(url.clone())
            .header("accept", "application/json")
            .send()
            .await
            .map_err(|e| FetchError(describe_request_error(&e, what, url)))?;
        let status = response.status();
        if status.is_redirection() {
            return Err(FetchError(format!(
                "the {what} at {url} answered {status} (a redirect); we don't follow redirects, so the issuer must serve it directly"
            )));
        }
        if !status.is_success() {
            return Err(FetchError(format!("the {what} at {url} answered {status}")));
        }
        let mut response = response;
        let mut body: Vec<u8> = Vec::new();
        loop {
            match response.chunk().await {
                Ok(Some(chunk)) => {
                    if body.len() + chunk.len() > MAX_DOCUMENT_BYTES {
                        return Err(FetchError(format!(
                            "the {what} at {url} is larger than {} KB",
                            MAX_DOCUMENT_BYTES / 1024
                        )));
                    }
                    body.extend_from_slice(&chunk);
                }
                Ok(None) => break,
                Err(e) => return Err(FetchError(describe_request_error(&e, what, url))),
            }
        }
        serde_json::from_slice(&body)
            .map_err(|_| FetchError(format!("the {what} at {url} isn't JSON")))
    }

    /// The issuer's discovery document: checks it names the same issuer and an allowed
    /// `jwks_uri`, and returns the `jwks_uri`.
    pub async fn discover(&self, issuer: &str) -> Result<Url, FetchError> {
        let base = check_url(issuer, self.allow_loopback, "issuer").map_err(FetchError)?;
        let url = Url::parse(&format!(
            "{}/.well-known/openid-configuration",
            base.as_str().trim_end_matches('/')
        ))
        .map_err(|_| FetchError(format!("the issuer '{issuer}' can't take a discovery path")))?;
        let doc = self.get_json(&url, "discovery document").await?;
        let named = doc.get("issuer").and_then(Value::as_str).unwrap_or("");
        if normalize_issuer(named) != normalize_issuer(issuer) {
            return Err(FetchError(format!(
                "the discovery document at {url} names the issuer '{named}', not '{issuer}'"
            )));
        }
        let jwks_uri = doc.get("jwks_uri").and_then(Value::as_str).ok_or_else(|| {
            FetchError(format!("the discovery document at {url} has no jwks_uri"))
        })?;
        check_url(jwks_uri, self.allow_loopback, "jwks_uri").map_err(FetchError)
    }

    async fn fetch(&self, issuer: &str) -> Result<CachedIssuer, FetchError> {
        let jwks_uri = self.discover(issuer).await?;
        let jwks = self.get_json(&jwks_uri, "JWKS").await?;
        let keys = jwks
            .get("keys")
            .and_then(Value::as_array)
            .cloned()
            .ok_or_else(|| FetchError(format!("the JWKS at {jwks_uri} has no keys array")))?;
        let entry = CachedIssuer {
            jwks_uri: jwks_uri.to_string(),
            keys,
            fetched_at: Instant::now(),
        };
        self.store(issuer, entry.clone());
        tracing::debug!(issuer, jwks_uri = %entry.jwks_uri, keys = entry.keys.len(), "fetched an issuer's keys");
        Ok(entry)
    }

    /// The issuer's keys: cached, fetched when missing or older than [`JWKS_CACHE_SECONDS`],
    /// and fetched again when `kid` isn't among them (at most every [`JWKS_REFETCH_SECONDS`]).
    async fn keys(&self, issuer: &str, kid: Option<&str>) -> Result<Vec<Value>, FetchError> {
        let has = |entry: &CachedIssuer| {
            kid.is_none_or(|kid| {
                entry
                    .keys
                    .iter()
                    .any(|k| k.get("kid").and_then(Value::as_str) == Some(kid))
            })
        };
        match self.cached(issuer) {
            Some(entry)
                if entry.fetched_at.elapsed() < Duration::from_secs(JWKS_CACHE_SECONDS)
                    && (has(&entry)
                        || entry.fetched_at.elapsed()
                            < Duration::from_secs(JWKS_REFETCH_SECONDS)) =>
            {
                Ok(entry.keys)
            }
            _ => Ok(self.fetch(issuer).await?.keys),
        }
    }
}

fn describe_request_error(e: &reqwest::Error, what: &str, url: &Url) -> String {
    use std::error::Error as _;
    let mut source = e.source();
    while let Some(s) = source {
        if let Some(refused) = s.downcast_ref::<RefusedHost>() {
            return format!("{refused}, so the {what} at {url} was not fetched");
        }
        source = s.source();
    }
    if e.is_timeout() {
        format!("the {what} at {url} didn't answer within 10 seconds")
    } else if e.is_connect() {
        format!("could not connect to fetch the {what} at {url}")
    } else {
        format!("could not fetch the {what} at {url}")
    }
}

// ---- verifying an outside token -------------------------------------------------------------

fn invalid(message: impl Into<String>) -> ApiError {
    ApiError::unauthenticated("invalid_federated_token", message).hint(
        "Send a fresh OIDC token from your CI (for GitHub Actions: `silicon-accounts login --federated --github-actions --silicon si:<id>`), with the audience the trust expects, from a job its conditions match.",
    )
}

#[derive(Debug, Deserialize)]
struct RawHeader {
    alg: Option<String>,
    kid: Option<String>,
}

/// The parts of an outside token read before anything is trusted.
#[derive(Debug, Clone)]
pub struct UnverifiedToken {
    pub issuer: String,
    pub alg: Algorithm,
    pub kid: Option<String>,
}

fn decode_part(part: &str, what: &str) -> Result<Value, ApiError> {
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(part.trim_end_matches('='))
        .map_err(|_| invalid(format!("The token's {what} isn't base64url.")))?;
    serde_json::from_slice(&bytes)
        .map_err(|_| invalid(format!("The token's {what} isn't a JSON object.")))
}

/// Reads an outside token's issuer, algorithm and key id (nothing is trusted yet).
pub fn peek(token: &str) -> Result<UnverifiedToken, ApiError> {
    if token.len() > MAX_TOKEN_BYTES {
        return Err(invalid(format!(
            "The token is larger than {} KB.",
            MAX_TOKEN_BYTES / 1024
        )));
    }
    let mut parts = token.split('.');
    let (Some(h), Some(p), Some(_s), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(invalid(
            "The subject_token isn't a compact JWT (three base64url parts separated by dots).",
        ));
    };
    let header: RawHeader = serde_json::from_value(decode_part(h, "header")?)
        .map_err(|_| invalid("The token's header isn't a JWT header."))?;
    let alg_name = header.alg.unwrap_or_default();
    if !ALGORITHMS.contains(&alg_name.as_str()) {
        return Err(invalid(format!(
            "The token is signed with alg '{}'; trusted tokens are signed with one of {}.",
            if alg_name.is_empty() {
                "none"
            } else {
                &alg_name
            },
            ALGORITHMS.join(", ")
        )));
    }
    let alg: Algorithm = alg_name
        .parse()
        .map_err(|_| invalid(format!("The token's alg '{alg_name}' is not supported.")))?;
    let claims = decode_part(p, "payload")?;
    let issuer = claims
        .get("iss")
        .and_then(Value::as_str)
        .map(normalize_issuer)
        .filter(|i| !i.is_empty())
        .ok_or_else(|| invalid("The token has no iss (issuer) claim."))?;
    Ok(UnverifiedToken {
        issuer,
        alg,
        kid: header
            .kid
            .map(|k| k.trim().to_string())
            .filter(|k| !k.is_empty()),
    })
}

/// A key of the issuer usable for `alg` (and `kid`, when the token names one).
fn decoding_keys(keys: &[Value], alg: Algorithm, kid: Option<&str>) -> Vec<DecodingKey> {
    let family = match alg {
        Algorithm::RS256
        | Algorithm::RS384
        | Algorithm::RS512
        | Algorithm::PS256
        | Algorithm::PS384
        | Algorithm::PS512 => "RSA",
        Algorithm::ES256 | Algorithm::ES384 => "EC",
        Algorithm::EdDSA => "OKP",
        _ => return Vec::new(),
    };
    keys.iter()
        .filter(|k| k.get("kty").and_then(Value::as_str) == Some(family))
        .filter(|k| {
            k.get("use")
                .and_then(Value::as_str)
                .is_none_or(|u| u == "sig")
        })
        .filter(|k| {
            k.get("alg")
                .and_then(Value::as_str)
                .is_none_or(|a| a == format!("{alg:?}"))
        })
        .filter(|k| kid.is_none_or(|kid| k.get("kid").and_then(Value::as_str) == Some(kid)))
        .filter_map(|k| serde_json::from_value::<jsonwebtoken::jwk::Jwk>(k.clone()).ok())
        .filter_map(|jwk| DecodingKey::from_jwk(&jwk).ok())
        .collect()
}

/// An outside token whose signature, issuer and times checked out.
#[derive(Debug, Clone)]
pub struct VerifiedToken {
    pub issuer: String,
    pub claims: Map<String, Value>,
    pub exp: i64,
    pub jti: Option<String>,
}

impl VerifiedToken {
    fn audiences(&self) -> Vec<&str> {
        match self.claims.get("aud") {
            Some(Value::String(a)) => vec![a.as_str()],
            Some(Value::Array(list)) => list.iter().filter_map(Value::as_str).collect(),
            _ => Vec::new(),
        }
    }

    /// The claim as a condition compares it: strings as they are, booleans and numbers as text.
    fn claim_text(&self, name: &str) -> Option<String> {
        match self.claims.get(name)? {
            Value::String(s) => Some(s.clone()),
            Value::Bool(b) => Some(b.to_string()),
            Value::Number(n) => Some(n.to_string()),
            _ => None,
        }
    }

    /// Why `trust` doesn't accept this token (`None` = it does). It names the claims that
    /// differ and the token's own values, never the trust's name or the values it expects:
    /// anyone with a token from the same issuer (any GitHub user) can ask.
    pub fn mismatch(&self, trust: &Federation) -> Option<String> {
        let auds = self.audiences();
        if !auds.contains(&trust.audience.as_str()) {
            return Some(format!(
                "its aud is {} and a trust wants another audience",
                if auds.is_empty() {
                    "missing".to_string()
                } else {
                    auds.iter()
                        .map(|a| format!("'{a}'"))
                        .collect::<Vec<_>>()
                        .join(", ")
                }
            ));
        }
        let wrong: Vec<String> = trust
            .conditions
            .0
            .iter()
            .filter(|(claim, expected)| {
                self.claim_text(claim).as_deref() != Some(expected.as_str())
            })
            .map(|(claim, _)| match self.claim_text(claim) {
                Some(got) => format!("'{claim}' (the token has '{got}')"),
                None => format!("'{claim}' (the token has none)"),
            })
            .collect();
        (!wrong.is_empty()).then(|| format!("a trust wants other values for {}", wrong.join(", ")))
    }
}

/// Verifies an outside token from `issuer` (already peeked): signature with the issuer's keys,
/// `exp` and `nbf` with [`LEEWAY_SECONDS`], `iat` present and not in the future.
pub async fn verify(
    client: &FederationClient,
    token: &str,
    peeked: &UnverifiedToken,
    now: i64,
) -> Result<VerifiedToken, ApiError> {
    let keys = client
        .keys(&peeked.issuer, peeked.kid.as_deref())
        .await
        .map_err(|e| {
            ApiError::unauthenticated(
                "issuer_unavailable",
                format!(
                    "We couldn't read the signing keys of {}: {}.",
                    peeked.issuer, e.0
                ),
            )
            .hint("Retry in a moment. If it keeps failing, check the issuer's /.well-known/openid-configuration and its jwks_uri are reachable over https.")
        })?;
    let candidates = decoding_keys(&keys, peeked.alg, peeked.kid.as_deref());
    if candidates.is_empty() {
        return Err(invalid(match &peeked.kid {
            Some(kid) => format!(
                "The token names the key '{kid}', which {} doesn't publish in its JWKS (we fetched it again to be sure).",
                peeked.issuer
            ),
            None => format!(
                "The token names no key (kid) and {} publishes no {:?} key.",
                peeked.issuer, peeked.alg
            ),
        }));
    }
    let mut validation = Validation::new(peeked.alg);
    validation.leeway = LEEWAY_SECONDS as u64;
    validation.validate_exp = true;
    validation.validate_nbf = true;
    validation.validate_aud = false;
    validation.set_required_spec_claims(&["exp", "iss"]);
    let mut last = None;
    for key in &candidates {
        match jsonwebtoken::decode::<Map<String, Value>>(token, key, &validation) {
            Ok(data) => {
                let claims = data.claims;
                let iss = claims
                    .get("iss")
                    .and_then(Value::as_str)
                    .map(normalize_issuer)
                    .unwrap_or_default();
                if iss != peeked.issuer {
                    return Err(invalid("The token's issuer changed while it was read."));
                }
                let exp = claims
                    .get("exp")
                    .and_then(Value::as_i64)
                    .ok_or_else(|| invalid("The token's exp must be a number of seconds."))?;
                let iat = claims.get("iat").and_then(Value::as_i64).ok_or_else(|| {
                    invalid("The token has no iat (issued at) claim, so its age can't be judged.")
                })?;
                if iat > now + LEEWAY_SECONDS {
                    return Err(invalid(format!(
                        "The token's iat is {} seconds in the future; check the clocks.",
                        iat - now
                    )));
                }
                let jti = match claims.get("jti") {
                    None | Some(Value::Null) => None,
                    Some(Value::String(j)) if !j.trim().is_empty() && j.len() <= 255 => {
                        Some(j.trim().to_string())
                    }
                    Some(_) => {
                        return Err(invalid(
                            "The token's jti must be a string of 1 to 255 characters.",
                        ));
                    }
                };
                return Ok(VerifiedToken {
                    issuer: iss,
                    claims,
                    exp,
                    jti,
                });
            }
            Err(e) => last = Some(e),
        }
    }
    use jsonwebtoken::errors::ErrorKind;
    Err(invalid(match last.as_ref().map(|e| e.kind()) {
        Some(ErrorKind::ExpiredSignature) => {
            "The token expired; get a fresh one from your CI and exchange it right away."
                .to_string()
        }
        Some(ErrorKind::ImmatureSignature) => {
            "The token isn't valid yet (its nbf is in the future); check the clocks.".to_string()
        }
        Some(ErrorKind::InvalidSignature) => format!(
            "The token's signature doesn't verify with the keys {} publishes.",
            peeked.issuer
        ),
        Some(ErrorKind::MissingRequiredClaim(c)) => format!("The token has no {c} claim."),
        _ => "The token couldn't be verified.".to_string(),
    }))
}

// ---- the exchange ---------------------------------------------------------------------------

/// What a token exchange asks for.
#[derive(Debug, Clone, Copy)]
pub struct ExchangeRequest<'a> {
    /// The Silicon to sign in: si:id or uuid.
    pub silicon: &'a str,
    /// The outside OIDC token.
    pub subject_token: &'a str,
}

fn no_trust(silicon: &str, issuer: &str) -> ApiError {
    ApiError::unauthenticated(
        "no_matching_trust",
        format!("{silicon} doesn't trust tokens from {issuer}."),
    )
    .hint("Its custodian (or the Silicon) adds a trust first: `silicon-accounts silicon trust add <si:id> --issuer <issuer> --claim repository=<owner/repo>`.")
    .detail("issuer", issuer.to_string())
}

/// The live trusts of a Silicon, oldest first.
pub async fn live_federations(
    conn: &mut PgConnection,
    silicon_uuid: &str,
) -> ApiResult<Vec<Federation>> {
    Ok(sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "select {FEDERATION_COLUMNS} from silicon_federations \
         where silicon_uuid = $1 and revoked_at is null order by created_at, id"
    )))
    .bind(silicon_uuid)
    .fetch_all(&mut *conn)
    .await?)
}

async fn record(
    conn: &mut PgConnection,
    account_uuid: &str,
    meta: &ClientMeta,
    outcome: &str,
) -> ApiResult<()> {
    audit::signin(
        conn,
        &SigninRecord {
            account_uuid: Some(account_uuid),
            app_id: Some(crate::FIRST_PARTY_APP_ID),
            method: audit::method::FEDERATED,
            outcome,
            ip: meta.ip.as_deref(),
            user_agent: meta.user_agent.as_deref(),
        },
    )
    .await
}

/// Signs a Silicon in with an outside OIDC token it is trusted for (see the module docs):
/// first-party tokens, origin `federated`, a sign-in that ends when the outside token expires
/// ([`session_seconds`]). The sign-in is linked to the trust that accepted it, so removing the
/// trust ends it.
///
/// Errors: 401 `invalid_federated_token` (malformed, wrong signature, expired, replayed),
/// `no_matching_trust` (no trust of the Silicon accepts the token), `issuer_unavailable`
/// (its keys couldn't be read); 403 `account_not_active`; 429 `rate_limited`.
pub async fn sign_in(
    state: &AppState,
    meta: &ClientMeta,
    req: ExchangeRequest<'_>,
) -> ApiResult<TokenExchangeResponse> {
    rate_limit::enforce_pool(
        &state.db,
        &rate_limit::bucket("federated_exchange:ip", meta.ip_or_unknown()),
        EXCHANGES_PER_IP,
        "token exchanges from this address",
    )
    .await?;
    let token = req.subject_token.trim();
    let peeked = peek(token)?;
    let wanted = req.silicon.trim();
    let mut conn = state.db.acquire().await?;
    let found = if wanted.contains(':') {
        accounts::by_handle(&mut conn, wanted).await?
    } else {
        accounts::get(&mut conn, wanted).await?
    };
    let Some(silicon) = found.filter(|a| a.kind == AccountKind::Silicon && !a.is_deleted()) else {
        return Err(ApiError::unauthenticated(
            "no_matching_trust",
            format!("No Silicon is {wanted}, so no trust can accept the token."),
        )
        .hint("Send the Silicon's si:id (e.g. si:scout) or uuid in the silicon parameter."));
    };
    let trusts: Vec<Federation> = live_federations(&mut conn, &silicon.uuid)
        .await?
        .into_iter()
        .filter(|t| normalize_issuer(&t.issuer) == peeked.issuer)
        .collect();
    drop(conn);
    if trusts.is_empty() {
        return Err(no_trust(&silicon.display_id(), &peeked.issuer));
    }
    let now = OffsetDateTime::now_utc().unix_timestamp();
    let verified = verify(&state.federation, token, &peeked, now).await?;

    // From here the token provably comes from a trusted issuer, so failures are recorded in
    // the Silicon's sign-in history (forged tokens never reach this point).
    let mut tx = state.db.begin().await?;
    let mut reasons = Vec::new();
    let trust = trusts.iter().find(|t| match verified.mismatch(t) {
        None => true,
        Some(why) => {
            reasons.push(why);
            false
        }
    });
    let Some(trust) = trust else {
        record(&mut tx, &silicon.uuid, meta, audit::outcome::FAILED).await?;
        tx.commit().await?;
        return Err(ApiError::unauthenticated(
            "no_matching_trust",
            format!(
                "{} trusts {}, but not this token: {}.",
                silicon.display_id(),
                peeked.issuer,
                reasons.join("; ")
            ),
        )
        .hint("Run the job from the repository, branch or environment the trust names, and ask for the audience it expects (`silicon-accounts silicon trust list <si:id>` shows the trusts)."));
    };
    if let Some(jti) = &verified.jti {
        let fresh = sqlx::query(
            "insert into federated_token_uses (issuer, jti, federation_id, expires_at) \
             values ($1, $2, $3, to_timestamp($4)) on conflict do nothing",
        )
        .bind(&verified.issuer)
        .bind(jti)
        .bind(trust.id)
        .bind((verified.exp + LEEWAY_SECONDS) as f64)
        .execute(&mut *tx)
        .await?
        .rows_affected()
            == 1;
        if !fresh {
            record(&mut tx, &silicon.uuid, meta, audit::outcome::FAILED).await?;
            tx.commit().await?;
            return Err(invalid(
                "This token was exchanged before (its jti); each outside token signs in once. Get a fresh one from your CI.",
            ));
        }
    }
    let Some(account) = accounts::lock(&mut tx, &silicon.uuid).await? else {
        return Err(no_trust(wanted, &peeked.issuer));
    };
    if account.status != AccountStatus::Active {
        record(&mut tx, &account.uuid, meta, audit::outcome::FAILED).await?;
        tx.commit().await?;
        return Err(ApiError::forbidden(
            "account_not_active",
            format!(
                "{} is {}, so it can't sign in.",
                account.display_id(),
                account.status
            ),
        ));
    }
    // The trust may have been removed while the token was verified.
    let still_live: bool = sqlx::query_scalar(
        "select revoked_at is null from silicon_federations where id = $1 for share",
    )
    .bind(trust.id)
    .fetch_optional(&mut *tx)
    .await?
    .unwrap_or(false);
    if !still_live {
        return Err(no_trust(&account.display_id(), &peeked.issuer));
    }
    let label = format!("{} (trusted outside token)", trust.name);
    let (issued, family) = tokens::issue_tokens_for(
        &mut tx,
        &state.keys,
        &state.settings,
        tokens::IssueRequest {
            account: &account,
            app_id: crate::FIRST_PARTY_APP_ID,
            origin: TokenOrigin::Federated,
            scopes: &[Scope::Profile],
            browser_session_id: None,
            label: Some(&label),
            ip: meta.ip.as_deref(),
            user_agent: meta.user_agent.as_deref(),
            nonce: None,
            auth_time: None,
        },
        session_seconds(verified.exp, now, state.settings.access_token_ttl_seconds),
    )
    .await?;
    sqlx::query(
        "insert into silicon_federation_sessions (family_id, federation_id) values ($1, $2)",
    )
    .bind(family.id)
    .bind(trust.id)
    .execute(&mut *tx)
    .await?;
    sqlx::query("update silicon_federations set last_used_at = now() where id = $1")
        .bind(trust.id)
        .execute(&mut *tx)
        .await?;
    record(&mut tx, &account.uuid, meta, audit::outcome::SUCCESS).await?;
    tx.commit().await?;
    Ok(TokenExchangeResponse {
        tokens: issued,
        issued_token_type: tokens::ACCESS_TOKEN_TYPE.to_string(),
    })
}

/// How long a sign-in from an outside token lasts: until that token expires, but at least one
/// access token (`access_ttl`) and at most [`MAX_SESSION_SECONDS`]. Refresh tokens rotate as
/// usual within it, so a CI job keeps going for as long as its own token is good, and never
/// longer.
pub fn session_seconds(outside_exp: i64, now: i64, access_ttl: i64) -> i64 {
    (outside_exp - now).clamp(access_ttl.max(1), MAX_SESSION_SECONDS.max(access_ttl))
}

/// True when `auth` is a sign-in that came from a trusted outside token. Such a sign-in can't
/// add sign-in methods (keys, trusts): a CI job may act as the Silicon, but never widen who
/// else can.
pub async fn is_federated_session(conn: &mut PgConnection, auth: &AccountAuth) -> ApiResult<bool> {
    let AuthVia::Bearer { family_id, .. } = &auth.via else {
        return Ok(false);
    };
    let origin: Option<String> =
        sqlx::query_scalar("select origin from token_families where id = $1")
            .bind(family_id)
            .fetch_optional(&mut *conn)
            .await?;
    Ok(origin.as_deref() == Some(TokenOrigin::Federated.as_str()))
}

/// When `auth` is a sign-in that came from a trusted outside token: its trust and the end of
/// its token family. A short-lived token it mints carries both (`repo::tokens::SltBound`), so
/// the app sign-in made from that token ends no later than this sign-in and belongs to the same
/// trust (removing the trust ends it too).
pub async fn session_bound(
    conn: &mut PgConnection,
    auth: &AccountAuth,
) -> ApiResult<Option<tokens::SltBound>> {
    let AuthVia::Bearer { family_id, .. } = &auth.via else {
        return Ok(None);
    };
    let row: Option<(Uuid, OffsetDateTime)> = sqlx::query_as(
        "select s.federation_id, f.expires_at from silicon_federation_sessions s \
         join token_families f on f.id = s.family_id \
         where s.family_id = $1 and f.origin = $2",
    )
    .bind(family_id)
    .bind(TokenOrigin::Federated.as_str())
    .fetch_optional(&mut *conn)
    .await?;
    Ok(
        row.map(|(federation_id, family_expires_cap)| tokens::SltBound {
            federation_id,
            family_expires_cap,
        }),
    )
}

/// 403 `federated_session`: a sign-in from an outside token tried to add a sign-in method.
pub fn federated_session_refused(what: &str) -> ApiError {
    ApiError::forbidden(
        "federated_session",
        format!(
            "This session came from a trusted outside token (a CI job), and such a session can't add {what}: it may act as the Silicon, but never widen who else can."
        ),
    )
    .hint("Add it from a session signed in with the STK or a key, or as the custodian.")
}

/// Whether `account` is the Silicon `silicon` or its custodian.
pub fn is_silicon_or_custodian(silicon: &Account, account_uuid: &str) -> bool {
    silicon.uuid == account_uuid || silicon.custodian_uuid.as_deref() == Some(account_uuid)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings() -> crate::Settings {
        crate::Settings::for_tests()
    }

    fn input(issuer: &str, conditions: Value) -> NewFederation {
        NewFederation {
            issuer: issuer.into(),
            audience: None,
            conditions: serde_json::from_value(conditions).expect("map"),
            name: None,
        }
    }

    #[test]
    fn trusts_need_a_condition_and_github_needs_a_repository() {
        let s = settings();
        let ok = validate(
            &input(
                GITHUB_ACTIONS_ISSUER,
                json!({"repository": "acme/scout", "ref": "refs/heads/main"}),
            ),
            &s,
        )
        .expect("valid");
        assert_eq!(ok.issuer, GITHUB_ACTIONS_ISSUER);
        assert_eq!(ok.audience, "http://localhost:8590");
        assert_eq!(ok.name, "GitHub Actions");
        let e = validate(&input(GITHUB_ACTIONS_ISSUER, json!({})), &s).expect_err("no conditions");
        assert!(
            e.get("conditions")
                .is_some_and(|m| m.contains("at least one"))
        );
        let e = validate(
            &input(GITHUB_ACTIONS_ISSUER, json!({"ref": "refs/heads/main"})),
            &s,
        )
        .expect_err("no repository");
        assert!(
            e.get("conditions")
                .is_some_and(|m| m.contains("repository"))
        );
        let e = validate(&input(GITLAB_ISSUER, json!({"ref": "main"})), &s).expect_err("gitlab");
        assert!(
            e.get("conditions")
                .is_some_and(|m| m.contains("project_path"))
        );
        assert!(validate(&input("https://ci.example.com", json!({"ref": "main"})), &s).is_ok());
        // CircleCI's claims are namespaced with a '/'.
        assert!(
            validate(
                &input(
                    "https://oidc.circleci.com/org/8c8a6f63",
                    json!({"oidc.circleci.com/project-id": "4f7b8a1e"})
                ),
                &s
            )
            .is_ok()
        );
        let e = validate(&input("https://ci.example.com", json!({"aud": "x"})), &s)
            .expect_err("reserved");
        assert!(e.get("conditions.aud").is_some());
        let e = validate(&input("https://ci.example.com", json!({"x": {"a": 1}})), &s)
            .expect_err("object");
        assert!(e.get("conditions.x").is_some());
        let e = validate(&input("http://ci.example.com", json!({"x": "1"})), &s).expect_err("http");
        assert!(e.get("issuer").is_some_and(|m| m.contains("https")));
    }

    #[test]
    fn sessions_last_as_long_as_the_outside_token_within_bounds() {
        let now = 1_900_000_000;
        // A GitHub token lives minutes: the session is one access token long.
        assert_eq!(session_seconds(now + 300, now, 1800), 1800);
        // A GitLab token lives as long as the job: the session follows it.
        assert_eq!(session_seconds(now + 3 * 3600, now, 1800), 3 * 3600);
        // Never longer than 12 hours, whatever the issuer says.
        assert_eq!(
            session_seconds(now + 400 * 86_400, now, 1800),
            MAX_SESSION_SECONDS
        );
    }

    #[test]
    fn issuer_urls_must_be_public_https() {
        for bad in [
            "http://token.actions.githubusercontent.com",
            "https://127.0.0.1",
            "https://10.0.0.8",
            "https://169.254.169.254",
            "https://[::1]",
            "https://localhost",
            "https://metadata.google.internal",
            "https://printer.local",
            "https://intranet",
            "https://user:pw@ci.example.com",
            "https://ci.example.com/?x=1",
            "ftp://ci.example.com",
        ] {
            assert!(check_url(bad, false, "issuer").is_err(), "{bad}");
        }
        assert!(check_url(GITHUB_ACTIONS_ISSUER, false, "issuer").is_ok());
        assert!(check_url("https://gitlab.example.com/gitlab", false, "issuer").is_ok());
        // The test flag allows loopback over http, never private or link-local addresses.
        assert!(check_url("http://127.0.0.1:9000", true, "issuer").is_ok());
        assert!(check_url("http://localhost:9000", true, "issuer").is_ok());
        assert!(check_url("http://10.0.0.8", true, "issuer").is_err());
        assert!(check_url("https://169.254.169.254", true, "issuer").is_err());
        assert!(!allowed_ip("10.1.2.3".parse().expect("ip"), true));
        assert!(allowed_ip("127.0.0.1".parse().expect("ip"), true));
        assert!(!allowed_ip("127.0.0.1".parse().expect("ip"), false));
    }

    #[test]
    fn peek_reads_the_issuer_and_refuses_unsafe_algorithms() {
        let e = |v: &Value| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(v.to_string());
        let token = |alg: &str| {
            format!(
                "{}.{}.sig",
                e(&json!({"alg": alg, "kid": "k1"})),
                e(&json!({"iss": "https://token.actions.githubusercontent.com/"}))
            )
        };
        let p = peek(&token("RS256")).expect("peek");
        assert_eq!(p.issuer, GITHUB_ACTIONS_ISSUER);
        assert_eq!(p.kid.as_deref(), Some("k1"));
        for bad in ["none", "HS256", ""] {
            assert_eq!(
                peek(&token(bad)).expect_err("alg").code,
                "invalid_federated_token"
            );
        }
        assert!(peek("a.b").is_err());
    }
}
