//! GET /.well-known/openid-configuration and /.well-known/jwks.json.

use accounts_core::test_support::{Req, TestContext};
use serde_json::{Value, json};

use crate::common::*;

#[tokio::test]
async fn the_discovery_document_describes_every_endpoint() {
    let ctx = TestContext::new().await;
    let r = ctx
        .call(router(), Req::get("/.well-known/openid-configuration"))
        .await;
    assert_eq!(r.status, 200);
    assert_eq!(header(&r, "cache-control"), "public, max-age=300");
    let d = &r.json;
    let base = ctx.state.settings.public_url.clone();
    assert_eq!(d["issuer"], base.as_str());
    assert_eq!(d["service_documentation"], ctx.state.settings.docs_url);
    for (field, path) in [
        ("authorization_endpoint", "/authorize"),
        ("token_endpoint", "/v1/oauth/token"),
        ("userinfo_endpoint", "/v1/userinfo"),
        ("jwks_uri", "/.well-known/jwks.json"),
        ("revocation_endpoint", "/v1/oauth/revoke"),
        ("introspection_endpoint", "/v1/oauth/introspect"),
        ("device_authorization_endpoint", "/v1/device/authorize"),
    ] {
        assert_eq!(d[field], format!("{base}{path}"), "{field}");
    }
    assert_eq!(d["response_types_supported"], json!(["code"]));
    assert_eq!(
        d["grant_types_supported"],
        json!([
            "authorization_code",
            "refresh_token",
            "urn:ietf:params:oauth:grant-type:device_code",
            "urn:silicon:params:oauth:grant-type:slt",
            "urn:ietf:params:oauth:grant-type:jwt-bearer"
        ])
    );
    assert_eq!(
        d["code_challenge_methods_supported"],
        json!(["S256", "plain"])
    );
    assert_eq!(d["id_token_signing_alg_values_supported"], json!(["EdDSA"]));
    assert_eq!(d["subject_types_supported"], json!(["public"]));
    assert_eq!(
        d["token_endpoint_auth_methods_supported"],
        json!(["client_secret_basic", "client_secret_post", "none"])
    );
    let scopes: Vec<&str> = d["scopes_supported"]
        .as_array()
        .expect("scopes")
        .iter()
        .filter_map(Value::as_str)
        .collect();
    for scope in [
        "openid",
        "profile",
        "email",
        "phone",
        "dob",
        "timezone",
        "offline_access",
    ] {
        assert!(scopes.contains(&scope), "{scope} missing from {scopes:?}");
    }
    let claims = d["claims_supported"].as_array().expect("claims");
    for claim in [
        "sub",
        "email_verified",
        "phone_number",
        "zoneinfo",
        "birthdate",
        "nonce",
    ] {
        assert!(claims.contains(&json!(claim)), "{claim}");
    }
}

#[tokio::test]
async fn the_jwks_publishes_the_signing_key() {
    let ctx = TestContext::new().await;
    let r = ctx.call(router(), Req::get("/.well-known/jwks.json")).await;
    assert_eq!(r.status, 200);
    assert_eq!(header(&r, "cache-control"), "public, max-age=300");
    let keys = r.json["keys"].as_array().expect("keys");
    assert_eq!(keys.len(), 1);
    let k = &keys[0];
    assert_eq!(k["kty"], "OKP");
    assert_eq!(k["crv"], "Ed25519");
    assert_eq!(k["alg"], "EdDSA");
    assert_eq!(k["use"], "sig");
    assert_eq!(k["kid"], ctx.state.settings.jwt_key_id.as_str());
    assert_eq!(s(k, "x").len(), 43, "base64url of 32 bytes");
    assert!(k.get("d").is_none(), "never the private key");
}
