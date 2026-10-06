//! `POST /v1/reports`: bug reports from Carbons, Silicons and anonymous callers (the CLI's
//! `accounts report`). Each report is stored in `bug_reports` and mailed (Postmark; recorded
//! only in local delivery mode) to every address in ACCOUNTS_REPORT_RECIPIENTS — by default
//! saketdev12@gmail.com, shubhastro2@gmail.com and bugs@teamofsilicons.com.
//!
//! Limits: 5 reports per hour per IP; message 1..10000 characters; `pr_url` must be https.
//! Idempotent: the same `Idempotency-Key` + body within 24 h returns the first report.

use accounts_core::delivery::{self, NewMessage, templates};
use accounts_core::http::{AccountAuth, ClientMeta, IdempotencyKey, Json};
use accounts_core::models::{ActorKind, MessageChannel};
use accounts_core::repo::audit::{self, AuditEntry};
use accounts_core::repo::{idempotency, rate_limit};
use accounts_core::{ApiError, AppState, FieldErrors, normalize};
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::Response;
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

/// Longest accepted report message, in characters.
pub const MAX_MESSAGE_CHARS: usize = 10_000;

/// Request body.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ReportBody {
    /// What happened, 1..10000 characters.
    pub message: String,
    /// Link to a pull request that patches it (https).
    #[serde(default)]
    pub pr_url: Option<String>,
}

/// Validated input: (trimmed message, pr_url).
fn validate(body: &ReportBody) -> Result<(String, Option<String>), ApiError> {
    let mut fields = FieldErrors::new();
    let message = body.message.trim();
    let chars = message.chars().count();
    if chars == 0 {
        fields.add(
            "message",
            "is empty; describe what you did, what you expected and what happened instead",
        );
    } else if chars > MAX_MESSAGE_CHARS {
        fields.add(
            "message",
            format!("is {chars} characters long; the limit is {MAX_MESSAGE_CHARS}"),
        );
    }
    if message.contains('\0') {
        fields.add("message", "contains a NUL character, which can't be stored");
    }
    let pr_url = match body
        .pr_url
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        None => None,
        Some(raw) => match normalize::validate_https_url(raw) {
            Ok(_) => Some(raw.to_string()),
            Err(why) => {
                fields.add(
                    "pr_url",
                    format!("{why}; pass the full https link, e.g. https://github.com/teamofsilicons/silicon-accounts/pull/42"),
                );
                None
            }
        },
    };
    fields.into_result()?;
    Ok((message.to_string(), pr_url))
}

/// `POST /v1/reports` → `201 {"report_id","status":"queued","recipients":n}`.
pub async fn create(
    State(state): State<AppState>,
    auth: Option<AccountAuth>,
    meta: ClientMeta,
    key: Option<IdempotencyKey>,
    Json(body): Json<ReportBody>,
) -> Result<Response, ApiError> {
    let (message, pr_url) = validate(&body)?;
    let caller = match &auth {
        Some(a) => format!("account:{}", a.uuid()),
        None => format!("ip:{}", meta.ip_or_unknown()),
    };
    let scope = idempotency::scope(&caller, "POST", "/v1/reports");
    idempotency::run(&state.db, key.as_deref(), &scope, &body, false, || async {
        // Inside the idempotent work so a replay never counts against the limit.
        rate_limit::enforce_pool(
            &state.db,
            &rate_limit::bucket("reports:ip", meta.ip_or_unknown()),
            rate_limit::limits::REPORTS_PER_IP,
            "bug reports from this network",
        )
        .await?;
        let report_id = Uuid::now_v7();
        let reporter = auth
            .as_ref()
            .map(|a| format!("{} (uuid {})", a.account.display_id(), a.uuid()));
        let email = templates::bug_report_email(
            &report_id.to_string(),
            &message,
            pr_url.as_deref(),
            reporter.as_deref(),
        );
        let recipients = &state.settings.report_recipients;
        let mut tx = state.db.begin().await?;
        sqlx::query(
            "insert into bug_reports (id, account_uuid, message, pr_url) values ($1, $2, $3, $4)",
        )
        .bind(report_id)
        .bind(auth.as_ref().map(|a| a.uuid()))
        .bind(&message)
        .bind(&pr_url)
        .execute(&mut *tx)
        .await?;
        let mut message_ids = Vec::with_capacity(recipients.len());
        for to in recipients {
            message_ids.push(
                delivery::enqueue(
                    &mut tx,
                    &state.settings,
                    &NewMessage {
                        channel: MessageChannel::Email,
                        to: to.clone(),
                        subject: Some(email.subject.clone()),
                        text_body: email.text.clone(),
                        html_body: Some(email.html.clone()),
                        purpose: "report".into(),
                    },
                )
                .await?,
            );
        }
        if let Some(a) = &auth {
            let report_ref = report_id.to_string();
            audit::record(
                &mut tx,
                &AuditEntry {
                    target_kind: Some("bug_report"),
                    target_id: Some(&report_ref),
                    account_uuid: Some(a.uuid()),
                    details: json!({ "has_pr": pr_url.is_some() }),
                    ip: meta.ip.as_deref(),
                    ..AuditEntry::new(ActorKind::Account, Some(a.uuid()), "report.submitted")
                },
            )
            .await?;
        }
        tx.commit().await?;
        for id in message_ids {
            delivery::spawn_deliver(&state, id);
        }
        tracing::info!(%report_id, signed_in = auth.is_some(), has_pr = pr_url.is_some(), "bug report queued");
        state.telemetry.record_progress(
            "api",
            "report",
            "report.submitted",
            Some(1.0),
            json!({
                "signed_in": auth.is_some(),
                "account_kind": auth.as_ref().map(|a| a.kind()),
                "has_pr": pr_url.is_some(),
                "recipients": recipients.len(),
            }),
        );
        Ok((
            StatusCode::CREATED,
            json!({
                "report_id": report_id.to_string(),
                "status": "queued",
                "recipients": recipients.len(),
            }),
        ))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body(message: &str, pr: Option<&str>) -> ReportBody {
        ReportBody {
            message: message.into(),
            pr_url: pr.map(str::to_string),
        }
    }

    #[test]
    fn validation_is_precise() {
        let (m, pr) = validate(&body(
            "  it broke  ",
            Some(" https://github.com/x/y/pull/1 "),
        ))
        .expect("valid");
        assert_eq!(m, "it broke");
        assert_eq!(pr.as_deref(), Some("https://github.com/x/y/pull/1"));
        assert_eq!(
            validate(&body("ok", Some(""))).expect("empty pr is none").1,
            None
        );

        let e = validate(&body("   ", None)).expect_err("empty");
        assert_eq!(e.code, "validation_failed");
        assert!(
            e.details["fields"]["message"]
                .as_str()
                .is_some_and(|m| m.contains("empty"))
        );

        let long = "x".repeat(MAX_MESSAGE_CHARS + 1);
        let e = validate(&body(&long, None)).expect_err("long");
        assert!(
            e.details["fields"]["message"]
                .as_str()
                .is_some_and(|m| m.contains("10001 characters"))
        );
        assert!(validate(&body(&"é".repeat(MAX_MESSAGE_CHARS), None)).is_ok());

        let e = validate(&body("ok", Some("http://github.com/x"))).expect_err("http");
        assert!(
            e.details["fields"]["pr_url"]
                .as_str()
                .is_some_and(|m| m.contains("must use https"))
        );
    }
}
