//! Input normalization and validation with precise, agent-friendly messages.
//!
//! - emails: [`normalize_email`] (trim + lowercase + RFC-ish syntax), [`mask_email`]
//! - phones: [`normalize_phone`] (E.164 via `phonenumber`, optional default country), [`mask_phone`]
//! - timezones: [`normalize_timezone`] (IANA, canonical case)
//! - names and dates: [`validate_display_name`], [`validate_dob`], [`default_dob`],
//!   [`parse_date_flexible`] (imports)
//! - URLs: [`validate_https_url`], [`validate_pfp_url`], [`validate_webhook_url`]
//! - the webhook SSRF guard: [`is_public_ip`], [`resolve_checked`] ([`BlockedAddress`])
//! - suggestions: [`display_name_from_email`], [`display_name_from_phone`]

use std::fmt;
use std::net::IpAddr;
use std::str::FromStr;

use time::{Date, Month};
use url::Url;

use crate::config::Settings;

/// Why an email or phone number was rejected.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContactError {
    /// `invalid_email`, `invalid_phone` or `invalid_country`.
    pub code: &'static str,
    pub message: String,
    pub hint: String,
}

impl fmt::Display for ContactError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ContactError {}

impl From<ContactError> for crate::error::ApiError {
    fn from(e: ContactError) -> Self {
        crate::error::ApiError::unprocessable(e.code, e.message).hint(e.hint)
    }
}

fn email_error(input: &str, why: impl fmt::Display) -> ContactError {
    ContactError {
        code: "invalid_email",
        message: format!("'{input}' is not a valid email address: {why}."),
        hint: "Use an address like name@example.com.".into(),
    }
}

/// Trims, lowercases and validates an email address.
pub fn normalize_email(input: &str) -> Result<String, ContactError> {
    let raw = input.trim();
    if raw.is_empty() {
        return Err(email_error(input, "it is empty"));
    }
    if raw.len() > 254 {
        return Err(email_error(raw, "it is longer than 254 characters"));
    }
    if let Some(c) = raw.chars().find(|c| !c.is_ascii()) {
        return Err(email_error(
            raw,
            format_args!("it contains the non-ASCII character '{c}'"),
        ));
    }
    if raw
        .chars()
        .any(|c| c.is_ascii_whitespace() || c.is_ascii_control())
    {
        return Err(email_error(
            raw,
            "it contains whitespace or control characters",
        ));
    }
    let email = raw.to_ascii_lowercase();
    let at_count = email.matches('@').count();
    if at_count != 1 {
        return Err(email_error(
            raw,
            if at_count == 0 {
                "it has no '@'".to_string()
            } else {
                "it has more than one '@'".to_string()
            },
        ));
    }
    let (local, domain) = email.split_once('@').unwrap_or(("", ""));
    if local.is_empty() {
        return Err(email_error(raw, "nothing comes before the '@'"));
    }
    if local.len() > 64 {
        return Err(email_error(
            raw,
            "the part before '@' is longer than 64 characters",
        ));
    }
    if local.starts_with('.') || local.ends_with('.') || local.contains("..") {
        return Err(email_error(
            raw,
            "the part before '@' has a leading, trailing or double dot",
        ));
    }
    const LOCAL_SPECIALS: &str = "!#$%&'*+-/=?^_`{|}~.";
    if let Some(c) = local
        .chars()
        .find(|c| !(c.is_ascii_alphanumeric() || LOCAL_SPECIALS.contains(*c)))
    {
        return Err(email_error(
            raw,
            format_args!("'{c}' is not allowed before the '@'"),
        ));
    }
    if domain.is_empty() {
        return Err(email_error(raw, "nothing comes after the '@'"));
    }
    if !domain.contains('.') {
        return Err(email_error(
            raw,
            format_args!("the domain '{domain}' has no dot (like example.com)"),
        ));
    }
    for label in domain.split('.') {
        if label.is_empty() {
            return Err(email_error(
                raw,
                format_args!("the domain '{domain}' has an empty part"),
            ));
        }
        if label.len() > 63 {
            return Err(email_error(
                raw,
                format_args!("the domain part '{label}' is longer than 63 characters"),
            ));
        }
        if label.starts_with('-') || label.ends_with('-') {
            return Err(email_error(
                raw,
                format_args!("the domain part '{label}' starts or ends with '-'"),
            ));
        }
        if let Some(c) = label
            .chars()
            .find(|c| !(c.is_ascii_alphanumeric() || *c == '-'))
        {
            return Err(email_error(
                raw,
                format_args!("'{c}' is not allowed in the domain"),
            ));
        }
    }
    let tld = domain.rsplit('.').next().unwrap_or("");
    if tld.len() < 2 || !(tld.chars().all(|c| c.is_ascii_alphabetic()) || tld.starts_with("xn--")) {
        return Err(email_error(
            raw,
            format_args!("'{tld}' is not a valid top-level domain"),
        ));
    }
    Ok(email)
}

