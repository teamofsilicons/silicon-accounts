//! `grant_type=authorization_code`.

use accounts_core::models::Scope;
use accounts_core::repo::{accounts, memberships};
use accounts_core::test_support::{Req, TestContext, call};
use serde_json::json;

use crate::common::*;

#[tokio::test]
async fn exchange_issues_tokens_and_an_id_token_that_verifies_with_the_jwks() {
    assert!(pkce_constants_agree());
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let (app, secret) = ctx.app("quill-docs").await;
    // The Carbon proved who they are 2 hours before this sign-in completed (continue-as).
    let authenticated = time::OffsetDateTime::now_utc() - time::Duration::hours(2);
    let code = signed_in_code(
        &ctx,
        &app.app_id,
        &carbon,
        Authorize {
            scopes: &[Scope::Profile, Scope::Email, Scope::Openid],
            nonce: Some("n-0S6_WzA2Mj"),
            pkce: Some((CHALLENGE, "S256")),
            auth_time: Some(authenticated),
            ..Default::default()
        },
    )
    .await;
    let r = exchange(&ctx, &app.app_id, &secret, &code, Some(VERIFIER)).await;
    let body = assert_tokens(&r);
    assert_eq!(body["scope"], "profile email openid");
    assert_eq!(
        body["membership_id"],
        format!("{}:{}", app.app_id, carbon.uuid)
    );
    let account = &body["account"];
    assert_eq!(account["uuid"], carbon.uuid.as_str());
    assert_eq!(account["kind"], "carbon");
    assert_eq!(account["id"], carbon.handle.as_deref().expect("handle"));
    let email = s(account, "email").to_string();
    assert!(email.ends_with("@example.test"), "{email}");
    assert_eq!(account["email_verified"], true);
    assert!(account.get("phone").is_none() && account.get("dob").is_none());
    let refresh_expires = time::OffsetDateTime::parse(
        s(body, "refresh_token_expires_at"),
        &time::format_description::well_known::Rfc3339,
    )
    .expect("RFC 3339");
    let days = (refresh_expires - time::OffsetDateTime::now_utc()).whole_days();
    assert!(
        (899..=900).contains(&days),
        "refresh lives 900 days: {days}"
    );

    // A third party checks both tokens with nothing but discovery and the JWKS.
    let discovery = ctx
        .call(router(), Req::get("/.well-known/openid-configuration"))
        .await
        .json;
    let jwks = ctx
        .call(router(), Req::get("/.well-known/jwks.json"))
        .await
        .json;
    let issuer = s(&discovery, "issuer").to_string();
    let id = verify_with_jwks(&jwks, &issuer, &app.app_id, s(body, "id_token"));
    assert_eq!(id["sub"], carbon.uuid.as_str());
    assert_eq!(id["nonce"], "n-0S6_WzA2Mj");
    assert_eq!(id["email"], email.as_str());
    assert_eq!(id["email_verified"], true);
    assert_eq!(id["name"], carbon.display_name.as_str());
    assert_eq!(id["picture"], carbon.pfp_url.as_str());
    assert_eq!(
        id["preferred_username"],
        carbon.handle.as_deref().expect("handle")
    );
    // auth_time is when the Carbon authenticated, not when the code was exchanged.
    assert_eq!(id["auth_time"], authenticated.unix_timestamp());
    assert!(id.get("phone_number").is_none(), "phone scope not granted");
    let access = verify_with_jwks(&jwks, &issuer, &app.app_id, s(body, "access_token"));
    assert_eq!(access["sub"], carbon.uuid.as_str());
    assert_eq!(access["kind"], "carbon");
    assert_eq!(access["mid"], format!("{}:{}", app.app_id, carbon.uuid));
    assert_eq!(access["scope"], "profile email openid");
    assert_eq!(
        access["exp"].as_i64().expect("exp") - access["iat"].as_i64().expect("iat"),
        1800
    );

    // The sign-in is a token family labelled after the code (so a reuse can find it).
    let origin: String = scalar(
        &ctx,
        "select origin from token_families where account_uuid = $1",
        &carbon.uuid,
    )
    .await;
    assert_eq!(origin, "authorization_code");
    let label: String = scalar(
        &ctx,
        "select label from token_families where account_uuid = $1",
        &carbon.uuid,
    )
    .await;
    assert!(label.starts_with("code:"), "{label}");
}

