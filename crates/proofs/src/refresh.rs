//! `POST /v1/proofs/refresh`: rotation with reuse detection, the same logic as sign-in refresh
//! tokens. Every use marks the presented refresh token used and returns a new proof token plus
//! the next refresh token; presenting a used refresh token again revokes the whole proof.

use accounts_core::crypto::prefix;
use accounts_core::models::{AccountStatus, App};
use accounts_core::repo::audit::{self, AuditEntry};
use accounts_core::timefmt::format_rfc3339_ms;
use accounts_core::{ApiError, AppState};
use serde_json::json;

use crate::input::describe_input;
use crate::model::{
    AUDIT_TARGET, ENDED_PROOF_RETENTION_DAYS, ProofKind, SYSTEM_REVOKER, action, revoke_reason,
};
use crate::store::{self, GrantState};
use crate::views::{IssuedProof, ProofUser};

fn invalid_refresh(message: impl Into<String>) -> ApiError {
    ApiError::bad_request("invalid_proof_refresh_token", message)
        .hint("Send the proof_refresh_token (sapr_…) from the latest issue or refresh response of this proof.")
}

/// Rotates `presented` for `caller` (which must be the issuing app). `ttl` was validated by the
/// caller (`None` = the proof's own token lifetime). Takes the pool: a detected reuse revokes the
/// proof and that must stick even though the request fails.
pub async fn refresh(
    state: &AppState,
    caller: &App,
    presented: &str,
    ttl: Option<i64>,
    ip: Option<&str>,
) -> Result<IssuedProof, ApiError> {
    let presented = presented.trim();
    if !presented.starts_with(prefix::PROOF_REFRESH) {
        let what =
            describe_input(presented).unwrap_or_else(|| "not a Silicon Accounts token".to_string());
        return Err(invalid_refresh(format!(
            "proof_refresh_token must be a proof refresh token (it starts with sapr_), but this is {what}."
        )));
    }
    let hash = state.keys.pepper.hash(presented);
    let mut tx = state.db.begin().await?;
    let Some(token) = store::lock_token(&mut tx, &hash).await? else {
        // Used refresh tokens of live proofs are kept (reuse detection), so an unknown one is a
        // typo, another environment, or a proof whose tokens the sweep deleted.
        return Err(ApiError::bad_request(
            "invalid_proof_refresh_token",
            format!(
                "The proof refresh token is not known: it is mistyped, it belongs to another environment, or its proof was revoked or expired more than {ENDED_PROOF_RETENTION_DAYS} days ago (every token of a proof is deleted then)."
            ),
        )
        .hint("Send the proof_refresh_token (sapr_…) from the latest issue or refresh response of this proof. If the proof ended, issue a new one (POST /v1/proofs/obo or POST /v1/proofs/ata)."));
    };
    if token.kind != "refresh" {
        return Err(invalid_refresh(
            "This is a proof token, not a proof refresh token.",
        ));
    }
    let Some(locked) = store::lock_family(&mut tx, token.family_id).await? else {
        return Err(ApiError::internal("proof token without a family"));
    };
    let family = locked.family;
    let kind = family.kind();
    let proof_id = family.id.to_string();
    if family.issuing_app != caller.app_id {
        return Err(ApiError::forbidden(
            "not_issuing_app",
            format!(
                "This proof refresh token belongs to a proof issued by '{}'; only the issuing app can refresh it, and '{}' is calling.",
                family.issuing_app, caller.app_id
            ),
        )
        .hint("Refresh proofs with the credentials of the app that issued them."));
    }
    if let Some(at) = family.revoked_at {
        let reason = family
            .revoke_reason
            .clone()
            .unwrap_or_else(|| "revoked".into());
        return Err(ApiError::gone(
            "proof_revoked",
            format!(
                "Proof {proof_id} was revoked at {} because {} ({reason}), so it can't be refreshed.",
                format_rfc3339_ms(at),
                revoke_reason::describe(&reason)
            ),
        )
        .hint(reissue_hint(kind))
        .detail("proof_id", proof_id)
        .detail("reason", reason)
        .detail("revoked_at", format_rfc3339_ms(at)));
    }
    if locked.expired {
        return Err(ApiError::gone(
            "proof_expired",
            format!(
                "Proof {proof_id} expired at {}; proofs last 900 days at most, and an OBO proof never outlives the sign-in it was issued under.",
                format_rfc3339_ms(family.expires_at)
            ),
        )
        .hint(reissue_hint(kind))
        .detail("proof_id", proof_id)
        .detail("expires_at", format_rfc3339_ms(family.expires_at)));
    }
    // The grant of an OBO proof is read before reuse detection: a proof whose sign-in was
    // revoked already ended then (verification has refused it since), exactly like a stored
    // revocation above, whichever of its refresh tokens is presented.
    let grant = match kind {
        ProofKind::Ata => None,
        ProofKind::Obo => Some(store::grant_state(&mut tx, family.id).await?),
    };
    if let Some(grant) = grant.as_ref().filter(|g| g.sign_in_revoked()) {
        // A revoked sign-in never comes back: store the proof's end now (the hourly sweep
        // would otherwise), so listings and the account's history keep it for good.
        if store::record_sign_in_revoked(&mut tx, family.id).await? {
            tx.commit().await?;
            tracing::info!(proof_id = %family.id, "proof ended with its sign-in; stored that end");
        }
        return Err(sign_in_revoked_error(grant, &family.issuing_app, &proof_id));
    }
    if token.used_at.is_some() {
        store::revoke(
            &mut tx,
            family.id,
            SYSTEM_REVOKER,
            revoke_reason::REFRESH_TOKEN_REUSE,
        )
        .await?;
        audit::record(
            &mut tx,
            &AuditEntry {
                target_kind: Some(AUDIT_TARGET),
                target_id: Some(&proof_id),
                app_id: Some(&family.issuing_app),
                account_uuid: family.account_uuid.as_deref(),
                details: json!({"kind": kind.as_str(), "reason": revoke_reason::REFRESH_TOKEN_REUSE}),
                ip,
                ..AuditEntry::new(
                    accounts_core::models::ActorKind::App,
                    Some(&caller.app_id),
                    action::REFRESH_TOKEN_REUSED,
                )
            },
        )
        .await?;
        tx.commit().await?;
        tracing::warn!(proof_id = %family.id, issuing_app = %family.issuing_app, "proof refresh token reuse detected; proof revoked");
        return Err(ApiError::bad_request(
            "proof_refresh_token_reused",
            format!(
                "This proof refresh token was already used once. Presenting a used refresh token revokes the whole proof to protect it, so proof {proof_id} is now revoked."
            ),
        )
        .hint(format!(
            "Always keep only the newest proof_refresh_token. {}",
            reissue_hint(kind)
        ))
        .detail("proof_id", proof_id));
    }
    let user = match &grant {
        None => None,
        Some(grant) => {
            // Membership and account ends are stored by the paths that cause them
            // (`access_removed`, `account_deleted`); anything else is refused without storing.
            check_grant(grant, &family.issuing_app, &proof_id)?;
            Some(ProofUser {
                uuid: grant.account_uuid.clone().unwrap_or_default(),
                id: grant.account_handle.clone(),
                kind: grant
                    .account_kind
                    .unwrap_or(accounts_core::models::AccountKind::Carbon),
                membership_id: accounts_core::ids::membership_id(
                    &family.issuing_app,
                    grant.account_uuid.as_deref().unwrap_or_default(),
                ),
            })
        }
    };
    let ttl = ttl.unwrap_or(i64::from(family.access_ttl_seconds));
    store::mark_used(&mut tx, &hash).await?;
    let tokens = store::mint_tokens(
        &mut tx,
        &state.keys.pepper,
        family.id,
        ttl,
        family.expires_at,
    )
    .await?;
    store::touch_refreshed(&mut tx, family.id).await?;
    audit::record(
        &mut tx,
        &AuditEntry {
            target_kind: Some(AUDIT_TARGET),
            target_id: Some(&proof_id),
            app_id: Some(&family.issuing_app),
            // Not tied to the account: refreshes would drown its history (see model::action).
            account_uuid: None,
            details: json!({
                "kind": kind.as_str(),
                "access_ttl_seconds": ttl,
                "subject": family.account_uuid,
            }),
            ip,
            ..AuditEntry::new(
                accounts_core::models::ActorKind::App,
                Some(&caller.app_id),
                action::REFRESHED,
            )
        },
    )
    .await?;
    tx.commit().await?;
    Ok(IssuedProof::new(
        family.id,
        kind,
        tokens,
        family.expires_at,
        &family.issuing_app,
        &family.audiences,
        user,
        family.scopes,
    ))
}

