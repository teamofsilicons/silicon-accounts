//! `GET /v1/me/history`.

use std::collections::HashSet;

use accounts_core::models::{Account, ActorKind, Scope};
use accounts_core::repo::audit::{self, AuditEntry, SigninRecord};
use accounts_core::repo::memberships;
use accounts_core::test_support::{Req, TestContext, rand_suffix};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::common::*;

fn items(page: &Value) -> Vec<Value> {
    page["items"].as_array().cloned().expect("items")
}

fn find<'a>(items: &'a [Value], kind: &str, title_part: &str) -> &'a Value {
    items
        .iter()
        .find(|i| i["kind"] == kind && i["title"].as_str().is_some_and(|t| t.contains(title_part)))
        .unwrap_or_else(|| panic!("no {kind} item containing '{title_part}' in {items:#?}"))
}

#[tokio::test]
async fn one_timeline_over_every_source() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let (silicon, _) = ctx.silicon(&carbon.uuid).await;
    let app = member_app(&ctx, "briefcase", &carbon, &[Scope::Profile]).await;
    let leaving = member_app(&ctx, "leaving", &carbon, &[Scope::Profile]).await;
    let mut conn = ctx.conn().await;
    audit::signin(
        &mut conn,
        &SigninRecord {
            account_uuid: Some(&carbon.uuid),
            app_id: Some(&app),
            method: audit::method::GOOGLE,
            outcome: audit::outcome::SUCCESS,
            ip: Some("203.0.113.9"),
            user_agent: Some("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"),
        },
    )
    .await
    .expect("signin");
    audit::signin(
        &mut conn,
        &SigninRecord {
            account_uuid: Some(&carbon.uuid),
            app_id: None,
            method: audit::method::EMAIL,
            outcome: audit::outcome::FAILED,
            ip: None,
            user_agent: None,
        },
    )
    .await
    .expect("failed signin");
    drop(conn);
    sqlx::query(
        "insert into custodian_history (silicon_uuid, from_uuid, to_uuid, kind) values ($1, null, $2, 'created_by_custodian')",
    )
    .bind(&silicon.uuid)
    .bind(&carbon.uuid)
    .execute(&ctx.state.db)
    .await
    .expect("custodian history");
    let proof = Uuid::now_v7();
    sqlx::query(
        "insert into proof_families (id, kind, issuing_app, audiences, account_uuid, scopes, access_ttl_seconds, expires_at, \
           revoked_at, revoked_by, revoke_reason) \
         values ($1, 'obo', $2, $3, $4, '{files.write}', 600, now() + interval '900 days', now() + interval '1 millisecond', $4, 'revoked_by_account')",
    )
    .bind(proof)
    .bind(&app)
    .bind(vec![leaving.clone()])
    .bind(&carbon.uuid)
    .execute(&ctx.state.db)
    .await
    .expect("proof");
    let tok = token(&ctx, &carbon).await;
    let new_id = format!("renamed-{}", rand_suffix());
    assert_status(
        &call(
            &ctx,
            Req::post("/v1/me/id")
                .bearer(&tok)
                .json(json!({ "id": new_id })),
        )
        .await,
        200,
    );
    assert_status(
        &call(
            &ctx,
            Req::patch("/v1/me")
                .bearer(&tok)
                .json(json!({ "display_name": "New Name" })),
        )
        .await,
        200,
    );
    assert_status(
        &call(
            &ctx,
            Req::delete(&format!("/v1/me/apps/{leaving}")).bearer(&tok),
        )
        .await,
        204,
    );

    let r = call(&ctx, Req::get("/v1/me/history").bearer(&tok)).await;
    assert_status(&r, 200);
    let all = items(&r.json);
    let kinds: HashSet<&str> = all.iter().filter_map(|i| i["kind"].as_str()).collect();
    for k in [
        "signin",
        "id_change",
        "custodian",
        "proof",
        "app_access",
        "security",
    ] {
        assert!(kinds.contains(k), "{k} missing: {all:#?}");
    }
    let ids: HashSet<&str> = all.iter().filter_map(|i| i["id"].as_str()).collect();
    assert_eq!(ids.len(), all.len(), "ids are unique");
    let times: Vec<&str> = all.iter().filter_map(|i| i["at"].as_str()).collect();
    let mut sorted = times.clone();
    sorted.sort_by(|a, b| b.cmp(a));
    assert_eq!(times, sorted, "newest first");

    let s = find(&all, "signin", "Signed in to");
    assert!(
        s["title"]
            .as_str()
            .is_some_and(|t| t.ends_with("with Google"))
    );
    assert_eq!(s["detail"], "from 203.0.113.9 · Safari on macOS");
    assert_eq!(s["app"]["app_id"], app);
    assert_eq!(s["meta"]["method"], "google");
    find(&all, "signin", "Failed sign-in with an email code");
    find(&all, "id_change", "Account created with the id");
    let changed = find(&all, "id_change", "Id changed from");
    assert_eq!(changed["meta"]["new_id"], format!("c:{new_id}"));
    let custody = find(&all, "custodian", "Created the Silicon");
    assert_eq!(custody["meta"]["silicon"]["uuid"], silicon.uuid);
    let issued = find(&all, "proof", "got a proof to act for you at");
    assert_eq!(issued["meta"]["event"], "issued");
    assert_eq!(issued["meta"]["scopes"], json!(["files.write"]));
    let revoked = find(&all, "proof", "revoked");
    assert_eq!(revoked["detail"], "Revoked by you");
    find(&all, "app_access", "Started using");
    let removal = find(&all, "app_access", "access");
    assert_eq!(removal["app"]["app_id"], leaving);
    let profile = find(&all, "security", "Profile updated");
    assert_eq!(profile["detail"], "Changed: display name");
    // The id change is shown once (from handle_history), not again from the audit log.
    assert!(
        !all.iter()
            .any(|i| i["meta"]["action"] == "account.id.changed"),
        "duplicate id change"
    );
}

