//! Cryptography: random tokens, peppered hashes, the encryption keyring, STKs, PKCE, OTP and
//! device codes, webhook signatures.
//!
//! - Every random token is `prefix + base64url(32 random bytes)` ([`random_token`] with a
//!   [`prefix`] constant). Only `HMAC-SHA256(pepper, token)` is stored ([`Pepper::hash`]).
//! - Secrets that must be read back (webhook secrets, BYO provider secrets, PKCE verifiers) are
//!   encrypted with [`Keyring::encrypt`]: `version byte || 12-byte nonce || AES-256-GCM ciphertext`.
//! - STKs (a Silicon's password) are low-entropy, so they are hashed with Argon2id
//!   ([`stk::StkHasher`]).

use std::collections::BTreeMap;
use std::fmt;

use aes_gcm::aead::Aead;
use aes_gcm::aead::generic_array::GenericArray;
use aes_gcm::{Aes256Gcm, KeyInit};
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, Mac};
use rand::{RngCore, TryRngCore};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use zeroize::Zeroizing;

/// Token prefixes (see the build spec's "Secrets and token formats").
pub mod prefix {
    /// Browser session cookie value.
    pub const SESSION: &str = "sas_";
    /// Refresh token.
    pub const REFRESH: &str = "sar_";
    /// Authorization code.
    pub const AUTH_CODE: &str = "sac_";
    /// Short-lived token (Silicon → app).
    pub const SLT: &str = "slt_";
    /// Device code (CLI device flow).
    pub const DEVICE_CODE: &str = "sad_";
    /// Proof access token.
    pub const PROOF: &str = "sap_";
    /// Proof refresh token.
    pub const PROOF_REFRESH: &str = "sapr_";
    /// Flow-binding cookie value.
    pub const FLOW: &str = "saf_";
    /// Sign-up session cookie value.
    pub const SIGNUP: &str = "sau_";
    /// Silicon custodian-request polling token.
    pub const SILICON_REQUEST: &str = "sarq_";
    /// Webhook signing secret.
    pub const WEBHOOK_SECRET: &str = "whsec_";
    /// App secret.
    pub const APP_SECRET: &str = "sa_app_";
}

/// What kind of credential a string looks like, from its prefix (for precise error messages).
pub fn describe_token(token: &str) -> Option<&'static str> {
    let t = token.trim();
    // Longest prefixes first (sapr_ before sap_, sarq_ before sar_).
    let table: [(&str, &str); 12] = [
        (prefix::PROOF_REFRESH, "a proof refresh token"),
        (prefix::SILICON_REQUEST, "a Silicon request polling token"),
        (prefix::APP_SECRET, "an app secret"),
        (prefix::WEBHOOK_SECRET, "a webhook signing secret"),
        (prefix::PROOF, "a proof token"),
        (prefix::REFRESH, "a refresh token"),
        (prefix::SESSION, "a browser session cookie"),
        (prefix::AUTH_CODE, "an authorization code"),
        (prefix::SLT, "a short-lived token"),
        (prefix::DEVICE_CODE, "a device code"),
        (prefix::FLOW, "a sign-in flow cookie"),
        (prefix::SIGNUP, "a sign-up session cookie"),
    ];
    if t.starts_with("stk-") {
        return Some("an STK (a Silicon's password)");
    }
    if t.starts_with("eyJ") {
        return Some("a JWT access token");
    }
    table
        .iter()
        .find(|(p, _)| t.starts_with(p))
        .map(|(_, d)| *d)
}

/// Crypto failures (never contain secret material).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CryptoError {
    #[error("ciphertext is too short or malformed")]
    Malformed,
    #[error("ciphertext was encrypted with keyring version {0}, which is not configured")]
    UnknownKeyVersion(u8),
    #[error("decryption failed (wrong key or tampered data)")]
    Decrypt,
    #[error("encryption failed")]
    Encrypt,
    #[error("decrypted value is not UTF-8")]
    NotUtf8,
    #[error("hashing failed: {0}")]
    Hash(String),
    #[error("invalid key: {0}")]
    InvalidKey(String),
}

/// `N` cryptographically secure random bytes (OS RNG; falls back to the thread CSPRNG).
pub fn random_bytes<const N: usize>() -> [u8; N] {
    let mut buf = [0u8; N];
    if rand::rngs::OsRng.try_fill_bytes(&mut buf).is_err() {
        // ThreadRng is ChaCha12 seeded from the OS RNG: still a CSPRNG.
        rand::rng().fill_bytes(&mut buf);
    }
    buf
}

