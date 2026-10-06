//! JWTs signed with Ed25519 (EdDSA): access tokens, OIDC id_tokens and the JWKS.
//!
//! Access token claims (`AccessClaims`): `iss` (public URL), `sub` (account uuid), `aud` (app_id),
//! `exp`, `iat`, `nbf`, `jti`, `kind`, `id` (c:/si: id at issue time), `mid` (membership id),
//! `fid` (token family uuid), `scope` (space separated). Header carries `kid`.

use std::fmt;

use ed25519_dalek::SigningKey;
use ed25519_dalek::pkcs8::{DecodePrivateKey, EncodePrivateKey};
use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::crypto::b64url;
use crate::models::AccountKind;

/// JWT failures with precise, caller-facing descriptions.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum JwtError {
    #[error("the token is not a well-formed JWT ({0})")]
    Malformed(String),
    #[error("the token's signature does not verify against Silicon Accounts' signing key")]
    BadSignature,
    #[error("the token was signed with key id '{0}', which Silicon Accounts does not use")]
    UnknownKey(String),
    #[error("the token expired")]
    Expired,
    #[error("the token is not valid yet (nbf is in the future)")]
    NotYetValid,
    #[error("the token was issued by '{got}', not by {expected}")]
    WrongIssuer { expected: String, got: String },
    #[error("the token was issued to app '{got}', not to '{expected}'")]
    WrongAudience { expected: String, got: String },
    #[error("could not sign the token: {0}")]
    Sign(String),
    #[error("invalid signing key: {0}")]
    Key(String),
}

/// Parses ACCOUNTS_JWT_PRIVATE_KEY: an Ed25519 PKCS#8 PEM (literal `\n` escapes allowed) or a
/// base64url 32-byte seed.
pub fn parse_private_key(value: &str) -> Result<SigningKey, String> {
    let v = value.trim();
    if v.contains("BEGIN") {
        let pem = v.replace("\\n", "\n");
        return SigningKey::from_pkcs8_pem(&pem).map_err(|e| {
            format!("is not an Ed25519 PKCS#8 PEM private key ({e}); generate one with `openssl genpkey -algorithm ed25519`")
        });
    }
    let seed = crate::config::decode_key32(v).map_err(|e| {
        format!("{e} (expected an Ed25519 PKCS#8 PEM, or a base64url 32-byte seed)")
    })?;
    Ok(SigningKey::from_bytes(&seed))
}

/// Ed25519 PKCS#8 PEM for a seed (dev tooling).
pub fn private_key_pem(seed: &[u8; 32]) -> Result<String, JwtError> {
    let key = SigningKey::from_bytes(seed);
    key.to_pkcs8_pem(Default::default())
        .map(|p| p.to_string())
        .map_err(|e| JwtError::Key(e.to_string()))
}

/// Claims of an access token.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccessClaims {
    pub iss: String,
    /// Account uuid.
    pub sub: String,
    /// app_id (`accounts` for first-party tokens).
    pub aud: String,
    pub exp: i64,
    pub iat: i64,
    pub nbf: i64,
    pub jti: String,
    pub kind: AccountKind,
    /// `c:` / `si:` id at issue time.
    pub id: String,
    /// Membership id `{app_id}:{uuid}`.
    pub mid: String,
    /// Token family uuid.
    pub fid: String,
    /// Space-separated scopes.
    pub scope: String,
}

impl AccessClaims {
    /// Family id as a UUID.
    pub fn family_id(&self) -> Option<uuid::Uuid> {
        uuid::Uuid::parse_str(&self.fid).ok()
    }

    /// Granted scopes.
    pub fn scopes(&self) -> Vec<crate::models::Scope> {
        crate::models::Scope::parse_list_lenient(&self.scope)
    }
}

/// What to put in an access token (issuer, times and jti are filled in by the signer).
#[derive(Debug, Clone)]
pub struct AccessTokenInput<'a> {
    pub account_uuid: &'a str,
    pub app_id: &'a str,
    pub kind: AccountKind,
    pub id: &'a str,
    pub family_id: uuid::Uuid,
    pub scope: &'a str,
    pub ttl_seconds: i64,
}

