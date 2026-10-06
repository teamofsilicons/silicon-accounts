//! Small helpers shared by the handlers.

use accounts_core::crypto::{Keyring, b64url, b64url_decode};
use accounts_core::{ApiResult, AppState};
use axum::http::{HeaderMap, HeaderValue, header};
use serde_json::Value;

/// Prefix of keyring-encrypted values stored in text columns.
const ENC_PREFIX: &str = "enc1:";

/// Encrypts a value for a text column (`enc1:` + base64url(keyring ciphertext)).
///
/// Used for the final redirect of a flow: it carries a live authorization code, and only
/// hashes of codes may be stored in clear.
pub fn encrypt_text(keyring: &Keyring, plain: &str) -> ApiResult<String> {
    Ok(format!(
        "{ENC_PREFIX}{}",
        b64url(&keyring.encrypt_str(plain)?)
    ))
}

/// Reverses [`encrypt_text`]. Values without the prefix are returned as they are.
pub fn decrypt_text(keyring: &Keyring, stored: &str) -> ApiResult<String> {
    match stored.strip_prefix(ENC_PREFIX) {
        Some(rest) => Ok(keyring.decrypt_string(&b64url_decode(rest)?)?),
        None => Ok(stored.to_string()),
    }
}

/// Appends query parameters to a (validated) redirect URI. `None` values are skipped.
pub fn with_query(base: &str, params: &[(&str, Option<&str>)]) -> String {
    match url::Url::parse(base) {
        Ok(mut u) => {
            {
                let mut q = u.query_pairs_mut();
                for (k, v) in params {
                    if let Some(v) = v {
                        q.append_pair(k, v);
                    }
                }
            }
            u.to_string()
        }
        Err(_) => {
            // Registered redirect URIs always parse; keep a correct fallback anyway.
            let pairs: Vec<(&str, &str)> = params
                .iter()
                .filter_map(|(k, v)| v.map(|v| (*k, v)))
                .collect();
            let query = serde_urlencoded::to_string(pairs).unwrap_or_default();
            let sep = if base.contains('?') { '&' } else { '?' };
            format!("{base}{sep}{query}")
        }
    }
}

/// Marks a response as never cacheable (it carries flow state, codes or cookies).
pub fn no_store(headers: &mut HeaderMap) {
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(header::PRAGMA, HeaderValue::from_static("no-cache"));
}

/// Records a sign-in telemetry event (never with emails, phones, codes or tokens).
pub fn telemetry(state: &AppState, event: &str, progress: Option<f64>, data: Value) {
    state
        .telemetry
        .record_progress("accounts-api", "signin", event, progress, data);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_is_appended_and_encoded() {
        assert_eq!(
            with_query(
                "https://app.example.com/cb",
                &[
                    ("code", Some("sac_x")),
                    ("state", Some("a b&c")),
                    ("none", None)
                ]
            ),
            "https://app.example.com/cb?code=sac_x&state=a+b%26c"
        );
        assert_eq!(
            with_query("https://app.example.com/cb?x=1", &[("code", Some("c"))]),
            "https://app.example.com/cb?x=1&code=c"
        );
        assert_eq!(
            with_query("com.example.app:/callback", &[("code", Some("c"))]),
            "com.example.app:/callback?code=c"
        );
    }

    #[test]
    fn encrypted_text_round_trips() {
        let settings = accounts_core::Settings::for_tests();
        let keys = accounts_core::Keys::from_settings(&settings).expect("keys");
        let enc = encrypt_text(&keys.keyring, "https://x/cb?code=sac_1").expect("encrypt");
        assert!(enc.starts_with("enc1:") && !enc.contains("sac_1"));
        assert_eq!(
            decrypt_text(&keys.keyring, &enc).expect("decrypt"),
            "https://x/cb?code=sac_1"
        );
        assert_eq!(
            decrypt_text(&keys.keyring, "plain").expect("plain"),
            "plain"
        );
    }
}
