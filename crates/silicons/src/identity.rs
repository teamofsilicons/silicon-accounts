//! Identity tokens: a signed-in Silicon gets an OpenID Connect ID token for an outside service
//! (AWS STS, Google Cloud workload identity federation, Microsoft Entra), so the cloud trusts
//! the Silicon itself and no cloud key is stored anywhere (core's `identity_tokens`).
//!
//! | endpoint | who | what |
//! |---|---|---|
//! | `GET /v1/silicons/{id}/identity-audiences` | the Silicon, or its custodian | `{"silicon", "audiences"}` |
//! | `PUT /v1/silicons/{id}/identity-audiences` | its custodian | `{"audiences": [..]}` replaces the list (`[]` = none) |
//! | `POST /v1/me/identity-tokens` | a signed-in Silicon | `{"audience", "ttl_seconds"?}` → 201 `{"identity_token", …}` |
//!
//! The custodian decides which audiences a Silicon may get tokens for, and a new Silicon may
//! get none (403 `audience_not_allowed`), so nothing changes for a Silicon until its custodian
//! opts in. Tokens live 60 to 3600 seconds (default 300). Every issued token is in the
//! Silicon's and the custodian's history (never the token itself), and every change of the list
//! reaches the Silicon's webhook and event stream (`silicon.identity_audiences.changed`).

use accounts_core::events;
use accounts_core::http::{AccountAuth, ClientMeta, Json, Path};
use accounts_core::identity_tokens::{
    self, DEFAULT_TTL_SECONDS, IdentityClaims, MAX_AUDIENCES, MAX_TTL_SECONDS, MIN_TTL_SECONDS,
    TOKEN_USE_IDENTITY,
};
use accounts_core::models::{Account, AccountKind};
use accounts_core::repo::{accounts, rate_limit};
use accounts_core::timefmt::format_rfc3339_ms;
use accounts_core::views::AccountSummary;
use accounts_core::{ApiError, ApiResult, AppState, FieldErrors};
use axum::extract::State;
use axum::http::StatusCode;
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::PgConnection;
use time::OffsetDateTime;

use crate::common::{lock_live_session, silicon_not_found};
use crate::history::Actor;
use crate::keys::silicon_for;

/// Identity tokens one Silicon may get per minute.
pub const IDENTITY_TOKENS_PER_SILICON: rate_limit::Limit = rate_limit::Limit::new(60, 60);

async fn audiences_of(conn: &mut PgConnection, silicon_uuid: &str) -> ApiResult<Vec<String>> {
    Ok(
        sqlx::query_scalar("select identity_audiences from accounts where uuid = $1")
            .bind(silicon_uuid)
            .fetch_optional(&mut *conn)
            .await?
            .unwrap_or_default(),
    )
}

fn audiences_view(silicon: &Account, audiences: &[String]) -> Value {
    json!({
        "silicon": {"uuid": silicon.uuid, "id": silicon.handle},
        "audiences": audiences,
    })
}

