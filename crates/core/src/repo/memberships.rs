//! Memberships: an account's relationship with an app (`{app_id}:{uuid}`).

use serde_json::Value;
use sqlx::{Connection, PgConnection};

use crate::error::{ApiError, ApiResult};
use crate::models::{
    Membership, MembershipSource, Scope, normalize_scopes, scope_strings, scopes_from_strings,
};

/// How sign-in scopes combine with what the account granted before.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GrantMode {
    /// The new grant replaces the old one (consent screen: unticked optional scopes are dropped).
    Replace,
    /// The new scopes are added to the old ones (SLT, continue-as).
    Union,
}

/// Fetches a membership.
pub async fn get(
    conn: &mut PgConnection,
    app_id: &str,
    account_uuid: &str,
) -> ApiResult<Option<Membership>> {
    Ok(sqlx::query_as::<_, Membership>(concat!(
        "select ",
        crate::membership_columns!(),
        " from memberships where app_id = $1 and account_uuid = $2"
    ))
    .bind(app_id)
    .bind(account_uuid)
    .fetch_optional(&mut *conn)
    .await?)
}

/// Records a sign-in: creates the membership or makes it `active` again, sets granted scopes
/// (see [`GrantMode`]) and the sign-in times. `source` is only used when the membership is new.
pub async fn upsert_signin(
    conn: &mut PgConnection,
    app_id: &str,
    account_uuid: &str,
    source: MembershipSource,
    scopes: &[Scope],
    mode: GrantMode,
) -> ApiResult<Membership> {
    let mut tx = conn.begin().await?;
    let existing = sqlx::query_as::<_, Membership>(concat!(
        "select ",
        crate::membership_columns!(),
        " from memberships where app_id = $1 and account_uuid = $2 for update"
    ))
    .bind(app_id)
    .bind(account_uuid)
    .fetch_optional(&mut *tx)
    .await?;
    let mut granted: Vec<Scope> = scopes.to_vec();
    if let (Some(m), GrantMode::Union) = (&existing, mode)
        && m.status != crate::models::MembershipStatus::AccessRemoved
    {
        granted.extend(scopes_from_strings(&m.granted_scopes));
    }
    let granted = scope_strings(&normalize_scopes(granted));
    let membership = sqlx::query_as::<_, Membership>(concat!(
        "insert into memberships (app_id, account_uuid, status, source, granted_scopes, first_signed_in_at, last_signed_in_at) \
         values ($1, $2, 'active', $3, $4, now(), now()) \
         on conflict (app_id, account_uuid) do update set status = 'active', granted_scopes = excluded.granted_scopes, \
           first_signed_in_at = coalesce(memberships.first_signed_in_at, now()), last_signed_in_at = now(), \
           access_removed_at = null, updated_at = now() \
         returning ",
        crate::membership_columns!()
    ))
    .bind(app_id)
    .bind(account_uuid)
    .bind(source)
    .bind(&granted)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(membership)
}

/// Creates or updates an imported membership. A membership that is already `active` stays
/// active; `external_id` is set when given; `imported_profile` is written when the membership is
/// new or `overwrite_profile` is true. Error: 409 `external_id_conflict` when another account of
/// this app already uses the external id.
///
/// A membership whose account **removed the app's access** is returned untouched (status
/// `access_removed`; check it to report the row as skipped): an import must never undo that
/// decision, nor bring back the app's webhooks about the account or put it back in the app's
/// user base. Only the account signing in to the app again (`upsert_signin`) reactivates it.
pub async fn upsert_imported(
    conn: &mut PgConnection,
    app_id: &str,
    account_uuid: &str,
    external_id: Option<&str>,
    imported_profile: Option<&Value>,
    overwrite_profile: bool,
) -> ApiResult<Membership> {
    let result = sqlx::query_as::<_, Membership>(concat!(
        "insert into memberships (app_id, account_uuid, status, source, external_id, imported_profile) \
         values ($1, $2, 'imported', 'import', $3, $4) \
         on conflict (app_id, account_uuid) do update set \
           external_id = coalesce($3, memberships.external_id), \
           imported_profile = case when $5 or memberships.imported_profile is null then coalesce($4, memberships.imported_profile) \
                                   else memberships.imported_profile end, \
           updated_at = now() \
         where memberships.status <> 'access_removed' \
         returning ",
        crate::membership_columns!()
    ))
    .bind(app_id)
    .bind(account_uuid)
    .bind(external_id)
    .bind(imported_profile)
    .bind(overwrite_profile)
    .fetch_optional(&mut *conn)
    .await;
    match result {
        Ok(Some(m)) => Ok(m),
        Ok(None) => get(conn, app_id, account_uuid).await?.ok_or_else(|| {
            ApiError::internal(format!(
                "membership {app_id}:{account_uuid} vanished during an import upsert"
            ))
        }),
        Err(e) if crate::repo::is_unique_violation(&e, Some("memberships_external_idx")) => {
            Err(ApiError::conflict(
                "external_id_conflict",
                format!(
                    "external_id '{}' is already used by another account of the app '{app_id}'.",
                    external_id.unwrap_or_default()
                ),
            )
            .hint("external ids are unique per app; fix the duplicate in your data."))
        }
        Err(e) => Err(e.into()),
    }
}

