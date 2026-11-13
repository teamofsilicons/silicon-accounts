mod common;
use accounts_core::{
    crypto::pkce,
    models::Scope,
    test_support::{Req, TestContext},
};
use common::router;
use serde_json::{Value, json};
const VERIFIER: &str = "this-is-a-valid-test-verifier-0123456789-abcdefghi";
const SECRET: &str = "sif_secret_example_01234567890123456789012345678901";

async fn fixture(
    ctx: &TestContext,
    kind: &str,
    public: bool,
) -> (accounts_core::models::Account, String, String) {
    let account = ctx.carbon().await;
    let cookie = ctx.browser_session(&account).await;
    let (app, _) = ctx.app_owned("target", Some(&account.uuid)).await;
    sqlx::query("insert into interface_auth_clients(interface_id,owner_uuid,revision,kind,name,app_ids,redirect_uris,allowed_origins,branding,signin_config,app_descriptions,active,secret_hash) values('potato',$1,1,$2,'Potato',$3,$4,$5,'{}'::jsonb,$6,'{}'::jsonb,true,$7)")
        .bind(&account.uuid).bind(kind).bind(vec![app.app_id.clone()]).bind(vec!["https://potato.example/callback"]).bind(vec!["https://potato.example"]).bind(json!({"public_client":public})).bind(ctx.state.keys.pepper.hash(SECRET)).execute(&ctx.state.db).await.unwrap();
    (account, cookie, app.app_id)
}
async fn begin(ctx: &TestContext, cookie: &str) -> Value {
    let r=ctx.call(router(),Req::post("/v1/interface-auth/flows").session(&ctx.state.settings,cookie).json(json!({"interface_id":"potato","redirect_uri":"https://potato.example/callback","state":"client-state","code_challenge":pkce::s256_challenge(VERIFIER),"code_challenge_method":"S256"}))).await;
    assert_eq!(r.status, 200, "{}", r.json);
    r.json
}
async fn decide(ctx: &TestContext, cookie: &str, id: &str, approve: bool) -> Value {
    ctx.call(
        router(),
        Req::post(&format!("/v1/interface-auth/flows/{id}/decision"))
            .session(&ctx.state.settings, cookie)
            .json(json!({"approve":approve})),
    )
    .await
    .json
}
fn code(value: &Value) -> String {
    url::Url::parse(value["redirect_to"].as_str().unwrap())
        .unwrap()
        .query_pairs()
        .find(|(k, _)| k == "code")
        .unwrap()
        .1
        .to_string()
}
fn exchange(code: &str, key: &str) -> Req {
    Req::post("/v1/interface-auth/token").header("idempotency-key",key).json(json!({"interface_id":"potato","grant_type":"authorization_code","code":code,"redirect_uri":"https://potato.example/callback","code_verifier":VERIFIER}))
}
fn refresh(token: &str, key: &str) -> Req {
    Req::post("/v1/interface-auth/token")
        .header("idempotency-key", key)
        .json(json!({"interface_id":"potato","grant_type":"refresh_token","refresh_token":token}))
}
fn inspect(token: &str) -> Req {
    Req::post("/v1/interface-auth/introspect")
        .json(json!({"interface_id":"potato","refresh_token":token}))
}

#[tokio::test]
async fn pkce_consent_refresh_reuse_revokes_only_interface_families() {
    let ctx = TestContext::new().await;
    let (account, cookie, app) = fixture(&ctx, "unverified", true).await;
    ctx.membership(&app, &account.uuid, &[Scope::Profile]).await;
    let unrelated = ctx.tokens_for(&account, &app, &[Scope::Profile]).await;
    let flow = begin(&ctx, &cookie).await;
    assert_eq!(flow["consent_required"], true);
    assert_eq!(flow["apps"][0]["app_id"], app);
    let id = flow["flow_id"].as_str().unwrap();
    let other = ctx.carbon().await;
    let other_cookie = ctx.browser_session(&other).await;
    let denied = ctx
        .call(
            router(),
            Req::post(&format!("/v1/interface-auth/flows/{id}/decision"))
                .session(&ctx.state.settings, &other_cookie)
                .json(json!({"approve":true})),
        )
        .await;
    assert_eq!(denied.status, 403);
    let done = decide(&ctx, &cookie, id, true).await;
    let code = code(&done);
    let issued = ctx.call(router(), exchange(&code, "first")).await;
    assert_eq!(issued.status, 200, "{}", issued.json);
    assert_eq!(issued.json["account"]["uuid"], account.uuid);
    assert!(issued.json["apps"][&app]["access_token"].is_string());
    assert!(issued.json["apps"][&app].get("refresh_token").is_none());
    let first = issued.json["refresh_token"].as_str().unwrap();
    assert_eq!(
        ctx.call(router(), inspect(first)).await.json["active"],
        true
    );
    let second = ctx.call(router(), refresh(first, "refresh-1")).await;
    assert_eq!(second.status, 200, "{}", second.json);
    assert_eq!(
        ctx.call(router(), refresh(first, "refresh-1")).await.json,
        second.json
    );
    assert_eq!(
        ctx.call(router(), exchange(&code, "first")).await.status,
        409
    );
    let current = second.json["refresh_token"].as_str().unwrap();
    assert_eq!(
        ctx.call(router(), inspect(current)).await.json["active"],
        true
    );
    let reuse = ctx.call(router(), refresh(first, "different-key")).await;
    assert_eq!(reuse.status, 401, "{}", reuse.json);
    assert_eq!(
        ctx.call(router(), inspect(current)).await.json["active"],
        false
    );
    let family = ctx
        .state
        .keys
        .jwt
        .verify_access(&unrelated.access_token, Some(&app))
        .unwrap()
        .family_id()
        .unwrap();
    let revoked: Option<time::OffsetDateTime> =
        sqlx::query_scalar("select revoked_at from token_families where id=$1")
            .bind(family)
            .fetch_one(&ctx.state.db)
            .await
            .unwrap();
    assert!(revoked.is_none());
}

#[tokio::test]
async fn deny_and_confidential_client_secret_are_enforced() {
    let ctx = TestContext::new().await;
    let (_, cookie, _) = fixture(&ctx, "verified", false).await;
    let flow = begin(&ctx, &cookie).await;
    let denied = decide(&ctx, &cookie, flow["flow_id"].as_str().unwrap(), false).await;
    assert!(
        denied["redirect_to"]
            .as_str()
            .unwrap()
            .contains("error=access_denied")
    );
    let flow = begin(&ctx, &cookie).await;
    let code = code(&decide(&ctx, &cookie, flow["flow_id"].as_str().unwrap(), true).await);
    assert_eq!(
        ctx.call(router(), exchange(&code, "missing-secret"))
            .await
            .status,
        401
    );
    let issued=ctx.call(router(),Req::post("/v1/interface-auth/token").header("idempotency-key","with-secret").json(json!({"interface_id":"potato","grant_type":"authorization_code","client_secret":SECRET,"code":code,"redirect_uri":"https://potato.example/callback","code_verifier":VERIFIER}))).await;
    assert_eq!(issued.status, 200, "{}", issued.json);
}