/// The domain of a normalized email.
pub fn email_domain(email: &str) -> &str {
    email.rsplit_once('@').map(|(_, d)| d).unwrap_or("")
}

/// `saket@gmail.com` → `s***@gmail.com`.
pub fn mask_email(email: &str) -> String {
    match email.split_once('@') {
        Some((local, domain)) => {
            let first: String = local.chars().take(1).collect();
            format!("{first}***@{domain}")
        }
        None => "***".into(),
    }
}

/// Parses a phone number into E.164. Numbers starting with `+` (or `00`) are international; others
/// need `default_country` (ISO 3166 alpha-2, e.g. `IN`).
pub fn normalize_phone(input: &str, default_country: Option<&str>) -> Result<String, ContactError> {
    let raw = input.trim();
    let invalid = |why: String| {
        ContactError {
        code: "invalid_phone",
        message: format!("'{raw}' is not a valid phone number: {why}."),
        hint: "Use international format like +919876543210, or send \"country\" (e.g. \"IN\") with a local number."
            .into(),
    }
    };
    if raw.is_empty() {
        return Err(invalid("it is empty".into()));
    }
    if raw.chars().filter(|c| c.is_ascii_digit()).count() < 4 {
        return Err(invalid("it has too few digits".into()));
    }
    if let Some(c) = raw
        .chars()
        .find(|c| !(c.is_ascii_digit() || " +-().".contains(*c)))
    {
        return Err(invalid(format!(
            "'{c}' is not allowed (only digits, spaces, +, -, ( and ))"
        )));
    }
    let international = raw.starts_with('+') || raw.starts_with("00");
    let normalized_input = if let Some(rest) = raw.strip_prefix("00") {
        format!("+{rest}")
    } else {
        raw.to_string()
    };
    let country = match default_country.map(str::trim).filter(|c| !c.is_empty()) {
        Some(c) => Some(
            phonenumber::country::Id::from_str(&c.to_ascii_uppercase()).map_err(|_| {
                ContactError {
                    code: "invalid_country",
                    message: format!("'{c}' is not an ISO 3166 country code."),
                    hint: "Use a two-letter country code such as IN, US or GB.".into(),
                }
            })?,
        ),
        None => None,
    };
    if !international && country.is_none() {
        return Err(invalid(
            "it has no country code; start it with + (like +91…) or send the country it belongs to"
                .into(),
        ));
    }
    let parsed = phonenumber::parse(
        if international { None } else { country },
        &normalized_input,
    )
    .map_err(|e| invalid(format!("it could not be parsed ({e})")))?;
    if !parsed.is_valid() {
        let region = parsed
            .country()
            .id()
            .map(|id| format!(" for {}", id.as_ref()))
            .unwrap_or_default();
        return Err(invalid(format!(
            "it is not a valid number{region} (wrong length or prefix)"
        )));
    }
    use std::fmt::Write as _;
    let mut out = String::new();
    write!(out, "{}", parsed.format().mode(phonenumber::Mode::E164))
        .map_err(|_| invalid("it could not be formatted as E.164".into()))?;
    Ok(out)
}

/// `+919876543210` → `+91******3210`.
pub fn mask_phone(phone: &str) -> String {
    let digits: Vec<char> = phone.chars().collect();
    if digits.len() <= 7 {
        return "***".into();
    }
    let head: String = digits[..3].iter().collect();
    let tail: String = digits[digits.len() - 4..].iter().collect();
    format!("{head}{}{tail}", "*".repeat(digits.len() - 7))
}

/// Validates an IANA timezone (case-insensitive) and returns its canonical spelling.
pub fn normalize_timezone(input: &str) -> Result<String, String> {
    let s = input.trim();
    if s.is_empty() {
        return Err("The timezone is empty; use an IANA name like Asia/Kolkata or UTC.".into());
    }
    if let Ok(tz) = s.parse::<chrono_tz::Tz>() {
        return Ok(tz.name().to_string());
    }
    // chrono-tz's own case-insensitive lookup needs a feature we don't build; scan instead.
    match chrono_tz::TZ_VARIANTS
        .iter()
        .find(|tz| tz.name().eq_ignore_ascii_case(s))
    {
        Some(tz) => Ok(tz.name().to_string()),
        None => Err(format!(
            "'{s}' is not an IANA timezone; use a tz identifier like Asia/Kolkata, America/New_York or UTC."
        )),
    }
}