#[tokio::test]
async fn filter_by_kind_and_page_through() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    for i in 0..7 {
        sqlx::query(
            "insert into signin_history (account_uuid, method, outcome, at) values ($1, 'email', 'success', now() - make_interval(mins => $2))",
        )
        .bind(&carbon.uuid)
        .bind(i)
        .execute(&ctx.state.db)
        .await
        .expect("signin row");
    }
    // Two rows at the very same instant still page deterministically.
    ctx.exec(&format!(
        "update signin_history set at = (select min(at) from signin_history where account_uuid = '{0}') \
         where account_uuid = '{0}' and id = (select max(id) from signin_history where account_uuid = '{0}')",
        carbon.uuid
    ))
    .await;
    let tok = token(&ctx, &carbon).await;

    let mut seen = Vec::new();
    let mut pages = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let path = match &cursor {
            Some(c) => format!("/v1/me/history?kind=signin&limit=3&cursor={c}"),
            None => "/v1/me/history?kind=signin&limit=3".to_string(),
        };
        let r = call(&ctx, Req::get(&path).bearer(&tok)).await;
        assert_status(&r, 200);
        let page = items(&r.json);
        assert!(page.iter().all(|i| i["kind"] == "signin"));
        pages.push(page.len());
        seen.extend(
            page.iter()
                .filter_map(|i| i["id"].as_str().map(str::to_string)),
        );
        match r.json["next_cursor"].as_str() {
            Some(c) => cursor = Some(c.to_string()),
            None => break,
        }
        assert!(pages.len() < 10, "pagination must end");
    }
    assert_eq!(pages, vec![3, 3, 1]);
    let unique: HashSet<&String> = seen.iter().collect();
    assert_eq!(unique.len(), 7);

    let r = call(&ctx, Req::get("/v1/me/history?kind=id_change").bearer(&tok)).await;
    assert_eq!(items(&r.json).len(), 1);
    let r = call(&ctx, Req::get("/v1/me/history?kind=proof").bearer(&tok)).await;
    assert_eq!(items(&r.json).len(), 0);
    let r = call(&ctx, Req::get("/v1/me/history?kind=logins").bearer(&tok)).await;
    assert_error(&r, 400, "invalid_history_kind");
    let r = call(
        &ctx,
        Req::get("/v1/me/history?cursor=not-a-cursor").bearer(&tok),
    )
    .await;
    assert_error(&r, 400, "invalid_cursor");
    let r = call(&ctx, Req::get("/v1/me/history")).await;
    assert_error(&r, 401, "unauthenticated");
}

