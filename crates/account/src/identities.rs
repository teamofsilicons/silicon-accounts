//! A Carbon's linked Google/Apple identities: list and disconnect.

use accounts_core::http::{CarbonAuth, ClientMeta, Json, Path};
use accounts_core::models::Provider;
use accounts_core::repo::identities;
use accounts_core::views::IdentityView;
use accounts_core::{ApiError, ApiResult, AppState};
use axum::extract::State;
use axum::http::StatusCode;
use serde_json::{Value, json};

use crate::util::{audit_self, clip, single_page, track};

/// `GET /v1/me/identities` → `{"items":[{"provider","subject","email","created_at",
/// "last_used_at"}],"next_cursor":null}`. `subject` is what DELETE needs.
pub(crate) async fn list(State(state): State<AppState>, me: CarbonAuth) -> ApiResult<Json<Value>> {
    let mut conn = state.db.acquire().await?;
    let rows = identities::list_for_account(&mut conn, me.uuid()).await?;
    let views: Vec<IdentityView> = rows.iter().map(IdentityView::from).collect();
    Ok(Json(single_page(&views)?))
}

/// `DELETE /v1/me/identities/{provider}/{subject}` → 204. Refused (409
/// `last_sign_in_method`) when it is the only way left to sign in to the account.
pub(crate) async fn unlink(
    State(state): State<AppState>,
    me: CarbonAuth,
    meta: ClientMeta,
    Path((provider, subject)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    let provider = Provider::parse(&provider.trim().to_ascii_lowercase()).ok_or_else(|| {
        ApiError::bad_request(
            "invalid_provider",
            format!(
                "'{}' is not an identity provider; Silicon Accounts links {}.",
                clip(provider.trim(), 40),
                Provider::expected()
            ),
        )
        .hint("Use the provider and subject from GET /v1/me/identities.")
    })?;
    let mut tx = state.db.begin().await?;
    // Lock the account so two disconnects can't both pass the "another way to sign in" check.
    accounts_core::repo::accounts::lock(&mut tx, me.uuid()).await?;
    let (contacts, others): (i64, i64) = sqlx::query_as(
        "select (select count(*) from account_emails where account_uuid = $1) \
              + (select count(*) from account_phones where account_uuid = $1), \
                (select count(*) from identities where account_uuid = $1 \
                   and not (provider = $2 and subject = $3))",
    )
    .bind(me.uuid())
    .bind(provider)
    .bind(&subject)
    .fetch_one(&mut *tx)
    .await?;
    let linked = identities::find(&mut tx, provider, &subject)
        .await?
        .is_some_and(|i| i.account_uuid == me.uuid());
    if linked && contacts == 0 && others == 0 {
        return Err(ApiError::conflict(
            "last_sign_in_method",
            format!(
                "This {} identity is the only way to sign in to {}: the account has no email or phone number.",
                provider.display_name(),
                me.account.display_id()
            ),
        )
        .hint("Add an email (POST /v1/me/emails) or a phone number (POST /v1/me/phones) first, then disconnect it."));
    }
    identities::remove(&mut tx, me.uuid(), provider, &subject).await?;
    audit_self(
        &mut tx,
        me.uuid(),
        "account.identity.unlinked",
        None,
        json!({ "provider": provider, "subject": subject }),
        meta.ip.as_deref(),
    )
    .await?;
    tx.commit().await?;
    track(
        &state,
        "identity",
        "account.identity.unlinked",
        json!({ "provider": provider }),
    );
    Ok(StatusCode::NO_CONTENT)
}
