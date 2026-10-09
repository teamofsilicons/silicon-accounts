//! Every client call hits exactly the method and path of the HTTP API (02-api.md), with
//! the right credentials.

#![allow(clippy::unwrap_used)]

mod common;

use common::{Mock, Reply};
use serde_json::{Value, json};
use silicon_accounts_client::{
    AccountsClient, Contact, CreateSilicon, DeliveriesQuery, HistoryQuery, ImportInput,
    ImportOptions, ImportRow, ImportRowsQuery, IssueAppVerification, IssueUserVerification,
    PageRequest, ProfileUpdate, ProofRef, ProofsQuery, ReplayRequest, UpdateSilicon, UsersQuery,
};

fn me() -> Value {
    json!({"uuid": "a8K", "kind": "carbon", "id": "c:saket", "display_name": "Saket", "pfp_url": "", "timezone": "UTC", "status": "active"})
}

fn silicon() -> Value {
    json!({"uuid": "b9Z", "kind": "silicon", "id": "si:scout", "display_name": "Scout", "pfp_url": "", "timezone": "UTC", "status": "active"})
}

fn summary() -> Value {
    json!({"uuid": "a8K", "kind": "carbon", "id": "c:saket", "display_name": "Saket", "pfp_url": "", "status": "active"})
}

fn tokens() -> Value {
    json!({"access_token": "eyJ", "token_type": "Bearer", "expires_in": 1800, "refresh_token": "sar_x", "scope": "profile"})
}

fn job() -> Value {
    json!({"id": "job-1", "status": "queued", "format": "json", "total_rows": 1, "processed_rows": 0, "counts": {}})
}

fn proof() -> Value {
    json!({"proof_id": "p1", "kind": "user_verification", "proof_token": "sap_x", "proof_refresh_token": "sapr_x", "issuing_app": "dm", "receiving_app": "briefcase", "scopes": []})
}

fn app_details() -> Value {
    json!({"app_id": "briefcase", "name": "Briefcase", "status": "active", "source": "fake", "signin_config": {"methods": {"email": true}}, "config_version": 3})
}

fn page(item: Value) -> Value {
    json!({"items": [item], "next_cursor": null})
}

/// Registers the reply, then asserts the call produced exactly one request to `method path`.
macro_rules! check {
    ($mock:expr, $method:literal, $path:expr, $reply:expr, $call:expr) => {{
        let path: String = $path.to_string();
        $mock.on($method, &path, $reply);
        let before = $mock.requests_to($method, &path).len();
        if let Err(err) = $call.await {
            panic!("{} {} failed: {err}", $method, path);
        }
        let after = $mock.requests_to($method, &path);
        assert_eq!(
            after.len(),
            before + 1,
            "{} {} was not called",
            $method,
            path
        );
        after.last().cloned().unwrap()
    }};
}

#[tokio::test]
async fn public_calls() {
    let mock = Mock::start().await;
    let c = AccountsClient::new(&mock.url).unwrap();
    check!(
        mock,
        "GET",
        "/v1/meta",
        Reply::json(200, json!({"name": "Silicon Accounts"})),
        c.meta()
    );
    let r = check!(
        mock,
        "GET",
        "/v1/ids/available",
        Reply::json(200, json!({"id": "c:x", "available": true})),
        c.id_available("c:x")
    );
    assert_eq!(r.query.as_deref(), Some("id=c%3Ax"));
    check!(
        mock,
        "GET",
        "/v1/apps/briefcase/public",
        Reply::json(200, json!({"app_id": "briefcase"})),
        c.app_public("briefcase")
    );
    // Newer fields: the docs link in meta and an app's embed origins.
    let mock = Mock::start().await;
    let c = AccountsClient::new(&mock.url).unwrap();
    mock.on(
        "GET",
        "/v1/meta",
        Reply::json(
            200,
            json!({"name": "Silicon Accounts", "docs_url": "https://developers.teamofsilicons.com/docs/accounts",
                "developer_url": "https://developers.teamofsilicons.com"}),
        ),
    );
    let meta = c.meta().await.unwrap();
    assert_eq!(
        meta.docs_url.as_deref(),
        Some("https://developers.teamofsilicons.com/docs/accounts")
    );
    assert_eq!(
        meta.developer_url.as_deref(),
        Some("https://developers.teamofsilicons.com")
    );
    mock.on(
        "GET",
        "/v1/apps/orbit/public",
        Reply::json(
            200,
            json!({"app_id": "orbit", "allowed_origins": ["https://orbit.example"]}),
        ),
    );
    let public = c.app_public("orbit").await.unwrap();
    assert_eq!(public.allowed_origins, vec!["https://orbit.example"]);
    check!(
        mock,
        "GET",
        "/.well-known/jwks.json",
        Reply::json(200, json!({"keys": []})),
        c.jwks()
    );
    check!(
        mock,
        "GET",
        "/.well-known/openid-configuration",
        Reply::json(
            200,
            json!({"issuer": "i", "authorization_endpoint": "a", "token_endpoint": "t", "jwks_uri": "j"})
        ),
        c.oidc_discovery()
    );
    check!(
        mock,
        "GET",
        "/v1/silicons/requests/req-1",
        Reply::json(
            200,
            json!({"id": "req-1", "status": "pending", "silicon": {"uuid": "b9Z"}})
        ),
        c.silicon_request_status("req-1", "sarq_x")
    );
    let r = check!(
        mock,
        "POST",
        "/v1/cli/login/start",
        Reply::json(
            200,
            json!({"challenge_id": "ch", "destination": "+91***10"})
        ),
        c.cli_login_start(&Contact::Phone {
            phone: "98765 43210".into(),
            country: Some("IN".into())
        })
    );
    assert_eq!(r.json(), json!({"phone": "98765 43210", "country": "IN"}));
    let r = check!(
        mock,
        "POST",
        "/v1/cli/login/verify",
        Reply::json(200, tokens()),
        c.cli_login_verify("ch", "123456", Some("label"))
    );
    assert_eq!(
        r.json(),
        json!({"challenge_id": "ch", "code": "123456", "client_label": "label"})
    );
    let r = check!(
        mock,
        "POST",
        "/v1/oauth/revoke",
        Reply::empty(200),
        c.revoke_first_party("sar_x")
    );
    assert_eq!(r.form()["client_id"], "silicon-accounts");
    // The developer platform's public client: PKCE code exchange, refresh and revoke without
    // a secret (and nothing for other client ids).
    let r = check!(
        mock,
        "POST",
        "/v1/oauth/token",
        Reply::json(200, tokens()),
        c.exchange_developer_code(
            " sac_x ",
            "http://localhost:8600/auth/callback",
            "verifier-1"
        )
    );
    let form = r.form();
    assert_eq!(form["grant_type"], "authorization_code");
    assert_eq!(form["client_id"], "developer");
    assert_eq!(form["code"], "sac_x");
    assert_eq!(form["redirect_uri"], "http://localhost:8600/auth/callback");
    assert_eq!(form["code_verifier"], "verifier-1");
    assert!(!form.contains_key("client_secret"));
    assert!(r.header("authorization").is_none());
    let r = check!(
        mock,
        "POST",
        "/v1/oauth/token",
        Reply::json(200, tokens()),
        c.refresh_public_client("developer", "sar_dev")
    );
    assert_eq!(r.form()["client_id"], "developer");
    assert_eq!(r.form()["refresh_token"], "sar_dev");
    let r = check!(
        mock,
        "POST",
        "/v1/oauth/revoke",
        Reply::empty(200),
        c.revoke_public_client("developer", "sar_dev")
    );
    assert_eq!(r.form()["client_id"], "developer");
    assert_eq!(r.form()["token_type_hint"], "refresh_token");
    let sent_before = mock.requests_to("POST", "/v1/oauth/token").len();
    let err = c
        .refresh_public_client("briefcase", "sar_x")
        .await
        .unwrap_err();
    assert_eq!(err.code(), "invalid_input");
    let err = c
        .exchange_developer_code("sac_x", "http://localhost:8600/auth/callback", " ")
        .await
        .unwrap_err();
    assert_eq!(err.code(), "invalid_input");
    assert_eq!(
        mock.requests_to("POST", "/v1/oauth/token").len(),
        sent_before,
        "refused locally"
    );
    let r = check!(
        mock,
        "POST",
        "/v1/reports",
        Reply::json(
            201,
            json!({"report_id": "r1", "status": "queued", "recipients": 3})
        ),
        c.report(
            "broken",
            Some("https://github.com/x/y/pull/1"),
            Some("tok"),
            Some("k1")
        )
    );
    assert_eq!(r.header("authorization"), Some("Bearer tok"));
    assert_eq!(r.header("idempotency-key"), Some("k1"));
    assert_eq!(
        r.json(),
        json!({"message": "broken", "pr_url": "https://github.com/x/y/pull/1"})
    );
}

