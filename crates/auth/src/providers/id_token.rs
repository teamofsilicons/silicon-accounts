//! Verifying Google and Apple id_tokens: signature against the provider's JWKS (by `kid`,
//! RS256/ES256 only), `iss`, `aud`, `exp`/`nbf` (60 s leeway), `nonce`, and a lenient
//! `email_verified` (Apple sends the string `"true"`).
//!
//! JWKS documents are cached per URL for their `Cache-Control: max-age` (1 hour by default,
//! clamped to 1 minute .. 1 day) and refetched when a token names an unknown `kid` (key
//! rotation), at most every few seconds.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use accounts_core::crypto::constant_time_eq;
use jsonwebtoken::errors::ErrorKind;
use jsonwebtoken::jwk::{Jwk, JwkSet};
use jsonwebtoken::{Algorithm, DecodingKey, Validation};
use serde::{Deserialize, Deserializer};

/// Claims we use from a provider id_token.
#[derive(Debug, Clone, Deserialize)]
pub struct ProviderClaims {
    pub iss: String,
    /// The provider's stable user id.
    pub sub: String,
    #[serde(default)]
    pub nonce: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
    /// `true`, `false`, `"true"` or `"false"` (Apple uses strings).
    #[serde(default, deserialize_with = "lenient_bool")]
    pub email_verified: Option<bool>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub given_name: Option<String>,
    #[serde(default)]
    pub family_name: Option<String>,
    #[serde(default)]
    pub picture: Option<String>,
    /// Google Workspace domain.
    #[serde(default)]
    pub hd: Option<String>,
}

impl ProviderClaims {
    /// `name`, else `given_name family_name`.
    pub fn full_name(&self) -> Option<String> {
        if let Some(n) = self
            .name
            .as_deref()
            .map(str::trim)
            .filter(|n| !n.is_empty())
        {
            return Some(n.to_string());
        }
        let parts: Vec<&str> = [self.given_name.as_deref(), self.family_name.as_deref()]
            .into_iter()
            .flatten()
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .collect();
        (!parts.is_empty()).then(|| parts.join(" "))
    }
}

fn lenient_bool<'de, D: Deserializer<'de>>(d: D) -> Result<Option<bool>, D::Error> {
    let v = Option::<serde_json::Value>::deserialize(d)?;
    Ok(match v {
        Some(serde_json::Value::Bool(b)) => Some(b),
        Some(serde_json::Value::String(s)) => match s.trim().to_ascii_lowercase().as_str() {
            "true" => Some(true),
            "false" => Some(false),
            _ => None,
        },
        _ => None,
    })
}

/// What the id_token must say.
#[derive(Debug, Clone)]
pub struct Expectations<'a> {
    /// Accepted `iss` values.
    pub issuers: &'a [String],
    /// The client id that started the sign-in (`aud`).
    pub audience: &'a str,
    /// The nonce sent with the authorize request.
    pub nonce: &'a str,
}

/// Why an id_token was refused (messages never include the token).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum IdTokenError {
    #[error("the id_token is not a well-formed JWT ({0})")]
    Malformed(String),
    #[error("the id_token is signed with {0}, but only RS256 and ES256 are accepted")]
    UnsupportedAlgorithm(String),
    #[error("the id_token header has no kid, so its signing key can't be found")]
    MissingKeyId,
    #[error(
        "the id_token was signed with key '{0}', which is not in the provider's published keys"
    )]
    UnknownKey(String),
    #[error("the id_token signature does not verify with the provider's key")]
    BadSignature,
    #[error("the id_token expired")]
    Expired,
    #[error("the id_token is not valid yet (nbf is in the future)")]
    NotYetValid,
    #[error("the id_token was issued by '{got}', not by {expected}")]
    WrongIssuer { got: String, expected: String },
    #[error("the id_token was issued to client '{got}', not to '{expected}'")]
    WrongAudience { got: String, expected: String },
    #[error("the id_token has no {0} claim")]
    MissingClaim(String),
    #[error("the id_token carries no nonce, so it can't be tied to this sign-in")]
    MissingNonce,
    #[error("the id_token nonce doesn't match this sign-in (a replayed or foreign token)")]
    NonceMismatch,
    #[error("the provider's signing keys could not be fetched: {0}")]
    Jwks(String),
}

