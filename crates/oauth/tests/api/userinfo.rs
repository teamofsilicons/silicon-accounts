//! GET / POST /v1/userinfo.

use accounts_core::jwt::AccessTokenInput;
use accounts_core::models::{AccountKind, Scope};
use accounts_core::repo::tokens;
use accounts_core::test_support::{CarbonSpec, Req, Resp, TestContext};
use uuid::Uuid;

use crate::common::*;

async fn userinfo(ctx: &TestContext, access_token: &str) -> Resp {
    ctx.call(router(), Req::get("/v1/userinfo").bearer(access_token))
        .await
}

#[track_caller]
fn assert_challenge(r: &Resp, status: u16, code: &str, error: Option<&str>) {
    assert_eq!(r.status.as_u16(), status, "{}", r.json);
    assert_eq!(r.error_code(), Some(code), "{}", r.json);
    let challenge = header(r, "www-authenticate");
    assert!(
        challenge.starts_with("Bearer realm=\"Silicon Accounts\""),
        "{challenge:?}"
    );
    match error {
        Some(e) => {
            assert!(
                challenge.contains(&format!("error=\"{e}\"")),
                "{challenge:?}"
            );
            assert!(challenge.contains("error_description=\""), "{challenge:?}");
        }
        None => assert!(!challenge.contains("error="), "{challenge:?}"),
    }
}

#[tokio::test]
async fn userinfo_is_the_scoped_account_with_oidc_claim_names() {
    let ctx = TestContext::new().await;
    let carbon = ctx
        .carbon_with(CarbonSpec {
            phone: Some("+12025550142".into()),
            timezone: Some("Asia/Kolkata".into()),
            ..Default::default()
        })
        .await;
    let (app, secret) = ctx.app("ledgerly").await;
    let tokens = sign_in(
        &ctx,
        &app.app_id,
        &secret,
        &carbon,
        &[
            Scope::Profile,
            Scope::Email,
            Scope::Phone,
            Scope::Dob,
            Scope::Timezone,
        ],
    )
    .await;
    let r = userinfo(&ctx, s(&tokens, "access_token")).await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(header(&r, "cache-control"), "no-store");
    let j = &r.json;
    assert_eq!(j["uuid"], carbon.uuid.as_str());
    assert_eq!(j["sub"], carbon.uuid.as_str());
    assert_eq!(
        j["membership_id"],
        format!("{}:{}", app.app_id, carbon.uuid)
    );
    assert_eq!(j["kind"], "carbon");
    assert_eq!(j["id"], carbon.handle.as_deref().expect("handle"));
    assert_eq!(j["display_name"], carbon.display_name.as_str());
    assert_eq!(j["name"], carbon.display_name.as_str());
    assert_eq!(j["pfp_url"], carbon.pfp_url.as_str());
    assert_eq!(j["picture"], carbon.pfp_url.as_str());
    assert!(s(j, "email").ends_with("@example.test"));
    assert_eq!(j["email_verified"], true);
    assert_eq!(j["phone"], "+12025550142");
    assert_eq!(j["phone_number"], "+12025550142");
    assert_eq!(j["phone_verified"], true);
    assert_eq!(j["phone_number_verified"], true);
    assert_eq!(j["dob"], "2000-01-01");
    assert_eq!(j["birthdate"], "2000-01-01");
    assert_eq!(j["timezone"], "Asia/Kolkata");
    assert_eq!(j["zoneinfo"], "Asia/Kolkata");
    assert!(j["updated_at"].is_string() && j["version"].is_i64());
}

#[tokio::test]
async fn only_granted_scopes_are_visible() {
    let ctx = TestContext::new().await;
    let carbon = ctx
        .carbon_with(CarbonSpec {
            phone: Some("+12025550143".into()),
            ..Default::default()
        })
        .await;
    let (app, secret) = ctx.app("briefcase").await;
    let tokens = sign_in(&ctx, &app.app_id, &secret, &carbon, &[Scope::Profile]).await;
    let r = userinfo(&ctx, s(&tokens, "access_token")).await;
    assert_eq!(r.status, 200);
    for hidden in [
        "email",
        "email_verified",
        "phone",
        "phone_number",
        "dob",
        "birthdate",
        "timezone",
        "zoneinfo",
        "custodian",
    ] {
        assert!(r.json.get(hidden).is_none(), "{hidden} leaked: {}", r.json);
    }
    assert_eq!(r.json["sub"], carbon.uuid.as_str());
}

