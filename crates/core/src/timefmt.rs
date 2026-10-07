//! Time helpers and serde formats.
//!
//! The API writes timestamps as RFC 3339 UTC with exactly three fractional digits
//! (`2026-10-06T12:00:00.000Z`) and dates as `YYYY-MM-DD`. The `time` crate's own serde impls
//! (with `serde-human-readable`) use a different format, so every timestamp field in a view must
//! use `#[serde(with = "accounts_core::timefmt::rfc3339_ms")]` (or `rfc3339_ms_option`), and every
//! date field `#[serde(with = "accounts_core::timefmt::date")]` (or `date_option`).

use time::format_description::well_known::Rfc3339;
use time::macros::format_description;
use time::{Date, OffsetDateTime, UtcOffset};

/// Current UTC time from the application clock. Prefer Postgres `now()` for TTL checks.
pub fn now() -> OffsetDateTime {
    OffsetDateTime::now_utc()
}

/// Formats as `2026-10-06T12:00:00.000Z` (UTC, millisecond precision).
pub fn format_rfc3339_ms(t: OffsetDateTime) -> String {
    let t = t.to_offset(UtcOffset::UTC);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        t.year(),
        u8::from(t.month()),
        t.day(),
        t.hour(),
        t.minute(),
        t.second(),
        t.millisecond()
    )
}

/// Parses any RFC 3339 timestamp (any offset, any precision).
pub fn parse_rfc3339(s: &str) -> Result<OffsetDateTime, String> {
    OffsetDateTime::parse(s.trim(), &Rfc3339).map_err(|e| {
        format!("'{s}' is not an RFC 3339 timestamp like 2026-10-06T12:00:00.000Z ({e})")
    })
}

/// Formats a date as `YYYY-MM-DD`.
pub fn format_date(d: Date) -> String {
    format!("{:04}-{:02}-{:02}", d.year(), u8::from(d.month()), d.day())
}

/// Parses a strict `YYYY-MM-DD` date.
pub fn parse_date(s: &str) -> Result<Date, String> {
    let format = format_description!("[year]-[month]-[day]");
    Date::parse(s.trim(), &format)
        .map_err(|_| format!("'{s}' is not a date in YYYY-MM-DD format (for example 2000-01-31)"))
}

/// Today's date in UTC.
pub fn today_utc() -> Date {
    now().date()
}

/// The calendar date at `at` in the IANA timezone `timezone` (`Asia/Kolkata`, `UTC`…). A name that
/// is not a timezone gives the UTC date.
pub fn date_in(at: OffsetDateTime, timezone: &str) -> Date {
    use chrono::{Offset, TimeZone};
    let utc_date = at.to_offset(UtcOffset::UTC).date();
    let Ok(tz) = timezone.trim().parse::<chrono_tz::Tz>() else {
        return utc_date;
    };
    let Some(instant) = chrono::DateTime::from_timestamp(at.unix_timestamp(), 0) else {
        return utc_date;
    };
    let seconds = tz
        .offset_from_utc_datetime(&instant.naive_utc())
        .fix()
        .local_minus_utc();
    match UtcOffset::from_whole_seconds(seconds) {
        Ok(offset) => at.to_offset(offset).date(),
        Err(_) => utc_date,
    }
}

/// Today's date for someone in the IANA timezone `timezone` (UTC for a name that is not one).
pub fn today_in(timezone: &str) -> Date {
    date_in(now(), timezone)
}

/// Serde: `OffsetDateTime` as RFC 3339 UTC with milliseconds.
pub mod rfc3339_ms {
    use serde::{Deserialize, Deserializer, Serializer};
    use time::OffsetDateTime;

    pub fn serialize<S: Serializer>(t: &OffsetDateTime, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&super::format_rfc3339_ms(*t))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<OffsetDateTime, D::Error> {
        let s = String::deserialize(d)?;
        super::parse_rfc3339(&s).map_err(serde::de::Error::custom)
    }
}

