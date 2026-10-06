//! `GET /v1/me/history` — one newest-first timeline of everything about the account, merged
//! from the history tables with keyset pagination:
//!
//! | kind | source |
//! |---|---|
//! | `signin` | `signin_history` (successful, failed and sign-up attempts) |
//! | `id_change` | `handle_history` (creation, every id change, release) |
//! | `custodian` | `custodian_history` (as the Silicon, the new or the old custodian) + audit actions about custodian requests/transfers |
//! | `proof` | `proof_families` (OBO proofs about the account: issued and revoked) |
//! | `app_access` | `memberships` (first sign-in to an app, an app's import) + audit actions `membership.*`, `consent.*`, `app_access.*` |
//! | `security` | every other audit action about the account (profile, photo, emails, phones, identities, sessions, STK, …) |
//!
//! Audit actions that other tables already record are skipped so nothing shows twice:
//! `proof.*` (proof_families), `account.id.*` / `silicon.id.*` (handle_history), and
//! custodian/transfer actions ending in `.accepted` (custodian_history).
//!
//! Other accounts write into this history too (a custodian acting on its Silicon, a Silicon
//! naming a Carbon as its custodian). Such entries never show the other actor's IP, and email
//! addresses and phone numbers in their details are masked. Only the account's own actions show
//! their IP.

use std::collections::{HashMap, HashSet};

use accounts_core::http::pagination::encode_cursor;
use accounts_core::http::{AccountAuth, Json, PageParams, Query};
use accounts_core::ids;
use accounts_core::models::{Account, App};
use accounts_core::normalize;
use accounts_core::views::{AccountSummary, AppSummary, Page};
use accounts_core::{ApiError, ApiResult, AppState};
use axum::extract::State;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use time::OffsetDateTime;

use crate::sessions::describe_user_agent;
use crate::util::{END_OF_TIME, clip, from_micros, to_micros, ts};

/// The history kinds, in the order the docs list them.
pub(crate) const KINDS: [&str; 6] = [
    "signin",
    "id_change",
    "custodian",
    "proof",
    "app_access",
    "security",
];

macro_rules! keyset {
    ($at:literal, $src:literal, $key:literal) => {
        concat!(
            " and ",
            $at,
            " <= $2 and (",
            $at,
            ", '",
            $src,
            "'::text collate \"C\", ",
            $key,
            ") < ($2, $3 collate \"C\", $4 collate \"C\") order by ",
            $at,
            " desc, ",
            $key,
            " desc limit $5)"
        )
    };
}

const SIGNIN: &str = concat!(
    "(select 'signin'::text as kind, 's'::text collate \"C\" as src, h.id::text collate \"C\" as row_key, ",
    "h.at as at, h.app_id as app_id, h.method as c1, h.outcome as c2, h.ip as c3, h.user_agent as c4, ",
    "null::text as c5, null::text as c6, null::jsonb as extra, null::timestamptz as t1 ",
    "from signin_history h where h.account_uuid = $1",
    keyset!("h.at", "s", "h.id::text collate \"C\"")
);

const HANDLE: &str = concat!(
    "(select 'id_change'::text as kind, 'h'::text collate \"C\" as src, hh.id::text collate \"C\" as row_key, ",
    "hh.changed_at as at, null::text as app_id, hh.old_handle as c1, hh.new_handle as c2, hh.changed_by as c3, ",
    "null::text as c4, null::text as c5, null::text as c6, null::jsonb as extra, null::timestamptz as t1 ",
    "from handle_history hh where hh.account_uuid = $1",
    keyset!("hh.changed_at", "h", "hh.id::text collate \"C\"")
);