/// True when `s` is a valid IANA timezone.
pub fn is_valid_timezone(s: &str) -> bool {
    normalize_timezone(s).is_ok()
}

/// Validates a display name: trimmed, 1..=100 characters, no control characters.
pub fn validate_display_name(input: &str) -> Result<String, String> {
    let s = input.trim();
    if s.is_empty() {
        return Err("The display name is empty; it must be 1 to 100 characters.".into());
    }
    let n = s.chars().count();
    if n > 100 {
        return Err(format!(
            "The display name is {n} characters; it must be at most 100."
        ));
    }
    if s.chars().any(|c| c.is_control()) {
        return Err("The display name contains control characters (like newlines or tabs).".into());
    }
    Ok(s.to_string())
}

/// Validates a date of birth: on or after 1900-01-01 and before `today`.
pub fn validate_dob(dob: Date, today: Date) -> Result<Date, String> {
    let earliest = Date::from_calendar_date(1900, Month::January, 1).unwrap_or(Date::MIN);
    if dob < earliest {
        return Err(format!(
            "The date of birth {} is before 1900-01-01.",
            crate::timefmt::format_date(dob)
        ));
    }
    if dob >= today {
        return Err(format!(
            "The date of birth {} is not in the past (today is {}).",
            crate::timefmt::format_date(dob),
            crate::timefmt::format_date(today)
        ));
    }
    Ok(dob)
}

/// The default dob: `today` minus 18 years, same month/day (Feb 29 → Feb 28).
pub fn default_dob(today: Date) -> Date {
    let year = today.year() - 18;
    Date::from_calendar_date(year, today.month(), today.day())
        .or_else(|_| Date::from_calendar_date(year, today.month(), 28))
        .unwrap_or(today)
}

/// Parses dates for imports: `YYYY-MM-DD`, `YYYY/MM/DD`, `DD/MM/YYYY` or `MM/DD/YYYY` (only
/// when unambiguous: one of the first two parts is > 12). `-` and `.` also work as separators
/// in the day-first forms.
pub fn parse_date_flexible(input: &str) -> Result<Date, String> {
    let s = input.trim();
    let parts: Vec<&str> = s.split(['-', '/', '.']).collect();
    let bad = || {
        format!(
            "'{s}' is not a date; use YYYY-MM-DD (also accepted: YYYY/MM/DD, DD/MM/YYYY, and MM/DD/YYYY when unambiguous)"
        )
    };
    if parts.len() != 3
        || parts
            .iter()
            .any(|p| p.is_empty() || !p.chars().all(|c| c.is_ascii_digit()))
    {
        return Err(bad());
    }
    let nums: Vec<u32> = parts.iter().filter_map(|p| p.parse::<u32>().ok()).collect();
    if nums.len() != 3 {
        return Err(bad());
    }
    let (y, m, d) = if parts[0].len() == 4 {
        (nums[0], nums[1], nums[2])
    } else if parts[2].len() == 4 {
        let (a, b) = (nums[0], nums[1]);
        if a > 12 && b <= 12 {
            (nums[2], b, a)
        } else if (b > 12 && a <= 12) || a == b {
            (nums[2], a, b)
        } else {
            return Err(format!(
                "'{s}' is ambiguous: it could be day/month or month/day; use YYYY-MM-DD"
            ));
        }
    } else {
        return Err(bad());
    };
    let month = u8::try_from(m)
        .ok()
        .and_then(|m| Month::try_from(m).ok())
        .ok_or_else(bad)?;
    let year = i32::try_from(y).map_err(|_| bad())?;
    let day = u8::try_from(d).map_err(|_| bad())?;
    Date::from_calendar_date(year, month, day)
        .map_err(|_| format!("'{s}' is not a real calendar date"))
}

/// The longest URL accepted anywhere (photos, webhooks), counted as it is stored.
pub const MAX_URL_LEN: usize = 2048;

