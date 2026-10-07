//! `grant_type=authorization_code`.
//!
//! The code is consumed and its tokens issued in ONE transaction that holds the code's row lock
//! (`select … for update`). Consequences:
//! - exactly one of any number of concurrent redemptions wins; the others wait for the lock and
//!   then find the code used;
//! - every losing redemption runs after the winner committed its tokens, so the reuse path
//!   always finds and revokes them (RFC 6749 §4.1.2), never racing the issuance;
//! - a server failure while issuing rolls everything back, leaving the code usable for a retry.
//!
//! Every refused redemption (wrong app, expired, `redirect_uri` mismatch, PKCE failure, account
//! or membership no longer valid) burns the code. Requests missing `code` or `redirect_uri`
//! are rejected before the code is touched.
//!
//! The account (share) and membership (update) rows are locked before the decision, so the
//! exchange serializes with account deletion and "remove app access" (see the `grants` module
//! docs): tokens are never issued to a membership whose access was removed meanwhile.
//!
//! core's `repo::tokens::consume_code` commits the consumption before the caller issues tokens,
//! which leaves a window where a concurrent reuse can't revoke the winner's tokens; this module
//! keeps both steps in one transaction instead (same checks and messages otherwise).

use accounts_core::crypto::{describe_token, pkce, prefix};
use accounts_core::http::{ClientAuth, ClientMeta};
use accounts_core::models::{
    Account, ActorKind, MembershipSource, MembershipStatus, Scope, TokenOrigin,
};
use accounts_core::repo::audit;
use accounts_core::repo::memberships::{self, GrantMode};
use accounts_core::repo::tokens::{self, AUTH_CODE_TTL_SECONDS, AuthCode, IssueRequest};
use accounts_core::timefmt::format_rfc3339_ms;
use accounts_core::views::TokenResponse;
use accounts_core::{AppState, OAuthError, events, is_first_party_app_id};
use serde_json::json;
use sqlx::PgConnection;
use uuid::Uuid;

use crate::SIGNOUT_REASON_CODE_REUSE;
use crate::grants::{grant_account, lock_membership, removed_after_issue};
use crate::params::opt;
use crate::token::TokenParams;

/// An authorization code row plus whether it expired by the database clock.
#[derive(sqlx::FromRow)]
struct CodeRow {
    #[sqlx(flatten)]
    code: AuthCode,
    expired: bool,
}

