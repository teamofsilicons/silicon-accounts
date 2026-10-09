//! Silicon key credentials: Ed25519 public keys registered for a Silicon, and the signed JWT
//! assertions (RFC 7523 style) a Silicon signs in with instead of its STK.
//!
//! **Keys.** A public key is accepted as 32 raw bytes in base64url or base64, as a PEM
//! `PUBLIC KEY` (SPKI), or as an OpenSSH line (`ssh-ed25519 AAAA… comment`). It is stored as the
//! 32 raw bytes with a fingerprint like `ssh-keygen -l` prints (`SHA256:<base64>`).
//!
//! **Assertions.** A compact JWS signed with the private key (`alg` `EdDSA`), with:
//! - `iss` and `sub`: the Silicon (its si:id or uuid; both the same);
//! - `aud`: the token endpoint (`{public_url}/v1/oauth/token`); the sign-in endpoint
//!   (`{public_url}/v1/silicons/login`) and the issuer (`{public_url}`) are accepted too;
//! - `exp`: at most 5 minutes after `iat` (or after now when there is no `iat`), not passed;
//! - `jti`: unique, 1 to 200 characters; each assertion works once;
//! - `kid` in the header (optional): the key's id; without it every live key is tried.

use base64::Engine as _;
use ed25519_dalek::{Signature, VerifyingKey};
use serde::Deserialize;
use serde_json::Value;

use crate::error::ApiError;

/// Longest lifetime of an assertion (`exp - iat`), in seconds.
pub const MAX_ASSERTION_SECONDS: i64 = 300;
/// Clock skew allowed on `iat` / `nbf` / `exp`, in seconds.
pub const LEEWAY_SECONDS: i64 = 30;
/// Live keys one Silicon may have.
pub const MAX_KEYS_PER_SILICON: i64 = 10;
/// Longest key name.
pub const MAX_NAME_CHARS: usize = 100;

/// A parsed public key: 32 raw bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublicKey(pub [u8; 32]);

impl PublicKey {
    /// `SHA256:<base64 without padding>`, as `ssh-keygen -l` prints for the key.
    pub fn fingerprint(&self) -> String {
        // ssh-keygen hashes the SSH wire blob of the key.
        let mut blob = Vec::with_capacity(51);
        blob.extend_from_slice(&11u32.to_be_bytes());
        blob.extend_from_slice(b"ssh-ed25519");
        blob.extend_from_slice(&32u32.to_be_bytes());
        blob.extend_from_slice(&self.0);
        let digest = crate::crypto::sha256(&blob);
        format!(
            "SHA256:{}",
            base64::engine::general_purpose::STANDARD_NO_PAD.encode(digest)
        )
    }

    /// The key as base64url (no padding).
    pub fn to_base64url(&self) -> String {
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(self.0)
    }
}

fn bad_key(why: &str) -> String {
    format!(
        "{why}. Send an Ed25519 public key: an OpenSSH line (ssh-ed25519 AAAA…), a PEM PUBLIC KEY, or the 32 raw bytes in base64url"
    )
}

/// Parses a public key in any accepted form.
pub fn parse_public_key(input: &str) -> Result<PublicKey, String> {
    let text = input.trim();
    if text.is_empty() {
        return Err(bad_key("the public key is empty"));
    }
    if text.len() > 4096 {
        return Err(bad_key("the public key is longer than 4096 characters"));
    }
    if text.starts_with("-----BEGIN") {
        use ed25519_dalek::pkcs8::DecodePublicKey;
        return VerifyingKey::from_public_key_pem(text)
            .map(|k| PublicKey(k.to_bytes()))
            .map_err(|_| bad_key("the PEM isn't an Ed25519 PUBLIC KEY"));
    }
    if let Some(rest) = text.strip_prefix("ssh-ed25519 ") {
        let b64 = rest.split_whitespace().next().unwrap_or("");
        let blob = base64::engine::general_purpose::STANDARD
            .decode(b64)
            .map_err(|_| bad_key("the ssh-ed25519 key isn't valid base64"))?;
        return parse_ssh_blob(&blob).ok_or_else(|| bad_key("the ssh-ed25519 key is damaged"));
    }
    if text.starts_with("ssh-") || text.starts_with("ecdsa-") {
        return Err(bad_key("only Ed25519 keys are accepted"));
    }
    let raw = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(text.trim_end_matches('='))
        .or_else(|_| base64::engine::general_purpose::STANDARD.decode(text))
        .map_err(|_| bad_key("the public key isn't base64url, PEM or OpenSSH"))?;
    let bytes: [u8; 32] = raw.try_into().map_err(|v: Vec<u8>| {
        bad_key(&format!(
            "the public key is {} bytes; an Ed25519 key is 32",
            v.len()
        ))
    })?;
    VerifyingKey::from_bytes(&bytes)
        .map_err(|_| bad_key("these 32 bytes aren't an Ed25519 point"))?;
    Ok(PublicKey(bytes))
}

