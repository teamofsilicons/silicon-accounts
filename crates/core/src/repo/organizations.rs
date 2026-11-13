//! Work identities, linked accounts and Organizations' effective policy projection.
//! No roles or teams are stored here. Service credentials never reveal account links.
use crate::models::Account;
use crate::repo::{accounts, memberships, tokens};
use crate::{ApiError, ApiResult};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{Connection, PgConnection};

pub const APP_ID: &str = "silicon-organizations";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, sqlx::FromRow)]
pub struct Organization {
    pub org_id: String,
    pub name: String,
    pub logo_url: Option<String>,
}

pub async fn organization(conn: &mut PgConnection, uuid: &str) -> ApiResult<Option<Organization>> {
    Ok(sqlx::query_as("select o.org_id,o.name,o.logo_url from organization_projections o join accounts a on a.org_id=o.org_id where a.uuid=$1")
        .bind(uuid).fetch_optional(conn).await?)
}

pub async fn org_id(conn: &mut PgConnection, uuid: &str) -> ApiResult<Option<String>> {
    Ok(
        sqlx::query_scalar::<_, Option<String>>("select org_id from accounts where uuid=$1")
            .bind(uuid)
            .fetch_optional(conn)
            .await?
            .flatten(),
    )
}

pub async fn require_work(conn: &mut PgConnection, org: &str, uuid: &str) -> ApiResult<Account> {
    if org_id(conn, uuid).await?.as_deref() != Some(org) {
        return Err(ApiError::not_found(
            "work_account_not_found",
            "This work account does not belong to this organization.",
        ));
    }
    accounts::require(conn, uuid).await
}

pub fn validate_org_id(input: &str) -> ApiResult<String> {
    let id = input.trim().to_ascii_lowercase();
    if !(3..=30).contains(&id.len())
        || !id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
    {
        return Err(ApiError::unprocessable(
            "invalid_org_id",
            "An org_id is 3 to 30 ASCII letters, digits, '-' or '_'.",
        ));
    }
    Ok(id)
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow, PartialEq, Eq)]
pub struct Policy {
    pub version: i64,
    pub mode: String,
    #[serde(default)]
    pub apps: Vec<String>,
    #[serde(default)]
    pub extra_apps: Vec<String>,
    #[serde(default)]
    pub excluded_apps: Vec<String>,
}
impl Policy {
    pub fn allows(&self, app: &str) -> bool {
        if app == crate::FIRST_PARTY_APP_ID || app == APP_ID {
            return true;
        }
        if self.excluded_apps.iter().any(|s| s == app) {
            return false;
        }
        if self.extra_apps.iter().any(|s| s == app) {
            return true;
        }
        match self.mode.as_str() {
            "everywhere" => true,
            "only" => self.apps.iter().any(|s| s == app),
            "except" => !self.apps.iter().any(|s| s == app),
            _ => false,
        }
    }
    pub fn validate(&self) -> ApiResult<()> {
        if self.version < 1 || !["everywhere", "only", "except"].contains(&self.mode.as_str()) {
            return Err(ApiError::unprocessable(
                "invalid_org_policy",
                "Policy version must be positive and mode must be everywhere, only or except.",
            ));
        }
        for app in self
            .apps
            .iter()
            .chain(&self.extra_apps)
            .chain(&self.excluded_apps)
        {
            crate::ids::validate_app_id(app)
                .map_err(|e| ApiError::unprocessable("invalid_app_id", e))?;
        }
        Ok(())
    }
}

pub async fn allowed(conn: &mut PgConnection, uuid: &str, app: &str) -> ApiResult<bool> {
    if app == crate::FIRST_PARTY_APP_ID || app == APP_ID || org_id(conn, uuid).await?.is_none() {
        return Ok(true);
    }
    let policy:Option<Policy>=sqlx::query_as("select version,mode,apps,extra_apps,excluded_apps from organization_account_policies where account_uuid=$1").bind(uuid).fetch_optional(conn).await?;
    Ok(policy.is_some_and(|p| p.allows(app)))
}

pub async fn check(conn: &mut PgConnection, uuid: &str, app: &str) -> ApiResult<()> {
    if allowed(conn, uuid, app).await? {
        return Ok(());
    }
    let org = organization(conn, uuid).await?;
    let name = org
        .as_ref()
        .map(|o| o.name.as_str())
        .unwrap_or("Your organization");
    Err(ApiError::forbidden(
        "organization_app_not_allowed",
        format!("{name} does not allow this work account to sign into '{app}'."),
    )
    .hint("Ask an owner or admin of your organization to change app access.")
    .detail("org", json!(org))
    .detail("app_id", app))
}