/// Exchanges an authorization code for tokens.
pub(crate) async fn exchange(
    state: &AppState,
    client: &ClientAuth,
    params: &TokenParams,
    meta: &ClientMeta,
) -> Result<TokenResponse, OAuthError> {
    let code = opt(params.code.as_deref()).ok_or_else(|| {
        OAuthError::invalid_request(
            "code is required for grant_type=authorization_code: send the code that arrived on your redirect_uri (?code=sac_...).",
        )
    })?;
    let redirect_uri = opt(params.redirect_uri.as_deref()).ok_or_else(|| {
        OAuthError::invalid_request(
            "redirect_uri is required for grant_type=authorization_code and must be exactly the redirect_uri sent to /authorize.",
        )
    })?;
    let verifier = opt(params.code_verifier.as_deref());
    if !code.starts_with(prefix::AUTH_CODE) {
        let what = describe_token(code).unwrap_or("not a Silicon Accounts authorization code");
        return Err(OAuthError::invalid_grant(format!(
            "code must be an authorization code (it starts with sac_), but this is {what}."
        )));
    }
    let app_id = client.app.app_id.as_str();

    let mut tx = state.db.begin().await?;
    let row = sqlx::query_as::<_, CodeRow>(concat!(
        "select ",
        accounts_core::auth_code_columns!(),
        ", (expires_at <= now()) as expired from authorization_codes where code_hash = $1 for update"
    ))
    .bind(state.keys.pepper.hash(code))
    .fetch_optional(&mut *tx)
    .await?;
    let Some(CodeRow {
        code: auth,
        expired,
    }) = row
    else {
        return Err(OAuthError::invalid_grant(
            "The authorization code is not known: it is mistyped, it was never issued, or it comes from another Silicon Accounts environment.",
        ));
    };

    if auth.consumed_at.is_some() {
        let revoked = revoke_tokens_of_reused_code(&mut tx, &auth, app_id, meta).await?;
        tx.commit().await?;
        return Err(OAuthError::invalid_grant(if revoked > 0 {
            "The authorization code was already used. Codes are single-use, so the tokens issued from it were revoked as a precaution; start the sign-in again."
        } else {
            "The authorization code was already used; codes are single-use. Start the sign-in again."
        }));
    }

    // From here on every outcome uses the code up; a refusal commits just this.
    sqlx::query("update authorization_codes set consumed_at = now() where code_hash = $1")
        .bind(&auth.code_hash)
        .execute(&mut *tx)
        .await?;
    if let Some(reason) = refusal(
        &auth,
        expired,
        app_id,
        redirect_uri,
        verifier,
        client.public,
    ) {
        tx.commit().await?;
        return Err(OAuthError::invalid_grant(reason));
    }
    let account = match grant_account(&mut tx, &auth.account_uuid).await? {
        Ok(account) => account,
        Err(refused) => {
            tx.commit().await?;
            return Err(refused);
        }
    };
    let scopes = auth.scope_list();
    if !client.app.is_first_party()
        && let Some(refused) = check_membership(&mut tx, &auth, &account, &scopes).await?
    {
        tx.commit().await?;
        return Err(refused);
    }

    let label = auth.family_label();
    let response = tokens::issue_tokens(
        &mut tx,
        &state.keys,
        &state.settings,
        IssueRequest {
            account: &account,
            app_id,
            origin: TokenOrigin::AuthorizationCode,
            scopes: &scopes,
            browser_session_id: auth.browser_session_id,
            // Lets a later reuse of this code find (and revoke) these tokens.
            label: Some(&label),
            ip: meta.ip.as_deref(),
            user_agent: meta.user_agent.as_deref(),
            nonce: auth.nonce.as_deref(),
            // When the Carbon actually authenticated (id_token auth_time, also after refreshes).
            auth_time: auth.auth_time,
        },
    )
    .await?;
    tx.commit().await?;
    Ok(response)
}

/// Why a redemption is refused, checked in this order: app, expiry, `redirect_uri`, PKCE.
/// A public client (`public`: the developer platform, which has no secret) must have used
/// PKCE with S256: without a secret the verifier is the only proof that the redeemer started
/// the sign-in.
fn refusal(
    auth: &AuthCode,
    expired: bool,
    app_id: &str,
    redirect_uri: &str,
    verifier: Option<&str>,
    public: bool,
) -> Option<String> {
    if auth.app_id != app_id {
        return Some(format!(
            "The authorization code was issued to a different app, not to '{app_id}'; an app can only exchange codes from its own sign-ins."
        ));
    }
    if expired {
        return Some(format!(
            "The authorization code expired at {} (codes are valid for {AUTH_CODE_TTL_SECONDS} seconds after the sign-in); start the sign-in again.",
            format_rfc3339_ms(auth.expires_at)
        ));
    }
    if redirect_uri != auth.redirect_uri {
        return Some(format!(
            "redirect_uri '{redirect_uri}' does not match the redirect_uri of the authorization request ('{}'); the two must be exactly equal.",
            auth.redirect_uri
        ));
    }
    let method = auth.code_challenge_method.as_deref().unwrap_or("S256");
    if public && (auth.code_challenge.is_none() || method != "S256") {
        return Some(format!(
            "'{app_id}' is a public client (it has no client_secret), so its sign-ins must use PKCE with code_challenge_method=S256; this authorization request {}. Start the sign-in again with code_challenge=BASE64URL(SHA256(code_verifier)) and code_challenge_method=S256, then send that code_verifier here.",
            if auth.code_challenge.is_none() {
                "sent no code_challenge".to_string()
            } else {
                format!("used code_challenge_method={method}")
            }
        ));
    }
    match (auth.code_challenge.as_deref(), verifier) {
        (None, None) => None,
        (Some(_), None) => Some(format!(
            "code_verifier is required: the authorization request sent a code_challenge (PKCE, method {method})."
        )),
        (Some(challenge), Some(v)) => {
            if pkce::verify(Some(method), v, challenge) {
                None
            } else {
                let rule = if method == "S256" {
                    ": BASE64URL(SHA256(code_verifier)) must equal the code_challenge"
                } else {
                    ": the code_verifier must equal the code_challenge"
                };
                let syntax = pkce::validate_verifier(v)
                    .err()
                    .map(|e| format!("; also, {e}"))
                    .unwrap_or_default();
                Some(format!(
                    "PKCE verification failed: the code_verifier does not match the code_challenge sent to /authorize (method {method}{rule}){syntax}."
                ))
            }
        }
        (None, Some(_)) => Some(
            "code_verifier was sent, but the authorization request had no code_challenge. It is refused to prevent PKCE downgrade attacks (RFC 9700 section 2.1.1): send code_challenge with code_challenge_method=S256 to /authorize, or omit code_verifier."
                .to_string(),
        ),
    }
}