#[tokio::test]
async fn code_is_single_use_and_reuse_revokes_the_tokens_it_issued() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let (app, secret) = ctx.app("briefcase").await;
    ctx.set_app_webhook(&app.app_id, "http://127.0.0.1:8593/briefcase/webhooks")
        .await;
    let code = signed_in_code(&ctx, &app.app_id, &carbon, Authorize::default()).await;
    let first = exchange(&ctx, &app.app_id, &secret, &code, None).await;
    let tokens = assert_tokens(&first).clone();

    let again = exchange(&ctx, &app.app_id, &secret, &code, None).await;
    assert_oauth_error(&again, 400, "invalid_grant", "already used");
    assert!(s(&again.json, "error_description").contains("revoked"));

    // The tokens of the first exchange are dead.
    let r = ctx
        .call(
            router(),
            Req::get("/v1/userinfo").bearer(s(&tokens, "access_token")),
        )
        .await;
    assert_eq!(r.status, 401);
    assert_eq!(r.error_code(), Some("token_revoked"));
    let r = ctx
        .call(
            router(),
            token_req(
                &app.app_id,
                &secret,
                &[
                    ("grant_type", "refresh_token"),
                    ("refresh_token", s(&tokens, "refresh_token")),
                ],
            ),
        )
        .await;
    assert_oauth_error(&r, 400, "invalid_grant", "authorization_code_reuse");

    // The app heard about it, and the account's history has it.
    let events = app_events(&ctx, &app.app_id, "membership.signed_out").await;
    assert_eq!(events.len(), 1, "{events:?}");
    assert_eq!(events[0]["reason"], "authorization_code_reuse");
    assert_eq!(events[0]["uuid"], carbon.uuid.as_str());
    let audits: i64 = scalar(
        &ctx,
        "select count(*) from audit_log where account_uuid = $1 and action = 'oauth.code_reuse_detected'",
        &carbon.uuid,
    )
    .await;
    assert_eq!(audits, 1);

    // A third presentation finds nothing more to revoke.
    let third = exchange(&ctx, &app.app_id, &secret, &code, None).await;
    assert_oauth_error(&third, 400, "invalid_grant", "already used");
    assert_eq!(
        app_events(&ctx, &app.app_id, "membership.signed_out")
            .await
            .len(),
        1
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_redemptions_of_one_code_exactly_one_wins() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let (app, secret) = ctx.app("briefcase").await;
    let code = signed_in_code(
        &ctx,
        &app.app_id,
        &carbon,
        Authorize {
            pkce: Some((CHALLENGE, "S256")),
            ..Default::default()
        },
    )
    .await;
    let redirect = redirect_for(&app.app_id);
    let mut tasks = Vec::new();
    for _ in 0..5 {
        let router = router().with_state(ctx.state.clone());
        let req = token_req(
            &app.app_id,
            &secret,
            &[
                ("grant_type", "authorization_code"),
                ("code", &code),
                ("redirect_uri", &redirect),
                ("code_verifier", VERIFIER),
            ],
        );
        tasks.push(tokio::spawn(async move { call(router, req).await }));
    }
    let mut results = Vec::new();
    for t in tasks {
        results.push(t.await.expect("request task"));
    }
    let winners: Vec<_> = results.iter().filter(|r| r.status == 200).collect();
    assert_eq!(
        winners.len(),
        1,
        "exactly one redemption wins: {:?}",
        results
            .iter()
            .map(|r| (r.status, r.json.clone()))
            .collect::<Vec<_>>()
    );
    for loser in results.iter().filter(|r| r.status != 200) {
        assert_oauth_error(loser, 400, "invalid_grant", "already used");
    }
    // Every loser ran after the winner committed, so the reuse revoked the winner's tokens.
    let families: i64 = scalar(
        &ctx,
        "select count(*) from token_families where account_uuid = $1",
        &carbon.uuid,
    )
    .await;
    assert_eq!(families, 1, "only one sign-in was ever issued");
    let reason: Option<String> = scalar(
        &ctx,
        "select revoke_reason from token_families where account_uuid = $1",
        &carbon.uuid,
    )
    .await;
    assert_eq!(reason.as_deref(), Some("authorization_code_reuse"));
    let r = ctx
        .call(
            router(),
            Req::get("/v1/userinfo").bearer(s(&winners[0].json, "access_token")),
        )
        .await;
    assert_eq!(r.error_code(), Some("token_revoked"));
}

