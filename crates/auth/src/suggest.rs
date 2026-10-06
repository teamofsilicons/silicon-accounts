//! Sign-up prefill rules (UNDERSTANDING.md "Sign up": everything must already be filled in).
//!
//! - display name: the provider's name, else the email's local part split on `. _ - +` and
//!   title-cased, else `Carbon 1234` from the phone's last four digits;
//! - id: from the email's local part, then from the display name, with `-2`, `-3`… (random
//!   digits after 20 tries) until available (`repo::accounts::suggest_id`);
//! - timezone: the first valid IANA timezone from the IP headers, else the browser's, else UTC;
//! - date of birth: exactly 18 years ago (Feb 29 → Feb 28);
//! - photo: our default Carbon photo from Iris (a Google picture is only offered alongside it,
//!   `signup.provider_pfp_url`).

use accounts_core::Settings;
use accounts_core::models::AccountKind;
use accounts_core::normalize::{
    default_dob, display_name_from_email, display_name_from_phone, normalize_timezone,
    validate_display_name,
};
use time::Date;

/// The suggested display name.
pub fn display_name(
    provider_name: Option<&str>,
    email: Option<&str>,
    phone: Option<&str>,
) -> String {
    if let Some(name) = provider_name.and_then(|n| validate_display_name(n).ok()) {
        return name;
    }
    if let Some(e) = email {
        return display_name_from_email(e);
    }
    if let Some(p) = phone {
        return display_name_from_phone(p);
    }
    "Carbon".to_string()
}

/// The suggested timezone: IP headers, then the browser's `Intl` timezone, then UTC.
pub fn timezone(ip_timezone: Option<&str>, browser_timezone: Option<&str>) -> String {
    ip_timezone
        .and_then(|t| normalize_timezone(t).ok())
        .or_else(|| browser_timezone.and_then(|t| normalize_timezone(t).ok()))
        .unwrap_or_else(|| "UTC".to_string())
}

/// The suggested date of birth: today minus 18 years.
pub fn dob(today: Date) -> Date {
    default_dob(today)
}

/// Seeds for the id suggestion, in order: the email's local part, then the display name.
pub fn id_seeds<'a>(email: Option<&'a str>, display_name: &'a str) -> Vec<&'a str> {
    let mut seeds = Vec::with_capacity(2);
    if let Some(local) = email
        .and_then(|e| e.split('@').next())
        .filter(|l| !l.is_empty())
    {
        seeds.push(local);
    }
    seeds.push(display_name);
    seeds
}

/// The Iris default photo shown on the sign-up page before the account exists. The real
/// default is keyed by the new account's uuid, so a submitted Iris default (this one or any
/// other) is stored as the new account's own default.
pub fn default_pfp_preview(settings: &Settings) -> String {
    accounts_core::pfp::default_pfp_url(&settings.iris_base_url, AccountKind::Carbon, "new")
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::macros::date;

    #[test]
    fn display_names() {
        assert_eq!(
            display_name(Some("  Ada Lovelace "), None, None),
            "Ada Lovelace"
        );
        assert_eq!(
            display_name(Some(""), Some("saket.dev+news@gmail.com"), None),
            "Saket Dev News"
        );
        assert_eq!(
            display_name(None, None, Some("+919876543210")),
            "Carbon 3210"
        );
        assert_eq!(display_name(Some("bad\nname"), None, None), "Carbon");
    }

    #[test]
    fn timezones_prefer_ip_then_browser() {
        assert_eq!(
            timezone(Some("asia/kolkata"), Some("Europe/Paris")),
            "Asia/Kolkata"
        );
        assert_eq!(
            timezone(Some("Mars/Base"), Some("Europe/Paris")),
            "Europe/Paris"
        );
        assert_eq!(timezone(None, Some("nope")), "UTC");
    }

    #[test]
    fn dob_is_exactly_18_years_ago() {
        assert_eq!(dob(date!(2026 - 10 - 06)), date!(2008 - 10 - 06));
        assert_eq!(dob(date!(2028 - 02 - 29)), date!(2010 - 02 - 28));
    }

    #[test]
    fn id_seed_order() {
        assert_eq!(
            id_seeds(Some("saket@x.com"), "Saket Dev"),
            vec!["saket", "Saket Dev"]
        );
        assert_eq!(id_seeds(None, "Carbon 3210"), vec!["Carbon 3210"]);
    }

    #[test]
    fn preview_is_an_iris_default() {
        let s = Settings::for_tests();
        let p = default_pfp_preview(&s);
        assert!(accounts_core::pfp::is_default_pfp(&s.iris_base_url, &p));
    }
}
