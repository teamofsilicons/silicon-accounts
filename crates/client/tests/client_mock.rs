//! The client against an in-process mock of the Silicon Accounts API.

#![allow(clippy::unwrap_used)]

mod common;

use std::time::Duration;

use common::{Mock, Reply};
use serde_json::json;
use silicon_accounts_client::{
    AccountKind, AccountsClient, Contact, CreateSilicon, DevicePoll, Error, ImportInput,
    ImportOptions, IssueAppVerification, MAX_IMPORT_BYTES, ProofVerification, SiliconSelfCreate,
    WaitEvent, WaitOptions,
};

fn token_body(aud_id: &str) -> serde_json::Value {
    json!({
        "access_token": "eyJ.header.sig", "token_type": "Bearer", "expires_in": 1800,
        "refresh_token": "sar_refresh", "refresh_token_expires_at": "2029-03-24T12:00:00.000Z",
        "scope": "profile", "membership_id": format!("silicon-accounts:{aud_id}"),
        "account": {"uuid": aud_id, "membership_id": format!("silicon-accounts:{aud_id}"), "kind": "silicon",
                    "id": "si:scout", "display_name": "Scout", "pfp_url": "https://iris.example/pfp", "version": 3,
                    "custodian": {"uuid": "a8K", "id": "c:saket"}}
    })
}

#[tokio::test]
async fn decodes_api_errors_with_hint_details_and_request_id() {
    let mock = Mock::start().await;
    mock.on(
        "POST",
        "/v1/silicons/login",
        Reply::json(
            403,
            json!({"error": {"code": "custodian_pending",
                "message": "Silicon si:scout can't sign in yet: its custodian c:saket hasn't accepted the request.",
                "hint": "Wait for c:saket to accept on accounts.teamofsilicons.com.",
                "details": {"request_id": "r-details"}}}),
        )
        .header("x-request-id", "r-header"),
    );
    let client = AccountsClient::new(&mock.url).unwrap();
    let err = client
        .silicon_login("si:scout", "stk-0123456789ab", Some("test"))
        .await
        .unwrap_err();
    assert_eq!(err.code(), "custodian_pending");
    assert_eq!(err.status(), Some(403));
    assert_eq!(err.request_id(), Some("r-header"));
    assert_eq!(
        err.to_string(),
        "Silicon si:scout can't sign in yet: its custodian c:saket hasn't accepted the request. Hint: Wait for c:saket to accept on accounts.teamofsilicons.com."
    );
    let sent = &mock.requests_to("POST", "/v1/silicons/login")[0];
    assert_eq!(
        sent.json(),
        json!({"id": "si:scout", "stk": "stk-0123456789ab", "client_label": "test"})
    );

    // 422 with field errors, 429 with Retry-After.
    mock.on(
        "PATCH",
        "/v1/me",
        Reply::json(422, json!({"error": {"code": "validation_failed", "message": "The profile is invalid.", "details": {"fields": {"timezone": "`Mars/Base` is not an IANA timezone"}}}})),
    );
    let session = client.with_token("tok");
    let err = session
        .update_me(&silicon_accounts_client::ProfileUpdate {
            timezone: Some("Mars/Base".into()),
            ..Default::default()
        })
        .await
        .unwrap_err();
    assert_eq!(
        err.as_api().unwrap().field_errors(),
        vec![(
            "timezone".to_owned(),
            "`Mars/Base` is not an IANA timezone".to_owned()
        )]
    );

    mock.on(
        "POST",
        "/v1/cli/login/start",
        Reply::json(429, json!({"error": {"code": "rate_limited", "message": "Too many codes.", "hint": "Wait."}})).header("retry-after", "120"),
    );
    let err = client
        .cli_login_start(&Contact::Email("a@b.test".into()))
        .await
        .unwrap_err();
    assert_eq!(err.retry_after(), Some(Duration::from_secs(120)));
}