const CUSTODIAN: &str = concat!(
    "(select 'custodian'::text as kind, 'c'::text collate \"C\" as src, ch.id::text collate \"C\" as row_key, ",
    "ch.at as at, null::text as app_id, ch.kind as c1, ch.silicon_uuid as c2, ch.from_uuid as c3, ch.to_uuid as c4, ",
    "ch.request_id::text as c5, null::text as c6, null::jsonb as extra, null::timestamptz as t1 ",
    "from custodian_history ch where (ch.silicon_uuid = $1 or ch.from_uuid = $1 or ch.to_uuid = $1)",
    keyset!("ch.at", "c", "ch.id::text collate \"C\"")
);

const PROOF_ISSUED: &str = concat!(
    "(select 'proof'::text as kind, 'p'::text collate \"C\" as src, (pf.id::text || ':issued') collate \"C\" as row_key, ",
    "pf.created_at as at, pf.issuing_app as app_id, pf.id::text as c1, pf.kind as c2, null::text as c3, null::text as c4, ",
    "null::text as c5, null::text as c6, jsonb_build_object('audiences', pf.audiences, 'scopes', pf.scopes) as extra, ",
    "pf.expires_at as t1 ",
    "from proof_families pf where pf.account_uuid = $1",
    keyset!(
        "pf.created_at",
        "p",
        "(pf.id::text || ':issued') collate \"C\""
    )
);

const PROOF_REVOKED: &str = concat!(
    "(select 'proof'::text as kind, 'q'::text collate \"C\" as src, (pf.id::text || ':revoked') collate \"C\" as row_key, ",
    "pf.revoked_at as at, pf.issuing_app as app_id, pf.id::text as c1, pf.kind as c2, pf.revoked_by as c3, ",
    "pf.revoke_reason as c4, null::text as c5, null::text as c6, ",
    "jsonb_build_object('audiences', pf.audiences, 'scopes', pf.scopes) as extra, pf.expires_at as t1 ",
    "from proof_families pf where pf.account_uuid = $1 and pf.revoked_at is not null",
    keyset!(
        "pf.revoked_at",
        "q",
        "(pf.id::text || ':revoked') collate \"C\""
    )
);

const MEMBERSHIP_FIRST: &str = concat!(
    "(select 'app_access'::text as kind, 'm'::text collate \"C\" as src, (m.app_id || ':first') collate \"C\" as row_key, ",
    "m.first_signed_in_at as at, m.app_id as app_id, m.source as c1, m.membership_id as c2, null::text as c3, ",
    "null::text as c4, null::text as c5, null::text as c6, null::jsonb as extra, null::timestamptz as t1 ",
    "from memberships m where m.account_uuid = $1 and m.app_id <> 'accounts' and m.first_signed_in_at is not null",
    keyset!(
        "m.first_signed_in_at",
        "m",
        "(m.app_id || ':first') collate \"C\""
    )
);

const MEMBERSHIP_IMPORT: &str = concat!(
    "(select 'app_access'::text as kind, 'i'::text collate \"C\" as src, (m.app_id || ':import') collate \"C\" as row_key, ",
    "m.created_at as at, m.app_id as app_id, m.source as c1, m.membership_id as c2, null::text as c3, ",
    "null::text as c4, null::text as c5, null::text as c6, null::jsonb as extra, null::timestamptz as t1 ",
    "from memberships m where m.account_uuid = $1 and m.source = 'import'",
    keyset!("m.created_at", "i", "(m.app_id || ':import') collate \"C\"")
);

macro_rules! app_access_action {
    () => {
        "(a.action like 'membership.%' or a.action like 'consent.%' or a.action like 'app\\_access.%')"
    };
}

macro_rules! custodian_action {
    () => {
        "(a.action like '%custodian%' or a.action like '%transfer%')"
    };
}

