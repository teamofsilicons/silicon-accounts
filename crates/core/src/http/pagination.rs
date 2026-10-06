//! Pagination: `?limit=50&cursor=<opaque>` → `{"items":[...],"next_cursor":null}`.
//!
//! Fetch `limit + 1` rows ordered by a stable key, then call [`paginate`]: it trims the extra row
//! and encodes the cursor of the last returned row. Cursors are base64url JSON of whatever key
//! you choose (e.g. `(created_at, id)`).

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::error::ApiError;
use crate::views::Page;

/// Default page size.
pub const DEFAULT_LIMIT: i64 = 50;
/// Largest page size.
pub const MAX_LIMIT: i64 = 200;

/// `limit` and `cursor` query parameters (flatten into your query struct with `#[serde(flatten)]`
/// or use directly).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct PageParams {
    pub limit: Option<i64>,
    pub cursor: Option<String>,
}

impl PageParams {
    /// The page size, clamped to 1..=200 (default 50).
    pub fn limit(&self) -> i64 {
        self.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT)
    }

    /// The decoded cursor, if any (400 `invalid_cursor` when it is not one of ours).
    pub fn cursor<T: DeserializeOwned>(&self) -> Result<Option<T>, ApiError> {
        match self
            .cursor
            .as_deref()
            .map(str::trim)
            .filter(|c| !c.is_empty())
        {
            Some(c) => decode_cursor(c).map(Some),
            None => Ok(None),
        }
    }
}

/// Encodes a cursor value.
pub fn encode_cursor<T: Serialize>(value: &T) -> String {
    crate::crypto::b64url(serde_json::to_string(value).unwrap_or_default().as_bytes())
}

/// Decodes a cursor value (400 `invalid_cursor`).
pub fn decode_cursor<T: DeserializeOwned>(cursor: &str) -> Result<T, ApiError> {
    let invalid = || {
        ApiError::bad_request("invalid_cursor", "The cursor is not valid for this list.")
            .hint("Pass the next_cursor value from the previous page unchanged, or omit cursor to start over.")
    };
    let bytes = crate::crypto::b64url_decode(cursor).map_err(|_| invalid())?;
    serde_json::from_slice(&bytes).map_err(|_| invalid())
}

/// Builds a page from `limit + 1` fetched rows.
pub fn paginate<T, C: Serialize>(
    mut rows: Vec<T>,
    limit: i64,
    cursor_of: impl Fn(&T) -> C,
) -> Page<T> {
    let limit = limit.max(0) as usize;
    if rows.len() > limit {
        rows.truncate(limit);
        let next = rows.last().map(|r| encode_cursor(&cursor_of(r)));
        Page::new(rows, next)
    } else {
        Page::new(rows, None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limits_and_cursors() {
        assert_eq!(PageParams::default().limit(), 50);
        assert_eq!(
            PageParams {
                limit: Some(500),
                cursor: None
            }
            .limit(),
            200
        );
        assert_eq!(
            PageParams {
                limit: Some(0),
                cursor: None
            }
            .limit(),
            1
        );
        let c = encode_cursor(&("2026-10-06T12:00:00.000Z", 42));
        let back: (String, i64) = decode_cursor(&c).expect("cursor");
        assert_eq!(back.1, 42);
        assert_eq!(
            decode_cursor::<(String, i64)>("!!").expect_err("bad").code,
            "invalid_cursor"
        );
        let page = paginate(vec![1, 2, 3], 2, |x| *x);
        assert_eq!(page.items, vec![1, 2]);
        assert_eq!(
            decode_cursor::<i32>(page.next_cursor.as_deref().expect("next")).expect("decode"),
            2
        );
        assert_eq!(paginate(vec![1], 2, |x| *x).next_cursor, None);
    }
}
