//! The app's user base.

mod common;

use std::collections::HashSet;

use accounts_core::ids::AccountId;
use accounts_core::models::{AccountKind, AccountStatus, Scope};
use accounts_core::pfp;
use accounts_core::repo::accounts::{self, ProfileUpdate};
use accounts_core::repo::{audit, memberships};
use accounts_core::test_support::{CarbonSpec, Req, TestContext};
use common::{call, owned_app};
use serde_json::{Value, json};

async fn list(ctx: &TestContext, app_id: &str, secret: &str, query: &str) -> Value {
    let r = call(
        ctx,
        Req::get(&format!("/v1/apps/{app_id}/users?{query}")).basic(app_id, secret),
    )
    .await;
    assert_eq!(r.status, 200, "{query}: {}", r.json);
    r.json
}

fn uuids(page: &Value) -> Vec<String> {
    page["items"]
        .as_array()
        .map(|i| {
            i.iter()
                .filter_map(|x| x["uuid"].as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

#[tokio::test]
async fn user_base_shows_only_what_the_app_may_see() {
    let ctx = TestContext::new().await;
    let a = owned_app(&ctx, "ub").await;

    let with_email = ctx
        .carbon_with(CarbonSpec {
            display_name: Some("Ada Lovelace".into()),
            email: Some("ada@ub.test".into()),
            phone: Some("+14155550101".into()),
            timezone: Some("Europe/London".into()),
            ..Default::default()
        })
        .await;
    ctx.membership(
        &a.app_id,
        &with_email.uuid,
        &[Scope::Profile, Scope::Email, Scope::Timezone],
    )
    .await;
    let everything = ctx
        .carbon_with(CarbonSpec {
            phone: Some("+14155550102".into()),
            ..Default::default()
        })
        .await;
    ctx.membership(
        &a.app_id,
        &everything.uuid,
        &[
            Scope::Profile,
            Scope::Email,
            Scope::Phone,
            Scope::Dob,
            Scope::Timezone,
        ],
    )
    .await;
    let profile_only = ctx
        .carbon_with(CarbonSpec {
            email: Some("hidden@ub.test".into()),
            ..Default::default()
        })
        .await;
    ctx.membership(&a.app_id, &profile_only.uuid, &[Scope::Profile])
        .await;
    let (silicon, _) = ctx.silicon(&with_email.uuid).await;
    ctx.membership(
        &a.app_id,
        &silicon.uuid,
        &[
            Scope::Profile,
            Scope::Email,
            Scope::Phone,
            Scope::Dob,
            Scope::Timezone,
        ],
    )
    .await;
    let imported = ctx
        .carbon_with(CarbonSpec {
            status: Some(AccountStatus::Unclaimed),
            email: Some("real@ub.test".into()),
            ..Default::default()
        })
        .await;
    let removed = ctx.carbon().await;
    ctx.membership(&a.app_id, &removed.uuid, &[Scope::Profile, Scope::Email])
        .await;
    {
        let mut conn = ctx.conn().await;
        memberships::upsert_imported(
            &mut conn,
            &a.app_id,
            &imported.uuid,
            Some("crm-77"),
            Some(&json!({"emails": ["supplied@ub.test"], "phones": ["+14155550199"], "dob": "1990-01-01", "timezone": "Europe/Berlin"})),
            false,
        )
        .await
        .expect("imported");
        memberships::remove_access(&mut conn, &a.app_id, &removed.uuid, &removed.uuid)
            .await
            .expect("removed");
    }

    let page = list(&ctx, &a.app_id, &a.secret, "").await;
    let items = page["items"].as_array().expect("items");
    assert_eq!(items.len(), 6);
    let by = |uuid: &str| {
        items
            .iter()
            .find(|i| i["uuid"] == uuid)
            .cloned()
            .expect("row")
    };

    let row = by(&with_email.uuid);
    assert_eq!(
        row["membership_id"],
        format!("{}:{}", a.app_id, with_email.uuid)
    );
    assert_eq!(row["kind"], "carbon");
    assert_eq!(row["display_name"], "Ada Lovelace");
    assert_eq!(row["email"], "ada@ub.test");
    assert_eq!(row["timezone"], "Europe/London");
    assert!(
        row.get("phone").is_none() && row.get("dob").is_none(),
        "{row}"
    );
    assert_eq!(row["status"], "active");
    assert_eq!(row["source"], "signin");
    assert_eq!(
        row["granted_scopes"],
        json!(["profile", "email", "timezone"])
    );
    assert!(row["first_signed_in_at"].is_string() && row["last_signed_in_at"].is_string());

    let row = by(&everything.uuid);
    assert_eq!(row["phone"], "+14155550102");
    assert_eq!(row["dob"], "2000-01-01");
    let row = by(&profile_only.uuid);
    assert!(
        row.get("email").is_none() && row.get("timezone").is_none(),
        "{row}"
    );
    let row = by(&silicon.uuid);
    assert_eq!(row["kind"], "silicon");
    assert!(
        row.get("email").is_none() && row.get("phone").is_none(),
        "Silicons never have contacts: {row}"
    );
    assert!(row["dob"].is_string() && row["timezone"].is_string());
    let row = by(&imported.uuid);
    assert_eq!(row["status"], "imported");
    assert_eq!(row["source"], "import");
    assert_eq!(row["external_id"], "crm-77");
    assert_eq!(
        row["email"], "supplied@ub.test",
        "imported rows show what the app supplied"
    );
    assert_eq!(row["phone"], "+14155550199");
    assert_eq!(row["dob"], "1990-01-01");
    assert_eq!(row["timezone"], "Europe/Berlin");
    assert_eq!(row["account_status"], "unclaimed");
    assert_eq!(row["first_signed_in_at"], Value::Null);
    let row = by(&removed.uuid);
    assert_eq!(row["status"], "access_removed");
    assert!(row.get("email").is_none(), "{row}");

    // Filters.
    assert_eq!(
        uuids(&list(&ctx, &a.app_id, &a.secret, "status=imported").await),
        vec![imported.uuid.clone()]
    );
    assert_eq!(
        uuids(&list(&ctx, &a.app_id, &a.secret, "kind=silicon").await),
        vec![silicon.uuid.clone()]
    );
    assert_eq!(
        uuids(&list(&ctx, &a.app_id, &a.secret, "source=import").await),
        vec![imported.uuid.clone()]
    );
    assert_eq!(
        list(&ctx, &a.app_id, &a.secret, "status=active&kind=carbon").await["items"]
            .as_array()
            .map(Vec::len),
        Some(3)
    );
    let r = call(
        &ctx,
        Req::get(&format!("/v1/apps/{}/users?status=gone", a.app_id)).basic(&a.app_id, &a.secret),
    )
    .await;
    assert_eq!(r.status, 400);
    assert_eq!(r.error_code(), Some("invalid_query"));
    assert!(
        r.json["error"]["message"]
            .as_str()
            .is_some_and(|m| m.contains("active, imported, access_removed, deleted"))
    );

    // Search only looks at what the app may see.
    assert_eq!(
        uuids(&list(&ctx, &a.app_id, &a.secret, "q=lovelace").await),
        vec![with_email.uuid.clone()]
    );
    assert_eq!(
        uuids(&list(&ctx, &a.app_id, &a.secret, "q=ada%40ub.test").await),
        vec![with_email.uuid.clone()]
    );
    assert!(
        uuids(&list(&ctx, &a.app_id, &a.secret, "q=hidden%40ub").await).is_empty(),
        "no email scope → not searchable"
    );
    assert!(
        uuids(&list(&ctx, &a.app_id, &a.secret, "q=real%40ub").await).is_empty(),
        "the unclaimed account's own email isn't the app's"
    );
    assert_eq!(
        uuids(&list(&ctx, &a.app_id, &a.secret, "q=supplied").await),
        vec![imported.uuid.clone()]
    );
    assert_eq!(
        uuids(&list(&ctx, &a.app_id, &a.secret, "q=CRM-77").await),
        vec![imported.uuid.clone()]
    );
    assert_eq!(
        uuids(&list(&ctx, &a.app_id, &a.secret, "q=%2B14155550199").await),
        vec![imported.uuid.clone()]
    );
    assert_eq!(
        uuids(&list(&ctx, &a.app_id, &a.secret, &format!("q={}", silicon.uuid)).await),
        vec![silicon.uuid.clone()]
    );
    let handle = silicon.handle.clone().expect("handle");
    assert_eq!(
        uuids(
            &list(
                &ctx,
                &a.app_id,
                &a.secret,
                &format!("q={}", handle.replace(':', "%3A"))
            )
            .await
        ),
        vec![silicon.uuid.clone()]
    );
    assert!(
        uuids(&list(&ctx, &a.app_id, &a.secret, "q=%25").await).is_empty(),
        "wildcards are literal"
    );

    // Pages cover everything exactly once.
    let mut seen = HashSet::new();
    let mut cursor: Option<String> = None;
    for _ in 0..10 {
        let q = match &cursor {
            Some(c) => format!("limit=2&cursor={c}"),
            None => "limit=2".to_string(),
        };
        let page = list(&ctx, &a.app_id, &a.secret, &q).await;
        for u in uuids(&page) {
            assert!(seen.insert(u), "a row came twice");
        }
        match page["next_cursor"].as_str() {
            Some(c) => cursor = Some(c.to_string()),
            None => break,
        }
    }
    assert_eq!(seen.len(), 6);
}

#[tokio::test]
async fn user_detail_has_the_last_twenty_signins_at_this_app() {
    let ctx = TestContext::new().await;
    let a = owned_app(&ctx, "ud").await;
    let other = owned_app(&ctx, "ud-o").await;
    let c = ctx.carbon().await;
    ctx.membership(&a.app_id, &c.uuid, &[Scope::Profile]).await;
    {
        let mut conn = ctx.conn().await;
        for i in 0..23 {
            audit::signin(
                &mut conn,
                &audit::SigninRecord {
                    account_uuid: Some(&c.uuid),
                    app_id: Some(if i == 22 { &other.app_id } else { &a.app_id }),
                    method: audit::method::EMAIL,
                    outcome: audit::outcome::SUCCESS,
                    ip: Some("10.0.0.1"),
                    user_agent: Some("test"),
                },
            )
            .await
            .expect("signin");
        }
    }
    let r = call(
        &ctx,
        Req::get(&format!("/v1/apps/{}/users/{}", a.app_id, c.uuid)).basic(&a.app_id, &a.secret),
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(r.json["uuid"], c.uuid.as_str());
    let history = r.json["history"].as_array().expect("history");
    assert_eq!(history.len(), 20);
    assert_eq!(history[0]["method"], "email");
    assert_eq!(history[0]["outcome"], "success");
    assert!(
        history[0].get("ip").is_none(),
        "sign-in IPs are not shared with apps"
    );

    let stranger = ctx.carbon().await;
    let r = call(
        &ctx,
        Req::get(&format!("/v1/apps/{}/users/{}", a.app_id, stranger.uuid))
            .basic(&a.app_id, &a.secret),
    )
    .await;
    assert_eq!(r.status, 404);
    assert_eq!(r.error_code(), Some("user_not_found"));
    let r = call(
        &ctx,
        Req::get(&format!("/v1/apps/{}/users/{}", a.app_id, c.uuid))
            .basic(&other.app_id, &other.secret),
    )
    .await;
    assert_eq!(r.error_code(), Some("app_mismatch"));
    let r = call(
        &ctx,
        Req::get(&format!("/v1/apps/{}/users/{}", a.app_id, c.uuid))
            .session(&ctx.state.settings, &a.cookie),
    )
    .await;
    assert_eq!(r.status, 200);
}

/// A deleted account stays in the user base as history only: no data, not a member, not
/// counted, not found by its old name.
#[tokio::test]
async fn deleted_accounts_are_history_without_data() {
    let ctx = TestContext::new().await;
    let a = owned_app(&ctx, "del").await;
    let gone = ctx
        .carbon_with(CarbonSpec {
            display_name: Some("Gone Person".into()),
            email: Some("gone@del.test".into()),
            ..Default::default()
        })
        .await;
    let stays = ctx.carbon().await;
    for c in [&gone, &stays] {
        ctx.membership(
            &a.app_id,
            &c.uuid,
            &[Scope::Profile, Scope::Email, Scope::Dob, Scope::Timezone],
        )
        .await;
    }
    {
        let mut conn = ctx.conn().await;
        memberships::upsert_imported(
            &mut conn,
            &a.app_id,
            &gone.uuid,
            Some("crm-gone"),
            None,
            false,
        )
        .await
        .expect("external id");
        accounts_core::repo::accounts::delete_account(
            &mut conn,
            &ctx.state.settings,
            &gone.uuid,
            &gone.uuid,
            true,
        )
        .await
        .expect("delete");
    }

    let page = list(&ctx, &a.app_id, &a.secret, "").await;
    let row = page["items"]
        .as_array()
        .and_then(|i| i.iter().find(|x| x["uuid"] == gone.uuid.as_str()))
        .cloned()
        .expect("still listed");
    assert_eq!(row["status"], "deleted");
    assert_eq!(row["account_status"], "deleted");
    assert_eq!(row["display_name"], "Deleted account");
    assert_eq!(row["id"], Value::Null);
    assert_eq!(row["external_id"], "crm-gone");
    for field in ["email", "phone", "dob", "timezone"] {
        assert!(row.get(field).is_none(), "{field}: {row}");
    }
    assert!(!row.to_string().contains("Gone Person"), "{row}");
    assert_eq!(
        uuids(&list(&ctx, &a.app_id, &a.secret, "status=deleted").await),
        vec![gone.uuid.clone()]
    );
    assert_eq!(
        uuids(&list(&ctx, &a.app_id, &a.secret, "status=active").await),
        vec![stays.uuid.clone()]
    );
    assert!(
        uuids(&list(&ctx, &a.app_id, &a.secret, "q=Person").await).is_empty(),
        "the old name can't be searched"
    );
    assert_eq!(
        uuids(&list(&ctx, &a.app_id, &a.secret, "q=crm-gone").await),
        vec![gone.uuid.clone()]
    );
    let r = call(
        &ctx,
        Req::get(&format!("/v1/apps/{}/users/{}", a.app_id, gone.uuid)).basic(&a.app_id, &a.secret),
    )
    .await;
    assert_eq!(r.status, 200);
    assert_eq!(r.json["status"], "deleted");
    assert!(r.json.get("dob").is_none(), "{}", r.json);

    let r = call(
        &ctx,
        Req::get(&format!("/v1/apps/{}", a.app_id)).basic(&a.app_id, &a.secret),
    )
    .await;
    assert_eq!(
        r.json["stats"],
        json!({"users": 1, "active_last_30d": 1, "imported_unclaimed": 0})
    );
    let r = call(
        &ctx,
        Req::get("/v1/me/owned-apps").session(&ctx.state.settings, &a.cookie),
    )
    .await;
    assert_eq!(r.json["items"][0]["users"], 1, "{}", r.json);
}

/// An account that removed an app's access stays in that app's user base as history, but the
/// app sees nothing of the account's own data any more: not its name or photo (as they were, nor
/// after it changes them), only who it was about (uuid, membership id, the public id any uuid
/// resolves to) and the app's own records. Search can't find it by its name either. Signing in
/// to the app again gives the app access again.
#[tokio::test]
async fn access_removed_members_show_nothing_about_the_account() {
    let ctx = TestContext::new().await;
    let a = owned_app(&ctx, "rm").await;
    let mira = ctx
        .carbon_with(CarbonSpec {
            handle: Some("lin-rm".into()),
            display_name: Some("Mira Before".into()),
            email: Some("mira@rm.test".into()),
            timezone: Some("Asia/Tokyo".into()),
            ..Default::default()
        })
        .await;
    let stays = ctx
        .carbon_with(CarbonSpec {
            display_name: Some("Mira Stays".into()),
            ..Default::default()
        })
        .await;
    ctx.membership(
        &a.app_id,
        &mira.uuid,
        &[Scope::Profile, Scope::Email, Scope::Timezone],
    )
    .await;
    ctx.membership(&a.app_id, &stays.uuid, &[Scope::Profile])
        .await;
    let photo = |n: u8| format!("https://photos.example.test/mira-{n}.png");
    {
        let mut conn = ctx.conn().await;
        accounts::update_profile(
            &mut conn,
            &mira.uuid,
            &ProfileUpdate {
                pfp_url: Some(photo(1)),
                ..Default::default()
            },
        )
        .await
        .expect("photo");
        // The app's own reference for her, set while she is a member.
        memberships::upsert_imported(
            &mut conn,
            &a.app_id,
            &mira.uuid,
            Some("crm-l1"),
            None,
            false,
        )
        .await
        .expect("external id");
    }
    let detail = |uuid: String| {
        let ctx = &ctx;
        let (app_id, secret) = (a.app_id.clone(), a.secret.clone());
        async move {
            let r = call(
                ctx,
                Req::get(&format!("/v1/apps/{app_id}/users/{uuid}")).basic(&app_id, &secret),
            )
            .await;
            assert_eq!(r.status, 200, "{}", r.json);
            r.json
        }
    };
    let search = |query: String| {
        let ctx = &ctx;
        let (app_id, secret) = (a.app_id.clone(), a.secret.clone());
        async move { uuids(&list(ctx, &app_id, &secret, &query).await) }
    };

    // A member: the app sees her name, photo and what she shares.
    let before = detail(mira.uuid.clone()).await;
    assert_eq!(before["status"], "active");
    assert_eq!(before["display_name"], "Mira Before");
    assert_eq!(before["pfp_url"], photo(1));
    assert_eq!(before["email"], "mira@rm.test");
    assert_eq!(before["timezone"], "Asia/Tokyo");

    // She removes the app's access: from then on the app sees nothing of hers.
    {
        let mut conn = ctx.conn().await;
        memberships::remove_access(&mut conn, &a.app_id, &mira.uuid, &mira.uuid)
            .await
            .expect("removed");
    }
    let default_photo = pfp::default_pfp_url(
        &ctx.state.settings.iris_base_url,
        AccountKind::Carbon,
        &mira.uuid,
    );
    let removed = detail(mira.uuid.clone()).await;
    assert_eq!(removed["status"], "access_removed");
    assert_eq!(removed["account_status"], "active");
    assert_eq!(removed["uuid"], mira.uuid.as_str());
    assert_eq!(
        removed["membership_id"],
        format!("{}:{}", a.app_id, mira.uuid)
    );
    assert_eq!(
        removed["id"], "c:lin-rm",
        "ids are public: any uuid resolves to its id"
    );
    assert_eq!(removed["display_name"], "Access removed");
    assert_eq!(removed["pfp_url"], default_photo.as_str());
    assert_eq!(
        removed["external_id"], "crm-l1",
        "the app's own reference stays"
    );
    for field in ["email", "phone", "dob", "timezone"] {
        assert!(removed.get(field).is_none(), "{field}: {removed}");
    }
    for secret in ["Mira Before", "mira-1.png", "mira@rm.test", "Asia/Tokyo"] {
        assert!(!removed.to_string().contains(secret), "{secret}: {removed}");
    }
    assert!(
        removed["history"].is_array(),
        "its own sign-ins stay: {removed}"
    );

    // …and then changes her name, photo and id: none of it reaches the app.
    {
        let mut conn = ctx.conn().await;
        accounts::update_profile(
            &mut conn,
            &mira.uuid,
            &ProfileUpdate {
                display_name: Some("Mira Renamed".into()),
                pfp_url: Some(photo(2)),
                ..Default::default()
            },
        )
        .await
        .expect("rename");
        let new_id = AccountId::parse("c:lin-two").expect("id");
        accounts::change_id(&mut conn, &mira.uuid, &new_id, &mira.uuid)
            .await
            .expect("new id");
    }
    let renamed = detail(mira.uuid.clone()).await;
    assert_eq!(renamed["display_name"], "Access removed");
    assert_eq!(renamed["pfp_url"], default_photo.as_str());
    assert_eq!(renamed["id"], "c:lin-two");
    for secret in ["Mira Renamed", "Mira Before", "mira-2.png", "mira-1.png"] {
        assert!(!renamed.to_string().contains(secret), "{secret}: {renamed}");
    }
    let listed = list(&ctx, &a.app_id, &a.secret, "status=access_removed").await;
    assert_eq!(uuids(&listed), vec![mira.uuid.clone()]);
    assert_eq!(listed["items"][0]["display_name"], "Access removed");
    assert!(!listed.to_string().contains("Mira Renamed"), "{listed}");

    // Search can't find her by a name, old or new; it still finds her by what the app may see.
    for q in ["Mira%20Renamed", "Renamed", "Before"] {
        assert!(search(format!("q={q}")).await.is_empty(), "q={q}");
        assert!(
            search(format!("status=access_removed&q={q}"))
                .await
                .is_empty(),
            "status=access_removed&q={q}"
        );
    }
    assert_eq!(search("q=Mira".into()).await, vec![stays.uuid.clone()]);
    assert_eq!(
        search("q=c%3Alin-two".into()).await,
        vec![mira.uuid.clone()]
    );
    assert_eq!(
        search(format!("q={}", mira.uuid)).await,
        vec![mira.uuid.clone()]
    );
    assert_eq!(search("q=crm-l1".into()).await, vec![mira.uuid.clone()]);
    assert!(search("q=mira%40rm.test".into()).await.is_empty());

    // Signing in to the app again gives it access again: it sees her as she is now.
    ctx.membership(&a.app_id, &mira.uuid, &[Scope::Profile])
        .await;
    let back = detail(mira.uuid.clone()).await;
    assert_eq!(back["status"], "active");
    assert_eq!(back["display_name"], "Mira Renamed");
    assert_eq!(back["pfp_url"], photo(2));
    assert_eq!(search("q=Renamed".into()).await, vec![mira.uuid.clone()]);

    // An account that removed the access and was deleted later is deleted history (no id).
    {
        let mut conn = ctx.conn().await;
        memberships::remove_access(&mut conn, &a.app_id, &stays.uuid, &stays.uuid)
            .await
            .expect("removed");
        accounts::delete_account(
            &mut conn,
            &ctx.state.settings,
            &stays.uuid,
            &stays.uuid,
            true,
        )
        .await
        .expect("deleted");
    }
    let gone = detail(stays.uuid.clone()).await;
    assert_eq!(gone["status"], "deleted");
    assert_eq!(gone["display_name"], "Deleted account");
    assert_eq!(gone["id"], Value::Null);
    assert_eq!(
        search("status=access_removed".into()).await,
        Vec::<String>::new()
    );
}