#[tokio::test]
async fn redirect_uri_must_match_exactly_and_a_mismatch_burns_the_code() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let (app, secret) = ctx.app("briefcase").await;
    let code = signed_in_code(&ctx, &app.app_id, &carbon, Authorize::default()).await;
    let close = format!("{}/", redirect_for(&app.app_id));
    let r = ctx
        .call(
            router(),
            token_req(
                &app.app_id,
                &secret,
                &[
                    ("grant_type", "authorization_code"),
                    ("code", &code),
                    ("redirect_uri", &close),
                ],
            ),
        )
        .await;
    assert_oauth_error(&r, 400, "invalid_grant", "does not match the redirect_uri");
    assert!(s(&r.json, "error_description").contains(&redirect_for(&app.app_id)));
    let r = exchange(&ctx, &app.app_id, &secret, &code, None).await;
    assert_oauth_error(&r, 400, "invalid_grant", "already used");
}

#[tokio::test]
async fn missing_parameters_are_refused_without_burning_the_code() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let (app, secret) = ctx.app("briefcase").await;
    let code = signed_in_code(&ctx, &app.app_id, &carbon, Authorize::default()).await;
    let r = ctx
        .call(
            router(),
            token_req(
                &app.app_id,
                &secret,
                &[("grant_type", "authorization_code"), ("code", &code)],
            ),
        )
        .await;
    assert_oauth_error(&r, 400, "invalid_request", "redirect_uri is required");
    let redirect = redirect_for(&app.app_id);
    let r = ctx
        .call(
            router(),
            token_req(
                &app.app_id,
                &secret,
                &[
                    ("grant_type", "authorization_code"),
                    ("redirect_uri", &redirect),
                ],
            ),
        )
        .await;
    assert_oauth_error(&r, 400, "invalid_request", "code is required");
    assert_tokens(&exchange(&ctx, &app.app_id, &secret, &code, None).await);
}

#[tokio::test]
async fn pkce_s256_and_plain_are_enforced() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let (app, secret) = ctx.app("briefcase").await;
    let s256 = Authorize {
        pkce: Some((CHALLENGE, "S256")),
        ..Default::default()
    };

    let code = signed_in_code(&ctx, &app.app_id, &carbon, s256.clone()).await;
    assert_tokens(&exchange(&ctx, &app.app_id, &secret, &code, Some(VERIFIER)).await);

    // A wrong verifier fails and burns the code.
    let code = signed_in_code(&ctx, &app.app_id, &carbon, s256.clone()).await;
    let wrong = "wrong-verifier-wrong-verifier-wrong-verifier-0";
    let r = exchange(&ctx, &app.app_id, &secret, &code, Some(wrong)).await;
    assert_oauth_error(&r, 400, "invalid_grant", "PKCE verification failed");
    assert!(s(&r.json, "error_description").contains("S256"));
    let r = exchange(&ctx, &app.app_id, &secret, &code, Some(VERIFIER)).await;
    assert_oauth_error(&r, 400, "invalid_grant", "already used");

    // A verifier that breaks RFC 7636's syntax says so.
    let code = signed_in_code(&ctx, &app.app_id, &carbon, s256.clone()).await;
    let r = exchange(&ctx, &app.app_id, &secret, &code, Some("short")).await;
    assert_oauth_error(&r, 400, "invalid_grant", "43 to 128");

    // Leaving the verifier out of a challenged code fails.
    let code = signed_in_code(&ctx, &app.app_id, &carbon, s256).await;
    let r = exchange(&ctx, &app.app_id, &secret, &code, None).await;
    assert_oauth_error(&r, 400, "invalid_grant", "code_verifier is required");

    // plain: the verifier is the challenge.
    let plain = "plain-verifier-plain-verifier-plain-verifier-1";
    let code = signed_in_code(
        &ctx,
        &app.app_id,
        &carbon,
        Authorize {
            pkce: Some((plain, "plain")),
            ..Default::default()
        },
    )
    .await;
    assert_tokens(&exchange(&ctx, &app.app_id, &secret, &code, Some(plain)).await);
}