#[tokio::test]
async fn accounts_sign_in_renders_interface_branding_and_enforces_methods() {
    let ctx = TestContext::new().await;
    let (_, _, _) = fixture(&ctx, "unverified", true).await;
    sqlx::query("update interface_auth_clients set signin_config=$1 where interface_id='potato'")
        .bind(json!({"methods":{"email":true,"phone":false,"google":false,"apple":false},"copy":{"title":"Enter Potato"}})).execute(&ctx.state.db).await.unwrap();
    let flow = ctx.call(router(), Req::post("/v1/flows").header("origin",&ctx.state.settings.public_origin).json(json!({"app_id":"silicon-accounts","interface_id":"potato","redirect_uri":format!("{}/sign-in",ctx.state.settings.public_origin)}))).await;
    assert_eq!(flow.status, 201, "{}", flow.json);
    assert_eq!(flow.json["flow"]["app"]["name"], "Potato");
    assert_eq!(flow.json["flow"]["app"]["first_party"], false);
    assert_eq!(flow.json["flow"]["app"]["copy"]["title"], "Enter Potato");
    assert_eq!(flow.json["flow"]["methods"], json!(["email"]));
}

#[tokio::test]
async fn missing_required_contact_can_be_added_then_optional_fields_are_explicitly_selected() {
    let ctx = TestContext::new().await;
    let (account, cookie, app) = fixture(&ctx, "unverified", true).await;
    sqlx::query("insert into app_signin_configs(app_id,config,updated_by) values($1,$2,$3) on conflict(app_id) do update set config=excluded.config")
        .bind(&app).bind(json!({"required_fields":["phone"],"optional_fields":["email","timezone"]})).bind(&account.uuid).execute(&ctx.state.db).await.unwrap();
    let request = || {
        Req::post("/v1/interface-auth/flows").session(&ctx.state.settings,&cookie).json(json!({"interface_id":"potato","redirect_uri":"https://potato.example/callback","state":"client-state","code_challenge":pkce::s256_challenge(VERIFIER),"code_challenge_method":"S256"}))
    };
    let missing = ctx.call(router(), request()).await;
    assert_eq!(missing.status, 403, "{}", missing.json);
    assert_eq!(missing.error_code(), Some("required_detail_missing"));
    assert_eq!(missing.json["error"]["details"]["field"], "phone");
    let phone = "+14155550123";
    let add = ctx
        .call(
            accounts_account::router(),
            Req::post("/v1/me/phones")
                .session(&ctx.state.settings, &cookie)
                .json(json!({"phone":phone})),
        )
        .await;
    assert_eq!(add.status, 201, "{}", add.json);
    let challenge = add.json["challenge_id"].as_str().unwrap();
    let messages = ctx.outbox(phone).await;
    let verification_code =
        accounts_core::delivery::extract_code(&messages.first().unwrap().1).unwrap();
    let verify = ctx
        .call(
            accounts_account::router(),
            Req::post("/v1/me/phones/verify")
                .session(&ctx.state.settings, &cookie)
                .json(json!({"challenge_id":challenge,"code":verification_code})),
        )
        .await;
    assert_eq!(verify.status, 200, "{}", verify.json);
    let started = ctx.call(router(), request()).await;
    assert_eq!(started.status, 200, "{}", started.json);
    let id = started.json["flow_id"].as_str().unwrap();
    assert_eq!(
        started.json["apps"][0]["optional_scopes"],
        json!(["email", "timezone"])
    );
    let decide_body = json!({"approve":true,"optional_scopes":{app.clone():["email"]}});
    let approved = ctx
        .call(
            router(),
            Req::post(&format!("/v1/interface-auth/flows/{id}/decision"))
                .session(&ctx.state.settings, &cookie)
                .json(decide_body),
        )
        .await;
    assert_eq!(approved.status, 200, "{}", approved.json);
    let issued = ctx
        .call(router(), exchange(&code(&approved.json), "optional"))
        .await;
    assert_eq!(issued.status, 200, "{}", issued.json);
    let scope = issued.json["apps"][&app]["scope"].as_str().unwrap();
    assert!(scope.contains("phone") && scope.contains("email"));
    assert!(!scope.contains("timezone"));
}

#[tokio::test]
async fn account_can_remove_its_interface_without_touching_other_signins() {
    let ctx = TestContext::new().await;
    let (account, cookie, app) = fixture(&ctx, "unverified", true).await;
    ctx.membership(&app, &account.uuid, &[Scope::Profile]).await;
    let unrelated = ctx.tokens_for(&account, &app, &[Scope::Profile]).await;
    let flow = begin(&ctx, &cookie).await;
    let authorized = decide(&ctx, &cookie, flow["flow_id"].as_str().unwrap(), true).await;
    let result = ctx
        .call(router(), exchange(&code(&authorized), "user-session"))
        .await;
    assert_eq!(result.status, 200, "{}", result.json);
    let refresh = result.json["refresh_token"].as_str().unwrap();
    let list = ctx
        .call(
            router(),
            Req::get("/v1/me/interface-sessions").session(&ctx.state.settings, &cookie),
        )
        .await;
    assert_eq!(list.json["sessions"].as_array().unwrap().len(), 1);
    let stranger = ctx.carbon().await;
    let stranger_cookie = ctx.browser_session(&stranger).await;
    let id = result.json["session_id"].as_str().unwrap();
    let not_owned = ctx
        .call(
            router(),
            Req::delete(&format!("/v1/me/interface-sessions/{id}"))
                .session(&ctx.state.settings, &stranger_cookie),
        )
        .await;
    assert_eq!(not_owned.status, 404);
    let removed = ctx
        .call(
            router(),
            Req::delete("/v1/me/interfaces/potato").session(&ctx.state.settings, &cookie),
        )
        .await;
    assert_eq!(removed.json["revoked_sessions"], 1);
    assert_eq!(
        ctx.call(router(), inspect(refresh)).await.json["active"],
        false
    );
    let family = ctx
        .state
        .keys
        .jwt
        .verify_access(&unrelated.access_token, Some(&app))
        .unwrap()
        .family_id()
        .unwrap();
    let revoked: Option<time::OffsetDateTime> =
        sqlx::query_scalar("select revoked_at from token_families where id=$1")
            .bind(family)
            .fetch_one(&ctx.state.db)
            .await
            .unwrap();
    assert!(revoked.is_none());
}

#[tokio::test]
async fn trusted_interface_still_obeys_organization_policy_on_issue_and_refresh() {
    let ctx = TestContext::new().await;
    let (account, cookie, app) = fixture(&ctx, "trusted", true).await;
    sqlx::query("insert into organization_projections(org_id,name) values('workorg','Work')")
        .execute(&ctx.state.db)
        .await
        .unwrap();
    sqlx::query("update accounts set handle='c:testuser.workorg',org_id='workorg' where uuid=$1")
        .bind(&account.uuid)
        .execute(&ctx.state.db)
        .await
        .unwrap();
    sqlx::query("insert into organization_account_policies(account_uuid,version,mode,apps) values($1,1,'only','{}')").bind(&account.uuid).execute(&ctx.state.db).await.unwrap();
    let body = json!({"interface_id":"potato","redirect_uri":"https://potato.example/callback","state":"state","code_challenge":pkce::s256_challenge(VERIFIER),"code_challenge_method":"S256"});
    let denied = ctx
        .call(
            router(),
            Req::post("/v1/interface-auth/flows")
                .session(&ctx.state.settings, &cookie)
                .json(body.clone()),
        )
        .await;
    assert_eq!(denied.status, 403, "{}", denied.json);
    sqlx::query("update organization_account_policies set apps=$2,version=2 where account_uuid=$1")
        .bind(&account.uuid)
        .bind(vec![app])
        .execute(&ctx.state.db)
        .await
        .unwrap();
    let allowed = ctx
        .call(
            router(),
            Req::post("/v1/interface-auth/flows")
                .session(&ctx.state.settings, &cookie)
                .json(body),
        )
        .await;
    assert_eq!(allowed.status, 200, "{}", allowed.json);
    assert_eq!(allowed.json["consent_required"], false);
    let approved = decide(
        &ctx,
        &cookie,
        allowed.json["flow_id"].as_str().unwrap(),
        true,
    )
    .await;
    let issued = ctx
        .call(router(), exchange(&code(&approved), "work-first"))
        .await;
    assert_eq!(issued.status, 200, "{}", issued.json);
    let refresh_token = issued.json["refresh_token"].as_str().unwrap();
    sqlx::query(
        "update organization_account_policies set apps='{}',version=3 where account_uuid=$1",
    )
    .bind(&account.uuid)
    .execute(&ctx.state.db)
    .await
    .unwrap();
    assert_eq!(
        ctx.call(router(), inspect(refresh_token)).await.json["active"],
        false
    );
    assert_eq!(
        ctx.call(router(), refresh(refresh_token, "work-refresh"))
            .await
            .status,
        403
    );
}

