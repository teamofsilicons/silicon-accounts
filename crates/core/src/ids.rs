//! Account identifiers.
//!
//! - **uuid**: permanent, case-sensitive base62 (`a-z A-Z 0-9`). [`uuid_for_number`] maps the
//!   global sequence number `n` (from `account_number_seq`) to a uuid: tier `k` (length) is the
//!   smallest `k ≥ 3` with `n < Σ_{j=3..k} 62^j`; `i` is `n` minus the sizes of the smaller tiers;
//!   the uuid is `(i·A_k + B_k) mod 62^k` written as exactly `k` base62 digits. `A_k` is odd and not
//!   divisible by 31, so the map is a bijection on each tier: unique, never reused, random-looking,
//!   and each length is exhausted before the next starts. The constants below are fixed forever.
//! - **id**: `c:{handle}` (Carbon) / `si:{handle}` (Silicon), handle `[a-z0-9_-]{3,30}`,
//!   case-insensitive (stored lowercase). [`AccountId::parse`] explains precisely why an input is
//!   not a valid id.
//! - **membership id**: `{app_id}:{uuid}` ([`membership_id`]).

use std::fmt;

use rand::Rng;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::models::AccountKind;

/// The base62 alphabet, digit value = index.
pub const BASE62_ALPHABET: &[u8; 62] =
    b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/// (k, A_k, B_k) for tiers 3..=11 (tier 11 covers every non-negative i64). Never change these.
const TIERS: [(u32, u128, u128); 9] = [
    (3, 147_295, 98_718),
    (4, 9_132_277, 6_120_558),
    (5, 566_201_229, 379_474_643),
    (6, 35_104_476_159, 23_527_427_924),
    (7, 2_176_477_521_915, 1_458_700_531_342),
    (8, 134_941_606_358_707, 90_439_432_943_237),
    (9, 8_366_379_594_239_801, 5_607_244_842_480_723),
    (10, 518_715_534_842_867_663, 347_649_180_233_804_865),
    (11, 32_160_363_160_257_795_053, 21_554_249_174_495_901_634),
];

fn pow62(k: u32) -> u128 {
    62u128.pow(k)
}

fn digit_value(c: u8) -> Option<u128> {
    BASE62_ALPHABET
        .iter()
        .position(|&a| a == c)
        .map(|p| p as u128)
}

/// The uuid for sequence number `n` (see module docs).
pub fn uuid_for_number(n: u64) -> String {
    let mut offset: u128 = 0;
    let n = n as u128;
    for (k, a, b) in TIERS {
        let size = pow62(k);
        if n < offset + size {
            let i = n - offset;
            let scrambled = (mul_mod(i, a, size) + b) % size;
            return encode_base62(scrambled, k);
        }
        offset += size;
    }
    // Unreachable for u64 inputs below 62^3+..+62^11 (> u64::MAX is impossible: the sum exceeds
    // 2^64), but keep a deterministic answer instead of panicking.
    encode_base62(n, 12)
}

/// Inverse of [`uuid_for_number`]: the sequence number of a uuid, or `None` if it isn't one.
pub fn number_for_uuid(uuid: &str) -> Option<u64> {
    let bytes = uuid.as_bytes();
    let k = bytes.len() as u32;
    let mut offset: u128 = 0;
    for (tk, a, b) in TIERS {
        let size = pow62(tk);
        if tk == k {
            let mut scrambled: u128 = 0;
            for &c in bytes {
                scrambled = scrambled * 62 + digit_value(c)?;
            }
            let inv = mod_inverse(a, size)?;
            if scrambled >= size {
                return None;
            }
            let i = mul_mod((scrambled + size - b % size) % size, inv, size);
            return u64::try_from(offset + i).ok();
        }
        offset += size;
    }
    None
}

/// `(a * b) mod m` without overflow (m < 2^67).
fn mul_mod(a: u128, b: u128, m: u128) -> u128 {
    let (mut a, mut b) = (a % m, b % m);
    let mut result = 0u128;
    while b > 0 {
        if b & 1 == 1 {
            result = (result + a) % m;
        }
        a = (a << 1) % m;
        b >>= 1;
    }
    result
}

fn encode_base62(mut v: u128, k: u32) -> String {
    let mut out = vec![b'a'; k as usize];
    for slot in out.iter_mut().rev() {
        *slot = BASE62_ALPHABET[(v % 62) as usize];
        v /= 62;
    }
    String::from_utf8(out).unwrap_or_default()
}