#[tokio::test]
async fn oauth_errors_and_foreign_bodies_are_typed() {
    let mock = Mock::start().await;
    mock.on(
        "POST",
        "/v1/oauth/token",
        Reply::json(400, json!({"error": "invalid_grant", "error_description": "The refresh token sar_… was already used; the whole family is now revoked."})),
    );
    let client = AccountsClient::new(&mock.url).unwrap();
    let err = client.refresh_first_party("sar_old").await.unwrap_err();
    let oauth = err.as_oauth().unwrap();
    assert_eq!(oauth.error, "invalid_grant");
    assert!(err.is_unauthenticated());
    assert!(err.to_string().contains("already used"));
    let form = mock.requests_to("POST", "/v1/oauth/token")[0].form();
    assert_eq!(
        form.get("grant_type").map(String::as_str),
        Some("refresh_token")
    );
    assert_eq!(
        form.get("client_id").map(String::as_str),
        Some("silicon-accounts")
    );

    // A proxy page instead of the API: GETs are retried, then reported precisely.
    mock.on(
        "GET",
        "/v1/meta",
        Reply::text(502, "<html><body>Bad Gateway</body></html>"),
    );
    let client = AccountsClient::builder()
        .base_url(&mock.url)
        .max_retries(1)
        .build()
        .unwrap();
    let err = client.meta().await.unwrap_err();
    assert_eq!(err.code(), "http_502");
    assert!(err.message().contains("Bad Gateway"), "{err}");
    assert_eq!(
        mock.requests_to("GET", "/v1/meta").len(),
        2,
        "one retry for a GET"
    );
}

#[tokio::test]
async fn transient_failures_are_retried_only_when_safe() {
    let mock = Mock::start().await;
    mock.on(
        "GET",
        "/v1/me",
        Reply::json(
            503,
            json!({"error": {"code": "unavailable", "message": "Starting up."}}),
        ),
    );
    mock.on("GET", "/v1/me", Reply::json(200, json!({"uuid": "a8K", "kind": "carbon", "id": "c:saket", "display_name": "Saket", "pfp_url": "", "timezone": "UTC", "status": "active"})));
    let client = AccountsClient::new(&mock.url).unwrap();
    let me = client.with_token("t").me().await.unwrap();
    assert_eq!(me.id, "c:saket");
    assert_eq!(mock.requests_to("GET", "/v1/me").len(), 2);

    // POST without an idempotency key is never retried on a 503.
    mock.on(
        "POST",
        "/v1/me/short-lived-tokens",
        Reply::json(
            503,
            json!({"error": {"code": "unavailable", "message": "Starting up."}}),
        ),
    );
    let err = client
        .with_token("t")
        .short_lived_token("remind")
        .await
        .unwrap_err();
    assert_eq!(err.status(), Some(503));
    assert_eq!(
        mock.requests_to("POST", "/v1/me/short-lived-tokens").len(),
        1
    );
}

#[tokio::test]
async fn connection_failures_name_the_url_and_a_fix() {
    // Bind and drop a listener to get a port nobody listens on.
    let port = {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.local_addr().unwrap().port()
    };
    let client = AccountsClient::builder()
        .base_url(format!("http://127.0.0.1:{port}"))
        .max_retries(0)
        .build()
        .unwrap();
    let err = client.meta().await.unwrap_err();
    assert!(matches!(err, Error::Http { .. }));
    assert_eq!(err.code(), "connection_failed");
    assert!(
        err.message().contains(&format!("127.0.0.1:{port}")),
        "{err}"
    );
    assert!(err.hint().unwrap().contains("--url"), "{err}");
}