#[tokio::test]
async fn adding_an_app_does_not_expand_an_existing_unverified_grant() {
    let ctx = TestContext::new().await;
    let (account, cookie, original) = fixture(&ctx, "unverified", true).await;
    let flow = begin(&ctx, &cookie).await;
    let done = decide(&ctx, &cookie, flow["flow_id"].as_str().unwrap(), true).await;
    let first = ctx.call(router(), exchange(&code(&done), "old-code")).await;
    assert_eq!(first.status, 200, "{}", first.json);
    let refresh_token = first.json["refresh_token"].as_str().unwrap();
    let (new_app, _) = ctx.app_owned("added", Some(&account.uuid)).await;
    sqlx::query("update interface_auth_clients set app_ids=$2,revision=2 where interface_id=$1")
        .bind("potato")
        .bind(vec![original.clone(), new_app.app_id.clone()])
        .execute(&ctx.state.db)
        .await
        .unwrap();
    let old = ctx
        .call(router(), refresh(refresh_token, "old-refresh"))
        .await;
    assert_eq!(old.status, 200, "{}", old.json);
    assert!(old.json["apps"].get(&new_app.app_id).is_none());
    let new_flow = begin(&ctx, &cookie).await;
    assert_eq!(new_flow["apps"].as_array().unwrap().len(), 2);
    let approved = decide(&ctx, &cookie, new_flow["flow_id"].as_str().unwrap(), true).await;
    let new = ctx
        .call(router(), exchange(&code(&approved), "new-code"))
        .await;
    assert_eq!(new.status, 200, "{}", new.json);
    assert!(new.json["apps"].get(&new_app.app_id).is_some());
}

#[tokio::test]
async fn trusted_interface_cannot_reactivate_an_explicitly_removed_app() {
    let ctx = TestContext::new().await;
    let (account, cookie, app) = fixture(&ctx, "trusted", true).await;
    ctx.membership(&app, &account.uuid, &[Scope::Profile]).await;
    sqlx::query("update memberships set status='access_removed',access_removed_at=now() where app_id=$1 and account_uuid=$2").bind(&app).bind(&account.uuid).execute(&ctx.state.db).await.unwrap();
    let flow = begin(&ctx, &cookie).await;
    let done = decide(&ctx, &cookie, flow["flow_id"].as_str().unwrap(), true).await;
    let refused = ctx.call(router(), exchange(&code(&done), "removed")).await;
    assert_eq!(refused.status, 403, "{}", refused.json);
    assert_eq!(refused.error_code(), Some("app_access_removed"));
    let status: String =
        sqlx::query_scalar("select status from memberships where app_id=$1 and account_uuid=$2")
            .bind(&app)
            .bind(&account.uuid)
            .fetch_one(&ctx.state.db)
            .await
            .unwrap();
    assert_eq!(status, "access_removed");
}

#[tokio::test]
async fn verified_backend_uses_secret_and_bound_capability_without_exposing_accounts_cookies() {
    let ctx = TestContext::new().await;
    let (account, _, app) = fixture(&ctx, "verified", true).await;
    let body = json!({"interface_id":"potato","interface_origin":"https://potato.example","redirect_uri":"https://potato.example/callback","state":"verified-state","code_challenge":pkce::s256_challenge(VERIFIER),"code_challenge_method":"S256"});
    let start = || {
        Req::post("/v1/verified-interface-auth/start")
            .bearer(SECRET)
            .json(body.clone())
    };
    let wrong = ctx
        .call(
            router(),
            Req::post("/v1/verified-interface-auth/start")
                .bearer("wrong")
                .json(body.clone()),
        )
        .await;
    assert_eq!(wrong.status, 401);
    let browser = ctx
        .call(router(), start().header("origin", "https://potato.example"))
        .await;
    assert_eq!(browser.status, 403);
    let started = ctx.call(router(), start()).await;
    assert_eq!(started.status, 200, "{}", started.json);
    assert!(
        started
            .headers
            .get_all("set-cookie")
            .iter()
            .next()
            .is_none()
    );
    let capability = started.json["capability"].as_str().unwrap();
    let action = |name: &str, payload: Value| {
        Req::post("/v1/verified-interface-auth/action").bearer(SECRET).json(json!({"interface_id":"potato","interface_origin":"https://potato.example","capability":capability,"action":name,"payload":payload}))
    };
    let mut conn = ctx.conn().await;
    let email = accounts_core::repo::contacts::primary_email(&mut conn, &account.uuid)
        .await
        .unwrap()
        .unwrap()
        .value;
    drop(conn);
    let sent = ctx
        .call(router(), action("email", json!({"email":email})))
        .await;
    assert_eq!(sent.status, 200, "{}", sent.json);
    let messages = ctx.outbox(&email).await;
    let otp = accounts_core::delivery::extract_code(&messages.first().unwrap().1).unwrap();
    let verified = ctx
        .call(router(), action("verify", json!({"code":otp})))
        .await;
    assert_eq!(verified.status, 200, "{}", verified.json);
    assert_eq!(verified.json["flow"]["step"], "complete");
    assert!(verified.json["flow"]["redirect_to"].is_null());
    assert!(
        verified
            .headers
            .get_all("set-cookie")
            .iter()
            .next()
            .is_none()
    );
    sqlx::query("update interface_auth_clients set revision=2 where interface_id='potato'")
        .execute(&ctx.state.db)
        .await
        .unwrap();
    let changed = ctx.call(router(), action("review", json!({}))).await;
    assert_eq!(changed.error_code(), Some("invalid_capability"));
    sqlx::query("update interface_auth_clients set revision=1 where interface_id='potato'")
        .execute(&ctx.state.db)
        .await
        .unwrap();
    let review = ctx.call(router(), action("review", json!({}))).await;
    assert_eq!(review.status, 200, "{}", review.json);
    assert_eq!(review.json["review"]["apps"][0]["app_id"], app);
    let decision = ctx
        .call(router(), action("decision", json!({"approve":true})))
        .await;
    assert_eq!(decision.status, 200, "{}", decision.json);
    let issued = ctx
        .call(router(), exchange(&code(&decision.json), "verified-code"))
        .await;
    assert_eq!(issued.status, 200, "{}", issued.json);
    assert_eq!(issued.json["account"]["uuid"], account.uuid);
    sqlx::query("update interface_auth_clients set kind='unverified' where interface_id='potato'")
        .execute(&ctx.state.db)
        .await
        .unwrap();
    assert_eq!(ctx.call(router(), start()).await.status, 403);
    assert_eq!(
        ctx.call(router(), action("get", json!({}))).await.status,
        403
    );
}