macro_rules! audit_branch {
    ($($filter:tt)*) => {
        concat!(
            "(select case when ", app_access_action!(), " then 'app_access' when ", custodian_action!(),
            " then 'custodian' else 'security' end as kind, 'a'::text collate \"C\" as src, ",
            "a.id::text collate \"C\" as row_key, a.at as at, a.app_id as app_id, a.action as c1, ",
            "a.actor_kind as c2, a.actor_id as c3, a.target_kind as c4, a.target_id as c5, a.ip as c6, ",
            "a.details as extra, null::timestamptz as t1 ",
            "from audit_log a where a.account_uuid = $1 ",
            "and a.action not like 'proof.%' and a.action not like 'account.id.%' and a.action not like 'silicon.id.%' ",
            "and not (", custodian_action!(), " and a.action like '%.accepted') ",
            $($filter)*,
            keyset!("a.at", "a", "a.id::text collate \"C\"")
        )
    };
}

const AUDIT_ALL: &str = audit_branch!("");
const AUDIT_APP_ACCESS: &str = audit_branch!(concat!("and ", app_access_action!()));
const AUDIT_CUSTODIAN: &str = audit_branch!(concat!(
    "and not ",
    app_access_action!(),
    " and ",
    custodian_action!()
));
const AUDIT_SECURITY: &str = audit_branch!(concat!(
    "and not ",
    app_access_action!(),
    " and not ",
    custodian_action!()
));

fn branches(kind: Option<&str>) -> &'static [&'static str] {
    match kind {
        Some("signin") => &[SIGNIN],
        Some("id_change") => &[HANDLE],
        Some("custodian") => &[CUSTODIAN, AUDIT_CUSTODIAN],
        Some("proof") => &[PROOF_ISSUED, PROOF_REVOKED],
        Some("app_access") => &[MEMBERSHIP_FIRST, MEMBERSHIP_IMPORT, AUDIT_APP_ACCESS],
        Some("security") => &[AUDIT_SECURITY],
        _ => &[
            SIGNIN,
            HANDLE,
            CUSTODIAN,
            PROOF_ISSUED,
            PROOF_REVOKED,
            MEMBERSHIP_FIRST,
            MEMBERSHIP_IMPORT,
            AUDIT_ALL,
        ],
    }
}

#[derive(Debug, Deserialize)]
pub(crate) struct HistoryQuery {
    kind: Option<String>,
    limit: Option<i64>,
    cursor: Option<String>,
}

#[derive(Debug, sqlx::FromRow)]
struct Row {
    kind: String,
    src: String,
    row_key: String,
    at: OffsetDateTime,
    app_id: Option<String>,
    c1: Option<String>,
    c2: Option<String>,
    c3: Option<String>,
    c4: Option<String>,
    c5: Option<String>,
    c6: Option<String>,
    extra: Option<Value>,
    t1: Option<OffsetDateTime>,
}

/// One timeline entry.
#[derive(Debug, Serialize)]
pub(crate) struct HistoryItem {
    /// Stable, unique per entry: `signin:12`, `handle:3`, `custodian:4`, `proof:<id>:issued`,
    /// `membership:<app_id>:first`, `audit:99`.
    id: String,
    kind: String,
    #[serde(with = "accounts_core::timefmt::rfc3339_ms")]
    at: OffsetDateTime,
    title: String,
    detail: Option<String>,
    app: Option<AppSummary>,
    meta: Value,
}