/// Serde: `Option<OffsetDateTime>` as RFC 3339 UTC with milliseconds, or `null`.
pub mod rfc3339_ms_option {
    use serde::{Deserialize, Deserializer, Serializer};
    use time::OffsetDateTime;

    pub fn serialize<S: Serializer>(t: &Option<OffsetDateTime>, s: S) -> Result<S::Ok, S::Error> {
        match t {
            Some(t) => s.serialize_str(&super::format_rfc3339_ms(*t)),
            None => s.serialize_none(),
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(
        d: D,
    ) -> Result<Option<OffsetDateTime>, D::Error> {
        let s = Option::<String>::deserialize(d)?;
        match s {
            Some(s) => super::parse_rfc3339(&s)
                .map(Some)
                .map_err(serde::de::Error::custom),
            None => Ok(None),
        }
    }
}

/// Serde: `Date` as `YYYY-MM-DD`.
pub mod date {
    use serde::{Deserialize, Deserializer, Serializer};
    use time::Date;

    pub fn serialize<S: Serializer>(d: &Date, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&super::format_date(*d))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Date, D::Error> {
        let s = String::deserialize(d)?;
        super::parse_date(&s).map_err(serde::de::Error::custom)
    }
}

/// Serde: `Option<Date>` as `YYYY-MM-DD`, or `null`.
pub mod date_option {
    use serde::{Deserialize, Deserializer, Serializer};
    use time::Date;

    pub fn serialize<S: Serializer>(d: &Option<Date>, s: S) -> Result<S::Ok, S::Error> {
        match d {
            Some(d) => s.serialize_str(&super::format_date(*d)),
            None => s.serialize_none(),
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Date>, D::Error> {
        let s = Option::<String>::deserialize(d)?;
        match s {
            Some(s) => super::parse_date(&s)
                .map(Some)
                .map_err(serde::de::Error::custom),
            None => Ok(None),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::macros::{date, datetime};

    #[test]
    fn formats_milliseconds_in_utc() {
        let t = datetime!(2026-10-06 17:30:00.123456 +05:30);
        assert_eq!(format_rfc3339_ms(t), "2026-10-06T12:00:00.123Z");
        assert_eq!(
            format_rfc3339_ms(datetime!(2026-10-06 12:00 UTC)),
            "2026-10-06T12:00:00.000Z"
        );
    }

    #[test]
    fn dates_follow_the_timezone() {
        // 20:34 UTC on 6 October is already 7 October in Kolkata and still 6 October in Los Angeles.
        let at = datetime!(2026-10-06 20:34 UTC);
        assert_eq!(date_in(at, "Asia/Kolkata"), date!(2026 - 10 - 07));
        assert_eq!(date_in(at, "America/Los_Angeles"), date!(2026 - 10 - 06));
        assert_eq!(date_in(at, "UTC"), date!(2026 - 10 - 06));
        // Just after midnight UTC it is still the previous day west of Greenwich.
        let early = datetime!(2026-10-07 00:30 UTC);
        assert_eq!(date_in(early, "America/New_York"), date!(2026 - 10 - 06));
        assert_eq!(date_in(early, "Pacific/Kiritimati"), date!(2026 - 10 - 07));
        // Not a timezone: the UTC date.
        assert_eq!(date_in(at, "Mars/Olympus_Mons"), date!(2026 - 10 - 06));
        assert_eq!(date_in(at, ""), date!(2026 - 10 - 06));
    }

    #[test]
    fn parses_rfc3339_and_dates() {
        let t = parse_rfc3339("2026-10-06T12:00:00.000Z").expect("parse");
        assert_eq!(t, datetime!(2026-10-06 12:00 UTC));
        assert!(parse_rfc3339("yesterday").is_err());
        assert_eq!(
            parse_date("2008-02-29").expect("date"),
            date!(2008 - 02 - 29)
        );
        assert!(parse_date("2007-02-29").is_err());
        assert!(parse_date("06/10/2026").is_err());
        assert_eq!(format_date(date!(2008 - 02 - 09)), "2008-02-09");
    }
}