/// OIDC id_token claims. Contact claims are present only when their scope was granted.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct IdTokenClaims {
    pub iss: String,
    pub sub: String,
    pub aud: String,
    pub exp: i64,
    pub iat: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth_time: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nonce: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub picture: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preferred_username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email_verified: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phone_number: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phone_number_verified: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub zoneinfo: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub birthdate: Option<String>,
}

/// The service's signing key, its id and its issuer.
#[derive(Clone)]
pub struct JwtKeys {
    kid: String,
    issuer: String,
    encoding: EncodingKey,
    decoding: DecodingKey,
    public_key: [u8; 32],
}

impl fmt::Debug for JwtKeys {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("JwtKeys")
            .field("kid", &self.kid)
            .field("issuer", &self.issuer)
            .finish_non_exhaustive()
    }
}

impl JwtKeys {
    /// Builds the keys from a signing key.
    pub fn new(signing: &SigningKey, kid: &str, issuer: &str) -> Result<JwtKeys, JwtError> {
        let der = signing
            .to_pkcs8_der()
            .map_err(|e| JwtError::Key(e.to_string()))?;
        let public_key = signing.verifying_key().to_bytes();
        Ok(JwtKeys {
            kid: kid.to_string(),
            issuer: issuer.to_string(),
            encoding: EncodingKey::from_ed_der(der.as_bytes()),
            decoding: DecodingKey::from_ed_der(&public_key),
            public_key,
        })
    }

    /// Parses ACCOUNTS_JWT_PRIVATE_KEY (PEM or seed).
    pub fn from_private_key(value: &str, kid: &str, issuer: &str) -> Result<JwtKeys, JwtError> {
        let key = parse_private_key(value).map_err(JwtError::Key)?;
        JwtKeys::new(&key, kid, issuer)
    }

    /// A fresh random key (tests and dev tooling). Returns the keys and the base64url seed.
    pub fn generate(kid: &str, issuer: &str) -> Result<(JwtKeys, String), JwtError> {
        let seed = crate::crypto::random_bytes::<32>();
        let key = SigningKey::from_bytes(&seed);
        Ok((JwtKeys::new(&key, kid, issuer)?, b64url(&seed)))
    }

    pub fn kid(&self) -> &str {
        &self.kid
    }

    pub fn issuer(&self) -> &str {
        &self.issuer
    }

    /// The public key as a JWK (`kty OKP`, `crv Ed25519`).
    pub fn jwk(&self) -> Value {
        json!({
            "kty": "OKP",
            "crv": "Ed25519",
            "x": b64url(&self.public_key),
            "kid": self.kid,
            "use": "sig",
            "alg": "EdDSA",
        })
    }

    /// The JWKS document served at `/.well-known/jwks.json`.
    pub fn jwks(&self) -> Value {
        json!({ "keys": [self.jwk()] })
    }

    /// Signs any claims with the `kid` header.
    pub fn sign<T: Serialize>(&self, claims: &T) -> Result<String, JwtError> {
        let mut header = Header::new(Algorithm::EdDSA);
        header.kid = Some(self.kid.clone());
        jsonwebtoken::encode(&header, claims, &self.encoding)
            .map_err(|e| JwtError::Sign(e.to_string()))
    }

    /// Verifies signature, `kid`, `iss`, `exp` and `nbf` (30 s leeway), optionally `aud`, and
    /// returns the claims.
    pub fn verify<T: DeserializeOwned>(
        &self,
        token: &str,
        audience: Option<&str>,
    ) -> Result<T, JwtError> {
        let header =
            jsonwebtoken::decode_header(token).map_err(|e| JwtError::Malformed(e.to_string()))?;
        if header.alg != Algorithm::EdDSA {
            return Err(JwtError::Malformed(format!(
                "alg is {:?}, expected EdDSA",
                header.alg
            )));
        }
        if let Some(kid) = &header.kid
            && kid != &self.kid
        {
            return Err(JwtError::UnknownKey(kid.clone()));
        }
        let mut validation = Validation::new(Algorithm::EdDSA);
        validation.leeway = 30;
        validation.validate_nbf = true;
        validation.validate_aud = false;
        validation.set_required_spec_claims(&["exp", "iss", "sub", "aud"]);
        let data = jsonwebtoken::decode::<Value>(token, &self.decoding, &validation)
            .map_err(map_jwt_error)?;
        let claims = data.claims;
        let iss = claims
            .get("iss")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if iss != self.issuer {
            return Err(JwtError::WrongIssuer {
                expected: self.issuer.clone(),
                got: iss.to_string(),
            });
        }
        if let Some(expected) = audience {
            let got = match claims.get("aud") {
                Some(Value::String(s)) => s.clone(),
                Some(Value::Array(a)) => a
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(" "),
                _ => String::new(),
            };
            if got != expected {
                return Err(JwtError::WrongAudience {
                    expected: expected.to_string(),
                    got,
                });
            }
        }
        serde_json::from_value(claims)
            .map_err(|e| JwtError::Malformed(format!("unexpected claims: {e}")))
    }