/// `GET /v1/me/history?kind=signin|id_change|custodian|proof|app_access|security&limit&cursor`
/// → `{"items":[HistoryItem…],"next_cursor"}`, newest first.
pub(crate) async fn list(
    State(state): State<AppState>,
    me: AccountAuth,
    Query(q): Query<HistoryQuery>,
) -> ApiResult<Json<Page<HistoryItem>>> {
    let requested = q
        .kind
        .as_deref()
        .map(|k| k.trim().to_ascii_lowercase())
        .filter(|k| !k.is_empty());
    let kind = match requested.as_deref() {
        None => None,
        Some(k) if KINDS.contains(&k) => Some(k.to_string()),
        Some(k) => {
            return Err(ApiError::bad_request(
                "invalid_history_kind",
                format!(
                    "'{}' is not a history kind; use one of {}.",
                    clip(k, 40),
                    KINDS.join(", ")
                ),
            )
            .hint("Omit kind to get every kind of entry."));
        }
    };
    let limit = q.limit.unwrap_or(50).clamp(1, 200);
    let params = PageParams {
        limit: Some(limit),
        cursor: q.cursor.clone(),
    };
    let (cursor_at, cursor_src, cursor_key) = match params.cursor::<(i64, String, String)>()? {
        Some((micros, src, key)) => (from_micros(micros)?, src, key),
        None => (END_OF_TIME, "~".to_string(), "~".to_string()),
    };
    let sql = format!(
        "select kind, src, row_key, at, app_id, c1, c2, c3, c4, c5, c6, extra, t1 from ({}) x \
         order by x.at desc, x.src desc, x.row_key desc limit $5",
        branches(kind.as_deref()).join(" union all ")
    );
    let mut rows: Vec<Row> = sqlx::query_as(sqlx::AssertSqlSafe(sql))
        .bind(me.uuid())
        .bind(cursor_at)
        .bind(&cursor_src)
        .bind(&cursor_key)
        .bind(limit + 1)
        .fetch_all(&state.db)
        .await?;
    let next_cursor = if rows.len() as i64 > limit {
        rows.truncate(limit as usize);
        rows.last()
            .map(|r| encode_cursor(&(to_micros(r.at), &r.src, &r.row_key)))
    } else {
        None
    };
    let lookups = Lookups::load(&state, &me.account, &rows).await?;
    let items = rows
        .into_iter()
        .map(|r| describe(r, &me.account, &lookups))
        .collect();
    Ok(Json(Page::new(items, next_cursor)))
}

/// Apps and accounts referenced by a page of rows, loaded in two queries.
struct Lookups {
    apps: HashMap<String, AppSummary>,
    accounts: HashMap<String, AccountSummary>,
}

impl Lookups {
    async fn load(state: &AppState, me: &Account, rows: &[Row]) -> ApiResult<Lookups> {
        let mut app_ids: HashSet<String> = HashSet::new();
        let mut uuids: HashSet<String> = HashSet::new();
        for r in rows {
            if let Some(a) = &r.app_id {
                app_ids.insert(a.clone());
            }
            match r.src.as_str() {
                "p" | "q" => {
                    for a in string_list(r.extra.as_ref(), "audiences") {
                        app_ids.insert(a);
                    }
                }
                "h" => {
                    if let Some(by) = &r.c3
                        && ids::is_account_uuid(by)
                    {
                        uuids.insert(by.clone());
                    }
                }
                "c" => {
                    for u in [&r.c2, &r.c3, &r.c4].into_iter().flatten() {
                        uuids.insert(u.clone());
                    }
                }
                "a" => {
                    if r.c2.as_deref() == Some("account")
                        && let Some(actor) = &r.c3
                    {
                        uuids.insert(actor.clone());
                    }
                }
                _ => {}
            }
        }
        uuids.remove(&me.uuid);
        let apps: Vec<App> = if app_ids.is_empty() {
            Vec::new()
        } else {
            sqlx::query_as(concat!(
                "select ",
                accounts_core::app_columns!(),
                " from apps where app_id = any($1)"
            ))
            .bind(app_ids.into_iter().collect::<Vec<_>>())
            .fetch_all(&state.db)
            .await?
        };
        let accounts: Vec<Account> = if uuids.is_empty() {
            Vec::new()
        } else {
            sqlx::query_as(concat!(
                "select ",
                accounts_core::account_columns!(),
                " from accounts where uuid = any($1)"
            ))
            .bind(uuids.into_iter().collect::<Vec<_>>())
            .fetch_all(&state.db)
            .await?
        };
        let mut accounts: HashMap<String, AccountSummary> = accounts
            .iter()
            .map(|a| (a.uuid.clone(), AccountSummary::from_account(a)))
            .collect();
        accounts.insert(me.uuid.clone(), AccountSummary::from_account(me));
        Ok(Lookups {
            apps: apps
                .iter()
                .map(|a| (a.app_id.clone(), AppSummary::from(a)))
                .collect(),
            accounts,
        })
    }