#[tokio::test]
async fn device_poll_maps_every_state() {
    let mock = Mock::start().await;
    let client = AccountsClient::new(&mock.url).unwrap();
    for (error, expected) in [
        ("authorization_pending", DevicePoll::Pending),
        ("slow_down", DevicePoll::SlowDown),
        ("access_denied", DevicePoll::Denied),
        ("expired_token", DevicePoll::Expired),
    ] {
        let mock = Mock::start().await;
        mock.on(
            "POST",
            "/v1/oauth/token",
            Reply::json(400, json!({"error": error, "error_description": "x"})),
        );
        let client = AccountsClient::new(&mock.url).unwrap();
        assert_eq!(
            client.device_poll("sad_x").await.unwrap(),
            expected,
            "{error}"
        );
        let form = mock.requests()[0].form();
        assert_eq!(
            form["grant_type"],
            "urn:ietf:params:oauth:grant-type:device_code"
        );
        assert_eq!(form["device_code"], "sad_x");
        assert_eq!(form["client_id"], "silicon-accounts");
    }
    mock.on(
        "POST",
        "/v1/oauth/token",
        Reply::json(400, json!({"error": "invalid_client"})),
    );
    assert!(client.device_poll("sad_x").await.is_err());
}

#[tokio::test]
async fn waits_for_device_approval() {
    let mock = Mock::start().await;
    mock.on(
        "POST",
        "/v1/device/authorize",
        Reply::json(200, json!({"device_code": "sad_dev", "user_code": "WDJB-MJHT", "verification_uri": format!("{}/device", "http://x"),
            "verification_uri_complete": "http://x/device?code=WDJB-MJHT", "expires_in": 600, "interval": 1})),
    );
    mock.on(
        "POST",
        "/v1/oauth/token",
        Reply::json(400, json!({"error": "authorization_pending"})),
    );
    mock.on(
        "POST",
        "/v1/oauth/token",
        Reply::json(200, token_body("b9Z")),
    );
    let client = AccountsClient::new(&mock.url).unwrap();
    let device = client
        .device_authorize(Some("silicon-accounts CLI on test"))
        .await
        .unwrap();
    assert_eq!(device.user_code, "WDJB-MJHT");
    assert_eq!(device.browser_url(), "http://x/device?code=WDJB-MJHT");
    assert!(
        !format!("{device:?}").contains("sad_dev"),
        "Debug must not leak the device code"
    );
    let mut polls = 0;
    let tokens = client
        .wait_for_device_tokens(&device, |event| {
            if let WaitEvent::Polled(DevicePoll::Pending) = event {
                polls += 1;
            }
        })
        .await
        .unwrap();
    assert_eq!(polls, 1);
    assert_eq!(tokens.refresh_token.unwrap().expose(), "sar_refresh");
    let account = tokens.account.unwrap();
    assert_eq!(account.kind, AccountKind::Silicon);
    assert_eq!(account.custodian.unwrap().id, "c:saket");

    // A denial ends the wait with a precise OAuth error.
    let denied = Mock::start().await;
    denied.on(
        "POST",
        "/v1/oauth/token",
        Reply::json(400, json!({"error": "access_denied"})),
    );
    let client = AccountsClient::new(&denied.url).unwrap();
    let err = client
        .wait_for_device_tokens(&device, |_| {})
        .await
        .unwrap_err();
    assert_eq!(err.code(), "access_denied");
    assert!(err.message().contains("WDJB-MJHT"), "{err}");
}