#[tokio::test]
async fn account_session_calls() {
    let mock = Mock::start().await;
    let c = AccountsClient::new(&mock.url).unwrap();
    let s = c.with_token("tok");
    let r = check!(mock, "GET", "/v1/me", Reply::json(200, me()), s.me());
    assert_eq!(r.header("authorization"), Some("Bearer tok"));
    let r = check!(
        mock,
        "PATCH",
        "/v1/me",
        Reply::json(200, me()),
        s.update_me(&ProfileUpdate {
            display_name: Some("S".into()),
            ..Default::default()
        })
    );
    assert_eq!(r.json(), json!({"display_name": "S"}));
    let r = check!(
        mock,
        "POST",
        "/v1/me/id",
        Reply::json(200, me()),
        s.change_id("c:new")
    );
    assert_eq!(r.json(), json!({"id": "c:new"}));
    let r = check!(
        mock,
        "POST",
        "/v1/me/photo",
        Reply::json(200, json!({"pfp_url": "https://x/v1/photos/1"})),
        s.set_photo(vec![0x89, b'P', b'N', b'G'], "image/png")
    );
    assert_eq!(r.header("content-type"), Some("image/png"));
    check!(
        mock,
        "DELETE",
        "/v1/me/photo",
        Reply::empty(204),
        s.remove_photo()
    );
    check!(
        mock,
        "GET",
        "/v1/me/emails",
        Reply::json(200, json!({"items": []})),
        s.emails()
    );
    check!(
        mock,
        "POST",
        "/v1/me/emails",
        Reply::json(200, json!({"challenge_id": "ch"})),
        s.add_email("a@b.test")
    );
    check!(
        mock,
        "POST",
        "/v1/me/emails/verify",
        Reply::json(200, json!([])),
        s.verify_email("ch", "123456")
    );
    check!(
        mock,
        "POST",
        "/v1/me/emails/a+b@b.test/primary",
        Reply::json(200, json!({"emails": []})),
        s.make_email_primary("a+b@b.test")
    );
    check!(
        mock,
        "DELETE",
        "/v1/me/emails/a@b.test",
        Reply::empty(204),
        s.remove_email("a@b.test")
    );
    check!(
        mock,
        "GET",
        "/v1/me/phones",
        Reply::json(200, json!([])),
        s.phones()
    );
    check!(
        mock,
        "POST",
        "/v1/me/phones",
        Reply::json(200, json!({"challenge_id": "ch"})),
        s.add_phone("+15550001111", None)
    );
    check!(
        mock,
        "POST",
        "/v1/me/phones/verify",
        Reply::json(200, json!([])),
        s.verify_phone("ch", "123456")
    );
    check!(
        mock,
        "POST",
        "/v1/me/phones/+15550001111/primary",
        Reply::json(200, json!([])),
        s.make_phone_primary("+15550001111")
    );
    check!(
        mock,
        "DELETE",
        "/v1/me/phones/+15550001111",
        Reply::json(200, json!([])),
        s.remove_phone("+15550001111")
    );
    check!(
        mock,
        "GET",
        "/v1/me/identities",
        Reply::json(200, json!([])),
        s.identities()
    );
    check!(
        mock,
        "DELETE",
        "/v1/me/identities/google/123",
        Reply::empty(204),
        s.remove_identity("google", "123")
    );
    check!(
        mock,
        "GET",
        "/v1/me/apps",
        Reply::json(200, json!({"items": []})),
        s.apps()
    );
    check!(
        mock,
        "DELETE",
        "/v1/me/apps/briefcase",
        Reply::empty(204),
        s.remove_app_access("briefcase")
    );
    check!(
        mock,
        "GET",
        "/v1/me/sessions",
        Reply::json(200, json!({"items": []})),
        s.sessions()
    );
    check!(
        mock,
        "DELETE",
        "/v1/me/sessions/s1",
        Reply::empty(204),
        s.revoke_session("s1")
    );
    let r = check!(
        mock,
        "GET",
        "/v1/me/history",
        Reply::json(200, json!({"items": []})),
        s.history(&HistoryQuery {
            kind: Some("signin".into()),
            limit: Some(20),
            cursor: None
        })
    );
    assert_eq!(r.query.as_deref(), Some("kind=signin&limit=20"));
    let r = check!(
        mock,
        "DELETE",
        "/v1/me",
        Reply::empty(204),
        s.delete_account("c:saket")
    );
    assert_eq!(r.json(), json!({"confirm": "c:saket"}));
    let r = check!(
        mock,
        "POST",
        "/v1/me/short-lived-tokens",
        Reply::json(
            201,
            json!({"slt": "slt_x", "app_id": "remind", "expires_at": "2026-10-06T12:02:00.000Z"})
        ),
        s.short_lived_token("remind")
    );
    assert_eq!(r.json(), json!({"app_id": "remind"}));
    check!(
        mock,
        "GET",
        "/v1/me/proofs",
        Reply::json(200, json!({"items": []})),
        s.proofs()
    );
    check!(
        mock,
        "DELETE",
        "/v1/me/proofs/p1",
        Reply::empty(204),
        s.revoke_proof("p1")
    );
    check!(
        mock,
        "PUT",
        "/v1/me/webhook",
        Reply::json(
            200,
            json!({"webhook_url": "https://x", "webhook_secret": "whsec_x"})
        ),
        s.set_my_webhook("https://x")
    );
    check!(
        mock,
        "DELETE",
        "/v1/me/webhook",
        Reply::empty(204),
        s.remove_my_webhook()
    );
    check!(
        mock,
        "POST",
        "/v1/me/webhook/test",
        Reply::json(200, json!({"event_id": "e1"})),
        s.test_my_webhook()
    );
    // A Silicon's own webhook deliveries: list, inspect, replay (as for an app's webhook).
    let r = check!(
        mock,
        "GET",
        "/v1/me/webhook/deliveries",
        Reply::json(
            200,
            json!({"items": [{"id": "d1", "status": "failed"}], "next_cursor": null})
        ),
        s.my_webhook_deliveries(&DeliveriesQuery {
            status: Some("failed".into()),
            limit: Some(5),
            ..Default::default()
        })
    );
    assert_eq!(r.query.as_deref(), Some("status=failed&limit=5"));
    check!(
        mock,
        "GET",
        "/v1/me/webhook/deliveries/d1",
        Reply::json(
            200,
            json!({"id": "d1", "attempts": [{"status_code": 503}], "payload": {"type": "silicon.updated"}, "payload_redacted": false})
        ),
        s.my_webhook_delivery(" d1 ")
    );
    let r = check!(
        mock,
        "POST",
        "/v1/me/webhook/replay",
        Reply::json(
            200,
            json!({"replayed": ["d1"], "skipped": [], "remaining": 0, "not_replayable": 0, "url": "https://x"})
        ),
        s.replay_my_webhook(
            &ReplayRequest::Deliveries(vec!["d1".into()]),
            Some("rp-own-1")
        )
    );
    assert_eq!(r.json(), json!({"delivery_ids": ["d1"]}));
    assert_eq!(r.header("idempotency-key"), Some("rp-own-1"));
    let r = check!(
        mock,
        "POST",
        "/v1/me/webhook/replay",
        Reply::json(200, json!({"replayed": [], "skipped": [], "remaining": 0})),
        s.replay_my_webhook(&ReplayRequest::Failed { since: None }, None)
    );
    assert_eq!(r.json(), json!({"status": "failed"}));
    // Refused before sending: no ids, or more than 100.
    let before = mock.requests_to("POST", "/v1/me/webhook/replay").len();
    let err = s
        .replay_my_webhook(&ReplayRequest::Deliveries(vec![]), None)
        .await
        .unwrap_err();
    assert_eq!(err.code(), "invalid_input");
    assert_eq!(
        mock.requests_to("POST", "/v1/me/webhook/replay").len(),
        before
    );
    check!(
        mock,
        "GET",
        "/v1/me/owned-apps",
        Reply::json(200, json!({"items": []})),
        s.owned_apps()
    );
    check!(
        mock,
        "GET",
        "/v1/device/WDJB-MJHT",
        Reply::json(200, json!({"user_code": "WDJB-MJHT", "status": "pending"})),
        s.device_request("wdjbmjht")
    );
    check!(
        mock,
        "POST",
        "/v1/device/WDJB-MJHT/approve",
        Reply::empty(204),
        s.approve_device("WDJB-MJHT")
    );
    check!(
        mock,
        "POST",
        "/v1/device/WDJB-MJHT/deny",
        Reply::empty(204),
        s.deny_device("WDJB-MJHT")
    );
    check!(
        mock,
        "GET",
        "/v1/accounts/a8K",
        Reply::json(200, summary()),
        s.lookup("a8K")
    );
    check!(
        mock,
        "GET",
        "/v1/accounts/by-id/c:saket",
        Reply::json(200, summary()),
        s.resolve("C:Saket")
    );
}