/// Validates an absolute https URL (≤ 2048 chars as stored, no credentials).
pub fn validate_https_url(input: &str) -> Result<Url, String> {
    let s = input.trim();
    if s.len() > MAX_URL_LEN {
        return Err(format!("the URL is longer than {MAX_URL_LEN} characters"));
    }
    let u = Url::parse(s)
        .map_err(|_| format!("'{s}' is not an absolute URL like https://example.com/image.png"))?;
    if u.scheme() != "https" {
        return Err(format!("'{s}' must use https"));
    }
    if u.host_str().is_none() {
        return Err(format!("'{s}' has no host"));
    }
    if !u.username().is_empty() || u.password().is_some() {
        return Err(format!("'{s}' must not contain credentials"));
    }
    // Non-ASCII input is percent-encoded when stored, which can make it much longer.
    if u.as_str().len() > MAX_URL_LEN {
        return Err(format!(
            "the URL is longer than {MAX_URL_LEN} characters once encoded ({} characters); shorten it",
            u.as_str().len()
        ));
    }
    Ok(u)
}

/// Validates a profile photo URL: an https URL, or a photo served by this service written
/// exactly as `POST /v1/me/photo` returns it (`{PUBLIC_URL}/v1/photos/{photo_id}`, see
/// [`crate::pfp::photo_ref`]). Whether such a photo may be used by an account (its own upload,
/// or its custodian's) is checked against the database by `repo::photos::check_usable`.
pub fn validate_pfp_url(settings: &Settings, input: &str) -> Result<String, String> {
    let s = input.trim();
    match crate::pfp::photo_ref(settings, s) {
        crate::pfp::PhotoRef::Exact(_) => Ok(s.to_string()),
        crate::pfp::PhotoRef::Inexact(problem) => Err(problem),
        crate::pfp::PhotoRef::External => validate_https_url(s).map(|u| u.to_string()),
    }
}

/// Validates a webhook URL. With `webhook_allow_private` (dev/test) http and private hosts are
/// fine; otherwise it must be https and must not name a local host or a literal IP that isn't
/// public ([`is_public_ip`]). Host names are checked again at delivery time, after DNS
/// resolution ([`resolve_checked`]).
pub fn validate_webhook_url(settings: &Settings, input: &str) -> Result<Url, String> {
    let s = input.trim();
    if s.len() > MAX_URL_LEN {
        return Err(format!(
            "the webhook URL is longer than {MAX_URL_LEN} characters"
        ));
    }
    let u = Url::parse(s)
        .map_err(|_| format!("'{s}' is not an absolute URL like https://example.com/webhooks"))?;
    if u.fragment().is_some() {
        return Err(format!("'{s}' must not contain a #fragment"));
    }
    if !u.username().is_empty() || u.password().is_some() {
        return Err(format!("'{s}' must not contain credentials"));
    }
    if u.as_str().len() > MAX_URL_LEN {
        return Err(format!(
            "the webhook URL is longer than {MAX_URL_LEN} characters once encoded"
        ));
    }
    let host = u.host_str().ok_or_else(|| format!("'{s}' has no host"))?;
    if settings.webhook_allow_private {
        if u.scheme() != "https" && u.scheme() != "http" {
            return Err(format!("'{s}' must use https (or http in development)"));
        }
        return Ok(u);
    }
    if u.scheme() != "https" {
        return Err(format!("'{s}' must use https"));
    }
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    if bare.eq_ignore_ascii_case("localhost")
        || bare.ends_with(".localhost")
        || bare.ends_with(".internal")
    {
        return Err(format!(
            "'{s}' points at a local host; webhooks must reach a public server"
        ));
    }
    // The URL parser has normalized the host, so every spelling of a literal IP lands here.
    let literal = match u.host() {
        Some(url::Host::Ipv4(v4)) => Some(IpAddr::V4(v4)),
        Some(url::Host::Ipv6(v6)) => Some(IpAddr::V6(v6)),
        _ => None,
    };
    if let Some(ip) = literal
        && !is_public_ip(ip)
    {
        return Err(format!(
            "'{s}' points at a private or reserved IP address; webhooks must reach a public server"
        ));
    }
    Ok(u)
}

/// The SSRF guard refused a webhook host name (ACCOUNTS_WEBHOOK_ALLOW_PRIVATE=false): it has no
/// address a webhook may be sent to.
///
/// Its message is stored where the app owner (or the Silicon) reads it, a delivery's
/// `last_error`, so it never names the addresses the host resolved to, nor whether the name
/// resolved at all: either would let anyone who can set a webhook URL map the service's internal
/// DNS. [`BlockedAddress::ip`] and [`BlockedAddress::lookup_error`] carry the details for the
/// server log.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlockedAddress {
    pub host: String,
    /// The first address that isn't [public](is_public_ip); `None` when the name didn't resolve.
    pub ip: Option<IpAddr>,
    /// Why the name didn't resolve, when it didn't.
    pub lookup_error: Option<String>,
}