fn mod_inverse(a: u128, m: u128) -> Option<u128> {
    // Extended Euclid on i128 (m ≤ 62^11 < 2^60, so products fit).
    let (mut old_r, mut r) = (a as i128, m as i128);
    let (mut old_s, mut s) = (1i128, 0i128);
    while r != 0 {
        let q = old_r / r;
        (old_r, r) = (r, old_r - q * r);
        (old_s, s) = (s, old_s - q * s);
    }
    if old_r != 1 {
        return None;
    }
    Some(old_s.rem_euclid(m as i128) as u128)
}

/// True when `s` looks like an account uuid (3+ base62 characters).
pub fn is_account_uuid(s: &str) -> bool {
    s.len() >= 3 && s.len() <= 12 && s.bytes().all(|c| c.is_ascii_alphanumeric())
}

/// `{app_id}:{uuid}`.
pub fn membership_id(app_id: &str, uuid: &str) -> String {
    format!("{app_id}:{uuid}")
}

/// Handles that can never be taken by a new id.
pub const RESERVED_HANDLES: &[&str] = &[
    "admin",
    "administrator",
    "root",
    "system",
    "support",
    "help",
    "security",
    "accounts",
    "account",
    "silicon",
    "silicons",
    "carbon",
    "carbons",
    "api",
    "www",
    "mail",
    "null",
    "undefined",
    "me",
    "owner",
    "staff",
];

/// True when the handle (without prefix, lowercase) is a reserved word.
pub fn is_reserved_handle(handle: &str) -> bool {
    RESERVED_HANDLES.contains(&handle)
}

pub const HANDLE_MIN: usize = 3;
pub const HANDLE_MAX: usize = 30;

/// Why a string is not a valid account id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IdError {
    Empty,
    MissingPrefix {
        input: String,
    },
    /// `x:scout`: a prefix, but not `c:` or `si:`. `prefix` includes the colon.
    UnknownPrefix {
        input: String,
        prefix: String,
    },
    WrongKind {
        input: String,
        expected: AccountKind,
    },
    TooShort {
        handle: String,
    },
    TooLong {
        handle: String,
    },
    InvalidChar {
        handle: String,
        ch: char,
        position: usize,
    },
    ReservedWord {
        handle: String,
    },
}

impl IdError {
    /// `invalid` or `reserved_word` (the `reason` of `GET /v1/ids/available`).
    pub fn reason(&self) -> &'static str {
        match self {
            IdError::ReservedWord { .. } => "reserved_word",
            _ => "invalid",
        }
    }

    /// What to do instead.
    pub fn hint(&self) -> String {
        match self {
            IdError::Empty | IdError::MissingPrefix { .. } | IdError::UnknownPrefix { .. } => {
                "Write the id as c:<handle> for a Carbon or si:<handle> for a Silicon, e.g. c:saket or si:scout.".into()
            }
            IdError::WrongKind { expected, .. } => {
                format!("Use the {} prefix, e.g. {}scout.", expected.prefix(), expected.prefix())
            }
            IdError::ReservedWord { .. } => "Pick another handle; reserved words can't be ids.".into(),
            _ => "A handle is 3 to 30 characters of a-z, 0-9, '-' and '_' (case-insensitive).".into(),
        }
    }
}

impl fmt::Display for IdError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            IdError::Empty => write!(f, "The id is empty."),
            IdError::MissingPrefix { input } => write!(
                f,
                "'{input}' has no prefix: ids start with c: (Carbons) or si: (Silicons)."
            ),
            IdError::UnknownPrefix { prefix, .. } => write!(
                f,
                "'{prefix}' is not an id prefix: ids start with c: (Carbons) or si: (Silicons)."
            ),
            IdError::WrongKind { input, expected } => {
                let other = match expected {
                    AccountKind::Carbon => "a Silicon",
                    AccountKind::Silicon => "a Carbon",
                };
                write!(
                    f,
                    "'{input}' is {other} id, but this must be {} id starting with {}.",
                    match expected {
                        AccountKind::Carbon => "a Carbon",
                        AccountKind::Silicon => "a Silicon",
                    },
                    expected.prefix()
                )
            }
            IdError::TooShort { handle } => write!(
                f,
                "The handle '{handle}' is {} character(s); it must be at least {HANDLE_MIN} (the prefix doesn't count).",
                handle.chars().count()
            ),
            IdError::TooLong { handle } => write!(
                f,
                "The handle '{handle}' is {} characters; it must be at most {HANDLE_MAX} (the prefix doesn't count).",
                handle.chars().count()
            ),
            IdError::InvalidChar {
                handle,
                ch,
                position,
            } => write!(
                f,
                "The handle '{handle}' contains {} at position {position}; only a-z, 0-9, '-' and '_' are allowed.",
                describe_char(*ch)
            ),
            IdError::ReservedWord { handle } => {
                write!(
                    f,
                    "'{handle}' is a reserved word and can't be used as an id."
                )
            }
        }
    }
}

