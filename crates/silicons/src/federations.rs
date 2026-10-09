//! A Silicon's trust relationships for outside OIDC tokens (workload identity federation, in
//! the style of trusted publishers): a CI job's token signs the Silicon in with no stored
//! secret (core's `federation`; the exchange is the token endpoint's token-exchange grant).
//!
//! | endpoint | who | what |
//! |---|---|---|
//! | `POST /v1/silicons/{id}/federations` | the Silicon, or its custodian | `{"issuer", "audience"?, "conditions", "name"?}` → 201 the trust |
//! | `GET /v1/silicons/{id}/federations` | the same | `{"items": [trust…], "next_cursor": null}`, newest first, removed ones too |
//! | `DELETE /v1/silicons/{id}/federations/{federation_id}` | the same | 204: the trust stops working and the sign-ins it started end, with the app sign-ins made from their short-lived tokens (those apps get `membership.signed_out`, reason `session_revoked`) |
//!
//! `{id}` is the Silicon's si:id or uuid; anyone else gets 404 `silicon_not_found`. Adding a
//! trust reads the issuer's discovery document first, so a trust always names a reachable
//! https OIDC issuer (422 `issuer_unreachable` otherwise). A sign-in that itself came from an
//! outside token can't add a trust (403 `federated_session`). Every change is in the Silicon's
//! history and reaches its webhook and event stream (`silicon.federation.added`,
//! `silicon.federation.removed`).

use accounts_core::events;
use accounts_core::federation::{
    self, FEDERATION_COLUMNS, Federation, MAX_FEDERATIONS_PER_SILICON, NewFederation,
};
use accounts_core::http::{AccountAuth, ClientMeta, Json, Path};
use accounts_core::models::{Account, AccountStatus};
use accounts_core::repo::{accounts, tokens};
use accounts_core::views::AccountSummary;
use accounts_core::{ApiError, ApiResult, AppState};
use axum::extract::State;
use axum::http::StatusCode;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::common::silicon_not_found;
use crate::history::Actor;
use crate::keys::silicon_for;

/// `POST /v1/silicons/{id}/federations`.
pub(crate) async fn add(
    State(state): State<AppState>,
    me: AccountAuth,
    meta: ClientMeta,
    Path(key): Path<String>,
    Json(body): Json<NewFederation>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let valid = federation::validate(&body, &state.settings).map_err(ApiError::validation)?;
    {
        let mut conn = state.db.acquire().await?;
        silicon_for(&mut conn, &me, &key).await?;
        if federation::is_federated_session(&mut conn, &me).await? {
            return Err(federation::federated_session_refused("trust relationships"));
        }
    }
    // The issuer must be a reachable OIDC issuer before anything trusts it (outside the
    // transaction: it is a network call).
    state
        .federation
        .discover(&valid.issuer)
        .await
        .map_err(|e| {
            ApiError::unprocessable(
                "issuer_unreachable",
                format!("{} can't be trusted yet: {}.", valid.issuer, e.0),
            )
            .hint("A trusted issuer serves /.well-known/openid-configuration over https from a public address, naming itself as issuer and a jwks_uri. GitHub Actions is https://token.actions.githubusercontent.com, GitLab.com is https://gitlab.com.")
            .detail("issuer", valid.issuer.clone())
        })?;
    let mut tx = state.db.begin().await?;
    let silicon = silicon_for(&mut tx, &me, &key).await?;
    let Some(silicon) = accounts::lock(&mut tx, &silicon.uuid).await? else {
        return Err(silicon_not_found(&key));
    };
    if silicon.status != AccountStatus::Active {
        return Err(ApiError::forbidden(
            "account_not_active",
            format!(
                "{} is {}, so it can't get trust relationships.",
                silicon.display_id(),
                silicon.status
            ),
        ));
    }
    let live = federation::live_federations(&mut tx, &silicon.uuid).await?;
    if live.len() as i64 >= MAX_FEDERATIONS_PER_SILICON {
        return Err(ApiError::conflict(
            "too_many_federations",
            format!(
                "{} already has {MAX_FEDERATIONS_PER_SILICON} trust relationships, the most a Silicon may have.",
                silicon.display_id()
            ),
        )
        .hint("Remove one it no longer needs (DELETE /v1/silicons/{id}/federations/{federation_id}), then add this one."));
    }
    if let Some(same) = live.iter().find(|t| {
        t.issuer == valid.issuer
            && t.audience == valid.audience
            && t.conditions.0 == valid.conditions
    }) {
        return Err(ApiError::conflict(
            "federation_exists",
            format!(
                "{} already trusts these tokens ({}).",
                silicon.display_id(),
                same.id
            ),
        )
        .detail("federation_id", same.id.to_string()));
    }
    let row: Federation = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "insert into silicon_federations (id, silicon_uuid, name, issuer, audience, conditions, created_by) \
         values ($1, $2, $3, $4, $5, $6, $7) returning {FEDERATION_COLUMNS}"
    )))
    .bind(Uuid::now_v7())
    .bind(&silicon.uuid)
    .bind(&valid.name)
    .bind(&valid.issuer)
    .bind(&valid.audience)
    .bind(sqlx::types::Json(&valid.conditions))
    .bind(&me.account.uuid)
    .fetch_one(&mut *tx)
    .await?;
    Actor::account(&me.account.uuid, meta.ip.as_deref())
        .record_for(
            &mut tx,
            "silicon.federation.added",
            &[Some(&me.account.uuid), Some(&silicon.uuid)],
            &silicon.uuid,
            json!({
                "federation_id": row.id, "name": row.name, "issuer": row.issuer,
                "audience": row.audience, "conditions": row.conditions.0,
            }),
        )
        .await?;
    events::emit_to_silicon(
        &mut tx,
        &silicon.uuid,
        events::types::SILICON_FEDERATION_ADDED,
        json!({
            "uuid": silicon.uuid, "id": silicon.handle, "federation": row.view(),
            "by": AccountSummary::from_account(&me.account),
        }),
    )
    .await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(row.view())))
}

