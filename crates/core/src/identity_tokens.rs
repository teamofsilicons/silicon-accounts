//! Identity tokens: OpenID Connect ID tokens a signed-in Silicon presents to an outside service
//! (AWS STS, Google Cloud workload identity federation, Microsoft Entra federated credentials)
//! instead of a stored cloud key.
//!
//! **Signing key.** Cloud token services verify RS256 (and some ES256) but not EdDSA, so
//! identity tokens are signed with their own RSA 2048 key, published in the same JWKS as the
//! Ed25519 key under its own `kid` (the RFC 7638 thumbprint). The Ed25519 key keeps signing
//! everything else. The service makes the RSA key itself the first time it is needed (the API
//! asks at start-up), seals it with the encryption keyring and stores it in `signing_keys`;
//! every API node then loads the same key. Concurrent first starts agree on one key: the
//! insert is guarded by a unique index and the loser loads the winner's key.
//!
//! **Claims.** `iss` (the public URL), `sub` (the Silicon's uuid), `aud` (one outside
//! audience), `iat`, `nbf`, `exp` (60 to 3600 seconds later), `jti`, plus `kind: "silicon"`,
//! `si_id`, `custodian` (the custodian's uuid) and `token_use: "identity"`. Our own API never
//! accepts one as a bearer token: it is RS256 (access tokens are EdDSA), and the `token_use`
//! claim is refused even if that ever changed.

use std::sync::Arc;

use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation};
use rsa::pkcs1::EncodeRsaPrivateKey;
use rsa::pkcs8::{DecodePrivateKey, EncodePrivateKey};
use rsa::traits::PublicKeyParts;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::PgPool;
use tokio::sync::OnceCell;

use crate::crypto::{Keyring, b64url, sha256};
use crate::error::{ApiError, ApiResult};

/// The `token_use` claim of every identity token.
pub const TOKEN_USE_IDENTITY: &str = "identity";
/// The purpose of the identity-token key in `signing_keys`.
pub const PURPOSE: &str = "identity_token";
/// The algorithm of identity tokens.
pub const ALGORITHM: &str = "RS256";
/// Shortest and longest lifetimes of an identity token, and the default.
pub const MIN_TTL_SECONDS: i64 = 60;
pub const MAX_TTL_SECONDS: i64 = 3600;
pub const DEFAULT_TTL_SECONDS: i64 = 300;
/// Most audiences one Silicon may be allowed.
pub const MAX_AUDIENCES: usize = 20;
/// Longest audience.
pub const MAX_AUDIENCE_CHARS: usize = 400;
/// Size of the RSA key.
pub const RSA_BITS: usize = 2048;

/// Claims of an identity token.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IdentityClaims {
    pub iss: String,
    /// The Silicon's uuid.
    pub sub: String,
    pub aud: String,
    pub iat: i64,
    pub nbf: i64,
    pub exp: i64,
    pub jti: String,
    /// Always `silicon`.
    pub kind: String,
    /// The Silicon's si:id when the token was issued.
    pub si_id: String,
    /// The custodian's uuid.
    pub custodian: String,
    /// Always [`TOKEN_USE_IDENTITY`].
    pub token_use: String,
}

/// The RS256 key that signs identity tokens.
#[derive(Clone)]
pub struct IdentitySigner {
    kid: String,
    encoding: EncodingKey,
    decoding: DecodingKey,
    jwk: Value,
}

impl std::fmt::Debug for IdentitySigner {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("IdentitySigner")
            .field("kid", &self.kid)
            .finish_non_exhaustive()
    }
}

impl IdentitySigner {
    /// A signer from an RSA private key as PKCS#8 DER.
    pub fn from_pkcs8_der(der: &[u8]) -> Result<IdentitySigner, String> {
        let key = rsa::RsaPrivateKey::from_pkcs8_der(der)
            .map_err(|e| format!("the stored identity-token key isn't an RSA PKCS#8 key ({e})"))?;
        IdentitySigner::from_key(&key)
    }

    /// A signer from an RSA private key as a PKCS#8 PEM (tests and tooling).
    pub fn from_pkcs8_pem(pem: &str) -> Result<IdentitySigner, String> {
        let key = rsa::RsaPrivateKey::from_pkcs8_pem(pem.trim())
            .map_err(|e| format!("not an RSA PKCS#8 PEM private key ({e})"))?;
        IdentitySigner::from_key(&key)
    }