/// `prefix + base64url(32 random bytes)`.
pub fn random_token(prefix: &str) -> String {
    format!("{prefix}{}", b64url(&random_bytes::<32>()))
}

/// base64url without padding.
pub fn b64url(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

/// Decodes base64url (padding optional).
pub fn b64url_decode(s: &str) -> Result<Vec<u8>, CryptoError> {
    URL_SAFE_NO_PAD
        .decode(s.trim().trim_end_matches('='))
        .map_err(|_| CryptoError::Malformed)
}

/// SHA-256 digest.
pub fn sha256(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

/// Constant-time equality.
pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && bool::from(a.ct_eq(b))
}

/// HMAC-SHA256.
pub fn hmac_sha256(key: &[u8], msg: &[u8]) -> [u8; 32] {
    let mut mac = match <Hmac<Sha256> as Mac>::new_from_slice(key) {
        Ok(m) => m,
        // HMAC accepts keys of any length, so this cannot happen.
        Err(_) => unreachable!("HMAC-SHA256 accepts keys of any length"),
    };
    mac.update(msg);
    mac.finalize().into_bytes().into()
}

/// The token pepper: stored token hashes are `HMAC-SHA256(pepper, token)`.
#[derive(Clone)]
pub struct Pepper(Zeroizing<[u8; 32]>);

impl Pepper {
    pub fn new(key: [u8; 32]) -> Pepper {
        Pepper(Zeroizing::new(key))
    }

    /// Parses ACCOUNTS_TOKEN_PEPPER (base64url 32 bytes).
    pub fn from_base64url(value: &str) -> Result<Pepper, CryptoError> {
        crate::config::decode_key32(value)
            .map(Pepper::new)
            .map_err(CryptoError::InvalidKey)
    }

    /// The stored hash of a token (32 bytes).
    pub fn hash(&self, token: &str) -> Vec<u8> {
        hmac_sha256(self.0.as_slice(), token.as_bytes()).to_vec()
    }

    /// Hash of arbitrary bytes.
    pub fn hash_bytes(&self, bytes: &[u8]) -> Vec<u8> {
        hmac_sha256(self.0.as_slice(), bytes).to_vec()
    }

    /// Constant-time check of a token against a stored hash.
    pub fn verify(&self, token: &str, stored_hash: &[u8]) -> bool {
        constant_time_eq(&self.hash(token), stored_hash)
    }

    /// Hash for a namespaced value (e.g. rate-limit buckets keyed by email) as hex.
    pub fn hash_hex(&self, namespace: &str, value: &str) -> String {
        hex::encode(&self.hash_bytes(format!("{namespace}\u{0}{value}").as_bytes())[..16])
    }
}

impl fmt::Debug for Pepper {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Pepper(redacted)")
    }
}

/// AES-256-GCM keyring with versioned keys. Ciphertexts are
/// `version (1 byte) || nonce (12 bytes) || ciphertext+tag`.
#[derive(Clone)]
pub struct Keyring {
    ciphers: BTreeMap<u8, Aes256Gcm>,
    current: u8,
}

impl Keyring {
    /// Builds a keyring; `current` must be one of the versions.
    pub fn new(keys: &BTreeMap<u8, [u8; 32]>, current: u8) -> Result<Keyring, CryptoError> {
        let mut ciphers = BTreeMap::new();
        for (v, k) in keys {
            let cipher = Aes256Gcm::new_from_slice(k)
                .map_err(|_| CryptoError::InvalidKey("AES key must be 32 bytes".into()))?;
            ciphers.insert(*v, cipher);
        }
        if !ciphers.contains_key(&current) {
            return Err(CryptoError::InvalidKey(format!(
                "current keyring version {current} has no key"
            )));
        }
        Ok(Keyring { ciphers, current })
    }

    /// Parses ACCOUNTS_ENCRYPTION_KEYRING JSON plus the current version.
    pub fn from_json(json: &str, current: u8) -> Result<Keyring, CryptoError> {
        let keys = crate::config::parse_keyring(json).map_err(CryptoError::InvalidKey)?;
        Keyring::new(&keys, current)
    }