#[tokio::test]
async fn custodian_calls() {
    let mock = Mock::start().await;
    let c = AccountsClient::new(&mock.url).unwrap();
    let s = c.with_token("tok");
    check!(
        mock,
        "GET",
        "/v1/me/silicons",
        Reply::json(200, page(silicon())),
        s.silicons()
    );
    let r = check!(
        mock,
        "POST",
        "/v1/me/silicons",
        Reply::json(
            201,
            json!({"silicon": silicon(), "stk": "stk-0123456789ab", "webhook_secret": null})
        ),
        s.create_silicon(
            &CreateSilicon {
                id: "si:scout".into(),
                display_name: "Scout".into(),
                ..Default::default()
            },
            Some("k")
        )
    );
    assert_eq!(r.header("idempotency-key"), Some("k"));
    check!(
        mock,
        "GET",
        "/v1/me/silicons/b9Z",
        Reply::json(200, silicon()),
        s.get_silicon("b9Z")
    );
    check!(
        mock,
        "PATCH",
        "/v1/me/silicons/b9Z",
        Reply::json(200, json!({"silicon": silicon()})),
        s.update_silicon(
            "b9Z",
            &UpdateSilicon {
                timezone: Some("UTC".into()),
                ..Default::default()
            }
        )
    );
    check!(
        mock,
        "POST",
        "/v1/me/silicons/b9Z/id",
        Reply::json(200, silicon()),
        s.change_silicon_id("b9Z", "si:scout2")
    );
    let r = check!(
        mock,
        "POST",
        "/v1/me/silicons/b9Z/photo",
        Reply::json(
            201,
            json!({"pfp_url": "https://x/v1/photos/2", "photo": {"id": "2", "content_type": "image/png", "bytes": 4, "width": 1, "height": 1}, "silicon": silicon()})
        ),
        s.set_silicon_photo(
            "b9Z",
            vec![0x89, b'P', b'N', b'G'],
            "image/png",
            Some("ph-1")
        )
    );
    assert_eq!(r.header("content-type"), Some("image/png"));
    assert_eq!(r.header("idempotency-key"), Some("ph-1"));
    assert_eq!(r.body, vec![0x89, b'P', b'N', b'G']);
    let r = check!(
        mock,
        "GET",
        "/v1/ids/available",
        Reply::json(
            200,
            json!({"id": "si:old", "available": true, "reclaimable": true})
        ),
        s.silicon_id_available("b9Z", "si:old")
    );
    assert_eq!(r.query.as_deref(), Some("id=si%3Aold&for=b9Z"));
    let r = check!(
        mock,
        "POST",
        "/v1/me/silicons/b9Z/stk",
        Reply::json(
            200,
            json!({"stk": null, "rotated_at": "2026-10-06T12:00:00.000Z"})
        ),
        s.rotate_stk("b9Z", Some("stk-deadbeef"))
    );
    assert_eq!(r.json(), json!({"stk": "stk-deadbeef"}));
    check!(
        mock,
        "PUT",
        "/v1/me/silicons/b9Z/webhook",
        Reply::json(
            200,
            json!({"webhook_url": "https://x", "webhook_secret": "whsec_x"})
        ),
        s.set_silicon_webhook("b9Z", "https://x")
    );
    check!(
        mock,
        "DELETE",
        "/v1/me/silicons/b9Z/webhook",
        Reply::empty(204),
        s.remove_silicon_webhook("b9Z")
    );
    // The custodian sees and replays the Silicon's webhook deliveries.
    let r = check!(
        mock,
        "GET",
        "/v1/me/silicons/b9Z/webhook/deliveries",
        Reply::json(200, json!({"items": [], "next_cursor": null})),
        s.silicon_webhook_deliveries(
            "b9Z",
            &DeliveriesQuery {
                status: Some("failed".into()),
                cursor: Some("c2".into()),
                ..Default::default()
            }
        )
    );
    assert_eq!(r.query.as_deref(), Some("status=failed&cursor=c2"));
    check!(
        mock,
        "GET",
        "/v1/me/silicons/b9Z/webhook/deliveries/d2",
        Reply::json(200, json!({"id": "d2", "attempts": [], "payload": {}})),
        s.silicon_webhook_delivery("b9Z", "d2")
    );
    let r = check!(
        mock,
        "POST",
        "/v1/me/silicons/b9Z/webhook/replay",
        Reply::json(
            200,
            json!({"replayed": ["d2"], "skipped": [], "remaining": 0})
        ),
        s.replay_silicon_webhook(
            "b9Z",
            &ReplayRequest::Failed {
                since: Some(time::macros::datetime!(2026-10-01 00:00 UTC))
            },
            Some("rp-si-1")
        )
    );
    assert_eq!(
        r.json(),
        json!({"status": "failed", "since": "2026-10-01T00:00:00Z"})
    );
    assert_eq!(r.header("idempotency-key"), Some("rp-si-1"));
    let r = check!(
        mock,
        "POST",
        "/v1/me/silicons/b9Z/transfer",
        Reply::json(
            201,
            json!({"request": {"id": "t1", "kind": "transfer", "status": "pending"}})
        ),
        s.transfer_silicon("b9Z", "c:shubham")
    );
    assert_eq!(r.json(), json!({"to": "c:shubham"}));
    check!(
        mock,
        "DELETE",
        "/v1/me/silicons/b9Z/transfer",
        Reply::empty(204),
        s.cancel_transfer("b9Z")
    );
    check!(
        mock,
        "DELETE",
        "/v1/me/silicons/b9Z",
        Reply::empty(204),
        s.delete_silicon("b9Z", "si:scout")
    );
    check!(
        mock,
        "GET",
        "/v1/me/custodian-requests",
        Reply::json(
            200,
            page(json!({"id": "r1", "kind": "initial", "silicon": summary(), "from": null}))
        ),
        s.custodian_requests()
    );
    check!(
        mock,
        "POST",
        "/v1/me/custodian-requests/r1/accept",
        Reply::empty(204),
        s.accept_custodian_request("r1")
    );
    check!(
        mock,
        "POST",
        "/v1/me/custodian-requests/r1/decline",
        Reply::empty(204),
        s.decline_custodian_request("r1")
    );
}

