//! Real Accounts grants and row locks: no copied linked-app credentials.
use crate::common::{CHALLENGE, VERIFIER, router};
use accounts_core::{
    crypto::{prefix, random_token},
    models::Scope,
    repo::{apps, tokens},
    test_support::{Req, TestContext},
};
use serde_json::json;
use uuid::Uuid;

#[tokio::test]
async fn cells_delegation_requires_authors_and_keeps_sessions_bound_to_one_cell() {
    let ctx = TestContext::new().await;
    let owner = ctx.carbon().await;
    let stranger = ctx.carbon().await;
    let (app, app_secret) = ctx.app_owned("notes", Some(&owner.uuid)).await;
    let service_secret = random_token(prefix::APP_SECRET);
    sqlx::query("insert into apps(app_id,name,secret_hash,status,source) values('silicon-cells','Silicon Cells',$1,'active','fake')").bind(ctx.state.keys.pepper.hash(&service_secret)).execute(&ctx.db.pool).await.expect("Cells delegation fixture or response");
    let author = ctx
        .tokens_for(&owner, "developer", &[Scope::Profile, Scope::Email])
        .await;
    let outsider = ctx
        .tokens_for(&stranger, "developer", &[Scope::Profile])
        .await;
    let cell = Uuid::new_v4();
    let other = Uuid::new_v4();
    let path = format!("/v1/internal/cells/links/{cell}/{}", app.app_id);
    let other_path = format!("/v1/internal/cells/links/{other}/{}", app.app_id);
    let callback = "https://notes.cells.example/auth/callback";
    let link_body = json!({"actor_token":author.access_token,"callback_uri":callback});
    let wrong_service = ctx
        .call(
            router(),
            Req::put(&path)
                .basic(&app.app_id, &app_secret)
                .header("idempotency-key", "wrong-service")
                .json(link_body.clone()),
        )
        .await;
    assert_eq!(wrong_service.status, 403);
    let not_author = ctx
        .call(
            router(),
            Req::put(&path)
                .basic("silicon-cells", &service_secret)
                .header("idempotency-key", "not-author")
                .json(json!({"actor_token":outsider.access_token,"callback_uri":callback})),
        )
        .await;
    assert_eq!(not_author.status, 403);
    let linked = ctx
        .call(
            router(),
            Req::put(&path)
                .basic("silicon-cells", &service_secret)
                .header("idempotency-key", "link")
                .json(link_body),
        )
        .await;
    assert_eq!(linked.status, 200, "{}", linked.json);
    assert!(!linked.json.to_string().contains(&app_secret));
    let configured =
        apps::effective_config(&mut *ctx.conn().await, &ctx.state.settings, &app.app_id)
            .await
            .expect("Cells delegation fixture or response");
    assert!(configured.redirect_uris.contains(&callback.to_owned()));
    let linked=ctx.call(router(),Req::put(&other_path).basic("silicon-cells",&service_secret).header("idempotency-key", "link-other").json(json!({"actor_token":author.access_token,"callback_uri":"https://other.cells.example/auth/callback"}))).await;
    assert_eq!(linked.status, 200);

    let (silicon, _) = ctx.silicon(&owner.uuid).await;
    let slt = tokens::create_slt(
        &mut *ctx.conn().await,
        &ctx.state.keys.pepper,
        &silicon.uuid,
        &app.app_id,
        &[Scope::Profile],
    )
    .await
    .expect("Cells delegation fixture or response")
    .0;
    let exchange_body = json!({"grant_type":"slt","slt":slt});
    let issued = ctx
        .call(
            router(),
            Req::post(&format!("{path}/token"))
                .basic("silicon-cells", &service_secret)
                .header("idempotency-key", "slt-exchange")
                .json(exchange_body.clone()),
        )
        .await;
    assert_eq!(issued.status, 200, "{}", issued.json);
    assert_eq!(issued.json["account"]["uuid"], silicon.uuid);
    let replay = ctx
        .call(
            router(),
            Req::post(&format!("{path}/token"))
                .basic("silicon-cells", &service_secret)
                .header("idempotency-key", "slt-exchange")
                .json(exchange_body),
        )
        .await;
    assert_eq!(replay.json, issued.json);
    let access = issued.json["access_token"]
        .as_str()
        .expect("Cells delegation fixture or response");
    let refresh = issued.json["refresh_token"]
        .as_str()
        .expect("Cells delegation fixture or response");
    let active = ctx
        .call(
            router(),
            Req::post(&format!("{path}/introspect"))
                .basic("silicon-cells", &service_secret)
                .json(json!({"token":access})),
        )
        .await;
    assert_eq!(active.json["active"], true);
    let other_active = ctx
        .call(
            router(),
            Req::post(&format!("{other_path}/introspect"))
                .basic("silicon-cells", &service_secret)
                .json(json!({"token":access})),
        )
        .await;
    assert_eq!(other_active.json, json!({"active":false}));
    let foreign_refresh = ctx
        .call(
            router(),
            Req::post(&format!("{other_path}/token"))
                .basic("silicon-cells", &service_secret)
                .header("idempotency-key", "foreign-refresh")
                .json(json!({"grant_type":"refresh_token","refresh_token":refresh})),
        )
        .await;
    assert_eq!(foreign_refresh.status, 401);
    let refreshed = ctx
        .call(
            router(),
            Req::post(&format!("{path}/token"))
                .basic("silicon-cells", &service_secret)
                .header("idempotency-key", "refresh")
                .json(json!({"grant_type":"refresh_token","refresh_token":refresh})),
        )
        .await;
    assert_eq!(refreshed.status, 200, "{}", refreshed.json);
    let refreshed_replay = ctx
        .call(
            router(),
            Req::post(&format!("{path}/token"))
                .basic("silicon-cells", &service_secret)
                .header("idempotency-key", "refresh")
                .json(json!({"grant_type":"refresh_token","refresh_token":refresh})),
        )
        .await;
    assert_eq!(refreshed_replay.json, refreshed.json);

    // A normal session for the linked app is not a delegated session.
    let ordinary = ctx
        .tokens_for(&silicon, &app.app_id, &[Scope::Profile])
        .await;
    let denied = ctx
        .call(
            router(),
            Req::post(&format!("{path}/token"))
                .basic("silicon-cells", &service_secret)
                .header("idempotency-key", "ordinary-refresh")
                .json(json!({"grant_type":"refresh_token","refresh_token":ordinary.refresh_token})),
        )
        .await;
    assert_eq!(denied.status, 401);

    // Carbon authorization codes are callback-bound and require PKCE, even for Cells.
    ctx.membership(&app.app_id, &owner.uuid, &[Scope::Profile])
        .await;
    let code = tokens::create_code(
        &mut *ctx.conn().await,
        &ctx.state.keys.pepper,
        &tokens::NewAuthCode {
            flow_id: "cells-test",
            app_id: &app.app_id,
            account_uuid: &owner.uuid,
            redirect_uri: callback,
            code_challenge: Some(CHALLENGE),
            code_challenge_method: Some("S256"),
            scopes: &[Scope::Profile],
            nonce: None,
            browser_session_id: None,
            auth_time: None,
        },
    )
    .await
    .expect("Cells delegation fixture or response");
    let carbon=ctx.call(router(),Req::post(&format!("{path}/token")).basic("silicon-cells",&service_secret).header("idempotency-key", "carbon-code").json(json!({"grant_type":"authorization_code","code":code,"redirect_uri":callback,"code_verifier":VERIFIER}))).await;
    assert_eq!(carbon.status, 200, "{}", carbon.json);
    let no_pkce = tokens::create_code(
        &mut *ctx.conn().await,
        &ctx.state.keys.pepper,
        &tokens::NewAuthCode {
            flow_id: "cells-test",
            app_id: &app.app_id,
            account_uuid: &owner.uuid,
            redirect_uri: callback,
            code_challenge: None,
            code_challenge_method: None,
            scopes: &[Scope::Profile],
            nonce: None,
            browser_session_id: None,
            auth_time: None,
        },
    )
    .await
    .expect("Cells delegation fixture or response");
    let denied=ctx.call(router(),Req::post(&format!("{path}/token")).basic("silicon-cells",&service_secret).header("idempotency-key", "no-pkce").json(json!({"grant_type":"authorization_code","code":no_pkce,"redirect_uri":callback}))).await;
    assert_eq!(denied.status, 400);

    let unlinked = ctx
        .call(
            router(),
            Req::delete(&path).basic("silicon-cells", &service_secret),
        )
        .await;
    assert_eq!(unlinked.status, 200);
    let denied = ctx
        .call(
            router(),
            Req::post(&format!("{path}/introspect"))
                .basic("silicon-cells", &service_secret)
                .json(json!({"token":access})),
        )
        .await;
    assert_eq!(denied.json, json!({"active":false}));
    let denied=ctx.call(router(),Req::post(&format!("{path}/token")).basic("silicon-cells",&service_secret).header("idempotency-key", "after-unlink").json(json!({"grant_type":"refresh_token","refresh_token":refreshed.json["refresh_token"]}))).await;
    assert_eq!(denied.status, 403);
    let configured =
        apps::effective_config(&mut *ctx.conn().await, &ctx.state.settings, &app.app_id)
            .await
            .expect("Cells delegation fixture or response");
    assert!(!configured.redirect_uris.contains(&callback.to_owned()));
    let ordinary_active = ctx
        .call(
            router(),
            Req::post("/v1/oauth/introspect")
                .basic(&app.app_id, &app_secret)
                .form(&[("token", &ordinary.access_token)]),
        )
        .await;
    assert_eq!(
        ordinary_active.json["active"], true,
        "Unlinking revoked a session that did not belong to the cell"
    );
}

