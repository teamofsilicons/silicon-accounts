//! `grant_type=urn:silicon:params:oauth:grant-type:slt` (alias `slt`): an app exchanges a
//! short-lived token a Silicon (or a Carbon's CLI) got for it with `POST /v1/me/short-lived-tokens`.
//!
//! Single use, 120 s, bound to one app (core's `repo::tokens::consume_slt`). A successful
//! exchange is a sign-in: the membership becomes active (source `slt` when new, scopes added to
//! what the account granted before), the sign-in is recorded, and tokens are issued with the
//! SLT's scopes.
//!
//! The app authenticates with its secret, or, when it turned on `public_client` (its own
//! command-line or desktop tool, which has no server to keep a secret in), with its `client_id`
//! alone (the token endpoint decides which). A sign-in through such a public client is recorded
//! with method `slt_public_client` instead of `slt`.
//!
//! An SLT minted by a sign-in from a trusted outside token (a CI job, see core's `federation`)
//! carries that sign-in's end (`short_lived_tokens.family_expires_cap`) and trust: the app sign-in it
//! starts ends no later than the CI sign-in did, is refused once the trust is removed, and is
//! linked to the trust (`silicon_federation_sessions`) so removing the trust later ends it too.
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
            "slt is required for grant_type={SLT_GRANT_TYPE}: send the short-lived token (slt_...) the Silicon handed you; it gets one with `silicon-accounts login --app <app_id>`."
        ))
    })?;
    let app_id = client.app.app_id.as_str();
    // Consumed (and committed) first: a refused exchange still uses the token up.
    let token = tokens::consume_slt(&state.db, &state.keys.pepper, slt, app_id)
        .await
        .map_err(|e| e.to_oauth())?;

    // A secretless exchange (the app's public client) is recorded as such.
    let method = if client.public {
        audit::method::SLT_PUBLIC_CLIENT
    } else {
        audit::method::SLT
    };
    let mut tx = state.db.begin().await?;
    let account = match admit(&mut tx, &token, app_id).await? {
        Ok(account) => account,
        Err(refused) => {
            record_signin(
                &mut tx,
                &token.account_uuid,
                app_id,
                meta,
                method,
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
        method,
        audit::outcome::SUCCESS,
    )
    .await?;
    let request = IssueRequest {
        account: &account,
        app_id,
        origin: TokenOrigin::Slt,
        scopes: &scopes,
        browser_session_id: None,
        label: None,
        ip: meta.ip.as_deref(),
        user_agent: meta.user_agent.as_deref(),
        nonce: None,
        auth_time: None,
    };
    let response = match (token.federation_id, token.family_expires_cap) {
        // Minted by a sign-in from a trusted outside token: this sign-in ends when that one
        // does, and belongs to the same trust, so removing the trust ends it too.
        (Some(federation_id), Some(ends_by)) => {
            let (response, family) =
                tokens::issue_tokens_until(&mut tx, &state.keys, &state.settings, request, ends_by)
                    .await?;
            sqlx::query(
                "insert into silicon_federation_sessions (family_id, federation_id) values ($1, $2)",
            )
            .bind(family.id)
            .bind(federation_id)
            .execute(&mut *tx)
            .await?;
            response
        }
        _ => tokens::issue_tokens(&mut tx, &state.keys, &state.settings, request).await?,
    };
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
    if let Some(refused) = outside_bounds(conn, token, &account, app_id).await? {
        return Ok(Err(refused));
    }
    let membership = lock_membership(conn, app_id, &account.uuid).await?;
    if let Some(refused) = removed_after_issue(
        membership.as_ref(),
        &account,
        app_id,
        token.created_at,
        "this short-lived token",
        &format!(
            "the account has to sign in to the app again with a new short-lived token (`silicon-accounts login --app {app_id}`)."
        ),
    ) {
        return Ok(Err(refused));
    }
    Ok(Ok(account))
}

/// For an SLT minted by a sign-in from a trusted outside token: `invalid_grant` when the trust
/// was removed (or the minting sign-in has ended) since. The trust row is share-locked until the
/// transaction ends, and removing a trust update-locks it before it ends the sign-ins linked to
/// it: either the removal waits for this exchange and then ends the sign-in it issued, or this
/// exchange waits for the removal and refuses.
async fn outside_bounds(
    conn: &mut PgConnection,
    token: &ShortLivedToken,
    account: &Account,
    app_id: &str,
) -> Result<Option<OAuthError>, OAuthError> {
    let (Some(federation_id), Some(ends_by)) = (token.federation_id, token.family_expires_cap)
    else {
        return Ok(None);
    };
    let again = format!(
        "a CI job signs the Silicon in again with a fresh outside token, then gets a new short-lived token (`silicon-accounts login --app {app_id}`)."
    );
    let trust: Option<(String, Option<OffsetDateTime>, bool)> = sqlx::query_as(
        "select name, revoked_at, $2 <= now() from silicon_federations where id = $1 for share",
    )
    .bind(federation_id)
    .bind(ends_by)
    .fetch_optional(&mut *conn)
    .await?;
    let refused = match trust {
        None => Some(format!(
            "The short-lived token was issued by a sign-in of {} from a trusted outside token, and that trust no longer exists; {again}",
            account.display_id()
        )),
        Some((name, Some(removed_at), _)) => Some(format!(
            "The short-lived token was issued by a sign-in of {} from a trusted outside token, and its custodian or the Silicon removed that trust ('{name}') at {}, which ended the sign-ins it started; {again}",
            account.display_id(),
            format_rfc3339_ms(removed_at)
        )),
        Some((_, None, true)) => Some(format!(
            "The short-lived token was issued by a sign-in of {} from a trusted outside token, and that sign-in ended at {}; a sign-in made from it can't last longer, so {again}",
            account.display_id(),
            format_rfc3339_ms(ends_by)
        )),
        Some((_, None, false)) => None,
    };
    Ok(refused.map(|m| {
        tracing::warn!(account_uuid = %account.uuid, app_id, %federation_id, "short-lived token from an ended or removed trusted sign-in was presented; refused");
        OAuthError::invalid_grant(m)
    }))
}

/// `invalid_grant` for an SLT minted before the Silicon's STK was rotated.
fn minted_before_rotation(
    account: &Account,
    app_id: &str,
    issued_at: OffsetDateTime,
    rotated_at: OffsetDateTime,
) -> OAuthError {
    OAuthError::invalid_grant(format!(
        "The short-lived token was issued at {} by a sign-in of {} that ended when its custodian rotated its STK at {}; rotating the STK ends every sign-in of the Silicon, including the short-lived tokens issued before it. The Silicon has to sign in with its new STK and get a new short-lived token (`silicon-accounts login --app {app_id}`).",
        format_rfc3339_ms(issued_at),
        account.display_id(),
        format_rfc3339_ms(rotated_at),
    ))
}

/// One `signin_history` row (method `slt`, or `slt_public_client` for a secretless exchange).
async fn record_signin(
    conn: &mut PgConnection,
    account_uuid: &str,
    app_id: &str,
    meta: &ClientMeta,
    method: &str,
    outcome: &str,
) -> Result<(), OAuthError> {
    audit::signin(
        conn,
        &SigninRecord {
            account_uuid: Some(account_uuid),
            app_id: Some(app_id),
            method,
            outcome,
            ip: meta.ip.as_deref(),
            user_agent: meta.user_agent.as_deref(),
        },
    )
    .await?;
    Ok(())
}