/// `string "ssh-ed25519"` + `string key(32)` (RFC 4253 encoding).
fn parse_ssh_blob(blob: &[u8]) -> Option<PublicKey> {
    let read = |at: usize| -> Option<(&[u8], usize)> {
        let len = u32::from_be_bytes(blob.get(at..at + 4)?.try_into().ok()?) as usize;
        let start = at + 4;
        Some((blob.get(start..start + len)?, start + len))
    };
    let (kind, next) = read(0)?;
    if kind != b"ssh-ed25519" {
        return None;
    }
    let (key, end) = read(next)?;
    if end != blob.len() {
        return None;
    }
    let bytes: [u8; 32] = key.try_into().ok()?;
    VerifyingKey::from_bytes(&bytes).ok()?;
    Some(PublicKey(bytes))
}

/// The parts of an assertion read before its signature is checked.
#[derive(Debug, Clone)]
pub struct Assertion {
    /// `iss` (= `sub`): the Silicon's si:id or uuid.
    pub subject: String,
    /// The header's `kid`, if any.
    pub kid: Option<String>,
    pub jti: String,
    /// `exp`, unix seconds.
    pub exp: i64,
    /// `header.payload`, the signed message.
    signed: String,
    signature: Vec<u8>,
}

#[derive(Deserialize)]
struct Header {
    alg: Option<String>,
    kid: Option<String>,
    typ: Option<String>,
}

fn invalid(message: impl Into<String>) -> ApiError {
    ApiError::unauthenticated("invalid_assertion", message).hint(
        "Sign a fresh JWT with the Silicon's registered Ed25519 key: header {\"alg\":\"EdDSA\",\"kid\":\"<key id>\"}, claims iss and sub = the si:id, aud = <public URL>/v1/oauth/token, exp at most 5 minutes ahead, a new jti every time.",
    )
}

fn number(claims: &Value, name: &str) -> Result<Option<i64>, ApiError> {
    match claims.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => v
            .as_i64()
            .or_else(|| v.as_f64().map(|f| f as i64))
            .map(Some)
            .ok_or_else(|| invalid(format!("The claim '{name}' must be a number of seconds."))),
    }
}