#[tokio::test]
async fn a_verifier_without_a_challenge_is_a_downgrade_and_refused() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let (app, secret) = ctx.app("briefcase").await;
    let code = signed_in_code(&ctx, &app.app_id, &carbon, Authorize::default()).await;
    let r = exchange(&ctx, &app.app_id, &secret, &code, Some(VERIFIER)).await;
    assert_oauth_error(&r, 400, "invalid_grant", "PKCE downgrade");
}

#[tokio::test]
async fn a_code_only_works_for_the_app_it_was_issued_to() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let (app, secret) = ctx.app("briefcase").await;
    let (other, other_secret) = ctx.app("dm").await;
    let code = signed_in_code(&ctx, &app.app_id, &carbon, Authorize::default()).await;
    let redirect = redirect_for(&app.app_id);
    let r = ctx
        .call(
            router(),
            token_req(
                &other.app_id,
                &other_secret,
                &[
                    ("grant_type", "authorization_code"),
                    ("code", &code),
                    ("redirect_uri", &redirect),
                ],
            ),
        )
        .await;
    assert_oauth_error(&r, 400, "invalid_grant", "different app");
    // Presenting it elsewhere burned it.
    let r = exchange(&ctx, &app.app_id, &secret, &code, None).await;
    assert_oauth_error(&r, 400, "invalid_grant", "already used");
}

#[tokio::test]
async fn an_expired_code_is_refused() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let (app, secret) = ctx.app("briefcase").await;
    let code = signed_in_code(&ctx, &app.app_id, &carbon, Authorize::default()).await;
    ctx.exec("update authorization_codes set expires_at = now() - interval '1 second'")
        .await;
    let r = exchange(&ctx, &app.app_id, &secret, &code, None).await;
    assert_oauth_error(&r, 400, "invalid_grant", "expired");
    assert!(s(&r.json, "error_description").contains("120 seconds"));
}

#[tokio::test]
async fn codes_are_valid_for_120_seconds() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let (app, _) = ctx.app("briefcase").await;
    signed_in_code(&ctx, &app.app_id, &carbon, Authorize::default()).await;
    let ttl: f64 = scalar(
        &ctx,
        "select extract(epoch from expires_at - created_at)::float8 from authorization_codes where account_uuid = $1",
        &carbon.uuid,
    )
    .await;
    assert!((ttl - 120.0).abs() < 1.0, "{ttl}");
}

#[tokio::test]
async fn clients_authenticate_with_basic_or_in_the_body() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let (app, secret) = ctx.app("briefcase").await;
    let redirect = redirect_for(&app.app_id);

    // client_secret_post
    let code = signed_in_code(&ctx, &app.app_id, &carbon, Authorize::default()).await;
    let r = ctx
        .call(
            router(),
            Req::post("/v1/oauth/token").form(&[
                ("grant_type", "authorization_code"),
                ("code", &code),
                ("redirect_uri", &redirect),
                ("client_id", &app.app_id),
                ("client_secret", &secret),
            ]),
        )
        .await;
    assert_tokens(&r);

    // A JSON body works too.
    let code = signed_in_code(&ctx, &app.app_id, &carbon, Authorize::default()).await;
    let r = ctx
        .call(
            router(),
            Req::post("/v1/oauth/token")
                .basic(&app.app_id, &secret)
                .json(json!({"grant_type": "authorization_code", "code": code, "redirect_uri": redirect})),
        )
        .await;
    assert_tokens(&r);

    let code = signed_in_code(&ctx, &app.app_id, &carbon, Authorize::default()).await;
    let form = [
        ("grant_type", "authorization_code"),
        ("code", code.as_str()),
        ("redirect_uri", redirect.as_str()),
    ];
    // A wrong secret is invalid_client with a Basic challenge.
    let r = ctx
        .call(router(), token_req(&app.app_id, "sa_app_wrong", &form))
        .await;
    assert_oauth_error(&r, 401, "invalid_client", "wrong");
    assert!(header(&r, "www-authenticate").starts_with("Basic"));
    // No credentials at all.
    let r = ctx
        .call(router(), Req::post("/v1/oauth/token").form(&form))
        .await;
    assert_oauth_error(&r, 401, "invalid_client", "not authenticated");
    // An app id without its secret.
    let mut with_id = form.to_vec();
    with_id.push(("client_id", app.app_id.as_str()));
    let r = ctx
        .call(router(), Req::post("/v1/oauth/token").form(&with_id))
        .await;
    assert_oauth_error(&r, 401, "invalid_client", "client_secret is required");
    // Two authentication methods at once.
    let mut twice = form.to_vec();
    twice.push(("client_secret", secret.as_str()));
    let r = ctx
        .call(router(), token_req(&app.app_id, &secret, &twice))
        .await;
    assert_oauth_error(&r, 400, "invalid_request", "authenticated twice");
    // None of the refused requests touched the code.
    assert_tokens(&exchange(&ctx, &app.app_id, &secret, &code, None).await);
}