#[tokio::test]
async fn a_silicon_shows_its_custodian_and_never_contacts() {
    let ctx = TestContext::new().await;
    let custodian = ctx.carbon().await;
    let (silicon, _) = ctx.silicon(&custodian.uuid).await;
    let (app, secret) = ctx.app("remind").await;
    let slt = {
        let mut conn = ctx.conn().await;
        tokens::create_slt(
            &mut conn,
            &ctx.state.keys.pepper,
            &silicon.uuid,
            &app.app_id,
            &[Scope::Profile, Scope::Email, Scope::Timezone],
        )
        .await
        .expect("slt")
        .0
    };
    let r = ctx
        .call(
            router(),
            token_req(
                &app.app_id,
                &secret,
                &[("grant_type", "slt"), ("slt", &slt)],
            ),
        )
        .await;
    let body = assert_tokens(&r).clone();
    let r = userinfo(&ctx, s(&body, "access_token")).await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(r.json["kind"], "silicon");
    assert_eq!(r.json["custodian"]["uuid"], custodian.uuid.as_str());
    assert_eq!(r.json["zoneinfo"], "UTC");
    assert!(r.json.get("email").is_none(), "Silicons have no email");
}

#[tokio::test]
async fn first_party_tokens_work_too() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let tokens = ctx.first_party_tokens(&carbon).await;
    let r = userinfo(&ctx, &tokens.access_token).await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(r.json["membership_id"], format!("accounts:{}", carbon.uuid));
}

#[tokio::test]
async fn errors_carry_a_bearer_challenge() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let (app, secret) = ctx.app("briefcase").await;

    let r = ctx.call(router(), Req::get("/v1/userinfo")).await;
    assert_challenge(&r, 401, "unauthenticated", None);
    let r = ctx
        .call(
            router(),
            Req::get("/v1/userinfo").basic(&app.app_id, &secret),
        )
        .await;
    assert_challenge(&r, 401, "invalid_authorization", None);
    let r = ctx
        .call(
            router(),
            Req::get("/v1/userinfo").header("authorization", "Bearer"),
        )
        .await;
    assert_challenge(&r, 401, "invalid_token", Some("invalid_token"));
    let r = userinfo(&ctx, "sar_not-an-access-token").await;
    assert_challenge(&r, 401, "invalid_token", Some("invalid_token"));
    assert!(s(&r.json["error"], "message").contains("refresh token"));

    // Revoked sign-in.
    let tokens = sign_in(&ctx, &app.app_id, &secret, &carbon, &[Scope::Profile]).await;
    ctx.exec("update token_families set revoked_at = now(), revoke_reason = 'app_revoked'")
        .await;
    let r = userinfo(&ctx, s(&tokens, "access_token")).await;
    assert_challenge(&r, 401, "token_revoked", Some("invalid_token"));

    // Expired access token.
    let fresh = sign_in(&ctx, &app.app_id, &secret, &carbon, &[Scope::Profile]).await;
    let family: Uuid = {
        let mut conn = ctx.conn().await;
        sqlx::query_scalar(
            "select id from token_families where account_uuid = $1 and revoked_at is null",
        )
        .bind(&carbon.uuid)
        .fetch_one(&mut *conn)
        .await
        .expect("family")
    };
    let (expired, _) = ctx
        .state
        .keys
        .jwt
        .sign_access(&AccessTokenInput {
            account_uuid: &carbon.uuid,
            app_id: &app.app_id,
            kind: AccountKind::Carbon,
            id: carbon.handle.as_deref().expect("handle"),
            family_id: family,
            scope: "profile",
            ttl_seconds: -600,
        })
        .expect("sign");
    let r = userinfo(&ctx, &expired).await;
    assert_challenge(&r, 401, "invalid_token", Some("invalid_token"));
    assert!(s(&r.json["error"], "message").contains("expired at"));
    assert!(s(&r.json["error"], "message").contains("30 minutes"));
    assert_eq!(userinfo(&ctx, s(&fresh, "access_token")).await.status, 200);
}

