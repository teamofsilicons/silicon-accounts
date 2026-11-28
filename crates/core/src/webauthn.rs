//! Passkeys: the relying-party side of WebAuthn Level 2, as Silicon Accounts uses it (Anil,
//! 2026-11-23).
//!
//! What this module does, and only this:
//!
//! - builds the options the browser passes to `navigator.credentials.create()` (adding a passkey)
//!   and `navigator.credentials.get()` (signing in with one), in their JSON forms
//!   (`PublicKeyCredentialCreationOptionsJSON` / `PublicKeyCredentialRequestOptionsJSON`);
//! - checks what the browser returns: the client data (type, challenge, origin), the
//!   authenticator data (RP ID hash, user present, the signature counter) and, when signing in,
//!   the signature over `authenticatorData || SHA-256(clientDataJSON)`.
//!
//! The relying party is Silicon Accounts itself: its RP ID is the host of `ACCOUNTS_PUBLIC_URL`
//! (accounts.teamofsilicons.com, `localhost` in development) and the accepted origins are the
//! allowed origins on that host. Every hosted sign-in page is served there, so one passkey signs
//! a Carbon in to every app.
//!
//! We ask for no attestation (`attestation: "none"`): which authenticator made the key doesn't
//! decide anything here, so the attestation statement is never checked. Keys are ES256 (P-256),
//! EdDSA (Ed25519) or RS256 (RSA PKCS#1 v1.5 with SHA-256), the algorithms every platform
//! authenticator offers. Passkeys are discoverable credentials: signing in needs no account name,
//! the authenticator offers the Carbon's own passkey and the server finds the account by the
//! credential id it returns.
//!
//! Pure Rust (RustCrypto and `ciborium`), like the rest of the service: no OpenSSL.

use base64::Engine;
use base64::engine::general_purpose::{URL_SAFE, URL_SAFE_NO_PAD};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::config::Settings;

/// COSE algorithm identifiers we accept, most preferred first.
pub const ES256: i64 = -7;
pub const EDDSA: i64 = -8;
pub const RS256: i64 = -257;
pub const ALGORITHMS: [i64; 3] = [ES256, EDDSA, RS256];

/// How long the browser may take over a ceremony, in milliseconds (five minutes).
pub const CEREMONY_TIMEOUT_MS: u64 = 300_000;

/// Who the relying party is: its RP ID, its display name and the origins it accepts.
#[derive(Debug, Clone)]
pub struct RelyingParty {
    pub id: String,
    pub name: String,
    origins: Vec<String>,
}

impl RelyingParty {
    /// From the service settings: the RP ID is the public URL's host; the accepted origins are
    /// the allowed origins on that host or its subdomains.
    pub fn from_settings(settings: &Settings) -> RelyingParty {
        let id = url::Url::parse(&settings.public_url)
            .ok()
            .and_then(|u| u.host_str().map(str::to_ascii_lowercase))
            .unwrap_or_else(|| "localhost".to_string());
        let origins = settings
            .allowed_origins()
            .filter(|origin| {
                url::Url::parse(origin)
                    .ok()
                    .and_then(|u| u.host_str().map(str::to_ascii_lowercase))
                    .is_some_and(|host| host == id || host.ends_with(&format!(".{id}")))
            })
            .map(str::to_string)
            .collect();
        RelyingParty {
            id,
            name: "Team of Silicons".to_string(),
            origins,
        }
    }

    /// A relying party with explicit values (tests).
    pub fn new(id: &str, origins: &[&str]) -> RelyingParty {
        RelyingParty {
            id: id.to_string(),
            name: "Team of Silicons".to_string(),
            origins: origins.iter().map(|o| (*o).to_string()).collect(),
        }
    }

    fn rp_id_hash(&self) -> [u8; 32] {
        Sha256::digest(self.id.as_bytes()).into()
    }
}

/// Why a ceremony's result was refused. The text is for logs; callers answer with their own
/// error codes.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum WebauthnError {
    #[error("the credential is malformed: {0}")]
    Malformed(&'static str),
    #[error("the credential was made for a different request (type)")]
    WrongType,
    #[error("the credential answers a different challenge")]
    WrongChallenge,
    #[error("the credential was made on an origin this service doesn't accept")]
    WrongOrigin,
    #[error("the credential was made for a different relying party")]
    WrongRelyingParty,
    #[error("the authenticator did not confirm the person was present")]
    UserNotPresent,
    #[error("the key uses an algorithm this service doesn't accept")]
    UnsupportedAlgorithm,
    #[error("the signature does not verify")]
    BadSignature,
    #[error("the signature counter went backwards: the authenticator may be cloned")]
    CounterRegressed,
}