    fn app_name(&self, app_id: &str) -> String {
        self.apps
            .get(app_id)
            .map(|a| a.name.clone())
            .unwrap_or_else(|| app_id.to_string())
    }

    fn app(&self, app_id: Option<&str>) -> Option<AppSummary> {
        let id = app_id?;
        Some(self.apps.get(id).cloned().unwrap_or_else(|| AppSummary {
            app_id: id.to_string(),
            name: id.to_string(),
            logo_url: None,
            logo_dark_url: None,
            homepage_url: None,
        }))
    }

    /// `c:saket`, or a description when the account has no id (deleted) or is unknown.
    fn who(&self, uuid: &str) -> String {
        match self.accounts.get(uuid) {
            Some(a) => {
                a.id.clone()
                    .unwrap_or_else(|| format!("the deleted account {uuid}"))
            }
            None => format!("the account {uuid}"),
        }
    }

    fn summary(&self, uuid: Option<&str>) -> Value {
        match uuid {
            Some(u) => match self.accounts.get(u) {
                Some(a) => serde_json::to_value(a).unwrap_or(Value::Null),
                None => json!({ "uuid": u }),
            },
            None => Value::Null,
        }
    }
}

fn string_list(v: Option<&Value>, key: &str) -> Vec<String> {
    v.and_then(|v| v.get(key))
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

fn src_name(src: &str) -> &'static str {
    match src {
        "s" => "signin",
        "h" => "handle",
        "c" => "custodian",
        "p" | "q" => "proof",
        "m" | "i" => "membership",
        _ => "audit",
    }
}

fn method_phrase(method: &str) -> String {
    match method {
        "email" => "an email code".into(),
        "phone" => "a phone code".into(),
        "google" => "Google".into(),
        "apple" => "Apple".into(),
        "silicon_stk" => "the STK".into(),
        "slt" => "a short-lived token".into(),
        "device" => "the accounts CLI (device code)".into(),
        "session" => "the browser session".into(),
        other => other.replace('_', " "),
    }
}

/// `display_name` / `pfp_url` / … → "display name, photo".
fn field_names(details: Option<&Value>) -> Option<String> {
    let names: Vec<String> = string_list(details, "changed")
        .iter()
        .map(|f| match f.as_str() {
            "pfp_url" => "photo".to_string(),
            "dob" => "date of birth".to_string(),
            other => other.replace('_', " "),
        })
        .collect();
    (!names.is_empty()).then(|| names.join(", "))
}

/// "silicon.webhook.set" → "Silicon webhook set".
fn action_title(action: &str) -> String {
    let words = action.replace(['.', '_'], " ");
    let mut chars = words.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

fn detail_str(details: Option<&Value>, key: &str) -> Option<String> {
    details
        .and_then(|d| d.get(key))
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// `s***@example.com` / `+91*****3210` for a string that is a whole email address or E.164
/// phone number; `None` for anything else.
fn masked_contact(s: &str) -> Option<String> {
    let t = s.trim();
    if t.contains('@') && !t.contains(char::is_whitespace) {
        return normalize::normalize_email(t)
            .ok()
            .map(|e| normalize::mask_email(&e));
    }
    let digits = t.strip_prefix('+')?;
    (digits.len() >= 7 && digits.chars().all(|c| c.is_ascii_digit()))
        .then(|| normalize::mask_phone(t))
}

/// Masks every email address and phone number inside audit details written by another account
/// (for example the address a custodian typed when transferring a Silicon).
fn mask_contacts(v: Value) -> Value {
    match v {
        Value::String(s) => Value::String(masked_contact(&s).unwrap_or(s)),
        Value::Array(items) => Value::Array(items.into_iter().map(mask_contacts).collect()),
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(k, v)| (k, mask_contacts(v)))
                .collect(),
        ),
        other => other,
    }
}