/// An access token signed for the account's live sign-in at the app, expiring `ttl` seconds
/// from now (negative = already expired).
async fn token_expiring_in(
    ctx: &TestContext,
    app_id: &str,
    account: &accounts_core::models::Account,
    ttl: i64,
) -> (String, i64) {
    let family: Uuid = {
        let mut conn = ctx.conn().await;
        sqlx::query_scalar(
            "select id from token_families where account_uuid = $1 and app_id = $2 and revoked_at is null",
        )
        .bind(&account.uuid)
        .bind(app_id)
        .fetch_one(&mut *conn)
        .await
        .expect("live family")
    };
    let (token, claims) = ctx
        .state
        .keys
        .jwt
        .sign_access(&AccessTokenInput {
            account_uuid: &account.uuid,
            app_id,
            kind: account.kind,
            id: account.handle.as_deref().expect("handle"),
            family_id: family,
            scope: "profile",
            ttl_seconds: ttl,
        })
        .expect("sign");
    (token, claims.exp)
}

#[tokio::test]
async fn an_access_token_stops_working_at_its_exp_without_leeway() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let (app, secret) = ctx.app("briefcase").await;
    sign_in(&ctx, &app.app_id, &secret, &carbon, &[Scope::Profile]).await;

    // Expired 5 s ago: inside the 30 s clock-skew leeway other verifiers allow, but this server
    // issued it, so it is expired here.
    let (expired, exp) = token_expiring_in(&ctx, &app.app_id, &carbon, -5).await;
    let r = userinfo(&ctx, &expired).await;
    assert_challenge(&r, 401, "invalid_token", Some("invalid_token"));
    let message = s(&r.json["error"], "message");
    let expired_at = accounts_core::timefmt::format_rfc3339_ms(
        time::OffsetDateTime::from_unix_timestamp(exp).expect("exp"),
    );
    assert!(
        message.contains(&format!("expired at {expired_at}")),
        "{message}"
    );
    assert_eq!(
        r.json["error"]["details"]["expired_at"],
        expired_at.as_str()
    );
    assert!(s(&r.json["error"], "hint").contains("grant_type=refresh_token"));

    // Still valid for a while: works.
    let (valid, _) = token_expiring_in(&ctx, &app.app_id, &carbon, 60).await;
    assert_eq!(userinfo(&ctx, &valid).await.status, 200);
}

#[tokio::test]
async fn an_apps_token_reads_the_account_only_while_the_membership_is_active() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let (app, secret) = ctx.app("briefcase").await;
    let tokens = sign_in(&ctx, &app.app_id, &secret, &carbon, &[Scope::Profile]).await;
    let access = s(&tokens, "access_token");

    // Access removed while the sign-in somehow stayed live (removal normally revokes it).
    ctx.exec("update memberships set status = 'access_removed', access_removed_at = now()")
        .await;
    let r = userinfo(&ctx, access).await;
    assert_challenge(&r, 401, "access_removed", Some("invalid_token"));
    let message = s(&r.json["error"], "message");
    assert!(message.contains("removed the access"), "{message}");
    assert!(message.contains(&app.app_id), "{message}");
    assert!(
        message.contains(carbon.handle.as_deref().expect("handle")),
        "{message}"
    );

    // Imported only (never signed in through the app since): not active either.
    ctx.exec("update memberships set status = 'imported', access_removed_at = null")
        .await;
    let r = userinfo(&ctx, access).await;
    assert_challenge(&r, 401, "membership_inactive", Some("invalid_token"));

    ctx.exec("update memberships set status = 'active'").await;
    assert_eq!(userinfo(&ctx, access).await.status, 200);

    // First-party tokens have no membership and keep working.
    let first_party = ctx.first_party_tokens(&carbon).await;
    assert_eq!(userinfo(&ctx, &first_party.access_token).await.status, 200);
}

