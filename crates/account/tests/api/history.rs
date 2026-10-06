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
    assert_eq!(revoked["detail"], "Revoked by you (revoked by account)");
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
    let requested = find(&mine, "custodian", "Silicon transfer requested");
    assert_eq!(requested["detail"], format!("By {first_id}"));
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
    assert_eq!(security[0]["title"], "STK rotated");

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
    }
    // The custodian sees its own entry in full.
    let own = entry(custodian.clone()).await;
    assert_eq!(own["meta"]["ip"], "203.0.113.77");
    assert_eq!(own["meta"]["details"]["to"], "Next.Owner@Example.test");
}