#[tokio::test]
async fn app_calls() {
    let mock = Mock::start().await;
    let c = AccountsClient::new(&mock.url).unwrap();
    let a = c.as_app("briefcase", "sa_app_secret");
    let basic = "Basic YnJpZWZjYXNlOnNhX2FwcF9zZWNyZXQ=";

    let r = check!(
        mock,
        "POST",
        "/v1/oauth/token",
        Reply::json(200, tokens()),
        a.exchange_code("sac_x", "https://b/cb", Some("ver"))
    );
    assert_eq!(r.header("authorization"), Some(basic));
    let form = r.form();
    assert_eq!(form["grant_type"], "authorization_code");
    assert_eq!(form["code_verifier"], "ver");
    let r = check!(
        mock,
        "POST",
        "/v1/oauth/token",
        Reply::json(200, tokens()),
        a.exchange_slt("slt_x")
    );
    assert_eq!(
        r.form()["grant_type"],
        "urn:silicon:params:oauth:grant-type:slt"
    );
    let r = check!(
        mock,
        "POST",
        "/v1/oauth/token",
        Reply::json(200, tokens()),
        a.refresh("sar_x")
    );
    assert_eq!(r.form()["refresh_token"], "sar_x");
    check!(
        mock,
        "POST",
        "/v1/oauth/revoke",
        Reply::empty(200),
        a.revoke("sar_x")
    );
    check!(
        mock,
        "POST",
        "/v1/oauth/introspect",
        Reply::json(200, json!({"active": false})),
        a.introspect("eyJ")
    );
    let r = check!(
        mock,
        "GET",
        "/v1/userinfo",
        Reply::json(200, json!({"uuid": "a8K", "kind": "carbon", "sub": "a8K"})),
        a.userinfo("user-token")
    );
    assert_eq!(r.header("authorization"), Some("Bearer user-token"));
    check!(
        mock,
        "GET",
        "/v1/apps/briefcase",
        Reply::json(200, app_details()),
        a.app()
    );
    let r = check!(
        mock,
        "PATCH",
        "/v1/apps/briefcase/signin-config",
        Reply::json(200, app_details()),
        a.update_signin_config(
            &json!({"methods": {"google": true}}),
            Some(3),
            Some("cfg-1")
        )
    );
    assert_eq!(
        r.json(),
        json!({"methods": {"google": true}, "expected_version": 3})
    );
    check!(
        mock,
        "GET",
        "/v1/apps/briefcase/signin-config/history",
        Reply::json(200, json!({"items": []})),
        a.signin_config_history(&PageRequest::default())
    );
    let r = check!(
        mock,
        "GET",
        "/v1/apps/briefcase/users",
        Reply::json(200, json!({"items": []})),
        a.users(&UsersQuery {
            q: Some("sak".into()),
            status: Some("imported".into()),
            limit: Some(10),
            ..Default::default()
        })
    );
    assert_eq!(r.query.as_deref(), Some("q=sak&status=imported&limit=10"));
    check!(
        mock,
        "GET",
        "/v1/apps/briefcase/users/a8K",
        Reply::json(200, json!({"uuid": "a8K", "history": []})),
        a.user("a8K")
    );
    let r = check!(
        mock,
        "POST",
        "/v1/apps/briefcase/imports",
        Reply::json(202, json!({"job": job()})),
        a.start_import(
            &ImportInput::Rows(vec![ImportRow {
                email: Some("a@b.test".into()),
                ..Default::default()
            }]),
            &ImportOptions::default(),
            None
        )
    );
    assert_eq!(r.json()["rows"][0], json!({"email": "a@b.test"}));
    assert_eq!(r.json()["options"]["dry_run"], false);
    check!(
        mock,
        "GET",
        "/v1/apps/briefcase/imports",
        Reply::json(200, json!({"items": [job()]})),
        a.imports(&PageRequest::default())
    );
    check!(
        mock,
        "GET",
        "/v1/apps/briefcase/imports/job-1",
        Reply::json(200, job()),
        a.import_job("job-1")
    );
    let r = check!(
        mock,
        "GET",
        "/v1/apps/briefcase/imports/job-1/rows",
        Reply::json(200, json!({"items": []})),
        a.import_rows(
            "job-1",
            &ImportRowsQuery {
                outcome: Some("error".into()),
                ..Default::default()
            }
        )
    );
    assert_eq!(r.query.as_deref(), Some("outcome=error"));
    // Rows can be filtered by message level and code too.
    let r = check!(
        mock,
        "GET",
        "/v1/apps/briefcase/imports/job-1/rows",
        Reply::json(200, json!({"items": []})),
        a.import_rows(
            "job-1",
            &ImportRowsQuery {
                level: Some("warning".into()),
                code: Some("id_conflict".into()),
                limit: Some(50),
                ..Default::default()
            }
        )
    );
    assert_eq!(
        r.query.as_deref(),
        Some("level=warning&code=id_conflict&limit=50")
    );
    check!(
        mock,
        "PUT",
        "/v1/apps/briefcase/webhook",
        Reply::json(200, json!({"url": "https://x", "secret": "whsec_x"})),
        a.set_webhook("https://x", None)
    );
    let r = check!(
        mock,
        "PUT",
        "/v1/apps/briefcase/webhook",
        Reply::json(200, json!({"url": "https://x", "secret": "whsec_x"})),
        a.set_webhook("https://x", Some("wh-set-1"))
    );
    assert_eq!(r.header("idempotency-key"), Some("wh-set-1"));
    check!(
        mock,
        "DELETE",
        "/v1/apps/briefcase/webhook",
        Reply::empty(204),
        a.remove_webhook()
    );
    check!(
        mock,
        "POST",
        "/v1/apps/briefcase/webhook/rotate-secret",
        Reply::json(200, json!({"secret": "whsec_y"})),
        a.rotate_webhook_secret(None)
    );
    let r = check!(
        mock,
        "POST",
        "/v1/apps/briefcase/webhook/rotate-secret",
        Reply::json(200, json!({"secret": "whsec_y"})),
        a.rotate_webhook_secret(Some("wh-rot-1"))
    );
    assert_eq!(r.header("idempotency-key"), Some("wh-rot-1"));
    let r = check!(
        mock,
        "POST",
        "/v1/apps/briefcase/webhook/test",
        Reply::json(200, json!({"event_id": "e"})),
        a.test_webhook(Some("wh-test-1"))
    );
    assert_eq!(r.header("idempotency-key"), Some("wh-test-1"));
    check!(
        mock,
        "GET",
        "/v1/apps/briefcase/webhook/deliveries",
        Reply::json(200, json!({"items": []})),
        a.deliveries(&DeliveriesQuery {
            status: Some("failed".into()),
            ..Default::default()
        })
    );
    check!(
        mock,
        "GET",
        "/v1/apps/briefcase/webhook/deliveries/d1",
        Reply::json(
            200,
            json!({"id": "d1", "attempts": [{"status_code": 500}], "payload": {"type": "ping"}})
        ),
        a.delivery("d1")
    );
    let r = check!(
        mock,
        "POST",
        "/v1/apps/briefcase/webhook/replay",
        Reply::json(200, json!({"replayed": ["d1"], "skipped": []})),
        a.replay(&ReplayRequest::Deliveries(vec!["d1".into()]), Some("rp-1"))
    );
    assert_eq!(r.json(), json!({"delivery_ids": ["d1"]}));
    let r = check!(
        mock,
        "POST",
        "/v1/proofs/user-verification",
        Reply::json(201, proof()),
        a.issue_user_verification(
            &IssueUserVerification {
                subject_token: "eyJ".into(),
                receiving_app: "briefcase".into(),
                ..Default::default()
            },
            Some("o1")
        )
    );
    assert_eq!(
        r.json(),
        json!({"subject_token": "eyJ", "receiving_app": "briefcase"})
    );
    check!(
        mock,
        "POST",
        "/v1/proofs/app-verification",
        Reply::json(201, proof()),
        a.issue_app_verification(
            &IssueAppVerification {
                receiving_app: "remind".into(),
                ..Default::default()
            },
            None
        )
    );
    let r = check!(
        mock,
        "POST",
        "/v1/proofs/refresh",
        Reply::json(200, proof()),
        a.refresh_proof("sapr_x", Some(600))
    );
    assert_eq!(
        r.json(),
        json!({"proof_refresh_token": "sapr_x", "access_ttl_seconds": 600})
    );
    let r = check!(
        mock,
        "POST",
        "/v1/proofs/revoke",
        Reply::empty(204),
        a.revoke_proof(&ProofRef::Id("p1".into()))
    );
    assert_eq!(r.json(), json!({"proof_id": "p1"}));
    check!(
        mock,
        "GET",
        "/v1/apps/briefcase/proofs",
        Reply::json(200, json!({"items": []})),
        a.proofs(&ProofsQuery {
            kind: Some("app_verification".into()),
            ..Default::default()
        })
    );
    check!(
        mock,
        "GET",
        "/v1/accounts/by-id/si:scout",
        Reply::json(200, summary()),
        a.lookup_by_id("si:scout")
    );

    // Owner mode revokes through the app-scoped endpoint.
    let owner = c.with_token("owner");
    let owned = owner.app("briefcase");
    check!(
        mock,
        "DELETE",
        "/v1/apps/briefcase/proofs/p1",
        Reply::empty(204),
        owned.revoke_proof(&ProofRef::Id("p1".into()))
    );
}

