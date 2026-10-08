//! The OBO subject: the account's access token that the issuing app presents as
//! `subject_token`. It proves the account signed into (and consented at) the issuing app; the
//! proof then stands on that sign-in (its token family) and dies with it.

use accounts_core::ApiError;
use accounts_core::jwt::JwtError;
use accounts_core::models::{Account, AccountStatus, MembershipStatus};
use accounts_core::repo::{accounts, memberships};
use accounts_core::state::Keys;
use sqlx::PgConnection;
use time::OffsetDateTime;
use uuid::Uuid;

/// A verified subject.
#[derive(Debug, Clone)]
pub struct Subject {
    pub account: Account,
    /// The account's token family at the issuing app.
    pub family_id: Uuid,
    pub family_expires_at: OffsetDateTime,
}

/// The subject's token family, with expiry judged by the database clock.
#[derive(Debug, Clone, sqlx::FromRow)]
struct SubjectFamily {
    id: Uuid,
    app_id: String,
    account_uuid: String,
    expires_at: OffsetDateTime,
    revoked_at: Option<OffsetDateTime>,
    revoke_reason: Option<String>,
    expired: bool,
}

fn invalid(reason: &'static str, message: String) -> ApiError {
    ApiError::bad_request("invalid_subject_token", message).detail("reason", reason)
}

/// Verifies `subject_token` for a proof issued by `app_id`: a Silicon Accounts access token
/// (signature, issuer, expiry) issued to `app_id`, whose sign-in is active, whose account is
/// active and whose membership with `app_id` is active.
///
/// Errors: 400 `invalid_subject_token` (`details.reason`: `not_an_access_token`, `invalid`,
/// `expired`, `revoked`), 403 `subject_token_wrong_app`, 403 `account_not_active`,
/// 403 `membership_inactive`.
pub async fn verify(
    conn: &mut PgConnection,
    keys: &Keys,
    token: &str,
    app_id: &str,
) -> Result<Subject, ApiError> {
    let token = token.trim();
    if !token.starts_with("eyJ") {
        let what = crate::input::describe_input(token)
            .unwrap_or_else(|| "not a Silicon Accounts token".to_string());
        return Err(invalid(
            "not_an_access_token",
            format!(
                "subject_token must be an access token (a JWT starting with eyJ) that '{app_id}' received for the account, but this is {what}."
            ),
        )
        .hint("Send the access_token from the account's POST /v1/oauth/token response at your app (not the refresh token)."));
    }
    let claims = keys.jwt.verify_access(token, None).map_err(|e| match e {
        JwtError::Expired => invalid(
            "expired",
            "subject_token expired (access tokens last 30 minutes).".into(),
        )
        .hint("Refresh the account's tokens with POST /v1/oauth/token grant_type=refresh_token, then issue the proof with the new access token."),
        other => invalid(
            "invalid",
            format!("subject_token is not a valid Silicon Accounts access token: {other}."),
        )
        .hint("Send the access token exactly as POST /v1/oauth/token returned it to your app."),
    })?;
    if claims.aud != app_id {
        return Err(ApiError::forbidden(
            "subject_token_wrong_app",
            format!(
                "subject_token was issued to the app '{}', but '{app_id}' is asking for the proof. An app can only turn access tokens it received itself into User verifications.",
                claims.aud
            ),
        )
        .hint(format!(
            "Use the access token '{app_id}' received when the account signed into '{app_id}'."
        ))
        .detail("token_app", claims.aud.clone()));
    }
    let family_id = claims.family_id().ok_or_else(|| {
        invalid(
            "invalid",
            "subject_token has no valid sign-in id (fid claim).".into(),
        )
    })?;
    let family = sqlx::query_as::<_, SubjectFamily>(
        "select id, app_id, account_uuid, expires_at, revoked_at, revoke_reason, expires_at <= now() as expired \
         from token_families where id = $1",
    )
    .bind(family_id)
    .fetch_optional(&mut *conn)
    .await?
    .ok_or_else(|| {
        invalid(
            "revoked",
            "The sign-in behind subject_token no longer exists.".into(),
        )
        .hint("The account must sign into your app again.")
    })?;
    if family.account_uuid != claims.sub || family.app_id != claims.aud {
        tracing::error!(family_id = %family.id, "subject token claims don't match their token family");
        return Err(invalid(
            "invalid",
            "subject_token does not match the sign-in it claims to belong to.".into(),
        ));
    }
    if let Some(at) = family.revoked_at {
        return Err(invalid(
            "revoked",
            format!(
                "The sign-in behind subject_token was revoked at {} ({}), so it can't back a proof.",
                accounts_core::timefmt::format_rfc3339_ms(at),
                family.revoke_reason.as_deref().unwrap_or("revoked")
            ),
        )
        .hint("The account must sign into your app again before you can act on its behalf."));
    }
    if family.expired {
        return Err(invalid(
            "expired",
            format!(
                "The sign-in behind subject_token expired at {} (sign-ins last 900 days).",
                accounts_core::timefmt::format_rfc3339_ms(family.expires_at)
            ),
        )
        .hint("The account must sign into your app again."));
    }
    let account = accounts::get(conn, &claims.sub).await?.ok_or_else(|| {
        invalid(
            "invalid",
            "The account of subject_token no longer exists.".into(),
        )
    })?;
    if account.status != AccountStatus::Active {
        return Err(ApiError::forbidden(
            "account_not_active",
            format!(
                "{} is {}, so no proof can be issued on its behalf.",
                account.display_id(),
                account.status
            ),
        )
        .hint("Only active Carbons and Silicons can be represented by a User verification.")
        .detail("status", account.status.as_str()));
    }
    let membership = memberships::get(conn, app_id, &account.uuid).await?;
    let membership_id = account.membership_id(app_id);
    match membership.as_ref().map(|m| m.status) {
        Some(MembershipStatus::Active) => {}
        other => {
            let state = match other {
                None => format!("there is no membership {membership_id}"),
                Some(s) => format!("membership {membership_id} is {s}"),
            };
            return Err(ApiError::forbidden(
                "membership_inactive",
                format!(
                    "{} has no active membership with '{app_id}' ({state}), so '{app_id}' can't act on its behalf.",
                    account.display_id()
                ),
            )
            .hint(format!(
                "The account must sign into '{app_id}' (and keep its access) before '{app_id}' can get User verifications for it."
            ))
            .detail("membership_id", membership_id));
        }
    }
    Ok(Subject {
        account,
        family_id: family.id,
        family_expires_at: family.expires_at,
    })
}