impl fmt::Display for BlockedAddress {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "the webhook host '{}' has no public address (it doesn't resolve, or it resolves to a private or reserved address); webhooks must reach a public server",
            self.host
        )
    }
}

impl std::error::Error for BlockedAddress {}

/// DNS lookup failure with the host name in the message (only while private targets are
/// allowed, in development; with the SSRF guard on, a lookup failure is a [`BlockedAddress`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LookupFailed {
    pub host: String,
    pub message: String,
}

impl fmt::Display for LookupFailed {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "the webhook host '{}' could not be resolved ({})",
            self.host, self.message
        )
    }
}

impl std::error::Error for LookupFailed {}

/// Resolves a webhook `host` (the SSRF guard at delivery time). Unless `allow_private`
/// (ACCOUNTS_WEBHOOK_ALLOW_PRIVATE), refuses it with a [`BlockedAddress`] when it doesn't resolve
/// or when *any* of its addresses isn't [public](is_public_ip). The caller must connect to
/// exactly the returned addresses (the worker's HTTP client uses this as its DNS resolver), so
/// DNS rebinding can't slip between the check and the request. The port of the returned
/// addresses is 0 (the connector applies the URL's port).
pub async fn resolve_checked(
    host: &str,
    allow_private: bool,
) -> Result<Vec<std::net::SocketAddr>, Box<dyn std::error::Error + Send + Sync>> {
    let host = host.trim_start_matches('[').trim_end_matches(']');
    let resolved = tokio::net::lookup_host((host, 0))
        .await
        .map(|addrs| addrs.collect::<Vec<std::net::SocketAddr>>())
        .map_err(|e| e.to_string())
        .and_then(|addrs| {
            if addrs.is_empty() {
                Err("no addresses".to_string())
            } else {
                Ok(addrs)
            }
        });
    if allow_private {
        return resolved.map_err(|message| {
            Box::new(LookupFailed {
                host: host.to_string(),
                message,
            }) as Box<dyn std::error::Error + Send + Sync>
        });
    }
    let refused = |ip: Option<IpAddr>, lookup_error: Option<String>| {
        Box::new(BlockedAddress {
            host: host.to_string(),
            ip,
            lookup_error,
        }) as Box<dyn std::error::Error + Send + Sync>
    };
    match resolved {
        Err(message) => Err(refused(None, Some(message))),
        Ok(addrs) => match addrs.iter().find(|a| !is_public_ip(a.ip())) {
            Some(bad) => Err(refused(Some(bad.ip()), None)),
            None => Ok(addrs),
        },
    }
}

/// True for addresses a webhook may be sent to while private targets are refused: globally
/// routable unicast.
///
/// IPv4: not private, loopback, link-local, CGNAT (100.64/10), benchmarking (198.18/15),
/// documentation, IETF protocol assignments (192.0.0/24), broadcast, multicast, unspecified,
/// `0/8` or reserved (240/4).
///
/// IPv6 is judged strictly, because some IPv6 forms carry an IPv4 address that a dual-stack
/// host, a NAT64 gateway or a 6to4 relay delivers to — a way into private IPv4 networks:
/// - IPv4-mapped `::ffff:a.b.c.d`, NAT64 `64:ff9b::a.b.c.d` (RFC 6052) and 6to4
///   `2002:aabb:ccdd::/48` (RFC 3056) count as the IPv4 address they carry;
/// - anything else outside global unicast `2000::/3` is refused: IPv4-compatible `::/96`,
///   IPv4-translated `::ffff:0:0:0/96`, local-use NAT64 `64:ff9b:1::/48`, discard-only
///   `100::/64`, unique-local, link-local, site-local `fec0::/10`, multicast, loopback,
///   unspecified;
/// - inside `2000::/3`, `2001::/23` (IETF protocol assignments: Teredo, benchmarking, ORCHID)
///   and the documentation ranges `2001:db8::/32` and `3fff::/20` are refused.
pub fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_public_v4(v4),
        IpAddr::V6(v6) => is_public_v6(v6),
    }
}

fn is_public_v4(v4: std::net::Ipv4Addr) -> bool {
    let o = v4.octets();
    !(v4.is_private()
        || v4.is_loopback()
        || v4.is_link_local()
        || v4.is_broadcast()
        || v4.is_documentation()
        || v4.is_unspecified()
        || v4.is_multicast()
        || o[0] == 0
        || (o[0] == 100 && (64..=127).contains(&o[1]))
        || (o[0] == 192 && o[1] == 0 && o[2] == 0)
        || (o[0] == 198 && (18..=19).contains(&o[1]))
        || o[0] >= 240)
}