fn subscription(delivery: &str) -> Value {
    json!({"id": "s1", "app_id": "briefcase", "delivery": delivery, "status": "active",
        "url": if delivery == "webhook" { json!("https://x") } else { Value::Null },
        "secret_set": delivery == "webhook", "updates": ["id_change"],
        "event_types": ["account.id_changed", "ping"], "stream_url": null,
        "created_at": "2026-10-09T00:00:00.000Z", "updated_at": "2026-10-09T00:00:00.000Z"})
}

#[tokio::test]
async fn subscription_calls() {
    use silicon_accounts_client::{
        NewSubscription, SubscriptionChanges, SubscriptionDelivery, SubscriptionStatus, Updates,
    };
    let mock = Mock::start().await;
    let c = AccountsClient::new(&mock.url).unwrap();
    let a = c.as_app("briefcase", "sa_app_secret");

    let r = check!(
        mock,
        "GET",
        "/v1/apps/briefcase/subscriptions",
        Reply::json(200, page(subscription("webhook"))),
        a.subscriptions()
    );
    assert!(
        r.header("authorization")
            .is_some_and(|h| h.starts_with("Basic "))
    );
    let list = a.subscriptions().await.unwrap();
    assert_eq!(list.items[0].delivery, SubscriptionDelivery::Webhook);
    assert_eq!(
        list.items[0].updates.as_deref(),
        Some(&["id_change".to_string()][..])
    );

    // A webhook with the defaults: no updates field, so the service picks them.
    let mut created = subscription("webhook");
    created["secret"] = json!("whsec_x");
    let r = check!(
        mock,
        "POST",
        "/v1/apps/briefcase/subscriptions",
        Reply::json(201, created),
        a.create_subscription(&NewSubscription::webhook(" https://x "), Some("sub-1"))
    );
    assert_eq!(r.json(), json!({"delivery": "webhook", "url": "https://x"}));
    assert_eq!(r.header("idempotency-key"), Some("sub-1"));
    let made = a
        .create_subscription(&NewSubscription::webhook("https://x"), None)
        .await
        .unwrap();
    assert_eq!(
        made.secret.map(|s| s.expose().to_string()).as_deref(),
        Some("whsec_x")
    );

    // A stream with every update, starting paused.
    let r = check!(
        mock,
        "POST",
        "/v1/apps/briefcase/subscriptions",
        Reply::json(201, subscription("stream")),
        a.create_subscription(
            &NewSubscription {
                paused: true,
                ..NewSubscription::stream().with_updates(Updates::All)
            },
            None
        )
    );
    assert_eq!(
        r.json(),
        json!({"delivery": "stream", "updates": null, "status": "paused"})
    );

    check!(
        mock,
        "GET",
        "/v1/apps/briefcase/subscriptions/s1",
        Reply::json(200, subscription("stream")),
        a.subscription(" s1 ")
    );
    let r = check!(
        mock,
        "PATCH",
        "/v1/apps/briefcase/subscriptions/s1",
        Reply::json(200, subscription("stream")),
        a.update_subscription(
            "s1",
            &SubscriptionChanges {
                updates: Updates::Only(vec!["id_change".into(), "account_deleted".into()]),
                status: Some(SubscriptionStatus::Paused),
                url: None,
            },
            Some("sub-patch-1")
        )
    );
    assert_eq!(
        r.json(),
        json!({"updates": ["id_change", "account_deleted"], "status": "paused"})
    );
    assert_eq!(r.header("idempotency-key"), Some("sub-patch-1"));
    let before = mock
        .requests_to("PATCH", "/v1/apps/briefcase/subscriptions/s1")
        .len();
    let err = a
        .update_subscription("s1", &SubscriptionChanges::default(), None)
        .await
        .unwrap_err();
    assert!(err.to_string().contains("Nothing to change"), "{err}");
    assert_eq!(
        mock.requests_to("PATCH", "/v1/apps/briefcase/subscriptions/s1")
            .len(),
        before,
        "nothing was sent"
    );
    check!(
        mock,
        "DELETE",
        "/v1/apps/briefcase/subscriptions/s1",
        Reply::empty(204),
        a.delete_subscription("s1")
    );
    let r = check!(
        mock,
        "POST",
        "/v1/apps/briefcase/subscriptions/s1/test",
        Reply::json(
            202,
            json!({"subscription_id": "s1", "event_id": "e1", "delivery_id": null})
        ),
        a.test_subscription("s1", Some("sub-test-1"))
    );
    assert_eq!(r.header("idempotency-key"), Some("sub-test-1"));
    let t = a.test_subscription("s1", None).await.unwrap();
    assert_eq!(t.event_id, "e1");
    assert_eq!(t.delivery_id, None);

    // Statuses and deliveries a newer service adds don't break older clients.
    let mut future = subscription("carrier_pigeon");
    future["status"] = json!("draining");
    mock.on(
        "GET",
        "/v1/apps/briefcase/subscriptions/s9",
        Reply::json(200, future),
    );
    let s = a.subscription("s9").await.unwrap();
    assert_eq!(s.delivery, SubscriptionDelivery::Unknown);
    assert_eq!(s.status, SubscriptionStatus::Unknown);
}

