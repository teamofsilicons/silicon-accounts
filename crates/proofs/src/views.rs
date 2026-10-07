//! Response shapes (02-api.md, Proofs).

use accounts_core::models::AccountKind;
use accounts_core::timefmt::{rfc3339_ms, rfc3339_ms_option};
use accounts_core::views::{AccountSummary, AppSummary};
use serde::Serialize;
use serde_json::{Value, json};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::model::{ProofKind, ProofStatus};

/// The account an OBO proof speaks for: `{"uuid","id","kind","membership_id"}`. The membership
/// is the account's membership with the *issuing* app — the grant the proof stands on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProofUser {
    pub uuid: String,
    /// Current `c:`/`si:` id (`null` only for a deleted account).
    pub id: Option<String>,
    pub kind: AccountKind,
    pub membership_id: String,
}

/// A freshly issued or refreshed proof (`POST /v1/proofs/obo|ata|refresh`). `Debug` never
/// prints the tokens.
///
/// There is deliberately no relative `expires_in`: an `Idempotency-Key` retry replays the
/// first response verbatim for up to 10 minutes, and a relative lifetime would then overstate
/// what is left. `expires_at` stays exact on a replay.
#[derive(Clone, Serialize)]
pub struct IssuedProof {
    pub proof_id: Uuid,
    pub kind: ProofKind,
    /// `sap_…`: what the receiving app verifies.
    pub proof_token: String,
    /// When `proof_token` stops verifying (absolute, so a replayed response stays right).
    #[serde(with = "rfc3339_ms")]
    pub expires_at: OffsetDateTime,
    /// `sapr_…`: kept by the issuing app; rotates on every refresh.
    pub proof_refresh_token: String,
    /// When the proof (and so its refresh token) ends at the latest.
    #[serde(with = "rfc3339_ms")]
    pub refresh_expires_at: OffsetDateTime,
    pub issuing_app: String,
    /// The one app that verifies the proof (OBO and ATA alike).
    pub receiving_app: String,
    /// OBO: the account; ATA: `null`.
    pub user: Option<ProofUser>,
    pub scopes: Vec<String>,
}

impl std::fmt::Debug for IssuedProof {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("IssuedProof")
            .field("proof_id", &self.proof_id)
            .field("kind", &self.kind)
            .field("proof_token", &"sap_…(redacted)")
            .field("expires_at", &self.expires_at)
            .field("proof_refresh_token", &"sapr_…(redacted)")
            .field("refresh_expires_at", &self.refresh_expires_at)
            .field("issuing_app", &self.issuing_app)
            .field("receiving_app", &self.receiving_app)
            .field("user", &self.user)
            .field("scopes", &self.scopes)
            .finish()
    }
}

impl IssuedProof {
    /// Fills `receiving_app` from the stored audiences (always one app; a proof issued before
    /// single-app ATA proofs reports its first).
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        proof_id: Uuid,
        kind: ProofKind,
        tokens: crate::store::MintedTokens,
        refresh_expires_at: OffsetDateTime,
        issuing_app: &str,
        audiences: &[String],
        user: Option<ProofUser>,
        scopes: Vec<String>,
    ) -> IssuedProof {
        let receiving_app = audiences.first().cloned().unwrap_or_default();
        IssuedProof {
            proof_id,
            kind,
            proof_token: tokens.access_token,
            expires_at: tokens.access_expires_at,
            proof_refresh_token: tokens.refresh_token,
            refresh_expires_at,
            issuing_app: issuing_app.to_string(),
            receiving_app,
            user,
            scopes,
        }
    }
}

/// `{"app_id","name"}` in a verification result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProofAppRef {
    pub app_id: String,
    pub name: String,
}

/// A valid verification: `{"valid":true,"proof_id","kind","expires_at","issuing_app",
/// "receiving_app","user","scopes"}`.
#[derive(Debug, Clone, Serialize)]
pub struct ValidProof {
    pub valid: bool,
    pub proof_id: Uuid,
    pub kind: ProofKind,
    #[serde(with = "rfc3339_ms")]
    pub expires_at: OffsetDateTime,
    pub issuing_app: ProofAppRef,
    /// The verifying app (always one of the proof's audiences).
    pub receiving_app: ProofAppRef,
    pub user: Option<ProofUser>,
    pub scopes: Vec<String>,
}

/// Exactly `{"valid":false,"expires_at":null}`: unknown, expired, revoked, not for the
/// verifying app, issuing app disabled, or (OBO) the grant behind it ended. Deliberately says
/// nothing more.
pub fn invalid_proof() -> Value {
    json!({ "valid": false, "expires_at": null })
}

/// One proof in `GET /v1/apps/{app_id}/proofs`.
#[derive(Debug, Clone, Serialize)]
pub struct AppProofItem {
    pub proof_id: Uuid,
    pub kind: ProofKind,
    /// The one app that verifies it (a proof issued before single-app ATA proofs reports its
    /// first receiving app).
    pub receiving_app: String,
    /// OBO: the account; ATA: `null`.
    pub user: Option<AccountSummary>,
    pub scopes: Vec<String>,
    pub status: ProofStatus,
    pub access_ttl_seconds: i32,
    #[serde(with = "rfc3339_ms")]
    pub created_at: OffsetDateTime,
    /// When the proof ends at the latest (its refresh token's lifetime).
    #[serde(with = "rfc3339_ms")]
    pub expires_at: OffsetDateTime,
    /// When its newest proof token stops verifying.
    #[serde(with = "rfc3339_ms_option")]
    pub token_expires_at: Option<OffsetDateTime>,
    #[serde(with = "rfc3339_ms_option")]
    pub last_refreshed_at: Option<OffsetDateTime>,
    /// When it was revoked, or (OBO) when the grant behind it ended, if known.
    #[serde(with = "rfc3339_ms_option")]
    pub revoked_at: Option<OffsetDateTime>,
    /// Why it is revoked (see `model::revoke_reason`), `null` while active.
    pub revoke_reason: Option<String>,
}

/// One OBO proof in `GET /v1/me/proofs`.
#[derive(Debug, Clone, Serialize)]
pub struct MyProofItem {
    pub proof_id: Uuid,
    /// The app acting on the account's behalf.
    pub issuing_app: AppSummary,
    /// The app it acts at.
    pub receiving_app: AppSummary,
    pub scopes: Vec<String>,
    pub status: ProofStatus,
    #[serde(with = "rfc3339_ms")]
    pub created_at: OffsetDateTime,
    /// When the proof ends at the latest unless revoked first.
    #[serde(with = "rfc3339_ms")]
    pub expires_at: OffsetDateTime,
    /// When its newest proof token stops verifying.
    #[serde(with = "rfc3339_ms_option")]
    pub token_expires_at: Option<OffsetDateTime>,
    #[serde(with = "rfc3339_ms_option")]
    pub last_refreshed_at: Option<OffsetDateTime>,
    #[serde(with = "rfc3339_ms_option")]
    pub revoked_at: Option<OffsetDateTime>,
    pub revoke_reason: Option<String>,
}