    /// Signs an access token; returns the JWT and its claims.
    pub fn sign_access(
        &self,
        input: &AccessTokenInput<'_>,
    ) -> Result<(String, AccessClaims), JwtError> {
        let now = time::OffsetDateTime::now_utc().unix_timestamp();
        let claims = AccessClaims {
            iss: self.issuer.clone(),
            sub: input.account_uuid.to_string(),
            aud: input.app_id.to_string(),
            exp: now + input.ttl_seconds,
            iat: now,
            nbf: now,
            jti: uuid::Uuid::now_v7().to_string(),
            kind: input.kind,
            id: input.id.to_string(),
            mid: crate::ids::membership_id(input.app_id, input.account_uuid),
            fid: input.family_id.to_string(),
            scope: input.scope.to_string(),
        };
        Ok((self.sign(&claims)?, claims))
    }

    /// Verifies an access token (optionally for one audience).
    pub fn verify_access(
        &self,
        token: &str,
        audience: Option<&str>,
    ) -> Result<AccessClaims, JwtError> {
        self.verify(token, audience)
    }

    /// Signs an id_token (the caller fills `iss`, `aud`, times and contact claims).
    pub fn sign_id_token(&self, claims: &IdTokenClaims) -> Result<String, JwtError> {
        self.sign(claims)
    }
}