fn reissue_hint(kind: ProofKind) -> &'static str {
    match kind {
        ProofKind::Obo => {
            "Issue a new proof with POST /v1/proofs/obo (the account must still be signed into your app)."
        }
        ProofKind::Ata => "Issue a new proof with POST /v1/proofs/ata.",
    }
}

/// The account an OBO proof speaks for, for messages: its id, else its uuid.
fn who(grant: &GrantState) -> String {
    grant
        .account_handle
        .clone()
        .or_else(|| grant.account_uuid.clone())
        .unwrap_or_else(|| "the account".into())
}

/// 410 `proof_revoked` for an OBO proof whose grant ended (`details.reason`).
fn grant_ended(
    grant: &GrantState,
    issuing_app: &str,
    proof_id: &str,
    reason: &'static str,
    message: String,
    at: Option<time::OffsetDateTime>,
) -> ApiError {
    let who = who(grant);
    let mut e = ApiError::gone("proof_revoked", message)
        .hint(format!(
            "OBO proofs end with the grant they were issued under. Once {who} signs into '{issuing_app}' again, issue a new proof with POST /v1/proofs/obo."
        ))
        .detail("proof_id", proof_id.to_string())
        .detail("reason", reason);
    if let Some(at) = at {
        e = e.detail("revoked_at", format_rfc3339_ms(at));
    }
    e
}