    /// The version new ciphertexts use.
    pub fn current_version(&self) -> u8 {
        self.current
    }

    /// Encrypts with the current key.
    pub fn encrypt(&self, plaintext: &[u8]) -> Result<Vec<u8>, CryptoError> {
        let cipher = self
            .ciphers
            .get(&self.current)
            .ok_or(CryptoError::UnknownKeyVersion(self.current))?;
        let nonce = random_bytes::<12>();
        let ct = cipher
            .encrypt(GenericArray::from_slice(&nonce), plaintext)
            .map_err(|_| CryptoError::Encrypt)?;
        let mut out = Vec::with_capacity(1 + 12 + ct.len());
        out.push(self.current);
        out.extend_from_slice(&nonce);
        out.extend_from_slice(&ct);
        Ok(out)
    }

    /// Decrypts a ciphertext made by any configured key version.
    pub fn decrypt(&self, data: &[u8]) -> Result<Vec<u8>, CryptoError> {
        if data.len() < 1 + 12 + 16 {
            return Err(CryptoError::Malformed);
        }
        let version = data[0];
        let cipher = self
            .ciphers
            .get(&version)
            .ok_or(CryptoError::UnknownKeyVersion(version))?;
        cipher
            .decrypt(GenericArray::from_slice(&data[1..13]), &data[13..])
            .map_err(|_| CryptoError::Decrypt)
    }

    pub fn encrypt_str(&self, plaintext: &str) -> Result<Vec<u8>, CryptoError> {
        self.encrypt(plaintext.as_bytes())
    }

    pub fn decrypt_string(&self, data: &[u8]) -> Result<String, CryptoError> {
        String::from_utf8(self.decrypt(data)?).map_err(|_| CryptoError::NotUtf8)
    }

    /// True when the ciphertext was made with an older key (re-encrypt it on the next write).
    pub fn needs_rotation(&self, data: &[u8]) -> bool {
        data.first().is_some_and(|v| *v != self.current)
    }
}

impl fmt::Debug for Keyring {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Keyring")
            .field("versions", &self.ciphers.keys().collect::<Vec<_>>())
            .field("current", &self.current)
            .finish()
    }
}

/// STKs: a Silicon's password.
pub mod stk {
    use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
    use argon2::{Algorithm, Argon2, Params, Version};

    use super::{CryptoError, random_bytes};

    /// Generated STKs are `stk-` + 12 lowercase hex characters.
    pub const GENERATED_HEX_LEN: usize = 12;
    /// Self-set STKs are 8..=32 hex characters.
    pub const MIN_HEX_LEN: usize = 8;
    pub const MAX_HEX_LEN: usize = 32;

    /// A fresh default STK: `stk-` + 12 random lowercase hex characters.
    pub fn generate() -> String {
        format!("stk-{}", hex::encode(random_bytes::<6>()))
    }

    /// Normalizes a self-set (or presented) STK: trims, lowercases, accepts the bare hex and adds
    /// `stk-`. Errors say exactly what is wrong.
    pub fn normalize(input: &str) -> Result<String, String> {
        let s = input.trim().to_ascii_lowercase();
        let hex_part = s.strip_prefix("stk-").unwrap_or(&s);
        if hex_part.is_empty() {
            return Err(
                "The STK is empty; an STK is stk- followed by 8 to 32 hexadecimal characters."
                    .into(),
            );
        }
        if let Some(c) = hex_part.chars().find(|c| !c.is_ascii_hexdigit()) {
            return Err(format!(
                "The STK contains '{c}', which is not hexadecimal; an STK is stk- followed by 8 to 32 characters of 0-9 and a-f."
            ));
        }
        let n = hex_part.len();
        if !(MIN_HEX_LEN..=MAX_HEX_LEN).contains(&n) {
            return Err(format!(
                "The STK has {n} hexadecimal characters; it must have {MIN_HEX_LEN} to {MAX_HEX_LEN} (after the stk- prefix)."
            ));
        }
        Ok(format!("stk-{hex_part}"))
    }

