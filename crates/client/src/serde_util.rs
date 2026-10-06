//! Lenient serde helpers. The service may add fields or send `null` where a value is
//! usually present; a client should keep working instead of failing a whole command.

use serde::Deserialize;
use serde::de::{self, Deserializer};
use serde_json::Value;

time::serde::format_description!(pub(crate) ymd, Date, "[year]-[month]-[day]");

/// `null`/missing → `""`; numbers and booleans → their text.
pub(crate) fn lenient_string<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<String, D::Error> {
    Ok(lenient_opt_string(deserializer)?.unwrap_or_default())
}

/// `null`/missing → `None`; numbers and booleans → their text.
pub(crate) fn lenient_opt_string<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<String>, D::Error> {
    match Option::<Value>::deserialize(deserializer)? {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s)),
        Some(Value::Number(n)) => Ok(Some(n.to_string())),
        Some(Value::Bool(b)) => Ok(Some(b.to_string())),
        Some(other) => Err(de::Error::custom(format!(
            "expected a string, found {}",
            describe(&other)
        ))),
    }
}

/// `null`/missing → empty list.
pub(crate) fn lenient_vec<'de, D, T>(deserializer: D) -> Result<Vec<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Ok(Option::<Vec<T>>::deserialize(deserializer)?.unwrap_or_default())
}

/// `null`/missing → `false`.
pub(crate) fn lenient_bool<'de, D: Deserializer<'de>>(deserializer: D) -> Result<bool, D::Error> {
    Ok(Option::<bool>::deserialize(deserializer)?.unwrap_or_default())
}

/// `null`/missing → 0.
pub(crate) fn lenient_u64<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
    Ok(Option::<u64>::deserialize(deserializer)?.unwrap_or_default())
}

/// `null`/missing → 0.
pub(crate) fn lenient_i64<'de, D: Deserializer<'de>>(deserializer: D) -> Result<i64, D::Error> {
    Ok(Option::<i64>::deserialize(deserializer)?.unwrap_or_default())
}

/// A short human description of a JSON value's type, for error messages.
pub(crate) fn describe(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "a boolean",
        Value::Number(_) => "a number",
        Value::String(_) => "a string",
        Value::Array(_) => "a list",
        Value::Object(_) => "an object",
    }
}

/// If `value` is an object whose only meaningful content is `{key: {...}}`, returns the
/// inner object; otherwise returns `value` unchanged. Lets the client accept both
/// `{"job": {...}}` and a bare `{...}`.
pub(crate) fn unwrap_key(value: Value, key: &str) -> Value {
    match value {
        Value::Object(mut map) if map.get(key).is_some_and(Value::is_object) => {
            map.remove(key).unwrap_or(Value::Null)
        }
        other => other,
    }
}