impl std::error::Error for IdError {}

fn describe_char(c: char) -> String {
    match c {
        ' ' => "a space".into(),
        ':' => "':'".into(),
        c if c.is_control() => format!("a control character (U+{:04X})", c as u32),
        c if !c.is_ascii() => format!("'{c}' (non-ASCII, U+{:04X})", c as u32),
        c => format!("'{c}'"),
    }
}

/// `s` without `prefix` (an ASCII prefix, compared ASCII-case-insensitively).
fn strip_prefix_ascii<'a>(s: &'a str, prefix: &str) -> Option<&'a str> {
    let head = s.get(..prefix.len())?;
    head.eq_ignore_ascii_case(prefix)
        .then(|| &s[prefix.len()..])
}

/// Validates and lowercases a bare handle (no prefix). Reserved words are an error.
///
/// Every character is checked as written, before lowercasing: only ASCII letters (either case),
/// digits, `-` and `_` pass. Lowercasing is ASCII-only, so no non-ASCII character can fold into
/// an allowed one (U+212A KELVIN SIGN would otherwise become `k`).
pub fn validate_handle(handle: &str) -> Result<String, IdError> {
    let h = handle.trim();
    if h.is_empty() {
        return Err(IdError::Empty);
    }
    if let Some((i, ch)) = h
        .chars()
        .enumerate()
        .find(|(_, c)| !(c.is_ascii_alphanumeric() || *c == '-' || *c == '_'))
    {
        return Err(IdError::InvalidChar {
            handle: h.to_string(),
            ch,
            position: i + 1,
        });
    }
    let lower = h.to_ascii_lowercase();
    let len = lower.chars().count();
    if len < HANDLE_MIN {
        return Err(IdError::TooShort { handle: lower });
    }
    if len > HANDLE_MAX {
        return Err(IdError::TooLong { handle: lower });
    }
    if is_reserved_handle(&lower) {
        return Err(IdError::ReservedWord { handle: lower });
    }
    Ok(lower)
}

/// A valid account id: kind + lowercase handle. Displays/serializes as `c:saket` / `si:scout`.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct AccountId {
    kind: AccountKind,
    handle: String,
}

impl AccountId {
    /// Parses `c:<handle>` or `si:<handle>` (prefix case-insensitive, surrounding spaces trimmed).
    /// The handle is validated exactly as written ([`validate_handle`]).
    pub fn parse(input: &str) -> Result<AccountId, IdError> {
        let s = input.trim();
        if s.is_empty() {
            return Err(IdError::Empty);
        }
        let (kind, rest) = if let Some(rest) = strip_prefix_ascii(s, "c:") {
            (AccountKind::Carbon, rest)
        } else if let Some(rest) = strip_prefix_ascii(s, "si:") {
            (AccountKind::Silicon, rest)
        } else {
            return Err(match s.split_once(':') {
                Some((prefix, _))
                    if !prefix.is_empty()
                        && prefix.len() <= 16
                        && prefix
                            .chars()
                            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') =>
                {
                    IdError::UnknownPrefix {
                        input: s.to_string(),
                        prefix: format!("{prefix}:"),
                    }
                }
                _ => IdError::MissingPrefix {
                    input: s.to_string(),
                },
            });
        };
        let handle = validate_handle(rest)?;
        Ok(AccountId { kind, handle })
    }

    /// Parses an id that must be of `kind`. A bare handle gets `kind`'s prefix added.
    pub fn parse_for_kind(input: &str, kind: AccountKind) -> Result<AccountId, IdError> {
        let s = input.trim();
        if strip_prefix_ascii(s, "c:").is_some() || strip_prefix_ascii(s, "si:").is_some() {
            let id = AccountId::parse(s)?;
            if id.kind != kind {
                return Err(IdError::WrongKind {
                    input: s.to_string(),
                    expected: kind,
                });
            }
            return Ok(id);
        }
        let handle = validate_handle(s)?;
        Ok(AccountId { kind, handle })
    }