    /// Argon2id parameters for STK hashes. The PHC string records them, so verification works
    /// across parameter changes.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct StkHasher {
        pub m_cost_kib: u32,
        pub t_cost: u32,
        pub p_cost: u32,
    }

    impl StkHasher {
        /// OWASP-recommended Argon2id: 19 MiB, 2 passes, 1 lane.
        pub const PRODUCTION: StkHasher = StkHasher {
            m_cost_kib: 19_456,
            t_cost: 2,
            p_cost: 1,
        };
        /// Cheap parameters for tests (never use in a running service).
        pub const FAST_FOR_TESTS: StkHasher = StkHasher {
            m_cost_kib: 256,
            t_cost: 1,
            p_cost: 1,
        };

        /// Hashes a normalized STK into a PHC string.
        pub fn hash(&self, stk: &str) -> Result<String, CryptoError> {
            let params = Params::new(self.m_cost_kib, self.t_cost, self.p_cost, None)
                .map_err(|e| CryptoError::Hash(e.to_string()))?;
            let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
            let salt = SaltString::encode_b64(&random_bytes::<16>())
                .map_err(|e| CryptoError::Hash(e.to_string()))?;
            argon
                .hash_password(stk.as_bytes(), &salt)
                .map(|h| h.to_string())
                .map_err(|e| CryptoError::Hash(e.to_string()))
        }

        /// Verifies a presented STK against a stored PHC string (parameters come from the string).
        pub fn verify(stk: &str, phc: &str) -> bool {
            let Ok(parsed) = PasswordHash::new(phc) else {
                return false;
            };
            Argon2::default()
                .verify_password(stk.as_bytes(), &parsed)
                .is_ok()
        }
    }
}

/// PKCE (RFC 7636).
pub mod pkce {
    use super::{b64url, constant_time_eq, sha256};

    /// The S256 challenge for a verifier.
    pub fn s256_challenge(verifier: &str) -> String {
        b64url(&sha256(verifier.as_bytes()))
    }

    /// Checks a verifier's syntax: 43..=128 characters of `A-Z a-z 0-9 - . _ ~`.
    pub fn validate_verifier(verifier: &str) -> Result<(), String> {
        let n = verifier.len();
        if !(43..=128).contains(&n) {
            return Err(format!(
                "code_verifier is {n} characters; RFC 7636 requires 43 to 128"
            ));
        }
        if let Some(c) = verifier
            .chars()
            .find(|c| !(c.is_ascii_alphanumeric() || "-._~".contains(*c)))
        {
            return Err(format!(
                "code_verifier contains '{c}'; only A-Z, a-z, 0-9, '-', '.', '_' and '~' are allowed"
            ));
        }
        Ok(())
    }

    /// Checks a challenge method name: `S256` (default) or `plain`.
    pub fn validate_method(method: Option<&str>) -> Result<&'static str, String> {
        match method.map(str::trim) {
            None | Some("") | Some("S256") => Ok("S256"),
            Some("plain") => Ok("plain"),
            Some(m) => Err(format!(
                "code_challenge_method '{m}' is not supported; use S256 (or plain)"
            )),
        }
    }

    /// Verifies a verifier against a stored challenge and method.
    pub fn verify(method: Option<&str>, verifier: &str, challenge: &str) -> bool {
        match method.unwrap_or("S256") {
            "plain" => constant_time_eq(verifier.as_bytes(), challenge.as_bytes()),
            "S256" => constant_time_eq(s256_challenge(verifier).as_bytes(), challenge.as_bytes()),
            _ => false,
        }
    }
}

/// A uniformly random 6-digit code (`000000`..=`999999`).
pub fn generate_otp() -> String {
    loop {
        let v = u32::from_le_bytes(random_bytes::<4>());
        // Rejection sampling keeps the distribution uniform.
        if v < 4_294_000_000 {
            return format!("{:06}", v % 1_000_000);
        }
    }
}

/// Characters of device user codes: A-Z without I, L, O, plus 2-9.
pub const USER_CODE_ALPHABET: &[u8] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/// A device user code like `WDJB-MJHT`.
pub fn generate_user_code() -> String {
    let mut out = String::with_capacity(9);
    let n = USER_CODE_ALPHABET.len() as u8;
    let limit = 256 - (256 % n as u16) as u8 as u16;
    while out.len() < 9 {
        for b in random_bytes::<16>() {
            if (b as u16) < limit {
                if out.len() == 4 {
                    out.push('-');
                }
                out.push(USER_CODE_ALPHABET[(b % n) as usize] as char);
                if out.len() == 9 {
                    break;
                }
            }
        }
    }
    out
}