#[tokio::test]
async fn idempotency_keys_and_telemetry_opt_out_are_sent() {
    let mock = Mock::start().await;
    mock.on(
        "POST",
        "/v1/silicons",
        Reply::json(201, json!({
            "silicon": {"uuid": "b9Z", "kind": "silicon", "id": "si:scout", "display_name": "Scout", "pfp_url": "", "timezone": "UTC", "status": "pending_custodian"},
            "stk": "stk-0123456789ab",
            "request": {"id": "req-1", "status": "pending", "expires_at": "2026-10-20T10:00:00.000Z", "custodian": "c:saket"},
            "request_token": "sarq_poll", "webhook_secret": null
        })),
    );
    let client = AccountsClient::builder()
        .base_url(&mock.url)
        .telemetry(false)
        .build()
        .unwrap();
    let created = client
        .silicon_self_create(
            &SiliconSelfCreate {
                id: "si:scout".into(),
                display_name: "Scout".into(),
                custodian: "c:saket".into(),
                ..Default::default()
            },
            Some("key-123"),
        )
        .await
        .unwrap();
    assert_eq!(created.stk.as_ref().unwrap().expose(), "stk-0123456789ab");
    assert_eq!(created.request.id, "req-1");
    assert!(
        !format!("{created:?}").contains("stk-0123456789ab"),
        "Debug must not leak the STK"
    );
    let sent = &mock.requests_to("POST", "/v1/silicons")[0];
    assert_eq!(sent.header("idempotency-key"), Some("key-123"));
    assert_eq!(sent.header("x-accounts-telemetry"), Some("off"));
    assert_eq!(
        sent.json(),
        json!({"id": "si:scout", "display_name": "Scout", "custodian": "c:saket"})
    );

    // Invalid keys never leave the machine.
    let err = client
        .with_token("t")
        .create_silicon(
            &CreateSilicon {
                id: "si:x".into(),
                display_name: "X".into(),
                ..Default::default()
            },
            Some("bad key"),
        )
        .await
        .unwrap_err();
    assert_eq!(err.code(), "invalid_input");
    assert!(mock.requests_to("POST", "/v1/me/silicons").is_empty());

    // Telemetry is not sent at all when disabled.
    let event = silicon_accounts_client::TelemetryEvent {
        source: "cli".into(),
        step: "test".into(),
        name: "cli.test".into(),
        progress: Some(1.0),
        data: serde_json::Value::Null,
    };
    client
        .send_telemetry(std::slice::from_ref(&event))
        .await
        .unwrap();
    assert!(mock.requests_to("POST", "/v1/telemetry/events").is_empty());
    mock.on("POST", "/v1/telemetry/events", Reply::empty(202));
    let enabled = AccountsClient::new(&mock.url).unwrap();
    enabled.send_telemetry(&[event]).await.unwrap();
    assert_eq!(
        mock.requests_to("POST", "/v1/telemetry/events")[0].json()["events"][0]["name"],
        "cli.test"
    );
}

#[tokio::test]
async fn app_credentials_proofs_and_owner_mode() {
    let mock = Mock::start().await;
    mock.on(
        "POST",
        "/v1/proofs/verify",
        Reply::json(200, json!({"valid": true, "proof_id": "p1", "kind": "user_verification", "expires_at": "2026-10-06T12:30:00.000Z",
            "issuing_app": {"app_id": "dm", "name": "DM"}, "receiving_app": {"app_id": "briefcase", "name": "Briefcase"},
            "user": {"uuid": "a8K", "id": "c:saket", "kind": "carbon", "membership_id": "dm:a8K"}, "scopes": ["files.write"]})),
    );
    mock.on(
        "POST",
        "/v1/proofs/verify",
        Reply::json(200, json!({"valid": false, "expires_at": null})),
    );
    let client = AccountsClient::new(&mock.url).unwrap();
    let app = client.as_app("briefcase", "sa_app_briefcase_secret");
    let first = app.verify_proof("sap_token").await.unwrap();
    let valid = first.valid().unwrap();
    assert_eq!(valid.issuing_app.app_id, "dm");
    assert_eq!(
        valid.user.as_ref().unwrap().membership_id.as_deref(),
        Some("dm:a8K")
    );
    assert_eq!(
        app.verify_proof("sap_token").await.unwrap(),
        ProofVerification::Invalid
    );
    let sent = &mock.requests_to("POST", "/v1/proofs/verify")[0];
    // base64("briefcase:sa_app_briefcase_secret")
    assert_eq!(
        sent.header("authorization"),
        Some("Basic YnJpZWZjYXNlOnNhX2FwcF9icmllZmNhc2Vfc2VjcmV0")
    );
    assert_eq!(sent.json(), json!({"proof_token": "sap_token"}));

    // Owner mode: app-or-owner endpoints use the owner's bearer token…
    mock.on(
        "POST",
        "/v1/apps/briefcase/proofs/app-verification",
        Reply::json(201, json!({"proof_id": "p2", "kind": "app_verification", "proof_token": "sap_app_verification", "expires_at": "2026-10-06T12:30:00.000Z",
            "proof_refresh_token": "sapr_app_verification", "issuing_app": "briefcase", "receiving_app": "remind", "user": null, "scopes": []})),
    );
    let owner = client.with_token("owner-token");
    let owned = owner.app("briefcase");
    let issued = owned
        .issue_app_verification(
            &IssueAppVerification {
                receiving_app: " remind ".into(),
                ..Default::default()
            },
            None,
        )
        .await
        .unwrap();
    assert_eq!(issued.receiving_app.as_deref(), Some("remind"));
    let sent = &mock.requests_to("POST", "/v1/apps/briefcase/proofs/app-verification")[0];
    assert_eq!(sent.header("authorization"), Some("Bearer owner-token"));
    assert_eq!(sent.json(), json!({"receiving_app": "remind"}));
    // An app verification proof is for exactly one app: several are refused before anything is sent.
    for several in ["remind,waveform", "remind waveform", ""] {
        let err = owned
            .issue_app_verification(
                &IssueAppVerification {
                    receiving_app: several.into(),
                    ..Default::default()
                },
                None,
            )
            .await
            .unwrap_err();
        assert_eq!(err.code(), "invalid_input", "{several}: {err}");
    }
    assert_eq!(
        mock.requests_to("POST", "/v1/apps/briefcase/proofs/app-verification")
            .len(),
        1
    );
    // …and calls that need the app secret are refused locally with a precise error.
    let err = owned
        .exchange_code("sac_x", "https://b.example/cb", None)
        .await
        .unwrap_err();
    assert_eq!(err.code(), "invalid_input");
    assert!(
        err.message().contains("app briefcase's own credentials"),
        "{err}"
    );
    let err = owned.verify_proof("sap_x").await.unwrap_err();
    assert_eq!(err.code(), "invalid_input");
}