fn describe(r: Row, me: &Account, l: &Lookups) -> HistoryItem {
    let id = format!("{}:{}", src_name(&r.src), r.row_key);
    let app = l.app(r.app_id.as_deref());
    let app_name = r.app_id.as_deref().map(|a| l.app_name(a));
    let (title, detail, meta) = match r.src.as_str() {
        "s" => {
            let method = r.c1.clone().unwrap_or_default();
            let outcome = r.c2.clone().unwrap_or_default();
            let phrase = method_phrase(&method);
            let title = match (outcome.as_str(), &app_name) {
                ("success", Some(a)) => format!("Signed in to {a} with {phrase}"),
                ("success", None) => format!("Signed in with {phrase}"),
                ("new_account", Some(a)) => {
                    format!("Signed up with {phrase} while signing in to {a}")
                }
                ("new_account", None) => format!("Signed up with {phrase}"),
                ("failed", Some(a)) => format!("Failed sign-in to {a} with {phrase}"),
                ("failed", None) => format!("Failed sign-in with {phrase}"),
                (other, _) => format!("Sign-in with {phrase} ({other})"),
            };
            let mut parts = Vec::new();
            if let Some(ip) = &r.c3 {
                parts.push(format!("from {ip}"));
            }
            if let Some(ua) = r.c4.as_deref().and_then(describe_user_agent) {
                parts.push(ua);
            }
            (
                title,
                (!parts.is_empty()).then(|| parts.join(" · ")),
                json!({ "method": method, "outcome": outcome, "ip": r.c3, "user_agent": r.c4 }),
            )
        }
        "h" => {
            let title = match (&r.c1, &r.c2) {
                (None, Some(new)) => format!("Account created with the id {new}"),
                (Some(old), Some(new)) => format!("Id changed from {old} to {new}"),
                (Some(old), None) => format!("Id {old} released"),
                (None, None) => "Id updated".to_string(),
            };
            let detail = match r.c3.as_deref() {
                Some("import") => {
                    Some("Created by an app's import of its existing accounts".to_string())
                }
                Some("system") => Some("Done by Silicon Accounts".to_string()),
                Some(by) if by == me.uuid => None,
                Some(by) if l.accounts.contains_key(by) => {
                    Some(format!("Changed by {}", l.who(by)))
                }
                _ => None,
            };
            (
                title,
                detail,
                json!({ "old_id": r.c1, "new_id": r.c2, "changed_by": r.c3 }),
            )
        }
        "c" => {
            let kind = r.c1.clone().unwrap_or_default();
            let silicon = r.c2.clone().unwrap_or_default();
            let from = r.c3.clone();
            let to = r.c4.clone().unwrap_or_default();
            let from_who = from
                .as_deref()
                .map(|f| l.who(f))
                .unwrap_or_else(|| "nobody".to_string());
            let title = if silicon == me.uuid {
                match kind.as_str() {
                    "created_by_custodian" => format!(
                        "{} created this Silicon and became its custodian",
                        l.who(&to)
                    ),
                    "initial_accepted" => format!("{} accepted to be the custodian", l.who(&to)),
                    _ => format!("Custodian changed from {from_who} to {}", l.who(&to)),
                }
            } else if to == me.uuid {
                match kind.as_str() {
                    "created_by_custodian" => format!("Created the Silicon {}", l.who(&silicon)),
                    "initial_accepted" => format!("Became the custodian of {}", l.who(&silicon)),
                    _ => format!(
                        "Became the custodian of {} (transferred from {from_who})",
                        l.who(&silicon)
                    ),
                }
            } else {
                format!("Transferred {} to {}", l.who(&silicon), l.who(&to))
            };
            (
                title,
                None,
                json!({
                    "kind": kind,
                    "silicon": l.summary(Some(&silicon)),
                    "from": l.summary(from.as_deref()),
                    "to": l.summary(Some(&to)),
                    "request_id": r.c5,
                }),
            )
        }
        "p" | "q" => {
            let issuer = app_name.clone().unwrap_or_else(|| "An app".to_string());
            let audiences = string_list(r.extra.as_ref(), "audiences");
            let scopes = string_list(r.extra.as_ref(), "scopes");
            let receivers = if audiences.is_empty() {
                "another app".to_string()
            } else {
                audiences
                    .iter()
                    .map(|a| l.app_name(a))
                    .collect::<Vec<_>>()
                    .join(", ")
            };
            let issued = r.src == "p";
            let title = if issued {
                format!("{issuer} got a proof to act for you at {receivers}")
            } else {
                format!("Proof for {issuer} to act for you at {receivers} revoked")
            };
            let detail = if issued {
                let scope_part = if scopes.is_empty() {
                    "No scopes".to_string()
                } else {
                    format!("Scopes: {}", scopes.join(", "))
                };
                Some(match r.t1 {
                    Some(t) => format!("{scope_part} · renewable until {}", ts(t)),
                    None => scope_part,
                })
            } else {
                let by = match r.c3.as_deref() {
                    Some(b) if b == me.uuid => Some("by you".to_string()),
                    Some("system") | None => None,
                    Some(b) if l.accounts.contains_key(b) => Some(format!("by {}", l.who(b))),
                    Some(b) => Some(format!("by {}", l.app_name(b))),
                };
                let reason = r.c4.as_deref().map(|x| x.replace('_', " "));
                match (by, reason) {
                    (Some(b), Some(x)) => Some(format!("Revoked {b} ({x})")),
                    (Some(b), None) => Some(format!("Revoked {b}")),
                    (None, Some(x)) => Some(format!("Reason: {x}")),
                    (None, None) => None,
                }
            };
            (
                title,
                detail,
                json!({
                    "proof_id": r.c1,
                    "event": if issued { "issued" } else { "revoked" },
                    "proof_kind": r.c2,
                    "issuing_app": r.app_id,
                    "audiences": audiences,
                    "scopes": scopes,
                    "revoked_by": if issued { None } else { r.c3.clone() },
                    "reason": if issued { None } else { r.c4.clone() },
                }),
            )
        }
        "m" | "i" => {
            let name = app_name.clone().unwrap_or_else(|| "An app".to_string());
            let title = if r.src == "m" {
                format!("Started using {name}")
            } else {
                format!("{name} imported your account from its existing records")
            };
            (
                title,
                None,
                json!({ "membership_id": r.c2, "source": r.c1 }),
            )
        }
        _ => {
            let action = r.c1.clone().unwrap_or_default();
            let details = r.extra.as_ref();
            let name = app_name.clone().unwrap_or_else(|| "An app".to_string());
            let (title, mut detail) = match action.as_str() {
                "membership.access_removed" => (
                    format!("Removed {name}'s access"),
                    Some("Its sign-ins and the proofs it held for you were revoked".to_string()),
                ),
                "account.profile.updated" => (
                    "Profile updated".to_string(),
                    field_names(details).map(|f| format!("Changed: {f}")),
                ),
                "account.photo.uploaded" => ("Profile photo uploaded".to_string(), None),
                "account.photo.removed" => ("Profile photo removed".to_string(), None),
                "account.email.added" => (
                    format!(
                        "Email {} added",
                        detail_str(details, "email").unwrap_or_default()
                    ),
                    None,
                ),
                "account.email.primary_changed" => (
                    format!(
                        "{} is now the primary email",
                        detail_str(details, "email").unwrap_or_default()
                    ),
                    None,
                ),
                "account.email.removed" => (
                    format!(
                        "Email {} removed",
                        detail_str(details, "email").unwrap_or_default()
                    ),
                    None,
                ),
                "account.phone.added" => (
                    format!(
                        "Phone number {} added",
                        detail_str(details, "phone").unwrap_or_default()
                    ),
                    None,
                ),
                "account.phone.primary_changed" => (
                    format!(
                        "{} is now the primary phone number",
                        detail_str(details, "phone").unwrap_or_default()
                    ),
                    None,
                ),
                "account.phone.removed" => (
                    format!(
                        "Phone number {} removed",
                        detail_str(details, "phone").unwrap_or_default()
                    ),
                    None,
                ),
                "account.identity.unlinked" => (
                    format!(
                        "{} account disconnected",
                        action_title(&detail_str(details, "provider").unwrap_or_default())
                    ),
                    None,
                ),
                "account.session.revoked" => (
                    match detail_str(details, "kind").as_deref() {
                        Some("browser") => "A browser session was signed out".to_string(),
                        _ => "A CLI sign-in was signed out".to_string(),
                    },
                    None,
                ),
                "silicon.stk.rotated" => ("STK rotated".to_string(), None),
                other => (action_title(other), None),
            };
            if detail.is_none()
                && r.c2.as_deref() == Some("account")
                && let Some(actor) = r.c3.as_deref()
                && actor != me.uuid
            {
                detail = Some(format!("By {}", l.who(actor)));
            }
            // Rows written by someone else (a custodian, the Silicon that named this Carbon, an
            // app, the service) never show that actor's IP, and their details show email
            // addresses and phone numbers only masked.
            let by_me =
                r.c2.as_deref() == Some("account") && r.c3.as_deref() == Some(me.uuid.as_str());
            let (ip, details) = if by_me {
                (r.c6, r.extra)
            } else {
                (None, r.extra.map(mask_contacts))
            };
            (
                title,
                detail,
                json!({
                    "action": action,
                    "actor_kind": r.c2,
                    "actor_id": r.c3,
                    "target_kind": r.c4,
                    "target_id": r.c5,
                    "ip": ip,
                    "details": details,
                }),
            )
        }
    };
    HistoryItem {
        id,
        kind: r.kind,
        at: r.at,
        title,
        detail,
        app,
        meta,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_kind_has_branches_and_the_sql_is_well_formed() {
        for k in KINDS {
            assert!(!branches(Some(k)).is_empty(), "{k}");
        }
        assert_eq!(branches(None).len(), 8);
        for b in branches(None) {
            assert!(b.starts_with("(select") && b.ends_with("limit $5)"), "{b}");
            assert_eq!(b.matches('(').count(), b.matches(')').count(), "{b}");
        }
        assert!(AUDIT_SECURITY.contains("and not (a.action like 'membership.%'"));
    }

    #[test]
    fn contacts_in_other_actors_details_are_masked() {
        let masked = mask_contacts(json!({
            "to": "Recipient@Example.com",
            "phone": "+919876543210",
            "nested": [{"email": "a.b@example.org"}, "plain text", 7],
            "request_id": "0199aaaa-0000-7000-8000-000000000000",
            "id": "si:scout",
            "short": "+12",
            "spaced": "not an@email here",
        }));
        assert_eq!(masked["to"], "r***@example.com");
        assert_eq!(masked["phone"], "+91******3210");
        assert_eq!(masked["nested"][0]["email"], "a***@example.org");
        assert_eq!(masked["nested"][1], "plain text");
        assert_eq!(masked["nested"][2], 7);
        assert_eq!(masked["request_id"], "0199aaaa-0000-7000-8000-000000000000");
        assert_eq!(masked["id"], "si:scout");
        assert_eq!(masked["short"], "+12");
        assert_eq!(masked["spaced"], "not an@email here");
    }

    #[test]
    fn action_titles() {
        assert_eq!(action_title("silicon.webhook.set"), "Silicon webhook set");
        assert_eq!(action_title(""), "");
        assert_eq!(
            field_names(Some(
                &json!({"changed": ["display_name", "pfp_url", "dob"]})
            ))
            .as_deref(),
            Some("display name, photo, date of birth")
        );
    }
}
