//! Real PostgreSQL and composed HTTP tests for work-account boundaries.
use accounts_core::models::{Account, Scope};
use accounts_core::repo::{accounts, organizations, tokens};
use accounts_core::test_support::{Req, Resp, TestContext, call};
use serde_json::{Value, json};

async fn send(ctx: &TestContext, req: Req) -> Resp {
    call(accounts_server::build_router(ctx.state.clone()), req).await
}
async fn setup() -> (TestContext, String, Account, String) {
    let ctx = TestContext::new().await;
    let secret = "org-test-service-secret".to_string();
    sqlx::query("insert into apps(app_id,name,secret_hash,status,source) values('silicon-organizations','Organizations',$1,'active','fake')").bind(ctx.state.keys.pepper.hash(&secret)).execute(&ctx.state.db).await.unwrap();
    sqlx::query("insert into app_signin_configs(app_id,config) values('silicon-organizations','{\"redirect_uris\":[\"http://localhost:8661/auth/callback\"]}')").execute(&ctx.state.db).await.unwrap();
    let personal = ctx.carbon().await;
    ctx.membership(organizations::APP_ID, &personal.uuid, &[Scope::Profile])
        .await;
    let token = ctx
        .tokens_for(&personal, organizations::APP_ID, &[Scope::Profile])
        .await
        .access_token;
    let r = send(
        &ctx,
        Req::put("/v1/internal/organizations/testorg")
            .basic(organizations::APP_ID, &secret)
            .json(json!({"name":"Test organization","version":1})),
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.json);
    (ctx, secret, personal, token)
}
async fn create(ctx: &TestContext, secret: &str, body: Value) -> Resp {
    send(
        ctx,
        Req::post("/v1/internal/organizations/testorg/accounts")
            .basic(organizations::APP_ID, secret)
            .header("idempotency-key", &uuid::Uuid::new_v4().to_string())
            .json(body),
    )
    .await
}
async fn work(ctx: &TestContext, secret: &str, actor: &str) -> Account {
    let r = create(
        ctx,
        secret,
        json!({"kind":"carbon","handle":"founder","display_name":"Founder","actor_token":actor}),
    )
    .await;
    assert_eq!(r.status, 201, "{}", r.json);
    accounts::require(
        &mut *ctx.conn().await,
        r.json["account"]["uuid"].as_str().unwrap(),
    )
    .await
    .unwrap()
}
#[tokio::test]
async fn work_identity_is_separate_and_linking_preserves_personal_privacy() {
    let (ctx, secret, personal, actor) = setup().await;
    let work = work(&ctx, &secret, &actor).await;
    assert_ne!(personal.uuid, work.uuid);
    assert_eq!(work.id(), "c:founder.testorg");
    let first = ctx.first_party_tokens(&personal).await;
    let r = send(
        &ctx,
        Req::get("/v1/me/linked-accounts").bearer(&first.access_token),
    )
    .await;
    assert_eq!(r.json["main_uuid"], personal.uuid);
    assert_eq!(r.json["accounts"].as_array().unwrap().len(), 2);
    let contacts: i64 =
        sqlx::query_scalar("select count(*) from account_emails where account_uuid=$1")
            .bind(&work.uuid)
            .fetch_one(&ctx.state.db)
            .await
            .unwrap();
    assert_eq!(contacts, 0);
    let own = ctx.first_party_tokens(&work).await;
    let r = send(
        &ctx,
        Req::post("/v1/me/id")
            .bearer(&own.access_token)
            .json(json!({"id":"c:hijack.testorg"})),
    )
    .await;
    assert_eq!(r.status, 403, "{}", r.json);
    let r = send(
        &ctx,
        Req::delete("/v1/me")
            .bearer(&own.access_token)
            .json(json!({"confirm":work.id()})),
    )
    .await;
    assert_eq!(r.status, 403, "{}", r.json);
    let other = ctx.carbon().await;
    let other_tokens = ctx.first_party_tokens(&other).await;
    let r = send(
        &ctx,
        Req::post("/v1/me/linked-accounts/link")
            .bearer(&first.access_token)
            .json(json!({"target_access_token":other_tokens.access_token})),
    )
    .await;
    assert_eq!(r.status, 409, "{}", r.json);
    let leaked: i64 =
        sqlx::query_scalar("select count(*) from organization_work_events where account_uuid=$1")
            .bind(&personal.uuid)
            .fetch_one(&ctx.state.db)
            .await
            .unwrap();
    assert_eq!(leaked, 0);
    let r = send(
        &ctx,
        Req::post(&format!(
            "/v1/internal/organizations/testorg/accounts/{}/close",
            work.uuid
        ))
        .basic(organizations::APP_ID, &secret)
        .json(json!({})),
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert!(
        accounts::require(&mut *ctx.conn().await, &personal.uuid)
            .await
            .unwrap()
            .is_active()
    );
    assert!(
        !organizations::linked(&mut *ctx.conn().await, &personal.uuid, &work.uuid)
            .await
            .unwrap()
    );
    assert!(
        tokens::verify_access_token(
            &mut *ctx.conn().await,
            &ctx.state.keys,
            &own.access_token,
            None
        )
        .await
        .is_err()
    );
}
#[tokio::test]
async fn organization_policy_immediately_revokes_tokens_proofs_and_respects_exclusions() {
    let (ctx, secret, _, actor) = setup().await;
    let work = work(&ctx, &secret, &actor).await;
    let (app, app_secret) = ctx.app("allowed").await;
    ctx.membership(&app.app_id, &work.uuid, &[Scope::Profile])
        .await;
    ctx.set_app_webhook(&app.app_id, "http://127.0.0.1:8999/hook")
        .await;
    let granted = ctx.tokens_for(&work, &app.app_id, &[Scope::Profile]).await;
    let own = ctx.first_party_tokens(&work).await;
    let r=send(&ctx,Req::put(&format!("/v1/internal/organizations/testorg/accounts/{}/policy",work.uuid)).basic(organizations::APP_ID,&secret).json(json!({"version":2,"mode":"only","apps":[],"extra_apps":[app.app_id],"excluded_apps":[app.app_id,"silicon-accounts","silicon-organizations"]}))).await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert!(
        r.json["removed_apps"]
            .as_array()
            .unwrap()
            .contains(&json!(app.app_id))
    );
    let r = send(
        &ctx,
        Req::post("/v1/me/short-lived-tokens")
            .bearer(&own.access_token)
            .json(json!({"app_id":app.app_id})),
    )
    .await;
    assert_eq!(r.status, 403, "{}", r.json);
    let r = send(
        &ctx,
        Req::post("/v1/oauth/introspect")
            .basic(&app.app_id, &app_secret)
            .form(&[("token", &granted.access_token)]),
    )
    .await;
    assert_eq!(r.json["active"], false);
    let r = send(
        &ctx,
        Req::post("/v1/oauth/token")
            .basic(&app.app_id, &app_secret)
            .form(&[
                ("grant_type", "refresh_token"),
                ("refresh_token", granted.refresh_token.as_str()),
            ]),
    )
    .await;
    assert_eq!(r.status, 400, "{}", r.json);
    let r = send(&ctx, Req::get("/v1/me").bearer(&own.access_token)).await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert!(
        organizations::allowed(&mut *ctx.conn().await, &work.uuid, organizations::APP_ID)
            .await
            .unwrap()
    );
    let n:i64=sqlx::query_scalar("select count(*) from webhook_events where account_uuid=$1 and type='membership.access_removed'").bind(&work.uuid).fetch_one(&ctx.state.db).await.unwrap();
    assert!(n > 0);
    let r = send(
        &ctx,
        Req::put(&format!(
            "/v1/internal/organizations/testorg/accounts/{}/policy",
            work.uuid
        ))
        .basic(organizations::APP_ID, &secret)
        .json(json!({"version":1,"mode":"everywhere"})),
    )
    .await;
    assert_eq!(r.status, 409);
}
#[tokio::test]
async fn organization_silicon_has_durable_custody_and_cross_kind_handle_reservation() {
    let (ctx, secret, personal, actor) = setup().await;
    let _work = work(&ctx, &secret, &actor).await;
    let duplicate = create(
        &ctx,
        &secret,
        json!({"kind":"silicon","handle":"founder","display_name":"Agent"}),
    )
    .await;
    assert_eq!(duplicate.status, 409, "{}", duplicate.json);
    let created = create(
        &ctx,
        &secret,
        json!({"kind":"silicon","handle":"agent","display_name":"Agent"}),
    )
    .await;
    assert_eq!(created.status, 201, "{}", created.json);
    let uuid = created.json["account"]["uuid"].as_str().unwrap();
    let stk = created.json["stk"].as_str().unwrap();
    let agent = accounts::require(&mut *ctx.conn().await, uuid)
        .await
        .unwrap();
    assert!(agent.custodian_uuid.is_none());
    let r = send(
        &ctx,
        Req::post("/v1/silicons/login").json(json!({"id":agent.id(),"stk":stk})),
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.json);
    let r = send(
        &ctx,
        Req::get("/v1/me").bearer(r.json["access_token"].as_str().unwrap()),
    )
    .await;
    assert_eq!(r.json["org_custodian"]["org_id"], "testorg");
    accounts::delete_account(
        &mut *ctx.conn().await,
        &ctx.state.settings,
        &personal.uuid,
        &personal.uuid,
        true,
    )
    .await
    .unwrap();
    assert!(
        accounts::require(&mut *ctx.conn().await, uuid)
            .await
            .unwrap()
            .is_active()
    );
    let r = send(
        &ctx,
        Req::post(&format!(
            "/v1/internal/organizations/testorg/accounts/{uuid}/rename"
        ))
        .basic(organizations::APP_ID, &secret)
        .json(json!({"handle":"new-agent"})),
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.json);
    let duplicate = create(
        &ctx,
        &secret,
        json!({"kind":"silicon","handle":"agent","display_name":"Reserved"}),
    )
    .await;
    assert_eq!(duplicate.status, 409, "{}", duplicate.json);
}
#[tokio::test]
async fn guest_invitation_proves_email_and_creates_only_work_account() {
    let (ctx, secret, _, _) = setup().await;
    let invite=send(&ctx,Req::post("/v1/internal/organizations/testorg/invitations").basic(organizations::APP_ID,&secret).json(json!({"invite_id":"invite-guest","email":"guest-new@example.test","handle":"guest-new","return_to":"https://organizations.teamofsilicons.com/invites/invite-guest"}))).await;
    assert_eq!(invite.status, 201, "{}", invite.json);
    let ticket = invite.json["ticket"].as_str().unwrap();
    let before: i64 = sqlx::query_scalar("select count(*) from accounts")
        .fetch_one(&ctx.state.db)
        .await
        .unwrap();
    let sent = send(
        &ctx,
        Req::post(&format!("/v1/work-invitations/{ticket}/email-code")),
    )
    .await;
    assert_eq!(sent.status, 200, "{}", sent.json);
    let message:String=sqlx::query_scalar("select text_body from outbound_messages where to_address='guest-new@example.test' order by created_at desc limit 1").fetch_one(&ctx.state.db).await.unwrap();
    let code = accounts_core::delivery::extract_code(&message).unwrap();
    let verified=send(&ctx,Req::post(&format!("/v1/work-invitations/{ticket}/verify")).json(json!({"challenge_id":sent.json["challenge_id"],"code":code,"display_name":"Guest","dob":"1995-03-02","timezone":"Asia/Kolkata"}))).await;
    assert_eq!(verified.status, 200, "{}", verified.json);
    let after_proof: i64 = sqlx::query_scalar("select count(*) from accounts")
        .fetch_one(&ctx.state.db)
        .await
        .unwrap();
    assert_eq!(before, after_proof);
    let body = json!({"kind":"carbon","handle":"guest-new","invitation_id":"invite-guest","invitation_proof":verified.json["invitation_proof"]});
    let accepted = create(&ctx, &secret, body.clone()).await;
    assert_eq!(accepted.status, 201, "{}", accepted.json);
    assert!(accepted.json["slt"].as_str().is_some());
    let after: i64 = sqlx::query_scalar("select count(*) from accounts")
        .fetch_one(&ctx.state.db)
        .await
        .unwrap();
    assert_eq!(after, before + 1);
    let guest = accounts::by_email(&mut *ctx.conn().await, "guest-new@example.test")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(guest.id(), "c:guest-new.testorg");
    let repeated = create(&ctx, &secret, body).await;
    assert!(repeated.status.is_client_error());
    let slt = accepted.json["slt"].as_str().unwrap();
    let signed = send(
        &ctx,
        Req::post("/v1/oauth/token")
            .basic(organizations::APP_ID, &secret)
            .form(&[
                ("grant_type", "urn:silicon:params:oauth:grant-type:slt"),
                ("slt", slt),
            ]),
    )
    .await;
    assert_eq!(signed.status, 200, "{}", signed.json);
}

async fn exchange_slt(ctx: &TestContext, app: &str, secret: &str, slt: &str, key: &str) -> Resp {
    send(
        ctx,
        Req::post("/v1/oauth/token")
            .basic(app, secret)
            .header("idempotency-key", key)
            .form(&[("grant_type", "slt"), ("slt", slt)]),
    )
    .await
}
#[tokio::test]
async fn keyed_slt_recovery_is_bound_and_never_resurrects_a_rotated_session() {
    let (ctx, _, personal, _) = setup().await;
    let (app, secret) = ctx.app("recovery").await;
    let slt = tokens::create_slt(
        &mut *ctx.conn().await,
        &ctx.state.keys.pepper,
        &personal.uuid,
        &app.app_id,
        &[Scope::Profile],
    )
    .await
    .unwrap()
    .0;
    let first = exchange_slt(&ctx, &app.app_id, &secret, &slt, "stable-slt-exchange").await;
    assert_eq!(first.status, 200, "{}", first.json);
    // Rebuild the router and reread PostgreSQL: no process-local cache participates.
    let retry = exchange_slt(&ctx, &app.app_id, &secret, &slt, "stable-slt-exchange").await;
    assert_eq!(retry.status, 200, "{}", retry.json);
    assert_eq!(first.json["access_token"], retry.json["access_token"]);
    assert_eq!(first.json["refresh_token"], retry.json["refresh_token"]);
    let wrong = exchange_slt(
        &ctx,
        &app.app_id,
        &secret,
        "slt_different",
        "stable-slt-exchange",
    )
    .await;
    assert_eq!(wrong.status, 409, "{}", wrong.json);
    let refreshed = send(
        &ctx,
        Req::post("/v1/oauth/token")
            .basic(&app.app_id, &secret)
            .form(&[
                ("grant_type", "refresh_token"),
                (
                    "refresh_token",
                    first.json["refresh_token"].as_str().unwrap(),
                ),
            ]),
    )
    .await;
    assert_eq!(refreshed.status, 200, "{}", refreshed.json);
    let stale = exchange_slt(&ctx, &app.app_id, &secret, &slt, "stable-slt-exchange").await;
    assert_eq!(stale.status, 409, "{}", stale.json);
    assert_eq!(stale.json["error"], "exchange_superseded");
}
#[tokio::test]
async fn keyed_code_recovery_binds_redirect_and_pkce_and_honors_replay_revocation() {
    let (ctx, _, personal, _) = setup().await;
    let (app, secret) = ctx.app("recovercode").await;
    ctx.membership(&app.app_id, &personal.uuid, &[Scope::Profile])
        .await;
    let verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~";
    let challenge =
        accounts_core::crypto::b64url(&accounts_core::crypto::sha256(verifier.as_bytes()));
    let code = tokens::create_code(
        &mut *ctx.conn().await,
        &ctx.state.keys.pepper,
        &tokens::NewAuthCode {
            flow_id: "recovery-flow",
            app_id: &app.app_id,
            account_uuid: &personal.uuid,
            redirect_uri: "https://example.test/callback",
            code_challenge: Some(&challenge),
            code_challenge_method: Some("S256"),
            scopes: &[Scope::Profile],
            nonce: None,
            browser_session_id: None,
            auth_time: None,
        },
    )
    .await
    .unwrap();
    let request = |key: &str, redirect: &str, proof: &str| {
        Req::post("/v1/oauth/token")
            .basic(&app.app_id, &secret)
            .header("idempotency-key", key)
            .form(&[
                ("grant_type", "authorization_code"),
                ("code", &code),
                ("redirect_uri", redirect),
                ("code_verifier", proof),
            ])
    };
    let first = send(
        &ctx,
        request(
            "stable-code-exchange",
            "https://example.test/callback",
            verifier,
        ),
    )
    .await;
    assert_eq!(first.status, 200, "{}", first.json);
    let retry = send(
        &ctx,
        request(
            "stable-code-exchange",
            "https://example.test/callback",
            verifier,
        ),
    )
    .await;
    assert_eq!(retry.status, 200, "{}", retry.json);
    assert_eq!(retry.json["refresh_token"], first.json["refresh_token"]);
    for (redirect, proof) in [
        ("https://wrong.test/callback", verifier),
        ("https://example.test/callback", "different-pkce"),
    ] {
        let invalid = send(&ctx, request("stable-code-exchange", redirect, proof)).await;
        assert_eq!(invalid.status, 409, "{}", invalid.json);
    }
    let reused = send(
        &ctx,
        request(
            "different-operation",
            "https://example.test/callback",
            verifier,
        ),
    )
    .await;
    assert_eq!(reused.status, 400, "{}", reused.json);
    let revoked = send(
        &ctx,
        request(
            "stable-code-exchange",
            "https://example.test/callback",
            verifier,
        ),
    )
    .await;
    assert_eq!(revoked.status, 409, "{}", revoked.json);
    assert_eq!(revoked.json["error"], "exchange_session_ended");
}
#[tokio::test]
async fn silicon_link_requires_recipient_or_current_custodian_consent() {
    let (ctx, secret, custodian, _) = setup().await;
    let (personal, _) = ctx.silicon(&custodian.uuid).await;
    let created = create(
        &ctx,
        &secret,
        json!({"kind":"silicon","handle":"consent","display_name":"Work agent"}),
    )
    .await;
    assert_eq!(created.status, 201, "{}", created.json);
    let work = created.json["account"]["uuid"].as_str().unwrap();
    let r = send(
        &ctx,
        Req::post(&format!(
            "/v1/internal/organizations/testorg/accounts/{work}/link-request"
        ))
        .basic(organizations::APP_ID, &secret)
        .header("idempotency-key", "link-consent")
        .json(json!({"target_id":personal.id()})),
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.json);
    let id = r.json["request_id"].as_str().unwrap();
    assert!(
        !organizations::linked(&mut *ctx.conn().await, work, &personal.uuid)
            .await
            .unwrap()
    );
    let unrelated = ctx.carbon().await;
    let unrelated = ctx.first_party_tokens(&unrelated).await;
    let deny = send(
        &ctx,
        Req::post(&format!("/v1/me/linked-accounts/requests/{id}/accept"))
            .bearer(&unrelated.access_token)
            .json(json!({})),
    )
    .await;
    assert_eq!(deny.status, 403, "{}", deny.json);
    let custody = ctx.first_party_tokens(&custodian).await;
    let list = send(
        &ctx,
        Req::get("/v1/me/linked-accounts/requests").bearer(&custody.access_token),
    )
    .await;
    assert_eq!(list.json["items"].as_array().unwrap().len(), 1);
    let accepted = send(
        &ctx,
        Req::post(&format!("/v1/me/linked-accounts/requests/{id}/accept"))
            .bearer(&custody.access_token)
            .json(json!({})),
    )
    .await;
    assert_eq!(accepted.status, 200, "{}", accepted.json);
    assert!(
        organizations::linked(&mut *ctx.conn().await, work, &personal.uuid)
            .await
            .unwrap()
    );
    let leaked: i64 =
        sqlx::query_scalar("select count(*) from organization_work_events where actor_id=any($1)")
            .bind(vec![custodian.uuid, personal.uuid])
            .fetch_one(&ctx.state.db)
            .await
            .unwrap();
    assert_eq!(
        leaked, 0,
        "Org work events must never reveal personal linked identities"
    );
}
#[tokio::test]
async fn account_creation_receipt_survives_http_cache_loss_and_actor_refresh() {
    let (ctx, secret, personal, actor) = setup().await;
    let body = json!({"kind":"carbon","handle":"recovered","actor_token":actor});
    let request = |body: Value| {
        Req::post("/v1/internal/organizations/testorg/accounts")
            .basic(organizations::APP_ID, &secret)
            .header("idempotency-key", "durable-create")
            .json(body)
    };
    let first = send(&ctx, request(body.clone())).await;
    assert_eq!(first.status, 201, "{}", first.json);
    sqlx::query("delete from idempotency_keys")
        .execute(&ctx.state.db)
        .await
        .unwrap();
    let new_actor = ctx
        .tokens_for(&personal, organizations::APP_ID, &[Scope::Profile])
        .await;
    let mut retry_body = body;
    retry_body["actor_token"] = json!(new_actor.access_token);
    let retry = send(&ctx, request(retry_body)).await;
    assert_eq!(retry.status, 201, "{}", retry.json);
    assert_eq!(first.json, retry.json);
    let count: i64 =
        sqlx::query_scalar("select count(*) from accounts where handle='c:recovered.testorg'")
            .fetch_one(&ctx.state.db)
            .await
            .unwrap();
    assert_eq!(count, 1);
    let receipts:i64=sqlx::query_scalar("select count(*) from organization_bridge_receipts where scope='org:testorg:create_account'").fetch_one(&ctx.state.db).await.unwrap();
    assert_eq!(receipts, 1);
}

#[tokio::test]
async fn proof_receiver_policy_revokes_and_logs_without_receiver_membership() {
    let (ctx, secret, _, actor) = setup().await;
    let work = work(&ctx, &secret, &actor).await;
    let (issuer, issuer_secret) = ctx.app("proofissuer").await;
    let (receiver, receiver_secret) = ctx.app("proofreceiver").await;
    ctx.membership(&issuer.app_id, &work.uuid, &[Scope::Profile])
        .await;
    let subject = ctx
        .tokens_for(&work, &issuer.app_id, &[Scope::Profile])
        .await;
    let issued=send(&ctx,Req::post("/v1/proofs/user-verification").basic(&issuer.app_id,&issuer_secret).json(json!({"subject_token":subject.access_token,"receiving_app":receiver.app_id,"scopes":["read"]}))).await;
    assert_eq!(issued.status, 201, "{}", issued.json);
    let policy = send(
        &ctx,
        Req::put(&format!(
            "/v1/internal/organizations/testorg/accounts/{}/policy",
            work.uuid
        ))
        .basic(organizations::APP_ID, &secret)
        .json(json!({"version":2,"mode":"everywhere","excluded_apps":[receiver.app_id]})),
    )
    .await;
    assert_eq!(policy.status, 200, "{}", policy.json);
    let checked = send(
        &ctx,
        Req::post("/v1/proofs/verify")
            .basic(&receiver.app_id, &receiver_secret)
            .json(json!({"proof_token":issued.json["proof_token"]})),
    )
    .await;
    assert_eq!(checked.status, 200, "{}", checked.json);
    assert_eq!(checked.json["valid"], false);
    let n:i64=sqlx::query_scalar("select count(*) from organization_work_events where account_uuid=$1 and kind='proof.revoked'").bind(&work.uuid).fetch_one(&ctx.state.db).await.unwrap();
    assert_eq!(n, 1);
    assert!(
        tokens::verify_access_token(
            &mut *ctx.conn().await,
            &ctx.state.keys,
            &subject.access_token,
            Some(&issuer.app_id)
        )
        .await
        .is_ok()
    );
}