#[tokio::test]
async fn verified_bridge_recovers_after_upstream_commits_before_cookie_receipt() {
    let ctx = TestContext::new().await;
    let (_, _, _) = fixture(&ctx, "verified", true).await;
    let start_body = json!({"interface_id":"potato","interface_origin":"https://potato.example","redirect_uri":"https://potato.example/callback","state":"recovery-state","code_challenge":pkce::s256_challenge(VERIFIER),"code_challenge_method":"S256"});
    let started = ctx
        .call(
            router(),
            Req::post("/v1/verified-interface-auth/start")
                .bearer(SECRET)
                .json(start_body),
        )
        .await;
    assert_eq!(started.status, 200, "{}", started.json);
    let capability = started.json["capability"].as_str().unwrap();
    let action = |name: &str, payload: Value| {
        Req::post("/v1/verified-interface-auth/action").bearer(SECRET).json(json!({"interface_id":"potato","interface_origin":"https://potato.example","capability":capability,"action":name,"payload":payload}))
    };
    let email = "new-person@example.test";
    assert_eq!(
        ctx.call(router(), action("email", json!({"email":email})))
            .await
            .status,
        200
    );
    let otp =
        accounts_core::delivery::extract_code(&ctx.outbox(email).await.first().unwrap().1).unwrap();
    let read_bridge = || async {
        let (id,sealed):(String,Vec<u8>)=sqlx::query_as("select signin_flow_id,sealed_cookies from verified_interface_auth_flows where capability_hash=$1").bind(ctx.state.keys.pepper.hash(capability)).fetch_one(&ctx.state.db).await.unwrap();
        let jar: std::collections::BTreeMap<String, String> =
            serde_json::from_str(&ctx.state.keys.keyring.decrypt_string(&sealed).unwrap()).unwrap();
        let cookie = jar
            .iter()
            .map(|(k, v)| format!("{k}={v}"))
            .collect::<Vec<_>>()
            .join("; ");
        (id, cookie)
    };
    let (id, cookie) = read_bridge().await;
    // Simulate Accounts committing verification while the process dies before
    // the bridge can persist the returned Set-Cookie header.
    let upstream = ctx
        .call(
            router(),
            Req::post(&format!("/v1/flows/{id}/verify"))
                .header("origin", &ctx.state.settings.public_origin)
                .header("cookie", &cookie)
                .json(json!({"code":otp})),
        )
        .await;
    assert_eq!(upstream.status, 200, "{}", upstream.json);
    assert_eq!(upstream.json["flow"]["step"], "signup");
    let recovered = ctx
        .call(router(), action("verify", json!({"code":otp})))
        .await;
    assert_eq!(recovered.status, 200, "{}", recovered.json);
    assert_eq!(recovered.json["flow"]["step"], "signup");
    let (id, cookie) = read_bridge().await;
    let signup = json!({"display_name":"Recovered User"});
    let upstream = ctx
        .call(
            router(),
            Req::post(&format!("/v1/flows/{id}/signup"))
                .header("origin", &ctx.state.settings.public_origin)
                .header("cookie", &cookie)
                .json(signup.clone()),
        )
        .await;
    assert_eq!(upstream.status, 200, "{}", upstream.json);
    assert_eq!(upstream.json["flow"]["step"], "complete");
    let recovered = ctx.call(router(), action("signup", signup)).await;
    assert_eq!(recovered.status, 200, "{}", recovered.json);
    assert_eq!(recovered.json["flow"]["step"], "complete");
    let count: i64 = sqlx::query_scalar("select count(*) from account_emails where email=$1")
        .bind(email)
        .fetch_one(&ctx.state.db)
        .await
        .unwrap();
    assert_eq!(count, 1);
    let review = ctx.call(router(), action("review", json!({}))).await;
    assert_eq!(review.status, 200, "{}", review.json);
    let decision = ctx
        .call(router(), action("decision", json!({"approve":true})))
        .await;
    assert_eq!(decision.status, 200, "{}", decision.json);
    assert_eq!(
        ctx.call(router(), action("decision", json!({"approve":true})))
            .await
            .json,
        decision.json
    );
    assert_eq!(
        ctx.call(router(), action("decision", json!({"approve":false})))
            .await
            .status,
        409
    );
    let internal_revoked:bool=sqlx::query_scalar("select b.revoked_at is not null from verified_interface_auth_flows v join browser_sessions b on b.id=v.browser_session_id where v.capability_hash=$1").bind(ctx.state.keys.pepper.hash(capability)).fetch_one(&ctx.state.db).await.unwrap();
    assert!(internal_revoked);
}

#[tokio::test]
async fn hosted_interface_signin_lets_carbon_select_a_linked_work_account() {
    let ctx = TestContext::new().await;
    let (personal, cookie, app) = fixture(&ctx, "unverified", true).await;
    let work = ctx.carbon().await;
    sqlx::query(
        "insert into organization_projections(org_id,name) values('selectorg','Select Org')",
    )
    .execute(&ctx.state.db)
    .await
    .unwrap();
    sqlx::query(
        "update accounts set handle='c:colleague.selectorg',org_id='selectorg' where uuid=$1",
    )
    .bind(&work.uuid)
    .execute(&ctx.state.db)
    .await
    .unwrap();
    sqlx::query("insert into organization_account_policies(account_uuid,version,mode,apps) values($1,1,'only',$2)").bind(&work.uuid).bind(vec![app]).execute(&ctx.state.db).await.unwrap();
    sqlx::query("insert into account_links(account_uuid,main_uuid) values($1,$2)")
        .bind(&work.uuid)
        .bind(&personal.uuid)
        .execute(&ctx.state.db)
        .await
        .unwrap();
    let mut browser = common::Browser::new(&ctx);
    browser.cookies.insert("sa_session".into(), cookie);
    let flow = common::new_flow(
        &ctx,
        &mut browser,
        "silicon-accounts",
        json!({"interface_id":"potato"}),
    )
    .await;
    let id = common::id_of(&flow);
    assert_eq!(flow["step"], "select_account");
    assert!(
        flow["accounts"]
            .as_array()
            .unwrap()
            .iter()
            .any(|a| a["uuid"] == work.uuid)
    );
    let selected = browser
        .post(
            &ctx,
            &format!("/v1/flows/{id}/select-account"),
            json!({"account_uuid":work.uuid}),
        )
        .await;
    assert_eq!(selected.status, 200, "{}", selected.json);
    assert_eq!(selected.json["flow"]["step"], "complete");
    let review=browser.post(&ctx,"/v1/interface-auth/flows",json!({"interface_id":"potato","redirect_uri":"https://potato.example/callback","state":"work-state","code_challenge":pkce::s256_challenge(VERIFIER),"code_challenge_method":"S256"})).await;
    assert_eq!(review.status, 200, "{}", review.json);
}