#[tokio::test]
async fn imports_upload_csv_and_wait_with_progress() {
    let mock = Mock::start().await;
    let job = |status: &str, processed: u64| {
        json!({"id": "job-1", "status": status, "format": "csv", "total_rows": 4, "processed_rows": processed,
               "counts": {"created": processed, "matched": 0, "updated": 0, "skipped": 0, "error": 0, "warnings": 1},
               "created_at": "2026-10-06T12:00:00.000Z"})
    };
    mock.on(
        "POST",
        "/v1/apps/legacy-crm/imports",
        Reply::json(202, json!({"job": job("queued", 0)})),
    );
    mock.on(
        "GET",
        "/v1/apps/legacy-crm/imports/job-1",
        Reply::json(200, json!({"job": job("running", 2)})),
    );
    mock.on(
        "GET",
        "/v1/apps/legacy-crm/imports/job-1",
        Reply::json(200, job("completed", 4)),
    );
    let client = AccountsClient::new(&mock.url).unwrap();
    let app = client.as_app("legacy-crm", "sa_app_legacy");
    let options = ImportOptions {
        default_country: Some("US".into()),
        dry_run: true,
        ..Default::default()
    };
    let started = app
        .start_import(
            &ImportInput::Csv(bytes::Bytes::from_static(b"email,name\na@b.test,A\n")),
            &options,
            Some("imp-1"),
        )
        .await
        .unwrap();
    assert_eq!(started.status, "queued");
    let sent = &mock.requests_to("POST", "/v1/apps/legacy-crm/imports")[0];
    assert_eq!(sent.header("content-type"), Some("text/csv"));
    assert_eq!(sent.header("idempotency-key"), Some("imp-1"));
    let query = sent.query.clone().unwrap();
    assert!(
        query.contains("default_country=US") && query.contains("dry_run=true"),
        "{query}"
    );

    let mut seen = Vec::new();
    let done = app
        .wait_for_import_with(
            "job-1",
            &WaitOptions::fixed(Duration::from_millis(20)),
            |event| {
                if let WaitEvent::Polled(job) = event {
                    seen.push((job.status.clone(), job.processed_rows));
                }
            },
        )
        .await
        .unwrap();
    assert!(done.is_finished());
    assert_eq!(done.counts.created, 4);
    assert_eq!(
        seen,
        vec![("running".to_owned(), 2), ("completed".to_owned(), 4)]
    );
}