/// Normalizes a typed user code (`wdjb mjht`, `WDJBMJHT`) to `WDJB-MJHT`; `None` if invalid.
pub fn normalize_user_code(input: &str) -> Option<String> {
    let chars: String = input
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .map(|c| c.to_ascii_uppercase())
        .collect();
    if chars.len() != 8 || !chars.bytes().all(|b| USER_CODE_ALPHABET.contains(&b)) {
        return None;
    }
    Some(format!("{}-{}", &chars[..4], &chars[4..]))
}

/// Webhook signature header value: `v1=` + hex(HMAC-SHA256(secret, "{timestamp}.{body}")).
/// The key is the full secret string (including `whsec_`) as UTF-8 bytes.
pub fn webhook_signature(secret: &str, timestamp: i64, body: &[u8]) -> String {
    let mut msg = Vec::with_capacity(body.len() + 21);
    msg.extend_from_slice(timestamp.to_string().as_bytes());
    msg.push(b'.');
    msg.extend_from_slice(body);
    format!("v1={}", hex::encode(hmac_sha256(secret.as_bytes(), &msg)))
}

/// Verifies a webhook signature header (constant time).
pub fn verify_webhook_signature(secret: &str, timestamp: i64, body: &[u8], header: &str) -> bool {
    let expected = webhook_signature(secret, timestamp, body);
    header
        .split(',')
        .map(str::trim)
        .any(|candidate| constant_time_eq(candidate.as_bytes(), expected.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_have_prefix_and_entropy() {
        let a = random_token(prefix::REFRESH);
        let b = random_token(prefix::REFRESH);
        assert!(a.starts_with("sar_"));
        assert_eq!(a.len(), 4 + 43);
        assert_ne!(a, b);
        assert_eq!(describe_token(&a), Some("a refresh token"));
        assert_eq!(describe_token("sapr_x"), Some("a proof refresh token"));
        assert_eq!(
            describe_token("sarq_x"),
            Some("a Silicon request polling token")
        );
        assert_eq!(
            describe_token("stk-abcdef12"),
            Some("an STK (a Silicon's password)")
        );
        assert_eq!(describe_token("nope"), None);
    }

    #[test]
    fn pepper_hashes_are_stable_and_keyed() {
        let p = Pepper::new([7u8; 32]);
        let q = Pepper::new([8u8; 32]);
        let h = p.hash("sar_abc");
        assert_eq!(h.len(), 32);
        assert_eq!(h, p.hash("sar_abc"));
        assert_ne!(h, q.hash("sar_abc"));
        assert!(p.verify("sar_abc", &h));
        assert!(!p.verify("sar_abd", &h));
        assert_eq!(p.hash_hex("otp", "a@b.c").len(), 32);
    }

    #[test]
    fn keyring_round_trip_and_rotation() {
        let mut keys = BTreeMap::new();
        keys.insert(1u8, [1u8; 32]);
        let k1 = Keyring::new(&keys, 1).expect("keyring");
        let ct = k1.encrypt_str("whsec_secret").expect("encrypt");
        assert_eq!(ct[0], 1);
        assert_eq!(k1.decrypt_string(&ct).expect("decrypt"), "whsec_secret");
        assert_ne!(
            k1.encrypt_str("whsec_secret").expect("encrypt"),
            ct,
            "fresh nonce every time"
        );

        keys.insert(2u8, [2u8; 32]);
        let k2 = Keyring::new(&keys, 2).expect("keyring");
        assert_eq!(
            k2.decrypt_string(&ct).expect("old version still decrypts"),
            "whsec_secret"
        );
        assert!(k2.needs_rotation(&ct));
        let ct2 = k2.encrypt_str("x").expect("encrypt");
        assert_eq!(ct2[0], 2);
        assert_eq!(k1.decrypt(&ct2), Err(CryptoError::UnknownKeyVersion(2)));

        let mut tampered = ct.clone();
        let last = tampered.len() - 1;
        tampered[last] ^= 1;
        assert_eq!(k1.decrypt(&tampered), Err(CryptoError::Decrypt));
        assert_eq!(k1.decrypt(&[1, 2, 3]), Err(CryptoError::Malformed));
        assert!(Keyring::new(&keys, 3).is_err());
    }

    #[test]
    fn stk_rules() {
        let g = stk::generate();
        assert!(g.starts_with("stk-") && g.len() == 16, "{g}");
        assert!(
            g[4..]
                .chars()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
        );
        assert_eq!(stk::normalize("ABCDEF12").as_deref(), Ok("stk-abcdef12"));
        assert_eq!(
            stk::normalize(" stk-0123456789abcdef ").as_deref(),
            Ok("stk-0123456789abcdef")
        );
        assert_eq!(
            stk::normalize("STK-ABCDEF12").as_deref(),
            Ok("stk-abcdef12")
        );
        assert!(
            stk::normalize("stk-abc")
                .expect_err("short")
                .contains("has 3 hexadecimal characters")
        );
        assert!(stk::normalize(&"a".repeat(33)).is_err());
        assert!(
            stk::normalize("stk-ghijklmn")
                .expect_err("hex")
                .contains("'g'")
        );
        assert!(stk::normalize("").is_err());
    }

    #[test]
    fn stk_hash_verify() {
        let h = stk::StkHasher::FAST_FOR_TESTS
            .hash("stk-abcdef123456")
            .expect("hash");
        assert!(h.starts_with("$argon2id$"));
        assert!(stk::StkHasher::verify("stk-abcdef123456", &h));
        assert!(!stk::StkHasher::verify("stk-abcdef123457", &h));
        assert!(!stk::StkHasher::verify("stk-abcdef123456", "not a hash"));
    }

    #[test]
    fn pkce_rules() {
        // Pair computed independently with Python: base64url(sha256(verifier)) without padding.
        let verifier = "dBjftJeZ4CVP-mJ92K9mlQhJq8XmJHkmWkrxPrJCnjE";
        let challenge = "xwYgnQQNZ3dlCRWEttF1F16Ja9ycfauonnmumJgYv8M";
        assert_eq!(pkce::s256_challenge(verifier), challenge);
        assert!(pkce::verify(Some("S256"), verifier, challenge));
        assert!(pkce::verify(None, verifier, challenge));
        assert!(!pkce::verify(
            Some("S256"),
            "wrong-verifier-wrong-verifier-wrong-verifier",
            challenge
        ));
        assert!(pkce::verify(Some("plain"), "abc", "abc"));
        assert!(!pkce::verify(Some("md5"), "abc", "abc"));
        assert!(pkce::validate_verifier(verifier).is_ok());
        assert!(pkce::validate_verifier("short").is_err());
        assert!(pkce::validate_method(Some("S512")).is_err());
    }

    #[test]
    fn otp_and_user_codes() {
        for _ in 0..200 {
            let c = generate_otp();
            assert_eq!(c.len(), 6);
            assert!(c.chars().all(|ch| ch.is_ascii_digit()));
            let u = generate_user_code();
            assert_eq!(u.len(), 9);
            assert_eq!(&u[4..5], "-");
            assert_eq!(
                normalize_user_code(&u.to_lowercase().replace('-', " ")).as_deref(),
                Some(u.as_str())
            );
        }
        assert_eq!(
            normalize_user_code("WDJB-MJHT").as_deref(),
            Some("WDJB-MJHT")
        );
        assert_eq!(
            normalize_user_code("WDJB-MJH0"),
            None,
            "0 is ambiguous and excluded"
        );
        assert_eq!(normalize_user_code("ABC"), None);
    }

    #[test]
    fn webhook_signatures() {
        let sig = webhook_signature("whsec_test", 1_700_000_000, br#"{"a":1}"#);
        assert!(sig.starts_with("v1=") && sig.len() == 3 + 64);
        assert!(verify_webhook_signature(
            "whsec_test",
            1_700_000_000,
            br#"{"a":1}"#,
            &sig
        ));
        assert!(verify_webhook_signature(
            "whsec_test",
            1_700_000_000,
            br#"{"a":1}"#,
            &format!("v0=xx, {sig}")
        ));
        assert!(!verify_webhook_signature(
            "whsec_other",
            1_700_000_000,
            br#"{"a":1}"#,
            &sig
        ));
        assert!(!verify_webhook_signature(
            "whsec_test",
            1_700_000_001,
            br#"{"a":1}"#,
            &sig
        ));
    }

    #[test]
    fn constant_time_and_b64() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"ab"));
        let bytes = random_bytes::<32>();
        assert_eq!(
            b64url_decode(&b64url(&bytes)).expect("decode"),
            bytes.to_vec()
        );
    }
}
