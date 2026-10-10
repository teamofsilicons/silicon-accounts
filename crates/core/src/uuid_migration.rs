//! Offline, transactional account UUID cutover. Never used as an authentication alias.
//! The persisted plan is exported before dependent services migrate. Apply requires
//! exactly that plan, all writers stopped, and rolls back unless explicitly committed.
use std::collections::{BTreeMap, BTreeSet};

use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{PgConnection, PgPool};
use uuid::Uuid;

use crate::{
    events, ids,
    models::{AccountField, AccountStatus},
    repo::accounts,
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, sqlx::FromRow)]
pub struct Mapping {
    pub old_uuid: String,
    pub new_uuid: String,
    pub kind: String,
}

#[derive(Debug, Default, Serialize)]
pub struct Report {
    pub dry_run: bool,
    pub mapped_accounts: usize,
    pub already_applied: usize,
    pub changed: BTreeMap<String, u64>,
}

fn ident(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}
async fn execute(conn: &mut PgConnection, query: String) -> Result<u64> {
    Ok(sqlx::query(sqlx::AssertSqlSafe(query))
        .execute(conn)
        .await?
        .rows_affected())
}

pub fn validate(rows: &[Mapping]) -> Result<()> {
    let mut old = BTreeSet::new();
    let mut new = BTreeSet::new();
    for row in rows {
        ensure!(
            ids::is_legacy_account_uuid(&row.old_uuid),
            "invalid legacy source ID"
        );
        let parsed = Uuid::parse_str(&row.new_uuid).context("invalid target UUID")?;
        ensure!(
            ids::is_standard_account_uuid(&row.new_uuid) && parsed.get_version_num() == 4,
            "target must be a canonical lowercase UUIDv4"
        );
        ensure!(
            matches!(row.kind.as_str(), "carbon" | "silicon"),
            "invalid account kind"
        );
        ensure!(
            old.insert(&row.old_uuid) && new.insert(&row.new_uuid),
            "duplicate source or target; merges are forbidden"
        );
    }
    Ok(())
}

/// Stable, exact CSV consumed by every app. No secrets are included.
pub fn to_csv(rows: &[Mapping]) -> Result<Vec<u8>> {
    validate(rows)?;
    let mut writer = csv::WriterBuilder::new()
        .has_headers(false)
        .from_writer(Vec::new());
    writer.write_record(["old_uuid", "new_uuid", "kind"])?;
    let mut ordered = rows.to_vec();
    ordered.sort_by(|a, b| a.old_uuid.cmp(&b.old_uuid));
    for row in ordered {
        writer.serialize(row)?;
    }
    Ok(writer.into_inner()?)
}

pub fn from_csv(bytes: &[u8]) -> Result<Vec<Mapping>> {
    let mut reader = csv::Reader::from_reader(bytes);
    ensure!(
        reader
            .headers()?
            .iter()
            .eq(["old_uuid", "new_uuid", "kind"]),
        "CSV header must be exactly old_uuid,new_uuid,kind"
    );
    let rows: Vec<Mapping> = reader.deserialize().collect::<Result<_, _>>()?;
    validate(&rows)?;
    Ok(rows)
}

async fn load(conn: &mut PgConnection) -> Result<Vec<Mapping>> {
    Ok(sqlx::query_as("select old_uuid,new_uuid::text,kind from account_uuid_migration_plan order by old_uuid collate \"C\"").fetch_all(conn).await?)
}

/// Persist random UUIDs once, including deleted accounts; repeated exports are identical.
/// New legacy accounts created after preparation must be added by running prepare again.
pub async fn prepare(pool: &PgPool) -> Result<Vec<Mapping>> {
    let mut tx = pool.begin().await?;
    sqlx::query("set local lock_timeout='10s'")
        .execute(&mut *tx)
        .await?;
    sqlx::query("lock table accounts,account_uuid_migration_plan in access exclusive mode")
        .execute(&mut *tx)
        .await?;
    let accounts: Vec<(String, String)> =
        sqlx::query_as("select uuid,kind from accounts order by uuid collate \"C\"")
            .fetch_all(&mut *tx)
            .await?;
    for (old, kind) in accounts {
        if ids::is_standard_account_uuid(&old) {
            continue;
        }
        ensure!(
            ids::is_legacy_account_uuid(&old),
            "account has an unrecognized ID; inspect before planning"
        );
        sqlx::query("insert into account_uuid_migration_plan(old_uuid,new_uuid,kind) values($1,$2,$3) on conflict(old_uuid) do nothing")
            .bind(&old).bind(Uuid::new_v4()).bind(&kind).execute(&mut *tx).await?;
    }
    let rows = load(&mut tx).await?;
    validate(&rows)?;
    tx.commit().await?;
    Ok(rows)
}

