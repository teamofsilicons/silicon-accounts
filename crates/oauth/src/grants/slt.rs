//! `grant_type=urn:silicon:params:oauth:grant-type:slt` (alias `slt`): an app exchanges a
//! short-lived token a Silicon (or a Carbon's CLI) got for it with `POST /v1/me/short-lived-tokens`.
//!
//! Single use, 120 s, bound to one app (core's `repo::tokens::consume_slt`). A successful
//! exchange is a sign-in: the membership becomes active (source `slt` when new, scopes added to
//! what the account granted before), the sign-in is recorded, and tokens are issued with the
//! SLT's scopes.
//!
//! An SLT carries the authority of the sign-in that minted it, so it is refused (and the failed
//! sign-in recorded) when, after it was issued:
//! - the Silicon's STK was rotated: rotation ends every sign-in of the Silicon, and an SLT minted
//!   before it would otherwise start a fresh one for whoever held the old STK;
//! - the account removed the app's access: the SLT predates that decision and must not undo it
//!   (an SLT issued after the removal is a new sign-in and restores the access).
//!
//! Both checks run under the row locks described in the `grants` module docs, so they also hold
//! when the rotation or the removal runs at the same moment as the exchange.

use accounts_core::http::{ClientAuth, ClientMeta};
use accounts_core::models::{Account, MembershipSource, TokenOrigin};
use accounts_core::repo::audit::{self, SigninRecord};
use accounts_core::repo::memberships::{self, GrantMode};
use accounts_core::repo::tokens::{self, IssueRequest, ShortLivedToken};
use accounts_core::timefmt::format_rfc3339_ms;
use accounts_core::views::TokenResponse;
use accounts_core::{AppState, OAuthError};
use sqlx::PgConnection;
use time::OffsetDateTime;

use crate::grants::{grant_account, lock_membership, removed_after_issue};
use crate::params::opt;
use crate::token::{SLT_GRANT_TYPE, TokenParams};

/// Exchanges a short-lived token for the account's tokens at the calling app.
pub(crate) async fn exchange(
    state: &AppState,
    client: &ClientAuth,
    params: &TokenParams,
    meta: &ClientMeta,
) -> Result<TokenResponse, OAuthError> {
    let slt = opt(params.slt.as_deref()).ok_or_else(|| {
        OAuthError::invalid_request(format!(
            "slt is required for grant_type={SLT_GRANT_TYPE}: send the short-lived token (slt_...) the Silicon handed you; it gets one with `accounts login --app <app_id>`."
        ))
    })?;
    let app_id = client.app.app_id.as_str();
    // Consumed (and committed) first: a refused exchange still uses the token up.
    let token = tokens::consume_slt(&state.db, &state.keys.pepper, slt, app_id)
        .await
        .map_err(|e| e.to_oauth())?;

    let mut tx = state.db.begin().await?;
    let account = match admit(&mut tx, &token, app_id).await? {
        Ok(account) => account,
        Err(refused) => {
            record_signin(
                &mut tx,
                &token.account_uuid,
                app_id,
                meta,
                audit::outcome::FAILED,
            )
            .await?;
            tx.commit().await?;
            return Err(refused);
        }
    };
    let scopes = token.scope_list();
    memberships::upsert_signin(
        &mut tx,
        app_id,
        &account.uuid,
        MembershipSource::Slt,
        &scopes,
        GrantMode::Union,
    )
    .await?;
    record_signin(
        &mut tx,
        &account.uuid,
        app_id,
        meta,
        audit::outcome::SUCCESS,
    )
    .await?;
    let response = tokens::issue_tokens(
        &mut tx,
        &state.keys,
        &state.settings,
        IssueRequest {
            account: &account,
            app_id,
            origin: TokenOrigin::Slt,
            scopes: &scopes,
            browser_session_id: None,
            label: None,
            ip: meta.ip.as_deref(),
            user_agent: meta.user_agent.as_deref(),
            nonce: None,
        },
    )
    .await?;
    tx.commit().await?;
    Ok(response)
}

/// Whether the SLT may still sign its account in: `Ok(Ok(account))`, or `Ok(Err(refusal))`.
/// Leaves the account share-locked and the membership row (if any) update-locked.
async fn admit(
    conn: &mut PgConnection,
    token: &ShortLivedToken,
    app_id: &str,
) -> Result<Result<Account, OAuthError>, OAuthError> {
    let account = match grant_account(conn, &token.account_uuid).await? {
        Ok(account) => account,
        Err(refused) => return Ok(Err(refused)),
    };
    // Only Silicons have an STK (`stk_rotated_at` is set when it is created and on each
    // rotation). The same transaction clock stamps both, and a tie counts as "before".
    if let Some(rotated_at) = account.stk_rotated_at.filter(|at| token.created_at <= *at) {
        tracing::warn!(
            account_uuid = %account.uuid,
            app_id,
            "short-lived token minted before an STK rotation was presented; refused"
        );
        return Ok(Err(minted_before_rotation(
            &account,
            app_id,
            token.created_at,
            rotated_at,
        )));
    }
    let membership = lock_membership(conn, app_id, &account.uuid).await?;
    if let Some(refused) = removed_after_issue(
        membership.as_ref(),
        &account,
        app_id,
        token.created_at,
        "this short-lived token",
        &format!(
            "the account has to sign in to the app again with a new short-lived token (`accounts login --app {app_id}`)."
        ),
    ) {
        return Ok(Err(refused));
    }
    Ok(Ok(account))
}

/// `invalid_grant` for an SLT minted before the Silicon's STK was rotated.
fn minted_before_rotation(
    account: &Account,
    app_id: &str,
    issued_at: OffsetDateTime,
    rotated_at: OffsetDateTime,
) -> OAuthError {
    OAuthError::invalid_grant(format!(
        "The short-lived token was issued at {} by a sign-in of {} that ended when its custodian rotated its STK at {}; rotating the STK ends every sign-in of the Silicon, including the short-lived tokens issued before it. The Silicon has to sign in with its new STK and get a new short-lived token (`accounts login --app {app_id}`).",
        format_rfc3339_ms(issued_at),
        account.display_id(),
        format_rfc3339_ms(rotated_at),
    ))
}

/// One `signin_history` row (method `slt`).
async fn record_signin(
    conn: &mut PgConnection,
    account_uuid: &str,
    app_id: &str,
    meta: &ClientMeta,
    outcome: &str,
) -> Result<(), OAuthError> {
    audit::signin(
        conn,
        &SigninRecord {
            account_uuid: Some(account_uuid),
            app_id: Some(app_id),
            method: audit::method::SLT,
            outcome,
            ip: meta.ip.as_deref(),
            user_agent: meta.user_agent.as_deref(),
        },
    )
    .await?;
    Ok(())
}
