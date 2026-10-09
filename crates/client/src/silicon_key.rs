//! A Silicon's signing key: sign in without an STK.
//!
//! The Silicon (or its custodian) registers the public half once
//! ([`crate::AccountSession::add_silicon_key`]); afterwards the Silicon signs a short-lived JWT
//! assertion with the private half for every sign-in
//! ([`crate::AccountsClient::silicon_login_with_key`]). The private key never leaves the
//! machine, and an assertion works once and expires within minutes, so nothing long-lived and
//! replayable is ever sent.
//!
//! Key files: a PKCS#8 PEM (`-----BEGIN PRIVATE KEY-----`, what
//! `openssl genpkey -algorithm ed25519` writes and [`SiliconSigningKey::to_pkcs8_pem`] saves) or
//! an unencrypted OpenSSH key (`ssh-keygen -t ed25519 -N ''`).

use std::fmt;
use std::path::Path;

use base64::Engine as _;
use ed25519_dalek::pkcs8::{DecodePrivateKey, EncodePrivateKey};
use ed25519_dalek::{Signer, SigningKey};
use rand::RngCore as _;
use serde_json::json;
use zeroize::Zeroizing;

use crate::error::{Error, Result};

/// An Ed25519 private key a Silicon signs its sign-ins with. `Debug` never shows it.
#[derive(Clone)]
pub struct SiliconSigningKey {
    key: SigningKey,
}

impl fmt::Debug for SiliconSigningKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SiliconSigningKey")
            .field("public_key", &self.public_key_base64url())
            .finish_non_exhaustive()
    }
}

fn bad_key(message: impl Into<String>) -> Error {
    Error::invalid_input(
        message,
        "Use an Ed25519 private key: a PEM PRIVATE KEY (openssl genpkey -algorithm ed25519) or an unencrypted OpenSSH key (ssh-keygen -t ed25519 -N '').",
    )
}

impl SiliconSigningKey {
    /// A new random key.
    pub fn generate() -> SiliconSigningKey {
        let mut seed = Zeroizing::new([0u8; 32]);
        rand::rng().fill_bytes(seed.as_mut());
        SiliconSigningKey {
            key: SigningKey::from_bytes(&seed),
        }
    }

    /// Reads a key file (PKCS#8 PEM or unencrypted OpenSSH).
    pub fn from_file(path: &Path) -> Result<SiliconSigningKey> {
        let text = Zeroizing::new(std::fs::read_to_string(path).map_err(|e| {
            bad_key(format!(
                "Could not read the key file {}: {e}.",
                path.display()
            ))
        })?);
        SiliconSigningKey::parse(&text)
    }

    /// Parses a PKCS#8 PEM or unencrypted OpenSSH private key.
    pub fn parse(text: &str) -> Result<SiliconSigningKey> {
        let text = text.trim();
        if text.starts_with("-----BEGIN PRIVATE KEY-----") {
            return SigningKey::from_pkcs8_pem(text)
                .map(|key| SiliconSigningKey { key })
                .map_err(|_| bad_key("The PEM isn't an Ed25519 private key."));
        }
        if text.starts_with("-----BEGIN OPENSSH PRIVATE KEY-----") {
            return parse_openssh(text)
                .map(|key| SiliconSigningKey { key })
                .ok_or_else(|| {
                    bad_key("The OpenSSH key isn't an unencrypted Ed25519 key (a passphrase-protected key can't be read).")
                });
        }
        Err(bad_key(
            "The file isn't a private key (it should start with -----BEGIN PRIVATE KEY----- or -----BEGIN OPENSSH PRIVATE KEY-----).",
        ))
    }

    /// The key as a PKCS#8 PEM, to save it (keep the file private).
    pub fn to_pkcs8_pem(&self) -> Result<Zeroizing<String>> {
        self.key
            .to_pkcs8_pem(ed25519_dalek::pkcs8::spki::der::pem::LineEnding::LF)
            .map_err(|e| bad_key(format!("Could not encode the key: {e}.")))
    }

    /// The public key, 32 bytes in base64url: what to register.
    pub fn public_key_base64url(&self) -> String {
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(self.key.verifying_key().to_bytes())
    }