/// A fresh challenge: 32 random bytes, base64url without padding.
pub fn new_challenge() -> String {
    let mut bytes = [0u8; 32];
    rand::fill(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

/// base64url, with or without padding (browsers send it without; some clients pad).
pub fn b64url_decode(value: &str) -> Result<Vec<u8>, WebauthnError> {
    URL_SAFE_NO_PAD
        .decode(value.trim_end_matches('='))
        .or_else(|_| URL_SAFE.decode(value))
        .map_err(|_| WebauthnError::Malformed("base64url"))
}

pub fn b64url_encode(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

/// The account a passkey is made for, as the authenticator shows it.
pub struct UserEntity<'a> {
    /// A stable, opaque id: the account uuid's bytes. Never shown.
    pub id: &'a [u8],
    /// The account's name in the passkey picker: its primary email, else its c:id.
    pub name: &'a str,
    pub display_name: &'a str,
}

/// `PublicKeyCredentialCreationOptionsJSON` for adding a passkey. `exclude` lists the account's
/// passkeys already registered, so the same authenticator isn't registered twice.
pub fn creation_options(
    rp: &RelyingParty,
    user: &UserEntity<'_>,
    challenge: &str,
    exclude: &[Vec<u8>],
) -> Value {
    json!({
        "challenge": challenge,
        "rp": { "id": rp.id, "name": rp.name },
        "user": {
            "id": b64url_encode(user.id),
            "name": user.name,
            "displayName": user.display_name,
        },
        "pubKeyCredParams": ALGORITHMS
            .iter()
            .map(|alg| json!({ "type": "public-key", "alg": alg }))
            .collect::<Vec<_>>(),
        "timeout": CEREMONY_TIMEOUT_MS,
        "attestation": "none",
        "authenticatorSelection": {
            "residentKey": "required",
            "requireResidentKey": true,
            "userVerification": "preferred",
        },
        "excludeCredentials": exclude
            .iter()
            .map(|id| json!({ "type": "public-key", "id": b64url_encode(id) }))
            .collect::<Vec<_>>(),
        "hints": ["client-device"],
    })
}

/// `PublicKeyCredentialRequestOptionsJSON` for signing in: no allow list, so the authenticator
/// offers whichever of the Carbon's passkeys it holds for this RP.
pub fn request_options(rp: &RelyingParty, challenge: &str) -> Value {
    json!({
        "challenge": challenge,
        "rpId": rp.id,
        "timeout": CEREMONY_TIMEOUT_MS,
        "userVerification": "preferred",
    })
}

/// What `navigator.credentials.create()` returns, as `PublicKeyCredential.toJSON()` spells it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistrationResponse {
    pub id: String,
    pub raw_id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub response: AttestationResponse,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttestationResponse {
    #[serde(rename = "clientDataJSON")]
    pub client_data_json: String,
    pub attestation_object: String,
    #[serde(default)]
    pub transports: Vec<String>,
}

/// What `navigator.credentials.get()` returns, as `PublicKeyCredential.toJSON()` spells it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthenticationResponse {
    pub id: String,
    pub raw_id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub response: AssertionResponse,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssertionResponse {
    #[serde(rename = "clientDataJSON")]
    pub client_data_json: String,
    pub authenticator_data: String,
    pub signature: String,
    #[serde(default)]
    pub user_handle: Option<String>,
}

impl AuthenticationResponse {
    /// The credential id the authenticator answered with (to find the passkey).
    pub fn credential_id(&self) -> Result<Vec<u8>, WebauthnError> {
        if self.kind != "public-key" {
            return Err(WebauthnError::Malformed("type"));
        }
        let raw = b64url_decode(&self.raw_id)?;
        if raw.is_empty() || raw.len() > 1023 {
            return Err(WebauthnError::Malformed("credential id"));
        }
        Ok(raw)
    }
}

/// A passkey checked and ready to store.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewPasskey {
    pub credential_id: Vec<u8>,
    /// The COSE key as the authenticator sent it.
    pub public_key: Vec<u8>,
    pub algorithm: i64,
    pub sign_count: u32,
    pub aaguid: Vec<u8>,
    pub backup_eligible: bool,
    pub backed_up: bool,
    pub transports: Vec<String>,
}

/// A passkey sign-in checked: the counter to store and the backup state now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VerifiedAssertion {
    pub sign_count: u32,
    pub backed_up: bool,
    pub user_verified: bool,
}

/// The stored key an assertion is checked against.
pub struct StoredKey<'a> {
    pub public_key: &'a [u8],
    pub algorithm: i64,
    pub sign_count: u32,
}

