//! Proof kinds, limits and the names this crate writes into the database (revoke reasons,
//! audit actions).

use serde::{Deserialize, Serialize};

/// Shortest proof token lifetime an app may ask for.
pub const MIN_ACCESS_TTL_SECONDS: i64 = 60;
/// Longest proof token lifetime, and the default: the same 30 minutes as a sign-in access token.
pub const MAX_ACCESS_TTL_SECONDS: i64 = 1800;
/// Proof token lifetime when the app doesn't ask for one.
pub const DEFAULT_ACCESS_TTL_SECONDS: i64 = MAX_ACCESS_TTL_SECONDS;
/// A proof (and its refresh token) lives at most this long, like a sign-in's refresh token.
/// An OBO proof also ends when the sign-in it was issued under ends.
pub const FAMILY_TTL_DAYS: i64 = accounts_core::repo::tokens::REFRESH_TOKEN_DAYS;
/// Most scopes one proof may carry.
pub const MAX_SCOPES: usize = 20;
/// Longest scope string.
pub const MAX_SCOPE_LEN: usize = 100;
/// Most receiving apps one ATA proof may name.
pub const MAX_AUDIENCES: usize = 20;
/// Proof tokens are deleted this many days after they expire (nothing can use them then; the
/// grace keeps "expired" answers precise for a day).
pub const EXPIRED_TOKEN_RETENTION_DAYS: i32 = 1;
/// Every token of a proof is deleted this many days after the proof was revoked or expired.
/// The proof row itself stays forever as history.
pub const ENDED_PROOF_RETENTION_DAYS: i32 = 30;

/// On behalf of an account (OBO) or app to app (ATA).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProofKind {
    /// App A acts at app B for an account that signed into app A.
    Obo,
    /// App A proves itself to the apps it names.
    Ata,
}

impl ProofKind {
    /// The wire and database spelling.
    pub const fn as_str(&self) -> &'static str {
        match self {
            ProofKind::Obo => "obo",
            ProofKind::Ata => "ata",
        }
    }

    /// Parses the database spelling.
    pub fn parse(s: &str) -> Option<ProofKind> {
        match s {
            "obo" => Some(ProofKind::Obo),
            "ata" => Some(ProofKind::Ata),
            _ => None,
        }
    }

    /// Upper-case name for messages.
    pub const fn label(&self) -> &'static str {
        match self {
            ProofKind::Obo => "OBO",
            ProofKind::Ata => "ATA",
        }
    }
}

impl std::fmt::Display for ProofKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Where a proof stands, as listings show it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProofStatus {
    /// Usable now (its token verifies until its own expiry and it can be refreshed).
    Active,
    /// Revoked explicitly, or (OBO) the grant behind it ended: the account's sign-in at the
    /// issuing app was revoked, the app's access was removed, or the account was deleted.
    Revoked,
    /// Past its 900-day lifetime, or (OBO) the sign-in behind it expired.
    Expired,
}

impl ProofStatus {
    /// The wire spelling (also what the listing SQL computes).
    pub const fn as_str(&self) -> &'static str {
        match self {
            ProofStatus::Active => "active",
            ProofStatus::Revoked => "revoked",
            ProofStatus::Expired => "expired",
        }
    }
}

/// `proof_families.revoke_reason` values (and the derived reasons listings report).
pub mod revoke_reason {
    /// The issuing app revoked it (`POST /v1/proofs/revoke`, `DELETE /v1/apps/{app_id}/proofs/{id}`).
    pub const REVOKED_BY_APP: &str = "revoked_by_app";
    /// The app's owner revoked it on the app's proofs page.
    pub const REVOKED_BY_OWNER: &str = "revoked_by_owner";
    /// The account it speaks for revoked it on account.teamofsilicons.com.
    pub const REVOKED_BY_ACCOUNT: &str = "revoked_by_account";
    /// A used proof refresh token was presented again.
    pub const REFRESH_TOKEN_REUSE: &str = "refresh_token_reuse";
    /// Written by `accounts_core` when an account removes the issuing app's access.
    pub const ACCESS_REMOVED: &str = "access_removed";
    /// Written by `accounts_core` when the account is deleted.
    pub const ACCOUNT_DELETED: &str = "account_deleted";
    /// The account's sign-in at the issuing app (the token family of the subject token) was
    /// revoked: signed out, STK rotated, sign-in refresh token reused, … A revoked sign-in never
    /// comes back, so this is stored (`revoked_by = system`, `revoked_at` = when the sign-in was
    /// revoked) by the hourly sweep, or sooner by a refresh or revoke of the proof; listings and
    /// verification derive it live until then.
    pub const SIGN_IN_REVOKED: &str = "sign_in_revoked";
    /// Derived (never stored): the account's sign-in at the issuing app expired.
    pub const SIGN_IN_EXPIRED: &str = "sign_in_expired";
    /// Derived (never stored): the account's membership with the issuing app is not active.
    /// The real removal path (`access_removed`) is stored by `accounts_core`.
    pub const MEMBERSHIP_INACTIVE: &str = "membership_inactive";
    /// Derived (never stored): the account is no longer active. Deletion (`account_deleted`)
    /// is stored by `accounts_core`.
    pub const ACCOUNT_INACTIVE: &str = "account_inactive";