#[tokio::test]
async fn custodian_changes_from_each_side() {
    let ctx = TestContext::new().await;
    let first = ctx.carbon().await;
    let second = ctx.carbon().await;
    let (silicon, _) = ctx.silicon(&first.uuid).await;
    sqlx::query(
        "insert into custodian_history (silicon_uuid, from_uuid, to_uuid, kind, at) values \
         ($1, null, $2, 'created_by_custodian', now() - interval '2 hours'), \
         ($1, $2, $3, 'transfer', now() - interval '1 hour')",
    )
    .bind(&silicon.uuid)
    .bind(&first.uuid)
    .bind(&second.uuid)
    .execute(&ctx.state.db)
    .await
    .expect("custodian history");
    let mut conn = ctx.conn().await;
    for (action, actor) in [
        ("silicon.transfer.requested", &first.uuid),
        ("silicon.transfer.accepted", &second.uuid),
        ("silicon.stk.rotated", &first.uuid),
    ] {
        audit::record(
            &mut conn,
            &AuditEntry {
                account_uuid: Some(&silicon.uuid),
                target_kind: Some("account"),
                target_id: Some(&silicon.uuid),
                ..AuditEntry::new(ActorKind::Account, Some(actor), action)
            },
        )
        .await
        .expect("audit");
    }
    memberships::upsert_imported(
        &mut conn,
        &ctx.app("crm").await.0.app_id,
        &silicon.uuid,
        None,
        None,
        false,
    )
    .await
    .ok();
    drop(conn);
    let first_id = first.handle.clone().expect("id");
    let second_id = second.handle.clone().expect("id");
    let silicon_id = silicon.handle.clone().expect("id");

    let r = call(
        &ctx,
        Req::get("/v1/me/history?kind=custodian").bearer(&token(&ctx, &silicon).await),
    )
    .await;
    let mine = items(&r.json);
    find(
        &mine,
        "custodian",
        &format!("{first_id} created this Silicon"),
    );
    find(
        &mine,
        "custodian",
        &format!("Custodian changed from {first_id} to {second_id}"),
    );
    let requested = find(
        &mine,
        "custodian",
        &format!("Transfer of {silicon_id} requested"),
    );
    assert_eq!(requested["detail"], format!("By {first_id}"));
    assert_eq!(requested["meta"]["silicon"]["uuid"], silicon.uuid.as_str());
    assert_eq!(requested["meta"]["silicon"]["id"], silicon_id.as_str());
    assert_eq!(
        mine.len(),
        3,
        "the accepted transfer isn't shown twice: {mine:#?}"
    );
    let r = call(
        &ctx,
        Req::get("/v1/me/history?kind=security").bearer(&token(&ctx, &silicon).await),
    )
    .await;
    let security = items(&r.json);
    assert_eq!(security.len(), 1, "{security:#?}");
    assert_eq!(
        security[0]["title"],
        format!("STK of {silicon_id} rotated"),
        "entries about a Silicon name it"
    );
    assert_eq!(security[0]["meta"]["silicon"]["kind"], "silicon");

    let r = call(
        &ctx,
        Req::get("/v1/me/history?kind=custodian").bearer(&token(&ctx, &first).await),
    )
    .await;
    let theirs = items(&r.json);
    find(
        &theirs,
        "custodian",
        &format!("Created the Silicon {silicon_id}"),
    );
    find(
        &theirs,
        "custodian",
        &format!("Transferred {silicon_id} to {second_id}"),
    );
    let r = call(
        &ctx,
        Req::get("/v1/me/history?kind=custodian").bearer(&token(&ctx, &second).await),
    )
    .await;
    let new_custodian = items(&r.json);
    assert_eq!(new_custodian.len(), 1);
    find(
        &new_custodian,
        "custodian",
        &format!("Became the custodian of {silicon_id} (transferred from {first_id})"),
    );
    let r = call(
        &ctx,
        Req::get("/v1/me/history?kind=app_access").bearer(&token(&ctx, &silicon).await),
    )
    .await;
    find(&items(&r.json), "app_access", "imported your account");
}