/// `GET /v1/silicons/{id}/identity-audiences`.
pub(crate) async fn get_audiences(
    State(state): State<AppState>,
    me: AccountAuth,
    Path(key): Path<String>,
) -> ApiResult<Json<Value>> {
    let mut conn = state.db.acquire().await?;
    let silicon = silicon_for(&mut conn, &me, &key).await?;
    let audiences = audiences_of(&mut conn, &silicon.uuid).await?;
    Ok(Json(audiences_view(&silicon, &audiences)))
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct AudiencesBody {
    audiences: Vec<String>,
}

/// `PUT /v1/silicons/{id}/identity-audiences` (the custodian only).
pub(crate) async fn set_audiences(
    State(state): State<AppState>,
    me: AccountAuth,
    meta: ClientMeta,
    Path(key): Path<String>,
    Json(body): Json<AudiencesBody>,
) -> ApiResult<Json<Value>> {
    let mut fields = FieldErrors::new();
    if body.audiences.len() > MAX_AUDIENCES {
        fields.add(
            "audiences",
            format!(
                "at most {MAX_AUDIENCES} audiences, got {}",
                body.audiences.len()
            ),
        );
    }
    let mut list: Vec<String> = Vec::new();
    for (i, raw) in body.audiences.iter().enumerate() {
        match identity_tokens::validate_audience(raw, state.settings.issuer()) {
            Ok(a) if !list.contains(&a) => list.push(a),
            Ok(_) => {}
            Err(why) => fields.add(format!("audiences[{i}]"), why),
        }
    }
    if !fields.is_empty() {
        return Err(ApiError::validation(fields));
    }
    let mut tx = state.db.begin().await?;
    let silicon = silicon_for(&mut tx, &me, &key).await?;
    if silicon.custodian_uuid.as_deref() != Some(me.uuid()) {
        return Err(ApiError::forbidden(
            "custodian_only",
            format!(
                "Only {}'s custodian decides which outside services it may get identity tokens for.",
                silicon.display_id()
            ),
        )
        .hint("Ask your custodian: `silicon-accounts silicon audiences allow <si:id> <audience>`."));
    }
    let Some(silicon) = accounts::lock(&mut tx, &silicon.uuid).await? else {
        return Err(silicon_not_found(&key));
    };
    let before = audiences_of(&mut tx, &silicon.uuid).await?;
    sqlx::query("update accounts set identity_audiences = $2, updated_at = now() where uuid = $1")
        .bind(&silicon.uuid)
        .bind(&list)
        .execute(&mut *tx)
        .await?;
    if before != list {
        Actor::account(me.uuid(), meta.ip.as_deref())
            .record_for(
                &mut tx,
                "silicon.identity_audiences.set",
                &[Some(me.uuid()), Some(&silicon.uuid)],
                &silicon.uuid,
                json!({"audiences": list, "before": before}),
            )
            .await?;
        events::emit_to_silicon(
            &mut tx,
            &silicon.uuid,
            events::types::SILICON_IDENTITY_AUDIENCES_CHANGED,
            json!({
                "uuid": silicon.uuid, "id": silicon.handle, "audiences": list,
                "by": AccountSummary::from_account(&me.account),
            }),
        )
        .await?;
    }
    tx.commit().await?;
    Ok(Json(audiences_view(&silicon, &list)))
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct IdentityTokenBody {
    audience: String,
    #[serde(default)]
    ttl_seconds: Option<i64>,
}

/// `POST /v1/me/identity-tokens`.
pub(crate) async fn issue(
    State(state): State<AppState>,
    me: AccountAuth,
    meta: ClientMeta,
    Json(body): Json<IdentityTokenBody>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    if me.kind() != AccountKind::Silicon {
        return Err(ApiError::forbidden(
            "silicon_only",
            "Identity tokens prove a Silicon to an outside service; Carbons sign in to those services themselves.",
        )
        .hint("Sign in as the Silicon (`silicon-accounts login --silicon si:<id> --stk-stdin`) and ask again."));
    }
    let ttl = body.ttl_seconds.unwrap_or(DEFAULT_TTL_SECONDS);
    if !(MIN_TTL_SECONDS..=MAX_TTL_SECONDS).contains(&ttl) {
        let mut f = FieldErrors::new();
        f.add(
            "ttl_seconds",
            format!("between {MIN_TTL_SECONDS} and {MAX_TTL_SECONDS} seconds, got {ttl}"),
        );
        return Err(ApiError::validation(f));
    }
    let audience = body.audience.trim().to_string();
    if audience.is_empty() {
        let mut f = FieldErrors::new();
        f.add(
            "audience",
            "the outside service's audience, e.g. sts.amazonaws.com",
        );
        return Err(ApiError::validation(f));
    }
    let signer = state.identity_signer().await?;
    let mut tx = state.db.begin().await?;
    let silicon = lock_live_session(&mut tx, &me, "get an identity token").await?;
    let allowed = audiences_of(&mut tx, &silicon.uuid).await?;
    if !allowed.contains(&audience) {
        return Err(ApiError::forbidden(
            "audience_not_allowed",
            format!(
                "{}'s custodian {} so it can't get an identity token for '{}'.",
                silicon.display_id(),
                if allowed.is_empty() {
                    "hasn't allowed any audience yet,".to_string()
                } else {
                    format!("only allows {},", allowed.join(", "))
                },
                audience.chars().take(100).collect::<String>()
            ),
        )
        .hint("Ask your custodian to allow it: `silicon-accounts silicon audiences allow <si:id> <audience>`.")
        .detail("audience", audience)
        .detail("allowed_audiences", allowed));
    }
    rate_limit::enforce(
        &mut tx,
        &rate_limit::bucket("identity_tokens:silicon", &silicon.uuid),
        IDENTITY_TOKENS_PER_SILICON,
        "identity tokens for this Silicon",
    )
    .await?;
    let custodian = silicon.custodian_uuid.clone().unwrap_or_default();
    let now = OffsetDateTime::now_utc().unix_timestamp();
    let claims = IdentityClaims {
        iss: state.settings.issuer().to_string(),
        sub: silicon.uuid.clone(),
        aud: audience.clone(),
        iat: now,
        nbf: now,
        exp: now + ttl,
        jti: uuid::Uuid::now_v7().to_string(),
        kind: "silicon".into(),
        si_id: silicon.id().to_string(),
        custodian: custodian.clone(),
        token_use: TOKEN_USE_IDENTITY.into(),
    };
    let token = signer.sign(&claims).map_err(ApiError::internal)?;
    let expires_at = OffsetDateTime::from_unix_timestamp(claims.exp)
        .map(format_rfc3339_ms)
        .unwrap_or_default();
    let issued_at = OffsetDateTime::from_unix_timestamp(claims.iat)
        .map(format_rfc3339_ms)
        .unwrap_or_default();
    Actor::account(me.uuid(), meta.ip.as_deref())
        .record_for(
            &mut tx,
            "silicon.identity_token.issued",
            &[Some(&silicon.uuid), silicon.custodian_uuid.as_deref()],
            &silicon.uuid,
            json!({
                "audience": audience, "jti": claims.jti, "ttl_seconds": ttl,
                "expires_at": expires_at,
            }),
        )
        .await?;
    tx.commit().await?;
    Ok((
        StatusCode::CREATED,
        Json(json!({
            "identity_token": token,
            "token_type": "urn:ietf:params:oauth:token-type:id_token",
            "issuer": claims.iss,
            "subject": claims.sub,
            "audience": claims.aud,
            "jti": claims.jti,
            "kid": signer.kid(),
            "issued_at": issued_at,
            "expires_at": expires_at,
            "expires_in": ttl,
        })),
    ))
}