    fn from_key(key: &rsa::RsaPrivateKey) -> Result<IdentitySigner, String> {
        if key.size() * 8 < RSA_BITS {
            return Err(format!(
                "the identity-token key has {} bits; at least {RSA_BITS} are required",
                key.size() * 8
            ));
        }
        let pkcs1 = key
            .to_pkcs1_der()
            .map_err(|e| format!("could not encode the identity-token key ({e})"))?;
        let public = key.to_public_key();
        let n = b64url(&public.n().to_bytes_be());
        let e = b64url(&public.e().to_bytes_be());
        let kid = thumbprint(&n, &e);
        let decoding = DecodingKey::from_rsa_components(&n, &e)
            .map_err(|e| format!("could not read the identity-token public key ({e})"))?;
        Ok(IdentitySigner {
            jwk: json!({
                "kty": "RSA",
                "n": n,
                "e": e,
                "kid": kid,
                "use": "sig",
                "alg": ALGORITHM,
            }),
            kid,
            encoding: EncodingKey::from_rsa_der(pkcs1.as_bytes()),
            decoding,
        })
    }

    /// A new random RSA 2048 key: the signer and the key as PKCS#8 DER (to store sealed).
    pub fn generate() -> Result<(IdentitySigner, Vec<u8>), String> {
        let mut rng = rsa::rand_core::OsRng;
        let key = rsa::RsaPrivateKey::new(&mut rng, RSA_BITS)
            .map_err(|e| format!("could not generate the identity-token key ({e})"))?;
        let der = key
            .to_pkcs8_der()
            .map_err(|e| format!("could not encode the identity-token key ({e})"))?;
        let signer = IdentitySigner::from_key(&key)?;
        Ok((signer, der.as_bytes().to_vec()))
    }

    /// The key id (RFC 7638 thumbprint of the public key).
    pub fn kid(&self) -> &str {
        &self.kid
    }

    /// The public key as a JWK (`kty RSA`, `alg RS256`).
    pub fn jwk(&self) -> &Value {
        &self.jwk
    }

    /// Signs identity claims (`alg RS256`, `typ JWT`, the `kid` header).
    pub fn sign(&self, claims: &IdentityClaims) -> Result<String, String> {
        let mut header = Header::new(Algorithm::RS256);
        header.kid = Some(self.kid.clone());
        header.typ = Some("JWT".into());
        jsonwebtoken::encode(&header, claims, &self.encoding)
            .map_err(|e| format!("could not sign the identity token ({e})"))
    }

    /// Verifies an identity token signed by this key for `audience` (tests and tooling; the
    /// outside services verify them with the JWKS).
    pub fn verify(
        &self,
        token: &str,
        issuer: &str,
        audience: &str,
    ) -> Result<IdentityClaims, String> {
        let mut v = Validation::new(Algorithm::RS256);
        v.set_issuer(&[issuer]);
        v.set_audience(&[audience]);
        v.leeway = 30;
        v.validate_nbf = true;
        v.set_required_spec_claims(&["exp", "iat", "iss", "sub", "aud"]);
        jsonwebtoken::decode::<IdentityClaims>(token, &self.decoding, &v)
            .map(|d| d.claims)
            .map_err(|e| format!("{e}"))
    }
}

/// True when `token` reads (without any signature check) as an identity token: its payload says
/// `token_use: "identity"`. Used to refuse it with a precise error where an access token is
/// expected.
pub fn is_identity_token(token: &str) -> bool {
    use base64::Engine as _;
    let Some(payload) = token.trim().split('.').nth(1) else {
        return false;
    };
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload.trim_end_matches('='))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .is_some_and(|claims| {
            claims.get("token_use").and_then(Value::as_str) == Some(TOKEN_USE_IDENTITY)
        })
}

/// 401 `identity_token_not_accepted`: an identity token was sent where an access token belongs.
pub fn not_an_access_token() -> ApiError {
    ApiError::unauthenticated(
        "identity_token_not_accepted",
        "This is an identity token (token_use=identity): it proves the Silicon to an outside service such as AWS STS, Google Cloud or Microsoft Entra, and Silicon Accounts never accepts one as an access token.",
    )
    .hint("Send the Silicon's access token (Authorization: Bearer <access token>) instead.")
}

