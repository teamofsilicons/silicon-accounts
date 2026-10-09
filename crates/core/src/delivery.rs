//! Outbound email and SMS.
//!
//! Every message is first stored in `outbound_messages` ([`enqueue`]): status `pending` with
//! `ACCOUNTS_DELIVERY=providers`, or `local` (never sent; visible in the dev outbox) with
//! `ACCOUNTS_DELIVERY=local`. Then:
//! - [`spawn_deliver`] / [`deliver_now`] send it right away (best effort, after the request's
//!   transaction committed);
//! - the worker calls [`claim_due`] + [`deliver_claimed`] for everything still pending.
//!
//! Claiming bumps `attempts` and pushes `next_attempt_at` [`CLAIM_SECONDS`] ahead in one
//! statement, so a message is never sent by two nodes at once. The result is recorded only while
//! the claim still holds (`attempts` and `next_attempt_at` unchanged since the claim): a sender
//! that outlived its claim, after another node claimed the message again, records nothing
//! ([`DeliveryOutcome::ClaimLost`]).
//!
//! Verification codes are never readable in `outbound_messages` with
//! `ACCOUNTS_DELIVERY=providers` (`otp_challenges` keeps only an HMAC of each code): a code
//! message is stored with the code replaced by [`REDACTED_CODE`], and its real subject and bodies
//! are sealed with the keyring in `sealed_body` ([`enqueue_otp`]). The sender opens them to send;
//! once the message is sent or has failed, `sealed_body` is cleared, except where the dev outbox
//! is on (never in production), which opens it to show the code.

use std::sync::Arc;

use async_trait::async_trait;
use secrecy::ExposeSecret;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::{PgConnection, PgPool};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::config::{DeliveryMode, Settings};
use crate::crypto::Keyring;
use crate::error::ApiResult;
use crate::models::{MessageChannel, OtpChannel, OtpPurpose};
use crate::repo::otp::OtpChallenge;
use crate::state::AppState;

/// Give up after this many attempts.
pub const MAX_ATTEMPTS: i32 = 8;

/// How long a claim keeps a message exclusive to the node that claimed it (seconds). A send is
/// bounded by the provider client's 10 s timeout, far inside it.
pub const CLAIM_SECONDS: i64 = 60;

/// A message to store.
#[derive(Debug, Clone)]
pub struct NewMessage {
    pub channel: MessageChannel,
    /// Email address or E.164 phone.
    pub to: String,
    /// Email only.
    pub subject: Option<String>,
    pub text_body: String,
    /// Email only.
    pub html_body: Option<String>,
    /// `otp_signin`, `otp_add_email`, `custodian_request`, `custodian_invite`, `report`, …
    pub purpose: String,
}

/// A stored message (`outbound_messages`).
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct OutboundMessage {
    pub id: Uuid,
    pub channel: MessageChannel,
    pub to_address: String,
    pub subject: Option<String>,
    pub text_body: String,
    pub html_body: Option<String>,
    pub purpose: String,
    /// `pending` | `sent` | `failed` | `local`.
    pub status: String,
    pub attempts: i32,
    pub next_attempt_at: OffsetDateTime,
    pub provider_message_id: Option<String>,
    pub last_error: Option<String>,
    pub created_at: OffsetDateTime,
    pub sent_at: Option<OffsetDateTime>,
    /// A code message's real subject and bodies, sealed with the keyring ([`SealedBody`]); the
    /// columns above then show the code as [`REDACTED_CODE`].
    pub sealed_body: Option<Vec<u8>>,
}

macro_rules! message_columns {
    () => {
        "id, channel, to_address, subject, text_body, html_body, purpose, status, attempts, next_attempt_at, \
         provider_message_id, last_error, created_at, sent_at, sealed_body"
    };
}

/// How a verification code reads in a stored message (its subject and bodies).
pub const REDACTED_CODE: &str = "••••••";

/// SQL `set` items that blank any 6-digit code left in a code message's subject and bodies (a
/// message enqueued before codes were sealed); a no-op on redacted ones.
macro_rules! redact_codes_sql {
    () => {
        "subject = case when purpose like 'otp\\_%' then regexp_replace(subject, '(?<![0-9])[0-9]{6}(?![0-9])', '••••••', 'g') else subject end, \
         text_body = case when purpose like 'otp\\_%' then regexp_replace(text_body, '(?<![0-9])[0-9]{6}(?![0-9])', '••••••', 'g') else text_body end, \
         html_body = case when purpose like 'otp\\_%' then regexp_replace(html_body, '(?<![0-9])[0-9]{6}(?![0-9])', '••••••', 'g') else html_body end"
    };
}