pub async fn record(
    conn: &mut PgConnection,
    uuid: &str,
    actor: Option<&str>,
    app: Option<&str>,
    kind: &str,
    details: Value,
) -> ApiResult<()> {
    sqlx::query("insert into organization_work_events(org_id,account_uuid,actor_id,app_id,kind,details) select a.org_id,a.uuid,case when exists(select 1 from accounts actor where actor.uuid=$2 and actor.org_id=a.org_id) then $2 else a.uuid end,$3,$4,$5 from accounts a where a.uuid=$1 and a.org_id is not null")
        .bind(uuid).bind(actor).bind(app).bind(kind).bind(details).execute(conn).await?;
    Ok(())
}

pub async fn update_policy(
    conn: &mut PgConnection,
    uuid: &str,
    policy: &Policy,
) -> ApiResult<Vec<String>> {
    policy.validate()?;
    let mut tx = conn.begin().await?;
    sqlx::query("select uuid from accounts where uuid=$1 for update")
        .bind(uuid)
        .fetch_one(&mut *tx)
        .await?;
    let old:Option<Policy>=sqlx::query_as("select version,mode,apps,extra_apps,excluded_apps from organization_account_policies where account_uuid=$1 for update").bind(uuid).fetch_optional(&mut *tx).await?;
    if let Some(old) = old {
        if old.version > policy.version || (old.version == policy.version && old != *policy) {
            return Err(ApiError::conflict(
                "stale_org_policy",
                "The policy version is stale or was already used for different settings.",
            ));
        }
        if old == *policy {
            tx.commit().await?;
            return Ok(vec![]);
        }
    }
    sqlx::query("insert into organization_account_policies(account_uuid,version,mode,apps,extra_apps,excluded_apps) values($1,$2,$3,$4,$5,$6) on conflict(account_uuid) do update set version=excluded.version,mode=excluded.mode,apps=excluded.apps,extra_apps=excluded.extra_apps,excluded_apps=excluded.excluded_apps,updated_at=now()")
        .bind(uuid).bind(policy.version).bind(&policy.mode).bind(&policy.apps).bind(&policy.extra_apps).bind(&policy.excluded_apps).execute(&mut *tx).await?;
    let apps:Vec<String>=sqlx::query_scalar("select app_id from memberships where account_uuid=$1 and status='active' union select app_id from token_families where account_uuid=$1 and revoked_at is null union select issuing_app from proof_families where account_uuid=$1 and revoked_at is null union select unnest(audiences) from proof_families where account_uuid=$1 and revoked_at is null").bind(uuid).fetch_all(&mut *tx).await?;
    let mut removed = vec![];
    for app in apps {
        if !policy.allows(&app) {
            tokens::revoke_families(
                &mut tx,
                &tokens::RevokeFilter {
                    account_uuid: uuid,
                    app_id: Some(&app),
                    ..Default::default()
                },
                "organization_access_removed",
            )
            .await?;
            if memberships::get(&mut tx, &app, uuid).await?.is_some() {
                memberships::remove_access(&mut tx, &app, uuid, "organization").await?;
            }
            sqlx::query("with revoked as (update proof_families set revoked_at=now(),revoked_by='organization',revoke_reason='organization_access_removed' where account_uuid=$1 and revoked_at is null and (issuing_app=$2 or $2=any(audiences)) returning id,kind,issuing_app,account_uuid,audiences,revoked_at) insert into audit_log(actor_kind,action,target_kind,target_id,app_id,account_uuid,details) select 'system','proof.revoked','proof',id::text,issuing_app,account_uuid,jsonb_build_object('kind',kind,'reason','organization_access_removed','via','organization_policy','audiences',audiences,'revoked_at',revoked_at) from revoked").bind(uuid).bind(&app).execute(&mut *tx).await?;
            crate::events::membership_access_removed(&mut tx, &app, uuid).await?;
            record(
                &mut tx,
                uuid,
                None,
                Some(&app),
                "account.access_removed",
                json!({"reason":"organization_policy"}),
            )
            .await?;
            removed.push(app);
        }
    }
    tx.commit().await?;
    Ok(removed)
}