fn actual_claim(token: &str, claim: &str) -> String {
    jsonwebtoken::dangerous::insecure_decode_claims::<serde_json::Value>(token)
        .ok()
        .and_then(|v| v.get(claim).cloned())
        .map(|v| match v {
            serde_json::Value::String(s) => s,
            other => other.to_string(),
        })
        .unwrap_or_else(|| "(none)".to_string())
}

/// Verifies an id_token against a key set (no network).
pub fn verify_with_keys(
    keys: &JwkSet,
    token: &str,
    expect: &Expectations<'_>,
) -> Result<ProviderClaims, IdTokenError> {
    let header =
        jsonwebtoken::decode_header(token).map_err(|e| IdTokenError::Malformed(e.to_string()))?;
    if !matches!(header.alg, Algorithm::RS256 | Algorithm::ES256) {
        return Err(IdTokenError::UnsupportedAlgorithm(format!(
            "{:?}",
            header.alg
        )));
    }
    let kid = header.kid.as_deref().ok_or(IdTokenError::MissingKeyId)?;
    let jwk = keys
        .find(kid)
        .ok_or_else(|| IdTokenError::UnknownKey(kid.to_string()))?;
    if let Some(alg) = jwk.common.key_algorithm {
        let matches = format!("{alg:?}") == format!("{:?}", header.alg);
        if !matches {
            return Err(IdTokenError::UnsupportedAlgorithm(format!(
                "{:?} with a {alg:?} key",
                header.alg
            )));
        }
    }
    let key = DecodingKey::from_jwk(jwk)
        .map_err(|e| IdTokenError::Jwks(format!("key '{kid}' is unusable ({e})")))?;
    let mut v = Validation::new(header.alg);
    v.set_issuer(expect.issuers);
    v.set_audience(&[expect.audience]);
    v.leeway = 60;
    v.validate_nbf = true;
    v.set_required_spec_claims(&["exp", "iss", "aud", "sub"]);
    let data =
        jsonwebtoken::decode::<ProviderClaims>(token, &key, &v).map_err(|e| match e.kind() {
            ErrorKind::InvalidSignature => IdTokenError::BadSignature,
            ErrorKind::ExpiredSignature => IdTokenError::Expired,
            ErrorKind::ImmatureSignature => IdTokenError::NotYetValid,
            ErrorKind::InvalidIssuer => IdTokenError::WrongIssuer {
                got: actual_claim(token, "iss"),
                expected: expect.issuers.join(" or "),
            },
            ErrorKind::InvalidAudience => IdTokenError::WrongAudience {
                got: actual_claim(token, "aud"),
                expected: expect.audience.to_string(),
            },
            ErrorKind::MissingRequiredClaim(c) => IdTokenError::MissingClaim(c.clone()),
            ErrorKind::Json(j) => {
                // Our claim struct requires iss and sub: serde reports those as missing fields.
                let m = j.to_string();
                match m
                    .strip_prefix("missing field `")
                    .and_then(|r| r.split('`').next())
                {
                    Some(field) => IdTokenError::MissingClaim(field.to_string()),
                    None => IdTokenError::Malformed(format!("its claims are not valid JSON ({m})")),
                }
            }
            ErrorKind::InvalidAlgorithm => {
                IdTokenError::UnsupportedAlgorithm(format!("{:?}", header.alg))
            }
            other => IdTokenError::Malformed(format!("{other:?}")),
        })?;
    let claims = data.claims;
    match &claims.nonce {
        None => return Err(IdTokenError::MissingNonce),
        Some(n) if !constant_time_eq(n.as_bytes(), expect.nonce.as_bytes()) => {
            return Err(IdTokenError::NonceMismatch);
        }
        Some(_) => {}
    }
    Ok(claims)
}

// ----------------------------------------------------------------------------- JWKS cache