/// The real subject and bodies of a code message, sealed in `outbound_messages.sealed_body`
/// (keyring-encrypted JSON).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SealedBody {
    pub subject: Option<String>,
    pub text: String,
    pub html: Option<String>,
}

fn message_keyring(settings: &Settings) -> ApiResult<Keyring> {
    Ok(Keyring::from_json(
        settings.encryption_keyring.expose_secret(),
        settings.encryption_current_version,
    )?)
}

/// Opens a message's `sealed_body` with the configured keyring.
pub fn open_sealed(settings: &Settings, sealed: &[u8]) -> ApiResult<SealedBody> {
    let json = message_keyring(settings)?.decrypt(sealed)?;
    Ok(serde_json::from_slice(&json)?)
}

/// True when a sent or failed message keeps its `sealed_body`: only where the dev outbox shows
/// codes (never in production).
fn keeps_sealed_body(settings: &Settings) -> bool {
    settings.dev_outbox_enabled()
}

/// Stores a message (`pending`, or `local` in local delivery mode). Returns its id.
pub async fn enqueue(
    conn: &mut PgConnection,
    settings: &Settings,
    msg: &NewMessage,
) -> ApiResult<Uuid> {
    insert(conn, settings, msg, None).await
}

async fn insert(
    conn: &mut PgConnection,
    settings: &Settings,
    msg: &NewMessage,
    sealed_body: Option<Vec<u8>>,
) -> ApiResult<Uuid> {
    let id = Uuid::now_v7();
    let status = match settings.delivery {
        DeliveryMode::Local => "local",
        DeliveryMode::Providers => "pending",
    };
    sqlx::query(
        "insert into outbound_messages (id, channel, to_address, subject, text_body, html_body, purpose, status, sealed_body) \
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
    )
    .bind(id)
    .bind(msg.channel)
    .bind(&msg.to)
    .bind(&msg.subject)
    .bind(&msg.text_body)
    .bind(&msg.html_body)
    .bind(&msg.purpose)
    .bind(status)
    .bind(sealed_body)
    .execute(&mut *conn)
    .await?;
    Ok(id)
}

/// Stores the code message for an OTP challenge (email or SMS). `app_name` personalizes it.
pub async fn enqueue_otp(
    conn: &mut PgConnection,
    settings: &Settings,
    challenge: &OtpChallenge,
    code: &str,
    app_name: Option<&str>,
) -> ApiResult<Uuid> {
    let minutes = settings.otp_ttl_seconds / 60;
    let msg = match challenge.channel {
        OtpChannel::Email => {
            let r = templates::otp_email(code, challenge.purpose, app_name, minutes);
            NewMessage {
                channel: MessageChannel::Email,
                to: challenge.destination.clone(),
                subject: Some(r.subject),
                text_body: r.text,
                html_body: Some(r.html),
                purpose: format!("otp_{}", challenge.purpose),
            }
        }
        OtpChannel::Phone => NewMessage {
            channel: MessageChannel::Sms,
            to: challenge.destination.clone(),
            subject: None,
            text_body: templates::otp_sms(code, challenge.purpose, app_name, minutes),
            html_body: None,
            purpose: format!("otp_{}", challenge.purpose),
        },
    };
    if settings.delivery == DeliveryMode::Local {
        // Never sent; the dev outbox shows it as written.
        return enqueue(conn, settings, &msg).await;
    }
    // The code is stored only sealed: the readable columns show it as REDACTED_CODE.
    let sealed = message_keyring(settings)?.encrypt(&serde_json::to_vec(&SealedBody {
        subject: msg.subject.clone(),
        text: msg.text_body.clone(),
        html: msg.html_body.clone(),
    })?)?;
    let redact = |s: &str| s.replace(code, REDACTED_CODE);
    let stored = NewMessage {
        subject: msg.subject.as_deref().map(redact),
        text_body: redact(&msg.text_body),
        html_body: msg.html_body.as_deref().map(redact),
        ..msg
    };
    insert(conn, settings, &stored, Some(sealed)).await
}

/// Why a send failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SendError {
    /// Worth retrying (network, 429, 5xx).
    pub retryable: bool,
    /// Never contains secrets.
    pub message: String,
}