/// Reads an assertion and checks everything but the signature and the jti: format, `alg`,
/// `iss` = `sub`, `aud` (one of `audiences`), `exp` (not passed, at most 5 minutes ahead),
/// `nbf`/`iat` (not in the future), `jti`.
pub fn read_assertion(token: &str, audiences: &[String], now: i64) -> Result<Assertion, ApiError> {
    let token = token.trim();
    let mut parts = token.split('.');
    let (Some(h), Some(p), Some(s), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(invalid(
            "The assertion isn't a compact JWT (three base64url parts separated by dots).",
        ));
    };
    let decode = |part: &str, what: &str| {
        base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(part)
            .map_err(|_| invalid(format!("The assertion's {what} isn't base64url.")))
    };
    let header: Header = serde_json::from_slice(&decode(h, "header")?)
        .map_err(|_| invalid("The assertion's header isn't a JSON object."))?;
    if header.alg.as_deref() != Some("EdDSA") {
        return Err(invalid(format!(
            "The assertion is signed with alg '{}'; only EdDSA (Ed25519) is accepted.",
            header.alg.as_deref().unwrap_or("none")
        )));
    }
    if let Some(typ) = &header.typ
        && !typ.eq_ignore_ascii_case("JWT")
    {
        return Err(invalid(format!(
            "The assertion's typ is '{typ}'; leave it out or use JWT."
        )));
    }
    let claims: Value = serde_json::from_slice(&decode(p, "payload")?)
        .map_err(|_| invalid("The assertion's payload isn't a JSON object."))?;
    let signature = decode(s, "signature")?;
    let iss = claims
        .get("iss")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let sub = claims
        .get("sub")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if iss.is_empty() || sub.is_empty() || iss != sub {
        return Err(invalid(
            "The assertion's iss and sub must both name the Silicon (its si:id or uuid), the same value in both.",
        ));
    }
    let aud_ok = match claims.get("aud") {
        Some(Value::String(a)) => audiences.iter().any(|x| x == a.trim_end_matches('/')),
        Some(Value::Array(list)) => list.iter().any(|a| {
            a.as_str()
                .is_some_and(|a| audiences.iter().any(|x| x == a.trim_end_matches('/')))
        }),
        _ => false,
    };
    if !aud_ok {
        return Err(invalid(format!(
            "The assertion's aud must be {} (the token endpoint).",
            audiences
                .first()
                .map(String::as_str)
                .unwrap_or("the token endpoint")
        )));
    }
    let exp = number(&claims, "exp")?
        .ok_or_else(|| invalid("The assertion has no exp; it must expire within 5 minutes."))?;
    if exp + LEEWAY_SECONDS <= now {
        return Err(invalid("The assertion expired; sign a fresh one."));
    }
    let iat = number(&claims, "iat")?;
    if let Some(iat) = iat
        && iat > now + LEEWAY_SECONDS
    {
        return Err(invalid(
            "The assertion's iat is in the future; check the clock.",
        ));
    }
    if let Some(nbf) = number(&claims, "nbf")?
        && nbf > now + LEEWAY_SECONDS
    {
        return Err(invalid(
            "The assertion isn't valid yet (nbf is in the future).",
        ));
    }
    let from = iat.unwrap_or(now).max(now - LEEWAY_SECONDS);
    if exp - from > MAX_ASSERTION_SECONDS + LEEWAY_SECONDS {
        return Err(invalid(format!(
            "The assertion lives too long: exp may be at most {MAX_ASSERTION_SECONDS} seconds after iat."
        )));
    }
    let jti = claims
        .get("jti")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if jti.is_empty() || jti.len() > 200 {
        return Err(invalid(
            "The assertion needs a jti of 1 to 200 characters, new for every assertion.",
        ));
    }
    Ok(Assertion {
        subject: sub.to_string(),
        kid: header
            .kid
            .map(|k| k.trim().to_string())
            .filter(|k| !k.is_empty()),
        jti: jti.to_string(),
        exp,
        signed: format!("{h}.{p}"),
        signature,
    })
}

impl Assertion {
    /// True when `key` signed this assertion.
    pub fn signed_by(&self, key: &[u8]) -> bool {
        let Ok(bytes) = <[u8; 32]>::try_from(key) else {
            return false;
        };
        let Ok(vk) = VerifyingKey::from_bytes(&bytes) else {
            return false;
        };
        let Ok(sig) = Signature::from_slice(&self.signature) else {
            return false;
        };
        vk.verify_strict(self.signed.as_bytes(), &sig).is_ok()
    }
}

/// One registered key.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct SiliconKey {
    pub id: uuid::Uuid,
    pub silicon_uuid: String,
    pub name: String,
    pub public_key: Vec<u8>,
    pub fingerprint: String,
    pub created_by: String,
    pub created_at: time::OffsetDateTime,
    pub last_used_at: Option<time::OffsetDateTime>,
    pub revoked_at: Option<time::OffsetDateTime>,
}

impl SiliconKey {
    /// The key as the API shows it (never anything secret: it is a public key).
    pub fn view(&self) -> Value {
        use crate::timefmt::format_rfc3339_ms;
        serde_json::json!({
            "id": self.id,
            "name": self.name,
            "algorithm": "EdDSA",
            "public_key": base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&self.public_key),
            "fingerprint": self.fingerprint,
            "created_by": self.created_by,
            "created_at": format_rfc3339_ms(self.created_at),
            "last_used_at": self.last_used_at.map(format_rfc3339_ms),
            "revoked_at": self.revoked_at.map(format_rfc3339_ms),
        })
    }
}

/// The audiences an assertion may name: the token endpoint, the sign-in endpoint, the issuer.
pub fn audiences(settings: &crate::Settings) -> Vec<String> {
    let issuer = settings.issuer().trim_end_matches('/').to_string();
    vec![
        settings.url("/v1/oauth/token"),
        settings.url("/v1/silicons/login"),
        issuer,
    ]
}