/// RFC 7638 JWK thumbprint of an RSA key: base64url SHA-256 of `{"e","kty","n"}`.
pub fn thumbprint(n: &str, e: &str) -> String {
    let canonical = format!("{{\"e\":\"{e}\",\"kty\":\"RSA\",\"n\":\"{n}\"}}");
    b64url(&sha256(canonical.as_bytes()))
}

/// The identity-token key of this deployment, loaded (or made) once per process.
#[derive(Clone, Default)]
pub struct IdentityKeyCell(Arc<OnceCell<IdentitySigner>>);

impl std::fmt::Debug for IdentityKeyCell {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_tuple("IdentityKeyCell")
            .field(&self.0.get().map(IdentitySigner::kid))
            .finish()
    }
}

impl IdentityKeyCell {
    /// An empty cell (the key loads on first use).
    pub fn new() -> IdentityKeyCell {
        IdentityKeyCell::default()
    }

    /// A cell that already holds `signer` (tests).
    pub fn with(signer: IdentitySigner) -> IdentityKeyCell {
        IdentityKeyCell(Arc::new(OnceCell::new_with(Some(signer))))
    }

    /// The key, loaded from `signing_keys` (made and stored first when there is none).
    pub async fn get(&self, db: &PgPool, keyring: &Keyring) -> ApiResult<&IdentitySigner> {
        self.0
            .get_or_try_init(|| async { load_or_create(db, keyring).await })
            .await
    }

    /// The key when it was already loaded (never touches the database).
    pub fn loaded(&self) -> Option<&IdentitySigner> {
        self.0.get()
    }
}

async fn load_current(db: &PgPool, keyring: &Keyring) -> ApiResult<Option<IdentitySigner>> {
    let row: Option<(String, Vec<u8>)> = sqlx::query_as(
        "select kid, private_key_enc from signing_keys where purpose = $1 and retired_at is null",
    )
    .bind(PURPOSE)
    .fetch_optional(db)
    .await?;
    let Some((kid, sealed)) = row else {
        return Ok(None);
    };
    let der = keyring.decrypt(&sealed).map_err(|e| {
        ApiError::internal(format!(
            "the identity-token key {kid} can't be opened with the encryption keyring ({e}); keep every key version that sealed it in ACCOUNTS_ENCRYPTION_KEYRING"
        ))
    })?;
    let signer = IdentitySigner::from_pkcs8_der(&der).map_err(ApiError::internal)?;
    if signer.kid() != kid {
        return Err(ApiError::internal(format!(
            "the stored identity-token key {kid} doesn't match its own thumbprint {}",
            signer.kid()
        )));
    }
    Ok(Some(signer))
}

/// Loads the current identity-token key, or makes one, seals it with the keyring and stores
/// it. Safe to call from several nodes at once: one insert wins, everyone loads the winner.
pub async fn load_or_create(db: &PgPool, keyring: &Keyring) -> ApiResult<IdentitySigner> {
    if let Some(signer) = load_current(db, keyring).await? {
        return Ok(signer);
    }
    let (signer, der) = tokio::task::spawn_blocking(IdentitySigner::generate)
        .await
        .map_err(|e| ApiError::internal(format!("generating the identity-token key: {e}")))?
        .map_err(ApiError::internal)?;
    let sealed = keyring
        .encrypt(&der)
        .map_err(|e| ApiError::internal(format!("sealing the identity-token key: {e}")))?;
    let inserted = sqlx::query(
        "insert into signing_keys (kid, purpose, algorithm, private_key_enc, public_jwk) \
         values ($1, $2, $3, $4, $5) on conflict do nothing",
    )
    .bind(signer.kid())
    .bind(PURPOSE)
    .bind(ALGORITHM)
    .bind(&sealed)
    .bind(signer.jwk())
    .execute(db)
    .await?
    .rows_affected();
    if inserted == 1 {
        tracing::info!(
            kid = signer.kid(),
            "made the RS256 identity-token signing key"
        );
        return Ok(signer);
    }
    load_current(db, keyring).await?.ok_or_else(|| {
        ApiError::internal("the identity-token key was neither stored nor found".to_string())
    })
}