/// 410 `proof_revoked` (`sign_in_revoked`): the sign-in the proof stands on was revoked.
fn sign_in_revoked_error(grant: &GrantState, issuing_app: &str, proof_id: &str) -> ApiError {
    let who = who(grant);
    let when = grant
        .subject_revoked_at
        .map(|at| {
            format!(
                " at {} ({})",
                format_rfc3339_ms(at),
                grant.subject_revoke_reason.as_deref().unwrap_or("revoked")
            )
        })
        .unwrap_or_default();
    grant_ended(
        grant,
        issuing_app,
        proof_id,
        revoke_reason::SIGN_IN_REVOKED,
        format!(
            "Proof {proof_id} can't be refreshed: the sign-in of {who} at '{issuing_app}' it was issued under was revoked{when}, so the proof was revoked with it."
        ),
        grant.subject_revoked_at,
    )
}

/// An OBO proof can only be refreshed while its grant lives: the account's sign-in at the
/// issuing app (not revoked, not expired), its membership with the issuing app (active) and the
/// account itself (active). 410 `proof_revoked` / `proof_expired` otherwise.
fn check_grant(grant: &GrantState, issuing_app: &str, proof_id: &str) -> Result<(), ApiError> {
    let who = who(grant);
    if grant.sign_in_revoked() {
        return Err(sign_in_revoked_error(grant, issuing_app, proof_id));
    }
    let ended = |reason: &'static str, message: String, at: Option<time::OffsetDateTime>| {
        grant_ended(grant, issuing_app, proof_id, reason, message, at)
    };
    if grant.membership_status.as_deref() != Some("active") {
        let state = grant
            .membership_status
            .as_deref()
            .unwrap_or("missing")
            .to_string();
        return Err(ended(
            revoke_reason::MEMBERSHIP_INACTIVE,
            format!(
                "Proof {proof_id} can't be refreshed: {who}'s membership with '{issuing_app}' is {state}, so '{issuing_app}' can no longer act on its behalf."
            ),
            grant.access_removed_at,
        ));
    }
    if grant.account_status != Some(AccountStatus::Active) {
        let status = grant
            .account_status
            .map(|s| s.as_str())
            .unwrap_or("missing");
        return Err(ended(
            revoke_reason::ACCOUNT_INACTIVE,
            format!("Proof {proof_id} can't be refreshed: {who} is {status}."),
            None,
        ));
    }
    if grant.subject_expired {
        let at = grant
            .subject_expires_at
            .map(format_rfc3339_ms)
            .unwrap_or_default();
        return Err(ApiError::gone(
            "proof_expired",
            format!(
                "Proof {proof_id} can't be refreshed: the sign-in of {who} at '{issuing_app}' it was issued under expired at {at}."
            ),
        )
        .hint(format!(
            "Once {who} signs into '{issuing_app}' again, issue a new proof with POST /v1/proofs/obo."
        ))
        .detail("proof_id", proof_id.to_string())
        .detail("reason", revoke_reason::SIGN_IN_EXPIRED));
    }
    Ok(())
}
