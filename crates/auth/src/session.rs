//! Browser session endpoints: `GET /v1/session`, `POST /v1/session/signout`.

use accounts_core::http::cookies::{SESSION_COOKIE, SIGNUP_COOKIE, append_cookie, clear_cookie};
use accounts_core::http::{AccountAuth, AuthVia, ClientMeta};
use accounts_core::models::ActorKind;
use accounts_core::repo::audit::{self, AuditEntry};
use accounts_core::repo::{sessions, tokens};
use accounts_core::timefmt::format_rfc3339_ms;
use accounts_core::views::AccountSummary;
use accounts_core::{ApiError, ApiResult, AppState};
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::json;

use crate::flow::signup;
use crate::util::no_store;

/// `GET /v1/session` (session): the signed-in account and its session.
///
/// Cookie: `{"account": AccountSummary, "session": {"id","kind":"browser","created_at",
/// "expires_at","last_seen_at"}}`. A first-party Bearer token describes its sign-in instead
/// (`"kind":"token"`, `access_token_expires_at`).
pub async fn get_session(State(state): State<AppState>, auth: AccountAuth) -> ApiResult<Response> {
    let mut conn = state.db.acquire().await?;
    let session = match &auth.via {
        AuthVia::Session { session_id } => {
            let s = sessions::get(&mut conn, *session_id)
                .await?
                .ok_or_else(|| {
                    ApiError::unauthenticated(
                        "session_expired",
                        "This browser session no longer exists.",
                    )
                })?;
            json!({
                "id": s.id,
                "kind": "browser",
                "created_at": format_rfc3339_ms(s.created_at),
                "expires_at": format_rfc3339_ms(s.expires_at),
                "last_seen_at": format_rfc3339_ms(s.last_seen_at),
            })
        }
        AuthVia::Bearer { family_id, claims } => {
            let f = tokens::find_family(&mut conn, *family_id)
                .await?
                .ok_or_else(|| {
                    ApiError::unauthenticated(
                        "token_revoked",
                        "The sign-in behind this access token no longer exists.",
                    )
                })?;
            let access_exp = time::OffsetDateTime::from_unix_timestamp(claims.exp)
                .map(format_rfc3339_ms)
                .ok();
            json!({
                "id": f.id,
                "kind": "token",
                "label": f.label,
                "created_at": format_rfc3339_ms(f.created_at),
                "expires_at": format_rfc3339_ms(f.expires_at),
                "last_seen_at": f.last_used_at.map(format_rfc3339_ms),
                "access_token_expires_at": access_exp,
            })
        }
    };
    let mut response = axum::Json(json!({
        "account": AccountSummary::from_account(&auth.account),
        "session": session,
    }))
    .into_response();
    no_store(response.headers_mut());
    Ok(response)
}

/// `POST /v1/session/signout` (session): revokes this browser session (or, with a Bearer
/// token, its first-party sign-in) and clears the cookies. 204. Signing out of the account
/// site doesn't sign the account out of apps.
pub async fn signout(
    State(state): State<AppState>,
    meta: ClientMeta,
    headers: HeaderMap,
    auth: Option<AccountAuth>,
) -> Response {
    let clear = |mut r: Response| {
        append_cookie(
            r.headers_mut(),
            &clear_cookie(&state.settings, SESSION_COOKIE),
        );
        append_cookie(
            r.headers_mut(),
            &clear_cookie(&state.settings, SIGNUP_COOKIE),
        );
        no_store(r.headers_mut());
        r
    };
    let Some(auth) = auth else {
        let e = ApiError::unauthenticated(
            "unauthenticated",
            "Nothing to sign out: this request carries no live session cookie or access token.",
        )
        .hint("The browser is already signed out.");
        return clear(e.into_response());
    };
    match do_signout(&state, &meta, &headers, &auth).await {
        Ok(()) => clear(StatusCode::NO_CONTENT.into_response()),
        Err(e) => e.into_response(),
    }
}

async fn do_signout(
    state: &AppState,
    meta: &ClientMeta,
    headers: &HeaderMap,
    auth: &AccountAuth,
) -> ApiResult<()> {
    let mut tx = state.db.begin().await?;
    let what = match &auth.via {
        AuthVia::Session { session_id } => {
            sessions::revoke(&mut tx, auth.uuid(), *session_id).await?;
            // A sign-up started in this browser shouldn't outlive the sign-out (shared devices).
            if let Some(s) = signup::from_cookie(&mut tx, state, headers).await?
                && s.is_live()
            {
                signup::expire_session(&mut tx, s.id).await?;
            }
            "browser"
        }
        AuthVia::Bearer { family_id, .. } => {
            tokens::revoke_family(
                &mut tx,
                *family_id,
                accounts_core::events::signout_reason::USER_SIGNED_OUT,
            )
            .await?;
            "token"
        }
    };
    audit::record(
        &mut tx,
        &AuditEntry {
            account_uuid: Some(auth.uuid()),
            target_kind: Some("session"),
            details: json!({"kind": what}),
            ip: meta.ip.as_deref(),
            ..AuditEntry::new(ActorKind::Account, Some(auth.uuid()), "session.signed_out")
        },
    )
    .await?;
    tx.commit().await?;
    Ok(())
}