impl SendError {
    pub fn retryable(message: impl Into<String>) -> Self {
        SendError {
            retryable: true,
            message: message.into(),
        }
    }

    pub fn permanent(message: impl Into<String>) -> Self {
        SendError {
            retryable: false,
            message: message.into(),
        }
    }
}

/// Sends one message through a provider. Returns the provider's message id.
#[async_trait]
pub trait Sender: Send + Sync {
    async fn send(&self, msg: &OutboundMessage) -> Result<String, SendError>;
    /// Short name for logs.
    fn name(&self) -> &'static str;
}

/// Never sends (local mode and tests); succeeds with id `local`.
#[derive(Debug, Clone, Default)]
pub struct LocalSender;

#[async_trait]
impl Sender for LocalSender {
    async fn send(&self, _msg: &OutboundMessage) -> Result<String, SendError> {
        Ok("local".into())
    }

    fn name(&self) -> &'static str {
        "local"
    }
}

/// Postmark Email API (`POST {api_url}/email`).
#[derive(Clone)]
pub struct PostmarkSender {
    pub http: reqwest::Client,
    pub api_url: String,
    pub server_token: secrecy::SecretString,
    /// `Silicon Accounts <accounts@teamofsilicons.com>`.
    pub from: String,
}

#[async_trait]
impl Sender for PostmarkSender {
    async fn send(&self, msg: &OutboundMessage) -> Result<String, SendError> {
        if msg.channel != MessageChannel::Email {
            return Err(SendError::permanent("Postmark only sends email"));
        }
        let mut body = json!({
            "From": self.from,
            "To": msg.to_address,
            "Subject": msg.subject.clone().unwrap_or_default(),
            "TextBody": msg.text_body,
            "MessageStream": "outbound",
        });
        if let Some(html) = &msg.html_body {
            body["HtmlBody"] = json!(html);
        }
        let resp = self
            .http
            .post(format!("{}/email", self.api_url.trim_end_matches('/')))
            .header("Accept", "application/json")
            .header("X-Postmark-Server-Token", self.server_token.expose_secret())
            .json(&body)
            .send()
            .await
            .map_err(|e| {
                SendError::retryable(format!("Postmark request failed: {}", without_url(&e)))
            })?;
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        let parsed: serde_json::Value =
            serde_json::from_str(&text).unwrap_or(serde_json::Value::Null);
        if status.is_success() && parsed["ErrorCode"].as_i64().unwrap_or(0) == 0 {
            return Ok(parsed["MessageID"].as_str().unwrap_or("").to_string());
        }
        let detail = format!(
            "Postmark answered {} (ErrorCode {}): {}",
            status.as_u16(),
            parsed["ErrorCode"].as_i64().unwrap_or(-1),
            parsed["Message"].as_str().unwrap_or("no message")
        );
        if status.as_u16() == 429 || status.is_server_error() {
            Err(SendError::retryable(detail))
        } else {
            Err(SendError::permanent(detail))
        }
    }

    fn name(&self) -> &'static str {
        "postmark"
    }
}

/// Twilio Messages API (`POST {api_url}/2010-04-01/Accounts/{sid}/Messages.json`).
#[derive(Clone)]
pub struct TwilioSender {
    pub http: reqwest::Client,
    pub api_url: String,
    pub account_sid: String,
    pub auth_token: secrecy::SecretString,
    pub messaging_service_sid: Option<String>,
    pub from: Option<String>,
}

#[async_trait]
impl Sender for TwilioSender {
    async fn send(&self, msg: &OutboundMessage) -> Result<String, SendError> {
        if msg.channel != MessageChannel::Sms {
            return Err(SendError::permanent("Twilio only sends SMS"));
        }
        let mut form: Vec<(&str, &str)> = vec![
            ("To", msg.to_address.as_str()),
            ("Body", msg.text_body.as_str()),
        ];
        match (&self.messaging_service_sid, &self.from) {
            (Some(ms), _) => form.push(("MessagingServiceSid", ms.as_str())),
            (None, Some(f)) => form.push(("From", f.as_str())),
            (None, None) => {
                return Err(SendError::permanent(
                    "Twilio needs a MessagingServiceSid or a From number",
                ));
            }
        }
        let resp = self
            .http
            .post(format!(
                "{}/2010-04-01/Accounts/{}/Messages.json",
                self.api_url.trim_end_matches('/'),
                self.account_sid
            ))
            .basic_auth(&self.account_sid, Some(self.auth_token.expose_secret()))
            .form(&form)
            .send()
            .await
            .map_err(|e| {
                SendError::retryable(format!("Twilio request failed: {}", without_url(&e)))
            })?;
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        let parsed: serde_json::Value =
            serde_json::from_str(&text).unwrap_or(serde_json::Value::Null);
        if status.is_success() {
            return Ok(parsed["sid"].as_str().unwrap_or("").to_string());
        }
        let detail = format!(
            "Twilio answered {} (code {}): {}",
            status.as_u16(),
            parsed["code"].as_i64().unwrap_or(-1),
            parsed["message"].as_str().unwrap_or("no message")
        );
        if status.as_u16() == 429 || status.is_server_error() {
            Err(SendError::retryable(detail))
        } else {
            Err(SendError::permanent(detail))
        }
    }