#[tokio::test]
async fn post_takes_the_token_in_the_header_or_the_form_but_not_both() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let (app, secret) = ctx.app("briefcase").await;
    let tokens = sign_in(&ctx, &app.app_id, &secret, &carbon, &[Scope::Profile]).await;
    let access = s(&tokens, "access_token");
    let r = ctx
        .call(router(), Req::post("/v1/userinfo").bearer(access))
        .await;
    assert_eq!(r.status, 200, "{}", r.json);
    let r = ctx
        .call(
            router(),
            Req::post("/v1/userinfo").form(&[("access_token", access)]),
        )
        .await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(r.json["sub"], carbon.uuid.as_str());
    let r = ctx
        .call(
            router(),
            Req::post("/v1/userinfo")
                .bearer(access)
                .form(&[("access_token", access)]),
        )
        .await;
    assert_challenge(&r, 400, "invalid_request", Some("invalid_request"));
    let r = ctx.call(router(), Req::post("/v1/userinfo")).await;
    assert_challenge(&r, 401, "unauthenticated", None);
}

#[tokio::test]
async fn a_disabled_apps_tokens_stop_reading_accounts() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let (app, secret) = ctx.app("briefcase").await;
    let tokens = sign_in(&ctx, &app.app_id, &secret, &carbon, &[Scope::Profile]).await;
    ctx.exec(&format!(
        "update apps set status = 'disabled' where app_id = '{}'",
        app.app_id
    ))
    .await;
    let r = userinfo(&ctx, s(&tokens, "access_token")).await;
    assert_challenge(&r, 401, "app_disabled", Some("invalid_token"));
    assert!(s(&r.json["error"], "message").contains(&app.app_id));
    ctx.exec(&format!(
        "update apps set status = 'active' where app_id = '{}'",
        app.app_id
    ))
    .await;
    assert_eq!(userinfo(&ctx, s(&tokens, "access_token")).await.status, 200);
}

#[tokio::test]
async fn silicon_apps_verified_emails_need_email_scope_and_exclude_unverified() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    sqlx::query("insert into apps(app_id,name,source,status,secret_hash) values('silicon-apps','Silicon Apps','silicon_apps','active','test'::bytea)").execute(&ctx.state.db).await.unwrap();
    sqlx::query("insert into account_emails(account_uuid,email,is_primary,verified_at) values($1,'secondary@company.test',false,now()),($1,'unverified@company.test',false,null)").bind(&carbon.uuid).execute(&ctx.state.db).await.unwrap();
    for scopes in [vec![Scope::Profile], vec![Scope::Profile, Scope::Email]] {
        ctx.membership("silicon-apps", &carbon.uuid, &scopes).await;
        let token = ctx
            .tokens_for(&carbon, "silicon-apps", &scopes)
            .await
            .access_token;
        let response = userinfo(&ctx, &token).await;
        assert_eq!(response.status, 200, "{}", response.json);
        if scopes.contains(&Scope::Email) {
            let emails = response.json["verified_emails"].as_array().unwrap();
            assert!(emails.iter().any(|v| v == "secondary@company.test"));
            assert!(!emails.iter().any(|v| v == "unverified@company.test"));
            assert_eq!(emails.len(), 2);
        } else {
            assert!(response.json.get("verified_emails").is_none());
        }
    }
    let (other, _) = ctx.app("other").await;
    ctx.membership(&other.app_id, &carbon.uuid, &[Scope::Profile, Scope::Email])
        .await;
    let token = ctx
        .tokens_for(&carbon, &other.app_id, &[Scope::Profile, Scope::Email])
        .await
        .access_token;
    assert!(
        userinfo(&ctx, &token)
            .await
            .json
            .get("verified_emails")
            .is_none()
    );
}
