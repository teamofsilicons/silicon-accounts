//! Exercise the client with tokens produced by the real Accounts signer.
use accounts_core::jwt::{AccessTokenInput, IdTokenClaims, JwtKeys};
use accounts_core::models::AccountKind;
use silicon_accounts_client::{Jwks, VerifyOptions, verify_access_token};

#[test]
fn local_verification_rejects_oidc_id_token_with_the_same_issuer_and_audience() {
    let issuer = "https://accounts.example.test";
    let (keys, _) = JwtKeys::generate("test-key", issuer).expect("test key");
    let jwks: Jwks = serde_json::from_value(keys.jwks()).expect("JWKS");
    let options = VerifyOptions::for_app("example-app").with_issuer(issuer);
    let (access, issued) = keys
        .sign_access(&AccessTokenInput {
            account_uuid: "11111111-1111-4111-8111-111111111111",
            app_id: "example-app",
            kind: AccountKind::Carbon,
            id: "c:example",
            family_id: uuid::Uuid::from_u128(1),
            scope: "profile openid",
            ttl_seconds: 600,
        })
        .expect("access token");
    let id = keys
        .sign_id_token(&IdTokenClaims {
            iss: issued.iss.clone(),
            sub: issued.sub.clone(),
            aud: issued.aud.clone(),
            exp: issued.exp,
            iat: issued.iat,
            ..Default::default()
        })
        .expect("OIDC ID token");
    assert!(verify_access_token(&jwks, &access, &options).is_ok());
    assert!(verify_access_token(&jwks, &id, &options).is_err());
    for field in ["nbf", "jti", "mid", "fid"] {
        let mut incomplete = serde_json::to_value(&issued).expect("claims");
        incomplete.as_object_mut().expect("object").remove(field);
        let token = keys.sign(&incomplete).expect("incomplete signed token");
        assert!(
            verify_access_token(&jwks, &token, &options).is_err(),
            "accepted missing {field}"
        );
    }
    for field in ["jti", "mid", "fid"] {
        let mut empty = serde_json::to_value(&issued).expect("claims");
        empty[field] = serde_json::json!("");
        let token = keys.sign(&empty).expect("signed token with empty claim");
        assert!(
            verify_access_token(&jwks, &token, &options).is_err(),
            "accepted empty {field}"
        );
    }
    // First-party and Silicon tokens use the same required access shape.
    let (silicon, _) = keys
        .sign_access(&AccessTokenInput {
            account_uuid: "22222222-2222-4222-8222-222222222222",
            app_id: "silicon-accounts",
            kind: AccountKind::Silicon,
            id: "si:example",
            family_id: uuid::Uuid::from_u128(2),
            scope: "profile",
            ttl_seconds: 600,
        })
        .expect("first-party Silicon token");
    assert!(
        verify_access_token(
            &jwks,
            &silicon,
            &VerifyOptions::for_app("silicon-accounts").with_issuer(issuer)
        )
        .is_ok()
    );
}