/// `GET /v1/silicons/{id}/federations`.
pub(crate) async fn list(
    State(state): State<AppState>,
    me: AccountAuth,
    Path(key): Path<String>,
) -> ApiResult<Json<Value>> {
    let mut conn = state.db.acquire().await?;
    let silicon = silicon_for(&mut conn, &me, &key).await?;
    let rows: Vec<Federation> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "select {FEDERATION_COLUMNS} from silicon_federations where silicon_uuid = $1 \
         order by created_at desc, id desc limit 200"
    )))
    .bind(&silicon.uuid)
    .fetch_all(&mut *conn)
    .await?;
    let items: Vec<Value> = rows.iter().map(Federation::view).collect();
    Ok(Json(json!({"items": items, "next_cursor": Value::Null})))
}

/// `DELETE /v1/silicons/{id}/federations/{federation_id}`.
pub(crate) async fn remove(
    State(state): State<AppState>,
    me: AccountAuth,
    meta: ClientMeta,
    Path((key, federation_id)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    let not_found = || {
        ApiError::not_found(
            "federation_not_found",
            format!(
                "No trust relationship '{}' belongs to this Silicon.",
                federation_id.trim()
            ),
        )
        .hint("List its trusts with GET /v1/silicons/{id}/federations.")
    };
    let id = Uuid::parse_str(federation_id.trim()).map_err(|_| not_found())?;
    let mut tx = state.db.begin().await?;
    let silicon: Account = silicon_for(&mut tx, &me, &key).await?;
    let row: Option<Federation> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "select {FEDERATION_COLUMNS} from silicon_federations where id = $1 and silicon_uuid = $2 for update"
    )))
    .bind(id)
    .bind(&silicon.uuid)
    .fetch_optional(&mut *tx)
    .await?;
    let row = row.ok_or_else(not_found)?;
    if row.revoked_at.is_some() {
        tx.commit().await?;
        return Ok(StatusCode::NO_CONTENT);
    }
    let row: Federation = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "update silicon_federations set revoked_at = now(), revoked_by = $2 where id = $1 returning {FEDERATION_COLUMNS}"
    )))
    .bind(id)
    .bind(&me.account.uuid)
    .fetch_one(&mut *tx)
    .await?;
    // The sign-ins the trust started end with it: the CI sign-ins, and the app sign-ins made
    // from the short-lived tokens they minted (whose apps hear `membership.signed_out`).
    let families: Vec<Uuid> = sqlx::query_scalar(
        "select s.family_id from silicon_federation_sessions s join token_families f on f.id = s.family_id \
         where s.federation_id = $1 and f.revoked_at is null",
    )
    .bind(id)
    .fetch_all(&mut *tx)
    .await?;
    let mut ended = Vec::with_capacity(families.len());
    for family in &families {
        if let Some(f) = tokens::revoke_family(&mut tx, *family, "federation_removed").await? {
            ended.push(f);
        }
    }
    events::signed_out_for_families(&mut tx, &ended, events::signout_reason::SESSION_REVOKED)
        .await?;
    Actor::account(&me.account.uuid, meta.ip.as_deref())
        .record_for(
            &mut tx,
            "silicon.federation.removed",
            &[Some(&me.account.uuid), Some(&silicon.uuid)],
            &silicon.uuid,
            json!({
                "federation_id": id, "name": row.name, "issuer": row.issuer,
                "ended_sessions": families.len(),
            }),
        )
        .await?;
    events::emit_to_silicon(
        &mut tx,
        &silicon.uuid,
        events::types::SILICON_FEDERATION_REMOVED,
        json!({
            "uuid": silicon.uuid, "id": silicon.handle, "federation": row.view(),
            "ended_sessions": families.len(),
            "by": AccountSummary::from_account(&me.account),
        }),
    )
    .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}