    fn name(&self) -> &'static str {
        "twilio"
    }
}

/// Routes email to Postmark and SMS to Twilio.
#[derive(Clone, Default)]
pub struct ProviderSender {
    pub postmark: Option<PostmarkSender>,
    pub twilio: Option<TwilioSender>,
}

#[async_trait]
impl Sender for ProviderSender {
    async fn send(&self, msg: &OutboundMessage) -> Result<String, SendError> {
        match msg.channel {
            MessageChannel::Email => match &self.postmark {
                Some(p) => p.send(msg).await,
                None => Err(SendError::permanent(
                    "email is not configured (ACCOUNTS_POSTMARK_SERVER_TOKEN is missing)",
                )),
            },
            MessageChannel::Sms => match &self.twilio {
                Some(t) => t.send(msg).await,
                None => Err(SendError::permanent(
                    "SMS is not configured (ACCOUNTS_TWILIO_ACCOUNT_SID / _AUTH_TOKEN / _MESSAGING_SERVICE_SID or _FROM are missing)",
                )),
            },
        }
    }

    fn name(&self) -> &'static str {
        "providers"
    }
}

fn without_url(e: &reqwest::Error) -> String {
    // reqwest errors include the URL; ours carry no secrets, but keep logs short and uniform.
    let s = e.to_string();
    if e.is_timeout() {
        "timed out".into()
    } else if e.is_connect() {
        format!("could not connect ({s})")
    } else {
        s
    }
}

/// `Silicon Accounts <address>` unless the setting already has a display name.
pub fn from_header(address: &str) -> String {
    if address.contains('<') {
        address.to_string()
    } else {
        format!("{} <{address}>", crate::PRODUCT_NAME)
    }
}

/// The sender for the configured delivery mode.
pub fn sender_from_settings(settings: &Settings, http: &reqwest::Client) -> Arc<dyn Sender> {
    match settings.delivery {
        DeliveryMode::Local => Arc::new(LocalSender),
        DeliveryMode::Providers => {
            let postmark = settings
                .postmark
                .server_token
                .clone()
                .map(|token| PostmarkSender {
                    http: http.clone(),
                    api_url: settings.postmark.api_url.clone(),
                    server_token: token,
                    from: from_header(&settings.postmark.from),
                });
            let twilio = match (&settings.twilio.account_sid, &settings.twilio.auth_token) {
                (Some(sid), Some(token)) if settings.twilio.configured() => Some(TwilioSender {
                    http: http.clone(),
                    api_url: settings.twilio.api_url.clone(),
                    account_sid: sid.clone(),
                    auth_token: token.clone(),
                    messaging_service_sid: settings.twilio.messaging_service_sid.clone(),
                    from: settings.twilio.from.clone(),
                }),
                _ => None,
            };
            Arc::new(ProviderSender { postmark, twilio })
        }
    }
}

/// What happened to a message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeliveryOutcome {
    Sent {
        provider_message_id: String,
    },
    Retrying {
        next_attempt_at: OffsetDateTime,
        error: String,
    },
    Failed {
        error: String,
    },
    /// Not pending/due (already sent, local, or another node holds it).
    Skipped,
    /// The send finished after this claim had run out and another node claimed the message
    /// again, so this result was not recorded (that node's result counts). Delivery is
    /// at-least-once: the message may have been sent twice.
    ClaimLost,
}