#[tokio::test]
async fn entries_written_by_someone_else_hide_their_ip_and_contacts() {
    let ctx = TestContext::new().await;
    let custodian = ctx.carbon().await;
    let recipient = ctx.carbon().await;
    let (silicon, _) = ctx.silicon(&custodian.uuid).await;
    // What the silicons crate writes when a custodian starts a transfer: one entry in the
    // history of the Silicon, the custodian and the recipient, with the custodian's IP.
    let mut conn = ctx.conn().await;
    for account in [&silicon.uuid, &custodian.uuid, &recipient.uuid] {
        audit::record(
            &mut conn,
            &AuditEntry {
                target_kind: Some("silicon"),
                target_id: Some(&silicon.uuid),
                account_uuid: Some(account),
                details: json!({"request_id": "0199aaaa-0000-7000-8000-000000000000", "to": "Next.Owner@Example.test"}),
                ip: Some("203.0.113.77"),
                ..AuditEntry::new(ActorKind::Account, Some(&custodian.uuid), "silicon.transfer.requested")
            },
        )
        .await
        .expect("audit");
    }
    drop(conn);
    let entry = |account: Account| {
        let ctx = &ctx;
        async move {
            let r = call(
                ctx,
                Req::get("/v1/me/history?kind=custodian").bearer(&token(ctx, &account).await),
            )
            .await;
            assert_status(&r, 200);
            items(&r.json)
                .into_iter()
                .find(|i| i["meta"]["action"] == "silicon.transfer.requested")
                .unwrap_or_else(|| panic!("no transfer entry in {}", r.json))
        }
    };

    for viewer in [recipient.clone(), silicon.clone()] {
        let seen = entry(viewer).await;
        assert_eq!(seen["meta"]["ip"], Value::Null, "{seen}");
        assert_eq!(seen["meta"]["details"]["to"], "n***@example.test");
        assert_eq!(
            seen["meta"]["details"]["request_id"],
            "0199aaaa-0000-7000-8000-000000000000"
        );
        assert_eq!(seen["meta"]["actor_id"], custodian.uuid);
        assert_eq!(
            seen["detail"],
            format!("By {}", custodian.handle.clone().expect("id"))
        );
        // The title names the Silicon and shows the recipient's address only masked.
        assert_eq!(
            seen["title"],
            format!(
                "Transfer of {} to n***@example.test requested",
                silicon.handle.clone().expect("si:id")
            )
        );
        assert_eq!(seen["meta"]["silicon"]["uuid"], silicon.uuid.as_str());
    }
    // The custodian sees its own entry in full.
    let own = entry(custodian.clone()).await;
    assert_eq!(own["meta"]["ip"], "203.0.113.77");
    assert_eq!(own["meta"]["details"]["to"], "Next.Owner@Example.test");
    assert_eq!(
        own["title"],
        format!(
            "Transfer of {} to Next.Owner@Example.test requested",
            silicon.handle.clone().expect("si:id")
        )
    );
}