fn is_public_v6(v6: std::net::Ipv6Addr) -> bool {
    use std::net::Ipv4Addr;
    if let Some(v4) = v6.to_ipv4_mapped() {
        return is_public_v4(v4);
    }
    let s = v6.segments();
    let o = v6.octets();
    if s[..6] == [0x0064, 0xff9b, 0, 0, 0, 0] {
        return is_public_v4(Ipv4Addr::new(o[12], o[13], o[14], o[15]));
    }
    if s[0] & 0xe000 != 0x2000 {
        return false;
    }
    if s[0] == 0x2002 {
        return is_public_v4(Ipv4Addr::new(o[2], o[3], o[4], o[5]));
    }
    let ietf_protocol = s[0] == 0x2001 && s[1] < 0x0200;
    let documentation = (s[0] == 0x2001 && s[1] == 0x0db8) || (s[0] == 0x3fff && s[1] < 0x1000);
    !ietf_protocol && !documentation
}

/// Display-name suggestion from an email: local part split on `. _ - +`, title-cased.
pub fn display_name_from_email(email: &str) -> String {
    let local = email.split('@').next().unwrap_or("");
    let words: Vec<String> = local
        .split(['.', '_', '-', '+'])
        .filter(|w| !w.is_empty())
        .map(|w| {
            let mut cs = w.chars();
            match cs.next() {
                Some(f) => f.to_uppercase().collect::<String>() + &cs.as_str().to_lowercase(),
                None => String::new(),
            }
        })
        .collect();
    let name = words.join(" ");
    if name.is_empty() {
        "Carbon".into()
    } else {
        name.chars().take(100).collect()
    }
}