#[tokio::test]
async fn custodian_app_controls() {
    let mock = Mock::start().await;
    let c = AccountsClient::new(&mock.url).unwrap();
    let s = c.with_token("eyJ.custodian");
    let my_app = json!({"app": {"app_id": "briefcase", "name": "Briefcase"}, "membership_id": "briefcase:b9Z",
        "status": "active", "granted_scopes": ["profile"]});
    let r = check!(
        mock,
        "GET",
        "/v1/me/silicons/b9Z/apps",
        Reply::json(200, page(my_app)),
        s.silicon_apps(" b9Z ", Some("active"))
    );
    assert_eq!(r.query.as_deref(), Some("status=active&limit=200"));
    assert_eq!(r.header("authorization"), Some("Bearer eyJ.custodian"));
    check!(
        mock,
        "DELETE",
        "/v1/me/silicons/b9Z/apps/briefcase",
        Reply::empty(204),
        s.remove_silicon_app("b9Z", " briefcase ")
    );
    let r = check!(
        mock,
        "GET",
        "/v1/me/silicons/b9Z/signins",
        Reply::json(
            200,
            page(
                json!({"at": "2026-10-09T00:00:00.000Z", "app": {"app_id": "briefcase", "name": "Briefcase"},
            "method": "slt", "outcome": "success", "ip": "203.0.113.9", "user_agent": null})
            )
        ),
        s.silicon_signins(
            "b9Z",
            &PageRequest {
                limit: Some(20),
                cursor: None
            }
        )
    );
    assert_eq!(r.query.as_deref(), Some("limit=20"));
    let signins = s
        .silicon_signins("b9Z", &PageRequest::default())
        .await
        .unwrap();
    assert_eq!(signins.items[0].method, "slt");
    check!(
        mock,
        "GET",
        "/v1/me/silicons/b9Z/allowed-apps",
        Reply::json(200, json!({"allowed_apps": null})),
        s.silicon_allowed_apps("b9Z")
    );
    let r = check!(
        mock,
        "PUT",
        "/v1/me/silicons/b9Z/allowed-apps",
        Reply::json(200, json!({"allowed_apps": ["briefcase"]})),
        s.set_silicon_allowed_apps("b9Z", Some(&["briefcase".to_string()]))
    );
    assert_eq!(r.json(), json!({"allowed_apps": ["briefcase"]}));
    let r = check!(
        mock,
        "PUT",
        "/v1/me/silicons/b9Z/allowed-apps",
        Reply::json(200, json!({"allowed_apps": null})),
        s.set_silicon_allowed_apps("b9Z", None)
    );
    assert_eq!(r.json(), json!({"allowed_apps": null}));
}