/// Claims one pending message by id (if due) for [`CLAIM_SECONDS`].
pub async fn claim(pool: &PgPool, id: Uuid) -> ApiResult<Option<OutboundMessage>> {
    Ok(sqlx::query_as::<_, OutboundMessage>(concat!(
        "update outbound_messages set attempts = attempts + 1, next_attempt_at = now() + make_interval(secs => $2) \
         where id = $1 and status = 'pending' and next_attempt_at <= now() returning ",
        message_columns!()
    ))
    .bind(id)
    .bind(CLAIM_SECONDS as f64)
    .fetch_optional(pool)
    .await?)
}

/// Claims up to `limit` due pending messages (for the worker), oldest first, each for
/// [`CLAIM_SECONDS`].
pub async fn claim_due(pool: &PgPool, limit: i64) -> ApiResult<Vec<OutboundMessage>> {
    Ok(sqlx::query_as::<_, OutboundMessage>(concat!(
        "update outbound_messages set attempts = attempts + 1, next_attempt_at = now() + make_interval(secs => $2) \
         where id in (select id from outbound_messages where status = 'pending' and next_attempt_at <= now() \
                      order by next_attempt_at limit $1 for update skip locked) returning ",
        message_columns!()
    ))
    .bind(limit)
    .bind(CLAIM_SECONDS as f64)
    .fetch_all(pool)
    .await?)
}

/// Sends a claimed message and records the result (sent / retry with backoff / failed).
/// OTP messages are not retried once their code would have expired.
///
/// The result is recorded only while `msg`'s claim still holds: the row must still be `pending`
/// with the `attempts` and `next_attempt_at` the claim set. If the claim ran out and another
/// node claimed the message again meanwhile, nothing is recorded and the outcome is
/// [`DeliveryOutcome::ClaimLost`].
pub async fn deliver_claimed(
    pool: &PgPool,
    sender: &dyn Sender,
    settings: &Settings,
    msg: &OutboundMessage,
) -> ApiResult<DeliveryOutcome> {
    // A code message is sent with its sealed subject and bodies (the stored ones are redacted).
    let sent = match &msg.sealed_body {
        None => sender.send(msg).await,
        Some(sealed) => match open_sealed(settings, sealed) {
            Ok(body) => {
                let real = OutboundMessage {
                    subject: body.subject,
                    text_body: body.text,
                    html_body: body.html,
                    sealed_body: None,
                    ..msg.clone()
                };
                sender.send(&real).await
            }
            Err(e) => {
                tracing::error!(message_id = %msg.id, error = %e, "a sealed message could not be opened");
                Err(SendError::permanent(
                    "the message's sealed subject and bodies can't be opened with the configured ACCOUNTS_ENCRYPTION_KEYRING (was the key that sealed them removed?)",
                ))
            }
        },
    };
    let keep_sealed = keeps_sealed_body(settings);
    match sent {
        Ok(provider_id) => {
            let recorded = sqlx::query(concat!(
                "update outbound_messages set status = 'sent', sent_at = now(), provider_message_id = $2, last_error = null, \
                 sealed_body = case when $5 then sealed_body end, ",
                redact_codes_sql!(),
                " where id = $1 and status = 'pending' and attempts = $3 and next_attempt_at = $4"
            ))
            .bind(msg.id)
            .bind(&provider_id)
            .bind(msg.attempts)
            .bind(msg.next_attempt_at)
            .bind(keep_sealed)
            .execute(pool)
            .await?
            .rows_affected();
            if recorded == 0 {
                return Ok(claim_lost(msg));
            }
            tracing::info!(message_id = %msg.id, purpose = %msg.purpose, channel = %msg.channel, sender = sender.name(), "message sent");
            Ok(DeliveryOutcome::Sent {
                provider_message_id: provider_id,
            })
        }
        Err(e) => {
            let otp_stale = msg.purpose.starts_with("otp_")
                && msg.created_at + time::Duration::seconds(settings.otp_ttl_seconds)
                    < OffsetDateTime::now_utc();
            if e.retryable && msg.attempts < MAX_ATTEMPTS && !otp_stale {
                let delay = crate::events::retry_delay_seconds(msg.attempts);
                let next: Option<OffsetDateTime> = sqlx::query_scalar(
                    "update outbound_messages set status = 'pending', last_error = $2, \
                     next_attempt_at = now() + make_interval(secs => $3) \
                     where id = $1 and status = 'pending' and attempts = $4 and next_attempt_at = $5 \
                     returning next_attempt_at",
                )
                .bind(msg.id)
                .bind(&e.message)
                .bind(delay as f64)
                .bind(msg.attempts)
                .bind(msg.next_attempt_at)
                .fetch_optional(pool)
                .await?;
                let Some(next) = next else {
                    return Ok(claim_lost(msg));
                };
                tracing::warn!(message_id = %msg.id, purpose = %msg.purpose, error = %e.message, "message send failed; will retry");
                Ok(DeliveryOutcome::Retrying {
                    next_attempt_at: next,
                    error: e.message,
                })
            } else {
                let recorded = sqlx::query(concat!(
                    "update outbound_messages set status = 'failed', last_error = $2, \
                     sealed_body = case when $5 then sealed_body end, ",
                    redact_codes_sql!(),
                    " where id = $1 and status = 'pending' and attempts = $3 and next_attempt_at = $4"
                ))
                .bind(msg.id)
                .bind(&e.message)
                .bind(msg.attempts)
                .bind(msg.next_attempt_at)
                .bind(keep_sealed)
                .execute(pool)
                .await?
                .rows_affected();
                if recorded == 0 {
                    return Ok(claim_lost(msg));
                }
                tracing::error!(message_id = %msg.id, purpose = %msg.purpose, error = %e.message, "message send failed permanently");
                Ok(DeliveryOutcome::Failed { error: e.message })
            }
        }
    }
}

