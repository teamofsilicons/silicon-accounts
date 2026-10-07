//! Recognizing and looking up the tokens apps present to revoke and introspect, and to refresh.

use accounts_core::ApiResult;
use accounts_core::crypto::{Pepper, describe_token, prefix};
use accounts_core::jwt::{AccessClaims, JwtKeys};
use accounts_core::models::MembershipStatus;
use sqlx::PgConnection;
use time::OffsetDateTime;
use uuid::Uuid;

/// What a presented token string is, judged by its shape.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Presented {
    /// `sar_…`
    Refresh,
    /// A JWT (`eyJ…`): an access token or an `id_token`.
    Access,
    /// Another Silicon Accounts credential (its prefix), with a description for messages.
    Other {
        prefix: &'static str,
        what: &'static str,
    },
    /// Nothing Silicon Accounts issues.
    Unknown,
}

/// Classifies a presented token by its prefix.
pub(crate) fn classify(token: &str) -> Presented {
    let token = token.trim();
    if token.starts_with(prefix::REFRESH) {
        return Presented::Refresh;
    }
    if token.starts_with("eyJ") {
        return Presented::Access;
    }
    let Some(what) = describe_token(token) else {
        return Presented::Unknown;
    };
    // Longest prefixes first, as in `describe_token`.
    let prefixes = [
        prefix::PROOF_REFRESH,
        prefix::SILICON_REQUEST,
        prefix::APP_SECRET,
        prefix::WEBHOOK_SECRET,
        prefix::PROOF,
        prefix::SESSION,
        prefix::AUTH_CODE,
        prefix::SLT,
        prefix::DEVICE_CODE,
        prefix::FLOW,
        prefix::SIGNUP,
        "stk-",
    ];
    let prefix = prefixes
        .into_iter()
        .find(|p| token.starts_with(p))
        .unwrap_or("");
    Presented::Other { prefix, what }
}

/// Where a credential that `/v1/oauth/revoke` does not handle is ended instead.
pub(crate) fn where_to_revoke(prefix: &str) -> &'static str {
    match prefix {
        p if p == prefix::PROOF || p == prefix::PROOF_REFRESH => {
            "Proofs are revoked by their issuing app with POST /v1/proofs/revoke (or by the account on accounts.teamofsilicons.com)."
        }
        p if p == prefix::AUTH_CODE || p == prefix::SLT => {
            "It is single-use and expires 2 minutes after it was issued, so there is nothing to revoke."
        }
        p if p == prefix::DEVICE_CODE => {
            "A device code expires 10 minutes after it was issued; the Carbon can also deny it on accounts.teamofsilicons.com/device."
        }
        p if p == prefix::SESSION => {
            "A browser session ends with POST /v1/session/signout, or from the sessions list on accounts.teamofsilicons.com."
        }
        p if p == prefix::APP_SECRET => {
            "App secrets are rotated in Silicon Apps. Never send an app secret as a token."
        }
        p if p == prefix::WEBHOOK_SECRET => {
            "Rotate a webhook signing secret with POST /v1/apps/{app_id}/webhook/rotate-secret."
        }
        "stk-" => {
            "A Silicon's custodian rotates its STK with POST /v1/me/silicons/{uuid}/stk. Never send an STK as a token."
        }
        _ => "It is not a token an app can revoke.",
    }
}

/// Verifies an access token's signature, key id and issuer but not its expiry, so an app can
/// still end a sign-in with an access token that already expired (core's
/// `JwtKeys::verify_access_ignoring_expiry`). `None` when it is not a genuine Silicon Accounts
/// access token.
pub(crate) fn access_claims_ignoring_expiry(jwt: &JwtKeys, token: &str) -> Option<AccessClaims> {
    jwt.verify_access_ignoring_expiry(token).ok()
}

/// A refresh token with its family and the membership of that family's account at its app.
#[derive(Debug, Clone, sqlx::FromRow)]
pub(crate) struct RefreshTokenInfo {
    pub family_id: Uuid,
    pub app_id: String,
    pub account_uuid: String,
    pub scopes: Vec<String>,
    /// Not revoked and not past the family's absolute expiry (database clock).
    pub family_active: bool,
    pub family_expires_at: OffsetDateTime,
    /// When this refresh token was issued.
    pub created_at: OffsetDateTime,
    /// Already rotated (presenting it again is reuse).
    pub used: bool,
    pub membership_status: Option<MembershipStatus>,
    pub access_removed_at: Option<OffsetDateTime>,
}