/// The consent step recorded the membership. Refuse when the account removed the app's access
/// after this code was issued; record the membership when it is missing (or only imported) so
/// every account that signed in is listed for the app.
///
/// The membership row stays locked until the exchange commits, so a concurrent "remove app
/// access" either finishes first (and the code is refused here) or waits and then revokes the
/// tokens this exchange issues (see the `grants` module docs). A plain read would let the
/// removal miss the new token family and leave a live sign-in behind a removed membership.
async fn check_membership(
    conn: &mut PgConnection,
    auth: &AuthCode,
    account: &Account,
    scopes: &[Scope],
) -> Result<Option<OAuthError>, OAuthError> {
    let membership = lock_membership(conn, &auth.app_id, &account.uuid).await?;
    if membership
        .as_ref()
        .is_some_and(|m| m.status == MembershipStatus::Active)
    {
        return Ok(None);
    }
    if let Some(refused) = removed_after_issue(
        membership.as_ref(),
        account,
        &auth.app_id,
        auth.created_at,
        "this code",
        "the account has to sign in to the app again.",
    ) {
        return Ok(Some(refused));
    }
    memberships::upsert_signin(
        conn,
        &auth.app_id,
        &account.uuid,
        MembershipSource::Signin,
        scopes,
        GrantMode::Union,
    )
    .await?;
    Ok(None)
}

/// A used code was presented again: revoke every token family issued from it and tell the app.
/// Returns how many families were revoked.
async fn revoke_tokens_of_reused_code(
    conn: &mut PgConnection,
    auth: &AuthCode,
    presented_by: &str,
    meta: &ClientMeta,
) -> Result<usize, OAuthError> {
    let revoked: Vec<Uuid> = sqlx::query_scalar(
        "update token_families set revoked_at = now(), revoke_reason = 'authorization_code_reuse' \
         where label = $1 and app_id = $2 and account_uuid = $3 and revoked_at is null returning id",
    )
    .bind(auth.family_label())
    .bind(&auth.app_id)
    .bind(&auth.account_uuid)
    .fetch_all(&mut *conn)
    .await?;
    if revoked.is_empty() {
        return Ok(0);
    }
    tracing::warn!(
        app_id = %auth.app_id,
        presented_by,
        families = revoked.len(),
        "authorization code reuse detected; the tokens issued from it were revoked"
    );
    if !is_first_party_app_id(&auth.app_id) {
        events::membership_signed_out(
            conn,
            &auth.app_id,
            &auth.account_uuid,
            SIGNOUT_REASON_CODE_REUSE,
        )
        .await?;
    }
    let ids: Vec<String> = revoked.iter().map(Uuid::to_string).collect();
    audit::record(
        conn,
        &audit::AuditEntry {
            target_kind: Some("token_family"),
            target_id: ids.first().map(String::as_str),
            app_id: Some(&auth.app_id),
            account_uuid: Some(&auth.account_uuid),
            details: json!({"revoked_families": ids, "presented_by": presented_by}),
            ip: meta.ip.as_deref(),
            ..audit::AuditEntry::new(
                ActorKind::App,
                Some(presented_by),
                "oauth.code_reuse_detected",
            )
        },
    )
    .await?;
    Ok(revoked.len())
}
