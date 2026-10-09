//! PATCH /v1/apps/{app_id}/signin-config and its history.

mod common;

use accounts_core::test_support::{Req, TestContext};
use common::{call, owned_app};
use serde_json::{Value, json};

const P8: &str = "-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgGdfFP1jFA4pzuhrh\nu9NNiwVnz8fs9N558N3uNB5RWF2hRANCAAT0i9TKV75AItnA5uq9Jwj+RT0uZEkx\nSLO0NtZA5x+rWTG+GkKWDp5R/fNlUSV/zza5ndQDaXpXC9EC9sofkPjd\n-----END PRIVATE KEY-----\n";

fn patch(app_id: &str, secret: &str, body: Value) -> Req {
    Req::patch(&format!("/v1/apps/{app_id}/signin-config"))
        .basic(app_id, secret)
        .json(body)
}

#[tokio::test]
async fn patch_deep_merges_replaces_arrays_and_records_history() {
    let ctx = TestContext::new().await;
    let a = owned_app(&ctx, "cfg").await;

    let r = call(
        &ctx,
        patch(&a.app_id, &a.secret, json!({
            "branding": {"radius": 28, "light": {"primary": "#0a0a0a"}, "font_family": "Fraunces"},
            "redirect_uris": ["https://cfg.example.com/a", "https://cfg.example.com/b"],
            "required_fields": ["email"], "optional_fields": ["timezone"]
        })),
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(r.json["config_version"], 2);
    let cfg = &r.json["signin_config"];
    assert_eq!(cfg["branding"]["radius"], 28);
    assert_eq!(
        cfg["branding"]["light"]["primary"], "#0A0A0A",
        "colours are canonicalized"
    );
    assert_eq!(
        cfg["branding"]["light"]["background"], "#F7F8FA",
        "untouched keys keep their values (a new app's default: the Silicon look)"
    );
    assert_eq!(
        cfg["branding"]["dark"]["primary"], "#1F5FB8",
        "the default dark fill keeps button text at WCAG AA"
    );
    assert_eq!(cfg["methods"]["email"], true);
    assert_eq!(cfg["required_fields"], json!(["email"]));

    // Arrays replace; null resets a field to its default.
    let r = call(
        &ctx,
        patch(
            &a.app_id,
            &a.secret,
            json!({"redirect_uris": ["https://cfg.example.com/c"], "branding": {"radius": null}}),
        ),
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(r.json["config_version"], 3);
    assert_eq!(
        r.json["signin_config"]["redirect_uris"],
        json!(["https://cfg.example.com/c"])
    );
    assert_eq!(r.json["signin_config"]["branding"]["radius"], 18);
    assert_eq!(
        r.json["signin_config"]["branding"]["font_family"],
        "Fraunces"
    );

    // The same values again: no new version, no history entry.
    let r = call(
        &ctx,
        patch(
            &a.app_id,
            &a.secret,
            json!({"redirect_uris": ["https://cfg.example.com/c"]}),
        ),
    )
    .await;
    assert_eq!(r.status, 200);
    assert_eq!(r.json["config_version"], 3);

    // The owner can patch too; history records who.
    let r = call(
        &ctx,
        Req::patch(&format!("/v1/apps/{}/signin-config", a.app_id))
            .session(&ctx.state.settings, &a.cookie)
            .json(json!({"copy": {"title": "Welcome back"}})),
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(r.json["config_version"], 4);

    let r = call(
        &ctx,
        Req::get(&format!("/v1/apps/{}/signin-config/history", a.app_id))
            .basic(&a.app_id, &a.secret),
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.json);
    let items = r.json["items"].as_array().expect("items");
    assert_eq!(
        items.len(),
        3,
        "three changes (the test factory's initial row has no history)"
    );
    assert_eq!(items[0]["version"], 4);
    assert_eq!(items[0]["actor"], a.owner.uuid.as_str());
    assert_eq!(
        items[0]["actor_account"]["id"],
        a.owner.handle.as_deref().unwrap_or_default()
    );
    assert_eq!(
        items[0]["changes"],
        json!([{"path": "copy.title", "before": null, "after": "Welcome back"}])
    );
    assert_eq!(items[1]["version"], 3);
    assert_eq!(items[1]["actor"], "app");
    let paths: Vec<&str> = items[1]["changes"]
        .as_array()
        .expect("changes")
        .iter()
        .filter_map(|c| c["path"].as_str())
        .collect();
    assert_eq!(paths, vec!["branding.radius", "redirect_uris"]);
    assert_eq!(items[1]["changes"][0]["before"], 28);
    assert_eq!(items[1]["changes"][0]["after"], 18);
    assert!(items[2]["at"].as_str().is_some_and(|t| t.ends_with('Z')));

    let r = call(
        &ctx,
        Req::get(&format!(
            "/v1/apps/{}/signin-config/history?limit=1",
            a.app_id
        ))
        .basic(&a.app_id, &a.secret),
    )
    .await;
    let cursor = r.json["next_cursor"].as_str().expect("cursor").to_string();
    let r = call(
        &ctx,
        Req::get(&format!(
            "/v1/apps/{}/signin-config/history?limit=5&cursor={cursor}",
            a.app_id
        ))
        .basic(&a.app_id, &a.secret),
    )
    .await;
    assert_eq!(r.json["items"][0]["version"], 3);
}

#[tokio::test]
async fn validation_errors_name_the_field() {
    let ctx = TestContext::new().await;
    let a = owned_app(&ctx, "val").await;
    let cases = [
        (
            json!({"branding": {"light": {"primary": "blue"}}}),
            "branding.light.primary",
            "#RRGGBB",
        ),
        (
            json!({"branding": {"colour": "red"}}),
            "branding.colour",
            "unknown field",
        ),
        (
            json!({"branding": {"radius": 99}}),
            "branding.radius",
            "between 0 and 40",
        ),
        (
            json!({"branding": {"theme": "neon"}}),
            "branding.theme",
            "auto, light, dark",
        ),
        (
            json!({"redirect_uris": ["http://example.com/cb"]}),
            "redirect_uris[0]",
            "only https",
        ),
        (
            json!({"methods": {"email": false}}),
            "methods",
            "at least one",
        ),
        (
            json!({"required_fields": ["email"], "optional_fields": ["email"]}),
            "optional_fields",
            "either required or optional",
        ),
        (
            json!({"expected_version": "two"}),
            "expected_version",
            "config_version",
        ),
        (
            json!({"google": {"client_secret": 42}}),
            "google.client_secret",
            "string",
        ),
    ];
    for (body, field, fragment) in cases {
        let r = call(&ctx, patch(&a.app_id, &a.secret, body.clone())).await;
        assert_eq!(r.status, 422, "{body}: {}", r.json);
        assert_eq!(r.error_code(), Some("validation_failed"));
        let msg = r.json["error"]["details"]["fields"][field]
            .as_str()
            .unwrap_or_else(|| panic!("{body}: {}", r.json));
        assert!(msg.contains(fragment), "{body}: {msg}");
    }

    // Text contrast below 4.5:1 (WCAG AA) is refused with the measured ratio.
    let r = call(
        &ctx,
        patch(
            &a.app_id,
            &a.secret,
            json!({"branding": {"dark": {"primary": "#FFFFFF", "primary_foreground": "#EEEEEE"}}}),
        ),
    )
    .await;
    let msg = r.json["error"]["details"]["fields"]["branding.dark.primary_foreground"]
        .as_str()
        .expect("contrast error");
    assert!(
        msg.contains("1.16:1") && msg.contains("at least 4.5:1"),
        "{msg}"
    );
    // The old default dark pair (#FFFDF9 on #5B8FE0, 3.2:1) is below the bar too.
    let r = call(
        &ctx,
        patch(
            &a.app_id,
            &a.secret,
            json!({"branding": {"dark": {"primary": "#5B8FE0", "primary_foreground": "#FFFDF9"}}}),
        ),
    )
    .await;
    assert_eq!(r.status, 422, "{}", r.json);
    assert!(
        r.json["error"]["details"]["fields"]["branding.dark.primary_foreground"]
            .as_str()
            .is_some_and(|m| m.contains("3.20:1")),
        "{}",
        r.json
    );

    // Not an object, not JSON.
    let r = call(&ctx, patch(&a.app_id, &a.secret, json!([1, 2]))).await;
    assert_eq!(r.status, 422);
    let r = call(
        &ctx,
        common::raw(
            Req::patch(&format!("/v1/apps/{}/signin-config", a.app_id)).basic(&a.app_id, &a.secret),
            "application/json",
            "{nope",
        ),
    )
    .await;
    assert_eq!(r.error_code(), Some("invalid_json"));

    // Nothing was stored by any failed attempt.
    let r = call(
        &ctx,
        Req::get(&format!("/v1/apps/{}", a.app_id)).basic(&a.app_id, &a.secret),
    )
    .await;
    assert_eq!(r.json["config_version"], 1);
}

#[tokio::test]
async fn expected_version_guards_against_lost_updates() {
    let ctx = TestContext::new().await;
    let a = owned_app(&ctx, "ver").await;
    let r = call(
        &ctx,
        patch(
            &a.app_id,
            &a.secret,
            json!({"expected_version": 1, "branding": {"radius": 10}}),
        ),
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(r.json["config_version"], 2);
    let r = call(
        &ctx,
        patch(
            &a.app_id,
            &a.secret,
            json!({"expected_version": 1, "branding": {"radius": 12}}),
        ),
    )
    .await;
    assert_eq!(r.status, 409);
    assert_eq!(r.error_code(), Some("config_version_conflict"));
    assert_eq!(r.json["error"]["details"]["current_version"], 2);
    assert_eq!(r.json["error"]["details"]["expected_version"], 1);
    // The hint names the app's own endpoint, never a `{app_id}` placeholder.
    assert_eq!(
        r.json["error"]["hint"],
        format!(
            "GET /v1/apps/{} for the current config and config_version, re-apply your change, and send it again.",
            a.app_id
        ),
        "{}",
        r.json
    );
}

#[tokio::test]
async fn byo_secrets_are_encrypted_masked_and_never_in_history() {
    let ctx = TestContext::new().await;
    let a = owned_app(&ctx, "byo").await;
    let google_secret = "GOCSPX-super-secret-value";

    // BYO without its secret is refused.
    let r = call(
        &ctx,
        patch(&a.app_id, &a.secret, json!({"methods": {"google": true}, "google": {"mode": "byo", "client_id": "1-x.apps.googleusercontent.com"}})),
    )
    .await;
    assert_eq!(r.status, 422);
    assert!(r.json["error"]["details"]["fields"]["google.client_secret"].is_string());

    let r = call(
        &ctx,
        patch(&a.app_id, &a.secret, json!({
            "methods": {"google": true, "apple": true},
            "google": {"mode": "byo", "client_id": "1-x.apps.googleusercontent.com", "client_secret": google_secret},
            "apple": {"mode": "byo", "services_id": "com.example.signin", "team_id": "ABCDEFGHIJ", "key_id": "KEY1234567", "private_key": P8}
        })),
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.json);
    let body = r.json.to_string();
    assert!(
        !body.contains(google_secret) && !body.contains("BEGIN PRIVATE KEY"),
        "secrets never come back"
    );
    assert_eq!(r.json["signin_config"]["google"]["client_secret_set"], true);
    assert_eq!(r.json["signin_config"]["apple"]["private_key_set"], true);
    assert_eq!(
        r.json["signin_config"]["google"]["client_id"],
        "1-x.apps.googleusercontent.com"
    );
    let methods = call(&ctx, Req::get(&format!("/v1/apps/{}/public", a.app_id)))
        .await
        .json["methods"]
        .clone();
    assert_eq!(
        methods,
        json!(["google", "apple", "email"]),
        "BYO providers show without managed credentials"
    );

    // Stored encrypted, outside the document.
    let (config, g_enc, a_enc): (Value, Option<Vec<u8>>, Option<Vec<u8>>) = sqlx::query_as(
        "select config, google_client_secret_enc, apple_private_key_enc from app_signin_configs where app_id = $1",
    )
    .bind(&a.app_id)
    .fetch_one(&ctx.state.db)
    .await
    .expect("row");
    assert!(!config.to_string().contains(google_secret));
    assert!(config["google"].get("client_secret").is_none());
    let g_enc = g_enc.expect("google secret stored");
    assert!(!String::from_utf8_lossy(&g_enc).contains(google_secret));
    assert_eq!(
        ctx.state
            .keys
            .keyring
            .decrypt_string(&g_enc)
            .expect("decrypt"),
        google_secret
    );
    assert_eq!(
        ctx.state
            .keys
            .keyring
            .decrypt_string(&a_enc.expect("apple"))
            .expect("decrypt"),
        P8
    );

    // History shows that the secrets changed, never their values.
    let r = call(
        &ctx,
        Req::get(&format!("/v1/apps/{}/signin-config/history", a.app_id))
            .basic(&a.app_id, &a.secret),
    )
    .await;
    let history = r.json.to_string();
    assert!(!history.contains(google_secret) && !history.contains("BEGIN PRIVATE KEY"));
    let changes = r.json["items"][0]["changes"]
        .as_array()
        .expect("changes")
        .clone();
    let secret_change = changes
        .iter()
        .find(|c| c["path"] == "google.client_secret")
        .expect("secret change recorded");
    assert_eq!(secret_change["before"], Value::Null);
    assert_eq!(secret_change["after"], "[redacted]");
    assert_eq!(secret_change["secret"], true);

    // A GET body echoed back (with the read-only *_set masks) is accepted; nothing changes.
    let details = call(
        &ctx,
        Req::get(&format!("/v1/apps/{}", a.app_id)).basic(&a.app_id, &a.secret),
    )
    .await
    .json;
    let mut echoed = details["signin_config"].clone();
    echoed["expected_version"] = details["config_version"].clone();
    let r = call(&ctx, patch(&a.app_id, &a.secret, echoed)).await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(r.json["config_version"], details["config_version"]);

    // Bad key, removing a secret BYO still needs, then switching back to managed.
    let r = call(&ctx, patch(&a.app_id, &a.secret, json!({"apple": {"private_key": "-----BEGIN PRIVATE KEY-----\nnope\n-----END PRIVATE KEY-----"}}))).await;
    assert_eq!(r.status, 422);
    assert!(r.json["error"]["details"]["fields"]["apple.private_key"].is_string());
    let r = call(
        &ctx,
        patch(
            &a.app_id,
            &a.secret,
            json!({"google": {"client_secret": null}}),
        ),
    )
    .await;
    assert_eq!(r.status, 422);
    assert!(
        r.json["error"]["details"]["fields"]["google.client_secret"]
            .as_str()
            .is_some_and(|m| m.contains("required"))
    );
    let r = call(
        &ctx,
        patch(
            &a.app_id,
            &a.secret,
            json!({"google": {"mode": "managed", "client_secret": null}}),
        ),
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(
        r.json["signin_config"]["google"]["client_secret_set"],
        false
    );
}

#[tokio::test]
async fn idempotency_and_auth_rules() {
    let ctx = TestContext::new().await;
    let a = owned_app(&ctx, "idem").await;
    let other = owned_app(&ctx, "idem-o").await;
    let body = json!({"branding": {"radius": 30}});
    let first = call(
        &ctx,
        patch(&a.app_id, &a.secret, body.clone()).header("idempotency-key", "k-1"),
    )
    .await;
    assert_eq!(first.status, 200);
    assert_eq!(first.json["config_version"], 2);
    let again = call(
        &ctx,
        patch(&a.app_id, &a.secret, body).header("idempotency-key", "k-1"),
    )
    .await;
    assert_eq!(again.status, 200);
    assert_eq!(again.headers["idempotent-replayed"], "true");
    assert_eq!(again.json["config_version"], 2);
    let reused = call(
        &ctx,
        patch(&a.app_id, &a.secret, json!({"branding": {"radius": 31}}))
            .header("idempotency-key", "k-1"),
    )
    .await;
    assert_eq!(reused.status, 409);
    assert_eq!(reused.error_code(), Some("idempotency_key_reused"));

    // Another Carbon can't change it; a cookie without the site Origin is refused (CSRF).
    let r = call(
        &ctx,
        Req::patch(&format!("/v1/apps/{}/signin-config", a.app_id))
            .session(&ctx.state.settings, &other.cookie)
            .json(json!({"branding": {"radius": 1}})),
    )
    .await;
    assert_eq!(r.error_code(), Some("not_app_owner"));
    let r = call(
        &ctx,
        Req::patch(&format!("/v1/apps/{}/signin-config", a.app_id))
            .header("cookie", &format!("sa_session={}", a.cookie))
            .header("origin", "https://evil.example")
            .json(json!({"branding": {"radius": 1}})),
    )
    .await;
    assert_eq!(r.status, 403);
    assert_eq!(r.error_code(), Some("origin_not_allowed"));
    let r = call(
        &ctx,
        Req::patch(&format!("/v1/apps/{}/signin-config", a.app_id))
            .basic(&other.app_id, &other.secret)
            .json(json!({"branding": {"radius": 1}})),
    )
    .await;
    assert_eq!(r.error_code(), Some("app_mismatch"));
}

#[tokio::test]
async fn flows_are_part_of_the_signin_setup() {
    let ctx = TestContext::new().await;
    let a = owned_app(&ctx, "flows").await;
    let r = call(
        &ctx,
        patch(
            &a.app_id,
            &a.secret,
            json!({
                "required_fields": ["email", "phone"],
                "optional_fields": ["dob", "timezone"],
                "flow": {"steps": [
                    {"id": "contact", "fields": ["email", "phone"], "title": "How can we reach you?"},
                    {"id": "about-you", "fields": ["dob", "timezone"], "continue_label": "Finish", "layout": "split"}
                ], "review": true},
                "copy": {"opening_title": "Opening {provider} for {app}…", "signup_title": "Create your account"}
            }),
        ),
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.json);
    let flow = &r.json["signin_config"]["flow"];
    assert_eq!(flow["review"], true);
    assert_eq!(flow["steps"][0]["id"], "contact");
    assert_eq!(
        flow["steps"][1],
        json!({"id": "about-you", "fields": ["dob", "timezone"], "title": null, "subtitle": null, "continue_label": "Finish", "layout": "split"})
    );
    assert_eq!(
        r.json["signin_config"]["copy"]["opening_title"],
        "Opening {provider} for {app}…"
    );

    // Dropping details keeps the flow valid: phone leaves its page, the emptied page goes.
    let r = call(
        &ctx,
        patch(
            &a.app_id,
            &a.secret,
            json!({"required_fields": ["email"], "optional_fields": []}),
        ),
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(
        r.json["signin_config"]["flow"]["steps"],
        json!([{"id": "contact", "fields": ["email"], "title": "How can we reach you?", "subtitle": null, "continue_label": null, "layout": null}])
    );
    let r = call(
        &ctx,
        Req::get(&format!(
            "/v1/apps/{}/signin-config/history?limit=1",
            a.app_id
        ))
        .basic(&a.app_id, &a.secret),
    )
    .await;
    let paths: Vec<&str> = r.json["items"][0]["changes"]
        .as_array()
        .expect("changes")
        .iter()
        .filter_map(|c| c["path"].as_str())
        .collect();
    assert_eq!(
        paths,
        vec!["flow.steps", "optional_fields", "required_fields"],
        "the flow change is part of the same version"
    );

    // A flow that doesn't match the details is refused with paths.
    let r = call(
        &ctx,
        patch(
            &a.app_id,
            &a.secret,
            json!({"flow": {"steps": [{"id": "x", "fields": ["email", "dob"]}, {"id": "x", "fields": []}], "review": "yes"}}),
        ),
    )
    .await;
    assert_eq!(r.status, 422, "{}", r.json);
    let fields = &r.json["error"]["details"]["fields"];
    assert!(fields["flow.review"].is_string(), "{fields}");
    let r = call(
        &ctx,
        patch(
            &a.app_id,
            &a.secret,
            json!({"flow": {"steps": [{"id": "x", "fields": ["email", "dob"]}, {"id": "x", "fields": []}]}}),
        ),
    )
    .await;
    assert_eq!(r.status, 422, "{}", r.json);
    let fields = &r.json["error"]["details"]["fields"];
    assert!(
        fields["flow.steps[0].fields[1]"]
            .as_str()
            .is_some_and(|m| m.contains("not one of the app's details")),
        "{fields}"
    );
    assert!(fields["flow.steps[1].id"].is_string(), "{fields}");
    assert!(fields["flow.steps[1].fields"].is_string(), "{fields}");
    let r = call(
        &ctx,
        patch(
            &a.app_id,
            &a.secret,
            json!({"copy": {"opening_title": "Opening {service}"}}),
        ),
    )
    .await;
    assert_eq!(r.status, 422);
    assert!(r.json["error"]["details"]["fields"]["copy.opening_title"].is_string());

    // null goes back to the default flow (one page with every detail).
    let r = call(&ctx, patch(&a.app_id, &a.secret, json!({"flow": null}))).await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(r.json["signin_config"]["flow"], serde_json::Value::Null);

    // The public config carries the new copy for the embed and the opening page.
    let r = call(&ctx, Req::get(&format!("/v1/apps/{}/public", a.app_id))).await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(r.json["copy"]["signup_title"], "Create your account");
}