/// Looks a refresh token up by its peppered hash (one indexed query).
pub(crate) async fn refresh_token_info(
    conn: &mut PgConnection,
    pepper: &Pepper,
    token: &str,
) -> ApiResult<Option<RefreshTokenInfo>> {
    Ok(sqlx::query_as::<_, RefreshTokenInfo>(
        "select f.id as family_id, f.app_id, f.account_uuid, f.scopes, \
                (f.revoked_at is null and f.expires_at > now()) as family_active, \
                f.expires_at as family_expires_at, r.created_at, (r.used_at is not null) as used, \
                m.status as membership_status, m.access_removed_at \
         from refresh_tokens r \
         join token_families f on f.id = r.family_id \
         left join memberships m on m.app_id = f.app_id and m.account_uuid = f.account_uuid \
         where r.token_hash = $1",
    )
    .bind(pepper.hash(token.trim()))
    .fetch_optional(&mut *conn)
    .await?)
}

/// What the OAuth endpoints need to know about an account's membership with an app.
#[derive(Debug, Clone, sqlx::FromRow)]
pub(crate) struct MembershipState {
    pub status: MembershipStatus,
    pub access_removed_at: Option<OffsetDateTime>,
}

/// The state of an account's membership with an app, if it has one (a plain read; grants lock
/// the row instead, see `grants::lock_membership`).
pub(crate) async fn membership_state(
    conn: &mut PgConnection,
    app_id: &str,
    account_uuid: &str,
) -> ApiResult<Option<MembershipState>> {
    Ok(sqlx::query_as::<_, MembershipState>(
        "select status, access_removed_at from memberships where app_id = $1 and account_uuid = $2",
    )
    .bind(app_id)
    .bind(account_uuid)
    .fetch_optional(&mut *conn)
    .await?)
}

/// The status of an account's membership with an app, if it has one.
pub(crate) async fn membership_status(
    conn: &mut PgConnection,
    app_id: &str,
    account_uuid: &str,
) -> ApiResult<Option<MembershipStatus>> {
    Ok(
        sqlx::query_scalar(
            "select status from memberships where app_id = $1 and account_uuid = $2",
        )
        .bind(app_id)
        .bind(account_uuid)
        .fetch_optional(&mut *conn)
        .await?,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_by_prefix() {
        assert_eq!(classify("sar_abc"), Presented::Refresh);
        assert_eq!(classify(" eyJhbGciOi.x.y "), Presented::Access);
        assert_eq!(classify("nothing-we-issue"), Presented::Unknown);
        match classify("sapr_abc") {
            Presented::Other { prefix, what } => {
                assert_eq!(prefix, "sapr_");
                assert_eq!(what, "a proof refresh token");
                assert!(where_to_revoke(prefix).contains("/v1/proofs/revoke"));
            }
            other => panic!("{other:?}"),
        }
        match classify("sap_abc") {
            Presented::Other { prefix, .. } => assert_eq!(prefix, "sap_"),
            other => panic!("{other:?}"),
        }
        match classify("sarq_abc") {
            Presented::Other { prefix, .. } => assert_eq!(prefix, "sarq_"),
            other => panic!("{other:?}"),
        }
        match classify("stk-abcdef123456") {
            Presented::Other { prefix, .. } => {
                assert_eq!(prefix, "stk-");
                assert!(where_to_revoke(prefix).contains("STK"));
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn expired_access_tokens_still_identify_their_family() {
        let (keys, seed) =
            JwtKeys::generate("k1", "http://localhost:8590").expect("generate signing key");
        let family = Uuid::now_v7();
        let (expired, _) = keys
            .sign_access(&accounts_core::jwt::AccessTokenInput {
                account_uuid: "a8K",
                app_id: "briefcase",
                kind: accounts_core::models::AccountKind::Carbon,
                id: "c:saket",
                family_id: family,
                scope: "profile",
                ttl_seconds: -3600,
            })
            .expect("sign");
        assert!(
            keys.verify_access(&expired, None).is_err(),
            "really expired"
        );
        let claims = access_claims_ignoring_expiry(&keys, &expired).expect("signature verifies");
        assert_eq!(claims.family_id(), Some(family));

        // Another key, another key id or another issuer is never accepted.
        let (other, _) = JwtKeys::generate("k1", "http://localhost:8590").expect("generate");
        assert!(access_claims_ignoring_expiry(&other, &expired).is_none());
        let rotated =
            JwtKeys::from_private_key(&seed, "k2", "http://localhost:8590").expect("same key");
        assert!(access_claims_ignoring_expiry(&rotated, &expired).is_none());
        let elsewhere =
            JwtKeys::from_private_key(&seed, "k1", "https://evil.test").expect("same key");
        let (forged, _) = elsewhere
            .sign_access(&accounts_core::jwt::AccessTokenInput {
                account_uuid: "a8K",
                app_id: "briefcase",
                kind: accounts_core::models::AccountKind::Carbon,
                id: "c:saket",
                family_id: family,
                scope: "profile",
                ttl_seconds: 600,
            })
            .expect("sign");
        assert!(access_claims_ignoring_expiry(&keys, &forged).is_none());
        assert!(access_claims_ignoring_expiry(&keys, "eyJ.not.a-jwt").is_none());
    }
}