fn claim_lost(msg: &OutboundMessage) -> DeliveryOutcome {
    tracing::warn!(
        message_id = %msg.id,
        purpose = %msg.purpose,
        attempt = msg.attempts,
        "a message send finished after its claim ran out and another node claimed it again; this result was not recorded"
    );
    DeliveryOutcome::ClaimLost
}

/// Sends one message now if it is pending and due (call after the transaction that enqueued it
/// committed).
pub async fn deliver_now(state: &AppState, id: Uuid) -> ApiResult<DeliveryOutcome> {
    match claim(&state.db, id).await? {
        Some(msg) => deliver_claimed(&state.db, state.sender.as_ref(), &state.settings, &msg).await,
        None => Ok(DeliveryOutcome::Skipped),
    }
}

/// Fire-and-forget [`deliver_now`] on a background task (the worker retries failures).
pub fn spawn_deliver(state: &AppState, id: Uuid) {
    if state.settings.delivery == DeliveryMode::Local {
        return;
    }
    let state = state.clone();
    tokio::spawn(async move {
        if let Err(e) = deliver_now(&state, id).await {
            tracing::error!(message_id = %id, error = %e, "immediate delivery failed; the worker will retry");
        }
    });
}

/// The first standalone 6-digit number in a text (dev outbox convenience).
pub fn extract_code(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut i = 0;
    while i + 6 <= bytes.len() {
        let window = &bytes[i..i + 6];
        let before_ok = i == 0 || !bytes[i - 1].is_ascii_digit();
        let after_ok = i + 6 == bytes.len() || !bytes[i + 6].is_ascii_digit();
        if before_ok && after_ok && window.iter().all(u8::is_ascii_digit) {
            return std::str::from_utf8(window).ok().map(str::to_string);
        }
        i += 1;
    }
    None
}

/// Message templates (plain text + simple HTML).
pub mod templates {
    use super::*;