/// An import body over 50 MB is refused before anything is sent (the service would refuse
/// it too, often before the upload ends, so the caller saw a reset connection or a proxy's
/// 500 instead of the reason); a body of exactly 50 MB is sent.
#[tokio::test]
async fn imports_over_50_mb_are_refused_before_anything_is_sent() {
    assert_eq!(MAX_IMPORT_BYTES, 52_428_800);
    let mock = Mock::start().await;
    mock.on(
        "POST",
        "/v1/apps/legacy-crm/imports",
        Reply::json(
            202,
            json!({"job": {"id": "job-1", "status": "queued", "format": "csv", "total_rows": 1, "processed_rows": 0}}),
        ),
    );
    let client = AccountsClient::new(&mock.url).unwrap();
    let app = client.as_app("legacy-crm", "sa_app_legacy");
    let options = ImportOptions {
        dry_run: true,
        ..Default::default()
    };
    let csv = |len: usize| {
        let mut body = b"email,display_name\n".to_vec();
        body.resize(len, b'a');
        ImportInput::Csv(bytes::Bytes::from(body))
    };

    let err = app
        .start_import(&csv(MAX_IMPORT_BYTES + 1), &options, Some("imp-big"))
        .await
        .unwrap_err();
    assert!(matches!(err, Error::PayloadTooLarge { .. }), "{err:?}");
    assert_eq!(err.code(), "payload_too_large");
    assert!(err.is_code("payload_too_large"));
    assert_eq!(err.status(), None);
    assert!(!err.is_transport());
    assert_eq!(
        err.message(),
        "The import is over the 50 MB limit: its CSV is 52428801 bytes (50.1 MB), and one import accepts at most 52428800 bytes, so it was not uploaded."
    );
    assert!(
        err.hint()
            .unwrap()
            .contains("files of at most 50 MB and 100,000 rows each"),
        "{err}"
    );
    assert_eq!(
        err.details(),
        Some(&json!({"size_bytes": 52_428_801, "limit_bytes": 52_428_800}))
    );

    // JSON rows count by their encoded body: 51 rows of 1 MB each.
    let rows: Vec<serde_json::Value> = (0..51)
        .map(|i| json!({"email": format!("u{i}@x.test"), "display_name": "x".repeat(1024 * 1024)}))
        .collect();
    let err = app
        .start_import(&ImportInput::Json(rows), &options, None)
        .await
        .unwrap_err();
    assert_eq!(err.code(), "payload_too_large");
    assert!(
        err.message()
            .starts_with("The import is over the 50 MB limit: its JSON body (51 rows) is "),
        "{err}"
    );
    assert!(err.details().unwrap()["size_bytes"].as_u64().unwrap() > 52_428_800);
    assert!(mock.requests().is_empty(), "nothing was sent");

    // Exactly 50 MB is within the limit: sent as it is.
    let job = app
        .start_import(&csv(MAX_IMPORT_BYTES), &options, None)
        .await
        .unwrap();
    assert_eq!(job.id, "job-1");
    let sent = mock.requests_to("POST", "/v1/apps/legacy-crm/imports");
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].body.len(), MAX_IMPORT_BYTES);
}