struct CachedKeys {
    keys: Arc<JwkSet>,
    fetched_at: Instant,
    ttl: Duration,
}

fn cache() -> &'static Mutex<HashMap<String, CachedKeys>> {
    static CACHE: OnceLock<Mutex<HashMap<String, CachedKeys>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Minimum time between two refetches of the same JWKS (unknown `kid` handling).
const MIN_REFETCH: Duration = Duration::from_secs(5);

fn max_age(headers: &reqwest::header::HeaderMap) -> Duration {
    let secs = headers
        .get(reqwest::header::CACHE_CONTROL)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| {
            v.split(',')
                .filter_map(|p| p.trim().strip_prefix("max-age="))
                .find_map(|n| n.trim().parse::<u64>().ok())
        })
        .unwrap_or(3600);
    Duration::from_secs(secs.clamp(60, 86_400))
}

/// Parses a JWKS document, skipping keys this library can't represent.
pub fn parse_jwks(value: &serde_json::Value) -> Result<JwkSet, String> {
    let keys = value
        .get("keys")
        .and_then(|k| k.as_array())
        .ok_or_else(|| "the document has no \"keys\" array".to_string())?;
    let keys: Vec<Jwk> = keys
        .iter()
        .filter_map(|k| serde_json::from_value::<Jwk>(k.clone()).ok())
        .collect();
    Ok(JwkSet { keys })
}

async fn fetch(http: &reqwest::Client, url: &str) -> Result<CachedKeys, IdTokenError> {
    let response = http
        .get(url)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|e| IdTokenError::Jwks(format!("GET {url} failed ({})", without_url(&e))))?;
    let status = response.status();
    if !status.is_success() {
        return Err(IdTokenError::Jwks(format!(
            "GET {url} answered HTTP {status}"
        )));
    }
    let ttl = max_age(response.headers());
    let value: serde_json::Value = response.json().await.map_err(|e| {
        IdTokenError::Jwks(format!(
            "GET {url} did not return JSON ({})",
            without_url(&e)
        ))
    })?;
    let keys = parse_jwks(&value).map_err(|m| IdTokenError::Jwks(format!("GET {url}: {m}")))?;
    Ok(CachedKeys {
        keys: Arc::new(keys),
        fetched_at: Instant::now(),
        ttl,
    })
}

fn without_url(e: &reqwest::Error) -> String {
    let mut e = e.to_string();
    if let Some(i) = e.find(" for url (") {
        e.truncate(i);
    }
    e
}

/// The key set at `url` (cached; `refresh` refetches unless it was fetched moments ago).
pub async fn keys(
    http: &reqwest::Client,
    url: &str,
    refresh: bool,
) -> Result<Arc<JwkSet>, IdTokenError> {
    {
        let map = cache()
            .lock()
            .map_err(|_| IdTokenError::Jwks("key cache poisoned".into()))?;
        if let Some(c) = map.get(url) {
            let age = c.fetched_at.elapsed();
            let fresh = age < c.ttl;
            if fresh && (!refresh || age < MIN_REFETCH) {
                return Ok(c.keys.clone());
            }
        }
    }
    let fetched = fetch(http, url).await?;
    let keys = fetched.keys.clone();
    if let Ok(mut map) = cache().lock() {
        if map.len() > 64 {
            map.clear();
        }
        map.insert(url.to_string(), fetched);
    }
    Ok(keys)
}

