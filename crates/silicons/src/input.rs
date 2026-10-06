//! Input rules shared by the handlers. Every check reports exactly what is wrong; field problems
//! are collected into [`FieldErrors`] (422 `validation_failed`, `details.fields`), while a bad
//! id is its own 422 `invalid_id` (with `details.reason`), like everywhere else in the API.

use accounts_core::crypto::stk;
use accounts_core::error::FieldErrors;
use accounts_core::ids::AccountId;
use accounts_core::models::AccountKind;
use accounts_core::normalize;
use accounts_core::repo::accounts;
use accounts_core::{ApiError, Settings};
use serde::{Deserialize, Deserializer};

/// Timezone used when neither the request nor the caller's network says one.
pub const DEFAULT_TIMEZONE: &str = "UTC";

/// Records `result`'s error under `field` and returns the value when it is valid.
pub fn check<T>(fields: &mut FieldErrors, field: &str, result: Result<T, String>) -> Option<T> {
    match result {
        Ok(v) => Some(v),
        Err(problem) => {
            fields.add(field, problem);
            None
        }
    }
}

/// A Silicon id (`si:scout`; a bare `scout` gets the prefix). 422 `invalid_id` otherwise.
pub fn silicon_id(input: &str) -> Result<AccountId, ApiError> {
    AccountId::parse_for_kind(input, AccountKind::Silicon)
        .map_err(|e| accounts::invalid_id_error(&e))
}

/// A display name: trimmed, 1..=100 characters, no control characters.
pub fn display_name(input: &str) -> Result<String, String> {
    normalize::validate_display_name(input)
}

/// An IANA timezone; when absent, the caller's network timezone, else UTC.
pub fn timezone(input: Option<&str>, network_default: Option<&str>) -> Result<String, String> {
    match input {
        Some(tz) => normalize::normalize_timezone(tz),
        None => Ok(network_default
            .and_then(|tz| normalize::normalize_timezone(tz).ok())
            .unwrap_or_else(|| DEFAULT_TIMEZONE.to_string())),
    }
}

/// A profile photo URL (https, or a photo served by this service). `None` = the Iris default.
pub fn pfp_url(settings: &Settings, input: Option<&str>) -> Result<Option<String>, String> {
    match input {
        None => Ok(None),
        Some(url) => normalize::validate_pfp_url(settings, url).map(Some),
    }
}

/// A self-chosen STK (`stk-` + 8..32 hex; the bare hex is accepted). `None` = generate one.
pub fn chosen_stk(input: Option<&str>) -> Result<Option<String>, String> {
    match input {
        None => Ok(None),
        Some(s) => stk::normalize(s).map(Some),
    }
}

/// A webhook URL (https in production; http and private hosts only when the service allows it).
pub fn webhook_url(settings: &Settings, input: Option<&str>) -> Result<Option<String>, String> {
    match input {
        None => Ok(None),
        Some(s) if s.trim().is_empty() => Err(
            "is empty; leave webhook_url out for no webhook, or pass an https URL like https://example.com/webhooks"
                .into(),
        ),
        Some(s) => normalize::validate_webhook_url(settings, s).map(|u| Some(u.to_string())),
    }
}

/// A Carbon named as custodian (self-create) or as the receiver of a transfer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CarbonTarget {
    /// By its `c:` id (a bare handle gets the prefix).
    Id(AccountId),
    /// By an email address (normalized), which may not have an account yet.
    Email(String),
}

impl CarbonTarget {
    /// Parses `c:saket`, `saket` or `saket@example.com`.
    pub fn parse(input: &str) -> Result<CarbonTarget, String> {
        let s = input.trim();
        if s.is_empty() {
            return Err(
                "is empty; name the Carbon by its c:id (like c:saket) or by an email address"
                    .into(),
            );
        }
        if s.contains('@') {
            return normalize::normalize_email(s)
                .map(CarbonTarget::Email)
                .map_err(|e| e.message);
        }
        AccountId::parse_for_kind(s, AccountKind::Carbon)
            .map(CarbonTarget::Id)
            .map_err(|e| format!("{e} {}", e.hint()))
    }
}

/// Deserializes a field that may be absent (`None`), `null` (`Some(None)`) or a value.
pub fn double_option<'de, D, T>(d: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(d).map(Some)
}

/// A free-text client label (CLI name, machine): trimmed, control characters dropped, at most
/// 100 characters; empty means none.
pub fn client_label(input: Option<&str>) -> Option<String> {
    let label: String = input?
        .chars()
        .filter(|c| !c.is_control())
        .collect::<String>()
        .trim()
        .chars()
        .take(100)
        .collect();
    (!label.is_empty()).then_some(label)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn carbon_targets() {
        assert_eq!(
            CarbonTarget::parse(" C:Saket "),
            Ok(CarbonTarget::Id(
                AccountId::parse("c:saket").expect("valid id")
            ))
        );
        assert_eq!(
            CarbonTarget::parse("saket"),
            Ok(CarbonTarget::Id(
                AccountId::parse("c:saket").expect("valid id")
            ))
        );
        assert_eq!(
            CarbonTarget::parse("Saket@Example.COM"),
            Ok(CarbonTarget::Email("saket@example.com".into()))
        );
        let e = CarbonTarget::parse("si:scout").expect_err("a Silicon can't be a custodian");
        assert!(e.contains("Carbon"), "{e}");
        assert!(CarbonTarget::parse("").is_err());
        assert!(CarbonTarget::parse("not an@email").is_err());
    }

    #[test]
    fn timezones_default_to_the_network_then_utc() {
        assert_eq!(timezone(None, None).as_deref(), Ok("UTC"));
        assert_eq!(
            timezone(None, Some("asia/kolkata")).as_deref(),
            Ok("Asia/Kolkata")
        );
        assert_eq!(timezone(None, Some("Mars/Base")).as_deref(), Ok("UTC"));
        assert_eq!(
            timezone(Some("europe/berlin"), Some("Asia/Kolkata")).as_deref(),
            Ok("Europe/Berlin")
        );
        assert!(timezone(Some("Nowhere/Land"), None).is_err());
    }

    #[test]
    fn stks_and_labels() {
        assert_eq!(chosen_stk(None), Ok(None));
        assert_eq!(
            chosen_stk(Some("ABCDEF12")),
            Ok(Some("stk-abcdef12".to_string()))
        );
        assert!(chosen_stk(Some("stk-xyz")).is_err());
        assert_eq!(
            client_label(Some("  mac\n cli  ")).as_deref(),
            Some("mac cli")
        );
        assert_eq!(client_label(Some("   ")), None);
        assert_eq!(
            client_label(Some(&"x".repeat(300))).map(|l| l.len()),
            Some(100)
        );
    }

    #[test]
    fn silicon_ids() {
        assert_eq!(
            silicon_id("Scout").expect("bare handle").to_string(),
            "si:scout"
        );
        let e = silicon_id("c:scout").expect_err("wrong kind");
        assert_eq!(e.code, "invalid_id");
        let e = silicon_id("si:admin").expect_err("reserved");
        assert_eq!(e.details["reason"], "reserved_word");
    }
}