#[tokio::test]
async fn selecting_linked_account_keeps_interface_custom_signin_pages() {
    let ctx = TestContext::new().await;
    let (personal, cookie, app) = fixture(&ctx, "unverified", true).await;
    let work = ctx.carbon().await;
    sqlx::query(
        "insert into organization_projections(org_id,name) values('linkedconfig','Linked Config')",
    )
    .execute(&ctx.state.db)
    .await
    .unwrap();
    sqlx::query(
        "update accounts set handle='c:member.linkedconfig',org_id='linkedconfig' where uuid=$1",
    )
    .bind(&work.uuid)
    .execute(&ctx.state.db)
    .await
    .unwrap();
    sqlx::query("insert into organization_account_policies(account_uuid,version,mode,apps) values($1,1,'only',$2)")
        .bind(&work.uuid).bind(vec![app]).execute(&ctx.state.db).await.unwrap();
    sqlx::query("insert into account_links(account_uuid,main_uuid) values($1,$2)")
        .bind(&work.uuid)
        .bind(&personal.uuid)
        .execute(&ctx.state.db)
        .await
        .unwrap();
    sqlx::query("update interface_auth_clients set signin_config=$1 where interface_id='potato'")
        .bind(json!({"required_fields":["timezone"],"flow":{"steps":[{"id":"location","fields":["timezone"],"title":"Your time zone"}],"review":true}}))
        .execute(&ctx.state.db).await.unwrap();
    let mut browser = common::Browser::new(&ctx);
    browser.cookies.insert("sa_session".into(), cookie);
    let flow = common::new_flow(
        &ctx,
        &mut browser,
        "silicon-accounts",
        json!({"interface_id":"potato"}),
    )
    .await;
    assert_eq!(flow["step"], "select_account");
    let selected = browser
        .post(
            &ctx,
            &format!("/v1/flows/{}/select-account", common::id_of(&flow)),
            json!({"account_uuid":work.uuid}),
        )
        .await;
    assert_eq!(selected.status, 200, "{}", selected.json);
    assert_eq!(
        selected.json["flow"]["step"], "details",
        "{}",
        selected.json
    );
    assert_eq!(selected.json["flow"]["details"]["title"], "Your time zone");
}

#[tokio::test]
async fn hosted_google_and_apple_handoff_keep_the_interface_identity_and_pkce_flow() {
    let mock = common::mock_oidc::MockOidc::start().await;
    let mut settings = accounts_core::Settings::for_tests();
    mock.configure(&mut settings);
    let ctx = TestContext::with_settings(settings).await;
    let (account, _, _) = fixture(&ctx, "verified", true).await;
    sqlx::query("update interface_auth_clients set signin_config=$1 where interface_id='potato'")
        .bind(json!({"methods":{"email":true,"google":true,"apple":true,"phone":false}}))
        .execute(&ctx.state.db)
        .await
        .unwrap();
    let mut conn = ctx.conn().await;
    let email = accounts_core::repo::contacts::primary_email(&mut conn, &account.uuid)
        .await
        .unwrap()
        .unwrap()
        .value;
    drop(conn);
    for provider in ["google", "apple"] {
        let mut browser = common::Browser::new(&ctx);
        let flow = common::new_flow(
            &ctx,
            &mut browser,
            "silicon-accounts",
            json!({"interface_id":"potato","method":provider}),
        )
        .await;
        assert_eq!(flow["app"]["name"], "Potato");
        let id = common::id_of(&flow);
        let opened = browser
            .post(&ctx, &format!("/v1/flows/{id}/oauth/{provider}"), json!({}))
            .await;
        assert_eq!(opened.status, 200, "{}", opened.json);
        let url = opened.json["authorize_url"].as_str().unwrap();
        let (provider_code, provider_state) = mock.authorize(
            url,
            json!({"sub":format!("{provider}-existing"),"email":email,"email_verified":true}),
        );
        if provider == "google" {
            let qs = serde_urlencoded::to_string([
                ("code", provider_code.as_str()),
                ("state", provider_state.as_str()),
            ])
            .unwrap();
            let callback = browser
                .call(
                    &ctx,
                    Req::get(&format!("/v1/oauth/callback/google?{qs}"))
                        .header("accept", "text/html"),
                )
                .await;
            assert_eq!(callback.status, 302);
        } else {
            let posted = ctx
                .call(
                    router(),
                    Req::post("/v1/oauth/callback/apple")
                        .header("origin", &mock.base)
                        .header("accept", "text/html")
                        .form(&[("code", &provider_code), ("state", &provider_state)]),
                )
                .await;
            assert_eq!(posted.status, 303);
            let location = posted.headers["location"].to_str().unwrap();
            let path = location
                .strip_prefix(&ctx.state.settings.public_url)
                .unwrap();
            assert_eq!(
                browser
                    .call(&ctx, Req::get(path).header("accept", "text/html"))
                    .await
                    .status,
                302
            );
        }
        let claimed = browser.get(&ctx, &format!("/v1/flows/{id}")).await;
        assert_eq!(claimed.status, 200, "{}", claimed.json);
        assert_eq!(claimed.json["flow"]["step"], "complete");
        assert_eq!(claimed.json["flow"]["signed_in_as"]["uuid"], account.uuid);
        let review=browser.post(&ctx,"/v1/interface-auth/flows",json!({"interface_id":"potato","redirect_uri":"https://potato.example/callback","state":"provider-state","code_challenge":pkce::s256_challenge(VERIFIER),"code_challenge_method":"S256"})).await;
        assert_eq!(review.status, 200, "{}", review.json);
    }
}

#[tokio::test]
async fn expired_verified_bridge_erases_cookies_and_revokes_only_its_internal_session() {
    let ctx = TestContext::new().await;
    let (account, _, _) = fixture(&ctx, "verified", true).await;
    let started=ctx.call(router(),Req::post("/v1/verified-interface-auth/start").bearer(SECRET).json(json!({"interface_id":"potato","interface_origin":"https://potato.example","redirect_uri":"https://potato.example/callback","state":"cleanup-state","code_challenge":pkce::s256_challenge(VERIFIER),"code_challenge_method":"S256"}))).await;
    assert_eq!(started.status, 200, "{}", started.json);
    let capability = started.json["capability"].as_str().unwrap();
    let token = ctx.browser_session(&account).await;
    let id: uuid::Uuid = sqlx::query_scalar("select id from browser_sessions where token_hash=$1")
        .bind(ctx.state.keys.pepper.hash(&token))
        .fetch_one(&ctx.state.db)
        .await
        .unwrap();
    sqlx::query("update verified_interface_auth_flows set browser_session_id=$2,expires_at=now()-interval '1 second' where capability_hash=$1").bind(ctx.state.keys.pepper.hash(capability)).bind(id).execute(&ctx.state.db).await.unwrap();
    accounts_auth::sweep::run_once(&ctx.state.db).await.unwrap();
    let remaining: i64 = sqlx::query_scalar(
        "select count(*) from verified_interface_auth_flows where capability_hash=$1",
    )
    .bind(ctx.state.keys.pepper.hash(capability))
    .fetch_one(&ctx.state.db)
    .await
    .unwrap();
    let revoked: bool =
        sqlx::query_scalar("select revoked_at is not null from browser_sessions where id=$1")
            .bind(id)
            .fetch_one(&ctx.state.db)
            .await
            .unwrap();
    assert_eq!(remaining, 0);
    assert!(revoked);
}