#[tokio::test]
async fn entries_about_a_silicon_name_it() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let (silicon, _) = ctx.silicon(&carbon.uuid).await;
    let silicon_id = silicon.handle.clone().expect("si:id");
    let mut conn = ctx.conn().await;
    for (action, actor, details) in [
        // A self-created Silicon names this Carbon as its custodian.
        (
            "silicon.custodian.requested",
            &silicon.uuid,
            json!({"kind": "initial"}),
        ),
        (
            "silicon.webhook.set",
            &carbon.uuid,
            json!({"url_origin": "https://hooks.example.test", "by": "custodian"}),
        ),
        (
            "silicon.profile.updated",
            &carbon.uuid,
            json!({"changed": ["display_name", "pfp_url"]}),
        ),
    ] {
        audit::record(
            &mut conn,
            &AuditEntry {
                account_uuid: Some(&carbon.uuid),
                target_kind: Some("silicon"),
                target_id: Some(&silicon.uuid),
                details,
                ..AuditEntry::new(ActorKind::Account, Some(actor), action)
            },
        )
        .await
        .expect("audit");
    }
    drop(conn);
    let r = call(
        &ctx,
        Req::get("/v1/me/history").bearer(&token(&ctx, &carbon).await),
    )
    .await;
    assert_status(&r, 200);
    let all = items(&r.json);
    let by_action = |a: &str| {
        all.iter()
            .find(|i| i["meta"]["action"] == a)
            .unwrap_or_else(|| panic!("no {a} in {all:#?}"))
            .clone()
    };
    let asked = by_action("silicon.custodian.requested");
    assert_eq!(
        asked["title"],
        format!("{silicon_id} asked you to be its custodian")
    );
    assert_eq!(
        asked["detail"],
        Value::Null,
        "the title already names the actor"
    );
    assert_eq!(asked["meta"]["silicon"]["uuid"], silicon.uuid.as_str());
    let hook = by_action("silicon.webhook.set");
    assert_eq!(hook["title"], format!("Webhook of {silicon_id} set"));
    assert_eq!(hook["detail"], "Events go to https://hooks.example.test");
    let profile = by_action("silicon.profile.updated");
    assert_eq!(profile["title"], format!("Profile of {silicon_id} updated"));
    assert_eq!(profile["detail"], "Changed: display name, photo");
    assert_eq!(profile["meta"]["silicon"]["id"], silicon_id.as_str());
}

/// The CLI and the Rust package sign in too: their sign-ins name them, never "A browser" (the
/// CLI's user agent is `accounts-cli/<v> silicon-accounts-client/<v>`).
#[tokio::test]
async fn sign_ins_name_the_cli_and_the_package_not_a_browser() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let mut conn = ctx.conn().await;
    for (method, user_agent) in [
        (
            audit::method::EMAIL,
            "accounts-cli/0.1.0 silicon-accounts-client/0.1.0",
        ),
        (audit::method::SLT, "silicon-accounts-client/0.1.0"),
        (
            audit::method::DEVICE,
            "scout/1.4 silicon-accounts-client/0.1.0",
        ),
        (audit::method::PHONE, "curl/8.4.0"),
    ] {
        audit::signin(
            &mut conn,
            &SigninRecord {
                account_uuid: Some(&carbon.uuid),
                app_id: None,
                method,
                outcome: audit::outcome::SUCCESS,
                ip: Some("127.0.0.1"),
                user_agent: Some(user_agent),
            },
        )
        .await
        .expect("signin");
    }
    drop(conn);
    let r = call(
        &ctx,
        Req::get("/v1/me/history?kind=signin").bearer(&token(&ctx, &carbon).await),
    )
    .await;
    assert_status(&r, 200);
    let signins = items(&r.json);
    let detail_for = |user_agent: &str| {
        signins
            .iter()
            .find(|i| i["meta"]["user_agent"] == user_agent)
            .unwrap_or_else(|| panic!("no sign-in from {user_agent} in {signins:#?}"))["detail"]
            .clone()
    };
    assert_eq!(
        detail_for("accounts-cli/0.1.0 silicon-accounts-client/0.1.0"),
        "from 127.0.0.1 · accounts CLI 0.1.0"
    );
    assert_eq!(
        detail_for("silicon-accounts-client/0.1.0"),
        "from 127.0.0.1 · Silicon Accounts Rust package 0.1.0"
    );
    assert_eq!(
        detail_for("scout/1.4 silicon-accounts-client/0.1.0"),
        "from 127.0.0.1 · scout 1.4 (Silicon Accounts Rust package 0.1.0)"
    );
    assert_eq!(detail_for("curl/8.4.0"), "from 127.0.0.1 · curl 8.4.0");
    assert!(
        signins
            .iter()
            .all(|i| !i["detail"].as_str().unwrap_or_default().contains("browser")),
        "{signins:#?}"
    );
}

