//! Delivery provider tests (Twilio Verify HTTP protocol).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use accounts_core::delivery::{
    OutboundMessage, Sender, SmsCodeVerifier, TwilioVerifySender, VerifyCheckOutcome,
};
use accounts_core::models::MessageChannel;
use axum::extract::{Form, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::post;
use base64::Engine as _;
use serde_json::json;
use time::OffsetDateTime;
use uuid::Uuid;

#[tokio::test]
async fn twilio_verify_sender_sends_and_checks_codes() {
    #[derive(Default)]
    struct MockState {
        sent: Mutex<Vec<(String, String)>>,
        auth_ok: Mutex<bool>,
    }

    let state = Arc::new(MockState::default());
    let expected_auth = format!(
        "Basic {}",
        base64::engine::general_purpose::STANDARD.encode("ACtest123:tok-secret")
    );
    let expected_auth_send = expected_auth.clone();
    let expected_auth_check = expected_auth;

    let app = axum::Router::new()
        .route(
            "/v2/Services/VAtest999/Verifications",
            post(
                move |State(st): State<Arc<MockState>>,
                      headers: HeaderMap,
                      Form(form): Form<HashMap<String, String>>| {
                    let expected = expected_auth_send.clone();
                    async move {
                        let ok = headers
                            .get("authorization")
                            .and_then(|v| v.to_str().ok())
                            == Some(expected.as_str());
                        *st.auth_ok.lock().unwrap() = ok;
                        let to = form.get("To").cloned().unwrap_or_default();
                        let channel = form.get("Channel").cloned().unwrap_or_default();
                        if to == "+15550006203" {
                            return (
                                StatusCode::TOO_MANY_REQUESTS,
                                axum::Json(json!({
                                    "code": 60203,
                                    "message": "Max send attempts reached"
                                })),
                            );
                        }
                        if to == "+15550000503" {
                            return (
                                StatusCode::SERVICE_UNAVAILABLE,
                                axum::Json(json!({ "code": 50000, "message": "busy" })),
                            );
                        }
                        st.sent.lock().unwrap().push((to, channel));
                        (
                            StatusCode::CREATED,
                            axum::Json(json!({
                                "sid": "VE00000000000000000000000000000001",
                                "status": "pending"
                            })),
                        )
                    }
                },
            ),
        )
        .route(
            "/v2/Services/VAtest999/VerificationCheck",
            post(
                move |headers: HeaderMap, Form(form): Form<HashMap<String, String>>| {
                    let expected = expected_auth_check.clone();
                    async move {
                        assert_eq!(
                            headers.get("authorization").and_then(|v| v.to_str().ok()),
                            Some(expected.as_str())
                        );
                        match form.get("Code").map(String::as_str) {
                            Some("123456") => (
                                StatusCode::OK,
                                axum::Json(json!({ "status": "approved", "valid": true })),
                            ),
                            Some("000000") => (
                                StatusCode::OK,
                                axum::Json(json!({ "status": "pending", "valid": false })),
                            ),
                            Some("404404") => (
                                StatusCode::NOT_FOUND,
                                axum::Json(json!({
                                    "code": 20404,
                                    "message": "The requested resource was not found"
                                })),
                            ),
                            Some("429602") => (
                                StatusCode::TOO_MANY_REQUESTS,
                                axum::Json(json!({
                                    "code": 60202,
                                    "message": "Max check attempts reached"
                                })),
                            ),
                            _ => (
                                StatusCode::SERVICE_UNAVAILABLE,
                                axum::Json(json!({ "code": 50000, "message": "down" })),
                            ),
                        }
                    }
                },
            ),
        )
        .with_state(state.clone());

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    let client = TwilioVerifySender {
        http: reqwest::Client::new(),
        api_url: format!("http://{addr}"),
        account_sid: "ACtest123".into(),
        auth_token: secrecy::SecretString::from("tok-secret"),
        verify_service_sid: "VAtest999".into(),
    };

    let msg = |to: &str| OutboundMessage {
        id: Uuid::now_v7(),
        channel: MessageChannel::Sms,
        to_address: to.into(),
        subject: None,
        text_body: "Twilio Verify SMS verification code".into(),
        html_body: None,
        purpose: "otp_add_phone".into(),
        status: "pending".into(),
        attempts: 1,
        next_attempt_at: OffsetDateTime::now_utc(),
        provider_message_id: None,
        last_error: None,
        created_at: OffsetDateTime::now_utc(),
        sent_at: None,
        sealed_body: None,
    };

    let sid = client.send(&msg("+918894979874")).await.expect("send ok");
    assert_eq!(sid, "VE00000000000000000000000000000001");
    assert!(*state.auth_ok.lock().unwrap());
    assert_eq!(
        *state.sent.lock().unwrap(),
        vec![("+918894979874".to_string(), "sms".to_string())]
    );

    let max_sends = client.send(&msg("+15550006203")).await.expect_err("60203");
    assert!(!max_sends.retryable, "60203 must be permanent");

    let busy = client.send(&msg("+15550000503")).await.expect_err("503");
    assert!(busy.retryable, "503 must be retryable");

    assert_eq!(
        client.check("+918894979874", "123456").await.unwrap(),
        VerifyCheckOutcome::Approved
    );
    assert_eq!(
        client.check("+918894979874", "000000").await.unwrap(),
        VerifyCheckOutcome::WrongCode
    );
    assert_eq!(
        client.check("+918894979874", "404404").await.unwrap(),
        VerifyCheckOutcome::ExpiredOrMaxAttempts
    );
    assert_eq!(
        client.check("+918894979874", "429602").await.unwrap(),
        VerifyCheckOutcome::ExpiredOrMaxAttempts
    );
    assert!(
        client
            .check("+918894979874", "503503")
            .await
            .expect_err("503")
            .retryable
    );
}