fn map_jwt_error(e: jsonwebtoken::errors::Error) -> JwtError {
    use jsonwebtoken::errors::ErrorKind;
    match e.kind() {
        ErrorKind::ExpiredSignature => JwtError::Expired,
        ErrorKind::ImmatureSignature => JwtError::NotYetValid,
        ErrorKind::InvalidSignature => JwtError::BadSignature,
        ErrorKind::MissingRequiredClaim(c) => JwtError::Malformed(format!("missing claim '{c}'")),
        other => JwtError::Malformed(format!("{other:?}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{DEV_JWT_KEY_ID, DEV_JWT_SEED};

    fn keys() -> JwtKeys {
        JwtKeys::from_private_key(DEV_JWT_SEED, DEV_JWT_KEY_ID, "http://localhost:8590")
            .expect("dev key")
    }

    fn input(family: uuid::Uuid) -> AccessTokenInput<'static> {
        AccessTokenInput {
            account_uuid: "a8K",
            app_id: "briefcase",
            kind: AccountKind::Carbon,
            id: "c:saket",
            family_id: family,
            scope: "profile email",
            ttl_seconds: 1800,
        }
    }

    #[test]
    fn access_token_round_trip() {
        let k = keys();
        let fid = uuid::Uuid::now_v7();
        let (jwt, claims) = k.sign_access(&input(fid)).expect("sign");
        let header = jsonwebtoken::decode_header(&jwt).expect("header");
        assert_eq!(header.kid.as_deref(), Some("dev-1"));
        assert_eq!(header.alg, Algorithm::EdDSA);
        let back = k.verify_access(&jwt, Some("briefcase")).expect("verify");
        assert_eq!(back, claims);
        assert_eq!(back.mid, "briefcase:a8K");
        assert_eq!(back.family_id(), Some(fid));
        assert_eq!(back.exp - back.iat, 1800);
        assert_eq!(
            k.verify_access(&jwt, Some("accounts")),
            Err(JwtError::WrongAudience {
                expected: "accounts".into(),
                got: "briefcase".into()
            })
        );
    }

    #[test]
    fn rejects_foreign_expired_and_tampered_tokens() {
        let k = keys();
        let (other, _) = JwtKeys::generate("dev-1", "http://localhost:8590").expect("gen");
        let (jwt, _) = other
            .sign_access(&input(uuid::Uuid::now_v7()))
            .expect("sign");
        assert_eq!(k.verify_access(&jwt, None), Err(JwtError::BadSignature));

        let (other_kid, _) = JwtKeys::generate("old-key", "http://localhost:8590").expect("gen");
        let (jwt, _) = other_kid
            .sign_access(&input(uuid::Uuid::now_v7()))
            .expect("sign");
        assert_eq!(
            k.verify_access(&jwt, None),
            Err(JwtError::UnknownKey("old-key".into()))
        );

        let mut expired = input(uuid::Uuid::now_v7());
        expired.ttl_seconds = -120;
        let (jwt, _) = k.sign_access(&expired).expect("sign");
        assert_eq!(k.verify_access(&jwt, None), Err(JwtError::Expired));

        let other_issuer =
            JwtKeys::from_private_key(DEV_JWT_SEED, DEV_JWT_KEY_ID, "https://evil.test")
                .expect("k");
        let (jwt, _) = other_issuer
            .sign_access(&input(uuid::Uuid::now_v7()))
            .expect("sign");
        assert!(matches!(
            k.verify_access(&jwt, None),
            Err(JwtError::WrongIssuer { .. })
        ));

        assert!(matches!(
            k.verify_access("not.a.jwt", None),
            Err(JwtError::Malformed(_))
        ));
    }

    #[test]
    fn jwks_matches_the_key() {
        let k = keys();
        let jwks = k.jwks();
        let key = &jwks["keys"][0];
        assert_eq!(key["kty"], "OKP");
        assert_eq!(key["crv"], "Ed25519");
        assert_eq!(key["alg"], "EdDSA");
        assert_eq!(key["kid"], "dev-1");
        // A verifier built only from the JWKS accepts our tokens.
        let x = key["x"].as_str().expect("x");
        let decoding = DecodingKey::from_ed_components(x).expect("jwk");
        let (jwt, _) = k.sign_access(&input(uuid::Uuid::now_v7())).expect("sign");
        let mut v = Validation::new(Algorithm::EdDSA);
        v.set_audience(&["briefcase"]);
        let data =
            jsonwebtoken::decode::<AccessClaims>(&jwt, &decoding, &v).expect("verify with jwks");
        assert_eq!(data.claims.sub, "a8K");
    }

    #[test]
    fn pem_and_seed_keys_agree() {
        let seed = crate::config::decode_key32(DEV_JWT_SEED).expect("seed");
        let pem = private_key_pem(&seed).expect("pem");
        assert!(pem.contains("BEGIN PRIVATE KEY"));
        let from_pem = parse_private_key(&pem).expect("pem parses");
        let escaped = pem.replace('\n', "\\n");
        let from_escaped = parse_private_key(&escaped).expect("escaped pem parses");
        let from_seed = parse_private_key(DEV_JWT_SEED).expect("seed parses");
        assert_eq!(from_pem.to_bytes(), from_seed.to_bytes());
        assert_eq!(from_escaped.to_bytes(), from_seed.to_bytes());
        assert!(parse_private_key("nope").is_err());
    }

    #[test]
    fn id_token_omits_ungranted_claims() {
        let k = keys();
        let claims = IdTokenClaims {
            iss: k.issuer().into(),
            sub: "a8K".into(),
            aud: "quill-docs".into(),
            exp: time::OffsetDateTime::now_utc().unix_timestamp() + 600,
            iat: time::OffsetDateTime::now_utc().unix_timestamp(),
            nonce: Some("n-1".into()),
            name: Some("Saket".into()),
            ..Default::default()
        };
        let jwt = k.sign_id_token(&claims).expect("sign");
        let v: Value = k.verify(&jwt, Some("quill-docs")).expect("verify");
        assert_eq!(v["nonce"], "n-1");
        assert!(v.get("email").is_none());
    }
}