    /// A signed assertion naming `silicon` (si:id or uuid) for `audience` (the token endpoint),
    /// valid `ttl_seconds` (at most 300), with a fresh `jti`.
    pub fn assertion(
        &self,
        silicon: &str,
        audience: &str,
        kid: Option<&str>,
        ttl_seconds: i64,
    ) -> String {
        let now = time::OffsetDateTime::now_utc().unix_timestamp();
        let mut jti = [0u8; 16];
        rand::rng().fill_bytes(&mut jti);
        let mut header = json!({"alg": "EdDSA", "typ": "JWT"});
        if let Some(kid) = kid {
            header["kid"] = json!(kid);
        }
        let claims = json!({
            "iss": silicon, "sub": silicon, "aud": audience,
            "iat": now, "exp": now + ttl_seconds.clamp(1, 300),
            "jti": hex::encode(jti),
        });
        let e = |v: &serde_json::Value| {
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(v.to_string().as_bytes())
        };
        let signed = format!("{}.{}", e(&header), e(&claims));
        let signature = self.key.sign(signed.as_bytes());
        format!(
            "{signed}.{}",
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(signature.to_bytes())
        )
    }
}

/// An unencrypted `openssh-key-v1` Ed25519 private key.
fn parse_openssh(text: &str) -> Option<SigningKey> {
    let body: String = text
        .lines()
        .filter(|l| !l.starts_with("-----"))
        .collect::<Vec<_>>()
        .join("");
    let blob = Zeroizing::new(
        base64::engine::general_purpose::STANDARD
            .decode(body.trim())
            .ok()?,
    );
    let magic = b"openssh-key-v1\0";
    let mut at = magic.len();
    if blob.get(..at)? != magic {
        return None;
    }
    let read = |at: &mut usize| -> Option<Vec<u8>> {
        let len = u32::from_be_bytes(blob.get(*at..*at + 4)?.try_into().ok()?) as usize;
        let start = *at + 4;
        let out = blob.get(start..start + len)?.to_vec();
        *at = start + len;
        Some(out)
    };
    if read(&mut at)? != b"none" || read(&mut at)? != b"none" {
        return None; // encrypted
    }
    let _kdf_options = read(&mut at)?;
    let count = u32::from_be_bytes(blob.get(at..at + 4)?.try_into().ok()?);
    at += 4;
    if count != 1 {
        return None;
    }
    let _public = read(&mut at)?;
    let private = Zeroizing::new(read(&mut at)?);
    // checkint, checkint, keytype, public key, private key (seed || public), comment, padding
    let mut p = 8usize;
    let take = |p: &mut usize| -> Option<Vec<u8>> {
        let len = u32::from_be_bytes(private.get(*p..*p + 4)?.try_into().ok()?) as usize;
        let start = *p + 4;
        let out = private.get(start..start + len)?.to_vec();
        *p = start + len;
        Some(out)
    };
    if private.get(0..4)? != private.get(4..8)? || take(&mut p)? != b"ssh-ed25519" {
        return None;
    }
    let _pk = take(&mut p)?;
    let secret = Zeroizing::new(take(&mut p)?);
    let seed: [u8; 32] = secret.get(..32)?.try_into().ok()?;
    Some(SigningKey::from_bytes(&seed))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_round_trip_and_sign() {
        let key = SiliconSigningKey::generate();
        let pem = key.to_pkcs8_pem().expect("pem");
        let again = SiliconSigningKey::parse(&pem).expect("parse");
        assert_eq!(again.public_key_base64url(), key.public_key_base64url());
        assert!(!format!("{key:?}").contains("PRIVATE"));
        let jwt = key.assertion(
            "si:scout",
            "https://a.example/v1/oauth/token",
            Some("k1"),
            120,
        );
        assert_eq!(jwt.split('.').count(), 3);
        assert!(SiliconSigningKey::parse("ssh-ed25519 AAAA").is_err());
    }

    #[test]
    fn openssh_keys_are_read() {
        // ssh-keygen -t ed25519 -N '' (a throwaway key made for this test).
        let text = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\nQyNTUxOQAAACAWQ4vweojFShksOEBMN8B2ey/hFFkILbWkDviUuwLJuQAAAJDhpx9V4acf\nVQAAAAtzc2gtZWQyNTUxOQAAACAWQ4vweojFShksOEBMN8B2ey/hFFkILbWkDviUuwLJuQ\nAAAEABb84Ppt6infVVbgMnalDVgse5U71tFYaY/dfhcWYfwhZDi/B6iMVKGSw4QEw3wHZ7\nL+EUWQgttaQO+JS7Asm5AAAACnRlc3RAbG9jYWwBAgM=\n-----END OPENSSH PRIVATE KEY-----\n";
        let key = SiliconSigningKey::parse(text).expect("openssh");
        assert_eq!(
            key.public_key_base64url(),
            "FkOL8HqIxUoZLDhATDfAdnsv4RRZCC21pA74lLsCybk"
        );
    }
}