#[tokio::test]
async fn waits_for_custodian_and_tolerates_list_shapes() {
    let mock = Mock::start().await;
    let status = |s: &str| json!({"id": "req-1", "status": s, "expires_at": "2026-10-20T10:00:00.000Z", "decided_at": null, "silicon": {"uuid": "b9Z", "id": "si:scout", "status": "pending_custodian"}});
    mock.on(
        "GET",
        "/v1/silicons/requests/req-1",
        Reply::json(200, status("pending")),
    );
    mock.on(
        "GET",
        "/v1/silicons/requests/req-1",
        Reply::json(
            500,
            json!({"error": {"code": "internal", "message": "boom"}}),
        ),
    );
    mock.on(
        "GET",
        "/v1/silicons/requests/req-1",
        Reply::json(200, status("accepted")),
    );
    let client = AccountsClient::builder()
        .base_url(&mock.url)
        .max_retries(0)
        .build()
        .unwrap();
    let mut transient = 0;
    let decided = client
        .wait_for_custodian_decision(
            "req-1",
            "sarq_x",
            &WaitOptions::fixed(Duration::from_millis(20)),
            |event| {
                if let WaitEvent::TransientError { .. } = event {
                    transient += 1;
                }
            },
        )
        .await
        .unwrap();
    assert!(decided.is_accepted());
    assert_eq!(transient, 1);
    assert_eq!(
        mock.requests_to("GET", "/v1/silicons/requests/req-1")[0].header("authorization"),
        Some("Bearer sarq_x")
    );

    // Lists may come bare, under `items`, or under their own name.
    mock.on(
        "GET",
        "/v1/me/emails",
        Reply::json(200, json!([{"email": "a@b.test", "is_primary": true}])),
    );
    let emails = client.with_token("t").emails().await.unwrap();
    assert_eq!(emails[0].email, "a@b.test");
    mock.on(
        "GET",
        "/v1/me/phones",
        Reply::json(
            200,
            json!({"phones": [{"phone": "+15550001111", "is_primary": true}]}),
        ),
    );
    assert_eq!(
        client.with_token("t").phones().await.unwrap()[0].phone,
        "+15550001111"
    );
    mock.on(
        "GET",
        "/v1/me/silicons",
        Reply::json(200, json!({"items": [
            {"uuid": "b9Z", "kind": "silicon", "id": "si:scout", "display_name": "Scout", "pfp_url": "", "timezone": "UTC", "status": "active", "pending_transfer": null},
            {"silicon": {"uuid": "c1A", "kind": "silicon", "id": "si:helper", "display_name": "Helper", "pfp_url": "", "timezone": "UTC", "status": "active"},
             "pending_transfer": {"id": "t1", "to": {"uuid": "z9", "id": "c:shubham"}, "expires_at": "2026-10-20T10:00:00.000Z"}}
        ], "next_cursor": null})),
    );
    let silicons = client.with_token("t").silicons().await.unwrap();
    assert_eq!(silicons[0].silicon.id, "si:scout");
    assert!(silicons[0].pending_transfer.is_none());
    assert_eq!(silicons[1].silicon.id, "si:helper");
    assert_eq!(
        silicons[1].pending_transfer.as_ref().unwrap().id.as_deref(),
        Some("t1")
    );

    // A response that doesn't match is a precise decode error, not a panic.
    mock.on("GET", "/v1/meta", Reply::json(200, json!("not meta")));
    let err = client.meta().await.unwrap_err();
    assert_eq!(err.code(), "unexpected_response");
    assert!(err.message().contains("GET /v1/meta"), "{err}");
}

#[tokio::test]
async fn list_helpers_follow_cursors() {
    let mock = Mock::start().await;
    let app = |id: &str| json!({"app": {"app_id": id, "name": id}, "membership_id": format!("{id}:a8K"), "status": "active", "granted_scopes": ["profile"]});
    mock.on(
        "GET",
        "/v1/me/apps",
        Reply::json(
            200,
            json!({"items": [app("briefcase")], "next_cursor": "c2"}),
        ),
    );
    mock.on(
        "GET",
        "/v1/me/apps",
        Reply::json(200, json!({"items": [app("remind")], "next_cursor": null})),
    );
    let client = AccountsClient::new(&mock.url).unwrap();
    let apps = client.with_token("t").apps().await.unwrap();
    let ids: Vec<&str> = apps.iter().map(|a| a.app.app_id.as_str()).collect();
    assert_eq!(ids, vec!["briefcase", "remind"]);
    let calls = mock.requests_to("GET", "/v1/me/apps");
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0].query.as_deref(), Some("limit=200"));
    assert_eq!(calls[1].query.as_deref(), Some("limit=200&cursor=c2"));
}