/// A revoked proof says why in words (as the Proofs page does), never with the raw reason code
/// ("Revoked by you (revoked by account)").
#[tokio::test]
async fn a_revoked_proof_says_why_in_words() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let owner = ctx.carbon().await;
    let issuer = member_app(&ctx, "dm", &carbon, &[Scope::Profile]).await;
    let receiver = member_app(&ctx, "briefcase", &carbon, &[Scope::Profile]).await;
    let app_revoker = format!("app:{issuer}");
    let cases: [(&str, &str); 7] = [
        ("revoked_by_account", carbon.uuid.as_str()),
        ("revoked_by_app", app_revoker.as_str()),
        ("revoked_by_owner", owner.uuid.as_str()),
        ("refresh_token_reuse", "system"),
        ("sign_in_revoked", "system"),
        ("access_removed", carbon.uuid.as_str()),
        ("some_future_reason", app_revoker.as_str()),
    ];
    for (reason, revoked_by) in cases {
        sqlx::query(
            "insert into proof_families (id, kind, issuing_app, audiences, account_uuid, scopes, access_ttl_seconds, expires_at, \
               revoked_at, revoked_by, revoke_reason) \
             values ($1, 'obo', $2, $3, $4, '{files.write}', 600, now() + interval '900 days', now(), $5, $6)",
        )
        .bind(Uuid::now_v7())
        .bind(&issuer)
        .bind(vec![receiver.clone()])
        .bind(&carbon.uuid)
        .bind(revoked_by)
        .bind(reason)
        .execute(&ctx.state.db)
        .await
        .expect("proof");
    }
    let r = call(
        &ctx,
        Req::get("/v1/me/history?kind=proof").bearer(&token(&ctx, &carbon).await),
    )
    .await;
    assert_status(&r, 200);
    let all = items(&r.json);
    let revoked: Vec<&Value> = all
        .iter()
        .filter(|i| i["meta"]["event"] == "revoked")
        .collect();
    assert_eq!(revoked.len(), cases.len(), "{all:#?}");
    let issuer_name = revoked[0]["app"]["name"].as_str().expect("issuer name");
    assert_eq!(issuer_name, "Test app dm");
    let detail = |reason: &str| {
        revoked
            .iter()
            .find(|i| i["meta"]["reason"] == reason)
            .unwrap_or_else(|| panic!("no proof revoked for {reason}"))["detail"]
            .as_str()
            .unwrap_or_else(|| panic!("no detail for {reason}"))
            .to_string()
    };
    assert_eq!(detail("revoked_by_account"), "Revoked by you");
    assert_eq!(detail("revoked_by_app"), "Revoked by Test app dm");
    assert_eq!(detail("revoked_by_owner"), "Revoked by Test app dm's owner");
    assert_eq!(
        detail("refresh_token_reuse"),
        "Revoked because its refresh token was used twice, which can mean it leaked"
    );
    assert_eq!(
        detail("sign_in_revoked"),
        "Ended when your sign-in at Test app dm ended"
    );
    assert_eq!(
        detail("access_removed"),
        "Ended when you removed Test app dm's access"
    );
    // A reason this version doesn't know still names who revoked it (the app, not `app:…`).
    assert_eq!(
        detail("some_future_reason"),
        "Revoked by Test app dm (some future reason)"
    );
    for item in &revoked {
        let text = item["detail"].as_str().unwrap_or_default();
        assert!(
            !text.contains("revoked by account")
                && !text.contains("app:")
                && !text.contains(owner.uuid.as_str()),
            "{text}"
        );
        assert_eq!(
            item["title"],
            "Proof for Test app dm to act for you at Test app briefcase revoked"
        );
    }
}