    /// A rendered email.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct Rendered {
        pub subject: String,
        pub text: String,
        pub html: String,
    }

    /// Escapes text for HTML.
    pub fn escape_html(s: &str) -> String {
        s.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
            .replace('"', "&quot;")
            .replace('\'', "&#39;")
    }

    fn purpose_line(purpose: OtpPurpose, app_name: Option<&str>) -> String {
        match (purpose, app_name) {
            (OtpPurpose::Signin, Some(app)) => format!("Use it to sign in to {app}."),
            (OtpPurpose::Signin, None) | (OtpPurpose::CliLogin, _) => {
                "Use it to sign in to Silicon Accounts.".into()
            }
            (OtpPurpose::AddEmail, _) => {
                "Use it to add this email to your Silicon Accounts account.".into()
            }
            (OtpPurpose::AddPhone, _) => {
                "Use it to add this phone number to your Silicon Accounts account.".into()
            }
            (OtpPurpose::Requirement, Some(app)) => {
                format!("Use it to finish signing in to {app}.")
            }
            (OtpPurpose::Requirement, None) => "Use it to finish signing in.".into(),
            (OtpPurpose::DeleteAccount, _) => {
                "Use it to confirm deleting your Silicon Accounts account.".into()
            }
        }
    }

    fn wrap_html(title: &str, body_html: &str) -> String {
        format!(
            "<!doctype html><html><body style=\"margin:0;padding:24px;background:#F7F8FA;color:#292929;\
             font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif\">\
             <div style=\"max-width:480px;margin:0 auto\"><p style=\"font-size:13px;color:#5C6370\">{}</p>{}\
             <p style=\"font-size:12px;color:#5C6370;margin-top:32px\">Sent by Silicon Accounts · \
             <a href=\"{}\" style=\"color:#1F5FB8\">accounts.teamofsilicons.com</a></p></div></body></html>",
            escape_html(title),
            body_html,
            crate::PRODUCT_SITE
        )
    }

    /// The verification code email.
    pub fn otp_email(
        code: &str,
        purpose: OtpPurpose,
        app_name: Option<&str>,
        minutes: i64,
    ) -> Rendered {
        let line = purpose_line(purpose, app_name);
        let subject = format!("{code} is your Silicon Accounts code");
        let text = format!(
            "Your Silicon Accounts verification code is {code}.\n\n{line} It expires in {minutes} minutes.\n\n\
             If you didn't ask for this code, ignore this email: nobody can use your account without it.\n\n\
             Silicon Accounts · accounts.teamofsilicons.com\n"
        );
        let html = wrap_html(
            "Silicon Accounts",
            &format!(
                "<p style=\"font-size:16px\">Your verification code is</p>\
                 <p style=\"font-size:32px;letter-spacing:6px;font-family:ui-monospace,Menlo,monospace;margin:8px 0 16px\">{}</p>\
                 <p>{} It expires in {minutes} minutes.</p>\
                 <p style=\"color:#5C6370\">If you didn't ask for this code, ignore this email: nobody can use your account without it.</p>",
                escape_html(code),
                escape_html(&line)
            ),
        );
        Rendered {
            subject,
            text,
            html,
        }
    }

    /// The verification code SMS.
    pub fn otp_sms(
        code: &str,
        purpose: OtpPurpose,
        app_name: Option<&str>,
        minutes: i64,
    ) -> String {
        let target = match (purpose, app_name) {
            (OtpPurpose::Signin | OtpPurpose::Requirement, Some(app)) => format!(" for {app}"),
            _ => String::new(),
        };
        format!(
            "{code} is your Silicon Accounts code{target}. It expires in {minutes} minutes. Don't share it."
        )
    }

    /// To an existing Carbon named as custodian by a Silicon.
    pub fn custodian_request_email(
        silicon_id: &str,
        silicon_name: &str,
        expires_at: OffsetDateTime,
        site_url: &str,
    ) -> Rendered {
        let expires = crate::timefmt::format_rfc3339_ms(expires_at);
        let subject = format!("{silicon_id} asked you to be its custodian");
        let text = format!(
            "The Silicon {silicon_name} ({silicon_id}) created its Silicon Accounts account and named you as its custodian.\n\n\
             As its custodian you manage its account: its details, its id and its STK. Accept or decline on \
             {site_url}/silicons before {expires}; after that the request expires.\n\n\
             If you don't know this Silicon, decline the request.\n"
        );
        let html = wrap_html(
            "Custodian request",
            &format!(
                "<p>The Silicon <b>{}</b> ({}) created its Silicon Accounts account and named you as its custodian.</p>\
                 <p>As its custodian you manage its account: its details, its id and its STK.</p>\
                 <p><a href=\"{}/silicons\" style=\"color:#1F5FB8\">Accept or decline</a> before {}.</p>\
                 <p style=\"color:#5C6370\">If you don't know this Silicon, decline the request.</p>",
                escape_html(silicon_name),
                escape_html(silicon_id),
                escape_html(site_url),
                escape_html(&expires)
            ),
        );
        Rendered {
            subject,
            text,
            html,
        }
    }

    /// To an email that has no account yet, named as custodian by a Silicon.
    pub fn custodian_invite_email(
        silicon_id: &str,
        silicon_name: &str,
        expires_at: OffsetDateTime,
        site_url: &str,
    ) -> Rendered {
        let expires = crate::timefmt::format_rfc3339_ms(expires_at);
        let subject = format!("{silicon_id} asked you to be its custodian on Silicon Accounts");
        let text = format!(
            "The Silicon {silicon_name} ({silicon_id}) named this email address as its custodian on Silicon Accounts.\n\n\
             To accept, sign up at {site_url} with this email address; the request will be waiting for you. \
             It expires at {expires}.\n\nIf you don't know this Silicon, ignore this email.\n"
        );
        let html = wrap_html(
            "Custodian invitation",
            &format!(
                "<p>The Silicon <b>{}</b> ({}) named this email address as its custodian on Silicon Accounts.</p>\
                 <p>To accept, <a href=\"{}\" style=\"color:#1F5FB8\">sign up</a> with this email address; the request will be waiting for you. It expires at {}.</p>\
                 <p style=\"color:#5C6370\">If you don't know this Silicon, ignore this email.</p>",
                escape_html(silicon_name),
                escape_html(silicon_id),
                escape_html(site_url),
                escape_html(&expires)
            ),
        );
        Rendered {
            subject,
            text,
            html,
        }
    }

    /// To the Carbon a custodian wants to transfer a Silicon to.
    pub fn custodian_transfer_email(
        silicon_id: &str,
        from_id: &str,
        expires_at: OffsetDateTime,
        site_url: &str,
    ) -> Rendered {
        let expires = crate::timefmt::format_rfc3339_ms(expires_at);
        let subject = format!("{from_id} wants to transfer {silicon_id} to you");
        let text = format!(
            "{from_id} wants to make you the custodian of the Silicon {silicon_id}.\n\n\
             Accept or decline on {site_url}/silicons before {expires}. Nothing changes unless you accept.\n"
        );
        let html = wrap_html(
            "Custodian transfer",
            &format!(
                "<p>{} wants to make you the custodian of the Silicon <b>{}</b>.</p>\
                 <p><a href=\"{}/silicons\" style=\"color:#1F5FB8\">Accept or decline</a> before {}. Nothing changes unless you accept.</p>",
                escape_html(from_id),
                escape_html(silicon_id),
                escape_html(site_url),
                escape_html(&expires)
            ),
        );
        Rendered {
            subject,
            text,
            html,
        }
    }

    /// A bug report sent to the report recipients.
    pub fn bug_report_email(
        report_id: &str,
        message: &str,
        pr_url: Option<&str>,
        reporter: Option<&str>,
    ) -> Rendered {
        let first_line: String = message
            .lines()
            .next()
            .unwrap_or("")
            .chars()
            .take(80)
            .collect();
        let subject = format!("[Silicon Accounts bug report] {first_line}");
        let reporter = reporter.unwrap_or("an anonymous caller");
        let pr = pr_url
            .map(|p| format!("\nPull request: {p}\n"))
            .unwrap_or_default();
        let text = format!("Bug report {report_id} from {reporter}:\n\n{message}\n{pr}");
        let html = wrap_html(
            "Bug report",
            &format!(
                "<p>Bug report <code>{}</code> from {}:</p><pre style=\"white-space:pre-wrap;font-size:14px\">{}</pre>{}",
                escape_html(report_id),
                escape_html(reporter),
                escape_html(message),
                pr_url
                    .map(|p| format!(
                        "<p>Pull request: <a href=\"{0}\">{0}</a></p>",
                        escape_html(p)
                    ))
                    .unwrap_or_default()
            ),
        );
        Rendered {
            subject,
            text,
            html,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn otp_templates_contain_code_and_ttl() {
        let r = templates::otp_email("123456", OtpPurpose::Signin, Some("Briefcase"), 10);
        assert!(r.subject.starts_with("123456"));
        assert!(r.text.contains("sign in to Briefcase") && r.text.contains("10 minutes"));
        assert!(r.html.contains("123456"));
        assert_eq!(extract_code(&r.text).as_deref(), Some("123456"));
        let sms = templates::otp_sms("654321", OtpPurpose::Signin, Some("DM"), 10);
        assert_eq!(extract_code(&sms).as_deref(), Some("654321"));
        assert!(sms.contains("for DM"));
    }

    #[test]
    fn extract_code_ignores_longer_numbers() {
        assert_eq!(
            extract_code("call +919876543210 code 042424."),
            Some("042424".into())
        );
        assert_eq!(extract_code("no code here 12345"), None);
    }

    #[test]
    fn html_is_escaped() {
        let r = templates::bug_report_email(
            "r1",
            "<script>alert(1)</script>",
            Some("https://github.com/x/y/pull/1"),
            None,
        );
        assert!(!r.html.contains("<script>"));
        assert!(
            r.text.contains("<script>"),
            "plain text keeps the message verbatim"
        );
        assert_eq!(
            from_header("accounts@teamofsilicons.com"),
            "Silicon Accounts <accounts@teamofsilicons.com>"
        );
    }
}
