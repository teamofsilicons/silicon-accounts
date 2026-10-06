//! HTTP handlers (routes in [`crate::router`]).

use accounts_core::crypto::prefix;
use accounts_core::http::{
    AccountAuth, AppActor, AppAuth, AppOrOwner, ClientMeta, IdempotencyKey, Json, PageParams, Path,
    Query, paginate,
};
use accounts_core::models::ActorKind;
use accounts_core::repo::audit::{self, AuditEntry};
use accounts_core::repo::idempotency;
use accounts_core::views::{AccountSummary, AppSummary, Page};
use accounts_core::{ApiError, AppState};
use axum::extract::State;
use axum::http::header::{CACHE_CONTROL, PRAGMA};
use axum::http::{HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

use crate::input::{
    IssueAtaBody, IssueOboBody, ProofReference, RefreshBody, RevokeBody, VerifyBody,
    describe_input, echo_safe,
};
use crate::issue::{self, Issuer};
use crate::model::{
    AUDIT_TARGET, ENDED_PROOF_RETENTION_DAYS, EXPIRED_TOKEN_RETENTION_DAYS, ProofKind, ProofStatus,
    action, app_revoker, revoke_reason,
};
use crate::store::{self, AppProofFilter, FamilyRow, TokenKind};
use crate::views::{AppProofItem, MyProofItem, ProofAppRef, ProofUser, ValidProof, invalid_proof};

/// Header carrying a syntactic hint on `{"valid":false}` answers (the body stays exactly the
/// contract shape; the hint only ever describes the *input*, never the proof).
pub const HINT_HEADER: &str = "x-accounts-hint";

/// Responses that carry tokens or token state must never be cached.
fn no_store(mut response: Response) -> Response {
    let h = response.headers_mut();
    h.insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    h.insert(PRAGMA, HeaderValue::from_static("no-cache"));
    response
}

// ---- issue -----------------------------------------------------------------------------------

/// `POST /v1/proofs/obo` (app, IDEMPOTENT).
pub async fn issue_obo(
    State(state): State<AppState>,
    auth: AppAuth,
    meta: ClientMeta,
    key: Option<IdempotencyKey>,
    Json(body): Json<IssueOboBody>,
) -> Result<Response, ApiError> {
    let scope = idempotency::scope(
        &format!("app:{}", auth.app.app_id),
        "POST",
        "/v1/proofs/obo",
    );
    let issuer = Issuer::app(&auth.app, meta.ip.as_deref());
    let response = idempotency::run(&state, key.as_deref(), &scope, &body, true, || async {
        let proof = issue::obo(&state, &issuer, &body).await?;
        Ok((StatusCode::CREATED, serde_json::to_value(&proof)?))
    })
    .await?;
    Ok(no_store(response))
}

/// `POST /v1/proofs/ata` (app, IDEMPOTENT).
pub async fn issue_ata(
    State(state): State<AppState>,
    auth: AppAuth,
    meta: ClientMeta,
    key: Option<IdempotencyKey>,
    Json(body): Json<IssueAtaBody>,
) -> Result<Response, ApiError> {
    let scope = idempotency::scope(
        &format!("app:{}", auth.app.app_id),
        "POST",
        "/v1/proofs/ata",
    );
    let issuer = Issuer::app(&auth.app, meta.ip.as_deref());
    let response = idempotency::run(&state, key.as_deref(), &scope, &body, true, || async {
        let proof = issue::ata(&state, &issuer, &body).await?;
        Ok((StatusCode::CREATED, serde_json::to_value(&proof)?))
    })
    .await?;
    Ok(no_store(response))
}

/// `POST /v1/apps/{app_id}/proofs/ata` (app-or-owner, IDEMPOTENT): the ATA page stand-in for
/// Silicon Apps. Same body and response as `POST /v1/proofs/ata`.
pub async fn issue_ata_for_app(
    State(state): State<AppState>,
    who: AppOrOwner,
    meta: ClientMeta,
    key: Option<IdempotencyKey>,
    Json(body): Json<IssueAtaBody>,
) -> Result<Response, ApiError> {
    let (actor_kind, actor_id) = who.audit_actor();
    let caller = match &who.actor {
        AppActor::App => format!("app:{}", who.app.app_id),
        AppActor::Owner(a) => format!("account:{}", a.uuid),
    };
    let scope = idempotency::scope(
        &caller,
        "POST",
        &format!("/v1/apps/{}/proofs/ata", who.app.app_id),
    );
    let issuer = Issuer {
        app: &who.app,
        actor_kind,
        actor_id,
        ip: meta.ip.as_deref(),
    };
    let response = idempotency::run(&state, key.as_deref(), &scope, &body, true, || async {
        let proof = issue::ata(&state, &issuer, &body).await?;
        Ok((StatusCode::CREATED, serde_json::to_value(&proof)?))
    })
    .await?;
    Ok(no_store(response))
}

// ---- refresh ---------------------------------------------------------------------------------

/// `POST /v1/proofs/refresh` (the issuing app). An optional `Idempotency-Key` makes a retried
/// refresh replay its first answer (for 10 minutes) instead of tripping reuse detection.
pub async fn refresh(
    State(state): State<AppState>,
    auth: AppAuth,
    meta: ClientMeta,
    key: Option<IdempotencyKey>,
    Json(body): Json<RefreshBody>,
) -> Result<Response, ApiError> {
    let mut fields = accounts_core::FieldErrors::new();
    if body.proof_refresh_token.trim().is_empty() {
        fields.add(
            "proof_refresh_token",
            "must be the proof refresh token (sapr_…) of the proof",
        );
    }
    let ttl = body
        .access_ttl_seconds
        .map(|v| crate::input::access_ttl(Some(v), &mut fields));
    fields.into_result()?;
    let scope = idempotency::scope(
        &format!("app:{}", auth.app.app_id),
        "POST",
        "/v1/proofs/refresh",
    );
    let response = idempotency::run(&state, key.as_deref(), &scope, &body, true, || async {
        let proof = crate::refresh::refresh(
            &state,
            &auth.app,
            &body.proof_refresh_token,
            ttl,
            meta.ip.as_deref(),
        )
        .await?;
        Ok((StatusCode::OK, serde_json::to_value(&proof)?))
    })
    .await?;
    Ok(no_store(response))
}

// ---- verify ----------------------------------------------------------------------------------

/// `POST /v1/proofs/verify` (the verifying app, which must be one of the proof's audiences).
///
/// One indexed query (plus the cached credential check of the extractor). Valid →
/// `{"valid":true,"proof_id","kind","expires_at","issuing_app","receiving_app","user","scopes"}`;
/// anything else → exactly `{"valid":false,"expires_at":null}`.
pub async fn verify(
    State(state): State<AppState>,
    auth: AppAuth,
    Json(body): Json<VerifyBody>,
) -> Result<Response, ApiError> {
    let token = body.proof_token.trim();
    if !token.starts_with(prefix::PROOF) {
        let what =
            describe_input(token).unwrap_or_else(|| "not a Silicon Accounts token".to_string());
        let hint =
            format!("proof_token must be a proof token (it starts with sap_), but this is {what}.");
        let mut response = no_store(Json(invalid_proof()).into_response());
        if let Ok(v) = HeaderValue::from_str(&hint) {
            response.headers_mut().insert(HINT_HEADER, v);
        }
        return Ok(response);
    }
    let hash = state.keys.pepper.hash(token);
    let row = store::verify_lookup(&state.db, &hash, &auth.app.app_id).await?;
    let Some(row) = row else {
        return Ok(no_store(Json(invalid_proof()).into_response()));
    };
    if let Some(reason) = row.invalid_reason() {
        tracing::debug!(proof_id = %row.proof_id, verifier = %auth.app.app_id, reason, "proof did not verify");
        return Ok(no_store(Json(invalid_proof()).into_response()));
    }
    let user = match (&row.account_uuid, row.account_kind) {
        (Some(uuid), Some(kind)) => Some(ProofUser {
            uuid: uuid.clone(),
            id: row.account_handle.clone(),
            kind,
            membership_id: accounts_core::ids::membership_id(&row.issuing_app_id, uuid),
        }),
        _ => None,
    };
    let valid = ValidProof {
        valid: true,
        proof_id: row.proof_id,
        kind: row.kind(),
        expires_at: row.token_expires_at,
        issuing_app: ProofAppRef {
            app_id: row.issuing_app_id,
            name: row.issuing_app_name,
        },
        receiving_app: ProofAppRef {
            app_id: auth.app.app_id.clone(),
            name: auth.app.name.clone(),
        },
        user,
        scopes: row.scopes,
    };
    Ok(no_store(Json(valid).into_response()))
}

// ---- revoke ----------------------------------------------------------------------------------

/// An example proof id for messages.
const EXAMPLE_PROOF_ID: &str = "01928c7e-3b7a-7c4e-9a51-2f3d4c5b6a79";

/// Parses a proof id. The value is repeated in the error only when it is short and id-shaped
/// ([`echo_safe`]); a token pasted as an id, alone or wrapped (`Bearer sap_…`), is described,
/// never echoed (Silicons log error messages).
fn parse_proof_id(raw: &str) -> Result<Uuid, ApiError> {
    let raw = raw.trim();
    Uuid::parse_str(raw).map_err(|_| {
        let message = match describe_input(raw) {
            Some(what) => format!(
                "proof_id must be a proof id (a UUID like {EXAMPLE_PROOF_ID}), but this is {what}."
            ),
            None if echo_safe(raw) => format!(
                "'{raw}' is not a proof id; proof ids are UUIDs like {EXAMPLE_PROOF_ID}."
            ),
            None => format!(
                "The proof_id sent ({} characters) is not a proof id; proof ids are UUIDs like {EXAMPLE_PROOF_ID}. It isn't repeated here because it doesn't look like an id.",
                raw.chars().count()
            ),
        };
        ApiError::bad_request("invalid_proof_id", message)
            .hint("Use the proof_id from the issue response or from a proofs listing; to revoke by token send proof_token or proof_refresh_token instead.")
    })
}

fn proof_not_found(message: String) -> ApiError {
    ApiError::not_found("proof_not_found", message)
        .hint("List the proofs you can see (GET /v1/apps/{app_id}/proofs for an app, GET /v1/me/proofs for an account) to find the right proof_id.")
}

/// 404 for a proof token / proof refresh token that matches no stored token. Besides a typo or
/// another environment, the hourly sweep may have deleted it: proof tokens a day after they
/// expire, every token of a proof 30 days after it ended.
fn unknown_proof_token(field: &str) -> ApiError {
    let why = if field == "proof_token" {
        format!(
            "it is mistyped, it belongs to another environment, or it is no longer stored (proof tokens are deleted {EXPIRED_TOKEN_RETENTION_DAYS} day after they expire, and every token of a proof {ENDED_PROOF_RETENTION_DAYS} days after the proof was revoked or expired)"
        )
    } else {
        format!(
            "it is mistyped, it belongs to another environment, or its proof was revoked or expired more than {ENDED_PROOF_RETENTION_DAYS} days ago (every token of a proof is deleted then)"
        )
    };
    ApiError::not_found(
        "proof_not_found",
        format!("No proof has this {field}: {why}."),
    )
    .hint("Revoke by proof_id instead (from the issue response or GET /v1/apps/{app_id}/proofs); a proof whose tokens were deleted can't be used any more anyway.")
}

/// Revokes `family` (if still live) and writes the audit entry. Returns whether this call
/// revoked it.
///
/// An OBO proof whose sign-in was revoked already ended then (verification has refused it
/// since); that first end is stored instead (`sign_in_revoked`, see
/// [`store::record_sign_in_revoked`]) and this call is a no-op, so the proof's history doesn't
/// change its mind about when and why it ended.
#[allow(clippy::too_many_arguments)]
async fn revoke_family(
    conn: &mut sqlx::PgConnection,
    family: &FamilyRow,
    revoked_by: &str,
    reason: &str,
    actor_kind: ActorKind,
    actor_id: &str,
    via: &str,
    ip: Option<&str>,
) -> Result<bool, ApiError> {
    if family.kind() == ProofKind::Obo
        && family.revoked_at.is_none()
        && store::record_sign_in_revoked(conn, family.id).await?
    {
        tracing::info!(proof_id = %family.id, "proof had already ended with its sign-in; stored that end");
        return Ok(false);
    }
    let revoked = store::revoke(conn, family.id, revoked_by, reason).await?;
    if revoked {
        let proof_id = family.id.to_string();
        audit::record(
            conn,
            &AuditEntry {
                target_kind: Some(AUDIT_TARGET),
                target_id: Some(&proof_id),
                app_id: Some(&family.issuing_app),
                account_uuid: family.account_uuid.as_deref(),
                details: json!({
                    "kind": family.kind().as_str(),
                    "reason": reason,
                    "via": via,
                    "audiences": family.audiences,
                }),
                ip,
                ..AuditEntry::new(actor_kind, Some(actor_id), action::REVOKED)
            },
        )
        .await?;
        tracing::info!(proof_id = %family.id, reason, "proof revoked");
    }
    Ok(revoked)
}

fn check_prefix(field: &str, token: &str, expected: &str, noun: &str) -> Result<(), ApiError> {
    let token = token.trim();
    // `sapr_…` does not start with `sap_` (and vice versa), so a plain prefix test tells them apart.
    if token.starts_with(expected) {
        return Ok(());
    }
    let what = describe_input(token).unwrap_or_else(|| "not a Silicon Accounts token".to_string());
    let mut f = accounts_core::FieldErrors::new();
    f.add(
        field,
        format!("must be {noun} (it starts with {expected}), but this is {what}"),
    );
    Err(ApiError::validation(f))
}

/// `POST /v1/proofs/revoke` (the issuing app): `{"proof_id"}` or `{"proof_token"}` or
/// `{"proof_refresh_token"}` → 204. Revoking an already revoked proof is a no-op (204).
pub async fn revoke(
    State(state): State<AppState>,
    auth: AppAuth,
    meta: ClientMeta,
    Json(body): Json<RevokeBody>,
) -> Result<StatusCode, ApiError> {
    let reference = body.reference().map_err(ApiError::validation)?;
    let app_id = auth.app.app_id.clone();
    let mut tx = state.db.begin().await?;
    let (family, via) = match &reference {
        ProofReference::Id(raw) => {
            let id = parse_proof_id(raw)?;
            match store::family(&mut tx, id).await? {
                Some(f) if f.issuing_app == app_id => (f, "proof_id"),
                // Another app's proof id: answer as if unknown (the caller holds no secret of it).
                _ => {
                    return Err(proof_not_found(format!(
                        "No proof with id {id} was issued by '{app_id}'."
                    )));
                }
            }
        }
        ProofReference::Token(t) | ProofReference::RefreshToken(t) => {
            let (field, kind, expected, noun) = if matches!(reference, ProofReference::Token(_)) {
                (
                    "proof_token",
                    TokenKind::Access,
                    prefix::PROOF,
                    "a proof token",
                )
            } else {
                (
                    "proof_refresh_token",
                    TokenKind::Refresh,
                    prefix::PROOF_REFRESH,
                    "a proof refresh token",
                )
            };
            check_prefix(field, t, expected, noun)?;
            let family = store::family_by_token(&mut tx, &state.keys.pepper, t, kind)
                .await?
                .ok_or_else(|| unknown_proof_token(field))?;
            if family.issuing_app != app_id {
                return Err(ApiError::forbidden(
                    "not_issuing_app",
                    format!(
                        "This {field} belongs to a proof issued by '{}'; only the issuing app can revoke it, and '{app_id}' is calling.",
                        family.issuing_app
                    ),
                )
                .hint("A receiving app that no longer trusts a proof can simply stop accepting it; the issuing app revokes it."));
            }
            (family, field)
        }
    };
    revoke_family(
        &mut tx,
        &family,
        &app_revoker(&app_id),
        revoke_reason::REVOKED_BY_APP,
        ActorKind::App,
        &app_id,
        via,
        meta.ip.as_deref(),
    )
    .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

/// `DELETE /v1/apps/{app_id}/proofs/{proof_id}` (app-or-owner) → 204.
pub async fn revoke_app_proof(
    State(state): State<AppState>,
    who: AppOrOwner,
    meta: ClientMeta,
    Path((_app_id, proof_id)): Path<(String, String)>,
) -> Result<StatusCode, ApiError> {
    let id = parse_proof_id(&proof_id)?;
    let app_id = who.app.app_id.clone();
    let mut tx = state.db.begin().await?;
    let family = match store::family(&mut tx, id).await? {
        Some(f) if f.issuing_app == app_id => f,
        _ => {
            return Err(proof_not_found(format!(
                "No proof with id {id} was issued by '{app_id}'."
            )));
        }
    };
    let (actor_kind, actor_id) = who.audit_actor();
    let (revoked_by, reason) = match &who.actor {
        AppActor::App => (app_revoker(&app_id), revoke_reason::REVOKED_BY_APP),
        AppActor::Owner(a) => (a.uuid.clone(), revoke_reason::REVOKED_BY_OWNER),
    };
    revoke_family(
        &mut tx,
        &family,
        &revoked_by,
        reason,
        actor_kind,
        &actor_id,
        "proof_id",
        meta.ip.as_deref(),
    )
    .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

/// `DELETE /v1/me/proofs/{proof_id}` (session): revoke an OBO proof issued on your behalf → 204.
pub async fn revoke_my_proof(
    State(state): State<AppState>,
    me: AccountAuth,
    meta: ClientMeta,
    Path(proof_id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let id = parse_proof_id(&proof_id)?;
    let mut tx = state.db.begin().await?;
    let family = match store::family(&mut tx, id).await? {
        Some(f) if f.kind() == ProofKind::Obo && f.account_uuid.as_deref() == Some(me.uuid()) => f,
        _ => {
            return Err(proof_not_found(format!(
                "No OBO proof with id {id} was issued on behalf of {}.",
                me.account.display_id()
            ))
            .hint("List your proofs with GET /v1/me/proofs (or `accounts proofs list`)."));
        }
    };
    revoke_family(
        &mut tx,
        &family,
        me.uuid(),
        revoke_reason::REVOKED_BY_ACCOUNT,
        ActorKind::Account,
        me.uuid(),
        "proof_id",
        meta.ip.as_deref(),
    )
    .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

// ---- listings --------------------------------------------------------------------------------

/// `?kind=obo|ata&status=active|revoked|expired&limit&cursor`.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AppProofsQuery {
    #[serde(default)]
    pub kind: Option<ProofKind>,
    #[serde(default)]
    pub status: Option<ProofStatus>,
    #[serde(default)]
    pub limit: Option<i64>,
    #[serde(default)]
    pub cursor: Option<String>,
}

/// `?status=active|revoked|expired&limit&cursor`.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MyProofsQuery {
    #[serde(default)]
    pub status: Option<ProofStatus>,
    #[serde(default)]
    pub limit: Option<i64>,
    #[serde(default)]
    pub cursor: Option<String>,
}

fn parse_status(s: &str) -> ProofStatus {
    match s {
        "revoked" => ProofStatus::Revoked,
        "expired" => ProofStatus::Expired,
        _ => ProofStatus::Active,
    }
}

/// `GET /v1/apps/{app_id}/proofs` (app-or-owner): proofs the app issued, newest first.
pub async fn list_app_proofs(
    State(state): State<AppState>,
    who: AppOrOwner,
    Query(q): Query<AppProofsQuery>,
) -> Result<Response, ApiError> {
    let page = PageParams {
        limit: q.limit,
        cursor: q.cursor.clone(),
    };
    let limit = page.limit();
    let after = store::cursor_bounds(page.cursor()?)?;
    let mut conn = state.db.acquire().await?;
    let rows = store::list_for_app(
        &mut conn,
        &who.app.app_id,
        &AppProofFilter {
            kind: q.kind.as_ref().map(ProofKind::as_str),
            status: q.status.as_ref().map(ProofStatus::as_str),
            after,
            fetch: limit + 1,
        },
    )
    .await?;
    let page: Page<store::AppProofRow> =
        paginate(rows, limit, |r| store::cursor_of(r.created_at, r.id));
    let items: Vec<AppProofItem> = page.items.into_iter().map(app_item).collect();
    Ok(Json(Page::new(items, page.next_cursor)).into_response())
}

fn app_item(r: store::AppProofRow) -> AppProofItem {
    let kind = ProofKind::parse(&r.kind).unwrap_or(ProofKind::Obo);
    let user = match (r.account_uuid, r.account_kind, r.account_status) {
        (Some(uuid), Some(account_kind), Some(status)) => Some(AccountSummary {
            uuid,
            kind: account_kind,
            id: r.account_handle,
            display_name: r.account_display_name.unwrap_or_default(),
            pfp_url: r.account_pfp_url.unwrap_or_default(),
            status,
        }),
        _ => None,
    };
    AppProofItem {
        proof_id: r.id,
        kind,
        audiences: r.audiences,
        user,
        scopes: r.scopes,
        status: parse_status(&r.status),
        access_ttl_seconds: r.access_ttl_seconds,
        created_at: r.created_at,
        expires_at: r.expires_at,
        token_expires_at: r.token_expires_at,
        last_refreshed_at: r.last_refreshed_at,
        revoked_at: r.revoked_at,
        revoke_reason: r.revoke_reason,
    }
}

/// `GET /v1/me/proofs` (session): OBO proofs issued on the signed-in account's behalf.
pub async fn list_my_proofs(
    State(state): State<AppState>,
    me: AccountAuth,
    Query(q): Query<MyProofsQuery>,
) -> Result<Response, ApiError> {
    let page = PageParams {
        limit: q.limit,
        cursor: q.cursor.clone(),
    };
    let limit = page.limit();
    let after = store::cursor_bounds(page.cursor()?)?;
    let mut conn = state.db.acquire().await?;
    let rows = store::list_for_account(
        &mut conn,
        me.uuid(),
        q.status.as_ref().map(ProofStatus::as_str),
        after,
        limit + 1,
    )
    .await?;
    let page: Page<store::MyProofRow> =
        paginate(rows, limit, |r| store::cursor_of(r.created_at, r.id));
    let items: Vec<MyProofItem> = page.items.into_iter().map(my_item).collect();
    Ok(Json(Page::new(items, page.next_cursor)).into_response())
}

fn my_item(r: store::MyProofRow) -> MyProofItem {
    let receiving_id = r.receiving_app_id.unwrap_or_default();
    MyProofItem {
        proof_id: r.id,
        issuing_app: AppSummary {
            app_id: r.issuing_app_id,
            name: r.issuing_app_name,
            logo_url: r.issuing_logo_url,
            logo_dark_url: r.issuing_logo_dark_url,
            homepage_url: r.issuing_homepage_url,
        },
        receiving_app: AppSummary {
            name: r.receiving_app_name.unwrap_or_else(|| receiving_id.clone()),
            app_id: receiving_id,
            logo_url: r.receiving_logo_url,
            logo_dark_url: r.receiving_logo_dark_url,
            homepage_url: r.receiving_homepage_url,
        },
        scopes: r.scopes,
        status: parse_status(&r.status),
        created_at: r.created_at,
        expires_at: r.expires_at,
        token_expires_at: r.token_expires_at,
        last_refreshed_at: r.last_refreshed_at,
        revoked_at: r.revoked_at,
        revoke_reason: r.revoke_reason,
    }
}