/// Verifies an id_token with the provider's published keys (refetching once on an unknown
/// `kid`, which is how key rotation shows up).
pub async fn verify(
    http: &reqwest::Client,
    jwks_url: &str,
    token: &str,
    expect: &Expectations<'_>,
) -> Result<ProviderClaims, IdTokenError> {
    let set = keys(http, jwks_url, false).await?;
    match verify_with_keys(&set, token, expect) {
        Err(IdTokenError::UnknownKey(_)) => {
            let set = keys(http, jwks_url, true).await?;
            verify_with_keys(&set, token, expect)
        }
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use jsonwebtoken::{EncodingKey, Header};
    use serde_json::json;

    const RSA_PRIVATE: &str = include_str!("../../tests/fixtures/rsa_test_private.pem");
    const RSA_N: &str = include_str!("../../tests/fixtures/rsa_test_n.txt");
    const RSA_OTHER_PRIVATE: &str = include_str!("../../tests/fixtures/rsa_other_private.pem");
    const EC_PRIVATE: &str = include_str!("../../tests/fixtures/ec_test_private.pem");
    const EC_X: &str = include_str!("../../tests/fixtures/ec_test_x.txt");
    const EC_Y: &str = include_str!("../../tests/fixtures/ec_test_y.txt");

    fn jwks() -> JwkSet {
        parse_jwks(&json!({"keys": [
            {"kty": "RSA", "kid": "rsa-1", "alg": "RS256", "use": "sig", "n": RSA_N.trim(), "e": "AQAB"},
            {"kty": "EC", "kid": "ec-1", "crv": "P-256", "x": EC_X.trim(), "y": EC_Y.trim()},
            {"kty": "weird", "kid": "skip-me"}
        ]}))
        .expect("jwks")
    }

    fn now() -> i64 {
        jsonwebtoken::get_current_timestamp() as i64
    }

    fn claims(extra: serde_json::Value) -> serde_json::Value {
        let mut c = json!({
            "iss": "https://accounts.google.com",
            "aud": "client-1",
            "sub": "1047",
            "iat": now(),
            "exp": now() + 600,
            "nonce": "n-123",
            "email": "ada@example.test",
            "email_verified": true,
            "name": "Ada Lovelace",
        });
        if let (Some(base), Some(over)) = (c.as_object_mut(), extra.as_object()) {
            for (k, v) in over {
                if v.is_null() {
                    base.remove(k);
                } else {
                    base.insert(k.clone(), v.clone());
                }
            }
        }
        c
    }

    fn rs256(kid: &str, pem: &str, c: &serde_json::Value) -> String {
        let mut h = Header::new(Algorithm::RS256);
        h.kid = Some(kid.into());
        jsonwebtoken::encode(
            &h,
            c,
            &EncodingKey::from_rsa_pem(pem.as_bytes()).expect("rsa key"),
        )
        .expect("sign")
    }

    fn es256(kid: &str, c: &serde_json::Value) -> String {
        let mut h = Header::new(Algorithm::ES256);
        h.kid = Some(kid.into());
        jsonwebtoken::encode(
            &h,
            c,
            &EncodingKey::from_ec_pem(EC_PRIVATE.as_bytes()).expect("ec key"),
        )
        .expect("sign")
    }

    fn expect() -> (Vec<String>, &'static str, &'static str) {
        (
            vec![
                "https://accounts.google.com".to_string(),
                "accounts.google.com".to_string(),
            ],
            "client-1",
            "n-123",
        )
    }

    fn check(token: &str) -> Result<ProviderClaims, IdTokenError> {
        let (issuers, aud, nonce) = expect();
        verify_with_keys(
            &jwks(),
            token,
            &Expectations {
                issuers: &issuers,
                audience: aud,
                nonce,
            },
        )
    }

    #[test]
    fn valid_rs256_and_es256_tokens_verify() {
        let c = check(&rs256("rsa-1", RSA_PRIVATE, &claims(json!({})))).expect("rs256");
        assert_eq!(c.sub, "1047");
        assert_eq!(c.email_verified, Some(true));
        assert_eq!(c.full_name().as_deref(), Some("Ada Lovelace"));
        let c = check(&es256("ec-1", &claims(json!({"email_verified": "true"})))).expect("es256");
        assert_eq!(c.email_verified, Some(true), "Apple's string form");
        let c = check(&rs256("rsa-1", RSA_PRIVATE, &claims(json!({"email_verified": "false", "name": null, "given_name": "Ada", "family_name": "L"})))).expect("ok");
        assert_eq!(c.email_verified, Some(false));
        assert_eq!(c.full_name().as_deref(), Some("Ada L"));
    }

    #[test]
    fn every_check_fails_precisely() {
        assert_eq!(
            check(&rs256(
                "rsa-1",
                RSA_PRIVATE,
                &claims(json!({"iss": "https://evil.test"}))
            ))
            .expect_err("iss"),
            IdTokenError::WrongIssuer {
                got: "https://evil.test".into(),
                expected: "https://accounts.google.com or accounts.google.com".into()
            }
        );
        assert_eq!(
            check(&rs256(
                "rsa-1",
                RSA_PRIVATE,
                &claims(json!({"aud": "client-2"}))
            ))
            .expect_err("aud"),
            IdTokenError::WrongAudience {
                got: "client-2".into(),
                expected: "client-1".into()
            }
        );
        assert_eq!(
            check(&rs256(
                "rsa-1",
                RSA_PRIVATE,
                &claims(json!({"exp": now() - 3600}))
            ))
            .expect_err("exp"),
            IdTokenError::Expired
        );
        assert_eq!(
            check(&rs256(
                "rsa-1",
                RSA_PRIVATE,
                &claims(json!({"nbf": now() + 3600}))
            ))
            .expect_err("nbf"),
            IdTokenError::NotYetValid
        );
        assert_eq!(
            check(&rs256(
                "rsa-1",
                RSA_PRIVATE,
                &claims(json!({"nonce": "other"}))
            ))
            .expect_err("nonce"),
            IdTokenError::NonceMismatch
        );
        assert_eq!(
            check(&rs256(
                "rsa-1",
                RSA_PRIVATE,
                &claims(json!({"nonce": null}))
            ))
            .expect_err("no nonce"),
            IdTokenError::MissingNonce
        );
        assert_eq!(
            check(&rs256("rsa-1", RSA_PRIVATE, &claims(json!({"sub": null})))).expect_err("no sub"),
            IdTokenError::MissingClaim("sub".into())
        );
        assert_eq!(
            check(&rs256("rsa-1", RSA_OTHER_PRIVATE, &claims(json!({})))).expect_err("signature"),
            IdTokenError::BadSignature
        );
        assert_eq!(
            check(&rs256("rsa-9", RSA_PRIVATE, &claims(json!({})))).expect_err("kid"),
            IdTokenError::UnknownKey("rsa-9".into())
        );
        // An RSA key named in an ES256 header (algorithm confusion) is refused.
        assert!(matches!(
            check(&es256("rsa-1", &claims(json!({})))).expect_err("confusion"),
            IdTokenError::UnsupportedAlgorithm(_)
        ));
    }

    #[test]
    fn hmac_and_unsigned_tokens_are_refused() {
        let mut h = Header::new(Algorithm::HS256);
        h.kid = Some("rsa-1".into());
        let hs = jsonwebtoken::encode(
            &h,
            &claims(json!({})),
            &EncodingKey::from_secret(RSA_N.as_bytes()),
        )
        .expect("hs");
        assert!(matches!(
            check(&hs).expect_err("hs256"),
            IdTokenError::UnsupportedAlgorithm(_)
        ));
        let b64 = |v: serde_json::Value| accounts_core::crypto::b64url(v.to_string().as_bytes());
        let none = format!(
            "{}.{}.",
            b64(json!({"alg": "none", "kid": "rsa-1"})),
            b64(claims(json!({})))
        );
        assert!(matches!(
            check(&none).expect_err("none"),
            IdTokenError::Malformed(_)
        ));
        assert!(matches!(
            check("not-a-jwt").expect_err("garbage"),
            IdTokenError::Malformed(_)
        ));
    }

    #[test]
    fn max_age_is_read_and_clamped() {
        let mut h = reqwest::header::HeaderMap::new();
        assert_eq!(max_age(&h), Duration::from_secs(3600));
        h.insert(
            reqwest::header::CACHE_CONTROL,
            "public, max-age=19432, must-revalidate"
                .parse()
                .expect("hv"),
        );
        assert_eq!(max_age(&h), Duration::from_secs(19432));
        h.insert(
            reqwest::header::CACHE_CONTROL,
            "max-age=5".parse().expect("hv"),
        );
        assert_eq!(max_age(&h), Duration::from_secs(60));
    }
}
