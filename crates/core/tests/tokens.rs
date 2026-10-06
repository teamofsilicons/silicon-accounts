//! Tokens: refresh rotation and reuse detection, access-token verification, authorization codes
//! with PKCE, short-lived tokens and the device flow.

use accounts_core::crypto::pkce;
use accounts_core::models::{Scope, TokenOrigin};
use accounts_core::repo::tokens::{self, GrantError, IssueRequest, NewAuthCode, RevokeFilter};
use accounts_core::test_support::TestContext;

#[tokio::test]
async fn refresh_rotates_and_reuse_revokes_the_family() {
    let ctx = TestContext::new().await;
    let c = ctx.carbon().await;
    let (app, _) = ctx.app("briefcase").await;
    let first = ctx
        .tokens_for(&c, &app.app_id, &[Scope::Profile, Scope::Email])
        .await;
    assert!(first.refresh_token.starts_with("sar_"));
    assert_eq!(first.scope, "profile email");
    assert_eq!(first.expires_in, 1800);
    assert_eq!(first.membership_id, format!("{}:{}", app.app_id, c.uuid));
    assert!(
        first.account.email.is_some(),
        "email scope shows the primary email"
    );
    let days = (first.refresh_token_expires_at - time::OffsetDateTime::now_utc()).whole_days();
    assert!(
        (899..=900).contains(&days),
        "refresh tokens live 900 days, got {days}"
    );

    let (s, k) = (&ctx.state.settings, &ctx.state.keys);
    let second = tokens::refresh(&ctx.state.db, k, s, &first.refresh_token, &app.app_id)
        .await
        .expect("rotate");
    assert_ne!(second.refresh_token, first.refresh_token);
    assert_eq!(second.scope, "profile email");

    // Another app can't use it.
    let (other, _) = ctx.app("other").await;
    match tokens::refresh(&ctx.state.db, k, s, &second.refresh_token, &other.app_id).await {
        Err(GrantError::Invalid(m)) => assert!(m.contains("different app"), "{m}"),
        other => panic!("expected invalid_grant, got {other:?}"),
    }

    // Reusing the first (already used) token revokes the whole family.
    match tokens::refresh(&ctx.state.db, k, s, &first.refresh_token, &app.app_id).await {
        Err(GrantError::Reused {
            app_id,
            account_uuid,
            ..
        }) => {
            assert_eq!(app_id, app.app_id);
            assert_eq!(account_uuid, c.uuid);
        }
        other => panic!("expected reuse detection, got {other:?}"),
    }
    match tokens::refresh(&ctx.state.db, k, s, &second.refresh_token, &app.app_id).await {
        Err(GrantError::Invalid(m)) => assert!(
            m.contains("revoked") && m.contains("refresh_token_reuse"),
            "{m}"
        ),
        other => panic!("expected revoked family, got {other:?}"),
    }
    let mut conn = ctx.conn().await;
    let err = tokens::verify_access_token(&mut conn, k, &second.access_token, Some(&app.app_id))
        .await
        .expect_err("revoked");
    assert_eq!(err.code, "token_revoked");

    // Garbage and other credential kinds get precise messages.
    match tokens::refresh(&ctx.state.db, k, s, "slt_abc", &app.app_id).await {
        Err(GrantError::Invalid(m)) => assert!(m.contains("short-lived token"), "{m}"),
        other => panic!("{other:?}"),
    }
    match tokens::refresh(&ctx.state.db, k, s, "sar_unknown", &app.app_id).await {
        Err(GrantError::Invalid(m)) => assert!(m.contains("not known"), "{m}"),
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn access_tokens_verify_audience_family_and_account() {
    let ctx = TestContext::new().await;
    let c = ctx.carbon().await;
    let (app, _) = ctx.app("dm").await;
    let t = ctx.tokens_for(&c, &app.app_id, &[Scope::Profile]).await;
    let mut conn = ctx.conn().await;
    let k = &ctx.state.keys;
    let v = tokens::verify_access_token(&mut conn, k, &t.access_token, Some(&app.app_id))
        .await
        .expect("valid");
    assert_eq!(v.account.uuid, c.uuid);
    assert_eq!(v.claims.mid, format!("{}:{}", app.app_id, c.uuid));
    assert_eq!(v.claims.id, c.handle.clone().expect("handle"));

    let err = tokens::verify_access_token(&mut conn, k, &t.access_token, Some("accounts"))
        .await
        .expect_err("audience");
    assert_eq!(err.code, "token_wrong_audience");
    assert!(err.message.contains(&app.app_id));
    let err = tokens::verify_access_token(&mut conn, k, &t.refresh_token, None)
        .await
        .expect_err("not a jwt");
    assert!(err.message.contains("refresh token"), "{}", err.message);

    let revoked = tokens::revoke_families(
        &mut conn,
        &RevokeFilter {
            account_uuid: &c.uuid,
            app_id: Some(&app.app_id),
            ..Default::default()
        },
        "app_revoked",
    )
    .await
    .expect("revoke");
    assert_eq!(revoked.len(), 1);
    let err = tokens::verify_access_token(&mut conn, k, &t.access_token, None)
        .await
        .expect_err("revoked");
    assert_eq!(err.code, "token_revoked");
}

#[tokio::test]
async fn openid_scope_adds_an_id_token_with_the_nonce() {
    let ctx = TestContext::new().await;
    let c = ctx.carbon().await;
    let (app, _) = ctx.app("quill-docs").await;
    let mut conn = ctx.conn().await;
    let t = tokens::issue_tokens(
        &mut conn,
        &ctx.state.keys,
        &ctx.state.settings,
        IssueRequest {
            account: &c,
            app_id: &app.app_id,
            origin: TokenOrigin::AuthorizationCode,
            scopes: &[Scope::Openid, Scope::Email],
            browser_session_id: None,
            label: None,
            ip: None,
            user_agent: None,
            nonce: Some("n-0S6_WzA2Mj"),
        },
    )
    .await
    .expect("issue");
    let id_token = t.id_token.expect("id_token");
    let claims: serde_json::Value = ctx
        .state
        .keys
        .jwt
        .verify(&id_token, Some(&app.app_id))
        .expect("verify");
    assert_eq!(claims["nonce"], "n-0S6_WzA2Mj");
    assert_eq!(claims["sub"], c.uuid);
    assert_eq!(claims["email_verified"], true);
    assert!(claims.get("phone_number").is_none());
}

#[tokio::test]
async fn authorization_codes_are_single_use_and_pkce_bound() {
    let ctx = TestContext::new().await;
    let c = ctx.carbon().await;
    let (app, _) = ctx.app("briefcase").await;
    let pepper = &ctx.state.keys.pepper;
    let verifier = "a".repeat(43);
    let challenge = pkce::s256_challenge(&verifier);
    let redirect = format!("http://127.0.0.1:8593/{}/callback", app.app_id);
    let mut conn = ctx.conn().await;
    let new = |flow: &'static str| NewAuthCode {
        flow_id: flow,
        app_id: &app.app_id,
        account_uuid: &c.uuid,
        redirect_uri: &redirect,
        code_challenge: Some(&challenge),
        code_challenge_method: Some("S256"),
        scopes: &[Scope::Profile],
        nonce: None,
        browser_session_id: None,
    };

    // Wrong verifier burns the code.
    let code = tokens::create_code(&mut conn, pepper, &new("f1"))
        .await
        .expect("code");
    assert!(code.starts_with("sac_"));
    match tokens::consume_code(
        &ctx.state.db,
        pepper,
        &code,
        &app.app_id,
        Some(&redirect),
        Some(&"b".repeat(43)),
    )
    .await
    {
        Err(GrantError::Invalid(m)) => assert!(m.contains("PKCE"), "{m}"),
        other => panic!("{other:?}"),
    }
    match tokens::consume_code(
        &ctx.state.db,
        pepper,
        &code,
        &app.app_id,
        Some(&redirect),
        Some(&verifier),
    )
    .await
    {
        Err(GrantError::Invalid(m)) => assert!(m.contains("already used"), "{m}"),
        other => panic!("{other:?}"),
    }

    // Missing verifier and wrong redirect are refused precisely.
    let code = tokens::create_code(&mut conn, pepper, &new("f2"))
        .await
        .expect("code");
    match tokens::consume_code(
        &ctx.state.db,
        pepper,
        &code,
        &app.app_id,
        Some(&redirect),
        None,
    )
    .await
    {
        Err(GrantError::Invalid(m)) => assert!(m.contains("code_verifier is required"), "{m}"),
        other => panic!("{other:?}"),
    }
    let code = tokens::create_code(&mut conn, pepper, &new("f3"))
        .await
        .expect("code");
    match tokens::consume_code(
        &ctx.state.db,
        pepper,
        &code,
        &app.app_id,
        Some("https://evil.test/cb"),
        Some(&verifier),
    )
    .await
    {
        Err(GrantError::Invalid(m)) => assert!(m.contains("does not match"), "{m}"),
        other => panic!("{other:?}"),
    }

    // The happy path, then reuse revokes the tokens issued from the code.
    let code = tokens::create_code(&mut conn, pepper, &new("f4"))
        .await
        .expect("code");
    let auth = tokens::consume_code(
        &ctx.state.db,
        pepper,
        &code,
        &app.app_id,
        Some(&redirect),
        Some(&verifier),
    )
    .await
    .expect("ok");
    assert_eq!(auth.account_uuid, c.uuid);
    let label = auth.family_label();
    let issued = tokens::issue_tokens(
        &mut conn,
        &ctx.state.keys,
        &ctx.state.settings,
        IssueRequest {
            account: &c,
            app_id: &app.app_id,
            origin: TokenOrigin::AuthorizationCode,
            scopes: &auth.scope_list(),
            browser_session_id: None,
            label: Some(&label),
            ip: None,
            user_agent: None,
            nonce: None,
        },
    )
    .await
    .expect("tokens");
    assert!(
        tokens::consume_code(
            &ctx.state.db,
            pepper,
            &code,
            &app.app_id,
            Some(&redirect),
            Some(&verifier)
        )
        .await
        .is_err()
    );
    let err = tokens::verify_access_token(&mut conn, &ctx.state.keys, &issued.access_token, None)
        .await
        .expect_err("revoked");
    assert_eq!(err.code, "token_revoked");

    // Expired codes.
    let code = tokens::create_code(&mut conn, pepper, &new("f5"))
        .await
        .expect("code");
    sqlx::query("update authorization_codes set expires_at = now() - interval '1 second' where flow_id = 'f5'")
        .execute(&mut *conn)
        .await
        .expect("time travel");
    match tokens::consume_code(
        &ctx.state.db,
        pepper,
        &code,
        &app.app_id,
        Some(&redirect),
        Some(&verifier),
    )
    .await
    {
        Err(GrantError::Invalid(m)) => assert!(m.contains("expired"), "{m}"),
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn short_lived_tokens_are_single_use_and_app_bound() {
    let ctx = TestContext::new().await;
    let c = ctx.carbon().await;
    let (s, _) = ctx.silicon(&c.uuid).await;
    let (app, _) = ctx.app("remind").await;
    let pepper = &ctx.state.keys.pepper;
    let mut conn = ctx.conn().await;
    let (slt, expires) =
        tokens::create_slt(&mut conn, pepper, &s.uuid, &app.app_id, &[Scope::Timezone])
            .await
            .expect("slt");
    assert!(slt.starts_with("slt_"));
    assert!((expires - time::OffsetDateTime::now_utc()).whole_seconds() <= 120);
    match tokens::consume_slt(&ctx.state.db, pepper, &slt, "briefcase").await {
        Err(GrantError::Invalid(m)) => assert!(
            m.contains(&format!("issued for the app '{}'", app.app_id)),
            "{m}"
        ),
        other => panic!("{other:?}"),
    }
    // The wrong-app attempt burned it.
    assert!(
        tokens::consume_slt(&ctx.state.db, pepper, &slt, &app.app_id)
            .await
            .is_err()
    );
    let (slt, _) = tokens::create_slt(&mut conn, pepper, &s.uuid, &app.app_id, &[Scope::Timezone])
        .await
        .expect("slt");
    let t = tokens::consume_slt(&ctx.state.db, pepper, &slt, &app.app_id)
        .await
        .expect("ok");
    assert_eq!(t.scope_list(), vec![Scope::Profile, Scope::Timezone]);
    match tokens::consume_slt(&ctx.state.db, pepper, &slt, &app.app_id).await {
        Err(GrantError::Invalid(m)) => assert!(m.contains("already used"), "{m}"),
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn device_flow_states() {
    let ctx = TestContext::new().await;
    let c = ctx.carbon().await;
    let pepper = &ctx.state.keys.pepper;
    let mut conn = ctx.conn().await;
    let start = tokens::create_device(&mut conn, pepper, Some("accounts CLI on mac"))
        .await
        .expect("start");
    assert!(start.device_code.starts_with("sad_"));
    assert_eq!(start.interval, 5);
    assert!(matches!(
        tokens::poll_device(&ctx.state.db, pepper, &start.device_code).await,
        Err(GrantError::AuthorizationPending)
    ));
    assert!(matches!(
        tokens::poll_device(&ctx.state.db, pepper, &start.device_code).await,
        Err(GrantError::SlowDown)
    ));

    let d =
        tokens::device_by_user_code(&mut conn, &start.user_code.to_lowercase().replace('-', ""))
            .await
            .expect("lookup");
    assert_eq!(d.client_label.as_deref(), Some("accounts CLI on mac"));
    tokens::decide_device(&mut conn, &start.user_code, &c.uuid, true)
        .await
        .expect("approve");
    let err = tokens::decide_device(&mut conn, &start.user_code, &c.uuid, false)
        .await
        .expect_err("decided");
    assert_eq!(err.code, "device_code_used");
    let done = tokens::poll_device(&ctx.state.db, pepper, &start.device_code)
        .await
        .expect("approved");
    assert_eq!(done.account_uuid.as_deref(), Some(c.uuid.as_str()));
    assert!(matches!(
        tokens::poll_device(&ctx.state.db, pepper, &start.device_code).await,
        Err(GrantError::Invalid(_))
    ));

    let denied = tokens::create_device(&mut conn, pepper, None)
        .await
        .expect("start");
    tokens::decide_device(&mut conn, &denied.user_code, &c.uuid, false)
        .await
        .expect("deny");
    assert!(matches!(
        tokens::poll_device(&ctx.state.db, pepper, &denied.device_code).await,
        Err(GrantError::AccessDenied(_))
    ));

    let expired = tokens::create_device(&mut conn, pepper, None)
        .await
        .expect("start");
    sqlx::query("update device_authorizations set expires_at = now() - interval '1 second' where user_code = $1")
        .bind(&expired.user_code)
        .execute(&mut *conn)
        .await
        .expect("time travel");
    assert!(matches!(
        tokens::poll_device(&ctx.state.db, pepper, &expired.device_code).await,
        Err(GrantError::ExpiredToken(_))
    ));
    let err = tokens::decide_device(&mut conn, &expired.user_code, &c.uuid, true)
        .await
        .expect_err("expired");
    assert_eq!(err.code, "device_code_expired");
    let err = tokens::device_by_user_code(&mut conn, "ZZZZ-ZZZZ")
        .await
        .expect_err("unknown");
    assert_eq!(err.code, "device_code_not_found");
}