/// Checks a new passkey (WebAuthn §7.1, without attestation).
pub fn verify_registration(
    rp: &RelyingParty,
    expected_challenge: &str,
    response: &RegistrationResponse,
) -> Result<NewPasskey, WebauthnError> {
    if response.kind != "public-key" {
        return Err(WebauthnError::Malformed("type"));
    }
    let client_data = b64url_decode(&response.response.client_data_json)?;
    check_client_data(rp, &client_data, "webauthn.create", expected_challenge)?;

    let attestation = b64url_decode(&response.response.attestation_object)?;
    let auth_data = attestation_auth_data(&attestation)?;
    let parsed = AuthData::parse(&auth_data)?;
    parsed.check(rp)?;
    let attested = parsed
        .attested
        .ok_or(WebauthnError::Malformed("no attested credential"))?;

    let raw_id = b64url_decode(&response.raw_id)?;
    if raw_id != attested.credential_id {
        return Err(WebauthnError::Malformed("credential id mismatch"));
    }
    let algorithm = cose_algorithm(&attested.public_key)?;
    // The key must be usable: parse it once now, so a bad key is refused here, not at sign-in.
    PublicKey::from_cose(&attested.public_key)?;

    Ok(NewPasskey {
        credential_id: attested.credential_id,
        public_key: attested.public_key,
        algorithm,
        sign_count: parsed.sign_count,
        aaguid: attested.aaguid,
        backup_eligible: parsed.backup_eligible,
        backed_up: parsed.backed_up,
        transports: response
            .response
            .transports
            .iter()
            .filter(|t| t.len() <= 32 && t.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'))
            .take(8)
            .cloned()
            .collect(),
    })
}

/// Checks a passkey sign-in (WebAuthn §7.2) against the stored key.
pub fn verify_authentication(
    rp: &RelyingParty,
    expected_challenge: &str,
    response: &AuthenticationResponse,
    stored: &StoredKey<'_>,
) -> Result<VerifiedAssertion, WebauthnError> {
    response.credential_id()?;
    let client_data = b64url_decode(&response.response.client_data_json)?;
    check_client_data(rp, &client_data, "webauthn.get", expected_challenge)?;

    let auth_data = b64url_decode(&response.response.authenticator_data)?;
    let parsed = AuthData::parse(&auth_data)?;
    parsed.check(rp)?;

    let signature = b64url_decode(&response.response.signature)?;
    let mut signed = auth_data.clone();
    signed.extend_from_slice(&Sha256::digest(&client_data));
    let key = PublicKey::from_cose(stored.public_key)?;
    if key.algorithm() != stored.algorithm {
        return Err(WebauthnError::UnsupportedAlgorithm);
    }
    key.verify(&signed, &signature)?;

    // §7.2 step 21: a counter that doesn't move forward when either side keeps one means the
    // authenticator may have been cloned. Many passkey providers always send 0.
    if (parsed.sign_count != 0 || stored.sign_count != 0) && parsed.sign_count <= stored.sign_count
    {
        return Err(WebauthnError::CounterRegressed);
    }
    Ok(VerifiedAssertion {
        sign_count: parsed.sign_count.max(stored.sign_count),
        backed_up: parsed.backed_up,
        user_verified: parsed.user_verified,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClientData {
    #[serde(rename = "type")]
    kind: String,
    challenge: String,
    origin: String,
    #[serde(default)]
    cross_origin: Option<bool>,
}

fn check_client_data(
    rp: &RelyingParty,
    raw: &[u8],
    expected_type: &str,
    expected_challenge: &str,
) -> Result<(), WebauthnError> {
    let data: ClientData =
        serde_json::from_slice(raw).map_err(|_| WebauthnError::Malformed("client data"))?;
    if data.kind != expected_type {
        return Err(WebauthnError::WrongType);
    }
    let sent = b64url_decode(&data.challenge)?;
    let expected = b64url_decode(expected_challenge)?;
    if sent.is_empty() || !bool::from(subtle::ConstantTimeEq::ct_eq(&sent[..], &expected[..])) {
        return Err(WebauthnError::WrongChallenge);
    }
    if !rp.origins.iter().any(|origin| origin == &data.origin) {
        return Err(WebauthnError::WrongOrigin);
    }
    // Never inside another site's frame.
    if data.cross_origin == Some(true) {
        return Err(WebauthnError::WrongOrigin);
    }
    Ok(())
}

/// The `authData` byte string out of an attestation object (a CBOR map with `fmt`, `attStmt` and
/// `authData`).
fn attestation_auth_data(attestation: &[u8]) -> Result<Vec<u8>, WebauthnError> {
    let value: ciborium::Value = ciborium::from_reader(attestation)
        .map_err(|_| WebauthnError::Malformed("attestation object"))?;
    let map = value
        .as_map()
        .ok_or(WebauthnError::Malformed("attestation object"))?;
    map.iter()
        .find(|(k, _)| k.as_text() == Some("authData"))
        .and_then(|(_, v)| v.as_bytes().cloned())
        .ok_or(WebauthnError::Malformed("authData"))
}

struct Attested {
    aaguid: Vec<u8>,
    credential_id: Vec<u8>,
    public_key: Vec<u8>,
}

struct AuthData {
    rp_id_hash: [u8; 32],
    user_present: bool,
    user_verified: bool,
    backup_eligible: bool,
    backed_up: bool,
    sign_count: u32,
    attested: Option<Attested>,
}

impl AuthData {
    fn parse(bytes: &[u8]) -> Result<AuthData, WebauthnError> {
        if bytes.len() < 37 {
            return Err(WebauthnError::Malformed("authenticator data"));
        }
        let mut rp_id_hash = [0u8; 32];
        rp_id_hash.copy_from_slice(&bytes[..32]);
        let flags = bytes[32];
        let sign_count = u32::from_be_bytes([bytes[33], bytes[34], bytes[35], bytes[36]]);
        let attested = if flags & 0x40 != 0 {
            let rest = &bytes[37..];
            if rest.len() < 18 {
                return Err(WebauthnError::Malformed("attested credential data"));
            }
            let aaguid = rest[..16].to_vec();
            let id_len = u16::from_be_bytes([rest[16], rest[17]]) as usize;
            if id_len == 0 || id_len > 1023 || rest.len() < 18 + id_len {
                return Err(WebauthnError::Malformed("credential id"));
            }
            let credential_id = rest[18..18 + id_len].to_vec();
            let key_and_more = &rest[18 + id_len..];
            // The COSE key is one CBOR item; extensions (flag ED) may follow it.
            let mut cursor = std::io::Cursor::new(key_and_more);
            let _: ciborium::Value = ciborium::from_reader(&mut cursor)
                .map_err(|_| WebauthnError::Malformed("credential public key"))?;
            let key_len = cursor.position() as usize;
            Some(Attested {
                aaguid,
                credential_id,
                public_key: key_and_more[..key_len].to_vec(),
            })
        } else {
            None
        };
        Ok(AuthData {
            rp_id_hash,
            user_present: flags & 0x01 != 0,
            user_verified: flags & 0x04 != 0,
            backup_eligible: flags & 0x08 != 0,
            backed_up: flags & 0x10 != 0,
            sign_count,
            attested,
        })
    }

    fn check(&self, rp: &RelyingParty) -> Result<(), WebauthnError> {
        if !bool::from(subtle::ConstantTimeEq::ct_eq(
            &self.rp_id_hash[..],
            &rp.rp_id_hash()[..],
        )) {
            return Err(WebauthnError::WrongRelyingParty);
        }
        if !self.user_present {
            return Err(WebauthnError::UserNotPresent);
        }
        Ok(())
    }
}

/// The COSE key's `alg` (label 3).
fn cose_algorithm(cose: &[u8]) -> Result<i64, WebauthnError> {
    let map = cose_map(cose)?;
    let alg = cose_int(&map, 3).ok_or(WebauthnError::Malformed("COSE alg"))?;
    if ALGORITHMS.contains(&alg) {
        Ok(alg)
    } else {
        Err(WebauthnError::UnsupportedAlgorithm)
    }
}

fn cose_map(cose: &[u8]) -> Result<Vec<(ciborium::Value, ciborium::Value)>, WebauthnError> {
    let value: ciborium::Value =
        ciborium::from_reader(cose).map_err(|_| WebauthnError::Malformed("COSE key"))?;
    match value {
        ciborium::Value::Map(map) => Ok(map),
        _ => Err(WebauthnError::Malformed("COSE key")),
    }
}

fn cose_entry(map: &[(ciborium::Value, ciborium::Value)], label: i64) -> Option<&ciborium::Value> {
    map.iter()
        .find(|(k, _)| k.as_integer().and_then(|i| i64::try_from(i).ok()) == Some(label))
        .map(|(_, v)| v)
}

fn cose_int(map: &[(ciborium::Value, ciborium::Value)], label: i64) -> Option<i64> {
    cose_entry(map, label)
        .and_then(ciborium::Value::as_integer)
        .and_then(|i| i64::try_from(i).ok())
}

fn cose_bytes(map: &[(ciborium::Value, ciborium::Value)], label: i64) -> Option<&Vec<u8>> {
    cose_entry(map, label).and_then(ciborium::Value::as_bytes)
}

enum PublicKey {
    Es256(p256::ecdsa::VerifyingKey),
    EdDsa(ed25519_dalek::VerifyingKey),
    Rs256(rsa::RsaPublicKey),
}

impl PublicKey {
    fn from_cose(cose: &[u8]) -> Result<PublicKey, WebauthnError> {
        let map = cose_map(cose)?;
        let kty = cose_int(&map, 1).ok_or(WebauthnError::Malformed("COSE kty"))?;
        let alg = cose_int(&map, 3).ok_or(WebauthnError::Malformed("COSE alg"))?;
        match (kty, alg) {
            // EC2, P-256
            (2, ES256) => {
                if cose_int(&map, -1) != Some(1) {
                    return Err(WebauthnError::UnsupportedAlgorithm);
                }
                let x = cose_bytes(&map, -2).ok_or(WebauthnError::Malformed("COSE x"))?;
                let y = cose_bytes(&map, -3).ok_or(WebauthnError::Malformed("COSE y"))?;
                if x.len() != 32 || y.len() != 32 {
                    return Err(WebauthnError::Malformed("COSE point"));
                }
                let mut sec1 = Vec::with_capacity(65);
                sec1.push(0x04);
                sec1.extend_from_slice(x);
                sec1.extend_from_slice(y);
                p256::ecdsa::VerifyingKey::from_sec1_bytes(&sec1)
                    .map(PublicKey::Es256)
                    .map_err(|_| WebauthnError::Malformed("COSE point"))
            }
            // OKP, Ed25519
            (1, EDDSA) => {
                if cose_int(&map, -1) != Some(6) {
                    return Err(WebauthnError::UnsupportedAlgorithm);
                }
                let x = cose_bytes(&map, -2).ok_or(WebauthnError::Malformed("COSE x"))?;
                let bytes: [u8; 32] = x
                    .as_slice()
                    .try_into()
                    .map_err(|_| WebauthnError::Malformed("COSE x"))?;
                ed25519_dalek::VerifyingKey::from_bytes(&bytes)
                    .map(PublicKey::EdDsa)
                    .map_err(|_| WebauthnError::Malformed("COSE x"))
            }
            // RSA
            (3, RS256) => {
                let n = cose_bytes(&map, -1).ok_or(WebauthnError::Malformed("COSE n"))?;
                let e = cose_bytes(&map, -2).ok_or(WebauthnError::Malformed("COSE e"))?;
                if n.len() < 256 {
                    return Err(WebauthnError::UnsupportedAlgorithm);
                }
                rsa::RsaPublicKey::new(
                    rsa::BigUint::from_bytes_be(n),
                    rsa::BigUint::from_bytes_be(e),
                )
                .map(PublicKey::Rs256)
                .map_err(|_| WebauthnError::Malformed("COSE RSA key"))
            }
            _ => Err(WebauthnError::UnsupportedAlgorithm),
        }
    }

    fn algorithm(&self) -> i64 {
        match self {
            PublicKey::Es256(_) => ES256,
            PublicKey::EdDsa(_) => EDDSA,
            PublicKey::Rs256(_) => RS256,
        }
    }

    fn verify(&self, message: &[u8], signature: &[u8]) -> Result<(), WebauthnError> {
        match self {
            PublicKey::Es256(key) => {
                use p256::ecdsa::signature::Verifier;
                let sig = p256::ecdsa::Signature::from_der(signature)
                    .map_err(|_| WebauthnError::BadSignature)?;
                key.verify(message, &sig)
                    .map_err(|_| WebauthnError::BadSignature)
            }
            PublicKey::EdDsa(key) => {
                let sig = ed25519_dalek::Signature::from_slice(signature)
                    .map_err(|_| WebauthnError::BadSignature)?;
                key.verify_strict(message, &sig)
                    .map_err(|_| WebauthnError::BadSignature)
            }
            PublicKey::Rs256(key) => {
                let digest = Sha256::digest(message);
                key.verify(rsa::Pkcs1v15Sign::new::<Sha256>(), &digest, signature)
                    .map_err(|_| WebauthnError::BadSignature)
            }
        }
    }
}

/// A software authenticator for tests: makes ES256 passkeys and signs assertions exactly as a
/// browser and platform authenticator would hand them to the server.
#[cfg(any(test, feature = "test-support"))]
pub mod testing {
    use super::*;
    use p256::ecdsa::{SigningKey, signature::Signer};

    pub struct SoftPasskey {
        pub credential_id: Vec<u8>,
        key: SigningKey,
        pub counter: u32,
        pub rp_id: String,
        pub origin: String,
    }

    impl SoftPasskey {
        pub fn new(rp_id: &str, origin: &str) -> SoftPasskey {
            let mut id = [0u8; 16];
            rand::fill(&mut id);
            let mut seed = [0u8; 32];
            rand::fill(&mut seed);
            SoftPasskey {
                credential_id: id.to_vec(),
                key: SigningKey::from_bytes((&seed).into()).expect("key"),
                counter: 0,
                rp_id: rp_id.to_string(),
                origin: origin.to_string(),
            }
        }

        fn cose_key(&self) -> Vec<u8> {
            let point = self.key.verifying_key().to_encoded_point(false);
            let map = ciborium::Value::Map(vec![
                (1.into(), 2.into()),
                (3.into(), ES256.into()),
                ((-1).into(), 1.into()),
                (
                    (-2).into(),
                    ciborium::Value::Bytes(point.x().expect("x").to_vec()),
                ),
                (
                    (-3).into(),
                    ciborium::Value::Bytes(point.y().expect("y").to_vec()),
                ),
            ]);
            let mut out = Vec::new();
            ciborium::into_writer(&map, &mut out).expect("cbor");
            out
        }

        fn client_data(&self, kind: &str, challenge: &str) -> Vec<u8> {
            serde_json::to_vec(&json!({
                "type": kind,
                "challenge": challenge,
                "origin": self.origin,
                "crossOrigin": false,
            }))
            .expect("json")
        }

        fn auth_data(&self, flags: u8, attested: bool) -> Vec<u8> {
            let mut out = Sha256::digest(self.rp_id.as_bytes()).to_vec();
            out.push(flags);
            out.extend_from_slice(&self.counter.to_be_bytes());
            if attested {
                out.extend_from_slice(&[0u8; 16]);
                out.extend_from_slice(&(self.credential_id.len() as u16).to_be_bytes());
                out.extend_from_slice(&self.credential_id);
                out.extend_from_slice(&self.cose_key());
            }
            out
        }

        /// `PublicKeyCredential.toJSON()` of `navigator.credentials.create()` for these options.
        pub fn register(&self, options: &Value) -> Value {
            let challenge = options["challenge"].as_str().expect("challenge");
            let client_data = self.client_data("webauthn.create", challenge);
            let auth_data = self.auth_data(0x01 | 0x04 | 0x40, true);
            let attestation = ciborium::Value::Map(vec![
                ("fmt".into(), "none".into()),
                ("attStmt".into(), ciborium::Value::Map(vec![])),
                ("authData".into(), ciborium::Value::Bytes(auth_data)),
            ]);
            let mut att = Vec::new();
            ciborium::into_writer(&attestation, &mut att).expect("cbor");
            let id = b64url_encode(&self.credential_id);
            json!({
                "id": id,
                "rawId": id,
                "type": "public-key",
                "response": {
                    "clientDataJSON": b64url_encode(&client_data),
                    "attestationObject": b64url_encode(&att),
                    "transports": ["internal", "hybrid"],
                },
                "clientExtensionResults": {},
                "authenticatorAttachment": "platform",
            })
        }

        /// `PublicKeyCredential.toJSON()` of `navigator.credentials.get()`, counting up first.
        pub fn sign_in(&mut self, options: &Value) -> Value {
            self.counter += 1;
            let challenge = options["challenge"].as_str().expect("challenge");
            let client_data = self.client_data("webauthn.get", challenge);
            let auth_data = self.auth_data(0x01 | 0x04, false);
            let mut signed = auth_data.clone();
            signed.extend_from_slice(&Sha256::digest(&client_data));
            let signature: p256::ecdsa::Signature = self.key.sign(&signed);
            let id = b64url_encode(&self.credential_id);
            json!({
                "id": id,
                "rawId": id,
                "type": "public-key",
                "response": {
                    "clientDataJSON": b64url_encode(&client_data),
                    "authenticatorData": b64url_encode(&auth_data),
                    "signature": b64url_encode(signature.to_der().as_bytes()),
                    "userHandle": null,
                },
                "clientExtensionResults": {},
                "authenticatorAttachment": "platform",
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::testing::SoftPasskey;
    use super::*;

    fn rp() -> RelyingParty {
        RelyingParty::new("accounts.example", &["https://accounts.example"])
    }

    fn registered(soft: &SoftPasskey) -> NewPasskey {
        let challenge = new_challenge();
        let response: RegistrationResponse =
            serde_json::from_value(soft.register(&json!({ "challenge": challenge })))
                .expect("parse");
        verify_registration(&rp(), &challenge, &response).expect("registers")
    }

    fn sign_in(soft: &mut SoftPasskey, challenge: &str) -> AuthenticationResponse {
        serde_json::from_value(soft.sign_in(&json!({ "challenge": challenge }))).expect("parse")
    }

    #[test]
    fn registers_and_signs_in() {
        let mut soft = SoftPasskey::new("accounts.example", "https://accounts.example");
        let key = registered(&soft);
        assert_eq!(key.credential_id, soft.credential_id);
        assert_eq!(key.algorithm, ES256);
        assert_eq!(key.transports, vec!["internal", "hybrid"]);

        let challenge = new_challenge();
        let response = sign_in(&mut soft, &challenge);
        assert_eq!(response.credential_id().expect("id"), soft.credential_id);
        let stored = StoredKey {
            public_key: &key.public_key,
            algorithm: key.algorithm,
            sign_count: key.sign_count,
        };
        let ok = verify_authentication(&rp(), &challenge, &response, &stored).expect("verifies");
        assert_eq!(ok.sign_count, 1);
        assert!(ok.user_verified);
    }

    #[test]
    fn refuses_what_it_should() {
        let mut soft = SoftPasskey::new("accounts.example", "https://accounts.example");
        let key = registered(&soft);
        let stored = |count| StoredKey {
            public_key: &key.public_key,
            algorithm: key.algorithm,
            sign_count: count,
        };

        // Another challenge.
        let response = sign_in(&mut soft, &new_challenge());
        assert_eq!(
            verify_authentication(&rp(), &new_challenge(), &response, &stored(0)),
            Err(WebauthnError::WrongChallenge)
        );

        // A counter that didn't move forward.
        let challenge = new_challenge();
        let response = sign_in(&mut soft, &challenge);
        assert_eq!(
            verify_authentication(&rp(), &challenge, &response, &stored(50)),
            Err(WebauthnError::CounterRegressed)
        );

        // A tampered signature.
        let challenge = new_challenge();
        let mut response = sign_in(&mut soft, &challenge);
        let mut sig = b64url_decode(&response.response.signature).expect("sig");
        let last = sig.len() - 2;
        sig[last] ^= 0x01;
        response.response.signature = b64url_encode(&sig);
        assert_eq!(
            verify_authentication(&rp(), &challenge, &response, &stored(0)),
            Err(WebauthnError::BadSignature)
        );

        // Another origin.
        let mut phish = SoftPasskey::new("accounts.example", "https://evil.example");
        let challenge = new_challenge();
        let response: RegistrationResponse =
            serde_json::from_value(phish.register(&json!({ "challenge": challenge })))
                .expect("parse");
        assert_eq!(
            verify_registration(&rp(), &challenge, &response),
            Err(WebauthnError::WrongOrigin)
        );

        // Another relying party.
        phish = SoftPasskey::new("evil.example", "https://accounts.example");
        let challenge = new_challenge();
        let response: RegistrationResponse =
            serde_json::from_value(phish.register(&json!({ "challenge": challenge })))
                .expect("parse");
        assert_eq!(
            verify_registration(&rp(), &challenge, &response),
            Err(WebauthnError::WrongRelyingParty)
        );

        // A registration answer is not a sign-in answer.
        let challenge = new_challenge();
        let response: RegistrationResponse =
            serde_json::from_value(soft.register(&json!({ "challenge": challenge })))
                .expect("parse");
        let as_get = AuthenticationResponse {
            id: response.id.clone(),
            raw_id: response.raw_id.clone(),
            kind: "public-key".into(),
            response: AssertionResponse {
                client_data_json: response.response.client_data_json.clone(),
                authenticator_data: b64url_encode(&[0u8; 37]),
                signature: b64url_encode(&[0u8; 8]),
                user_handle: None,
            },
        };
        assert_eq!(
            verify_authentication(&rp(), &challenge, &as_get, &stored(0)),
            Err(WebauthnError::WrongType)
        );
    }

    /// A sign-in answer for accounts.example with these authenticator flags and client data, signed by `sign`.
    fn signed_answer(
        flags: u8,
        client_data: Value,
        sign: impl Fn(&[u8]) -> Vec<u8>,
    ) -> AuthenticationResponse {
        let client_data = serde_json::to_vec(&client_data).expect("json");
        let mut auth_data = Sha256::digest(b"accounts.example").to_vec();
        auth_data.push(flags);
        auth_data.extend_from_slice(&1u32.to_be_bytes());
        let mut signed = auth_data.clone();
        signed.extend_from_slice(&Sha256::digest(&client_data));
        let id = b64url_encode(b"key");
        AuthenticationResponse {
            id: id.clone(),
            raw_id: id,
            kind: "public-key".into(),
            response: AssertionResponse {
                client_data_json: b64url_encode(&client_data),
                authenticator_data: b64url_encode(&auth_data),
                signature: b64url_encode(&sign(&signed)),
                user_handle: None,
            },
        }
    }

    fn get_data(challenge: &str) -> Value {
        json!({ "type": "webauthn.get", "challenge": challenge, "origin": "https://accounts.example" })
    }

    fn cose(entries: Vec<(i64, ciborium::Value)>) -> Vec<u8> {
        let map = entries.into_iter().map(|(k, v)| (k.into(), v)).collect();
        let mut out = Vec::new();
        ciborium::into_writer(&ciborium::Value::Map(map), &mut out).expect("cbor");
        out
    }

    fn ed25519() -> (ed25519_dalek::SigningKey, Vec<u8>) {
        let key = ed25519_dalek::SigningKey::from_bytes(&[7u8; 32]);
        let public = key.verifying_key().to_bytes().to_vec();
        let cose_key = cose(vec![
            (1, 1.into()),
            (3, EDDSA.into()),
            (-1, 6.into()),
            (-2, ciborium::Value::Bytes(public)),
        ]);
        (key, cose_key)
    }

    #[test]
    fn signs_in_with_eddsa_and_rs256_keys() {
        use ed25519_dalek::Signer as _;
        use rsa::traits::PublicKeyParts as _;
        let (ed, ed_cose) = ed25519();
        let rsa_key = rsa::RsaPrivateKey::new(&mut rsa::rand_core::OsRng, 2048).expect("rsa");
        let rsa_cose = cose(vec![
            (1, 3.into()),
            (3, RS256.into()),
            (-1, ciborium::Value::Bytes(rsa_key.n().to_bytes_be())),
            (-2, ciborium::Value::Bytes(rsa_key.e().to_bytes_be())),
        ]);
        let sign_ed = |m: &[u8]| ed.sign(m).to_bytes().to_vec();
        let sign_rsa = |m: &[u8]| {
            rsa_key
                .sign(rsa::Pkcs1v15Sign::new::<Sha256>(), &Sha256::digest(m))
                .expect("sign")
        };
        let keys: [(&[u8], i64, &dyn Fn(&[u8]) -> Vec<u8>); 2] =
            [(&ed_cose, EDDSA, &sign_ed), (&rsa_cose, RS256, &sign_rsa)];

        for (cose_key, algorithm, sign) in keys {
            assert_eq!(cose_algorithm(cose_key), Ok(algorithm));
            let stored = StoredKey {
                public_key: cose_key,
                algorithm,
                sign_count: 0,
            };
            let challenge = new_challenge();
            let answer = signed_answer(0x01 | 0x04, get_data(&challenge), sign);
            let ok = verify_authentication(&rp(), &challenge, &answer, &stored);
            assert_eq!(ok.map(|v| v.sign_count), Ok(1), "algorithm {algorithm}");

            // Signed over something else.
            let forged = signed_answer(0x01 | 0x04, get_data(&challenge), |m| {
                sign(&[m, b"x"].concat())
            });
            assert_eq!(
                verify_authentication(&rp(), &challenge, &forged, &stored),
                Err(WebauthnError::BadSignature),
                "algorithm {algorithm}"
            );
        }
    }

    #[test]
    fn refuses_no_presence_and_another_sites_frame() {
        use ed25519_dalek::Signer as _;
        let (ed, ed_cose) = ed25519();
        let sign = |m: &[u8]| ed.sign(m).to_bytes().to_vec();
        let stored = StoredKey {
            public_key: &ed_cose,
            algorithm: EDDSA,
            sign_count: 0,
        };

        // Verified, but the authenticator didn't say the person was there (no UP flag).
        let challenge = new_challenge();
        let answer = signed_answer(0x04, get_data(&challenge), sign);
        assert_eq!(
            verify_authentication(&rp(), &challenge, &answer, &stored),
            Err(WebauthnError::UserNotPresent)
        );

        // Our own origin, but inside another site's frame.
        let challenge = new_challenge();
        let mut data = get_data(&challenge);
        data["crossOrigin"] = json!(true);
        let answer = signed_answer(0x01 | 0x04, data, sign);
        assert_eq!(
            verify_authentication(&rp(), &challenge, &answer, &stored),
            Err(WebauthnError::WrongOrigin)
        );
    }

    #[test]
    fn relying_party_from_hosts() {
        let rp = RelyingParty::new("localhost", &["http://localhost:9100"]);
        assert_eq!(rp.id, "localhost");
        let options = request_options(&rp, "abc");
        assert_eq!(options["rpId"], "localhost");
        let user = UserEntity {
            id: b"uuid",
            name: "ada@example.com",
            display_name: "Ada",
        };
        let create = creation_options(&rp, &user, "abc", &[vec![1, 2, 3]]);
        assert_eq!(create["user"]["id"], b64url_encode(b"uuid"));
        assert_eq!(create["excludeCredentials"][0]["id"], "AQID");
        assert_eq!(create["authenticatorSelection"]["residentKey"], "required");
    }
}