#[tokio::test]
async fn cells_custom_callbacks_are_fenced_and_never_replace_the_permanent_callback() {
    let ctx = TestContext::new().await;
    let owner = ctx.carbon().await;
    let (app, app_secret) = ctx.app_owned("domains", Some(&owner.uuid)).await;
    let secret = random_token(prefix::APP_SECRET);
    sqlx::query("insert into apps(app_id,name,secret_hash,status,source) values('silicon-cells','Silicon Cells',$1,'active','fake')")
        .bind(ctx.state.keys.pepper.hash(&secret)).execute(&ctx.db.pool).await.expect("fixture service");
    let author = ctx.tokens_for(&owner, "developer", &[Scope::Profile]).await;
    let cell = Uuid::new_v4();
    let path = format!("/v1/internal/cells/links/{cell}/{}", app.app_id);
    let update = format!("{path}/callback");
    let base = "https://permanent.cells.example/auth/callback";
    let custom = "https://data.example/auth/callback";
    let body = |generation, alias: Option<&str>| json!({"base_callback_uri":base,"custom_callback_uri":alias,"generation":generation});
    let send = |body, key: &'static str| {
        Req::put(&update)
            .basic("silicon-cells", &secret)
            .header("idempotency-key", key)
            .json(body)
    };
    let denied = ctx
        .call(router(), send(body(1, Some(custom)), "unlinked"))
        .await;
    assert_eq!(denied.status, 403);
    let linked = ctx
        .call(
            router(),
            Req::put(&path)
                .basic("silicon-cells", &secret)
                .header("idempotency-key", "link")
                .json(json!({"actor_token":author.access_token,"callback_uri":base})),
        )
        .await;
    assert_eq!(linked.status, 200);
    let denied = ctx
        .call(
            router(),
            Req::put(&update)
                .basic(&app.app_id, &app_secret)
                .header("idempotency-key", "wrong-service")
                .json(body(1, Some(custom))),
        )
        .await;
    assert_eq!(denied.status, 403);
    for invalid in [
        "http://data.example/auth/callback",
        "https://data.example/elsewhere",
        "https://user@data.example/auth/callback",
        "https://data.example/auth/callback?q=1",
        "https://data.example/auth/callback#x",
        base,
    ] {
        let denied = ctx
            .call(router(), send(body(1, Some(invalid)), "invalid"))
            .await;
        assert_eq!(denied.status, 400);
    }
    let denied = ctx.call(router(), send(json!({"base_callback_uri":"https://foreign.example/auth/callback","custom_callback_uri":custom,"generation":1}), "wrong-base")).await;
    assert_eq!(denied.status, 409);
    let accepted = ctx
        .call(router(), send(body(2, Some(custom)), "custom"))
        .await;
    assert_eq!(accepted.status, 200);
    let replay = ctx
        .call(router(), send(body(2, Some(custom)), "custom"))
        .await;
    assert_eq!(replay.json, accepted.json);
    let config = apps::effective_config(&mut *ctx.conn().await, &ctx.state.settings, &app.app_id)
        .await
        .expect("config");
    assert!(config.redirect_uris.contains(&base.to_owned()));
    assert!(config.redirect_uris.contains(&custom.to_owned()));
    ctx.membership(&app.app_id, &owner.uuid, &[Scope::Profile])
        .await;
    let mut custom_grant = None;
    for (callback, key) in [(base, "base-code"), (custom, "custom-code")] {
        let code = tokens::create_code(
            &mut *ctx.conn().await,
            &ctx.state.keys.pepper,
            &tokens::NewAuthCode {
                flow_id: "domains-test",
                app_id: &app.app_id,
                account_uuid: &owner.uuid,
                redirect_uri: callback,
                code_challenge: Some(CHALLENGE),
                code_challenge_method: Some("S256"),
                scopes: &[Scope::Profile],
                nonce: None,
                browser_session_id: None,
                auth_time: None,
            },
        )
        .await
        .expect("code");
        let grant = json!({"grant_type":"authorization_code","code":code,"redirect_uri":callback,"code_verifier":VERIFIER});
        let issued = ctx
            .call(
                router(),
                Req::post(&format!("{path}/token"))
                    .basic("silicon-cells", &secret)
                    .header("idempotency-key", key)
                    .json(grant.clone()),
            )
            .await;
        assert_eq!(issued.status, 200);
        if callback == custom {
            custom_grant = Some(grant);
        }
    }
    let reused = ctx.call(router(), send(body(3, None), "custom")).await;
    assert_eq!(reused.status, 409, "A callback key changed request meaning");
    let removed = ctx.call(router(), send(body(3, None), "remove")).await;
    assert_eq!(removed.status, 200);
    let denied = ctx
        .call(router(), send(body(2, Some(custom)), "custom"))
        .await;
    assert_eq!(
        denied.status, 409,
        "stale command restored a removed callback"
    );
    let denied = ctx
        .call(router(), send(body(3, Some(custom)), "same-generation"))
        .await;
    assert_eq!(denied.status, 409);
    let denied = ctx
        .call(
            router(),
            Req::post(&format!("{path}/token"))
                .basic("silicon-cells", &secret)
                .header("idempotency-key", "custom-code")
                .json(custom_grant.expect("custom grant")),
        )
        .await;
    assert_eq!(
        denied.status, 400,
        "removed callback replayed a saved token response"
    );
    let config = apps::effective_config(&mut *ctx.conn().await, &ctx.state.settings, &app.app_id)
        .await
        .expect("config");
    assert!(config.redirect_uris.contains(&base.to_owned()));
    assert!(!config.redirect_uris.contains(&custom.to_owned()));
    assert_eq!(
        ctx.call(router(), send(body(4, Some(custom)), "restore"))
            .await
            .status,
        200
    );
    assert_eq!(
        ctx.call(router(), Req::delete(&path).basic("silicon-cells", &secret))
            .await
            .status,
        200
    );
    assert_eq!(
        ctx.call(router(), send(body(4, Some(custom)), "restore"))
            .await
            .status,
        403
    );
    let linked = ctx
        .call(
            router(),
            Req::put(&path)
                .basic("silicon-cells", &secret)
                .header("idempotency-key", "relink")
                .json(json!({"actor_token":author.access_token,"callback_uri":base})),
        )
        .await;
    assert_eq!(linked.status, 200);
    let config = apps::effective_config(&mut *ctx.conn().await, &ctx.state.settings, &app.app_id)
        .await
        .expect("config");
    assert!(config.redirect_uris.contains(&base.to_owned()));
    assert!(
        !config.redirect_uris.contains(&custom.to_owned()),
        "relink exposed a suspended domain before verification sync"
    );
    assert_eq!(
        ctx.call(router(), send(body(4, Some(custom)), "restore"))
            .await
            .status,
        200
    );
    let config = apps::effective_config(&mut *ctx.conn().await, &ctx.state.settings, &app.app_id)
        .await
        .expect("config");
    assert!(config.redirect_uris.contains(&custom.to_owned()));
    // Ordinary sign-in configuration edits cannot remove either managed callback.
    sqlx::query("delete from app_signin_configs where app_id=$1")
        .bind(&app.app_id)
        .execute(&ctx.db.pool)
        .await
        .expect("edit config");
    let config = apps::effective_config(&mut *ctx.conn().await, &ctx.state.settings, &app.app_id)
        .await
        .expect("config");
    assert!(
        config.redirect_uris.contains(&base.to_owned())
            && config.redirect_uris.contains(&custom.to_owned())
    );
    // Even after unlink, the assigned base cannot silently become another host.
    assert_eq!(
        ctx.call(router(), Req::delete(&path).basic("silicon-cells", &secret))
            .await
            .status,
        200
    );
    let denied = ctx.call(router(), Req::put(&path).basic("silicon-cells", &secret).header("idempotency-key", "replace-base").json(json!({"actor_token":author.access_token,"callback_uri":"https://other.example/auth/callback"}))).await;
    assert_eq!(denied.status, 409);
}