#[tokio::test]
async fn custom_interface_pages_require_request_bound_proof_and_scope_isolation() {
    let ctx = TestContext::new().await;
    let (account, cookie, app) = fixture(&ctx, "unverified", true).await;
    let config = json!({"required_fields":["email"],"optional_fields":["timezone"],"flow":{"steps":[{"id":"contact","fields":["email"],"title":"Contact"},{"id":"location","fields":["timezone"],"title":"Location"}],"review":true},"remember_browser":true});
    sqlx::query("update interface_auth_clients set signin_config=$1 where interface_id='potato'")
        .bind(config)
        .execute(&ctx.state.db)
        .await
        .unwrap();
    let binding = json!({"interface_id":"potato","redirect_uri":"https://potato.example/callback","state":"custom-state","code_challenge":pkce::s256_challenge(VERIFIER)});
    let review_request = || json!({"interface_id":"potato","redirect_uri":"https://potato.example/callback","state":"custom-state","code_challenge":pkce::s256_challenge(VERIFIER),"code_challenge_method":"S256"});
    let missing = ctx
        .call(
            router(),
            Req::post("/v1/interface-auth/flows")
                .session(&ctx.state.settings, &cookie)
                .json(review_request()),
        )
        .await;
    assert_eq!(missing.error_code(), Some("interface_signin_required"));
    let mut browser = common::Browser::new(&ctx);
    browser.cookies.insert("sa_session".into(), cookie);
    let firstparty = common::new_flow(
        &ctx,
        &mut browser,
        "silicon-accounts",
        json!({"interface_id":"potato","interface_request":binding.to_string()}),
    )
    .await;
    let id = common::id_of(&firstparty);
    let contact = browser
        .post(&ctx, &format!("/v1/flows/{id}/continue"), json!({}))
        .await;
    assert_eq!(contact.json["flow"]["step"], "details", "{}", contact.json);
    assert_eq!(contact.json["flow"]["details"]["title"], "Contact");
    let location = browser
        .post(
            &ctx,
            &format!("/v1/flows/{id}/details/continue"),
            json!({"share":[]}),
        )
        .await;
    assert_eq!(location.json["flow"]["details"]["title"], "Location");
    let review = browser
        .post(
            &ctx,
            &format!("/v1/flows/{id}/details/continue"),
            json!({"share":["timezone"]}),
        )
        .await;
    assert_eq!(review.json["flow"]["step"], "review");
    let complete = browser
        .post(
            &ctx,
            &format!("/v1/flows/{id}/review"),
            json!({"approve":true}),
        )
        .await;
    assert_eq!(
        complete.json["flow"]["step"], "complete",
        "{}",
        complete.json
    );
    let proof = code(&json!({"redirect_to":complete.json["flow"]["redirect_to"]}));
    let mut body = review_request();
    body["signin_proof"] = json!(proof);
    let other_browser = ctx.browser_session(&account).await;
    let cross_browser = ctx
        .call(
            router(),
            Req::post("/v1/interface-auth/flows")
                .session(&ctx.state.settings, &other_browser)
                .json(body.clone()),
        )
        .await;
    assert_eq!(cross_browser.error_code(), Some("invalid_signin_proof"));
    let other_account = ctx.carbon().await;
    let other_cookie = ctx.browser_session(&other_account).await;
    let cross_account = ctx
        .call(
            router(),
            Req::post("/v1/interface-auth/flows")
                .session(&ctx.state.settings, &other_cookie)
                .json(body.clone()),
        )
        .await;
    assert_eq!(cross_account.error_code(), Some("invalid_signin_proof"));
    sqlx::query("update interface_auth_clients set revision=2 where interface_id='potato'")
        .execute(&ctx.state.db)
        .await
        .unwrap();
    let changed = browser
        .post(&ctx, "/v1/interface-auth/flows", body.clone())
        .await;
    assert_eq!(changed.error_code(), Some("invalid_signin_proof"));
    sqlx::query("update interface_auth_clients set revision=1 where interface_id='potato'")
        .execute(&ctx.state.db)
        .await
        .unwrap();
    let mut altered = body.clone();
    altered["state"] = json!("attacker-state");
    let refused = browser
        .post(&ctx, "/v1/interface-auth/flows", altered)
        .await;
    assert_eq!(refused.error_code(), Some("invalid_signin_proof"));
    let started = browser
        .post(&ctx, "/v1/interface-auth/flows", body.clone())
        .await;
    assert_eq!(started.status, 200, "{}", started.json);
    assert_eq!(
        browser
            .post(&ctx, "/v1/interface-auth/flows", body)
            .await
            .json["flow_id"],
        started.json["flow_id"]
    );
    let approved = browser
        .post(
            &ctx,
            &format!(
                "/v1/interface-auth/flows/{}/decision",
                started.json["flow_id"].as_str().unwrap()
            ),
            json!({"approve":true}),
        )
        .await;
    let issued = ctx
        .call(router(), exchange(&code(&approved.json), "custom-flow"))
        .await;
    assert_eq!(issued.status, 200, "{}", issued.json);
    assert_eq!(issued.json["account"]["uuid"], account.uuid);
    assert!(issued.json["account"]["email"].is_string());
    assert!(issued.json["account"]["timezone"].is_string());
    assert!(
        !issued.json["apps"][&app]["scope"]
            .as_str()
            .unwrap()
            .contains("email")
    );
    assert!(
        !issued.json["apps"][&app]["scope"]
            .as_str()
            .unwrap()
            .contains("timezone")
    );
    let refresh_token = issued.json["refresh_token"].as_str().unwrap();
    sqlx::query("update account_emails set verified_at=null where account_uuid=$1 and is_primary")
        .bind(&account.uuid)
        .execute(&ctx.state.db)
        .await
        .unwrap();
    assert_eq!(
        ctx.call(router(), inspect(refresh_token)).await.json["active"],
        false
    );
    sqlx::query("update account_emails set verified_at=now() where account_uuid=$1 and is_primary")
        .bind(&account.uuid)
        .execute(&ctx.state.db)
        .await
        .unwrap();
    sqlx::query("update interface_auth_clients set signin_config=signin_config||$1::jsonb where interface_id='potato'").bind(json!({"allowed_email_domains":["changed.example"]})).execute(&ctx.state.db).await.unwrap();
    assert_eq!(
        ctx.call(router(), inspect(refresh_token)).await.json["active"],
        false
    );
    assert_ne!(
        ctx.call(router(), refresh(refresh_token, "custom-changed"))
            .await
            .status,
        200
    );
}