#[tokio::test]
async fn silicon_key_calls() {
    let mock = Mock::start().await;
    let c = AccountsClient::new(&mock.url).unwrap();
    let s = c.with_token("eyJ.scout");
    let key_json = json!({"id": "k1", "name": "laptop", "algorithm": "EdDSA", "public_key": "x",
        "fingerprint": "SHA256:x", "created_by": "b9Z", "created_at": "2026-10-09T00:00:00.000Z"});
    let r = check!(
        mock,
        "POST",
        "/v1/silicons/si:scout/keys",
        Reply::json(201, key_json.clone()),
        s.add_silicon_key("si:scout", " ssh-ed25519 AAAA ", Some("laptop"))
    );
    assert_eq!(
        r.json(),
        json!({"public_key": "ssh-ed25519 AAAA", "name": "laptop"})
    );
    check!(
        mock,
        "GET",
        "/v1/silicons/si:scout/keys",
        Reply::json(200, page(key_json)),
        s.silicon_keys("si:scout")
    );
    check!(
        mock,
        "DELETE",
        "/v1/silicons/si:scout/keys/k1",
        Reply::empty(204),
        s.revoke_silicon_key("si:scout", "k1")
    );
    mock.on(
        "GET",
        "/v1/meta",
        Reply::json(
            200,
            json!({"name": "Silicon Accounts", "public_url": "https://accounts.example"}),
        ),
    );
    let key = silicon_accounts_client::SiliconSigningKey::generate();
    let r = check!(
        mock,
        "POST",
        "/v1/silicons/login",
        Reply::json(200, tokens()),
        c.silicon_login_with_key("si:scout", &key, Some("k1"), Some("scout on build box"))
    );
    let body = r.json();
    assert_eq!(body["client_label"], "scout on build box");
    let jwt = body["assertion"].as_str().unwrap();
    let payload = jwt.split('.').nth(1).unwrap();
    let claims: Value = serde_json::from_slice(
        &base64::Engine::decode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, payload)
            .unwrap(),
    )
    .unwrap();
    assert_eq!(claims["iss"], "si:scout");
    assert_eq!(claims["sub"], "si:scout");
    assert_eq!(claims["aud"], "https://accounts.example/v1/oauth/token");
    assert!(claims["exp"].as_i64().unwrap() - claims["iat"].as_i64().unwrap() <= 300);
}