pub async fn main_uuid(conn: &mut PgConnection, uuid: &str) -> ApiResult<String> {
    Ok(
        sqlx::query_scalar("select main_uuid from account_links where account_uuid=$1")
            .bind(uuid)
            .fetch_optional(conn)
            .await?
            .unwrap_or_else(|| uuid.to_owned()),
    )
}
pub async fn linked(conn: &mut PgConnection, first: &str, second: &str) -> ApiResult<bool> {
    if first == second {
        return Ok(true);
    }
    Ok(main_uuid(conn, first).await? == main_uuid(conn, second).await?)
}
pub async fn linked_accounts(
    conn: &mut PgConnection,
    uuid: &str,
    app: Option<&str>,
) -> ApiResult<Value> {
    let main = main_uuid(conn, uuid).await?;
    let rows:Vec<Account>=sqlx::query_as("select a.* from accounts a where a.status='active' and (a.uuid=$1 or a.uuid in (select account_uuid from account_links where main_uuid=$1)) order by (a.org_id is not null),a.created_at,a.uuid").bind(&main).fetch_all(&mut *conn).await?;
    let mut out = vec![];
    for a in rows {
        let org = organization(conn, &a.uuid).await?;
        let allowed = match app {
            Some(id) => allowed(conn, &a.uuid, id).await?,
            None => true,
        };
        let reason = if allowed {
            None
        } else {
            Some(format!(
                "{} does not allow this app.",
                org.as_ref()
                    .map(|o| o.name.as_str())
                    .unwrap_or("Your organization")
            ))
        };
        let mut value = serde_json::to_value(crate::views::AccountSummary::from_account(&a))?;
        value["org"] = json!(org);
        value["is_main"] = json!(a.uuid == main);
        value["allowed"] = json!(allowed);
        value["reason"] = json!(reason);
        out.push(value);
    }
    Ok(json!({"main_uuid":main,"accounts":out}))
}

/// Caller must independently prove control of both accounts before calling this.
pub async fn link(conn: &mut PgConnection, first: &str, second: &str) -> ApiResult<String> {
    let mut tx = conn.begin().await?;
    // One global relationship lock avoids merge/delete cycles across overlapping groups.
    sqlx::query("select pg_advisory_xact_lock(73002912)")
        .execute(&mut *tx)
        .await?;
    let a = accounts::require(&mut tx, first).await?;
    let b = accounts::require(&mut tx, second).await?;
    if !a.is_active() || !b.is_active() || a.kind != b.kind {
        return Err(ApiError::forbidden(
            "account_link_kind",
            "Only active accounts of the same kind can be linked.",
        ));
    }
    let am = main_uuid(&mut tx, first).await?;
    let bm = main_uuid(&mut tx, second).await?;
    if am == bm {
        tx.commit().await?;
        return Ok(am);
    }
    let all:Vec<(String,Option<String>)>=sqlx::query_as("select uuid,org_id from accounts where status='active' and (uuid=any($1) or uuid in(select account_uuid from account_links where main_uuid=any($1))) order by created_at,uuid").bind(vec![&am,&bm]).fetch_all(&mut *tx).await?;
    let personals: Vec<&str> = all
        .iter()
        .filter(|(_, org)| org.is_none())
        .map(|(id, _)| id.as_str())
        .collect();
    if personals.len() > 1 {
        return Err(ApiError::conflict(
            "personal_account_already_linked",
            "Linked accounts can contain only one personal account. These groups each already have one.",
        ));
    }
    let main = personals
        .first()
        .copied()
        .unwrap_or(am.as_str())
        .to_string();
    for (id, _) in all {
        sqlx::query("insert into account_links(account_uuid,main_uuid) values($1,$2) on conflict(account_uuid) do update set main_uuid=excluded.main_uuid").bind(&id).bind(&main).execute(&mut *tx).await?;
        // Never expose the other identities through an organization's log.
        record(&mut tx, &id, Some(&id), None, "account.linked", json!({})).await?;
    }
    tx.commit().await?;
    Ok(main)
}

pub async fn detach_deleted(conn: &mut PgConnection, uuid: &str) -> ApiResult<()> {
    sqlx::query("select pg_advisory_xact_lock(73002912)")
        .execute(&mut *conn)
        .await?;
    let main = main_uuid(conn, uuid).await?;
    let personal = org_id(conn, uuid).await?.is_none();
    sqlx::query("delete from account_links where account_uuid=$1")
        .bind(uuid)
        .execute(&mut *conn)
        .await?;
    if personal {
        sqlx::query("delete from account_links where main_uuid=$1")
            .bind(&main)
            .execute(&mut *conn)
            .await?;
    } else if main == uuid {
        let next:Option<String>=sqlx::query_scalar("select l.account_uuid from account_links l join accounts a on a.uuid=l.account_uuid where l.main_uuid=$1 and a.status='active' order by a.created_at,a.uuid limit 1").bind(uuid).fetch_optional(&mut *conn).await?;
        if let Some(next) = next {
            sqlx::query("update account_links set main_uuid=$2 where main_uuid=$1")
                .bind(uuid)
                .bind(next)
                .execute(&mut *conn)
                .await?;
        }
    }
    Ok(())
}

pub async fn record_refusal(pool: &sqlx::PgPool, uuid: &str, app: &str) -> ApiResult<()> {
    let mut conn = pool.acquire().await?;
    record(
        &mut conn,
        uuid,
        Some(uuid),
        Some(app),
        "account.signin_refused",
        json!({"reason":"organization_policy"}),
    )
    .await
}