#[tokio::test]
async fn trusted_custom_pages_share_only_approved_details_then_skip_app_consent() {
    let ctx = TestContext::new().await;
    let (account, _, app) = fixture(&ctx, "trusted", true).await;
    sqlx::query("update interface_auth_clients set signin_config=$1 where interface_id='potato'")
        .bind(json!({"required_fields":["email"],"optional_fields":["timezone"]}))
        .execute(&ctx.state.db)
        .await
        .unwrap();
    let start = json!({"interface_id":"potato","interface_origin":"https://potato.example","redirect_uri":"https://potato.example/callback","state":"trusted-custom","code_challenge":pkce::s256_challenge(VERIFIER),"code_challenge_method":"S256"});
    let created = ctx
        .call(
            router(),
            Req::post("/v1/verified-interface-auth/start")
                .bearer(SECRET)
                .json(start),
        )
        .await;
    assert_eq!(created.status, 200, "{}", created.json);
    let capability = created.json["capability"].as_str().unwrap();
    let action = |name: &str, payload: Value| {
        Req::post("/v1/verified-interface-auth/action").bearer(SECRET).json(json!({"interface_id":"potato","interface_origin":"https://potato.example","capability":capability,"action":name,"payload":payload}))
    };
    let mut conn = ctx.conn().await;
    let email = accounts_core::repo::contacts::primary_email(&mut conn, &account.uuid)
        .await
        .unwrap()
        .unwrap()
        .value;
    drop(conn);
    assert_eq!(
        ctx.call(router(), action("email", json!({"email":email})))
            .await
            .status,
        200
    );
    let otp = accounts_core::delivery::extract_code(&ctx.outbox(&email).await.first().unwrap().1)
        .unwrap();
    let verified = ctx
        .call(router(), action("verify", json!({"code":otp})))
        .await;
    assert_eq!(
        verified.json["flow"]["step"], "details",
        "{}",
        verified.json
    );
    let done = ctx
        .call(
            router(),
            action("details_continue", json!({"share":["timezone"]})),
        )
        .await;
    assert_eq!(done.json["flow"]["step"], "complete", "{}", done.json);
    let review = ctx.call(router(), action("review", json!({}))).await;
    assert_eq!(review.status, 200, "{}", review.json);
    assert_eq!(review.json["review"]["consent_required"], false);
    let decision = ctx
        .call(router(), action("decision", json!({"approve":true})))
        .await;
    let issued = ctx
        .call(router(), exchange(&code(&decision.json), "trusted-custom"))
        .await;
    assert_eq!(issued.status, 200, "{}", issued.json);
    assert!(issued.json["account"]["email"].is_string());
    assert!(issued.json["account"]["timezone"].is_string());
    assert!(
        !issued.json["apps"][&app]["scope"]
            .as_str()
            .unwrap()
            .contains("email")
    );
}

#[tokio::test]
async fn verified_bridge_rejects_a_changed_interface_revision() {
    let ctx = TestContext::new().await;
    let (_, _, _) = fixture(&ctx, "verified", true).await;
    let created=ctx.call(router(),Req::post("/v1/verified-interface-auth/start").bearer(SECRET).json(json!({"interface_id":"potato","interface_origin":"https://potato.example","redirect_uri":"https://potato.example/callback","state":"state","code_challenge":pkce::s256_challenge(VERIFIER),"code_challenge_method":"S256"}))).await;
    let capability = created.json["capability"].as_str().unwrap();
    sqlx::query("update interface_auth_clients set revision=2 where interface_id='potato'")
        .execute(&ctx.state.db)
        .await
        .unwrap();
    let result=ctx.call(router(),Req::post("/v1/verified-interface-auth/action").bearer(SECRET).json(json!({"interface_id":"potato","interface_origin":"https://potato.example","capability":capability,"action":"get","payload":{}}))).await;
    assert_eq!(result.error_code(), Some("invalid_capability"));
}

#[tokio::test]
async fn interface_signup_domain_and_remember_policies_apply_to_existing_and_contact_flows() {
    let ctx = TestContext::new().await;
    let (_, cookie, _) = fixture(&ctx, "unverified", true).await;
    sqlx::query("update interface_auth_clients set signin_config=$1 where interface_id='potato'")
        .bind(json!({"methods":{"email":true,"phone":true,"google":false,"apple":false},"allowed_email_domains":["allowed.test"],"allow_signup":false,"remember_browser":false})).execute(&ctx.state.db).await.unwrap();
    let mut b = common::Browser::new(&ctx);
    b.cookies.insert("sa_session".into(), cookie);
    let flow = common::new_flow(
        &ctx,
        &mut b,
        "silicon-accounts",
        json!({"interface_id":"potato"}),
    )
    .await;
    let id = common::id_of(&flow);
    let continued = b
        .post(&ctx, &format!("/v1/flows/{id}/continue"), json!({}))
        .await;
    assert_eq!(continued.error_code(), Some("continue_not_allowed"));
    let invalid = b
        .post(
            &ctx,
            &format!("/v1/flows/{id}/email"),
            json!({"email":"new@outside.test"}),
        )
        .await;
    assert_eq!(invalid.error_code(), Some("email_domain_not_allowed"));
    let sent = b
        .post(
            &ctx,
            &format!("/v1/flows/{id}/email"),
            json!({"email":"new@allowed.test"}),
        )
        .await;
    assert_eq!(sent.status, 200, "{}", sent.json);
    let otp = common::last_code(&ctx, "new@allowed.test").await;
    let denied = b
        .post(&ctx, &format!("/v1/flows/{id}/verify"), json!({"code":otp}))
        .await;
    assert_eq!(
        denied.error_code(),
        Some("signup_not_allowed"),
        "{}",
        denied.json
    );
    sqlx::query("update interface_auth_clients set signin_config=signin_config||$1::jsonb where interface_id='potato'").bind(json!({"allow_signup":true})).execute(&ctx.state.db).await.unwrap();
    let mut b = common::Browser::new(&ctx);
    let flow = common::new_flow(
        &ctx,
        &mut b,
        "silicon-accounts",
        json!({"interface_id":"potato"}),
    )
    .await;
    let id = common::id_of(&flow);
    let sent = b
        .post(
            &ctx,
            &format!("/v1/flows/{id}/phone"),
            json!({"phone":"+14155550140"}),
        )
        .await;
    assert_eq!(sent.status, 200, "{}", sent.json);
    let otp = common::last_code(&ctx, "+14155550140").await;
    let denied = b
        .post(&ctx, &format!("/v1/flows/{id}/verify"), json!({"code":otp}))
        .await;
    assert_eq!(
        denied.error_code(),
        Some("email_domain_not_allowed"),
        "{}",
        denied.json
    );
}

#[tokio::test]
async fn interface_managed_providers_respect_domain_and_signup_restrictions() {
    let mock = common::mock_oidc::MockOidc::start().await;
    let mut settings = accounts_core::Settings::for_tests();
    mock.configure(&mut settings);
    let ctx = TestContext::with_settings(settings).await;
    let (_, _, _) = fixture(&ctx, "verified", true).await;
    sqlx::query("update interface_auth_clients set signin_config=$1 where interface_id='potato'")
        .bind(json!({"methods":{"email":true,"phone":false,"google":true,"apple":true},"allowed_email_domains":["allowed.test"],"allow_signup":false})).execute(&ctx.state.db).await.unwrap();
    for (provider, email, expected) in [
        ("google", "new@allowed.test", "signup_not_allowed"),
        ("apple", "new@outside.test", "email_domain_not_allowed"),
    ] {
        let mut browser = common::Browser::new(&ctx);
        let flow = common::new_flow(
            &ctx,
            &mut browser,
            "silicon-accounts",
            json!({"interface_id":"potato","method":provider}),
        )
        .await;
        let id = common::id_of(&flow);
        let opened = browser
            .post(&ctx, &format!("/v1/flows/{id}/oauth/{provider}"), json!({}))
            .await;
        let (provider_code, provider_state) = mock.authorize(
            opened.json["authorize_url"].as_str().unwrap(),
            json!({"sub":format!("restricted-{provider}"),"email":email,"email_verified":true}),
        );
        if provider == "google" {
            let qs = serde_urlencoded::to_string([
                ("code", provider_code.as_str()),
                ("state", provider_state.as_str()),
            ])
            .unwrap();
            assert_eq!(
                browser
                    .call(
                        &ctx,
                        Req::get(&format!("/v1/oauth/callback/google?{qs}"))
                            .header("accept", "text/html")
                    )
                    .await
                    .status,
                302
            );
        } else {
            let posted = ctx
                .call(
                    router(),
                    Req::post("/v1/oauth/callback/apple")
                        .header("origin", &mock.base)
                        .header("accept", "text/html")
                        .form(&[("code", &provider_code), ("state", &provider_state)]),
                )
                .await;
            let path = posted.headers["location"]
                .to_str()
                .unwrap()
                .strip_prefix(&ctx.state.settings.public_url)
                .unwrap();
            assert_eq!(
                browser
                    .call(&ctx, Req::get(path).header("accept", "text/html"))
                    .await
                    .status,
                302
            );
        }
        let outcome = browser.get(&ctx, &format!("/v1/flows/{id}")).await;
        assert_eq!(
            outcome.json["flow"]["error"]["code"], expected,
            "{}",
            outcome.json
        );
    }
}