    /// Builds an id from a handle already known to be valid; validates again to be safe.
    pub fn new(kind: AccountKind, handle: &str) -> Result<AccountId, IdError> {
        Ok(AccountId {
            kind,
            handle: validate_handle(handle)?,
        })
    }

    pub fn kind(&self) -> AccountKind {
        self.kind
    }

    /// The handle without prefix (`saket`).
    pub fn handle(&self) -> &str {
        &self.handle
    }

    /// The full id with prefix (`c:saket`), as stored in `accounts.handle`.
    pub fn as_full(&self) -> String {
        format!("{}{}", self.kind.prefix(), self.handle)
    }
}

impl fmt::Display for AccountId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}{}", self.kind.prefix(), self.handle)
    }
}

impl Serialize for AccountId {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

impl<'de> Deserialize<'de> for AccountId {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        AccountId::parse(&s).map_err(serde::de::Error::custom)
    }
}

/// Splits a full id into (kind, handle) without validating the handle (for stored values).
pub fn split_full_id(full: &str) -> Option<(AccountKind, &str)> {
    if let Some(h) = full.strip_prefix("c:") {
        Some((AccountKind::Carbon, h))
    } else {
        full.strip_prefix("si:").map(|h| (AccountKind::Silicon, h))
    }
}

/// A normalized handle base from free text (email local part, a name, a desired username):
/// lowercase, keep `[a-z0-9_-]`, collapse every other run to `-`, trim `-`/`_` from both ends,
/// truncate to 30 and pad short results with digits to 3. `None` when nothing usable remains.
pub fn handle_base(seed: &str) -> Option<String> {
    let seed = seed.trim();
    let seed = seed
        .strip_prefix("c:")
        .or_else(|| seed.strip_prefix("si:"))
        .unwrap_or(seed);
    let mut out = String::new();
    let mut pending_dash = false;
    for c in seed.to_lowercase().chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-' {
            if pending_dash && !out.is_empty() && !out.ends_with('-') {
                out.push('-');
            }
            pending_dash = false;
            out.push(c);
        } else {
            pending_dash = true;
        }
    }
    let trimmed: String = out.trim_matches(|c| c == '-' || c == '_').to_string();
    if trimmed.is_empty() {
        return None;
    }
    let mut base: String = trimmed.chars().take(HANDLE_MAX).collect();
    base = base.trim_end_matches(['-', '_']).to_string();
    if base.is_empty() {
        return None;
    }
    let mut pad = 1;
    while base.chars().count() < HANDLE_MIN {
        base.push(char::from(b'0' + (pad % 10) as u8));
        pad += 1;
    }
    Some(base)
}

/// Appends `suffix` (like `-2`) to `base`, truncating the base so the result is ≤ 30 characters.
pub fn with_suffix(base: &str, suffix: &str) -> String {
    let keep = HANDLE_MAX.saturating_sub(suffix.len());
    let mut b: String = base.chars().take(keep).collect();
    b = b.trim_end_matches(['-', '_']).to_string();
    format!("{b}{suffix}")
}

/// Candidate handles in suggestion order: each distinct base as-is, then the first base with
/// `-2`, `-3`, … (19 more tries), then the first base with random 4 digits (forever). Reserved
/// words are skipped. Take as many as you want to check.
pub fn handle_candidates(seeds: &[&str]) -> impl Iterator<Item = String> {
    let mut bases: Vec<String> = Vec::new();
    for s in seeds {
        if let Some(b) = handle_base(s)
            && !bases.contains(&b)
        {
            bases.push(b);
        }
    }
    if bases.is_empty() {
        bases.push("carbon".to_string());
    }
    let first = bases[0].clone();
    let plain = bases.clone().into_iter();
    let numbered = {
        let first = first.clone();
        (2..=20).map(move |n| with_suffix(&first, &format!("-{n}")))
    };
    let random = std::iter::repeat_with(move || {
        let n: u32 = rand::rng().random_range(1000..10000);
        with_suffix(&first, &format!("-{n}"))
    });
    plain
        .chain(numbered)
        .chain(random)
        .filter(|h| validate_handle(h).is_ok())
}