/// Rewrites only named identity fields in audit/config metadata. Provider subjects,
/// imported input, free text, URLs and previously signed webhook payloads stay exact.
fn rewrite_metadata(value: &mut Value, mapping: &BTreeMap<String, String>) {
    match value {
        Value::Array(items) => {
            for item in items {
                rewrite_metadata(item, mapping);
            }
        }
        Value::Object(object) => {
            for (key, item) in object {
                if matches!(
                    key.as_str(),
                    "uuid"
                        | "account_uuid"
                        | "custodian_uuid"
                        | "from_uuid"
                        | "to_uuid"
                        | "owner_uuid"
                        | "silicon_uuid"
                ) {
                    if let Some(new) = item.as_str().and_then(|s| mapping.get(s)) {
                        *item = Value::String(new.clone());
                    }
                } else if key == "membership_id"
                    && let Some((app, old)) = item.as_str().and_then(|s| s.split_once(':'))
                    && let Some(new) = mapping.get(old)
                {
                    *item = Value::String(format!("{app}:{new}"));
                }
                rewrite_metadata(item, mapping);
            }
        }
        _ => {}
    }
}

pub async fn apply(pool: &PgPool, expected: &[Mapping], commit: bool) -> Result<Report> {
    validate(expected)?;
    let mut tx = pool.begin().await?;
    sqlx::query("set local lock_timeout='10s'")
        .execute(&mut *tx)
        .await?;
    sqlx::query("set local statement_timeout='10min'")
        .execute(&mut *tx)
        .await?;
    sqlx::query("select pg_advisory_xact_lock(hashtextextended('accounts:uuid128',0))")
        .execute(&mut *tx)
        .await?;
    // This is an offline operation. Locks also fence accidental concurrent writers.
    let tables: Vec<String> = sqlx::query_scalar("select tablename from pg_tables where schemaname='public' and tablename<>'_sqlx_migrations' order by tablename").fetch_all(&mut *tx).await?;
    let table_list = tables
        .iter()
        .map(|t| format!("public.{}", ident(t)))
        .collect::<Vec<_>>()
        .join(",");
    execute(
        &mut tx,
        format!("lock table {table_list} in access exclusive mode"),
    )
    .await?;
    let plan = load(&mut tx).await?;
    ensure!(
        to_csv(&plan)? == to_csv(expected)?,
        "CSV does not match the persisted complete plan; export it again"
    );
    let pending: Vec<Mapping> = sqlx::query_as("select old_uuid,new_uuid::text,kind from account_uuid_migration_plan where applied_at is null order by old_uuid").fetch_all(&mut *tx).await?;
    let mut report = Report {
        dry_run: !commit,
        mapped_accounts: pending.len(),
        already_applied: plan.len() - pending.len(),
        ..Default::default()
    };
    let current: Vec<(String, String)> = sqlx::query_as("select uuid,kind from accounts")
        .fetch_all(&mut *tx)
        .await?;
    let current: BTreeMap<_, _> = current.into_iter().collect();
    for row in &plan {
        if pending.contains(row) {
            ensure!(
                current.get(&row.old_uuid) == Some(&row.kind),
                "source account missing or kind changed"
            );
            ensure!(
                !current.contains_key(&row.new_uuid),
                "target account already exists; merging is forbidden"
            );
        } else {
            ensure!(
                !current.contains_key(&row.old_uuid)
                    && current.get(&row.new_uuid) == Some(&row.kind),
                "applied mapping does not match current accounts"
            );
        }
    }
    ensure!(
        current.keys().all(
            |id| ids::is_standard_account_uuid(id) || pending.iter().any(|r| &r.old_uuid == id)
        ),
        "unmapped account exists; prepare and redistribute the complete plan"
    );
    if pending.is_empty() {
        tx.rollback().await?;
        return Ok(report);
    }
    let mapping: BTreeMap<_, _> = pending
        .iter()
        .map(|r| (r.old_uuid.clone(), r.new_uuid.clone()))
        .collect();
    // These legacy actor columns mix raw account IDs with literal system actors.
    // A reserved-word collision needs operator review; never silently relabel it.
    for marker in ["app", "system", "import", "silicon_apps"] {
        ensure!(
            !mapping.contains_key(marker),
            "legacy ID collides with a reserved actor marker; manual provenance review required"
        );
    }
    sqlx::query("create temp table uuid_map(old_uuid text primary key,new_uuid text unique not null) on commit drop").execute(&mut *tx).await?;
    for row in &pending {
        sqlx::query("insert into uuid_map values($1,$2)")
            .bind(&row.old_uuid)
            .bind(&row.new_uuid)
            .execute(&mut *tx)
            .await?;
    }
    // Discover actual FKs, so added account links cannot be silently missed. All
    // real constraints are checked before their original deferral flags return.
    let foreign_keys: Vec<(String,String,String,bool,bool)> = sqlx::query_as(
        "select n.nspname,t.relname,k.conname,k.condeferrable,k.condeferred from pg_constraint k join pg_class t on t.oid=k.conrelid join pg_namespace n on n.oid=t.relnamespace where k.contype='f' and k.confrelid='public.accounts'::regclass order by t.relname,k.conname"
    ).fetch_all(&mut *tx).await?;
    for (schema, table, name, _, _) in &foreign_keys {
        ensure!(
            schema == "public",
            "external schema references Accounts; migrate it explicitly"
        );
        execute(
            &mut tx,
            format!(
                "alter table {}.{} alter constraint {} deferrable initially deferred",
                ident(schema),
                ident(table),
                ident(name)
            ),
        )
        .await?;
    }
    sqlx::query("set constraints all deferred")
        .execute(&mut *tx)
        .await?;
    for (label, query) in [
        (
            "revoked_browser_sessions",
            "update browser_sessions set revoked_at=now() where revoked_at is null and account_uuid in(select old_uuid from uuid_map)",
        ),
        (
            "revoked_token_families",
            "update token_families set revoked_at=now(),revoke_reason='account_uuid_migrated' where revoked_at is null and account_uuid in(select old_uuid from uuid_map)",
        ),
        (
            "revoked_proof_families",
            "update proof_families set revoked_at=now(),revoked_by='system',revoke_reason='account_uuid_migrated' where revoked_at is null and account_uuid in(select old_uuid from uuid_map)",
        ),
        ("expired_auth_retries", "delete from idempotency_keys"),
    ] {
        report
            .changed
            .insert(label.into(), execute(&mut tx, query.into()).await?);
    }
    // Incomplete flows may still contain a pre-cutover subject in sealed provider
    // state or redirect results. Expire all transient flows, including unsigned-in ones.
    for table in [
        "authorization_codes",
        "short_lived_tokens",
        "device_authorizations",
        "signin_flows",
        "otp_challenges",
        "signup_sessions",
    ] {
        let count = execute(
            &mut tx,
            format!(
                "update {} set expires_at=least(expires_at,now()) where expires_at>now()",
                ident(table)
            ),
        )
        .await?;
        report.changed.insert(format!("expired_{table}"), count);
    }
    // Only retire events containing a migrated identity. Their original payload
    // stays byte-for-byte intact. Collect every affected current account so even
    // a canonical account whose historical custodian was migrated gets fresh state.
    let old_events: Vec<(Uuid,Option<String>,String,String,Value)> = sqlx::query_as(
        "select event_id,account_uuid,target_kind,target_id,payload from webhook_events where identity_migrated_at is null"
    ).fetch_all(&mut *tx).await?;
    let mut reconcile: BTreeSet<String> = pending.iter().map(|r| r.new_uuid.clone()).collect();
    let dependents: Vec<String> = sqlx::query_scalar(
        "select uuid from accounts where custodian_uuid in(select old_uuid from uuid_map)",
    )
    .fetch_all(&mut *tx)
    .await?;
    for id in dependents {
        reconcile.insert(mapping.get(&id).cloned().unwrap_or(id));
    }
    let mut retired = 0;
    for (event_id, account, kind, target, payload) in old_events {
        let mut normalized = payload.clone();
        rewrite_metadata(&mut normalized, &mapping);
        if account.as_ref().is_some_and(|id| mapping.contains_key(id))
            || (kind == "silicon" && mapping.contains_key(&target))
            || normalized != payload
        {
            sqlx::query("update webhook_events set identity_migrated_at=now() where event_id=$1")
                .bind(event_id)
                .execute(&mut *tx)
                .await?;
            retired += 1;
            if let Some(id) = account {
                reconcile.insert(mapping.get(&id).cloned().unwrap_or(id));
            }
        }
    }
    report.changed.insert("retired_events".into(), retired);
    report.changed.insert("cancelled_deliveries".into(),execute(&mut tx,"update webhook_deliveries d set status='failed',locked_until=null,last_error='account_uuid_migrated: superseded by fresh account state' from webhook_events e where e.event_id=d.event_id and e.identity_migrated_at is not null and d.status='pending'".into()).await?);
    let mut columns: Vec<(String,String)> = sqlx::query_as(
        "select distinct t.relname,a.attname from pg_constraint k join pg_class t on t.oid=k.conrelid join pg_attribute a on a.attrelid=t.oid and a.attnum=any(k.conkey) where k.contype='f' and k.confrelid='public.accounts'::regclass and array_length(k.conkey,1)=1 and k.confkey=array[(select attnum from pg_attribute where attrelid='public.accounts'::regclass and attname='uuid')]::smallint[]"
    ).fetch_all(&mut *tx).await?;
    ensure!(
        columns.len() == foreign_keys.len(),
        "unsupported account FK shape; extend the migration before cutover"
    );
    for (table, column) in [
        ("accounts", "uuid"),
        ("bug_reports", "account_uuid"),
        ("import_job_rows", "account_uuid"),
        ("webhook_events", "account_uuid"),
        ("audit_log", "account_uuid"),
        ("custodian_requests", "decided_by"),
        ("silicon_keys", "created_by"),
        ("silicon_keys", "revoked_by"),
        ("silicon_federations", "created_by"),
        ("silicon_federations", "revoked_by"),
        ("silicon_key_assertions", "silicon_uuid"),
        ("proof_families", "revoked_by"),
        ("handle_history", "changed_by"),
        ("app_signin_configs", "updated_by"),
        ("app_config_history", "actor"),
        ("import_jobs", "created_by"),
    ] {
        columns.push((table.into(), column.into()));
    }
    columns.sort();
    columns.dedup();
    for (table, column) in &columns {
        let count = execute(
            &mut tx,
            format!(
                "update {} t set {}=m.new_uuid from uuid_map m where t.{}=m.old_uuid",
                ident(table),
                ident(column),
                ident(column)
            ),
        )
        .await?;
        if count > 0 {
            report.changed.insert(format!("{table}.{column}"), count);
        }
    }
    for (table, column, predicate) in [
        ("webhook_events", "target_id", "t.target_kind='silicon'"),
        ("webhook_deliveries", "target_id", "t.target_kind='silicon'"),
        ("audit_log", "actor_id", "t.actor_kind='account'"),
        (
            "audit_log",
            "target_id",
            "t.target_kind in ('account','silicon','carbon')",
        ),
    ] {
        let count=execute(&mut tx,format!("update {} t set {}=m.new_uuid from uuid_map m where t.{}=m.old_uuid and {predicate}",ident(table),ident(column),ident(column))).await?;
        report.changed.insert(format!("{table}.{column}"), count);
    }
    for (table, column) in [
        ("proof_families", "revoked_by"),
        ("handle_history", "changed_by"),
        ("app_signin_configs", "updated_by"),
        ("app_config_history", "actor"),
        ("import_jobs", "created_by"),
    ] {
        execute(&mut tx,format!("update {} t set {}='account:'||m.new_uuid from uuid_map m where t.{}='account:'||m.old_uuid",ident(table),ident(column),ident(column))).await?;
    }
    for (table, column) in [("audit_log", "details"), ("app_config_history", "changes")] {
        let rows: Vec<(i64, Value)> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "select id,{} from {}",
            ident(column),
            ident(table)
        )))
        .fetch_all(&mut *tx)
        .await?;
        for (id, old) in rows {
            let mut new = old.clone();
            rewrite_metadata(&mut new, &mapping);
            if new != old {
                sqlx::query(sqlx::AssertSqlSafe(format!(
                    "update {} set {}=$1 where id=$2",
                    ident(table),
                    ident(column)
                )))
                .bind(new)
                .bind(id)
                .execute(&mut *tx)
                .await?;
            }
        }
    }
    sqlx::query("set constraints all immediate")
        .execute(&mut *tx)
        .await?;
    for (schema, table, name, defer, initial) in foreign_keys {
        let flags = if initial {
            "deferrable initially deferred"
        } else if defer {
            "deferrable initially immediate"
        } else {
            "not deferrable"
        };
        execute(
            &mut tx,
            format!(
                "alter table {}.{} alter constraint {} {flags}",
                ident(&schema),
                ident(&table),
                ident(&name)
            ),
        )
        .await?;
    }
    // A rollback to the short-ID allocator must fail instead of creating new legacy subjects.
    execute(&mut tx,"alter table accounts add constraint accounts_standard_uuid check(uuid ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')".into()).await?;
    for new_uuid in reconcile {
        sqlx::query("update accounts set version=version+1,updated_at=now() where uuid=$1")
            .bind(&new_uuid)
            .execute(&mut *tx)
            .await?;
        let account = accounts::get(&mut tx, &new_uuid)
            .await?
            .context("migrated account missing")?;
        let members: Vec<(String, String)> =
            sqlx::query_as("select app_id,status from memberships where account_uuid=$1")
                .bind(&new_uuid)
                .fetch_all(&mut *tx)
                .await?;
        for (app, status) in members {
            let event_type = if account.status == AccountStatus::Deleted {
                Some(events::types::ACCOUNT_DELETED)
            } else if status == "access_removed" {
                Some(events::types::MEMBERSHIP_ACCESS_REMOVED)
            } else {
                None
            };
            if let Some(event_type) = event_type {
                events::emit_to_app(
                    &mut tx,
                    &app,
                    event_type,
                    Some(&new_uuid),
                    json!({"uuid":new_uuid,"membership_id":ids::membership_id(&app,&new_uuid)}),
                )
                .await?;
            } else if pending.iter().any(|row| row.new_uuid == new_uuid) {
                events::membership_signed_out(&mut tx, &app, &new_uuid, "account_uuid_migrated")
                    .await?;
            }
        }
        if account.status != AccountStatus::Deleted {
            events::notify_profile_updated(
                &mut tx,
                &account,
                &[
                    AccountField::DisplayName,
                    AccountField::PfpUrl,
                    AccountField::Dob,
                    AccountField::Timezone,
                    AccountField::Email,
                    AccountField::Phone,
                    AccountField::Custodian,
                ],
            )
            .await?;
        }
    }
    for (table, column) in columns {
        let remaining: bool = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
            "select exists(select 1 from {} t join uuid_map m on t.{}=m.old_uuid)",
            ident(&table),
            ident(&column)
        )))
        .fetch_one(&mut *tx)
        .await?;
        if remaining {
            bail!("old identity remains in {table}.{column}");
        }
    }
    sqlx::query("update account_uuid_migration_plan set applied_at=now() where applied_at is null")
        .execute(&mut *tx)
        .await?;
    if commit {
        tx.commit().await?;
    } else {
        tx.rollback().await?;
    }
    Ok(report)
}