/// Signs a Silicon in with an assertion (see the module docs) and returns first-party tokens
/// (origin `silicon_login`, `aud = silicon-accounts`), like `POST /v1/silicons/login` with an
/// STK. The sign-in is recorded (method `silicon_key`), the key's `last_used_at` set, and the
/// token family linked to the key, so revoking the key ends it.
///
/// Errors: 401 `invalid_assertion` (malformed, expired, wrong audience, no live key of that
/// Silicon signed it, or the jti was used before), 403 `account_not_active`.
pub async fn sign_in(
    state: &crate::AppState,
    meta: &crate::http::ClientMeta,
    assertion: &str,
    label: Option<&str>,
) -> crate::ApiResult<crate::views::TokenResponse> {
    use crate::models::{AccountKind, AccountStatus, Scope, TokenOrigin};
    use crate::repo::audit::{self, SigninRecord};
    use crate::repo::{accounts, tokens};

    let now = time::OffsetDateTime::now_utc().unix_timestamp();
    let a = read_assertion(assertion, &audiences(&state.settings), now)?;
    let mut tx = state.db.begin().await?;
    let found = if a.subject.contains(':') {
        accounts::by_handle(&mut tx, &a.subject).await?
    } else {
        accounts::get(&mut tx, &a.subject).await?
    };
    let refuse = || invalid("No live key of this Silicon signed the assertion.");
    let Some(account) = found.filter(|a| a.kind == AccountKind::Silicon) else {
        return Err(refuse());
    };
    let keys: Vec<SiliconKey> = sqlx::query_as(
        "select id, silicon_uuid, name, public_key, fingerprint, created_by, created_at, last_used_at, revoked_at \
         from silicon_keys where silicon_uuid = $1 and revoked_at is null order by created_at",
    )
    .bind(&account.uuid)
    .fetch_all(&mut *tx)
    .await?;
    let key = keys
        .iter()
        .filter(|k| a.kid.as_deref().is_none_or(|kid| kid == k.id.to_string()))
        .find(|k| a.signed_by(&k.public_key))
        .ok_or_else(refuse)?;
    // Each assertion works once (kept until it expires; the cleanup deletes it afterwards).
    let fresh = sqlx::query(
        "insert into silicon_key_assertions (silicon_uuid, jti, key_id, expires_at) \
         values ($1, $2, $3, to_timestamp($4)) on conflict do nothing",
    )
    .bind(&account.uuid)
    .bind(&a.jti)
    .bind(key.id)
    .bind((a.exp + LEEWAY_SECONDS) as f64)
    .execute(&mut *tx)
    .await?
    .rows_affected()
        == 1;
    if !fresh {
        return Err(invalid(
            "This assertion was used before (its jti); each assertion signs in once.",
        ));
    }
    let Some(account) = accounts::lock(&mut tx, &account.uuid).await? else {
        return Err(refuse());
    };
    if account.status != AccountStatus::Active {
        tx.commit().await?;
        return Err(ApiError::forbidden(
            "account_not_active",
            format!(
                "{} is {}, so it can't sign in.",
                account.display_id(),
                account.status
            ),
        ));
    }
    let label = label
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(|l| l.chars().take(100).collect::<String>())
        .unwrap_or_else(|| format!("Silicon key {}", key.name));
    let response = tokens::issue_tokens(
        &mut tx,
        &state.keys,
        &state.settings,
        tokens::IssueRequest {
            account: &account,
            app_id: crate::FIRST_PARTY_APP_ID,
            origin: TokenOrigin::SiliconLogin,
            scopes: &[Scope::Profile],
            browser_session_id: None,
            label: Some(&label),
            ip: meta.ip.as_deref(),
            user_agent: meta.user_agent.as_deref(),
            nonce: None,
            auth_time: None,
        },
    )
    .await?;
    // The family this transaction just created (its rows carry this transaction's id).
    sqlx::query(
        "insert into silicon_key_sessions (family_id, key_id) \
         select id, $2 from token_families where account_uuid = $1 and xmin::text = (pg_current_xact_id()::xid)::text",
    )
    .bind(&account.uuid)
    .bind(key.id)
    .execute(&mut *tx)
    .await?;
    sqlx::query("update silicon_keys set last_used_at = now() where id = $1")
        .bind(key.id)
        .execute(&mut *tx)
        .await?;
    audit::signin(
        &mut tx,
        &SigninRecord {
            account_uuid: Some(&account.uuid),
            app_id: Some(crate::FIRST_PARTY_APP_ID),
            method: audit::method::SILICON_KEY,
            outcome: audit::outcome::SUCCESS,
            ip: meta.ip.as_deref(),
            user_agent: meta.user_agent.as_deref(),
        },
    )
    .await?;
    tx.commit().await?;
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use serde_json::json;

    fn key() -> SigningKey {
        SigningKey::from_bytes(&[7u8; 32])
    }

    fn jwt(header: Value, claims: Value, key: &SigningKey) -> String {
        let e = |v: &Value| {
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(v.to_string().as_bytes())
        };
        let signed = format!("{}.{}", e(&header), e(&claims));
        let sig = key.sign(signed.as_bytes());
        format!(
            "{signed}.{}",
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(sig.to_bytes())
        )
    }

    const AUD: &str = "https://accounts.example/v1/oauth/token";

    #[test]
    fn keys_parse_in_every_form() {
        let k = key();
        let raw = k.verifying_key().to_bytes();
        let b64url = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(raw);
        assert_eq!(parse_public_key(&b64url).expect("b64url").0, raw);
        let b64 = base64::engine::general_purpose::STANDARD.encode(raw);
        assert_eq!(parse_public_key(&b64).expect("b64").0, raw);
        use ed25519_dalek::pkcs8::EncodePublicKey;
        let pem = k
            .verifying_key()
            .to_public_key_pem(ed25519_dalek::pkcs8::spki::der::pem::LineEnding::LF)
            .expect("pem");
        assert_eq!(parse_public_key(&pem).expect("pem").0, raw);
        let mut blob = Vec::new();
        blob.extend_from_slice(&11u32.to_be_bytes());
        blob.extend_from_slice(b"ssh-ed25519");
        blob.extend_from_slice(&32u32.to_be_bytes());
        blob.extend_from_slice(&raw);
        let line = format!(
            "ssh-ed25519 {} scout@laptop",
            base64::engine::general_purpose::STANDARD.encode(&blob)
        );
        let parsed = parse_public_key(&line).expect("ssh");
        assert_eq!(parsed.0, raw);
        assert!(parsed.fingerprint().starts_with("SHA256:"));
        assert!(parse_public_key("ssh-rsa AAAAB3Nza").is_err());
        assert!(parse_public_key("aGVsbG8").is_err());
        assert!(parse_public_key("").is_err());
    }

    #[test]
    fn assertions_are_checked() {
        let k = key();
        let now = 1_800_000_000;
        let good = jwt(
            json!({"alg": "EdDSA", "kid": "k1", "typ": "JWT"}),
            json!({"iss": "si:scout", "sub": "si:scout", "aud": AUD, "iat": now, "exp": now + 120, "jti": "a1"}),
            &k,
        );
        let aud = vec![AUD.to_string()];
        let a = read_assertion(&good, &aud, now).expect("valid");
        assert_eq!(a.subject, "si:scout");
        assert_eq!(a.kid.as_deref(), Some("k1"));
        assert!(a.signed_by(&k.verifying_key().to_bytes()));
        assert!(
            !a.signed_by(
                &SigningKey::from_bytes(&[8u8; 32])
                    .verifying_key()
                    .to_bytes()
            )
        );
        let bad = |claims: Value| {
            read_assertion(&jwt(json!({"alg": "EdDSA"}), claims, &k), &aud, now)
                .expect_err("refused")
                .message
        };
        assert!(
            bad(json!({"iss": "si:a", "sub": "si:b", "aud": AUD, "exp": now + 60, "jti": "x"}))
                .contains("iss and sub")
        );
        assert!(bad(json!({"iss": "si:a", "sub": "si:a", "aud": "https://elsewhere", "exp": now + 60, "jti": "x"})).contains("aud"));
        assert!(
            bad(json!({"iss": "si:a", "sub": "si:a", "aud": AUD, "exp": now - 120, "jti": "x"}))
                .contains("expired")
        );
        assert!(bad(json!({"iss": "si:a", "sub": "si:a", "aud": AUD, "iat": now, "exp": now + 3600, "jti": "x"})).contains("too long"));
        assert!(
            bad(json!({"iss": "si:a", "sub": "si:a", "aud": AUD, "exp": now + 60})).contains("jti")
        );
        assert!(bad(json!({"iss": "si:a", "sub": "si:a", "aud": [AUD], "exp": now + 60, "jti": "x", "iat": now + 600})).contains("future"));
        let hs = jwt(json!({"alg": "HS256"}), json!({}), &k);
        assert!(
            read_assertion(&hs, &aud, now)
                .expect_err("alg")
                .message
                .contains("EdDSA")
        );
        assert!(read_assertion("a.b", &aud, now).is_err());
        let e = read_assertion("x.y.z", &aud, now).expect_err("garbage");
        assert_eq!(e.code, "invalid_assertion");
    }
}