    /// Why a proof with this stored reason was revoked, for messages ("… because {describe}").
    pub fn describe(reason: &str) -> &'static str {
        match reason {
            REVOKED_BY_APP => "the issuing app revoked it",
            REVOKED_BY_OWNER => "the issuing app's owner revoked it",
            REVOKED_BY_ACCOUNT => "the account it speaks for revoked it",
            REFRESH_TOKEN_REUSE => {
                "one of its proof refresh tokens was presented again after it had been used"
            }
            ACCESS_REMOVED => "the account removed the issuing app's access",
            ACCOUNT_DELETED => "the account it speaks for was deleted",
            SIGN_IN_REVOKED => {
                "the account's sign-in at the issuing app it was issued under was revoked"
            }
            _ => "it was revoked",
        }
    }
}

/// `audit_log.action` values written by this crate (`target_kind` is always `proof`, `target_id`
/// the proof id). Issue and revoke entries of OBO proofs carry the account's uuid, so they show
/// in that account's history; refresh entries don't (a proof refreshes every few minutes for
/// up to 900 days, which would drown the history).
pub mod action {
    /// A proof was issued.
    pub const ISSUED: &str = "proof.issued";
    /// A proof's token was refreshed (refresh token rotated).
    pub const REFRESHED: &str = "proof.refreshed";
    /// A proof was revoked.
    pub const REVOKED: &str = "proof.revoked";
    /// A used refresh token was presented again; the proof was revoked.
    pub const REFRESH_TOKEN_REUSED: &str = "proof.refresh_token_reused";
}

/// `audit_log.target_kind` of every entry this crate writes.
pub const AUDIT_TARGET: &str = "proof";

/// `revoked_by` for revocations made with an app's credentials (account uuids never contain
/// a colon, so this can't collide with an account revoker).
pub fn app_revoker(app_id: &str) -> String {
    format!("app:{app_id}")
}

/// `revoked_by` for revocations the service makes itself.
pub const SYSTEM_REVOKER: &str = "system";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds_round_trip() {
        for k in [ProofKind::Obo, ProofKind::Ata] {
            assert_eq!(ProofKind::parse(k.as_str()), Some(k));
            assert_eq!(
                serde_json::to_value(k).expect("json"),
                serde_json::json!(k.as_str())
            );
        }
        assert_eq!(ProofKind::parse("OBO"), None);
        assert_eq!(ProofStatus::Expired.as_str(), "expired");
        assert_eq!(
            serde_json::from_str::<ProofStatus>("\"revoked\"").expect("status"),
            ProofStatus::Revoked
        );
    }

    #[test]
    fn contract_numbers() {
        assert_eq!(MIN_ACCESS_TTL_SECONDS, 60);
        assert_eq!(MAX_ACCESS_TTL_SECONDS, 1800);
        assert_eq!(DEFAULT_ACCESS_TTL_SECONDS, 1800);
        assert_eq!(FAMILY_TTL_DAYS, 900);
        assert_eq!(app_revoker("dm"), "app:dm");
    }

    #[test]
    fn every_stored_reason_is_explained() {
        for reason in [
            revoke_reason::REVOKED_BY_APP,
            revoke_reason::REVOKED_BY_OWNER,
            revoke_reason::REVOKED_BY_ACCOUNT,
            revoke_reason::REFRESH_TOKEN_REUSE,
            revoke_reason::ACCESS_REMOVED,
            revoke_reason::ACCOUNT_DELETED,
            revoke_reason::SIGN_IN_REVOKED,
        ] {
            assert_ne!(
                revoke_reason::describe(reason),
                "it was revoked",
                "{reason}"
            );
        }
        assert_eq!(revoke_reason::describe("something_new"), "it was revoked");
    }
}