#[tokio::test]
async fn trusted_interface_can_add_unlisted_app_without_extra_consent() {
    let ctx = TestContext::new().await;
    let (account, cookie, app) = fixture(&ctx, "trusted", true).await;
    sqlx::query("update interface_auth_clients set app_ids='{}' where interface_id='potato'")
        .execute(&ctx.state.db)
        .await
        .unwrap();
    let flow = begin(&ctx, &cookie).await;
    assert_eq!(flow["consent_required"], false);
    assert!(flow["apps"].as_array().unwrap().is_empty());
    let approved = decide(&ctx, &cookie, flow["flow_id"].as_str().unwrap(), true).await;
    let issued = ctx
        .call(router(), exchange(&code(&approved), "trusted-empty"))
        .await;
    assert_eq!(issued.status, 200, "{}", issued.json);
    let token = issued.json["refresh_token"].as_str().unwrap();
    let added=ctx.call(router(),Req::post("/v1/interface-auth/token").header("idempotency-key","trusted-add").json(json!({"interface_id":"potato","grant_type":"refresh_token","refresh_token":token,"app_id":app}))).await;
    assert_eq!(added.status, 200, "{}", added.json);
    assert_eq!(added.json["account"]["uuid"], account.uuid);
    assert!(added.json["apps"][&app]["access_token"].is_string());
}

#[tokio::test]
async fn trusted_interface_cannot_add_an_app_management_app() {
    let ctx = TestContext::new().await;
    let (_, cookie, _) = fixture(&ctx, "trusted", true).await;
    sqlx::query("update interface_auth_clients set app_ids='{}' where interface_id='potato'")
        .execute(&ctx.state.db)
        .await
        .unwrap();
    let flow = begin(&ctx, &cookie).await;
    let approved = decide(&ctx, &cookie, flow["flow_id"].as_str().unwrap(), true).await;
    let issued = ctx
        .call(router(), exchange(&code(&approved), "trusted-privileged"))
        .await;
    assert_eq!(issued.status, 200, "{}", issued.json);
    let token = issued.json["refresh_token"].as_str().unwrap();
    // Silicon Apps tokens act as the owner on /v1/apps/*: as dangerous as Developer's.
    for app in ["silicon-apps", "developer", "silicon-accounts", "accounts"] {
        let added = ctx
            .call(
                router(),
                Req::post("/v1/interface-auth/token")
                    .header("idempotency-key", &format!("trusted-add-{app}"))
                    .json(json!({"interface_id":"potato","grant_type":"refresh_token","refresh_token":token,"app_id":app})),
            )
            .await;
        assert_eq!(added.status, 403, "{app}: {}", added.json);
        assert_eq!(added.json["error"]["code"], "first_party_delegation_forbidden", "{app}");
    }
    // A stored row naming Silicon Apps (written around the registry's check) is refused too.
    sqlx::query("update interface_auth_clients set app_ids='{silicon-apps}' where interface_id='potato'")
        .execute(&ctx.state.db)
        .await
        .unwrap();
    let started = ctx.call(router(),Req::post("/v1/interface-auth/flows").session(&ctx.state.settings,&cookie).json(json!({"interface_id":"potato","redirect_uri":"https://potato.example/callback","state":"privileged","code_challenge":pkce::s256_challenge(VERIFIER),"code_challenge_method":"S256"}))).await;
    assert_eq!(started.status, 403, "{}", started.json);
    assert_eq!(started.json["error"]["code"], "first_party_delegation_forbidden");
}

#[tokio::test]
async fn declining_interface_details_cannot_be_bypassed_by_verified_backend() {
    let ctx = TestContext::new().await;
    let (account, _, _) = fixture(&ctx, "verified", true).await;
    sqlx::query("update interface_auth_clients set signin_config=$1 where interface_id='potato'").bind(json!({"required_fields":["email"],"flow":{"steps":[{"id":"contact","fields":["email"]}],"review":true}})).execute(&ctx.state.db).await.unwrap();
    let started=ctx.call(router(),Req::post("/v1/verified-interface-auth/start").bearer(SECRET).json(json!({"interface_id":"potato","interface_origin":"https://potato.example","redirect_uri":"https://potato.example/callback","state":"denied","code_challenge":pkce::s256_challenge(VERIFIER),"code_challenge_method":"S256"}))).await;
    let capability = started.json["capability"].as_str().unwrap();
    let action = |name: &str, payload: Value| {
        Req::post("/v1/verified-interface-auth/action").bearer(SECRET).json(json!({"interface_id":"potato","interface_origin":"https://potato.example","capability":capability,"action":name,"payload":payload}))
    };
    let mut conn = ctx.conn().await;
    let email = accounts_core::repo::contacts::primary_email(&mut conn, &account.uuid)
        .await
        .unwrap()
        .unwrap()
        .value;
    drop(conn);
    assert_eq!(
        ctx.call(router(), action("email", json!({"email":email})))
            .await
            .status,
        200
    );
    let otp = accounts_core::delivery::extract_code(&ctx.outbox(&email).await.first().unwrap().1)
        .unwrap();
    assert_eq!(
        ctx.call(router(), action("verify", json!({"code":otp})))
            .await
            .json["flow"]["step"],
        "details"
    );
    assert_eq!(
        ctx.call(router(), action("details_continue", json!({"share":[]})))
            .await
            .json["flow"]["step"],
        "review"
    );
    let denied = ctx
        .call(router(), action("signin_review", json!({"approve":false})))
        .await;
    assert_eq!(denied.json["flow"]["outcome"], "denied");
    let review = ctx.call(router(), action("review", json!({}))).await;
    assert_eq!(review.error_code(), Some("identity_not_verified"));
}

#[tokio::test]
async fn a_refresh_does_not_rewrite_receipts_already_unavailable() {
    let ctx = TestContext::new().await;
    let (_, cookie, _) = fixture(&ctx, "verified", true).await;
    let flow = begin(&ctx, &cookie).await;
    let code = code(&decide(&ctx, &cookie, flow["flow_id"].as_str().unwrap(), true).await);
    let issued = ctx.call(router(), exchange(&code, "first")).await;
    let second = ctx
        .call(
            router(),
            refresh(issued.json["refresh_token"].as_str().unwrap(), "second"),
        )
        .await;
    let version = "select xmin::text from interface_token_operations where key='first'";
    let before: String = sqlx::query_scalar(version)
        .fetch_one(&ctx.state.db)
        .await
        .unwrap();
    let third = ctx
        .call(
            router(),
            refresh(second.json["refresh_token"].as_str().unwrap(), "third"),
        )
        .await;
    assert_eq!(third.status, 200, "{}", third.json);
    let after: String = sqlx::query_scalar(version)
        .fetch_one(&ctx.state.db)
        .await
        .unwrap();
    assert_eq!(before, after, "an unavailable receipt is left as it is");
}