#[tokio::test]
async fn the_public_first_party_client_cannot_exchange_codes() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let (app, _) = ctx.app("briefcase").await;
    let code = signed_in_code(&ctx, &app.app_id, &carbon, Authorize::default()).await;
    let redirect = redirect_for(&app.app_id);
    let r = ctx
        .call(
            router(),
            public_token_req(&[
                ("grant_type", "authorization_code"),
                ("code", &code),
                ("redirect_uri", &redirect),
            ]),
        )
        .await;
    assert_oauth_error(&r, 400, "unauthorized_client", "public client");
}

#[tokio::test]
async fn access_removed_after_the_code_was_issued_refuses_it() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let (app, secret) = ctx.app("briefcase").await;
    let code = signed_in_code(&ctx, &app.app_id, &carbon, Authorize::default()).await;
    {
        let mut conn = ctx.conn().await;
        memberships::remove_access(&mut conn, &app.app_id, &carbon.uuid, &carbon.uuid)
            .await
            .expect("remove access");
    }
    let r = exchange(&ctx, &app.app_id, &secret, &code, None).await;
    assert_oauth_error(&r, 400, "invalid_grant", "removed the access");
    assert!(s(&r.json, "error_description").contains("has to sign in to the app again"));
    let status: String = scalar(
        &ctx,
        "select status from memberships where account_uuid = $1",
        &carbon.uuid,
    )
    .await;
    assert_eq!(status, "access_removed", "the membership stays removed");
    let r = exchange(&ctx, &app.app_id, &secret, &code, None).await;
    assert_oauth_error(&r, 400, "invalid_grant", "already used");
}