/// An audit entry as another crate writes it: (action, actor kind, actor id, app, target kind,
/// details).
type Written<'a> = (
    &'a str,
    ActorKind,
    Option<&'a str>,
    Option<&'a str>,
    &'a str,
    Value,
);

/// Audit actions written outside this crate (auth's sign-in flows, the CLI's sign-ins, OAuth,
/// the service) read as sentences, never as their action code in words ("Contact added",
/// "Oauth token revoked", "Signin locked").
#[tokio::test]
async fn entries_from_sign_in_flows_read_as_sentences() {
    let ctx = TestContext::new().await;
    let carbon = ctx.carbon().await;
    let dm = member_app(&ctx, "dm", &carbon, &[Scope::Profile]).await;
    let me = carbon.uuid.as_str();
    let account = ActorKind::Account;
    let system = ActorKind::System;
    let entries: Vec<Written<'_>> = vec![
        // crates/auth/src/flow/requirements.rs today: the kind, not the address …
        (
            "contact.added",
            account,
            Some(me),
            Some(dm.as_str()),
            "phone",
            json!({"via": "requirement", "app_id": dm, "kind": "phone"}),
        ),
        // … and the address, when the entry carries it.
        (
            "contact.added",
            account,
            Some(me),
            Some(dm.as_str()),
            "email",
            json!({"via": "requirement", "app_id": dm, "kind": "email", "email": "ada.second@example.test"}),
        ),
        (
            "identity.linked",
            account,
            Some(me),
            None,
            "identity",
            json!({"provider": "google", "linked_by": "account_site", "email_added": true}),
        ),
        (
            "identity.linked",
            account,
            Some(me),
            Some(dm.as_str()),
            "identity",
            json!({"provider": "apple", "linked_by": "verified_email"}),
        ),
        (
            "session.created",
            account,
            Some(me),
            Some("accounts"),
            "session",
            json!({"kind": "cli", "label": "accounts CLI on studio (macos)", "via": "email"}),
        ),
        (
            "session.signed_out",
            account,
            Some(me),
            None,
            "session",
            json!({"kind": "browser"}),
        ),
        (
            "device.approved",
            account,
            Some(me),
            Some("accounts"),
            "device",
            json!({"client_label": "accounts CLI on studio (macos)"}),
        ),
        (
            "signin.locked",
            system,
            None,
            Some(dm.as_str()),
            "email",
            json!({"destination": "a***@example.test", "purpose": "signin", "wrong_codes": 10, "locked_until": "2026-10-07T10:01:00.000Z"}),
        ),
        (
            "signin.refused",
            system,
            None,
            Some(dm.as_str()),
            "identity",
            json!({"provider": "google", "reason": "email_not_verified"}),
        ),
        (
            "contact.unverified_removed",
            system,
            None,
            None,
            "phone",
            json!({"kind": "phone", "was_primary": false, "reason": "an unverified address left by an import was proven by another sign-in"}),
        ),
        (
            "oauth.token_revoked",
            ActorKind::App,
            Some(dm.as_str()),
            Some(dm.as_str()),
            "token_family",
            json!({"reason": "app_revoked", "token_type": "refresh_token", "label": null}),
        ),
        (
            "oauth.token_revoked",
            account,
            Some(me),
            Some("accounts"),
            "token_family",
            json!({"reason": "user_signed_out", "token_type": "refresh_token", "label": "accounts CLI on studio (macos)"}),
        ),
        (
            "oauth.refresh_reuse_detected",
            ActorKind::App,
            Some(dm.as_str()),
            Some(dm.as_str()),
            "token_family",
            json!({"reason": "refresh_token_reuse"}),
        ),
        (
            "account.claimed",
            account,
            Some(me),
            Some(dm.as_str()),
            "account",
            json!({"method": "email", "app_id": dm}),
        ),
    ];
    let mut conn = ctx.conn().await;
    for (action, actor_kind, actor_id, app_id, target_kind, details) in &entries {
        audit::record(
            &mut conn,
            &AuditEntry {
                account_uuid: Some(me),
                app_id: *app_id,
                target_kind: Some(target_kind),
                details: details.clone(),
                ip: Some("198.51.100.4"),
                ..AuditEntry::new(*actor_kind, *actor_id, action)
            },
        )
        .await
        .expect("audit");
    }
    drop(conn);
    let r = call(
        &ctx,
        Req::get("/v1/me/history?kind=security&limit=50").bearer(&token(&ctx, &carbon).await),
    )
    .await;
    assert_status(&r, 200);
    let all = items(&r.json);
    assert_eq!(all.len(), entries.len(), "{all:#?}");
    let mut said: Vec<(String, Option<String>)> = all
        .iter()
        .map(|i| {
            (
                i["title"].as_str().expect("title").to_string(),
                i["detail"].as_str().map(str::to_string),
            )
        })
        .collect();
    let want: Vec<(&str, Option<&str>)> = vec![
        ("Phone number added while signing in to Test app dm", None),
        (
            "Email ada.second@example.test added while signing in to Test app dm",
            None,
        ),
        (
            "Google account connected",
            Some("Its verified email was added to your emails"),
        ),
        (
            "Apple account connected",
            Some("Connected when you signed in with it: its verified email is on your account"),
        ),
        (
            "New CLI sign-in",
            Some("accounts CLI on studio (macos) · with an email code"),
        ),
        ("Signed out of a browser session", None),
        (
            "Approved a terminal sign-in",
            Some("accounts CLI on studio (macos)"),
        ),
        (
            "Too many wrong codes for a***@example.test",
            Some("After 10 wrong codes in a row, tries were paused until 2026-10-07T10:01:00.000Z"),
        ),
        (
            "Google sign-in to Test app dm refused",
            Some("Reason: email not verified"),
        ),
        (
            "Unverified phone number removed",
            Some(
                "An app's import had added it without a check, and someone else proved it is theirs",
            ),
        ),
        ("Test app dm signed you out", None),
        (
            "Signed out of a CLI sign-in",
            Some("accounts CLI on studio (macos)"),
        ),
        (
            "Sign-in at Test app dm ended",
            Some(
                "Its refresh token was used twice, which can mean it leaked; sign in again to continue",
            ),
        ),
        (
            "Finished setting up your account",
            Some("An app's import of its existing accounts had made it"),
        ),
    ];
    let mut want: Vec<(String, Option<String>)> = want
        .into_iter()
        .map(|(t, d)| (t.to_string(), d.map(str::to_string)))
        .collect();
    // Rows written in the same microsecond have no meaningful order: compare as sets.
    said.sort();
    want.sort();
    assert_eq!(said, want);
    for (title, _) in &said {
        for code_words in [
            "Contact added",
            "Oauth",
            "Signin",
            "Identity linked",
            "Device approved",
        ] {
            assert!(!title.contains(code_words), "{title}");
        }
    }
}