/// Every membership of an account, most recently used first.
pub async fn list_for_account(
    conn: &mut PgConnection,
    account_uuid: &str,
) -> ApiResult<Vec<Membership>> {
    Ok(sqlx::query_as::<_, Membership>(concat!(
        "select ",
        crate::membership_columns!(),
        " from memberships where account_uuid = $1 order by last_signed_in_at desc nulls last, created_at desc"
    ))
    .bind(account_uuid)
    .fetch_all(&mut *conn)
    .await?)
}

/// What [`remove_access`] did.
#[derive(Debug, Clone)]
pub struct AccessRemoved {
    pub membership: Membership,
    pub revoked_families: u64,
    pub revoked_proofs: u64,
}

/// Removes an app's access to an account: membership `access_removed`, the app's token families
/// for the account revoked (`access_removed`), and User verification proofs that app issued about the account
/// revoked (by `actor`, each with a `proof.revoked` audit entry). Emit
/// `events::membership_access_removed` after. Error: 404 `membership_not_found`.
pub async fn remove_access(
    conn: &mut PgConnection,
    app_id: &str,
    account_uuid: &str,
    actor: &str,
) -> ApiResult<AccessRemoved> {
    let mut tx = conn.begin().await?;
    let membership = sqlx::query_as::<_, Membership>(concat!(
        "update memberships set status = 'access_removed', access_removed_at = now(), updated_at = now() \
         where app_id = $1 and account_uuid = $2 returning ",
        crate::membership_columns!()
    ))
    .bind(app_id)
    .bind(account_uuid)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| {
        ApiError::not_found("membership_not_found", format!("You have never signed into the app '{app_id}'."))
            .hint("List the apps you've signed into to see their app ids.")
    })?;
    let revoked_families = sqlx::query(
        "update token_families set revoked_at = now(), revoke_reason = 'access_removed' \
         where app_id = $1 and account_uuid = $2 and revoked_at is null",
    )
    .bind(app_id)
    .bind(account_uuid)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    let (actor_kind, actor_id) = if actor == account_uuid {
        (crate::models::ActorKind::Account, Some(actor))
    } else {
        (crate::models::ActorKind::System, None)
    };
    let revoked_proofs = crate::repo::accounts::revoke_proofs(
        &mut tx,
        "account_uuid = $1",
        account_uuid,
        Some(app_id),
        actor,
        "access_removed",
        actor_kind,
        actor_id,
    )
    .await?;
    tx.commit().await?;
    Ok(AccessRemoved {
        membership,
        revoked_families,
        revoked_proofs,
    })
}

/// Where an event about an account is recorded for one member app: one of the app's active
/// subscriptions (its webhook, or the event stream).
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct MemberTarget {
    pub app_id: String,
    pub membership_id: String,
    pub granted_scopes: Vec<String>,
    pub subscription_id: uuid::Uuid,
    pub delivery: crate::models::SubscriptionDelivery,
    /// The updates the subscription wants (`null` = every update).
    pub updates: Option<Value>,
    /// The app's webhook URL (webhook subscriptions only).
    pub webhook_url: Option<String>,
}

impl MemberTarget {
    pub fn scopes(&self) -> Vec<Scope> {
        scopes_from_strings(&self.granted_scopes)
    }

    /// The subscription's updates (`None` = every update).
    pub fn updates(&self) -> Option<Vec<String>> {
        crate::repo::subscriptions::updates_from_json(self.updates.as_ref())
    }

    /// True when the subscription wants the update `choice`.
    pub fn wants(&self, choice: &str) -> bool {
        crate::repo::subscriptions::wants(self.updates().as_deref(), choice)
    }
}

/// Event targets for an account: every active subscription of every app it has a live
/// membership with (`active` or `imported`), by app id, the webhook first. A webhook
/// subscription counts while the app has a webhook URL; a stream subscription always.
///
/// A disabled app is still a target: its events are stored like any other app's and the worker
/// holds their deliveries ("Not sent: … is disabled"), so an app re-enabled within the delivery
/// window learns every change made meanwhile (an id change, a deletion) instead of keeping
/// stale data.
pub async fn webhook_targets(
    conn: &mut PgConnection,
    account_uuid: &str,
) -> ApiResult<Vec<MemberTarget>> {
    Ok(sqlx::query_as::<_, MemberTarget>(
        "select m.app_id, m.membership_id, m.granted_scopes, s.id as subscription_id, s.delivery, \
         s.updates, c.webhook_url from memberships m \
         join app_event_subscriptions s on s.app_id = m.app_id and s.status = 'active' \
         left join app_signin_configs c on c.app_id = m.app_id \
         where m.account_uuid = $1 and m.status in ('active', 'imported') \
           and (s.delivery = 'stream' or c.webhook_url is not null) \
         order by m.app_id, s.delivery desc",
    )
    .bind(account_uuid)
    .fetch_all(&mut *conn)
    .await?)
}