fn exchange_req(app_id: &str, secret: &str, code: &str) -> Req {
    let redirect = redirect_for(app_id);
    token_req(
        app_id,
        secret,
        &[
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", &redirect),
        ],
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_exchange_during_an_access_removal_waits_for_it_and_is_refused() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let (app, secret) = ctx.app("briefcase").await;
    let code = signed_in_code(&ctx, &app.app_id, &carbon, Authorize::default()).await;

    // DELETE /v1/me/apps/{app_id} is in flight: its transaction holds the membership row and
    // has already revoked every token family it can see.
    let removal = begin_access_removal(&ctx.state, &app.app_id, &carbon.uuid).await;
    let exchange = spawn_token_request(&ctx, exchange_req(&app.app_id, &secret, &code));
    // The exchange waits for the removal instead of deciding on the membership it read before.
    wait_for_lock_waiters(&ctx, 1).await;
    assert!(!exchange.is_finished());
    removal.commit().await.expect("commit the removal");

    let r = exchange.await.expect("exchange task");
    assert_oauth_error(&r, 400, "invalid_grant", "removed the access");
    assert!(s(&r.json, "error_description").contains("after this code was issued"));
    assert_eq!(
        live_families(&ctx, &carbon.uuid).await,
        0,
        "no sign-in survives"
    );
    let status: String = scalar(
        &ctx,
        "select status from memberships where account_uuid = $1",
        &carbon.uuid,
    )
    .await;
    assert_eq!(status, "access_removed");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_exchange_during_an_account_deletion_waits_for_it_and_is_refused() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let (app, secret) = ctx.app("briefcase").await;
    let code = signed_in_code(&ctx, &app.app_id, &carbon, Authorize::default()).await;

    // DELETE /v1/me is in flight: its transaction holds the account row and has revoked every
    // sign-in it can see.
    let mut deletion = ctx.state.db.begin().await.expect("begin the deletion");
    accounts::lock(&mut deletion, &carbon.uuid)
        .await
        .expect("lock the account")
        .expect("the account exists");
    accounts::delete_account(
        &mut deletion,
        &ctx.state.settings,
        &carbon.uuid,
        &carbon.uuid,
        true,
    )
    .await
    .expect("delete the account");
    let exchange = spawn_token_request(&ctx, exchange_req(&app.app_id, &secret, &code));
    wait_for_lock_waiters(&ctx, 1).await;
    assert!(!exchange.is_finished());
    deletion.commit().await.expect("commit the deletion");

    let r = exchange.await.expect("exchange task");
    assert_oauth_error(&r, 400, "invalid_grant", "was deleted");
    assert_eq!(live_families(&ctx, &carbon.uuid).await, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn racing_exchanges_and_access_removals_never_leave_a_live_sign_in() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let (app, secret) = ctx.app("briefcase").await;
    let (mut issued, mut refused) = (0, 0);
    for round in 0..25 {
        // A fresh sign-in (the consent step makes the membership active again).
        let code = signed_in_code(&ctx, &app.app_id, &carbon, Authorize::default()).await;
        let exchange = spawn_token_request(&ctx, exchange_req(&app.app_id, &secret, &code));
        let state = ctx.state.clone();
        let (app_id, uuid) = (app.app_id.clone(), carbon.uuid.clone());
        let removal = tokio::spawn(async move {
            begin_access_removal(&state, &app_id, &uuid)
                .await
                .commit()
                .await
                .expect("commit the removal");
        });
        let r = exchange.await.expect("exchange task");
        removal.await.expect("removal task");
        if r.status == 200 {
            issued += 1;
        } else {
            assert_oauth_error(&r, 400, "invalid_grant", "removed the access");
            refused += 1;
        }
        // Whichever ran first, the account's decision wins: no live sign-in for the app.
        assert_eq!(
            live_families(&ctx, &carbon.uuid).await,
            0,
            "round {round}: a sign-in outlived the access removal ({})",
            r.json
        );
    }
    assert_eq!(issued + refused, 25);
}

#[tokio::test]
async fn a_missing_membership_is_recorded_at_exchange() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let (app, secret) = ctx.app("briefcase").await;
    let code = signed_in_code(
        &ctx,
        &app.app_id,
        &carbon,
        Authorize {
            scopes: &[Scope::Profile, Scope::Timezone],
            no_membership: true,
            ..Default::default()
        },
    )
    .await;
    assert_tokens(&exchange(&ctx, &app.app_id, &secret, &code, None).await);
    let mut conn = ctx.conn().await;
    let m = memberships::get(&mut conn, &app.app_id, &carbon.uuid)
        .await
        .expect("query")
        .expect("membership recorded");
    assert_eq!(m.status.as_str(), "active");
    assert_eq!(m.source.as_str(), "signin");
    assert_eq!(m.scopes(), vec![Scope::Profile, Scope::Timezone]);
}

#[tokio::test]
async fn a_deleted_account_cannot_exchange_its_code() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let (app, secret) = ctx.app("briefcase").await;
    let code = signed_in_code(&ctx, &app.app_id, &carbon, Authorize::default()).await;
    ctx.exec(&format!(
        "update accounts set status = 'deleted', handle = null, deleted_at = now() where uuid = '{}'",
        carbon.uuid
    ))
    .await;
    let r = exchange(&ctx, &app.app_id, &secret, &code, None).await;
    assert_oauth_error(&r, 400, "invalid_grant", "was deleted");
    let r = exchange(&ctx, &app.app_id, &secret, &code, None).await;
    assert_oauth_error(&r, 400, "invalid_grant", "already used");
}

#[tokio::test]
async fn other_credentials_and_unknown_codes_get_precise_errors() {
    let ctx = TestContext::new().await;
    let (app, secret) = ctx.app("briefcase").await;
    let redirect = redirect_for(&app.app_id);
    for (code, expected) in [
        ("sar_not-a-code", "a refresh token"),
        ("slt_not-a-code", "a short-lived token"),
        ("hello", "not a Silicon Accounts authorization code"),
        ("sac_unknown", "not known"),
    ] {
        let r = ctx
            .call(
                router(),
                token_req(
                    &app.app_id,
                    &secret,
                    &[
                        ("grant_type", "authorization_code"),
                        ("code", code),
                        ("redirect_uri", &redirect),
                    ],
                ),
            )
            .await;
        assert_oauth_error(&r, 400, "invalid_grant", expected);
    }
}
