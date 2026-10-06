//! Sign in with Apple's client secret: an ES256 JWT signed with the `.p8` key, with header
//! `kid` = key id and claims `iss` = team id, `sub` = Services ID, `aud` = Apple's issuer,
//! `iat` = now, `exp` ≤ 5 minutes later (Apple allows up to 6 months; short is safer).

use jsonwebtoken::{Algorithm, EncodingKey, Header};
use serde::Serialize;

/// How long a client secret we mint stays valid.
pub const CLIENT_SECRET_TTL_SECONDS: i64 = 300;

#[derive(Serialize)]
struct Claims<'a> {
    iss: &'a str,
    iat: i64,
    exp: i64,
    aud: &'a str,
    sub: &'a str,
}

/// What signs an Apple client secret.
pub struct ClientSecretInput<'a> {
    pub team_id: &'a str,
    pub key_id: &'a str,
    /// The Services ID (the OAuth client id).
    pub services_id: &'a str,
    /// The `.p8` key (PKCS#8 PEM, P-256). Literal `\n` escapes are accepted.
    pub private_key_pem: &'a str,
    /// `ACCOUNTS_APPLE_ISSUER` (`https://appleid.apple.com`).
    pub audience: &'a str,
    /// Unix time.
    pub now: i64,
}

/// Mints a client secret. The error says what is wrong with the key (never the key itself).
pub fn client_secret(input: &ClientSecretInput<'_>) -> Result<String, String> {
    let pem = input.private_key_pem.trim().replace("\\n", "\n");
    let key = EncodingKey::from_ec_pem(pem.as_bytes())
        .map_err(|e| format!("the Apple private key is not a P-256 PKCS#8 PEM (.p8) key ({e})"))?;
    let mut header = Header::new(Algorithm::ES256);
    header.kid = Some(input.key_id.to_string());
    jsonwebtoken::encode(
        &header,
        &Claims {
            iss: input.team_id,
            iat: input.now,
            exp: input.now + CLIENT_SECRET_TTL_SECONDS,
            aud: input.audience,
            sub: input.services_id,
        },
        &key,
    )
    .map_err(|e| format!("the Apple client secret could not be signed with the .p8 key ({e})"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use jsonwebtoken::{DecodingKey, Validation};

    const PRIVATE: &str = include_str!("../../tests/fixtures/ec_test_private.pem");
    const PUBLIC: &str = include_str!("../../tests/fixtures/ec_test_public.pem");

    #[derive(serde::Deserialize)]
    struct Back {
        iss: String,
        sub: String,
        aud: String,
        iat: i64,
        exp: i64,
    }

    #[test]
    fn signs_a_verifiable_es256_secret() {
        let now = jsonwebtoken::get_current_timestamp() as i64;
        let jwt = client_secret(&ClientSecretInput {
            team_id: "TEAM123456",
            key_id: "KEY1234567",
            services_id: "com.example.signin",
            private_key_pem: PRIVATE,
            audience: "https://appleid.apple.com",
            now,
        })
        .expect("signed");
        let header = jsonwebtoken::decode_header(&jwt).expect("header");
        assert_eq!(header.alg, Algorithm::ES256);
        assert_eq!(header.kid.as_deref(), Some("KEY1234567"));
        let mut v = Validation::new(Algorithm::ES256);
        v.set_audience(&["https://appleid.apple.com"]);
        v.set_issuer(&["TEAM123456"]);
        let data = jsonwebtoken::decode::<Back>(
            &jwt,
            &DecodingKey::from_ec_pem(PUBLIC.as_bytes()).expect("public key"),
            &v,
        )
        .expect("verifies with the public key");
        assert_eq!(data.claims.iss, "TEAM123456");
        assert_eq!(data.claims.sub, "com.example.signin");
        assert_eq!(data.claims.aud, "https://appleid.apple.com");
        assert_eq!(data.claims.exp - data.claims.iat, CLIENT_SECRET_TTL_SECONDS);
    }

    #[test]
    fn escaped_newlines_work_and_bad_keys_are_explained() {
        let escaped = PRIVATE.replace('\n', "\\n");
        assert!(
            client_secret(&ClientSecretInput {
                team_id: "T",
                key_id: "K",
                services_id: "S",
                private_key_pem: &escaped,
                audience: "A",
                now: 1,
            })
            .is_ok()
        );
        let err = client_secret(&ClientSecretInput {
            team_id: "T",
            key_id: "K",
            services_id: "S",
            private_key_pem: "-----BEGIN PRIVATE KEY-----\nnope\n-----END PRIVATE KEY-----",
            audience: "A",
            now: 1,
        })
        .expect_err("bad key");
        assert!(err.contains("P-256 PKCS#8 PEM"), "{err}");
    }
}