/// Display-name suggestion from a phone: `Carbon 1234` (last four digits).
pub fn display_name_from_phone(phone: &str) -> String {
    let digits: String = phone.chars().filter(|c| c.is_ascii_digit()).collect();
    let tail = &digits[digits.len().saturating_sub(4)..];
    format!("Carbon {tail}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::macros::date;

    #[test]
    fn email_table() {
        let ok = [
            (" Saket.Dev+1@Gmail.COM ", "saket.dev+1@gmail.com"),
            ("a@b.co", "a@b.co"),
            ("x_y@sub.example.test", "x_y@sub.example.test"),
            ("a@xn--p1ai.xn--p1ai", "a@xn--p1ai.xn--p1ai"),
        ];
        for (i, o) in ok {
            assert_eq!(normalize_email(i).as_deref(), Ok(o), "{i}");
        }
        let bad = [
            ("", "empty"),
            ("saket", "no '@'"),
            ("a@b@c.com", "more than one"),
            ("@example.com", "nothing comes before"),
            ("a@", "nothing comes after"),
            ("a@localhost", "no dot"),
            ("a..b@example.com", "double dot"),
            ("a b@example.com", "whitespace"),
            ("josé@example.com", "non-ASCII"),
            ("a@exa_mple.com", "'_' is not allowed in the domain"),
            ("a@example.c", "top-level domain"),
            ("a@-example.com", "starts or ends with '-'"),
        ];
        for (i, frag) in bad {
            let e = normalize_email(i).expect_err(i);
            assert_eq!(e.code, "invalid_email");
            assert!(e.message.contains(frag), "{i}: {}", e.message);
        }
        assert_eq!(mask_email("saket@gmail.com"), "s***@gmail.com");
        assert_eq!(email_domain("a@b.test"), "b.test");
    }

    #[test]
    fn phone_table() {
        assert_eq!(
            normalize_phone("+91 98765 43210", None).as_deref(),
            Ok("+919876543210")
        );
        assert_eq!(
            normalize_phone("098765 43210", Some("in")).as_deref(),
            Ok("+919876543210")
        );
        assert_eq!(
            normalize_phone("(415) 555-2671", Some("US")).as_deref(),
            Ok("+14155552671")
        );
        assert_eq!(
            normalize_phone("0044 20 7946 0958", None).as_deref(),
            Ok("+442079460958")
        );
        assert_eq!(
            normalize_phone("+1 415 555 2671", Some("IN")).as_deref(),
            Ok("+14155552671")
        );
        let e = normalize_phone("9876543210", None).expect_err("no country");
        assert!(e.message.contains("no country code"), "{}", e.message);
        let e = normalize_phone("12345", Some("IN")).expect_err("short");
        assert_eq!(e.code, "invalid_phone");
        let e = normalize_phone("98765", Some("ZZ")).expect_err("country");
        assert_eq!(e.code, "invalid_country");
        let e = normalize_phone("+91 98765abc", None).expect_err("letters");
        assert!(e.message.contains("'a' is not allowed"));
        assert_eq!(mask_phone("+919876543210"), "+91******3210");
    }

    #[test]
    fn timezone_table() {
        assert_eq!(
            normalize_timezone("asia/kolkata").as_deref(),
            Ok("Asia/Kolkata")
        );
        assert_eq!(normalize_timezone("UTC").as_deref(), Ok("UTC"));
        assert_eq!(
            normalize_timezone(" America/New_York ").as_deref(),
            Ok("America/New_York")
        );
        assert!(normalize_timezone("Mars/Olympus").is_err());
        assert!(normalize_timezone("+05:30").is_err());
    }

    #[test]
    fn names_and_dates() {
        assert_eq!(validate_display_name("  Saket  ").as_deref(), Ok("Saket"));
        assert!(validate_display_name("   ").is_err());
        assert!(validate_display_name(&"x".repeat(101)).is_err());
        assert!(validate_display_name("a\nb").is_err());
        let today = date!(2026 - 10 - 06);
        assert_eq!(default_dob(today), date!(2008 - 10 - 06));
        assert_eq!(default_dob(date!(2028 - 02 - 29)), date!(2010 - 02 - 28));
        assert!(validate_dob(date!(1899 - 12 - 31), today).is_err());
        assert!(validate_dob(date!(1900 - 01 - 01), today).is_ok());
        assert!(validate_dob(today, today).is_err());
        assert_eq!(parse_date_flexible("2000-01-31"), Ok(date!(2000 - 01 - 31)));
        assert_eq!(parse_date_flexible("2000/01/31"), Ok(date!(2000 - 01 - 31)));
        assert_eq!(parse_date_flexible("31/01/2000"), Ok(date!(2000 - 01 - 31)));
        assert_eq!(parse_date_flexible("01/31/2000"), Ok(date!(2000 - 01 - 31)));
        assert_eq!(parse_date_flexible("05/05/2000"), Ok(date!(2000 - 05 - 05)));
        assert!(
            parse_date_flexible("03/04/2000")
                .expect_err("ambiguous")
                .contains("ambiguous")
        );
        assert!(parse_date_flexible("2001-02-29").is_err());
        assert!(parse_date_flexible("yesterday").is_err());
    }

    #[test]
    fn urls() {
        let settings = Settings::for_tests();
        assert!(validate_https_url("https://iris.teamofsilicons.com/pfp/carbon?id=a8K").is_ok());
        assert!(validate_https_url("http://example.com/x.png").is_err());
        assert!(validate_https_url("https://user:pw@example.com/").is_err());
        // Short input whose stored (percent-encoded) form is over the limit.
        let wide = format!("https://example.com/{}", "\u{00e9}".repeat(1000));
        assert!(wide.len() <= MAX_URL_LEN);
        let e = validate_https_url(&wide).expect_err("encoded too long");
        assert!(e.contains("once encoded"), "{e}");
        let photo = format!(
            "{}0190f0f0-0000-7000-8000-000000000001",
            crate::pfp::photo_url_prefix(&settings)
        );
        assert_eq!(
            validate_pfp_url(&settings, &photo).as_deref(),
            Ok(photo.as_str())
        );
        let e = validate_pfp_url(&settings, &format!("{photo}?v=2")).expect_err("inexact");
        assert!(e.contains(&photo), "{e}");
        assert!(validate_pfp_url(&settings, "http://localhost:8590/v1/photos/0190").is_err());
        assert!(validate_pfp_url(&settings, "http://localhost:9999/x.png").is_err());
        assert!(
            validate_webhook_url(&settings, "http://127.0.0.1:8593/briefcase/webhooks").is_ok()
        );
        let mut prod = Settings::for_tests();
        prod.webhook_allow_private = false;
        assert!(validate_webhook_url(&prod, "http://hooks.example.com/x").is_err());
        assert!(validate_webhook_url(&prod, "https://127.0.0.1/x").is_err());
        assert!(validate_webhook_url(&prod, "https://10.1.2.3/x").is_err());
        assert!(validate_webhook_url(&prod, "https://0x7f.1/x").is_err());
        assert!(validate_webhook_url(&prod, "https://[::1]/x").is_err());
        assert!(validate_webhook_url(&prod, "https://[64:ff9b::a00:1]/x").is_err());
        assert!(validate_webhook_url(&prod, "https://[2002:a00:1::1]/x").is_err());
        assert!(validate_webhook_url(&prod, "https://[::a00:1]/x").is_err());
        assert!(validate_webhook_url(&prod, "https://localhost/x").is_err());
        assert!(validate_webhook_url(&prod, "https://hooks.example.com/x").is_ok());
        assert!(validate_webhook_url(&prod, "https://[2606:4700:4700::1111]/x").is_ok());
    }

    #[test]
    fn public_addresses() {
        let refused = [
            "10.0.0.1",
            "127.0.0.1",
            "169.254.169.254",
            "100.64.0.1",
            "0.0.0.0",
            "192.0.0.8",
            "192.0.2.1",
            "198.18.0.1",
            "224.0.0.1",
            "240.0.0.1",
            "255.255.255.255",
            "::",
            "::1",
            "::127.0.0.1",        // IPv4-compatible loopback
            "::a00:1",            // IPv4-compatible 10.0.0.1
            "::ffff:127.0.0.1",   // IPv4-mapped loopback
            "::ffff:10.0.0.1",    // IPv4-mapped private
            "::ffff:0:7f00:1",    // IPv4-translated (SIIT) loopback
            "64:ff9b::a9fe:a9fe", // NAT64 of 169.254.169.254
            "64:ff9b::a00:1",     // NAT64 of 10.0.0.1
            "64:ff9b:1::808:808", // local-use NAT64 prefix
            "2002:7f00:1::",      // 6to4 of 127.0.0.1
            "2002:a00:1::1",      // 6to4 of 10.0.0.1
            "2001::1",            // Teredo
            "2001:2::1",          // benchmarking
            "2001:10::1",         // ORCHID
            "2001:20::1",         // ORCHIDv2
            "2001:db8::1",        // documentation
            "3fff::1",            // documentation (RFC 9637)
            "100::1",             // discard-only
            "5f00::1",            // SRv6 SIDs
            "fc00::1",            // unique-local
            "fd12:3456::1",       // unique-local
            "fe80::1",            // link-local
            "fec0::1",            // site-local (deprecated)
            "ff02::1",            // multicast
        ];
        for ip in refused {
            let parsed: IpAddr = ip.parse().expect(ip);
            assert!(!is_public_ip(parsed), "{ip} must be refused");
        }
        let allowed = [
            "8.8.8.8",
            "1.1.1.1",
            "2606:4700:4700::1111",
            "2001:4860:4860::8888",
            "2a00:1450:4001::64",
            "64:ff9b::808:808", // NAT64 of 8.8.8.8
            "::ffff:8.8.8.8",   // IPv4-mapped 8.8.8.8
            "2002:808:808::1",  // 6to4 of 8.8.8.8
        ];
        for ip in allowed {
            let parsed: IpAddr = ip.parse().expect(ip);
            assert!(is_public_ip(parsed), "{ip} must be allowed");
        }
    }

    #[tokio::test]
    async fn resolving_webhook_hosts() {
        let addrs = resolve_checked("localhost", true)
            .await
            .expect("dev allows loopback");
        assert!(!addrs.is_empty());
        let err = resolve_checked("localhost", false)
            .await
            .expect_err("loopback refused");
        let blocked = err
            .downcast_ref::<BlockedAddress>()
            .expect("a BlockedAddress error");
        assert!(blocked.ip.is_some_and(|ip| ip.is_loopback()));
        assert!(
            !err.to_string().contains("127.0.0.1") && !err.to_string().contains("::1"),
            "the stored text never names the address: {err}"
        );
        assert!(resolve_checked("127.0.0.1", false).await.is_err());
        // A name that doesn't resolve reads like a private one under the guard.
        let err = resolve_checked("does-not-exist.invalid", false)
            .await
            .expect_err("no address");
        let blocked = err
            .downcast_ref::<BlockedAddress>()
            .expect("a BlockedAddress error");
        assert!(blocked.ip.is_none() && blocked.lookup_error.is_some());
        let dev = resolve_checked("does-not-exist.invalid", true)
            .await
            .expect_err("does not resolve");
        assert!(dev.to_string().contains("could not be resolved"), "{dev}");
    }

    #[test]
    fn suggestions() {
        assert_eq!(
            display_name_from_email("saket.dev+12@gmail.com"),
            "Saket Dev 12"
        );
        assert_eq!(display_name_from_email("JOHN_smith@x.com"), "John Smith");
        assert_eq!(display_name_from_phone("+919876543210"), "Carbon 3210");
    }
}