/// Checks one audience a custodian allows: printable ASCII without spaces, at most
/// [`MAX_AUDIENCE_CHARS`] characters, and shaped like a host name, URL or URN (it holds `.`,
/// `:` or `/`). The last rule means an audience can never equal an app id, so an identity
/// token can't pass for one of our id_tokens at an app; `issuer` (our own origin) and anything
/// under it are refused for the same reason.
pub fn validate_audience(raw: &str, issuer: &str) -> Result<String, String> {
    let a = raw.trim();
    if a.is_empty() {
        return Err("an audience can't be empty".into());
    }
    if a.chars().count() > MAX_AUDIENCE_CHARS {
        return Err(format!(
            "an audience is at most {MAX_AUDIENCE_CHARS} characters"
        ));
    }
    if !a.bytes().all(|b| b.is_ascii_graphic()) {
        return Err(format!(
            "'{}' holds spaces or characters outside printable ASCII",
            a.chars().take(60).collect::<String>()
        ));
    }
    if !a.contains(['.', ':', '/']) {
        return Err(format!(
            "'{a}' isn't a host name, URL or URN (like sts.amazonaws.com, https://iam.googleapis.com/... or api://AzureADTokenExchange); an audience can't look like an app id, so an identity token is never taken for a sign-in token"
        ));
    }
    let ours = issuer.trim_end_matches('/');
    if !ours.is_empty() && (a.trim_end_matches('/') == ours || a.starts_with(&format!("{ours}/"))) {
        return Err(format!(
            "'{a}' is Silicon Accounts itself; identity tokens are for outside services (use the access token here)"
        ));
    }
    Ok(a.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audiences_must_look_like_outside_services() {
        let issuer = "https://accounts.teamofsilicons.com";
        assert_eq!(
            validate_audience(" sts.amazonaws.com ", issuer).as_deref(),
            Ok("sts.amazonaws.com")
        );
        assert!(validate_audience("api://AzureADTokenExchange", issuer).is_ok());
        assert!(
            validate_audience(
                "https://iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/providers/q",
                issuer
            )
            .is_ok()
        );
        assert!(validate_audience("briefcase", issuer).is_err());
        assert!(validate_audience("", issuer).is_err());
        assert!(validate_audience("a b.c", issuer).is_err());
        assert!(validate_audience(issuer, issuer).is_err());
        assert!(validate_audience(&format!("{issuer}/v1/oauth/token"), issuer).is_err());
        assert!(validate_audience(&"a.".repeat(300), issuer).is_err());
    }

    #[test]
    fn a_generated_key_signs_tokens_its_jwk_verifies() {
        let (signer, der) = IdentitySigner::generate().expect("generate");
        let again = IdentitySigner::from_pkcs8_der(&der).expect("reload");
        assert_eq!(again.kid(), signer.kid());
        assert_eq!(signer.jwk()["kty"], "RSA");
        assert_eq!(signer.jwk()["alg"], "RS256");
        assert_eq!(signer.jwk()["kid"], signer.kid());
        let now = 1_900_000_000;
        let claims = IdentityClaims {
            iss: "https://accounts.example".into(),
            sub: "a8K".into(),
            aud: "sts.amazonaws.com".into(),
            iat: now,
            nbf: now,
            exp: now + 300,
            jti: "j1".into(),
            kind: "silicon".into(),
            si_id: "si:scout".into(),
            custodian: "zQo".into(),
            token_use: TOKEN_USE_IDENTITY.into(),
        };
        let token = signer.sign(&claims).expect("sign");
        assert!(is_identity_token(&token));
        let header = jsonwebtoken::decode_header(&token).expect("header");
        assert_eq!(header.alg, Algorithm::RS256);
        assert_eq!(header.kid.as_deref(), Some(signer.kid()));
        // Anyone holding only the JWK verifies it.
        let jwk: jsonwebtoken::jwk::Jwk =
            serde_json::from_value(signer.jwk().clone()).expect("jwk");
        let key = DecodingKey::from_jwk(&jwk).expect("decoding key");
        let mut v = Validation::new(Algorithm::RS256);
        v.set_audience(&["sts.amazonaws.com"]);
        v.validate_exp = false;
        let back = jsonwebtoken::decode::<IdentityClaims>(&token, &key, &v).expect("verify");
        assert_eq!(back.claims, claims);
    }

    #[test]
    fn thumbprints_follow_rfc_7638() {
        // The example key of RFC 7638 section 3.1.
        let n = "0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw";
        let e = "AQAB";
        assert_eq!(
            thumbprint(n, e),
            "NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs"
        );
    }
}
