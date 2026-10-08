//! Issuing proofs: User verification (`POST /v1/proofs/user-verification`) and App verification (`POST /v1/proofs/app-verification`, and the App verification page
//! `POST /v1/apps/{app_id}/proofs/app-verification`). Both are always for exactly one receiving app.

use accounts_core::models::{ActorKind, App, AppStatus};
use accounts_core::repo::audit::{self, AuditEntry};
use accounts_core::{ApiError, AppState, FieldErrors};
use serde_json::json;

use crate::input::{self, IssueAppVerificationBody, IssueUserVerificationBody};
use crate::model::{AUDIT_TARGET, ProofKind, action};
use crate::store::{self, NewProof};
use crate::subject;
use crate::views::{IssuedProof, ProofUser};

/// Who is issuing: the issuing app, the actor (the app itself, or its owner on the App verification page)
/// and the caller's IP for the audit log.
#[derive(Debug, Clone)]
pub struct Issuer<'a> {
    pub app: &'a App,
    pub actor_kind: ActorKind,
    pub actor_id: String,
    pub ip: Option<&'a str>,
}

impl<'a> Issuer<'a> {
    /// The app acting with its own credentials.
    pub fn app(app: &'a App, ip: Option<&'a str>) -> Issuer<'a> {
        Issuer {
            app,
            actor_kind: ActorKind::App,
            actor_id: app.app_id.clone(),
            ip,
        }
    }
}

/// Issues a user verification proof (see [`subject::verify`] for the subject checks and
/// [`check_receivers`] for the receiving app).
pub async fn user_verification(
    state: &AppState,
    issuer: &Issuer<'_>,
    body: &IssueUserVerificationBody,
) -> Result<IssuedProof, ApiError> {
    let mut fields = FieldErrors::new();
    if body.subject_token.trim().is_empty() {
        fields.add(
            "subject_token",
            format!(
                "must be the account's access token issued to '{}'",
                issuer.app.app_id
            ),
        );
    }
    let receiving = input::app_ref(&body.receiving_app, "receiving_app", &mut fields);
    let scopes = input::scopes(body.scopes.as_deref(), &mut fields);
    let ttl = input::access_ttl(body.access_ttl_seconds, &mut fields);
    fields.into_result()?;
    let receiving = receiving.unwrap_or_default();

    let mut conn = state.db.acquire().await?;
    let subject = subject::verify(
        &mut conn,
        &state.keys,
        &body.subject_token,
        &issuer.app.app_id,
    )
    .await?;
    let audiences = vec![receiving];
    check_receivers(&mut conn, issuer.app, &audiences).await?;
    drop(conn);

    let mut tx = state.db.begin().await?;
    let (family, tokens) = store::create(
        &mut tx,
        &state.keys.pepper,
        &NewProof {
            kind: ProofKind::UserVerification,
            issuing_app: &issuer.app.app_id,
            audiences: &audiences,
            subject: Some((
                &subject.account.uuid,
                subject.family_id,
                subject.family_expires_at,
            )),
            scopes: &scopes,
            access_ttl_seconds: ttl,
        },
    )
    .await?;
    let proof_id = family.id.to_string();
    audit::record(
        &mut tx,
        &AuditEntry {
            target_kind: Some(AUDIT_TARGET),
            target_id: Some(&proof_id),
            app_id: Some(&issuer.app.app_id),
            account_uuid: Some(&subject.account.uuid),
            details: json!({
                "kind": "user_verification",
                "issuing_app": issuer.app.app_id,
                "receiving_app": audiences[0],
                "scopes": scopes,
                "access_ttl_seconds": ttl,
                "expires_at": accounts_core::timefmt::format_rfc3339_ms(family.expires_at),
                "token_expires_at": accounts_core::timefmt::format_rfc3339_ms(tokens.access_expires_at),
            }),
            ip: issuer.ip,
            ..AuditEntry::new(issuer.actor_kind, Some(&issuer.actor_id), action::ISSUED)
        },
    )
    .await?;
    tx.commit().await?;
    tracing::info!(proof_id = %family.id, issuing_app = %issuer.app.app_id, receiving_app = %audiences[0], "User verification issued");
    let user = ProofUser {
        uuid: subject.account.uuid.clone(),
        id: subject.account.handle.clone(),
        kind: subject.account.kind,
        membership_id: subject.account.membership_id(&issuer.app.app_id),
    };
    Ok(IssuedProof::new(
        family.id,
        ProofKind::UserVerification,
        tokens,
        family.expires_at,
        &issuer.app.app_id,
        &audiences,
        Some(user),
        scopes,
    ))
}