#[tokio::test]
async fn federation_and_identity_token_calls() {
    let mock = Mock::start().await;
    let c = AccountsClient::new(&mock.url).unwrap();
    let s = c.with_token("eyJ.scout");
    let trust = json!({"id": "f1", "name": "deploys", "issuer": "https://token.actions.githubusercontent.com",
        "audience": "https://accounts.teamofsilicons.com", "conditions": {"repository": "acme/scout"},
        "created_by": "a8K", "created_at": "2026-10-09T00:00:00.000Z", "last_used_at": null, "revoked_at": null});
    let mut conditions = std::collections::BTreeMap::new();
    conditions.insert("repository".to_string(), "acme/scout".to_string());
    let new = silicon_accounts_client::NewFederation {
        issuer: "https://token.actions.githubusercontent.com".into(),
        audience: None,
        conditions,
        name: Some("deploys".into()),
    };
    let r = check!(
        mock,
        "POST",
        "/v1/silicons/si:scout/federations",
        Reply::json(201, trust.clone()),
        s.add_federation("si:scout", &new)
    );
    assert_eq!(
        r.json(),
        json!({"issuer": "https://token.actions.githubusercontent.com", "conditions": {"repository": "acme/scout"}, "name": "deploys"})
    );
    check!(
        mock,
        "GET",
        "/v1/silicons/si:scout/federations",
        Reply::json(200, page(trust)),
        s.federations("si:scout")
    );
    check!(
        mock,
        "DELETE",
        "/v1/silicons/si:scout/federations/f1",
        Reply::empty(204),
        s.remove_federation("si:scout", "f1")
    );
    let audiences =
        json!({"silicon": {"uuid": "b9Z", "id": "si:scout"}, "audiences": ["sts.amazonaws.com"]});
    check!(
        mock,
        "GET",
        "/v1/silicons/b9Z/identity-audiences",
        Reply::json(200, audiences.clone()),
        s.identity_audiences("b9Z")
    );
    let r = check!(
        mock,
        "PUT",
        "/v1/silicons/b9Z/identity-audiences",
        Reply::json(200, audiences),
        s.set_identity_audiences("b9Z", &["sts.amazonaws.com".to_string()])
    );
    assert_eq!(r.json(), json!({"audiences": ["sts.amazonaws.com"]}));
    let r = check!(
        mock,
        "POST",
        "/v1/me/identity-tokens",
        Reply::json(
            201,
            json!({"identity_token": "eyJ.id.sig", "token_type": "urn:ietf:params:oauth:token-type:id_token",
            "issuer": "https://accounts.example", "subject": "b9Z", "audience": "sts.amazonaws.com", "jti": "j1",
            "kid": "k", "issued_at": "2026-10-09T00:00:00.000Z", "expires_at": "2026-10-09T00:05:00.000Z", "expires_in": 300})
        ),
        s.identity_token("sts.amazonaws.com", Some(600))
    );
    assert_eq!(
        r.json(),
        json!({"audience": "sts.amazonaws.com", "ttl_seconds": 600})
    );
    // The exchange is a form post to the token endpoint, as the first-party client.
    let r = check!(
        mock,
        "POST",
        "/v1/oauth/token",
        Reply::json(
            200,
            json!({"access_token": "eyJ", "token_type": "Bearer", "expires_in": 1800,
            "issued_token_type": "urn:ietf:params:oauth:token-type:access_token", "scope": "profile"})
        ),
        c.exchange_federated_token("si:scout", "eyJ.ci.sig")
    );
    let form = r.form();
    assert_eq!(
        form["grant_type"],
        "urn:ietf:params:oauth:grant-type:token-exchange"
    );
    assert_eq!(form["subject_token"], "eyJ.ci.sig");
    assert_eq!(
        form["subject_token_type"],
        "urn:ietf:params:oauth:token-type:jwt"
    );
    assert_eq!(form["silicon"], "si:scout");
    assert_eq!(form["client_id"], "silicon-accounts");
}