/// Picks the first candidate for which `is_available` returns `Ok(true)`, checking at most
/// `max_checks` candidates. The callback usually asks the database (see
/// `repo::accounts::suggest_ids` / `repo::accounts::suggest_id`).
pub async fn pick_available<F, Fut, E>(
    kind: AccountKind,
    seeds: &[&str],
    max_checks: usize,
    mut is_available: F,
) -> Result<Option<AccountId>, E>
where
    F: FnMut(AccountId) -> Fut,
    Fut: std::future::Future<Output = Result<bool, E>>,
{
    for handle in handle_candidates(seeds).take(max_checks) {
        let Ok(id) = AccountId::new(kind, &handle) else {
            continue;
        };
        if is_available(id.clone()).await? {
            return Ok(Some(id));
        }
    }
    Ok(None)
}

/// `app_id` syntax: `[a-z][a-z0-9-]{1,39}`.
pub fn validate_app_id(app_id: &str) -> Result<(), String> {
    let len = app_id.len();
    let mut chars = app_id.chars();
    let first_ok = chars.next().is_some_and(|c| c.is_ascii_lowercase());
    if !(2..=40).contains(&len)
        || !first_ok
        || !app_id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    {
        return Err(format!(
            "'{app_id}' is not an app id: app ids are 2-40 characters of a-z, 0-9 and '-', starting with a letter (e.g. briefcase)"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn tier_boundaries() {
        let t3 = 62u64.pow(3);
        let t4 = 62u64.pow(4);
        assert_eq!(uuid_for_number(0).len(), 3);
        assert_eq!(uuid_for_number(t3 - 1).len(), 3);
        assert_eq!(uuid_for_number(t3).len(), 4);
        assert_eq!(uuid_for_number(t3 + t4 - 1).len(), 4);
        assert_eq!(uuid_for_number(t3 + t4).len(), 5);
        assert_eq!(uuid_for_number(i64::MAX as u64).len(), 11);
        // Fixed forever: the first uuid ever issued.
        assert_eq!(uuid_for_number(0), "zQo");
    }

    #[test]
    fn bijection_over_whole_first_tier() {
        let t3 = 62u64.pow(3);
        let mut seen = HashSet::with_capacity(t3 as usize);
        for n in 0..t3 {
            let u = uuid_for_number(n);
            assert_eq!(u.len(), 3);
            assert!(seen.insert(u.clone()), "duplicate uuid {u} for {n}");
            assert_eq!(number_for_uuid(&u), Some(n), "inverse of {u}");
        }
        assert_eq!(seen.len() as u64, t3);
    }

    #[test]
    fn inverse_round_trips_across_tiers() {
        let samples = [
            62u64.pow(3),
            62u64.pow(3) + 1,
            12_345_678,
            999_999_999_999,
            62u64.pow(3) + 62u64.pow(4) + 62u64.pow(5) - 1,
            i64::MAX as u64,
        ];
        for n in samples {
            let u = uuid_for_number(n);
            assert_eq!(number_for_uuid(&u), Some(n), "{n} -> {u}");
        }
        let mut seen = HashSet::new();
        for n in 238_328..(238_328 + 50_000) {
            assert!(seen.insert(uuid_for_number(n)));
        }
        assert_eq!(number_for_uuid("ab"), None);
        assert_eq!(number_for_uuid("a-b"), None);
    }

    #[test]
    fn consecutive_uuids_look_random() {
        let a = uuid_for_number(0);
        let b = uuid_for_number(1);
        let c = uuid_for_number(2);
        assert_ne!(a[..2], b[..2]);
        assert_ne!(b[..2], c[..2]);
    }

    #[test]
    fn handle_validation_table() {
        let ok = [
            ("c:saket", "c:saket"),
            ("C:Saket", "c:saket"),
            ("  si:head_of_growth ", "si:head_of_growth"),
            ("c:a-b", "c:a-b"),
            ("c:___", "c:___"),
            (
                "c:abcdefghijklmnopqrstuvwxyz0123",
                "c:abcdefghijklmnopqrstuvwxyz0123",
            ),
        ];
        for (input, expect) in ok {
            assert_eq!(
                AccountId::parse(input).map(|i| i.to_string()),
                Ok(expect.to_string()),
                "{input}"
            );
        }
        let bad: [(&str, &str); 12] = [
            ("", "empty"),
            ("saket", "no prefix"),
            ("c:ab", "at least 3"),
            ("c:abcdefghijklmnopqrstuvwxyz01234", "at most 30"),
            ("c:john smith", "a space at position 5"),
            ("c:si:x", "':' at position 3"),
            ("c:josé", "non-ASCII"),
            ("c:admin", "reserved word"),
            (
                "x:abc",
                "'x:' is not an id prefix: ids start with c: (Carbons) or si: (Silicons).",
            ),
            // Non-ASCII letters whose lowercase is ASCII are refused as written.
            ("c:\u{212A}elvin", "non-ASCII, U+212A) at position 1"),
            ("c:ma\u{0130}l", "non-ASCII, U+0130) at position 3"),
            ("si:\u{FF41}bc", "non-ASCII, U+FF41) at position 1"),
        ];
        for (input, fragment) in bad {
            let err = AccountId::parse(input).expect_err(input);
            assert!(err.to_string().contains(fragment), "{input}: {err}");
        }
        assert_eq!(
            AccountId::parse("x:scout"),
            Err(IdError::UnknownPrefix {
                input: "x:scout".into(),
                prefix: "x:".into()
            })
        );
        assert_eq!(
            AccountId::parse("x:scout").expect_err("prefix").hint(),
            AccountId::parse("scout").expect_err("none").hint()
        );
        // Without a colon, or with something that is no prefix before it, there is none.
        for input in ["scout", ":scout", "an id: scout"] {
            assert!(
                matches!(AccountId::parse(input), Err(IdError::MissingPrefix { .. })),
                "{input}"
            );
        }
        assert_eq!(
            AccountId::parse("c:admin").expect_err("reserved").reason(),
            "reserved_word"
        );
        assert_eq!(
            AccountId::parse("c:a").expect_err("short").reason(),
            "invalid"
        );
    }

    #[test]
    fn parse_for_kind() {
        assert_eq!(
            AccountId::parse_for_kind("scout", AccountKind::Silicon).map(|i| i.to_string()),
            Ok("si:scout".into())
        );
        let err =
            AccountId::parse_for_kind("c:scout", AccountKind::Silicon).expect_err("wrong kind");
        assert!(
            err.to_string()
                .contains("must be a Silicon id starting with si:"),
            "{err}"
        );
    }

    #[test]
    fn handle_bases_and_candidates() {
        assert_eq!(handle_base("Saket.Dev+12"), Some("saket-dev-12".into()));
        assert_eq!(handle_base("  John Smith! "), Some("john-smith".into()));
        assert_eq!(handle_base("jo"), Some("jo1".into()));
        assert_eq!(handle_base("!!!"), None);
        assert_eq!(handle_base("c:admin"), Some("admin".into()));
        assert_eq!(handle_base(&"x".repeat(40)).map(|s| s.len()), Some(30));
        let c: Vec<String> = handle_candidates(&["saket", "Saket Dev"]).take(4).collect();
        assert_eq!(c, vec!["saket", "saket-dev", "saket-2", "saket-3"]);
        let c: Vec<String> = handle_candidates(&["admin"]).take(2).collect();
        assert_eq!(c, vec!["admin-2", "admin-3"], "reserved bases are skipped");
        let long = "y".repeat(30);
        let c: Vec<String> = handle_candidates(&[long.as_str()]).take(25).collect();
        assert!(c.iter().all(|h| h.len() <= 30));
        assert!(
            c[21].len() == 30 && c[21].contains('-'),
            "random suffix after 20 tries: {}",
            c[21]
        );
    }

    #[tokio::test]
    async fn pick_available_uses_callback() {
        let taken = ["saket", "saket-2"];
        let id = pick_available::<_, _, ()>(AccountKind::Carbon, &["saket"], 50, |id| {
            let free = !taken.contains(&id.handle());
            async move { Ok(free) }
        })
        .await
        .expect("no error");
        assert_eq!(id.map(|i| i.to_string()), Some("c:saket-3".into()));
    }

    #[test]
    fn app_ids() {
        assert!(validate_app_id("briefcase").is_ok());
        assert!(validate_app_id("acme-notes").is_ok());
        assert!(validate_app_id("a").is_err());
        assert!(validate_app_id("1abc").is_err());
        assert!(validate_app_id("Acme").is_err());
        assert_eq!(membership_id("briefcase", "a8K"), "briefcase:a8K");
    }
}