/// Issues an app verification proof for the one app in `receiving_app` (a body naming `audiences` gets 422
/// `app_verification_single_app`, see [`IssueAppVerificationBody::receiving_app`]). `endpoint` is the route called.
pub async fn app_verification(
    state: &AppState,
    issuer: &Issuer<'_>,
    body: &IssueAppVerificationBody,
    endpoint: &str,
) -> Result<IssuedProof, ApiError> {
    let mut fields = FieldErrors::new();
    let receiving = body.receiving_app(endpoint, &mut fields)?;
    if issuer.app.status != AppStatus::Active {
        return Err(ApiError::forbidden(
            "app_disabled",
            format!(
                "The app '{}' is disabled, so it can't issue proofs.",
                issuer.app.app_id
            ),
        )
        .hint("Re-enable the app in Silicon Apps first."));
    }
    let scopes = input::scopes(body.scopes.as_deref(), &mut fields);
    let ttl = input::access_ttl(body.access_ttl_seconds, &mut fields);
    fields.into_result()?;
    // Stored as a one-app audience list (the column predates single-app App verification proofs).
    let audiences = vec![receiving.unwrap_or_default()];

    let mut tx = state.db.begin().await?;
    check_receivers(&mut tx, issuer.app, &audiences).await?;
    let (family, tokens) = store::create(
        &mut tx,
        &state.keys.pepper,
        &NewProof {
            kind: ProofKind::AppVerification,
            issuing_app: &issuer.app.app_id,
            audiences: &audiences,
            subject: None,
            scopes: &scopes,
            access_ttl_seconds: ttl,
        },
    )
    .await?;
    let proof_id = family.id.to_string();
    audit::record(
        &mut tx,
        &AuditEntry {
            target_kind: Some(AUDIT_TARGET),
            target_id: Some(&proof_id),
            app_id: Some(&issuer.app.app_id),
            details: json!({
                "kind": "app_verification",
                "issuing_app": issuer.app.app_id,
                "receiving_app": audiences[0],
                "scopes": scopes,
                "access_ttl_seconds": ttl,
                "expires_at": accounts_core::timefmt::format_rfc3339_ms(family.expires_at),
                "token_expires_at": accounts_core::timefmt::format_rfc3339_ms(tokens.access_expires_at),
            }),
            ip: issuer.ip,
            ..AuditEntry::new(issuer.actor_kind, Some(&issuer.actor_id), action::ISSUED)
        },
    )
    .await?;
    tx.commit().await?;
    tracing::info!(proof_id = %family.id, issuing_app = %issuer.app.app_id, receiving_app = %audiences[0], "App verification issued");
    Ok(IssuedProof::new(
        family.id,
        ProofKind::AppVerification,
        tokens,
        family.expires_at,
        &issuer.app.app_id,
        &audiences,
        None,
        scopes,
    ))
}

/// Checks the receiving apps of a new proof: not the issuer itself, not the first-party app,
/// every one exists (400 `unknown_receiving_app`) and is active (403 `receiving_app_disabled`).
pub async fn check_receivers(
    conn: &mut sqlx::PgConnection,
    issuer: &App,
    audiences: &[String],
) -> Result<(), ApiError> {
    if audiences.contains(&issuer.app_id) {
        return Err(ApiError::bad_request(
            "invalid_receiving_app",
            format!(
                "An app can't issue a proof to itself: '{}' is both the issuing and a receiving app.",
                issuer.app_id
            ),
        )
        .hint("A proof lets your app act at another app; name the other app as the receiver.")
        .detail("app_ids", vec![issuer.app_id.clone()]));
    }
    let found = store::apps_by_id(conn, audiences).await?;
    let unknown: Vec<String> = audiences
        .iter()
        .filter(|a| !found.iter().any(|f| f.app_id == **a))
        .cloned()
        .collect();
    if !unknown.is_empty() {
        let list = quoted(&unknown);
        return Err(ApiError::bad_request(
            "unknown_receiving_app",
            if unknown.len() == 1 {
                format!("No app with app_id {list} exists, so it can't receive a proof.")
            } else {
                format!("These receiving apps don't exist: {list}.")
            },
        )
        .hint("Check the app ids; apps are created in Silicon Apps.")
        .detail("app_ids", unknown));
    }
    let first_party: Vec<String> = found
        .iter()
        .filter(|a| a.is_first_party())
        .map(|a| a.app_id.clone())
        .collect();
    if !first_party.is_empty() {
        return Err(ApiError::bad_request(
            "invalid_receiving_app",
            format!(
                "{} is Silicon Accounts itself and doesn't accept proofs; proofs are verified by the apps they're for.",
                quoted(&first_party)
            ),
        )
        .hint("Name the app your app wants to act at.")
        .detail("app_ids", first_party));
    }
    let disabled: Vec<String> = found
        .iter()
        .filter(|a| a.status != AppStatus::Active)
        .map(|a| a.app_id.clone())
        .collect();
    if !disabled.is_empty() {
        return Err(ApiError::forbidden(
            "receiving_app_disabled",
            format!(
                "{} {} disabled, so {} can't verify proofs right now.",
                quoted(&disabled),
                if disabled.len() == 1 { "is" } else { "are" },
                if disabled.len() == 1 { "it" } else { "they" }
            ),
        )
        .hint("Ask the receiving app's owner to re-enable it in Silicon Apps, or leave it out.")
        .detail("app_ids", disabled));
    }
    Ok(())
}

fn quoted(ids: &[String]) -> String {
    ids.iter()
        .map(|i| format!("'{i}'"))
        .collect::<Vec<_>>()
        .join(", ")
}
